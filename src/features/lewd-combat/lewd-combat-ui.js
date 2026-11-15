/**
 * lewd-combat-ui.js — DOM controller for the Lewd Combat board.
 *
 * Mirrors the tactical board's overlay lifecycle, but the board has no grid:
 * the controller only owns selection, persistence, and the local AI turns.
 * Everything numeric is resolved by the engine. There is deliberately no
 * narrator call, outcome queue, or prose model here — those belong to U7/U8.
 *
 * No DOM access happens at import time; `installLewdCombatUi` is the only
 * entry point that touches `document`.
 */

import { getActiveChatId, getSettings } from '../../../state-manager.js';
import { LEWD_CHANGED_EVENT, LEWD_OPEN_EVENT } from './lewd-combat-constants.js';
import {
    appendLewdProseEntry,
    applyLewdAction,
    hydrateLewdState,
    lewdBeatId,
    listLegalActions,
    markLewdBeatsNarrated,
    resolveLewdOpponentTurn,
    serializeLewdState,
    setSpectator,
    stopLewdEncounter,
} from './lewd-combat-engine.js';
import {
    buildLewdCombatMarkup,
    describeLewdBeat,
} from './lewd-combat-markup.js';
import {
    canStartLewdEncounter,
    collectLewdContext,
    createLewdEncounterFromContext,
    resolveLewdStartMode,
} from './lewd-combat-context.js';
import {
    getLewdEncounterForChat,
    removeLewdEncounterForChat,
    setLewdEncounterForChat,
} from './lewd-combat-store.js';
import { clearPendingNarration, getPendingNarration } from '../tactical-combat/tactical-combat-store.js';
import { saveSettings } from '../../app/runtime-bridge.js';

const OVERLAY_ID = 'rt-lewd-combat-overlay';
const HOST_ID = 'rt-lewd-combat-host';
const MAX_AI_ITERATIONS = 12;

/**
 * Non-authoritative prose is queued per round and, while a narrator generation
 * is running, held as pending beats until GENERATION_ENDED. It is never part of
 * the board state math.
 */
const proseQueue = {
    round: 0,
    pending: [],
    flushing: false,
    // Bumped on reset/close/chat change. A result tagged with an older token is
    // from a board that no longer exists and is discarded.
    token: 0,
};

const ui = {
    installed: false,
    overlay: null,
    overlayOpen: false,
    starting: false,
    lastProseEntryId: '',
    view: {
        startOpen: false,
        startCandidates: null,
        startSelected: [],
        spectatorSelected: [],
        startMode: 'duel',
        tone: '',
        darkerThemes: false,
        actorId: '',
        techniqueId: '',
        posture: 'switch',
        zone: '',
        targetIds: [],
        busy: false,
        error: '',
        showDebug: false,
        outcomeDismissed: false,
        prose: '',
    },
};

function text(value) {
    return String(value ?? '').trim();
}

function arr(value) {
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return [...value];
    if (value == null || value === '') return [];
    return [value];
}

function toast(kind, message) {
    if (!message) return;
    try {
        const fn = globalThis?.toastr?.[kind];
        if (typeof fn === 'function') {
            fn(String(message), 'Lewd Combat');
            return;
        }
    } catch (_) { /* toastr unavailable */ }
    const log = kind === 'error' ? console.warn : console.log;
    log('[RPG Tracker][Lewd Combat]', message);
}

function notifyChanged() {
    try {
        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent(LEWD_CHANGED_EVENT));
        }
    } catch (_) { /* no-op */ }
}

function safeContext() {
    try {
        return typeof SillyTavern !== 'undefined' && typeof SillyTavern?.getContext === 'function'
            ? SillyTavern.getContext()
            : {};
    } catch (_) {
        return {};
    }
}

function readState() {
    try {
        const raw = getLewdEncounterForChat(getActiveChatId(), getSettings());
        return raw ? hydrateLewdState(raw) : null;
    } catch (error) {
        ui.view.error = error?.message || 'Could not read the Lewd Combat board.';
        return null;
    }
}

function persist(state) {
    if (!state) return;
    const chatId = getActiveChatId();
    const settings = getSettings();
    if (!chatId || !settings) return;
    setLewdEncounterForChat(chatId, serializeLewdState(state), settings);
    notifyChanged();
}

function isOut(participant) {
    return !!participant?.atMercy || !!participant?.surrendered;
}

function activePlayers(state) {
    return (state?.participants || []).filter(participant =>
        !participant.ai && !participant.spectator && !isOut(participant));
}

