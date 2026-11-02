/**
 * tactical-combat-passives.js — shared passive-trigger vocabulary.
 *
 * Passives are not actions. A passive stores a trigger plus the same
 * deterministic effectTemplate used by special abilities. The AI resolver
 * authors that recipe once; the engine evaluates it automatically.
 */

const PASSIVE_EVENTS = new Set(['hit', 'attacked', 'round-start', 'kill']);
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
    if (event === 'turn-start' || event === 'start-of-turn') event = 'round-start';
    if (!PASSIVE_EVENTS.has(event)) event = 'hit';
    const attack = normalizedToken(source.attack ?? source.hit, 'any');
    const action = normalizedToken(source.action ?? source.with, 'any');
    const limit = normalizedToken(source.limit ?? source.frequency, 'per-hit');
    return {
        event,
        attack: PASSIVE_ATTACKS.has(attack) ? attack : 'any',
        action: PASSIVE_ACTIONS.has(action) ? action : 'any',
        limit: PASSIVE_LIMITS.has(limit) ? limit : 'per-hit',
        count: clampInt(source.count, 1, 99, 1),
    };
}

/**
 * @param {object|null|undefined} skill
 * @param {'hit'|'attacked'|'round-start'|'kill'} event
 * @param {{attackType?:string, actionType?:string}} [context]
 * @returns {boolean}
 */
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
    else if (trigger.event === 'kill') text = 'on kill';
    else {
        const attack = trigger.attack === 'melee' ? 'melee ' : trigger.attack === 'ranged' ? 'ranged ' : '';
        const action = trigger.action === 'basic' ? 'attack' : trigger.action === 'skill' ? 'skill' : 'hit';
        text = `on ${attack}${action}`;
    }
    if (trigger.limit !== 'per-hit') {
        const limit = trigger.limit.replace('per-', 'per ');
        text += ` (${trigger.count > 1 ? `${trigger.count} ` : ''}${limit})`;
    }
    return text;
}

export { PASSIVE_EVENTS, PASSIVE_ATTACKS, PASSIVE_ACTIONS, PASSIVE_LIMITS };
