/**
 * tactical-combat-settings.js — binds the Tactical Combat settings tab.
 *
 * Connection/profile/preset fields are bound by index.js's shared
 * `bindFeatureConnectionSettings` (same code path as every other agent), so this
 * module only owns the feature controls, prompt editors, catalogue validation,
 * and board launchers.
 */

import { getActiveChatId } from '../../../state-manager.js';
import { parseActionCatalog } from './tactical-combat-actions.js';
import {
    DEFAULT_LOADOUT_CLASSIFIER_JSON,
    normalizeClassifierConfig,
} from './tactical-combat-classifiers.js';
import {
    DEFAULT_TACTICAL_ACTION_CATALOG_JSON,
    TC_GRID_PRESETS,
} from './tactical-combat-constants.js';
import {
    DEFAULT_TACTICAL_COMBAT_AGENT_PROMPT,
    DEFAULT_TACTICAL_ENCOUNTER_SYSTEM_PROMPT,
    DEFAULT_TACTICAL_OUTCOME_PROMPT,
    DEFAULT_TACTICAL_SPECIAL_RESOLUTION_PROMPT,
} from './tactical-combat-prompts.js';
import { getEncounterForChat } from './tactical-combat-store.js';
import {
    isTacticalCombatBusy,
    openTacticalCombatBoard,
    refreshTacticalCombatUi,
    resetTacticalCombatEncounter,
    startTacticalCombatFlow,
    stopTacticalCombatAgent,
} from './tactical-combat-ui.js';

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

function syncGridControls(settings) {
    const preset = String(settings.tacticalCombatGridPreset || '15x15');
    const select = el('rpg_tactical_combat_grid_preset');
    if (select) select.value = preset;
    const custom = el('rpg_tactical_combat_grid_custom');
    if (custom) custom.style.display = preset === 'custom' ? 'flex' : 'none';
    const rows = el('rpg_tactical_combat_grid_rows');
    const cols = el('rpg_tactical_combat_grid_cols');
    setValue(rows, settings.tacticalCombatGridRows ?? 15);
    setValue(cols, settings.tacticalCombatGridCols ?? 15);
    const presetDef = TC_GRID_PRESETS.find(entry => entry.id === preset);
    if (rows) rows.disabled = !presetDef || presetDef.id !== 'custom';
    if (cols) cols.disabled = !presetDef || presetDef.id !== 'custom';
    const note = el('rpg_tactical_combat_grid_note');
    if (note) {
        note.textContent = preset === 'dynamic'
            ? 'Dynamic grids grow from 8×8 to 24×24 based on the number of combatants.'
            : preset === 'custom'
                ? 'Enter rows and columns between 5 and 40.'
                : presetDef?.rows
                    ? `Fixed ${presetDef.cols} × ${presetDef.rows} battlefield.`
                    : '';
    }
}

function catalogStatus(settings) {
    const node = el('rpg_tactical_combat_catalog_status');
    if (!node) return;
    const parsed = parseActionCatalog(settings.tacticalCombatActionCatalogJson || DEFAULT_TACTICAL_ACTION_CATALOG_JSON);
    if (parsed.ok) {
        node.textContent = `Valid catalogue · ${parsed.catalog.filter(entry => entry.enabled !== false).length} enabled action${parsed.catalog.filter(entry => entry.enabled !== false).length === 1 ? '' : 's'}.`;
        node.className = 'rt-tc-setting-status rt-tc-ok';
    } else {
        node.textContent = `Invalid catalogue: ${parsed.error} The shipped catalogue is used until this is fixed.`;
        node.className = 'rt-tc-setting-status rt-tc-error';
    }
}

function classifierStatus(settings) {
    const node = el('rpg_tactical_combat_classifier_status');
    if (!node) return;
    const parsed = normalizeClassifierConfig(settings.tacticalCombatClassifierJson || DEFAULT_LOADOUT_CLASSIFIER_JSON);
    if (parsed.ok) {
        const ruleCount = parsed.config.skillRules.length;
        const buff = parsed.config.buff;
        node.textContent = `Valid classifier · ${ruleCount} skill rule${ruleCount === 1 ? '' : 's'} · buffs: +${buff.acBonus} AC / +${buff.attackBonus} ATK for ${buff.rounds} round${buff.rounds === 1 ? '' : 's'}.`;
        node.className = 'rt-tc-setting-status rt-tc-ok';
    } else {
        node.textContent = `Invalid classifier: ${parsed.error} The shipped rules are used until this is fixed.`;
        node.className = 'rt-tc-setting-status rt-tc-error';
    }
}

