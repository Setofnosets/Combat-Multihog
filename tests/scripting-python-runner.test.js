import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { testExtensionSettings } from './setup.js';

vi.mock('../portrait-storage.js', () => ({
    lookupCustomPortraitSrc: () => '',
}));

import {
    normalizeScriptDefinition,
    normalizeScriptResult,
    parseScriptFromJson,
    validateScriptDefinition,
} from '../src/features/scripting/core/script-schema.js';
import {
    executeScriptHook,
    getRunner,
    listRunners,
} from '../src/features/scripting/core/runner-registry.js';
import {
    createTurnLedger,
    ensureScriptState,
    renderScriptMemo,
    runScriptToolAction,
    runScriptsAfterGenerate,
    runScriptsBeforeGenerate,
} from '../src/features/scripting/core/script-engine.js';
import {
    SCRIPT_PYTHON_STARTER_TEMPLATES,
    getStarterTemplateById,
    getStarterTemplatesForLang,
} from '../src/features/scripting/core/script-templates.js';
import { createPyodideRunner } from '../src/features/scripting/core/runner-python-pyodide.js';
import { upsertScript } from '../src/features/scripting/script-store.js';
import {
    applyScriptMemoPatches,
    initScriptHostAdapter,
} from '../src/features/scripting/script-host-adapter.js';
import { getSettings } from '../state-manager.js';
import { renderMemoAsCards } from '../renderer.js';

const HEARTH_FIXTURE_RAW = readFileSync(
    new URL('./fixtures/hearth-companion-py.script.json', import.meta.url),
    'utf8',
);

function makePyScript(code, overrides = {}) {
    return normalizeScriptDefinition({
        id: 'test_py_script',
        name: 'Test Python Script',
        lang: 'python',
        trackerTag: 'TEST_PY',
        code,
        ...overrides,
    });
}

