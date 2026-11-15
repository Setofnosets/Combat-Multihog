/**
 * lewd-combat-context.js — turn the memo/scene into Lewd Combat participants.
 *
 * The tactical context collector already knows how to read `[CHARACTER]`,
 * `[PARTY]`, and `[COMBAT]` blocks. This module reuses that reader for the
 * roster, then merges the optional `[LEWD]` profiles and the narrator-provided
 * session names. Everything here is pure: it reads settings and a SillyTavern
 * context object, returns plain data, and persists nothing.
 *
 * Important: `collectEncounterContext` throws when every player character is
 * defeated. A lewd board is still allowed to start from `[LEWD]` names and
 * spectators, so the failure is downgraded to a warning and profiles are parsed
 * directly from the memo instead.
 */

import { LEWD_COMBAT_LABEL } from './lewd-combat-constants.js';
import {
    applyLewdAction,
    createLewdEncounterState,
    lewdParticipantControl,
    listLegalActions,
} from './lewd-combat-engine.js';
import {
    inferProfile,
    normalizeLewdName,
    parseLewdProfiles,
} from './lewd-combat-profile.js';
import { getLewdEncounterForChat, setLewdEncounterForChat } from './lewd-combat-store.js';
import {
    collectEncounterContext,
    parseCombatUnits,
    parsePlayerUnits,
} from '../tactical-combat/tactical-combat-context.js';

const START_MODES = Object.freeze(['duel', 'group', 'free-for-all']);

function text(value) {
    return String(value ?? '').trim();
}

function unitKey(unit) {
    return normalizeLewdName(unit?.name);
}

function profileIsExplicit(profile) {
    return !!profile && profile.inferred !== true && profile.source !== 'inferred';
}

/**
 * Normalize a start mode. Unknown/missing values fall back to `duel`.
 * @param {unknown} value
 * @returns {'duel'|'group'|'free-for-all'}
 */
export function resolveLewdStartMode(value) {
    const key = text(value).toLowerCase().replace(/[_\s]+/g, '-');
    if (key === 'freeforall' || key === 'ffa' || key === 'free-for-all') return 'free-for-all';
    if (key === 'group') return 'group';
    if (key === 'duel') return 'duel';
    return 'duel';
}

/**
 * Normalize a participant-control policy. Unknown/missing values fall back to
 * `auto`, so a stale or hand-edited setting can never break a start.
 * @param {unknown} value
 * @returns {'auto'|'player-all'|'ai-others'}
 */
export function resolveLewdControlMode(value) {
    const key = text(value).toLowerCase().replace(/[_\s]+/g, '-');
    if (key === 'player-all' || key === 'playerall' || key === 'all-player') return 'player-all';
    if (key === 'ai-others' || key === 'aiothers' || key === 'others-ai') return 'ai-others';
    return 'auto';
}

function normalizePlayerKeys(playerNames) {
    // Callers that already hold a normalized set pass it straight through so a
    // per-candidate resolve loop does not rebuild it for every candidate.
    if (playerNames instanceof Set) return playerNames;
    const keys = new Set();
    for (const name of Array.isArray(playerNames) ? playerNames : []) {
        const key = normalizeLewdName(name);
        if (key) keys.add(key);
    }
    return keys;
}

/**
 * Resolve who controls one roster candidate. Control is independent of `side`:
 * `player-all` makes every participant player-controlled; `auto`/`ai-others`
 * keep only party/player-persona names on the player side and hand every
 * `[COMBAT]`, `[LEWD]`-only, session, or scene NPC to the AI. An explicit
 * `control` on the candidate always wins. Never inferred from names alone.
 *
 * @param {object} entry
 * @param {{ controlMode?: string, playerNames?: Iterable<string> }} [options]
 * @returns {'player'|'ai'}
 */
export function resolveLewdParticipantControl(entry = {}, options = {}) {
    if (entry?.control === 'player' || entry?.control === 'ai') return entry.control;
    if (resolveLewdControlMode(options.controlMode) === 'player-all') return 'player';

    const key = text(entry?.normalizedName) || normalizeLewdName(entry?.name);
    const playerKeys = normalizePlayerKeys(options.playerNames);
    if (key && playerKeys.has(key)) return 'player';

    const sources = Array.isArray(entry?.sources) ? entry.sources : [];
    if (sources.includes('party')) return 'player';
    if (text(entry?.unit?.side).toLowerCase() === 'player') return 'player';
    return 'ai';
}

