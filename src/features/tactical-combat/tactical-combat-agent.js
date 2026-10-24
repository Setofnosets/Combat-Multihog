/**
 * tactical-combat-agent.js — encounter generation + tactical action agent.
 *
 * The model receives a JSON game state and returns a declarative action list.
 * The pure engine interprets those actions; nothing here mutates the board
 * directly. Every failure path falls back to a deterministic local tactics AI so
 * combat never stalls because a model is offline.
 */

import { sendStateRequest } from '../../../llm-client.js';
import { parseMapArchitectResponse } from '../../../map-architect-parser.js';
import { getActiveChatId } from '../../../state-manager.js';
import { createChatCommitGuard } from '../../state/pass-affinity.js';
import {
    TC_DYNAMIC_MAX,
    TC_DYNAMIC_MIN,
    TC_TERRAIN,
    TC_TERRAIN_CHARS,
    resolveGridDimensions,
    clampInt,
    terrainChar,
} from './tactical-combat-constants.js';
import {
    extractJsonObjects,
    getActionCatalog,
    parseActionsResponse,
    sanitizeActionsPayload,
} from './tactical-combat-actions.js';
import {
    normalizeStatusBehavior,
    normalizeWillpowerOutcome,
    normalizeWillpowerResource,
} from './tactical-combat-willpower.js';
import {
    DEFAULT_TACTICAL_COMBAT_AGENT_PROMPT,
    DEFAULT_TACTICAL_ENCOUNTER_SYSTEM_PROMPT,
    DEFAULT_TACTICAL_SPECIAL_RESOLUTION_PROMPT,
} from './tactical-combat-prompts.js';
import {
    applyAction,
    applySpecialEffects,
    buildAgentGameState,
    chebyshev,
    computeReachableCells,
    getTerrain,
    hasLineOfSight,
    interpretActions,
    livingUnits,
    prepareSpecialAction,
    resolveEffectTemplate,
} from './tactical-combat-engine.js';

const MAX_CORRECTION_ATTEMPTS = 2;
const MAX_SPECIAL_RESOLUTIONS_PER_TURN = 2;

/**
 * Reasoning models often emit prose/thinking before the JSON payload. Prefer the
 * first parsed object containing the expected key, then fall back to the normal
 * first-object parser.
 * @param {string} text
 * @param {string} key
 * @returns {{ value: any, error: string|null }}
 */
function parseTacticalResponse(text, key) {
    const first = parseMapArchitectResponse(text);
    if (first.value && (Array.isArray(first.value) || first.value[key])) return first;
    for (const value of extractJsonObjects(text)) {
        if (value && value[key]) return { value, error: null };
    }
    return first;
}

function numberOr(value, fallback, min, max) {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return clampInt(n, min, max);
}

export function tacticalRequestSettings(settings) {
    return {
        connectionSource: settings?.tacticalCombatConnectionSource || 'default',
        connectionProfileId: settings?.tacticalCombatConnectionProfileId || '',
        completionPresetId: settings?.tacticalCombatCompletionPresetId || '',
        ollamaUrl: settings?.tacticalCombatOllamaUrl || 'http://localhost:11434',
        ollamaModel: settings?.tacticalCombatOllamaModel || '',
        openaiUrl: settings?.tacticalCombatOpenaiUrl || '',
        openaiKey: settings?.tacticalCombatOpenaiKey || '',
        openaiModel: settings?.tacticalCombatOpenaiModel || '',
        maxTokens: Math.max(1000, Number(settings?.tacticalCombatMaxTokens) || 6000),
        debugMode: !!settings?.debugMode,
    };
}

function compactUnitForContext(unit) {
    return {
        name: unit.name,
        classLabel: unit.classLabel || '',
        side: unit.side,
        hp: unit.hp,
        maxHp: unit.maxHp,
        willpower: unit.willpower,
        maxWillpower: unit.maxWillpower,
        willpowerSave: unit.willpowerSave ?? 0,
        ac: unit.ac,
        attackBonus: unit.attackBonus,
        attackRange: unit.attackRange,
        damage: unit.damage,
        attackResource: unit.attackResource || 'hp',
        willpowerDamage: unit.willpowerDamage || '',
        attackWillpowerOutcome: unit.attackWillpowerOutcome || 'defeat',
        initiativeBonus: unit.initiativeBonus,
        skills: (unit.skills || []).map(skill => ({
            name: skill.name,
            kind: skill.kind,
            resource: skill.resource || 'hp',
            range: skill.range,
            damage: skill.damage,
            willpowerDamage: skill.willpowerDamage || '',
            willpowerOutcome: skill.willpowerOutcome || 'defeat',
            heal: skill.heal,
            maxUses: skill.maxUses,
            bonusAction: !!skill.bonusAction,
            description: skill.description || '',
            effectTemplate: Array.isArray(skill.effectTemplate) ? skill.effectTemplate : undefined,
        })),
        items: (unit.items || []).map(item => ({
            name: item.name,
            kind: item.kind,
            resource: item.resource || 'hp',
            target: item.target || 'ally',
            amount: item.amount || '',
            maxUses: item.maxUses,
            description: item.description || '',
        })),
        inventory: (unit.inventory || []).slice(0, 24).map(entry => ({
            name: entry.name,
            description: entry.description || '',
            section: entry.section || '',
            equipped: !!entry.equipped,
            rarity: entry.rarity || '',
            quantity: entry.quantity || 1,
        })),
        notes: unit.notes || '',
    };
}

/**
 * Context JSON for the Encounter Architect.
 * @param {object} context
 * @param {Record<string, any>} settings
 * @returns {object}
 */
