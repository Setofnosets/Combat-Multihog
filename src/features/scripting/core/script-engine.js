/**
 * script-engine.js — Turn orchestration engine, per-turn deduplication ledger,
 * hook execution, and sandbox simulator for Combat-Multihog Game Scripts.
 *
 * Pure ESM, zero SillyTavern/DOM/Multihog imports.
 */

import {
    normalizeScriptResult,
    parseUserCommand,
    sanitizeTrackerTag,
} from './script-schema.js';
import { executeScriptHook } from './runner-registry.js';

const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 8;

function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneJson(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'object') return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return Array.isArray(value) ? [...value] : { ...value };
    }
}

function normalizeActionName(name) {
    return String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/[-_]+/g, '_');
}

function sortValueKeys(value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => (item === undefined ? null : sortValueKeys(item)));
    }
    const sorted = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
        const propVal = value[key];
        if (propVal === undefined) continue;
        sorted[key] = sortValueKeys(propVal);
    }
    return sorted;
}

function stripUndefinedKeys(obj) {
    if (!isPlainObject(obj)) return obj;
    const out = {};
    for (const [key, val] of Object.entries(obj)) {
        if (val !== undefined) {
            out[key] = val;
        }
    }
    return out;
}

function isArgsEmpty(args) {
    if (args === undefined || args === null) return true;
    if (typeof args === 'string') return args.trim() === '';
    if (Array.isArray(args)) return args.length === 0;
    if (typeof args === 'object') {
        return Object.keys(stripUndefinedKeys(args)).length === 0;
    }
    return false;
}

function normalizeTextForArgMatch(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function doPreTurnArgsMatchOrEmpty(rawArgs, args) {
    if (isArgsEmpty(args)) {
        return true;
    }

    const rawTrimmed = String(rawArgs ?? '').trim();
    if (!rawTrimmed) {
        return false;
    }

    const cleanArgs = stripUndefinedKeys(args);

    if (
        (rawTrimmed.startsWith('{') && rawTrimmed.endsWith('}')) ||
        (rawTrimmed.startsWith('[') && rawTrimmed.endsWith(']'))
    ) {
        try {
            const parsed = JSON.parse(rawTrimmed);
            if (canonicalizeArgs(parsed) === canonicalizeArgs(cleanArgs)) {
                return true;
            }
        } catch (_) {
            // Fall through to plain-text argument comparison.
        }
    }

    const normRaw = normalizeTextForArgMatch(rawTrimmed);

    if (!isPlainObject(cleanArgs)) {
        return normalizeTextForArgMatch(cleanArgs) === normRaw;
    }

    const entries = Object.entries(cleanArgs);
    if (entries.length === 0) {
        return true;
    }

    if (entries.length === 1) {
        const [key, val] = entries[0];
        const normVal = normalizeTextForArgMatch(val);
        if (normVal === normRaw) {
            return true;
        }
        const normKey = normalizeTextForArgMatch(key);
        if (
            normRaw === `${normKey}:${normVal}` ||
            normRaw === `${normKey}: ${normVal}` ||
            normRaw === `${normKey}=${normVal}`
        ) {
            return true;
        }
    }

    const joinedValues = entries
        .map(([, val]) => normalizeTextForArgMatch(val))
        .filter(Boolean)
        .join(' ');
    if (joinedValues && joinedValues === normRaw) {
        return true;
    }

    return false;
}

function ensureLedgerShape(ledger) {
    const target = isPlainObject(ledger) ? ledger : createTurnLedger();
    if (!isPlainObject(target.handledInPreTurn)) {
        target.handledInPreTurn = {};
    }
    if (!isPlainObject(target.handledInToolCall)) {
        target.handledInToolCall = {};
    }
    if (!Number.isFinite(Number(target.toolCallCount)) || Number(target.toolCallCount) < 0) {
        target.toolCallCount = 0;
    }
    if (!Number.isFinite(Number(target.maxToolCallsPerTurn)) || Number(target.maxToolCallsPerTurn) < 0) {
        target.maxToolCallsPerTurn = DEFAULT_MAX_TOOL_CALLS_PER_TURN;
    }
    if (!Array.isArray(target.pendingAppendMarkdown)) {
        target.pendingAppendMarkdown = [];
    }
    if (!Array.isArray(target.errors)) {
        target.errors = [];
    }
    return target;
}

function buildOtherScriptsSnapshot(workingStates, excludeScriptId) {
    const otherScripts = {};
    for (const [id, state] of Object.entries(workingStates)) {
        if (id === excludeScriptId) continue;
        if (state === undefined) continue;
        otherScripts[id] = cloneJson(state);
    }
    return otherScripts;
}

function seedWorkingStates(statesById) {
    const workingStates = {};
    if (!isPlainObject(statesById)) return workingStates;
    for (const [id, state] of Object.entries(statesById)) {
        if (state === undefined || state === null) continue;
        workingStates[id] = cloneJson(state);
    }
    return workingStates;
}

function getEnabledOrderedScripts(scripts) {
    if (!Array.isArray(scripts)) return [];
    return scripts.filter((script) => isPlainObject(script) && script.enabled !== false);
}

/**
 * Produces a deterministic, sorted-key JSON string for tool call argument deduplication.
 *
 * @param {unknown} args
 * @returns {string}
 */
export function canonicalizeArgs(args) {
    if (args === undefined || args === null) {
        return '{}';
    }
    try {
        const serialized = JSON.stringify(sortValueKeys(args));
        return typeof serialized === 'string' ? serialized : '{}';
    } catch (_) {
        return '{}';
    }
}

/**
 * Creates a mutable per-turn execution ledger tracking pre-turn commands,
 * tool calls, call budget, pending markdown appends, and isolated hook errors.
 *
 * @param {{ maxToolCallsPerTurn?: number }} [options={}]
 * @returns {{
 *   handledInPreTurn: Record<string, Array<{ subcommand: string, rawArgs: string, normalizedAction: string }>>,
 *   handledInToolCall: Record<string, Array<{ action: string, argsKey: string, args: any }>>,
 *   toolCallCount: number,
 *   maxToolCallsPerTurn: number,
 *   pendingAppendMarkdown: Array<{ scriptId: string, markdown: string }>,
 *   errors: Array<{ scriptId: string, hook: string, error: string }>,
 * }}
 */
export function createTurnLedger(options = {}) {
    const opts = isPlainObject(options) ? options : {};
    const rawMax = opts.maxToolCallsPerTurn;
    const parsedMax = rawMax === undefined || rawMax === null
        ? DEFAULT_MAX_TOOL_CALLS_PER_TURN
        : Number(rawMax);
    const maxToolCallsPerTurn = Number.isFinite(parsedMax) && parsedMax >= 0
        ? Math.floor(parsedMax)
        : DEFAULT_MAX_TOOL_CALLS_PER_TURN;

    return {
        handledInPreTurn: {},
        handledInToolCall: {},
        toolCallCount: 0,
        maxToolCallsPerTurn,
        pendingAppendMarkdown: [],
        errors: [],
    };
}

function deepFreeze(value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            deepFreeze(item);
        }
    } else {
        for (const key of Object.keys(value)) {
            deepFreeze(value[key]);
        }
    }
    return Object.freeze(value);
}

