/**
 * runner-registry.js — Language runner registry & hook dispatcher for Game Scripts.
 *
 * Pure ESM, zero SillyTavern/DOM/Multihog imports.
 * Auto-registers the appropriate JS sandbox runner (Web Worker in browsers,
 * Node `vm` in headless Node/Vitest) and Python sandbox runner (Pyodide Web
 * Worker in browsers, Node `python3` in headless Node/Vitest).
 */

import { createJsWorkerRunner, isWorkerRunnerAvailable } from './runner-js-worker.js';
import { createJsNodeRunner, isNodeVmRunnerAvailable } from './runner-js-node.js';
import { createPyodideRunner, isPyodideWorkerAvailable } from './runner-python-pyodide.js';
import { createPythonNodeRunner, isPythonNodeRunnerAvailable } from './runner-python-node.js';

export const DEFAULT_SCRIPT_TIMEOUT_MS = 1500;

const registry = new Map();

function normalizeLang(lang) {
    return String(lang || '').trim().toLowerCase();
}

/**
 * Registers a script language runner or metadata entry.
 * @param {string} lang
 * @param {{ lang?: string, label?: string, available?: boolean, note?: string, runHook?: Function, runJsHook?: Function }} runner
 */
export function registerRunner(lang, runner) {
    const key = normalizeLang(lang);
    if (!key) {
        throw new Error('registerRunner requires a non-empty language identifier');
    }
    if (!runner || typeof runner !== 'object') {
        throw new Error(`registerRunner(${key}) requires a runner object`);
    }

    const runFn = typeof runner.runHook === 'function'
        ? runner.runHook
        : (typeof runner.runJsHook === 'function' ? runner.runJsHook : null);

    const entry = {
        ...runner,
        lang: key,
        label: typeof runner.label === 'string' && runner.label.trim() ? runner.label : key.toUpperCase(),
        available: runner.available !== undefined ? Boolean(runner.available) : Boolean(runFn),
        note: typeof runner.note === 'string' ? runner.note : '',
    };

    if (runFn && !entry.runHook) {
        entry.runHook = runFn;
    }

    registry.set(key, entry);
    return entry;
}

/**
 * Unregisters a script language runner.
 * @param {string} lang
 * @returns {boolean}
 */
export function unregisterRunner(lang) {
    const key = normalizeLang(lang);
    if (!key) return false;
    return registry.delete(key);
}

/**
 * Gets a registered runner entry by language identifier.
 * @param {string} lang
 * @returns {object|null}
 */
export function getRunner(lang) {
    const key = normalizeLang(lang);
    if (!key) return null;
    return registry.get(key) || null;
}

/**
 * Lists metadata for all registered runners without exposing internal execution functions.
 * @returns {Array<{ lang: string, label: string, available: boolean, note: string }>}
 */
export function listRunners() {
    return Array.from(registry.values()).map((entry) => ({
        lang: entry.lang,
        label: entry.label,
        available: Boolean(entry.available),
        note: entry.note || '',
    }));
}

/**
 * Updates runtime configuration on a registered runner if it supports `configure()`.
 * @param {string} lang
 * @param {object} [config={}]
 * @returns {object|null}
 */
export function configureRunner(lang, config = {}) {
    const runner = getRunner(lang);
    if (!runner || typeof runner.configure !== 'function') {
        return getRunnerStatus(lang);
    }
    const res = runner.configure(config);
    return res !== undefined ? res : getRunnerStatus(lang);
}

/**
 * Returns the live status object for a registered runner.
 * @param {string} lang
 * @returns {{ state: string, lastError: string|null, [key: string]: any }}
 */
export function getRunnerStatus(lang) {
    const runner = getRunner(lang);
    if (typeof runner?.getStatus === 'function') {
        const status = runner.getStatus();
        if (status && typeof status === 'object') {
            return status;
        }
    }
    return {
        state: runner?.available ? 'ready' : 'unavailable',
        lastError: null,
    };
}

/**
 * Pre-warms a registered runner if it supports `warmup()`.
 * @param {string} lang
 * @returns {Promise<{ ok: boolean, state: string, error?: string|null }>}
 */
export async function warmupRunner(lang) {
    const runner = getRunner(lang);
    if (!runner || !runner.available) {
        return {
            ok: false,
            state: 'unavailable',
            error: runner?.note || `Runner for language "${normalizeLang(lang)}" is unavailable`,
        };
    }
    if (typeof runner.warmup === 'function') {
        const res = await runner.warmup();
        if (res && typeof res === 'object') {
            return res;
        }
    }
    const status = getRunnerStatus(lang);
    return {
        ok: true,
        state: status?.state || 'ready',
    };
}