function currentActor(state) {
    const participants = state?.participants || [];
    const chosen = participants.find(participant => participant.id === text(ui.view.actorId));
    // Prefer an actor that still owes this round a turn. An explicit selection
    // is honoured only while it can actually act, so the board never dead-ends
    // on the participant who just resolved an exchange.
    if (chosen && !chosen.spectator && !isOut(chosen) && !chosen.acted) return chosen;
    const eligible = activePlayers(state);
    return eligible.find(participant => !participant.acted)
        || (chosen && !chosen.spectator && !isOut(chosen) ? chosen : null)
        || eligible[0]
        || null;
}

function selectedEntry(state, actor) {
    if (!state || !actor) return null;
    const id = text(ui.view.techniqueId);
    if (!id) return null;
    try {
        return listLegalActions(state, actor)
            .find(entry => entry.id === id || entry.name === id) || null;
    } catch (_) {
        return null;
    }
}

function setError(message) {
    ui.view.error = text(message);
    if (message) toast('warning', message);
}

/**
 * Run every AI participant that still owes a turn. The dedicated agent is used
 * when configured and the host is idle; any failure falls back to the local
 * deterministic policy. Guards at 12 iterations and persists once at the end.
 * @returns {Promise<object|null>}
 */
async function runAiTurns() {
    let state = readState();
    if (!state || state.status !== 'active') return state;
    const settings = getSettings() || {};
    let agent = null;
    let prose = null;
    try { agent = await import('./lewd-combat-agent.js'); } catch (_) { agent = null; }
    try { prose = await import('./lewd-combat-prose.js'); } catch (_) { prose = null; }
    const busyNow = () => (typeof prose?.isNarratorBusy === 'function' ? prose.isNarratorBusy() : false);
    let changed = false;
    let iterations = 0;
    try {
        while (state.status === 'active' && iterations < MAX_AI_ITERATIONS) {
            const actor = (state.participants || []).find(participant =>
                participant.ai && !participant.acted && !participant.spectator && !isOut(participant));
            if (!actor) break;
            const techniqueCount = arr(state.techniques).length;
            let result = null;
            if (agent && typeof agent.lewAgentConfigured === 'function'
                && agent.lewAgentConfigured(settings) && !busyNow()) {
                try {
                    const proposal = await agent.requestLewdOpponentAction(state, actor, settings);
                    if (proposal?.ok && proposal.actions?.length) {
                        result = resolveLewdOpponentTurn(state, proposal.actions);
                    }
                } catch (_) {
                    result = null;
                }
            }
            if (!result || !result.ok) {
                try {
                    result = resolveLewdOpponentTurn(state);
                } catch (_) {
                    result = null;
                }
            }
            iterations += 1;
            if (!result?.ok) break;
            changed = true;
            // A compiled novel technique must survive even when no action
            // resolved, otherwise the next turn would re-compile it.
            if (arr(state.techniques).length !== techniqueCount) changed = true;
        }
    } catch (_) {
        // A broken agent/connection must never break the board; whatever the
        // local policy already resolved stays persisted.
    }
    if (changed) persist(state);
    return state;
}

function resetProseQueue() {
    proseQueue.round = 0;
    proseQueue.pending = [];
    proseQueue.flushing = false;
    proseQueue.token += 1;
    ui.view.prose = '';
    ui.lastProseEntryId = '';
}

/** Drop `wait` beats so a trailing wait never suppresses a whole batch. */
function proseItems(list) {
    return arr(list).filter(item =>
        item?.beat && typeof item.beat === 'object' && text(item.beat.type) !== 'wait');
}

function proseItemId(state, item) {
    return lewdBeatId(state, item?.beat, item?.index);
}

function mergeProseItems(state, items) {
    const narrated = new Set(arr(state?.narratedBeatIds).map(String));
    const seen = new Set(proseQueue.pending.map(item => proseItemId(state, item)));
    const merged = [...proseQueue.pending];
    for (const item of proseItems(items)) {
        const id = proseItemId(state, item);
        if (seen.has(id) || narrated.has(id)) continue;
        seen.add(id);
        merged.push(item);
    }
    return merged;
}

/**
 * Drop items another flush (or a previous exchange) already narrated. The
 * cursor is identity-based, so a trimmed log cannot cause a re-narration.
 */
function freshProseItems(state, items) {
    const narrated = new Set(arr(state?.narratedBeatIds).map(String));
    return proseItems(items).filter(item => !narrated.has(proseItemId(state, item)));
}

/**
 * Ask the Main connection for prose covering every supplied beat. Does not
 * mutate or persist state; the caller commits after checking the render token.
 */
