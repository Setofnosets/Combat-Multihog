import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testExtensionSettings } from './setup.js';

vi.mock('../../../../script.js', () => ({
    getRequestHeaders: () => ({}),
}));

import { buildTraditionalCombatRuntimeOverride, registerTraditionalCombatTool } from '../narrative-hooks.js';

describe('Traditional Combat narrator function tool', () => {
    beforeEach(() => {
        for (const key of Object.keys(testExtensionSettings)) delete testExtensionSettings[key];
        testExtensionSettings.rpg_tracker = {
            combatStyle: 'traditional',
            tacticalCombatEnabled: false,
            syspromptModules: { traditional_combat: true },
            currentMemo: '[COMBAT]\nGoblin: 10/10 HP\n[/COMBAT]',
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('registers StartTraditionalCombat with a valid schema and mode-aware availability', () => {
        const registerFunctionTool = vi.fn();
        const unregisterFunctionTool = vi.fn();
        vi.spyOn(SillyTavern, 'getContext').mockReturnValue({
            extensionSettings: testExtensionSettings,
            chatId: 'vitest-chat',
            registerFunctionTool,
            unregisterFunctionTool,
        });

        registerTraditionalCombatTool();

        expect(unregisterFunctionTool).toHaveBeenCalledWith('StartTraditionalCombat');
        expect(registerFunctionTool).toHaveBeenCalledTimes(1);
        const tool = registerFunctionTool.mock.calls[0][0];
        expect(tool.name).toBe('StartTraditionalCombat');
        expect(tool.displayName).toBe('Traditional Combat');
        expect(tool.description).toMatch(/turn-based combat board/i);
        expect(tool.parameters.$schema).toBe('http://json-schema.org/draft-04/schema#');
        expect(tool.parameters.required).toEqual([]);
        expect(Object.keys(tool.parameters.properties).sort()).toEqual([
            'description', 'enemyNames', 'location', 'openingAction', 'openingSkill', 'openingTarget', 'reason', 'surprise', 'title',
        ]);
        expect(tool.shouldRegister()).toBe(true);

        testExtensionSettings.rpg_tracker.combatStyle = 'tactical';
        testExtensionSettings.rpg_tracker.tacticalCombatEnabled = true;
        expect(tool.shouldRegister()).toBe(false);

        testExtensionSettings.rpg_tracker.combatStyle = 'traditional';
        testExtensionSettings.rpg_tracker.traditionalCombatByChat = { 'vitest-chat': { status: 'active' } };
        expect(tool.shouldRegister()).toBe(false);
        delete testExtensionSettings.rpg_tracker.traditionalCombatByChat;

        testExtensionSettings.rpg_tracker.tacticalCombatReturn = { chatId: 'vitest-chat', stateId: 'trad-test' };
        expect(tool.shouldRegister()).toBe(false);
        delete testExtensionSettings.rpg_tracker.tacticalCombatReturn;

        testExtensionSettings.rpg_tracker.syspromptModules = { traditional_combat: false };
        expect(tool.shouldRegister()).toBe(false);
    });

    it('injects a traditional override for engaged, dormant, and active boards', () => {
        const settings = testExtensionSettings.rpg_tracker;
        vi.spyOn(SillyTavern, 'getContext').mockReturnValue({
            extensionSettings: testExtensionSettings,
            chatId: 'vitest-chat',
        });

        settings.currentMemo = '[COMBAT]\nCOMBAT STATE: DORMANT\nENEMIES:\nGoblin: 10/10 HP\n[/COMBAT]';
        expect(buildTraditionalCombatRuntimeOverride(settings)).toContain('DORMANT_ENCOUNTER');

        settings.currentMemo = '[COMBAT]\nCOMBAT STATE: HOSTILE\nCOMBAT ROUND 1\nENEMIES:\nGoblin: 10/10 HP\n[/COMBAT]';
        const engaged = buildTraditionalCombatRuntimeOverride(settings);
        expect(engaged).toContain('[TRADITIONAL_COMBAT_OVERRIDE]');
        expect(engaged).toContain('Call the StartTraditionalCombat function tool exactly once');

        settings.traditionalCombatByChat = { 'vitest-chat': { status: 'active' } };
        const active = buildTraditionalCombatRuntimeOverride(settings);
        expect(active).toContain('currently being resolved on the board');
        expect(active).not.toContain('Call the StartTraditionalCombat function tool');
    });
});
