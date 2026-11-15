import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { normalizeLewdCombatSettings } from '../src/features/lewd-combat/lewd-combat-settings.js';
import { buildDefaultSettings } from '../src/state/defaults.js';

const settingsHtml = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
const defaultsSource = readFileSync(new URL('../src/state/defaults.js', import.meta.url), 'utf8');
const stateSettingsSource = readFileSync(new URL('../src/state/settings.js', import.meta.url), 'utf8');
const connectionsSource = readFileSync(new URL('../src/state/connection-setups.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const settingsModuleSource = readFileSync(new URL('../src/features/lewd-combat/lewd-combat-settings.js', import.meta.url), 'utf8');
const proseSource = readFileSync(new URL('../src/features/lewd-combat/lewd-combat-prose.js', import.meta.url), 'utf8');

describe('Lewd Combat settings pane contract', () => {
    it('ships every control the plan requires', () => {
        for (const id of [
            'rpg_lewd_combat_drawer',
            'rpg_lewd_combat_enabled',
            'rpg_lewd_combat_options',
            'rpg_lewd_combat_explicitness',
            'rpg_lewd_combat_darker_themes',
            'rpg_lewd_combat_prose_frequency',
            'rpg_lewd_combat_round_cap',
            'rpg_lewd_combat_max_partners',
            'rpg_lewd_combat_combat_cleanup',
            'rpg_lewd_combat_mercy_status_writeback',
            'rpg_lewd_combat_compendium',
            'rpg_lewd_combat_compendium_reset',
            'rpg_lewd_combat_compendium_status',
            'rpg_lewd_combat_compiler_prompt',
            'rpg_lewd_combat_agent_prompt',
            'rpg_lewd_combat_agent_prompt_reset',
            'rpg_lewd_combat_prose_prompt',
            'rpg_lewd_combat_prose_prompt_reset',
            'rpg_lewd_combat_outcome_prompt',
            'rpg_lewd_combat_outcome_prompt_reset',
            'rpg_lewd_combat_agent_max_tokens',
            'rpg_lewd_combat_prose_max_tokens',
            'rpg_lewd_combat_status',
            'rpg_lewd_combat_open',
            'rpg_lewd_combat_start',
            'rpg_lewd_combat_stop',
            'rpg_lewd_combat_reset',
            'rpg_lewd_combat_remove',
        ]) {
            expect(settingsHtml).toContain(`id="${id}"`);
        }
    });

    it('keeps every lewd DOM id unique', () => {
        const ids = [...settingsHtml.matchAll(/id="(rpg_lewd_combat_[^"]+)"/g)].map(match => match[1]);
        expect(ids.length).toBeGreaterThan(20);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('ships the opponent-agent connection drawer and wires it through the shared binder', () => {
        for (const id of [
            'rpg_lewd_combat_connection_source',
            'rpg_lewd_combat_profile_group',
            'rpg_lewd_combat_connection_profile',
            'rpg_lewd_combat_ollama_group',
            'rpg_lewd_combat_ollama_url',
            'rpg_lewd_combat_ollama_model',
            'rpg_lewd_combat_ollama_refresh',
            'rpg_lewd_combat_openai_group',
            'rpg_lewd_combat_openai_url',
            'rpg_lewd_combat_openai_key',
            'rpg_lewd_combat_openai_model',
            'rpg_lewd_combat_openai_refresh',
            'rpg_lewd_combat_openai_model_manual',
            'rpg_lewd_combat_completion_preset',
            'rpg_connection_slot_lewd_combat',
        ]) {
            expect(settingsHtml).toContain(`id="${id}"`);
        }
        expect(connectionsSource).toContain("key: 'lewd_combat'");
        expect(connectionsSource).toContain("connectionSource: 'lewdCombatConnectionSource'");
        expect(connectionsSource).toContain('#rpg_lewd_combat_connection_source');
        expect(indexSource).toContain("uiPrefix: 'rpg_lewd_combat'");
        expect(indexSource).toContain("keyPrefix: 'lewdCombat'");
        expect(indexSource).toContain("key: 'lewd_combat', control: '#rpg_lewd_combat_connection_source'");
    });

    it('persists every setting, prompt, token limit, and connection key', () => {
        for (const key of [
            'lewdCombatEnabled: false',
            'lewdCombatProsePrompt: DEFAULT_LEWD_PROSE_PROMPT',
            'lewdCombatOutcomePrompt: DEFAULT_LEWD_OUTCOME_PROMPT',
            'lewdCombatAgentPrompt: DEFAULT_LEWD_AGENT_PROMPT',
            'lewdCombatAgentMaxTokens: 2000',
            'lewdCombatProseMaxTokens: 2000',
            'lewdCombatCombatCleanup: "mark"',
            'lewdCombatMercyStatusWriteback: true',
            'lewdCombatConnectionSource: "default"',
            'lewdCombatOllamaUrl: "http://localhost:11434"',
        ]) {
            expect(defaultsSource).toContain(key);
        }
        for (const key of [
            'lewdCombatProsePrompt',
            'lewdCombatOutcomePrompt',
            'lewdCombatAgentPrompt',
            'lewdCombatAgentMaxTokens',
            'lewdCombatProseMaxTokens',
            'lewdCombatCombatCleanup',
            'lewdCombatMercyStatusWriteback',
            'lewdCombatConnectionSource',
            'lewdCombatConnectionProfileId',
            'lewdCombatCompletionPresetId',
            'lewdCombatOllamaUrl',
            'lewdCombatOllamaModel',
            'lewdCombatOpenaiUrl',
            'lewdCombatOpenaiKey',
            'lewdCombatOpenaiModel',
        ]) {
            expect(stateSettingsSource).toContain(`'${key}'`);
        }
    });

    it('exposes the defaults through buildDefaultSettings', () => {
        const settings = buildDefaultSettings();
        expect(settings.lewdCombatEnabled).toBe(false);
        expect(settings.lewdCombatProsePrompt).toMatch(/2 to 4 sentences/);
        expect(settings.lewdCombatOutcomePrompt).toMatch(/AUTHORITATIVE/);
        expect(settings.lewdCombatAgentPrompt).toMatch(/Never invent numbers/);
        expect(settings.lewdCombatConnectionSource).toBe('default');
    });

    it('clamps enum and numeric settings deterministically', () => {
        const normalized = normalizeLewdCombatSettings({
            lewdCombatExplicitness: 'nope',
            lewdCombatProseFrequency: 'sometimes',
            lewdCombatRoundCap: '999',
            lewdCombatMaxPartners: '0',
        });
        expect(normalized.lewdCombatExplicitness).toBe('explicit');
        expect(normalized.lewdCombatProseFrequency).toBe('per-exchange');
        expect(normalized.lewdCombatRoundCap).toBe(60);
        expect(normalized.lewdCombatMaxPartners).toBe(1);

        const kept = normalizeLewdCombatSettings({
            lewdCombatExplicitness: 'suggestive',
            lewdCombatProseFrequency: 'per-round',
            lewdCombatRoundCap: 20,
            lewdCombatMaxPartners: 3,
        });
        expect(kept.lewdCombatExplicitness).toBe('suggestive');
        expect(kept.lewdCombatProseFrequency).toBe('per-round');
        expect(kept.lewdCombatRoundCap).toBe(20);
        expect(kept.lewdCombatMaxPartners).toBe(3);
    });

    it('normalizes the combat cleanup mode and mercy writeback flag', () => {
        const fallback = normalizeLewdCombatSettings({ lewdCombatCombatCleanup: 'nonsense' });
        expect(fallback.lewdCombatCombatCleanup).toBe('mark');
        expect(fallback.lewdCombatMercyStatusWriteback).toBe(true);

        expect(normalizeLewdCombatSettings({ lewdCombatCombatCleanup: 'close' }).lewdCombatCombatCleanup).toBe('close');
        expect(normalizeLewdCombatSettings({ lewdCombatCombatCleanup: 'off' }).lewdCombatCombatCleanup).toBe('off');
        expect(normalizeLewdCombatSettings({ lewdCombatMercyStatusWriteback: false }).lewdCombatMercyStatusWriteback).toBe(false);
    });

    it('binds start, stop, reset, and the prompt defaults in the settings module', () => {
        expect(settingsModuleSource).toContain('startLewdCombatFlow');
        expect(settingsModuleSource).toContain('stopLewdCombatEncounter');
        expect(settingsModuleSource).toContain('resetLewdCombatEncounter');
        expect(settingsModuleSource).toContain('DEFAULT_LEWD_PROSE_PROMPT');
        expect(settingsModuleSource).toContain('DEFAULT_LEWD_OUTCOME_PROMPT');
        expect(settingsModuleSource).toContain('DEFAULT_LEWD_AGENT_PROMPT');
        expect(settingsModuleSource).toContain('normalizeLewdCombatSettings');
    });

    it('fixes the prose pass to the Main API connection', () => {
        expect(proseSource).toContain('connectionSource: \'default\'');
        expect(proseSource).toContain('lewdProseRequestSettings');
        expect(settingsHtml).toContain('The prose pass always uses the <b>Main API</b>');
    });
});
