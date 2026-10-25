import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { testExtensionSettings } from './setup.js';

vi.mock('../../../../script.js', () => ({
    getRequestHeaders: () => ({}),
}));

import { buildTacticalCombatRuntimeOverride, isLatestAssistantFromActiveChar, registerTacticalCombatTool } from '../narrative-hooks.js';

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const hooksSource = readFileSync(new URL('../narrative-hooks.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../src/features/tactical-combat/tactical-combat-ui.js', import.meta.url), 'utf8');

describe('Tactical Combat narrator function tool', () => {
    beforeEach(() => {
        for (const key of Object.keys(testExtensionSettings)) delete testExtensionSettings[key];
        testExtensionSettings.rpg_tracker = {
            tacticalCombatEnabled: true,
            syspromptModules: { tactical_combat: true },
            currentMemo: '[COMBAT]\nGoblin: 10/10 HP\n[/COMBAT]',
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('registers StartTacticalCombat through SillyTavern registerFunctionTool with a valid schema', () => {
        const registerFunctionTool = vi.fn();
        const unregisterFunctionTool = vi.fn();
        vi.spyOn(SillyTavern, 'getContext').mockReturnValue({
            extensionSettings: testExtensionSettings,
            chatId: 'vitest-chat',
            registerFunctionTool,
            unregisterFunctionTool,
        });

        registerTacticalCombatTool();

        expect(unregisterFunctionTool).toHaveBeenCalledWith('StartTacticalCombat');
        expect(registerFunctionTool).toHaveBeenCalledTimes(1);
        const tool = registerFunctionTool.mock.calls[0][0];
        expect(tool.name).toBe('StartTacticalCombat');
        expect(tool.displayName).toBe('Tactical Combat');
        expect(tool.description).toMatch(/real fight begins/i);
        expect(tool.parameters.$schema).toBe('http://json-schema.org/draft-04/schema#');
        expect(tool.parameters.type).toBe('object');
        expect(tool.parameters.required).toEqual([]);
        expect(Object.keys(tool.parameters.properties).sort()).toEqual([
            'description', 'enemyNames', 'location', 'openingAction', 'openingSkill', 'openingTarget', 'reason', 'surprise', 'title',
        ]);
        expect(typeof tool.action).toBe('function');
        expect(tool.formatMessage()).toMatch(/board is open/i);
        expect(tool.stealth).toBe(false);
        expect(tool.shouldRegister()).toBe(true);
        // The tool is available before [COMBAT] exists; the board seeds the memo.
        testExtensionSettings.rpg_tracker.currentMemo = '';
        expect(tool.shouldRegister()).toBe(true);
        testExtensionSettings.rpg_tracker.tacticalCombatEnabled = false;
        expect(tool.shouldRegister()).toBe(false);
        testExtensionSettings.rpg_tracker.tacticalCombatEnabled = true;
        testExtensionSettings.rpg_tracker.tacticalCombatByChat = { 'vitest-chat': { status: 'active' } };
        expect(tool.shouldRegister()).toBe(false);
        delete testExtensionSettings.rpg_tracker.tacticalCombatByChat;
        testExtensionSettings.rpg_tracker.tacticalCombatReturn = { chatId: 'vitest-chat', stateId: 'tc-test' };
        expect(tool.shouldRegister()).toBe(false);
        delete testExtensionSettings.rpg_tracker.tacticalCombatReturn;
        testExtensionSettings.rpg_tracker.syspromptModules = { tactical_combat: false };
        expect(tool.shouldRegister()).toBe(false);
        testExtensionSettings.rpg_tracker.syspromptModules = { tactical_combat: true };
        testExtensionSettings.rpg_tracker.tacticalCombatAutoStartOnHostility = false;
        expect(tool.shouldRegister()).toBe(false);
    });

    it('registers during init next to the dice tools, not inside the settings UI setup', () => {
        expect(hooksSource).toContain('registerFunctionTool({');
        expect(hooksSource).toContain("name: 'StartTacticalCombat'");
        expect(hooksSource).toContain('tacticalCombatReturn');
        expect(hooksSource).toContain("isEffectiveSectionEnabled('tactical_combat'");
        expect(hooksSource).toContain('stealth: false');
        expect(hooksSource).toContain("tacticalCombatEncounterSource || 'auto'");
        expect(hooksSource).toContain('openingAction');
        expect(hooksSource).toContain('enemyNames');
        expect(hooksSource).toContain('export function syncTacticalCombatToolRegistration');
        expect(hooksSource).toContain('buildTacticalCombatRuntimeOverride');
        expect(hooksSource).toContain('[TACTICAL_COMBAT_OVERRIDE]');
        expect(indexSource).toContain('MESSAGE_SENT, () => syncTacticalCombatToolRegistration()');
        expect(uiSource).toContain('if (!options.fromNarrator) void runEnemyTurnForState');
        expect(uiSource).toContain('scheduleDeferredEncounterArchitect');
        expect(uiSource).toContain('state.preparing');
        expect(uiSource).toContain('clearEndedEncounterForFreshStart');

        const toolBlock = indexSource.match(/\/\/ ─── Dice System ───[\s\S]*?registerDiceFunctionTool\(\);\s*syncTacticalCombatToolRegistration\(\);\s*syncTraditionalCombatToolRegistration\(\);\s*syncLocationMappingRuntime\(\);/);
        expect(toolBlock).not.toBeNull();

        const settingsStart = indexSource.indexOf('initSettingsOverlay(settingsHtml, { folderName: FOLDER_NAME });');
        const settingsEnd = indexSource.indexOf('organizeConnectionSettingsUI();', settingsStart);
        expect(settingsStart).toBeGreaterThan(-1);
        expect(settingsEnd).toBeGreaterThan(settingsStart);
        expect(indexSource.slice(settingsStart, settingsEnd)).not.toContain('syncTacticalCombatToolRegistration');
    });

    it('does not demand the tool for a dormant encounter roster', () => {
        vi.spyOn(SillyTavern, 'getContext').mockReturnValue({
            extensionSettings: testExtensionSettings,
            chatId: 'vitest-chat',
        });
        const settings = testExtensionSettings.rpg_tracker;
        settings.syspromptModules = { tactical_combat: true };
        settings.currentMemo = '[COMBAT]\nCOMBAT STATE: DORMANT\nENEMIES:\nGoblin: 10/10 HP\n[/COMBAT]';
        const dormant = buildTacticalCombatRuntimeOverride(settings);
        expect(dormant).toContain('DORMANT_ENCOUNTER');
        expect(dormant).not.toContain('Call the StartTacticalCombat function tool exactly once');

        settings.currentMemo = '[COMBAT]\nCOMBAT STATE: HOSTILE\nCOMBAT ROUND 1\nENEMIES:\nGoblin: 10/10 HP\n[/COMBAT]';
        expect(buildTacticalCombatRuntimeOverride(settings)).toContain('Call the StartTacticalCombat function tool exactly once');

        settings.tacticalCombatAutoStartOnHostility = false;
        const manual = buildTacticalCombatRuntimeOverride(settings);
        expect(manual).toContain('Automatic tactical start is disabled');
        expect(manual).not.toContain('Call the StartTacticalCombat function tool exactly once');
    });

    it('find the narrator row through non-stealth tool/system rows', () => {
        const chat = [
            { is_user: true, mes: 'I draw my blade.' },
            { name: 'Aria', mes: 'The gatehouse answers with steel.' },
            { is_system: true, name: 'Tactical Combat', mes: '{"name":"StartTacticalCombat","result":"ok"}' },
        ];
        expect(isLatestAssistantFromActiveChar(chat, { name2: 'Aria' })).toBe(true);
        const stopped = [
            { is_user: true, mes: 'I draw my blade.' },
            { name: 'Aria', mes: 'The gatehouse answers with steel.' },
            { is_user: true, mes: 'Again.' },
            { is_system: true, name: 'Tactical Combat', mes: 'tool row' },
        ];
        expect(isLatestAssistantFromActiveChar(stopped, { name2: 'Aria' })).toBe(false);
    });
});
