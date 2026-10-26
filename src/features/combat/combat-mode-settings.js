/**
 * combat-mode-settings.js — binds the three-way combat style selector and
 * shows the matching settings pane.
 */

import {
    COMBAT_STYLES,
    hasActiveCombatBoard,
    normalizeCombatStyle,
    resolveCombatStyle,
    setCombatStyle,
} from './combat-mode.js';

let bound = false;
let depsRef = null;

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

export function syncCombatModeSettingsUi(deps = depsRef) {
    const settings = deps?.settings;
    if (!settings) return;
    const resolved = normalizeCombatStyle(settings.combatStyle) || resolveCombatStyle(settings);
    setCombatStyle(settings, resolved);
    const select = el('rpg_combat_style');
    if (select) select.value = resolved;
    syncPanes(resolved);
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
            if (next !== current && hasActiveCombatBoard(settings)) {
                select.value = current;
                const message = 'Finish or clear the active combat encounter before switching combat styles.';
                try { globalThis.toastr?.warning?.(message, 'Combat'); } catch (_) { /* no-op */ }
                try { console.warn('[RPG Tracker]', message); } catch (_) { /* no-op */ }
                return;
            }
            setCombatStyle(settings, next);
            syncPanes(next);
            try { deps.saveSettings(); } catch (_) { /* boot */ }
            dispatchChanged();
        });
    }
    bound = true;
    const wasExplicit = COMBAT_STYLES.includes(String(settings.combatStyle || ''));
    syncCombatModeSettingsUi({ settings, saveSettings: deps.saveSettings });
    if (!wasExplicit) {
        try { deps.saveSettings(); } catch (_) { /* boot */ }
    }
}
