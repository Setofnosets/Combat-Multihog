/**
 * traditional-combat-ui.js — DOM controller for the no-grid combat board.
 *
 * The board delegates every click, mutates state only through the shared engine,
 * persists per chat under `traditionalCombatByChat`, and hands the authoritative
 * outcome to the same narration pipeline used by tactical combat.
 */

import { getActiveChatId, getSettings } from '../../../state-manager.js';
import {
    addLog,
    applyOpeningAction,
    applySpecialEffects,
    applySurprise,
    buildOutcomeSummary,
    completeAgentTurn,
    createStateRng,
    endTurn,
    getActiveUnit,
    getPendingAgentUnitIds,
    getUnitById,
    prepareSpecialAction,
    resolveEffectTemplate,
    restoreCombatScopedState,
    retreatEncounter,
} from '../tactical-combat/tactical-combat-engine.js';
import { normalizeSpecialEffects, allowedSpecialTargetIds } from '../tactical-combat/tactical-combat-agent.js';
import { collectEncounterContext } from '../tactical-combat/tactical-combat-context.js';
import {
    clearPendingNarration,
    getEncounterForChat,
    hasPendingNarration,
    removeEncounterForChat,
    setEncounterForChat,
    TRADITIONAL_BY_CHAT_KEY,
} from '../tactical-combat/tactical-combat-store.js';
import {
    buildCombatTrackerReport,
    clearStaleCombatMemo,
    seedCombatMemo,
    syncCombatResultToMemo,
} from '../tactical-combat/tactical-combat-memo.js';
import { continueToNarration, queueCombatOutcome, requeueCombatOutcomeIfMissing } from '../tactical-combat/tactical-combat-outcome.js';
import { isTraditionalCombatMode } from '../combat/combat-mode.js';
import { buildTraditionalCombatMarkup } from './traditional-combat-markup.js';
import {
    applyTraditionalAction,
    buildTraditionalEncounterFromContext,
    describeTraditionalUnitOptions,
    getTraditionalActionCatalog,
    hydrateTraditionalEncounterState,
    serializeTraditionalAgentGameState,
} from './traditional-combat-engine.js';
import {
    generateTraditionalEncounterWithAgent,
    resolveTraditionalSpecialEffectWithAgent,
    runTraditionalAgentTurn,
} from './traditional-combat-agent.js';

const OVERLAY_ID = 'rt-traditional-combat-overlay';
const HOST_ID = 'rt-trad-host';
const AUTO_NARRATE_DELAY_MS = 1100;

const ui = {
    installed: false,
    overlay: null,
    overlayOpen: false,
    view: {
        selectedUnitId: '',
        activeUnitId: '',
        mode: '',
        selectedSkillId: '',
        selectedItemId: '',
        targetIds: [],
        targetLabels: {},
        busy: false,
        busyLabel: '',
        abortable: false,
        error: '',
        dismissResult: false,
    },
    abortController: null,
    agentRunToken: 0,
    starting: false,
    autoNarrateTimer: null,
    architectTimer: null,
    architectStateId: '',
    centerNextRender: false,
};

function toast(kind, message) {
    const fn = globalThis?.toastr?.[kind];
    if (typeof fn === 'function') {
        fn(String(message || ''), 'Traditional Combat');
        return;
    }
    const log = kind === 'error' ? console.warn : console.log;
    log('[RPG Tracker][Traditional Combat]', message);
}

function getState() {
    const state = getEncounterForChat(getActiveChatId(), getSettings(), { key: TRADITIONAL_BY_CHAT_KEY });
    return state ? hydrateTraditionalEncounterState(state) : null;
}

function persist(state) {
    const chatId = getActiveChatId();
    if (!chatId || !state) return;
    setEncounterForChat(chatId, state, getSettings(), { key: TRADITIONAL_BY_CHAT_KEY });
    notifySettings();
}

function notifySettings() {
    try { document.dispatchEvent(new CustomEvent('rt_traditional_combat_changed')); } catch (_) { /* no-op */ }
}

function selectedPlayer(state) {
    return state?.units?.find(unit => unit.id === ui.view.selectedUnitId && !unit.defeated && !unit.fled) || null;
}

function resetViewSelection() {
    ui.view.selectedUnitId = '';
    ui.view.activeUnitId = '';
    ui.view.mode = '';
    ui.view.selectedSkillId = '';
    ui.view.selectedItemId = '';
    ui.view.targetIds = [];
    ui.view.targetLabels = {};
    ui.view.error = '';
}

function setBusy(busy, label = '', abortable = false) {
    ui.view.busy = !!busy;
    ui.view.busyLabel = label || '';
    ui.view.abortable = !!abortable;
}

function targetInfo(state, unit) {
    if (!unit || !ui.view.mode) return { ids: [], labels: {} };
    const options = describeTraditionalUnitOptions(state, unit);
    let ids = [];
    if (ui.view.mode === 'attack') ids = options.attackTargets;
    else if (ui.view.mode === 'skill' && ui.view.selectedSkillId) ids = options.skillTargets[ui.view.selectedSkillId] || [];
    else if (ui.view.mode === 'item' && ui.view.selectedItemId) ids = options.itemTargets[ui.view.selectedItemId] || [];
    const labels = {};
    for (const id of ids) {
        const target = getUnitById(state, id);
        if (target) labels[id] = `${target.name} (${target.hp}/${target.maxHp} HP${target.maxWillpower ? `, ${target.willpower}/${target.maxWillpower} WP` : ''})`;
    }
    return { ids, labels };
}

function ensureOverlay() {
    if (ui.overlay && document.body.contains(ui.overlay)) return;
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'rt-tc-overlay rt-trad-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `<div id="${HOST_ID}" class="rt-tc-host rt-trad-host"></div>`;
    overlay.addEventListener('click', onOverlayClick);
    document.body.appendChild(overlay);
    ui.overlay = overlay;
}

function render() {
    if (!ui.overlayOpen) return;
    ensureOverlay();
    const host = ui.overlay.querySelector(`#${HOST_ID}`);
    if (!host) return;
    const state = getState();
    const active = state ? getActiveUnit(state) : null;
    ui.view.activeUnitId = active?.id || '';
    if (state) {
        const selected = state.units.find(unit => unit.id === ui.view.selectedUnitId && !unit.defeated && !unit.fled);
        if (!selected) {
            const fallback = (active && active.side === 'player' && !active.defeated && !active.fled)
                ? active
                : state.units.find(unit => unit.side === 'player' && !unit.defeated && !unit.fled);
            ui.view.selectedUnitId = fallback?.id || '';
        }
        const unit = selectedPlayer(state);
        const targets = targetInfo(state, unit);
        ui.view.targetIds = targets.ids;
        ui.view.targetLabels = targets.labels;
    } else {
        ui.view.targetIds = [];
        ui.view.targetLabels = {};
    }
    host.innerHTML = buildTraditionalCombatMarkup(state, ui.view);
    if (ui.centerNextRender) {
        ui.centerNextRender = false;
        host.querySelector('.rt-trad-team-player')?.scrollIntoView?.({ block: 'nearest' });
    }
}