function syncStatus(settings = depsRef?.settings) {
    const status = el('rpg_tactical_combat_status');
    if (!status || !settings) return;
    const activeChatId = getActiveChatId();
    const state = getEncounterForChat(activeChatId, settings);
    const enabled = !!settings.tacticalCombatEnabled;
    status.classList.toggle('rt-tc-error', !enabled);
    if (!enabled) {
        status.textContent = 'Tactical Combat is disabled. Enable it to start an encounter.';
    } else if (!activeChatId) {
        status.textContent = 'Open a chat to use tactical combat.';
    } else if (!state) {
        status.textContent = 'No encounter saved for this chat. Start one to build the battlefield.';
    } else if (state.status === 'active') {
        const phase = state.turnStyle === 'phase'
            ? (state.phase === 'enemy' ? 'Enemy phase' : 'Player phase')
            : 'Initiative';
        status.textContent = `${isTacticalCombatBusy() ? 'Agent working — ' : ''}Encounter in progress: ${state.title} — round ${state.round}, ${phase}, ${state.units.filter(unit => !unit.defeated && !unit.fled).length} combatants standing.`;
    } else {
        status.textContent = `${state.outcome?.label || 'Ended'}: ${state.outcome?.summary || 'The encounter is over.'} The result is queued for the main narrator.`;
    }
    const startBtn = el('rpg_tactical_combat_start');
    if (startBtn) {
        startBtn.disabled = !enabled;
        const label = state?.status === 'active' ? 'Resume encounter' : state ? 'Start new encounter' : 'Start encounter';
        startBtn.innerHTML = `<i class="fa-solid fa-crosshairs" aria-hidden="true"></i> ${label}`;
    }
    const resetBtn = el('rpg_tactical_combat_reset');
    if (resetBtn) resetBtn.disabled = !state;
    const stopBtn = el('rpg_tactical_combat_stop');
    if (stopBtn) stopBtn.disabled = !isTacticalCombatBusy() && (!state || state.status !== 'active');
}

function syncControls(settings) {
    if (!settings) return;
    setChecked(el('rpg_tactical_combat_enabled'), settings.tacticalCombatEnabled);
    setValue(el('rpg_tactical_combat_grid_preset'), settings.tacticalCombatGridPreset || '15x15');
    setValue(el('rpg_tactical_combat_turn_style'), settings.tacticalCombatTurnStyle || 'phase');
    setValue(el('rpg_tactical_combat_terrain_theme'), settings.tacticalCombatTerrainTheme || 'auto');
    setValue(el('rpg_tactical_combat_terrain_density'), settings.tacticalCombatTerrainDensity ?? 35);
    const densityValue = el('rpg_tactical_combat_terrain_density_value');
    if (densityValue) densityValue.textContent = `${Number(settings.tacticalCombatTerrainDensity ?? 35)}%`;
    setValue(el('rpg_tactical_combat_movement'), settings.tacticalCombatMovement ?? 6);
    setValue(el('rpg_tactical_combat_encounter_source'), settings.tacticalCombatEncounterSource || 'auto');
    setChecked(el('rpg_tactical_combat_auto_narrate'), settings.tacticalCombatAutoNarrate !== false);
    setChecked(el('rpg_tactical_combat_show_coordinates'), !!settings.tacticalCombatShowCoordinates);
    setValue(el('rpg_tactical_combat_max_tokens'), settings.tacticalCombatMaxTokens ?? 6000);
    setValue(el('rpg_tactical_combat_agent_prompt'), settings.tacticalCombatAgentPrompt || DEFAULT_TACTICAL_COMBAT_AGENT_PROMPT);
    setValue(el('rpg_tactical_combat_encounter_prompt'), settings.tacticalCombatEncounterPrompt || DEFAULT_TACTICAL_ENCOUNTER_SYSTEM_PROMPT);
    setValue(el('rpg_tactical_combat_outcome_prompt'), settings.tacticalCombatOutcomePrompt || DEFAULT_TACTICAL_OUTCOME_PROMPT);
    setValue(el('rpg_tactical_combat_special_prompt'), settings.tacticalCombatSpecialPrompt || DEFAULT_TACTICAL_SPECIAL_RESOLUTION_PROMPT);
    setValue(el('rpg_tactical_combat_action_catalog'), settings.tacticalCombatActionCatalogJson || DEFAULT_TACTICAL_ACTION_CATALOG_JSON);
    setValue(el('rpg_tactical_combat_classifier'), settings.tacticalCombatClassifierJson || DEFAULT_LOADOUT_CLASSIFIER_JSON);
    syncGridControls(settings);
    catalogStatus(settings);
    classifierStatus(settings);
    syncStatus(settings);
}

