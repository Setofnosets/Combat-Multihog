import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { testExtensionSettings } from './setup.js';

vi.mock('../../../../script.js', () => ({
    getRequestHeaders: () => ({}),
}));

import {
    buildLewdCombatRuntimeOverride,
    lewdCombatToolConfigured,
    onLewdUserTurn,
    registerLewdCombatTool,
    syncLewdCombatToolRegistration,
    unregisterLewdCombatTool,
} from '../narrative-hooks.js';
import { canStartLewdEncounter, consumeLewdResolution } from '../src/features/lewd-combat/lewd-combat-context.js';
import { buildDefaultSettings } from '../src/state/defaults.js';
import { RT_PROMPTS } from '../constants.js';

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const hooksSource = readFileSync(new URL('../narrative-hooks.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../src/features/lewd-combat/lewd-combat-ui.js', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
const syspromptSource = readFileSync(new URL('../sysprompt.txt', import.meta.url), 'utf8');
const legacySource = readFileSync(new URL('../sysprompt_legacy.txt', import.meta.url), 'utf8');

function settings() {
    return testExtensionSettings.rpg_tracker;
}

function mockContext(extra = {}) {
    vi.spyOn(SillyTavern, 'getContext').mockReturnValue({
        extensionSettings: testExtensionSettings,
        chatId: 'vitest-chat',
        ...extra,
    });
}

describe('Lewd Combat narrator function tool', () => {
    beforeEach(() => {
        unregisterLewdCombatTool();
        for (const key of Object.keys(testExtensionSettings)) delete testExtensionSettings[key];
        testExtensionSettings.rpg_tracker = {
            lewdCombatEnabled: true,
            syspromptModules: { lewd_combat: true },
            currentMemo: '',
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis._rpgGenerationBusy;
    });

    it('registers StartLewdCombat once with the public draft-04 schema', () => {
        const registerFunctionTool = vi.fn();
        const unregisterFunctionTool = vi.fn();
        mockContext({ registerFunctionTool, unregisterFunctionTool });

        registerLewdCombatTool();

        expect(unregisterFunctionTool).toHaveBeenCalledWith('StartLewdCombat');
        expect(registerFunctionTool).toHaveBeenCalledTimes(1);
        const tool = registerFunctionTool.mock.calls[0][0];
        expect(tool.name).toBe('StartLewdCombat');
        expect(tool.displayName).toBe('Lewd Combat');
        expect(tool.description).toMatch(/player-initiated/i);
        expect(tool.description).toMatch(/do not call it for ordinary hostile combat/i);
        expect(tool.parameters.$schema).toBe('http://json-schema.org/draft-04/schema#');
        expect(tool.parameters.type).toBe('object');
        expect(tool.parameters.required).toEqual([]);
        expect(Object.keys(tool.parameters.properties).sort()).toEqual([
            'controlMode', 'location', 'mode', 'openingTechnique', 'openingZone', 'participantNames', 'reason', 'spectatorNames', 'title', 'tone',
        ]);
        expect(tool.parameters.properties.mode.enum).toEqual(['duel', 'group', 'free-for-all']);
        expect(tool.parameters.properties.controlMode.enum).toEqual(['auto', 'player-all', 'ai-others']);
        expect(tool.stealth).toBe(false);
        expect(typeof tool.action).toBe('function');
        expect(tool.formatMessage()).toMatch(/board is open/i);

        // No [COMBAT] and an empty memo are irrelevant: this tool is not gated on them.
        expect(tool.shouldRegister()).toBe(true);
        settings().currentMemo = '';
        expect(tool.shouldRegister()).toBe(true);
    });

    it('limits availability to the enabled module and an idle chat', () => {
        const registerFunctionTool = vi.fn();
        const unregisterFunctionTool = vi.fn();
        mockContext({ registerFunctionTool, unregisterFunctionTool });
        registerLewdCombatTool();
        const tool = registerFunctionTool.mock.calls[0][0];
        const s = settings();

        s.lewdCombatEnabled = false;
        expect(tool.shouldRegister()).toBe(false);
        s.lewdCombatEnabled = true;

        s.syspromptModules = { lewd_combat: false };
        expect(tool.shouldRegister()).toBe(false);
        s.syspromptModules = { lewd_combat: true };

        s.lewdCombatByChat = { 'vitest-chat': { status: 'active' } };
        expect(tool.shouldRegister()).toBe(false);
        delete s.lewdCombatByChat;

        s.tacticalCombatReturn = { chatId: 'vitest-chat', stateId: 'pending' };
        expect(tool.shouldRegister()).toBe(false);
        delete s.tacticalCombatReturn;

        s.tacticalCombatReturnByChat = { 'vitest-chat': { chatId: 'vitest-chat', stateId: 'pending-2' } };
        expect(tool.shouldRegister()).toBe(false);
        delete s.tacticalCombatReturnByChat;

        s.tacticalCombatByChat = { 'vitest-chat': { status: 'active' } };
        expect(tool.shouldRegister()).toBe(false);
        delete s.tacticalCombatByChat;

        s.traditionalCombatByChat = { 'vitest-chat': { status: 'active' } };
        expect(tool.shouldRegister()).toBe(false);
        delete s.traditionalCombatByChat;

        expect(tool.shouldRegister()).toBe(true);
        expect(lewdCombatToolConfigured()).toBe(true);
    });

    it('stays unavailable through the handoff and re-arms after manual consumption', () => {
        const registerFunctionTool = vi.fn();
        const unregisterFunctionTool = vi.fn();
        mockContext({ registerFunctionTool, unregisterFunctionTool });
        const s = settings();
        s.lewdCombatPostEncounterCooldownMs = 0;
        s.lewdCombatByChat = {
            'vitest-chat': {
                id: 'lewd-latch',
                status: 'ended',
                endedAt: Date.now(),
                resolution: {
                    stateId: 'lewd-latch',
                    endedAt: Date.now(),
                    consumedAt: 0,
                    consumedFor: '',
                    deliveredAt: Date.now(),
                },
            },
        };
        registerLewdCombatTool();
        const tool = registerFunctionTool.mock.calls[0][0];

        expect(tool.shouldRegister()).toBe(false);
        expect(canStartLewdEncounter(s, 'vitest-chat').ok).toBe(false);

        consumeLewdResolution(s, 'vitest-chat', { reason: 'manual', persist: false });
        expect(tool.shouldRegister()).toBe(true);
        expect(canStartLewdEncounter(s, 'vitest-chat').ok).toBe(true);
    });

    it('consumes a delivered result on the next user turn and re-registers', () => {
        const registerFunctionTool = vi.fn();
        const unregisterFunctionTool = vi.fn();
        mockContext({ registerFunctionTool, unregisterFunctionTool });
        const s = settings();
        s.lewdCombatPostEncounterCooldownMs = 0;
        const board = {
            id: 'lewd-delivered',
            status: 'ended',
            endedAt: Date.now(),
            resolution: {
                stateId: 'lewd-delivered',
                endedAt: Date.now(),
                consumedAt: 0,
                consumedFor: '',
                deliveredAt: Date.now(),
            },
        };
        s.lewdCombatByChat = { 'vitest-chat': board };

        onLewdUserTurn();
        expect(board.resolution.consumedFor).toBe('user-turn');
        expect(registerFunctionTool).toHaveBeenCalledTimes(1);
        expect(registerFunctionTool.mock.calls[0][0].name).toBe('StartLewdCombat');
    });

    it('never consumes the latch on generation start/end registration syncs', () => {
        const registerFunctionTool = vi.fn();
        const unregisterFunctionTool = vi.fn();
        mockContext({ registerFunctionTool, unregisterFunctionTool });
        const s = settings();
        s.lewdCombatPostEncounterCooldownMs = 0;
        const board = {
            id: 'lewd-busy',
            status: 'ended',
            endedAt: Date.now(),
            resolution: {
                stateId: 'lewd-busy',
                endedAt: Date.now(),
                consumedAt: 0,
                consumedFor: '',
                deliveredAt: Date.now(),
            },
        };
        s.lewdCombatByChat = { 'vitest-chat': board };

        // GENERATION_STARTED and GENERATION_ENDED both call the sync, including
        // for swipes/continues. Neither is a player turn, so neither consumes.
        globalThis._rpgGenerationBusy = false;
        syncLewdCombatToolRegistration();
        expect(board.resolution.consumedAt).toBe(0);
        expect(registerFunctionTool).not.toHaveBeenCalled();

        globalThis._rpgGenerationBusy = true;
        syncLewdCombatToolRegistration();
        expect(board.resolution.consumedAt).toBe(0);
        expect(registerFunctionTool).not.toHaveBeenCalled();

        // Only the explicit user-turn hook releases the latch.
        globalThis._rpgGenerationBusy = false;
        onLewdUserTurn();
        expect(board.resolution.consumedFor).toBe('user-turn');
        expect(registerFunctionTool).toHaveBeenCalledTimes(1);
    });

    it('syncs registration without any combat-style coupling', () => {
        const registerFunctionTool = vi.fn();
        const unregisterFunctionTool = vi.fn();
        mockContext({ registerFunctionTool, unregisterFunctionTool });

        syncLewdCombatToolRegistration();
        expect(registerFunctionTool).toHaveBeenCalledTimes(1);
        expect(registerFunctionTool.mock.calls[0][0].name).toBe('StartLewdCombat');

        settings().lewdCombatEnabled = false;
        syncLewdCombatToolRegistration();
        expect(unregisterFunctionTool).toHaveBeenCalledWith('StartLewdCombat');
    });

    it('injects the runtime override only while a lewd board owns the chat', () => {
        const s = settings();
        expect(buildLewdCombatRuntimeOverride(s)).toBe('');

        s.lewdCombatEnabled = false;
        s.lewdCombatByChat = { 'vitest-chat': { status: 'active' } };
        expect(buildLewdCombatRuntimeOverride(s)).toBe('');

        s.lewdCombatEnabled = true;
        expect(buildLewdCombatRuntimeOverride(s)).toContain('[LEWD_COMBAT_OVERRIDE]');
        expect(buildLewdCombatRuntimeOverride(s)).toContain('StartLewdCombat');
        expect(buildLewdCombatRuntimeOverride(s)).toContain('Do not narrate');

        s.tacticalCombatReturn = { chatId: 'vitest-chat', stateId: 'pending' };
        expect(buildLewdCombatRuntimeOverride(s)).toBe('');
        delete s.tacticalCombatReturn;

        s.lewdCombatByChat = { 'vitest-chat': { status: 'ended' } };
        expect(buildLewdCombatRuntimeOverride(s)).toBe('');

        s.lewdCombatByChat = {
            'vitest-chat': {
                status: 'ended',
                resolution: { stateId: 'lewd-1', consumedAt: 0, deliveredAt: 0 },
            },
        };
        const handoff = buildLewdCombatRuntimeOverride(s);
        expect(handoff).toContain('[LEWD_COMBAT_OVERRIDE]');
        expect(handoff).toMatch(/do not resume or restart/i);
        expect(handoff).toContain('StartLewdCombat');

        s.lewdCombatByChat = {
            'vitest-chat': {
                status: 'ended',
                resolution: { stateId: 'lewd-1', consumedAt: Date.now(), consumedFor: 'user-turn' },
            },
        };
        expect(buildLewdCombatRuntimeOverride(s)).toBe('');

        delete s.lewdCombatByChat;
        expect(buildLewdCombatRuntimeOverride(s)).toBe('');
    });

    it('wires the tool, prompt section, and defaults into the shipped sources', () => {
        expect(hooksSource).toContain("name: 'StartLewdCombat'");
        expect(hooksSource).toContain('export function syncLewdCombatToolRegistration');
        expect(hooksSource).toContain('[LEWD_COMBAT_OVERRIDE]');
        expect(hooksSource).toContain('LEWD_COMBAT_RESULT_NOTICE');

        expect(indexSource).toContain('MESSAGE_SENT, () => syncLewdCombatToolRegistration()');
        expect(indexSource).toMatch(
            /registerDiceFunctionTool\(\);\s*syncTacticalCombatToolRegistration\(\);\s*syncTraditionalCombatToolRegistration\(\);\s*syncLocationMappingRuntime\(\);\s*syncLewdCombatToolRegistration\(\);/,
        );

        expect(settingsSource).toContain('rpg_sysprompt_mod_lewd_combat');
        expect(buildDefaultSettings().syspromptModules.lewd_combat).toBe(true);

        for (const source of [
            RT_PROMPTS['sysprompt.txt'],
            RT_PROMPTS['sysprompt_legacy.txt'],
            syspromptSource,
            legacySource,
        ]) {
            expect(source.replaceAll('\r\n', '\n')).toContain('<lewd_combat>');
            expect(source.replaceAll('\r\n', '\n')).toContain('StartLewdCombat');
        }
    });

    it('exposes a narrator start path that opens the board without running AI turns', () => {
        const start = uiSource.indexOf('export async function startLewdCombatFromNarrator');
        expect(start).toBeGreaterThan(-1);
        const finish = uiSource.indexOf('function loadStartCandidates', start);
        expect(finish).toBeGreaterThan(start);
        const body = uiSource.slice(start, finish);
        expect(body).toContain('openLewdCombatBoard');
        expect(body).not.toContain('runAiTurns');
    });

    it('refuses a lewd start while a tactical board is active but allows a finished one', () => {
        const s = {
            lewdCombatEnabled: true,
            lewdCombatByChat: {},
            tacticalCombatByChat: { 'vitest-chat': { status: 'active' } },
        };
        expect(canStartLewdEncounter(s, 'vitest-chat')).toMatchObject({ ok: false });
        expect(canStartLewdEncounter(s, 'vitest-chat').reason).toMatch(/tactical\/traditional/i);

        s.tacticalCombatByChat = { 'vitest-chat': { status: 'ended' } };
        expect(canStartLewdEncounter(s, 'vitest-chat').ok).toBe(true);
    });
});