function openBoard() {
    ensureOverlay();
    ui.overlayOpen = true;
    ui.overlay.classList.add('is-open');
    ui.overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('rt-tc-modal-open');
    try {
        document.dispatchEvent(new CustomEvent('rt_combat_board_opening', { detail: { board: 'traditional' } }));
    } catch (_) { /* no-op */ }
    render();
}

function closeBoard() {
    if (!ui.overlay) return;
    ui.overlayOpen = false;
    ui.overlay.classList.remove('is-open');
    ui.overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('rt-tc-modal-open');
}

function openSettingsTab() {
    try {
        document.dispatchEvent(new CustomEvent('rt_open_settings_overlay', { detail: { tab: 'combat' } }));
    } catch (_) { /* no-op */ }
}

function selectUnit(unitId) {
    const state = getState();
    if (!state) return;
    const unit = state.units.find(entry => entry.id === unitId);
    if (!unit) return;
    ui.view.selectedUnitId = unit.id;
    ui.view.mode = unit.side === 'player' && !unit.defeated && !unit.fled ? 'attack' : '';
    ui.view.selectedSkillId = '';
    ui.view.selectedItemId = '';
    render();
}

function handleMode(mode) {
    const state = getState();
    const unit = state ? selectedPlayer(state) : null;
    if (!unit) return;
    ui.view.mode = mode;
    ui.view.selectedSkillId = '';
    ui.view.selectedItemId = '';
    render();
}

function handleSelectSkill(skillId) {
    ui.view.mode = 'skill';
    ui.view.selectedSkillId = skillId;
    ui.view.selectedItemId = '';
    render();
}

function handleSelectItem(itemId) {
    ui.view.mode = 'item';
    ui.view.selectedItemId = itemId;
    ui.view.selectedSkillId = '';
    render();
}

function afterPlayerAction(state, settings = getSettings()) {
    persist(state);
    ui.view.mode = '';
    ui.view.selectedSkillId = '';
    ui.view.selectedItemId = '';
    render();
    if (state.status !== 'active') {
        finishEncounter(state, settings);
        return;
    }
    if (state.turnStyle === 'initiative' && state.phase === 'enemy') {
        void runEnemyTurnForState(state, settings);
    }
}

function applyPlayerAction(action, { autoEndUnit = false } = {}) {
    const state = getState();
    const settings = getSettings();
    if (!state || state.status !== 'active' || ui.view.busy) return;
    const result = applyTraditionalAction(state, action, {
        actorSide: 'player',
        rng: createStateRng(state),
        source: 'player',
    });
    if (!result.ok) {
        toast('warning', result.error || 'That action is not legal.');
        render();
        return;
    }
    if (autoEndUnit && state.status === 'active') {
        const unit = getUnitById(state, action.unitId);
        if (unit) unit.doneForRound = true;
        const advanced = endTurn(state, createStateRng(state));
        persist(state);
        render();
        if (state.status !== 'active') {
            finishEncounter(state, settings);
        } else if (advanced.agentUnitIds?.length || (state.phase === 'enemy' && getPendingAgentUnitIds(state).length)) {
            void runEnemyTurnForState(state, settings);
        }
        return;
    }
    afterPlayerAction(state, settings);
}

function resolveSpecialPlayerAction(sourceKind, source, targetId) {
    const state = getState();
    const settings = getSettings();
    const unit = selectedPlayer(state);
    if (!state || !unit || !source || ui.view.busy) return;
    const action = {
        type: sourceKind,
        unitId: unit.id,
        targetId,
        ...(sourceKind === 'skill' ? { skillId: source.id } : { itemId: source.id }),
    };
    const prepared = prepareSpecialAction(state, action, { actorSide: 'player' });
    if (!prepared.ok) {
        toast('warning', prepared.error || 'That special action is not legal.');
        return;
    }
    const sourceInfo = {
        kind: sourceKind,
        name: source.name,
        description: source.description || '',
        resource: source.resource,
        willpowerOutcome: source.willpowerOutcome,
    };
    const run = async () => {
        const controller = new AbortController();
        ui.abortController = controller;
        setBusy(true, `Resolving ${source.name}…`);
        render();
        try {
            let effects = [];
            let log = '';
            if (Array.isArray(source.effectTemplate) && source.effectTemplate.length) {
                const template = resolveEffectTemplate(source.effectTemplate, {
                    casterId: prepared.unit.id,
                    targetId: prepared.target?.id || prepared.unit.id,
                });
                const normalized = normalizeSpecialEffects({ effects: template }, state, { theater: true });
                if (!normalized.effects.length) throw new Error(normalized.rejected.join(' ') || 'The special effect had no legal targets.');
                effects = normalized.effects;
                log = normalized.log || '';
            } else {
                const resolved = await resolveTraditionalSpecialEffectWithAgent(
                    state,
                    prepared.unit,
                    sourceInfo,
                    prepared.target,
                    settings,
                    { signal: controller.signal },
                );
                if (!resolved.ok) throw new Error(resolved.error || 'The special resolver failed.');
                effects = resolved.effects || [];
                log = resolved.log || '';
            }
            const applied = applySpecialEffects(state, effects, {
                casterId: prepared.unit.id,
                skillId: prepared.skill?.id,
                itemId: prepared.item?.id,
                label: source.name,
                narrative: log,
                rng: createStateRng(state),
            });
            if (!applied.ok) throw new Error(applied.error || 'The special effect could not be applied.');
            afterPlayerAction(state, settings);
        } catch (error) {
            toast('warning', String(error?.message || error));
            render();
        } finally {
            if (ui.abortController === controller) ui.abortController = null;
            setBusy(false);
            render();
        }
    };
    void run();
}

