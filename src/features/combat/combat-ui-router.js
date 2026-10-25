/**
 * combat-ui-router.js — one header button opens whichever combat board is
 * currently selected. Narrative mode opens the Combat settings pane instead.
 */

import { getSettings } from '../../../state-manager.js';
import { resolveCombatStyle } from './combat-mode.js';
import { openTacticalCombatBoard } from '../tactical-combat/tactical-combat-ui.js';
import { openTraditionalCombatBoard } from '../traditional-combat/traditional-combat-ui.js';

let installed = false;

const STYLE_UI = {
    narrative: { icon: 'fa-crosshairs', title: 'Combat settings' },
    tactical: { icon: 'fa-chess-board', title: 'Tactical Combat' },
    traditional: { icon: 'fa-table-list', title: 'Traditional Combat' },
};

export function syncCombatHeaderButton() {
    const style = resolveCombatStyle(getSettings());
    const ui = STYLE_UI[style] || STYLE_UI.narrative;
    document.querySelectorAll('.rt-combat-btn').forEach(button => {
        button.title = ui.title;
        button.setAttribute('aria-label', ui.title);
        const icon = button.querySelector('i');
        if (icon) {
            icon.classList.remove('fa-chess-board', 'fa-crosshairs', 'fa-table-list');
            icon.classList.add(ui.icon);
        }
    });
}

function openActiveCombatUi() {
    const style = resolveCombatStyle(getSettings());
    if (style === 'tactical') {
        openTacticalCombatBoard();
        return;
    }
    if (style === 'traditional') {
        openTraditionalCombatBoard();
        return;
    }
    try {
        document.dispatchEvent(new CustomEvent('rt_open_settings_overlay', { detail: { tab: 'combat' } }));
    } catch (_) { /* no-op */ }
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
    syncCombatHeaderButton();
}