export function buildEncounterRequestPayload(context, settings) {
    const unitCount = (context?.playerUnits?.length || 1) + (context?.allies?.length || 0) + 4;
    const grid = resolveGridDimensions(settings, unitCount);
    return {
        request: 'Design one tactical encounter that fits the current scene and the player declaration below.',
        playerDeclaration: String(context?.playerDeclaration || '').slice(0, 1200),
        enemyNames: Array.isArray(context?.enemyNames) ? context.enemyNames.slice(0, 6) : [],
        freshStart: context?.freshStart === true,
        party: (context?.playerUnits || []).map(compactUnitForContext),
        nonPartyAllies: (context?.allies || []).map(compactUnitForContext),
        existingCombat: (context?.enemies || []).map(compactUnitForContext),
        location: context?.location || '',
        sceneExcerpt: String(context?.sceneExcerpt || '').slice(0, 3500),
        partySummary: context?.summary?.party || [],
        requestedGrid: {
            mode: grid.mode,
            rows: grid.rows,
            cols: grid.cols,
            note: grid.mode === 'dynamic' ? `Choose rows/cols between ${TC_DYNAMIC_MIN} and ${TC_DYNAMIC_MAX}.` : 'Use the configured grid dimensions.',
        },
        terrainLegend: Object.fromEntries(
            Object.entries(TC_TERRAIN_CHARS).map(([char, id]) => [char, TC_TERRAIN[id].label]),
        ),
        rules: {
            enemyCount: '2-6',
            fairFight: 'Routine encounter should be winnable; a boss fight may be deadly.',
            keepSpawnLanesClear: 'Left two columns are the player side; right two columns are the enemy side.',
            willpower: 'Willpower is a morale pool, normally 25-40% of max HP. Only mental/morale abilities should target it. maxWillpower 0 means immune. At 0 Willpower the target breaks; use willpowerOutcome to say how (defeat, flee, switch_side, incapacitate, surrender).',
        },
    };
}

/**
 * @param {object} context
 * @param {Record<string, any>} settings
 * @returns {string}
 */
export function buildEncounterUserPrompt(context, settings) {
    const payload = buildEncounterRequestPayload(context, settings);
    return `## ENCOUNTER REQUEST\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nReturn exactly one JSON encounter object. No prose, no markdown fences.`;
}

/**
 * Validate and normalize an agent-authored encounter.
 * @param {any} value
 * @param {{ grid?: { rows: number, cols: number } }} [options]
 * @returns {{ ok: boolean, encounter?: object, errors: string[] }}
 */
export function normalizeEncounterPayload(value, options = {}) {
    const errors = [];
    let payload = value;
    if (payload && !Array.isArray(payload) && payload.encounter && typeof payload.encounter === 'object') {
        payload = payload.encounter;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, errors: ['The response is not a JSON object.'] };
    }

    const title = String(payload.title || '').trim().slice(0, 140);
    const description = String(payload.description || '').trim().slice(0, 4000);
    if (!title) errors.push('title is required.');

    const themeRaw = String(payload.terrainTheme || '').toLowerCase();
    const terrainTheme = ['dungeon', 'forest', 'cave', 'city', 'interior', 'plain'].includes(themeRaw)
        ? themeRaw
        : '';

    let grid = null;
    if (payload.grid && typeof payload.grid === 'object') {
        const rows = numberOr(payload.grid.rows, 0, TC_DYNAMIC_MIN, TC_DYNAMIC_MAX);
        const cols = numberOr(payload.grid.cols, 0, TC_DYNAMIC_MIN, TC_DYNAMIC_MAX);
        if (rows && cols) grid = { rows, cols };
    }
    if (grid && options.grid && (grid.rows !== options.grid.rows || grid.cols !== options.grid.cols)) {
        // The configured (or resolved) grid wins for fixed sizes.
        grid = null;
    }

    let terrain = null;
    if (Array.isArray(payload.terrain)) {
        const rows = payload.terrain.map(row => Array.isArray(row) ? row.join('') : String(row || ''));
        if (rows.length && rows.every(row => row.length === rows[0].length)) terrain = rows;
        else errors.push('terrain rows must all have the same width.');
    }

    const rawEnemies = Array.isArray(payload.enemies) ? payload.enemies : [];
    if (!rawEnemies.length) errors.push('At least one enemy is required.');
    const enemies = [];
    for (let index = 0; index < rawEnemies.slice(0, 8).length; index += 1) {
        const raw = rawEnemies[index];
        if (!raw || typeof raw !== 'object') {
            errors.push(`enemies[${index}] must be an object.`);
            continue;
        }
        const name = String(raw.name || '').trim();
        if (!name) {
            errors.push(`enemies[${index}].name is required.`);
            continue;
        }
        const maxHp = numberOr(raw.maxHp ?? raw.hp, 12, 1, 500);
        const attackRange = numberOr(raw.attackRange, 1, 1, 24);
        const skills = Array.isArray(raw.skills)
            ? raw.skills.filter(skill => skill && typeof skill === 'object').slice(0, 6).map((skill, skillIndex) => ({
                id: String(skill.id || `skill-${index}-${skillIndex}`).slice(0, 60),
                name: String(skill.name || `Ability ${skillIndex + 1}`).slice(0, 80),
                description: String(skill.description || '').slice(0, 400),
                kind: ['attack', 'heal', 'buff', 'special'].includes(String(skill.kind || '').toLowerCase())
                    ? String(skill.kind).toLowerCase()
                    : 'attack',
                resource: normalizeWillpowerResource(skill.resource ?? skill.targetResource, 'hp'),
                range: numberOr(skill.range, 1, 0, 24),
                damage: String(skill.damage || '').slice(0, 40),
                willpowerDamage: String(skill.willpowerDamage ?? skill.willDamage ?? '').slice(0, 40),
                willpowerOutcome: normalizeWillpowerOutcome(skill.willpowerOutcome ?? skill.willOutcome, 'defeat'),
                heal: String(skill.heal || '').slice(0, 40),
                acBonus: numberOr(skill.acBonus, 0, 0, 10),
                attackBonus: numberOr(skill.attackBonus, 0, -5, 10),
                bonusAction: !!skill.bonusAction,
                rounds: numberOr(skill.rounds, 2, 1, 10),
                maxUses: numberOr(skill.maxUses ?? skill.uses, 1, 1, 99),
                effectTemplate: Array.isArray(skill.effectTemplate)
                    ? skill.effectTemplate.filter(entry => entry && typeof entry === 'object').slice(0, 6)
                    : undefined,
            }))
            : [];
        enemies.push({
            name: name.slice(0, 80),
            classLabel: String(raw.classLabel || raw.className || '').slice(0, 80),
            side: 'enemy',
            maxHp,
            hp: maxHp,
            maxWillpower: raw.maxWillpower == null ? undefined : numberOr(raw.maxWillpower, 0, 0, 99),
            willpower: raw.willpower == null ? undefined : numberOr(raw.willpower, 0, 0, 99),
            willpowerSave: raw.willpowerSave == null ? (raw.willSave == null ? undefined : numberOr(raw.willSave, 0, -10, 30)) : numberOr(raw.willpowerSave, 0, -10, 30),
            ac: numberOr(raw.ac, 13, 1, 40),
            attackBonus: numberOr(raw.attackBonus, 3, -5, 30),
            attackRange,
            damage: String(raw.damage || '1d6').slice(0, 40),
            attackResource: normalizeWillpowerResource(raw.attackResource, 'hp'),
            willpowerDamage: String(raw.willpowerDamage ?? raw.willDamage ?? '').slice(0, 40),
            attackWillpowerOutcome: normalizeWillpowerOutcome(raw.attackWillpowerOutcome ?? raw.willpowerOutcome, 'defeat'),
            initiativeBonus: numberOr(raw.initiativeBonus, 0, -10, 20),
            skills,
            notes: String(raw.notes || '').slice(0, 500),
            source: 'agent',
        });
    }

    if (errors.length) return { ok: false, errors };
    return {
        ok: true,
        encounter: {
            title,
            description,
            terrainTheme: terrainTheme || 'dungeon',
            grid,
            terrain,
            enemies,
        },
        errors: [],
    };
}