function resolveTarget(targetId) {
    const state = getState();
    const unit = selectedPlayer(state);
    if (!state || !unit || ui.view.busy) return;
    if (ui.view.mode === 'attack') {
        applyPlayerAction({ type: 'attack', unitId: unit.id, targetId });
        return;
    }
    if (ui.view.mode === 'skill') {
        const skill = (unit.skills || []).find(entry => entry.id === ui.view.selectedSkillId);
        if (!skill) {
            toast('info', 'Choose a skill first.');
            return;
        }
        if (skill.kind === 'special') resolveSpecialPlayerAction('skill', skill, targetId);
        else applyPlayerAction({ type: 'skill', unitId: unit.id, skillId: skill.id, targetId });
        return;
    }
    if (ui.view.mode === 'item') {
        const item = (unit.items || []).find(entry => entry.id === ui.view.selectedItemId);
        if (!item) {
            toast('info', 'Choose an item first.');
            return;
        }
        if (item.kind === 'special') resolveSpecialPlayerAction('item', item, targetId);
        else applyPlayerAction({ type: 'item', unitId: unit.id, itemId: item.id, targetId });
    }
}

function handleEndTurn() {
    const state = getState();
    const settings = getSettings();
    if (!state || state.status !== 'active' || ui.view.busy) return;
    const pending = getPendingAgentUnitIds(state);
    if (state.phase === 'enemy') {
        if (pending.length) {
            void runEnemyTurnForState(state, settings);
            return;
        }
        const completion = completeAgentTurn(state, createStateRng(state));
        persist(state);
        render();
        if (state.status !== 'active') finishEncounter(state, settings);
        else if (completion.agentUnitIds?.length) void runEnemyTurnForState(state, settings);
        return;
    }
    const advanced = endTurn(state, createStateRng(state));
    persist(state);
    render();
    if (state.status !== 'active') {
        finishEncounter(state, settings);
    } else if (advanced.agentUnitIds?.length || (state.phase === 'enemy' && getPendingAgentUnitIds(state).length)) {
        void runEnemyTurnForState(state, settings);
    }
}

function handleRetreat() {
    const state = getState();
    const settings = getSettings();
    if (!state || state.status !== 'active' || ui.view.busy) return;
    const confirmed = typeof globalThis.confirm === 'function'
        ? globalThis.confirm('Retreat from this encounter? Every living party unit will leave the fight.')
        : true;
    if (!confirmed) return;
    retreatEncounter(state);
    persist(state);
    render();
    finishEncounter(state, settings);
}

async function runEnemyTurnForState(state, settings = getSettings()) {
    if (!state || state.status !== 'active' || ui.view.busy) return;
    const chatId = getActiveChatId();
    if (!chatId) return;
    let pending = getPendingAgentUnitIds(state);
    if (!pending.length) {
        const completion = completeAgentTurn(state, createStateRng(state));
        persist(state);
        render();
        if (state.status !== 'active') finishEncounter(state, settings);
        else if (completion.agentUnitIds?.length) await runEnemyTurnForState(state, settings);
        return;
    }

    const controller = new AbortController();
    ui.abortController = controller;
    const token = ++ui.agentRunToken;
    setBusy(true, `Enemy phase — resolving ${pending.length} unit${pending.length === 1 ? '' : 's'}…`, true);
    render();
    const catalog = getTraditionalActionCatalog(settings).catalog;

    try {
        for (let pass = 0; pass < 6 && state.status === 'active'; pass += 1) {
            const currentPending = getPendingAgentUnitIds(state);
            if (!currentPending.length) break;
            const result = await runTraditionalAgentTurn(state, currentPending, settings, {
                signal: controller.signal,
                rng: createStateRng(state),
                catalog,
            });
            if (ui.abortController !== controller || ui.agentRunToken !== token) return;
            if (controller.signal.aborted) {
                setBusy(false);
                render();
                return;
            }
            if (getActiveChatId() !== chatId) return;
            persist(state);
            if (result.source === 'local' || result.source === 'mixed') {
                toast('warning', result.error || 'The combat agent was unavailable; local tactics took over.');
            }
            render();
            if (state.status !== 'active') {
                finishEncounter(state, settings);
                return;
            }
            const completion = completeAgentTurn(state, createStateRng(state));
            persist(state);
            render();
            if (state.status !== 'active') {
                finishEncounter(state, settings);
                return;
            }
            pending = completion.agentUnitIds || [];
            if (!pending.length) break;
        }
    } catch (error) {
        if (getActiveChatId() === chatId) {
            console.warn('[RPG Tracker] Traditional Combat agent turn failed:', error);
            toast('error', `Enemy turn failed: ${error?.message || error}`);
        }
    } finally {
        if (ui.abortController === controller) {
            ui.abortController = null;
            setBusy(false);
            render();
        }
    }
}

function narratorGenerationBusy() {
    if (globalThis._rpgGenerationBusy === true) return true;
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.isGenerating === 'boolean') return ctx.isGenerating;
    } catch (_) { /* host not ready */ }
    return false;
}

function narratorPipelineBusy() {
    if (typeof globalThis._rpgStateModelRunning === 'function' && globalThis._rpgStateModelRunning()) return true;
    return narratorGenerationBusy();
}

function scheduleAutoNarration(state, settings, options = {}) {
    const chatId = getActiveChatId();
    if (!chatId || !state || state.finalization?.autoNarrateStarted) return;
    state.finalization = { ...(state.finalization || {}), autoNarrateStarted: true };
    persist(state);
    cancelAutoNarrate();
    const attempt = () => {
        ui.autoNarrateTimer = null;
        if (getActiveChatId() !== chatId) return;
        const latest = getState();
        if (!latest || latest.id !== state.id || latest.finalization?.finalizing) return;
        if (narratorGenerationBusy()) {
            const attempts = Number(latest.finalization?.autoNarrateAttempts) || 0;
            if (attempts >= 20) return;
            latest.finalization = { ...(latest.finalization || {}), autoNarrateAttempts: attempts + 1 };
            persist(latest);
            ui.autoNarrateTimer = setTimeout(attempt, AUTO_NARRATE_DELAY_MS);
            return;
        }
        closeBoard();
        void continueToNarration(getSettings()).then(ok => {
            if (!ok) toast('info', 'The result is queued. Send your next message to continue the story.');
        });
    };
    ui.autoNarrateTimer = setTimeout(attempt, AUTO_NARRATE_DELAY_MS);
}

function cancelAutoNarrate() {
    if (ui.autoNarrateTimer) {
        clearTimeout(ui.autoNarrateTimer);
        ui.autoNarrateTimer = null;
    }
}

function releaseInterruptedFinalization(chatId, stateId, settings = getSettings()) {
    if (!chatId || !stateId) return;
    const latest = getEncounterForChat(chatId, settings, { key: TRADITIONAL_BY_CHAT_KEY });
    if (!latest || latest.id !== stateId || latest.status === 'active') return;
    latest.finalization = {
        ...(latest.finalization || {}),
        finalizing: false,
        waitingForNarration: false,
        stage: 'interrupted',
    };
    setEncounterForChat(chatId, latest, settings, { key: TRADITIONAL_BY_CHAT_KEY });
}

