/**
 * lewd-combat-states.js — stances, holds, escapes, and the overwhelmed window.
 *
 * These helpers are deliberately pure data operations on the board state. They
 * do not roll dice unless the caller supplies the roll, so the engine can keep
 * the seeded RNG stream in one place (`lewd-combat-engine.js`).
 */

import {
    findEngagement,
    holdsOn,
    releaseHold,
} from './lewd-combat-pairing.js';

export const LEWD_STANCE_DEFINITIONS = Object.freeze([
    { id: 'commanding', label: 'Commanding', poiseBonus: 2, description: 'In control and unshaken.' },
    { id: 'yielding', label: 'Yielding', poiseBonus: 1, description: 'Soft, open, and hard to rattle.' },
    { id: 'entwined', label: 'Entwined', poiseBonus: 1, description: 'Close enough that distance stops helping.' },
    { id: 'guarded', label: 'Guarded', poiseBonus: 2, description: 'Careful, watchful, and defended.' },
    { id: 'teasing', label: 'Teasing', poiseBonus: 0, description: 'Playing for reactions, not for contact.' },
    { id: 'devoted', label: 'Devoted', poiseBonus: 1, description: 'Giving the partner your full attention.' },
]);

const STANCE_BY_ID = new Map(LEWD_STANCE_DEFINITIONS.map(stance => [stance.id, stance]));

