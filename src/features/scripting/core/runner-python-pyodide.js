/**
 * runner-python-pyodide.js — Persistent warm Web Worker Pyodide sandbox
 * for Combat-Multihog Phase 2 Game Scripts.
 *
 * Pure browser-compatible ESM: zero SillyTavern, DOM, or Node imports.
 * Boots Pyodide once inside a dedicated Blob Web Worker, evaluates
 * `PYTHON_SANDBOX_BOOTSTRAP` once, neutralizes worker network/storage globals
 * before signaling readiness, serializes hook calls over a request queue,
 * and enforces separate boot vs. per-hook execution watchdogs.
 */

import { PYTHON_SANDBOX_BOOTSTRAP } from './python-bootstrap.js';

export const DEFAULT_PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/';
export const DEFAULT_PYODIDE_BOOT_TIMEOUT_MS = 25000;

const DEFAULT_HOOK_TIMEOUT_MS = 1500;
const MIN_BOOT_TIMEOUT_MS = 5000;
const MAX_BOOT_TIMEOUT_MS = 120000;
const MAX_LOGS = 100;

/**
 * Checks whether the current runtime supports Blob Web Workers for Pyodide.
 * @returns {boolean}
 */
export function isPyodideWorkerAvailable() {
    return (
        typeof Worker === 'function' &&
        typeof Blob === 'function' &&
        typeof URL?.createObjectURL === 'function'
    );
}

