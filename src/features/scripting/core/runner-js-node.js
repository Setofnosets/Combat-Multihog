/**
 * runner-js-node.js — Node `vm` sandbox for Combat-Multihog Game Scripts.
 *
 * Pure ESM, zero SillyTavern/DOM/Multihog imports.
 * Uses dynamic `await import('node:vm')` at execution time so browsers never fail
 * to parse or load this module if imported statically.
 */

const DEFAULT_TIMEOUT_MS = 1500;
const MAX_LOGS = 100;

const RESERVED_IDENTIFIERS = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
    'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
    'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while',
    'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
    'private', 'protected', 'public', 'await', 'async',
]);

/**
 * Checks whether the Node `vm` runner can be used in the current runtime.
 * @returns {boolean}
 */
export function isNodeVmRunnerAvailable() {
    return Boolean(typeof process !== 'undefined' && process?.versions?.node);
}

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function isSafeHookIdentifier(name) {
    return (
        typeof name === 'string' &&
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) &&
        !RESERVED_IDENTIFIERS.has(name)
    );
}

function isTimeoutError(err) {
    if (!err || typeof err !== 'object') return false;
    if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return true;
    const msg = typeof err.message === 'string' ? err.message : '';
    return msg.includes('Script execution timed out');
}

/**
 * Creates a Node `vm` JS runner.
 * @returns {{ runJsHook: (opts: { code: string, hookName: string, payload?: any, timeoutMs?: number }) => Promise<{ ok: boolean, result: any, missingHook?: boolean, logs: string[], error: string|null, durationMs: number, timedOut: boolean }> }}
 */
