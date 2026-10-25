/**
 * traditional-combat-settings.js — binds the Traditional Combat settings pane.
 * Connection/profile/preset fields are bound by index.js's shared
 * `bindFeatureConnectionSettings`, exactly like the tactical pane.
 */

import { getActiveChatId } from '../../../state-manager.js';
import { isTraditionalCombatMode } from '../combat/combat-mode.js';
import { parseActionCatalog } from '../tactical-combat/tactical-combat-actions.js';
import { getEncounterForChat, TRADITIONAL_BY_CHAT_KEY } from '../tactical-combat/tactical-combat-store.js';
import {
    DEFAULT_TRADITIONAL_ACTION_CATALOG_JSON,
    TRADITIONAL_DEFAULT_MAX_TOKENS,
} from './traditional-combat-constants.js';
import {
    DEFAULT_TRADITIONAL_COMBAT_AGENT_PROMPT,
    DEFAULT_TRADITIONAL_ENCOUNTER_SYSTEM_PROMPT,
    DEFAULT_TRADITIONAL_OUTCOME_PROMPT,
    DEFAULT_TRADITIONAL_SPECIAL_RESOLUTION_PROMPT,
} from './traditional-combat-prompts.js';
import { getTraditionalActionCatalog } from './traditional-combat-engine.js';
import {
    isTraditionalCombatBusy,
    openTraditionalCombatBoard,
    refreshTraditionalCombatUi,
    resetTraditionalCombatEncounter,
    startTraditionalCombatFlow,
    stopTraditionalCombatAgent,
} from './traditional-combat-ui.js';

let bound = false;
let statusListenerInstalled = false;
let depsRef = null;

function el(id) {
    return document.getElementById(id);
}

function setValue(node, value) {
    if (node) node.value = value == null ? '' : String(value);
}

function setChecked(node, value) {
    if (node) node.checked = !!value;
}

function catalogStatus(settings) {
    const node = el('rpg_traditional_combat_catalog_status');
    if (!node) return;
    const raw = String(settings?.traditionalCombatActionCatalogJson || '').trim();
    if (!raw) {
        node.textContent = 'Using the shipped catalogue: Attack, Skill, Item, Defend, Wait, Flee.';
        node.className = 'rt-tc-setting-status rt-tc-ok';
        return;
    }
    const parsed = parseActionCatalog(raw);
    const catalog = getTraditionalActionCatalog(settings);
    if (parsed.ok && !catalog.error) {
        const count = catalog.catalog.filter(entry => entry.enabled !== false).length;
        node.textContent = `Valid catalogue · ${count} enabled action${count === 1 ? '' : 's'}.`;
        node.className = 'rt-tc-setting-status rt-tc-ok';
    } else {
        node.textContent = `Invalid catalogue: ${catalog.error || parsed.error} The shipped traditional catalogue is used until this is fixed.`;
        node.className = 'rt-tc-setting-status rt-tc-error';
    }
}

function syncStatus(settings = depsRef?.settings) {
    const status = el('rpg_traditional_combat_status');
    if (!status || !settings) return;
    const activeChatId = getActiveChatId();
    const state = getEncounterForChat(activeChatId, settings, { key: TRADITIONAL_BY_CHAT_KEY });
    const enabled = isTraditionalCombatMode(settings);
    status.classList.toggle('rt-tc-error', !enabled);
    if (!enabled) {
        status.textContent = 'Traditional Combat is not selected. Choose it in the Combat style dropdown.';
    } else if (!activeChatId) {
        status.textContent = 'Open a chat to use traditional combat.';
    } else if (!state) {
        status.textContent = 'No encounter saved for this chat. Start one to build the roster.';
    } else if (state.preparing?.active) {
        status.textContent = 'The encounter architect is designing the opposition from the current scene…';
    } else if (state.status === 'active') {
        const phase = state.turnStyle === 'phase'
            ? (state.phase === 'enemy' ? 'Enemy phase' : 'Player phase')
            : 'Initiative';
        status.textContent = `${isTraditionalCombatBusy() ? 'Agent working — ' : ''}Encounter in progress: ${state.title} — round ${state.round}, ${phase}, ${state.units.filter(unit => !unit.defeated && !unit.fled).length} combatants standing.`;
    } else {
        status.textContent = `${state.outcome?.label || 'Ended'}: ${state.outcome?.summary || 'The encounter is over.'} The result is queued for the main narrator.`;
    }
    const startBtn = el('rpg_traditional_combat_start');
    if (startBtn) {
        startBtn.disabled = !enabled;
        const label = state?.preparing?.active
            ? 'Preparing encounter…'
            : state?.status === 'active' ? 'Resume encounter' : state ? 'Start new encounter' : 'Start encounter';
        startBtn.innerHTML = `<i class="fa-solid fa-crosshairs" aria-hidden="true"></i> ${label}`;
    }
    const resetBtn = el('rpg_traditional_combat_reset');
    if (resetBtn) resetBtn.disabled = !state;
    const stopBtn = el('rpg_traditional_combat_stop');
    if (stopBtn) stopBtn.disabled = !isTraditionalCombatBusy() && (!state || state.status !== 'active');
}