async function runCombatFinalization(state, settings, options = {}) {
    const chatId = getActiveChatId();
    if (!chatId || !state || state.status === 'active') return true;
    if (state.finalization?.narrationQueued) {
        requeueCombatOutcomeIfMissing(state, settings);
        return true;
    }
    if (narratorGenerationBusy()) {
        if (!state.finalization?.waitingForNarration) {
            state.finalization = {
                ...(state.finalization || {}),
                finalizing: true,
                waitingForNarration: true,
                stage: 'waiting-for-narration',
                finalizingStartedAt: state.finalization?.finalizingStartedAt || Date.now(),
            };
            persist(state);
            setTimeout(() => {
                if (getActiveChatId() !== chatId) {
                    releaseInterruptedFinalization(chatId, state.id);
                    return;
                }
                const latest = getEncounterForChat(chatId, getSettings(), { key: TRADITIONAL_BY_CHAT_KEY });
                if (!latest || latest.id !== state.id) return;
                latest.finalization = { ...(latest.finalization || {}), finalizing: false, waitingForNarration: false };
                void runCombatFinalization(latest, getSettings(), options);
            }, 1200);
        }
        render();
        return true;
    }
    if (state.finalization?.finalizing) return true;

    state.finalization = {
        ...(state.finalization || {}),
        finalizing: true,
        stage: 'syncing',
        finalizingStartedAt: Date.now(),
    };
    if (!state.outcome) state.outcome = buildOutcomeSummary(state);
    restoreCombatScopedState(state);
    syncCombatResultToMemo(state, settings);
    persist(state);
    render();

    try {
        const stateTrackerBusy = typeof globalThis._rpgStateModelRunning === 'function'
            && globalThis._rpgStateModelRunning();
        const canSync = settings.enabled
            && !stateTrackerBusy
            && !narratorGenerationBusy()
            && settings.traditionalCombatSyncTrackerBeforeNarration !== false
            && typeof globalThis._rpgRunStateModelPass === 'function';
        if (canSync) {
            setBusy(true, 'Updating the State Tracker with the final combat state…');
            render();
            await globalThis._rpgRunStateModelPass('', false, null, {
                extraContext: buildCombatTrackerReport(state, {
                    recoverWillpower: settings.tacticalCombatWillpowerRecoverAfterCombat !== false,
                }),
                extraInstruction: 'The traditional combat board is authoritative. Apply this final state to the memo, close [COMBAT], and do not re-adjudicate the encounter.',
                timeoutMs: 30000,
            });
        }
    } catch (error) {
        console.warn('[RPG Tracker] Traditional Combat tracker finalization failed:', error);
    } finally {
        setBusy(false);
    }

    if (getActiveChatId() !== chatId) {
        releaseInterruptedFinalization(chatId, state.id);
        return true;
    }
    const latest = getState();
    if (!latest || latest.id !== state.id) return true;
    syncCombatResultToMemo(latest, settings);
    queueCombatOutcome(latest, settings, { persist: false, refresh: true });
    latest.finalization = {
        ...(latest.finalization || {}),
        finalizing: false,
        stage: 'queued',
        finalizedAt: Date.now(),
    };
    persist(latest);
    render();

    if (settings.traditionalCombatAutoNarrate !== false && options.autoNarrate !== false) {
        scheduleAutoNarration(latest, settings, options);
    }
    return true;
}

function finishEncounter(state, settings = getSettings(), options = {}) {
    if (!state || state.status === 'active') return false;
    const finalizingStartedAt = Number(state.finalization?.finalizingStartedAt) || 0;
    const staleFinalization = !!state.finalization?.finalizing
        && finalizingStartedAt > 0
        && Date.now() - finalizingStartedAt > 90000;
    if (staleFinalization) {
        state.finalization = { ...(state.finalization || {}), finalizing: false, waitingForNarration: false };
    }
    if (state.finalization?.narrationQueued) {
        requeueCombatOutcomeIfMissing(state, settings);
    } else if (!state.finalization?.finalizing || staleFinalization) {
        void runCombatFinalization(state, settings, options);
    }
    render();
    return true;
}

function clearEndedEncounterForFreshStart(existing, settings) {
    if (!existing || existing.status === 'active') return false;
    const chatId = existing.chatId || getActiveChatId();
    if (chatId) removeEncounterForChat(chatId, settings, { key: TRADITIONAL_BY_CHAT_KEY, persist: false });
    settings.combatDefeatedUi = [];
    clearStaleCombatMemo(existing, settings);
    cancelAutoNarrate();
    resetViewSelection();
    setBusy(false);
    return true;
}

function collectStartContext(settings, options = {}) {
    const context = collectEncounterContext(settings, (() => {
        try { return SillyTavern.getContext(); } catch (_) { return {}; }
    })(), {
        enemyNames: options.enemyNames,
        playerDeclaration: options.playerDeclaration,
        freshStart: options.freshStart === true,
    });
    context.chatId = getActiveChatId() || context.chatId;
    if (options.location) {
        context.location = String(options.location).slice(0, 200);
        context.theme = context.theme || 'plain';
    }
    if (options.reason) {
        const reason = String(options.reason).slice(0, 300);
        context.sceneExcerpt = `${context.sceneExcerpt || ''}\nNarrator trigger: ${reason}`.trim();
        if (reason && !String(context.playerDeclaration || '').includes(reason)) {
            context.playerDeclaration = `${context.playerDeclaration || ''}\n${reason}`.trim().slice(0, 1200);
        }
    }
    if (options.openingAction) {
        const declaration = String(options.openingAction).trim();
        if (declaration && !String(context.playerDeclaration || '').includes(declaration)) {
            context.playerDeclaration = `${declaration}\n${context.playerDeclaration || ''}`.trim().slice(0, 1200);
        }
    }
    return context;
}

function buildOpeningRequest(options = {}) {
    const raw = options.openingAction;
    const fromObject = raw && typeof raw === 'object' ? raw : null;
    const text = String(fromObject?.text || fromObject?.description || raw || '').trim();
    if (!text) return null;
    return {
        text: text.slice(0, 1200),
        actorName: String(fromObject?.actorName || options.openingActor || '').trim(),
        targetName: String(fromObject?.targetName || options.openingTarget || '').trim(),
        skillName: String(fromObject?.skillName || options.openingSkill || '').trim(),
        itemName: String(fromObject?.itemName || options.openingItem || options.openingSkill || '').trim(),
        surprise: fromObject?.surprise === true || options.surprise === true,
        sourceMessageId: options.sourceMessageId || '',
    };
}

