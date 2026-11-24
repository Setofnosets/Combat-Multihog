/**
 * runner-js-worker.js — Browser Web Worker sandbox for Combat-Multihog Game Scripts.
 *
 * Pure ESM, zero SillyTavern/DOM/Multihog imports.
 * Executes user-authored hook scripts inside an ephemeral Blob Web Worker with
 * dangerous browser globals shadowed, console output captured, strict JSON
 * round-tripping on inputs/outputs, and watchdog termination on timeout.
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
 * Checks whether the current runtime supports ephemeral Blob Web Workers.
 * @returns {boolean}
 */
export function isWorkerRunnerAvailable() {
    return (
        typeof Worker === 'function' &&
        typeof Blob === 'function' &&
        typeof URL?.createObjectURL === 'function'
    );
}

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function buildWorkerSource() {
    const reservedList = JSON.stringify(Array.from(RESERVED_IDENTIFIERS));
    return `'use strict';

const MAX_LOGS = ${MAX_LOGS};
const RESERVED_IDENTIFIERS = new Set(${reservedList});

function isSafeHookIdentifier(name) {
    return (
        typeof name === 'string' &&
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) &&
        !RESERVED_IDENTIFIERS.has(name)
    );
}

function safeFormatArg(value) {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    if (value instanceof Error) {
        return value.stack || (value.name + ': ' + value.message);
    }
    try {
        return JSON.stringify(value);
    } catch (_) {
        try {
            return String(value);
        } catch (__) {
            return '[unserializable]';
        }
    }
}

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function invokeHook(fn, hookName, payload) {
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    switch (hookName) {
        case 'initState':
            return fn(safePayload.ctx);
        case 'onBeforeGenerate':
            return fn(safePayload.state, safePayload.ctx);
        case 'onToolCall':
            return fn(safePayload.state, safePayload.call, safePayload.ctx);
        case 'onAfterGenerate':
            return fn(safePayload.state, safePayload.ctx);
        case 'renderMemo':
            return fn(safePayload.state, safePayload.ctx);
        default:
            return fn(safePayload.state, safePayload.ctx);
    }
}

const hostPostMessage = self.postMessage.bind(self);

self.onmessage = async function (event) {
    const data = event && event.data ? event.data : {};
    const code = typeof data.code === 'string' ? data.code : '';
    const hookName = typeof data.hookName === 'string' ? data.hookName : '';
    const payload = data.payload;

    const logs = [];
    const appendLog = function (level, args) {
        if (logs.length >= MAX_LOGS) return;
        const formatted = Array.prototype.map.call(args, safeFormatArg).join(' ');
        logs.push(level ? '[' + level + '] ' + formatted : formatted);
    };

    const sandboxConsole = Object.freeze({
        log: function () { appendLog('', arguments); },
        info: function () { appendLog('info', arguments); },
        warn: function () { appendLog('warn', arguments); },
        error: function () { appendLog('error', arguments); },
    });

    const startTime = Date.now();

    try {
        const moduleObj = { exports: {} };
        const exportsObj = moduleObj.exports;

        const dynamicNamedLookup = isSafeHookIdentifier(hookName)
            ? '(typeof ' + hookName + ' === "function" ? ' + hookName + ' : undefined)'
            : 'undefined';

        // Shadow network, storage, and worker-escape globals inside the function scope.
        // Function constructor is safe here because it runs inside the ephemeral Worker.
        const wrappedBody =
            '"use strict";\\n' +
            'return (function(module, exports, console, fetch, XMLHttpRequest, importScripts, WebSocket, EventSource, indexedDB, caches, navigator, self, globalThis, postMessage, close, Worker, SharedWorker) {\\n' +
            code +
            '\\n;\\n' +
            'const __namedHooks = {\\n' +
            '  initState: typeof initState === "function" ? initState : undefined,\\n' +
            '  onBeforeGenerate: typeof onBeforeGenerate === "function" ? onBeforeGenerate : undefined,\\n' +
            '  onToolCall: typeof onToolCall === "function" ? onToolCall : undefined,\\n' +
            '  onAfterGenerate: typeof onAfterGenerate === "function" ? onAfterGenerate : undefined,\\n' +
            '  renderMemo: typeof renderMemo === "function" ? renderMemo : undefined,\\n' +
            '};\\n' +
            'const __dynamicNamed = ' + dynamicNamedLookup + ';\\n' +
            'return { __namedHooks: __namedHooks, __dynamicNamed: __dynamicNamed };\\n' +
            '});';

        // Note: if user code explicitly uses \`return { ... }\`, the trailing __namedHooks
        // block won't execute and the factory call directly returns the user's exports object.
        const factory = new Function(wrappedBody)();
        const returned = factory(
            moduleObj,
            exportsObj,
            sandboxConsole,
            undefined, // fetch
            undefined, // XMLHttpRequest
            undefined, // importScripts
            undefined, // WebSocket
            undefined, // EventSource
            undefined, // indexedDB
            undefined, // caches
            undefined, // navigator
            undefined, // self
            undefined, // globalThis
            undefined, // postMessage
            undefined, // close
            undefined, // Worker
            undefined  // SharedWorker
        );

        let hookFn = null;
        if (returned && typeof returned === 'object' && returned.__namedHooks) {
            // Check named declarations first, then dynamic named, then module.exports / exports
            if (typeof returned.__namedHooks[hookName] === 'function') {
                hookFn = returned.__namedHooks[hookName];
            } else if (typeof returned.__dynamicNamed === 'function') {
                hookFn = returned.__dynamicNamed;
            } else if (moduleObj.exports && typeof moduleObj.exports[hookName] === 'function') {
                hookFn = moduleObj.exports[hookName];
            } else if (exportsObj && typeof exportsObj[hookName] === 'function') {
                hookFn = exportsObj[hookName];
            } else if (typeof moduleObj.exports === 'function' && hookName === 'default') {
                hookFn = moduleObj.exports;
            }
        } else if (returned && typeof returned === 'object' && typeof returned[hookName] === 'function') {
            hookFn = returned[hookName];
        } else if (moduleObj.exports && typeof moduleObj.exports[hookName] === 'function') {
            hookFn = moduleObj.exports[hookName];
        } else if (exportsObj && typeof exportsObj[hookName] === 'function') {
            hookFn = exportsObj[hookName];
        }

        if (typeof hookFn !== 'function') {
            hostPostMessage({
                ok: true,
                result: undefined,
                missingHook: true,
                logs,
                error: null,
                durationMs: Math.max(0, Date.now() - startTime),
                timedOut: false,
            });
            return;
        }

        const safePayload = cloneJson(payload);
        const rawResult = await invokeHook(hookFn, hookName, safePayload);
        const clonedResult = cloneJson(rawResult);

        hostPostMessage({
            ok: true,
            result: clonedResult,
            logs,
            error: null,
            durationMs: Math.max(0, Date.now() - startTime),
            timedOut: false,
        });
    } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err
            ? String(err.message)
            : String(err);
        hostPostMessage({
            ok: false,
            result: null,
            logs,
            error: message || 'Script execution failed',
            durationMs: Math.max(0, Date.now() - startTime),
            timedOut: false,
        });
    }
};
`;
}

