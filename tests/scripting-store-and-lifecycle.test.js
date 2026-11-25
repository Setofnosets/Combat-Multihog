import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { testExtensionSettings } from './setup.js';

vi.mock('../portrait-storage.js', () => ({
    lookupCustomPortraitSrc: () => '',
}));

vi.mock('../ui-editors.js', () => ({
    refreshOrderList: vi.fn(),
}));

vi.mock('../game-systems.js', () => ({
    syncAllNarratorTogglesForUnlockState: vi.fn(),
}));

import {
    captureScriptSnapshot,
    deleteScript,
    getChatScriptRecord,
    getChatScriptState,
    getScriptById,
    isScriptEnabledForChat,
    listScripts,
    reorderScripts,
    restoreScriptSwipeSnapshot,
    setChatScriptEnabled,
    setChatScriptRecord,
    stampScriptSwipeSnapshot,
    upsertScript,
} from '../src/features/scripting/script-store.js';
import {
    handleHostScriptSwipeRollback,
    initScriptHostAdapter,
    runHostScriptsAfterGenerate,
    runHostScriptsBeforeGenerate,
    syncScriptToolRegistrations,
} from '../src/features/scripting/script-host-adapter.js';
import { onChatRenamedMigrate } from '../src/features/chat/chat-rename-migrate.js';
import { removeDeletedChatData, storedChatIds } from '../src/features/chat/deleted-chat-data.js';
import { copyChatStatePartition } from '../src/features/chat/branch-campaign-utils.js';
import { applyCartridgePayload, buildCartridgePayload } from '../game-cartridges.js';
import { CARTRIDGE_PAYLOAD_GROUPS, getSettings } from '../state-manager.js';
import { buildModulesInstructionText } from '../memo-processor.js';
import { registerScriptCardMetaResolver, renderMemoAsCards } from '../renderer.js';
import { runtimeState } from '../src/app/runtime-state.js';
import { configureRuntimeActions } from '../src/app/runtime-bridge.js';

const settingsOverlaySource = readFileSync(new URL('../src/ui/settings-overlay.js', import.meta.url), 'utf8');
const settingsHtmlSource = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const narrativeHooksSource = readFileSync(new URL('../narrative-hooks.js', import.meta.url), 'utf8');

function resetTestSettings() {
    for (const key of Object.keys(testExtensionSettings)) {
        delete testExtensionSettings[key];
    }
    localStorage.clear();
    runtimeState.currentChatId = null;
    runtimeState.pendingUnseenChatReset = null;
    runtimeState.loreRedoStack = [];
    globalThis.toastr = {
        warning: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        error: vi.fn(),
    };
}

function makeRoundTripScript(overrides = {}) {
    return {
        id: 'roundtrip_script',
        name: 'Roundtrip Tracker',
        icon: '🧪',
        trackerTag: 'ROUNDTRIP',
        scope: 'global',
        globalEnabled: true,
        commandPrefix: '!rt',
        stripCommandFromPrompt: true,
        toolEnabled: true,
        toolName: 'Script_Roundtrip',
        toolActions: [
            {
                name: 'tick',
                description: 'Increment counter and append summary',
                params: [
                    { name: 'amount', type: 'number', description: 'Delta', required: false },
                ],
            },
        ],
        code: `
            function initState() {
                return { count: 0, note: 'init', portrait: '' };
            }
            function onBeforeGenerate(state, ctx) {
                const next = { ...state };
                const cmd = String((ctx && ctx.command && ctx.command.subcommand) || '').trim().toLowerCase();
                if (cmd === 'boost') {
                    next.count += 10;
                    next.note = 'boosted';
                    return {
                        state: next,
                        stripCommand: true,
                        promptInjection: 'Pre-turn boost applied.',
                    };
                }
                return { state: next };
            }
            function onToolCall(state, call) {
                const next = { ...state };
                const action = call && call.action;
                const args = (call && call.args) || {};
                if (action === 'tick') {
                    const delta = Number(args.amount || 1);
                    next.count += delta;
                    next.note = 'ticked';
                    return {
                        state: next,
                        appendMarkdown: '**Script Log:** +' + delta + ' (total ' + next.count + ')',
                        toolResult: { ok: true, count: next.count },
                    };
                }
                return { state: next, toolResult: { ok: false } };
            }
            function onAfterGenerate(state) {
                if (state.note === 'ticked') {
                    return {
                        state,
                        appendMarkdown: '**Script Log:** +1 (total ' + state.count + ')',
                    };
                }
                return { state };
            }
            function renderMemo(state) {
                return 'Count: ' + state.count + '\\nNote: ' + state.note;
            }
        `,
        ...overrides,
    };
}