function normalizePyodideIndexUrl(rawUrl) {
    if (typeof rawUrl !== 'string') {
        return DEFAULT_PYODIDE_INDEX_URL;
    }
    const trimmed = rawUrl.trim();
    if (!trimmed) {
        return DEFAULT_PYODIDE_INDEX_URL;
    }
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function clampBootTimeoutMs(rawTimeout, fallback = DEFAULT_PYODIDE_BOOT_TIMEOUT_MS) {
    if (
        rawTimeout === undefined ||
        rawTimeout === null ||
        (typeof rawTimeout === 'string' && !rawTimeout.trim())
    ) {
        return fallback;
    }
    const num = Number(rawTimeout);
    if (!Number.isFinite(num)) {
        return fallback;
    }
    return Math.max(MIN_BOOT_TIMEOUT_MS, Math.min(MAX_BOOT_TIMEOUT_MS, Math.floor(num)));
}

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function normalizeWorkerOutcome(data, fallbackDurationMs) {
    if (!data || typeof data !== 'object') {
        return {
            ok: false,
            result: null,
            missingHook: false,
            logs: [],
            error: 'Invalid response from Pyodide worker',
            durationMs: fallbackDurationMs,
            timedOut: false,
        };
    }

    const ok = Boolean(data.ok);
    const missingHook = Boolean(data.missingHook);
    const logs = Array.isArray(data.logs)
        ? data.logs.slice(0, MAX_LOGS).map((entry) => String(entry))
        : [];
    const timedOut = Boolean(data.timedOut);
    const durationMs = (
        typeof data.durationMs === 'number' &&
        Number.isFinite(data.durationMs) &&
        data.durationMs >= 0
    )
        ? Math.floor(data.durationMs)
        : fallbackDurationMs;

    let result = null;
    if (ok && data.result !== undefined) {
        try {
            const cloned = cloneJson(data.result);
            result = cloned === undefined ? null : cloned;
        } catch (err) {
            return {
                ok: false,
                result: null,
                missingHook: false,
                logs,
                error: `Python return value is not JSON-serializable: ${err?.message || String(err)}`,
                durationMs,
                timedOut: false,
            };
        }
    }

    const error = ok
        ? null
        : (data.error != null && String(data.error) !== ''
            ? String(data.error)
            : 'Python script execution failed');

    return {
        ok,
        result,
        missingHook,
        logs,
        error,
        durationMs,
        timedOut,
    };
}

/**
 * Builds the classic Blob Web Worker script that boots Pyodide, installs
 * `PYTHON_SANDBOX_BOOTSTRAP`, neutralizes network/storage globals, and
 * serves `{ type: 'exec', id, code, hookName, payloadJson }` requests.
 *
 * @param {string} [indexUrl]
 * @returns {string}
 */
export function buildPyodideWorkerSource(indexUrl = DEFAULT_PYODIDE_INDEX_URL) {
    const normalizedIndexUrl = normalizePyodideIndexUrl(indexUrl);
    const indexUrlLiteral = JSON.stringify(normalizedIndexUrl);
    const bootstrapLiteral = JSON.stringify(PYTHON_SANDBOX_BOOTSTRAP);

    return `'use strict';

const INDEX_URL = ${indexUrlLiteral};
const BOOTSTRAP_CODE = ${bootstrapLiteral};
const SCOPE = typeof self !== 'undefined' ? self : globalThis;
const hostPostMessage = typeof SCOPE.postMessage === 'function'
    ? SCOPE.postMessage.bind(SCOPE)
    : function () {};

const BLOCKED_GLOBALS = [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'indexedDB',
    'caches',
    'importScripts',
];

let pyodide = null;
let ready = false;
let bootError = null;

function formatErr(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'object' && 'message' in err && err.message) {
        return String(err.message);
    }
    return String(err);
}

function getLoadedPyodideFn() {
    if (typeof SCOPE.loadPyodide === 'function') {
        return SCOPE.loadPyodide;
    }
    if (typeof loadPyodide === 'function') {
        return loadPyodide;
    }
    return null;
}

function neutralizeWorkerGlobals() {
    for (let i = 0; i < BLOCKED_GLOBALS.length; i++) {
        const name = BLOCKED_GLOBALS[i];
        try {
            Object.defineProperty(SCOPE, name, {
                value: undefined,
                writable: false,
                configurable: true,
            });
        } catch (_) {
            try {
                SCOPE[name] = undefined;
            } catch (__) {
                // Ignore non-configurable / read-only globals.
            }
        }
    }
}

async function loadPyodideFactory() {
    const preloaded = getLoadedPyodideFn();
    if (preloaded) {
        return preloaded;
    }

    let loadError = null;
    if (typeof SCOPE.importScripts === 'function') {
        try {
            SCOPE.importScripts(INDEX_URL + 'pyodide.js');
            const fromImportScripts = getLoadedPyodideFn();
            if (fromImportScripts) {
                return fromImportScripts;
            }
        } catch (err) {
            loadError = err;
        }
    }

    try {
        const mod = await import(INDEX_URL + 'pyodide.mjs');
        if (mod && typeof mod.loadPyodide === 'function') {
            return mod.loadPyodide;
        }
    } catch (err) {
        if (!loadError) {
            loadError = err;
        }
    }

    throw loadError || new Error('Failed to load Pyodide from ' + INDEX_URL);
}

async function boot() {
    try {
        const loadPyodideFn = await loadPyodideFactory();
        const instance = await loadPyodideFn({ indexURL: INDEX_URL });
        if (
            !instance ||
            typeof instance.runPythonAsync !== 'function' ||
            typeof instance.runPython !== 'function' ||
            !instance.globals ||
            typeof instance.globals.set !== 'function'
        ) {
            throw new Error('Loaded Pyodide instance does not expose required runtime APIs');
        }

        await instance.runPythonAsync(BOOTSTRAP_CODE);
        pyodide = instance;

        // Neutralize network and storage APIs only after Pyodide & bootstrap finish loading.
        neutralizeWorkerGlobals();

        ready = true;
        hostPostMessage({ type: 'ready' });
    } catch (err) {
        bootError = formatErr(err);
        ready = false;
        pyodide = null;
        hostPostMessage({ type: 'boot-error', error: bootError });
    }
}

const bootPromise = boot();

SCOPE.onmessage = async function (event) {
    const msg = event && event.data ? event.data : {};
    if (msg.type !== 'exec') {
        return;
    }

    const id = msg.id;
    await bootPromise;

    if (!ready || !pyodide) {
        hostPostMessage({
            type: 'result',
            id,
            data: {
                ok: false,
                result: null,
                missingHook: false,
                logs: [],
                error: bootError || 'Pyodide runtime is not ready',
            },
        });
        return;
    }

    const code = typeof msg.code === 'string' ? msg.code : '';
    const hookName = typeof msg.hookName === 'string' ? msg.hookName : '';
    const payloadJson = typeof msg.payloadJson === 'string' ? msg.payloadJson : '{}';

    try {
        pyodide.globals.set('__rt_code', code);
        pyodide.globals.set('__rt_hook', hookName);
        pyodide.globals.set('__rt_payload', payloadJson);

        let outJson;
        try {
            outJson = pyodide.runPython('run_sandboxed_hook(__rt_code, __rt_hook, __rt_payload)');
        } finally {
            if (pyodide.globals && typeof pyodide.globals.delete === 'function') {
                const tempKeys = ['__rt_code', '__rt_hook', '__rt_payload'];
                for (let i = 0; i < tempKeys.length; i++) {
                    try {
                        pyodide.globals.delete(tempKeys[i]);
                    } catch (_) {}
                }
            }
        }

        let data;
        if (typeof outJson === 'string') {
            data = JSON.parse(outJson);
        } else if (outJson && typeof outJson === 'object') {
            data = outJson;
        } else {
            throw new Error('Unexpected non-JSON return value from run_sandboxed_hook');
        }

        hostPostMessage({
            type: 'result',
            id,
            data,
        });
    } catch (err) {
        hostPostMessage({
            type: 'result',
            id,
            data: {
                ok: false,
                result: null,
                missingHook: false,
                logs: [],
                error: formatErr(err),
            },
        });
    }
};
`;
}

/**
 * Creates a persistent warm Web Worker Pyodide runner for browser Game Scripts.
 *
 * @param {{ pyodideIndexUrl?: string, indexUrl?: string, bootTimeoutMs?: number }} [initialConfig]
 * @returns {{
 *   runHook: (opts: { code: string, hookName: string, payload?: any, timeoutMs?: number, pyodideIndexUrl?: string, bootTimeoutMs?: number }) => Promise<{ ok: boolean, result: any, missingHook?: boolean, logs: string[], error: string|null, durationMs: number, timedOut: boolean }>,
 *   configure: (opts?: { pyodideIndexUrl?: string, indexUrl?: string, bootTimeoutMs?: number }) => { state: 'idle'|'loading'|'ready'|'error', indexUrl: string, lastError: string|null },
 *   warmup: () => Promise<{ ok: boolean, state: 'idle'|'loading'|'ready'|'error', error: string|null }>,
 *   getStatus: () => { state: 'idle'|'loading'|'ready'|'error', indexUrl: string, lastError: string|null },
 *   terminate: () => void,
 * }}
 */
export function createPyodideRunner(initialConfig = {}) {
    let indexUrl = normalizePyodideIndexUrl(
        initialConfig?.pyodideIndexUrl !== undefined
            ? initialConfig.pyodideIndexUrl
            : initialConfig?.indexUrl,
    );
    let bootTimeoutMs = clampBootTimeoutMs(
        initialConfig?.bootTimeoutMs,
        DEFAULT_PYODIDE_BOOT_TIMEOUT_MS,
    );

    /** @type {'idle' | 'loading' | 'ready' | 'error'} */
    let state = 'idle';
    /** @type {string|null} */
    let lastError = null;
    /** @type {Worker|null} */
    let worker = null;
    /** @type {string|null} */
    let blobUrl = null;
    let requestSeq = 0;

    let activeBoot = null;
    let activeExec = null;
    let queueTail = Promise.resolve();

    function enqueue(taskFn) {
        const next = queueTail.then(taskFn, taskFn);
        queueTail = next.then(() => undefined, () => undefined);
        return next;
    }

    function destroyWorkerInstance() {
        if (worker) {
            try { worker.onmessage = null; } catch (_) {}
            try { worker.onerror = null; } catch (_) {}
            try { worker.onmessageerror = null; } catch (_) {}
            try { worker.terminate(); } catch (_) {}
            worker = null;
        }
        if (blobUrl) {
            try {
                if (typeof URL?.revokeObjectURL === 'function') {
                    URL.revokeObjectURL(blobUrl);
                }
            } catch (_) {}
            blobUrl = null;
        }
    }

    function getStatus() {
        return {
            state,
            indexUrl,
            lastError,
        };
    }

    function terminate() {
        if (activeBoot) {
            const pendingBoot = activeBoot;
            activeBoot = null;
            if (pendingBoot.timerId !== null) {
                clearTimeout(pendingBoot.timerId);
                pendingBoot.timerId = null;
            }
            destroyWorkerInstance();
            state = 'idle';
            lastError = null;
            pendingBoot.resolve({
                ok: false,
                state: 'idle',
                error: 'Pyodide worker terminated',
                timedOut: false,
            });
        } else {
            destroyWorkerInstance();
            state = 'idle';
            lastError = null;
        }

        if (activeExec) {
            const pendingExec = activeExec;
            activeExec = null;
            if (pendingExec.timerId !== null) {
                clearTimeout(pendingExec.timerId);
                pendingExec.timerId = null;
            }
            pendingExec.resolve({
                ok: false,
                result: null,
                missingHook: false,
                logs: [],
                error: 'Pyodide worker terminated',
                durationMs: Math.max(0, Date.now() - pendingExec.startTime),
                timedOut: false,
            });
        }
    }

    function configure(config = {}) {
        if (!config || typeof config !== 'object') {
            return getStatus();
        }

        const hasUrl = config.pyodideIndexUrl !== undefined || config.indexUrl !== undefined;
        if (hasUrl) {
            const rawUrl = config.pyodideIndexUrl !== undefined
                ? config.pyodideIndexUrl
                : config.indexUrl;
            const nextIndexUrl = normalizePyodideIndexUrl(rawUrl);
            if (nextIndexUrl !== indexUrl) {
                indexUrl = nextIndexUrl;
                if (worker !== null || state !== 'idle') {
                    terminate();
                }
            }
        }

        if (config.bootTimeoutMs !== undefined) {
            bootTimeoutMs = clampBootTimeoutMs(
                config.bootTimeoutMs,
                DEFAULT_PYODIDE_BOOT_TIMEOUT_MS,
            );
        }

        return getStatus();
    }

    function startBoot() {
        if (state === 'ready' && worker) {
            return Promise.resolve({
                ok: true,
                state: 'ready',
                error: null,
                timedOut: false,
            });
        }
        if (state === 'loading' && activeBoot) {
            return activeBoot.promise;
        }

        if (!isPyodideWorkerAvailable()) {
            destroyWorkerInstance();
            state = 'error';
            lastError = 'Pyodide Web Worker runner is unavailable in this environment';
            return Promise.resolve({
                ok: false,
                state: 'error',
                error: lastError,
                timedOut: false,
            });
        }

        destroyWorkerInstance();
        state = 'loading';
        lastError = null;

        const workerSource = buildPyodideWorkerSource(indexUrl);
        let spawnedWorker = null;
        let spawnedBlobUrl = null;

        try {
            const blob = new Blob([workerSource], { type: 'application/javascript' });
            spawnedBlobUrl = URL.createObjectURL(blob);
            spawnedWorker = new Worker(spawnedBlobUrl);
        } catch (err) {
            if (spawnedBlobUrl && typeof URL?.revokeObjectURL === 'function') {
                try { URL.revokeObjectURL(spawnedBlobUrl); } catch (_) {}
            }
            state = 'error';
            lastError = `Failed to spawn Pyodide worker: ${err?.message || String(err)}`;
            return Promise.resolve({
                ok: false,
                state: 'error',
                error: lastError,
                timedOut: false,
            });
        }

        worker = spawnedWorker;
        blobUrl = spawnedBlobUrl;

        const currentBootTimeout = bootTimeoutMs;
        let bootResolve = null;
        const promise = new Promise((resolve) => {
            bootResolve = resolve;
        });

        const bootRecord = {
            promise,
            resolve: bootResolve,
            timerId: null,
        };
        activeBoot = bootRecord;

        const failBoot = (errorMessage, timedOut = false) => {
            if (activeBoot !== bootRecord) return;
            activeBoot = null;
            if (bootRecord.timerId !== null) {
                clearTimeout(bootRecord.timerId);
                bootRecord.timerId = null;
            }
            destroyWorkerInstance();
            state = 'error';
            lastError = errorMessage || 'Pyodide initialization failed';
            bootRecord.resolve({
                ok: false,
                state: 'error',
                error: lastError,
                timedOut,
            });
        };

        const succeedBoot = () => {
            if (activeBoot !== bootRecord) return;
            activeBoot = null;
            if (bootRecord.timerId !== null) {
                clearTimeout(bootRecord.timerId);
                bootRecord.timerId = null;
            }
            state = 'ready';
            lastError = null;
            bootRecord.resolve({
                ok: true,
                state: 'ready',
                error: null,
                timedOut: false,
            });
        };

        bootRecord.timerId = setTimeout(() => {
            failBoot(`Pyodide initialization timed out after ${currentBootTimeout}ms`, true);
        }, currentBootTimeout);

        spawnedWorker.onmessage = (event) => {
            const msg = event && event.data ? event.data : {};
            if (msg.type === 'ready') {
                succeedBoot();
                return;
            }
            if (msg.type === 'boot-error') {
                failBoot(msg.error || 'Pyodide initialization failed', false);
                return;
            }
            if (msg.type === 'result' && activeExec && msg.id === activeExec.id) {
                const execRecord = activeExec;
                activeExec = null;
                if (execRecord.timerId !== null) {
                    clearTimeout(execRecord.timerId);
                    execRecord.timerId = null;
                }
                const fallbackDuration = Math.max(0, Date.now() - execRecord.startTime);
                execRecord.resolve(normalizeWorkerOutcome(msg.data, fallbackDuration));
            }
        };

        spawnedWorker.onerror = (event) => {
            const message = event?.message || 'Pyodide worker error';
            if (activeBoot === bootRecord) {
                failBoot(message, false);
                return;
            }
            if (activeExec) {
                const execRecord = activeExec;
                activeExec = null;
                if (execRecord.timerId !== null) {
                    clearTimeout(execRecord.timerId);
                    execRecord.timerId = null;
                }
                const durationMs = Math.max(0, Date.now() - execRecord.startTime);
                terminate();
                execRecord.resolve({
                    ok: false,
                    result: null,
                    missingHook: false,
                    logs: [],
                    error: message,
                    durationMs,
                    timedOut: false,
                });
                return;
            }
            terminate();
        };

        spawnedWorker.onmessageerror = () => {
            const message = 'Pyodide worker message deserialization failed';
            if (activeBoot === bootRecord) {
                failBoot(message, false);
                return;
            }
            if (activeExec) {
                const execRecord = activeExec;
                activeExec = null;
                if (execRecord.timerId !== null) {
                    clearTimeout(execRecord.timerId);
                    execRecord.timerId = null;
                }
                const durationMs = Math.max(0, Date.now() - execRecord.startTime);
                terminate();
                execRecord.resolve({
                    ok: false,
                    result: null,
                    missingHook: false,
                    logs: [],
                    error: message,
                    durationMs,
                    timedOut: false,
                });
                return;
            }
            terminate();
        };

        return promise;
    }

    async function warmup() {
        try {
            if (state === 'ready' && worker) {
                return { ok: true, state: 'ready', error: null };
            }
            if (state === 'loading' && activeBoot) {
                const bootRes = await activeBoot.promise;
                return {
                    ok: Boolean(bootRes.ok),
                    state: bootRes.state || state,
                    error: bootRes.error ?? null,
                };
            }
            if (state !== 'idle') {
                return {
                    ok: false,
                    state,
                    error: lastError,
                };
            }
            const bootRes = await startBoot();
            return {
                ok: Boolean(bootRes.ok),
                state: bootRes.state || state,
                error: bootRes.error ?? null,
            };
        } catch (err) {
            return {
                ok: false,
                state,
                error: err?.message || String(err),
            };
        }
    }

    function executeHookOnReadyWorker({ code, hookName, payloadJson, effectiveTimeout }) {
        if (!worker || state !== 'ready') {
            return Promise.resolve({
                ok: false,
                result: null,
                missingHook: false,
                logs: [],
                error: lastError || 'Pyodide worker is not ready',
                durationMs: 0,
                timedOut: false,
            });
        }

        const id = ++requestSeq;
        const startTime = Date.now();

        return new Promise((resolve) => {
            const execRecord = {
                id,
                resolve,
                timerId: null,
                startTime,
            };
            activeExec = execRecord;

            execRecord.timerId = setTimeout(() => {
                if (activeExec !== execRecord) return;
                activeExec = null;
                execRecord.timerId = null;
                const durationMs = Math.max(0, Date.now() - execRecord.startTime);
                terminate();
                resolve({
                    ok: false,
                    result: null,
                    missingHook: false,
                    logs: [],
                    error: `Python script execution timed out after ${effectiveTimeout}ms`,
                    durationMs,
                    timedOut: true,
                });
            }, effectiveTimeout);

            try {
                worker.postMessage({
                    type: 'exec',
                    id,
                    code,
                    hookName,
                    payloadJson,
                });
            } catch (err) {
                if (activeExec === execRecord) {
                    activeExec = null;
                }
                if (execRecord.timerId !== null) {
                    clearTimeout(execRecord.timerId);
                    execRecord.timerId = null;
                }
                const durationMs = Math.max(0, Date.now() - execRecord.startTime);
                terminate();
                resolve({
                    ok: false,
                    result: null,
                    missingHook: false,
                    logs: [],
                    error: `Failed to post message to Pyodide worker: ${err?.message || String(err)}`,
                    durationMs,
                    timedOut: false,
                });
            }
        });
    }

    async function runHook({
        code,
        hookName,
        payload = {},
        timeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
        pyodideIndexUrl,
        bootTimeoutMs: callBootTimeoutMs,
    } = {}) {
        const effectiveTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
            ? Math.max(1, Math.floor(Number(timeoutMs)))
            : DEFAULT_HOOK_TIMEOUT_MS;

        if (!isPyodideWorkerAvailable()) {
            return {
                ok: false,
                result: null,
                missingHook: false,
                logs: [],
                error: 'Pyodide Web Worker runner is unavailable in this environment',
                durationMs: 0,
                timedOut: false,
            };
        }

        if (typeof code !== 'string') {
            return {
                ok: false,
                result: null,
                missingHook: false,
                logs: [],
                error: 'Script code must be a string',
                durationMs: 0,
                timedOut: false,
            };
        }

        const requestedHook = String(hookName || '');

        let payloadJson;
        try {
            const safePayload = payload === undefined ? {} : cloneJson(payload);
            payloadJson = JSON.stringify(safePayload ?? {});
        } catch (err) {
            return {
                ok: false,
                result: null,
                missingHook: false,
                logs: [],
                error: `Payload is not JSON-serializable: ${err?.message || String(err)}`,
                durationMs: 0,
                timedOut: false,
            };
        }

        return enqueue(async () => {
            if (pyodideIndexUrl !== undefined || callBootTimeoutMs !== undefined) {
                configure({
                    ...(pyodideIndexUrl !== undefined ? { pyodideIndexUrl } : {}),
                    ...(callBootTimeoutMs !== undefined ? { bootTimeoutMs: callBootTimeoutMs } : {}),
                });
            }

            if (state !== 'ready' || !worker) {
                const bootStartTime = Date.now();
                const bootRes = await startBoot();
                if (!bootRes.ok) {
                    return {
                        ok: false,
                        result: null,
                        missingHook: false,
                        logs: [],
                        error: bootRes.error || 'Pyodide initialization failed',
                        durationMs: Math.max(0, Date.now() - bootStartTime),
                        timedOut: Boolean(bootRes.timedOut),
                    };
                }
            }

            return executeHookOnReadyWorker({
                code,
                hookName: requestedHook,
                payloadJson,
                effectiveTimeout,
            });
        });
    }

    return {
        runHook,
        configure,
        warmup,
        getStatus,
        terminate,
    };
}
