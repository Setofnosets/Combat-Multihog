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
    listLegalActions,
} from './lewd-combat-engine.js';
import {
    inferProfile,
    normalizeLewdName,
    parseLewdProfiles,
} from './lewd-combat-profile.js';
import { getLewdEncounterForChat } from './lewd-combat-store.js';
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
 *   profiles: Record<string, object>,
 *   units: object[],
 *   candidates: object[],
 *   warnings: string[],
 * }}
 */
export function collectLewdContext(settings = {}, ctx = {}, options = {}) {
    const warnings = [];
    const memo = String(settings?.currentMemo || '');
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

    return {
        chatId,
        memo: sourceMemo,
        location,
        sceneExcerpt,
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

function seedForName(name, context, settings, spectator) {
    const clean = text(name);
    if (!clean) return null;
    const candidate = findCandidate(context, clean);
    if (candidate) {
        const unit = candidate.unit || null;
        return {
            name: candidate.name || clean,
            side: candidate.side || unit?.side || 'player',
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
        spectator: !!spectator,
        stats: {},
        proficiency: 0,
        profile: inferProfile({ name: clean }, settings),
    };
}

/**
 * Build engine participant seeds from a collected context.
 *
 * Unknown names are allowed: they become inferred, unit-less players. The
 * function throws when fewer than two non-spectator participants are selected —
 * that is a programming/selection error the caller must surface, not a board.
 *
 * @param {object} context
 * @param {{ participantNames?: string[], spectatorNames?: string[], mode?: string, settings?: object }} [options]
 * @returns {object[]}
 */
export function buildLewdParticipantSeeds(context, options = {}) {
    const settings = options.settings || {};
    const participants = [];
    const spectators = [];
    const seen = new Set();

    for (const name of options.participantNames || []) {
        const seed = seedForName(name, context, settings, false);
        if (!seed) continue;
        const key = normalizeLewdName(seed.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        participants.push(seed);
    }
    for (const name of options.spectatorNames || []) {
        const seed = seedForName(name, context, settings, true);
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
    const context = collectLewdContext(settings, ctx, options);
    const seeds = buildLewdParticipantSeeds(context, {
        participantNames: options.participantNames,
        spectatorNames: options.spectatorNames,
        mode: options.mode,
        settings,
    });
    const seed = options.seed != null && options.seed !== ''
        ? String(options.seed)
        : `${context.chatId || 'lewd'}:${Date.now()}`;
    const state = createLewdEncounterState({
        participants: seeds,
        seed,
        settings,
        mode: resolveLewdStartMode(options.mode),
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
    return (state?.participants || []).find(participant =>
        !participant.spectator
        && !participant.ai
        && participant.side !== 'enemy'
        && participant.side !== 'opponent'
        && !participant.atMercy
        && !participant.surrendered) || null;
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
