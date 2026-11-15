/**
 * lewd-combat-settings.js — Settings → Combat drawer for the secondary Lewd
 * Combat module.
 *
 * This module owns only configuration: it reads/writes the `lewdCombat*`
 * settings keys, reflects the per-chat board status, and forwards the
 * start/stop/reset controls to the board UI. It never resolves an exchange,
 * never calls a model, and never touches `[COMBAT]`, HP, or Willpower.
 *
 * The opponent-agent connection controls live in the shared Connections tab;
 * `index.js` binds them with `bindFeatureConnectionSettings` using the same
 * `rpg_lewd_combat_*` ids referenced by `src/state/connection-setups.js`.
 */

import { getActiveChatId } from '../../../state-manager.js';
import {
    LEWD_CHANGED_EVENT,
    LEWD_COMBAT_DEFAULTS,
    LEWD_COMBAT_LABEL,
    LEWD_EXPLICITNESS_OPTIONS,
    LEWD_PROSE_FREQUENCY_OPTIONS,
} from './lewd-combat-constants.js';
import { getLewdEncounterForChat, removeLewdEncounterForChat } from './lewd-combat-store.js';
import {
    DEFAULT_LEWD_TECHNIQUE_COMPENDIUM_JSON,
    buildLewdTechniqueCatalog,
    describeLewdCatalog,
} from './lewd-combat-compendium.js';
import { DEFAULT_LEWD_COMPILER_PROMPT } from './lewd-combat-compiler.js';
import {
    DEFAULT_LEWD_AGENT_PROMPT,
    DEFAULT_LEWD_OUTCOME_PROMPT,
    DEFAULT_LEWD_PROSE_PROMPT,
} from './lewd-combat-prompts.js';
import {
    resetLewdCombatEncounter,
    startLewdCombatFlow,
    stopLewdCombatEncounter,
} from './lewd-combat-ui.js';
import { resolveLewdCombatCleanupMode } from './lewd-combat-outcome.js';

let lewdBound = false;

const PROMPT_FIELDS = Object.freeze({
    agent: {
        id: 'rpg_lewd_combat_agent_prompt',
        key: 'lewdCombatAgentPrompt',
        fallback: DEFAULT_LEWD_AGENT_PROMPT,
    },
    prose: {
        id: 'rpg_lewd_combat_prose_prompt',
        key: 'lewdCombatProsePrompt',
        fallback: DEFAULT_LEWD_PROSE_PROMPT,
    },
    outcome: {
        id: 'rpg_lewd_combat_outcome_prompt',
        key: 'lewdCombatOutcomePrompt',
        fallback: DEFAULT_LEWD_OUTCOME_PROMPT,
    },
});

function el(id) {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
}

function toast(level, message, title = LEWD_COMBAT_LABEL) {
    try {
        const fn = globalThis.toastr?.[level];
        if (typeof fn === 'function') fn.call(globalThis.toastr, message, title);
    } catch (_) { /* no-op */ }
    try { console.warn('[RPG Tracker]', message); } catch (_) { /* no-op */ }
}

function activeChatId() {
    try {
        return String(getActiveChatId() || '');
    } catch (_) {
        return '';
    }
}

