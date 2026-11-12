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
    normalizeArea,
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
import { describeResource, hasUses } from './tactical-combat-resources.js';
import { builtinPassiveRecipe, describePassiveTrigger, normalizePassiveTrigger } from './tactical-combat-passives.js';
import { sanitizeEffectTemplate } from './tactical-combat-effect-template.js';
import { classifySkillIntent, normalizeSkillIntent } from './tactical-combat-classifiers.js';
import { fallbackSkills } from './tactical-combat-context.js';
import {
    DEFAULT_COMBAT_PASSIVE_RESOLUTION_PROMPT,
    DEFAULT_SKILL_INTENT_PROMPT,
    DEFAULT_TACTICAL_COMBAT_AGENT_PROMPT,
    DEFAULT_TACTICAL_ENCOUNTER_SYSTEM_PROMPT,
    DEFAULT_TACTICAL_SPECIAL_RESOLUTION_PROMPT,
    DEFAULT_TRANSFORMATION_LOADOUT_PROMPT,
} from './tactical-combat-prompts.js';
import {
    DEFAULT_TRADITIONAL_COMBAT_AGENT_PROMPT,
    DEFAULT_TRADITIONAL_ENCOUNTER_SYSTEM_PROMPT,
    DEFAULT_TRADITIONAL_SPECIAL_RESOLUTION_PROMPT,
} from '../traditional-combat/traditional-combat-prompts.js';
import { buildTraditionalAgentGameState } from '../traditional-combat/traditional-combat-engine.js';
import {
    applyAction,
    applySpecialEffects,
    buildAgentGameState,
    chebyshev,
    cellKey,
    computeReachableCells,
    getAreaTargets,
    getTerrain,
    hasLineOfSight,
    interpretActions,
    livingUnits,
    normalizeSkillList,
    prepareSpecialAction,
    resolveEffectTemplate,
} from './tactical-combat-engine.js';
import {
    findSkillRegistryEntry,
    getSkillRegistry,
    registryEntryToDefinition,
    rememberPassiveResolution,
    rememberSpecialResolution,
} from '../skill-registry/skill-registry.js';
import { markSkillRegistryDirty, persistSkillRegistry } from '../skill-registry/skill-registry-store.js';
const MAX_CORRECTION_ATTEMPTS = 2;
const MAX_SPECIAL_RESOLUTIONS_PER_TURN = 2;

function maxSpecialResolutionsFor(settings, mode = 'tactical') {
    const configured = Number(mode === 'traditional'
        ? settings?.traditionalCombatMaxSpecialResolutions
        : settings?.tacticalCombatMaxSpecialResolutions);
    if (!Number.isFinite(configured)) return MAX_SPECIAL_RESOLUTIONS_PER_TURN;
    return Math.max(0, Math.min(4, Math.round(configured)));
}

function hasDeterministicSpecialRecipe(settings, source) {
    if (!source) return false;
    if (Array.isArray(source.effectTemplate) && source.effectTemplate.length) return true;
    const entry = findSkillRegistryEntry(settings, source.name);
    return !!entry?.mechanics?.effectTemplate?.length;
}

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

/**
 * Connection settings for the traditional turn-based agent.
 * @param {Record<string, any>} settings
 * @returns {object}
 */
export function traditionalRequestSettings(settings) {
    return {
        connectionSource: settings?.traditionalCombatConnectionSource || 'default',
        connectionProfileId: settings?.traditionalCombatConnectionProfileId || '',
        completionPresetId: settings?.traditionalCombatCompletionPresetId || '',
        ollamaUrl: settings?.traditionalCombatOllamaUrl || 'http://localhost:11434',
        ollamaModel: settings?.traditionalCombatOllamaModel || '',
        openaiUrl: settings?.traditionalCombatOpenaiUrl || '',
        openaiKey: settings?.traditionalCombatOpenaiKey || '',
        openaiModel: settings?.traditionalCombatOpenaiModel || '',
        maxTokens: Math.max(1000, Number(settings?.traditionalCombatMaxTokens) || 6000),
        debugMode: !!settings?.debugMode,
    };
}

