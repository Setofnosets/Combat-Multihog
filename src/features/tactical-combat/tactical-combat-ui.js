/**
 * tactical-combat-ui.js — DOM controller for the tactical board.
 *
 * The board is a single delegated overlay so re-rendering 400 cells does not
 * leak listeners. All game mutations go through the pure engine; this file owns
 * selection, targeting, async agent turns, persistence, and the narration handoff.
 */

import { getActiveChatId, getSettings } from '../../../state-manager.js';
import {
    applyAction,
    applySpecialEffects,
    completeAgentTurn,
    computeReachableCells,
    createStateRng,
    describeUnitOptions,
    endTurn,
    getPendingAgentUnitIds,
    retreatEncounter,
    serializeAgentGameState,
} from './tactical-combat-engine.js';
import { getActionCatalog } from './tactical-combat-actions.js';
import { buildTacticalCombatMarkup } from './tactical-combat-markup.js';
import {
    buildEncounterFromContext,
    collectEncounterContext,
    inferTerrainTheme,
} from './tactical-combat-context.js';
import {
    generateEncounterWithAgent,
    resolveSpecialEffectWithAgent,
    runAgentTurn,
} from './tactical-combat-agent.js';
import {
    getEncounterForChat,
    removeEncounterForChat,
    setEncounterForChat,
} from './tactical-combat-store.js';
import {
    continueToNarration,
    queueCombatOutcome,
} from './tactical-combat-outcome.js';

const OVERLAY_ID = 'rt-tactical-combat-overlay';
const HOST_ID = 'rt-tc-host';
const AUTO_NARRATE_DELAY_MS = 1100;

const ui = {
    installed: false,
    overlay: null,
    overlayOpen: false,
    view: {
        selectedUnitId: '',
        mode: 'move',
        selectedSkillId: '',
        selectedItemId: '',
        busy: false,
        busyLabel: '',
        abortable: false,
        error: '',
        dismissResult: false,
    },
    abortController: null,
    starting: false,
    centerNextRender: false,
    agentRunToken: 0,
    autoNarrateTimer: null,
};

function toast(kind, message) {
    const fn = globalThis?.toastr?.[kind];
    if (typeof fn === 'function') {
        fn(String(message || ''), 'Tactical Combat');
        return;
    }
    const log = kind === 'error' ? console.warn : console.log;
    log('[RPG Tracker][Tactical Combat]', message);
}

function getState() {
    return getEncounterForChat(getActiveChatId(), getSettings());
}

function persist(state) {
    const chatId = getActiveChatId();
    if (!chatId || !state) return;
    setEncounterForChat(chatId, state, getSettings());
    notifySettings();
}

function notifySettings() {
    try { document.dispatchEvent(new CustomEvent('rt_tactical_combat_changed')); } catch (_) { /* no-op */ }
}

function activeUnitId(state) {
    if (!state || state.turnStyle !== 'initiative') return '';
    return state.initiativeOrder?.[state.turnIndex] || '';
}

function playerUnitById(state, unitId) {
    return state?.units?.find(unit => unit.id === unitId && unit.side === 'player' && !unit.defeated && !unit.fled) || null;
}

function pickSelectedUnit(state) {
    const current = state.units.find(unit => unit.id === ui.view.selectedUnitId);
    const initiativeActive = state.turnStyle === 'initiative' && state.phase === 'player'
        ? state.units.find(unit => unit.id === activeUnitId(state))
        : null;
    if (initiativeActive && initiativeActive.side === 'player') return initiativeActive;
    if (current && !current.fled) return current;
    return state.units.find(unit => unit.side === 'player' && !unit.defeated && !unit.fled)
        || state.units.find(unit => !unit.defeated && !unit.fled)
        || null;
}

function skillResourceUsed(unit, skill) {
    return skill?.bonusAction ? !!unit?.bonusUsed : !!unit?.actionUsed;
}

function itemTargetCells(state, unit, item) {
    const cells = new Set();
    if (!unit || !item) return cells;
    const special = item.kind === 'special';
    for (const target of state.units) {
        if (target.defeated || target.fled) continue;
        if (!special && (!['player', 'ally'].includes(target.side) || !['player', 'ally'].includes(unit.side))) continue;
        const distance = target.id === unit.id ? 0 : Math.max(Math.abs(target.x - unit.x), Math.abs(target.y - unit.y));
        if (distance <= (Number(item.range) || 0)) cells.add(`${target.x},${target.y}`);
    }
    return cells;
}

