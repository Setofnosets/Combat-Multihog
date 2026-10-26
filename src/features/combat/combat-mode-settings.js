/**
 * combat-mode-settings.js — binds the three-way combat style selector and
 * shows the matching settings pane.
 *
 * Switching styles is only unsafe while a saved board is actually running for
 * some chat. Because every chat keeps its own board, the blocker is often not
 * visible; the pane therefore lists the offending chats and offers a clear
 * action instead of only refusing the change.
 */

import { getActiveChatId } from '../../../state-manager.js';
import {
    COMBAT_STYLES,
    COMBAT_STYLE_LABELS,
    hasActiveCombatBoard,
    listActiveCombatBoards,
    normalizeCombatStyle,
    resolveCombatStyle,
    setCombatStyle,
} from './combat-mode.js';
import { clearActiveCombatEncounters } from './combat-board-reset.js';

let bound = false;
let eventsInstalled = false;
let depsRef = null;
/** Style the user tried to select while boards were still running. */
let pendingStyle = null;

const PHASE_TEXT = {
    preparing: 'preparing the encounter',
    finalizing: 'closing out after the fight',
    active: 'in progress',
};

function el(id) {
    return document.getElementById(id);
}

function syncPanes(style) {
    const panes = {
        narrative: el('rpg_combat_narrative_pane'),
        tactical: el('rpg_combat_tactical_pane'),
        traditional: el('rpg_combat_traditional_pane'),
    };
    for (const [id, node] of Object.entries(panes)) {
        if (!node) continue;
        node.style.display = id === style ? '' : 'none';
    }
}

function dispatchChanged() {
    try { document.dispatchEvent(new CustomEvent('rt_combat_style_changed')); } catch (_) { /* no-op */ }
}

function toast(level, message, title = 'Combat') {
    try {
        const fn = globalThis.toastr?.[level];
        if (typeof fn === 'function') fn.call(globalThis.toastr, message, title);
    } catch (_) { /* no-op */ }
    try { console.warn('[RPG Tracker]', message); } catch (_) { /* no-op */ }
}

/** Chat ids are `Name - date`; the name half is what the user recognises. */
function chatLabel(chatId) {
    const raw = String(chatId || '').trim();
    if (!raw) return 'Unknown chat';
    const name = raw.split(' - ')[0].trim();
    return name || raw;
}

function activeChatId() {
    try {
        return String(getActiveChatId() || '');
    } catch (_) {
        return '';
    }
}

function boardDescription(board) {
    const style = COMBAT_STYLE_LABELS[board.style] || board.style;
    const phase = PHASE_TEXT[board.phase] || board.phase;
    const round = board.round > 1 ? ` · round ${board.round}` : '';
    return `${style} · ${phase}${round}`;
}

function boardHeading(board) {
    const current = board.chatId === activeChatId();
    return `${chatLabel(board.chatId)}${current ? ' (this chat)' : ''}`;
}

function uniqueChatNames(boards) {
    return [...new Set(boards.map(board => chatLabel(board.chatId)))];
}

/**
 * Render the open-encounter list. The block stays hidden when nothing would
 * block a style switch.
 * @param {Record<string, any>} [settings]
 */
export function refreshCombatEncountersUi(settings = depsRef?.settings) {
    const panel = el('rpg_combat_active_encounters');
    const list = el('rpg_combat_active_encounters_list');
    const clear = el('rpg_combat_clear_encounters');
    if (!panel || !list || !settings) return;

    const boards = listActiveCombatBoards(settings);
    list.textContent = '';
    if (!boards.length) {
        panel.style.display = 'none';
        if (clear) clear.disabled = true;
        return;
    }

    panel.style.display = '';
    if (clear) clear.disabled = false;
    for (const board of boards) {
        const row = document.createElement('div');
        row.className = 'rt-tc-open-encounter';
        row.title = board.chatId;
        const name = document.createElement('span');
        name.className = 'rt-tc-open-encounter-name';
        name.textContent = boardHeading(board);
        const detail = document.createElement('span');
        detail.className = 'rt-tc-open-encounter-detail';
        detail.textContent = boardDescription(board);
        row.append(name, detail);
        list.appendChild(row);
    }
}