describe('1. Real Python 3 execution via runner-registry.js (lang: "python")', () => {
    it('registers a ready python runner in runner-registry', () => {
        const pyRunner = getRunner('python');
        expect(pyRunner).not.toBeNull();
        expect(pyRunner.available).toBe(true);
        const listed = listRunners().find((r) => r.lang === 'python');
        expect(listed).toMatchObject({ lang: 'python', available: true });
    });

    it('supports snake_case hooks including 0-arg init_state() and 1-arg render_memo(state)', async () => {
        const script = makePyScript(`
def init_state():
    return {"hp": 42, "status": "Ready"}

def on_before_generate(state, ctx):
    next_state = dict(state)
    next_state["hp"] = state["hp"] + 3
    return {"state": next_state, "prompt_injection": "Before cue"}

def on_tool_call(state, call, ctx):
    action = call.get("action")
    delta = int((call.get("args") or {}).get("delta", 0))
    next_state = dict(state)
    next_state["hp"] = state["hp"] + delta
    return {"state": next_state, "tool_result": {"ok": True, "action": action, "hp": next_state["hp"]}}

def on_after_generate(state, ctx):
    next_state = dict(state)
    next_state["after"] = ctx.get("assistantMessage", "")
    return {"state": next_state, "portrait_url": "https://example.com/p.png", "append_markdown": "Done!"}

def render_memo(state):
    return f"HP: {state['hp']} | {state['status']}"
`);

        const initRes = await executeScriptHook(script, 'initState', { ctx: {} });
        expect(initRes.ok).toBe(true);
        expect(initRes.missingHook).toBe(false);
        expect(initRes.result).toEqual({ hp: 42, status: 'Ready' });

        const beforeRes = await executeScriptHook(script, 'onBeforeGenerate', {
            state: initRes.result,
            ctx: {},
        });
        expect(beforeRes.ok).toBe(true);
        expect(beforeRes.result.state).toEqual({ hp: 45, status: 'Ready' });
        expect(beforeRes.result.promptInjection).toBe('Before cue');

        const toolRes = await executeScriptHook(script, 'onToolCall', {
            state: beforeRes.result.state,
            call: { action: 'heal', args: { delta: 5 } },
            ctx: {},
        });
        expect(toolRes.ok).toBe(true);
        expect(toolRes.result.state).toEqual({ hp: 50, status: 'Ready' });
        expect(toolRes.result.toolResult).toEqual({ ok: true, action: 'heal', hp: 50 });

        const afterRes = await executeScriptHook(script, 'onAfterGenerate', {
            state: toolRes.result.state,
            ctx: { assistantMessage: 'Hello' },
        });
        expect(afterRes.ok).toBe(true);
        expect(afterRes.result.state).toEqual({ hp: 50, status: 'Ready', after: 'Hello' });
        expect(afterRes.result.portraitUrl).toBe('https://example.com/p.png');
        expect(afterRes.result.appendMarkdown).toBe('Done!');

        const memoRes = await executeScriptHook(script, 'renderMemo', {
            state: afterRes.result.state,
            ctx: {},
        });
        expect(memoRes.ok).toBe(true);
        expect(memoRes.result).toBe('HP: 50 | Ready');
    }, 15000);

    it('supports camelCase hook names (initState, onBeforeGenerate, onToolCall, onAfterGenerate, renderMemo)', async () => {
        const script = makePyScript(`
def initState(ctx):
    return {"step": 1}

def onBeforeGenerate(state, ctx):
    return {"state": {"step": state["step"] + 1}, "promptInjection": "camel-before"}

def onToolCall(state, call, ctx):
    return {"state": {"step": state["step"] + 10}, "toolResult": {"ok": True, "action": call.get("action")}}

def onAfterGenerate(state, ctx):
    return {"state": {"step": state["step"] + 100}}

def renderMemo(state, ctx):
    return f"Step: {state['step']}"
`);

        const r1 = await executeScriptHook(script, 'initState', { ctx: {} });
        expect(r1.ok).toBe(true);
        expect(r1.result).toEqual({ step: 1 });

        const r2 = await executeScriptHook(script, 'onBeforeGenerate', { state: r1.result, ctx: {} });
        expect(r2.ok).toBe(true);
        expect(r2.result.state).toEqual({ step: 2 });
        expect(r2.result.promptInjection).toBe('camel-before');

        const r3 = await executeScriptHook(script, 'onToolCall', {
            state: r2.result.state,
            call: { action: 'ping', args: {} },
            ctx: {},
        });
        expect(r3.ok).toBe(true);
        expect(r3.result.state).toEqual({ step: 12 });
        expect(r3.result.toolResult).toEqual({ ok: true, action: 'ping' });

        const r4 = await executeScriptHook(script, 'onAfterGenerate', { state: r3.result.state, ctx: {} });
        expect(r4.ok).toBe(true);
        expect(r4.result.state).toEqual({ step: 112 });

        const r5 = await executeScriptHook(script, 'renderMemo', { state: r4.result.state, ctx: {} });
        expect(r5.ok).toBe(true);
        expect(r5.result).toBe('Step: 112');
    }, 15000);

    it('normalizes snake_case return keys to camelCase via normalizeScriptResult', async () => {
        const script = makePyScript(`
def on_before_generate(state, ctx):
    return {
        "state": {"v": 9},
        "memo_block": "Val: 9",
        "prompt_injection": "Injected cue",
        "tool_result": {"ok": True, "source": "snake"},
        "strip_command": True,
        "portrait_url": "https://example.com/portrait.webp",
        "append_markdown": "> Banner",
    }
`);

        const hookRes = await executeScriptHook(script, 'onBeforeGenerate', { state: {}, ctx: {} });
        expect(hookRes.ok).toBe(true);

        const norm = normalizeScriptResult(hookRes.result);
        expect(norm.hasState).toBe(true);
        expect(norm.state).toEqual({ v: 9 });
        expect(norm.hasMemoBlock).toBe(true);
        expect(norm.memoBlock).toBe('Val: 9');
        expect(norm.promptInjection).toBe('Injected cue');
        expect(norm.hasToolResult).toBe(true);
        expect(norm.toolResult).toEqual({ ok: true, source: 'snake' });
        expect(norm.stripCommand).toBe(true);
        expect(norm.hasPortraitUrl).toBe(true);
        expect(norm.portraitUrl).toBe('https://example.com/portrait.webp');
        expect(norm.appendMarkdown).toBe('> Banner');
    });

    it('captures print() output into logs[] and caps at 100 entries', async () => {
        const script = makePyScript(`
def init_state(ctx):
    for i in range(130):
        print("log", i)
    return {"count": 130}
`);

        const res = await executeScriptHook(script, 'initState', { ctx: {} });
        expect(res.ok).toBe(true);
        expect(res.result).toEqual({ count: 130 });
        expect(Array.isArray(res.logs)).toBe(true);
        expect(res.logs).toHaveLength(100);
        expect(res.logs[0]).toBe('log 0');
        expect(res.logs[99]).toBe('log 99');
    });

    it('returns { ok: true, missingHook: true } when an optional hook is omitted', async () => {
        const script = makePyScript(`
def init_state(ctx):
    return {"ready": True}
`);

        const res = await executeScriptHook(script, 'onBeforeGenerate', { state: { ready: true }, ctx: {} });
        expect(res.ok).toBe(true);
        expect(res.missingHook).toBe(true);
        expect(res.result).toBeNull();
        expect(res.error).toBeNull();
    });

    it('isolates syntax errors and runtime exceptions cleanly', async () => {
        const syntaxScript = makePyScript(`
def init_state(ctx)
    return {}
`);
        const syntaxRes = await executeScriptHook(syntaxScript, 'initState', { ctx: {} });
        expect(syntaxRes.ok).toBe(false);
        expect(syntaxRes.timedOut).toBe(false);
        expect(syntaxRes.error).toMatch(/SyntaxError/i);

        const runtimeScript = makePyScript(`
def init_state(ctx):
    return 1 / 0
`);
        const runtimeRes = await executeScriptHook(runtimeScript, 'initState', { ctx: {} });
        expect(runtimeRes.ok).toBe(false);
        expect(runtimeRes.timedOut).toBe(false);
        expect(runtimeRes.error).toMatch(/ZeroDivisionError/i);
    });

    it('terminates infinite loops cleanly within timeoutMs with { ok: false, timedOut: true }', async () => {
        const loopScript = makePyScript(`
def init_state(ctx):
    while True:
        pass
`);
        const res = await executeScriptHook(
            loopScript,
            'initState',
            { ctx: {} },
            { timeoutMs: 250 },
        );
        expect(res.ok).toBe(false);
        expect(res.timedOut).toBe(true);
        expect(res.error).toMatch(/timed out/i);
    }, 10000);
});