/**
 * Build the pure markup view for the current encounter.
 * @param {object} state
 * @returns {object}
 */
export function buildTacticalView(state) {
    const settings = getSettings();
    const view = {
        ...ui.view,
        actionCatalog: state.actionCatalog || [],
        showCoords: !!settings.tacticalCombatShowCoordinates,
        compact: typeof window !== 'undefined' && window.innerWidth <= 640,
        activeUnitId: activeUnitId(state),
    };
    let selected = pickSelectedUnit(state);
    if (state.turnStyle === 'initiative' && state.phase === 'player') {
        const active = state.units.find(unit => unit.id === activeUnitId(state));
        if (active?.side === 'player') selected = active;
    }
    if (!selected) {
        view.selectedUnitId = '';
        view.reachableCells = new Set();
        view.targetCells = new Set();
        return view;
    }
    view.selectedUnitId = selected.id;
    view.mode = ui.view.mode || 'move';

    if (view.selectedSkillId && !(selected.skills || []).some(skill => skill.id === view.selectedSkillId)) {
        view.selectedSkillId = '';
    }
    if (view.selectedItemId && !(selected.items || []).some(item => item.id === view.selectedItemId)) {
        view.selectedItemId = '';
    }

    const canAct = state.status === 'active'
        && state.phase === 'player'
        && selected.side === 'player'
        && !selected.defeated
        && !selected.fled
        && !selected.doneForRound
        && !ui.view.busy
        && (state.turnStyle !== 'initiative' || activeUnitId(state) === selected.id);

    const reachable = new Set();
    const targets = new Set();
    if (canAct) {
        if (view.mode === 'move') {
            const budget = (Number(selected.speed) || 0) - (Number(selected.movementUsed) || 0);
            if (budget > 0) {
                for (const key of computeReachableCells(state, selected).keys()) reachable.add(key);
            }
        } else if (view.mode === 'attack') {
            if (!selected.actionUsed) {
                const options = describeUnitOptions(state, selected);
                for (const id of options.attackTargets) {
                    const target = state.units.find(unit => unit.id === id);
                    if (target) targets.add(`${target.x},${target.y}`);
                }
            }
        } else if (view.mode === 'skill') {
            const skill = (selected.skills || []).find(entry => entry.id === view.selectedSkillId);
            if (skill && skill.uses > 0 && !skillResourceUsed(selected, skill)) {
                if (skill.kind === 'special') {
                    for (const target of state.units) {
                        if (target.defeated || target.fled) continue;
                        const distance = target.id === selected.id ? 0 : Math.max(Math.abs(target.x - selected.x), Math.abs(target.y - selected.y));
                        if (distance <= (Number(skill.range) || 6)) targets.add(`${target.x},${target.y}`);
                    }
                } else {
                    const options = describeUnitOptions(state, selected);
                    for (const id of options.skillTargets?.[skill.id] || []) {
                        const target = state.units.find(unit => unit.id === id);
                        if (target) targets.add(`${target.x},${target.y}`);
                    }
                }
            }
        } else if (view.mode === 'item') {
            const item = (selected.items || []).find(entry => entry.id === view.selectedItemId);
            if (item && item.uses > 0 && !selected.actionUsed) {
                for (const key of itemTargetCells(state, selected, item)) targets.add(key);
            }
        }
    }
    view.reachableCells = reachable;
    view.targetCells = targets;
    return view;
}

function ensureOverlay() {
    if (ui.overlay && document.body.contains(ui.overlay)) return ui.overlay;
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'rt-tc-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Tactical Combat');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `<div class="rt-tc-host" id="${HOST_ID}"></div>`;
    overlay.addEventListener('click', onOverlayClick);
    document.body.appendChild(overlay);
    ui.overlay = overlay;
    return overlay;
}