export function namedEnemyMismatch(encounter, context) {
    const requested = Array.isArray(context?.enemyNames)
        ? context.enemyNames.map(name => String(name || '').trim().toLowerCase()).filter(Boolean)
        : [];
    if (!requested.length) return '';
    const allowed = new Set();
    for (const name of requested) {
        allowed.add(name);
        allowed.add(name.split(/\s+/)[0]);
    }
    const enemies = Array.isArray(encounter?.enemies) ? encounter.enemies : [];
    if (!enemies.length) return '';
    const bad = enemies.find(enemy => {
        const name = String(enemy?.name || '').toLowerCase();
        return ![...allowed].some(type => name.includes(type));
    });
    return bad ? `The encounter must use the named enemy type(s): ${context.enemyNames.join(', ')}. "${bad.name}" does not match.` : '';
}

const ENCOUNTER_JSON_SCHEMA = {
    name: 'tactical_encounter',
    description: 'A tactical encounter with terrain and enemies.',
    strict: false,
    value: {
        type: 'object',
        properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            terrainTheme: { type: 'string', enum: ['dungeon', 'forest', 'cave', 'city', 'interior', 'plain'] },
            grid: {
                type: 'object',
                properties: { rows: { type: 'integer' }, cols: { type: 'integer' } },
            },
            terrain: { type: 'array', items: { type: 'string' } },
            enemies: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        classLabel: { type: 'string' },
                        maxHp: { type: 'integer' },
                        maxWillpower: { type: 'integer' },
                        willpowerSave: { type: 'integer' },
                        ac: { type: 'integer' },
                        attackBonus: { type: 'integer' },
                        attackRange: { type: 'integer' },
                        damage: { type: 'string' },
                        attackResource: { type: 'string', enum: ['hp', 'willpower', 'both'] },
                        willpowerDamage: { type: 'string' },
                        initiativeBonus: { type: 'integer' },
                        notes: { type: 'string' },
                        skills: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    name: { type: 'string' },
                                    description: { type: 'string' },
                                    kind: { type: 'string', enum: ['attack', 'heal', 'buff', 'special'] },
                                    resource: { type: 'string', enum: ['hp', 'willpower', 'both'] },
                                    range: { type: 'integer' },
                                    damage: { type: 'string' },
                                    willpowerDamage: { type: 'string' },
                                    willpowerOutcome: { type: 'string', enum: ['defeat', 'flee', 'switch_side', 'incapacitate', 'surrender'] },
                                    heal: { type: 'string' },
                                    maxUses: { type: 'integer' },
                                    bonusAction: { type: 'boolean' },
                                    effectTemplate: { type: 'array', items: { type: 'object' } },
                                },
                                required: ['name'],
                            },
                        },
                    },
                    required: ['name', 'maxHp', 'ac', 'attackBonus', 'damage'],
                },
            },
        },
        required: ['title', 'enemies'],
    },
};

const ACTIONS_JSON_SCHEMA = {
    name: 'tactical_combat_actions',
    description: 'A list of declarative tactical combat actions.',
    strict: false,
    value: {
        type: 'object',
        properties: {
            actions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        type: { type: 'string', enum: ['move', 'attack', 'skill', 'item', 'defend', 'wait', 'flee'] },
                        unitId: { type: 'string' },
                        to: {
                            type: 'object',
                            properties: { x: { type: 'integer' }, y: { type: 'integer' } },
                        },
                        targetId: { type: 'string' },
                        skillId: { type: 'string' },
                        itemId: { type: 'string' },
                    },
                    required: ['type', 'unitId'],
                },
            },
        },
        required: ['actions'],
    },
};

/**
 * Ask the combat agent to design an encounter. Never throws for model/parse
 * errors; returns `{ ok:false, error }` so the caller can use local opposition.
 * @param {object} context
 * @param {Record<string, any>} settings
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: boolean, encounter?: object, error?: string, attempts: number, raw?: string }>}
 */