function requestSettingsFor(settings, mode) {
    return mode === 'traditional' ? traditionalRequestSettings(settings) : tacticalRequestSettings(settings);
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
        skills: (unit.skills || []).filter(skill => !skill.passive && !skill.noncombat).map(skill => ({
            name: skill.name,
            kind: skill.kind,
            intent: skill.intent || skill.kind,
            utility: skill.utility === true,
            resource: skill.resource || 'hp',
            range: skill.range,
            area: normalizeArea(skill.area ?? skill.aoe),
            damage: skill.damage,
            willpowerDamage: skill.willpowerDamage || '',
            willpowerOutcome: skill.willpowerOutcome || 'defeat',
            heal: skill.heal,
            maxUses: skill.maxUses,
            bonusAction: !!skill.bonusAction,
            description: skill.description || '',
            effectTemplate: Array.isArray(skill.effectTemplate) ? skill.effectTemplate : undefined,
        })),
        passives: (unit.skills || []).filter(skill => skill.passive && !skill.noncombat).map(skill => ({
            name: skill.name,
            description: skill.description || '',
            trigger: describePassiveTrigger(skill.trigger),
            resolved: Array.isArray(skill.effectTemplate) && skill.effectTemplate.length > 0,
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
 * Compact registry entry for the encounter architect. Keeps prompts small and
 * gives the architect a stable, authoritative skill vocabulary.
 * @param {object} entry
 */
function compactRegistrySkill(entry) {
    return {
        name: entry.name,
        type: entry.type,
        brief: String(entry.brief || '').slice(0, 240),
        effect: String(entry.effectSummary || '').slice(0, 240),
        kind: entry.mechanics?.kind || 'special',
        intent: entry.intent || (entry.mechanics?.noncombat ? 'noncombat' : entry.mechanics?.passive ? 'passive' : entry.mechanics?.utility ? 'utility' : entry.mechanics?.kind) || 'special',
        utility: entry.mechanics?.utility === true,
        noncombat: entry.mechanics?.noncombat === true || entry.noncombat === true,
        passive: entry.mechanics?.passive === true,
        trigger: entry.mechanics?.passive ? describePassiveTrigger(entry.mechanics.trigger) : '',
        tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 8) : [],
        owners: Array.isArray(entry.owners) ? entry.owners.slice(0, 6).map(owner => owner.name) : [],
    };
}

function compactRegistryClass(cls) {
    return {
        name: cls.name,
        brief: String(cls.brief || '').slice(0, 200),
        skills: Array.isArray(cls.skillIds) ? cls.skillIds.slice(0, 20) : [],
    };
}

/**
 * Context JSON for the Encounter Architect.
 * @param {object} context
 * @param {Record<string, any>} settings
 * @param {{ mode?: 'tactical'|'traditional' }} [options]
 * @returns {object}
 */
export function buildEncounterRequestPayload(context, settings, options = {}) {
    const mode = options.mode === 'traditional' ? 'traditional' : 'tactical';
    const unitCount = (context?.playerUnits?.length || 1) + (context?.allies?.length || 0) + 4;
    const registry = context?.skillRegistry || getSkillRegistry(settings);
    const knownSkills = Object.values(registry.skills || {})
        .filter(entry => (entry.status === 'resolved' || entry.status === 'confirmed')
            && entry.intent !== 'noncombat'
            && entry.noncombat !== true
            && entry.mechanics?.noncombat !== true)
        .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))
        .slice(0, 32)
        .map(compactRegistrySkill);
    const knownClasses = Object.values(registry.classes || {})
        .slice(0, 10)
        .map(compactRegistryClass);
    const payload = {
        mode,
        request: mode === 'traditional'
            ? 'Design one turn-based encounter that fits the current scene and the player declaration below.'
            : 'Design one tactical encounter that fits the current scene and the player declaration below.',
        playerDeclaration: String(context?.playerDeclaration || '').slice(0, 1200),
        enemyNames: Array.isArray(context?.enemyNames) ? context.enemyNames.slice(0, 6) : [],
        freshStart: context?.freshStart === true,
        party: (context?.playerUnits || []).map(compactUnitForContext),
        nonPartyAllies: (context?.allies || []).map(compactUnitForContext),
        existingCombat: (context?.enemies || []).map(compactUnitForContext),
        combatState: String(context?.combatState || 'absent'),
        location: context?.location || '',
        sceneExcerpt: String(context?.sceneExcerpt || '').slice(0, 3500),
        partySummary: context?.summary?.party || [],
        ...(knownSkills.length ? { knownSkills } : {}),
        ...(knownClasses.length ? { knownClasses } : {}),
        rules: {
            enemyCount: '2-6',
            fairFight: 'Routine encounter should be winnable; a boss fight may be deadly.',
            willpower: 'Willpower is a morale pool, normally the configured % of max HP. Only mental/morale abilities should target it. maxWillpower 0 means immune. At 0 Willpower the target breaks; use willpowerOutcome to say how (defeat, flee, switch_side, incapacitate, surrender).',
            willpowerMaxPercent: Number(settings?.tacticalCombatWillpowerMaxPercent) || 30,
        },
    };
    if (mode === 'traditional') {
        payload.rules.grid = 'none';
        payload.rules.terrain = 'none';
        payload.rules.movement = 'none';
        payload.rules.targeting = 'All living units on the opposing side are legal attack targets. Range and line of sight are ignored.';
        return payload;
    }
    payload.rules.area = 'Optional skill area template: {"shape":"burst","radius":1-6,"origin":"target"|"self","friendlyFire":false}. Radius uses grid cells (radius 1 = 3x3). Use origin "self" for auras centered on the caster. Hostile areas exclude allies unless friendlyFire is true.';
    const grid = resolveGridDimensions(settings, unitCount);
    payload.requestedGrid = {
        mode: grid.mode,
        rows: grid.rows,
        cols: grid.cols,
        note: grid.mode === 'dynamic' ? `Choose rows/cols between ${TC_DYNAMIC_MIN} and ${TC_DYNAMIC_MAX}.` : 'Use the configured grid dimensions.',
    };
    payload.terrainLegend = Object.fromEntries(
        Object.entries(TC_TERRAIN_CHARS).map(([char, id]) => [char, TC_TERRAIN[id].label]),
    );
    payload.rules.keepSpawnLanesClear = 'Left two columns are the player side; right two columns are the enemy side.';
    return payload;
}

/**
 * @param {object} context
 * @param {Record<string, any>} settings
 * @param {{ mode?: 'tactical'|'traditional' }} [options]
 * @returns {string}
 */
export function buildEncounterUserPrompt(context, settings, options = {}) {
    const payload = buildEncounterRequestPayload(context, settings, options);
    return `## ENCOUNTER REQUEST\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nReturn exactly one JSON encounter object. No prose, no markdown fences.`;
}

/**
 * Apply a stored registry definition to an architect-authored skill. Resolved
 * specials are authoritative so the same named ability cannot silently change
 * between encounters; ordinary skills only receive missing metadata.
 * @param {object} skill
 * @param {object|null} registry
 * @returns {object}
 */
function applyRegistryDefinitionToSkill(skill, registry) {
    if (!skill || !registry) return skill;
    const entry = findSkillRegistryEntry(registry, skill.name);
    if (!entry) return skill;
    const definition = registryEntryToDefinition(entry);
    if (!definition) return skill;
    const definitionIntent = normalizeSkillIntent(definition.intent);
    const incomingIntent = normalizeSkillIntent(skill.intent);
    const protectedIntent = skill.passive === true
        || skill.utility === true
        || skill.noncombat === true
        || ['passive', 'utility', 'noncombat'].includes(incomingIntent);
    if (definition.passive === true && !skill.noncombat) {
        skill.passive = true;
        skill.trigger = normalizePassiveTrigger(definition.trigger);
        skill.unlimited = true;
        skill.maxUses = 0;
        skill.uses = 0;
        skill.kind = 'special';
        skill.intent = 'passive';
        skill.damage = '';
        skill.heal = '';
        skill.willpowerDamage = '';
        if (definition.effectTemplate?.length && !skill.effectTemplate?.length) {
            skill.effectTemplate = definition.effectTemplate;
        }
        return skill;
    }
    if (definition.utility === true || definitionIntent === 'utility') {
        skill.kind = 'special';
        skill.intent = 'utility';
        skill.utility = true;
        skill.damage = '';
        skill.heal = '';
        skill.willpowerDamage = '';
        if (definition.effectTemplate?.length && !skill.effectTemplate?.length) {
            skill.effectTemplate = definition.effectTemplate;
        }
        return skill;
    }
    if (definition.noncombat === true || definitionIntent === 'noncombat') {
        skill.kind = 'special';
        skill.intent = 'noncombat';
        skill.noncombat = true;
        skill.utility = false;
        skill.damage = '';
        skill.heal = '';
        skill.willpowerDamage = '';
        return skill;
    }
    if (protectedIntent) {
        if (definition.effectTemplate?.length && !skill.effectTemplate?.length) {
            skill.effectTemplate = definition.effectTemplate;
        }
        return skill;
    }
    if (definition.effectTemplate?.length && !skill.effectTemplate?.length) {
        skill.effectTemplate = definition.effectTemplate;
    }
    if ((entry.status === 'resolved' || entry.status === 'confirmed' || entry.locked)
        && definition.kind === 'special') {
        skill.kind = 'special';
        skill.intent = 'special';
        if (definition.effectTemplate?.length) skill.effectTemplate = definition.effectTemplate;
        if (definition.resource) skill.resource = definition.resource;
        if (definition.save) skill.save = definition.save;
        if (definition.willpowerDamage) skill.willpowerDamage = definition.willpowerDamage;
        if (definition.willpowerOutcome) skill.willpowerOutcome = definition.willpowerOutcome;
        if (definition.range != null && !skill.range) skill.range = definition.range;
        if (definition.area && !skill.area) skill.area = definition.area;
        if (!skill.description && definition.description) skill.description = definition.description;
        return skill;
    }
    if (definition.kind && !skill.kind) skill.kind = definition.kind;
    if (!skill.damage && definition.damage) skill.damage = definition.damage;
    if (!skill.heal && definition.heal) skill.heal = definition.heal;
    if (!skill.save && definition.save) skill.save = definition.save;
    if (!skill.area && definition.area) skill.area = definition.area;
    if (definition.effectTemplate?.length && !skill.effectTemplate?.length) {
        skill.effectTemplate = definition.effectTemplate;
    }
    return skill;
}

/**
 * Validate and normalize an agent-authored encounter.
 * @param {any} value
 * @param {{ grid?: { rows: number, cols: number }, skillRegistry?: object }} [options]
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
            ? raw.skills.filter(skill => skill && typeof skill === 'object').slice(0, 6).map((skill, skillIndex) => {
                const normalizedArea = normalizeArea(skill.area ?? skill.aoe);
                const target = String(skill.target || '').toLowerCase();
                const skillName = String(skill.name || `Ability ${skillIndex + 1}`).slice(0, 80);
                const skillDescription = String(skill.description || '').slice(0, 400);
                const intentInfo = classifySkillIntent(skillName, skillDescription, { type: 'ability' });
                const intent = normalizeSkillIntent(skill.intent) || intentInfo.intent;
                const passive = skill.passive === true || intent === 'passive';
                const utility = skill.utility === true || intent === 'utility' || intent === 'unknown';
                const noncombat = skill.noncombat === true || intent === 'noncombat';
                const kindRaw = String(skill.kind || '').toLowerCase();
                let kind;
                if (passive || utility || noncombat) kind = 'special';
                else if (['attack', 'heal', 'buff', 'special'].includes(kindRaw)) kind = kindRaw;
                else if (skill.damage || skill.willpowerDamage || skill.willDamage) kind = 'attack';
                else if (skill.heal) kind = 'heal';
                else if (skill.acBonus || skill.attackBonus || skill.rounds) kind = 'buff';
                else kind = 'special';
                const blockedDamage = passive || utility || noncombat;
                const normalized = {
                    id: String(skill.id || `skill-${index}-${skillIndex}`).slice(0, 60),
                    name: skillName,
                    description: skillDescription,
                    kind,
                    intent: intent || kind,
                    intentSource: String(skill.intentSource || 'architect').slice(0, 20),
                    resource: normalizeWillpowerResource(skill.resource ?? skill.targetResource, 'hp'),
                    target: ['enemy', 'ally', 'self', 'any'].includes(target) ? target : undefined,
                    range: numberOr(skill.range, normalizedArea && normalizedArea.origin === 'target' ? 6 : 1, 0, 24),
                    area: normalizedArea,
                    damage: blockedDamage ? '' : String(skill.damage || '').slice(0, 40),
                    willpowerDamage: blockedDamage ? '' : String(skill.willpowerDamage ?? skill.willDamage ?? '').slice(0, 40),
                    willpowerOutcome: normalizeWillpowerOutcome(skill.willpowerOutcome ?? skill.willOutcome, 'defeat'),
                    heal: blockedDamage ? '' : String(skill.heal || '').slice(0, 40),
                    acBonus: numberOr(skill.acBonus, 0, 0, 10),
                    attackBonus: numberOr(skill.attackBonus, 0, -5, 10),
                    bonusAction: !!skill.bonusAction,
                    rounds: numberOr(skill.rounds, 2, 1, 10),
                    maxUses: passive ? 0 : numberOr(skill.maxUses ?? skill.uses, 1, 1, 99),
                    unlimited: passive || skill.unlimited === true,
                    utility,
                    noncombat,
                    passive,
                    trigger: passive ? normalizePassiveTrigger(skill.trigger) : null,
                    save: String(skill.save || '').toLowerCase().slice(0, 8),
                    spell: skill.spell === true,
                    effectTemplate: Array.isArray(skill.effectTemplate)
                        ? skill.effectTemplate.filter(entry => entry && typeof entry === 'object').slice(0, 16)
                        : undefined,
                };
                return applyRegistryDefinitionToSkill(normalized, options.skillRegistry);
            })
            : [];
        for (const skill of skills) {
            if (skill.resource === 'both' && !skill.willpowerDamage) {
                errors.push(`enemies[${index}].skills "${skill.name}" uses resource "both" but is missing willpowerDamage.`);
            }
        }
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
            spellAttackBonus: raw.spellAttackBonus == null ? undefined : numberOr(raw.spellAttackBonus, raw.attackBonus ?? 3, -5, 30),
            spellSaveDC: raw.spellSaveDC == null ? undefined : numberOr(raw.spellSaveDC, 13, 1, 40),
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
                        spellAttackBonus: { type: 'integer' },
                        spellSaveDC: { type: 'integer' },
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
                                    intent: { type: 'string', enum: ['attack', 'heal', 'buff', 'special', 'utility', 'passive', 'noncombat'] },
                                    utility: { type: 'boolean' },
                                    passive: { type: 'boolean' },
                                    noncombat: { type: 'boolean' },
                                    resource: { type: 'string', enum: ['hp', 'willpower', 'both'] },
                                    range: { type: 'integer' },
                                    area: {
                                        type: 'object',
                                        properties: {
                                            shape: { type: 'string', enum: ['burst'] },
                                            radius: { type: 'integer' },
                                            origin: { type: 'string', enum: ['target', 'self'] },
                                            friendlyFire: { type: 'boolean' },
                                        },
                                    },
                                    damage: { type: 'string' },
                                    willpowerDamage: { type: 'string' },
                                    willpowerOutcome: { type: 'string', enum: ['defeat', 'flee', 'switch_side', 'incapacitate', 'surrender'] },
                                    heal: { type: 'string' },
                                    maxUses: { type: 'integer' },
                                    spell: { type: 'boolean' },
                                    save: { type: 'string' },
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
                        targetCell: {
                            type: 'object',
                            properties: { x: { type: 'integer' }, y: { type: 'integer' } },
                        },
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
    const mode = options.mode === 'traditional' ? 'traditional' : 'tactical';
    const chatId = getActiveChatId();
    const ownsChat = createChatCommitGuard(chatId, getActiveChatId, { signal: options.signal });
    const system = String(mode === 'traditional'
        ? (settings?.traditionalCombatEncounterPrompt || DEFAULT_TRADITIONAL_ENCOUNTER_SYSTEM_PROMPT)
        : (settings?.tacticalCombatEncounterPrompt || DEFAULT_TACTICAL_ENCOUNTER_SYSTEM_PROMPT));
    const request = requestSettingsFor(settings, mode);
    let userPrompt = buildEncounterUserPrompt(context, settings, { mode });
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
                { stream: false, debugSource: mode === 'traditional' ? 'Traditional Combat Encounter' : 'Tactical Combat Encounter', jsonSchema: ENCOUNTER_JSON_SCHEMA },
            );
            if (!ownsChat()) return { ok: false, error: 'The active chat changed before the encounter was ready.', attempts };
            const parsed = parseTacticalResponse(raw, 'enemies');
            if (!parsed.value) {
                lastError = parsed.error || 'No JSON object was found.';
                continue;
            }
            const normalized = normalizeEncounterPayload(parsed.value, {
                skillRegistry: getSkillRegistry(settings),
            });
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
 * @param {{ mode?: 'tactical'|'traditional' }} [options]
 * @returns {{ system: string, user: string, payload: object }}
 */
export function buildAgentPrompts(state, unitIds, settings, catalog, options = {}) {
    const mode = options.mode === 'traditional' ? 'traditional' : 'tactical';
    // Compact player summaries keep the prompt small enough for reasoning models
    // (DeepSeek etc.) without losing any unit the agent is allowed to control.
    const payload = mode === 'traditional'
        ? buildTraditionalAgentGameState(state, unitIds, catalog, { compact: true })
        : buildAgentGameState(state, unitIds, catalog, { compact: true });
    const system = String(mode === 'traditional'
        ? (settings?.traditionalCombatAgentPrompt || DEFAULT_TRADITIONAL_COMBAT_AGENT_PROMPT)
        : (settings?.tacticalCombatAgentPrompt || DEFAULT_TACTICAL_COMBAT_AGENT_PROMPT));
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
 * @param {{ signal?: AbortSignal, catalog?: object[], mode?: 'tactical'|'traditional', prompts?: { system: string, user: string, payload?: object } }} [options]
 * @returns {Promise<{ ok: boolean, actions: object[], rejected: { action: any, error: string }[], error?: string, attempts: number, raw?: string }>}
 */
export async function requestAgentActions(state, unitIds, settings, options = {}) {
    const mode = options.mode === 'traditional' ? 'traditional' : 'tactical';
    const chatId = getActiveChatId();
    const ownsChat = createChatCommitGuard(chatId, getActiveChatId, { signal: options.signal });
    const catalogResult = getActionCatalog(settings, mode === 'traditional' ? 'traditionalCombatActionCatalogJson' : 'tacticalCombatActionCatalogJson');
    const catalog = options.catalog || catalogResult.catalog;
    const request = requestSettingsFor(settings, mode);
    const prompts = options.prompts || buildAgentPrompts(state, unitIds, settings, catalog, { mode });
    const engineCorrection = String(options.correction || '').trim();
    const firstUserPrompt = engineCorrection
        ? `${prompts.user}\n\n## ENGINE REJECTIONS\n${engineCorrection}\nReturn only a corrected JSON object with an "actions" array.`
        : prompts.user;
    let lastError = '';
    let attempts = 0;

    for (let attempt = 0; attempt < MAX_CORRECTION_ATTEMPTS; attempt += 1) {
        attempts = attempt + 1;
        try {
            const raw = await sendStateRequest(
                attempt === 0 ? request : { ...request, maxTokens: Math.max(8000, Number(request.maxTokens) || 0) },
                prompts.system,
                attempt === 0
                    ? firstUserPrompt
                    : `${prompts.user}\n\n## CORRECTION\nYour previous response was invalid: ${lastError}\nReturn only a corrected JSON object with an "actions" array.`,
                options.signal || null,
                { stream: false, debugSource: mode === 'traditional' ? 'Traditional Combat Agent' : 'Tactical Combat Agent', jsonSchema: ACTIONS_JSON_SCHEMA },
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
        statuses: (unit.statuses || []).map(status => ({
            label: status.label,
            behavior: status.behavior || '',
            stacks: status.stacks || 1,
            rounds: Number(status.rounds) || 0,
            damage: status.damage || '',
            damageResource: status.damageResource || 'hp',
            damageType: status.damageType || '',
            durationMinutes: Number(status.durationMinutes) || 0,
            permanent: status.permanent === true,
        })),
    };
}

function isFriendlyTransformEffect(state, effect) {
    if (!effect || String(effect.type || '').toLowerCase() !== 'transform') return false;
    const target = state.units.find(unit => unit.id === String(effect.targetId || ''));
    return !!target && (target.side === 'player' || target.side === 'ally');
}

function needsTransformationLoadout(effect) {
    return !Array.isArray(effect.skills) || effect.skills.length === 0;
}

/**
 * When a player/ally transformation comes back without a replacement loadout,
 * ask the resolver once for fitting form skills. If that fails, remove the
 * skills key so the engine keeps the existing loadout instead of blanking it.
 * @param {object} state
 * @param {object[]} effects
 * @param {object} caster
 * @param {object} source
 * @param {Record<string, any>} settings
 * @param {{ mode?: 'tactical'|'traditional', signal?: AbortSignal }} [options]
 * @returns {Promise<object[]>}
 */
async function fillPlayerTransformationLoadouts(state, effects, caster, source, settings, options = {}) {
    const mode = options.mode === 'traditional' ? 'traditional' : 'tactical';
    const pending = effects.filter(effect => isFriendlyTransformEffect(state, effect) && needsTransformationLoadout(effect));
    if (!pending.length) return effects;

    for (const effect of pending) {
        const target = state.units.find(unit => unit.id === String(effect.targetId || ''));
        if (!target) continue;
        const payload = {
            mode,
            ability: {
                name: String(source?.name || 'Transformation'),
                description: String(source?.description || '').slice(0, 700),
                maxUses: source?.maxUses ?? null,
            },
            caster: compactSpecialUnit(caster),
            target: compactSpecialUnit(target),
            form: {
                targetId: target.id,
                name: String(effect.name || target.name),
                classLabel: String(effect.classLabel || target.classLabel || ''),
                maxHp: effect.maxHp ?? target.maxHp,
                hp: effect.hp ?? target.hp,
                ac: effect.ac ?? target.ac,
                attackBonus: effect.attackBonus ?? target.attackBonus,
                attackRange: effect.attackRange ?? target.attackRange,
                damage: effect.damage ?? target.damage,
                damageType: effect.damageType || target.damageType || '',
                speed: effect.speed ?? target.speed,
                notes: String(effect.notes || target.notes || ''),
            },
            limits: { maxSkills: 5 },
        };
        try {
            const raw = await sendStateRequest(
                requestSettingsFor(settings, mode),
                DEFAULT_TRANSFORMATION_LOADOUT_PROMPT,
                `## TRANSFORMATION LOADOUT\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n\nReturn only {"skills":[...]} and nothing else.`,
                options.signal || null,
                {
                    stream: false,
                    debugSource: mode === 'traditional'
                        ? 'Traditional Combat Transform Loadout'
                        : 'Tactical Combat Transform Loadout',
                },
            );
            const parsed = parseTacticalResponse(raw, 'skills');
            const rawSkills = Array.isArray(parsed.value) ? parsed.value : parsed.value?.skills;
            const skills = normalizeSkillList(rawSkills, target.side);
            if (skills.length) {
                effect.skills = skills;
                delete effect.skillsResolutionFailed;
            } else {
                delete effect.skills;
                effect.skillsResolutionFailed = true;
            }
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            delete effect.skills;
            effect.skillsResolutionFailed = true;
        }
    }
    return effects;
}

/**
 * Validate the effect list returned by the special-ability resolver.
 * @param {any} value
 * @param {object} state
 * @param {{ theater?: boolean }} [options]
 * @returns {{ effects: object[], log: string, rejected: string[] }}
 */
export function normalizeSpecialEffects(value, state, options = {}) {
    let payload = value;
    if (payload && !Array.isArray(payload) && Array.isArray(payload.effects)) payload = payload.effects;
    const effects = [];
    const rejected = [];
    const maxEffects = Math.max(1, Math.min(64, Number(options.maxEffects) || 6));
    const allowed = Array.isArray(options.allowedTargetIds)
        ? new Set(options.allowedTargetIds.map(id => String(id)))
        : null;
    const list = Array.isArray(payload) ? payload.slice(0, maxEffects) : [];
    const targetAllowed = target => !allowed || allowed.has(String(target?.id || ''));
    for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const type = String(raw.type || '').toLowerCase();
        if (type === 'damage' || type === 'drain' || type === 'heal' || type === 'status' || type === 'cure') {
            const target = state.units.find(unit => unit.id === String(raw.targetId || ''));
            if (!target || target.defeated || target.fled) {
                rejected.push(`Unknown target "${raw.targetId || ''}".`);
                continue;
            }
            if (!targetAllowed(target)) {
                rejected.push(`${target.name} is outside the ability's area.`);
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
            } else if (type === 'drain') {
                const amount = String(raw.amount ?? raw.damage ?? '1d6').slice(0, 40);
                if (!/\d/.test(amount)) { rejected.push('Drain effect needs a dice amount.'); continue; }
                effects.push({
                    type,
                    targetId: target.id,
                    amount,
                    resource,
                    healRatio: Math.max(0, Math.min(1, Number(raw.healRatio ?? 0.5) || 0.5)),
                    healResource: normalizeWillpowerResource(raw.healResource, 'hp'),
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
                    rounds: raw.rounds == null
                        ? (raw.permanent === true || Number(raw.durationMinutes) > 0 ? 0 : 2)
                        : numberOr(raw.rounds, 0, 0, 99),
                    acBonus: numberOr(raw.acBonus, 0, -10, 10),
                    attackBonus: numberOr(raw.attackBonus, 0, -10, 10),
                    damage: String(raw.damage || '').slice(0, 40),
                    damageResource: normalizeWillpowerResource(raw.damageResource ?? raw.resource, 'hp'),
                    damageType: String(raw.damageType || '').slice(0, 20),
                    willpowerOutcome: normalizeWillpowerOutcome(raw.willpowerOutcome ?? raw.willOutcome, 'defeat'),
                    behavior: normalizeStatusBehavior(raw.behavior),
                    sourceId: String(raw.sourceId || '').slice(0, 60),
                    stacks: numberOr(raw.stacks, 1, 1, 5),
                    maxStacks: numberOr(raw.maxStacks, 1, 1, 10),
                    polarity: ['positive', 'negative'].includes(String(raw.polarity || '').toLowerCase())
                        ? String(raw.polarity).toLowerCase()
                        : '',
                    durationMinutes: raw.durationMinutes == null ? 0 : numberOr(raw.durationMinutes, 0, 0, 99999),
                    permanent: raw.permanent === true,
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
            if (!targetAllowed(target)) {
                rejected.push(`${target.name} is outside the ability's area.`);
                continue;
            }
            if (Number(target.maxWillpower) === 0) {
                rejected.push(`${target.name} is immune to Willpower effects.`);
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
            if (!targetAllowed(target)) {
                rejected.push(`${target.name} is outside the ability's area.`);
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
            if (options.theater) {
                rejected.push('Terrain effects are not supported in traditional combat.');
                continue;
            }
            const areaKeys = Array.isArray(options.areaCells) && options.areaCells.length
                ? new Set(options.areaCells.map(cell => cellKey(Number(cell.x), Number(cell.y))))
                : null;
            const occupied = new Set(
                (state.units || [])
                    .filter(unit => unit && !unit.defeated && !unit.fled)
                    .map(unit => cellKey(Number(unit.x), Number(unit.y))),
            );
            const cells = Array.isArray(raw.cells) ? raw.cells : Array.isArray(raw.tiles) ? raw.tiles : [];
            const cleaned = cells.slice(0, 24).filter(cell => {
                const x = Number(cell?.x);
                const y = Number(cell?.y);
                if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= state.grid.cols || y >= state.grid.rows) return false;
                if (areaKeys && !areaKeys.has(cellKey(x, y))) return false;
                const terrain = String(cell.terrain || raw.terrain || '').toLowerCase();
                const definition = TC_TERRAIN[terrain];
                if (!definition) return false;
                // Never entomb a living unit with impassable terrain.
                if (definition.walkable === false && occupied.has(cellKey(x, y))) return false;
                return true;
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

const SKILL_INTENT_CACHE = new Map();
const MAX_SKILL_INTENT_BATCH = 24;

function skillIntentCacheKey(skill, chatId = '') {
    const name = String(skill?.name || '').trim().toLowerCase();
    const description = String(skill?.description || '').trim().toLowerCase();
    let hash = 0;
    for (let i = 0; i < description.length; i += 1) {
        hash = ((hash << 5) - hash + description.charCodeAt(i)) | 0;
    }
    return `${chatId}|${name}|${hash}`;
}

function statedExpression(value, description) {
    const expression = String(value || '').trim().slice(0, 40);
    if (!expression) return '';
    const source = String(description || '').replace(/\s+/g, '').toLowerCase();
    const needle = expression.replace(/\s+/g, '').toLowerCase();
    if (!needle || !source) return '';
    return source.includes(needle) ? expression : '';
}

function pendingSkillIntentUnits(context) {
    return [
        ...(Array.isArray(context?.playerUnits) ? context.playerUnits : []),
        ...(Array.isArray(context?.allies) ? context.allies : []),
        ...(Array.isArray(context?.enemies) ? context.enemies : []),
    ];
}

/**
 * True when the context still contains skills whose role could not be inferred
 * deterministically. The UI uses this to decide whether to run the AI intent pass.
 * @param {object} context
 * @returns {boolean}
 */
export function hasPendingSkillIntents(context) {
    return pendingSkillIntentUnits(context).some(unit =>
        (unit?.skills || []).some(skill => skill && skill.passive !== true && skill.intent === 'unknown'));
}

/**
 * Ask the model to classify a batch of ambiguous skills. This function never
 * invents mechanical values: it only copies expressions the model quotes from
 * the supplied ability text.
 * @param {object[]} skills
 * @param {Record<string, any>} settings
 * @param {{ mode?: 'tactical'|'traditional', signal?: AbortSignal, chatId?: string }} [options]
 * @returns {Promise<{ ok:boolean, results:object[], warnings:string[] }>}
 */
export async function classifySkillIntentsWithAgent(skills, settings, options = {}) {
    const mode = options.mode === 'traditional' ? 'traditional' : 'tactical';
    const chatId = String(options.chatId || getActiveChatId() || '');
    const unique = new Map();
    for (const skill of Array.isArray(skills) ? skills : []) {
        if (!skill?.name) continue;
        const key = String(skill.name).trim().toLowerCase();
        if (!key || unique.has(key)) continue;
        unique.set(key, skill);
    }
    const list = [...unique.values()];
    if (!list.length) return { ok: true, results: [], warnings: [] };
    const ownsChat = createChatCommitGuard(chatId, getActiveChatId, { signal: options.signal });
    const warnings = [];
    const results = [];
    for (let offset = 0; offset < list.length; offset += MAX_SKILL_INTENT_BATCH) {
        const batch = list.slice(offset, offset + MAX_SKILL_INTENT_BATCH);
        const cached = [];
        const missing = [];
        for (const skill of batch) {
            const hit = SKILL_INTENT_CACHE.get(skillIntentCacheKey(skill, chatId));
            if (hit) cached.push({ ...hit, name: skill.name });
            else missing.push(skill);
        }
        results.push(...cached);
        if (!missing.length) continue;
        const payload = {
            mode,
            skills: missing.map(skill => ({
                name: String(skill.name || '').slice(0, 80),
                type: String(skill.type || (skill.spell ? 'spell' : 'ability')).slice(0, 20),
                description: String(skill.description || '').slice(0, 600),
                classLabel: String(skill.classLabel || '').slice(0, 80),
                owner: String(skill.owner || '').slice(0, 80),
                currentKind: String(skill.kind || '').slice(0, 20),
                resource: String(skill.resource || '').slice(0, 12),
                damage: String(skill.damage || '').slice(0, 40),
                heal: String(skill.heal || '').slice(0, 40),
                maxUses: skill.maxUses ?? null,
            })),
            rules: {
                intents: ['attack', 'heal', 'buff', 'special', 'utility', 'passive', 'noncombat'],
                utility: 'Battlefield utility only. Never assign direct damage.',
                passive: 'Always-on or triggered trait. Never a clickable action.',
                noncombat: 'No combat application at all. Keep it in the campaign registry but hide it from combat.',
                willpower: 'Use resource "willpower" only for explicit mental, morale, fear, charm, domination, sleep, or psychic effects. Use "both" when HP and Willpower are both explicitly damaged.',
                damage: 'Never invent a damage expression. Copy only dice or numbers stated in the supplied text.',
            },
        };
        try {
            const raw = await sendStateRequest(
                requestSettingsFor(settings, mode),
                String(settings?.combatSkillIntentPrompt || DEFAULT_SKILL_INTENT_PROMPT),
                `## SKILL INTENT CLASSIFICATION\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n\nReturn exactly one JSON object: {"skills":[{"name":"...","intent":"attack|heal|buff|special|utility|passive|noncombat","resource":"hp|willpower|both","damage":"","willpowerDamage":"","willpowerOutcome":"defeat","heal":"","note":""}]}`,
                options.signal || null,
                { stream: false, debugSource: 'Combat Skill Intent Classifier' },
            );
            if (!ownsChat()) return { ok: false, results, warnings: [...warnings, 'The active chat changed during skill classification.'] };
            const parsed = parseTacticalResponse(raw, 'skills');
            const responseSkills = Array.isArray(parsed.value?.skills)
                ? parsed.value.skills
                : (Array.isArray(parsed.value) ? parsed.value : []);
            if (!responseSkills.length) {
                warnings.push(parsed.error || 'The skill intent classifier returned no skills.');
                continue;
            }
            for (const result of responseSkills) {
                if (!result || typeof result !== 'object') continue;
                const name = String(result.name || '').trim();
                const intent = normalizeSkillIntent(result.intent);
                if (!name || !intent) continue;
                const source = missing.find(skill => String(skill.name || '').trim().toLowerCase() === name.toLowerCase());
                const description = source?.description || '';
                const normalized = {
                    name,
                    intent,
                    resource: normalizeWillpowerResource(result.resource, 'hp'),
                    willpowerOutcome: normalizeWillpowerOutcome(result.willpowerOutcome ?? result.willOutcome, 'defeat'),
                    // Never accept a damage/healing expression the model invented.
                    damage: statedExpression(result.damage, description),
                    willpowerDamage: statedExpression(result.willpowerDamage ?? result.willDamage, description),
                    heal: statedExpression(result.heal, description),
                    acBonus: result.acBonus == null ? null : numberOr(result.acBonus, 0, -10, 20),
                    attackBonus: result.attackBonus == null ? null : numberOr(result.attackBonus, 0, -10, 20),
                    rounds: result.rounds == null ? null : numberOr(result.rounds, 2, 1, 10),
                    note: String(result.note || '').slice(0, 240),
                };
                results.push(normalized);
                if (source) SKILL_INTENT_CACHE.set(skillIntentCacheKey(source, chatId), normalized);
            }
        } catch (error) {
            warnings.push(`Skill intent classification failed: ${String(error?.message || error)}`);
        }
    }
    return { ok: results.length > 0, results, warnings };
}

function applyIntentResultToSkill(skill, result) {
    if (!skill || !result) return false;
    const intent = normalizeSkillIntent(result.intent);
    if (!intent || intent === 'unknown') return false;
    skill.intent = intent;
    skill.intentSource = 'ai';
    if (intent === 'noncombat') {
        skill.kind = 'special';
        skill.noncombat = true;
        skill.utility = false;
        skill.passive = false;
        skill.damage = '';
        skill.willpowerDamage = '';
        skill.heal = '';
        return true;
    }
    if (intent === 'passive') {
        skill.kind = 'special';
        skill.passive = true;
        skill.noncombat = false;
        skill.utility = false;
        skill.damage = '';
        skill.willpowerDamage = '';
        skill.heal = '';
        skill.unlimited = true;
        skill.maxUses = 0;
        skill.uses = 0;
        skill.trigger = normalizePassiveTrigger(skill.trigger);
        return true;
    }
    if (intent === 'utility') {
        skill.kind = 'special';
        skill.utility = true;
        skill.passive = false;
        skill.noncombat = false;
        skill.damage = '';
        skill.willpowerDamage = '';
        skill.heal = '';
        return true;
    }
    skill.passive = false;
    skill.utility = false;
    skill.noncombat = false;
    if (intent === 'attack') {
        skill.kind = 'attack';
        if (result.resource) skill.resource = result.resource;
        if (result.damage) skill.damage = result.damage;
        if (result.willpowerDamage) skill.willpowerDamage = result.willpowerDamage;
        if (result.willpowerOutcome) skill.willpowerOutcome = result.willpowerOutcome;
        return true;
    }
    if (intent === 'heal') {
        skill.kind = 'heal';
        if (result.resource) skill.resource = result.resource;
        if (result.heal) skill.heal = result.heal;
        skill.damage = '';
        skill.willpowerDamage = '';
        return true;
    }
    if (intent === 'buff') {
        skill.kind = 'buff';
        if (result.acBonus != null) skill.acBonus = result.acBonus;
        if (result.attackBonus != null) skill.attackBonus = result.attackBonus;
        if (result.rounds != null) skill.rounds = result.rounds;
        return true;
    }
    skill.kind = 'special';
    skill.damage = '';
    skill.willpowerDamage = '';
    skill.heal = '';
    return true;
}

/**
 * Run the AI intent pass for every ambiguous skill in a collected context.
 * Skills become passive, utility, noncombat, or keep a real combat kind; the
 * function never defaults an unresolved skill to attack.
 * @param {object} context
 * @param {Record<string, any>} settings
 * @param {{ mode?: 'tactical'|'traditional', signal?: AbortSignal, chatId?: string }} [options]
 * @returns {Promise<{ changed:number, warnings:string[] }>}
 */
export async function resolvePendingSkillIntents(context, settings, options = {}) {
    const units = pendingSkillIntentUnits(context);
    const pending = [];
    const byName = new Map();
    for (const unit of units) {
        for (const skill of unit?.skills || []) {
            if (!skill || skill.passive === true || skill.intent !== 'unknown') continue;
            const key = String(skill.name || '').trim().toLowerCase();
            if (!key) continue;
            if (!byName.has(key)) {
                byName.set(key, []);
                pending.push({ ...skill, classLabel: unit.classLabel || '', owner: unit.name || '' });
            }
            byName.get(key).push(skill);
        }
    }
    if (!pending.length) return { changed: 0, warnings: [] };
    const classified = await classifySkillIntentsWithAgent(pending, settings, options);
    let changed = 0;
    const resultByName = new Map(classified.results.map(result => [String(result.name || '').trim().toLowerCase(), result]));
    for (const [key, skills] of byName) {
        const result = resultByName.get(key);
        if (!result) continue;
        for (const skill of skills) {
            if (applyIntentResultToSkill(skill, result)) changed += 1;
        }
    }
    for (const unit of units) {
        if ((unit.skills || []).some(skill => !skill?.noncombat)) continue;
        unit.skills = [...(unit.skills || []), ...fallbackSkills(unit.side || 'player', unit.classLabel)];
        changed += 1;
    }
    return { changed, warnings: classified.warnings };
}

/**
 * Compile a prose passive into a deterministic trigger/effect recipe with one
 * AI call. The result is cached in the Campaign Skill Registry.
 * @param {object} entry
 * @param {Record<string, any>} settings
 * @param {{ signal?: AbortSignal, mode?: 'tactical'|'traditional' }} [options]
 * @returns {Promise<{ ok: boolean, trigger?: object, effects?: object[], error?: string }>}
 */
export async function resolvePassiveRecipeWithAgent(entry, settings, options = {}) {
    if (!entry?.name) return { ok: false, error: 'Missing passive entry.' };
    const mode = options.mode === 'traditional' ? 'traditional' : 'tactical';
    const chatId = getActiveChatId();
    const ownsChat = createChatCommitGuard(chatId, getActiveChatId, { signal: options.signal });
    const payload = {
        passive: {
            name: String(entry.name || '').slice(0, 80),
            type: String(entry.type || 'ability').slice(0, 20),
            brief: String(entry.brief || '').slice(0, 700),
            owners: Array.isArray(entry.owners) ? entry.owners.slice(0, 8) : [],
            mechanics: {
                kind: entry.mechanics?.kind || 'special',
                resource: entry.mechanics?.resource || 'hp',
                range: entry.mechanics?.range ?? null,
                damage: entry.mechanics?.damage || '',
                heal: entry.mechanics?.heal || '',
                target: entry.mechanics?.target || '',
            },
        },
        rules: {
            supportedEvents: ['hit', 'attacked', 'round-start', 'kill'],
            supportedAttackFilters: ['melee', 'ranged', 'any'],
            supportedActionFilters: ['basic', 'skill', 'any'],
            supportedLimits: ['per-hit', 'per-turn', 'per-round', 'per-encounter'],
            selectors: ['$caster', '$target'],
            mode,
        },
    };
    try {
        const raw = await sendStateRequest(
            requestSettingsFor(settings, mode),
            String(settings?.combatPassiveResolutionPrompt || DEFAULT_COMBAT_PASSIVE_RESOLUTION_PROMPT),
            `## PASSIVE ABILITY\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n\nReturn only the JSON object with "trigger" and "effects".`,
            options.signal || null,
            { stream: false, debugSource: 'Combat Passive Resolver' },
        );
        if (!ownsChat()) return { ok: false, error: 'The active chat changed.' };
        const parsed = parseTacticalResponse(raw, 'effects');
        if (!parsed.value) return { ok: false, error: parsed.error || 'The passive resolver returned no JSON.' };
        const trigger = normalizePassiveTrigger(parsed.value.trigger);
        const effects = sanitizeEffectTemplate(parsed.value.effects, { max: 16 })
            .filter(effect => !effect.targetId)
            .map(effect => ({
                ...effect,
                ...(effect.type === 'status' && effect.damage && !effect.damageResource
                    ? { damageResource: 'hp' }
                    : {}),
            }));
        if (!effects.length) {
            return { ok: false, error: 'The passive resolver returned no usable effects.', trigger };
        }
        return { ok: true, trigger, effects };
    } catch (error) {
        return { ok: false, error: String(error?.message || error) };
    }
}

/**
 * Resolve every passive skill in a freshly collected context that does not yet
 * have a stored recipe. Mutates the context skills in place so the encounter
 * built immediately afterwards uses the compiled trigger.
 * @param {object} context
 * @param {Record<string, any>} settings
 * @param {{ signal?: AbortSignal, mode?: 'tactical'|'traditional', chatId?: string }} [options]
 * @returns {Promise<{ changed: number, warnings: string[] }>}
 */
export async function resolvePendingPassives(context, settings, options = {}) {
    const warnings = [];
    let changed = 0;
    const units = [
        ...(Array.isArray(context?.playerUnits) ? context.playerUnits : []),
        ...(Array.isArray(context?.allies) ? context.allies : []),
        ...(Array.isArray(context?.enemies) ? context.enemies : []),
    ];
    const recipes = new Map();
    const failed = new Set();
    const applyRecipe = (skill, recipe) => {
        if (!recipe) return false;
        skill.trigger = normalizePassiveTrigger(recipe.trigger);
        skill.effectTemplate = recipe.effects;
        skill.registryId = recipe.registryId || skill.registryId || '';
        skill.registryStatus = 'resolved';
        return true;
    };
    for (const unit of units) {
        for (const skill of unit?.skills || []) {
            if (skill?.passive !== true) continue;
            const key = String(skill.name || '').trim().toLowerCase();
            if (!key) continue;
            if (recipes.has(key)) {
                applyRecipe(skill, recipes.get(key));
                continue;
            }
            if (failed.has(key)) continue;
            const existingEntry = findSkillRegistryEntry(settings, skill.name, { ownerName: unit.name });
            const existingTemplate = existingEntry?.mechanics?.effectTemplate;
            if (Array.isArray(existingTemplate) && existingTemplate.length) {
                const recipe = {
                    trigger: existingEntry.mechanics.trigger,
                    effects: existingTemplate,
                    registryId: existingEntry.id || '',
                };
                recipes.set(key, recipe);
                applyRecipe(skill, recipe);
                continue;
            }
            const entry = existingEntry || {
                name: skill.name,
                type: 'ability',
                brief: skill.description || '',
                owners: [{ type: unit.side === 'enemy' ? 'enemy' : 'character', name: unit.name }],
                mechanics: {
                    kind: skill.kind,
                    resource: skill.resource,
                    range: skill.range,
                    damage: skill.damage,
                    heal: skill.heal,
                    target: skill.target,
                },
            };
            const builtin = builtinPassiveRecipe(skill.name);
            if (builtin) {
                const remembered = rememberPassiveResolution(settings, entry, builtin.trigger, builtin.effects);
                const recipe = {
                    trigger: remembered.entry?.mechanics?.trigger || builtin.trigger,
                    effects: remembered.entry?.mechanics?.effectTemplate || builtin.effects,
                    registryId: remembered.entry?.id || '',
                };
                recipes.set(key, recipe);
                applyRecipe(skill, recipe);
                changed += 1;
                continue;
            }
            const compiled = await resolvePassiveRecipeWithAgent(entry, settings, {
                signal: options.signal,
                mode: options.mode,
            });
            if (!compiled.ok) {
                failed.add(key);
                warnings.push(`${skill.name} could not be compiled into a passive recipe: ${compiled.error || 'unknown error'}. It will remain read-only.`);
                continue;
            }
            const remembered = rememberPassiveResolution(settings, entry, compiled.trigger, compiled.effects);
            const recipe = {
                trigger: remembered.entry?.mechanics?.trigger || compiled.trigger,
                effects: remembered.entry?.mechanics?.effectTemplate || compiled.effects,
                registryId: remembered.entry?.id || '',
            };
            recipes.set(key, recipe);
            applyRecipe(skill, recipe);
            changed += 1;
        }
    }
    if (changed) {
        const chatId = options.chatId || getActiveChatId();
        markSkillRegistryDirty(chatId);
        try {
            persistSkillRegistry(settings, chatId, { force: false });
        } catch (error) {
            if (settings?.debugMode) console.warn('[RPG Tracker] Passive recipe persistence failed:', error);
        }
    }
    return { changed, warnings };
}

/**
 * True when a context contains at least one passive without a stored recipe.
 * @param {object} context
 * @returns {boolean}
 */
export function hasPendingPassiveRecipes(context) {
    const units = [
        ...(Array.isArray(context?.playerUnits) ? context.playerUnits : []),
        ...(Array.isArray(context?.allies) ? context.allies : []),
        ...(Array.isArray(context?.enemies) ? context.enemies : []),
    ];
    return units.some(unit => (unit?.skills || []).some(skill =>
        skill?.passive === true && !(Array.isArray(skill.effectTemplate) && skill.effectTemplate.length),
    ));
}

/**
 * Copy freshly compiled passive recipes from a collected context into an
 * already-built encounter state. Used by the narrator-triggered background
 * compile path, where the board may be built before the resolver returns.
 * @param {object} context
 * @param {object} state
 * @returns {number} number of skills updated
 */
export function applyPassiveRecipesToState(context, state) {
    const recipeByName = new Map();
    const units = [
        ...(Array.isArray(context?.playerUnits) ? context.playerUnits : []),
        ...(Array.isArray(context?.allies) ? context.allies : []),
        ...(Array.isArray(context?.enemies) ? context.enemies : []),
    ];
    for (const unit of units) {
        for (const skill of unit?.skills || []) {
            if (skill?.passive !== true || !Array.isArray(skill.effectTemplate) || !skill.effectTemplate.length) continue;
            recipeByName.set(String(skill.name || '').toLowerCase(), {
                trigger: normalizePassiveTrigger(skill.trigger),
                effectTemplate: skill.effectTemplate,
                registryId: skill.registryId || '',
            });
        }
    }
    if (!recipeByName.size) return 0;
    let changed = 0;
    for (const unit of state?.units || []) {
        for (const skill of unit?.skills || []) {
            if (skill?.passive !== true || (Array.isArray(skill.effectTemplate) && skill.effectTemplate.length)) continue;
            const recipe = recipeByName.get(String(skill.name || '').toLowerCase());
            if (!recipe) continue;
            skill.trigger = normalizePassiveTrigger(recipe.trigger);
            skill.effectTemplate = recipe.effectTemplate;
            skill.registryId = recipe.registryId || skill.registryId || '';
            skill.registryStatus = 'resolved';
            changed += 1;
        }
    }
    return changed;
}

/**
 * Resolve one special ability/item into engine primitives. Called only when a
 * `kind: 'special'` skill or item is actually used, so ordinary combat spends
 * no extra tokens.
 *
 * @param {object} state
 * @param {object} caster
 * @param {{ kind: 'skill'|'item', name: string, description: string, area?: object }} source
 * @param {object|null} target
 * @param {Record<string, any>} settings
 * @param {{ signal?: AbortSignal, mode?: 'tactical'|'traditional', targets?: object[], area?: object, anchor?: object, areaCells?: object[], maxEffects?: number, allowedTargetIds?: string[] }} [options]
 * @returns {Promise<{ ok: boolean, effects?: object[], log?: string, error?: string }>}
 */
export async function resolveSpecialEffectWithAgent(state, caster, source, target, settings, options = {}) {
    if (!state || !caster || !source) return { ok: false, error: 'Missing special ability context.' };
    const mode = options.mode === 'traditional' ? 'traditional' : 'tactical';
    const chatId = getActiveChatId();
    const ownsChat = createChatCommitGuard(chatId, getActiveChatId, { signal: options.signal });
    const targets = Array.isArray(options.targets)
        ? options.targets.filter(unit => unit && !unit.defeated && !unit.fled)
        : (target ? [target] : []);
    const area = mode === 'traditional' ? null : normalizeArea(options.area ?? source.area ?? source.aoe);
    const areaTargets = area ? targets : [];
    const allowedTargetIds = Array.isArray(options.allowedTargetIds)
        ? options.allowedTargetIds.map(String)
        : (area
            ? [...new Set(areaTargets.map(unit => unit.id))]
            : [caster.id, target?.id].filter(Boolean).map(String));
    const maxEffects = Math.max(
        1,
        Math.min(64, Number(options.maxEffects) || (area ? Math.min(24, 6 * Math.max(1, areaTargets.length)) : 6)),
    );
    const payload = {
        ability: {
            kind: source.kind,
            name: String(source.name || 'Special ability'),
            description: String(source.description || '').slice(0, 700),
            resource: normalizeWillpowerResource(source.resource, 'hp'),
            willpowerOutcome: normalizeWillpowerOutcome(source.willpowerOutcome ?? source.willOutcome, 'defeat'),
            area: mode === 'traditional' ? null : area,
        },
        caster: compactSpecialUnit(caster),
        target: target ? compactSpecialUnit(target) : null,
        battlefield: mode === 'traditional'
            ? {
                mode: 'traditional',
                grid: 'none',
                terrain: 'none',
                units: state.units.filter(unit => !unit.defeated && !unit.fled).map(compactSpecialUnit),
            }
            : {
                rows: state.grid.rows,
                cols: state.grid.cols,
                terrainLegend: Object.fromEntries(Object.entries(TC_TERRAIN_CHARS).map(([char, id]) => [id, TC_TERRAIN[id]?.label || id])),
                terrain: state.terrain.map(row => row.map(id => terrainChar(id)).join('')),
                units: state.units.filter(unit => !unit.defeated && !unit.fled).map(compactSpecialUnit),
            },
        ...(mode === 'traditional' ? {} : {
            areaTargets: areaTargets.map(compactSpecialUnit),
            anchor: options.anchor || null,
            areaCells: Array.isArray(options.areaCells) ? options.areaCells.slice(0, 169) : [],
        }),
        rules: {
            actorSide: caster.side,
            willpower: 'Willpower is separate from HP. To break Willpower, apply damage with resource "willpower". Set willpowerOutcome on the damage effect. A defeat effect is only legal after Willpower is already 0.',
            permanentEnemyEffects: 'Permanent transformations are disabled for enemy-authored specials. Use temporary transformations unless the source is a player unit.',
            ...(mode === 'traditional' ? {} : {
                areaTargets: 'When ability.area is present, unit-targeted effects must use ids from areaTargets only. Apply the effect to each affected unit as appropriate. Do not damage allies unless friendlyFire is true.',
            }),
        },
        limits: { maxEffects },
    };
    try {
        const raw = await sendStateRequest(
            requestSettingsFor(settings, mode),
            String(mode === 'traditional'
                ? (settings?.traditionalCombatSpecialPrompt || DEFAULT_TRADITIONAL_SPECIAL_RESOLUTION_PROMPT)
                : (settings?.tacticalCombatSpecialPrompt || DEFAULT_TACTICAL_SPECIAL_RESOLUTION_PROMPT)),
            `## SPECIAL ABILITY\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n\nReturn only the JSON object with "log" and "effects".`,
            options.signal || null,
            { stream: false, debugSource: mode === 'traditional' ? 'Traditional Combat Special' : 'Tactical Combat Special' },
        );
        if (!ownsChat()) return { ok: false, error: 'The active chat changed.' };
        const parsed = parseTacticalResponse(raw, 'effects');
        if (!parsed.value) return { ok: false, error: parsed.error || 'The resolver returned no JSON.' };
        const normalized = normalizeSpecialEffects(parsed.value, state, {
            theater: mode === 'traditional',
            maxEffects,
            allowedTargetIds,
            areaCells: options.areaCells,
        });
        await fillPlayerTransformationLoadouts(state, normalized.effects, caster, source, settings, {
            mode,
            signal: options.signal,
        });
        if (!ownsChat()) return { ok: false, error: 'The active chat changed.' };
        if (!normalized.effects.length) {
            return { ok: false, error: normalized.rejected.join(' ') || 'The resolver returned no usable effects.' };
        }
        return { ok: true, effects: normalized.effects, log: normalized.log };
    } catch (error) {
        return { ok: false, error: String(error?.message || error) };
    }
}

/**
 * Resolve a declared special through the campaign registry first. A stored
 * recipe is expanded deterministically; only an unknown special reaches the AI
 * resolver, and its successful result is recorded for all later uses.
 *
 * @param {object} state
 * @param {object} prepared result of prepareSpecialAction
 * @param {{ kind?: 'skill'|'item', name: string, description?: string, resource?: string, willpowerOutcome?: string, area?: object, target?: string, damage?: string, heal?: string, willpowerDamage?: string, maxUses?: number, effectTemplate?: object[], registryId?: string, save?: string, range?: number }} source
 * @param {Record<string, any>} settings
 * @param {{ signal?: AbortSignal, mode?: 'tactical'|'traditional', allowAiFallback?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, effects?: object[], log?: string, error?: string, fromRegistry?: boolean, fromTemplate?: boolean }>}
 */
export async function resolveSpecialSource(state, prepared, source, settings, options = {}) {
    if (!state || !prepared?.ok || !prepared?.unit) {
        return { ok: false, error: prepared?.error || 'The special action could not be prepared.' };
    }
    const mode = options.mode === 'traditional' ? 'traditional' : 'tactical';
    const caster = prepared.unit;
    const targets = Array.isArray(prepared.targets) && prepared.targets.length
        ? prepared.targets.filter(unit => unit && !unit.defeated && !unit.fled)
        : (prepared.target ? [prepared.target] : []);
    const targetIds = targets.map(unit => unit.id).filter(Boolean);
    const friendlyIds = [];
    const hostileIds = [];
    for (const target of targets) {
        if (hostileTo(caster, target)) hostileIds.push(target.id);
        else if (target.id !== caster.id) friendlyIds.push(target.id);
        else friendlyIds.push(target.id);
    }
    const allowedTargetIds = allowedSpecialTargetIds(prepared);
    const maxEffects = Math.max(
        1,
        Math.min(64, Number(options.maxEffects) || (prepared.area
            ? Math.min(24, 6 * Math.max(1, targets.length))
            : 6)),
    );
    const anchor = prepared.anchor
        || (prepared.target && Number.isFinite(Number(prepared.target.x))
            ? { x: Number(prepared.target.x), y: Number(prepared.target.y) }
            : (Number.isFinite(Number(caster.x)) ? { x: Number(caster.x), y: Number(caster.y) } : null));
    const registry = getSkillRegistry(settings);
    let entry = null;
    if (source?.registryId) {
        entry = Object.values(registry.skills || {}).find(candidate => candidate.id === source.registryId) || null;
    }
    if (!entry) {
        entry = findSkillRegistryEntry(registry, source?.name || prepared.label || '', {
            ownerName: caster.name,
        });
    }
    const registryTemplate = entry?.mechanics?.effectTemplate?.length
        ? entry.mechanics.effectTemplate
        : null;
    const sourceTemplate = Array.isArray(source?.effectTemplate) && source.effectTemplate.length
        ? source.effectTemplate
        : null;
    let template = registryTemplate || sourceTemplate;
    const incompleteForm = (template || []).find(effect => effect?.formId
        && registry.forms?.[effect.formId]?.incomplete === true);
    if (incompleteForm) {
        // A previous friendly transformation could not generate a loadout. Do not
        // freeze that partial form; retry the loadout authoring once.
        template = null;
    }
    if (template?.length) {
        const expanded = resolveEffectTemplate(template, {
            casterId: caster.id,
            casterName: caster.name,
            casterX: caster.x,
            casterY: caster.y,
            targetId: prepared.target?.id || caster.id,
            targetName: prepared.target?.name || '',
            targetIds,
            friendlyIds,
            hostileIds,
            anchor,
            forms: registry.forms,
        });
        const missingForm = expanded.find(effect => effect?.type === 'transform'
            && effect.formId
            && !effect.name
            && effect.maxHp == null
            && effect.ac == null
            && !Array.isArray(effect.skills));
        if (missingForm) {
            return {
                ok: false,
                error: `The registered transformation form "${missingForm.formId}" is missing from the Skill Registry.`,
                fromRegistry: !!registryTemplate,
                fromTemplate: true,
            };
        }
        const normalized = normalizeSpecialEffects({ effects: expanded }, state, {
            theater: mode === 'traditional',
            maxEffects: Math.max(maxEffects, expanded.length),
            allowedTargetIds,
            areaCells: prepared.areaCells,
        });
        if (!normalized.effects.length) {
            return {
                ok: false,
                error: normalized.rejected.join(' ') || `${source?.name || 'The special ability'} has no legal registered effect in this situation.`,
                fromRegistry: !!registryTemplate,
                fromTemplate: true,
            };
        }
        if (!registryTemplate && sourceTemplate) {
            try {
                rememberSpecialResolution(settings, prepared, source, normalized.effects, { force: false });
                markSkillRegistryDirty(getActiveChatId());
            } catch (error) {
                if (settings?.debugMode) {
                    console.warn('[RPG Tracker] Could not record authored special template:', error);
                }
            }
        }
        return {
            ok: true,
            effects: normalized.effects,
            log: '',
            fromRegistry: !!registryTemplate,
            fromTemplate: true,
        };
    }
    if (options.allowAiFallback === false) {
        return { ok: false, error: `${source?.name || 'The special ability'} has no deterministic recipe.` };
    }
    const resolved = await resolveSpecialEffectWithAgent(
        state,
        caster,
        {
            ...source,
            kind: source?.kind || 'skill',
            name: source?.name || prepared.label || 'Special ability',
            description: source?.description || '',
            resource: source?.resource,
            willpowerOutcome: source?.willpowerOutcome,
            area: source?.area ?? prepared.area,
            target: source?.target,
            damage: source?.damage,
            heal: source?.heal,
            willpowerDamage: source?.willpowerDamage,
            maxUses: source?.maxUses,
        },
        prepared.target,
        settings,
        {
            signal: options.signal,
            mode,
            targets,
            area: prepared.area,
            anchor: prepared.anchor,
            areaCells: prepared.areaCells,
            maxEffects,
            allowedTargetIds,
        },
    );
    if (!resolved.ok) return { ok: false, error: resolved.error || 'The special resolver failed.' };
    try {
        rememberSpecialResolution(settings, prepared, source, resolved.effects || [], {
            force: options.force === true,
        });
        markSkillRegistryDirty(getActiveChatId());
    } catch (error) {
        if (settings?.debugMode) {
            console.warn('[RPG Tracker] Could not record special resolution:', error);
        }
    }
    return {
        ok: true,
        effects: resolved.effects || [],
        log: resolved.log || '',
        fromRegistry: false,
        fromTemplate: false,
    };
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

function chooseBestAreaAttack(state, caster, unit, targets) {
    let best = null;
    for (const skill of unit.skills || []) {
        const area = normalizeArea(skill.area);
        if (skill.kind !== 'attack' || !area || !hasUses(skill, caster)) continue;
        if (skill.bonusAction ? unit.bonusUsed : unit.actionUsed) continue;
        const anchors = area.origin === 'self'
            ? [{ targetId: unit.id, cell: { x: caster.x, y: caster.y } }]
            : targets.map(target => ({ targetId: target.id, cell: { x: target.x, y: target.y } }));
        for (const anchor of anchors) {
            const result = getAreaTargets(state, caster, skill, anchor.cell, { allowEmpty: false });
            if (!result.ok) continue;
            const hostiles = result.targets.filter(target => hostileTo(unit, target));
            if (hostiles.length < 2) continue;
            if (result.targets.some(target => !hostileTo(unit, target))) continue;
            const score = hostiles.length * 100 + Math.max(0, Number(skill.damage ? 1 : 0));
            if (!best || score > best.score) {
                best = { skill, anchor, targets: hostiles, score };
            }
        }
    }
    return best;
}

/**
 * Deterministic local tactics. Returns declarative actions (does not mutate).
 * @param {object} state
 * @param {string[]} unitIds
 * @param {{ rng?: () => number, allowMove?: boolean, theater?: boolean }} [options]
 * @returns {object[]}
 */
export function buildLocalAiActions(state, unitIds, options = {}) {
    const actions = [];
    const ids = Array.isArray(unitIds) ? unitIds : [];
    const allowMove = options.allowMove !== false;
    const theater = options.theater === true || state?.theater === true;
    const catalog = Array.isArray(options.catalog) ? options.catalog : null;
    const canUse = (type) => !catalog || catalog.some(entry => entry.type === type && entry.enabled !== false);
    for (const unitId of ids) {
        const unit = state.units.find(candidate => candidate.id === unitId);
        if (!unit || unit.defeated || unit.fled || unit.doneForRound) continue;
        const targets = livingUnits(state).filter(target => target.id !== unit.id && hostileTo(unit, target));
        if (!targets.length) {
            if (canUse('wait')) actions.push({ type: 'wait', unitId: unit.id });
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
        if (canUse('skill') && !actionUsed && unit.hp <= unit.maxHp * 0.35) {
            const heal = (unit.skills || []).find(skill =>
                skill.kind === 'heal'
                && hasUses(skill, unit)
                && skill.resource !== 'willpower');
            if (heal && (!heal.bonusAction || !bonusUsed)) {
                actions.push({ type: 'skill', unitId: unit.id, skillId: heal.id, targetId: unit.id });
                if (heal.bonusAction) bonusUsed = true;
                else actionUsed = true;
                performed = true;
            }
        }
        if (canUse('skill') && !actionUsed && Number(unit.maxWillpower) > 0 && unit.willpower <= unit.maxWillpower * 0.35) {
            const heal = (unit.skills || []).find(skill =>
                skill.kind === 'heal'
                && hasUses(skill, unit)
                && skill.resource === 'willpower');
            if (heal && (!heal.bonusAction || !bonusUsed)) {
                actions.push({ type: 'skill', unitId: unit.id, skillId: heal.id, targetId: unit.id });
                if (heal.bonusAction) bonusUsed = true;
                else actionUsed = true;
                performed = true;
            }
        }

        let moved = false;
        const projected = { ...unit };
        if (allowMove && canUse('move') && !isAdjacentEnough(state, projected, target) && unit.movementUsed < unit.speed) {
            const best = chooseStrategicCell(state, unit, target);
            if (best && (best.x !== unit.x || best.y !== unit.y)) {
                actions.push({ type: 'move', unitId: unit.id, to: { x: best.x, y: best.y } });
                projected.x = best.x;
                projected.y = best.y;
                moved = true;
                performed = true;
            }
        }

        if (canUse('skill') && !actionUsed) {
            const areaAttack = chooseBestAreaAttack(
                state,
                projected,
                { ...unit, actionUsed, bonusUsed },
                targets,
            );
            if (areaAttack) {
                actions.push({
                    type: 'skill',
                    unitId: unit.id,
                    skillId: areaAttack.skill.id,
                    targetId: areaAttack.anchor.targetId,
                });
                if (areaAttack.skill.bonusAction) bonusUsed = true;
                else actionUsed = true;
                performed = true;
            }
        }

        if (!actionUsed && isAdjacentEnough(state, projected, target)) {
            const willpowerSkill = canUse('skill') ? (unit.skills || []).find(skill =>
                skill.kind === 'attack'
                && skill.resource === 'willpower'
                && hasUses(skill, unit)
                && (skill.bonusAction ? !bonusUsed : !actionUsed)
                && chebyshev(projected, target) <= (Number(skill.range) || 1)
                && ((Number(skill.range) || 1) <= 1 || hasLineOfSight(state, projected, target))) : null;
            if (willpowerSkill && Number(target.maxWillpower) > 0) {
                actions.push({ type: 'skill', unitId: unit.id, skillId: willpowerSkill.id, targetId: target.id });
                if (willpowerSkill.bonusAction) bonusUsed = true;
                else actionUsed = true;
                performed = true;
            } else if (canUse('attack')) {
                actions.push({ type: 'attack', unitId: unit.id, targetId: target.id });
                actionUsed = true;
                performed = true;
            } else if (canUse('skill')) {
                const attackSkill = (unit.skills || []).find(skill => skill.kind === 'attack' && hasUses(skill, unit));
                if (attackSkill) {
                    actions.push({ type: 'skill', unitId: unit.id, skillId: attackSkill.id, targetId: target.id });
                    actionUsed = true;
                    performed = true;
                }
            }
        } else if (!actionUsed && !moved && canUse('defend')) {
            actions.push({ type: 'defend', unitId: unit.id });
            actionUsed = true;
            performed = true;
        }

        // Every unit must produce at least one action so the batch is complete.
        if (!performed && canUse('wait')) actions.push({ type: 'wait', unitId: unit.id });
    }
    return actions;
}

export function allowedSpecialTargetIds(prepared) {
    const targets = Array.isArray(prepared?.targets)
        ? prepared.targets
        : (prepared?.target ? [prepared.target] : []);
    if (!prepared?.area) {
        return [...new Set([prepared?.unit?.id, prepared?.target?.id].filter(Boolean).map(String))];
    }
    // Area support effects already include the caster when they are inside the
    // self-centered aura or target burst. Never add the caster unconditionally:
    // that would let a heal burst reach a caster standing outside it.
    return [...new Set(targets.map(target => target.id).filter(Boolean).map(String))];
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
    const resolved = await resolveSpecialSource(state, prepared, {
        kind: prepared.skill ? 'skill' : 'item',
        name: source.name,
        description: source.description || '',
        resource: source.resource,
        willpowerOutcome: source.willpowerOutcome,
        area: source.area,
        target: source.target,
        damage: source.damage,
        heal: source.heal,
        willpowerDamage: source.willpowerDamage,
        maxUses: source.maxUses,
        effectTemplate: source.effectTemplate,
        registryId: source.registryId,
        save: source.save,
        range: source.range,
    }, settings, {
        signal: options.signal,
        mode: options.mode,
    });
    if (!resolved.ok) {
        return { result: { ok: false, error: resolved.error || 'The special resolver failed.' }, special: true, applied: [] };
    }
    const effects = resolved.effects || [];
    const log = resolved.log || '';
    const result = applySpecialEffects(state, effects, {
        casterId: prepared.unit.id,
        skillId: prepared.skill?.id,
        itemId: prepared.item?.id,
        label: source.name,
        narrative: log,
        rng: options.rng,
        maxEffects: Math.max(32, effects.length),
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
 * @param {{ signal?: AbortSignal, rng?: () => number, catalog?: object[], mode?: 'tactical'|'traditional', prompts?: object, allowMove?: boolean }} [options]
 * @returns {Promise<{ source: string, applied: object[], rejected: object[], ended: boolean, error: string, attempts: number }>}
 */
export async function runAgentTurn(state, unitIds, settings, options = {}) {
    const mode = options.mode === 'traditional' ? 'traditional' : 'tactical';
    const ids = (Array.isArray(unitIds) ? unitIds : []).filter(id => {
        const unit = state.units.find(candidate => candidate.id === id);
        return unit && !unit.defeated && !unit.fled;
    });
    if (!ids.length) return { source: 'none', applied: [], rejected: [], ended: state.status !== 'active', error: '', attempts: 0 };

    const runChatId = getActiveChatId();
    const ownsRun = () => String(getActiveChatId() || '') === String(runChatId || '');
    const catalogResult = getActionCatalog(settings, mode === 'traditional' ? 'traditionalCombatActionCatalogJson' : 'tacticalCombatActionCatalogJson');
    const catalog = options.catalog || catalogResult.catalog;
    const responses = await requestAgentActions(state, ids, settings, { ...options, catalog, mode });
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
    const engineRejected = [];
    const maxSpecialResolutions = maxSpecialResolutionsFor(settings, mode);
    let specialResolutions = 0;
    let attempts = responses.attempts;
    const executeBatch = async (batch) => {
        for (const action of batch) {
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
            const deterministicSpecial = isSpecial && hasDeterministicSpecialRecipe(settings, skill || item);
            if (isSpecial && !deterministicSpecial && specialResolutions >= maxSpecialResolutions) {
                rejected.push({ action, error: `Special resolution limit reached (${maxSpecialResolutions} per activation).` });
                continue;
            }
            if (isSpecial && !deterministicSpecial) specialResolutions += 1;
            const executed = await executeAgentAction(state, action, settings, options);
            if (executed.result.ok) {
                applied.push(...executed.applied);
                if (!actedUnitIds.includes(action.unitId)) actedUnitIds.push(action.unitId);
            } else {
                const entry = { action, error: executed.result.error || 'Rejected.' };
                rejected.push(entry);
                engineRejected.push(entry);
            }
        }
    };

    await executeBatch(actions);

    let acted = new Set(actedUnitIds);
    let missing = ids.filter(id => !acted.has(id));
    // One corrective agent call after the local engine rejects actions. This is
    // cheaper and more reliable than immediately replacing the model with local
    // tactics, while still bounded to a single retry.
    if (source === 'agent' && state.status === 'active' && engineRejected.length && missing.length) {
        const correction = engineRejected.slice(0, 8)
            .map(entry => `- ${entry.action?.unitId || 'unknown unit'} (${entry.action?.type || 'action'}): ${entry.error}`)
            .join('\n');
        const corrected = await requestAgentActions(state, missing, settings, {
            ...options,
            catalog,
            mode,
            prompts: undefined,
            correction: `The engine rejected these declared actions:\n${correction}\nUse only legal target ids, current resources, and the action vocabulary.`,
        });
        attempts += corrected.attempts || 0;
        if (ownsRun() && !options.signal?.aborted) {
            if (corrected.ok && corrected.actions?.length) {
                rejected.push(...(corrected.rejected || []));
                await executeBatch(corrected.actions);
            } else if (corrected.error) {
                error = corrected.error;
            }
        }
        acted = new Set(actedUnitIds);
        missing = ids.filter(id => !acted.has(id));
    }

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
        attempts,
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
