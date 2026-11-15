/**
 * combat-ui-router.js — one header button opens whichever combat board is
 * currently selected. Narrative mode opens the Combat settings pane instead.
 *
 * Lewd Combat is a secondary board: it is not a `combatStyle`. While one is
 * running in the current chat it takes over the header button, and the router
 * asks the lewd board UI to open through `rt_lewd_combat_open`. That UI lands in
 * a later unit; until then the router falls back to the Combat settings tab.
 */

import { getActiveChatId, getSettings } from '../../../state-manager.js';
import { resolveCombatStyle } from './combat-mode.js';
import { openTacticalCombatBoard } from '../tactical-combat/tactical-combat-ui.js';
import { openTraditionalCombatBoard } from '../traditional-combat/traditional-combat-ui.js';
import { LEWD_CHANGED_EVENT, LEWD_OPEN_EVENT } from '../lewd-combat/lewd-combat-constants.js';
import { hasActiveLewdEncounter } from '../lewd-combat/lewd-combat-store.js';

let installed = false;

const STYLE_UI = {
    narrative: { icon: 'fa-crosshairs', title: 'Combat settings' },
    tactical: { icon: 'fa-chess-board', title: 'Tactical Combat' },
    traditional: { icon: 'fa-table-list', title: 'Traditional Combat' },
    lewd: { icon: 'fa-heart', title: 'Lewd Combat' },
};

const STYLE_ICONS = ['fa-chess-board', 'fa-crosshairs', 'fa-table-list', 'fa-heart'];

function activeChatId() {
    try {
        return String(getActiveChatId() || '');
    } catch (_) {
        return '';
    }
}

/** True while the module is enabled and a lewd board is running in this chat. */
function hasActiveLewdBoard() {
    const settings = getSettings();
    if (!settings?.lewdCombatEnabled) return false;
    return hasActiveLewdEncounter(settings, activeChatId());
}

export function syncCombatHeaderButton() {
    const style = hasActiveLewdBoard() ? 'lewd' : resolveCombatStyle(getSettings());
    const ui = STYLE_UI[style] || STYLE_UI.narrative;
    document.querySelectorAll('.rt-combat-btn').forEach(button => {
        button.title = ui.title;
        button.setAttribute('aria-label', ui.title);
        const icon = button.querySelector('i');
        if (icon) {
            icon.classList.remove(...STYLE_ICONS);
            icon.classList.add(ui.icon);
        }
    });
}

/** Ask the lewd board UI to open. Returns true when a listener handled it. */
function openLewdBoard() {
    try {
        const notCancelled = document.dispatchEvent(new CustomEvent(LEWD_OPEN_EVENT, {
            detail: { chatId: activeChatId() },
            cancelable: true,
        }));
        return !notCancelled;
    } catch (_) {
        return false;
    }
}

function openSettingsCombatTab() {
    try {
        document.dispatchEvent(new CustomEvent('rt_open_settings_overlay', { detail: { tab: 'combat' } }));
    } catch (_) { /* no-op */ }
}

function openActiveCombatUi() {
    if (hasActiveLewdBoard()) {
        if (!openLewdBoard()) openSettingsCombatTab();
        return;
    }
    const style = resolveCombatStyle(getSettings());
    if (style === 'tactical') {
        openTacticalCombatBoard();
        return;
    }
    if (style === 'traditional') {
        openTraditionalCombatBoard();
        return;
    }
    openSettingsCombatTab();
}

function onClick(event) {
    const trigger = event.target.closest?.('.rt-combat-btn, [data-combat-open]');
    if (!trigger) return;
    event.preventDefault();
    openActiveCombatUi();
}

export function installCombatUiRouter() {
    if (installed) {
        syncCombatHeaderButton();
        return;
    }
    installed = true;
    document.addEventListener('click', onClick);
    document.addEventListener('rt_combat_style_changed', syncCombatHeaderButton);
    document.addEventListener('rt_tactical_combat_changed', syncCombatHeaderButton);
    document.addEventListener('rt_traditional_combat_changed', syncCombatHeaderButton);
    document.addEventListener(LEWD_CHANGED_EVENT, syncCombatHeaderButton);
    syncCombatHeaderButton();
}