function clamp(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function slug(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'state';
}

export function findStanceDefinition(idOrLabel) {
    const key = String(idOrLabel ?? '').trim().toLowerCase();
    if (!key) return null;
    return STANCE_BY_ID.get(slug(key))
        || LEWD_STANCE_DEFINITIONS.find(stance => stance.label.toLowerCase() === key)
        || null;
}

/**
 * Normalize a stance from a shipped definition, a technique application, or a
 * stored board. Unknown labels are retained (the engine still gets a stable id
 * and a 0 bonus) so a homebrew stance is never silently discarded.
 */
export function normalizeStance(stance, fallbackRounds = 3) {
    if (!stance) return null;
    const source = typeof stance === 'string' ? { label: stance } : stance;
    const label = String(source.label ?? source.name ?? source.id ?? '').trim();
    if (!label) return null;
    const definition = findStanceDefinition(source.id || label);
    return {
        id: slug(source.id || definition?.id || label),
        label: source.label || definition?.label || label,
        poiseBonus: Number(source.poiseBonus ?? definition?.poiseBonus) || 0,
        accuracyBonus: Number(source.accuracyBonus) || 0,
        roundsLeft: clamp(source.roundsLeft ?? source.rounds ?? fallbackRounds, 1, 99, fallbackRounds),
    };
}

/** Apply a stance, replacing any current stance. */
export function applyStance(participant, stance, options = {}) {
    if (!participant) return null;
    const normalized = normalizeStance(stance, options.rounds ?? 3);
    if (!normalized) return null;
    normalized.appliedRound = Math.max(1, Number(options.round) || 1);
    participant.stance = normalized;
    return normalized;
}

/** Remove the current stance. */
export function clearStance(participant) {
    if (!participant) return null;
    const previous = participant.stance || null;
    participant.stance = null;
    return previous;
}

/**
 * Called when a participant changes posture: stances do not survive a posture
 * change. Returns the stance that was dropped.
 */
export function expireStanceOnPostureChange(participant, nextPosture) {
    if (!participant?.stance) return null;
    if (!nextPosture || !participant.lastPosture || participant.lastPosture === nextPosture) return null;
    return clearStance(participant);
}

/** Tick a stance at the end of a round, expiring it at 0. */
export function tickStance(participant) {
    if (!participant?.stance) return null;
    participant.stance.roundsLeft = Number(participant.stance.roundsLeft) - 1;
    if (participant.stance.roundsLeft <= 0) {
        const expired = participant.stance;
        participant.stance = null;
        return expired;
    }
    return null;
}

/**
 * Normalize a hold from a technique, a string, or a stored board. `escapeDC`
 * defaults to the technique's `hold.dc` or 12.
 */
export function normalizeHold(hold, technique) {
    if (!hold) return null;
    const source = typeof hold === 'string' ? { label: hold } : hold;
    const label = String(source.label ?? source.name ?? source.id ?? technique?.name ?? 'Hold').trim();
    if (!label) return null;
    return {
        id: slug(source.id || label),
        label,
        poiseBonus: Number(source.poiseBonus) || 0,
        accuracyBonus: Number(source.accuracyBonus) || 0,
        escapeDC: clamp(source.escapeDC ?? source.dc ?? technique?.escapeDC ?? technique?.hold?.dc ?? 12, 1, 40, 12),
    };
}

/** Holds currently applied to a participant (holder resolved). */
export function holdsAgainst(state, participant) {
    return holdsOn(state, participant);
}

/** The hold connecting two participants, or null. */
export function holdBetween(state, a, b) {
    return findEngagement(state, a, b)?.hold || null;
}

/** Base escape modifier from Poise. */
export function poiseEscapeBonus(participant) {
    return Math.floor((Number(participant?.poise) || 0) / 2);
}

/** Extra escape modifier from experience (matches the engine's +1 per 2 XP, cap 3). */
export function experienceEscapeBonus(participant) {
    return clamp(Math.floor((Number(participant?.profile?.experience) || 0) / 2), 0, 3, 0);
}

/**
 * Resolve an escape attempt with a caller-supplied d20 roll. On success the hold
 * is released; the pair remains engaged but no longer held.
 *
 * @param {object} state
 * @param {object} participant
 * @param {object|string} holderOrEdge
 * @param {{ roll: number, poiseBonus?: number, escapeBonus?: number }} options
 * @returns {{ resolved: boolean, reason?: string, success?: boolean, total?: number, dc?: number, hold?: object }}
 */
export function attemptEscape(state, participant, holderOrEdge, options = {}) {
    if (!state || !participant) return { resolved: false, reason: 'Participant not found.' };
    const holderId = typeof holderOrEdge === 'object' && holderOrEdge?.hold
        ? (holderOrEdge.a === participant.id ? holderOrEdge.b : holderOrEdge.a)
        : String(holderOrEdge?.id ?? holderOrEdge ?? '');
    const edge = holderOrEdge?.hold ? holderOrEdge : findEngagement(state, participant.id, holderId);
    if (!edge?.hold) return { resolved: false, reason: 'You are not being held.' };
    const holder = typeof holderOrEdge === 'object' && holderOrEdge?.hold
        ? state.participants?.find(candidate => candidate.id === holderId)
        : holderOrEdge;
    const hold = edge.hold;
    const dc = clamp(hold.escapeDC ?? hold.dc ?? 12, 1, 40, 12);
    const roll = Number(options.roll);
    if (!Number.isFinite(roll)) return { resolved: false, reason: 'Escape needs a d20 roll.' };
    const total = roll
        + (Number(options.poiseBonus) || 0)
        + (Number(options.escapeBonus) || 0);
    const success = total >= dc;
    if (success) releaseHold(state, participant.id, holderId);
    return {
        resolved: true,
        success,
        roll,
        total,
        dc,
        hold,
        holderId,
        holderName: holder?.name || holderId,
        edge,
    };
}

/** True while a participant's overwhelmed window is still open. */
export function isOverwhelmed(state, participant) {
    if (!state || !participant) return false;
    return Number(participant.overwhelmedUntilRound) >= Number(state.round);
}

/**
 * Open or extend the overwhelmed window. Overwhelmed participants gain more
 * Arousal and unlock finishers; the window ends at the end of the next round.
 */
export function markOverwhelmed(state, participant, extraRounds = 0) {
    if (!state || !participant) return 0;
    const round = Math.max(1, Number(state.round) || 1);
    const until = round + 1 + Math.max(0, Math.floor(Number(extraRounds) || 0));
    participant.overwhelmedUntilRound = Math.max(Number(participant.overwhelmedUntilRound) || 0, until);
    participant.stance = null;
    return participant.overwhelmedUntilRound;
}

/**
 * Close the overwhelmed window when it has expired and refresh Poise to half
 * (rounded up). Returns true when the window was closed.
 */
export function tickOverwhelmed(state, participant) {
    if (!state || !participant?.overwhelmedUntilRound) return false;
    if (Number(state.round) <= Number(participant.overwhelmedUntilRound)) return false;
    participant.overwhelmedUntilRound = 0;
    const half = Math.ceil((Number(participant.maxPoise) || 0) / 2);
    participant.poise = clamp(Math.max(Number(participant.poise) || 0, half), 0, participant.maxPoise, half);
    return true;
}

/** Clear the window immediately (used by a reset or a completed recovery). */
export function clearOverwhelmed(participant) {
    if (!participant) return;
    participant.overwhelmedUntilRound = 0;
}
