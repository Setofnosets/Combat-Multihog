import { describe, expect, it, vi } from 'vitest';

import {
    extractCharacterCardSummary,
    buildScriptWizardSystemPrompt,
    buildScriptWizardDraftUserPrompt,
    buildScriptWizardIterateUserPrompt,
    parseScriptWizardResponse,
} from '../src/features/scripting/script-wizard-prompts.js';

import {
    getScriptWizardConnectionSettings,
    draftScriptWithAi,
    iterateScriptWithAi,
} from '../src/features/scripting/script-wizard.js';

function makeValidJsScriptPayload(overrides = {}) {
    return {
        schemaVersion: 1,
        id: 'ember_watch',
        name: 'Ember Watch',
        icon: '🔥',
        description: 'Tracks campfire warmth and watch turns.',
        lang: 'js',
        scope: 'chat',
        boundCharacters: [],
        globalEnabled: false,
        trackerTag: 'EMBER_WATCH',
        commandPrefix: '!ember',
        stripCommandFromPrompt: true,
        toolEnabled: true,
        toolName: 'Script_EmberWatch',
        toolDescription: 'Update campfire warmth and stoke embers.',
        toolActions: [
            {
                name: 'stoke',
                description: 'Stoke the campfire to raise warmth.',
                params: [
                    { name: 'amount', type: 'number', required: true, description: 'Warmth gained' },
                ],
            },
        ],
        gmPrompt: '<ember_watch>Keep [EMBER_WATCH] authoritative for {{user}} and {{char}}.</ember_watch>',
        code: [
            'function initState() { return { warmth: 50, turns: 0 }; }',
            'function onBeforeGenerate(state, ctx) {',
            '  const next = { ...state, turns: state.turns + 1 };',
            '  if (ctx && ctx.command && ctx.command.subcommand === "stoke") {',
            '    next.warmth = Math.min(100, next.warmth + 15);',
            '  }',
            '  return { state: next };',
            '}',
            'function onToolCall(state, call) {',
            '  const delta = Number(call && call.args && call.args.amount) || 10;',
            '  const next = { ...state, warmth: Math.min(100, state.warmth + delta) };',
            '  return { state: next, toolResult: { warmth: next.warmth } };',
            '}',
            'function renderMemo(state) {',
            '  return "Warmth ((BAR)) " + state.warmth + "/100\\nTurns: " + state.turns;',
            '}',
        ].join('\n'),
        ...overrides,
    };
}

function makeValidPythonScriptPayload(overrides = {}) {
    return {
        schemaVersion: 1,
        id: 'ember_watch_py',
        name: 'Ember Watch Python',
        icon: '🐍',
        description: 'Tracks campfire warmth using Python.',
        lang: 'python',
        scope: 'chat',
        boundCharacters: [],
        globalEnabled: false,
        trackerTag: 'EMBER_WATCH',
        commandPrefix: '!ember',
        stripCommandFromPrompt: true,
        toolEnabled: true,
        toolName: 'Script_EmberWatchPython',
        toolDescription: 'Update campfire warmth in Python.',
        toolActions: [
            {
                name: 'stoke',
                description: 'Stoke the fire.',
                params: [
                    { name: 'amount', type: 'number', required: true, description: 'Warmth added' },
                ],
            },
        ],
        gmPrompt: '<ember_watch>Respect [EMBER_WATCH] for {{user}} and {{char}}.</ember_watch>',
        code: [
            'import math',
            '',
            'def init_state(ctx=None):',
            '    return {"warmth": 60, "turns": 0}',
            '',
            'def on_before_generate(state, ctx):',
            '    next_state = dict(state or {})',
            '    next_state["turns"] = int(next_state.get("turns", 0)) + 1',
            '    cmd = (ctx or {}).get("command") or {}',
            '    if cmd.get("subcommand") == "stoke":',
            '        next_state["warmth"] = min(100, int(next_state.get("warmth", 0)) + 15)',
            '    return {"state": next_state}',
            '',
            'def on_tool_call(state, call, ctx):',
            '    next_state = dict(state or {})',
            '    args = (call or {}).get("args") or {}',
            '    delta = int(math.floor(float(args.get("amount", 10))))',
            '    next_state["warmth"] = min(100, int(next_state.get("warmth", 0)) + delta)',
            '    return {"state": next_state, "tool_result": {"warmth": next_state["warmth"]}}',
            '',
            'def render_memo(state, ctx=None):',
            '    s = state or {}',
            '    return f"Warmth ((BAR)) {s.get(\'warmth\', 0)}/100\\nTurns: {s.get(\'turns\', 0)}"',
        ].join('\n'),
        ...overrides,
    };
}