function resolveChatId(collected, ctx, options) {
    const candidates = [
        options?.chatId,
        collected?.chatId,
        ctx?.chatId,
        typeof ctx?.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : '',
    ];
    for (const candidate of candidates) {
        const value = text(candidate);
        if (value) return value;
    }
    return '';
}

/**
 * Read the roster and profiles for a lewd board.
 *
 * @param {Record<string, any>} settings
 * @param {object} [ctx] SillyTavern context (`name1`, `name2`, `chat`, …)
 * @param {object} [options]
 * @returns {{
 *   chatId: string,
 *   memo: string,
 *   location: string,
 *   sceneExcerpt: string,
 *   controlMode: 'auto'|'player-all'|'ai-others',
 *   playerNames: string[],
 *   profiles: Record<string, object>,
 *   units: object[],
 *   candidates: object[],
 *   warnings: string[],
 * }}
 */
export function collectLewdContext(settings = {}, ctx = {}, options = {}) {
    const warnings = [];
    const memo = String(settings?.currentMemo || '');
    const controlMode = resolveLewdControlMode(options.controlMode ?? settings?.lewdCombatControlMode);
    const playerNames = new Set();
    const personaKey = normalizeLewdName(ctx?.name1);
    if (personaKey) playerNames.add(personaKey);
    for (const key of normalizePlayerKeys(options.playerNames)) playerNames.add(key);
    let collected = null;
    try {
        collected = collectEncounterContext(settings, ctx, options);
    } catch (error) {
        // A defeated party must not crash the lewd start; the roster below is
        // rebuilt from the memo and any `[LEWD]` profiles.
        const message = error?.message || 'Encounter context could not be read.';
        if (message) warnings.push(message);
    }

    const sourceMemo = String(collected?.memo || memo);
    const location = text(options.location || collected?.location || '');
    const sceneExcerpt = String(collected?.sceneExcerpt || '');
    const chatId = resolveChatId(collected, ctx, options);

    let playerUnits = Array.isArray(collected?.playerUnits) ? [...collected.playerUnits] : [];
    let enemies = Array.isArray(collected?.enemies) ? [...collected.enemies] : [];
    let allies = Array.isArray(collected?.allies) ? [...collected.allies] : [];

    if (!collected) {
        try {
            playerUnits = parsePlayerUnits(sourceMemo, ctx, {});
        } catch (error) {
            warnings.push(error?.message || 'Party roster could not be parsed.');
        }
        try {
            const combat = parseCombatUnits(sourceMemo, {});
            enemies = combat.enemies;
            allies = combat.allies;
        } catch (error) {
            warnings.push(error?.message || 'Combat roster could not be parsed.');
        }
    }

    const units = [...playerUnits, ...allies, ...enemies].filter(Boolean);
    const profiles = parseLewdProfiles(sourceMemo, settings, { units });

    const candidates = [];
    const byKey = new Map();

    const addCandidate = (entry) => {
        const key = entry.normalizedName;
        if (!key) return;
        if (entry.control === 'player' || entry.control === 'ai') entry.controlExplicit = true;
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, entry);
            candidates.push(entry);
            return;
        }
        if (!existing.unit && entry.unit) existing.unit = entry.unit;
        for (const source of entry.sources) {
            if (!existing.sources.includes(source)) existing.sources.push(source);
        }
        const incomingExplicit = profileIsExplicit(entry.profile);
        const existingExplicit = profileIsExplicit(existing.profile);
        if (incomingExplicit && !existingExplicit) {
            existing.profile = entry.profile;
            existing.inferred = false;
            existing.roleSuggestion = entry.roleSuggestion;
        }
        if (entry.controlExplicit && !existing.controlExplicit) {
            existing.control = entry.control;
            existing.controlExplicit = true;
        }
        if (existing.unit?.side) existing.side = existing.unit.side;
        else if (entry.unit?.side) existing.side = entry.unit.side;
    };

    // `[LEWD]`/inline profiles are candidates even without a party/combat unit.
    for (const [key, profile] of Object.entries(profiles || {})) {
        const unit = units.find(candidate => unitKey(candidate) === key) || null;
        addCandidate({
            name: profile.name || unit?.name || key,
            normalizedName: key,
            unit,
            side: unit?.side || 'player',
            roleSuggestion: profile.role || '',
            profile,
            inferred: !profileIsExplicit(profile),
            sources: ['lewd'],
        });
    }

    const addUnits = (list, source) => {
        for (const unit of list) {
            const key = unitKey(unit);
            if (!key) continue;
            const explicit = profiles?.[key] || null;
            addCandidate({
                name: unit.name,
                normalizedName: key,
                unit,
                side: unit.side || 'player',
                roleSuggestion: explicit?.role || '',
                profile: explicit || inferProfile(unit, settings),
                inferred: !profileIsExplicit(explicit),
                sources: [source],
            });
        }
    };
    addUnits(playerUnits, 'party');
    addUnits(allies, 'combat');
    addUnits(enemies, 'combat');

    // Narrator / session names (`{{user}}` and the active character).
    for (const name of [text(ctx?.name1), text(ctx?.name2)]) {
        if (!name) continue;
        const key = normalizeLewdName(name);
        if (!key) continue;
        const unit = units.find(candidate => unitKey(candidate) === key) || null;
        const explicit = profiles?.[key] || null;
        addCandidate({
            name: unit?.name || name,
            normalizedName: key,
            unit,
            side: unit?.side || 'player',
            roleSuggestion: explicit?.role || '',
            profile: explicit || inferProfile(unit || { name }, settings),
            inferred: !profileIsExplicit(explicit),
            sources: ['session'],
        });
    }

    // Names already present in the scene excerpt become scene-sourced too.
    const sceneHaystack = sceneExcerpt.toLowerCase();
    if (sceneHaystack) {
        for (const candidate of candidates) {
            const needle = text(candidate.name).toLowerCase();
            if (needle && sceneHaystack.includes(needle) && !candidate.sources.includes('scene')) {
                candidate.sources.push('scene');
            }
        }
    }

    // Control is resolved once the merged sources/units are final. An explicit
    // control survives the merge; everything else follows the selected mode.
    for (const candidate of candidates) {
        candidate.control = candidate.controlExplicit
            ? candidate.control
            : resolveLewdParticipantControl(
                { ...candidate, control: undefined },
                { controlMode, playerNames },
            );
    }

    return {
        chatId,
        memo: sourceMemo,
        location,
        sceneExcerpt,
        controlMode,
        playerNames: [...playerNames],
        profiles,
        units,
        candidates,
        warnings,
    };
}