function resetOpeningActorResources(state) {
    const actor = state?.units?.find(unit => unit.id === state.opening?.actorId);
    if (!actor) return;
    actor.actionUsed = false;
    actor.bonusUsed = false;
    actor.doneForRound = false;
}

async function resolveSpecialOpeningForState(state, settings, options = {}) {
    if (!state || state.status !== 'active' || !state.opening?.requiresAgent || state.opening?.resolving) return false;
    const actor = state.units.find(unit => unit.id === state.opening.actorId);
    const target = state.units.find(unit => unit.id === state.opening.targetId) || null;
    if (!actor) {
        state.opening.error = 'The opening actor is no longer on the board.';
        state.opening.requiresAgent = false;
        return false;
    }
    const skill = (actor.skills || []).find(entry => entry.id === state.opening.skillId) || null;
    const item = (actor.items || []).find(entry => entry.id === state.opening.itemId) || null;
    state.opening.resolving = true;
    const controller = new AbortController();
    ui.abortController = controller;
    setBusy(true, 'Resolving the opening action…', true);
    persist(state);
    render();
    try {
        const source = item
            ? { kind: 'item', name: item.name, description: item.description || state.opening.text, resource: item.resource, willpowerOutcome: item.willpowerOutcome, target: item.target, damage: item.damage, heal: item.heal, willpowerDamage: item.willpowerDamage, maxUses: item.maxUses }
            : { kind: 'skill', name: skill?.name || 'Opening action', description: skill?.description || state.opening.text, resource: skill?.resource, willpowerOutcome: skill?.willpowerOutcome, target: skill?.target, damage: skill?.damage, heal: skill?.heal, willpowerDamage: skill?.willpowerDamage, maxUses: skill?.maxUses };
        let resolved;
        if (Array.isArray(skill?.effectTemplate) || Array.isArray(item?.effectTemplate)) {
            const template = skill?.effectTemplate || item?.effectTemplate;
            const effects = resolveEffectTemplate(template, { casterId: actor.id, targetId: target?.id || actor.id });
            const preparedForTargets = {
                unit: actor,
                target,
                targets: target ? [target] : [],
                area: null,
                skill,
                item,
            };
            const normalized = normalizeSpecialEffects({ effects }, state, {
                theater: true,
                allowedTargetIds: allowedSpecialTargetIds(preparedForTargets),
            });
            resolved = normalized.effects.length
                ? { ok: true, effects: normalized.effects, log: '' }
                : { ok: false, error: normalized.rejected.join(' ') || 'The effect template had no legal effects.' };
        } else {
            resolved = await resolveTraditionalSpecialEffectWithAgent(state, actor, source, target, settings, {
                signal: controller.signal,
            });
        }
        if (getActiveChatId() !== state.chatId) return false;
        if (!resolved.ok) {
            state.opening.error = resolved.error || 'The opening action could not be resolved.';
            state.opening.requiresAgent = false;
            addLog(state, 'opening', `Opening action needs manual resolution: ${state.opening.error}`, actor.id);
            toast('warning', state.opening.error);
            return false;
        }
        const applied = applySpecialEffects(state, resolved.effects || [], {
            casterId: actor.id,
            skillId: skill?.id || '',
            itemId: item?.id || '',
            log: resolved.log || state.opening.text,
            narrative: resolved.log || '',
        });
        if (!applied.ok) {
            state.opening.error = applied.error || 'The opening action had no usable effects.';
            state.opening.requiresAgent = false;
            addLog(state, 'opening', `Opening action needs manual resolution: ${state.opening.error}`, actor.id);
            toast('warning', state.opening.error);
            return false;
        }
        resetOpeningActorResources(state);
        if (state.opening?.surprise && !state.opening?.surpriseApplied && state.status === 'active') {
            applySurprise(state, 'player');
            state.opening.surpriseApplied = true;
        }
        state.opening.requiresAgent = false;
        state.opening.resolved = true;
        state.opening.log = resolved.log || '';
        state.opening.resolvedAt = Date.now();
        addLog(state, 'opening', `${actor.name} opens the fight: ${state.opening.text}.`, actor.id);
        if (state.status !== 'active') state.outcome = buildOutcomeSummary(state);
        return true;
    } catch (error) {
        state.opening.error = String(error?.message || error);
        state.opening.requiresAgent = false;
        addLog(state, 'opening', `Opening action could not be resolved: ${state.opening.error}`, actor.id);
        return false;
    } finally {
        if (ui.abortController === controller) ui.abortController = null;
        state.opening.resolving = false;
        setBusy(false);
        render();
    }
}

function scheduleOpeningResolution(state, settings, options = {}) {
    if (!state?.opening?.requiresAgent) return;
    const chatId = state.chatId || getActiveChatId();
    const startedAt = Date.now();
    const attempt = () => {
        if (getActiveChatId() !== chatId) return;
        const latest = getState();
        if (!latest || latest.id !== state.id || latest.status !== 'active') return;
        if (narratorPipelineBusy() && Date.now() - startedAt < 45000) {
            setTimeout(attempt, 600);
            return;
        }
        void resolveSpecialOpeningForState(latest, getSettings(), options).then(ok => {
            if (getActiveChatId() !== chatId) return;
            persist(latest);
            render();
            if (!ok) return;
            if (latest.status !== 'active') finishEncounter(latest, getSettings(), { autoNarrate: !options.fromNarrator });
        });
    };
    setTimeout(attempt, 800);
}

function applyEncounterOptionsToState(state, settings, options = {}) {
    if (options.title) state.title = String(options.title).slice(0, 140);
    if (options.location) state.location = String(options.location).slice(0, 200);
    if (options.description) state.description = String(options.description).slice(0, 4000);
    if (options.reason && !options.description) {
        state.description = `${state.description || ''}\n\nTrigger: ${String(options.reason).slice(0, 300)}`.trim();
    }
    let openingNeedsAgent = false;
    if (settings.traditionalCombatOpeningActions !== false) {
        const opening = buildOpeningRequest(options);
        if (opening) {
            const result = applyOpeningAction(state, opening, { rng: createStateRng(state) });
            if (result.requiresAgent) openingNeedsAgent = true;
            else if (!result.ok && result.error) addLog(state, 'opening', `Opening action was not resolved automatically: ${result.error}`, null);
        } else if (options.surprise === true) {
            applySurprise(state, 'player');
        }
    }
    seedCombatMemo(state, settings);
    return openingNeedsAgent;
}