describe('extractCharacterCardSummary', () => {
    it('reads V1 top-level fields cleanly', () => {
        const v1Card = {
            name: '  Seraphina  ',
            scenario: 'An ancient library at midnight.',
            description: 'Keeper of forbidden arcane ledgers.',
            personality: 'Stoic, observant, dry wit.',
            first_mes: '"Mind the candles, traveler."',
            mes_example: '<START>\n{{user}}: What is this place?\n{{char}}: Quiet.',
            creator_notes: 'Tracks sanity and candle wax.',
        };

        const summary = extractCharacterCardSummary(v1Card);
        expect(summary.name).toBe('Seraphina');
        expect(summary.truncated).toBe(false);
        expect(summary.text).toContain('### Name\nSeraphina');
        expect(summary.text).toContain('### Scenario\nAn ancient library at midnight.');
        expect(summary.text).toContain('### Description\nKeeper of forbidden arcane ledgers.');
        expect(summary.text).toContain('### Personality\nStoic, observant, dry wit.');
        expect(summary.text).toContain('### First Message\n"Mind the candles, traveler."');
        expect(summary.text).toContain('### Example Dialogs\n<START>');
        expect(summary.text).toContain('### Creator Notes\nTracks sanity and candle wax.');
    });

    it('reads V2 nested data.* fields cleanly', () => {
        const v2Card = {
            spec: 'chara_card_v2',
            data: {
                name: 'Kaelen',
                scenario: 'A siege on Ironwatch Bastion.',
                description: 'Quartermaster counting every arrow.',
                personality: 'Pragmatic and blunt.',
                first_mes: 'Report your supplies.',
                mes_example: '{{user}}: Ten bolts left.\n{{char}}: Make them count.',
                creator_notes: 'Uses ammo & morale trackers.',
            },
        };

        const summary = extractCharacterCardSummary(v2Card);
        expect(summary.name).toBe('Kaelen');
        expect(summary.truncated).toBe(false);
        expect(summary.text).toContain('### Name\nKaelen');
        expect(summary.text).toContain('### Scenario\nA siege on Ironwatch Bastion.');
        expect(summary.text).toContain('### Description\nQuartermaster counting every arrow.');
        expect(summary.text).toContain('### Personality\nPragmatic and blunt.');
        expect(summary.text).toContain('### First Message\nReport your supplies.');
        expect(summary.text).toContain('### Example Dialogs');
        expect(summary.text).toContain('### Creator Notes\nUses ammo & morale trackers.');
    });

    it('prioritizes Scenario & Description and truncates oversized mes_example and creator_notes within maxChars', () => {
        const card = {
            name: 'Vesper',
            scenario: 'CRITICAL_SCENARIO_ANCHOR: Neon rain over Sector 9.',
            description: 'CRITICAL_DESCRIPTION_ANCHOR: Bounty hunter with heat gauge.',
            personality: 'Calculating.',
            first_mes: 'Target locked.',
            mes_example: Array.from({ length: 60 }, (_, i) => `Line ${i}: example dialogue banter.`).join('\n'),
            creator_notes: Array.from({ length: 40 }, (_, i) => `Note ${i}: extended mechanical notes.`).join('\n'),
        };

        const maxChars = 650;
        const summary = extractCharacterCardSummary(card, { maxChars });

        expect(summary.truncated).toBe(true);
        expect(summary.text.length).toBeLessThanOrEqual(maxChars);
        expect(summary.text).toContain('CRITICAL_SCENARIO_ANCHOR');
        expect(summary.text).toContain('CRITICAL_DESCRIPTION_ANCHOR');

        const scenarioIdx = summary.text.indexOf('### Scenario');
        const descIdx = summary.text.indexOf('### Description');
        const personalityIdx = summary.text.indexOf('### Personality');
        expect(scenarioIdx).toBeGreaterThan(-1);
        expect(descIdx).toBeGreaterThan(scenarioIdx);
        expect(personalityIdx).toBeGreaterThan(descIdx);
    });

    it('returns an empty summary safely for nullish or invalid card payloads', () => {
        expect(extractCharacterCardSummary(null)).toEqual({ name: '', text: '', truncated: false });
        expect(extractCharacterCardSummary(undefined)).toEqual({ name: '', text: '', truncated: false });
        expect(extractCharacterCardSummary([])).toEqual({ name: '', text: '', truncated: false });
    });
});

