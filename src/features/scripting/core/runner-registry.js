/**
 * runner-registry.js — Language runner registry & hook dispatcher for Game Scripts.
 *
 * Pure ESM, zero SillyTavern/DOM/Multihog imports.
 * Auto-registers the appropriate JS sandbox runner (Web Worker in browsers,
 * Node `vm` in headless Node/Vitest) and registers a metadata placeholder for Python.
 */

import { createJsWorkerRunner, isWorkerRunnerAvailable } from './runner-js-worker.js';
import { createJsNodeRunner, isNodeVmRunnerAvailable } from './runner-js-node.js';

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
 * Executes a hook on a script object using the registered runner for `script.lang`.
 * @param {{ lang?: string, code?: string, timeoutMs?: number }} script
 * @param {string} hookName
 * @param {object} [payload]
 * @param {{ timeoutMs?: number }} [options]
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

    return runFn({
        code: typeof script.code === 'string' ? script.code : '',
        hookName: String(hookName || ''),
        payload: payload ?? {},
        timeoutMs,
    });
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

    registerRunner('python', {
        label: 'Python (Pyodide)',
        available: false,
        note: 'Planned for Phase 2 (Pyodide WebAssembly)',
    });
}

registerDefaultRunners();