export async function generateEncounterWithAgent(context, settings, options = {}) {
    const chatId = getActiveChatId();
    const ownsChat = createChatCommitGuard(chatId, getActiveChatId, { signal: options.signal });
    const system = String(settings?.tacticalCombatEncounterPrompt || DEFAULT_TACTICAL_ENCOUNTER_SYSTEM_PROMPT);
    const request = tacticalRequestSettings(settings);
    let userPrompt = buildEncounterUserPrompt(context, settings);
    let lastError = '';
    let attempts = 0;

    for (let attempt = 0; attempt < MAX_CORRECTION_ATTEMPTS; attempt += 1) {
        attempts = attempt + 1;
        try {
            const raw = await sendStateRequest(
                attempt === 0 ? request : { ...request, maxTokens: Math.max(8000, Number(request.maxTokens) || 0) },
                system,
                attempt === 0
                    ? userPrompt
                    : `${userPrompt}\n\n## CORRECTION\nYour previous response could not be used: ${lastError}\nReturn only the corrected JSON object.`,
                options.signal || null,
                { stream: false, debugSource: 'Tactical Combat Encounter', jsonSchema: ENCOUNTER_JSON_SCHEMA },
            );
            if (!ownsChat()) return { ok: false, error: 'The active chat changed before the encounter was ready.', attempts };
            const parsed = parseTacticalResponse(raw, 'enemies');
            if (!parsed.value) {
                lastError = parsed.error || 'No JSON object was found.';
                continue;
            }
            const normalized = normalizeEncounterPayload(parsed.value);
            if (!normalized.ok) {
                lastError = normalized.errors.join(' ');
                continue;
            }
            const mismatch = namedEnemyMismatch(normalized.encounter, context);
            if (mismatch) {
                lastError = mismatch;
                continue;
            }
            return { ok: true, encounter: normalized.encounter, attempts, raw };
        } catch (error) {
            if (error?.name === 'AbortError') return { ok: false, error: 'Encounter generation was cancelled.', attempts, raw: '' };
            if (!ownsChat()) return { ok: false, error: 'The active chat changed before the encounter was ready.', attempts };
            lastError = String(error?.message || error);
        }
    }
    return { ok: false, error: lastError || 'The combat agent could not design an encounter.', attempts };
}

/**
 * @param {object} state
 * @param {string[]} unitIds
 * @param {Record<string, any>} settings
 * @param {object[]} catalog
 * @returns {{ system: string, user: string, payload: object }}
 */
export function buildAgentPrompts(state, unitIds, settings, catalog) {
    // Compact player summaries keep the prompt small enough for reasoning models
    // (DeepSeek etc.) without losing any unit the agent is allowed to control.
    const payload = buildAgentGameState(state, unitIds, catalog, { compact: true });
    const system = String(settings?.tacticalCombatAgentPrompt || DEFAULT_TACTICAL_COMBAT_AGENT_PROMPT);
    const user = `## GAME STATE\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n\nAct for these units in this order: ${unitIds.join(', ')}.\nReturn exactly one JSON object of the form {"actions":[...]} and nothing else.`;
    return { system, user, payload };
}

/**
 * Parse a model response into action objects. Exported for tests.
 * @param {string} text
 * @param {{ unitIds?: string[], catalog?: object[] }} [options]
 * @returns {{ actions: object[], rejected: { action: any, error: string }[], error: string }}
 */
export function parseAgentActionResponse(text, options = {}) {
    const parsed = parseActionsResponse(text);
    if (parsed.error) return { actions: [], rejected: [], error: parsed.error };
    const sanitized = sanitizeActionsPayload(parsed.actions, options);
    return { actions: sanitized.actions, rejected: sanitized.rejected, error: '' };
}

/**
 * Ask the agent for one enemy/ally activation batch.
 * @param {object} state
 * @param {string[]} unitIds
 * @param {Record<string, any>} settings
 * @param {{ signal?: AbortSignal, catalog?: object[] }} [options]
 * @returns {Promise<{ ok: boolean, actions: object[], rejected: { action: any, error: string }[], error?: string, attempts: number, raw?: string }>}
 */
export async function requestAgentActions(state, unitIds, settings, options = {}) {
    const chatId = getActiveChatId();
    const ownsChat = createChatCommitGuard(chatId, getActiveChatId, { signal: options.signal });
    const catalogResult = getActionCatalog(settings);
    const catalog = options.catalog || catalogResult.catalog;
    const request = tacticalRequestSettings(settings);
    const prompts = buildAgentPrompts(state, unitIds, settings, catalog);
    let lastError = '';
    let attempts = 0;

    for (let attempt = 0; attempt < MAX_CORRECTION_ATTEMPTS; attempt += 1) {
        attempts = attempt + 1;
        try {
            const raw = await sendStateRequest(
                attempt === 0 ? request : { ...request, maxTokens: Math.max(8000, Number(request.maxTokens) || 0) },
                prompts.system,
                attempt === 0
                    ? prompts.user
                    : `${prompts.user}\n\n## CORRECTION\nYour previous response was invalid: ${lastError}\nReturn only a corrected JSON object with an "actions" array.`,
                options.signal || null,
                { stream: false, debugSource: 'Tactical Combat Agent', jsonSchema: ACTIONS_JSON_SCHEMA },
            );
            if (!ownsChat()) return { ok: false, actions: [], rejected: [], error: 'The active chat changed.', attempts };
            const parsed = parseAgentActionResponse(raw, { unitIds, catalog });
            if (parsed.error) {
                lastError = parsed.error;
                continue;
            }
            if (!parsed.actions.length && parsed.rejected.length) {
                lastError = parsed.rejected.slice(0, 3).map(item => item.error).join(' ');
                continue;
            }
            return { ok: true, actions: parsed.actions, rejected: parsed.rejected, attempts, raw };
        } catch (error) {
            if (error?.name === 'AbortError') return { ok: false, actions: [], rejected: [], error: 'Agent turn cancelled.', attempts };
            if (!ownsChat()) return { ok: false, actions: [], rejected: [], error: 'The active chat changed.', attempts };
            lastError = String(error?.message || error);
        }
    }
    return { ok: false, actions: [], rejected: [], error: lastError || 'The combat agent returned no usable actions.', attempts };
}

function hostileTo(unit, target) {
    const friendly = new Set(['player', 'ally']);
    return (friendly.has(unit.side) && target.side === 'enemy')
        || (unit.side === 'enemy' && friendly.has(target.side));
}