describe('Game Scripts Store, Persistence & Integration', () => {
    beforeEach(() => {
        resetTestSettings();
        configureRuntimeActions({
            saveSettings: vi.fn(),
        });
        const base = {
            extensionSettings: testExtensionSettings,
            chatId: 'chat-default',
            getCurrentChatId: () => 'chat-default',
            saveSettingsDebounced: () => {},
        };
        SillyTavern.getContext = () => ({ ...base });
        registerScriptCardMetaResolver(null);
    });

    describe('1. Catalog CRUD & Ordering (script-store.js)', () => {
        it('supports upsertScript, listScripts, getScriptById, reorderScripts, and deleteScript cleanup', () => {
            const settings = getSettings();

            const savedA = upsertScript(settings, {
                id: 'alpha_script',
                name: 'Alpha Script',
                trackerTag: 'ALPHA',
                scope: 'chat',
                code: 'function initState() { return { v: 1 }; }',
            });
            const savedB = upsertScript(settings, {
                id: 'beta_script',
                name: 'Beta Script',
                trackerTag: 'BETA',
                scope: 'global',
                globalEnabled: true,
                code: 'function initState() { return { v: 2 }; }',
            });
            const savedC = upsertScript(settings, {
                id: 'gamma_script',
                name: 'Gamma Script',
                trackerTag: 'GAMMA',
                scope: 'chat',
                code: 'function initState() { return { v: 3 }; }',
            });

            expect(savedA.id).toBe('alpha_script');
            expect(savedB.id).toBe('beta_script');
            expect(savedC.id).toBe('gamma_script');
            expect(settings.gameScriptOrder).toEqual(['alpha_script', 'beta_script', 'gamma_script']);

            // Update existing preserves createdAt and refreshes updatedAt
            const updatedA = upsertScript(settings, {
                id: 'alpha_script',
                name: 'Alpha Script v2',
                trackerTag: 'ALPHA',
                scope: 'chat',
                code: 'function initState() { return { v: 99 }; }',
            });
            expect(updatedA.createdAt).toBe(savedA.createdAt);
            expect(updatedA.name).toBe('Alpha Script v2');
            expect(getScriptById(settings, 'alpha_script')?.name).toBe('Alpha Script v2');
            expect(getScriptById(settings, 'missing_id')).toBeNull();

            // Reorder scripts (ignores unknown IDs and preserves omitted valid ones)
            const nextOrder = reorderScripts(settings, ['gamma_script', 'alpha_script', 'nonexistent']);
            expect(nextOrder).toEqual(['gamma_script', 'alpha_script', 'beta_script']);
            expect(listScripts(settings).map(s => s.id)).toEqual(['gamma_script', 'alpha_script', 'beta_script']);

            // Seed runtime state + per-chat setup override before delete
            setChatScriptRecord(settings, 'chat-1', 'alpha_script', { state: { v: 42 } });
            setChatScriptRecord(settings, 'chat-2', 'alpha_script', { state: { v: 7 } });
            setChatScriptRecord(settings, 'chat-1', 'beta_script', { state: { v: 2 } });
            setChatScriptEnabled(settings, 'chat-1', 'alpha_script', true);
            setChatScriptEnabled(settings, 'chat-2', 'alpha_script', false);
            setChatScriptEnabled(settings, 'chat-1', 'beta_script', true);

            expect(deleteScript(settings, 'alpha_script')).toBe(true);
            expect(deleteScript(settings, 'alpha_script')).toBe(false);

            expect(settings.gameScriptDatabase.map(s => s.id)).toEqual(['beta_script', 'gamma_script']);
            expect(settings.gameScriptOrder).toEqual(['gamma_script', 'beta_script']);
            expect(settings.gameScriptStatesByChat['chat-1'].alpha_script).toBeUndefined();
            expect(settings.gameScriptStatesByChat['chat-2'].alpha_script).toBeUndefined();
            expect(settings.gameScriptStatesByChat['chat-1'].beta_script).toBeDefined();
            expect(settings.chatStates['chat-1'].setup.gameScriptStates.alpha_script).toBeUndefined();
            expect(settings.chatStates['chat-2'].setup.gameScriptStates.alpha_script).toBeUndefined();
            expect(settings.chatStates['chat-1'].setup.gameScriptStates.beta_script).toBe(true);
        });
    });

    describe('2. Scope & Character Auto-Binding Resolution', () => {
        it('resolves chat, global, character, override precedence, and disabled_master cleanly', () => {
            const settings = getSettings();

            const chatScoped = upsertScript(settings, {
                id: 'chat_only',
                name: 'Chat Only',
                scope: 'chat',
                code: 'function initState() { return {}; }',
            });
            const globalOn = upsertScript(settings, {
                id: 'global_on',
                name: 'Global On',
                scope: 'global',
                globalEnabled: true,
                code: 'function initState() { return {}; }',
            });
            const globalOff = upsertScript(settings, {
                id: 'global_off',
                name: 'Global Off',
                scope: 'global',
                globalEnabled: false,
                code: 'function initState() { return {}; }',
            });
            const charScoped = upsertScript(settings, {
                id: 'char_bound',
                name: 'Char Bound',
                scope: 'character',
                boundCharacters: ['Seraphina', 'Mira Vance'],
                code: 'function initState() { return {}; }',
            });

            // Chat scope: inactive until explicitly enabled
            expect(isScriptEnabledForChat(settings, chatScoped, 'chat-1', 'Seraphina')).toEqual({
                enabled: false,
                reason: 'chat',
            });
            setChatScriptEnabled(settings, 'chat-1', 'chat_only', true);
            expect(isScriptEnabledForChat(settings, chatScoped, 'chat-1', 'Seraphina')).toEqual({
                enabled: true,
                reason: 'override',
            });

            // Global scope: follows globalEnabled unless overridden per chat
            expect(isScriptEnabledForChat(settings, globalOn, 'chat-1')).toEqual({
                enabled: true,
                reason: 'global',
            });
            expect(isScriptEnabledForChat(settings, globalOff, 'chat-1')).toEqual({
                enabled: false,
                reason: 'global',
            });
            setChatScriptEnabled(settings, 'chat-1', 'global_on', false);
            expect(isScriptEnabledForChat(settings, globalOn, 'chat-1')).toEqual({
                enabled: false,
                reason: 'override',
            });
            expect(isScriptEnabledForChat(settings, globalOn, 'chat-2')).toEqual({
                enabled: true,
                reason: 'global',
            });

            // Character scope: case-insensitive match + explicit override precedence
            expect(isScriptEnabledForChat(settings, charScoped, 'chat-1', 'seraphina')).toEqual({
                enabled: true,
                reason: 'character',
            });
            expect(isScriptEnabledForChat(settings, charScoped, 'chat-1', '  MIRA VANCE  ')).toEqual({
                enabled: true,
                reason: 'character',
            });
            expect(isScriptEnabledForChat(settings, charScoped, 'chat-1', 'Goblin King')).toEqual({
                enabled: false,
                reason: 'character',
            });

            setChatScriptEnabled(settings, 'chat-1', 'char_bound', false);
            expect(isScriptEnabledForChat(settings, charScoped, 'chat-1', 'Seraphina')).toEqual({
                enabled: false,
                reason: 'override',
            });
            setChatScriptEnabled(settings, 'chat-1', 'char_bound', true);
            expect(isScriptEnabledForChat(settings, charScoped, 'chat-1', 'Goblin King')).toEqual({
                enabled: true,
                reason: 'override',
            });

            // Master switch disables all scripts cleanly
            settings.gameScriptsEnabled = false;
            for (const script of [chatScoped, globalOn, globalOff, charScoped]) {
                expect(isScriptEnabledForChat(settings, script, 'chat-1', 'Seraphina')).toEqual({
                    enabled: false,
                    reason: 'disabled_master',
                });
            }
        });
    });

    describe('3. Swipe Rollback Snapshots & Full Turn Round-Trip', () => {
        it('captures, stamps, and restores swipe snapshots without clobbering unrelated swipes', () => {
            const settings = getSettings();
            const chatId = 'swipe-chat';
            const lastAiMsg = { mes: 'Turn 1', swipe_id: 0, extra: {} };

            setChatScriptRecord(settings, chatId, 's1', { state: { hp: 100 } });
            const before0 = captureScriptSnapshot(settings, chatId);

            setChatScriptRecord(settings, chatId, 's1', { state: { hp: 75 } });
            const after0 = captureScriptSnapshot(settings, chatId);
            stampScriptSwipeSnapshot(lastAiMsg, 0, before0, after0);

            // Simulate user generating swipe 1 (before = 100, after = 50)
            lastAiMsg.swipe_id = 1;
            const before1 = cloneViaJson(before0);
            setChatScriptRecord(settings, chatId, 's1', { state: { hp: 50 } });
            const after1 = captureScriptSnapshot(settings, chatId);
            stampScriptSwipeSnapshot(lastAiMsg, 1, before1, after1);

            // Mutate live state unexpectedly and swipe back to 0 -> restores swipe 0 result (75)
            setChatScriptRecord(settings, chatId, 's1', { state: { hp: 999 } });
            lastAiMsg.swipe_id = 0;
            const resTo0 = restoreScriptSwipeSnapshot(lastAiMsg, settings, chatId);
            expect(resTo0.anyChanged).toBe(true);
            expect(getChatScriptState(settings, chatId, 's1')).toEqual({ hp: 75 });

            // Swipe forward to 1 -> restores swipe 1 result (50), swipe 0 result still intact
            lastAiMsg.swipe_id = 1;
            const resTo1 = restoreScriptSwipeSnapshot(lastAiMsg, settings, chatId);
            expect(resTo1.anyChanged).toBe(true);
            expect(getChatScriptState(settings, chatId, 's1')).toEqual({ hp: 50 });
            expect(lastAiMsg.extra.rpgScriptResult[0].s1.state).toEqual({ hp: 75 });

            // Swipe from swipe 0 to a brand-new unseen swipe index 2 -> falls back to rollback[0] (100)
            lastAiMsg.swipe_id = 0;
            restoreScriptSwipeSnapshot(lastAiMsg, settings, chatId);
            stampScriptSwipeSnapshot(lastAiMsg, 0, before0, after0);
            lastAiMsg.swipe_id = 2;
            const resTo2 = restoreScriptSwipeSnapshot(lastAiMsg, settings, chatId);
            expect(resTo2.anyChanged).toBe(true);
            expect(getChatScriptState(settings, chatId, 's1')).toEqual({ hp: 100 });
            expect(lastAiMsg.extra.rpgScriptResult[0].s1.state).toEqual({ hp: 75 });
            expect(lastAiMsg.extra.rpgScriptResult[1].s1.state).toEqual({ hp: 50 });
        });

        it('executes full beforeGenerate -> tool call -> afterGenerate -> swipe rollback round-trip with deduplicated appendMarkdown', async () => {
            const settings = getSettings();
            const chatId = 'roundtrip-chat';
            const registeredTools = new Map();

            const baseCtx = SillyTavern.getContext();
            SillyTavern.getContext = () => ({
                ...baseCtx,
                chatId,
                getCurrentChatId: () => chatId,
                registerFunctionTool: (def) => {
                    registeredTools.set(def.name, def);
                },
                unregisterFunctionTool: (name) => {
                    registeredTools.delete(name);
                },
                updateMessageBlock: vi.fn(),
                saveChatDebounced: vi.fn(),
            });

            const script = upsertScript(settings, makeRoundTripScript());
            setChatScriptRecord(settings, chatId, script.id, {
                state: { count: 2, note: 'ready', portrait: '' },
            });

            syncScriptToolRegistrations(settings, chatId);
            const toolDef = registeredTools.get('Script_Roundtrip');
            expect(toolDef).toBeDefined();

            // 1) Before generate with pre-turn command
            const preRes = await runHostScriptsBeforeGenerate({
                chat: [],
                lastUserMessage: '!rt boost\nHello',
                settings,
                chatId,
            });
            expect(preRes.ran).toBe(true);
            expect(preRes.stripCommand).toBe(true);
            expect(preRes.strippedMessage).toBe('Hello');
            expect(preRes.promptInjection).toContain('[SCRIPT_EVENT]');
            expect(preRes.promptInjection).toContain('Pre-turn boost applied.');
            expect(getChatScriptState(settings, chatId, script.id)).toEqual({
                count: 12,
                note: 'boosted',
                portrait: '',
            });

            // 2) Tool call during generation
            const toolRawResult = await toolDef.action({ action: 'tick', amount: 1 });
            expect(JSON.parse(toolRawResult)).toEqual({ ok: true, count: 13 });
            expect(getChatScriptState(settings, chatId, script.id).count).toBe(13);

            // 3) After generate: appends markdown once (not duplicated when onAfterGenerate emits identical snippet)
            const lastAiMsg = {
                mes: 'The tavern lights flicker.',
                content: 'The tavern lights flicker.',
                swipes: ['The tavern lights flicker.'],
                swipe_id: 0,
                extra: {},
            };
            const afterRes = await runHostScriptsAfterGenerate({
                chat: [lastAiMsg],
                lastAiMsg,
                settings,
                chatId,
            });
            expect(afterRes.ran).toBe(true);
            expect(afterRes.errors).toEqual([]);
            const expectedSnippet = '**Script Log:** +1 (total 13)';
            expect(afterRes.appendedMarkdown).toEqual([expectedSnippet]);
            expect(lastAiMsg.mes.match(/\*\*Script Log:\*\*/g)).toHaveLength(1);
            expect(lastAiMsg.swipes[0]).toContain(expectedSnippet);
            expect(settings.currentMemo).toContain('Count: 13');

            // 4) Swipe to swipe 1 (unseen) -> rolls back to pre-turn snapshot (count: 2) and re-renders memo
            lastAiMsg.swipe_id = 1;
            const rollbackRes = await handleHostScriptSwipeRollback(lastAiMsg, settings, chatId);
            expect(rollbackRes.anyChanged).toBe(true);
            expect(getChatScriptState(settings, chatId, script.id).count).toBe(2);
            expect(settings.currentMemo).toContain('Count: 2');
            expect(settings.currentMemo).toContain('Note: ready');

            // 5) Swipe back to swipe 0 -> restores count: 13; re-running afterGenerate does not duplicate snippet already in lastAiMsg.mes
            lastAiMsg.swipe_id = 0;
            const restore0Res = await handleHostScriptSwipeRollback(lastAiMsg, settings, chatId);
            expect(restore0Res.anyChanged).toBe(true);
            expect(getChatScriptState(settings, chatId, script.id).count).toBe(13);

            const duplicateRes = await runHostScriptsAfterGenerate({
                chat: [lastAiMsg],
                lastAiMsg,
                settings,
                chatId,
            });
            expect(duplicateRes.appendedMarkdown).toEqual([]);
            expect(lastAiMsg.mes.match(/\*\*Script Log:\*\*/g)).toHaveLength(1);
        });
    });

    describe('4. Chat Rename, Delete & Campaign Branch Persistence', () => {
        it('migrates gameScriptStatesByChat on chat rename', async () => {
            const settings = getSettings();
            const baseCtx = SillyTavern.getContext();
            SillyTavern.getContext = () => ({
                ...baseCtx,
                chatId: 'Renamed Chat',
                getCurrentChatId: () => 'Renamed Chat',
            });

            settings.chatStates = {
                'Old Chat': {
                    currentMemo: 'alive',
                    setup: { gameScriptStates: { my_script: true } },
                },
            };
            settings.gameScriptStatesByChat = {
                'Old Chat': {
                    my_script: { state: { gold: 42 }, portraitUrl: '', lastUpdatedAt: 100, lastError: null },
                },
            };

            await onChatRenamedMigrate(
                { oldFileName: 'Old Chat.jsonl', newFileName: 'Renamed Chat.jsonl' },
                { saveSettings: vi.fn(), loadChatState: vi.fn(() => true) },
            );

            expect(settings.gameScriptStatesByChat['Old Chat']).toBeUndefined();
            expect(settings.gameScriptStatesByChat['Renamed Chat']).toEqual({
                my_script: { state: { gold: 42 }, portraitUrl: '', lastUpdatedAt: 100, lastError: null },
            });
        });

        it('discovers gameScriptStatesByChat in storedChatIds and deletes it in removeDeletedChatData', () => {
            const settings = getSettings();
            settings.gameScriptStatesByChat = {
                'orphan-script-chat': {
                    my_script: { state: { hp: 10 }, portraitUrl: '', lastUpdatedAt: 1, lastError: null },
                },
                'keep-chat': {
                    my_script: { state: { hp: 20 }, portraitUrl: '', lastUpdatedAt: 2, lastError: null },
                },
            };

            expect(storedChatIds(settings)).toContain('orphan-script-chat');
            expect(storedChatIds(settings)).toContain('keep-chat');

            expect(removeDeletedChatData(settings, 'orphan-script-chat')).toBe(true);
            expect(settings.gameScriptStatesByChat['orphan-script-chat']).toBeUndefined();
            expect(settings.gameScriptStatesByChat['keep-chat']).toBeDefined();
            expect(storedChatIds(settings)).not.toContain('orphan-script-chat');
        });

        it('deep-clones gameScriptStatesByChat in copyChatStatePartition without aliasing source', () => {
            const settings = getSettings();
            settings.chatStates = {
                'source-chat': {
                    currentMemo: '[CHARACTER]Hero[/CHARACTER]',
                    setup: { gameScriptStates: { s1: true } },
                },
            };
            settings.gameScriptStatesByChat = {
                'source-chat': {
                    s1: { state: { inventory: ['dagger'] }, portraitUrl: '', lastUpdatedAt: 10, lastError: null },
                },
            };

            copyChatStatePartition(settings, 'source-chat', 'branch-chat', 'branch_chat', {});

            expect(settings.gameScriptStatesByChat['branch-chat']).toEqual(
                settings.gameScriptStatesByChat['source-chat'],
            );
            settings.gameScriptStatesByChat['branch-chat'].s1.state.inventory.push('potion');
            expect(settings.gameScriptStatesByChat['source-chat'].s1.state.inventory).toEqual(['dagger']);
        });
    });

    describe('5. Game Cartridge Support', () => {
        it('includes gameScripts keys in buildCartridgePayload and CARTRIDGE_PAYLOAD_GROUPS and restores cleanly', () => {
            const settings = getSettings();
            const script = upsertScript(settings, makeRoundTripScript({ id: 'cart_script', name: 'Cartridge Script' }));
            settings.gameScriptsEnabled = false;

            settings.gameScriptPyodideIndexUrl = 'https://custom.local/pyodide/';
            settings.gameScriptPyodideBootTimeoutMs = 30000;

            const payload = buildCartridgePayload(settings);
            expect(payload.gameScriptsEnabled).toBe(false);
            expect(payload.gameScriptPyodideIndexUrl).toBe('https://custom.local/pyodide/');
            expect(payload.gameScriptPyodideBootTimeoutMs).toBe(30000);
            expect(payload.gameScriptDatabase).toHaveLength(1);
            expect(payload.gameScriptDatabase[0].id).toBe(script.id);
            expect(payload.gameScriptOrder).toEqual(['cart_script']);

            const group = CARTRIDGE_PAYLOAD_GROUPS.find(g => g.id === 'gameScripts');
            expect(group).toBeDefined();
            expect(group.keys).toEqual([
                'gameScriptsEnabled',
                'gameScriptPyodideIndexUrl',
                'gameScriptPyodideBootTimeoutMs',
                'gameScriptDatabase',
                'gameScriptOrder',
            ]);

            // Wipe live settings then restore from cartridge payload
            settings.gameScriptsEnabled = true;
            settings.gameScriptPyodideIndexUrl = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/';
            settings.gameScriptPyodideBootTimeoutMs = 25000;
            settings.gameScriptDatabase = [];
            settings.gameScriptOrder = [];

            applyCartridgePayload(settings, payload);
            expect(settings.gameScriptsEnabled).toBe(false);
            expect(settings.gameScriptPyodideIndexUrl).toBe('https://custom.local/pyodide/');
            expect(settings.gameScriptPyodideBootTimeoutMs).toBe(30000);
            expect(settings.gameScriptDatabase).toHaveLength(1);
            expect(settings.gameScriptDatabase[0].id).toBe('cart_script');
            expect(settings.gameScriptOrder).toEqual(['cart_script']);
        });
    });

    describe('6. State Tracker Tag Exclusion (buildModulesInstructionText)', () => {
        it('omits stock and custom modules claimed by enabled scripts in that chat, and keeps them when disabled', () => {
            const settings = getSettings();
            settings.modules = {
                ...settings.modules,
                inventory: true,
                time: true,
            };
            settings.customFields = [
                { id: 'cf-1', tag: 'SANITY', label: 'Sanity', prompt: 'Track sanity 0-100', enabled: true },
                { id: 'cf-2', tag: 'WEATHER', label: 'Weather', prompt: 'Track weather', enabled: true },
            ];

            upsertScript(settings, {
                id: 'sanity_script',
                name: 'Sanity Script',
                trackerTag: 'SANITY',
                scope: 'chat',
                code: 'function initState() { return {}; }',
            });
            upsertScript(settings, {
                id: 'inventory_script',
                name: 'Inventory Script',
                trackerTag: 'INVENTORY',
                scope: 'chat',
                code: 'function initState() { return {}; }',
            });

            // Scripts disabled in chat-a -> both [INVENTORY] and [SANITY] remain in tracker instructions
            const beforeEnable = buildModulesInstructionText(settings, { chatId: 'chat-a' });
            expect(beforeEnable).toContain('- [INVENTORY]:');
            expect(beforeEnable).toContain('- [SANITY]:');
            expect(beforeEnable).toContain('- [WEATHER]:');

            // Enable both scripts in chat-a -> [INVENTORY] and [SANITY] omitted, [WEATHER] kept
            setChatScriptEnabled(settings, 'chat-a', 'sanity_script', true);
            setChatScriptEnabled(settings, 'chat-a', 'inventory_script', true);

            const whileEnabled = buildModulesInstructionText(settings, { chatId: 'chat-a' });
            expect(whileEnabled).not.toContain('- [INVENTORY]:');
            expect(whileEnabled).not.toContain('- [SANITY]:');
            expect(whileEnabled).toContain('- [WEATHER]:');
            expect(whileEnabled).toContain('- [TIME]:');

            // Another chat where scripts are disabled still receives [INVENTORY] and [SANITY]
            const otherChat = buildModulesInstructionText(settings, { chatId: 'chat-b' });
            expect(otherChat).toContain('- [INVENTORY]:');
            expect(otherChat).toContain('- [SANITY]:');

            // Disabling master switch also restores them
            settings.gameScriptsEnabled = false;
            const masterOff = buildModulesInstructionText(settings, { chatId: 'chat-a' });
            expect(masterOff).toContain('- [INVENTORY]:');
            expect(masterOff).toContain('- [SANITY]:');
        });
    });

    describe('7. Renderer Script Card Metadata & Portrait', () => {
        it('renders icon, label, and safe portraitUrl via registerScriptCardMetaResolver + renderMemoAsCards, rejecting javascript: URLs', () => {
            const memo = '[ARCANA]\nMana: 10/10\n[/ARCANA]';

            registerScriptCardMetaResolver((tag) => {
                if (tag === 'ARCANA') {
                    return {
                        icon: '🔮',
                        label: 'Arcana Meter',
                        portraitUrl: 'https://example.com/arcana.png',
                    };
                }
                return null;
            });

            const safeHtml = renderMemoAsCards(memo, null, {});
            expect(safeHtml).toContain('🔮 Arcana Meter');
            expect(safeHtml).toContain('rt-script-card-portrait');
            expect(safeHtml).toContain('src="https://example.com/arcana.png"');

            registerScriptCardMetaResolver((tag) => {
                if (tag === 'ARCANA') {
                    return {
                        icon: '🔮',
                        label: 'Arcana Meter',
                        portraitUrl: 'javascript:alert(1)',
                    };
                }
                return null;
            });

            const unsafeHtml = renderMemoAsCards(memo, null, {});
            expect(unsafeHtml).toContain('🔮 Arcana Meter');
            expect(unsafeHtml).not.toContain('rt-script-card-portrait');
            expect(unsafeHtml).not.toContain('javascript:');
        });

        it('wires registerScriptCardMetaResolver via initScriptHostAdapter for active script records', () => {
            const settings = getSettings();
            const chatId = 'render-chat';
            const baseCtx = SillyTavern.getContext();
            SillyTavern.getContext = () => ({
                ...baseCtx,
                chatId,
                getCurrentChatId: () => chatId,
            });

            const script = upsertScript(settings, {
                id: 'host_meta',
                name: 'Host Script Card',
                icon: '📜',
                trackerTag: 'HOSTCARD',
                scope: 'global',
                globalEnabled: true,
                code: 'function initState() { return {}; }',
            });
            setChatScriptRecord(settings, chatId, script.id, {
                state: { ready: true },
                portraitUrl: '/characters/hero.png',
            });

            initScriptHostAdapter();
            const html = renderMemoAsCards('[HOSTCARD]\nStatus: Active\n[/HOSTCARD]', null, {});
            expect(html).toContain('📜 Host Script Card');
            expect(html).toContain('rt-script-card-portrait');
            expect(html).toContain('src="/characters/hero.png"');
        });
    });

    describe('8. Settings & Runtime Structural Contracts', () => {
        it('registers the scripts tab in settings-overlay.js TAB_DEFS', () => {
            expect(settingsOverlaySource).toContain("id: 'scripts'");
            expect(settingsOverlaySource).toContain("label: 'Scripts'");
        });

        it('ships every required Game Scripts DOM id in settings.html', () => {
            for (const id of [
                'rpg_scripts_enabled',
                'rpg_scripts_new_btn',
                'rpg_scripts_wizard_btn',
                'rpg_scripts_import_btn',
                'rpg_scripts_import_file',
                'rpg_scripts_collision_banner',
                'rpg_scripts_list',
                'rpg_scripts_live_section',
                'rpg_scripts_pyodide_url',
                'rpg_scripts_pyodide_reset_btn',
                'rpg_scripts_pyodide_status',
            ]) {
                expect(settingsHtmlSource).toContain(`id="${id}"`);
            }
        });

        it('wires Game Scripts in index.js', () => {
            expect(indexSource).toContain('getClaimedScriptTagsForActiveChat');
            expect(indexSource).toContain('buildActiveScriptsSyspromptBlock');
            expect(indexSource).toContain('initScriptHostAdapter');
            expect(indexSource).toContain('installScriptsUi');
        });

        it('wires Game Scripts lifecycle hooks in narrative-hooks.js', () => {
            expect(narrativeHooksSource).toContain('handleHostScriptSwipeRollback');
            expect(narrativeHooksSource).toContain('runHostScriptsBeforeGenerate');
            expect(narrativeHooksSource).toContain('runHostScriptsAfterGenerate');
            expect(narrativeHooksSource).toContain('syncScriptToolRegistrations');
        });
    });
});

function cloneViaJson(value) {
    return JSON.parse(JSON.stringify(value));
}