function scheduleDeferredArchitect(provisional, settings, options = {}) {
    if (!provisional?.preparing?.active) return;
    const chatId = provisional.chatId || getActiveChatId();
    if (!chatId) return;
    if (ui.architectTimer && ui.architectStateId === provisional.id) return;
    if (ui.architectTimer) clearTimeout(ui.architectTimer);
    ui.architectStateId = provisional.id;
    const startedAt = Date.now();
    const attempt = () => {
        ui.architectTimer = null;
        if (getActiveChatId() !== chatId) {
            ui.architectStateId = '';
            return;
        }
        const latest = getState();
        if (!latest || latest.id !== provisional.id || !latest.preparing?.active) {
            ui.architectStateId = '';
            return;
        }
        if (narratorPipelineBusy() && Date.now() - startedAt < 90000) {
            ui.architectTimer = setTimeout(attempt, 700);
            return;
        }
        ui.architectStateId = '';
        void runDeferredArchitect(latest, getSettings(), options);
    };
    ui.architectTimer = setTimeout(attempt, 850);
}

async function runDeferredArchitect(provisional, settings, options = {}) {
    const chatId = provisional?.chatId || getActiveChatId();
    if (!provisional?.preparing?.active || !chatId) return false;
    const controller = new AbortController();
    ui.abortController = controller;
    setBusy(true, 'The encounter architect is designing the opposition…', true);
    persist(provisional);
    render();
    try {
        const context = collectStartContext(settings, options);
        const generated = await generateTraditionalEncounterWithAgent(context, settings, { signal: controller.signal });
        if (controller.signal.aborted || getActiveChatId() !== chatId) return false;
        const latest = getState();
        if (!latest || latest.id !== provisional.id || !latest.preparing?.active) return false;
        const built = buildTraditionalEncounterFromContext(context, settings, {
            agentEncounter: generated.ok ? generated.encounter : null,
            source: options.source || settings.traditionalCombatEncounterSource || 'auto',
            seed: Math.floor(Math.random() * 0x7fffffff),
            actionCatalog: getTraditionalActionCatalog(settings).catalog,
        });
        return finalizePrepared(latest, built.state, settings, options, context, built.warnings, generated.error);
    } catch (error) {
        const latest = getState();
        if (!latest || latest.id !== provisional.id) return false;
        const built = buildTraditionalEncounterFromContext(collectStartContext(settings, options), settings, {
            source: options.source || settings.traditionalCombatEncounterSource || 'auto',
            seed: Math.floor(Math.random() * 0x7fffffff),
        });
        return finalizePrepared(latest, built.state, settings, options, built.state, [], String(error?.message || error));
    } finally {
        if (ui.abortController === controller) ui.abortController = null;
        setBusy(false);
        render();
    }
}

function finalizePrepared(provisional, next, settings, options, context, warnings = [], error = '') {
    if (!provisional || provisional.status !== 'active' || !provisional.preparing?.active) return false;
    next.id = provisional.id;
    next.createdAt = provisional.createdAt;
    next.chatId = provisional.chatId;
    next.preparing = null;
    const allWarnings = [...(provisional.preparing.warnings || []), ...(warnings || [])];
    if (error) allWarnings.push(String(error));
    const openingNeedsAgent = applyEncounterOptionsToState(next, settings, options);
    persist(next);
    ui.starting = false;
    setBusy(false);
    resetViewSelection();
    ui.centerNextRender = true;
    render();
    toast(allWarnings.length ? 'warning' : 'success', allWarnings.length ? allWarnings[0] : 'Encounter ready.');
    if (next.status !== 'active') {
        finishEncounter(next, settings, { autoNarrate: !options.fromNarrator });
    } else {
        if (openingNeedsAgent) scheduleOpeningResolution(next, settings, options);
        if (next.phase === 'enemy' && getPendingAgentUnitIds(next).length && !options.fromNarrator) {
            void runEnemyTurnForState(next, settings);
        }
    }
    return true;
}