function compactSpecialUnit(unit) {
    return {
        id: unit.id,
        name: unit.name,
        side: unit.side,
        x: unit.x,
        y: unit.y,
        hp: unit.hp,
        maxHp: unit.maxHp,
        willpower: unit.willpower,
        maxWillpower: unit.maxWillpower,
        willpowerBroken: !!unit.willpowerBroken,
        ac: unit.ac,
        statuses: (unit.statuses || []).map(status => ({ label: status.label, behavior: status.behavior || '', stacks: status.stacks || 1 })),
    };
}

/**
 * Validate the effect list returned by the special-ability resolver.
 * @param {any} value
 * @param {object} state
 * @returns {{ effects: object[], log: string, rejected: string[] }}
 */
export function normalizeSpecialEffects(value, state) {
    let payload = value;
    if (payload && !Array.isArray(payload) && Array.isArray(payload.effects)) payload = payload.effects;
    const effects = [];
    const rejected = [];
    const list = Array.isArray(payload) ? payload.slice(0, 6) : [];
    for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const type = String(raw.type || '').toLowerCase();
        if (type === 'damage' || type === 'heal' || type === 'status' || type === 'cure') {
            const target = state.units.find(unit => unit.id === String(raw.targetId || ''));
            if (!target || target.defeated || target.fled) {
                rejected.push(`Unknown target "${raw.targetId || ''}".`);
                continue;
            }
            const resource = normalizeWillpowerResource(raw.resource ?? raw.stat, 'hp');
            if (type === 'damage') {
                const amount = String(raw.amount ?? raw.damage ?? '1d6').slice(0, 40);
                if (!/\d/.test(amount)) { rejected.push('Damage effect needs a dice amount.'); continue; }
                effects.push({
                    type,
                    targetId: target.id,
                    amount,
                    resource,
                    willpowerOutcome: normalizeWillpowerOutcome(raw.willpowerOutcome ?? raw.willOutcome, 'defeat'),
                });
            } else if (type === 'heal') {
                const amount = String(raw.amount ?? raw.heal ?? '1d8+2').slice(0, 40);
                if (!/\d/.test(amount)) { rejected.push('Heal effect needs a dice amount.'); continue; }
                effects.push({ type, targetId: target.id, amount, resource });
            } else if (type === 'cure') {
                effects.push({ type, targetId: target.id });
            } else {
                effects.push({
                    type,
                    targetId: target.id,
                    label: String(raw.label || raw.name || 'Afflicted').slice(0, 60),
                    rounds: numberOr(raw.rounds, 2, 1, 10),
                    acBonus: numberOr(raw.acBonus, 0, -10, 10),
                    attackBonus: numberOr(raw.attackBonus, 0, -10, 10),
                    damage: String(raw.damage || '').slice(0, 40),
                    damageResource: normalizeWillpowerResource(raw.damageResource ?? raw.resource, 'hp'),
                    willpowerOutcome: normalizeWillpowerOutcome(raw.willpowerOutcome ?? raw.willOutcome, 'defeat'),
                    behavior: normalizeStatusBehavior(raw.behavior),
                    sourceId: String(raw.sourceId || '').slice(0, 60),
                    stacks: numberOr(raw.stacks, 1, 1, 5),
                    maxStacks: numberOr(raw.maxStacks, 1, 1, 10),
                    description: String(raw.description || '').slice(0, 300),
                });
            }
            continue;
        }
        if (type === 'defeat') {
            const target = state.units.find(unit => unit.id === String(raw.targetId || ''));
            if (!target || target.defeated || target.fled) {
                rejected.push(`Unknown target "${raw.targetId || ''}".`);
                continue;
            }
            if (Number(target.willpower) > 0 && !target.willpowerBroken) {
                rejected.push(`${target.name} still has Willpower; a defeat effect is not legal.`);
                continue;
            }
            if (target.willpowerBroken) {
                rejected.push(`${target.name} has already been broken.`);
                continue;
            }
            effects.push({
                type,
                targetId: target.id,
                outcome: normalizeWillpowerOutcome(raw.outcome ?? raw.willpowerOutcome, 'defeat'),
                reason: String(raw.reason || raw.log || '').slice(0, 200),
            });
            continue;
        }
        if (type === 'transform') {
            const target = state.units.find(unit => unit.id === String(raw.targetId || ''));
            if (!target || target.defeated || target.fled) {
                rejected.push(`Unknown target "${raw.targetId || ''}".`);
                continue;
            }
            const skills = Array.isArray(raw.skills)
                ? raw.skills.filter(entry => entry && typeof entry === 'object').slice(0, 8)
                : undefined;
            const items = Array.isArray(raw.items)
                ? raw.items.filter(entry => entry && typeof entry === 'object').slice(0, 8)
                : undefined;
            const inventory = Array.isArray(raw.inventory)
                ? raw.inventory.filter(entry => entry && typeof entry === 'object').slice(0, 24)
                : undefined;
            effects.push({
                type,
                targetId: target.id,
                name: raw.name == null ? undefined : String(raw.name).slice(0, 80),
                classLabel: raw.classLabel == null ? undefined : String(raw.classLabel).slice(0, 80),
                ac: raw.ac == null ? undefined : numberOr(raw.ac, target.ac, 1, 40),
                maxHp: raw.maxHp == null ? undefined : numberOr(raw.maxHp, target.maxHp, 1, 999),
                hp: raw.hp == null ? undefined : numberOr(raw.hp, target.hp, 0, 999),
                maxWillpower: raw.maxWillpower == null ? undefined : numberOr(raw.maxWillpower, target.maxWillpower, 0, 99),
                willpower: raw.willpower == null ? undefined : numberOr(raw.willpower, target.willpower, 0, 99),
                attackBonus: raw.attackBonus == null ? undefined : numberOr(raw.attackBonus, target.attackBonus, -10, 30),
                attackRange: raw.attackRange == null ? undefined : numberOr(raw.attackRange, target.attackRange, 1, 24),
                damage: raw.damage == null ? undefined : String(raw.damage).slice(0, 40),
                damageType: raw.damageType == null ? undefined : String(raw.damageType).slice(0, 20),
                speed: raw.speed == null ? undefined : numberOr(raw.speed, target.speed, 1, 30),
                notes: raw.notes == null ? undefined : String(raw.notes).slice(0, 500),
                glyph: raw.glyph == null ? undefined : String(raw.glyph).slice(0, 3),
                color: raw.color == null ? undefined : String(raw.color).slice(0, 30),
                skills,
                items,
                inventory,
                permanent: raw.permanent === true,
                rounds: raw.rounds == null ? 0 : numberOr(raw.rounds, 0, 0, 99),
            });
            continue;
        }
        if (type === 'terrain') {
            const cells = Array.isArray(raw.cells) ? raw.cells : Array.isArray(raw.tiles) ? raw.tiles : [];
            const cleaned = cells.slice(0, 24).filter(cell => {
                const x = Number(cell?.x);
                const y = Number(cell?.y);
                return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < state.grid.cols && y < state.grid.rows;
            }).map(cell => ({
                x: Number(cell.x),
                y: Number(cell.y),
                terrain: String(cell.terrain || raw.terrain || '').toLowerCase(),
            })).filter(cell => Boolean(TC_TERRAIN[cell.terrain]));
            if (!cleaned.length) { rejected.push('Terrain effect had no valid cells/terrain.'); continue; }
            effects.push({ type, terrain: String(raw.terrain || '').toLowerCase(), cells: cleaned });
            continue;
        }
        if (type === 'summon') {
            const name = String(raw.name || raw.unit?.name || '').trim();
            if (!name) { rejected.push('Summon effect needs a name.'); continue; }
            effects.push({
                type,
                name: name.slice(0, 60),
                maxHp: numberOr(raw.maxHp ?? raw.hp, 12, 1, 300),
                maxWillpower: raw.maxWillpower == null ? undefined : numberOr(raw.maxWillpower, 0, 0, 99),
                ac: numberOr(raw.ac, 12, 1, 40),
                attackBonus: numberOr(raw.attackBonus, 3, -5, 30),
                damage: String(raw.damage || '1d6').slice(0, 40),
                attackRange: numberOr(raw.attackRange, 1, 1, 24),
            });
            continue;
        }
        if (type === 'log' || type === 'note') {
            if (raw.text) effects.push({ type: 'log', text: String(raw.text).slice(0, 400) });
            continue;
        }
        rejected.push(`Unsupported effect type "${type}".`);
    }
    return {
        effects,
        log: String(value?.log || '').slice(0, 500),
        rejected,
    };
}

