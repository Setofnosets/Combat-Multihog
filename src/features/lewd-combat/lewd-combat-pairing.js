/**
 * lewd-combat-pairing.js — who is involved, who is with whom, and which holds
 * connect them.
 *
 * An engagement is a single undirected edge between two participants. Edges
 * carry the active hold and stance for that pair, when they were created or last
 * refreshed, and an intensity counter the UI can render. Edges expire after one
 * round without a refresh; the engine prunes them when a round advances.
 *
 * The participant's `engagedWith[]` cache is always rebuilt from the edges, so
 * the board and the engine can never disagree about who is paired with whom.
 */

export const DEFAULT_MAX_PARTNERS = 2;

function clamp(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function idOf(value) {
    if (value == null) return '';
    if (typeof value === 'object') return String(value.id ?? '');
    return String(value);
}

/** Stable undirected pair key. */
export function pairKey(a, b) {
    const left = idOf(a);
    const right = idOf(b);
    return left < right ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * Find the edge between two participants, regardless of order.
 * @param {object} state
 * @param {string|object} a
 * @param {string|object} b
 * @returns {object|null}
 */
export function findEngagement(state, a, b) {
    const left = idOf(a);
    const right = idOf(b);
    if (!left || !right) return null;
    return (state?.engagements || []).find(edge =>
        (edge.a === left && edge.b === right) || (edge.a === right && edge.b === left)) || null;
}

/** Distinct partners currently connected to `participantId`. */
export function engagementCount(state, participantId) {
    const id = idOf(participantId);
    if (!id) return 0;
    return (state?.engagements || []).filter(edge => edge.a === id || edge.b === id).length;
}

/**
 * True when a new edge would stay within both participants' partner cap.
 * Existing edges are always allowed so a pair can refresh its hold.
 */
export function canEngageWith(state, actor, target, maxPartners = state?.maxPartners) {
    const left = idOf(actor);
    const right = idOf(target);
    if (!left || !right || left === right) return false;
    if (findEngagement(state, left, right)) return true;
    const cap = clamp(maxPartners, 1, 4, DEFAULT_MAX_PARTNERS);
    return engagementCount(state, left) < cap && engagementCount(state, right) < cap;
}

/** Rebuild every participant's `engagedWith[]` cache from the edge list. */
export function refreshEngagedWith(state) {
    if (!state?.participants) return;
    for (const participant of state.participants) participant.engagedWith = [];
    for (const edge of state.engagements || []) {
        const a = state.participants.find(participant => participant.id === edge.a);
        const b = state.participants.find(participant => participant.id === edge.b);
        if (a && !a.engagedWith.includes(b.id)) a.engagedWith.push(b.id);
        if (b && !b.engagedWith.includes(a.id)) b.engagedWith.push(a.id);
    }
}

/**
 * Create or refresh the edge between two participants. A patch may set `hold`
 * or `stance` explicitly; `hold: null` removes the edge's hold.
 *
 * @param {object} state
 * @param {string|object} a
 * @param {string|object} b
 * @param {{ hold?: object|null, stance?: object|null }} [patch]
 * @returns {object|null}
 */
export function upsertEngagement(state, a, b, patch = {}) {
    const left = idOf(a);
    const right = idOf(b);
    if (!state || !left || !right || left === right) return null;
    const round = Math.max(1, Number(state.round) || 1);
    let edge = findEngagement(state, left, right);
    if (!edge) {
        edge = {
            a: left,
            b: right,
            hold: null,
            stance: null,
            sinceRound: round,
            refreshedRound: round,
            intensity: 0,
        };
        state.engagements = Array.isArray(state.engagements) ? state.engagements : [];
        state.engagements.push(edge);
    }
    if ('hold' in patch) edge.hold = patch.hold;
    if ('stance' in patch) edge.stance = patch.stance;
    edge.refreshedRound = round;
    edge.intensity = Math.min(5, (Number(edge.intensity) || 0) + 1);
    refreshEngagedWith(state);
    return edge;
}

/**
 * Drop edges that were not refreshed in the previous round (or the current
 * one). The default TTL of one round matches the plan: an edge survives the
 * round it was made in and the next one.
 */
export function expireEngagements(state, currentRound = state?.round, ttl = 1) {
    if (!state) return [];
    const round = Math.max(1, Number(currentRound) || 1);
    const removed = [];
    state.engagements = (state.engagements || []).filter(edge => {
        const refreshed = Number(edge.refreshedRound ?? edge.sinceRound) || 0;
        const keep = round - refreshed <= ttl;
        if (!keep) removed.push(edge);
        return keep;
    });
    refreshEngagedWith(state);
    return removed;
}

/** Remove an edge entirely. */
export function removeEngagement(state, a, b) {
    const left = idOf(a);
    const right = idOf(b);
    const before = state?.engagements?.length || 0;
    state.engagements = (state?.engagements || []).filter(edge =>
        !((edge.a === left && edge.b === right) || (edge.a === right && edge.b === left)));
    if (state.engagements.length !== before) refreshEngagedWith(state);
    return state.engagements.length !== before;
}

/**
 * Release a hold without removing the pair. Returns the hold that was released,
 * or null when the pair was not holding.
 */
export function releaseHold(state, a, b) {
    const edge = findEngagement(state, a, b);
    if (!edge?.hold) return null;
    const hold = edge.hold;
    edge.hold = null;
    edge.intensity = 0;
    edge.refreshedRound = Math.max(Number(edge.refreshedRound) || 0, Number(state?.round) || 1);
    return hold;
}

/** The hold connecting two participants, or null. */
export function holdBetween(state, a, b) {
    return findEngagement(state, a, b)?.hold || null;
}

/**
 * Holds currently applied to a participant, with the holder id resolved.
 * @returns {Array<{ edge: object, hold: object, holderId: string, holderName: string }>}
 */
export function holdsOn(state, participant) {
    const id = idOf(participant);
    if (!id) return [];
    const rows = [];
    for (const edge of state?.engagements || []) {
        if (!edge.hold) continue;
        if (edge.a !== id && edge.b !== id) continue;
        const holderId = edge.a === id ? edge.b : edge.a;
        const holder = state.participants?.find(candidate => candidate.id === holderId);
        rows.push({
            edge,
            hold: edge.hold,
            holderId,
            holderName: holder?.name || holderId,
        });
    }
    return rows;
}

/** Edges involving one participant. */
export function engagementsFor(state, participant) {
    const id = idOf(participant);
    if (!id) return [];
    return (state?.engagements || []).filter(edge => edge.a === id || edge.b === id);
}

/** Every unique pair in the roster, with its current edge data. */
export function buildPairingMatrix(state) {
    const participants = (state?.participants || []).map(participant => ({
        id: participant.id,
        name: participant.name,
        side: participant.side,
        spectator: !!participant.spectator,
        active: participant.active !== false && !participant.atMercy && !participant.surrendered,
        atMercy: !!participant.atMercy,
        surrendered: !!participant.surrendered,
        stance: participant.stance || null,
        engagedWith: [...(participant.engagedWith || [])],
        stamina: participant.stamina,
        maxStamina: participant.maxStamina,
        arousal: participant.arousal,
        maxArousal: participant.maxArousal,
        poise: participant.poise,
        maxPoise: participant.maxPoise,
    }));
    const cells = [];
    for (let i = 0; i < participants.length; i += 1) {
        for (let j = i + 1; j < participants.length; j += 1) {
            const a = participants[i];
            const b = participants[j];
            const edge = findEngagement(state, a.id, b.id);
            cells.push({
                a: a.id,
                b: b.id,
                engaged: !!edge,
                hold: edge?.hold || null,
                stance: edge?.stance || null,
                sinceRound: edge?.sinceRound ?? null,
                refreshedRound: edge?.refreshedRound ?? null,
                intensity: edge?.intensity ?? 0,
            });
        }
    }
    return { participants, cells };
}

/** Alias kept for UI code that prefers the shorter name. */
export const pairingMatrix = buildPairingMatrix;
