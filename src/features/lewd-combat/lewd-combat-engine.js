/**
 * lewd-combat-engine.js — deterministic resolution for the Lewd Combat board.
 *
 * The engine owns every number: rolls, accuracy, sensitivity, Arousal, Poise,
 * Stamina, climaxes, holds, pairings, and the winner. The model only writes
 * prose (later unit). There is no `Math.random` here; every roll comes from the
 * persisted `seed`/`rollCount`/`rngState`, so the same state + action + seed
 * produces the same result and a hydrated board continues the same stream.
 *
 * Participant pools:
 * - Stamina 1–6: drained by climaxes. At 0 the participant is `atMercy`.
 * - Arousal 0–maxArousal: reaching max triggers a climax and resets to 0.
 * - Poise 0–maxPoise: the defense pool. At 0 the participant is overwhelmed
 *   until the end of the next round; Poise then refreshes to half.
 *
 * A `[LEWD]` profile (see lewd-combat-profile.js) supplies max pools, zone
 * sensitivity, preferences, limits, and traits. Traits are already folded into
 * the profile by the parser; this engine reads the final values once.
 */

import {
    DEFAULT_ZONE_SENSITIVITY,
    inferProfile,
    isBlockedByLimits,
    maxStaminaFromProfile,
    normalizeLewdProfile,
    normalizeLewdZone,
    preferenceMultiplier,
    zoneMultiplier,
} from './lewd-combat-profile.js';

export const LEWD_STATE_FORMAT = 'lewd-combat';
export const LEWD_STATE_VERSION = 1;
export const LEWD_POSTURES = Object.freeze({
    lead: Object.freeze({ accuracy: 2, arousal: 1, poiseDefense: -2, poiseRegen: 0 }),
    follow: Object.freeze({ accuracy: -1, arousal: -1, poiseDefense: 2, poiseRegen: 2 }),
    switch: Object.freeze({ accuracy: 0, arousal: 0, poiseDefense: 0, poiseRegen: 1 }),
});

const LEWD_MODES = ['duel', 'group', 'free-for-all'];
const POSTURE_KEYS = Object.keys(LEWD_POSTURES);
const LOG_LIMIT = 100;
const DEFAULT_ROUND_CAP = 12;
const DEFAULT_MAX_PARTNERS = 2;