/**
 * Resolve one special ability/item into engine primitives. Called only when a
 * `kind: 'special'` skill or item is actually used, so ordinary combat spends
 * no extra tokens.
 *
 * @param {object} state
 * @param {object} caster
 * @param {{ kind: 'skill'|'item', name: string, description: string }} source
 * @param {object|null} target
 * @param {Record<string, any>} settings
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: boolean, effects?: object[], log?: string, error?: string }>}
 */
export async function resolveSpecialEffectWithAgent(state, caster, source, target, settings, options = {}) {
    if (!state || !caster || !source) return { ok: false, error: 'Missing special ability context.' };
    const chatId = getActiveChatId();
    const ownsChat = createChatCommitGuard(chatId, getActiveChatId, { signal: options.signal });
    const payload = {
        ability: {
            kind: source.kind,
            name: String(source.name || 'Special ability'),
            description: String(source.description || '').slice(0, 700),
            resource: normalizeWillpowerResource(source.resource, 'hp'),
            willpowerOutcome: normalizeWillpowerOutcome(source.willpowerOutcome ?? source.willOutcome, 'defeat'),
        },
        caster: compactSpecialUnit(caster),
        target: target ? compactSpecialUnit(target) : null,
        battlefield: {
            rows: state.grid.rows,
            cols: state.grid.cols,
            terrainLegend: Object.fromEntries(Object.entries(TC_TERRAIN_CHARS).map(([char, id]) => [id, TC_TERRAIN[id]?.label || id])),
            terrain: state.terrain.map(row => row.map(id => terrainChar(id)).join('')),
            units: state.units.filter(unit => !unit.defeated && !unit.fled).map(compactSpecialUnit),
        },
        rules: {
            actorSide: caster.side,
            willpower: 'Willpower is separate from HP. To break Willpower, apply damage with resource "willpower". Set willpowerOutcome on the damage effect. A defeat effect is only legal after Willpower is already 0.',
            permanentEnemyEffects: 'Permanent transformations are disabled for enemy-authored specials. Use temporary transformations unless the source is a player unit.',
        },
        limits: { maxEffects: 6 },
    };
    try {
        const raw = await sendStateRequest(
            tacticalRequestSettings(settings),
            String(settings?.tacticalCombatSpecialPrompt || DEFAULT_TACTICAL_SPECIAL_RESOLUTION_PROMPT),
            `## SPECIAL ABILITY\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n\nReturn only the JSON object with "log" and "effects".`,
            options.signal || null,
            { stream: false, debugSource: 'Tactical Combat Special' },
        );
        if (!ownsChat()) return { ok: false, error: 'The active chat changed.' };
        const parsed = parseTacticalResponse(raw, 'effects');
        if (!parsed.value) return { ok: false, error: parsed.error || 'The resolver returned no JSON.' };
        const normalized = normalizeSpecialEffects(parsed.value, state);
        if (!normalized.effects.length) {
            return { ok: false, error: normalized.rejected.join(' ') || 'The resolver returned no usable effects.' };
        }
        return { ok: true, effects: normalized.effects, log: normalized.log };
    } catch (error) {
        return { ok: false, error: String(error?.message || error) };
    }
}

function isAdjacentEnough(state, unit, target) {
    if (chebyshev(unit, target) > (Number(unit.attackRange) || 1)) return false;
    return (Number(unit.attackRange) || 1) <= 1 || hasLineOfSight(state, unit, target);
}