/**
 * Returns a clean read-only JSON summary of a turn ledger suitable for passing
 * to scripts as `ctx.turnLedger`.
 *
 * @param {object} ledger
 * @returns {object}
 */
export function serializeTurnLedger(ledger) {
    const src = isPlainObject(ledger) ? ledger : createTurnLedger();

    const handledInPreTurn = {};
    if (isPlainObject(src.handledInPreTurn)) {
        for (const [scriptId, entries] of Object.entries(src.handledInPreTurn)) {
            handledInPreTurn[scriptId] = Array.isArray(entries)
                ? entries.map((entry) => deepFreeze({
                    subcommand: String(entry?.subcommand ?? ''),
                    rawArgs: String(entry?.rawArgs ?? ''),
                    normalizedAction: String(entry?.normalizedAction ?? ''),
                }))
                : [];
            Object.freeze(handledInPreTurn[scriptId]);
        }
    }
    Object.freeze(handledInPreTurn);

    const handledInToolCall = {};
    if (isPlainObject(src.handledInToolCall)) {
        for (const [scriptId, entries] of Object.entries(src.handledInToolCall)) {
            handledInToolCall[scriptId] = Array.isArray(entries)
                ? entries.map((entry) => deepFreeze({
                    action: String(entry?.action ?? ''),
                    argsKey: String(entry?.argsKey ?? canonicalizeArgs(entry?.args)),
                    args: cloneJson(entry?.args ?? {}),
                }))
                : [];
            Object.freeze(handledInToolCall[scriptId]);
        }
    }
    Object.freeze(handledInToolCall);

    const pendingAppendMarkdown = Array.isArray(src.pendingAppendMarkdown)
        ? src.pendingAppendMarkdown.map((item) => deepFreeze(cloneJson(item)))
        : [];
    Object.freeze(pendingAppendMarkdown);

    const errors = Array.isArray(src.errors)
        ? src.errors.map((item) => deepFreeze(cloneJson(item)))
        : [];
    Object.freeze(errors);

    const toolCallCount = Number.isFinite(Number(src.toolCallCount)) && Number(src.toolCallCount) >= 0
        ? Math.floor(Number(src.toolCallCount))
        : 0;
    const maxToolCallsPerTurn = Number.isFinite(Number(src.maxToolCallsPerTurn)) && Number(src.maxToolCallsPerTurn) >= 0
        ? Math.floor(Number(src.maxToolCallsPerTurn))
        : DEFAULT_MAX_TOOL_CALLS_PER_TURN;

    return Object.freeze({
        handledInPreTurn,
        handledInToolCall,
        toolCallCount,
        maxToolCallsPerTurn,
        pendingAppendMarkdown,
        errors,
    });
}

/**
 * Ensures a script has an initialized state, returning `cloneJson(existingState)`
 * if present or invoking `initState(ctx)` otherwise.
 *
 * @param {object} script
 * @param {any} existingState
 * @param {object} [ctx={}]
 * @param {object} [runnerOpts={}]
 * @returns {Promise<{ ok: boolean, state: any, initialized: boolean, logs: string[], error: string|null }>}
 */
export async function ensureScriptState(script, existingState, ctx = {}, runnerOpts = {}) {
    if (existingState !== null && existingState !== undefined) {
        return {
            ok: true,
            state: cloneJson(existingState),
            initialized: false,
            logs: [],
            error: null,
        };
    }

    let res;
    try {
        res = await executeScriptHook(script, 'initState', { ctx: isPlainObject(ctx) ? ctx : {} }, runnerOpts);
    } catch (err) {
        return {
            ok: false,
            state: {},
            initialized: false,
            logs: [],
            error: err?.message || String(err),
        };
    }

    const logs = Array.isArray(res?.logs) ? res.logs : [];

    if (res?.missingHook) {
        return {
            ok: true,
            state: {},
            initialized: true,
            logs,
            error: null,
        };
    }

    if (!res?.ok) {
        return {
            ok: false,
            state: {},
            initialized: false,
            logs,
            error: res?.error || 'Script initState hook failed',
        };
    }

    const nextState = res.result ?? {};
    return {
        ok: true,
        state: cloneJson(nextState),
        initialized: true,
        logs,
        error: null,
    };
}

