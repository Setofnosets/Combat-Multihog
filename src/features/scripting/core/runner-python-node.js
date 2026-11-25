/**
 * runner-python-node.js — Node `child_process` (`python3 -I`) sandbox for
 * Combat-Multihog Phase 2 Game Scripts.
 *
 * Pure ESM, zero SillyTavern/DOM/Multihog imports.
 * Uses dynamic `await import('node:child_process')` at execution time so
 * browsers never fail to parse or load this module if imported statically.
 */

import { PYTHON_SANDBOX_BOOTSTRAP } from './python-bootstrap.js';

const DEFAULT_TIMEOUT_MS = 1500;

const PYTHON_NODE_DRIVER = `${PYTHON_SANDBOX_BOOTSTRAP}
import sys as _sys

def _run_node_driver():
    _raw_stdin = _sys.stdin.read()
    _req = _json.loads(_raw_stdin) if _raw_stdin else {}
    if not isinstance(_req, dict):
        _req = {}
    _payload = _req.get('payload')
    if _payload is None:
        _payload = {}
    _out_json = run_sandboxed_hook(
        _req.get('code'),
        _req.get('hookName', ''),
        _json.dumps(_payload),
    )
    _sys.stdout.write(_out_json)
    _sys.stdout.flush()

_run_node_driver()
`;

/**
 * Checks whether the Node `python3` runner can be used in the current runtime.
 * @returns {boolean}
 */
export function isPythonNodeRunnerAvailable() {
    return typeof process !== 'undefined' && Boolean(process?.versions?.node);
}

/**
 * Creates a Node `child_process` Python 3 sandbox runner.
 * @returns {{
 *   runHook: (opts: { code: string, hookName: string, payload?: any, timeoutMs?: number }) => Promise<{ ok: boolean, result: any, missingHook?: boolean, logs: string[], error: string|null, durationMs: number, timedOut: boolean }>,
 *   getStatus: () => { state: string, runtime: string, lastError: string|null },
 *   warmup: () => Promise<{ ok: boolean, state: string }>,
 *   configure: () => void,
 *   terminate: () => void,
 * }}
 */
export function createPythonNodeRunner() {
    async function runHook({ code, hookName, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        const startTime = Date.now();
        const effectiveTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
            ? Math.floor(Number(timeoutMs))
            : DEFAULT_TIMEOUT_MS;

        if (!isPythonNodeRunnerAvailable()) {
            return {
                ok: false,
                result: null,
                logs: [],
                error: 'Python Node runner is unavailable in this environment',
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

        let requestJson;
        try {
            requestJson = JSON.stringify({
                code,
                hookName: requestedHook,
                payload: payload ?? {},
            });
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

        let spawn;
        try {
            ({ spawn } = await import('node:child_process'));
        } catch (err) {
            return {
                ok: false,
                result: null,
                logs: [],
                error: `Failed to load node:child_process: ${err?.message || String(err)}`,
                durationMs: Math.max(0, Date.now() - startTime),
                timedOut: false,
            };
        }

        return new Promise((resolve) => {
            let settled = false;
            let timerId = null;
            const stdoutChunks = [];
            const stderrChunks = [];

            const finish = (outcome) => {
                if (settled) return;
                settled = true;
                if (timerId !== null) {
                    clearTimeout(timerId);
                    timerId = null;
                }
                resolve(outcome);
            };

            let child;
            try {
                child = spawn('python3', ['-I', '-c', PYTHON_NODE_DRIVER], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            } catch (err) {
                const isMissing = err?.code === 'ENOENT';
                finish({
                    ok: false,
                    result: null,
                    logs: [],
                    error: isMissing
                        ? 'python3 executable not found in PATH'
                        : `Failed to spawn python3: ${err?.message || String(err)}`,
                    durationMs: Math.max(0, Date.now() - startTime),
                    timedOut: false,
                });
                return;
            }

            timerId = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Process may have already exited.
                }
                finish({
                    ok: false,
                    result: null,
                    logs: [],
                    error: `Python script execution timed out after ${effectiveTimeout}ms`,
                    durationMs: Math.max(0, Date.now() - startTime),
                    timedOut: true,
                });
            }, effectiveTimeout);

            child.stdout.on('data', (chunk) => {
                stdoutChunks.push(chunk);
            });

            child.stderr.on('data', (chunk) => {
                stderrChunks.push(chunk);
            });

            child.stdin.on('error', () => {
                // Ignore EPIPE if child terminates before reading all of stdin.
            });

            child.on('error', (err) => {
                const isMissing = err?.code === 'ENOENT';
                finish({
                    ok: false,
                    result: null,
                    logs: [],
                    error: isMissing
                        ? 'python3 executable not found in PATH'
                        : `Failed to execute python3: ${err?.message || String(err)}`,
                    durationMs: Math.max(0, Date.now() - startTime),
                    timedOut: false,
                });
            });

            child.on('close', (exitCode, signal) => {
                const durationMs = Math.max(0, Date.now() - startTime);
                const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
                const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

                if (!stdout) {
                    finish({
                        ok: false,
                        result: null,
                        logs: [],
                        error: stderr || `python3 exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''} and produced no output`,
                        durationMs,
                        timedOut: false,
                    });
                    return;
                }

                let parsed;
                try {
                    parsed = JSON.parse(stdout);
                } catch (err) {
                    finish({
                        ok: false,
                        result: null,
                        logs: [],
                        error: `Invalid JSON output from python3 runner: ${err?.message || String(err)}${stderr ? ` (${stderr})` : ''}`,
                        durationMs,
                        timedOut: false,
                    });
                    return;
                }

                if (!parsed || typeof parsed !== 'object') {
                    finish({
                        ok: false,
                        result: null,
                        logs: [],
                        error: 'Invalid response object from python3 runner',
                        durationMs,
                        timedOut: false,
                    });
                    return;
                }

                finish({
                    ok: Boolean(parsed.ok),
                    result: parsed.result ?? null,
                    missingHook: Boolean(parsed.missingHook),
                    logs: Array.isArray(parsed.logs) ? parsed.logs : [],
                    error: parsed.error ?? null,
                    durationMs,
                    timedOut: false,
                });
            });

            try {
                child.stdin.end(requestJson);
            } catch (err) {
                finish({
                    ok: false,
                    result: null,
                    logs: [],
                    error: `Failed to write request to python3 stdin: ${err?.message || String(err)}`,
                    durationMs: Math.max(0, Date.now() - startTime),
                    timedOut: false,
                });
            }
        });
    }

    return {
        runHook,
        getStatus: () => ({ state: 'ready', runtime: 'node-python3', lastError: null }),
        warmup: async () => ({ ok: true, state: 'ready' }),
        configure: () => {},
        terminate: () => {},
    };
}