async function startEncounterFlow(options = {}) {
    const settings = getSettings();
    if (!isTraditionalCombatMode(settings)) {
        toast('warning', 'Select Traditional Combat in Settings → Combat first.');
        openSettingsTab();
        return { ok: false, error: 'Traditional Combat is disabled.' };
    }
    const existing = getState();
    if (existing?.status === 'active') {
        openBoard();
        toast('info', 'That encounter is already in progress.');
        return { ok: true, alreadyActive: true, state: existing };
    }
    const activeChatId = getActiveChatId();
    if (hasPendingNarration(settings, activeChatId)) {
        toast('info', 'A combat result is still queued for the narrator. Let it resolve before starting another encounter.');
        return { ok: false, error: 'A combat result is still queued for this chat.' };
    }
    if (existing && existing.finalization?.finalizing) {
        toast('info', 'The previous encounter is still syncing its final state. Try again when it finishes.');
        return { ok: false, error: 'The previous encounter is still finalizing.' };
    }
    if (existing && !options.silentNew && typeof globalThis.confirm === 'function'
        && !globalThis.confirm('Start a new encounter? The previous result has already been queued for the narrator.')) {
        return { ok: false, cancelled: true };
    }
    if (ui.starting) return { ok: false, error: 'An encounter is already being prepared.' };
    ensureOverlay();
    openBoard();
    ui.starting = true;
    ui.view.error = '';
    ui.view.dismissResult = false;
    cancelAutoNarrate();
    setBusy(true, 'Preparing the encounter…');
    render();
    const controller = new AbortController();
    ui.abortController = controller;

    const freshStart = clearEndedEncounterForFreshStart(existing, settings) || options.freshStart === true;
    const source = String(options.source || settings.traditionalCombatEncounterSource || 'auto');
    let context;
    try {
        context = collectStartContext(settings, { ...options, source, freshStart });
    } catch (error) {
        if (ui.abortController === controller) ui.abortController = null;
        ui.starting = false;
        setBusy(false);
        ui.view.error = `Could not read the current scene: ${error?.message || error}`;
        render();
        toast('error', ui.view.error);
        return { ok: false, error: ui.view.error };
    }
    if (!context.chatId) {
        if (ui.abortController === controller) ui.abortController = null;
        ui.starting = false;
        setBusy(false);
        ui.view.error = 'Open a chat before starting a traditional encounter.';
        render();
        return { ok: false, error: ui.view.error };
    }

    let agentEncounter = null;
    const warnings = [];
    const needsAgent = source === 'agent' || (source === 'auto' && !context.existingCombat);
    const deferArchitect = needsAgent && options.fromNarrator === true;
    if (needsAgent && !deferArchitect) {
        setBusy(true, 'The combat agent is designing the encounter…', true);
        render();
        const generated = await generateTraditionalEncounterWithAgent(context, settings, { signal: controller.signal });
        if (controller.signal.aborted) {
            if (ui.abortController === controller) ui.abortController = null;
            ui.starting = false;
            setBusy(false);
            render();
            return { ok: false, cancelled: true };
        }
        if (generated.ok) agentEncounter = generated.encounter;
        else if (generated.error) warnings.push(generated.error);
    }
    if (ui.abortController === controller) ui.abortController = null;

    if (source === 'existing' && !context.existingCombat && !deferArchitect) {
        ui.starting = false;
        setBusy(false);
        ui.view.error = 'No active [COMBAT] enemies were found. Switch Encounter source to Auto or Agent to generate opposition.';
        render();
        toast('error', ui.view.error);
        return { ok: false, error: ui.view.error };
    }

    try {
        const built = buildTraditionalEncounterFromContext(context, settings, {
            agentEncounter,
            source,
            seed: Math.floor(Math.random() * 0x7fffffff),
            actionCatalog: getTraditionalActionCatalog(settings).catalog,
        });
        warnings.push(...(built.warnings || []));
        const state = built.state;
        if (options.title) state.title = String(options.title).slice(0, 140);
        if (options.location) state.location = String(options.location).slice(0, 200);
        if (options.description) state.description = String(options.description).slice(0, 4000);
        if (options.reason && !options.description) {
            state.description = `${state.description || ''}\n\nTrigger: ${String(options.reason).slice(0, 300)}`.trim();
        }

        if (deferArchitect) {
            state.preparing = {
                active: true,
                startedAt: Date.now(),
                source,
                freshStart,
                options: { ...options, source, freshStart },
                warnings: [...warnings],
            };
            persist(state);
            ui.starting = false;
            setBusy(false);
            resetViewSelection();
            ui.centerNextRender = true;
            render();
            toast('info', 'The encounter architect is designing the opposition…');
            scheduleDeferredArchitect(state, settings, { ...options, source, freshStart });
            return { ok: true, state, warnings, preparing: true };
        }

        const openingNeedsAgent = applyEncounterOptionsToState(state, settings, options);
        persist(state);
        ui.starting = false;
        setBusy(false);
        resetViewSelection();
        ui.centerNextRender = true;
        render();
        toast('success', warnings.length ? `Encounter ready. ${warnings[0]}` : 'Encounter ready.');
        if (state.status !== 'active') {
            finishEncounter(state, settings, { autoNarrate: !options.fromNarrator });
        } else {
            if (openingNeedsAgent) scheduleOpeningResolution(state, settings, options);
            if (state.phase === 'enemy' && getPendingAgentUnitIds(state).length && !options.fromNarrator) {
                void runEnemyTurnForState(state, settings);
            }
        }
        return { ok: true, state, warnings };
    } catch (error) {
        if (ui.abortController === controller) ui.abortController = null;
        ui.starting = false;
        setBusy(false);
        ui.view.error = String(error?.message || error);
        render();
        toast('error', ui.view.error);
        return { ok: false, error: ui.view.error };
    }
}

function useLocalRoster() {
    const current = getState();
    if (!current?.preparing?.active) return;
    if (ui.abortController) {
        ui.abortController.abort();
        ui.abortController = null;
    }
    if (ui.architectTimer) {
        clearTimeout(ui.architectTimer);
        ui.architectTimer = null;
    }
    ui.architectStateId = '';
    const settings = getSettings();
    const options = current.preparing.options || {};
    try {
        const context = collectStartContext(settings, options);
        const built = buildTraditionalEncounterFromContext(context, settings, {
            source: options.source || settings.traditionalCombatEncounterSource || 'auto',
            seed: Math.floor(Math.random() * 0x7fffffff),
            actionCatalog: getTraditionalActionCatalog(settings).catalog,
        });
        finalizePrepared(current, built.state, settings, options, context, built.warnings, 'The local roster was used instead of the encounter architect.');
    } catch (error) {
        toast('error', String(error?.message || error));
        render();
    }
}

function handleOverlayAction(action, element) {
    switch (action) {
        case 'close':
            closeBoard();
            break;
        case 'settings':
            closeBoard();
            openSettingsTab();
            break;
        case 'export':
            exportState();
            break;
        case 'start':
            void startEncounterFlow();
            break;
        case 'use-fallback':
            void useLocalRoster();
            break;
        case 'end-turn':
            handleEndTurn();
            break;
        case 'retreat':
            handleRetreat();
            break;
        case 'resume-agent': {
            const state = getState();
            if (state) void runEnemyTurnForState(state);
            break;
        }
        case 'abort-agent':
            if (ui.abortController) ui.abortController.abort();
            ui.abortController = null;
            setBusy(false);
            render();
            break;
        case 'mode-attack':
            handleMode('attack');
            break;
        case 'mode-skill':
            handleMode('skill');
            break;
        case 'mode-item':
            handleMode('item');
            break;
        case 'defend': {
            const state = getState();
            const unit = selectedPlayer(state);
            if (unit) applyPlayerAction({ type: 'defend', unitId: unit.id });
            break;
        }
        case 'wait': {
            const state = getState();
            const unit = selectedPlayer(state);
            if (unit) applyPlayerAction({ type: 'wait', unitId: unit.id }, { autoEndUnit: state.turnStyle === 'initiative' });
            break;
        }
        case 'flee': {
            const state = getState();
            const unit = selectedPlayer(state);
            if (unit) applyPlayerAction({ type: 'flee', unitId: unit.id }, { autoEndUnit: state.turnStyle === 'initiative' });
            break;
        }
        case 'select-skill':
            handleSelectSkill(element?.dataset?.tradSkillId || '');
            break;
        case 'select-item':
            handleSelectItem(element?.dataset?.tradItemId || '');
            break;
        case 'target':
            resolveTarget(element?.dataset?.tradTargetId || '');
            break;
        case 'continue-narration': {
            const current = getState();
            if (current?.finalization?.finalizing) {
                const since = Number(current.finalization.finalizingStartedAt) || 0;
                if (!since || Date.now() - since < 90000) {
                    toast('info', 'Updating the State Tracker with the final combat state…');
                    break;
                }
                current.finalization = { ...(current.finalization || {}), finalizing: false, waitingForNarration: false };
                finishEncounter(current, getSettings());
                break;
            }
            cancelAutoNarrate();
            closeBoard();
            void continueToNarration(getSettings()).then(ok => {
                if (!ok) toast('info', 'The result is queued. Send your next message to continue the story.');
            });
            break;
        }
        case 'dismiss-result':
            cancelAutoNarrate();
            ui.view.dismissResult = true;
            render();
            break;
        case 'new-encounter':
            cancelAutoNarrate();
            ui.view.dismissResult = false;
            void startEncounterFlow();
            break;
        default:
            break;
    }
}