/**
 * Executes a script's `renderMemo(state, ctx)` hook and normalizes either a
 * string return value or `{ memoBlock: string }`.
 *
 * @param {object} script
 * @param {any} state
 * @param {object} [ctx={}]
 * @param {object} [runnerOpts={}]
 * @returns {Promise<{ ok: boolean, memoBlock: string|null, logs: string[], error: string|null }>}
 */
export async function renderScriptMemo(script, state, ctx = {}, runnerOpts = {}) {
    let res;
    try {
        res = await executeScriptHook(
            script,
            'renderMemo',
            { state, ctx: isPlainObject(ctx) ? ctx : {} },
            runnerOpts,
        );
    } catch (err) {
        return {
            ok: false,
            memoBlock: null,
            logs: [],
            error: err?.message || String(err),
        };
    }

    const logs = Array.isArray(res?.logs) ? res.logs : [];

    if (res?.missingHook) {
        return {
            ok: true,
            memoBlock: null,
            logs,
            error: null,
        };
    }

    if (!res?.ok) {
        return {
            ok: false,
            memoBlock: null,
            logs,
            error: res?.error || 'Script renderMemo hook failed',
        };
    }

    let text = null;
    if (typeof res.result === 'string') {
        text = res.result;
    } else if (isPlainObject(res.result) && typeof res.result.memoBlock === 'string') {
        text = res.result.memoBlock;
    }

    return {
        ok: true,
        memoBlock: typeof text === 'string' ? text.trim() : null,
        logs,
        error: null,
    };
}

/**
 * Runs enabled scripts sequentially before LLM generation.
 *
 * @param {Array<object>} scripts
 * @param {Record<string, any>} [statesById={}]
 * @param {object} [baseCtx={}]
 * @param {object} [ledger=createTurnLedger()]
 * @param {object} [runnerOpts={}]
 * @returns {Promise<{
 *   ledger: object,
 *   updatedStates: Record<string, any>,
 *   memoPatches: Record<string, string>,
 *   promptInjections: Array<{ scriptId: string, scriptName: string, text: string }>,
 *   portraitUrls: Record<string, string|null>,
 *   appendMarkdowns: Array<{ scriptId: string, markdown: string }>,
 *   stripCommand: boolean,
 *   strippedMessage: string,
 *   logsByScript: Record<string, string[]>,
 *   errors: Array<{ scriptId: string, hook: string, error: string }>,
 * }>}
 */
export async function runScriptsBeforeGenerate(
    scripts,
    statesById = {},
    baseCtx = {},
    ledger = createTurnLedger(),
    runnerOpts = {},
) {
    const activeLedger = ensureLedgerShape(ledger);
    const safeStatesById = isPlainObject(statesById) ? statesById : {};
    const safeBaseCtx = isPlainObject(baseCtx) ? baseCtx : {};
    const safeRunnerOpts = isPlainObject(runnerOpts) ? runnerOpts : {};

    const orderedScripts = getEnabledOrderedScripts(scripts);
    const workingStates = seedWorkingStates(safeStatesById);

    const updatedStates = {};
    const memoPatches = {};
    const promptInjections = [];
    const portraitUrls = {};
    const appendMarkdowns = [];
    const logsByScript = {};
    const errors = [];

    let currentUserMessage = typeof safeBaseCtx.userMessage === 'string'
        ? safeBaseCtx.userMessage
        : String(safeBaseCtx.userMessage ?? '');
    let stripCommand = false;

    for (const script of orderedScripts) {
        const scriptId = String(script.id ?? '').trim();
        const scriptName = String(script.name || scriptId);
        const trackerTag = sanitizeTrackerTag(script.trackerTag);
        const scriptLogs = [];

        const command = parseUserCommand(currentUserMessage, script.commandPrefix);
        const otherScripts = buildOtherScriptsSnapshot(workingStates, scriptId);

        const ctx = {
            ...safeBaseCtx,
            userMessage: currentUserMessage,
            command,
            otherScripts,
            turnLedger: serializeTurnLedger(activeLedger),
        };

        const initRes = await ensureScriptState(script, safeStatesById[scriptId], ctx, safeRunnerOpts);
        if (initRes.logs.length > 0) {
            scriptLogs.push(...initRes.logs);
        }

        if (!initRes.ok) {
            const errEntry = {
                scriptId,
                hook: 'initState',
                error: initRes.error || 'Failed to initialize script state',
            };
            errors.push(errEntry);
            activeLedger.errors.push({ ...errEntry });
            if (safeStatesById[scriptId] !== undefined && safeStatesById[scriptId] !== null) {
                const preserved = cloneJson(safeStatesById[scriptId]);
                updatedStates[scriptId] = preserved;
                workingStates[scriptId] = cloneJson(preserved);
            }
            logsByScript[scriptId] = scriptLogs;
            continue;
        }

        const state = initRes.state;
        let hookRes;
        try {
            hookRes = await executeScriptHook(script, 'onBeforeGenerate', { state, ctx }, safeRunnerOpts);
        } catch (err) {
            hookRes = {
                ok: false,
                result: null,
                logs: [],
                error: err?.message || String(err),
            };
        }

        if (Array.isArray(hookRes?.logs) && hookRes.logs.length > 0) {
            scriptLogs.push(...hookRes.logs);
        }

        if (!hookRes?.ok) {
            const errEntry = {
                scriptId,
                hook: 'onBeforeGenerate',
                error: hookRes?.error || 'Script onBeforeGenerate hook failed',
            };
            errors.push(errEntry);
            activeLedger.errors.push({ ...errEntry });
            const preserved = cloneJson(state);
            updatedStates[scriptId] = preserved;
            workingStates[scriptId] = cloneJson(preserved);
            logsByScript[scriptId] = scriptLogs;
            continue;
        }

        const norm = hookRes.missingHook
            ? normalizeScriptResult(undefined)
            : normalizeScriptResult(hookRes.result);

        if (norm.logs.length > 0) {
            scriptLogs.push(...norm.logs);
        }

        const nextState = norm.hasState ? cloneJson(norm.state) : cloneJson(state);
        updatedStates[scriptId] = nextState;
        workingStates[scriptId] = cloneJson(nextState);

        if (command) {
            if (!Array.isArray(activeLedger.handledInPreTurn[scriptId])) {
                activeLedger.handledInPreTurn[scriptId] = [];
            }
            activeLedger.handledInPreTurn[scriptId].push({
                subcommand: command.subcommand,
                rawArgs: command.rawArgs,
                normalizedAction: normalizeActionName(command.subcommand),
            });
        }

        if (command && (norm.stripCommand || script.stripCommandFromPrompt)) {
            stripCommand = true;
            currentUserMessage = command.strippedMessage;
        }

        let memoBlock = null;
        if (norm.hasMemoBlock) {
            memoBlock = norm.memoBlock;
        } else if (trackerTag) {
            const renderCtx = {
                ...ctx,
                turnLedger: serializeTurnLedger(activeLedger),
            };
            const memoRes = await renderScriptMemo(script, nextState, renderCtx, safeRunnerOpts);
            if (memoRes.logs.length > 0) {
                scriptLogs.push(...memoRes.logs);
            }
            if (!memoRes.ok) {
                const errEntry = {
                    scriptId,
                    hook: 'renderMemo',
                    error: memoRes.error || 'Script renderMemo hook failed',
                };
                errors.push(errEntry);
                activeLedger.errors.push({ ...errEntry });
            } else {
                memoBlock = memoRes.memoBlock;
            }
        }

        if (memoBlock != null && trackerTag) {
            memoPatches[trackerTag] = memoBlock;
        }

        if (norm.promptInjection && norm.promptInjection.trim()) {
            promptInjections.push({
                scriptId,
                scriptName,
                text: norm.promptInjection.trim(),
            });
        }

        if (norm.hasPortraitUrl) {
            portraitUrls[scriptId] = norm.portraitUrl;
        }

        if (norm.appendMarkdown && norm.appendMarkdown.trim()) {
            const appendEntry = {
                scriptId,
                markdown: norm.appendMarkdown,
            };
            appendMarkdowns.push(appendEntry);
            activeLedger.pendingAppendMarkdown.push({ ...appendEntry });
        }

        logsByScript[scriptId] = scriptLogs;
    }

    return {
        ledger: activeLedger,
        updatedStates,
        memoPatches,
        promptInjections,
        portraitUrls,
        appendMarkdowns,
        stripCommand,
        strippedMessage: currentUserMessage,
        logsByScript,
        errors,
    };
}