/**
 * Executes a hook on a script object using the registered runner for `script.lang`.
 * @param {{ lang?: string, code?: string, timeoutMs?: number }} script
 * @param {string} hookName
 * @param {object} [payload]
 * @param {{ timeoutMs?: number, pyodideIndexUrl?: string, bootTimeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, result: any, missingHook?: boolean, logs: string[], error: string|null, durationMs: number, timedOut: boolean }>}
 */
export async function executeScriptHook(script, hookName, payload = {}, options = {}) {
    if (!script || typeof script !== 'object') {
        return {
            ok: false,
            result: null,
            logs: [],
            error: 'Invalid script definition',
            durationMs: 0,
            timedOut: false,
        };
    }

    const lang = normalizeLang(script.lang || 'js') || 'js';
    const runner = getRunner(lang);

    if (!runner) {
        return {
            ok: false,
            result: null,
            logs: [],
            error: `No runner registered for script language "${lang}"`,
            durationMs: 0,
            timedOut: false,
        };
    }

    const runFn = typeof runner.runHook === 'function'
        ? runner.runHook
        : (typeof runner.runJsHook === 'function' ? runner.runJsHook : null);

    if (!runner.available || !runFn) {
        return {
            ok: false,
            result: null,
            logs: [],
            error: runner.note || `Runner for language "${lang}" is unavailable`,
            durationMs: 0,
            timedOut: false,
        };
    }

    const rawTimeout = options?.timeoutMs ?? script.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    const timeoutMs = Number.isFinite(Number(rawTimeout)) && Number(rawTimeout) > 0
        ? Math.floor(Number(rawTimeout))
        : DEFAULT_SCRIPT_TIMEOUT_MS;

    const runOpts = {
        code: typeof script.code === 'string' ? script.code : '',
        hookName: String(hookName || ''),
        payload: payload ?? {},
        timeoutMs,
    };

    if (options && typeof options === 'object') {
        if (options.pyodideIndexUrl !== undefined) {
            runOpts.pyodideIndexUrl = options.pyodideIndexUrl;
        }
        if (options.bootTimeoutMs !== undefined) {
            runOpts.bootTimeoutMs = options.bootTimeoutMs;
        }
    }

    return runFn(runOpts);
}

function registerDefaultRunners() {
    if (isWorkerRunnerAvailable()) {
        const workerRunner = createJsWorkerRunner();
        registerRunner('js', {
            label: 'JavaScript (Web Worker)',
            available: true,
            note: 'Browser Web Worker sandbox',
            runHook: workerRunner.runJsHook,
            runJsHook: workerRunner.runJsHook,
        });
    } else if (isNodeVmRunnerAvailable()) {
        const nodeRunner = createJsNodeRunner();
        registerRunner('js', {
            label: 'JavaScript (Node VM)',
            available: true,
            note: 'Node vm sandbox',
            runHook: nodeRunner.runJsHook,
            runJsHook: nodeRunner.runJsHook,
        });
    } else {
        registerRunner('js', {
            label: 'JavaScript',
            available: false,
            note: 'No JavaScript sandbox runner available in this environment',
        });
    }

    if (isPyodideWorkerAvailable()) {
        const pyWorker = createPyodideRunner();
        registerRunner('python', {
            label: 'Python (Pyodide)',
            available: true,
            note: 'Browser Pyodide WebAssembly Worker sandbox',
            runHook: pyWorker.runHook,
            configure: pyWorker.configure,
            warmup: pyWorker.warmup,
            getStatus: pyWorker.getStatus,
            terminate: pyWorker.terminate,
        });
    } else if (isPythonNodeRunnerAvailable()) {
        const pyNode = createPythonNodeRunner();
        registerRunner('python', {
            label: 'Python (Node python3)',
            available: true,
            note: 'Node python3 isolated sandbox runner',
            runHook: pyNode.runHook,
            configure: pyNode.configure,
            warmup: pyNode.warmup,
            getStatus: pyNode.getStatus,
            terminate: pyNode.terminate,
        });
    } else {
        registerRunner('python', {
            label: 'Python',
            available: false,
            note: 'No Python sandbox runner available in this environment',
        });
    }
}

registerDefaultRunners();