function syncControls(settings) {
    if (!settings) return;
    setValue(el('rpg_traditional_combat_turn_style'), settings.traditionalCombatTurnStyle || 'initiative');
    setValue(el('rpg_traditional_combat_encounter_source'), settings.traditionalCombatEncounterSource || 'auto');
    setChecked(el('rpg_traditional_combat_auto_start_on_hostility'), settings.traditionalCombatAutoStartOnHostility !== false);
    setChecked(el('rpg_traditional_combat_auto_narrate'), settings.traditionalCombatAutoNarrate !== false);
    setChecked(el('rpg_traditional_combat_opening_actions'), settings.traditionalCombatOpeningActions !== false);
    setChecked(el('rpg_traditional_combat_sync_tracker_before_narration'), settings.traditionalCombatSyncTrackerBeforeNarration !== false);
    setValue(el('rpg_traditional_combat_max_special_resolutions'), settings.traditionalCombatMaxSpecialResolutions ?? 2);
    setValue(el('rpg_traditional_combat_max_tokens'), settings.traditionalCombatMaxTokens ?? TRADITIONAL_DEFAULT_MAX_TOKENS);
    setValue(el('rpg_traditional_combat_agent_prompt'), settings.traditionalCombatAgentPrompt || DEFAULT_TRADITIONAL_COMBAT_AGENT_PROMPT);
    setValue(el('rpg_traditional_combat_encounter_prompt'), settings.traditionalCombatEncounterPrompt || DEFAULT_TRADITIONAL_ENCOUNTER_SYSTEM_PROMPT);
    setValue(el('rpg_traditional_combat_outcome_prompt'), settings.traditionalCombatOutcomePrompt || DEFAULT_TRADITIONAL_OUTCOME_PROMPT);
    setValue(el('rpg_traditional_combat_special_prompt'), settings.traditionalCombatSpecialPrompt || DEFAULT_TRADITIONAL_SPECIAL_RESOLUTION_PROMPT);
    setValue(el('rpg_traditional_combat_action_catalog'), settings.traditionalCombatActionCatalogJson || DEFAULT_TRADITIONAL_ACTION_CATALOG_JSON);
    catalogStatus(settings);
    syncStatus(settings);
}

/**
 * @param {{ settings: Record<string, any>, saveSettings: Function, presetManager?: any }} deps
 */
