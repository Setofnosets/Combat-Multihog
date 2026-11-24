import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { testExtensionSettings } from './setup.js';

vi.mock('../portrait-storage.js', () => ({
    lookupCustomPortraitSrc: () => '',
}));

import {
    buildToolSchemaFromActions,
    parseScriptFromJson,
} from '../src/features/scripting/core/script-schema.js';
import {
    createTurnLedger,
    ensureScriptState,
    renderScriptMemo,
    runScriptToolAction,
    runScriptsBeforeGenerate,
} from '../src/features/scripting/core/script-engine.js';
import {
    isScriptEnabledForChat,
    upsertScript,
} from '../src/features/scripting/script-store.js';
import {
    applyScriptMemoPatches,
    initScriptHostAdapter,
} from '../src/features/scripting/script-host-adapter.js';
import { getSettings } from '../state-manager.js';
import { renderMemoAsCards } from '../renderer.js';

const FIXTURE_RAW = readFileSync(
    new URL('./fixtures/my-succubus-companion.script.json', import.meta.url),
    'utf8',
);

function loadFixtureScript() {
    const parsed = parseScriptFromJson(FIXTURE_RAW);
    expect(parsed.ok).toBe(true);
    return parsed.script;
}

describe('Succubus Companion reference fixture', () => {
    beforeEach(() => {
        for (const key of Object.keys(testExtensionSettings)) {
            delete testExtensionSettings[key];
        }
        localStorage.clear();
    });

    it('1. Import & Schema Validation: parses cleanly, builds tool schema, and binds case-insensitively', () => {
        const parsed = parseScriptFromJson(FIXTURE_RAW);
        expect(parsed.ok).toBe(true);
        expect(parsed.errors).toEqual([]);
        expect(parsed.warnings).toEqual([]);

        const script = parsed.script;
        expect(script.id).toBe('succubus_companion');
        expect(script.trackerTag).toBe('SUCCUBUS_COMPANION');
        expect(script.commandPrefix).toBe('!succubus');

        const schema = buildToolSchemaFromActions(script);
        expect(schema).not.toBeNull();
        expect(schema.name).toBe('Script_SuccubusCompanion');
        expect(schema.parameters.required).toEqual(['action']);
        expect(schema.parameters.properties.action.enum).toEqual(
            expect.arrayContaining([
                'contact',
                'feed',
                'train',
                'comfort',
                'set_name',
                'set_rule',
                'protection',
                'evolve',
                'pass_day',
                'status',
            ]),
        );
        expect(schema.parameters.properties.action.enum).toHaveLength(10);

        const settings = getSettings();
        upsertScript(settings, script);

        expect(isScriptEnabledForChat(settings, script, 'chat-1', 'My Succubus Companion')).toEqual({
            enabled: true,
            reason: 'character',
        });
        expect(isScriptEnabledForChat(settings, script, 'chat-1', '  my succubus companion  ')).toEqual({
            enabled: true,
            reason: 'character',
        });
        expect(isScriptEnabledForChat(settings, script, 'chat-1', 'Other Character')).toEqual({
            enabled: false,
            reason: 'character',
        });
    });

    it('2. Command-Driven Flow (onBeforeGenerate): name, set-rule, contact, and protection ward', async () => {
        const script = loadFixtureScript();

        // !succubus name: Mira
        const step1 = await runScriptsBeforeGenerate(
            [script],
            {},
            { userMessage: '!succubus name: Mira' },
        );
        expect(step1.errors).toEqual([]);
        let state = step1.updatedStates[script.id];
        expect(state.name).toBe('Mira');
        expect(step1.memoPatches.SUCCUBUS_COMPANION).toBeDefined();
        expect(step1.memoPatches.SUCCUBUS_COMPANION).toContain('Identity: Mira');

        // Also verify host memo patching places [SUCCUBUS_COMPANION] block into settings.currentMemo
        const settings = getSettings();
        applyScriptMemoPatches(settings, step1.memoPatches);
        expect(settings.currentMemo).toContain('[SUCCUBUS_COMPANION]');
        expect(settings.currentMemo).toContain('Identity: Mira');
        expect(settings.currentMemo).toContain('[/SUCCUBUS_COMPANION]');

        // !succubus set-rule: No feeding without permission.
        const disciplineBeforeRule = state.discipline;
        const step2 = await runScriptsBeforeGenerate(
            [script],
            { [script.id]: state },
            { userMessage: '!succubus set-rule: No feeding without permission.' },
        );
        expect(step2.errors).toEqual([]);
        state = step2.updatedStates[script.id];
        expect(state.rules).toContain('No feeding without permission.');
        expect(state.discipline).toBeGreaterThan(disciplineBeforeRule);

        // !succubus contact: kiss (unprotected)
        const vitBeforeKiss = state.succubusVitality;
        const step3 = await runScriptsBeforeGenerate(
            [script],
            { [script.id]: state },
            { userMessage: '!succubus contact: kiss' },
        );
        expect(step3.errors).toEqual([]);
        state = step3.updatedStates[script.id];
        const unprotectedDrain = state.lastDrain;
        expect(unprotectedDrain).toBe(3);
        expect(state.userVitality).toBe(97);
        expect(state.succubusVitality).toBeGreaterThan(vitBeforeKiss);
        expect(state.sustenanceNeed).toBe(100 - state.succubusVitality);

        // !succubus protection: ward reduces subsequent kiss drain
        const step4 = await runScriptsBeforeGenerate(
            [script],
            { [script.id]: state },
            { userMessage: '!succubus protection: ward' },
        );
        expect(step4.errors).toEqual([]);
        state = step4.updatedStates[script.id];
        expect(state.protection).toBe('ward');

        const step5 = await runScriptsBeforeGenerate(
            [script],
            { [script.id]: state },
            { userMessage: '!succubus contact: kiss' },
        );
        expect(step5.errors).toEqual([]);
        state = step5.updatedStates[script.id];
        expect(state.lastDrain).toBeLessThan(unprotectedDrain);
        expect(state.userVitality).toBe(97 - state.lastDrain);
    });

    it('3. Natural-RP Mid-Turn Tool Call Flow: zero lag stage advance and one-shot portrait appendMarkdown', async () => {
        const script = loadFixtureScript();
        const initRes = await ensureScriptState(script, null, {});
        expect(initRes.ok).toBe(true);
        let state = initRes.state;
        expect(state.succubusVitality).toBe(50);
        expect(state.stage).toBe('Awakened');

        const feedRes = await runScriptToolAction(
            script,
            state,
            'feed',
            { source: 'vitality', intensity: 5 },
            {},
            createTurnLedger(),
        );
        expect(feedRes.ok).toBe(true);
        expect(feedRes.deduped).toBe(false);
        state = feedRes.state;

        expect(state.succubusVitality).toBe(100);
        expect(state.stage).toBe('Imprinted');
        expect(state.route).not.toBe('Undefined');
        expect(feedRes.toolResult.stageChanged).toBe(true);
        expect(feedRes.toolResult.stage).toBe('Imprinted');
        expect(feedRes.hasPortraitUrl).toBe(true);
        expect(feedRes.portraitUrl).toMatch(/^https:\/\/ella\.janitorai\.com\/media-approved\//);
        expect(feedRes.appendMarkdown).toBe(`![](${feedRes.portraitUrl})`);

        // Non-evolving action on the next turn must NOT re-emit appendMarkdown
        const nextTurnRes = await runScriptToolAction(
            script,
            state,
            'comfort',
            { intensity: 3 },
            {},
            createTurnLedger(),
        );
        expect(nextTurnRes.ok).toBe(true);
        expect(nextTurnRes.state.stage).toBe('Imprinted');
        expect(nextTurnRes.toolResult.stageChanged).toBe(false);
        expect(nextTurnRes.appendMarkdown).toBe('');
    });

    it('4. Monotone Progression & Route Lock: locks Perfect Housewife at Defined, resists predation at Ascendant, and resets cleanly', async () => {
        const script = loadFixtureScript();
        const initRes = await ensureScriptState(script, null, {});
        let state = initRes.state;

        // Feed to reach Imprinted (succubusVitality === 100)
        const feedRes = await runScriptToolAction(
            script,
            state,
            'feed',
            { source: 'vitality', intensity: 5 },
            {},
            createTurnLedger(),
        );
        state = feedRes.state;
        expect(state.stage).toBe('Imprinted');

        // Train domesticity + discipline to reach Shaped -> Defined with Perfect Housewife
        for (let i = 0; i < 4; i += 1) {
            const trainDom = await runScriptToolAction(
                script,
                state,
                'train',
                { stat: 'domesticity', intensity: 8 },
                {},
                createTurnLedger(),
            );
            state = trainDom.state;
        }
        expect(state.stage).toBe('Shaped');
        expect(state.route).toBe('Perfect Housewife');
        expect(state.routeLocked).toBe(false);

        // One more moderate domesticity session reaches Defined (80 >= 75, < 100) and locks the route
        const trainDefined = await runScriptToolAction(
            script,
            state,
            'train',
            { stat: 'domesticity', intensity: 3 },
            {},
            createTurnLedger(),
        );
        state = trainDefined.state;
        expect(state.stage).toBe('Defined');
        expect(state.route).toBe('Perfect Housewife');
        expect(state.routeLocked).toBe(true);

        // Heavy predation training reaches Ascendant while preserving locked route and never regressing stage
        for (let i = 0; i < 6; i += 1) {
            const trainPred = await runScriptToolAction(
                script,
                state,
                'train',
                { stat: 'predation', intensity: 10 },
                {},
                createTurnLedger(),
            );
            state = trainPred.state;
            expect(['Defined', 'Ascendant']).toContain(state.stage);
            expect(state.route).toBe('Perfect Housewife');
            expect(state.routeLocked).toBe(true);
        }
        expect(state.stage).toBe('Ascendant');
        expect(state.route).toBe('Perfect Housewife');
        expect(state.routeLocked).toBe(true);

        // !succubus reset restores Awakened / Undefined / Unknown
        const resetRes = await runScriptsBeforeGenerate(
            [script],
            { [script.id]: state },
            { userMessage: '!succubus reset' },
        );
        expect(resetRes.errors).toEqual([]);
        const resetState = resetRes.updatedStates[script.id];
        expect(resetState.stage).toBe('Awakened');
        expect(resetState.route).toBe('Undefined');
        expect(resetState.routeLocked).toBe(false);
        expect(resetState.name).toBe('Unknown');
    });

    it('5. Neglect / Starved Horror Branch: 3 days triggers Shaped + Starved Horror, 7 days triggers Defined + locked Starved Horror', async () => {
        const script = loadFixtureScript();
        const initRes = await ensureScriptState(script, null, {});
        let state = initRes.state;

        for (let i = 0; i < 3; i += 1) {
            const res = await runScriptsBeforeGenerate(
                [script],
                { [script.id]: state },
                { userMessage: '!succubus pass-day' },
            );
            expect(res.errors).toEqual([]);
            state = res.updatedStates[script.id];
        }
        expect(state.neglectDays).toBe(3);
        expect(state.stage).toBe('Shaped');
        expect(state.route).toBe('Starved Horror');
        expect(state.routeLocked).toBe(false);

        for (let i = 0; i < 4; i += 1) {
            const res = await runScriptsBeforeGenerate(
                [script],
                { [script.id]: state },
                { userMessage: '!succubus pass-day' },
            );
            expect(res.errors).toEqual([]);
            state = res.updatedStates[script.id];
        }
        expect(state.neglectDays).toBe(7);
        expect(state.stage).toBe('Defined');
        expect(state.route).toBe('Starved Horror');
        expect(state.routeLocked).toBe(true);
    });

    it('6. Time Decay: deltaMinutes = 45 decays succubusVitality and raises sustenanceNeed deterministically', async () => {
        const script = loadFixtureScript();
        const initRes = await ensureScriptState(script, null, {});
        const initial = initRes.state;

        const res = await runScriptsBeforeGenerate(
            [script],
            { [script.id]: initial },
            {
                userMessage: 'We sit quietly by the hearth for a while.',
                time: { deltaMinutes: 45, dayChanged: false },
            },
        );
        expect(res.errors).toEqual([]);
        const updated = res.updatedStates[script.id];

        // floor(45 / 15) = 3 vitality decay
        expect(updated.succubusVitality).toBe(initial.succubusVitality - 3);
        expect(updated.sustenanceNeed).toBe(initial.sustenanceNeed + 3);
        expect(updated.sustenanceNeed).toBe(100 - updated.succubusVitality);
    });

    it('7. Dual-Adjudication Double-Fire Prevention: pre-turn !succubus contact: kiss blocks duplicate mid-turn tool call', async () => {
        const script = loadFixtureScript();
        const ledger = createTurnLedger();

        const preRes = await runScriptsBeforeGenerate(
            [script],
            {},
            { userMessage: '!succubus contact: kiss' },
            ledger,
        );
        expect(preRes.errors).toEqual([]);
        const stateAfterPre = preRes.updatedStates[script.id];
        expect(stateAfterPre.userVitality).toBe(97);
        expect(stateAfterPre.lastDrain).toBe(3);

        const dupToolRes = await runScriptToolAction(
            script,
            stateAfterPre,
            'contact',
            { type: 'kiss' },
            {},
            ledger,
        );
        expect(dupToolRes.ok).toBe(true);
        expect(dupToolRes.deduped).toBe(true);
        expect(dupToolRes.reason).toBe('already_handled_pre_turn');
        expect(dupToolRes.state.userVitality).toBe(97);
        expect(dupToolRes.state.succubusVitality).toBe(stateAfterPre.succubusVitality);
    });

    it('8. HUD Rendering: renderMemo emits ((BAR)) and ((PILLS)) and renders cleanly via renderMemoAsCards', async () => {
        const script = loadFixtureScript();
        const settings = getSettings();
        upsertScript(settings, script);

        // Set up SillyTavern context with matching character so script card meta resolver recognizes the tag
        const prevGetContext = globalThis.SillyTavern.getContext;
        globalThis.SillyTavern.getContext = () => ({
            extensionSettings: testExtensionSettings,
            chatId: 'vitest-chat',
            name2: 'My Succubus Companion',
            saveSettingsDebounced: () => {},
        });

        try {
            initScriptHostAdapter();

            const initRes = await ensureScriptState(script, null, {});
            const memoRes = await renderScriptMemo(script, initRes.state, {});
            expect(memoRes.ok).toBe(true);
            expect(memoRes.memoBlock).toContain('((BAR');
            expect(memoRes.memoBlock).toContain('((PILLS))');

            applyScriptMemoPatches(settings, { [script.trackerTag]: memoRes.memoBlock });
            const html = renderMemoAsCards(settings.currentMemo, null, {});
            expect(typeof html).toBe('string');
            expect(html).toContain('data-tag="SUCCUBUS_COMPANION"');
            expect(html).toContain('My Succubus Companion');
            expect(html).toContain('rt-hp-bar-wrap');
            expect(html).toContain('rt-unit-pill');
        } finally {
            globalThis.SillyTavern.getContext = prevGetContext;
        }
    });
});