describe('Script Wizard prompt builders', () => {
    it('builds JS vs Python system prompts with language-specific hooks and sandbox rules', () => {
        const jsPrompt = buildScriptWizardSystemPrompt({ lang: 'js', interactionMode: 'both' });
        expect(jsPrompt).toContain('"lang": "js"');
        expect(jsPrompt).toContain('function initState()');
        expect(jsPrompt).toContain('function onBeforeGenerate(state, ctx)');
        expect(jsPrompt).toContain('function onToolCall(state, call, ctx)');
        expect(jsPrompt).toContain('function onAfterGenerate(state, ctx)');
        expect(jsPrompt).toContain('function renderMemo(state)');
        expect(jsPrompt).toContain('NO `fetch`');
        expect(jsPrompt).not.toContain('def init_state');

        const pyPrompt = buildScriptWizardSystemPrompt({ lang: 'python', interactionMode: 'both' });
        expect(pyPrompt).toContain('"lang": "python"');
        expect(pyPrompt).toContain('def init_state(ctx=None):');
        expect(pyPrompt).toContain('def on_before_generate(state, ctx):');
        expect(pyPrompt).toContain('def on_tool_call(state, call, ctx):');
        expect(pyPrompt).toContain('def on_after_generate(state, ctx):');
        expect(pyPrompt).toContain('def render_memo(state, ctx=None):');
        expect(pyPrompt).toContain('Allowed Python stdlib modules ONLY');
        for (const mod of ['math', 're', 'json', 'random', 'datetime', 'collections', 'copy']) {
            expect(pyPrompt).toContain(`\`${mod}\``);
        }
        expect(pyPrompt).toContain('Strictly forbidden');
        expect(pyPrompt).not.toContain('function initState');
    });

    it('builds draft prompt with character auto-binding and embedded context blocks', () => {
        const promptWithChar = buildScriptWizardDraftUserPrompt({
            description: 'Track corruption and willpower.',
            characterName: 'Lilith',
            characterCardSummary: '### Scenario\nAbyssal pact.',
            storyContext: 'User entered the cathedral.',
            loreContext: 'Pacts drain willpower nightly.',
            currentMemo: '[TIME]\nDay 2, Dusk\n[/TIME]',
            lang: 'python',
            interactionMode: 'tools',
        });

        expect(promptWithChar).toContain('Language: `python`');
        expect(promptWithChar).toContain('Interaction Mode: `tools`');
        expect(promptWithChar).toContain('Target character is **Lilith**');
        expect(promptWithChar).toContain('"scope": "character"');
        expect(promptWithChar).toContain('"boundCharacters": ["Lilith"]');
        expect(promptWithChar).toContain('### User Design Brief\nTrack corruption and willpower.');
        expect(promptWithChar).toContain('### Character Card Reference\n### Scenario\nAbyssal pact.');
        expect(promptWithChar).toContain('### Recent Story Context\nUser entered the cathedral.');
        expect(promptWithChar).toContain('### Active Lorebook / World Context\nPacts drain willpower nightly.');
        expect(promptWithChar).toContain('[TIME]\nDay 2, Dusk\n[/TIME]');

        const promptWithoutChar = buildScriptWizardDraftUserPrompt({
            description: 'Generic hunger meter.',
            lang: 'js',
        });
        expect(promptWithoutChar).toContain('default to `"scope": "chat"`, `"boundCharacters": []`');
    });

    it('builds iterate prompt with validationErrors, sandboxErrors, and bidirectional JS <-> Python conversion guidance', () => {
        const jsToPyPrompt = buildScriptWizardIterateUserPrompt({
            currentScript: makeValidJsScriptPayload(),
            instruction: 'Add daily decay.',
            validationErrors: ['Tool action name is invalid.'],
            sandboxErrors: ['ReferenceError: foo is not defined'],
            targetLang: 'python',
        });

        expect(jsToPyPrompt).toContain('Language Conversion Directive (`js` -> `python`)');
        expect(jsToPyPrompt).toContain('init_state(ctx=None)');
        expect(jsToPyPrompt).toContain('### Refinement Instruction\nAdd daily decay.');
        expect(jsToPyPrompt).toContain('### Schema / Validation Errors to Fix\n- Tool action name is invalid.');
        expect(jsToPyPrompt).toContain('### Sandbox Execution Errors to Fix\n- ReferenceError: foo is not defined');

        const pyToJsPrompt = buildScriptWizardIterateUserPrompt({
            currentScript: makeValidPythonScriptPayload(),
            targetLang: 'js',
        });

        expect(pyToJsPrompt).toContain('Language Conversion Directive (`python` -> `js`)');
        expect(pyToJsPrompt).toContain('initState');
        expect(pyToJsPrompt).toContain('onBeforeGenerate(state, ctx)');
    });
});