export function bindTraditionalCombatSettings(deps) {
    depsRef = deps;
    if (bound) {
        syncControls(deps.settings);
        return;
    }
    const settings = deps.settings;
    if (!settings) return;
    const save = () => {
        try { deps.saveSettings(); } catch (_) { /* boot */ }
    };
    const changed = () => {
        syncStatus(settings);
        refreshTraditionalCombatUi();
        try { document.dispatchEvent(new CustomEvent('rt_traditional_combat_changed')); } catch (_) { /* no-op */ }
    };

    for (const [id, key, values] of [
        ['rpg_traditional_combat_turn_style', 'traditionalCombatTurnStyle', ['initiative', 'phase']],
        ['rpg_traditional_combat_encounter_source', 'traditionalCombatEncounterSource', ['auto', 'existing', 'agent']],
    ]) {
        const node = el(id);
        if (!node) continue;
        node.addEventListener('change', () => {
            settings[key] = values.includes(String(node.value)) ? String(node.value) : values[0];
            save();
            changed();
        });
    }

    for (const [id, key] of [
        ['rpg_traditional_combat_auto_start_on_hostility', 'traditionalCombatAutoStartOnHostility'],
        ['rpg_traditional_combat_auto_narrate', 'traditionalCombatAutoNarrate'],
        ['rpg_traditional_combat_opening_actions', 'traditionalCombatOpeningActions'],
        ['rpg_traditional_combat_sync_tracker_before_narration', 'traditionalCombatSyncTrackerBeforeNarration'],
    ]) {
        const node = el(id);
        if (!node) continue;
        node.addEventListener('change', () => {
            settings[key] = !!node.checked;
            save();
            changed();
        });
    }

    for (const [id, key, fallback, min, max] of [
        ['rpg_traditional_combat_max_special_resolutions', 'traditionalCombatMaxSpecialResolutions', 2, 0, 4],
        ['rpg_traditional_combat_max_tokens', 'traditionalCombatMaxTokens', TRADITIONAL_DEFAULT_MAX_TOKENS, 1000, 32000],
    ]) {
        const node = el(id);
        if (!node) continue;
        node.addEventListener('change', () => {
            const value = Math.max(min, Math.min(max, parseInt(String(node.value), 10) || fallback));
            node.value = value;
            settings[key] = value;
            save();
            changed();
        });
    }

    for (const [id, key, defaultValue] of [
        ['rpg_traditional_combat_agent_prompt', 'traditionalCombatAgentPrompt', DEFAULT_TRADITIONAL_COMBAT_AGENT_PROMPT],
        ['rpg_traditional_combat_encounter_prompt', 'traditionalCombatEncounterPrompt', DEFAULT_TRADITIONAL_ENCOUNTER_SYSTEM_PROMPT],
        ['rpg_traditional_combat_outcome_prompt', 'traditionalCombatOutcomePrompt', DEFAULT_TRADITIONAL_OUTCOME_PROMPT],
        ['rpg_traditional_combat_special_prompt', 'traditionalCombatSpecialPrompt', DEFAULT_TRADITIONAL_SPECIAL_RESOLUTION_PROMPT],
    ]) {
        const node = el(id);
        if (!node) continue;
        node.addEventListener('input', () => {
            settings[key] = String(node.value || '');
            save();
        });
        const reset = el(`${id}_reset`);
        if (reset) {
            reset.addEventListener('click', (event) => {
                event.preventDefault();
                settings[key] = defaultValue;
                node.value = defaultValue;
                save();
            });
        }
    }

    const catalog = el('rpg_traditional_combat_action_catalog');
    if (catalog) {
        catalog.addEventListener('input', () => {
            settings.traditionalCombatActionCatalogJson = String(catalog.value || '');
            save();
            catalogStatus(settings);
        });
        const reset = el('rpg_traditional_combat_action_catalog_reset');
        if (reset) {
            reset.addEventListener('click', (event) => {
                event.preventDefault();
                settings.traditionalCombatActionCatalogJson = DEFAULT_TRADITIONAL_ACTION_CATALOG_JSON;
                catalog.value = DEFAULT_TRADITIONAL_ACTION_CATALOG_JSON;
                save();
                catalogStatus(settings);
            });
        }
    }

    const openBtn = el('rpg_traditional_combat_open');
    if (openBtn) {
        openBtn.addEventListener('click', (event) => {
            event.preventDefault();
            openTraditionalCombatBoard();
        });
    }
    const startBtn = el('rpg_traditional_combat_start');
    if (startBtn) {
        startBtn.addEventListener('click', (event) => {
            event.preventDefault();
            if (!isTraditionalCombatMode(settings)) {
                syncStatus(settings);
                return;
            }
            startTraditionalCombatFlow();
        });
    }
    const stopBtn = el('rpg_traditional_combat_stop');
    if (stopBtn) {
        stopBtn.addEventListener('click', (event) => {
            event.preventDefault();
            stopTraditionalCombatAgent();
        });
    }
    const resetBtn = el('rpg_traditional_combat_reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', (event) => {
            event.preventDefault();
            const confirmed = typeof globalThis.confirm === 'function'
                ? globalThis.confirm('Remove the saved traditional encounter for this chat? This cannot be undone.')
                : true;
            if (!confirmed) return;
            resetTraditionalCombatEncounter();
            syncStatus(settings);
        });
    }

    bound = true;
    if (!statusListenerInstalled) {
        statusListenerInstalled = true;
        document.addEventListener('rt_traditional_combat_changed', () => syncStatus(depsRef?.settings));
        document.addEventListener('rt_traditional_combat_changed', () => {
            if (depsRef?.settings) catalogStatus(depsRef.settings);
        });
        document.addEventListener('rt_combat_style_changed', () => {
            if (depsRef?.settings) syncStatus(depsRef.settings);
        });
    }
    syncControls(settings);
}

export function syncTraditionalCombatSettingsUi(deps = depsRef) {
    if (!deps?.settings) return;
    syncControls(deps.settings);
}
