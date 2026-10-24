/**
 * tactical-combat-willpower.js — shared Willpower vocabulary and deterministic
 * derivation helpers.
 *
 * Willpower is the tactical combat morale pool. It is deliberately separate
 * from the `Saves: ... Will +X` saving throw: the save still exists and is used
 * as an input to a character's maximum Willpower.
 *
 * This module stays dependency-free apart from the small integer clamp helper so
 * the engine, memo parser, agent payloads, and UI can share one vocabulary.
 */

import { clampInt } from './tactical-combat-constants.js';

export const TC_WILLPOWER_RESOURCES = ['hp', 'willpower', 'both'];

export const TC_WILLPOWER_OUTCOMES = [
    'defeat',
    'flee',
    'switch_side',
    'incapacitate',
    'surrender',
];

export const TC_STATUS_BEHAVIORS = [
    'stunned',
    'confused',
    'frightened',
    'charmed',
    'berserk',
];

export const TC_WILLPOWER_OUTCOME_LABELS = {
    defeat: 'broken',
    flee: 'fled in terror',
    switch_side: 'turned against former allies',
    incapacitate: 'incapacitated',
    surrender: 'surrendered',
};

/**
 * Normalize a resource id. Accepts the old prototype shorthand (`will`) as an
 * alias so partially migrated data keeps working.
 * @param {unknown} value
 * @param {'hp'|'willpower'|'both'} [fallback]
 * @returns {'hp'|'willpower'|'both'}
 */
export function normalizeWillpowerResource(value, fallback = 'hp') {
    const raw = String(value ?? '').trim().toLowerCase();
    if (raw === 'willpower' || raw === 'will' || raw === 'morale') return 'willpower';
    if (raw === 'both' || raw === 'hp+willpower' || raw === 'hp+will' || raw === 'willpower+hp') return 'both';
    if (raw === 'hp' || raw === 'health') return 'hp';
    return fallback;
}

/**
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeWillpowerOutcome(value, fallback = 'defeat') {
    const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (TC_WILLPOWER_OUTCOMES.includes(raw)) return raw;
    if (raw === 'escape' || raw === 'retreat' || raw === 'panic') return 'flee';
    if (raw === 'switch' || raw === 'side_switch' || raw === 'mind_control' || raw === 'charm') return 'switch_side';
    if (raw === 'sleep' || raw === 'unconscious' || raw === 'stunned' || raw === 'paralyzed') return 'incapacitate';
    if (raw === 'yield' || raw === 'submit') return 'surrender';
    if (raw === 'broken' || raw === 'down' || raw === 'lose') return 'defeat';
    return fallback;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeStatusBehavior(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    return TC_STATUS_BEHAVIORS.includes(raw) ? raw : '';
}

/**
 * @param {string} outcome
 * @returns {string}
 */
export function willpowerOutcomeLabel(outcome) {
    return TC_WILLPOWER_OUTCOME_LABELS[normalizeWillpowerOutcome(outcome)] || 'broken';
}

/**
 * Deterministic baseline. Explicit `Willpower: current/max` lines and
 * architect-authored `maxWillpower` values override this.
 *
 * The result is intentionally below max HP for ordinary characters:
 *   2 + 30% of max HP + positive WIS modifier + positive Will save.
 *
 * @param {number} maxHp
 * @param {number} wisMod
 * @param {number} willSave
 * @returns {number}
 */
export function deriveMaxWillpower(maxHp, wisMod = 0, willSave = 0, maxPercent = 30) {
    const hp = Math.max(1, Math.round(Number(maxHp) || 1));
    const ratio = Math.max(0.05, Math.min(0.9, (Number(maxPercent) || 30) / 100));
    const raw = 2
        + Math.round(hp * ratio)
        + Math.max(0, Math.round(Number(wisMod) || 0))
        + Math.max(0, Math.round(Number(willSave) || 0));
    const cap = Math.max(1, hp - 1);
    return clampInt(Math.min(raw, cap), 1, 60);
}

/**
 * @param {object|null|undefined} unit
 * @returns {boolean}
 */
export function isWillpowerImmune(unit) {
    return Number(unit?.maxWillpower) === 0;
}