describe('parseScriptWizardResponse', () => {
    it('extracts valid JSON from <script_json>...</script_json> tags', () => {
        const payload = makeValidJsScriptPayload();
        const raw = `Here is your script:\n<script_json>\n${JSON.stringify(payload, null, 2)}\n</script_json>\nEnjoy!`;

        const res = parseScriptWizardResponse(raw);
        expect(res.ok).toBe(true);
        expect(res.errors).toEqual([]);
        expect(res.script).not.toBeNull();
        expect(res.script.id).toBe('ember_watch');
        expect(res.script.lang).toBe('js');
    });

    it('extracts valid JSON from fenced ```json ... ``` blocks', () => {
        const payload = makeValidPythonScriptPayload();
        const raw = `Drafted script below:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;

        const res = parseScriptWizardResponse(raw);
        expect(res.ok).toBe(true);
        expect(res.errors).toEqual([]);
        expect(res.script?.id).toBe('ember_watch_py');
        expect(res.script?.lang).toBe('python');
    });

    it('extracts outermost balanced { ... } when surrounded by prose', () => {
        const payload = makeValidJsScriptPayload({
            code: 'function initState() { return { ok: true }; }',
        });
        const raw = [
            'Sure! Note that {braces in prose} should be ignored if invalid JSON.',
            JSON.stringify(payload),
            'Let me know if you want changes.',
        ].join('\n\n');

        const res = parseScriptWizardResponse(raw);
        expect(res.ok).toBe(true);
        expect(res.script?.id).toBe('ember_watch');
        expect(res.script?.code).toBe('function initState() { return { ok: true }; }');
    });

    it('applies fallbackLang, fallbackScope, and fallbackBoundCharacters when omitted', () => {
        const minimal = {
            id: 'pact_tracker',
            name: 'Pact Tracker',
            code: 'def init_state(ctx=None):\n    return {"charges": 3}',
        };
        const raw = `<script_json>${JSON.stringify(minimal)}</script_json>`;

        const res = parseScriptWizardResponse(raw, {
            fallbackLang: 'python',
            fallbackScope: 'character',
            fallbackBoundCharacters: ['Lilith'],
        });

        expect(res.ok).toBe(true);
        expect(res.script?.lang).toBe('python');
        expect(res.script?.scope).toBe('character');
        expect(res.script?.boundCharacters).toEqual(['Lilith']);
    });

    it('returns { ok: false, errors: [...] } cleanly on malformed JSON, empty input, or missing required fields', () => {
        const emptyRes = parseScriptWizardResponse('   ');
        expect(emptyRes.ok).toBe(false);
        expect(emptyRes.script).toBeNull();
        expect(emptyRes.errors.length).toBeGreaterThan(0);

        const malformedRes = parseScriptWizardResponse('<script_json>{ "name": "Broken", </script_json>');
        expect(malformedRes.ok).toBe(false);
        expect(malformedRes.script).toBeNull();
        expect(malformedRes.errors[0]).toMatch(/Invalid JSON/i);

        const missingFieldsRes = parseScriptWizardResponse('<script_json>{"id":"only_id"}</script_json>');
        expect(missingFieldsRes.ok).toBe(false);
        expect(missingFieldsRes.script).toBeNull();
        expect(missingFieldsRes.errors).toEqual(
            expect.arrayContaining([
                'Script name is required.',
                'Script code must not be empty.',
            ]),
        );
    });
});

describe('draftScriptWithAi', () => {
    it('succeeds in a single pass for a valid JS draft and passes real sandbox verification', async () => {
        const jsPayload = makeValidJsScriptPayload();
        const sendRequest = vi.fn(async () => `<script_json>${JSON.stringify(jsPayload)}</script_json>`);

        const res = await draftScriptWithAi({
            description: 'Track campfire warmth.',
            lang: 'js',
            interactionMode: 'both',
            sendRequest,
        });

        expect(sendRequest).toHaveBeenCalledTimes(1);
        expect(res.ok).toBe(true);
        expect(res.repaired).toBe(false);
        expect(res.attempts).toBe(1);
        expect(res.errors).toEqual([]);
        expect(res.script?.lang).toBe('js');
        expect(res.sandboxCheck.ok).toBe(true);
        expect(res.sandboxCheck.statePreview).toEqual({ warmth: 50, turns: 1 });
        expect(res.sandboxCheck.memoPreview).toBe('Warmth ((BAR)) 50/100\nTurns: 1');
    });

    it('succeeds in a single pass for a valid Python draft and executes real Python in verifyScriptDraftInSandbox', async () => {
        const pyPayload = makeValidPythonScriptPayload();
        const sendRequest = vi.fn(async () => `<script_json>${JSON.stringify(pyPayload)}</script_json>`);

        const res = await draftScriptWithAi({
            description: 'Track campfire warmth in Python.',
            lang: 'python',
            interactionMode: 'both',
            sendRequest,
        });

        expect(sendRequest).toHaveBeenCalledTimes(1);
        expect(res.ok).toBe(true);
        expect(res.repaired).toBe(false);
        expect(res.attempts).toBe(1);
        expect(res.errors).toEqual([]);
        expect(res.script?.lang).toBe('python');
        expect(res.sandboxCheck.ok).toBe(true);
        expect(res.sandboxCheck.statePreview).toEqual({ warmth: 60, turns: 1 });
        expect(res.sandboxCheck.memoPreview).toBe('Warmth ((BAR)) 60/100\nTurns: 1');
    });

    it('performs automatic 1-retry self-repair when the first JS draft throws in initState', async () => {
        const brokenPayload = makeValidJsScriptPayload({
            code: [
                "function initState() { throw new Error('boom'); }",
                'function onBeforeGenerate(state) { return { state }; }',
                'function renderMemo() { return "broken"; }',
            ].join('\n'),
        });
        const fixedPayload = makeValidJsScriptPayload();

        const sendRequest = vi
            .fn()
            .mockResolvedValueOnce(`<script_json>${JSON.stringify(brokenPayload)}</script_json>`)
            .mockResolvedValueOnce(`<script_json>${JSON.stringify(fixedPayload)}</script_json>`);

        const res = await draftScriptWithAi({
            description: 'Track campfire warmth.',
            lang: 'js',
            sendRequest,
        });

        expect(sendRequest).toHaveBeenCalledTimes(2);
        const [, repairUserPrompt] = sendRequest.mock.calls[1];
        expect(repairUserPrompt).toContain('Sandbox Execution Errors to Fix');
        expect(repairUserPrompt).toContain('boom');

        expect(res.ok).toBe(true);
        expect(res.repaired).toBe(true);
        expect(res.attempts).toBe(2);
        expect(res.errors).toEqual([]);
        expect(res.sandboxCheck.ok).toBe(true);
        expect(res.sandboxCheck.statePreview).toEqual({ warmth: 50, turns: 1 });
    });

    it('respects autoRepair: false and stops after 1 attempt on sandbox error', async () => {
        const brokenPayload = makeValidJsScriptPayload({
            code: "function initState() { throw new Error('boom'); }",
        });
        const sendRequest = vi.fn(async () => `<script_json>${JSON.stringify(brokenPayload)}</script_json>`);

        const res = await draftScriptWithAi({
            description: 'Track campfire warmth.',
            lang: 'js',
            autoRepair: false,
            sendRequest,
        });

        expect(sendRequest).toHaveBeenCalledTimes(1);
        expect(res.ok).toBe(false);
        expect(res.repaired).toBe(false);
        expect(res.attempts).toBe(1);
        expect(res.sandboxCheck.ok).toBe(false);
        expect(res.errors.join('\n')).toContain('boom');
    });

    it('handles an aborted AbortSignal cleanly without running a repair pass', async () => {
        const preAborted = new AbortController();
        preAborted.abort();
        const preAbortSend = vi.fn(async () => '<script_json>{}</script_json>');

        await expect(
            draftScriptWithAi({
                description: 'Aborted before start.',
                signal: preAborted.signal,
                sendRequest: preAbortSend,
            }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(preAbortSend).not.toHaveBeenCalled();

        const midFlight = new AbortController();
        const midFlightSend = vi.fn(async () => {
            midFlight.abort();
            return '<script_json>{ invalid json }</script_json>';
        });

        await expect(
            draftScriptWithAi({
                description: 'Aborted during first request.',
                signal: midFlight.signal,
                autoRepair: true,
                sendRequest: midFlightSend,
            }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(midFlightSend).toHaveBeenCalledTimes(1);
    });
});

describe('iterateScriptWithAi', () => {
    it('refines an existing JS script and converts it to a sandbox-verified Python script', async () => {
        const currentJs = makeValidJsScriptPayload();
        const convertedPy = makeValidPythonScriptPayload({
            id: currentJs.id,
            name: currentJs.name,
            code: [
                'def init_state(ctx=None):',
                '    return {"warmth": 75, "turns": 0}',
                '',
                'def on_before_generate(state, ctx):',
                '    next_state = dict(state or {})',
                '    next_state["turns"] = int(next_state.get("turns", 0)) + 1',
                '    return {"state": next_state}',
                '',
                'def on_tool_call(state, call, ctx):',
                '    next_state = dict(state or {})',
                '    args = (call or {}).get("args") or {}',
                '    delta = int(args.get("amount", 10))',
                '    next_state["warmth"] = min(100, int(next_state.get("warmth", 0)) + delta)',
                '    return {"state": next_state, "tool_result": {"warmth": next_state["warmth"]}}',
                '',
                'def render_memo(state, ctx=None):',
                '    s = state or {}',
                '    return f"Warmth ((BAR)) {s.get(\'warmth\', 0)}/100\\nTurns: {s.get(\'turns\', 0)}"',
            ].join('\n'),
        });

        const sendRequest = vi.fn(async () => `<script_json>${JSON.stringify(convertedPy)}</script_json>`);

        const res = await iterateScriptWithAi({
            currentScript: currentJs,
            instruction: 'Convert to Python and start warmth at 75.',
            targetLang: 'python',
            sendRequest,
        });

        expect(sendRequest).toHaveBeenCalledTimes(1);
        const [sysPrompt, usrPrompt] = sendRequest.mock.calls[0];
        expect(sysPrompt).toContain('def init_state(ctx=None):');
        expect(usrPrompt).toContain('Language Conversion Directive (`js` -> `python`)');
        expect(usrPrompt).toContain('Convert to Python and start warmth at 75.');

        expect(res.ok).toBe(true);
        expect(res.repaired).toBe(false);
        expect(res.attempts).toBe(1);
        expect(res.script?.lang).toBe('python');
        expect(res.sandboxCheck.ok).toBe(true);
        expect(res.sandboxCheck.statePreview).toEqual({ warmth: 75, turns: 1 });
        expect(res.sandboxCheck.memoPreview).toBe('Warmth ((BAR)) 75/100\nTurns: 1');
    });
});

describe('getScriptWizardConnectionSettings', () => {
    it('maps gameSystemWizard* settings cleanly with expected defaults', () => {
        expect(getScriptWizardConnectionSettings({})).toEqual({
            connectionSource: 'default',
            connectionProfileId: '',
            completionPresetId: '',
            ollamaUrl: 'http://localhost:11434',
            ollamaModel: '',
            openaiUrl: '',
            openaiKey: '',
            openaiModel: '',
            maxTokens: undefined,
            debugMode: undefined,
        });

        expect(
            getScriptWizardConnectionSettings({
                gameSystemWizardConnectionSource: 'openai',
                gameSystemWizardConnectionProfileId: 'prof_123',
                gameSystemWizardCompletionPresetId: 'preset_abc',
                gameSystemWizardOllamaUrl: 'http://127.0.0.1:11434',
                gameSystemWizardOllamaModel: 'qwen2.5:14b',
                gameSystemWizardOpenaiUrl: 'https://api.example.com/v1',
                gameSystemWizardOpenaiKey: 'sk-test-123',
                gameSystemWizardOpenaiModel: 'gpt-4o-mini',
                maxTokens: 2048,
                debugMode: true,
            }),
        ).toEqual({
            connectionSource: 'openai',
            connectionProfileId: 'prof_123',
            completionPresetId: 'preset_abc',
            ollamaUrl: 'http://127.0.0.1:11434',
            ollamaModel: 'qwen2.5:14b',
            openaiUrl: 'https://api.example.com/v1',
            openaiKey: 'sk-test-123',
            openaiModel: 'gpt-4o-mini',
            maxTokens: 2048,
            debugMode: true,
        });
    });
});