/**
 * @param {{ settings: Record<string, any>, saveSettings: Function, presetManager?: any }} deps
 */
export function bindTacticalCombatSettings(deps) {
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
        refreshTacticalCombatUi();
        try { document.dispatchEvent(new CustomEvent('rt_tactical_combat_changed')); } catch (_) { /* no-op */ }
    };

    const enabled = el('rpg_tactical_combat_enabled');
    if (enabled) {
        enabled.addEventListener('change', () => {
            settings.tacticalCombatEnabled = !!enabled.checked;
            save();
            changed();
        });
    }

    const gridPreset = el('rpg_tactical_combat_grid_preset');
    if (gridPreset) {
        gridPreset.addEventListener('change', () => {
            settings.tacticalCombatGridPreset = String(gridPreset.value || '15x15');
            const preset = TC_GRID_PRESETS.find(entry => entry.id === settings.tacticalCombatGridPreset);
            if (preset?.rows && preset?.cols) {
                settings.tacticalCombatGridRows = preset.rows;
                settings.tacticalCombatGridCols = preset.cols;
            }
            save();
            syncGridControls(settings);
            changed();
        });
    }

    for (const [id, key] of [
        ['rpg_tactical_combat_grid_rows', 'tacticalCombatGridRows'],
        ['rpg_tactical_combat_grid_cols', 'tacticalCombatGridCols'],
    ]) {
        const node = el(id);
        if (!node) continue;
        node.addEventListener('change', () => {
            const value = Math.max(5, Math.min(40, parseInt(String(node.value), 10) || 15));
            node.value = value;
            settings[key] = value;
            save();
            syncGridControls(settings);
            changed();
        });
    }

    for (const [id, key, values] of [
        ['rpg_tactical_combat_turn_style', 'tacticalCombatTurnStyle', ['phase', 'initiative']],
        ['rpg_tactical_combat_terrain_theme', 'tacticalCombatTerrainTheme', ['auto', 'dungeon', 'forest', 'cave', 'city', 'interior', 'plain']],
        ['rpg_tactical_combat_encounter_source', 'tacticalCombatEncounterSource', ['auto', 'existing', 'agent']],
    ]) {
        const node = el(id);
        if (!node) continue;
        node.addEventListener('change', () => {
            settings[key] = values.includes(String(node.value)) ? String(node.value) : values[0];
            save();
            changed();
        });
    }

    const density = el('rpg_tactical_combat_terrain_density');
    if (density) {
        density.addEventListener('input', () => {
            const value = Math.max(0, Math.min(100, parseInt(String(density.value), 10) || 0));
            settings.tacticalCombatTerrainDensity = value;
            const label = el('rpg_tactical_combat_terrain_density_value');
            if (label) label.textContent = `${value}%`;
            save();
        });
    }

    const movement = el('rpg_tactical_combat_movement');
    if (movement) {
        movement.addEventListener('change', () => {
            const value = Math.max(1, Math.min(24, parseInt(String(movement.value), 10) || 6));
            movement.value = value;
            settings.tacticalCombatMovement = value;
            save();
            changed();
        });
    }

    for (const [id, key] of [
        ['rpg_tactical_combat_auto_narrate', 'tacticalCombatAutoNarrate'],
        ['rpg_tactical_combat_show_coordinates', 'tacticalCombatShowCoordinates'],
    ]) {
        const node = el(id);
        if (!node) continue;
        node.addEventListener('change', () => {
            settings[key] = !!node.checked;
            save();
            changed();
        });
    }

    const maxTokens = el('rpg_tactical_combat_max_tokens');
    if (maxTokens) {
        maxTokens.addEventListener('change', () => {
            const value = Math.max(1000, Math.min(32000, parseInt(String(maxTokens.value), 10) || 6000));
            maxTokens.value = value;
            settings.tacticalCombatMaxTokens = value;
            save();
        });
    }

    for (const [id, key, defaultValue] of [
        ['rpg_tactical_combat_agent_prompt', 'tacticalCombatAgentPrompt', DEFAULT_TACTICAL_COMBAT_AGENT_PROMPT],
        ['rpg_tactical_combat_encounter_prompt', 'tacticalCombatEncounterPrompt', DEFAULT_TACTICAL_ENCOUNTER_SYSTEM_PROMPT],
        ['rpg_tactical_combat_outcome_prompt', 'tacticalCombatOutcomePrompt', DEFAULT_TACTICAL_OUTCOME_PROMPT],
        ['rpg_tactical_combat_special_prompt', 'tacticalCombatSpecialPrompt', DEFAULT_TACTICAL_SPECIAL_RESOLUTION_PROMPT],
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

    const catalog = el('rpg_tactical_combat_action_catalog');
    if (catalog) {
        catalog.addEventListener('input', () => {
            settings.tacticalCombatActionCatalogJson = String(catalog.value || '');
            save();
            catalogStatus(settings);
        });
        const reset = el('rpg_tactical_combat_action_catalog_reset');
        if (reset) {
            reset.addEventListener('click', (event) => {
                event.preventDefault();
                settings.tacticalCombatActionCatalogJson = DEFAULT_TACTICAL_ACTION_CATALOG_JSON;
                catalog.value = DEFAULT_TACTICAL_ACTION_CATALOG_JSON;
                save();
                catalogStatus(settings);
            });
        }
    }

    const classifier = el('rpg_tactical_combat_classifier');
    if (classifier) {
        classifier.addEventListener('input', () => {
            settings.tacticalCombatClassifierJson = String(classifier.value || '');
            save();
            classifierStatus(settings);
        });
        const reset = el('rpg_tactical_combat_classifier_reset');
        if (reset) {
            reset.addEventListener('click', (event) => {
                event.preventDefault();
                settings.tacticalCombatClassifierJson = DEFAULT_LOADOUT_CLASSIFIER_JSON;
                classifier.value = DEFAULT_LOADOUT_CLASSIFIER_JSON;
                save();
                classifierStatus(settings);
            });
        }
    }

    const openBtn = el('rpg_tactical_combat_open');
    if (openBtn) {
        openBtn.addEventListener('click', (event) => {
            event.preventDefault();
            openTacticalCombatBoard();
        });
    }
    const startBtn = el('rpg_tactical_combat_start');
    if (startBtn) {
        startBtn.addEventListener('click', (event) => {
            event.preventDefault();
            if (!settings.tacticalCombatEnabled) {
                syncStatus(settings);
                return;
            }
            startTacticalCombatFlow();
        });
    }
    const stopBtn = el('rpg_tactical_combat_stop');
    if (stopBtn) {
        stopBtn.addEventListener('click', (event) => {
            event.preventDefault();
            stopTacticalCombatAgent();
        });
    }
    const resetBtn = el('rpg_tactical_combat_reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', (event) => {
            event.preventDefault();
            const confirmed = typeof globalThis.confirm === 'function'
                ? globalThis.confirm('Remove the saved tactical encounter for this chat? This cannot be undone.')
                : true;
            if (!confirmed) return;
            resetTacticalCombatEncounter();
            syncStatus(settings);
        });
    }

    bound = true;
    if (!statusListenerInstalled) {
        statusListenerInstalled = true;
        document.addEventListener('rt_tactical_combat_changed', () => syncStatus(depsRef?.settings));
        document.addEventListener('rt_tactical_combat_changed', () => {
            if (depsRef?.settings) catalogStatus(depsRef.settings);
        });
        document.addEventListener('rt_tactical_combat_changed', () => {
            if (depsRef?.settings) classifierStatus(depsRef.settings);
        });
    }
    syncControls(settings);
}

/**
 * Refresh values after a chat switch / factory reset.
 * @param {{ settings: Record<string, any> }} deps
 */
export function syncTacticalCombatSettingsUi(deps = depsRef) {
    if (!deps?.settings) return;
    syncControls(deps.settings);
}
