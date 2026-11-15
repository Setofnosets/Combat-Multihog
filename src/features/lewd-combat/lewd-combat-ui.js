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
    applyLewdAction,
    hydrateLewdState,
    listLegalActions,
    resolveLewdOpponentTurn,
    serializeLewdState,
    setSpectator,
    stopLewdEncounter,
} from './lewd-combat-engine.js';
import {
    buildLewdCombatMarkup,
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

const OVERLAY_ID = 'rt-lewd-combat-overlay';
const HOST_ID = 'rt-lewd-combat-host';
const MAX_AI_ITERATIONS = 12;

const ui = {
    installed: false,
    overlay: null,
    overlayOpen: false,
    starting: false,
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
 * Run the deterministic local policy for every AI participant that still owes
 * a turn. Guards at 12 iterations and persists once at the end.
 * @returns {object|null}
 */
function runAiTurns() {
    let state = readState();
    if (!state || state.status !== 'active') return state;
    let changed = false;
    let iterations = 0;
    while (state.status === 'active' && iterations < MAX_AI_ITERATIONS) {
        const actor = (state.participants || []).find(participant =>
            participant.ai && !participant.acted && !participant.spectator && !isOut(participant));
        if (!actor) break;
        const result = resolveLewdOpponentTurn(state);
        iterations += 1;
        if (!result.ok) break;
        changed = true;
    }
    if (changed) persist(state);
    return state;
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

function startFromOverlay() {
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
        runAiTurns();
        if (result.warnings?.length) toast('info', result.warnings[0]);
    } catch (error) {
        setError(error?.message || 'Could not start the Lewd Combat encounter.');
    } finally {
        ui.starting = false;
        render();
    }
}

function resolveAction() {
    if (ui.view.busy || ui.starting) return;
    const state = readState();
    if (!state || state.status !== 'active') {
        setError('There is no active encounter to resolve.');
        render();
        return;
    }
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
            runAiTurns();
        }
    } catch (error) {
        setError(error?.message || 'The action could not be resolved.');
    } finally {
        ui.view.busy = false;
        render();
    }
}

function simpleAction(type) {
    if (ui.view.busy || ui.starting) return;
    const state = readState();
    if (!state || state.status !== 'active') {
        setError('There is no active encounter.');
        render();
        return;
    }
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
            if (type !== 'stop') runAiTurns();
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
 * Install the delegated listeners. Idempotent and safe to call before the
 * runtime bridge is ready.
 */
export function installLewdCombatUi() {
    if (ui.installed) return;
    if (typeof document === 'undefined') return;
    ui.installed = true;
    document.addEventListener('keydown', onKeydown);
    document.addEventListener(LEWD_OPEN_EVENT, onOpenRequest);
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
    if (chatId && settings) removeLewdEncounterForChat(chatId, settings);
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