/**
 * Executes a single mid-turn script tool call with per-turn budget enforcement,
 * pre-turn command deduplication, and identical mid-turn call deduplication.
 *
 * @param {object} script
 * @param {any} currentState
 * @param {string} action
 * @param {object} [args={}]
 * @param {object} [baseCtx={}]
 * @param {object} [ledger=createTurnLedger()]
 * @param {object} [runnerOpts={}]
 * @returns {Promise<{
 *   ok: boolean,
 *   deduped: boolean,
 *   reason?: string|null,
 *   state: any,
 *   memoBlock: string|null,
 *   portraitUrl: string|null|undefined,
 *   hasPortraitUrl: boolean,
 *   appendMarkdown: string,
 *   promptInjection: string,
 *   toolResult: any,
 *   logs: string[],
 *   error: string|null,
 * }>}
 */
export async function runScriptToolAction(
    script,
    currentState,
    action,
    args = {},
    baseCtx = {},
    ledger = createTurnLedger(),
    runnerOpts = {},
) {
    const activeLedger = ensureLedgerShape(ledger);
    const safeBaseCtx = isPlainObject(baseCtx) ? baseCtx : {};
    const safeRunnerOpts = isPlainObject(runnerOpts) ? runnerOpts : {};
    const safeArgs = args === undefined || args === null ? {} : cloneJson(args);

    if (!isPlainObject(script)) {
        return {
            ok: false,
            deduped: false,
            reason: null,
            state: currentState !== undefined ? cloneJson(currentState) : {},
            memoBlock: null,
            portraitUrl: undefined,
            hasPortraitUrl: false,
            appendMarkdown: '',
            promptInjection: '',
            toolResult: null,
            logs: [],
            error: 'Invalid script definition',
        };
    }

    const scriptId = String(script.id ?? '').trim();
    const actionStr = String(action ?? '').trim();

    if (activeLedger.toolCallCount >= activeLedger.maxToolCallsPerTurn) {
        return {
            ok: true,
            deduped: true,
            reason: 'max_calls_reached',
            state: cloneJson(currentState),
            memoBlock: null,
            portraitUrl: undefined,
            hasPortraitUrl: false,
            appendMarkdown: '',
            promptInjection: '',
            toolResult: {
                status: 'skipped',
                reason: 'Per-turn script tool call limit reached.',
            },
            logs: [],
            error: null,
        };
    }

    const normalizedAction = normalizeActionName(actionStr);
    const preTurnEntries = Array.isArray(activeLedger.handledInPreTurn[scriptId])
        ? activeLedger.handledInPreTurn[scriptId]
        : [];

    if (normalizedAction && preTurnEntries.length > 0) {
        const preTurnMatch = preTurnEntries.some((entry) => {
            const entryAction = entry?.normalizedAction || normalizeActionName(entry?.subcommand);
            if (!entryAction || entryAction !== normalizedAction) {
                return false;
            }
            return doPreTurnArgsMatchOrEmpty(entry?.rawArgs, safeArgs);
        });

        if (preTurnMatch) {
            return {
                ok: true,
                deduped: true,
                reason: 'already_handled_pre_turn',
                state: cloneJson(currentState),
                memoBlock: null,
                portraitUrl: undefined,
                hasPortraitUrl: false,
                appendMarkdown: '',
                promptInjection: '',
                toolResult: {
                    status: 'already_handled',
                    message: 'This action was already executed by the user command before generation. Narrate the pre-turn result without re-running it.',
                },
                logs: [],
                error: null,
            };
        }
    }

    const argsKey = canonicalizeArgs(safeArgs);
    const priorToolCalls = Array.isArray(activeLedger.handledInToolCall[scriptId])
        ? activeLedger.handledInToolCall[scriptId]
        : [];

    const midTurnDuplicate = priorToolCalls.some(
        (entry) => String(entry?.action ?? '') === actionStr && entry?.argsKey === argsKey,
    );
    if (midTurnDuplicate) {
        return {
            ok: true,
            deduped: true,
            reason: 'duplicate_tool_call',
            state: cloneJson(currentState),
            memoBlock: null,
            portraitUrl: undefined,
            hasPortraitUrl: false,
            appendMarkdown: '',
            promptInjection: '',
            toolResult: {
                status: 'already_handled',
                message: 'Identical tool action with the same arguments was already executed this turn. Narrate the existing result without re-running it.',
            },
            logs: [],
            error: null,
        };
    }

    const logs = [];
    const ctx = {
        ...safeBaseCtx,
        turnLedger: serializeTurnLedger(activeLedger),
    };

    const initRes = await ensureScriptState(script, currentState, ctx, safeRunnerOpts);
    if (initRes.logs.length > 0) {
        logs.push(...initRes.logs);
    }

    if (!initRes.ok) {
        const errMsg = initRes.error || 'Failed to initialize script state';
        activeLedger.errors.push({ scriptId, hook: 'initState', error: errMsg });
        return {
            ok: false,
            deduped: false,
            reason: null,
            state: currentState !== undefined && currentState !== null ? cloneJson(currentState) : {},
            memoBlock: null,
            portraitUrl: undefined,
            hasPortraitUrl: false,
            appendMarkdown: '',
            promptInjection: '',
            toolResult: null,
            logs,
            error: errMsg,
        };
    }

    const state = initRes.state;
    let hookRes;
    try {
        hookRes = await executeScriptHook(
            script,
            'onToolCall',
            {
                state,
                call: { action: actionStr, args: safeArgs },
                ctx,
            },
            safeRunnerOpts,
        );
    } catch (err) {
        hookRes = {
            ok: false,
            result: null,
            logs: [],
            error: err?.message || String(err),
        };
    }

    if (Array.isArray(hookRes?.logs) && hookRes.logs.length > 0) {
        logs.push(...hookRes.logs);
    }

    if (hookRes?.missingHook) {
        const missingMsg = 'Script does not define an onToolCall hook';
        activeLedger.errors.push({ scriptId, hook: 'onToolCall', error: missingMsg });
        return {
            ok: false,
            deduped: false,
            reason: null,
            state: cloneJson(state),
            memoBlock: null,
            portraitUrl: undefined,
            hasPortraitUrl: false,
            appendMarkdown: '',
            promptInjection: '',
            toolResult: { ok: false, error: missingMsg },
            logs,
            error: missingMsg,
        };
    }

    if (!hookRes?.ok) {
        const errMsg = hookRes?.error || 'Script onToolCall hook failed';
        activeLedger.errors.push({ scriptId, hook: 'onToolCall', error: errMsg });
        return {
            ok: false,
            deduped: false,
            reason: null,
            state: cloneJson(state),
            memoBlock: null,
            portraitUrl: undefined,
            hasPortraitUrl: false,
            appendMarkdown: '',
            promptInjection: '',
            toolResult: null,
            logs,
            error: errMsg,
        };
    }

    const norm = normalizeScriptResult(hookRes.result);
    if (norm.logs.length > 0) {
        logs.push(...norm.logs);
    }

    const nextState = norm.hasState ? cloneJson(norm.state) : cloneJson(state);

    activeLedger.toolCallCount += 1;
    if (!Array.isArray(activeLedger.handledInToolCall[scriptId])) {
        activeLedger.handledInToolCall[scriptId] = [];
    }
    activeLedger.handledInToolCall[scriptId].push({
        action: actionStr,
        argsKey,
        args: cloneJson(safeArgs),
    });

    const trackerTag = sanitizeTrackerTag(script.trackerTag);
    let memoBlock = null;
    if (norm.hasMemoBlock) {
        memoBlock = norm.memoBlock;
    } else if (trackerTag) {
        const renderCtx = {
            ...safeBaseCtx,
            turnLedger: serializeTurnLedger(activeLedger),
        };
        const memoRes = await renderScriptMemo(script, nextState, renderCtx, safeRunnerOpts);
        if (memoRes.logs.length > 0) {
            logs.push(...memoRes.logs);
        }
        if (!memoRes.ok) {
            activeLedger.errors.push({
                scriptId,
                hook: 'renderMemo',
                error: memoRes.error || 'Script renderMemo hook failed',
            });
        } else {
            memoBlock = memoRes.memoBlock;
        }
    }

    if (norm.appendMarkdown && norm.appendMarkdown.trim()) {
        activeLedger.pendingAppendMarkdown.push({
            scriptId,
            markdown: norm.appendMarkdown,
        });
    }

    return {
        ok: true,
        deduped: false,
        reason: null,
        state: nextState,
        memoBlock,
        portraitUrl: norm.hasPortraitUrl ? norm.portraitUrl : undefined,
        hasPortraitUrl: norm.hasPortraitUrl,
        appendMarkdown: norm.appendMarkdown,
        promptInjection: norm.promptInjection,
        toolResult: norm.hasToolResult ? norm.toolResult : { ok: true, state: nextState },
        logs,
        error: null,
    };
}

