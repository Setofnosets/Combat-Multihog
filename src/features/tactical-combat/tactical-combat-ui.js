/**
 * tactical-combat-ui.js — DOM controller for the tactical board.
 *
 * The board is a single delegated overlay so re-rendering 400 cells does not
 * leak listeners. All game mutations go through the pure engine; this file owns
 * selection, targeting, async agent turns, persistence, and the narration handoff.
 */

import { getActiveChatId, getSettings } from '../../../state-manager.js';
import {
    addLog,
    applyAction,
    applyOpeningAction,
    applySpecialEffects,
    applySurprise,
    beginDeployment,
    buildOutcomeSummary,
    completeAgentTurn,
    computeReachableCells,
    createStateRng,
    deployUnit,
    describeUnitOptions,
    endTurn,
    finishDeployment,
    getDeploymentCells,
    getPendingAgentUnitIds,
    prepareSpecialAction,
    resolveEffectTemplate,
    restoreCombatScopedState,
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
    normalizeSpecialEffects,
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
import {
    buildCombatTrackerReport,
    clearStaleCombatMemo,
    seedCombatMemo,
    syncCombatResultToMemo,
} from './tactical-combat-memo.js';

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
    architectTimer: null,
    architectStateId: '',
    architectToken: 0,
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

/**
 * Return the interactable unit on a cell. Defeated combatants are scenery and
 * must never capture clicks, block movement, or become attack targets.
 * @param {object} state
 * @param {number} x
 * @param {number} y
 * @returns {object|null}
 */
export function liveUnitAtCell(state, x, y) {
    return state?.units?.find(unit => unit.x === x && unit.y === y && !unit.defeated && !unit.fled) || null;
}

function pickSelectedUnit(state) {
    const current = state.units.find(unit => unit.id === ui.view.selectedUnitId);
    const initiativeActive = state.turnStyle === 'initiative' && state.phase === 'player'
        ? state.units.find(unit => unit.id === activeUnitId(state))
        : null;
    if (initiativeActive && initiativeActive.side === 'player') return initiativeActive;
    if (current && !current.fled && !current.defeated) return current;
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
        const targetRule = item.target || 'ally';
        const targetIsFriendly = ['player', 'ally'].includes(target.side) && ['player', 'ally'].includes(unit.side);
        const targetIsHostile = (unit.side === 'enemy' && ['player', 'ally'].includes(target.side))
            || (['player', 'ally'].includes(unit.side) && target.side === 'enemy');
        if (!special && targetRule === 'ally' && !targetIsFriendly) continue;
        if (!special && targetRule === 'enemy' && !targetIsHostile) continue;
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
    view.deploymentActive = !!state.deployment?.active;

    if (view.deploymentActive) {
        view.mode = 'deploy';
        view.reachableCells = new Set(getDeploymentCells(state).map(cell => `${cell.x},${cell.y}`));
        view.targetCells = new Set();
        return view;
    }

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

function cancelArchitectPreparation() {
    if (ui.architectTimer) {
        clearTimeout(ui.architectTimer);
        ui.architectTimer = null;
    }
    ui.architectStateId = '';
    ui.architectToken += 1;
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
    if (!unit || unit.fled || unit.defeated) return;
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

function handleDeploy(x, y) {
    const state = getState();
    if (!state?.deployment?.active || ui.view.busy) return false;
    const view = buildTacticalView(state);
    if (!view.selectedUnitId) return false;
    const result = deployUnit(state, view.selectedUnitId, x, y);
    if (!result.ok) {
        toast('warning', result.error || 'That deployment cell is unavailable.');
        return false;
    }
    persist(state);
    render();
    return true;
}

function handleStartBattle() {
    const state = getState();
    const settings = getSettings();
    if (!state?.deployment?.active || ui.view.busy) return;
    if (!finishDeployment(state)) return;
    ui.view.mode = 'move';
    persist(state);
    render();
    if (state.status !== 'active') {
        finishEncounter(state, settings);
        return;
    }
    if (state.phase === 'enemy' && getPendingAgentUnitIds(state).length) {
        toast('info', 'Deployment complete. The enemy acts first.');
    }
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
    const prepared = prepareSpecialAction(state, {
        type: sourceKind,
        unitId: caster.id,
        ...(sourceKind === 'skill' ? { skillId: source.id } : { itemId: source.id }),
        targetId: target.id,
    }, { actorSide: 'player' });
    if (!prepared.ok) {
        toast('error', prepared.error || `${source.name} cannot be used that way.`);
        render();
        return;
    }
    const chatId = getActiveChatId();
    const controller = new AbortController();
    ui.abortController = controller;
    setBusy(true, `Resolving ${source.name}…`, true);
    render();
    try {
        let resolved;
        if (Array.isArray(prepared.skill?.effectTemplate) || Array.isArray(prepared.item?.effectTemplate)) {
            const template = prepared.skill?.effectTemplate || prepared.item?.effectTemplate;
            const effects = resolveEffectTemplate(template, { casterId: prepared.unit.id, targetId: prepared.target.id });
            const normalized = normalizeSpecialEffects({ effects }, state);
            resolved = normalized.effects.length
                ? { ok: true, effects: normalized.effects, log: '' }
                : { ok: false, error: normalized.rejected.join(' ') || 'The effect template had no legal effects.' };
        } else {
            resolved = await resolveSpecialEffectWithAgent(
                state,
                prepared.unit,
                {
                    kind: sourceKind,
                    name: source.name,
                    description: source.description || source.amount || '',
                    resource: source.resource,
                    willpowerOutcome: source.willpowerOutcome,
                },
                prepared.target,
                settings,
                { signal: controller.signal },
            );
        }
        if (controller.signal.aborted) return;
        if (getActiveChatId() !== chatId || getState() !== state) return;
        if (!resolved.ok) {
            toast('error', resolved.error || `Could not resolve ${source.name}.`);
            return;
        }
        const applied = applySpecialEffects(state, resolved.effects, {
            casterId: prepared.unit.id,
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
    const unit = liveUnitAtCell(state, x, y);
    const view = buildTacticalView(state);

    if (state.deployment?.active) {
        if (unit) selectUnit(unit.id);
        else if (view.reachableCells.has(key)) handleDeploy(x, y);
        return;
    }

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

function scheduleAutoNarration(state, settings, options = {}) {
    const chatId = getActiveChatId();
    if (!chatId || !state || state.finalization?.autoNarrateStarted) return;
    state.finalization.autoNarrateStarted = true;
    setEncounterForChat(chatId, state, settings);
    notifySettings();
    cancelAutoNarrate();
    ui.autoNarrateTimer = setTimeout(() => {
        ui.autoNarrateTimer = null;
        if (getActiveChatId() !== chatId) return;
        const latest = getEncounterForChat(chatId, getSettings());
        if (!latest || latest.id !== state.id || latest.finalization?.finalizing) return;
        closeBoard();
        void continueToNarration(getSettings()).then(ok => {
            if (!ok) toast('info', 'The result is queued. Send your next message to continue the story.');
        });
    }, AUTO_NARRATE_DELAY_MS);
}

async function runCombatFinalization(state, settings, options = {}) {
    const chatId = getActiveChatId();
    if (!chatId || !state || state.status === 'active') return true;
    if (state.finalization?.narrationQueued) return true;
    if (narratorGenerationBusy()) {
        if (!state.finalization?.waitingForNarration) {
            state.finalization = {
                ...(state.finalization || {}),
                finalizing: true,
                waitingForNarration: true,
                stage: 'waiting-for-narration',
                finalizingStartedAt: state.finalization?.finalizingStartedAt || Date.now(),
            };
            setEncounterForChat(chatId, state, settings);
            notifySettings();
            setTimeout(() => {
                if (getActiveChatId() !== chatId) return;
                const latest = getEncounterForChat(chatId, getSettings());
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
    setEncounterForChat(chatId, state, settings);
    notifySettings();
    render();

    try {
        const stateTrackerBusy = typeof globalThis._rpgStateModelRunning === 'function'
            && globalThis._rpgStateModelRunning();
        const canSync = settings.enabled
            && !stateTrackerBusy
            && settings.tacticalCombatSyncTrackerBeforeNarration !== false
            && typeof globalThis._rpgRunStateModelPass === 'function';
        if (canSync) {
            setBusy(true, 'Updating the State Tracker with the final combat state…');
            render();
            await globalThis._rpgRunStateModelPass('', false, null, {
                extraContext: buildCombatTrackerReport(state, {
                    recoverWillpower: settings.tacticalCombatWillpowerRecoverAfterCombat !== false,
                }),
                extraInstruction: 'The tactical board is authoritative. Apply this final state to the memo, close [COMBAT], and do not re-adjudicate the encounter.',
                timeoutMs: 30000,
            });
        }
    } catch (error) {
        console.warn('[RPG Tracker] Tactical Combat tracker finalization failed:', error);
    } finally {
        setBusy(false);
    }

    if (getActiveChatId() !== chatId) return true;
    const latest = getEncounterForChat(chatId, getSettings());
    if (!latest || latest.id !== state.id) return true;

    // Re-apply the deterministic end state. A tracker pass may have emitted a
    // partial [COMBAT] block, but it must never leave dead enemies active.
    syncCombatResultToMemo(latest, settings);
    queueCombatOutcome(latest, settings, { persist: false, refresh: true });
    latest.finalization = {
        ...(latest.finalization || {}),
        finalizing: false,
        stage: 'queued',
        finalizedAt: Date.now(),
    };
    setEncounterForChat(chatId, latest, settings);
    notifySettings();
    render();

    if (settings.tacticalCombatAutoNarrate && options.autoNarrate !== false) {
        scheduleAutoNarration(latest, settings, options);
    }
    return true;
}

function finalizeIfEnded(state, settings = getSettings(), options = {}) {
    if (!state || state.status === 'active') return false;
    const chatId = getActiveChatId();
    if (!chatId) return true;
    const finalizingStartedAt = Number(state.finalization?.finalizingStartedAt) || 0;
    const staleFinalization = !!state.finalization?.finalizing
        && finalizingStartedAt > 0
        && Date.now() - finalizingStartedAt > 90000;
    if (staleFinalization) {
        state.finalization = { ...(state.finalization || {}), finalizing: false, waitingForNarration: false };
    }
    if (!state.finalization?.narrationQueued && (!state.finalization?.finalizing || staleFinalization)) {
        void runCombatFinalization(state, settings, options);
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
    const state = getState();
    const preparing = !!state?.preparing?.active;
    if (ui.abortController) {
        ui.abortController.abort();
        ui.abortController = null;
    }
    ui.agentRunToken += 1;
    if (preparing) {
        cancelArchitectPreparation();
        void finalizePreparedEncounter(state, getSettings(), state.preparing.options || {}, {
            error: 'The encounter architect was stopped; the local roster was used.',
        });
        return;
    }
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

/**
 * Remove a concluded board and any memo roster that provably belonged to it.
 * Active boards are never cleared; the tool should reopen those instead.
 */
function clearEndedEncounterForFreshStart(existing, settings) {
    if (!existing || existing.status === 'active') return false;
    const chatId = existing.chatId || getActiveChatId();
    if (chatId) removeEncounterForChat(chatId, settings, { persist: false });
    settings.combatDefeatedUi = [];
    clearStaleCombatMemo(existing, settings);
    cancelAutoNarrate();
    cancelArchitectPreparation();
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
        context.theme = inferTerrainTheme(context.location, context.sceneExcerpt);
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
    actor.movementUsed = 0;
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
    setBusy(true, 'Resolving the opening action…');
    persist(state);
    render();
    try {
        const source = item
            ? { kind: 'item', name: item.name, description: item.description || state.opening.text, resource: item.resource, willpowerOutcome: item.willpowerOutcome }
            : { kind: 'skill', name: skill?.name || 'Opening action', description: skill?.description || state.opening.text, resource: skill?.resource, willpowerOutcome: skill?.willpowerOutcome };
        let resolved;
        if (Array.isArray(skill?.effectTemplate) || Array.isArray(item?.effectTemplate)) {
            const template = skill?.effectTemplate || item?.effectTemplate;
            const effects = resolveEffectTemplate(template, { casterId: actor.id, targetId: target?.id || actor.id });
            const normalized = normalizeSpecialEffects({ effects }, state);
            resolved = normalized.effects.length
                ? { ok: true, effects: normalized.effects, log: '' }
                : { ok: false, error: normalized.rejected.join(' ') || 'The effect template had no legal effects.' };
        } else {
            resolved = await resolveSpecialEffectWithAgent(state, actor, source, target, settings, {
                signal: options.signal || null,
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
        const latest = getEncounterForChat(chatId, getSettings());
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

function applyEncounterOptionsToState(state, settings, options, context, warnings = [], behavior = {}) {
    if (options.title) state.title = String(options.title).slice(0, 140);
    if (options.location) state.location = String(options.location).slice(0, 200);
    if (options.description) state.description = String(options.description).slice(0, 4000);
    if (options.reason && !options.description) {
        state.description = `${state.description || ''}\n\nTrigger: ${String(options.reason).slice(0, 300)}`.trim();
    }

    let openingNeedsAgent = false;
    if (settings.tacticalCombatOpeningActions !== false) {
        const opening = buildOpeningRequest(options);
        if (opening) {
            const openingResult = applyOpeningAction(state, opening, { rng: createStateRng(state) });
            if (openingResult.requiresAgent) openingNeedsAgent = true;
            else if (!openingResult.ok && openingResult.error) {
                warnings.push(`Opening action was not resolved automatically: ${openingResult.error}`);
            }
        } else if (options.surprise === true) {
            applySurprise(state, 'player');
        }
    }

    if (behavior.seedMemo !== false) seedCombatMemo(state, settings);
    if (state.status === 'active'
        && settings.tacticalCombatDeploymentPhase !== false
        && !state.opening) {
        beginDeployment(state);
    }
    void context;
    return openingNeedsAgent;
}

function finalizePreparedEncounter(provisional, settings, options = {}, payload = {}) {
    if (!provisional || provisional.status !== 'active' || !provisional.preparing?.active) return false;
    const chatId = provisional.chatId || getActiveChatId();
    if (!chatId) return false;
    const warnings = [...(provisional.preparing.warnings || [])];
    if (payload.error) warnings.push(String(payload.error));

    let next = provisional;
    if (payload.encounter?.enemies?.length) {
        try {
            const context = payload.context || collectStartContext(settings, options);
            const catalog = getActionCatalog(settings).catalog;
            const built = buildEncounterFromContext(context, settings, {
                agentEncounter: payload.encounter,
                source: options.source || settings.tacticalCombatEncounterSource || 'auto',
                seed: Math.floor(Math.random() * 0x7fffffff),
                actionCatalog: catalog,
            });
            next = built.state;
            warnings.push(...(built.warnings || []));
            next.id = provisional.id;
            next.createdAt = provisional.createdAt;
            next.chatId = provisional.chatId;
        } catch (error) {
            warnings.push(`Encounter architect result could not be applied: ${error?.message || error}`);
        }
    }

    next.preparing = null;
    const openingNeedsAgent = applyEncounterOptionsToState(next, settings, options, payload.context, warnings);
    persist(next);
    ui.starting = false;
    setBusy(false);
    resetViewSelection();
    ui.centerNextRender = true;
    render();
    toast(warnings.length ? 'warning' : 'success', warnings.length ? warnings[0] : 'Encounter ready.');
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

async function runDeferredEncounterArchitect(provisional, settings, options = {}) {
    const chatId = provisional?.chatId || getActiveChatId();
    if (!provisional?.preparing?.active || !chatId) return false;
    if (narratorPipelineBusy()) {
        scheduleDeferredEncounterArchitect(provisional, settings, options);
        return false;
    }
    const controller = new AbortController();
    ui.abortController = controller;
    const token = ++ui.architectToken;
    setBusy(true, 'The encounter architect is designing the opposition…', true);
    persist(provisional);
    render();
    try {
        const context = collectStartContext(settings, options);
        const generated = await generateEncounterWithAgent(context, settings, { signal: controller.signal });
        if (controller.signal.aborted || ui.architectToken !== token || getActiveChatId() !== chatId) return false;
        const latest = getEncounterForChat(chatId, getSettings());
        if (!latest || latest.id !== provisional.id || !latest.preparing?.active) return false;
        if (!generated.ok) {
            return finalizePreparedEncounter(latest, getSettings(), options, {
                context,
                error: generated.error || 'The encounter architect did not return a usable encounter.',
            });
        }
        return finalizePreparedEncounter(latest, getSettings(), options, {
            encounter: generated.encounter,
            context,
        });
    } catch (error) {
        if (controller.signal.aborted) return false;
        if (getActiveChatId() !== chatId) return false;
        const latest = getEncounterForChat(chatId, getSettings());
        if (!latest || latest.id !== provisional.id) return false;
        return finalizePreparedEncounter(latest, getSettings(), options, {
            error: String(error?.message || error),
        });
    } finally {
        if (ui.abortController === controller) ui.abortController = null;
        setBusy(false);
        render();
    }
}

function scheduleDeferredEncounterArchitect(provisional, settings, options = {}) {
    if (!provisional?.preparing?.active) return;
    const chatId = provisional.chatId || getActiveChatId();
    if (!chatId) return;
    if (ui.architectTimer && ui.architectStateId === provisional.id) return;
    cancelArchitectPreparation();
    ui.architectStateId = provisional.id;
    const startedAt = Date.now();
    const attempt = () => {
        ui.architectTimer = null;
        if (getActiveChatId() !== chatId) {
            ui.architectStateId = '';
            return;
        }
        const latest = getEncounterForChat(chatId, getSettings());
        if (!latest || latest.id !== provisional.id || !latest.preparing?.active) {
            ui.architectStateId = '';
            return;
        }
        if (narratorPipelineBusy() && Date.now() - startedAt < 90000) {
            ui.architectTimer = setTimeout(attempt, 700);
            return;
        }
        ui.architectStateId = '';
        if (narratorPipelineBusy()) {
            void finalizePreparedEncounter(latest, getSettings(), options, {
                error: 'The narrator was still generating, so a local roster was used.',
            });
            return;
        }
        void runDeferredEncounterArchitect(latest, getSettings(), options);
    };
    ui.architectTimer = setTimeout(attempt, 850);
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
    const activeChatId = getActiveChatId();
    if (settings.tacticalCombatReturn?.chatId && String(settings.tacticalCombatReturn.chatId) === String(activeChatId)) {
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
    cancelArchitectPreparation();
    const controller = new AbortController();
    ui.abortController = controller;

    const freshStart = clearEndedEncounterForFreshStart(existing, settings) || options.freshStart === true;
    const source = String(options.source || settings.tacticalCombatEncounterSource || 'auto');
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
        ui.view.error = 'Open a chat before starting a tactical encounter.';
        render();
        return { ok: false, error: ui.view.error };
    }

    let agentEncounter = null;
    let warnings = [];
    const needsAgent = source === 'agent' || (source === 'auto' && !context.existingCombat);
    // Calling the encounter architect from inside the narrator's function-tool
    // action would create a nested provider request while the main generation is
    // still running. Defer that path until the generation ends. The provisional
    // board is hidden behind a preparing screen and is replaced by the architect.
    const deferArchitect = needsAgent && options.fromNarrator === true;
    const canCallAgentNow = needsAgent && !deferArchitect;
    if (canCallAgentNow) {
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

    if (source === 'existing' && !context.existingCombat && !deferArchitect) {
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
            scheduleDeferredEncounterArchitect(state, settings, { ...options, source, freshStart });
            return { ok: true, state, warnings, preparing: true };
        }

        const openingNeedsAgent = applyEncounterOptionsToState(
            state,
            settings,
            options,
            context,
            warnings,
            { seedMemo: !context.existingCombat || source === 'agent' },
        );
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
            if (state.phase === 'enemy' && getPendingAgentUnitIds(state).length) {
                // Never call the combat agent from inside the narrator's tool call:
                // it would make a nested provider request while the main generation is
                // still running (a common source of 503s). The board's "Resolve enemy
                // turn" button handles it once the narration finishes.
                if (!options.fromNarrator) void runEnemyTurnForState(state, settings);
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
        case 'start-battle':
            handleStartBattle();
            break;
        case 'use-fallback': {
            const state = getState();
            if (state?.preparing?.active) {
                if (ui.abortController) {
                    ui.abortController.abort();
                    ui.abortController = null;
                }
                cancelArchitectPreparation();
                void finalizePreparedEncounter(state, getSettings(), state.preparing.options || {}, {
                    error: 'The local roster was used instead of the encounter architect.',
                });
            }
            break;
        }
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
        case 'continue-narration': {
            const current = getState();
            if (current?.finalization?.finalizing) {
                const since = Number(current.finalization.finalizingStartedAt) || 0;
                if (!since || Date.now() - since < 90000) {
                    toast('info', 'Updating the State Tracker with the final combat state…');
                    break;
                }
                current.finalization = { ...(current.finalization || {}), finalizing: false, waitingForNarration: false };
                finalizeIfEnded(current, getSettings());
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
    cancelArchitectPreparation();
    setBusy(false);
    resetViewSelection();
    ui.centerNextRender = true;
    const arrived = chatId ? getEncounterForChat(chatId, getSettings()) : null;
    if (arrived?.preparing?.active) {
        scheduleDeferredEncounterArchitect(arrived, getSettings(), arrived.preparing.options || {});
    } else if (arrived && arrived.status !== 'active' && !arrived.finalization?.narrationQueued) {
        finalizeIfEnded(arrived, getSettings());
    }
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
        openingAction: args.openingAction,
        openingTarget: args.openingTarget,
        openingSkill: args.openingSkill,
        surprise: args.surprise,
        enemyNames: args.enemyNames,
        silentNew: true,
        source: options.source || settings.tacticalCombatEncounterSource || 'auto',
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
    const deploymentHint = state?.deployment?.active
        ? ' Deploy the party in the highlighted lane, then press Start battle.'
        : '';
    if (state?.preparing?.active) {
        return {
            ok: true,
            message: `Tactical encounter preparation started: ${state?.title || 'encounter'}. The encounter architect is designing the opposition from the current scene; the board will open for deployment when the roster is ready.`,
        };
    }
    return {
        ok: true,
        message: `Tactical encounter ${state?.status === 'active' ? 'started' : (state?.outcome?.label || 'prepared')}: ${state?.title || 'encounter'}. The board is open.${deploymentHint} Resolve the fight on the grid and the result will return to narration when it ends.`,
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
