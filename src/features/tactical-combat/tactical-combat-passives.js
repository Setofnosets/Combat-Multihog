/**
 * tactical-combat-passives.js — shared passive-trigger vocabulary.
 *
 * Passives are not actions. A passive stores a trigger plus the same
 * deterministic effectTemplate used by special abilities. The AI resolver
 * authors that recipe once; the engine evaluates it automatically.
 */

import { describeCombatCondition, normalizeCombatCondition } from './tactical-combat-variables.js';

const PASSIVE_EVENTS = new Set([
    'hit',
    'attacked',
    'round-start',
    'battle-start',
    'turn-start',
    'damaged',
    'low-hp',
    'kill',
    'willpower-break',
]);
const PASSIVE_ATTACKS = new Set(['melee', 'ranged', 'any']);
const PASSIVE_ACTIONS = new Set(['basic', 'skill', 'any']);
const PASSIVE_LIMITS = new Set(['per-hit', 'per-turn', 'per-round', 'per-encounter']);

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function normalizedToken(value, fallback = '') {
    return String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * Normalize a stored passive trigger. Unknown values fall back to the safest
 * on-hit behavior so malformed registry data cannot crash a fight.
 * @param {any} raw
 * @returns {{event:string, attack:string, action:string, limit:string, count:number}}
 */
export function normalizePassiveTrigger(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    let event = normalizedToken(source.event ?? source.on, 'hit');
    if (event === 'start-of-turn' || event === 'start-turn') event = 'turn-start';
    if (event === 'start-of-round' || event === 'begin-round') event = 'round-start';
    if (event === 'start-of-combat' || event === 'combat-start') event = 'battle-start';
    if (event === 'took-damage' || event === 'on-damaged' || event === 'damage-taken') event = 'damaged';
    if (event === 'low-health' || event === 'low-hp-trigger') event = 'low-hp';
    if (event === 'willpower-break' || event === 'will-break') event = 'willpower-break';
    if (!PASSIVE_EVENTS.has(event)) event = 'hit';
    const attack = normalizedToken(source.attack ?? source.hit, 'any');
    const action = normalizedToken(source.action ?? source.with, 'any');
    const limit = normalizedToken(source.limit ?? source.frequency, 'per-hit');
    const trigger = {
        event,
        attack: PASSIVE_ATTACKS.has(attack) ? attack : 'any',
        action: PASSIVE_ACTIONS.has(action) ? action : 'any',
        limit: PASSIVE_LIMITS.has(limit) ? limit : 'per-hit',
        count: clampInt(source.count, 1, 99, 1),
    };
    const condition = normalizeCombatCondition(source.condition);
    if (condition) trigger.condition = condition;
    return trigger;
}

/**
 * @param {object|null|undefined} skill
 * @param {'hit'|'attacked'|'round-start'|'kill'} event
 * @param {{attackType?:string, actionType?:string}} [context]
 * @returns {boolean}
 */
const BUILTIN_PASSIVE_RECIPES = Object.freeze({
    'pack tactics': {
        trigger: { event: 'hit', attack: 'any', action: 'any', limit: 'per-hit', condition: { variable: 'allies', op: 'gte', value: 1 } },
        effects: [{ type: 'status', target: '$caster', label: 'Pack Tactics', rounds: 1, attackBonus: 2, maxStacks: 1 }],
    },
    regeneration: {
        trigger: { event: 'round-start', limit: 'per-round' },
        effects: [{ type: 'heal', target: '$caster', amount: '1d6', resource: 'hp' }],
    },
    'brutal strike': {
        trigger: { event: 'hit', attack: 'melee', action: 'any', limit: 'per-turn' },
        effects: [{ type: 'damage', target: '$target', amount: '1d6', resource: 'hp' }],
    },
    'sneak attack': {
        trigger: { event: 'hit', attack: 'any', action: 'any', limit: 'per-turn', condition: { variable: 'allies', op: 'gte', value: 1 } },
        effects: [{ type: 'damage', target: '$target', amount: '1d6', resource: 'hp' }],
    },
    relentless: {
        trigger: { event: 'low-hp', limit: 'per-encounter', condition: { variable: 'hpPct', op: 'lte', value: 25 } },
        effects: [{ type: 'heal', target: '$caster', amount: '1d4', resource: 'hp' }, { type: 'log', text: 'Relentless resolve keeps the combatant standing.' }],
    },
    'undead fortitude': {
        trigger: { event: 'low-hp', limit: 'per-encounter', condition: { variable: 'hpPct', op: 'lte', value: 25 } },
        effects: [{ type: 'heal', target: '$caster', amount: '1d6', resource: 'hp' }],
    },
});

/**
 * Standard tabletop passives do not need an AI call. Returns a cloned recipe
 * for a known passive name, or null when the name is not built in.
 * @param {string} name
 * @returns {{trigger:object, effects:object[]}|null}
 */
export function builtinPassiveRecipe(name) {
    const key = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const recipe = BUILTIN_PASSIVE_RECIPES[key];
    if (!recipe) return null;
    return JSON.parse(JSON.stringify(recipe));
}

export function passiveMatchesEvent(skill, event, context = {}) {
    if (!skill || skill.passive !== true || !skill.trigger) return false;
    const trigger = normalizePassiveTrigger(skill.trigger);
    if (trigger.event !== event) return false;
    if (event === 'hit' || event === 'attacked') {
        if (trigger.attack !== 'any') {
            const attackType = normalizedToken(context.attackType, 'any');
            if (attackType !== trigger.attack) return false;
        }
        if (trigger.action !== 'any') {
            const actionType = normalizedToken(context.actionType, 'any');
            if (actionType !== trigger.action) return false;
        }
    }
    return true;
}

/**
 * Human-readable trigger text used by the skill registry and UI.
 * @param {any} raw
 * @returns {string}
 */
export function describePassiveTrigger(raw) {
    const trigger = normalizePassiveTrigger(raw);
    let text = 'on hit';
    if (trigger.event === 'attacked') text = 'when hit';
    else if (trigger.event === 'round-start') text = 'at round start';
    else if (trigger.event === 'battle-start') text = 'at battle start';
    else if (trigger.event === 'turn-start') text = 'at turn start';
    else if (trigger.event === 'damaged') text = 'when damaged';
    else if (trigger.event === 'low-hp') text = 'when badly wounded';
    else if (trigger.event === 'kill') text = 'on kill';
    else if (trigger.event === 'willpower-break') text = 'on Willpower break';
    else {
        const attack = trigger.attack === 'melee' ? 'melee ' : trigger.attack === 'ranged' ? 'ranged ' : '';
        const action = trigger.action === 'basic' ? 'attack' : trigger.action === 'skill' ? 'skill' : 'hit';
        text = `on ${attack}${action}`;
    }
    if (trigger.limit !== 'per-hit') {
        const limit = trigger.limit.replace('per-', 'per ');
        text += ` (${trigger.count > 1 ? `${trigger.count} ` : ''}${limit})`;
    }
    if (trigger.condition) {
        const condition = describeCombatCondition(trigger.condition);
        if (condition) text += ` when ${condition}`;
    }
    return text;
}

export { PASSIVE_EVENTS, PASSIVE_ATTACKS, PASSIVE_ACTIONS, PASSIVE_LIMITS };
