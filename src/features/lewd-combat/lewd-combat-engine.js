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
import {
    canEngageWith,
    expireEngagements,
    findEngagement,
    refreshEngagedWith,
    upsertEngagement,
} from './lewd-combat-pairing.js';
import {
    LEWD_TECHNIQUES,
    listLegalActions,
    techniqueActorRequirementReason,
    techniqueTargetRequirementReason,
} from './lewd-combat-techniques.js';
import {
    attemptEscape,
    expireStanceOnPostureChange,
    experienceEscapeBonus,
    isOverwhelmed,
    markOverwhelmed,
    normalizeHold,
    normalizeStance,
    poiseEscapeBonus,
    tickOverwhelmed,
    tickStance,
} from './lewd-combat-states.js';

export { listLegalActions } from './lewd-combat-techniques.js';

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

function normalizeControlMode(value) {
    const key = textValue(value).toLowerCase().replace(/[_\s]+/g, '-');
    if (key === 'player-all' || key === 'playerall' || key === 'all-player') return 'player-all';
    if (key === 'ai-others' || key === 'aiothers' || key === 'others-ai') return 'ai-others';
    return 'auto';
}

/**
 * Resolve a participant's control. `control` is authoritative; a legacy board
 * that only carries `ai` (and maybe `side`) is read through those fields so the
 * board, UI, and agent can never disagree. Exported because this is the single
 * canonical fallback used by every consumer.
 *
 * @param {object} participant
 * @returns {'player'|'ai'}
 */
export function lewdParticipantControl(participant) {
    if (participant?.control === 'player' || participant?.control === 'ai') return participant.control;
    if (participant?.ai === true) return 'ai';
    if (participant?.ai === false) return 'player';
    if (participant?.side === 'enemy' || participant?.side === 'opponent') return 'ai';
    return 'player';
}

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

function cloneProfileProvenance(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
        copy[key] = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? { ...entry }
            : entry;
    }
    return copy;
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
            anatomy: Array.isArray(raw.anatomy) ? [...raw.anatomy] : [],
            skills: Array.isArray(raw.skills) ? [...raw.skills] : [],
            kinks: Array.isArray(raw.kinks) ? [...raw.kinks] : [],
            sourceSkills: Array.isArray(raw.sourceSkills) ? [...raw.sourceSkills] : [],
            sourceTraits: Array.isArray(raw.sourceTraits) ? [...raw.sourceTraits] : [],
            provenance: cloneProfileProvenance(raw.provenance),
            inferredFields: Array.isArray(raw.inferredFields) ? [...raw.inferredFields] : [],
            body: String(raw.body ?? ''),
            species: String(raw.species ?? ''),
        };
    }
    return normalizeLewdProfile(raw, { unit });
}