describe('2. Python sandbox security', () => {
    it('allows safe stdlib modules (math, re, json, random, collections, datetime)', async () => {
        const script = makePyScript(`
import math
import re
import json
import random
import collections
import datetime

def init_state(ctx):
    rng = random.Random(42)
    counts = collections.Counter(["a", "b", "a"])
    dt = datetime.date(2026, 1, 15).isoformat()
    matched = bool(re.search(r"^hello-\\d+$", "hello-7"))
    encoded = json.dumps({"sqrt": int(math.sqrt(144))})
    return {
        "roll": rng.randint(1, 10),
        "a_count": counts["a"],
        "date": dt,
        "matched": matched,
        "encoded": encoded,
    }
`);
        const res = await executeScriptHook(script, 'initState', { ctx: {} });
        expect(res.ok).toBe(true);
        expect(res.result).toMatchObject({
            a_count: 2,
            date: '2026-01-15',
            matched: true,
            encoded: '{"sqrt": 12}',
        });
        expect(res.result.roll).toBeGreaterThanOrEqual(1);
        expect(res.result.roll).toBeLessThanOrEqual(10);
    });

    it.each(['os', 'sys', 'subprocess', 'socket', 'urllib', 'importlib'])(
        'blocks importing "%s" with ImportError (ok: false)',
        async (modName) => {
            const script = makePyScript(`
import ${modName}

def init_state(ctx):
    return {}
`);
            const res = await executeScriptHook(script, 'initState', { ctx: {} });
            expect(res.ok).toBe(false);
            expect(res.error).toMatch(/ImportError/i);
        },
    );

    it.each([
        ['open', 'open("/etc/passwd", "r")'],
        ['eval', 'eval("1 + 1")'],
        ['exec', 'exec("x = 1")'],
        ['compile', 'compile("x = 1", "<x>", "exec")'],
    ])('blocks dangerous builtin %s() (ok: false)', async (_name, expr) => {
        const script = makePyScript(`
def init_state(ctx):
    return {"val": ${expr}}
`);
        const res = await executeScriptHook(script, 'initState', { ctx: {} });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/NameError/i);
    });

    it.each([
        ['__subclasses__ via tuple __class__', "getattr(getattr((), '__class__').__base__, '__subclasses__')()"],
        ['__globals__ via function', "def _f(): pass\n    return getattr(_f, '__globals__')"],
        ['__builtins__ via function', "def _f(): pass\n    return getattr(_f, '__builtins__')"],
        ['__code__ via function', "def _f(): pass\n    return getattr(_f, '__code__')"],
    ])('blocks dunder escape (%s) cleanly with ok: false', async (_label, body) => {
        const code = body.includes('\n')
            ? `def init_state(ctx):\n    ${body}`
            : `def init_state(ctx):\n    return ${body}`;
        const script = makePyScript(code);
        const res = await executeScriptHook(script, 'initState', { ctx: {} });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/AttributeError|restricted/i);
    });
});