/**
 * Runs `onAfterGenerate(state, ctx)` sequentially for each enabled script.
 *
 * @param {Array<object>} scripts
 * @param {Record<string, any>} [statesById={}]
 * @param {object} [baseCtx={}]
 * @param {object} [ledger=createTurnLedger()]
 * @param {object} [runnerOpts={}]
 * @returns {Promise<{
 *   updatedStates: Record<string, any>,
 *   memoPatches: Record<string, string>,
 *   portraitUrls: Record<string, string|null>,
 *   appendMarkdowns: Array<{ scriptId: string, markdown: string }>,
 *   logsByScript: Record<string, string[]>,
 *   errors: Array<{ scriptId: string, hook: string, error: string }>,
 * }>}
 */
export async function runScriptsAfterGenerate(
    scripts,
    statesById = {},
    baseCtx = {},
    ledger = createTurnLedger(),
    runnerOpts = {},
) {
    const activeLedger = ensureLedgerShape(ledger);
    const safeStatesById = isPlainObject(statesById) ? statesById : {};
    const safeBaseCtx = isPlainObject(baseCtx) ? baseCtx : {};
    const safeRunnerOpts = isPlainObject(runnerOpts) ? runnerOpts : {};

    const orderedScripts = getEnabledOrderedScripts(scripts);
    const workingStates = seedWorkingStates(safeStatesById);

    const updatedStates = {};
    const memoPatches = {};
    const portraitUrls = {};
    const appendMarkdowns = [];
    const logsByScript = {};
    const errors = [];

    const assistantMessage = typeof safeBaseCtx.assistantMessage === 'string'
        ? safeBaseCtx.assistantMessage
        : String(safeBaseCtx.assistantMessage ?? '');

    for (const script of orderedScripts) {
        const scriptId = String(script.id ?? '').trim();
        const trackerTag = sanitizeTrackerTag(script.trackerTag);
        const scriptLogs = [];

        const otherScripts = buildOtherScriptsSnapshot(workingStates, scriptId);
        const ctx = {
            ...safeBaseCtx,
            assistantMessage,
            otherScripts,
            turnLedger: serializeTurnLedger(activeLedger),
        };

        const initRes = await ensureScriptState(script, safeStatesById[scriptId], ctx, safeRunnerOpts);
        if (initRes.logs.length > 0) {
            scriptLogs.push(...initRes.logs);
        }

        if (!initRes.ok) {
            const errEntry = {
                scriptId,
                hook: 'initState',
                error: initRes.error || 'Failed to initialize script state',
            };
            errors.push(errEntry);
            activeLedger.errors.push({ ...errEntry });
            if (safeStatesById[scriptId] !== undefined && safeStatesById[scriptId] !== null) {
                const preserved = cloneJson(safeStatesById[scriptId]);
                updatedStates[scriptId] = preserved;
                workingStates[scriptId] = cloneJson(preserved);
            }
            logsByScript[scriptId] = scriptLogs;
            continue;
        }

        const state = initRes.state;
        let hookRes;
        try {
            hookRes = await executeScriptHook(script, 'onAfterGenerate', { state, ctx }, safeRunnerOpts);
        } catch (err) {
            hookRes = {
                ok: false,
                result: null,
                logs: [],
                error: err?.message || String(err),
            };
        }

        if (Array.isArray(hookRes?.logs) && hookRes.logs.length > 0) {
            scriptLogs.push(...hookRes.logs);
        }

        if (!hookRes?.ok) {
            const errEntry = {
                scriptId,
                hook: 'onAfterGenerate',
                error: hookRes?.error || 'Script onAfterGenerate hook failed',
            };
            errors.push(errEntry);
            activeLedger.errors.push({ ...errEntry });
            const preserved = cloneJson(state);
            updatedStates[scriptId] = preserved;
            workingStates[scriptId] = cloneJson(preserved);
            logsByScript[scriptId] = scriptLogs;
            continue;
        }

        const norm = hookRes.missingHook
            ? normalizeScriptResult(undefined)
            : normalizeScriptResult(hookRes.result);

        if (norm.logs.length > 0) {
            scriptLogs.push(...norm.logs);
        }

        const nextState = norm.hasState ? cloneJson(norm.state) : cloneJson(state);
        updatedStates[scriptId] = nextState;
        workingStates[scriptId] = cloneJson(nextState);

        let memoBlock = null;
        if (norm.hasMemoBlock) {
            memoBlock = norm.memoBlock;
        } else if (trackerTag) {
            const memoRes = await renderScriptMemo(script, nextState, ctx, safeRunnerOpts);
            if (memoRes.logs.length > 0) {
                scriptLogs.push(...memoRes.logs);
            }
            if (!memoRes.ok) {
                const errEntry = {
                    scriptId,
                    hook: 'renderMemo',
                    error: memoRes.error || 'Script renderMemo hook failed',
                };
                errors.push(errEntry);
                activeLedger.errors.push({ ...errEntry });
            } else {
                memoBlock = memoRes.memoBlock;
            }
        }

        if (memoBlock != null && trackerTag) {
            memoPatches[trackerTag] = memoBlock;
        }

        if (norm.hasPortraitUrl) {
            portraitUrls[scriptId] = norm.portraitUrl;
        }

        if (norm.appendMarkdown && norm.appendMarkdown.trim()) {
            const appendEntry = {
                scriptId,
                markdown: norm.appendMarkdown,
            };
            appendMarkdowns.push(appendEntry);
            activeLedger.pendingAppendMarkdown.push({ ...appendEntry });
        }

        logsByScript[scriptId] = scriptLogs;
    }

    return {
        updatedStates,
        memoPatches,
        portraitUrls,
        appendMarkdowns,
        logsByScript,
        errors,
    };
}