function centerGridOnSelected(wrap, host) {
    if (!wrap || !host) return;
    const cell = host.querySelector('.rt-tc-cell.is-selected')
        || host.querySelector('.rt-tc-cell.is-active')
        || host.querySelector('.rt-tc-token[data-tc-select-unit]')?.closest?.('.rt-tc-cell');
    if (!cell) return;
    const wrapRect = wrap.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    if (!wrapRect.width || !wrapRect.height) return;
    wrap.scrollLeft = Math.max(0, wrap.scrollLeft + cellRect.left - wrapRect.left - wrapRect.width / 2 + cellRect.width / 2);
    wrap.scrollTop = Math.max(0, wrap.scrollTop + cellRect.top - wrapRect.top - wrapRect.height / 2 + cellRect.height / 2);
}

function render() {
    if (!ui.overlay || !ui.overlayOpen) return;
    const host = ui.overlay.querySelector(`#${HOST_ID}`);
    if (!host) return;
    const previousWrap = host.querySelector('.rt-tc-grid-wrap');
    const previousScroll = previousWrap
        ? { left: previousWrap.scrollLeft, top: previousWrap.scrollTop }
        : null;
    const state = getState();
    const view = state
        ? buildTacticalView(state)
        : {
            ...ui.view,
            selectedUnitId: '',
            mode: 'move',
            reachableCells: new Set(),
            targetCells: new Set(),
            showCoords: !!getSettings().tacticalCombatShowCoordinates,
            compact: typeof window !== 'undefined' && window.innerWidth <= 640,
        };
    host.innerHTML = buildTacticalCombatMarkup(state, view);
    const wrap = host.querySelector('.rt-tc-grid-wrap');
    if (wrap) {
        if (ui.centerNextRender || !previousScroll) {
            centerGridOnSelected(wrap, host);
            ui.centerNextRender = false;
        } else {
            wrap.scrollLeft = previousScroll.left;
            wrap.scrollTop = previousScroll.top;
        }
    }
    const log = host.querySelector('.rt-tc-log-list');
    if (log) log.scrollTop = log.scrollHeight;
}

function openBoard() {
    const overlay = ensureOverlay();
    ui.overlayOpen = true;
    ui.centerNextRender = true;
    ui.view.error = '';
    ui.view.dismissResult = false;
    ui.view.mode = 'move';
    ui.view.selectedSkillId = '';
    ui.view.selectedItemId = '';
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('rt-tc-modal-open');
    render();
    setTimeout(() => overlay.querySelector('[data-tc-action="close"]')?.focus?.(), 40);
}

function closeBoard() {
    cancelAutoNarrate();
    if (!ui.overlay) return;
    ui.overlayOpen = false;
    ui.overlay.classList.remove('is-open');
    ui.overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('rt-tc-modal-open');
}

function openSettingsTab() {
    try {
        document.dispatchEvent(new CustomEvent('rt_open_settings_overlay', { detail: { tab: 'tactical' } }));
    } catch (_) { /* no-op */ }
}

function cancelAutoNarrate() {
    if (ui.autoNarrateTimer) {
        clearTimeout(ui.autoNarrateTimer);
        ui.autoNarrateTimer = null;
    }
}

function setBusy(busy, label = '', abortable = false) {
    ui.view.busy = !!busy;
    ui.view.busyLabel = label;
    ui.view.abortable = abortable;
    notifySettings();
}

function resetViewSelection() {
    ui.view.selectedUnitId = '';
    ui.view.mode = 'move';
    ui.view.selectedSkillId = '';
    ui.view.selectedItemId = '';
    ui.view.dismissResult = false;
    ui.view.error = '';
}

function selectUnit(unitId) {
    const state = getState();
    if (!state || ui.view.busy) return;
    const unit = state.units.find(candidate => candidate.id === unitId);
    if (!unit || unit.fled) return;
    const view = buildTacticalView(state);
    const key = `${unit.x},${unit.y}`;
    if (view.targetCells instanceof Set && view.targetCells.has(key)) {
        handleCellClick(unit.x, unit.y);
        return;
    }
    if (state.turnStyle === 'initiative' && state.phase === 'player'
        && unit.side === 'player' && unit.id !== activeUnitId(state)) {
        const active = state.units.find(candidate => candidate.id === activeUnitId(state));
        toast('warning', active ? `It is ${active.name}'s turn.` : 'Another unit is acting.');
        return;
    }
    ui.view.selectedUnitId = unit.id;
    ui.view.mode = 'move';
    ui.view.selectedSkillId = '';
    ui.view.selectedItemId = '';
    render();
}