function clampInt(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function dispatchChanged() {
    try { document.dispatchEvent(new CustomEvent(LEWD_CHANGED_EVENT)); } catch (_) { /* no-op */ }
}

/**
 * Clamp and normalise every persisted lewd setting without mutating the input.
 * Unknown enum values fall back to the documented defaults.
 * @param {Record<string, any>} settings
 * @returns {Record<string, any>}
 */
export function normalizeLewdCombatSettings(settings = {}) {
    const explicitness = String(settings.lewdCombatExplicitness || LEWD_COMBAT_DEFAULTS.explicitness);
    const frequency = String(settings.lewdCombatProseFrequency || LEWD_COMBAT_DEFAULTS.proseFrequency);
    return {
        ...settings,
        lewdCombatEnabled: !!settings.lewdCombatEnabled,
        lewdCombatExplicitness: LEWD_EXPLICITNESS_OPTIONS.includes(explicitness)
            ? explicitness
            : LEWD_COMBAT_DEFAULTS.explicitness,
        lewdCombatDarkerThemes: !!settings.lewdCombatDarkerThemes,
        lewdCombatProseFrequency: LEWD_PROSE_FREQUENCY_OPTIONS.includes(frequency)
            ? frequency
            : LEWD_COMBAT_DEFAULTS.proseFrequency,
        lewdCombatRoundCap: clampInt(settings.lewdCombatRoundCap, 1, 60, LEWD_COMBAT_DEFAULTS.roundCap),
        lewdCombatMaxPartners: clampInt(settings.lewdCombatMaxPartners, 1, 4, LEWD_COMBAT_DEFAULTS.maxPartners),
        lewdCombatPostEncounterLatch: settings.lewdCombatPostEncounterLatch !== false,
        lewdCombatPostEncounterCooldownMs: clampInt(
            settings.lewdCombatPostEncounterCooldownMs,
            0,
            600000,
            LEWD_COMBAT_DEFAULTS.postEncounterCooldownMs,
        ),
        lewdCombatCombatCleanup: resolveLewdCombatCleanupMode(settings.lewdCombatCombatCleanup),
        lewdCombatMercyStatusWriteback: settings.lewdCombatMercyStatusWriteback !== false,
    };
}

/**
 * Human-readable board status for the settings drawer.
 * @param {Record<string, any>} settings
 * @param {object|null} [state]
 * @returns {string}
 */
export function lewdSettingsStatusText(settings, state = getLewdEncounterForChat(activeChatId(), settings)) {
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
 * Push persisted settings into the drawer controls. DOM-free module import is
 * preserved: this function is a no-op without a document.
 * @param {Record<string, any>} [settings]
 */
export function syncLewdCombatSettingsUi(settings) {
    if (!settings) return;
    const normalized = normalizeLewdCombatSettings(settings);
    const options = el('rpg_lewd_combat_options');
    if (options) options.style.display = normalized.lewdCombatEnabled ? '' : 'none';
    const toggle = el('rpg_lewd_combat_enabled');
    if (toggle) toggle.checked = normalized.lewdCombatEnabled;

    const explicitness = el('rpg_lewd_combat_explicitness');
    if (explicitness) explicitness.value = normalized.lewdCombatExplicitness;
    const darker = el('rpg_lewd_combat_darker_themes');
    if (darker) darker.checked = normalized.lewdCombatDarkerThemes;
    const frequency = el('rpg_lewd_combat_prose_frequency');
    if (frequency) frequency.value = normalized.lewdCombatProseFrequency;
    const roundCap = el('rpg_lewd_combat_round_cap');
    if (roundCap) roundCap.value = String(normalized.lewdCombatRoundCap);
    const maxPartners = el('rpg_lewd_combat_max_partners');
    if (maxPartners) maxPartners.value = String(normalized.lewdCombatMaxPartners);
    const latch = el('rpg_lewd_combat_post_encounter_latch');
    if (latch) latch.checked = normalized.lewdCombatPostEncounterLatch;
    const cooldown = el('rpg_lewd_combat_post_encounter_cooldown');
    if (cooldown) cooldown.value = String(Math.round(normalized.lewdCombatPostEncounterCooldownMs / 1000));
    const combatCleanup = el('rpg_lewd_combat_combat_cleanup');
    if (combatCleanup) combatCleanup.value = normalized.lewdCombatCombatCleanup;
    const mercyWriteback = el('rpg_lewd_combat_mercy_status_writeback');
    if (mercyWriteback) mercyWriteback.checked = normalized.lewdCombatMercyStatusWriteback;

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
    for (const field of Object.values(PROMPT_FIELDS)) {
        const node = el(field.id);
        if (node && document.activeElement !== node) {
            node.value = String(settings[field.key] ?? field.fallback);
        }
    }
    const agentTokens = el('rpg_lewd_combat_agent_max_tokens');
    if (agentTokens) agentTokens.value = String(clampInt(settings.lewdCombatAgentMaxTokens, 600, 32000, 2000));
    const proseTokens = el('rpg_lewd_combat_prose_max_tokens');
    if (proseTokens) proseTokens.value = String(clampInt(settings.lewdCombatProseMaxTokens, 400, 32000, 2000));

    const state = getLewdEncounterForChat(activeChatId(), settings);
    const status = el('rpg_lewd_combat_status');
    if (status) {
        status.textContent = lewdSettingsStatusText(settings, state);
        status.classList.toggle('rt-lc-active', state?.status === 'active');
        status.classList.toggle('rt-lc-finished', !!state && state.status !== 'active');
    }

    const remove = el('rpg_lewd_combat_remove');
    if (remove) remove.disabled = !state;
    const stop = el('rpg_lewd_combat_stop');
    if (stop) stop.disabled = state?.status !== 'active';
    const reset = el('rpg_lewd_combat_reset');
    if (reset) reset.disabled = !state;
}

function save(settings, saveSettings) {
    void settings;
    try { saveSettings?.(); } catch (_) { /* boot */ }
}

/**
 * Bind every control in the lewd drawer once. Settings are written straight
 * onto the supplied settings object; persistence is delegated to the host.
 *
 * @param {Record<string, any>} settings
 * @param {Function} [saveSettings]
 */
export function bindLewdCombatSettings(settings, saveSettings) {
    if (!settings || lewdBound || typeof document === 'undefined') return;
    lewdBound = true;

    const toggle = el('rpg_lewd_combat_enabled');
    toggle?.addEventListener('change', () => {
        settings.lewdCombatEnabled = !!toggle.checked;
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
        // The header icon, tool registration, and prompt sections all react to
        // the module flag; one event keeps them in sync.
        dispatchChanged();
    });

    const explicitness = el('rpg_lewd_combat_explicitness');
    explicitness?.addEventListener('change', () => {
        const value = String(explicitness.value || '');
        settings.lewdCombatExplicitness = LEWD_EXPLICITNESS_OPTIONS.includes(value)
            ? value
            : LEWD_COMBAT_DEFAULTS.explicitness;
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
    });

    const darker = el('rpg_lewd_combat_darker_themes');
    darker?.addEventListener('change', () => {
        settings.lewdCombatDarkerThemes = !!darker.checked;
        save(settings, saveSettings);
    });

    const frequency = el('rpg_lewd_combat_prose_frequency');
    frequency?.addEventListener('change', () => {
        const value = String(frequency.value || '');
        settings.lewdCombatProseFrequency = LEWD_PROSE_FREQUENCY_OPTIONS.includes(value)
            ? value
            : LEWD_COMBAT_DEFAULTS.proseFrequency;
        save(settings, saveSettings);
    });

    const roundCap = el('rpg_lewd_combat_round_cap');
    roundCap?.addEventListener('change', () => {
        settings.lewdCombatRoundCap = clampInt(roundCap.value, 1, 60, LEWD_COMBAT_DEFAULTS.roundCap);
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
    });

    const maxPartners = el('rpg_lewd_combat_max_partners');
    maxPartners?.addEventListener('change', () => {
        settings.lewdCombatMaxPartners = clampInt(maxPartners.value, 1, 4, LEWD_COMBAT_DEFAULTS.maxPartners);
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
    });

    const latch = el('rpg_lewd_combat_post_encounter_latch');
    latch?.addEventListener('change', () => {
        settings.lewdCombatPostEncounterLatch = !!latch.checked;
        save(settings, saveSettings);
        dispatchChanged();
    });

    const cooldown = el('rpg_lewd_combat_post_encounter_cooldown');
    cooldown?.addEventListener('change', () => {
        // An explicitly cleared field means "no cooldown", not "restore 60s".
        const raw = String(cooldown.value ?? '').trim();
        const seconds = raw === '' ? 0 : Number(raw);
        settings.lewdCombatPostEncounterCooldownMs = clampInt(
            (Number.isFinite(seconds) ? seconds : 0) * 1000,
            0,
            600000,
            LEWD_COMBAT_DEFAULTS.postEncounterCooldownMs,
        );
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
    });

    const combatCleanup = el('rpg_lewd_combat_combat_cleanup');
    combatCleanup?.addEventListener('change', () => {
        settings.lewdCombatCombatCleanup = resolveLewdCombatCleanupMode(combatCleanup.value);
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
    });

    const mercyWriteback = el('rpg_lewd_combat_mercy_status_writeback');
    mercyWriteback?.addEventListener('change', () => {
        settings.lewdCombatMercyStatusWriteback = !!mercyWriteback.checked;
        save(settings, saveSettings);
    });

    const compendium = el('rpg_lewd_combat_compendium');
    compendium?.addEventListener('input', () => {
        settings.lewdCombatTechniqueCompendiumJson = String(compendium.value || '');
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
    });
    el('rpg_lewd_combat_compendium_reset')?.addEventListener('click', (event) => {
        event.preventDefault();
        settings.lewdCombatTechniqueCompendiumJson = DEFAULT_LEWD_TECHNIQUE_COMPENDIUM_JSON;
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
    });

    const compilerPrompt = el('rpg_lewd_combat_compiler_prompt');
    compilerPrompt?.addEventListener('input', () => {
        settings.lewdCombatCompilerPrompt = String(compilerPrompt.value || DEFAULT_LEWD_COMPILER_PROMPT);
        save(settings, saveSettings);
    });

    for (const field of Object.values(PROMPT_FIELDS)) {
        const node = el(field.id);
        node?.addEventListener('input', () => {
            settings[field.key] = String(node.value ?? '');
            save(settings, saveSettings);
        });
        el(`${field.id}_reset`)?.addEventListener('click', (event) => {
            event.preventDefault();
            settings[field.key] = field.fallback;
            if (node) node.value = field.fallback;
            save(settings, saveSettings);
        });
    }

    const agentTokens = el('rpg_lewd_combat_agent_max_tokens');
    agentTokens?.addEventListener('change', () => {
        settings.lewdCombatAgentMaxTokens = clampInt(agentTokens.value, 600, 32000, 2000);
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
    });
    const proseTokens = el('rpg_lewd_combat_prose_max_tokens');
    proseTokens?.addEventListener('change', () => {
        settings.lewdCombatProseMaxTokens = clampInt(proseTokens.value, 400, 32000, 2000);
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
    });

    el('rpg_lewd_combat_open')?.addEventListener('click', (event) => {
        event.preventDefault();
        if (!settings.lewdCombatEnabled) {
            toast('warning', 'Enable Lewd Combat before opening its board.');
            return;
        }
        startLewdCombatFlow();
    });

    el('rpg_lewd_combat_start')?.addEventListener('click', (event) => {
        event.preventDefault();
        if (!settings.lewdCombatEnabled) {
            toast('warning', 'Enable Lewd Combat before starting a scene.');
            return;
        }
        startLewdCombatFlow();
    });

    el('rpg_lewd_combat_stop')?.addEventListener('click', (event) => {
        event.preventDefault();
        try {
            stopLewdCombatEncounter();
        } catch (error) {
            toast('error', `Safe word could not be applied: ${error?.message || error}`);
        }
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
    });

    el('rpg_lewd_combat_remove')?.addEventListener('click', (event) => {
        event.preventDefault();
        const chatId = activeChatId();
        if (!chatId) return;
        if (!getLewdEncounterForChat(chatId, settings)) {
            syncLewdCombatSettingsUi(settings);
            return;
        }
        const confirmed = typeof globalThis.confirm === 'function'
            ? globalThis.confirm('Discard the saved Lewd Combat board for this chat? This cannot be undone.')
            : true;
        if (!confirmed) return;
        removeLewdEncounterForChat(chatId, settings);
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
        dispatchChanged();
    });

    el('rpg_lewd_combat_reset')?.addEventListener('click', (event) => {
        event.preventDefault();
        if (getLewdEncounterForChat(activeChatId(), settings)) {
            const confirmed = typeof globalThis.confirm === 'function'
                ? globalThis.confirm('Reset the Lewd Combat board for this chat? The saved scene and its pending handoff are removed and this cannot be undone.')
                : true;
            if (!confirmed) return;
        }
        try {
            resetLewdCombatEncounter();
        } catch (error) {
            toast('error', `The board could not be reset: ${error?.message || error}`);
        }
        save(settings, saveSettings);
        syncLewdCombatSettingsUi(settings);
    });
}

/** Test/DI seam: allow a fresh bind after a document teardown. */
export function resetLewdCombatSettingsBindings() {
    lewdBound = false;
}