async function requestProse(state, items) {
    const beats = arr(items).map(item => item?.beat).filter(Boolean);
    if (!state || !beats.length) return { ok: false, skipped: true };
    let prose = null;
    try { prose = await import('./lewd-combat-prose.js'); } catch (_) { prose = null; }
    if (!prose || typeof prose.generateLewdProse !== 'function') {
        return { ok: false, error: 'The prose connection is unavailable.' };
    }
    const settings = getSettings() || {};
    const frequency = text(settings.lewdCombatProseFrequency) || 'per-exchange';
    try {
        return await prose.generateLewdProse(state, beats, settings, {
            roundEnded: frequency === 'per-round',
        });
    } catch (error) {
        return { ok: false, error: error?.message || String(error) };
    }
}

function commitProse(state, items, proseText, source = 'model') {
    const list = proseItems(items);
    if (!list.length) return null;
    const beatIds = list.map(({ beat, index }) => lewdBeatId(state, beat, index));
    const actorIds = [...new Set(list
        .map(({ beat }) => text(beat?.actor?.id))
        .filter(Boolean))];
    const maxIndex = Math.max(...list.map(item => Number(item.index) || 0));
    const round = Number(state.round) || 1;
    const entry = appendLewdProseEntry(state, {
        stateId: state.id,
        chatId: state.chatId,
        round,
        exchangeId: `${text(state.id) || 'lewd'}:${round}:${beatIds[0] || ''}`,
        actorIds,
        beatIds,
        text: proseText,
        source,
    });
    markLewdBeatsNarrated(state, maxIndex, beatIds);
    return entry;
}

function commitFallbackProse(state, items, proseModule) {
    const list = proseItems(items);
    if (!list.length) return 0;
    const entries = typeof proseModule?.buildLewdFallbackProseEntries === 'function'
        ? proseModule.buildLewdFallbackProseEntries(state, list)
        : list.map(({ beat, index }) => ({
            beatIds: [lewdBeatId(state, beat, index)],
            text: describeLewdBeat(beat, state),
            source: 'fallback',
        }));
    const beatIds = [];
    for (const entry of entries) {
        appendLewdProseEntry(state, {
            ...entry,
            stateId: state.id,
            chatId: state.chatId,
            round: entry.round || Number(state.round) || 1,
        });
        beatIds.push(...arr(entry.beatIds));
    }
    const maxIndex = Math.max(...list.map(item => Number(item.index) || 0));
    markLewdBeatsNarrated(state, maxIndex, beatIds);
    return entries.length;
}

async function flushPendingProse() {
    if (proseQueue.flushing || !proseQueue.pending.length) return;
    const token = proseQueue.token;
    const state = readState();
    if (!state) return;
    const items = freshProseItems(state, proseQueue.pending);
    proseQueue.pending = [];
    if (!items.length) return;
    proseQueue.flushing = true;
    let result = null;
    let proseModule = null;
    try { proseModule = await import('./lewd-combat-prose.js'); } catch (_) { proseModule = null; }
    try {
        result = await requestProse(state, items);
    } catch (error) {
        result = { ok: false, error: error?.message || String(error) };
    } finally {
        proseQueue.flushing = false;
    }

    // A late result for a reset/closed board or another chat is discarded.
    if (token !== proseQueue.token) return;

    if (result?.deferred) {
        proseQueue.pending = [...items, ...proseQueue.pending];
        return;
    }
    if (result?.skipped) return;

    const current = readState();
    if (!current || String(current.id) !== String(state.id)) return;
    // Another flush may have committed some of these while the model was
    // working; never narrate a beat twice.
    const remaining = freshProseItems(current, items);
    if (!remaining.length) return;

    if (result?.ok && result.prose) {
        commitProse(current, remaining, result.prose, 'model');
        persist(current);
    } else {
        const settings = getSettings() || {};
        if (settings.debugMode && result?.error) toast('warning', result.error);
        commitFallbackProse(current, remaining, proseModule);
        persist(current);
    }
    if (ui.overlayOpen) render();
}

/**
 * Non-authoritative prose for the exchange that just resolved. It covers every
 * beat since the last narrated index, so the player's action and the AI reply
 * are both visible. Frequency gates live here; `generateLewdProse` re-checks
 * them. Never throws and never changes mechanics.
 * @param {object|null} state
 * @param {number} [previousRound]
 */