function buildParticipant(raw = {}, state, index, controlMode = 'auto') {
    const name = String(raw.name || `Participant ${index + 1}`).trim().slice(0, 80);
    const profile = normalizeProfile(raw.profile, raw) || inferProfile(raw, {});
    const maxStamina = maxStaminaFromProfile(profile);
    const maxArousal = clamp(profile.maxArousal, 8, 30, 10);
    const maxPoise = clamp(profile.maxPoise, 4, 16, 6);
    const spectator = raw.spectator === true;
    const stamina = clamp(raw.stamina ?? maxStamina, 0, maxStamina, maxStamina);
    const mode = normalizeControlMode(controlMode);
    let control;
    if (raw.control === 'player' || raw.control === 'ai') control = raw.control;
    else if (mode === 'player-all') control = 'player';
    else control = raw.side === 'opponent' || raw.side === 'enemy' ? 'ai' : 'player';
    const profileList = (key) => {
        if (Array.isArray(raw?.[key])) return raw[key].map(String);
        if (Array.isArray(profile?.[key])) return profile[key].map(String);
        return [];
    };
    return {
        id: uniqueId(state, raw.id, name),
        name,
        side: String(raw.side || 'player'),
        control,
        spectator,
        active: !spectator && stamina > 0,
        stats: raw.stats || raw.unit?.stats || {},
        proficiency: Number(raw.proficiency) || 0,
        initiativeBonus: Number(raw.initiativeBonus ?? raw.unit?.initiativeBonus ?? statModifier(raw, 'dex')) || 0,
        initiative: 0,
        tieBreak: 0,
        ai: control === 'ai',
        profile,
        anatomy: profileList('anatomy'),
        skills: profileList('skills'),
        kinks: profileList('kinks'),
        sourceSkills: profileList('sourceSkills'),
        sourceTraits: profileList('sourceTraits'),
        inferredFields: profileList('inferredFields'),
        provenance: raw?.provenance && typeof raw.provenance === 'object'
            ? cloneProfileProvenance(raw.provenance)
            : cloneProfileProvenance(profile.provenance),
        body: String(raw.body ?? profile.body ?? ''),
        species: String(raw.species ?? profile.species ?? ''),
        notes: String(raw.notes ?? profile.notes ?? '').trim(),
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

function textValue(value) {
    return String(value ?? '').trim();
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

function engage(state, actor, target, patch = {}) {
    return upsertEngagement(state, actor.id, target.id, patch);
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
        if (!canEngageWith(state, actor.id, target.id, state.maxPartners)) {
            return {
                targets: [],
                excluded: [{ id: target.id, name: target.name, reason: `Partner limit reached (${state.maxPartners}).` }],
                error: `Partner limit reached (${state.maxPartners}).`,
            };
        }
        return { targets: mode === 'pair' ? [target, actor] : [target], excluded: [] };
    }
    if (mode === 'group') {
        const pool = requested.length
            ? requested.map(id => findParticipant(state, id)).filter(Boolean)
            : state.participants.filter(p => p.id !== actor.id);
        return filterMultiTargets(state, actor, pool);
    }
    // aura: everyone currently engaged with the actor, else every active opponent.
    const engaged = (actor.engagedWith || [])
        .map(id => findParticipant(state, id))
        .filter(participant => isActive(participant) && participant.id !== actor.id);
    const pool = engaged.length
        ? engaged
        : state.participants.filter(p => p.id !== actor.id);
    return filterMultiTargets(state, actor, pool);
}

/**
 * Group/aura actions keep legal targets and report why the rest were skipped,
 * so the beat log and the pairing UI can explain a silent omission.
 */
function filterMultiTargets(state, actor, pool) {
    const targets = [];
    const excluded = [];
    for (const participant of pool) {
        if (participant.id === actor.id) continue;
        if (!isActive(participant)) {
            excluded.push({ id: participant.id, name: participant.name, reason: 'Target is out of the encounter.' });
            continue;
        }
        if (!canEngageWith(state, actor.id, participant.id, state.maxPartners)) {
            excluded.push({
                id: participant.id,
                name: participant.name,
                reason: `Partner limit reached (${state.maxPartners}).`,
            });
            continue;
        }
        targets.push(participant);
    }
    return { targets, excluded };
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
    // Beats carry a stable, monotonic id so the prose cursor survives the log
    // trimming its oldest entries.
    if (beat && typeof beat === 'object' && !beat.id) {
        state.beatSeq = (Number(state.beatSeq) || 0) + 1;
        beat.id = `${textValue(state.id) || 'lewd'}:beat:${state.beatSeq}`;
    }
    state.log.push(beat);
    if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

function tickParticipantRound(state, participant, endingRound) {
    participant.acted = false;
    tickStance(participant);
    // A status applied during the round that is ending has not yet had its
    // round; skip its first tick so "1 round" spans the next round.
    participant.status = participant.status
        .map(status => {
            if (Number(status.appliedRound ?? 0) >= endingRound) return status;
            return { ...status, roundsLeft: Number(status.roundsLeft) - 1 };
        })
        .filter(status => status.roundsLeft > 0);
    tickOverwhelmed(state, participant);
}

function advanceRoundIfComplete(state) {
    if (state.status !== 'active') return;
    const eligible = state.participants.filter(isActive);
    if (!eligible.length) return;
    if (!eligible.every(participant => participant.acted)) return;

    state.round += 1;
    const endingRound = state.round - 1;
    for (const participant of state.participants) tickParticipantRound(state, participant, endingRound);
    expireEngagements(state, state.round);

    if (state.round > state.roundCap) {
        endEncounter(state, 'draw', { reason: 'round-cap' });
    }
}

function endEncounter(state, outcome, extra = {}) {
    if (state.status === 'ended') return state.outcome;
    state.status = 'ended';
    state.outcome = outcome;
    state.endedRound = state.round;
    state.endedAt = Number(extra.endedAt) || Date.now();
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
    const controlMode = normalizeControlMode(options.controlMode);
    const state = {
        format: LEWD_STATE_FORMAT,
        schemaVersion: LEWD_STATE_VERSION,
        id: String(options.id || ''),
        mode: LEWD_MODES.includes(options.mode) ? options.mode : 'duel',
        controlMode,
        status: 'active',
        round: 1,
        roundCap: clamp(settings.lewdCombatRoundCap, 1, 60, DEFAULT_ROUND_CAP),
        maxPartners: clamp(settings.lewdCombatMaxPartners, 1, 4, DEFAULT_MAX_PARTNERS),
        // Only the flags the resolution policy needs; the full settings object
        // stays outside the board so it is never serialized by accident.
        settings: {
            lewdCombatDarkerThemes: !!settings.lewdCombatDarkerThemes,
            lewdCombatExplicitness: String(settings.lewdCombatExplicitness || 'explicit'),
        },
        seed,
        rollCount: 0,
        rngState: hashSeed(seed),
        techniques: Array.isArray(options.techniques) ? options.techniques : LEWD_TECHNIQUES,
        participants: [],
        engagements: [],
        log: [],
        actionLog: [],
        outcome: null,
        summary: '',
        endedAt: 0,
        stopped: false,
        prose: null,
        proseLog: [],
        proseSeq: 0,
        beatSeq: 0,
        lastNarratedLogIndex: -1,
        narratedBeatIds: [],
    };

    const input = Array.isArray(options.participants) ? options.participants : [];
    input.forEach((raw, index) => {
        state.participants.push(buildParticipant(raw, state, index, controlMode));
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
 * Non-authoritative model text (a taunt or intent) is recorded for the prose
 * pass only. It is sanitized, capped, and never read by the math below.
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeLewdFlavor(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
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

    if (type === 'escape') {
        const requested = targetIdsOf(action)[0];
        const holds = state.engagements.filter(edge =>
            edge.hold && (edge.a === actor.id || edge.b === actor.id));
        const edge = requested
            ? holds.find(candidate => candidate.a === requested || candidate.b === requested)
            : holds[0];
        if (!edge) return { ok: false, reason: 'You are not being held.' };
        const natural = rollDie(state, 20);
        const escape = attemptEscape(state, actor, edge, {
            roll: natural,
            poiseBonus: poiseEscapeBonus(actor),
            escapeBonus: statModifier(actor, 'dex') + experienceEscapeBonus(actor),
        });
        if (!escape.resolved) return { ok: false, reason: escape.reason };
        actor.acted = true;
        const beat = {
            type: 'escape',
            round: state.round,
            actor: { id: actor.id, name: actor.name },
            target: { id: escape.holderId, name: escape.holderName },
            hold: escape.hold,
            natural,
            total: escape.total,
            dc: escape.dc,
            success: escape.success,
            stateChanges: [
                escape.success
                    ? `${actor.name} escapes ${escape.holderName}'s ${escape.hold.label}.`
                    : `${actor.name} fails to escape ${escape.holderName}'s ${escape.hold.label}.`,
            ],
        };
        pushLog(state, beat);
        state.actionLog.push({
            round: state.round,
            unitId: actor.id,
            type: 'escape',
            targetIds: [escape.holderId],
            success: escape.success,
            source: actionSummarySource(action),
        });
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
    const actorRequirementReason = techniqueActorRequirementReason(state, actor, technique);
    if (actorRequirementReason) {
        return { ok: false, reason: actorRequirementReason };
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
    const excluded = [...(resolved.excluded || [])];
    for (const target of resolved.targets) {
        const targetRequirementReason = techniqueTargetRequirementReason(state, actor, target, technique);
        if (targetRequirementReason) {
            excluded.push({ id: target.id, name: target.name, reason: targetRequirementReason });
            continue;
        }
        if (!requiresHoldCheck(state, actor, target, technique)) {
            excluded.push({ id: target.id, name: target.name, reason: 'Requires a hold.' });
            continue;
        }
        if (technique.requires?.overwhelmed && target.id !== actor.id && !isOverwhelmed(state, target)) {
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

    expireStanceOnPostureChange(actor, posture);

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
    const flavor = sanitizeLewdFlavor(action?.flavor);
    const intent = sanitizeLewdFlavor(action?.intent);
    if (flavor) beat.flavor = flavor;
    if (intent) beat.intent = intent;

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
            const selfRecovery = target.id === actor.id && technique.category === 'recover';
            const rawArousal = rollLewdDice(state, technique.arousal).total + NUMBER(LEWD_POSTURES[posture]?.arousal);
            if (rawArousal > 0) {
                const delta = Math.max(1, round(rawArousal * arousalMultiplier(state, target, zone, technique)));
                const before = target.arousal;
                if (selfRecovery) {
                    target.arousal = clamp(target.arousal - delta, 0, target.maxArousal, 0);
                } else {
                    target.arousal = clamp(target.arousal + delta, 0, target.maxArousal, target.maxArousal);
                }
                entry.arousalDelta = target.arousal - before;
            }

            const rawPoise = rollLewdDice(state, technique.poise).total;
            if (rawPoise > 0) {
                const before = target.poise;
                target.poise = selfRecovery
                    ? clamp(target.poise + rawPoise, 0, target.maxPoise, target.maxPoise)
                    : clamp(target.poise - rawPoise, 0, target.maxPoise, 0);
                entry.poiseDelta = target.poise - before;
                if (!selfRecovery && target.poise <= 0) {
                    markOverwhelmed(state, target);
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
        ...(flavor ? { flavor } : {}),
        ...(intent ? { intent } : {}),
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
        markOverwhelmed(state, participant);
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
    const participant = buildParticipant(raw, state, state.participants.length, state.controlMode);
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
        isActive(participant) && lewdParticipantControl(participant) === 'ai');
    return pool.find(participant => !participant.acted) || null;
}

function categoryWeight(actor, category) {
    const role = actor?.profile?.role;
    if (role === 'dominant') {
        if (['hold', 'command', 'finisher'].includes(category)) return 1.2;
        if (category === 'submit') return -1;
        return 0;
    }
    if (role === 'submissive') {
        if (['submit', 'counter', 'recover'].includes(category)) return 1.2;
        if (['command', 'hold'].includes(category)) return -0.8;
        return 0;
    }
    if (role === 'switch') {
        if (['stance', 'tease', 'technique'].includes(category)) return 0.8;
    }
    return 0;
}

function conditionWeight(state, actor, entry, target) {
    const conditions = entry.technique?.ai?.conditions || [];
    let weight = 0;
    for (const condition of conditions) {
        if (condition === 'held') {
            if (state.engagements.some(edge => edge.hold && (edge.a === actor.id || edge.b === actor.id))) weight += 0.8;
        } else if (condition === 'overwhelmed') {
            if (target && isOverwhelmed(state, target)) weight += 0.8;
        } else if (condition === 'darker') {
            if (state.settings?.lewdCombatDarkerThemes) weight += 0.5;
        } else if (condition.startsWith('role:')) {
            if (actor.profile?.role === condition.slice(5)) weight += 0.6;
        } else if (condition.startsWith('targetSensitive:')) {
            const zone = condition.slice('targetSensitive:'.length);
            if (target && zoneMultiplier(target.profile, zone) >= 1.25) weight += 0.8;
        }
    }
    return weight;
}

function targetWeight(target, entry) {
    if (!target || !entry.zones?.length) return 0;
    return entry.zones.reduce((sum, zone) => sum + zoneMultiplier(target.profile, zone), 0) / entry.zones.length;
}

/**
 * Deterministic local policy. It scores only actions that `listLegalActions`
 * considers legal, applies a repetition penalty, and biases by role and target
 * sensitivity. Ties are broken by the seeded RNG, never `Math.random`.
 *
 * @param {object} state
 * @param {object|string} unit
 * @param {{ techniques?: object[] }} [options]
 * @returns {{ action: object, technique: object, entry: object, score: number }|null}
 */
export function chooseOpponentAction(state, unit, options = {}) {
    const actor = findParticipant(state, unit);
    if (!actor || !isActive(actor) || actor.acted) return null;
    const legal = listLegalActions(state, actor, options);
    const recent = state.actionLog.filter(entry => entry.unitId === actor.id).slice(-6);
    const scored = [];
    for (const entry of legal) {
        if (entry.disabled) continue;
        const legalTargets = entry.targets.filter(target => !target.disabled);
        if (entry.technique.targetMode !== 'self' && !legalTargets.length) continue;
        const repetitions = recent.filter(action => action.techniqueId === entry.id).length;
        const targets = entry.technique.targetMode === 'self' ? [null] : legalTargets;
        for (const target of targets) {
            const score = NUMBER(entry.technique.ai?.priority)
                + categoryWeight(actor, entry.category)
                + conditionWeight(state, actor, entry, target)
                + (target ? targetWeight(target, entry) * 0.5 : 0)
                - repetitions * 1.5
                + nextRandom(state) * 0.001;
            scored.push({ entry, target, score });
        }
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const action = {
        type: 'technique',
        unitId: actor.id,
        techniqueId: best.entry.id,
        posture: best.entry.posture,
        source: 'ai',
    };
    if (best.target) {
        action.targetIds = [best.target.id];
        action.zone = best.entry.zones[0];
    }
    return { action, technique: best.entry.technique, entry: best.entry, score: best.score };
}

function localOpponentChoice(state, actor, options) {
    const chosen = chooseOpponentAction(state, actor, options);
    if (!chosen) return null;
    const result = applyLewdAction(state, chosen.action, options);
    return result.ok ? result : null;
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

/** Cap the prose transcript so a long scene cannot grow the saved board without bound. */
export const LEWD_PROSE_LOG_LIMIT = 50;

/**
 * Stable id for a log entry. Beats may not carry their own id, so the board id
 * plus the log index is the identity used by the prose transcript.
 *
 * @param {object} state
 * @param {object} beat
 * @param {number} index
 * @returns {string}
 */
export function lewdBeatId(state, beat, index) {
    const id = textValue(beat?.id);
    if (id) return id;
    return `${textValue(state?.id) || 'lewd'}:beat:${Number(index) || 0}`;
}

/**
 * Normalize the prose transcript fields on a board. Safe to call repeatedly.
 * @param {object} state
 * @returns {object|null}
 */
export function ensureLewdProseState(state) {
    if (!state || typeof state !== 'object') return null;
    state.proseLog = Array.isArray(state.proseLog) ? state.proseLog.slice(-LEWD_PROSE_LOG_LIMIT) : [];
    state.proseSeq = Math.max(0, Number(state.proseSeq) || 0);
    state.beatSeq = Math.max(0, Number(state.beatSeq) || 0);
    state.lastNarratedLogIndex = Number.isFinite(Number(state.lastNarratedLogIndex))
        ? Number(state.lastNarratedLogIndex)
        : -1;
    state.narratedBeatIds = Array.isArray(state.narratedBeatIds)
        ? state.narratedBeatIds.map(String)
        : [];
    if (!state.prose || typeof state.prose !== 'object') state.prose = null;
    return state;
}

/**
 * Append one prose transcript entry (model prose or deterministic fallback).
 * Newest last, capped, and mirrored to `state.prose` for compatibility.
 *
 * @param {object} state
 * @param {object} entry
 * @returns {object|null}
 */
export function appendLewdProseEntry(state, entry = {}) {
    if (!state || typeof state !== 'object') return null;
    ensureLewdProseState(state);
    state.proseSeq += 1;
    const round = Math.max(1, Number(entry.round) || Number(state.round) || 1);
    const beatIds = Array.isArray(entry.beatIds) ? entry.beatIds.map(String).filter(Boolean) : [];
    const item = {
        id: textValue(entry.id) || `${textValue(state.id) || 'lewd'}:prose:${state.proseSeq}`,
        stateId: textValue(entry.stateId) || textValue(state.id),
        chatId: textValue(entry.chatId) || textValue(state.chatId),
        round,
        exchangeId: textValue(entry.exchangeId) || `${textValue(state.id) || 'lewd'}:${round}:${beatIds[0] || state.proseSeq}`,
        actorIds: Array.isArray(entry.actorIds) ? entry.actorIds.map(String).filter(Boolean) : [],
        beatIds,
        text: String(entry.text ?? '').trim(),
        source: textValue(entry.source) || 'model',
        createdAt: Number(entry.createdAt) || Date.now(),
    };
    state.proseLog = [...state.proseLog, item].slice(-LEWD_PROSE_LOG_LIMIT);
    state.prose = { text: item.text, round: item.round };
    return item;
}

/**
 * Advance the narrated cursor after prose (or a deterministic fallback) covers
 * every log entry up to `upToIndex`.
 *
 * @param {object} state
 * @param {number} upToIndex
 * @param {string[]} [beatIds]
 * @returns {object|null}
 */
export function markLewdBeatsNarrated(state, upToIndex, beatIds = []) {
    if (!state || typeof state !== 'object') return null;
    ensureLewdProseState(state);
    state.lastNarratedLogIndex = Math.max(
        state.lastNarratedLogIndex,
        Number(upToIndex) || 0,
    );
    const seen = new Set(state.narratedBeatIds);
    for (const id of Array.isArray(beatIds) ? beatIds : []) {
        const value = textValue(id);
        if (value) seen.add(value);
    }
    // The sentinel set is an aid for debugging/back-compat, not the cursor; cap
    // it so a very long board does not accumulate forever.
    state.narratedBeatIds = [...seen].slice(-200);
    return state;
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
    state.controlMode = normalizeControlMode(state.controlMode);
    state.seed = String(state.seed ?? 'lewd-combat');
    state.rollCount = Math.max(0, Number(state.rollCount) || 0);
    state.techniques = Array.isArray(state.techniques) && state.techniques.length
        ? state.techniques
        : LEWD_TECHNIQUES;
    state.participants = Array.isArray(state.participants) ? state.participants : [];
    state.engagements = Array.isArray(state.engagements) ? state.engagements : [];
    state.log = Array.isArray(state.log) ? state.log : [];
    state.actionLog = Array.isArray(state.actionLog) ? state.actionLog : [];
    state.stopped = !!state.stopped;
    ensureLewdProseState(state);
    for (const beat of state.log) {
        if (beat && typeof beat === 'object' && !beat.id) {
            state.beatSeq += 1;
            beat.id = `${textValue(state.id) || 'lewd'}:beat:${state.beatSeq}`;
        }
    }
    state.endedAt = Math.max(0, Number(state.endedAt) || 0);
    // The resolution latch is written once by `finishEncounterIfEnded`; hydrate
    // only preserves a stored record so a reload cannot drop it. No synthetic
    // null is added, so a fresh board round-trips byte-for-byte.
    if (!state.resolution || typeof state.resolution !== 'object') delete state.resolution;

    for (const participant of state.participants) {
        participant.status = Array.isArray(participant.status) ? participant.status : [];
        participant.engagedWith = Array.isArray(participant.engagedWith) ? participant.engagedWith : [];
        participant.uses = participant.uses && typeof participant.uses === 'object' ? participant.uses : {};
        participant.stance = participant.stance || null;
        participant.acted = !!participant.acted;
        participant.atMercy = !!participant.atMercy || Number(participant.stamina) <= 0;
        participant.surrendered = !!participant.surrendered;
        participant.spectator = !!participant.spectator;
        // Control is persisted, but a legacy board may only carry `ai`. Backfill
        // from `ai` (then side) and re-mirror so the two never disagree.
        if (participant.control !== 'player' && participant.control !== 'ai') {
            if (participant.ai === true) participant.control = 'ai';
            else if (participant.ai === false) participant.control = 'player';
            else if (participant.side === 'enemy' || participant.side === 'opponent') participant.control = 'ai';
            else participant.control = 'player';
        }
        participant.ai = participant.control === 'ai';
        participant.active = !participant.spectator && !participant.atMercy && !participant.surrendered;
        participant.maxStamina = clamp(participant.maxStamina, 1, 6, 2);
        participant.stamina = clamp(participant.stamina, 0, participant.maxStamina, participant.maxStamina);
        participant.maxArousal = clamp(participant.maxArousal, 8, 30, 10);
        participant.arousal = clamp(participant.arousal, 0, participant.maxArousal, 0);
        participant.maxPoise = clamp(participant.maxPoise, 4, 16, 6);
        participant.poise = clamp(participant.poise, 0, participant.maxPoise, participant.maxPoise);
        if (!participant.profile) participant.profile = inferProfile(participant, {});
        // Profile capability data is additive. Legacy boards get empty
        // containers; unknown persisted fields are left untouched.
        for (const key of ['anatomy', 'skills', 'kinks', 'sourceSkills', 'sourceTraits', 'inferredFields']) {
            participant[key] = Array.isArray(participant[key]) ? participant[key] : [];
        }
        participant.provenance = cloneProfileProvenance(participant.provenance);
        participant.body = String(participant.body ?? '');
        participant.species = String(participant.species ?? '');
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