function chooseStrategicCell(state, unit, target) {
    const reachable = computeReachableCells(state, unit);
    let best = null;
    for (const [key, cost] of reachable.entries()) {
        const [x, y] = key.split(',').map(Number);
        const distance = Math.max(Math.abs(x - target.x), Math.abs(y - target.y));
        const terrain = getTerrain(state, x, y);
        let score = distance * 10 + cost;
        if (distance <= (Number(unit.attackRange) || 1)) score -= 100;
        if (terrain.cover) score -= 4;
        if (terrain.attackBonus > 0) score -= 3;
        if (terrain.id === 'hazard') score += 12;
        if (!best || score < best.score) best = { x, y, score, distance, cost };
    }
    return best;
}

/**
 * Deterministic local tactics. Returns declarative actions (does not mutate).
 * @param {object} state
 * @param {string[]} unitIds
 * @param {{ rng?: () => number }} [options]
 * @returns {object[]}
 */
export function buildLocalAiActions(state, unitIds, options = {}) {
    const actions = [];
    const ids = Array.isArray(unitIds) ? unitIds : [];
    for (const unitId of ids) {
        const unit = state.units.find(candidate => candidate.id === unitId);
        if (!unit || unit.defeated || unit.fled || unit.doneForRound) continue;
        const targets = livingUnits(state).filter(target => target.id !== unit.id && hostileTo(unit, target));
        if (!targets.length) {
            actions.push({ type: 'wait', unitId: unit.id });
            continue;
        }
        targets.sort((a, b) => {
            const da = chebyshev(unit, a);
            const db = chebyshev(unit, b);
            const durabilityA = Number(a.hp || 0) + Number(a.willpower || 0) * 0.5;
            const durabilityB = Number(b.hp || 0) + Number(b.willpower || 0) * 0.5;
            return da - db || durabilityA - durabilityB;
        });
        const target = targets[0];

        let actionUsed = !!unit.actionUsed;
        let bonusUsed = !!unit.bonusUsed;
        let performed = false;

        // Low-health / low-Willpower self-heal before engaging.
        if (!actionUsed && unit.hp <= unit.maxHp * 0.35) {
            const heal = (unit.skills || []).find(skill => skill.kind === 'heal' && skill.uses > 0 && (skill.range || 0) === 0 && skill.resource !== 'willpower');
            if (heal && (!heal.bonusAction || !bonusUsed)) {
                actions.push({ type: 'skill', unitId: unit.id, skillId: heal.id, targetId: unit.id });
                if (heal.bonusAction) bonusUsed = true;
                else actionUsed = true;
                performed = true;
            }
        }
        if (!actionUsed && Number(unit.maxWillpower) > 0 && unit.willpower <= unit.maxWillpower * 0.35) {
            const heal = (unit.skills || []).find(skill => skill.kind === 'heal' && skill.uses > 0 && (skill.range || 0) === 0 && skill.resource === 'willpower');
            if (heal && (!heal.bonusAction || !bonusUsed)) {
                actions.push({ type: 'skill', unitId: unit.id, skillId: heal.id, targetId: unit.id });
                if (heal.bonusAction) bonusUsed = true;
                else actionUsed = true;
                performed = true;
            }
        }

        let moved = false;
        const projected = { ...unit };
        if (!isAdjacentEnough(state, projected, target) && unit.movementUsed < unit.speed) {
            const best = chooseStrategicCell(state, unit, target);
            if (best && (best.x !== unit.x || best.y !== unit.y)) {
                actions.push({ type: 'move', unitId: unit.id, to: { x: best.x, y: best.y } });
                projected.x = best.x;
                projected.y = best.y;
                moved = true;
                performed = true;
            }
        }

        if (!actionUsed && isAdjacentEnough(state, projected, target)) {
            const willpowerSkill = (unit.skills || []).find(skill =>
                skill.kind === 'attack'
                && skill.resource === 'willpower'
                && skill.uses > 0
                && (skill.bonusAction ? !bonusUsed : !actionUsed)
                && chebyshev(projected, target) <= (Number(skill.range) || 1)
                && ((Number(skill.range) || 1) <= 1 || hasLineOfSight(state, projected, target)));
            if (willpowerSkill && Number(target.maxWillpower) > 0) {
                actions.push({ type: 'skill', unitId: unit.id, skillId: willpowerSkill.id, targetId: target.id });
                if (willpowerSkill.bonusAction) bonusUsed = true;
                else actionUsed = true;
                performed = true;
            } else {
                actions.push({ type: 'attack', unitId: unit.id, targetId: target.id });
                actionUsed = true;
                performed = true;
            }
        } else if (!actionUsed && !moved) {
            actions.push({ type: 'defend', unitId: unit.id });
            actionUsed = true;
            performed = true;
        }

        // Every unit must produce at least one action so the batch is complete.
        if (!performed) actions.push({ type: 'wait', unitId: unit.id });
    }
    return actions;
}