async function narrateAfterExchange(state, previousRound) {
    try {
        const settings = getSettings() || {};
        const frequency = text(settings.lewdCombatProseFrequency) || 'per-exchange';
        if (frequency === 'off') return;
        if (!state || !arr(state.log).length) return;

        let prose = null;
        try { prose = await import('./lewd-combat-prose.js'); } catch (_) { prose = null; }
        if (typeof prose?.selectUnnarratedBeats !== 'function') return;
        const items = prose.selectUnnarratedBeats(state);
        if (!items.length) return;

        if (frequency === 'per-round') {
            const ended = state.status !== 'active';
            const roundChanged = Number(previousRound) !== Number(state.round)
                || (proseQueue.round && proseQueue.round !== Number(state.round));
            if (!ended && !roundChanged) {
                proseQueue.round = Number(state.round) || 1;
                return;
            }
            proseQueue.round = Number(state.round) || 1;
        }

        proseQueue.pending = mergeProseItems(state, items);
        await flushPendingProse();
    } catch (_) {
        // Prose is optional; the templated sentence remains visible.
    }
}

/**
 * Queue the authoritative result once a board has ended, then optionally hand
 * the turn back to the narrator when the host is idle. Best-effort: a failed
 * import or a busy host must never break the board.
 *
 * The persisted board, not the caller's snapshot, is authoritative: a retry
 * after a reload must not queue a second payload or write a second resolution.
 *
 * @param {object|null} inputState
 * @param {{ autoNarrate?: boolean, now?: number }} [options]
 * @returns {Promise<{ ok: boolean, payload?: object, reason?: string }>}
 */
export async function finishEncounterIfEnded(inputState, options = {}) {
    let settings = {};
    let state = inputState;
    try {
        settings = getSettings() || {};
        const chatId = getActiveChatId();
        const stored = chatId ? getLewdEncounterForChat(chatId, settings) : null;
        if (stored) state = stored;
    } catch (_) { /* settings/runtime bridge not ready */ }
    if (!state || state.status !== 'ended') return { ok: false, reason: 'not-ended' };
    try {
        let outcome = null;
        try { outcome = await import('./lewd-combat-outcome.js'); } catch (_) { outcome = null; }
        if (!outcome || typeof outcome.queueLewdOutcome !== 'function'
            || typeof outcome.ensureLewdResolution !== 'function') {
            return { ok: false, reason: 'outcome module unavailable' };
        }

        if (!state.resolution) {
            state.resolution = outcome.ensureLewdResolution(state, { now: options.now });
            persist(state);
        }
        if (state.finalization?.narrationQueued) {
            return { ok: true, payload: state.finalization.payload || null };
        }

        const payload = outcome.queueLewdOutcome(state, settings, { persist: false });
        if (!payload) return { ok: false, reason: 'outcome payload unavailable' };
        persist(state);

        if (options.autoNarrate === false) return { ok: true, payload };
        if (state.finalization?.autoNarrateStarted) return { ok: true, payload };

        let prose = null;
        try { prose = await import('./lewd-combat-prose.js'); } catch (_) { prose = null; }
        const busy = typeof prose?.isNarratorBusy === 'function' ? prose.isNarratorBusy() : false;
        if (busy) return { ok: true, payload };
        state.finalization = {
            ...(state.finalization || {}),
            autoNarrateStarted: Date.now(),
        };
        persist(state);
        try {
            const { continueToNarration } = await import('../tactical-combat/tactical-combat-outcome.js');
            void continueToNarration(settings);
        } catch (_) { /* narration is optional */ }
        return { ok: true, payload };
    } catch (error) {
        // The result is optional; the board's own summary stays visible.
        if (getSettings()?.debugMode) console.warn('[RPG Tracker][Lewd Combat] Could not queue the outcome:', error);
        return { ok: false, reason: error?.message || String(error) };
    }
}