function findCandidate(context, name) {
    const key = normalizeLewdName(name);
    if (!key) return null;
    return (context?.candidates || []).find(candidate => candidate.normalizedName === key) || null;
}

function seedControlFor(name, candidate, controlMode, playerNames, options = {}) {
    if (candidate?.controlExplicit && (candidate.control === 'player' || candidate.control === 'ai')) {
        return candidate.control;
    }
    // A candidate already carries the control resolved by `collectLewdContext`.
    // Re-resolve only when the caller asks for a different mode or player list.
    if (candidate
        && (candidate.control === 'player' || candidate.control === 'ai')
        && !options.playerNamesProvided
        && resolveLewdControlMode(controlMode) === resolveLewdControlMode(options.contextControlMode)) {
        return candidate.control;
    }
    if (candidate) {
        return resolveLewdParticipantControl(
            { ...candidate, control: undefined },
            { controlMode, playerNames },
        );
    }
    if (resolveLewdControlMode(controlMode) === 'player-all') return 'player';
    const key = normalizeLewdName(name);
    if (key && normalizePlayerKeys(playerNames).has(key)) return 'player';
    // Unknown, session-only names belong to the AI unless the player list or
    // the mode says otherwise. Never guess from the name itself.
    return 'ai';
}

function seedForName(name, context, settings, spectator, options = {}) {
    const clean = text(name);
    if (!clean) return null;
    const controlMode = options.controlMode ?? context?.controlMode ?? settings?.lewdCombatControlMode;
    const playerNames = options.playerNames || context?.playerNames || [];
    const candidate = findCandidate(context, clean);
    const control = seedControlFor(clean, candidate, controlMode, playerNames, {
        contextControlMode: context?.controlMode,
        playerNamesProvided: options.playerNamesProvided === true,
    });
    if (candidate) {
        const unit = candidate.unit || null;
        return {
            name: candidate.name || clean,
            side: candidate.side || unit?.side || 'player',
            control,
            ai: control === 'ai',
            spectator: !!spectator,
            stats: unit?.stats || {},
            proficiency: Number(unit?.proficiency) || 0,
            initiativeBonus: unit?.initiativeBonus,
            profile: candidate.profile || inferProfile(unit || { name: clean }, settings),
        };
    }
    return {
        name: clean,
        side: 'player',
        control,
        ai: control === 'ai',
        spectator: !!spectator,
        stats: {},
        proficiency: 0,
        profile: inferProfile({ name: clean }, settings),
    };
}