/**
 * Single-script simulator for the Script Studio Live Test Sandbox.
 *
 * @param {object} script
 * @param {any} currentState
 * @param {{
 *   type?: 'init'|'beforeGenerate'|'toolCall'|'afterGenerate',
 *   userMessage?: string,
 *   assistantMessage?: string,
 *   action?: string,
 *   args?: object,
 *   time?: { current?: any, prior?: any, deltaMinutes?: number, dayChanged?: boolean },
 *   memoBlocks?: Record<string, string>,
 *   character?: any,
 *   user?: any,
 *   otherScripts?: Record<string, any>,
 *   ledger?: object,
 *   ctx?: object,
 * }} [simEvent={}]
 * @param {object} [runnerOpts={}]
 * @returns {Promise<{
 *   ok: boolean,
 *   state: any,
 *   memoBlock: string|null,
 *   promptInjection: string,
 *   toolResult: any,
 *   portraitUrl: string|null|undefined,
 *   appendMarkdown: string,
 *   stripCommand: boolean,
 *   strippedMessage: string,
 *   logs: string[],
 *   error: string|null,
 *   durationMs: number,
 * }>}
 */
export async function runSandboxSimulation(script, currentState, simEvent = {}, runnerOpts = {}) {
    const startTime = Date.now();
    const ev = isPlainObject(simEvent) ? simEvent : {};
    const safeRunnerOpts = isPlainObject(runnerOpts) ? runnerOpts : {};
    const eventType = ev.type !== undefined ? String(ev.type).trim() : 'beforeGenerate';

    const rawCtx = isPlainObject(ev.ctx) ? ev.ctx : {};
    const rawTime = isPlainObject(ev.time)
        ? ev.time
        : (isPlainObject(rawCtx.time) ? rawCtx.time : {});

    const deltaMinutes = Number.isFinite(Number(rawTime.deltaMinutes))
        ? Number(rawTime.deltaMinutes)
        : 0;
    const time = {
        ...cloneJson(rawTime),
        current: rawTime.current ?? null,
        prior: rawTime.prior ?? null,
        deltaMinutes,
        dayChanged: Boolean(rawTime.dayChanged),
    };

    const userMessage = typeof ev.userMessage === 'string'
        ? ev.userMessage
        : (typeof rawCtx.userMessage === 'string'
            ? rawCtx.userMessage
            : String(ev.userMessage ?? rawCtx.userMessage ?? ''));

    const assistantMessage = typeof ev.assistantMessage === 'string'
        ? ev.assistantMessage
        : (typeof rawCtx.assistantMessage === 'string'
            ? rawCtx.assistantMessage
            : String(ev.assistantMessage ?? rawCtx.assistantMessage ?? ''));

    const memoBlocks = isPlainObject(ev.memoBlocks)
        ? cloneJson(ev.memoBlocks)
        : (isPlainObject(rawCtx.memoBlocks) ? cloneJson(rawCtx.memoBlocks) : {});

    const character = ev.character !== undefined
        ? cloneJson(ev.character)
        : (rawCtx.character !== undefined ? cloneJson(rawCtx.character) : {});

    const user = ev.user !== undefined
        ? cloneJson(ev.user)
        : (rawCtx.user !== undefined ? cloneJson(rawCtx.user) : {});

    const baseCtx = {
        ...cloneJson(rawCtx),
        userMessage,
        assistantMessage,
        time,
        memoBlocks,
        character,
        user,
    };

    if (!isPlainObject(script)) {
        return {
            ok: false,
            state: currentState !== undefined ? cloneJson(currentState) : {},
            memoBlock: null,
            promptInjection: '',
            toolResult: undefined,
            portraitUrl: undefined,
            appendMarkdown: '',
            stripCommand: false,
            strippedMessage: userMessage,
            logs: [],
            error: 'Invalid script definition',
            durationMs: Math.max(0, Date.now() - startTime),
        };
    }

    const simId = String(script.id ?? '').trim() || 'sandbox_script';
    const simScript = {
        ...script,
        id: simId,
        enabled: true,
    };
    const trackerTag = sanitizeTrackerTag(simScript.trackerTag);
    const activeLedger = isPlainObject(ev.ledger) ? ensureLedgerShape(ev.ledger) : createTurnLedger();
    const otherScripts = isPlainObject(ev.otherScripts) ? cloneJson(ev.otherScripts) : {};

    if (eventType === 'init') {
        const initCtx = {
            ...baseCtx,
            otherScripts,
            turnLedger: serializeTurnLedger(activeLedger),
        };
        const initRes = await ensureScriptState(simScript, null, initCtx, safeRunnerOpts);
        const logs = [...initRes.logs];

        if (!initRes.ok) {
            return {
                ok: false,
                state: currentState !== undefined && currentState !== null ? cloneJson(currentState) : {},
                memoBlock: null,
                promptInjection: '',
                toolResult: undefined,
                portraitUrl: undefined,
                appendMarkdown: '',
                stripCommand: false,
                strippedMessage: userMessage,
                logs,
                error: initRes.error,
                durationMs: Math.max(0, Date.now() - startTime),
            };
        }

        let memoBlock = null;
        if (trackerTag) {
            const memoRes = await renderScriptMemo(simScript, initRes.state, initCtx, safeRunnerOpts);
            if (memoRes.logs.length > 0) {
                logs.push(...memoRes.logs);
            }
            if (!memoRes.ok) {
                return {
                    ok: false,
                    state: initRes.state,
                    memoBlock: null,
                    promptInjection: '',
                    toolResult: undefined,
                    portraitUrl: undefined,
                    appendMarkdown: '',
                    stripCommand: false,
                    strippedMessage: userMessage,
                    logs,
                    error: memoRes.error,
                    durationMs: Math.max(0, Date.now() - startTime),
                };
            }
            memoBlock = memoRes.memoBlock;
        }

        return {
            ok: true,
            state: initRes.state,
            memoBlock,
            promptInjection: '',
            toolResult: undefined,
            portraitUrl: undefined,
            appendMarkdown: '',
            stripCommand: false,
            strippedMessage: userMessage,
            logs,
            error: null,
            durationMs: Math.max(0, Date.now() - startTime),
        };
    }

    if (eventType === 'beforeGenerate') {
        const statesById = { ...otherScripts };
        if (currentState !== undefined && currentState !== null) {
            statesById[simId] = currentState;
        } else {
            delete statesById[simId];
        }

        const res = await runScriptsBeforeGenerate(
            [simScript],
            statesById,
            baseCtx,
            activeLedger,
            safeRunnerOpts,
        );

        const hasState = Object.prototype.hasOwnProperty.call(res.updatedStates, simId);
        const state = hasState
            ? res.updatedStates[simId]
            : (currentState !== undefined && currentState !== null ? cloneJson(currentState) : {});
        const memoBlock = trackerTag && Object.prototype.hasOwnProperty.call(res.memoPatches, trackerTag)
            ? res.memoPatches[trackerTag]
            : null;
        const portraitUrl = Object.prototype.hasOwnProperty.call(res.portraitUrls, simId)
            ? res.portraitUrls[simId]
            : undefined;

        return {
            ok: res.errors.length === 0,
            state,
            memoBlock,
            promptInjection: res.promptInjections[0]?.text ?? '',
            toolResult: undefined,
            portraitUrl,
            appendMarkdown: res.appendMarkdowns[0]?.markdown ?? '',
            stripCommand: res.stripCommand,
            strippedMessage: res.strippedMessage,
            logs: res.logsByScript[simId] ?? [],
            error: res.errors[0]?.error ?? null,
            durationMs: Math.max(0, Date.now() - startTime),
        };
    }

    if (eventType === 'toolCall') {
        const action = ev.action ?? '';
        const args = ev.args ?? {};
        const toolCtx = {
            ...baseCtx,
            otherScripts,
        };
        const res = await runScriptToolAction(
            simScript,
            currentState,
            action,
            args,
            toolCtx,
            activeLedger,
            safeRunnerOpts,
        );

        return {
            ok: res.ok,
            state: res.state,
            memoBlock: res.memoBlock ?? null,
            promptInjection: res.promptInjection ?? '',
            toolResult: res.toolResult,
            portraitUrl: res.hasPortraitUrl ? res.portraitUrl : undefined,
            appendMarkdown: res.appendMarkdown ?? '',
            stripCommand: false,
            strippedMessage: userMessage,
            logs: res.logs ?? [],
            error: res.error ?? null,
            durationMs: Math.max(0, Date.now() - startTime),
        };
    }

    if (eventType === 'afterGenerate') {
        const statesById = { ...otherScripts };
        if (currentState !== undefined && currentState !== null) {
            statesById[simId] = currentState;
        } else {
            delete statesById[simId];
        }

        const res = await runScriptsAfterGenerate(
            [simScript],
            statesById,
            baseCtx,
            activeLedger,
            safeRunnerOpts,
        );

        const hasState = Object.prototype.hasOwnProperty.call(res.updatedStates, simId);
        const state = hasState
            ? res.updatedStates[simId]
            : (currentState !== undefined && currentState !== null ? cloneJson(currentState) : {});
        const memoBlock = trackerTag && Object.prototype.hasOwnProperty.call(res.memoPatches, trackerTag)
            ? res.memoPatches[trackerTag]
            : null;
        const portraitUrl = Object.prototype.hasOwnProperty.call(res.portraitUrls, simId)
            ? res.portraitUrls[simId]
            : undefined;

        return {
            ok: res.errors.length === 0,
            state,
            memoBlock,
            promptInjection: '',
            toolResult: undefined,
            portraitUrl,
            appendMarkdown: res.appendMarkdowns[0]?.markdown ?? '',
            stripCommand: false,
            strippedMessage: userMessage,
            logs: res.logsByScript[simId] ?? [],
            error: res.errors[0]?.error ?? null,
            durationMs: Math.max(0, Date.now() - startTime),
        };
    }

    return {
        ok: false,
        state: currentState !== undefined && currentState !== null ? cloneJson(currentState) : {},
        memoBlock: null,
        promptInjection: '',
        toolResult: undefined,
        portraitUrl: undefined,
        appendMarkdown: '',
        stripCommand: false,
        strippedMessage: userMessage,
        logs: [],
        error: `Unsupported simulation event type "${eventType}". Expected one of: init, beforeGenerate, toolCall, afterGenerate.`,
        durationMs: Math.max(0, Date.now() - startTime),
    };
}