describe('3. Python starter templates (SCRIPT_PYTHON_STARTER_TEMPLATES)', () => {
    const expectedIds = [
        'py_blank',
        'py_time_decay_meter',
        'py_command_tool_companion',
        'py_stage_route_progression',
    ];

    it('exposes the 4 canonical Python starter templates via SCRIPT_PYTHON_STARTER_TEMPLATES and getStarterTemplatesForLang', () => {
        expect(SCRIPT_PYTHON_STARTER_TEMPLATES).toHaveLength(4);
        expect(getStarterTemplatesForLang('python')).toBe(SCRIPT_PYTHON_STARTER_TEMPLATES);
        expect(SCRIPT_PYTHON_STARTER_TEMPLATES.map((t) => t.id)).toEqual(expectedIds);
    });

    it.each(expectedIds)(
        'template "%s" passes validateScriptDefinition (0 errors) and executes initState + onBeforeGenerate + renderMemo cleanly',
        async (id) => {
            const tpl = getStarterTemplateById(id);
            expect(tpl).not.toBeNull();
            expect(tpl.lang).toBe('python');

            const normalized = normalizeScriptDefinition(tpl);
            const validation = validateScriptDefinition(normalized);
            expect(validation.valid).toBe(true);
            expect(validation.errors).toEqual([]);

            const initRes = await ensureScriptState(normalized, null, {
                time: { deltaMinutes: 0, dayChanged: false },
            });
            expect(initRes.ok).toBe(true);
            expect(initRes.initialized).toBe(true);

            const beforeRes = await runScriptsBeforeGenerate(
                [normalized],
                { [normalized.id]: initRes.state },
                {
                    userMessage: 'We pause along the moonlit trail.',
                    time: { deltaMinutes: 60, dayChanged: false },
                },
            );
            expect(beforeRes.errors).toEqual([]);
            expect(beforeRes.updatedStates[normalized.id]).toBeDefined();
            expect(typeof beforeRes.memoPatches[normalized.trackerTag]).toBe('string');
            expect(beforeRes.memoPatches[normalized.trackerTag].length).toBeGreaterThan(0);

            const directMemo = await renderScriptMemo(
                normalized,
                beforeRes.updatedStates[normalized.id],
                {},
            );
            expect(directMemo.ok).toBe(true);
            expect(typeof directMemo.memoBlock).toBe('string');
            expect(directMemo.memoBlock.length).toBeGreaterThan(0);
        },
        10000,
    );
});

