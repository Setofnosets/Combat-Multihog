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
import {
    LEWD_CHANGED_EVENT,
    LEWD_COMBAT_DEFAULTS,
    LEWD_COMBAT_LABEL,
    LEWD_EXPLICITNESS_OPTIONS,
    LEWD_OPEN_EVENT,
    LEWD_PROSE_FREQUENCY_OPTIONS,
} from '../lewd-combat/lewd-combat-constants.js';
import {
    getLewdEncounterForChat,
    removeLewdEncounterForChat,
} from '../lewd-combat/lewd-combat-store.js';
import {
    DEFAULT_LEWD_TECHNIQUE_COMPENDIUM_JSON,
    buildLewdTechniqueCatalog,
    describeLewdCatalog,
} from '../lewd-combat/lewd-combat-compendium.js';
import { DEFAULT_LEWD_COMPILER_PROMPT } from '../lewd-combat/lewd-combat-compiler.js';

let bound = false;
let eventsInstalled = false;
let depsRef = null;
let lewdBound = false;
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

/**
 * The lewd drawer is a *secondary* module surface: it is never shown by
 * `syncPanes()` and never replaces the primary style pane. It only reflects and
 * writes its own settings keys plus the open/remove controls for the per-chat
 * board.
 * @param {Record<string, any>} settings
 */
function lewdStatusText(settings) {
    const state = getLewdEncounterForChat(activeChatId(), settings);
    if (!state) return `${LEWD_COMBAT_LABEL}: no board in this chat.`;
    const status = String(state.status || 'unknown');
    if (status === 'active') {
        const round = Number(state.round) || 0;
        const count = Array.isArray(state.participants) ? state.participants.length : 0;
        const roundText = round > 0 ? ` · round ${round}` : '';
        const countText = count > 0 ? ` · ${count} participant${count === 1 ? '' : 's'}` : '';
        return `${LEWD_COMBAT_LABEL}: active${roundText}${countText}.`;
    }
    return `${LEWD_COMBAT_LABEL}: finished (${status}).`;
}

/**
 * @param {Record<string, any>} [settings]
 */
export function syncLewdCombatSettingsUi(settings = depsRef?.settings) {
    if (!settings) return;
    const enabled = !!settings.lewdCombatEnabled;
    const options = el('rpg_lewd_combat_options');
    if (options) options.style.display = enabled ? '' : 'none';
    const toggle = el('rpg_lewd_combat_enabled');
    if (toggle) toggle.checked = enabled;

    const explicitness = el('rpg_lewd_combat_explicitness');
    if (explicitness) {
        const value = String(settings.lewdCombatExplicitness || LEWD_COMBAT_DEFAULTS.explicitness);
        explicitness.value = LEWD_EXPLICITNESS_OPTIONS.includes(value) ? value : LEWD_COMBAT_DEFAULTS.explicitness;
    }
    const darker = el('rpg_lewd_combat_darker_themes');
    if (darker) darker.checked = !!settings.lewdCombatDarkerThemes;
    const frequency = el('rpg_lewd_combat_prose_frequency');
    if (frequency) {
        const value = String(settings.lewdCombatProseFrequency || LEWD_COMBAT_DEFAULTS.proseFrequency);
        frequency.value = LEWD_PROSE_FREQUENCY_OPTIONS.includes(value) ? value : LEWD_COMBAT_DEFAULTS.proseFrequency;
    }
    const roundCap = el('rpg_lewd_combat_round_cap');
    if (roundCap) roundCap.value = String(Number(settings.lewdCombatRoundCap) || LEWD_COMBAT_DEFAULTS.roundCap);
    const maxPartners = el('rpg_lewd_combat_max_partners');
    if (maxPartners) maxPartners.value = String(Number(settings.lewdCombatMaxPartners) || LEWD_COMBAT_DEFAULTS.maxPartners);

    const compendium = el('rpg_lewd_combat_compendium');
    if (compendium && document.activeElement !== compendium) {
        compendium.value = String(settings.lewdCombatTechniqueCompendiumJson ?? DEFAULT_LEWD_TECHNIQUE_COMPENDIUM_JSON);
    }
    const compendiumStatus = el('rpg_lewd_combat_compendium_status');
    if (compendiumStatus) {
        const catalog = buildLewdTechniqueCatalog(settings);
        compendiumStatus.textContent = describeLewdCatalog(catalog);
        compendiumStatus.classList.toggle('rt-lc-error', !!catalog.error);
        compendiumStatus.classList.toggle('rt-lc-warning', !catalog.error && catalog.diagnostics.length > 0);
    }
    const compilerPrompt = el('rpg_lewd_combat_compiler_prompt');
    if (compilerPrompt && document.activeElement !== compilerPrompt) {
        compilerPrompt.value = String(settings.lewdCombatCompilerPrompt || DEFAULT_LEWD_COMPILER_PROMPT);
    }

    const status = el('rpg_lewd_combat_status');
    if (status) {
        const state = getLewdEncounterForChat(activeChatId(), settings);
        status.textContent = lewdStatusText(settings);
        status.classList.toggle('rt-lc-active', state?.status === 'active');
        status.classList.toggle('rt-lc-finished', !!state && state.status !== 'active');
    }

    const remove = el('rpg_lewd_combat_remove');
    if (remove) remove.disabled = !getLewdEncounterForChat(activeChatId(), settings);
}