/**
 * Narrator entry point: start a lewd board from a StartLewdCombat tool call.
 * Opens the board for the player; it never auto-runs AI turns.
 * @param {object} [args]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function startLewdCombatFromNarrator(args = {}) {
    try {
        const settings = getSettings() || {};
        const chatId = getActiveChatId();
        const gate = canStartLewdEncounter(settings, chatId);
        if (!gate.ok) return { ok: false, message: gate.reason };

        const result = createLewdEncounterFromContext(settings, safeContext(), {
            participantNames: arr(args.participantNames),
            spectatorNames: arr(args.spectatorNames),
            title: args.title,
            location: args.location,
            reason: args.reason,
            openingTechnique: args.openingTechnique,
            openingZone: args.openingZone,
            tone: args.tone || settings.lewdCombatExplicitness,
            mode: args.mode,
        });

        resetProseQueue();
        persist(result.state);
        ui.view.startOpen = false;
        ui.view.startCandidates = null;
        ui.view.startSelected = [];
        ui.view.spectatorSelected = [];
        ui.view.actorId = '';
        ui.view.techniqueId = '';
        ui.view.posture = 'switch';
        ui.view.zone = '';
        ui.view.targetIds = [];
        ui.view.error = '';
        openLewdCombatBoard();
        notifyChanged();
        const names = (result.state.participants || [])
            .filter(participant => !participant.spectator)
            .map(participant => participant.name)
            .join(', ');
        return {
            ok: true,
            message: `Lewd Combat: the board is open for ${names}. Resolve the scene on the board; the result returns to the narrator when it ends.`,
        };
    } catch (error) {
        return { ok: false, message: `Lewd Combat could not start: ${error?.message || error}` };
    }
}

function loadStartCandidates() {
    try {
        const settings = getSettings() || {};
        const context = collectLewdContext(settings, safeContext(), {});
        ui.view.startCandidates = context.candidates || [];
        ui.view.tone = text(settings.lewdCombatExplicitness) || 'explicit';
        ui.view.darkerThemes = !!settings.lewdCombatDarkerThemes;
        if (context.warnings?.length && settings.debugMode) {
            console.warn('[RPG Tracker][Lewd Combat] Context warnings:', context.warnings);
        }
    } catch (error) {
        ui.view.startCandidates = [];
        setError(error?.message || 'Could not read the memo for candidates.');
    }
}

function ensureOverlay() {
    if (typeof document === 'undefined') return null;
    if (ui.overlay && document.body.contains(ui.overlay)) return ui.overlay;
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'rt-tc-overlay rt-lc-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Lewd Combat');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `<div class="rt-tc-host rt-lc-host" id="${HOST_ID}"></div>`;
    overlay.addEventListener('click', onOverlayClick);
    overlay.addEventListener('change', onOverlayChange);
    document.body.appendChild(overlay);
    ui.overlay = overlay;
    return overlay;
}

function render() {
    if (!ui.overlay || !ui.overlayOpen) return;
    const host = ui.overlay.querySelector(`#${HOST_ID}`);
    if (!host) return;
    const state = readState();
    if (!state && !ui.view.startCandidates) loadStartCandidates();
    const safeView = {
        ...ui.view,
        busy: !!ui.view.busy || ui.starting,
    };
    host.innerHTML = buildLewdCombatMarkup(state, safeView);
    const scroll = host.querySelector('[data-lc-prose-scroll]');
    const proseLog = arr(state?.proseLog);
    const lastId = text(proseLog[proseLog.length - 1]?.id);
    if (scroll && lastId && lastId !== ui.lastProseEntryId) {
        scroll.scrollTop = scroll.scrollHeight;
        ui.lastProseEntryId = lastId;
    }
}

function openBoard() {
    const overlay = ensureOverlay();
    if (!overlay) return;
    ui.overlayOpen = true;
    ui.view.error = '';
    ui.view.startOpen = true;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    try { document.body.classList.add('rt-lc-modal-open'); } catch (_) { /* no-op */ }
    if (!readState() && !ui.view.startCandidates) loadStartCandidates();
    render();
    try {
        setTimeout(() => overlay.querySelector('[data-lc-action="close"]')?.focus?.(), 40);
    } catch (_) { /* no-op */ }
}

function closeBoard() {
    if (!ui.overlay) return;
    // Any in-flight prose result belongs to a board the player has closed.
    proseQueue.token += 1;
    proseQueue.pending = [];
    ui.overlayOpen = false;
    ui.overlay.classList.remove('is-open');
    ui.overlay.setAttribute('aria-hidden', 'true');
    try { document.body.classList.remove('rt-lc-modal-open'); } catch (_) { /* no-op */ }
}

function openSettingsTab() {
    try {
        document.dispatchEvent(new CustomEvent('rt_open_settings_overlay', { detail: { tab: 'combat' } }));
    } catch (_) { /* no-op */ }
}

function checkedValues(root, attribute) {
    if (!root?.querySelectorAll) return [];
    return [...root.querySelectorAll(`input[${attribute}]`)]
        .filter(input => input?.checked && !input.disabled)
        .map(input => input.value);
}

async function startFromOverlay() {
    const settings = getSettings() || {};
    const chatId = getActiveChatId();
    const gate = canStartLewdEncounter(settings, chatId);
    if (!gate.ok) {
        setError(gate.reason);
        render();
        return;
    }
    const participantNames = checkedValues(ui.overlay, 'data-lc-start-participant');
    const spectatorNames = checkedValues(ui.overlay, 'data-lc-start-spectator');
    const mode = ui.overlay?.querySelector('[data-lc-start-mode]')?.value || ui.view.startMode;
    ui.starting = true;
    resetProseQueue();
    try {
        const result = createLewdEncounterFromContext(settings, safeContext(), {
            participantNames,
            spectatorNames,
            mode,
            tone: settings.lewdCombatExplicitness,
        });
        ui.view.startOpen = false;
        ui.view.startCandidates = null;
        ui.view.startSelected = [];
        ui.view.spectatorSelected = [];
        ui.view.actorId = '';
        ui.view.techniqueId = '';
        ui.view.posture = 'switch';
        ui.view.zone = '';
        ui.view.targetIds = [];
        ui.view.error = '';
        persist(result.state);
        const previousRound = result.state.round;
        const next = await runAiTurns();
        await narrateAfterExchange(next || result.state, previousRound);
        await finishEncounterIfEnded(next || result.state);
        if (result.warnings?.length) toast('info', result.warnings[0]);
    } catch (error) {
        setError(error?.message || 'Could not start the Lewd Combat encounter.');
    } finally {
        ui.starting = false;
        render();
    }
}