/**
 * Creates a browser Web Worker JS runner.
 * @returns {{ runJsHook: (opts: { code: string, hookName: string, payload?: any, timeoutMs?: number }) => Promise<{ ok: boolean, result: any, missingHook?: boolean, logs: string[], error: string|null, durationMs: number, timedOut: boolean }> }}
 */
export function createJsWorkerRunner() {
    const workerSource = buildWorkerSource();

    async function runJsHook({ code, hookName, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        const startTime = Date.now();
        const effectiveTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
            ? Math.floor(Number(timeoutMs))
            : DEFAULT_TIMEOUT_MS;

        if (!isWorkerRunnerAvailable()) {
            return {
                ok: false,
                result: null,
                logs: [],
                error: 'Web Worker runner is unavailable in this environment',
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

        let safePayload;
        try {
            safePayload = cloneJson(payload ?? {});
        } catch (err) {
            return {
                ok: false,
                result: null,
                logs: [],
                error: `Payload is not JSON-serializable: ${err?.message || String(err)}`,
                durationMs: Math.max(0, Date.now() - startTime),
                timedOut: false,
            };
        }

        let blobUrl = null;
        let worker = null;

        try {
            const blob = new Blob([workerSource], { type: 'application/javascript' });
            blobUrl = URL.createObjectURL(blob);
            worker = new Worker(blobUrl);
        } catch (err) {
            if (blobUrl) {
                try { URL.revokeObjectURL(blobUrl); } catch (_) {}
            }
            return {
                ok: false,
                result: null,
                logs: [],
                error: `Failed to spawn script worker: ${err?.message || String(err)}`,
                durationMs: Math.max(0, Date.now() - startTime),
                timedOut: false,
            };
        }

        return new Promise((resolve) => {
            let settled = false;
            let timerId = null;

            const cleanup = () => {
                if (timerId !== null) {
                    clearTimeout(timerId);
                    timerId = null;
                }
                if (worker) {
                    try { worker.onmessage = null; } catch (_) {}
                    try { worker.onerror = null; } catch (_) {}
                    try { worker.onmessageerror = null; } catch (_) {}
                    try { worker.terminate(); } catch (_) {}
                    worker = null;
                }
                if (blobUrl) {
                    try { URL.revokeObjectURL(blobUrl); } catch (_) {}
                    blobUrl = null;
                }
            };

            const finish = (response) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(response);
            };

            timerId = setTimeout(() => {
                finish({
                    ok: false,
                    result: null,
                    logs: [],
                    error: `Script execution timed out after ${effectiveTimeout}ms`,
                    durationMs: Math.max(0, Date.now() - startTime),
                    timedOut: true,
                });
            }, effectiveTimeout);

            worker.onmessage = (event) => {
                const msg = event && event.data ? event.data : {};
                let clonedResult = msg.result;
                try {
                    clonedResult = cloneJson(msg.result);
                } catch (err) {
                    finish({
                        ok: false,
                        result: null,
                        logs: Array.isArray(msg.logs) ? msg.logs : [],
                        error: `Script return value is not JSON-serializable: ${err?.message || String(err)}`,
                        durationMs: Math.max(0, Date.now() - startTime),
                        timedOut: false,
                    });
                    return;
                }

                const response = {
                    ok: Boolean(msg.ok),
                    result: msg.ok ? clonedResult : null,
                    logs: Array.isArray(msg.logs) ? msg.logs.slice(0, MAX_LOGS) : [],
                    error: msg.error ?? null,
                    durationMs: typeof msg.durationMs === 'number'
                        ? msg.durationMs
                        : Math.max(0, Date.now() - startTime),
                    timedOut: Boolean(msg.timedOut),
                };
                if (msg.missingHook) {
                    response.missingHook = true;
                }
                finish(response);
            };

            worker.onerror = (event) => {
                const message = event?.message || 'Worker script error';
                finish({
                    ok: false,
                    result: null,
                    logs: [],
                    error: message,
                    durationMs: Math.max(0, Date.now() - startTime),
                    timedOut: false,
                });
            };

            worker.onmessageerror = () => {
                finish({
                    ok: false,
                    result: null,
                    logs: [],
                    error: 'Worker message serialization failed',
                    durationMs: Math.max(0, Date.now() - startTime),
                    timedOut: false,
                });
            };

            try {
                worker.postMessage({
                    code,
                    hookName: String(hookName || ''),
                    payload: safePayload,
                });
            } catch (err) {
                finish({
                    ok: false,
                    result: null,
                    logs: [],
                    error: `Failed to post message to script worker: ${err?.message || String(err)}`,
                    durationMs: Math.max(0, Date.now() - startTime),
                    timedOut: false,
                });
            }
        });
    }

    return { runJsHook };
}
