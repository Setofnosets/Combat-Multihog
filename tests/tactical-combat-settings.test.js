import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const settingsHtml = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
const overlaySource = readFileSync(new URL('../src/ui/settings-overlay.js', import.meta.url), 'utf8');
const defaultsSource = readFileSync(new URL('../src/state/defaults.js', import.meta.url), 'utf8');
const constantsSource = readFileSync(new URL('../constants.js', import.meta.url), 'utf8');
const settingsStateSource = readFileSync(new URL('../src/state/settings.js', import.meta.url), 'utf8');
const connectionsSource = readFileSync(new URL('../src/state/connection-setups.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const hooksSource = readFileSync(new URL('../narrative-hooks.js', import.meta.url), 'utf8');
const panelMarkup = readFileSync(new URL('../src/ui/panel/panel-markup.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const syspromptSource = readFileSync(new URL('../sysprompt.txt', import.meta.url), 'utf8');
const gameSystemsSource = readFileSync(new URL('../game-systems.js', import.meta.url), 'utf8');

describe('Tactical Combat settings tab contract', () => {
    it('ships a primary Combat drawer with the expected tactical controls', () => {
        expect(settingsHtml).toContain('<b>Combat</b>');
        for (const id of [
            'rpg_combat_style',
            'rpg_tactical_combat_grid_preset',
            'rpg_tactical_combat_grid_rows',
            'rpg_tactical_combat_grid_cols',
            'rpg_tactical_combat_turn_style',
            'rpg_tactical_combat_terrain_theme',
            'rpg_tactical_combat_terrain_density',
            'rpg_tactical_combat_movement',
            'rpg_tactical_combat_auto_start_on_hostility',
            'rpg_tactical_combat_willpower_percent',
            'rpg_tactical_combat_willpower_recover',
            'rpg_tactical_combat_max_special_resolutions',
            'rpg_tactical_combat_encounter_source',
            'rpg_tactical_combat_auto_narrate',
            'rpg_tactical_combat_opening_actions',
            'rpg_tactical_combat_deployment_phase',
            'rpg_tactical_combat_sync_tracker_before_narration',
            'rpg_tactical_combat_show_coordinates',
            'rpg_tactical_combat_show_targeting_previews',
            'rpg_tactical_combat_max_tokens',
            'rpg_tactical_combat_agent_prompt',
            'rpg_tactical_combat_agent_prompt_reset',
            'rpg_tactical_combat_encounter_prompt',
            'rpg_tactical_combat_encounter_prompt_reset',
            'rpg_tactical_combat_outcome_prompt',
            'rpg_tactical_combat_outcome_prompt_reset',
            'rpg_tactical_combat_special_prompt',
            'rpg_tactical_combat_special_prompt_reset',
            'rpg_tactical_combat_action_catalog',
            'rpg_tactical_combat_action_catalog_reset',
            'rpg_tactical_combat_catalog_status',
            'rpg_tactical_combat_classifier',
            'rpg_tactical_combat_classifier_reset',
            'rpg_tactical_combat_classifier_status',
            'rpg_tactical_combat_status',
            'rpg_tactical_combat_open',
            'rpg_tactical_combat_start',
            'rpg_tactical_combat_stop',
            'rpg_tactical_combat_reset',
            'rpg_sysprompt_mod_tactical_combat',
        ]) {
            expect(settingsHtml).toContain(`id="${id}"`);
        }
    });

    it('ships the full combat-agent connection drawer', () => {
        for (const id of [
            'rpg_tactical_combat_connection_source',
            'rpg_tactical_combat_profile_group',
            'rpg_tactical_combat_connection_profile',
            'rpg_tactical_combat_ollama_group',
            'rpg_tactical_combat_ollama_url',
            'rpg_tactical_combat_ollama_model',
            'rpg_tactical_combat_ollama_refresh',
            'rpg_tactical_combat_openai_group',
            'rpg_tactical_combat_openai_url',
            'rpg_tactical_combat_openai_key',
            'rpg_tactical_combat_openai_model',
            'rpg_tactical_combat_openai_refresh',
            'rpg_tactical_combat_openai_model_manual',
            'rpg_tactical_combat_completion_preset',
        ]) {
            expect(settingsHtml).toContain(`id="${id}"`);
        }
        expect(connectionsSource).toContain("key: 'tactical_combat'");
        expect(connectionsSource).toContain("connectionSource: 'tacticalCombatConnectionSource'");
        expect(connectionsSource).toContain('#rpg_tactical_combat_connection_source');
    });

    it('keeps every tactical DOM id unique', () => {
        const ids = [...settingsHtml.matchAll(/id="(rpg_tactical_combat_[^"]+)"/g)].map(match => match[1]);
        expect(ids.length).toBeGreaterThan(20);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('registers the tab in the settings rail', () => {
        expect(overlaySource).toContain("id: 'combat'");
        expect(overlaySource).toContain('Combat');
        expect(overlaySource).toContain('fa-crosshairs');
    });

    it('ships defaults for every setting, prompt, per-chat map, and outcome slot', () => {
        for (const key of [
            'tacticalCombatEnabled: false',
            'tacticalCombatGridPreset: "15x15"',
            'tacticalCombatGridRows: 15',
            'tacticalCombatGridCols: 15',
            'tacticalCombatTurnStyle: "phase"',
            'tacticalCombatTerrainTheme: "auto"',
            'tacticalCombatTerrainDensity: 35',
            'tacticalCombatMovement: 6',
            'tacticalCombatAutoStartOnHostility: true',
            'tacticalCombatWillpowerMaxPercent: 30',
            'tacticalCombatWillpowerRecoverAfterCombat: true',
            'tacticalCombatMaxSpecialResolutions: 2',
            'tacticalCombatEncounterSource: "auto"',
            'tacticalCombatAutoNarrate: true',
            'tacticalCombatOpeningActions: true',
            'tacticalCombatDeploymentPhase: true',
            'tacticalCombatSyncTrackerBeforeNarration: true',
            'tacticalCombatShowCoordinates: false',
            'tacticalCombatShowTargetingPreviews: true',
            'tacticalCombatConnectionSource: "default"',
            'tacticalCombatMaxTokens: 6000',
            'tacticalCombatAgentPrompt: DEFAULT_TACTICAL_COMBAT_AGENT_PROMPT',
            'tacticalCombatEncounterPrompt: DEFAULT_TACTICAL_ENCOUNTER_SYSTEM_PROMPT',
            'tacticalCombatOutcomePrompt: DEFAULT_TACTICAL_OUTCOME_PROMPT',
            'tacticalCombatSpecialPrompt: DEFAULT_TACTICAL_SPECIAL_RESOLUTION_PROMPT',
            'tacticalCombatActionCatalogJson: DEFAULT_TACTICAL_ACTION_CATALOG_JSON',
            'tacticalCombatClassifierJson: DEFAULT_LOADOUT_CLASSIFIER_JSON',
            'tacticalCombatByChat: {}',
            'tacticalCombatReturn: null',
        ]) {
            expect(defaultsSource).toContain(key);
        }
        expect(defaultsSource).toContain("from '../features/tactical-combat/tactical-combat-prompts.js'");
    });

    it('documents standalone abilities and spells as player-character-only loadouts', () => {
        expect(constantsSource).toContain('PLAYER CHARACTER ONLY: [ABILITIES]');
        expect(constantsSource).toContain('PLAYER CHARACTER ONLY: [SPELLS]');
        expect(constantsSource).toContain("Party members' abilities belong inside their own [PARTY] entry");
        expect(constantsSource).toContain("Party members' spells belong inside their own [PARTY] entry");
    });

    it('treats tactical settings as global UI preferences, not chat state', () => {
        for (const key of [
            'tacticalCombatEnabled',
            'tacticalCombatByChat',
            'tacticalCombatReturn',
            'tacticalCombatAgentPrompt',
            'tacticalCombatConnectionSource',
        ]) {
            expect(settingsStateSource).toContain(`'${key}'`);
        }
    });

    it('wires the tab, board install, connection binder, and chat-change reset in index.js', () => {
        expect(indexSource).toContain('installTacticalCombatUi');
        expect(indexSource).toContain('syncTacticalCombatToolRegistration');
        expect(syspromptSource).toContain('<tactical_combat>');
        expect(syspromptSource).toContain('StartTacticalCombat');
        expect(syspromptSource).toContain('TACTICAL COMBAT OVERRIDE');
        expect(settingsHtml).toContain('id="rpg_sysprompt_mod_tactical_combat"');
        expect(gameSystemsSource).toContain("tactical_combat: 'rpg_sysprompt_mod_tactical_combat'");
        expect(gameSystemsSource).toContain("tag === 'tactical_combat' && !isTacticalCombatMode(settings)");
        expect(gameSystemsSource).toContain('TACTICAL_COMBAT_COMBAT_OVERRIDE');
        expect(indexSource).toContain("if (row.tag === 'combat')");
        expect(defaultsSource).toContain('tactical_combat: true');
        expect(indexSource).toContain('bindTacticalCombatSettings');
        expect(indexSource).toContain("uiPrefix: 'rpg_tactical_combat'");
        expect(indexSource).toContain("keyPrefix: 'tacticalCombat'");
        expect(indexSource).toContain('onTacticalCombatChatChanged');
        expect(indexSource).toContain("rt_open_settings_overlay");
        expect(indexSource).toContain("openSettingsOverlay(event?.detail?.tab || 'combat')");
        expect(panelMarkup).toContain('rt-combat-btn');
        expect(panelMarkup).toContain('data-combat-open');
    });

    it('injects the authoritative outcome as a narrator message and consumes it only after a real generation', () => {
        expect(hooksSource).toContain('buildNarrationBlock');
        expect(hooksSource).toContain('markNarrationInjected');
        expect(hooksSource).toContain('clearNarrationAfterGeneration');
        expect(hooksSource).toContain('registerTacticalCombatTool');
        expect(hooksSource).toContain("name: 'StartTacticalCombat'");
        expect(hooksSource).toContain('startTacticalCombatFromNarrator');
        expect(hooksSource).toContain('const tacticalBlock = buildNarrationBlock(settings, getActiveChatId());');
        expect(hooksSource).toContain('tcResultId');
        expect(hooksSource).toContain("!['quiet', 'impersonate', 'swipe', 'regenerate'].includes(typeLower)");
    });

    it('ships responsive board styles with a terrain legend and reduced-motion support', () => {
        for (const selector of [
            '.rt-tc-overlay',
            '.rt-tc-shell',
            '.rt-tc-header',
            '.rt-tc-grid',
            '.rt-tc-cell',
            '.rt-tc-token',
            '.rt-tc-legend',
            '.rt-tc-result',
            '.rt-tc-settings-intro',
            '.rt-tc-key-grid',
        ]) {
            expect(style).toContain(selector);
        }
        expect(style).toContain('@media screen and (max-width: 960px)');
        expect(style).toContain('@media screen and (max-width: 640px)');
        expect(style).toContain('@media screen and (max-width: 380px)');
        expect(style).toContain('@media (prefers-reduced-motion: reduce)');
        expect(style).toContain('color-mix');
    });

    it('ships Willpower tracker prompts, classifier defaults, and board styles', () => {
        expect(defaultsSource).toContain('<willpower_logic>');
        expect(constantsSource).toContain('Willpower: current/max');
        expect(constantsSource).toContain('WILLPOWER TARGETING');
        expect(settingsHtml).toContain('willpower');
        expect(style).toContain('.rt-tc-wpbar');
        expect(style).toContain('.rt-tc-token-wp');
    });

    it('gates hybrid RNG and the tactical override on engaged combat', () => {
        expect(gameSystemsSource).toContain('isCombatEngaged(settings.currentMemo)');
        expect(gameSystemsSource).not.toContain('const inCombat = !!combatBody');
        expect(gameSystemsSource).not.toContain('If [COMBAT] is already present and no tactical encounter is active');
        expect(gameSystemsSource).toContain('COMBAT STATE: DORMANT roster is not an active fight');
    });

    it('disables upstream auto-update so the fork is not overwritten', () => {
        expect(manifest.auto_update).toBe(false);
        expect(manifest.display_name).toContain('Combat');
        expect(manifest.forkHomePage).toBe('https://github.com/Setofnosets/Combat-Multihog');
    });
});

describe('Combat shared settings and compendium contract', () => {
    it('exposes shared Willpower, classifiers, and spell compendium outside the style panes', () => {
        expect(settingsHtml).toContain('id="rpg_combat_shared_pane"');
        expect(settingsHtml).toContain('id="rpg_tactical_combat_willpower_percent"');
        expect(settingsHtml).toContain('id="rpg_tactical_combat_willpower_recover"');
        expect(settingsHtml).toContain('id="rpg_tactical_combat_classifier"');
        expect(settingsHtml).toContain('id="rpg_tactical_combat_spell_compendium"');
        expect(settingsHtml).toContain('id="rpg_tactical_combat_spell_compendium_status"');
        expect(settingsHtml).not.toContain('id="rpg_tactical_combat_enabled"');
    });

    it('persists spell compendium and per-chat outcome settings', () => {
        expect(defaultsSource).toContain('tacticalCombatSpellCompendiumJson: DEFAULT_SPELL_COMPENDIUM_JSON');
        expect(defaultsSource).toContain('tacticalCombatReturnByChat: {}');
        expect(settingsStateSource).toContain("'tacticalCombatSpellCompendiumJson'");
        expect(settingsStateSource).toContain("'tacticalCombatReturnByChat'");
    });

    it('keeps Components checkboxes aligned with effective section defaults', () => {
        expect(indexSource).toContain('s.syspromptModules?.[key] ?? true');
    });
});
