import { describe, expect, it } from 'vitest';

import {
    SCRIPT_SCHEMA_VERSION,
    buildToolSchemaFromActions,
    deriveScriptToolName,
    detectScriptCollisions,
    normalizeScriptDefinition,
    normalizeScriptResult,
    parseScriptFromJson,
    parseUserCommand,
    sanitizeCommandPrefix,
    sanitizePortraitUrl,
    sanitizeScriptId,
    sanitizeTrackerTag,
    serializeScriptToJson,
    validateScriptDefinition,
} from '../src/features/scripting/core/script-schema.js';

import {
    executeScriptHook,
    getRunner,
    listRunners,
} from '../src/features/scripting/core/runner-registry.js';

import {
    SCRIPT_STARTER_TEMPLATES,
    getStarterTemplateById,
} from '../src/features/scripting/core/script-templates.js';

import {
    canonicalizeArgs,
    createTurnLedger,
    ensureScriptState,
    renderScriptMemo,
    runSandboxSimulation,
    runScriptToolAction,
    runScriptsAfterGenerate,
    runScriptsBeforeGenerate,
} from '../src/features/scripting/core/script-engine.js';

describe('script-schema.js', () => {
    describe('sanitizers and identifiers', () => {
        it('sanitizes script IDs to lowercase snake_case with fallback', () => {
            expect(sanitizeScriptId('  Succubus Curse!  ')).toBe('succubus_curse');
            expect(sanitizeScriptId('__My-Script 01__')).toBe('my_script_01');
            expect(sanitizeScriptId('')).toBe('custom_script');
            expect(sanitizeScriptId('   !!!   ')).toBe('custom_script');
            expect(sanitizeScriptId(null)).toBe('custom_script');
        });

        it('sanitizes tracker tags to UPPER_SNAKE_CASE', () => {
            expect(sanitizeTrackerTag('  vital meter-2 ')).toBe('VITAL_METER_2');
            expect(sanitizeTrackerTag('__custom--tag__')).toBe('CUSTOM_TAG');
            expect(sanitizeTrackerTag('')).toBe('');
            expect(sanitizeTrackerTag('---')).toBe('');
        });

        it('sanitizes command prefixes with a single leading bang', () => {
            expect(sanitizeCommandPrefix('succubus')).toBe('!succubus');
            expect(sanitizeCommandPrefix('  !!ally  ')).toBe('!ally');
            expect(sanitizeCommandPrefix('!  cmd ')).toBe('!cmd');
            expect(sanitizeCommandPrefix('!')).toBe('');
            expect(sanitizeCommandPrefix('   ')).toBe('');
        });

        it('keeps valid explicit toolName or derives Script_<PascalCase>', () => {
            expect(deriveScriptToolName({ toolName: 'update_vital_meter', name: 'Ignored' })).toBe('update_vital_meter');
            expect(deriveScriptToolName({ toolName: '123_invalid', name: 'Succubus Pact' })).toBe('Script_SuccubusPact');
            expect(deriveScriptToolName({ name: '', id: 'my_custom_script' })).toBe('Script_MyCustomScript');
            expect(deriveScriptToolName({ name: '!!!', id: '!!!' })).toBe('Script_Custom');
        });

        it('allows safe portrait URLs and rejects unsafe schemes', () => {
            expect(sanitizePortraitUrl('  https://example.com/p.png  ')).toBe('https://example.com/p.png');
            expect(sanitizePortraitUrl('http://localhost:8000/img.webp')).toBe('http://localhost:8000/img.webp');
            expect(sanitizePortraitUrl('/assets/portraits/stage-1.png')).toBe('/assets/portraits/stage-1.png');
            expect(sanitizePortraitUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');

            expect(sanitizePortraitUrl('javascript:alert(1)')).toBe('');
            expect(sanitizePortraitUrl('  JAVASCRIPT:alert(1)')).toBe('');
            expect(sanitizePortraitUrl('vbscript:msgbox(1)')).toBe('');
            expect(sanitizePortraitUrl('data:text/html,<script>alert(1)</script>')).toBe('');
            expect(sanitizePortraitUrl('')).toBe('');
            expect(sanitizePortraitUrl(null)).toBe('');
        });
    });

    describe('normalizeScriptDefinition & validateScriptDefinition', () => {
        it('normalizes and validates a valid script definition', () => {
            const normalized = normalizeScriptDefinition({
                name: 'Stamina Tracker',
                scope: 'CHARACTER',
                boundCharacters: ['Elena', 'Elena', '  Marcus  '],
                trackerTag: 'stamina meter',
                commandPrefix: 'stamina',
                toolEnabled: true,
                toolActions: [
                    {
                        name: 'rest',
                        description: 'Recover stamina',
                        params: [{ name: 'amount', type: 'number', required: true }],
                    },
                ],
                code: 'function initState() { return { stamina: 100 }; }',
            });

            expect(normalized.schemaVersion).toBe(SCRIPT_SCHEMA_VERSION);
            expect(normalized.id).toBe('stamina_tracker');
            expect(normalized.lang).toBe('js');
            expect(normalized.scope).toBe('character');
            expect(normalized.boundCharacters).toEqual(['Elena', 'Marcus']);
            expect(normalized.trackerTag).toBe('STAMINA_METER');
            expect(normalized.commandPrefix).toBe('!stamina');
            expect(normalized.toolName).toBe('Script_StaminaTracker');

            const validation = validateScriptDefinition(normalized);
            expect(validation.valid).toBe(true);
            expect(validation.errors).toEqual([]);
            expect(validation.warnings).toEqual([]);
        });

        it('rejects scripts with missing name or empty code', () => {
            const res = validateScriptDefinition(normalizeScriptDefinition({ name: '', code: '   ' }));
            expect(res.valid).toBe(false);
            expect(res.errors).toEqual(expect.arrayContaining([
                'Script name is required.',
                'Script code must not be empty.',
            ]));
        });

        it('warns on lang: python and on toolEnabled with empty toolActions', () => {
            const normalized = normalizeScriptDefinition({
                name: 'Future Py Script',
                lang: 'python',
                toolEnabled: true,
                toolActions: [],
                code: 'def init_state(): return {}',
            });

            const validation = validateScriptDefinition(normalized);
            expect(validation.valid).toBe(true);
            expect(validation.errors).toEqual([]);
            expect(validation.warnings).toHaveLength(2);
            expect(validation.warnings.some((w) => /python/i.test(w))).toBe(true);
            expect(validation.warnings.some((w) => /no tool actions/i.test(w))).toBe(true);
        });
    });

    describe('buildToolSchemaFromActions', () => {
        it('builds a tight action enum and merges parameter types and enums', () => {
            const script = normalizeScriptDefinition({
                name: 'Companion Script',
                toolEnabled: true,
                toolName: 'companion_tool',
                toolDescription: 'Manage companion state.',
                toolActions: [
                    {
                        name: 'interact',
                        description: 'Shift mood',
                        params: [
                            { name: 'mood', type: 'string', enum: ['Warm', 'Guarded'], description: 'Target mood' },
                            { name: 'delta', type: 'number', required: true, description: 'Affinity change' },
                        ],
                    },
                    {
                        name: 'set_stance',
                        description: 'Adjust stance',
                        params: [
                            { name: 'mood', type: 'string', enum: ['Guarded', 'Playful'] },
                            { name: 'locked', type: 'boolean', required: false },
                        ],
                    },
                ],
                code: 'function initState() { return {}; }',
            });

            const schema = buildToolSchemaFromActions(script);
            expect(schema).not.toBeNull();
            expect(schema.name).toBe('companion_tool');
            expect(schema.parameters.required).toEqual(['action']);
            expect(schema.parameters.properties.action.enum).toEqual(['interact', 'set_stance']);
            expect(schema.parameters.properties.mood).toMatchObject({
                type: 'string',
                enum: ['Warm', 'Guarded', 'Playful'],
                description: 'Target mood',
            });
            expect(schema.parameters.properties.delta.type).toBe('number');
            expect(schema.parameters.properties.locked.type).toBe('boolean');
        });

        it('returns null when toolEnabled is false or toolActions is empty', () => {
            const disabled = normalizeScriptDefinition({
                name: 'Disabled Tool',
                toolEnabled: false,
                toolActions: [{ name: 'ping' }],
                code: 'function initState() { return {}; }',
            });
            expect(buildToolSchemaFromActions(disabled)).toBeNull();

            const emptyActions = normalizeScriptDefinition({
                name: 'No Actions',
                toolEnabled: true,
                toolActions: [],
                code: 'function initState() { return {}; }',
            });
            expect(buildToolSchemaFromActions(emptyActions)).toBeNull();
        });
    });

    describe('parseUserCommand', () => {
        it('parses space-separated, colon-separated, and hyphenated commands', () => {
            const spaceCmd = parseUserCommand('!succubus name Mira', '!succubus');
            expect(spaceCmd).toMatchObject({
                prefix: '!succubus',
                subcommand: 'name',
                rawArgs: 'Mira',
                strippedMessage: '',
            });

            const colonSpaced = parseUserCommand('!succubus name: Mira', '!succubus');
            expect(colonSpaced).toMatchObject({
                prefix: '!succubus',
                subcommand: 'name',
                rawArgs: 'Mira',
                strippedMessage: '',
            });

            const colonTight = parseUserCommand('!succubus name:Mira', '!succubus');
            expect(colonTight).toMatchObject({
                prefix: '!succubus',
                subcommand: 'name',
                rawArgs: 'Mira',
            });

            const hyphenated = parseUserCommand('!succubus set-rule: No biting', '!succubus');
            expect(hyphenated).toMatchObject({
                prefix: '!succubus',
                subcommand: 'set-rule',
                rawArgs: 'No biting',
            });
        });

        it('strips the matched command line from multi-line messages', () => {
            const msg = 'I step into the courtyard.\n  !succubus set-rule: No biting\nShe smiles faintly.';
            const parsed = parseUserCommand(msg, '!succubus');
            expect(parsed).not.toBeNull();
            expect(parsed.subcommand).toBe('set-rule');
            expect(parsed.rawArgs).toBe('No biting');
            expect(parsed.strippedMessage).toBe('I step into the courtyard.\nShe smiles faintly.');
        });

        it('returns null when no line matches the command prefix', () => {
            expect(parseUserCommand('Hello world\n!other arg', '!succubus')).toBeNull();
            expect(parseUserCommand('!succubus_extra arg', '!succubus')).toBeNull();
            expect(parseUserCommand('', '!succubus')).toBeNull();
        });
    });

    describe('normalizeScriptResult', () => {
        it('distinguishes missing portraitUrl, explicit empty clear, and sanitized URLs', () => {
            const omitted = normalizeScriptResult({ state: { hp: 10 } });
            expect(omitted.hasPortraitUrl).toBe(false);
            expect(omitted.portraitUrl).toBeNull();

            const unsafe = normalizeScriptResult({ portraitUrl: 'javascript:alert(1)' });
            expect(unsafe.hasPortraitUrl).toBe(false);
            expect(unsafe.portraitUrl).toBeNull();

            const cleared = normalizeScriptResult({ portraitUrl: '' });
            expect(cleared.hasPortraitUrl).toBe(true);
            expect(cleared.portraitUrl).toBe('');

            const valid = normalizeScriptResult({ portraitUrl: '  https://cdn.example.com/avatar.png  ' });
            expect(valid.hasPortraitUrl).toBe(true);
            expect(valid.portraitUrl).toBe('https://cdn.example.com/avatar.png');
        });

        it('returns safe defaults for null, undefined, primitives, and arrays', () => {
            for (const bad of [null, undefined, 42, 'hello', true, ['a']]) {
                expect(normalizeScriptResult(bad)).toEqual({
                    hasState: false,
                    state: undefined,
                    hasMemoBlock: false,
                    memoBlock: null,
                    promptInjection: '',
                    hasToolResult: false,
                    toolResult: undefined,
                    stripCommand: false,
                    hasPortraitUrl: false,
                    portraitUrl: null,
                    appendMarkdown: '',
                    logs: [],
                });
            }
        });
    });

    describe('detectScriptCollisions', () => {
        it('detects duplicate trackerTag, case-insensitive commandPrefix, and toolName', () => {
            const s1 = normalizeScriptDefinition({
                id: 'script_a',
                name: 'Script A',
                trackerTag: 'pact_state',
                commandPrefix: '!Pact',
                toolEnabled: true,
                toolName: 'shared_tool',
                toolActions: [{ name: 'act' }],
                code: 'function initState() { return {}; }',
            });
            const s2 = normalizeScriptDefinition({
                id: 'script_b',
                name: 'Script B',
                trackerTag: 'PACT_STATE',
                commandPrefix: '!pact',
                toolEnabled: true,
                toolName: 'shared_tool',
                toolActions: [{ name: 'act' }],
                code: 'function initState() { return {}; }',
            });

            const collisions = detectScriptCollisions([s1, s2]);
            expect(collisions.hasCollisions).toBe(true);
            expect(collisions.trackerTagCollisions).toHaveLength(1);
            expect(collisions.trackerTagCollisions[0].scriptIds).toEqual(['script_a', 'script_b']);
            expect(collisions.commandPrefixCollisions).toHaveLength(1);
            expect(collisions.commandPrefixCollisions[0].scriptIds).toEqual(['script_a', 'script_b']);
            expect(collisions.toolNameCollisions).toHaveLength(1);
            expect(collisions.toolNameCollisions[0].scriptIds).toEqual(['script_a', 'script_b']);
        });

        it('reports no false positives when unique or when toolEnabled is false', () => {
            const s1 = normalizeScriptDefinition({
                id: 'script_a',
                name: 'Script A',
                trackerTag: 'TAG_A',
                commandPrefix: '!a',
                toolEnabled: false,
                toolName: 'same_name',
                toolActions: [{ name: 'act' }],
                code: 'function initState() { return {}; }',
            });
            const s2 = normalizeScriptDefinition({
                id: 'script_b',
                name: 'Script B',
                trackerTag: 'TAG_B',
                commandPrefix: '!b',
                toolEnabled: false,
                toolName: 'same_name',
                toolActions: [{ name: 'act' }],
                code: 'function initState() { return {}; }',
            });

            const collisions = detectScriptCollisions([s1, s2]);
            expect(collisions.hasCollisions).toBe(false);
            expect(collisions.trackerTagCollisions).toEqual([]);
            expect(collisions.commandPrefixCollisions).toEqual([]);
            expect(collisions.toolNameCollisions).toEqual([]);
        });
    });

    describe('serializeScriptToJson & parseScriptFromJson', () => {
        it('round-trips a valid script definition cleanly', () => {
            const original = normalizeScriptDefinition({
                name: 'Roundtrip Meter',
                description: 'Tracks points',
                trackerTag: 'POINTS',
                commandPrefix: '!pts',
                code: 'function initState() { return { pts: 0 }; }',
            });

            const json = serializeScriptToJson(original);
            const parsed = parseScriptFromJson(json);

            expect(parsed.ok).toBe(true);
            expect(parsed.errors).toEqual([]);
            expect(parsed.script).toEqual(original);
        });

        it('reports descriptive errors on malformed or invalid JSON payloads', () => {
            expect(parseScriptFromJson('')).toMatchObject({ ok: false, script: null });
            expect(parseScriptFromJson('{bad json')).toMatchObject({
                ok: false,
                script: null,
                errors: [expect.stringMatching(/Invalid JSON/i)],
            });
            expect(parseScriptFromJson('[1, 2, 3]')).toMatchObject({
                ok: false,
                script: null,
                errors: ['Script JSON must represent an object.'],
            });
            expect(parseScriptFromJson(JSON.stringify({ name: 'Bad Lang', lang: 'ruby', code: 'x = 1' }))).toMatchObject({
                ok: false,
                script: null,
                errors: [expect.stringMatching(/Invalid script language/i)],
            });
        });
    });
});

describe('runner-registry.js & Node VM sandbox', () => {
    it('supports all 3 JS authoring styles', async () => {
        const namedCode = `
            function initState(ctx) { return { style: 'named', seed: ctx.seed || 1 }; }
            function renderMemo(state) { return 'style=' + state.style; }
        `;
        const returnObjectCode = `
            return {
                initState(ctx) { return { style: 'return', seed: ctx.seed || 2 }; },
                renderMemo(state) { return 'style=' + state.style; },
            };
        `;
        const moduleExportsCode = `
            module.exports = {
                initState(ctx) { return { style: 'cjs', seed: ctx.seed || 3 }; },
                renderMemo(state) { return 'style=' + state.style; },
            };
        `;

        for (const [label, code] of [
            ['named', namedCode],
            ['return', returnObjectCode],
            ['cjs', moduleExportsCode],
        ]) {
            const res = await executeScriptHook({ lang: 'js', code }, 'initState', { ctx: { seed: 7 } });
            expect(res.ok).toBe(true);
            expect(res.result).toEqual({ style: label, seed: 7 });
        }
    });

    it('supports async hooks, missing optional hooks, and captures console logs', async () => {
        const code = `
            async function onBeforeGenerate(state, ctx) {
                console.log('tick', ctx.turn);
                console.warn('careful');
                const next = await Promise.resolve({ ...state, count: (state.count || 0) + 1 });
                return { state: next };
            }
        `;

        const hookRes = await executeScriptHook(
            { lang: 'js', code },
            'onBeforeGenerate',
            { state: { count: 2 }, ctx: { turn: 5 } },
        );
        expect(hookRes.ok).toBe(true);
        expect(hookRes.result).toEqual({ state: { count: 3 } });
        expect(hookRes.logs).toEqual(['tick 5', '[warn] careful']);

        const missingRes = await executeScriptHook({ lang: 'js', code }, 'renderMemo', { state: {} });
        expect(missingRes.ok).toBe(true);
        expect(missingRes.missingHook).toBe(true);
    });

    it('isolates thrown runtime errors and terminates infinite loops on timeout', async () => {
        const throwRes = await executeScriptHook(
            { lang: 'js', code: 'function initState() { throw new Error("kaboom"); }' },
            'initState',
            {},
        );
        expect(throwRes.ok).toBe(false);
        expect(throwRes.timedOut).toBe(false);
        expect(throwRes.error).toContain('kaboom');

        const loopRes = await executeScriptHook(
            { lang: 'js', code: 'function initState() { while (true) {} }' },
            'initState',
            {},
            { timeoutMs: 40 },
        );
        expect(loopRes.ok).toBe(false);
        expect(loopRes.timedOut).toBe(true);
        expect(loopRes.error).toMatch(/timed out/i);
    });

    it('blocks dangerous host globals inside the sandbox', async () => {
        const code = `
            function initState() {
                return {
                    fetchType: typeof fetch,
                    processType: typeof process,
                    requireType: typeof require,
                    xhrType: typeof XMLHttpRequest,
                };
            }
        `;
        const res = await executeScriptHook({ lang: 'js', code }, 'initState', {});
        expect(res.ok).toBe(true);
        expect(res.result).toEqual({
            fetchType: 'undefined',
            processType: 'undefined',
            requireType: 'undefined',
            xhrType: 'undefined',
        });
    });

    it('lists the Python runner placeholder as unavailable', async () => {
        const runners = listRunners();
        const jsRunner = runners.find((r) => r.lang === 'js');
        const pyRunner = runners.find((r) => r.lang === 'python');

        expect(jsRunner).toBeDefined();
        expect(jsRunner.available).toBe(true);
        expect(pyRunner).toBeDefined();
        expect(pyRunner.available).toBe(false);
        expect(getRunner('python')?.available).toBe(false);

        const pyExec = await executeScriptHook(
            { lang: 'python', code: 'def init_state(): return {}' },
            'initState',
            {},
        );
        expect(pyExec.ok).toBe(false);
        expect(pyExec.error).toMatch(/Phase 2|Pyodide|unavailable/i);
    });
});

describe('script-templates.js', () => {
    it('validates all 4 starter templates and runs initState + onBeforeGenerate + renderMemo cleanly', async () => {
        expect(SCRIPT_STARTER_TEMPLATES).toHaveLength(4);

        for (const rawTpl of SCRIPT_STARTER_TEMPLATES) {
            const tpl = getStarterTemplateById(rawTpl.id);
            expect(tpl).not.toBeNull();

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
                    userMessage: 'We explore the lantern corridor.',
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
        }
    });
});

describe('script-engine.js', () => {
    it('executes scripts in priority order and hands off read-only ctx.otherScripts', async () => {
        const script1 = normalizeScriptDefinition({
            id: 'script_one',
            name: 'Script One',
            trackerTag: 'ONE',
            code: `
                function initState() { return { count: 1, tag: 'init' }; }
                function onBeforeGenerate(state) {
                    return { state: { count: state.count + 9, tag: 'from_one' } };
                }
                function renderMemo(state) { return 'count=' + state.count; }
            `,
        });

        const script2 = normalizeScriptDefinition({
            id: 'script_two',
            name: 'Script Two',
            trackerTag: 'TWO',
            code: `
                function initState() { return { seenCount: 0, seenTag: '' }; }
                function onBeforeGenerate(state, ctx) {
                    const peer = ctx.otherScripts.script_one;
                    // Attempted mutation should not leak back to script_one's state.
                    peer.count = 9999;
                    return {
                        state: { seenCount: 10, seenTag: peer.tag },
                        memoBlock: 'seen=' + peer.tag,
                    };
                }
            `,
        });

        const res = await runScriptsBeforeGenerate([script1, script2], {}, { userMessage: 'Continue.' });
        expect(res.errors).toEqual([]);
        expect(res.updatedStates.script_one).toEqual({ count: 10, tag: 'from_one' });
        expect(res.updatedStates.script_two).toEqual({ seenCount: 10, seenTag: 'from_one' });
        expect(res.memoPatches.ONE).toBe('count=10');
        expect(res.memoPatches.TWO).toBe('seen=from_one');
    });

    it('isolates errors so a failing script does not block subsequent scripts', async () => {
        const brokenScript = normalizeScriptDefinition({
            id: 'broken_script',
            name: 'Broken Script',
            code: `
                function initState() { return { intact: true }; }
                function onBeforeGenerate() { throw new Error('script1 boom'); }
            `,
        });
        const healthyScript = normalizeScriptDefinition({
            id: 'healthy_script',
            name: 'Healthy Script',
            trackerTag: 'HEALTHY',
            code: `
                function initState() { return { ran: false }; }
                function onBeforeGenerate(state) {
                    return {
                        state: { ran: true },
                        memoBlock: 'healthy=ok',
                    };
                }
            `,
        });

        const res = await runScriptsBeforeGenerate(
            [brokenScript, healthyScript],
            { broken_script: { intact: true } },
            { userMessage: 'Hello' },
        );

        expect(res.errors).toHaveLength(1);
        expect(res.errors[0]).toMatchObject({
            scriptId: 'broken_script',
            hook: 'onBeforeGenerate',
        });
        expect(res.errors[0].error).toContain('script1 boom');
        expect(res.updatedStates.broken_script).toEqual({ intact: true });
        expect(res.updatedStates.healthy_script).toEqual({ ran: true });
        expect(res.memoPatches.HEALTHY).toBe('healthy=ok');
    });

    describe('dual-adjudication turn ledger', () => {
        const succubusScript = normalizeScriptDefinition({
            id: 'succubus_pact',
            name: 'Succubus Pact',
            trackerTag: 'PACT',
            commandPrefix: '!succubus',
            stripCommandFromPrompt: true,
            toolEnabled: true,
            toolName: 'succubus_action',
            toolActions: [
                { name: 'set_rule', params: [{ name: 'rule', type: 'string' }] },
                { name: 'drain', params: [{ name: 'amount', type: 'number' }] },
            ],
            code: `
                function initState() { return { rules: [], calls: 0 }; }
                function onBeforeGenerate(state, ctx) {
                    if (ctx.command && ctx.command.subcommand === 'set-rule') {
                        return {
                            state: { ...state, rules: [...state.rules, ctx.command.rawArgs] },
                        };
                    }
                    return { state };
                }
                function onToolCall(state, call) {
                    const nextCalls = state.calls + 1;
                    if (call.action === 'set_rule') {
                        return {
                            state: {
                                ...state,
                                calls: nextCalls,
                                rules: [...state.rules, String(call.args?.rule || '')],
                            },
                            toolResult: { ok: true, action: 'set_rule' },
                        };
                    }
                    return {
                        state: { ...state, calls: nextCalls },
                        toolResult: { ok: true, action: call.action, amount: call.args?.amount ?? 0 },
                    };
                }
                function onAfterGenerate(state, ctx) {
                    const toolCalls = ctx.turnLedger?.handledInToolCall?.succubus_pact || [];
                    if (toolCalls.length > 0) {
                        return { state };
                    }
                    return {
                        state: { ...state, fallbackRan: true },
                    };
                }
                function renderMemo(state) {
                    return 'Rules: ' + state.rules.length + ', Calls: ' + state.calls;
                }
            `,
        });

        it('dedupes pre-turn !cmd action against mid-turn tool calls including hyphen/underscore equivalence', async () => {
            const ledger = createTurnLedger();
            const pre = await runScriptsBeforeGenerate(
                [succubusScript],
                {},
                { userMessage: 'Let us negotiate.\n!succubus set-rule: No biting' },
                ledger,
            );

            expect(pre.stripCommand).toBe(true);
            expect(pre.strippedMessage).toBe('Let us negotiate.');
            expect(pre.updatedStates.succubus_pact.rules).toEqual(['No biting']);

            // Matching action (set-rule vs set_rule) with matching arg is blocked
            const dupTool = await runScriptToolAction(
                succubusScript,
                pre.updatedStates.succubus_pact,
                'set_rule',
                { rule: 'No biting' },
                {},
                ledger,
            );
            expect(dupTool.ok).toBe(true);
            expect(dupTool.deduped).toBe(true);
            expect(dupTool.reason).toBe('already_handled_pre_turn');
            expect(dupTool.state.calls).toBe(0);

            // Matching action with empty args is also blocked
            const emptyArgsDup = await runScriptToolAction(
                succubusScript,
                pre.updatedStates.succubus_pact,
                'set_rule',
                {},
                {},
                ledger,
            );
            expect(emptyArgsDup.deduped).toBe(true);
            expect(emptyArgsDup.reason).toBe('already_handled_pre_turn');

            // Different args for the same action are allowed to execute
            const differentArgTool = await runScriptToolAction(
                succubusScript,
                pre.updatedStates.succubus_pact,
                'set_rule',
                { rule: 'Always ask first' },
                {},
                ledger,
            );
            expect(differentArgTool.ok).toBe(true);
            expect(differentArgTool.deduped).toBe(false);
            expect(differentArgTool.state.calls).toBe(1);
            expect(differentArgTool.state.rules).toEqual(['No biting', 'Always ask first']);
        });

        it('dedupes identical mid-turn tool calls regardless of key ordering', async () => {
            expect(canonicalizeArgs({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');

            const ledger = createTurnLedger();
            const initial = { rules: [], calls: 0 };

            const first = await runScriptToolAction(
                succubusScript,
                initial,
                'drain',
                { amount: 5, source: 'kiss' },
                {},
                ledger,
            );
            expect(first.ok).toBe(true);
            expect(first.deduped).toBe(false);
            expect(first.state.calls).toBe(1);

            const second = await runScriptToolAction(
                succubusScript,
                first.state,
                'drain',
                { source: 'kiss', amount: 5 },
                {},
                ledger,
            );
            expect(second.ok).toBe(true);
            expect(second.deduped).toBe(true);
            expect(second.reason).toBe('duplicate_tool_call');
            expect(second.state.calls).toBe(1);
        });

        it('enforces maxToolCallsPerTurn cap', async () => {
            const ledger = createTurnLedger({ maxToolCallsPerTurn: 2 });
            let state = { rules: [], calls: 0 };

            const c1 = await runScriptToolAction(succubusScript, state, 'drain', { amount: 1 }, {}, ledger);
            expect(c1.deduped).toBe(false);
            state = c1.state;

            const c2 = await runScriptToolAction(succubusScript, state, 'drain', { amount: 2 }, {}, ledger);
            expect(c2.deduped).toBe(false);
            state = c2.state;

            const c3 = await runScriptToolAction(succubusScript, state, 'drain', { amount: 3 }, {}, ledger);
            expect(c3.ok).toBe(true);
            expect(c3.deduped).toBe(true);
            expect(c3.reason).toBe('max_calls_reached');
            expect(c3.state.calls).toBe(2);
            expect(ledger.toolCallCount).toBe(2);
        });

        it('passes ctx.turnLedger.handledInToolCall to runScriptsAfterGenerate so fallback is skipped', async () => {
            const ledgerWithTool = createTurnLedger();
            const toolRes = await runScriptToolAction(
                succubusScript,
                { rules: [], calls: 0 },
                'drain',
                { amount: 4 },
                {},
                ledgerWithTool,
            );

            const afterWithTool = await runScriptsAfterGenerate(
                [succubusScript],
                { succubus_pact: toolRes.state },
                { assistantMessage: 'The pact seals.' },
                ledgerWithTool,
            );
            expect(afterWithTool.errors).toEqual([]);
            expect(afterWithTool.updatedStates.succubus_pact.fallbackRan).toBeUndefined();

            const freshLedger = createTurnLedger();
            const afterWithoutTool = await runScriptsAfterGenerate(
                [succubusScript],
                { succubus_pact: { rules: [], calls: 0 } },
                { assistantMessage: 'Nothing happened mid-turn.' },
                freshLedger,
            );
            expect(afterWithoutTool.errors).toEqual([]);
            expect(afterWithoutTool.updatedStates.succubus_pact.fallbackRan).toBe(true);
        });
    });

    describe('runSandboxSimulation', () => {
        const simScript = normalizeScriptDefinition({
            id: 'sim_demo',
            name: 'Sim Demo',
            trackerTag: 'SIM_DEMO',
            commandPrefix: '!sim',
            stripCommandFromPrompt: true,
            code: `
                function initState() {
                    return { energy: 50, lastEvent: 'init' };
                }
                function onBeforeGenerate(state, ctx) {
                    const boost = ctx.command?.subcommand === 'boost' ? 10 : 0;
                    return {
                        state: { energy: state.energy + boost, lastEvent: 'before' },
                        promptInjection: boost ? 'Energized!' : '',
                    };
                }
                function onToolCall(state, call) {
                    const delta = Number(call.args?.delta || 0);
                    return {
                        state: { energy: state.energy + delta, lastEvent: 'tool' },
                        toolResult: { ok: true, energy: state.energy + delta },
                    };
                }
                function onAfterGenerate(state) {
                    return {
                        state: { energy: state.energy - 5, lastEvent: 'after' },
                        portraitUrl: '/assets/sim.png',
                        appendMarkdown: '> Turn complete',
                    };
                }
                function renderMemo(state) {
                    return 'Energy: ' + state.energy + ' (' + state.lastEvent + ')';
                }
            `,
        });

        it('supports init, beforeGenerate, toolCall, and afterGenerate simulation events', async () => {
            const initSim = await runSandboxSimulation(simScript, null, { type: 'init' });
            expect(initSim.ok).toBe(true);
            expect(initSim.state).toEqual({ energy: 50, lastEvent: 'init' });
            expect(initSim.memoBlock).toBe('Energy: 50 (init)');

            const beforeSim = await runSandboxSimulation(simScript, initSim.state, {
                type: 'beforeGenerate',
                userMessage: 'Look around.\n!sim boost',
            });
            expect(beforeSim.ok).toBe(true);
            expect(beforeSim.state).toEqual({ energy: 60, lastEvent: 'before' });
            expect(beforeSim.promptInjection).toBe('Energized!');
            expect(beforeSim.stripCommand).toBe(true);
            expect(beforeSim.strippedMessage).toBe('Look around.');
            expect(beforeSim.memoBlock).toBe('Energy: 60 (before)');

            const toolSim = await runSandboxSimulation(simScript, beforeSim.state, {
                type: 'toolCall',
                action: 'adjust',
                args: { delta: 15 },
            });
            expect(toolSim.ok).toBe(true);
            expect(toolSim.state).toEqual({ energy: 75, lastEvent: 'tool' });
            expect(toolSim.toolResult).toEqual({ ok: true, energy: 75 });
            expect(toolSim.memoBlock).toBe('Energy: 75 (tool)');

            const afterSim = await runSandboxSimulation(simScript, toolSim.state, {
                type: 'afterGenerate',
                assistantMessage: 'Done.',
            });
            expect(afterSim.ok).toBe(true);
            expect(afterSim.state).toEqual({ energy: 70, lastEvent: 'after' });
            expect(afterSim.portraitUrl).toBe('/assets/sim.png');
            expect(afterSim.appendMarkdown).toBe('> Turn complete');
            expect(afterSim.memoBlock).toBe('Energy: 70 (after)');

            const badSim = await runSandboxSimulation(simScript, afterSim.state, { type: 'unknown' });
            expect(badSim.ok).toBe(false);
            expect(badSim.error).toMatch(/Unsupported simulation event type/i);
        });
    });
});