async function executeAgentAction(state, action, settings, options = {}) {
    const unit = state.units.find(candidate => candidate.id === action.unitId);
    const skill = action.skillId
        ? (unit?.skills || []).find(entry => entry.id === action.skillId || entry.name === action.skillId)
        : null;
    const item = action.itemId
        ? (unit?.items || []).find(entry => entry.id === action.itemId || entry.name === action.itemId)
        : null;
    const isSpecial = skill?.kind === 'special' || item?.kind === 'special';
    if (!isSpecial) {
        const result = applyAction(state, action, {
            rng: options.rng,
            actorSide: 'agent',
            source: 'agent',
        });
        return { result, special: false, applied: result.ok ? [{ action }] : [] };
    }

    const prepared = prepareSpecialAction(state, action, { actorSide: 'agent' });
    if (!prepared.ok) {
        return { result: { ok: false, error: prepared.error }, special: true, applied: [] };
    }
    const source = prepared.skill || prepared.item;
    const template = Array.isArray(source?.effectTemplate) ? source.effectTemplate : null;
    let effects = [];
    let log = '';
    if (template?.length) {
        effects = resolveEffectTemplate(template, { casterId: prepared.unit.id, targetId: prepared.target.id });
        const normalized = normalizeSpecialEffects({ effects }, state);
        if (!normalized.effects.length) {
            return {
                result: { ok: false, error: normalized.rejected.join(' ') || 'The effect template had no legal effects.' },
                special: true,
                applied: [],
            };
        }
        effects = normalized.effects;
    } else {
        const resolved = await resolveSpecialEffectWithAgent(
            state,
            prepared.unit,
            {
                kind: prepared.skill ? 'skill' : 'item',
                name: source.name,
                description: source.description || '',
                resource: source.resource,
                willpowerOutcome: source.willpowerOutcome,
            },
            prepared.target,
            settings,
            { signal: options.signal },
        );
        if (!resolved.ok) {
            return { result: { ok: false, error: resolved.error || 'The special resolver failed.' }, special: true, applied: [] };
        }
        effects = resolved.effects || [];
        log = resolved.log || '';
    }
    const result = applySpecialEffects(state, effects, {
        casterId: prepared.unit.id,
        skillId: prepared.skill?.id,
        itemId: prepared.item?.id,
        label: source.name,
        narrative: log,
        rng: options.rng,
    });
    return {
        result: { ok: result.ok, error: result.error, ended: result.ended, applied: result.applied, rejected: result.rejected },
        special: true,
        applied: result.ok ? [{ action, effects: result.applied }] : [],
    };
}

/**
 * Run one enemy/ally activation batch: ask the agent, interpret its actions,
 * and fill any unhandled units with the local tactics fallback.
 *
 * @param {object} state
 * @param {string[]} unitIds
 * @param {Record<string, any>} settings
 * @param {{ signal?: AbortSignal, rng?: () => number, catalog?: object[] }} [options]
 * @returns {Promise<{ source: string, applied: object[], rejected: object[], ended: boolean, error: string, attempts: number }>}
 */
export async function runAgentTurn(state, unitIds, settings, options = {}) {
    const ids = (Array.isArray(unitIds) ? unitIds : []).filter(id => {
        const unit = state.units.find(candidate => candidate.id === id);
        return unit && !unit.defeated && !unit.fled;
    });
    if (!ids.length) return { source: 'none', applied: [], rejected: [], ended: state.status !== 'active', error: '', attempts: 0 };

    const runChatId = getActiveChatId();
    const ownsRun = () => String(getActiveChatId() || '') === String(runChatId || '');
    const catalogResult = getActionCatalog(settings);
    const catalog = options.catalog || catalogResult.catalog;
    const responses = await requestAgentActions(state, ids, settings, { ...options, catalog });
    if (!ownsRun()) {
        return { source: 'cancelled', applied: [], rejected: [], ended: false, error: 'The active chat changed.', attempts: responses.attempts };
    }
    if (options.signal?.aborted) {
        return { source: 'cancelled', applied: [], rejected: [], ended: false, error: 'Agent turn cancelled.', attempts: responses.attempts };
    }

    let source = 'agent';
    let actions = responses.actions || [];
    let rejected = [...(responses.rejected || [])];
    let error = responses.error || '';
    if (!responses.ok || !actions.length) {
        actions = buildLocalAiActions(state, ids, options);
        source = 'local';
        if (!error) error = responses.error || 'The agent returned no usable actions; local tactics took over.';
    }

    const allowed = new Set(ids);
    const applied = [];
    const actedUnitIds = [];
    let specialResolutions = 0;
    for (const action of actions) {
        if (state.status !== 'active') break;
        if (!allowed.has(action.unitId)) {
            rejected.push({ action, error: `Unit "${action.unitId}" is not in the units-to-move list.` });
            continue;
        }
        const unit = state.units.find(candidate => candidate.id === action.unitId);
        const skill = action.skillId
            ? (unit?.skills || []).find(entry => entry.id === action.skillId || entry.name === action.skillId)
            : null;
        const item = action.itemId
            ? (unit?.items || []).find(entry => entry.id === action.itemId || entry.name === action.itemId)
            : null;
        const isSpecial = skill?.kind === 'special' || item?.kind === 'special';
        if (isSpecial && specialResolutions >= MAX_SPECIAL_RESOLUTIONS_PER_TURN) {
            rejected.push({ action, error: `Special resolution limit reached (${MAX_SPECIAL_RESOLUTIONS_PER_TURN} per activation).` });
            continue;
        }
        if (isSpecial) specialResolutions += 1;
        const executed = await executeAgentAction(state, action, settings, options);
        if (executed.result.ok) {
            applied.push(...executed.applied);
            if (!actedUnitIds.includes(action.unitId)) actedUnitIds.push(action.unitId);
        } else {
            rejected.push({ action, error: executed.result.error || 'Rejected.' });
        }
    }

    const acted = new Set(actedUnitIds);
    const missing = ids.filter(id => !acted.has(id));
    if (missing.length && state.status === 'active') {
        const fallbackActions = buildLocalAiActions(state, missing, options);
        const secondPass = interpretActions(state, fallbackActions, {
            unitIds: missing,
            actorSide: 'agent',
            source: 'agent',
            rng: options.rng,
        });
        source = source === 'local' ? 'local' : 'mixed';
        applied.push(...secondPass.applied);
        rejected.push(...secondPass.rejected);
    }

    return {
        source,
        applied,
        rejected,
        ended: state.status !== 'active',
        error,
        attempts: responses.attempts,
    };
}

/**
 * Small probe used by the settings "Test connection" button.
 * @param {Record<string, any>} settings
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function probeCombatAgent(settings, signal = null) {
    try {
        const raw = await sendStateRequest(
            tacticalRequestSettings(settings),
            'You are a connection probe. Reply with exactly {"actions":[]} and nothing else.',
            'Reply with {"actions":[]}.',
            signal,
            { stream: false, debugSource: 'Tactical Combat Probe' },
        );
        const parsed = parseActionsResponse(raw);
        if (parsed.error) return { ok: false, message: parsed.error };
        return { ok: true, message: 'Combat agent responded with a valid action list.' };
    } catch (error) {
        return { ok: false, message: String(error?.message || error) };
    }
}