async function resolveAction() {
    if (ui.view.busy || ui.starting) return;
    const state = readState();
    if (!state || state.status !== 'active') {
        setError('There is no active encounter to resolve.');
        render();
        return;
    }
    const previousRound = state.round;
    const actor = currentActor(state);
    if (!actor) {
        setError('No player participant can act right now.');
        render();
        return;
    }
    const entry = selectedEntry(state, actor);
    if (!entry) {
        setError('Choose a technique first.');
        render();
        return;
    }
    const targetIds = entry.technique?.targetMode === 'self' ? [] : [...arr(ui.view.targetIds)];
    if (entry.technique?.targetMode !== 'self' && !targetIds.length) {
        setError('Choose at least one target.');
        render();
        return;
    }
    const allowedPostures = arr(entry.postures);
    const posture = allowedPostures.includes(ui.view.posture)
        ? ui.view.posture
        : (entry.posture || 'switch');
    ui.view.posture = posture;
    ui.view.busy = true;
    try {
        const action = {
            type: 'technique',
            unitId: actor.id,
            techniqueId: entry.id,
            targetIds,
            posture,
            ...(ui.view.zone ? { zone: ui.view.zone } : {}),
        };
        const result = applyLewdAction(state, action);
        if (!result.ok) {
            setError(result.reason || 'The action could not be resolved.');
        } else {
            ui.view.error = '';
            ui.view.actorId = '';
            ui.view.techniqueId = '';
            ui.view.targetIds = [];
            ui.view.zone = '';
            persist(state);
            const next = await runAiTurns();
            await narrateAfterExchange(next || state, previousRound);
            await finishEncounterIfEnded(next || state);
        }
    } catch (error) {
        setError(error?.message || 'The action could not be resolved.');
    } finally {
        ui.view.busy = false;
        render();
    }
}

async function simpleAction(type) {
    if (ui.view.busy || ui.starting) return;
    const state = readState();
    if (!state || state.status !== 'active') {
        setError('There is no active encounter.');
        render();
        return;
    }
    const previousRound = state.round;
    const actor = currentActor(state)
        || state.participants.find(participant => !participant.spectator)
        || state.participants[0];
    if (!actor) {
        setError('No participant can act.');
        render();
        return;
    }
    ui.view.busy = true;
    try {
        const result = applyLewdAction(state, { type, unitId: actor.id });
        if (!result.ok) {
            setError(result.reason || 'The action was rejected.');
        } else {
            ui.view.error = '';
            ui.view.actorId = '';
            ui.view.techniqueId = '';
            ui.view.targetIds = [];
            ui.view.zone = '';
            persist(state);
            let next = state;
            if (type !== 'stop') {
                next = (await runAiTurns()) || state;
                await narrateAfterExchange(next, previousRound);
            }
            await finishEncounterIfEnded(next);
        }
    } catch (error) {
        setError(error?.message || 'The action could not be resolved.');
    } finally {
        ui.view.busy = false;
        render();
    }
}

function stopEncounter() {
    const state = readState();
    if (!state) return;
    ui.view.busy = true;
    try {
        const actor = state.participants?.find(participant =>
            !participant.spectator && !isOut(participant)) || state.participants?.[0];
        let result = null;
        if (actor) result = applyLewdAction(state, { type: 'stop', unitId: actor.id });
        if (!result?.ok) {
            // The engine also exposes the direct safe word; use it when no
            // participant can be resolved as the caller.
            result = stopLewdEncounter(state);
        }
        if (result) {
            ui.view.error = '';
            persist(state);
            void finishEncounterIfEnded(state);
        }
    } catch (error) {
        setError(error?.message || 'The safe word could not be applied.');
    } finally {
        ui.view.busy = false;
        render();
    }
}