function onOverlayClick(event) {
    if (event.target === ui.overlay) {
        closeBoard();
        return;
    }
    const actionEl = event.target.closest?.('[data-trad-action]');
    if (actionEl && ui.overlay?.contains(actionEl)) {
        event.preventDefault();
        handleOverlayAction(actionEl.dataset.tradAction, actionEl);
        return;
    }
    const targetEl = event.target.closest?.('[data-trad-target]');
    if (targetEl && ui.overlay?.contains(targetEl)) {
        event.preventDefault();
        resolveTarget(targetEl.dataset.tradTarget);
        return;
    }
    const selectEl = event.target.closest?.('[data-trad-select-unit]');
    if (selectEl && ui.overlay?.contains(selectEl)) {
        event.preventDefault();
        selectUnit(selectEl.dataset.tradSelectUnit);
    }
}

function onDocumentClick(event) {
    const trigger = event.target.closest?.('#rt-traditional-combat-btn, [data-trad-open-board]');
    if (!trigger) return;
    event.preventDefault();
    openBoard();
}

function onKeydown(event) {
    if (event.key === 'Escape' && ui.overlayOpen) {
        event.preventDefault();
        closeBoard();
    }
}

function exportState() {
    const state = getState();
    if (!state) return;
    const text = serializeTraditionalAgentGameState(state);
    try {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `traditional-combat-${state.id || 'encounter'}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        console.warn('[RPG Tracker] Could not export traditional combat state:', error);
    }
}

export function installTraditionalCombatUi() {
    if (ui.installed) return;
    ui.installed = true;
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('rt_open_traditional_combat', openBoard);
    document.addEventListener('rt_combat_board_opening', (event) => {
        if (event?.detail?.board !== 'traditional' && ui.overlayOpen) closeBoard();
    });
}

export function onTraditionalCombatChatChanged(chatId = getActiveChatId()) {
    if (ui.abortController) {
        ui.abortController.abort();
        ui.abortController = null;
    }
    ui.agentRunToken += 1;
    ui.starting = false;
    cancelAutoNarrate();
    if (ui.architectTimer) {
        clearTimeout(ui.architectTimer);
        ui.architectTimer = null;
    }
    ui.architectStateId = '';
    setBusy(false);
    resetViewSelection();
    ui.centerNextRender = true;
    const arrived = chatId
        ? getEncounterForChat(chatId, getSettings(), { key: TRADITIONAL_BY_CHAT_KEY })
        : null;
    const state = arrived ? hydrateTraditionalEncounterState(arrived) : null;
    if (state?.preparing?.active) {
        scheduleDeferredArchitect(state, getSettings(), state.preparing.options || {});
    } else if (state?.opening?.requiresAgent && !state.opening?.resolving) {
        scheduleOpeningResolution(state, getSettings(), state.preparing?.options || {});
    } else if (state && state.status !== 'active') {
        if (state.finalization?.narrationQueued) requeueCombatOutcomeIfMissing(state, getSettings());
        else finishEncounter(state, getSettings());
    }
    notifySettings();
    if (ui.overlayOpen) render();
}

export function openTraditionalCombatBoard() {
    openBoard();
}

export function startTraditionalCombatFlow(options = {}) {
    return startEncounterFlow(options);
}

export async function startTraditionalCombatFromNarrator(args = {}, options = {}) {
    const settings = getSettings();
    if (!isTraditionalCombatMode(settings)) {
        return {
            ok: false,
            message: 'Traditional Combat is not selected. Ask the player to choose it in Settings → Combat.',
        };
    }
    const result = await startEncounterFlow({
        title: args.title,
        location: args.location,
        description: args.description,
        reason: args.reason,
        openingAction: args.openingAction,
        openingTarget: args.openingTarget,
        openingSkill: args.openingSkill,
        surprise: args.surprise,
        enemyNames: args.enemyNames,
        silentNew: true,
        source: options.source || settings.traditionalCombatEncounterSource || 'auto',
        fromNarrator: true,
    });
    if (!result.ok) {
        return {
            ok: false,
            message: result.error || (result.cancelled ? 'Encounter start was cancelled.' : 'Could not start the traditional encounter.'),
        };
    }
    openBoard();
    const state = result.state || getState();
    if (result.alreadyActive) {
        return { ok: true, message: `A traditional encounter is already active (${state?.title || 'encounter'}); the board is open.` };
    }
    if (state?.preparing?.active) {
        return {
            ok: true,
            message: `Traditional encounter preparation started: ${state?.title || 'encounter'}. The encounter architect is designing the opposition.`,
        };
    }
    return {
        ok: true,
        message: `Traditional encounter ${state?.status === 'active' ? 'started' : (state?.outcome?.label || 'prepared')}: ${state?.title || 'encounter'}. The board is open. Resolve the fight by choosing actions and targets; the result returns to narration when it ends.`,
    };
}

export function stopTraditionalCombatAgent() {
    if (ui.abortController) ui.abortController.abort();
    ui.abortController = null;
    if (ui.architectTimer) {
        clearTimeout(ui.architectTimer);
        ui.architectTimer = null;
    }
    ui.architectStateId = '';
    setBusy(false);
    render();
}

export function isTraditionalCombatBusy() {
    return !!ui.view.busy || !!ui.starting;
}

export function refreshTraditionalCombatUi() {
    if (ui.overlayOpen) render();
}

export function resetTraditionalCombatEncounter() {
    const chatId = getActiveChatId();
    if (!chatId) return;
    cancelAutoNarrate();
    if (ui.abortController) {
        ui.abortController.abort();
        ui.abortController = null;
    }
    if (ui.architectTimer) {
        clearTimeout(ui.architectTimer);
        ui.architectTimer = null;
    }
    ui.architectStateId = '';
    const settings = getSettings();
    const existing = getEncounterForChat(chatId, settings, { key: TRADITIONAL_BY_CHAT_KEY });
    if (existing) clearStaleCombatMemo(existing, settings);
    clearPendingNarration(settings, { chatId });
    removeEncounterForChat(chatId, settings, { key: TRADITIONAL_BY_CHAT_KEY });
    resetViewSelection();
    setBusy(false);
    notifySettings();
    if (ui.overlayOpen) render();
}
