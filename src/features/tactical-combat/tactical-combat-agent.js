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
} from './tactical-combat-constants.js';
import {
    getActionCatalog,
    parseActionsResponse,
    sanitizeActionsPayload,
} from './tactical-combat-actions.js';
import {
    DEFAULT_TACTICAL_COMBAT_AGENT_PROMPT,
    DEFAULT_TACTICAL_ENCOUNTER_SYSTEM_PROMPT,
} from './tactical-combat-prompts.js';
import {
    buildAgentGameState,
    chebyshev,
    computeReachableCells,
    getTerrain,
    hasLineOfSight,
    interpretActions,
    livingUnits,
} from './tactical-combat-engine.js';

const MAX_CORRECTION_ATTEMPTS = 2;

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
        ac: unit.ac,
        attackBonus: unit.attackBonus,
        attackRange: unit.attackRange,
        damage: unit.damage,
        initiativeBonus: unit.initiativeBonus,
        skills: (unit.skills || []).map(skill => ({
            name: skill.name,
            kind: skill.kind,
            range: skill.range,
            damage: skill.damage,
            heal: skill.heal,
            maxUses: skill.maxUses,
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
        request: 'Design one tactical encounter that fits the current scene.',
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
                kind: ['attack', 'heal', 'buff'].includes(String(skill.kind || '').toLowerCase())
                    ? String(skill.kind).toLowerCase()
                    : 'attack',
                range: numberOr(skill.range, 1, 0, 24),
                damage: String(skill.damage || '').slice(0, 40),
                heal: String(skill.heal || '').slice(0, 40),
                acBonus: numberOr(skill.acBonus, 0, 0, 10),
                attackBonus: numberOr(skill.attackBonus, 0, -5, 10),
                bonusAction: !!skill.bonusAction,
                rounds: numberOr(skill.rounds, 2, 1, 10),
                maxUses: numberOr(skill.maxUses ?? skill.uses, 1, 1, 99),
            }))
            : [];
        enemies.push({
            name: name.slice(0, 80),
            classLabel: String(raw.classLabel || raw.className || '').slice(0, 80),
            side: 'enemy',
            maxHp,
            hp: maxHp,
            ac: numberOr(raw.ac, 13, 1, 40),
            attackBonus: numberOr(raw.attackBonus, 3, -5, 30),
            attackRange,
            damage: String(raw.damage || '1d6').slice(0, 40),
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
                        ac: { type: 'integer' },
                        attackBonus: { type: 'integer' },
                        attackRange: { type: 'integer' },
                        damage: { type: 'string' },
                        initiativeBonus: { type: 'integer' },
                        notes: { type: 'string' },
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
                request,
                system,
                attempt === 0
                    ? userPrompt
                    : `${userPrompt}\n\n## CORRECTION\nYour previous response could not be used: ${lastError}\nReturn only the corrected JSON object.`,
                options.signal || null,
                { stream: false, debugSource: 'Tactical Combat Encounter', jsonSchema: ENCOUNTER_JSON_SCHEMA },
            );
            if (!ownsChat()) return { ok: false, error: 'The active chat changed before the encounter was ready.', attempts };
            const parsed = parseMapArchitectResponse(raw);
            if (!parsed.value) {
                lastError = parsed.error || 'No JSON object was found.';
                continue;
            }
            const normalized = normalizeEncounterPayload(parsed.value);
            if (!normalized.ok) {
                lastError = normalized.errors.join(' ');
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
    const payload = buildAgentGameState(state, unitIds, catalog);
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
                request,
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
            return da - db || a.hp - b.hp;
        });
        const target = targets[0];

        let actionUsed = !!unit.actionUsed;
        let bonusUsed = !!unit.bonusUsed;
        let performed = false;

        // Low-health self-heal before engaging.
        if (!actionUsed && unit.hp <= unit.maxHp * 0.35) {
            const heal = (unit.skills || []).find(skill => skill.kind === 'heal' && skill.uses > 0 && (skill.range || 0) === 0);
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
            actions.push({ type: 'attack', unitId: unit.id, targetId: target.id });
            actionUsed = true;
            performed = true;
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

    const firstPass = interpretActions(state, actions, {
        unitIds: ids,
        actorSide: 'agent',
        source: 'agent',
        rng: options.rng,
    });
    const acted = new Set(firstPass.actedUnitIds);
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
        firstPass.applied.push(...secondPass.applied);
        firstPass.rejected.push(...secondPass.rejected);
        firstPass.ended = state.status !== 'active';
    }

    return {
        source,
        applied: firstPass.applied,
        rejected: [...rejected, ...firstPass.rejected],
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