describe('4. Python reference fixture (hearth-companion-py.script.json)', () => {
    beforeEach(() => {
        for (const key of Object.keys(testExtensionSettings)) {
            delete testExtensionSettings[key];
        }
        localStorage.clear();
    });

    it('parses cleanly via parseScriptFromJson with ok: true, 0 errors, 0 warnings', () => {
        const parsed = parseScriptFromJson(HEARTH_FIXTURE_RAW);
        expect(parsed.ok).toBe(true);
        expect(parsed.errors).toEqual([]);
        expect(parsed.warnings).toEqual([]);
        expect(parsed.script.id).toBe('hearth_companion_py');
        expect(parsed.script.lang).toBe('python');
        expect(parsed.script.trackerTag).toBe('HEARTH_COMPANION');
        expect(parsed.script.commandPrefix).toBe('!hearth');
    });

    it('executes a full multi-turn playthrough: command + [TIME] decay, pre-turn dedupe, Trusted stage media, onAfterGenerate skip, and HUD card rendering', async () => {
        const parsed = parseScriptFromJson(HEARTH_FIXTURE_RAW);
        expect(parsed.ok).toBe(true);
        const script = parsed.script;

        // Turn 1: !hearth comfort: gift + [TIME] decay (deltaMinutes: 30)
        // Initial warmth=45, trust=10.
        // 30m decay => -2 warmth (43). Gift => +6 warmth (49), +10 trust (20).
        const turn1Ledger = createTurnLedger();
        const turn1Before = await runScriptsBeforeGenerate(
            [script],
            {},
            {
                userMessage: '!hearth comfort: gift',
                time: { deltaMinutes: 30, dayChanged: false },
            },
            turn1Ledger,
        );
        expect(turn1Before.errors).toEqual([]);
        let state = turn1Before.updatedStates[script.id];
        expect(state.warmth).toBe(49);
        expect(state.trust).toBe(20);
        expect(state.stage).toBe('Stranger');
        expect(state.cared_today).toBe(true);
        expect(turn1Before.promptInjections[0].text).toContain('[TIME]');
        expect(turn1Before.promptInjections[0].text).toContain('cooled the hearth by -2 Warmth');

        // Pre-turn dedupe: calling runScriptToolAction('comfort', { kind: 'gift' }) on the same ledger is skipped
        const dedupedTool = await runScriptToolAction(
            script,
            state,
            'comfort',
            { kind: 'gift' },
            {},
            turn1Ledger,
        );
        expect(dedupedTool.ok).toBe(true);
        expect(dedupedTool.deduped).toBe(true);
        expect(dedupedTool.reason).toBe('already_handled_pre_turn');
        expect(dedupedTool.state.warmth).toBe(49);
        expect(dedupedTool.state.trust).toBe(20);

        // onAfterGenerate on Turn 1 sees handledInPreTurn and skips fallback warmth adjustment
        const turn1After = await runScriptsAfterGenerate(
            [script],
            { [script.id]: state },
            { assistantMessage: 'The room is silent.' },
            turn1Ledger,
        );
        expect(turn1After.errors).toEqual([]);
        state = turn1After.updatedStates[script.id];
        expect(state.warmth).toBe(49);
        expect(state.trust).toBe(20);

        // Turn 2: natural RP mid-turn tool calls reaching Trusted (trust >= 35)
        // First comfort gift: trust 20 -> 30, warmth 49 -> 55 (still Stranger)
        const turn2Ledger = createTurnLedger();
        const tool1 = await runScriptToolAction(
            script,
            state,
            'comfort',
            { kind: 'gift' },
            {},
            turn2Ledger,
        );
        expect(tool1.ok).toBe(true);
        expect(tool1.deduped).toBe(false);
        state = tool1.state;
        expect(state.trust).toBe(30);
        expect(state.stage).toBe('Stranger');
        expect(tool1.appendMarkdown).toBe('');

        // Second comfort embrace: trust 30 -> 37 (>= 35 => Trusted!), warmth 55 -> 63
        const tool2 = await runScriptToolAction(
            script,
            state,
            'comfort',
            { kind: 'embrace' },
            {},
            turn2Ledger,
        );
        expect(tool2.ok).toBe(true);
        expect(tool2.deduped).toBe(false);
        state = tool2.state;
        expect(state.trust).toBe(37);
        expect(state.warmth).toBe(63);
        expect(state.stage).toBe('Trusted');
        expect(tool2.toolResult.stage_changed).toBe(true);
        expect(tool2.hasPortraitUrl).toBe(true);
        expect(tool2.portraitUrl).toBe('https://example.com/portraits/lyra_trusted.webp');
        expect(tool2.appendMarkdown).toBe('![](https://example.com/portraits/lyra_trusted.webp)');

        // onAfterGenerate on Turn 2 sees handledInToolCall and skips fallback decay AND does NOT repeat appendMarkdown
        const turn2After = await runScriptsAfterGenerate(
            [script],
            { [script.id]: state },
            { assistantMessage: 'She smiles softly.' },
            turn2Ledger,
        );
        expect(turn2After.errors).toEqual([]);
        state = turn2After.updatedStates[script.id];
        expect(state.warmth).toBe(63);
        expect(turn2After.appendMarkdowns).toEqual([]);

        // Turn 3: another tool action while Trusted does NOT repeat appendMarkdown
        const turn3Tool = await runScriptToolAction(
            script,
            state,
            'comfort',
            { kind: 'words' },
            {},
            createTurnLedger(),
        );
        expect(turn3Tool.ok).toBe(true);
        state = turn3Tool.state;
        expect(state.stage).toBe('Trusted');
        expect(turn3Tool.toolResult.stage_changed).toBe(false);
        expect(turn3Tool.hasPortraitUrl).toBe(true);
        expect(turn3Tool.portraitUrl).toBe('https://example.com/portraits/lyra_trusted.webp');
        expect(turn3Tool.appendMarkdown).toBe('');

        // Verify fallback DOES run when neither command nor tool handled the turn
        const unhandedAfter = await runScriptsAfterGenerate(
            [script],
            { [script.id]: state },
            { assistantMessage: 'We sit quietly without tending the fire.' },
            createTurnLedger(),
        );
        expect(unhandedAfter.errors).toEqual([]);
        expect(unhandedAfter.updatedStates[script.id].warmth).toBe(state.warmth - 2);
        state = unhandedAfter.updatedStates[script.id];

        // Render memo cleanly through renderer.js (renderMemoAsCards)
        const settings = getSettings();
        upsertScript(settings, script);

        const prevGetContext = globalThis.SillyTavern.getContext;
        globalThis.SillyTavern.getContext = () => ({
            extensionSettings: testExtensionSettings,
            chatId: 'vitest-chat',
            name2: 'Lyra',
            saveSettingsDebounced: () => {},
        });

        try {
            initScriptHostAdapter();
            const memoRes = await renderScriptMemo(script, state, {});
            expect(memoRes.ok).toBe(true);
            expect(memoRes.memoBlock).toContain('Companion: Lyra');
            expect(memoRes.memoBlock).toContain('((PILLS))');
            expect(memoRes.memoBlock).toContain('Trusted');
            expect(memoRes.memoBlock).toContain('((BAR))');
            expect(memoRes.memoBlock).toContain('((BARGREEN))');

            applyScriptMemoPatches(settings, { [script.trackerTag]: memoRes.memoBlock });
            const html = renderMemoAsCards(settings.currentMemo, null, {});
            expect(typeof html).toBe('string');
            expect(html).toContain('data-tag="HEARTH_COMPANION"');
            expect(html).toContain('Hearth Companion (Python)');
            expect(html).toContain('rt-hp-bar-wrap');
            expect(html).toContain('rt-unit-pill');
        } finally {
            globalThis.SillyTavern.getContext = prevGetContext;
        }
    }, 20000);
});