export function createJsNodeRunner() {
    async function runJsHook({ code, hookName, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        const startTime = Date.now();
        const effectiveTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
            ? Math.floor(Number(timeoutMs))
            : DEFAULT_TIMEOUT_MS;

        if (!isNodeVmRunnerAvailable()) {
            return {
                ok: false,
                result: null,
                logs: [],
                error: 'Node vm runner is unavailable in this environment',
                durationMs: 0,
                timedOut: false,
            };
        }

        if (typeof code !== 'string') {
            return {
                ok: false,
                result: null,
                logs: [],
                error: 'Script code must be a string',
                durationMs: 0,
                timedOut: false,
            };
        }

        const requestedHook = String(hookName || '');
        const logs = [];

        let payloadJson;
        try {
            payloadJson = JSON.stringify(payload ?? {});
        } catch (err) {
            return {
                ok: false,
                result: null,
                logs,
                error: `Payload is not JSON-serializable: ${err?.message || String(err)}`,
                durationMs: Math.max(0, Date.now() - startTime),
                timedOut: false,
            };
        }

        let vm;
        try {
            vm = await import('node:vm');
        } catch (err) {
            return {
                ok: false,
                result: null,
                logs,
                error: `Failed to load node:vm: ${err?.message || String(err)}`,
                durationMs: Math.max(0, Date.now() - startTime),
                timedOut: false,
            };
        }

        // Null-prototype sandbox with dangerous host globals explicitly blocked.
        // Standard JS builtins (Math, JSON, Date, RegExp, Array, Object, Number,
        // String, Boolean, Map, Set, Error, TypeError, RangeError, parseInt,
        // parseFloat, isNaN, isFinite, Promise) come natively from the isolated V8
        // context realm; coupled with codeGeneration: { strings: false }, no host
        // constructor or Function() escape path exists.
        const sandbox = Object.create(null);
        Object.assign(sandbox, {
            fetch: undefined,
            XMLHttpRequest: undefined,
            WebSocket: undefined,
            importScripts: undefined,
            process: undefined,
            require: undefined,
            globalThis: undefined,
            Buffer: undefined,
            __hostLogs: logs,
            __hostPayloadJson: payloadJson,
            __hostMissingHook: false,
        });

        const context = vm.createContext(sandbox, {
            name: 'CombatMultihogScriptSandbox',
            codeGeneration: {
                strings: false,
                wasm: false,
            },
        });

        const escapedHookName = JSON.stringify(requestedHook);
        const dynamicNamedLookup = isSafeHookIdentifier(requestedHook)
            ? `(typeof ${requestedHook} === "function" ? ${requestedHook} : undefined)`
            : 'undefined';

        const compiledSource = `
(function(__global) {
    "use strict";

    const __logs = __global.__hostLogs;
    const __payloadJson = __global.__hostPayloadJson;
    delete __global.__hostLogs;
    delete __global.__hostPayloadJson;

    const __safeFormatArg = function(value) {
        if (typeof value === "string") return value;
        if (value === undefined) return "undefined";
        if (value === null) return "null";
        if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
            return String(value);
        }
        if (value instanceof Error) {
            return value.stack || (value.name + ": " + value.message);
        }
        try {
            return JSON.stringify(value);
        } catch (_) {
            try {
                return String(value);
            } catch (__) {
                return "[unserializable]";
            }
        }
    };

    const __appendLog = function(level, args) {
        if (__logs.length >= ${MAX_LOGS}) return;
        const formatted = Array.prototype.map.call(args, __safeFormatArg).join(" ");
        __logs.push(level ? "[" + level + "] " + formatted : formatted);
    };

    // Realm-native console functions prevent leaking host Function constructor.
    const __sandboxConsole = Object.freeze({
        log: function() { __appendLog("", arguments); },
        info: function() { __appendLog("info", arguments); },
        warn: function() { __appendLog("warn", arguments); },
        error: function() { __appendLog("error", arguments); },
    });

    const __invokeHook = function(fn, hookName, payload) {
        const safePayload = payload && typeof payload === "object" ? payload : {};
        switch (hookName) {
            case "initState":
                return fn(safePayload.ctx);
            case "onBeforeGenerate":
                return fn(safePayload.state, safePayload.ctx);
            case "onToolCall":
                return fn(safePayload.state, safePayload.call, safePayload.ctx);
            case "onAfterGenerate":
                return fn(safePayload.state, safePayload.ctx);
            case "renderMemo":
                return fn(safePayload.state, safePayload.ctx);
            default:
                return fn(safePayload.state, safePayload.ctx);
        }
    };

    const module = { exports: {} };
    let exports = module.exports;

    const __returned = (function(
        module,
        exports,
        console,
        fetch,
        XMLHttpRequest,
        WebSocket,
        importScripts,
        process,
        require,
        globalThis,
        Buffer
    ) {
        ${code}
        ;
        const __namedHooks = {
            initState: typeof initState === "function" ? initState : undefined,
            onBeforeGenerate: typeof onBeforeGenerate === "function" ? onBeforeGenerate : undefined,
            onToolCall: typeof onToolCall === "function" ? onToolCall : undefined,
            onAfterGenerate: typeof onAfterGenerate === "function" ? onAfterGenerate : undefined,
            renderMemo: typeof renderMemo === "function" ? renderMemo : undefined,
        };
        const __dynamicNamed = ${dynamicNamedLookup};
        return { __namedHooks: __namedHooks, __dynamicNamed: __dynamicNamed };
    })(
        module,
        exports,
        __sandboxConsole,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
    );

    const __hookName = ${escapedHookName};
    let __hookFn = null;

    if (__returned && typeof __returned === "object" && __returned.__namedHooks) {
        if (typeof __returned.__namedHooks[__hookName] === "function") {
            __hookFn = __returned.__namedHooks[__hookName];
        } else if (typeof __returned.__dynamicNamed === "function") {
            __hookFn = __returned.__dynamicNamed;
        } else if (module.exports && typeof module.exports[__hookName] === "function") {
            __hookFn = module.exports[__hookName];
        } else if (exports && typeof exports[__hookName] === "function") {
            __hookFn = exports[__hookName];
        } else if (typeof module.exports === "function" && __hookName === "default") {
            __hookFn = module.exports;
        }
    } else if (__returned && typeof __returned === "object" && typeof __returned[__hookName] === "function") {
        __hookFn = __returned[__hookName];
    } else if (module.exports && typeof module.exports[__hookName] === "function") {
        __hookFn = module.exports[__hookName];
    } else if (exports && typeof exports[__hookName] === "function") {
        __hookFn = exports[__hookName];
    }

    if (typeof __hookFn !== "function") {
        __global.__hostMissingHook = true;
        return undefined;
    }

    const __realmPayload = __payloadJson !== undefined ? JSON.parse(__payloadJson) : {};
    return __invokeHook(__hookFn, __hookName, __realmPayload);
})(this);
`;

        let script;
        try {
            script = new vm.Script(compiledSource, {
                filename: 'game-script.js',
            });
        } catch (err) {
            return {
                ok: false,
                result: null,
                logs,
                error: err?.message || String(err),
                durationMs: Math.max(0, Date.now() - startTime),
                timedOut: false,
            };
        }

        let timerId = null;
        try {
            const executionValue = script.runInContext(context, {
                timeout: effectiveTimeout,
                breakOnSigint: false,
            });

            if (sandbox.__hostMissingHook) {
                return {
                    ok: true,
                    result: undefined,
                    missingHook: true,
                    logs: Array.from(logs),
                    error: null,
                    durationMs: Math.max(0, Date.now() - startTime),
                    timedOut: false,
                };
            }

            let resolvedValue = executionValue;
            if (
                executionValue &&
                (typeof executionValue === 'object' || typeof executionValue === 'function') &&
                typeof executionValue.then === 'function'
            ) {
                const remainingMs = Math.max(1, effectiveTimeout - (Date.now() - startTime));
                const asyncPromise = new Promise((resolve, reject) => {
                    executionValue.then(resolve, reject);
                });
                const timeoutPromise = new Promise((_, reject) => {
                    timerId = setTimeout(() => {
                        const timeoutErr = new Error(`Script execution timed out after ${effectiveTimeout}ms`);
                        timeoutErr.code = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
                        reject(timeoutErr);
                    }, remainingMs);
                });
                resolvedValue = await Promise.race([asyncPromise, timeoutPromise]);
            }

            const clonedResult = cloneJson(resolvedValue);
            return {
                ok: true,
                result: clonedResult,
                logs: Array.from(logs),
                error: null,
                durationMs: Math.max(0, Date.now() - startTime),
                timedOut: false,
            };
        } catch (err) {
            const timedOut = isTimeoutError(err);
            return {
                ok: false,
                result: null,
                logs: Array.from(logs),
                error: timedOut
                    ? `Script execution timed out after ${effectiveTimeout}ms`
                    : (err?.message || String(err)),
                durationMs: Math.max(0, Date.now() - startTime),
                timedOut,
            };
        } finally {
            if (timerId !== null) {
                clearTimeout(timerId);
                timerId = null;
            }
        }
    }

    return { runJsHook };
}