function moveParticipant(unitId, spectator) {
    const state = readState();
    if (!state || state.status !== 'active') {
        setError('There is no active encounter.');
        render();
        return;
    }
    const id = text(unitId);
    if (!id) return;
    ui.view.busy = true;
    try {
        const result = setSpectator(state, id, spectator);
        if (!result.ok) {
            setError(result.reason || 'That participant cannot change seats.');
        } else {
            ui.view.error = '';
            persist(state);
        }
    } catch (error) {
        setError(error?.message || 'Could not move that participant.');
    } finally {
        ui.view.busy = false;
        render();
    }
}

function selectActor(element) {
    const id = element?.getAttribute?.('data-lc-unit-id') || '';
    if (!id) return;
    if (ui.view.actorId !== id) {
        ui.view.techniqueId = '';
        ui.view.zone = '';
        ui.view.targetIds = [];
    }
    ui.view.actorId = id;
    ui.view.error = '';
    render();
}

function selectTechnique(element) {
    const id = element?.getAttribute?.('data-lc-technique') || '';
    if (!id) return;
    const state = readState();
    const actor = currentActor(state);
    const entry = state && actor
        ? (() => {
            try {
                return listLegalActions(state, actor).find(candidate => candidate.id === id) || null;
            } catch (_) {
                return null;
            }
        })()
        : null;
    ui.view.techniqueId = ui.view.techniqueId === id ? '' : id;
    ui.view.targetIds = [];
    ui.view.zone = ui.view.techniqueId && entry?.zones?.length ? entry.zones[0] : '';
    if (ui.view.techniqueId && entry?.posture) ui.view.posture = entry.posture;
    ui.view.error = '';
    render();
}

function selectPosture(element) {
    const posture = text(element?.getAttribute?.('data-lc-posture'));
    if (!['lead', 'follow', 'switch'].includes(posture)) return;
    ui.view.posture = posture;
    ui.view.error = '';
    render();
}

function handleAction(action, element) {
    switch (action) {
        case 'start':
            startFromOverlay();
            break;
        case 'resolve':
            resolveAction();
            break;
        case 'wait':
            simpleAction('wait');
            break;
        case 'surrender':
            simpleAction('surrender');
            break;
        case 'stop':
            stopEncounter();
            break;
        case 'new-encounter':
        case 'reset':
            resetLewdCombatEncounter();
            break;
        case 'close':
            closeBoard();
            break;
        case 'settings':
            openSettingsTab();
            break;
        case 'join':
            moveParticipant(element.getAttribute('data-lc-unit-id'), false);
            break;
        case 'leave':
            moveParticipant(element.getAttribute('data-lc-unit-id'), true);
            break;
        case 'select-actor':
            selectActor(element);
            break;
        case 'toggle-debug':
            ui.view.showDebug = !ui.view.showDebug;
            render();
            break;
        default:
            break;
    }
}

function onOverlayClick(event) {
    try {
        const target = event?.target;
        if (!target?.closest) return;
        const actionElement = target.closest('[data-lc-action]');
        if (actionElement) {
            if (actionElement.disabled) return;
            handleAction(actionElement.getAttribute('data-lc-action'), actionElement);
            return;
        }
        const techniqueElement = target.closest('[data-lc-technique]');
        if (techniqueElement) {
            if (techniqueElement.disabled) return;
            selectTechnique(techniqueElement);
            return;
        }
        const postureElement = target.closest('[data-lc-posture]');
        if (postureElement) {
            selectPosture(postureElement);
        }
    } catch (error) {
        setError(error?.message || 'The Lewd Combat board could not handle that click.');
        render();
    }
}

function onOverlayChange(event) {
    try {
        const target = event?.target;
        if (!target?.matches) return;
        if (target.matches('[data-lc-zone]')) {
            ui.view.zone = text(target.value);
            render();
            return;
        }
        if (target.matches('[data-lc-target]')) {
            if (!ui.overlay) return;
            ui.view.targetIds = [...ui.overlay.querySelectorAll('[data-lc-target]')]
                .filter(input => input.checked && !input.disabled)
                .map(input => input.value);
            return;
        }
        if (target.matches('[data-lc-start-mode]')) {
            ui.view.startMode = resolveLewdStartMode(target.value);
            return;
        }
        if (target.matches('[data-lc-start-participant], [data-lc-start-spectator]')) {
            // Keep the draft in sync so a validation re-render (fewer than two
            // participants, gate failure) does not silently clear the boxes.
            ui.view.startSelected = checkedValues(ui.overlay, 'data-lc-start-participant');
            ui.view.spectatorSelected = checkedValues(ui.overlay, 'data-lc-start-spectator');
        }
    } catch (error) {
        setError(error?.message || 'The Lewd Combat board could not handle that change.');
        render();
    }
}