describe('5. Browser Pyodide Worker runner (runner-python-pyodide.js)', () => {
    const originalWorker = globalThis.Worker;
    const originalBlob = globalThis.Blob;
    const originalUrl = globalThis.URL;

    afterEach(() => {
        if (originalWorker === undefined) {
            delete globalThis.Worker;
        } else {
            globalThis.Worker = originalWorker;
        }
        if (originalBlob === undefined) {
            delete globalThis.Blob;
        } else {
            globalThis.Blob = originalBlob;
        }
        globalThis.URL = originalUrl;
        vi.restoreAllMocks();
    });

    function installMockWorkerEnv({ onExec } = {}) {
        const workers = [];
        const revokedUrls = [];
        let blobSeq = 0;

        class MockBlob {
            constructor(parts, options) {
                this.parts = parts;
                this.options = options;
                this.size = parts.reduce((sum, p) => sum + String(p).length, 0);
            }
        }

        class MockWorker {
            constructor(scriptUrl) {
                this.scriptUrl = scriptUrl;
                this.onmessage = null;
                this.onerror = null;
                this.onmessageerror = null;
                this.terminated = false;
                this.postedMessages = [];
                workers.push(this);

                queueMicrotask(() => {
                    if (!this.terminated && typeof this.onmessage === 'function') {
                        this.onmessage({ data: { type: 'ready' } });
                    }
                });
            }

            postMessage(msg) {
                this.postedMessages.push(msg);
                if (typeof onExec === 'function') {
                    onExec(this, msg);
                }
            }

            terminate() {
                this.terminated = true;
            }
        }

        const MockURL = class extends originalUrl {};
        MockURL.createObjectURL = vi.fn(() => `blob:mock-pyodide-${++blobSeq}`);
        MockURL.revokeObjectURL = vi.fn((url) => {
            revokedUrls.push(url);
        });

        globalThis.Blob = MockBlob;
        globalThis.Worker = MockWorker;
        globalThis.URL = MockURL;

        return { workers, revokedUrls, MockURL };
    }

    it('reuses a warm worker across sequential runHook calls and transitions getStatus() idle -> ready', async () => {
        const { workers } = installMockWorkerEnv({
            onExec: (worker, msg) => {
                queueMicrotask(() => {
                    if (worker.terminated) return;
                    worker.onmessage?.({
                        data: {
                            type: 'result',
                            id: msg.id,
                            data: {
                                ok: true,
                                result: { hook: msg.hookName, payload: JSON.parse(msg.payloadJson) },
                                missingHook: false,
                                logs: [`ran ${msg.hookName}`],
                                durationMs: 4,
                            },
                        },
                    });
                });
            },
        });

        const runner = createPyodideRunner();
        expect(runner.getStatus().state).toBe('idle');

        const res1 = await runner.runHook({
            code: 'def init_state(ctx): return {}',
            hookName: 'initState',
            payload: { ctx: { turn: 1 } },
        });
        expect(res1.ok).toBe(true);
        expect(res1.result).toEqual({ hook: 'initState', payload: { ctx: { turn: 1 } } });
        expect(res1.logs).toEqual(['ran initState']);
        expect(runner.getStatus().state).toBe('ready');
        expect(workers).toHaveLength(1);

        const res2 = await runner.runHook({
            code: 'def on_before_generate(state, ctx): return {"state": state}',
            hookName: 'onBeforeGenerate',
            payload: { state: { turn: 1 }, ctx: {} },
        });
        expect(res2.ok).toBe(true);
        expect(res2.result.hook).toBe('onBeforeGenerate');
        expect(workers).toHaveLength(1);
        expect(workers[0].terminated).toBe(false);
        expect(workers[0].postedMessages).toHaveLength(2);
    });

    it('configure({ pyodideIndexUrl }) terminates the old worker and resets status to idle', async () => {
        const { workers, revokedUrls } = installMockWorkerEnv({
            onExec: (worker, msg) => {
                queueMicrotask(() => {
                    if (worker.terminated) return;
                    worker.onmessage?.({
                        data: {
                            type: 'result',
                            id: msg.id,
                            data: { ok: true, result: { ok: true }, missingHook: false, logs: [] },
                        },
                    });
                });
            },
        });

        const runner = createPyodideRunner();
        await runner.runHook({ code: 'def init_state(ctx): return {}', hookName: 'initState' });
        expect(runner.getStatus().state).toBe('ready');
        expect(workers).toHaveLength(1);
        const firstWorker = workers[0];

        const status = runner.configure({ pyodideIndexUrl: 'https://custom.local/pyodide/' });
        expect(firstWorker.terminated).toBe(true);
        expect(revokedUrls).toHaveLength(1);
        expect(status).toEqual({
            state: 'idle',
            indexUrl: 'https://custom.local/pyodide/',
            lastError: null,
        });
        expect(runner.getStatus()).toEqual(status);

        // Next call boots a new worker with the custom indexUrl embedded in its source
        await runner.runHook({ code: 'def init_state(ctx): return {}', hookName: 'initState' });
        expect(workers).toHaveLength(2);
        expect(runner.getStatus().state).toBe('ready');
    });

    it('terminates hung worker on per-hook timeout, returns { ok: false, timedOut: true }, resets to idle, and recovers on next call', async () => {
        let shouldHang = true;
        const { workers } = installMockWorkerEnv({
            onExec: (worker, msg) => {
                if (shouldHang) {
                    // Intentionally never respond to simulate infinite loop in Pyodide worker
                    return;
                }
                queueMicrotask(() => {
                    if (worker.terminated) return;
                    worker.onmessage?.({
                        data: {
                            type: 'result',
                            id: msg.id,
                            data: { ok: true, result: { recovered: true }, missingHook: false, logs: [] },
                        },
                    });
                });
            },
        });

        const runner = createPyodideRunner();

        const timeoutRes = await runner.runHook({
            code: 'while True: pass',
            hookName: 'initState',
            timeoutMs: 30,
        });
        expect(timeoutRes.ok).toBe(false);
        expect(timeoutRes.timedOut).toBe(true);
        expect(timeoutRes.error).toMatch(/timed out/i);
        expect(workers).toHaveLength(1);
        expect(workers[0].terminated).toBe(true);
        expect(runner.getStatus().state).toBe('idle');

        // Next call boots a fresh worker and succeeds
        shouldHang = false;
        const recoveryRes = await runner.runHook({
            code: 'def init_state(ctx): return {"recovered": True}',
            hookName: 'initState',
            timeoutMs: 200,
        });
        expect(recoveryRes.ok).toBe(true);
        expect(recoveryRes.timedOut).toBe(false);
        expect(recoveryRes.result).toEqual({ recovered: true });
        expect(workers).toHaveLength(2);
        expect(workers[1].terminated).toBe(false);
        expect(runner.getStatus().state).toBe('ready');
    });
});