function applyPlayerAction(action, { autoEndUnit = false } = {}) {
    const state = getState();
    const settings = getSettings();
    if (!state || state.status !== 'active') return false;
    if (ui.view.busy) return false;
    const result = applyAction(state, action, {
        actorSide: 'player',
        source: 'player',
        rng: createStateRng(state),
    });
    if (!result.ok) {
        toast('error', result.error || 'That action is not legal.');
        render();
        return false;
    }
    persist(state);
    if (result.ended) {
        finalizeIfEnded(state, settings);
        render();
        return true;
    }
    if (autoEndUnit) {
        handleEndTurn();
        return true;
    }
    render();
    return true;
}

function handleMove(x, y) {
    const view = buildTacticalView(getState());
    if (!view.selectedUnitId) return;
    return applyPlayerAction({ type: 'move', unitId: view.selectedUnitId, to: { x, y } });
}

function handleAttack(targetId) {
    const view = buildTacticalView(getState());
    if (!view.selectedUnitId) return;
    const ok = applyPlayerAction({ type: 'attack', unitId: view.selectedUnitId, targetId });
    if (ok && getState()?.status === 'active') {
        ui.view.mode = 'move';
        render();
    }
    return ok;
}

function handleSkill(targetId) {
    const state = getState();
    const view = buildTacticalView(state);
    if (!view.selectedUnitId || !view.selectedSkillId) {
        toast('info', 'Choose a skill first.');
        return false;
    }
    const unit = playerUnitById(state, view.selectedUnitId);
    const skill = (unit?.skills || []).find(entry => entry.id === view.selectedSkillId);
    if (skill?.kind === 'special') {
        void resolveSpecialPlayerAction('skill', skill, targetId || view.selectedUnitId);
        return true;
    }
    const ok = applyPlayerAction({
        type: 'skill',
        unitId: view.selectedUnitId,
        skillId: view.selectedSkillId,
        targetId: targetId || view.selectedUnitId,
    });
    if (ok) {
        ui.view.selectedSkillId = '';
        ui.view.mode = 'move';
        render();
    }
    return ok;
}

function handleItem(targetId) {
    const state = getState();
    const view = buildTacticalView(state);
    if (!view.selectedUnitId || !view.selectedItemId) {
        toast('info', 'Choose an item first.');
        return false;
    }
    const unit = playerUnitById(state, view.selectedUnitId);
    const item = (unit?.items || []).find(entry => entry.id === view.selectedItemId);
    if (item?.kind === 'special') {
        void resolveSpecialPlayerAction('item', item, targetId || view.selectedUnitId);
        return true;
    }
    const ok = applyPlayerAction({
        type: 'item',
        unitId: view.selectedUnitId,
        itemId: view.selectedItemId,
        targetId: targetId || view.selectedUnitId,
    });
    if (ok) {
        ui.view.selectedItemId = '';
        ui.view.mode = 'move';
        render();
    }
    return ok;
}

/**
 * Resolve a freeform ability/item through one compact agent call, then let the
 * pure engine apply the returned primitives. Ordinary abilities never take this
 * path, so token usage stays limited to genuinely unusual effects.
 */