/**
 * Persist and apply a style, keeping the selector and panes in sync.
 * @param {Record<string, any>} settings
 * @param {string} style
 */
function applyStyle(settings, style) {
    const resolved = normalizeCombatStyle(style) || 'narrative';
    setCombatStyle(settings, resolved);
    const select = el('rpg_combat_style');
    if (select) select.value = resolved;
    syncPanes(resolved);
    try { depsRef?.saveSettings?.(); } catch (_) { /* boot */ }
    dispatchChanged();
    refreshCombatEncountersUi(settings);
}

/**
 * Explain the blocked switch and remember the requested style so the clear
 * action can finish the job.
 * @param {Record<string, any>} settings
 * @param {string} current
 * @param {string} next
 * @param {HTMLSelectElement} select
 */
function blockStyleChange(settings, current, next, select) {
    pendingStyle = next;
    select.value = current;
    refreshCombatEncountersUi(settings);
    const names = uniqueChatNames(listActiveCombatBoards(settings));
    const where = names.length === 1 ? `"${names[0]}"` : `${names.length} chats (${names.join(', ')})`;
    toast(
        'warning',
        `Combat style not changed: ${where} still ${names.length === 1 ? 'has' : 'have'} an open encounter. `
        + `Clear the open encounters below to switch to ${COMBAT_STYLE_LABELS[next] || next}.`,
    );
}

function bindClearButton(settings) {
    const button = el('rpg_combat_clear_encounters');
    if (!button) return;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        const boards = listActiveCombatBoards(settings);
        if (!boards.length) {
            refreshCombatEncountersUi(settings);
            return;
        }
        const names = uniqueChatNames(boards);
        const target = pendingStyle
            ? ` and switch to ${COMBAT_STYLE_LABELS[pendingStyle] || pendingStyle}`
            : '';
        const message = `Clear ${boards.length} open combat encounter${boards.length === 1 ? '' : 's'} `
            + `(${names.join(', ')})${target}? The saved boards are removed and this cannot be undone.`;
        const confirmed = typeof globalThis.confirm === 'function'
            ? globalThis.confirm(message)
            : true;
        if (!confirmed) return;

        const result = clearActiveCombatEncounters(settings);
        refreshCombatEncountersUi(settings);
        if (pendingStyle) {
            const style = pendingStyle;
            pendingStyle = null;
            applyStyle(settings, style);
            return;
        }
        toast('success', `Cleared ${result.cleared} open combat encounter${result.cleared === 1 ? '' : 's'}.`);
    });
}

export function syncCombatModeSettingsUi(deps = depsRef) {
    const settings = deps?.settings;
    if (!settings) return;
    const resolved = normalizeCombatStyle(settings.combatStyle) || resolveCombatStyle(settings);
    setCombatStyle(settings, resolved);
    const select = el('rpg_combat_style');
    if (select) select.value = resolved;
    syncPanes(resolved);
    refreshCombatEncountersUi(settings);
}

/**
 * @param {{ settings: Record<string, any>, saveSettings: Function }} deps
 */
export function bindCombatModeSettings(deps) {
    depsRef = deps;
    const settings = deps?.settings;
    if (!settings) return;
    const select = el('rpg_combat_style');
    if (select && !bound) {
        select.addEventListener('change', () => {
            const next = normalizeCombatStyle(select.value) || 'narrative';
            const current = resolveCombatStyle(settings);
            if (next === current) {
                pendingStyle = null;
                refreshCombatEncountersUi(settings);
                return;
            }
            if (hasActiveCombatBoard(settings)) {
                blockStyleChange(settings, current, next, select);
                return;
            }
            pendingStyle = null;
            applyStyle(settings, next);
        });
    }
    if (!bound) bindClearButton(settings);
    bound = true;
    if (!eventsInstalled) {
        eventsInstalled = true;
        document.addEventListener('rt_tactical_combat_changed', () => refreshCombatEncountersUi());
        document.addEventListener('rt_traditional_combat_changed', () => refreshCombatEncountersUi());
    }
    const wasExplicit = COMBAT_STYLES.includes(String(settings.combatStyle || ''));
    syncCombatModeSettingsUi({ settings, saveSettings: deps.saveSettings });
    if (!wasExplicit) {
        try { deps.saveSettings(); } catch (_) { /* boot */ }
    }
}