function onKeydown(event) {
    if (event?.key !== 'Escape' || !ui.overlayOpen) return;
    event.preventDefault();
    closeBoard();
}

function onOpenRequest(event) {
    try { event.preventDefault(); } catch (_) { /* no-op */ }
    openLewdCombatBoard();
}

/**
 * Flush held prose once the host finishes a generation. Only installed when
 * SillyTavern's event bridge is actually available.
 */
function installProseFlushListener() {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const eventSource = ctx?.eventSource;
        const eventTypes = ctx?.eventTypes || ctx?.event_types;
        const ended = eventTypes?.GENERATION_ENDED;
        if (!eventSource || typeof eventSource.on !== 'function' || !ended) return;
        eventSource.on(ended, () => { flushPendingProse().catch(() => {}); });
    } catch (_) {
        // No host events: the templated sentence simply stays visible.
    }
}

/**
 * Install the delegated listeners. Idempotent and safe to call before the
 * runtime bridge is ready.
 */
export function installLewdCombatUi() {
    if (ui.installed) return;
    if (typeof document === 'undefined') return;
    ui.installed = true;
    document.addEventListener('keydown', onKeydown);
    document.addEventListener(LEWD_OPEN_EVENT, onOpenRequest);
    installProseFlushListener();
}

/**
 * Board entry point used by the header button, settings drawer, and narrator.
 * @param {{ participantNames?: string[], spectatorNames?: string[], mode?: string }} [options]
 */
export function openLewdCombatBoard(options = {}) {
    if (!ui.overlayOpen && !ui.view.startCandidates && !readState()) loadStartCandidates();
    if (options.participantNames) ui.view.startSelected = [...options.participantNames];
    if (options.spectatorNames) ui.view.spectatorSelected = [...options.spectatorNames];
    if (options.mode) ui.view.startMode = resolveLewdStartMode(options.mode);
    openBoard();
}

/**
 * Open the start dialog, optionally prefilled by the narrator (U8).
 * @param {{ participantNames?: string[], spectatorNames?: string[], mode?: string }} [options]
 */
export function startLewdCombatFlow(options = {}) {
    ui.view.startOpen = true;
    openLewdCombatBoard(options);
}

/** Safe-word entry point used by the settings drawer. */
export function stopLewdCombatEncounter() {
    stopEncounter();
}

/** Drop the saved board and return to the start screen. */
export function resetLewdCombatEncounter() {
    const chatId = getActiveChatId();
    const settings = getSettings();
    if (chatId && settings) {
        // One write for the whole reset: the board (with its resolution and
        // prose log) and the lewd pending narration leave together.
        removeLewdEncounterForChat(chatId, settings, { persist: false });
        // Discard only our own queued result; a tactical/traditional result
        // waiting for narration must survive a lewd-board reset.
        if (getPendingNarration(settings, chatId)?.kind === 'lewd') {
            clearPendingNarration(settings, { chatId });
        } else {
            try { saveSettings(); } catch (_) { /* boot-time bridge may be absent */ }
        }
    }
    resetProseQueue();
    ui.view.actorId = '';
    ui.view.techniqueId = '';
    ui.view.posture = 'switch';
    ui.view.zone = '';
    ui.view.targetIds = [];
    ui.view.showDebug = false;
    ui.view.error = '';
    ui.view.outcomeDismissed = false;
    ui.view.startOpen = true;
    notifyChanged();
    if (!ui.view.startCandidates) loadStartCandidates();
    render();
}

/** Re-render after a relevant setting changes. */
export function refreshLewdCombatUi() {
    if (ui.overlayOpen) {
        if (!readState() && !ui.view.startCandidates) loadStartCandidates();
        render();
    }
}

/**
 * Called from CHAT_CHANGED. Resets selection and redraws the board for the new
 * chat so a different chat's board is never leaked into the overlay.
 * @param {string} [chatId]
 */
export function onLewdCombatChatChanged(chatId = getActiveChatId()) {
    resetProseQueue();
    ui.view.actorId = '';
    ui.view.techniqueId = '';
    ui.view.posture = 'switch';
    ui.view.zone = '';
    ui.view.targetIds = [];
    ui.view.showDebug = false;
    ui.view.error = '';
    ui.view.startCandidates = null;
    ui.view.startSelected = [];
    ui.view.spectatorSelected = [];
    ui.view.outcomeDismissed = false;
    if (!ui.overlayOpen) return;
    if (!chatId) {
        closeBoard();
        return;
    }
    if (!readState()) loadStartCandidates();
    render();
}

/** True while a start/resolve cycle is in flight. */
export function isLewdCombatBusy() {
    return !!ui.view.busy || !!ui.starting;
}