async function resolveSpecialPlayerAction(sourceKind, source, targetId) {
    if (ui.view.busy) return;
    const state = getState();
    const settings = getSettings();
    if (!state) return;
    const view = buildTacticalView(state);
    const caster = playerUnitById(state, view.selectedUnitId);
    if (!caster) return;
    if (sourceKind === 'skill' && skillResourceUsed(caster, source)) {
        toast('warning', source.bonusAction ? 'The bonus action is already spent.' : 'The action is already spent.');
        return;
    }
    if (sourceKind === 'item' && caster.actionUsed) {
        toast('warning', 'The main action is already spent.');
        return;
    }
    if (source.uses <= 0) {
        toast('warning', `${source.name} has no uses left.`);
        return;
    }
    const target = state.units.find(unit => unit.id === (targetId || caster.id)) || caster;
    const chatId = getActiveChatId();
    const controller = new AbortController();
    ui.abortController = controller;
    setBusy(true, `Resolving ${source.name}…`, true);
    render();
    try {
        const resolved = await resolveSpecialEffectWithAgent(
            state,
            caster,
            {
                kind: sourceKind,
                name: source.name,
                description: source.description || source.amount || '',
            },
            target,
            settings,
            { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (getActiveChatId() !== chatId || getState() !== state) return;
        if (!resolved.ok) {
            toast('error', resolved.error || `Could not resolve ${source.name}.`);
            return;
        }
        const applied = applySpecialEffects(state, resolved.effects, {
            casterId: caster.id,
            skillId: sourceKind === 'skill' ? source.id : undefined,
            itemId: sourceKind === 'item' ? source.id : undefined,
            label: source.name,
            narrative: resolved.log || '',
            rng: createStateRng(state),
        });
        if (!applied.ok) {
            toast('error', applied.error || `${source.name} had no legal effect.`);
            return;
        }
        ui.view.selectedSkillId = '';
        ui.view.selectedItemId = '';
        ui.view.mode = 'move';
        persist(state);
        render();
        if (applied.ended) finalizeIfEnded(state, settings);
    } catch (error) {
        if (getActiveChatId() === chatId) {
            console.warn('[RPG Tracker] Special ability resolution failed:', error);
            toast('error', `Could not resolve ${source.name}: ${error?.message || error}`);
        }
    } finally {
        if (ui.abortController === controller) ui.abortController = null;
        setBusy(false);
        render();
    }
}

function handleCellClick(x, y) {
    const state = getState();
    if (!state || state.status !== 'active' || ui.view.busy) return;
    const key = `${x},${y}`;
    const unit = state.units.find(candidate => candidate.x === x && candidate.y === y && !candidate.fled) || null;
    const view = buildTacticalView(state);

    if (view.mode === 'attack' && unit && view.targetCells.has(key)) {
        handleAttack(unit.id);
        return;
    }
    if (view.mode === 'skill' && view.targetCells.has(key)) {
        handleSkill(unit?.id || view.selectedUnitId);
        return;
    }
    if (view.mode === 'item' && view.targetCells.has(key)) {
        handleItem(unit?.id || view.selectedUnitId);
        return;
    }
    if (view.mode === 'move' && !unit && view.reachableCells.has(key)) {
        handleMove(x, y);
        return;
    }
    if (unit) {
        selectUnit(unit.id);
        return;
    }
    if (view.mode === 'move') toast('info', 'That cell is out of movement range.');
}

function handleMode(mode) {
    const state = getState();
    if (!state || state.status !== 'active' || ui.view.busy) return;
    ui.view.mode = mode;
    if (mode !== 'skill') ui.view.selectedSkillId = '';
    if (mode !== 'item') ui.view.selectedItemId = '';
    render();
}

function handleSelectSkill(skillId) {
    const state = getState();
    const view = buildTacticalView(state);
    const unit = playerUnitById(state, view.selectedUnitId);
    if (!unit) return;
    const skill = (unit.skills || []).find(entry => entry.id === skillId);
    if (!skill || skill.uses <= 0) {
        toast('warning', 'That skill has no uses left.');
        return;
    }
    if (skillResourceUsed(unit, skill)) {
        toast('warning', skill.bonusAction ? 'The bonus action is already spent.' : 'The action is already spent.');
        return;
    }
    ui.view.selectedSkillId = skill.id;
    ui.view.selectedItemId = '';
    ui.view.mode = 'skill';
    render();
}

function handleSelectItem(itemId) {
    const state = getState();
    const view = buildTacticalView(state);
    const unit = playerUnitById(state, view.selectedUnitId);
    if (!unit) return;
    const item = (unit.items || []).find(entry => entry.id === itemId);
    if (!item || item.uses <= 0) {
        toast('warning', 'That item has no uses left.');
        return;
    }
    if (unit.actionUsed) {
        toast('warning', 'The main action is already spent.');
        return;
    }
    ui.view.selectedItemId = item.id;
    ui.view.selectedSkillId = '';
    ui.view.mode = 'item';
    render();
}

function finishEncounter(state, settings, options = {}) {
    return finalizeIfEnded(state, settings, options);
}

function finalizeIfEnded(state, settings = getSettings(), options = {}) {
    if (!state || state.status === 'active') return false;
    const chatId = getActiveChatId();
    if (!chatId) return true;
    if (!state.finalization?.narrationQueued) {
        queueCombatOutcome(state, settings, { persist: false, refresh: true });
        setEncounterForChat(chatId, state, settings);
        notifySettings();
        if (settings.tacticalCombatAutoNarrate && options.autoNarrate !== false && !state.finalization.autoNarrateStarted) {
            state.finalization.autoNarrateStarted = true;
            setEncounterForChat(chatId, state, settings);
            notifySettings();
            cancelAutoNarrate();
            ui.autoNarrateTimer = setTimeout(() => {
                ui.autoNarrateTimer = null;
                if (getActiveChatId() !== chatId) return;
                const latest = getEncounterForChat(chatId, getSettings());
                if (!latest || latest.id !== state.id) return;
                closeBoard();
                void continueToNarration(getSettings()).then(ok => {
                    if (!ok) toast('info', 'The result is queued. Send your next message to continue the story.');
                });
            }, AUTO_NARRATE_DELAY_MS);
        }
    }
    render();
    return true;
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
    const catalog = getActionCatalog(settings).catalog;

    try {
        for (let pass = 0; pass < 6 && state.status === 'active'; pass += 1) {
            const currentPending = getPendingAgentUnitIds(state);
            if (!currentPending.length) break;
            const result = await runAgentTurn(state, currentPending, settings, {
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
            console.warn('[RPG Tracker] Tactical Combat agent turn failed:', error);
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
        completeAgentTurn(state, createStateRng(state));
        persist(state);
        if (state.status !== 'active') finishEncounter(state, settings);
        else render();
        return;
    }
    const result = endTurn(state, createStateRng(state));
    persist(state);
    render();
    if (state.status !== 'active') {
        finishEncounter(state, settings);
        return;
    }
    if (result.agentUnitIds?.length) {
        void runEnemyTurnForState(state, settings);
    }
}

function handleRetreat() {
    const state = getState();
    const settings = getSettings();
    if (!state || state.status !== 'active' || ui.view.busy) return;
    if (typeof globalThis.confirm === 'function'
        && !globalThis.confirm('Retreat from this encounter? Surviving player units withdraw.')) {
        return;
    }
    if (!retreatEncounter(state)) return;
    persist(state);
    finishEncounter(state, settings);
    render();
}

function abortAgent() {
    if (ui.abortController) {
        ui.abortController.abort();
        ui.abortController = null;
    }
    ui.agentRunToken += 1;
    setBusy(false);
    render();
    toast('info', 'Agent turn stopped. You can resolve the enemy turn again.');
}

function exportState() {
    const state = getState();
    if (!state) {
        toast('warning', 'There is no encounter to export.');
        return;
    }
    const unitIds = getPendingAgentUnitIds(state);
    const ids = unitIds.length ? unitIds : state.units.filter(unit => unit.side !== 'player' && !unit.defeated && !unit.fled).map(unit => unit.id);
    const json = serializeAgentGameState(state, ids);
    const name = `tactical-combat-${String(state.id || 'state').replace(/[^a-z0-9-]+/gi, '-')}.json`;
    try {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('success', 'Game state downloaded as JSON.');
    } catch (error) {
        void copyText(json).then(copied => {
            toast(copied ? 'success' : 'error', copied
                ? 'Download was blocked, so the JSON was copied to your clipboard.'
                : `Could not export the state: ${error?.message || error}`);
        });
    }
}

async function copyText(text) {
    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (_) { /* fall through */ }
    return false;
}

async function startEncounterFlow(options = {}) {
    const settings = getSettings();
    if (!settings.tacticalCombatEnabled) {
        toast('warning', 'Enable Tactical Combat in Settings → Tactical Combat first.');
        openSettingsTab();
        return { ok: false, error: 'Tactical Combat is disabled.' };
    }
    const existing = getState();
    if (existing?.status === 'active') {
        openBoard();
        toast('info', 'That encounter is already in progress.');
        return { ok: true, alreadyActive: true, state: existing };
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
    const controller = new AbortController();
    ui.abortController = controller;

    const source = String(options.source || settings.tacticalCombatEncounterSource || 'auto');
    let context;
    try {
        context = collectEncounterContext(settings, (() => {
            try { return SillyTavern.getContext(); } catch (_) { return {}; }
        })());
    } catch (error) {
        if (ui.abortController === controller) ui.abortController = null;
        ui.starting = false;
        setBusy(false);
        ui.view.error = `Could not read the current scene: ${error?.message || error}`;
        render();
        toast('error', ui.view.error);
        return { ok: false, error: ui.view.error };
    }
    context.chatId = getActiveChatId() || context.chatId;
    if (options.location) {
        context.location = String(options.location).slice(0, 200);
        context.theme = inferTerrainTheme(context.location, context.sceneExcerpt);
    }
    if (options.reason) context.sceneExcerpt = `${context.sceneExcerpt || ''}\nNarrator trigger: ${String(options.reason).slice(0, 300)}`.trim();
    if (!context.chatId) {
        if (ui.abortController === controller) ui.abortController = null;
        ui.starting = false;
        setBusy(false);
        ui.view.error = 'Open a chat before starting a tactical encounter.';
        render();
        return { ok: false, error: ui.view.error };
    }

    let agentEncounter = null;
    let warnings = [];
    const needsAgent = source === 'agent' || (source === 'auto' && !context.existingCombat);
    if (needsAgent) {
        setBusy(true, 'The combat agent is designing the encounter…', true);
        render();
        const generated = await generateEncounterWithAgent(context, settings, { signal: controller.signal });
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

    if (source === 'existing' && !context.existingCombat) {
        if (ui.abortController === controller) ui.abortController = null;
        ui.starting = false;
        setBusy(false);
        ui.view.error = 'No active [COMBAT] enemies were found. Switch Encounter source to Auto or Agent to generate opposition.';
        render();
        toast('error', ui.view.error);
        return { ok: false, error: ui.view.error };
    }

    const catalogResult = getActionCatalog(settings);
    if (catalogResult.error) {
        toast('warning', `Action catalogue error: ${catalogResult.error} Shipped actions were used.`);
    }

    try {
        const built = buildEncounterFromContext(context, settings, {
            agentEncounter,
            source,
            seed: Math.floor(Math.random() * 0x7fffffff),
            actionCatalog: catalogResult.catalog,
        });
        warnings = [...warnings, ...(built.warnings || [])];
        const state = built.state;
        if (options.title) state.title = String(options.title).slice(0, 140);
        if (options.location) state.location = String(options.location).slice(0, 200);
        if (options.description) state.description = String(options.description).slice(0, 4000);
        if (options.reason && !options.description) {
            state.description = `${state.description || ''}\n\nTrigger: ${String(options.reason).slice(0, 300)}`.trim();
        }
        persist(state);
        ui.starting = false;
        setBusy(false);
        resetViewSelection();
        ui.centerNextRender = true;
        render();
        toast('success', warnings.length ? `Encounter ready. ${warnings[0]}` : 'Encounter ready.');
        if (state.status !== 'active') {
            finishEncounter(state, settings, { autoNarrate: !options.fromNarrator });
        } else if (state.phase === 'enemy' && getPendingAgentUnitIds(state).length) {
            // Never call the combat agent from inside the narrator's tool call:
            // it would make a nested provider request while the main generation is
            // still running (a common source of 503s). The board's "Resolve enemy
            // turn" button handles it once the narration finishes.
            if (!options.fromNarrator) void runEnemyTurnForState(state, settings);
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
            abortAgent();
            break;
        case 'mode-move':
            handleMode('move');
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
        case 'defend':
            applyPlayerAction({ type: 'defend', unitId: buildTacticalView(getState()).selectedUnitId });
            break;
        case 'wait':
            applyPlayerAction(
                { type: 'wait', unitId: buildTacticalView(getState()).selectedUnitId },
                { autoEndUnit: getState()?.turnStyle === 'initiative' },
            );
            break;
        case 'flee':
            applyPlayerAction(
                { type: 'flee', unitId: buildTacticalView(getState()).selectedUnitId },
                { autoEndUnit: getState()?.turnStyle === 'initiative' },
            );
            break;
        case 'select-skill':
            handleSelectSkill(element?.dataset?.tcSkillId || '');
            break;
        case 'select-item':
            handleSelectItem(element?.dataset?.tcItemId || '');
            break;
        case 'continue-narration':
            cancelAutoNarrate();
            closeBoard();
            void continueToNarration(getSettings()).then(ok => {
                if (!ok) toast('info', 'The result is queued. Send your next message to continue the story.');
            });
            break;
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
    const actionEl = event.target.closest?.('[data-tc-action]');
    if (actionEl && ui.overlay?.contains(actionEl)) {
        event.preventDefault();
        handleOverlayAction(actionEl.dataset.tcAction, actionEl);
        return;
    }
    const unitEl = event.target.closest?.('[data-tc-select-unit]');
    if (unitEl && ui.overlay?.contains(unitEl)) {
        event.preventDefault();
        selectUnit(unitEl.dataset.tcSelectUnit);
        return;
    }
    const cellEl = event.target.closest?.('[data-tc-cell]');
    if (cellEl && ui.overlay?.contains(cellEl)) {
        event.preventDefault();
        const [x, y] = String(cellEl.dataset.tcCell || '').split(',').map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) handleCellClick(x, y);
    }
}

function onDocumentClick(event) {
    const trigger = event.target.closest?.('#rt-tactical-combat-btn, [data-tc-open-board]');
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

/**
 * Install once after the runtime bridge is configured.
 */
export function installTacticalCombatUi() {
    if (ui.installed) return;
    ui.installed = true;
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('rt_open_tactical_combat', openBoard);
}

/**
 * Called from CHAT_CHANGED. Aborts work for the departing chat and redraws the
 * board for the arriving chat (or shows the empty state).
 * @param {string} [chatId]
 */
export function onTacticalCombatChatChanged(chatId = getActiveChatId()) {
    if (ui.abortController) {
        ui.abortController.abort();
        ui.abortController = null;
    }
    ui.agentRunToken += 1;
    ui.starting = false;
    cancelAutoNarrate();
    setBusy(false);
    resetViewSelection();
    ui.centerNextRender = true;
    notifySettings();
    if (ui.overlayOpen) render();
}

/**
 * Board entry point used by the settings tab and the tracker header button.
 */
export function openTacticalCombatBoard() {
    openBoard();
}

/**
 * Settings-tab "Start encounter" entry point.
 * @param {{ title?: string, location?: string, description?: string, reason?: string, silentNew?: boolean }} [options]
 */
export function startTacticalCombatFlow(options = {}) {
    return startEncounterFlow(options);
}

/**
 * Narrator function-tool entry point. Opens/focuses the board, starts or resumes
 * the encounter, and returns a short status message for the model.
 * @param {{ title?: string, location?: string, description?: string, reason?: string }} [args]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function startTacticalCombatFromNarrator(args = {}, options = {}) {
    const settings = getSettings();
    if (!settings.tacticalCombatEnabled) {
        return {
            ok: false,
            message: 'Tactical Combat is disabled. Ask the player to enable it in Settings → Tactical Combat.',
        };
    }
    const result = await startEncounterFlow({
        title: args.title,
        location: args.location,
        description: args.description,
        reason: args.reason,
        silentNew: true,
        source: options.source || 'existing',
        fromNarrator: true,
    });
    if (!result.ok) {
        return {
            ok: false,
            message: result.error || (result.cancelled ? 'Encounter start was cancelled.' : 'Could not start the tactical encounter.'),
        };
    }
    openBoard();
    const state = result.state || getState();
    if (result.alreadyActive) {
        return { ok: true, message: `A tactical encounter is already active (${state?.title || 'encounter'}); the board is open.` };
    }
    return {
        ok: true,
        message: `Tactical encounter ${state?.status === 'active' ? 'started' : (state?.outcome?.label || 'prepared')}: ${state?.title || 'encounter'}. The board is open; resolve the fight on the grid and the result will return to narration when it ends.`,
    };
}

/**
 * Settings-tab / board stop button.
 */
export function stopTacticalCombatAgent() {
    abortAgent();
}

/** True while an encounter/agent request is in flight. */
export function isTacticalCombatBusy() {
    return !!ui.view.busy || !!ui.starting;
}

/**
 * Re-render after a relevant setting changes (e.g. coordinates on/off).
 */
export function refreshTacticalCombatUi() {
    if (ui.overlayOpen) render();
}

/**
 * Start a fresh encounter for the current chat, discarding the saved board.
 */
export function resetTacticalCombatEncounter() {
    const chatId = getActiveChatId();
    if (!chatId) return;
    cancelAutoNarrate();
    removeEncounterForChat(chatId, getSettings());
    resetViewSelection();
    setBusy(false);
    notifySettings();
    if (ui.overlayOpen) render();
}