/**
 * Build engine participant seeds from a collected context.
 *
 * Unknown names are allowed: they become inferred, unit-less participants.
 * Control follows `controlMode`/`playerNames`; unknown names are AI-controlled
 * unless the mode is `player-all` or the name is explicitly a player. The
 * function throws when fewer than two non-spectator participants are selected —
 * that is a programming/selection error the caller must surface, not a board.
 *
 * @param {object} context
 * @param {{ participantNames?: string[], spectatorNames?: string[], mode?: string, settings?: object, controlMode?: string, playerNames?: string[] }} [options]
 * @returns {object[]}
 */
export function buildLewdParticipantSeeds(context, options = {}) {
    const settings = options.settings || {};
    const controlMode = options.controlMode ?? context?.controlMode ?? settings.lewdCombatControlMode;
    const explicitPlayerNames = Array.isArray(options.playerNames) ? options.playerNames : [];
    const contextPlayerNames = Array.isArray(context?.playerNames) ? context.playerNames : [];
    const playerNames = [...new Set([...explicitPlayerNames, ...contextPlayerNames])];
    const seedOptions = {
        controlMode,
        playerNames,
        playerNamesProvided: explicitPlayerNames.length > 0,
    };
    const participants = [];
    const spectators = [];
    const seen = new Set();

    for (const name of options.participantNames || []) {
        const seed = seedForName(name, context, settings, false, seedOptions);
        if (!seed) continue;
        const key = normalizeLewdName(seed.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        participants.push(seed);
    }
    for (const name of options.spectatorNames || []) {
        const seed = seedForName(name, context, settings, true, seedOptions);
        if (!seed) continue;
        const key = normalizeLewdName(seed.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        spectators.push(seed);
    }

    if (participants.length < 2) {
        throw new Error('Lewd Combat needs at least two active participants. Select two or more names.');
    }
    return [...participants, ...spectators];
}

const DEFAULT_POST_ENCOUNTER_COOLDOWN_MS = 60000;

function postEncounterLatchEnabled(settings) {
    return settings?.lewdCombatPostEncounterLatch !== false;
}

function postEncounterCooldownMs(settings) {
    const value = Number(settings?.lewdCombatPostEncounterCooldownMs);
    if (!Number.isFinite(value)) return DEFAULT_POST_ENCOUNTER_COOLDOWN_MS;
    return Math.max(0, Math.min(600000, value));
}

function sameResolution(state, stateId) {
    const id = text(stateId);
    return !id
        || String(state?.resolution?.stateId ?? '') === id
        || String(state?.id ?? '') === id;
}

/**
 * Record that the narrator actually injected the outcome. This is half of the
 * turn-based latch; consumption happens on the next user turn.
 *
 * @param {Record<string, any>} settings
 * @param {string} chatId
 * @param {string} [stateId]
 * @param {{ now?: number, persist?: boolean }} [options]
 * @returns {boolean}
 */
export function markLewdResolutionDelivered(settings, chatId, stateId, options = {}) {
    if (!settings || !text(chatId)) return false;
    const state = getLewdEncounterForChat(chatId, settings);
    if (!state?.resolution || !sameResolution(state, stateId)) return false;
    if (Number(state.resolution.deliveredAt) > 0) return true;
    state.resolution.deliveredAt = Number(options.now) || Date.now();
    setLewdEncounterForChat(chatId, state, settings, { persist: options.persist !== false });
    return true;
}

/**
 * Consume the resolution latch. Manual consumption (New encounter / Reset)
 * bypasses the cooldown; automatic consumption still leaves the cooldown as a
 * safety net.
 *
 * @param {Record<string, any>} settings
 * @param {string} chatId
 * @param {{ reason?: string, now?: number, persist?: boolean }} [options]
 * @returns {object|null}
 */
export function consumeLewdResolution(settings, chatId, options = {}) {
    if (!settings || !text(chatId)) return null;
    const state = getLewdEncounterForChat(chatId, settings);
    if (!state?.resolution) return null;
    const now = Number(options.now) || Date.now();
    if (!Number(state.resolution.consumedAt)) {
        state.resolution.consumedAt = now;
        state.resolution.consumedFor = text(options.reason) || 'manual';
    }
    // The finalizing marker exists to block the tool until the handoff is
    // acknowledged. Once consumed it must stop blocking.
    if (state.finalization && state.finalization.finalizing) {
        state.finalization = {
            ...state.finalization,
            finalizing: false,
            finalizingClearedAt: now,
        };
    }
    setLewdEncounterForChat(chatId, state, settings, { persist: options.persist !== false });
    return state.resolution;
}

/**
 * Consume a resolution that the narrator already delivered. Called at the start
 * of the user-turn tool sync: the next player turn acknowledges the aftermath.
 *
 * @param {Record<string, any>} settings
 * @param {string} chatId
 * @param {{ now?: number, persist?: boolean }} [options]
 * @returns {object|null}
 */
export function consumeDeliveredLewdResolution(settings, chatId, options = {}) {
    if (!settings || !text(chatId) || !postEncounterLatchEnabled(settings)) return null;
    const state = getLewdEncounterForChat(chatId, settings);
    if (!state?.resolution) return null;
    if (!Number(state.resolution.deliveredAt)) return null;
    if (Number(state.resolution.consumedAt)) return null;
    return consumeLewdResolution(settings, chatId, { ...options, reason: 'user-turn' });
}

/**
 * Whether a start must be refused because the previous encounter still owns the
 * chat: unconsumed handoff, in-flight finalization, or the post-encounter
 * cooldown. Legacy finished boards without a resolution stay startable.
 *
 * @param {Record<string, any>} settings
 * @param {string} chatId
 * @param {{ now?: number }} [options]
 * @returns {{ latched: boolean, reason?: string }}
 */
export function isLewdStartLatched(settings, chatId, options = {}) {
    const id = text(chatId);
    if (!settings || !id) return { latched: false };
    const state = getLewdEncounterForChat(id, settings);
    if (!state) return { latched: false };
    const now = Number(options.now) || Date.now();
    const resolution = state.resolution && typeof state.resolution === 'object'
        ? state.resolution
        : null;
    const consumed = Number(resolution?.consumedAt) > 0;
    const manual = consumed && ['manual', 'reset'].includes(text(resolution?.consumedFor));

    if (state.status !== 'active') {
        if (resolution && !consumed && postEncounterLatchEnabled(settings)) {
            return {
                latched: true,
                reason: 'The last Lewd Combat scene has not been acknowledged yet. Finish its aftermath or choose New encounter before starting another.',
            };
        }
        const endedAt = Number(resolution?.endedAt || state.endedAt) || 0;
        const cooldown = postEncounterCooldownMs(settings);
        if (endedAt && cooldown > 0 && !manual && now - endedAt < cooldown) {
            const seconds = Math.ceil((cooldown - Math.max(0, now - endedAt)) / 1000);
            return {
                latched: true,
                reason: `A Lewd Combat scene just ended. Wait ${seconds}s or choose New encounter before starting another.`,
            };
        }
        if (!resolution && state.finalization?.finalizing && postEncounterLatchEnabled(settings)) {
            return {
                latched: true,
                reason: 'The last Lewd Combat outcome is still being delivered. Wait for the aftermath before starting another scene.',
            };
        }
    }
    if (state.finalization?.finalizing && !consumed) {
        return {
            latched: true,
            reason: 'The last Lewd Combat outcome is still being delivered. Wait for the aftermath before starting another scene.',
        };
    }
    return { latched: false };
}

/**
 * Whether a fresh lewd board may start for this chat.
 * @param {Record<string, any>} settings
 * @param {string} chatId
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canStartLewdEncounter(settings, chatId) {
    if (!settings?.lewdCombatEnabled) {
        return { ok: false, reason: 'Lewd Combat is disabled. Enable it in Settings → Combat first.' };
    }
    const id = text(chatId);
    if (!id) return { ok: false, reason: 'Open a chat before starting Lewd Combat.' };
    const existing = getLewdEncounterForChat(id, settings);
    if (existing && existing.status === 'active') {
        return { ok: false, reason: 'A Lewd Combat board is already active in this chat. Reset it first.' };
    }
    const latch = isLewdStartLatched(settings, id);
    if (latch.latched) return { ok: false, reason: latch.reason };
    const tactical = settings?.tacticalCombatByChat?.[id]?.status;
    const traditional = settings?.traditionalCombatByChat?.[id]?.status;
    if (tactical === 'active' || traditional === 'active') {
        return { ok: false, reason: 'A tactical/traditional combat board is active in this chat. Finish or reset it before starting Lewd Combat.' };
    }
    return { ok: true };
}

/**
 * Create a fresh deterministic board from context. Persists nothing.
 *
 * @param {Record<string, any>} settings
 * @param {object} [ctx]
 * @param {object} [options]
 * @returns {{ state: object, context: object, warnings: string[], opening?: object }}
 */
export function createLewdEncounterFromContext(settings = {}, ctx = {}, options = {}) {
    const controlMode = resolveLewdControlMode(options.controlMode ?? settings.lewdCombatControlMode);
    const playerNames = Array.isArray(options.playerNames) ? options.playerNames : [];
    const context = collectLewdContext(settings, ctx, { ...options, controlMode, playerNames });
    const seeds = buildLewdParticipantSeeds(context, {
        participantNames: options.participantNames,
        spectatorNames: options.spectatorNames,
        mode: options.mode,
        settings,
        controlMode,
        playerNames,
    });
    const seed = options.seed != null && options.seed !== ''
        ? String(options.seed)
        : `${context.chatId || 'lewd'}:${Date.now()}`;
    const state = createLewdEncounterState({
        participants: seeds,
        seed,
        settings,
        mode: resolveLewdStartMode(options.mode),
        controlMode,
        id: options.id != null ? String(options.id) : `lewd-${seed}`,
        techniques: options.techniques,
    });
    state.title = text(options.title) || LEWD_COMBAT_LABEL;
    state.location = text(options.location) || context.location || '';
    state.reason = text(options.reason);
    state.tone = text(options.tone) || text(settings.lewdCombatExplicitness) || 'explicit';

    const warnings = [...context.warnings];
    let opening = null;
    if (options.openingTechnique) {
        opening = applyLewdOpeningExchange(state, {
            openingTechnique: options.openingTechnique,
            openingZone: options.openingZone,
            actorId: options.actorId,
        });
        if (!opening.ok) {
            warnings.push(`Opening exchange skipped: ${opening.reason || 'no legal action'}.`);
        }
    }

    return { state, context, warnings, ...(opening ? { opening } : {}) };
}

function openingActor(state) {
    const participants = state?.participants || [];
    const eligible = participant => !participant.spectator
        && !participant.atMercy
        && !participant.surrendered;
    // Only a player-controlled participant may open the narrator-declared
    // exchange. A legacy board without a control field is resolved through
    // `ai`/side inside `lewdParticipantControl`.
    return participants.find(participant =>
        eligible(participant) && lewdParticipantControl(participant) === 'player') || null;
}

/**
 * Resolve the optional narrator opening action through the local engine.
 * Never throws on an illegal/unknown opening.
 *
 * @param {object} state
 * @param {{ openingTechnique?: string, openingZone?: string, actorId?: string }} [options]
 * @returns {{ ok: boolean, beat?: object|null, reason?: string }}
 */
export function applyLewdOpeningExchange(state, options = {}) {
    const techniqueName = text(options.openingTechnique);
    if (!techniqueName) return { ok: true, beat: null };
    if (!state || state.status !== 'active') return { ok: false, reason: 'Encounter is not active.' };

    try {
        const actor = (options.actorId
            ? state.participants.find(participant => participant.id === options.actorId)
            : null) || openingActor(state);
        if (!actor) return { ok: false, reason: 'No player participant can open the exchange.' };

        const legal = listLegalActions(state, actor);
        const key = normalizeLewdName(techniqueName);
        const entry = legal.find(candidate =>
            normalizeLewdName(candidate.id) === key || normalizeLewdName(candidate.name) === key);
        if (!entry) return { ok: false, reason: `Unknown opening technique "${techniqueName}".` };
        if (entry.disabled) {
            return { ok: false, reason: entry.reasons?.[0] || 'Opening technique is not legal right now.' };
        }

        const mode = entry.technique?.targetMode || 'single';
        const target = mode === 'self' ? null : (entry.targets || []).find(candidate => !candidate.disabled);
        if (mode !== 'self' && !target) {
            return { ok: false, reason: 'No legal opening target.' };
        }

        const zone = text(options.openingZone) || entry.zones?.[0] || undefined;
        const action = {
            type: 'technique',
            unitId: actor.id,
            techniqueId: entry.id,
            targetIds: mode === 'self' || !target ? [] : [target.id],
            ...(zone ? { zone } : {}),
        };
        return applyLewdAction(state, action);
    } catch (error) {
        return { ok: false, reason: error?.message || 'Opening exchange could not be resolved.' };
    }
}