function clampInt(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function bindLewdCombatSettings(settings, saveSettings) {
    const toggle = el('rpg_lewd_combat_enabled');
    if (toggle && !lewdBound) {
        toggle.addEventListener('change', () => {
            settings.lewdCombatEnabled = !!toggle.checked;
            try { saveSettings?.(); } catch (_) { /* boot */ }
            syncLewdCombatSettingsUi(settings);
            // The header icon, tool registration, and prompt sections all react
            // to the module flag; one event keeps them in sync.
            try { document.dispatchEvent(new CustomEvent(LEWD_CHANGED_EVENT)); } catch (_) { /* no-op */ }
        });
    }

    const explicitness = el('rpg_lewd_combat_explicitness');
    if (explicitness && !lewdBound) {
        explicitness.addEventListener('change', () => {
            const value = String(explicitness.value || '');
            settings.lewdCombatExplicitness = LEWD_EXPLICITNESS_OPTIONS.includes(value)
                ? value
                : LEWD_COMBAT_DEFAULTS.explicitness;
            syncLewdCombatSettingsUi(settings);
            try { saveSettings?.(); } catch (_) { /* boot */ }
        });
    }

    const darker = el('rpg_lewd_combat_darker_themes');
    if (darker && !lewdBound) {
        darker.addEventListener('change', () => {
            settings.lewdCombatDarkerThemes = !!darker.checked;
            try { saveSettings?.(); } catch (_) { /* boot */ }
        });
    }

    const frequency = el('rpg_lewd_combat_prose_frequency');
    if (frequency && !lewdBound) {
        frequency.addEventListener('change', () => {
            const value = String(frequency.value || '');
            settings.lewdCombatProseFrequency = LEWD_PROSE_FREQUENCY_OPTIONS.includes(value)
                ? value
                : LEWD_COMBAT_DEFAULTS.proseFrequency;
            try { saveSettings?.(); } catch (_) { /* boot */ }
        });
    }

    const roundCap = el('rpg_lewd_combat_round_cap');
    if (roundCap && !lewdBound) {
        roundCap.addEventListener('change', () => {
            settings.lewdCombatRoundCap = clampInt(roundCap.value, 1, 60, LEWD_COMBAT_DEFAULTS.roundCap);
            syncLewdCombatSettingsUi(settings);
            try { saveSettings?.(); } catch (_) { /* boot */ }
        });
    }

    const maxPartners = el('rpg_lewd_combat_max_partners');
    if (maxPartners && !lewdBound) {
        maxPartners.addEventListener('change', () => {
            settings.lewdCombatMaxPartners = clampInt(maxPartners.value, 1, 4, LEWD_COMBAT_DEFAULTS.maxPartners);
            syncLewdCombatSettingsUi(settings);
            try { saveSettings?.(); } catch (_) { /* boot */ }
        });
    }

    const compendium = el('rpg_lewd_combat_compendium');
    if (compendium && !lewdBound) {
        compendium.addEventListener('input', () => {
            settings.lewdCombatTechniqueCompendiumJson = String(compendium.value || '');
            syncLewdCombatSettingsUi(settings);
            try { saveSettings?.(); } catch (_) { /* boot */ }
        });
        const reset = el('rpg_lewd_combat_compendium_reset');
        if (reset) {
            reset.addEventListener('click', (event) => {
                event.preventDefault();
                settings.lewdCombatTechniqueCompendiumJson = DEFAULT_LEWD_TECHNIQUE_COMPENDIUM_JSON;
                compendium.value = DEFAULT_LEWD_TECHNIQUE_COMPENDIUM_JSON;
                syncLewdCombatSettingsUi(settings);
                try { saveSettings?.(); } catch (_) { /* boot */ }
            });
        }
    }

    const compilerPrompt = el('rpg_lewd_combat_compiler_prompt');
    if (compilerPrompt && !lewdBound) {
        compilerPrompt.addEventListener('input', () => {
            settings.lewdCombatCompilerPrompt = String(compilerPrompt.value || DEFAULT_LEWD_COMPILER_PROMPT);
            try { saveSettings?.(); } catch (_) { /* boot */ }
        });
    }

    const open = el('rpg_lewd_combat_open');
    if (open && !lewdBound) {
        open.addEventListener('click', (event) => {
            event.preventDefault();
            if (!settings.lewdCombatEnabled) {
                toast('warning', 'Enable Lewd Combat before opening its board.');
                return;
            }
            let handled = false;
            try {
                handled = document.dispatchEvent(new CustomEvent(LEWD_OPEN_EVENT, {
                    detail: { chatId: activeChatId() },
                    cancelable: true,
                }));
                handled = !handled;
            } catch (_) {
                handled = false;
            }
            if (!handled) toast('info', 'No Lewd Combat board is available to open in this build.');
        });
    }

    const remove = el('rpg_lewd_combat_remove');
    if (remove && !lewdBound) {
        remove.addEventListener('click', (event) => {
            event.preventDefault();
            const chatId = activeChatId();
            if (!chatId) return;
            const state = getLewdEncounterForChat(chatId, settings);
            if (!state) {
                syncLewdCombatSettingsUi(settings);
                return;
            }
            const confirmed = typeof globalThis.confirm === 'function'
                ? globalThis.confirm('Discard the saved Lewd Combat board for this chat? This cannot be undone.')
                : true;
            if (!confirmed) return;
            removeLewdEncounterForChat(chatId, settings);
            try { saveSettings?.(); } catch (_) { /* boot */ }
            syncLewdCombatSettingsUi(settings);
            refreshCombatEncountersUi(settings);
            try { document.dispatchEvent(new CustomEvent(LEWD_CHANGED_EVENT)); } catch (_) { /* no-op */ }
        });
    }

    lewdBound = true;
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
    syncLewdCombatSettingsUi(settings);
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
    bindLewdCombatSettings(settings, deps.saveSettings);
    if (!eventsInstalled) {
        eventsInstalled = true;
        document.addEventListener('rt_tactical_combat_changed', () => refreshCombatEncountersUi());
        document.addEventListener('rt_traditional_combat_changed', () => refreshCombatEncountersUi());
        document.addEventListener(LEWD_CHANGED_EVENT, () => {
            refreshCombatEncountersUi();
            syncLewdCombatSettingsUi();
        });
    }
    const wasExplicit = COMBAT_STYLES.includes(String(settings.combatStyle || ''));
    syncCombatModeSettingsUi({ settings, saveSettings: deps.saveSettings });
    if (!wasExplicit) {
        try { deps.saveSettings(); } catch (_) { /* boot */ }
    }
}
