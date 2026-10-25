import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const settingsHtml = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
const defaultsSource = readFileSync(new URL('../src/state/defaults.js', import.meta.url), 'utf8');
const settingsStateSource = readFileSync(new URL('../src/state/settings.js', import.meta.url), 'utf8');
const connectionsSource = readFileSync(new URL('../src/state/connection-setups.js', import.meta.url), 'utf8');
const overlaySource = readFileSync(new URL('../src/ui/settings-overlay.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const hooksSource = readFileSync(new URL('../narrative-hooks.js', import.meta.url), 'utf8');
const syspromptSource = readFileSync(new URL('../sysprompt.txt', import.meta.url), 'utf8');
const panelMarkup = readFileSync(new URL('../src/ui/panel/panel-markup.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

describe('Traditional Combat settings contract', () => {
    it('ships the mode selector, tactical pane, and traditional controls', () => {
        expect(settingsHtml).toContain('<b>Combat</b>');
        expect(settingsHtml).toContain('id="rpg_combat_style"');
        expect(settingsHtml).toContain('id="rpg_combat_tactical_pane"');
        expect(settingsHtml).toContain('id="rpg_combat_traditional_pane"');
        for (const id of [
            'rpg_traditional_combat_turn_style',
            'rpg_traditional_combat_encounter_source',
            'rpg_traditional_combat_auto_start_on_hostility',
            'rpg_traditional_combat_auto_narrate',
            'rpg_traditional_combat_opening_actions',
            'rpg_traditional_combat_sync_tracker_before_narration',
            'rpg_traditional_combat_max_special_resolutions',
            'rpg_traditional_combat_max_tokens',
            'rpg_traditional_combat_agent_prompt',
            'rpg_traditional_combat_agent_prompt_reset',
            'rpg_traditional_combat_encounter_prompt',
            'rpg_traditional_combat_encounter_prompt_reset',
            'rpg_traditional_combat_outcome_prompt',
            'rpg_traditional_combat_outcome_prompt_reset',
            'rpg_traditional_combat_special_prompt',
            'rpg_traditional_combat_special_prompt_reset',
            'rpg_traditional_combat_action_catalog',
            'rpg_traditional_combat_action_catalog_reset',
            'rpg_traditional_combat_action_catalog_status',
            'rpg_traditional_combat_status',
            'rpg_traditional_combat_open',
            'rpg_traditional_combat_start',
            'rpg_traditional_combat_stop',
            'rpg_traditional_combat_reset',
            'rpg_sysprompt_mod_traditional_combat',
        ]) {
            expect(settingsHtml).toContain(`id="${id}"`);
        }
    });

    it('ships the full traditional combat-agent connection drawer', () => {
        for (const id of [
            'rpg_traditional_combat_connection_source',
            'rpg_traditional_combat_profile_group',
            'rpg_traditional_combat_connection_profile',
            'rpg_traditional_combat_ollama_group',
            'rpg_traditional_combat_ollama_url',
            'rpg_traditional_combat_ollama_model',
            'rpg_traditional_combat_ollama_refresh',
            'rpg_traditional_combat_openai_group',
            'rpg_traditional_combat_openai_url',
            'rpg_traditional_combat_openai_key',
            'rpg_traditional_combat_openai_model',
            'rpg_traditional_combat_openai_refresh',
            'rpg_traditional_combat_openai_model_manual',
            'rpg_traditional_combat_completion_preset',
        ]) {
            expect(settingsHtml).toContain(`id="${id}"`);
        }
        expect(connectionsSource).toContain("key: 'traditional_combat'");
        expect(connectionsSource).toContain("connectionSource: 'traditionalCombatConnectionSource'");
        expect(connectionsSource).toContain('#rpg_traditional_combat_connection_source');
    });

    it('keeps every traditional DOM id unique', () => {
        const ids = [...settingsHtml.matchAll(/id="(rpg_traditional_combat_[^"]+)"/g)].map(match => match[1]);
        expect(ids.length).toBeGreaterThan(20);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('registers the Combat tab and generic header button', () => {
        expect(overlaySource).toContain("id: 'combat'");
        expect(overlaySource).toContain('fa-crosshairs');
        expect(panelMarkup).toContain('rt-combat-btn');
        expect(panelMarkup).toContain('data-combat-open');
    });

    it('ships defaults for the style, traditional settings, prompts, and per-chat map', () => {
        expect(defaultsSource).toContain('combatStyle: ""');
        for (const key of [
            'traditionalCombatTurnStyle: "initiative"',
            'traditionalCombatEncounterSource: "auto"',
            'traditionalCombatAutoStartOnHostility: true',
            'traditionalCombatAutoNarrate: true',
            'traditionalCombatOpeningActions: true',
            'traditionalCombatSyncTrackerBeforeNarration: true',
            'traditionalCombatMaxSpecialResolutions: 2',
            'traditionalCombatMaxTokens: 6000',
            'traditionalCombatConnectionSource: "default"',
            'traditionalCombatActionCatalogJson: DEFAULT_TRADITIONAL_ACTION_CATALOG_JSON',
            'traditionalCombatByChat: {}',
        ]) {
            expect(defaultsSource).toContain(key);
        }
        expect(defaultsSource).toContain('traditional_combat: true');
    });

    it('registers traditional settings as global, not chat state', () => {
        for (const key of [
            'combatStyle',
            'traditionalCombatTurnStyle',
            'traditionalCombatActionCatalogJson',
            'traditionalCombatByChat',
        ]) {
            expect(settingsStateSource).toContain(`'${key}'`);
        }
    });

    it('wires the traditional board, settings, tool, and sysprompt', () => {
        expect(indexSource).toContain('installTraditionalCombatUi');
        expect(indexSource).toContain('bindTraditionalCombatSettings');
        expect(indexSource).toContain("uiPrefix: 'rpg_traditional_combat'");
        expect(indexSource).toContain("keyPrefix: 'traditionalCombat'");
        expect(indexSource).toContain('onTraditionalCombatChatChanged');
        expect(indexSource).toContain('syncTraditionalCombatToolRegistration');
        expect(indexSource).toContain("row.tag === 'traditional_combat'");
        expect(hooksSource).toContain("name: 'StartTraditionalCombat'");
        expect(hooksSource).toContain('buildTraditionalCombatRuntimeOverride');
        expect(hooksSource).toContain("isEffectiveSectionEnabled('traditional_combat'");
        expect(syspromptSource).toContain('<traditional_combat>');
        expect(syspromptSource).toContain('StartTraditionalCombat');
        expect(syspromptSource).toContain('TRADITIONAL COMBAT OVERRIDE');
    });

    it('ships roster styles and the no-grid result UI', () => {
        for (const selector of [
            '.rt-trad-body',
            '.rt-trad-roster',
            '.rt-trad-unit',
            '.rt-trad-target',
        ]) {
            expect(style).toContain(selector);
        }
    });
});