function clamp(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function round(value) {
    return Math.round(Number(value) || 0);
}

function hashSeed(seed) {
    const text = String(seed ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function mulberryStep(state) {
    state.rngState = (state.rngState + 0x6D2B79F5) | 0;
    let value = state.rngState;
    value = Math.imul(value ^ (value >>> 15), 1 | value);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function nextRandom(state) {
    const value = mulberryStep(state);
    state.rollCount = (Number(state.rollCount) || 0) + 1;
    return value;
}

function rollDie(state, sides) {
    const safeSides = Math.max(1, Math.floor(Number(sides) || 20));
    return 1 + Math.floor(nextRandom(state) * safeSides);
}

/**
 * Roll a dice expression (`1d6+2`, `2d4`, `1d4-1`, or a flat number).
 * @param {object} state
 * @param {string|number} notation
 * @returns {{ total: number, rolls: number[] }}
 */
export function rollLewdDice(state, notation) {
    if (typeof notation === 'number' && Number.isFinite(notation)) {
        return { total: notation, rolls: [] };
    }
    const text = String(notation ?? '').trim();
    if (!text) return { total: 0, rolls: [] };
    const match = text.match(/^(\d*)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?$/i);
    if (!match) {
        const flat = Number.parseFloat(text);
        return Number.isFinite(flat) ? { total: flat, rolls: [] } : { total: 0, rolls: [] };
    }
    const count = clamp(match[1] || 1, 1, 20, 1);
    const sides = clamp(match[2], 2, 100, 6);
    const modifier = match[3] ? Number(match[4]) * (match[3] === '-' ? -1 : 1) : 0;
    const rolls = [];
    for (let index = 0; index < count; index += 1) rolls.push(rollDie(state, sides));
    return { total: rolls.reduce((sum, value) => sum + value, 0) + modifier, rolls };
}

function slug(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'participant';
}

function techniqueKey(technique) {
    return String(technique?.id || slug(technique?.name || 'technique'));
}

function statModifier(participant, stat = 'cha') {
    const stats = participant?.stats || participant?.unit?.stats || {};
    const modKey = `${stat}Mod`;
    if (Number.isFinite(Number(stats[modKey]))) return Number(stats[modKey]);
    const score = Number(stats[stat]);
    return Number.isFinite(score) ? Math.floor((score - 10) / 2) : 0;
}

function experienceBonus(participant) {
    return clamp(Math.floor((Number(participant?.profile?.experience) || 0) / 2), 0, 3);
}

function roleBonus(role, posture) {
    if (role === 'dominant') return posture === 'lead' ? 1 : posture === 'follow' ? -1 : 0;
    if (role === 'submissive') return posture === 'follow' ? 1 : posture === 'lead' ? -1 : 0;
    if (role === 'switch') return posture === 'switch' ? 1 : 0;
    return 0;
}

function participantOut(participant) {
    return !!participant?.atMercy || !!participant?.surrendered;
}

function isActive(participant) {
    return !!participant && !participant.spectator && !participantOut(participant);
}

function findParticipant(state, reference) {
    if (!reference) return null;
    if (typeof reference === 'object') {
        if (state.participants.includes(reference)) return reference;
        if (reference.id) return state.participants.find(p => p.id === reference.id) || null;
        if (reference.name) return findParticipant(state, reference.name);
        return null;
    }
    const text = String(reference).trim().toLowerCase();
    if (!text) return null;
    return state.participants.find(p => String(p.id).toLowerCase() === text)
        || state.participants.find(p => String(p.name).toLowerCase() === text)
        || null;
}

function uniqueId(state, requested, name) {
    const base = slug(requested || name);
    if (!state.participants.some(p => p.id === base)) return base;
    let index = 2;
    while (state.participants.some(p => p.id === `${base}-${index}`)) index += 1;
    return `${base}-${index}`;
}

function normalizeProfile(raw, unit) {
    if (!raw) return null;
    if (Number.isFinite(Number(raw.maxStamina))) {
        // Caller-supplied canonical profiles are copied so a board never aliases
        // an object the profile parser or UI still owns.
        return {
            ...raw,
            sensitivity: { ...(raw.sensitivity || {}) },
            preference: { ...(raw.preference || {}) },
            limits: Array.isArray(raw.limits) ? [...raw.limits] : [],
            traits: { ...(raw.traits || {}) },
            warnings: Array.isArray(raw.warnings) ? [...raw.warnings] : [],
        };
    }
    return normalizeLewdProfile(raw, { unit });
}

function buildParticipant(raw = {}, state, index) {
    const name = String(raw.name || `Participant ${index + 1}`).trim().slice(0, 80);
    const profile = normalizeProfile(raw.profile, raw) || inferProfile(raw, {});
    const maxStamina = maxStaminaFromProfile(profile);
    const maxArousal = clamp(profile.maxArousal, 8, 30, 10);
    const maxPoise = clamp(profile.maxPoise, 4, 16, 6);
    const spectator = raw.spectator === true;
    const stamina = clamp(raw.stamina ?? maxStamina, 0, maxStamina, maxStamina);
    return {
        id: uniqueId(state, raw.id, name),
        name,
        side: String(raw.side || 'player'),
        spectator,
        active: !spectator && stamina > 0,
        stats: raw.stats || raw.unit?.stats || {},
        proficiency: Number(raw.proficiency) || 0,
        initiativeBonus: Number(raw.initiativeBonus ?? raw.unit?.initiativeBonus ?? statModifier(raw, 'dex')) || 0,
        initiative: 0,
        tieBreak: 0,
        ai: raw.ai === true || raw.side === 'opponent' || raw.side === 'enemy',
        profile,
        stamina,
        maxStamina,
        arousal: clamp(raw.arousal ?? 0, 0, maxArousal, 0),
        maxArousal,
        poise: clamp(raw.poise ?? maxPoise, 0, maxPoise, maxPoise),
        maxPoise,
        stance: raw.stance ? normalizeStance(raw.stance) : null,
        status: Array.isArray(raw.status) ? raw.status.map(entry => normalizeStatusEntry(entry)).filter(Boolean) : [],
        engagedWith: [],
        uses: {},
        acted: false,
        lastPosture: null,
        overwhelmedUntilRound: 0,
        atMercy: stamina <= 0,
        surrendered: false,
        joinRound: 0,
        drain: Number(profile.drain) || 0,
    };
}

function normalizeStatusEntry(status) {
    if (!status) return null;
    if (typeof status === 'string') {
        return { id: slug(status), label: status, roundsLeft: 1 };
    }
    const label = String(status.label || status.name || status.id || 'Status');
    return {
        ...status,
        id: slug(status.id || label),
        label,
        roundsLeft: clamp(status.roundsLeft ?? status.rounds ?? 1, 1, 99, 1),
    };
}

function normalizeStance(stance, fallbackRounds = 3) {
    if (!stance) return null;
    if (typeof stance === 'string') {
        return { id: slug(stance), label: stance, poiseBonus: 0, roundsLeft: fallbackRounds };
    }
    const label = String(stance.label || stance.name || stance.id || 'Stance');
    return {
        ...stance,
        id: slug(stance.id || label),
        label,
        poiseBonus: Number(stance.poiseBonus) || 0,
        roundsLeft: clamp(stance.roundsLeft ?? stance.rounds ?? fallbackRounds, 1, 99, fallbackRounds),
    };
}

function normalizeHold(hold, technique) {
    if (!hold) return null;
    if (typeof hold === 'string') {
        return {
            id: slug(hold),
            label: hold,
            poiseBonus: 0,
            accuracyBonus: 0,
            escapeDC: clamp(technique?.escapeDC ?? technique?.hold?.dc ?? 12, 1, 40, 12),
        };
    }
    const label = String(hold.label || hold.name || hold.id || technique?.name || 'Hold');
    return {
        ...hold,
        id: slug(hold.id || label),
        label,
        poiseBonus: Number(hold.poiseBonus) || 0,
        accuracyBonus: Number(hold.accuracyBonus) || 0,
        escapeDC: clamp(hold.escapeDC ?? hold.dc ?? technique?.escapeDC ?? 12, 1, 40, 12),
    };
}

function stancePoiseBonus(participant) {
    return Number(participant?.stance?.poiseBonus) || 0;
}

function postureDefenseBonus(participant) {
    return NUMBER(LEWD_POSTURES[participant?.lastPosture]?.poiseDefense);
}

function NUMBER(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function findEngagement(state, aId, bId) {
    return state.engagements.find(edge =>
        (edge.a === aId && edge.b === bId) || (edge.a === bId && edge.b === aId)) || null;
}

function holdDefenseBonus(state, participant) {
    let bonus = 0;
    for (const edge of state.engagements) {
        if (edge.hold && (edge.a === participant.id || edge.b === participant.id)) {
            bonus += Number(edge.hold.poiseBonus) || 0;
        }
    }
    return bonus;
}

function refreshEngagedWith(state) {
    for (const participant of state.participants) participant.engagedWith = [];
    for (const edge of state.engagements) {
        const a = findParticipant(state, edge.a);
        const b = findParticipant(state, edge.b);
        if (a && !a.engagedWith.includes(b.id)) a.engagedWith.push(b.id);
        if (b && !b.engagedWith.includes(a.id)) b.engagedWith.push(a.id);
    }
}

function engage(state, actor, target, patch = {}) {
    let edge = findEngagement(state, actor.id, target.id);
    if (!edge) {
        edge = {
            a: actor.id,
            b: target.id,
            hold: null,
            stance: null,
            sinceRound: state.round,
            refreshedRound: state.round,
            intensity: 0,
        };
        state.engagements.push(edge);
    }
    if ('hold' in patch) edge.hold = patch.hold;
    if ('stance' in patch) edge.stance = patch.stance;
    edge.refreshedRound = state.round;
    edge.intensity = Math.min(5, (Number(edge.intensity) || 0) + 1);
    refreshEngagedWith(state);
    return edge;
}

function isOverwhelmed(state, participant) {
    return Number(participant?.overwhelmedUntilRound) >= state.round;
}

function applyStatus(state, participant, status) {
    const list = Array.isArray(status) ? status : [status];
    const applied = [];
    for (const raw of list) {
        const entry = normalizeStatusEntry(raw);
        if (!entry) continue;
        entry.appliedRound = state.round;
        const existing = participant.status.find(item => item.id === entry.id);
        if (existing) Object.assign(existing, entry);
        else participant.status.push(entry);
        applied.push(`${entry.label} (${entry.roundsLeft} round${entry.roundsLeft === 1 ? '' : 's'})`);
    }
    return applied;
}

function statusSensitivityBonus(participant) {
    let bonus = 0;
    for (const status of participant?.status || []) bonus += NUMBER(status.sensitivityBonus);
    return bonus;
}

function computeAccuracy(actor, technique, posture) {
    const check = technique.check || {};
    const stat = check.stat || 'cha';
    return NUMBER(statModifier(actor, stat))
        + NUMBER(actor.proficiency)
        + NUMBER(check.accuracy ?? technique.accuracy)
        + NUMBER(LEWD_POSTURES[posture]?.accuracy)
        + roleBonus(actor.profile?.role, posture)
        + experienceBonus(actor);
}

function computeDefense(state, target) {
    return Math.max(0,
        NUMBER(target.poise)
        + stancePoiseBonus(target)
        + holdDefenseBonus(state, target)
        + postureDefenseBonus(target));
}

function techniquePosture(technique, requested) {
    const allowed = technique?.posture;
    if (requested && POSTURE_KEYS.includes(requested)) return requested;
    if (typeof allowed === 'string' && POSTURE_KEYS.includes(allowed)) return allowed;
    if (Array.isArray(allowed)) {
        const first = allowed.find(value => POSTURE_KEYS.includes(value));
        if (first) return first;
    }
    return 'switch';
}

function isPostureAllowed(technique, posture) {
    const allowed = technique?.posture;
    if (!allowed || allowed === 'either' || allowed === 'any') return true;
    if (Array.isArray(allowed)) return allowed.includes(posture);
    return allowed === posture;
}

function techniqueRegistryLookup(state, action, options) {
    if (action?.technique && typeof action.technique === 'object') return action.technique;
    const id = String(action?.techniqueId || action?.technique || '').trim();
    if (!id) return null;
    const registry = options.techniques || state.techniques;
    if (!registry) return null;
    if (Array.isArray(registry)) return registry.find(tech => tech?.id === id) || null;
    if (registry instanceof Map) return registry.get(id) || null;
    if (typeof registry === 'object') {
        if (registry[id]) return registry[id];
        return Object.values(registry).find(tech => tech?.id === id) || null;
    }
    return null;
}

function targetIdsOf(action) {
    const raw = action?.targetIds ?? action?.targetId ?? action?.targets ?? [];
    if (Array.isArray(raw)) return raw.map(String);
    return raw ? [String(raw)] : [];
}

function zonesOf(action, technique) {
    const raw = action?.zones ?? action?.zone;
    const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    const normalized = list.map(normalizeLewdZone).filter(Boolean);
    if (normalized.length) return normalized;
    return (technique?.zones || []).map(normalizeLewdZone).filter(Boolean);
}

function resolveTargets(state, actor, technique, action) {
    const mode = technique.targetMode || 'single';
    const requested = targetIdsOf(action);
    if (mode === 'self') return { targets: [actor], excluded: [] };
    if (mode === 'single' || mode === 'pair') {
        const target = findParticipant(state, requested[0]);
        if (!target) return { targets: [], excluded: [], error: 'Target not found.' };
        if (target.id === actor.id) return { targets: [], excluded: [], error: 'Choose another participant.' };
        if (!isActive(target)) return { targets: [], excluded: [], error: 'Target is out of the encounter.' };
        return { targets: mode === 'pair' ? [target, actor] : [target], excluded: [] };
    }
    if (mode === 'group') {
        const pool = requested.length
            ? requested.map(id => findParticipant(state, id)).filter(Boolean)
            : state.participants.filter(p => isActive(p) && p.id !== actor.id);
        return { targets: pool.filter(participant => isActive(participant) && participant.id !== actor.id), excluded: [] };
    }
    // aura: everyone currently engaged with the actor, else every active opponent.
    const engaged = (actor.engagedWith || [])
        .map(id => findParticipant(state, id))
        .filter(participant => isActive(participant) && participant.id !== actor.id);
    const pool = engaged.length
        ? engaged
        : state.participants.filter(p => isActive(p) && p.id !== actor.id);
    return { targets: pool, excluded: [] };
}

function requiresHoldCheck(state, actor, target, technique) {
    const required = technique?.requires?.hold;
    if (!required) return true;
    const edge = findEngagement(state, actor.id, target.id);
    if (!edge || !edge.hold) return false;
    if (required === true) return true;
    return edge.hold.id === slug(required) || edge.hold.label.toLowerCase() === String(required).toLowerCase();
}

function requiresStanceCheck(actor, technique) {
    const required = technique?.requires?.stance;
    if (!required) return true;
    if (!actor.stance) return false;
    return actor.stance.id === slug(required) || actor.stance.label.toLowerCase() === String(required).toLowerCase();
}

function techniqueUsesRemaining(actor, technique) {
    const max = technique?.uses?.max;
    if (max == null) return Infinity;
    const used = Number(actor.uses?.[techniqueKey(technique)]) || 0;
    return Math.max(0, Number(max) - used);
}

function arousalMultiplier(state, target, zone, technique) {
    const zonePref = preferenceMultiplier(target.profile, zone);
    let tagPref = 1;
    const tags = Array.isArray(technique?.tags) ? technique.tags : [];
    const disliked = tags.find(tag => preferenceMultiplier(target.profile, tag) < 1);
    if (disliked) tagPref = preferenceMultiplier(target.profile, disliked);
    else {
        const liked = tags.find(tag => preferenceMultiplier(target.profile, tag) > 1);
        if (liked) tagPref = preferenceMultiplier(target.profile, liked);
    }
    const sensitivity = zoneMultiplier(target.profile, zone) * (1 + statusSensitivityBonus(target));
    return Math.max(0.1, zonePref * tagPref * sensitivity);
}

function addStateChange(changes, participant) {
    changes.push(`${participant.name}: Stamina ${participant.stamina}/${participant.maxStamina}, Arousal ${participant.arousal}/${participant.maxArousal}, Poise ${participant.poise}/${participant.maxPoise}`);
}

function pushLog(state, beat) {
    state.log.push(beat);
    if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

function clearOverwhelmedIfExpired(state, participant) {
    if (!participant.overwhelmedUntilRound) return;
    if (state.round > participant.overwhelmedUntilRound) {
        participant.overwhelmedUntilRound = 0;
        participant.poise = Math.max(participant.poise, Math.ceil(participant.maxPoise / 2));
    }
}

function tickParticipantRound(state, participant, endingRound) {
    participant.acted = false;
    if (participant.stance) {
        participant.stance.roundsLeft -= 1;
        if (participant.stance.roundsLeft <= 0) participant.stance = null;
    }
    // A status applied during the round that is ending has not yet had its
    // round; skip its first tick so "1 round" spans the next round.
    participant.status = participant.status
        .map(status => {
            if (Number(status.appliedRound ?? 0) >= endingRound) return status;
            return { ...status, roundsLeft: Number(status.roundsLeft) - 1 };
        })
        .filter(status => status.roundsLeft > 0);
    clearOverwhelmedIfExpired(state, participant);
}

function advanceRoundIfComplete(state) {
    if (state.status !== 'active') return;
    const eligible = state.participants.filter(isActive);
    if (!eligible.length) return;
    if (!eligible.every(participant => participant.acted)) return;

    state.round += 1;
    const endingRound = state.round - 1;
    for (const participant of state.participants) tickParticipantRound(state, participant, endingRound);
    state.engagements = state.engagements.filter(edge => state.round - (Number(edge.refreshedRound) || 0) <= 1);
    refreshEngagedWith(state);

    if (state.round > state.roundCap) {
        endEncounter(state, 'draw', { reason: 'round-cap' });
    }
}

function endEncounter(state, outcome, extra = {}) {
    if (state.status === 'ended') return state.outcome;
    state.status = 'ended';
    state.outcome = outcome;
    state.endedRound = state.round;
    state.endReason = extra.reason || outcome;
    if (extra.winnerIds) state.winnerIds = extra.winnerIds;
    if (extra.winnerSide) state.winnerSide = extra.winnerSide;

    const roster = state.participants
        .filter(participant => !participant.spectator)
        .map(participant => `${participant.name} ${participant.stamina}/${participant.maxStamina} Stamina`)
        .join(', ');
    if (outcome === 'stopped') {
        state.summary = `Encounter stopped by safe word. ${roster}.`;
    } else if (outcome === 'draw' || outcome === 'mutual') {
        state.summary = `${outcome === 'mutual' ? 'Mutual climax' : 'Draw'} — no winner. ${roster}.`;
    } else {
        const winnerNames = (extra.winnerIds || [])
            .map(id => findParticipant(state, id)?.name)
            .filter(Boolean)
            .join(', ');
        state.summary = `${winnerNames ? `${winnerNames} wins` : 'Encounter ended'} (${outcome}). ${roster}.`;
    }
    return outcome;
}

/**
 * End-check shared by actions, climaxes, and the board. Returns the outcome
 * when the encounter ends, otherwise null. Safe to call repeatedly.
 * @param {object} state
 * @returns {string|null}
 */
export function checkLewdEncounterEnd(state) {
    if (!state || state.status !== 'active') return state?.outcome || null;
    if (state.stopped) return endEncounter(state, 'stopped', { reason: 'safe-word' });

    const roster = state.participants.filter(participant => !participant.spectator);
    const active = roster.filter(isActive);
    const out = roster.filter(participant => !isActive(participant));

    if (!active.length) {
        const outcome = state.mode === 'duel' && roster.length === 2 ? 'mutual' : 'draw';
        return endEncounter(state, outcome, { reason: 'all-out' });
    }

    if (state.round > state.roundCap) {
        return endEncounter(state, 'draw', { reason: 'round-cap' });
    }

    if (!out.length) return null;

    const activeSides = new Set(active.map(participant => participant.side));
    if (state.mode === 'free-for-all') {
        if (active.length === 1) {
            return endEncounter(state, 'sideVictory', {
                reason: 'last-standing',
                winnerIds: active.map(participant => participant.id),
                winnerSide: active[0].side,
            });
        }
        return null;
    }

    if (activeSides.size > 1) return null;

    const winnerIds = active.map(participant => participant.id);
    if (state.mode === 'duel') {
        const outcome = out.every(participant => participant.surrendered) ? 'surrendered' : 'atMercy';
        return endEncounter(state, outcome, {
            reason: outcome,
            winnerIds,
            winnerSide: active[0].side,
        });
    }
    return endEncounter(state, 'sideVictory', {
        reason: 'side-eliminated',
        winnerIds,
        winnerSide: active[0].side,
    });
}

/**
 * Create a deterministic encounter. Participants are normalized, profiles are
 * resolved, pools start full, and initiative is rolled from the seeded RNG.
 *
 * @param {{ participants?: object[], seed?: string|number, settings?: object, mode?: string, id?: string }} options
 * @returns {object}
 */
export function createLewdEncounterState(options = {}) {
    const settings = options.settings || {};
    const seed = String(options.seed ?? settings.lewdCombatSeed ?? 'lewd-combat');
    const state = {
        format: LEWD_STATE_FORMAT,
        schemaVersion: LEWD_STATE_VERSION,
        id: String(options.id || ''),
        mode: LEWD_MODES.includes(options.mode) ? options.mode : 'duel',
        status: 'active',
        round: 1,
        roundCap: clamp(settings.lewdCombatRoundCap, 1, 60, DEFAULT_ROUND_CAP),
        maxPartners: clamp(settings.lewdCombatMaxPartners, 1, 4, DEFAULT_MAX_PARTNERS),
        seed,
        rollCount: 0,
        rngState: hashSeed(seed),
        participants: [],
        engagements: [],
        log: [],
        actionLog: [],
        outcome: null,
        summary: '',
        stopped: false,
    };

    const input = Array.isArray(options.participants) ? options.participants : [];
    input.forEach((raw, index) => {
        state.participants.push(buildParticipant(raw, state, index));
    });

    for (const participant of state.participants) {
        if (participant.spectator) continue;
        participant.initiative = rollDie(state, 20) + NUMBER(participant.initiativeBonus);
        participant.tieBreak = rollDie(state, 20);
    }
    state.participants.sort((a, b) => {
        if (a.spectator !== b.spectator) return a.spectator ? 1 : -1;
        if (b.initiative !== a.initiative) return b.initiative - a.initiative;
        if (b.tieBreak !== a.tieBreak) return b.tieBreak - a.tieBreak;
        if (a.side === 'player' && b.side !== 'player') return -1;
        if (b.side === 'player' && a.side !== 'player') return 1;
        return 0;
    });
    return state;
}

function actionSummarySource(action) {
    return action?.source === 'ai' ? 'ai' : action?.source === 'system' ? 'system' : 'player';
}

/**
 * Resolve one exchange. Validation happens before any roll or mutation, so a
 * rejected action leaves the state untouched.
 *
 * @param {object} state
 * @param {object} action
 * @param {{ techniques?: object[]|Record<string, object>|Map<string, object>, source?: string }} [options]
 * @returns {{ ok: boolean, reason?: string, beat?: object, outcome?: string|null }}
 */
export function applyLewdAction(state, action, options = {}) {
    if (!state || state.status !== 'active') return { ok: false, reason: 'Encounter is not active.' };
    const actor = findParticipant(state, action?.unitId ?? action?.actorId ?? action?.unit ?? action?.actor);
    if (!actor) return { ok: false, reason: 'Actor not found.' };
    if (actor.spectator) return { ok: false, reason: 'Spectators cannot act.' };
    if (participantOut(actor)) return { ok: false, reason: 'This participant is out of the encounter.' };

    const type = String(action?.type || 'technique');
    if (type === 'stop') {
        state.stopped = true;
        const outcome = checkLewdEncounterEnd(state);
        const beat = {
            type: 'stop',
            round: state.round,
            actor: { id: actor.id, name: actor.name },
            outcome,
        };
        pushLog(state, beat);
        state.actionLog.push({ round: state.round, unitId: actor.id, type, source: actionSummarySource(action) });
        return { ok: true, beat, outcome };
    }

    if (type === 'surrender') {
        const participant = surrenderParticipant(state, actor, { source: actionSummarySource(action) });
        const beat = state.log[state.log.length - 1] || null;
        return { ok: true, beat, outcome: state.outcome, participant };
    }

    if (actor.acted) {
        return { ok: false, reason: 'This participant has already acted this round.' };
    }

    if (type === 'wait') {
        actor.acted = true;
        const beat = {
            type: 'wait',
            round: state.round,
            actor: { id: actor.id, name: actor.name },
            stateChanges: [`${actor.name} waits.`],
        };
        pushLog(state, beat);
        state.actionLog.push({ round: state.round, unitId: actor.id, type, source: actionSummarySource(action) });
        advanceRoundIfComplete(state);
        const outcome = state.status === 'ended' ? state.outcome : checkLewdEncounterEnd(state);
        if (outcome) beat.outcome = outcome;
        return { ok: true, beat, outcome: outcome || null };
    }

    if (type !== 'technique' && type !== 'action') {
        return { ok: false, reason: `Unknown action type "${type}".` };
    }

    const technique = techniqueRegistryLookup(state, action, options);
    if (!technique) return { ok: false, reason: 'Unknown technique.' };
    if (action?.posture && !POSTURE_KEYS.includes(String(action.posture))) {
        return { ok: false, reason: `Unknown posture "${action.posture}".` };
    }
    const posture = techniquePosture(technique, action?.posture);
    if (!isPostureAllowed(technique, posture)) {
        return { ok: false, reason: `This technique cannot be used from the ${posture} posture.` };
    }
    if (!requiresStanceCheck(actor, technique)) {
        return { ok: false, reason: `Requires stance: ${technique.requires.stance}.` };
    }
    if (techniqueUsesRemaining(actor, technique) <= 0) {
        return { ok: false, reason: 'No uses remaining for this technique.' };
    }

    const resolved = resolveTargets(state, actor, technique, action);
    if (resolved.error) return { ok: false, reason: resolved.error };
    if (!resolved.targets.length) return { ok: false, reason: 'No legal targets.' };

    const zones = zonesOf(action, technique);
    const technicalZones = (technique.zones || []).map(normalizeLewdZone).filter(Boolean);
    for (const zone of zones) {
        if (technicalZones.length && !technicalZones.includes(zone)) {
            return { ok: false, reason: `This technique cannot target the ${zone} zone.` };
        }
    }
    const defaultZone = zones[0] || technicalZones[0] || 'full_body';

    const targets = [];
    const excluded = [];
    for (const target of resolved.targets) {
        if (!requiresHoldCheck(state, actor, target, technique)) {
            excluded.push({ id: target.id, name: target.name, reason: 'Requires a hold.' });
            continue;
        }
        if (technique.requires?.overwhelmed && !isOverwhelmed(state, target)) {
            excluded.push({ id: target.id, name: target.name, reason: 'Requires an overwhelmed target.' });
            continue;
        }
        const blocked = isBlockedByLimits(target.profile, [...(technique.tags || []), ...(technique.zones || []), defaultZone]);
        if (blocked) {
            excluded.push({ id: target.id, name: target.name, reason: `Blocked by limit: ${blocked}` });
            continue;
        }
        targets.push(target);
    }
    if (!targets.length) {
        return {
            ok: false,
            reason: excluded.length ? excluded[0].reason : 'No legal targets.',
            excluded,
        };
    }
    // Single-target techniques are all-or-nothing; a blocked target is an error.
    if ((technique.targetMode === 'single' || technique.targetMode === 'pair') && excluded.length) {
        return { ok: false, reason: excluded[0].reason, excluded };
    }

    const postureChange = actor.lastPosture && actor.lastPosture !== posture;
    if (postureChange) actor.stance = null;

    const beat = {
        type: 'technique',
        round: state.round,
        actor: { id: actor.id, name: actor.name },
        posture,
        technique: {
            id: techniqueKey(technique),
            name: technique.name || technique.id || 'Technique',
            category: technique.category || 'technique',
        },
        targets: [],
        excluded,
        stateChanges: [],
        seed: state.seed,
    };

    for (const target of targets) {
        const zone = defaultZone;
        const defense = target.id === actor.id ? 0 : computeDefense(state, target);
        const accuracy = computeAccuracy(actor, technique, posture);
        const natural = rollDie(state, 20);
        const check = natural + accuracy;
        const hit = target.id === actor.id || check >= defense;
        const entry = {
            id: target.id,
            name: target.name,
            zone,
            natural,
            check,
            accuracy,
            defense,
            hit,
            arousalDelta: 0,
            poiseDelta: 0,
            staminaDelta: 0,
            status: [],
            climaxed: false,
        };

        if (hit) {
            const rawArousal = rollLewdDice(state, technique.arousal).total + NUMBER(LEWD_POSTURES[posture]?.arousal);
            if (rawArousal > 0) {
                const delta = Math.max(1, round(rawArousal * arousalMultiplier(state, target, zone, technique)));
                const before = target.arousal;
                target.arousal = clamp(target.arousal + delta, 0, target.maxArousal, target.maxArousal);
                entry.arousalDelta = target.arousal - before;
            }

            const rawPoise = rollLewdDice(state, technique.poise).total;
            if (rawPoise > 0) {
                const before = target.poise;
                target.poise = clamp(target.poise - rawPoise, 0, target.maxPoise, 0);
                entry.poiseDelta = target.poise - before;
                if (target.poise <= 0) {
                    target.overwhelmedUntilRound = Math.max(target.overwhelmedUntilRound, state.round + 1);
                    target.stance = null;
                }
            }

            if (technique.applies?.status) {
                entry.status = applyStatus(state, target, technique.applies.status);
            }

            if (technique.applies?.stance) {
                const stance = normalizeStance(technique.applies.stance, 3);
                if (stance) {
                    actor.stance = stance;
                    entry.stance = stance.label;
                }
            }

            const hold = normalizeHold(technique.hold, technique);
            if (hold) {
                engage(state, actor, target, { hold });
                entry.hold = hold.label;
            } else if (target.id !== actor.id) {
                engage(state, actor, target);
            }

            if (target.arousal >= target.maxArousal) {
                const cost = Number(technique.staminaDrain);
                const finisherExtra = cost > 0
                    ? Math.max(0, cost - 1)
                    : (technique.category === 'finisher' ? 1 : 0);
                const beforeStamina = target.stamina;
                climaxParticipant(state, target, { finisherExtra });
                entry.climaxed = true;
                entry.staminaDelta = target.stamina - beforeStamina;
                entry.status = [...entry.status, 'Overstimulated (1 round)'];
            }
        }

        beat.targets.push(entry);
        addStateChange(beat.stateChanges, target);
    }

    if (technique.category === 'stance' && !technique.applies?.stance) {
        const stance = normalizeStance({ id: technique.id, label: technique.name, poiseBonus: technique.stance?.poiseBonus }, 3);
        if (stance) actor.stance = stance;
    }
    if (technique.category === 'hold' && technique.hold == null) {
        const hold = normalizeHold(technique.id || technique.name, technique);
        for (const target of targets) engage(state, actor, target, { hold });
    }

    const regen = NUMBER(LEWD_POSTURES[posture]?.poiseRegen);
    if (regen) actor.poise = clamp(actor.poise + regen, 0, actor.maxPoise, actor.maxPoise);
    actor.lastPosture = posture;
    const usedKey = techniqueKey(technique);
    actor.uses[usedKey] = (Number(actor.uses[usedKey]) || 0) + 1;
    actor.acted = true;

    state.actionLog.push({
        round: state.round,
        unitId: actor.id,
        type: 'technique',
        techniqueId: techniqueKey(technique),
        targetIds: targets.map(target => target.id),
        zones: [defaultZone],
        posture,
        source: actionSummarySource(action),
    });

    advanceRoundIfComplete(state);
    const outcome = state.status === 'ended' ? state.outcome : checkLewdEncounterEnd(state);
    if (outcome) beat.outcome = outcome;
    pushLog(state, beat);
    return { ok: true, beat, outcome: outcome || null };
}

/**
 * Drain one Stamina point (or more for a finisher), reset Arousal, and apply
 * the one-round `overstimulated` status. A profile's `drain` trait reduces the
 * cost but never below 1. At 0 Stamina the participant is `atMercy`.
 *
 * @param {object} state
 * @param {object|string} unit
 * @param {{ finisherExtra?: number, reason?: string }} [options]
 * @returns {object|null} the mutated participant
 */
export function climaxParticipant(state, unit, options = {}) {
    const participant = findParticipant(state, unit);
    if (!participant || participant.spectator || participantOut(participant)) return null;

    const extra = Math.max(0, Math.floor(Number(options.finisherExtra) || 0));
    const reduction = Math.max(0, -(Number(participant.profile?.drain ?? participant.drain) || 0));
    const cost = Math.max(1, 1 + extra - reduction);
    const before = participant.stamina;
    participant.stamina = clamp(participant.stamina - cost, 0, participant.maxStamina, 0);
    participant.arousal = 0;
    participant.poise = clamp(participant.poise - 2, 0, participant.maxPoise, 0);
    applyStatus(state, participant, {
        id: 'overstimulated',
        label: 'Overstimulated',
        roundsLeft: 1,
        // One sensitivity step (+0.3 on the multiplier scale below the
        // numeric edge used by `sensitivity:zone+N` traits).
        sensitivityBonus: 0.3,
    });
    if (participant.poise <= 0) {
        participant.overwhelmedUntilRound = Math.max(participant.overwhelmedUntilRound, state.round + 1);
    }
    if (participant.stamina <= 0) {
        participant.stamina = 0;
        participant.atMercy = true;
        participant.active = false;
        participant.stance = null;
        participant.acted = true;
    }
    return { ...participant, staminaDelta: participant.stamina - before, cost };
}

/**
 * Hard yield: the participant leaves the encounter and cannot re-enter it.
 * @param {object} state
 * @param {object|string} unit
 * @param {{ source?: string }} [options]
 * @returns {object|null}
 */
export function surrenderParticipant(state, unit, options = {}) {
    const participant = findParticipant(state, unit);
    if (!participant || participant.spectator) return null;
    if (participant.surrendered) return participant;
    participant.surrendered = true;
    participant.active = false;
    participant.stance = null;
    participant.lastPosture = null;
    participant.acted = true;
    const beat = {
        type: 'surrender',
        round: state.round,
        actor: { id: participant.id, name: participant.name },
        stateChanges: [`${participant.name} surrenders.`],
    };
    pushLog(state, beat);
    state.actionLog.push({
        round: state.round,
        unitId: participant.id,
        type: 'surrender',
        source: actionSummarySource(options),
    });
    advanceRoundIfComplete(state);
    if (state.status === 'active') checkLewdEncounterEnd(state);
    return participant;
}

/** Safe-word / stop. Immediate, no winner. */
export function stopLewdEncounter(state) {
    if (!state) return null;
    state.stopped = true;
    return checkLewdEncounterEnd(state) || endEncounter(state, 'stopped', { reason: 'safe-word' });
}

/**
 * Join a spectator or a new participant at the start of a round. Surrendered
 * characters are permanently barred from this encounter.
 * @param {object} state
 * @param {object} raw
 * @returns {{ ok: boolean, reason?: string, participant?: object }}
 */
export function joinParticipant(state, raw = {}) {
    if (!state) return { ok: false, reason: 'Encounter is not active.' };
    const name = String(raw.name || '').trim();
    const existing = name ? findParticipant(state, name) : (raw.id ? findParticipant(state, raw.id) : null);
    if (existing?.surrendered) {
        return { ok: false, reason: 'A surrendered participant cannot re-enter this encounter.' };
    }
    if (state.status !== 'active') return { ok: false, reason: 'Encounter is not active.' };
    if (existing) {
        existing.spectator = false;
        existing.active = true;
        existing.acted = true;
        return { ok: true, participant: existing };
    }
    // `state.maxPartners` caps how many partners a technique may engage (U4
    // pairing); the roster itself may hold additional spectators.
    const participant = buildParticipant(raw, state, state.participants.length);
    participant.joinRound = state.round;
    participant.acted = true;
    if (!participant.spectator) {
        participant.initiative = rollDie(state, 20) + NUMBER(participant.initiativeBonus);
        participant.tieBreak = rollDie(state, 20);
    }
    state.participants.push(participant);
    state.participants.sort((a, b) => {
        if (a.spectator !== b.spectator) return a.spectator ? 1 : -1;
        if (b.initiative !== a.initiative) return b.initiative - a.initiative;
        return (Number(b.tieBreak) || 0) - (Number(a.tieBreak) || 0);
    });
    return { ok: true, participant };
}

/**
 * Move a participant between the active roster and the spectator rail.
 * @param {object} state
 * @param {object|string} unit
 * @param {boolean} spectator
 * @returns {{ ok: boolean, reason?: string, participant?: object }}
 */
export function setSpectator(state, unit, spectator = true) {
    const participant = findParticipant(state, unit);
    if (!participant) return { ok: false, reason: 'Participant not found.' };
    if (!spectator && participant.surrendered) {
        return { ok: false, reason: 'A surrendered participant cannot re-enter this encounter.' };
    }
    participant.spectator = !!spectator;
    participant.active = !spectator && !participantOut(participant);
    participant.acted = true;
    if (!spectator && !participant.initiative) {
        participant.initiative = rollDie(state, 20) + NUMBER(participant.initiativeBonus);
        participant.tieBreak = rollDie(state, 20);
    }
    return { ok: true, participant };
}

/** True when an actor may act right now (active, not out, not spectator). */
export function canLewdParticipantAct(state, unit) {
    const participant = findParticipant(state, unit);
    return !!state && state.status === 'active' && isActive(participant);
}

function nextOpponentActor(state) {
    const pool = state.participants.filter(participant =>
        isActive(participant) && (participant.ai || participant.side === 'opponent' || participant.side === 'enemy'));
    return pool.find(participant => !participant.acted) || null;
}

function localOpponentChoice(state, actor, options) {
    const registry = options.techniques || state.techniques;
    if (!registry) return null;
    const list = Array.isArray(registry)
        ? registry
        : registry instanceof Map
            ? [...registry.values()]
            : Object.values(registry);
    const recent = state.actionLog.filter(entry => entry.unitId === actor.id).slice(-6);
    const scored = list
        .filter(technique => technique && technique.targetMode !== 'self')
        .map(technique => {
            const id = techniqueKey(technique);
            const repetitions = recent.filter(entry => entry.techniqueId === id).length;
            const priority = NUMBER(technique.ai?.priority);
            return { technique, score: priority - repetitions * 1.5 + nextRandom(state) * 0.001 };
        })
        .sort((a, b) => b.score - a.score);

    for (const { technique } of scored) {
        const targets = state.participants.filter(participant => isActive(participant) && participant.id !== actor.id);
        for (const target of targets) {
            const blocked = isBlockedByLimits(target.profile, [...(technique.tags || []), ...(technique.zones || [])]);
            if (blocked) continue;
            const result = applyLewdAction(state, {
                type: 'technique',
                unitId: actor.id,
                techniqueId: technique.id,
                targetIds: [target.id],
                posture: techniquePosture(technique),
                zone: (technique.zones || [])[0],
                source: 'ai',
            }, options);
            if (result.ok) return result;
        }
    }
    return null;
}

/**
 * Resolve one AI-controlled participant's turn. The supplied action list is
 * tried first; illegal or missing actions fall back to the deterministic local
 * policy. The chosen action is recorded in `state.actionLog`.
 *
 * @param {object} state
 * @param {object[]|{ actions?: object[] }} [actions]
 * @param {{ techniques?: object[]|Record<string, object>|Map<string, object> }} [options]
 * @returns {{ ok: boolean, reason?: string, beat?: object, outcome?: string|null }}
 */
export function resolveLewdOpponentTurn(state, actions = [], options = {}) {
    if (!state || state.status !== 'active') return { ok: false, reason: 'Encounter is not active.' };
    const actor = nextOpponentActor(state);
    if (!actor) return { ok: false, reason: 'No opponent participant is active.' };

    const list = Array.isArray(actions) ? actions : Array.isArray(actions?.actions) ? actions.actions : [];
    const provided = list.find(action => {
        const id = String(action?.unitId ?? action?.actorId ?? '');
        return !id || id === actor.id || id === actor.name;
    });
    if (provided) {
        const result = applyLewdAction(state, { ...provided, unitId: actor.id, source: 'ai' }, options);
        if (result.ok) return result;
        state.actionLog.push({
            round: state.round,
            unitId: actor.id,
            type: 'rejected-ai-action',
            reason: result.reason || 'illegal action',
            source: 'ai',
        });
    }

    const local = localOpponentChoice(state, actor, options);
    if (local) return local;

    return applyLewdAction(state, { type: 'wait', unitId: actor.id, source: 'ai' }, options);
}

/**
 * Deep-clone the board for storage. Preserves seed, rollCount, RNG state,
 * profiles, stances, holds, engagements, and both logs.
 * @param {object} state
 * @returns {object}
 */
export function serializeLewdState(state) {
    if (!state || typeof state !== 'object') return null;
    const copy = JSON.parse(JSON.stringify(state));
    copy.format = LEWD_STATE_FORMAT;
    copy.schemaVersion = LEWD_STATE_VERSION;
    return copy;
}

/**
 * Restore a stored board. Missing RNG state is reconstructed from seed +
 * rollCount so a reload cannot change the next roll.
 * @param {object} raw
 * @returns {object|null}
 */
export function hydrateLewdState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    let state;
    try {
        state = JSON.parse(JSON.stringify(raw));
    } catch (_) {
        return null;
    }
    state.format = LEWD_STATE_FORMAT;
    state.schemaVersion = LEWD_STATE_VERSION;
    state.status = state.status === 'ended' ? 'ended' : 'active';
    state.round = Math.max(1, Number(state.round) || 1);
    state.roundCap = Math.max(1, Number(state.roundCap) || DEFAULT_ROUND_CAP);
    state.maxPartners = Math.max(1, Number(state.maxPartners) || DEFAULT_MAX_PARTNERS);
    state.seed = String(state.seed ?? 'lewd-combat');
    state.rollCount = Math.max(0, Number(state.rollCount) || 0);
    state.participants = Array.isArray(state.participants) ? state.participants : [];
    state.engagements = Array.isArray(state.engagements) ? state.engagements : [];
    state.log = Array.isArray(state.log) ? state.log : [];
    state.actionLog = Array.isArray(state.actionLog) ? state.actionLog : [];
    state.stopped = !!state.stopped;

    for (const participant of state.participants) {
        participant.status = Array.isArray(participant.status) ? participant.status : [];
        participant.engagedWith = Array.isArray(participant.engagedWith) ? participant.engagedWith : [];
        participant.uses = participant.uses && typeof participant.uses === 'object' ? participant.uses : {};
        participant.stance = participant.stance || null;
        participant.acted = !!participant.acted;
        participant.atMercy = !!participant.atMercy || Number(participant.stamina) <= 0;
        participant.surrendered = !!participant.surrendered;
        participant.spectator = !!participant.spectator;
        participant.active = !participant.spectator && !participant.atMercy && !participant.surrendered;
        participant.maxStamina = clamp(participant.maxStamina, 1, 6, 2);
        participant.stamina = clamp(participant.stamina, 0, participant.maxStamina, participant.maxStamina);
        participant.maxArousal = clamp(participant.maxArousal, 8, 30, 10);
        participant.arousal = clamp(participant.arousal, 0, participant.maxArousal, 0);
        participant.maxPoise = clamp(participant.maxPoise, 4, 16, 6);
        participant.poise = clamp(participant.poise, 0, participant.maxPoise, participant.maxPoise);
        if (!participant.profile) participant.profile = inferProfile(participant, {});
    }
    refreshEngagedWith(state);

    if (!Number.isFinite(Number(state.rngState))) {
        let rngState = hashSeed(state.seed);
        for (let index = 0; index < state.rollCount; index += 1) {
            rngState = (rngState + 0x6D2B79F5) | 0;
        }
        state.rngState = rngState;
    }
    return state;
}
