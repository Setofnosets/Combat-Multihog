/**
 * script-host-adapter.js — Host runtime adapter bridging Combat-Multihog
 * Game Scripts (core engine + store) with SillyTavern context, memo blocks,
 * function tools, card metadata, and swipe rollback.
 */

import {
    buildToolSchemaFromActions,
    deriveScriptToolName,
    sanitizeTrackerTag,
} from './core/script-schema.js';
import {
    runScriptToolAction,
    runScriptsAfterGenerate,
    runScriptsBeforeGenerate,
    renderScriptMemo,
    ensureScriptState,
    createTurnLedger,
} from './core/script-engine.js';
import {
    configureRunner,
    getRunnerStatus,
    warmupRunner,
} from './core/runner-registry.js';
import {
    captureScriptSnapshot,
    getChatScriptRecord,
    getChatScriptRecords,
    getClaimedScriptTags,
    getScriptById,
    resolveEnabledScriptsForChat,
    restoreScriptSwipeSnapshot,
    setChatScriptRecord,
    stampScriptSwipeSnapshot,
} from './script-store.js';
import {
    extractCurrentTimeStr,
    parseInWorldTime,
} from '../../../memo-processor.js';
import {
    parseMemoBlocks,
    registerScriptCardMetaResolver,
} from '../../../renderer.js';
import {
    getActiveChatId,
    getSettings,
} from '../../../state-manager.js';
import { saveSettings } from '../../app/runtime-bridge.js';

const _registeredScriptTools = new Set();
let _activeTurn = null;

function getStContextSafe() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch (_) {
        return null;
    }
}

function saveSettingsSafe() {
    try {
        return saveSettings();
    } catch (_) {
        return undefined;
    }
}

function escapeRegex(str) {
    return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveChatId(chatId) {
    if (chatId === undefined || chatId === null) {
        return getActiveChatId() || '';
    }
    return String(chatId).trim();
}

function getRecordsStatesMap(settings, chatId) {
    const records = getChatScriptRecords(settings, chatId);
    const statesById = {};
    for (const [scriptId, record] of Object.entries(records)) {
        if (record && record.state !== null && record.state !== undefined) {
            statesById[scriptId] = record.state;
        }
    }
    return statesById;
}

function buildPersistPatchFromRecord(existingRecord, { state, hasPortraitUrl, portraitUrl, error } = {}) {
    const patch = {};
    if (state !== undefined) {
        patch.state = state;
    }
    if (hasPortraitUrl) {
        patch.portraitUrl = portraitUrl ?? '';
    } else if (existingRecord && existingRecord.portraitUrl) {
        patch.portraitUrl = existingRecord.portraitUrl;
    }
    if (error !== undefined) {
        patch.lastError = error || null;
    }
    return patch;
}

function ensureSettingsMemoString(settings) {
    if (!settings || typeof settings !== 'object') return '';
    if (typeof settings.currentMemo !== 'string') {
        settings.currentMemo = settings.currentMemo == null ? '' : String(settings.currentMemo);
    }
    return settings.currentMemo;
}

function resolvePriorMemoFallback(settings, priorMemo) {
    if (typeof priorMemo === 'string' && priorMemo.length > 0) {
        return priorMemo;
    }
    if (!Array.isArray(settings?.memoHistory) || settings.memoHistory.length === 0) {
        return '';
    }
    const lastEntry = settings.memoHistory[settings.memoHistory.length - 1];
    if (typeof lastEntry === 'string') {
        return lastEntry;
    }
    if (lastEntry && typeof lastEntry === 'object' && typeof lastEntry.memo === 'string') {
        return lastEntry.memo;
    }
    return '';
}

function extractTimeBlockStr(memo) {
    if (typeof memo !== 'string' || !memo) return '';
    try {
        const blocks = parseMemoBlocks(memo);
        const timeBlock = blocks?.TIME;
        return timeBlock ? extractCurrentTimeStr(timeBlock) : '';
    } catch (_) {
        const match = memo.match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
        return match ? extractCurrentTimeStr(match[1]) : '';
    }
}

function findScriptOwningTag(tag, settings = getSettings(), chatId = getActiveChatId()) {
    const cleanTag = sanitizeTrackerTag(tag);
    if (!cleanTag) return null;
    const scripts = getActiveChatScripts(settings, chatId);
    for (const script of scripts) {
        if (sanitizeTrackerTag(script?.trackerTag) === cleanTag) {
            return script;
        }
    }
    return null;
}

function buildRunnerOpts(settings) {
    const opts = {};
    if (settings?.gameScriptPyodideIndexUrl !== undefined) {
        opts.pyodideIndexUrl = settings.gameScriptPyodideIndexUrl;
    }
    if (settings?.gameScriptPyodideBootTimeoutMs !== undefined) {
        opts.bootTimeoutMs = settings.gameScriptPyodideBootTimeoutMs;
    }
    return opts;
}

async function handleToolInvocation(scriptId, rawArgs) {
    const settings = getSettings();
    const chatId = getActiveChatId();
    const activeScripts = getActiveChatScripts(settings, chatId);
    const script = activeScripts.find(s => s.id === scriptId) || getScriptById(settings, scriptId);

    if (!script) {
        return JSON.stringify({ ok: false, error: `Script "${scriptId}" is not found or unavailable.` });
    }

    const safeRaw = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? rawArgs : {};
    const action = safeRaw.action;
    const args = { ...safeRaw };
    delete args.action;

    const sameActiveTurn = _activeTurn && (!_activeTurn.chatId || !chatId || _activeTurn.chatId === String(chatId));
    const ledger = sameActiveTurn ? _activeTurn.ledger : createTurnLedger();
    const priorMemo = sameActiveTurn ? (_activeTurn.priorMemo || '') : '';

    const existingRecord = getChatScriptRecord(settings, chatId, script.id);
    const currentState = existingRecord ? existingRecord.state : null;
    const baseCtx = buildHostContext(settings, chatId, { priorMemo });
    const runnerOpts = buildRunnerOpts(settings);

    const res = await runScriptToolAction(
        script,
        currentState,
        action,
        args,
        baseCtx,
        ledger,
        runnerOpts,
    );

    if (chatId) {
        const patch = buildPersistPatchFromRecord(existingRecord, {
            state: res.state,
            hasPortraitUrl: res.hasPortraitUrl,
            portraitUrl: res.portraitUrl,
            error: res.ok ? null : (res.error || 'Tool action failed'),
        });
        setChatScriptRecord(settings, chatId, script.id, patch);
    }

    const trackerTag = sanitizeTrackerTag(script.trackerTag);
    if (trackerTag && res.memoBlock !== null && res.memoBlock !== undefined) {
        applyScriptMemoPatches(settings, { [trackerTag]: res.memoBlock });
    }

    saveSettingsSafe();
    return JSON.stringify(res.toolResult);
}

// ── Public Host Adapter API ───────────────────────────────────────────────────

/**
 * Safely reads the active character name from SillyTavern context.
 * @returns {string}
 */
export function getActiveCharacterName() {
    const ctx = getStContextSafe();
    if (!ctx) return '';
    const charId = ctx.characterId ?? ctx.this_chid;
    const charName = (charId != null && ctx.characters)
        ? ctx.characters[charId]?.name
        : undefined;
    const raw = charName ?? ctx.name2 ?? '';
    return typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
}

/**
 * Returns enabled normalized scripts for the active chat and character context.
 * @param {object} [settings=getSettings()]
 * @param {string|null} [chatId=getActiveChatId()]
 * @returns {Array<object>}
 */
export function getActiveChatScripts(settings = getSettings(), chatId = getActiveChatId()) {
    return resolveEnabledScriptsForChat(settings, chatId, getActiveCharacterName());
}

/**
 * Returns a `Set<string>` of uppercase tracker tags claimed by active scripts in this chat.
 * @param {object} [settings=getSettings()]
 * @param {string|null} [chatId=getActiveChatId()]
 * @returns {Set<string>}
 */
export function getClaimedScriptTagsForActiveChat(settings = getSettings(), chatId = getActiveChatId()) {
    return getClaimedScriptTags(settings, chatId, getActiveCharacterName());
}

/**
 * Applies script-rendered `[TAG]...[/TAG]` block patches onto `settings.currentMemo`.
 * Removes a tag block if `body === ''`. Notifies `_rpgUpdateUIMemo` when changed.
 *
 * @param {object} settings
 * @param {Record<string, string>} memoPatches
 * @returns {{ changed: boolean, memo: string }}
 */
export function applyScriptMemoPatches(settings, memoPatches) {
    if (!settings || typeof settings !== 'object') {
        return { changed: false, memo: '' };
    }

    const beforeMemo = ensureSettingsMemoString(settings);
    let nextMemo = beforeMemo;

    for (const [rawTag, rawBody] of Object.entries(memoPatches || {})) {
        const tag = sanitizeTrackerTag(rawTag);
        if (!tag) continue;

        const body = rawBody == null ? '' : String(rawBody).trim();
        const escaped = escapeRegex(tag);
        const existingRe = new RegExp(`\\s*\\[${escaped}\\][\\s\\S]*?\\[\\/${escaped}\\]`, 'gi');

        if (body === '') {
            if (existingRe.test(nextMemo)) {
                nextMemo = nextMemo.replace(existingRe, '').replace(/\n{3,}/g, '\n\n').trim();
            }
            continue;
        }

        const block = `[${tag}]\n${body}\n[/${tag}]`;
        if (existingRe.test(nextMemo)) {
            let replacedFirst = false;
            nextMemo = nextMemo
                .replace(existingRe, () => {
                    if (replacedFirst) return '';
                    replacedFirst = true;
                    return `\n\n${block}`;
                })
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        } else {
            nextMemo = nextMemo.trim()
                ? `${nextMemo.trimEnd()}\n\n${block}`
                : block;
        }
    }

    const changed = nextMemo !== beforeMemo;
    settings.currentMemo = nextMemo;

    if (changed) {
        try {
            globalThis._rpgUpdateUIMemo?.(settings.currentMemo);
        } catch (_) {
            // Best-effort UI sync
        }
    }

    return { changed, memo: settings.currentMemo };
}

/**
 * Builds the read-only host context payload passed into script hooks.
 *
 * @param {object} [settings=getSettings()]
 * @param {string|null} [chatId=getActiveChatId()]
 * @param {{ userMessage?: string, assistantMessage?: string, priorMemo?: string }} [options={}]
 * @returns {object}
 */
export function buildHostContext(
    settings = getSettings(),
    chatId = getActiveChatId(),
    { userMessage = '', assistantMessage = '', priorMemo = '' } = {},
) {
    const ctx = getStContextSafe();
    const currentMemo = typeof settings?.currentMemo === 'string' ? settings.currentMemo : '';
    const memoBlocks = parseMemoBlocks(currentMemo);

    const resolvedPriorMemo = resolvePriorMemoFallback(settings, priorMemo);
    const currentTimeStr = extractTimeBlockStr(currentMemo);
    const priorTimeStr = extractTimeBlockStr(resolvedPriorMemo);

    const currentMinutes = currentTimeStr ? parseInWorldTime(currentTimeStr) : null;
    const priorMinutes = priorTimeStr ? parseInWorldTime(priorTimeStr) : null;
    const bothValid = Number.isFinite(currentMinutes) && Number.isFinite(priorMinutes);

    const deltaMinutes = bothValid ? Math.max(0, currentMinutes - priorMinutes) : 0;
    const dayChanged = bothValid
        ? Math.floor(currentMinutes / 1440) > Math.floor(priorMinutes / 1440)
        : false;

    const userName = (typeof ctx?.name1 === 'string' && ctx.name1.trim())
        ? ctx.name1.trim()
        : 'User';

    return {
        userMessage: typeof userMessage === 'string' ? userMessage : String(userMessage ?? ''),
        assistantMessage: typeof assistantMessage === 'string' ? assistantMessage : String(assistantMessage ?? ''),
        memoBlocks,
        time: {
            current: currentTimeStr,
            prior: priorTimeStr,
            currentMinutes,
            priorMinutes,
            deltaMinutes,
            dayChanged,
        },
        character: { name: getActiveCharacterName() },
        user: { name: userName },
        chatId: resolveChatId(chatId),
    };
}

/**
 * Collects active scripts' GM prompt instructions (and concise tool hints when needed)
 * for injection into the narrator system prompt / context.
 *
 * @param {object} [settings=getSettings()]
 * @param {string|null} [chatId=getActiveChatId()]
 * @returns {string}
 */
export function buildActiveScriptsSyspromptBlock(settings = getSettings(), chatId = getActiveChatId()) {
    const scripts = getActiveChatScripts(settings, chatId);
    if (!scripts.length) return '';

    const blocks = [];
    for (const script of scripts) {
        const gmPrompt = typeof script?.gmPrompt === 'string' ? script.gmPrompt.trim() : '';
        const hasTool = Boolean(
            script?.toolEnabled &&
            Array.isArray(script?.toolActions) &&
            script.toolActions.some(a => a && typeof a.name === 'string' && a.name.trim().length > 0),
        );
        const toolName = hasTool ? deriveScriptToolName(script) : '';

        const parts = [];
        if (gmPrompt) {
            parts.push(gmPrompt);
        }
        if (hasTool && toolName && !gmPrompt.includes(toolName)) {
            const actionList = script.toolActions
                .map(a => String(a?.name ?? '').trim())
                .filter(Boolean)
                .join(', ');
            parts.push(`Registered tool \`${toolName}\` (actions: ${actionList}).`);
        }

        const combined = parts.join('\n').trim();
        if (combined) {
            blocks.push(combined);
        }
    }

    return blocks.join('\n\n');
}

/**
 * Synchronizes SillyTavern function tool registrations for active scripts in the current chat.
 *
 * @param {object} [settings=getSettings()]
 * @param {string|null} [chatId=getActiveChatId()]
 */
export function syncScriptToolRegistrations(settings = getSettings(), chatId = getActiveChatId()) {
    const ctx = getStContextSafe();
    const registerFn = ctx?.registerFunctionTool;
    const unregisterFn = ctx?.unregisterFunctionTool;

    if (typeof registerFn !== 'function' && typeof unregisterFn !== 'function') {
        _registeredScriptTools.clear();
        return;
    }

    const activeScripts = getActiveChatScripts(settings, chatId);
    const desired = [];
    const desiredNames = new Set();

    for (const script of activeScripts) {
        if (!script?.toolEnabled || !Array.isArray(script.toolActions) || script.toolActions.length === 0) {
            continue;
        }
        const schema = buildToolSchemaFromActions(script);
        if (!schema) continue;
        desired.push({ script, schema });
        desiredNames.add(schema.name);
    }

    for (const prevName of [..._registeredScriptTools]) {
        if (!desiredNames.has(prevName)) {
            try {
                unregisterFn?.(prevName);
            } catch (_) {
                // Best effort
            }
            _registeredScriptTools.delete(prevName);
        }
    }

    if (typeof registerFn !== 'function') {
        return;
    }

    for (const { script, schema } of desired) {
        try {
            unregisterFn?.(schema.name);
        } catch (_) {
            // Best effort
        }

        try {
            registerFn({
                name: schema.name,
                displayName: schema.displayName,
                description: schema.description,
                parameters: schema.parameters,
                formatMessage: () => '',
                action: async (rawArgs) => handleToolInvocation(script.id, rawArgs),
            });
            _registeredScriptTools.add(schema.name);
        } catch (err) {
            console.warn(`[RPG Tracker] Could not register script tool "${schema.name}":`, err);
        }
    }
}

/**
 * Ensures initial runtime state is seeded for a script in the given chat and
 * renders/patches its initial `[TAG]` memo block if non-empty.
 *
 * @param {object} settings
 * @param {string} chatId
 * @param {string} scriptId
 * @returns {Promise<{ ok: boolean, state: any, initialized: boolean, memoBlock: string|null, error: string|null }>}
 */
export async function seedInitialScriptStateForChat(settings, chatId, scriptId) {
    const cid = resolveChatId(chatId);
    const script = getScriptById(settings, scriptId);
    if (!settings || !cid || !script) {
        return { ok: false, state: null, initialized: false, memoBlock: null, error: 'Invalid script or chat' };
    }

    const existingRecord = getChatScriptRecord(settings, cid, script.id);
    const baseCtx = buildHostContext(settings, cid);
    const runnerOpts = buildRunnerOpts(settings);
    const initRes = await ensureScriptState(script, existingRecord?.state ?? null, baseCtx, runnerOpts);

    if (!initRes.ok) {
        setChatScriptRecord(settings, cid, script.id, {
            ...(existingRecord ? { portraitUrl: existingRecord.portraitUrl } : {}),
            lastError: initRes.error || 'Failed to initialize script state',
        });
        return { ok: false, state: existingRecord?.state ?? null, initialized: false, memoBlock: null, error: initRes.error };
    }

    let memoBlock = null;
    let renderError = null;
    const trackerTag = sanitizeTrackerTag(script.trackerTag);

    if (trackerTag) {
        const memoRes = await renderScriptMemo(script, initRes.state, baseCtx, runnerOpts);
        if (memoRes.ok) {
            memoBlock = memoRes.memoBlock;
            if (memoBlock && memoBlock.trim()) {
                applyScriptMemoPatches(settings, { [trackerTag]: memoBlock });
            }
        } else {
            renderError = memoRes.error || 'Failed to render initial script memo';
        }
    }

    setChatScriptRecord(settings, cid, script.id, {
        state: initRes.state,
        ...(existingRecord?.portraitUrl ? { portraitUrl: existingRecord.portraitUrl } : {}),
        lastError: renderError,
    });

    return {
        ok: renderError === null,
        state: initRes.state,
        initialized: initRes.initialized,
        memoBlock,
        error: renderError,
    };
}

/**
 * Synchronizes Python runner configuration (Pyodide index URL and boot timeout)
 * from extension settings.
 *
 * @param {object} [settings=getSettings()]
 * @returns {object|null}
 */
export function syncPythonRunnerConfig(settings = getSettings()) {
    return configureRunner('python', {
        pyodideIndexUrl: settings?.gameScriptPyodideIndexUrl,
        bootTimeoutMs: settings?.gameScriptPyodideBootTimeoutMs,
    });
}

/**
 * Returns the live status of the Python runner (state, indexUrl, lastError).
 * @returns {{ state: string, lastError: string|null, [key: string]: any }}
 */
export function getPythonRunnerStatus() {
    return getRunnerStatus('python');
}

/**
 * Runs active Game Scripts before LLM generation, persisting state updates and
 * memo patches and returning formatted `[SCRIPT_EVENT]` prompt injections and
 * command stripping results.
 *
 * @param {{ chat?: any[], lastUserMessage?: string, settings?: object, chatId?: string|null }} [options={}]
 * @returns {Promise<{
 *   ran: boolean,
 *   promptInjection: string,
 *   stripCommand: boolean,
 *   strippedMessage: string,
 *   memoPatches?: Record<string, string>,
 *   errors?: Array<{ scriptId: string, hook: string, error: string }>,
 * }>}
 */
export async function runHostScriptsBeforeGenerate({
    chat = [],
    lastUserMessage = '',
    settings = getSettings(),
    chatId = getActiveChatId(),
} = {}) {
    void chat;
    const cid = resolveChatId(chatId);
    const scripts = getActiveChatScripts(settings, cid);
    if (!scripts.length) {
        _activeTurn = null;
        return {
            ran: false,
            promptInjection: '',
            stripCommand: false,
            strippedMessage: lastUserMessage,
        };
    }

    const beforeSnapshot = captureScriptSnapshot(settings, cid);
    const priorMemo = typeof settings?.currentMemo === 'string' ? settings.currentMemo : '';
    const ledger = createTurnLedger();
    _activeTurn = {
        chatId: cid,
        ledger,
        beforeSnapshot,
        priorMemo,
    };

    const statesById = getRecordsStatesMap(settings, cid);
    const baseCtx = buildHostContext(settings, cid, {
        userMessage: lastUserMessage,
        priorMemo,
    });
    const runnerOpts = buildRunnerOpts(settings);

    const result = await runScriptsBeforeGenerate(scripts, statesById, baseCtx, ledger, runnerOpts);

    const errorsByScript = new Map();
    for (const err of result.errors || []) {
        if (!err?.scriptId) continue;
        if (!errorsByScript.has(err.scriptId)) {
            errorsByScript.set(err.scriptId, err.error || 'Script hook failed');
        }
    }

    const existingRecords = getChatScriptRecords(settings, cid);
    for (const script of scripts) {
        const sid = script.id;
        const hasUpdatedState = Object.prototype.hasOwnProperty.call(result.updatedStates, sid);
        const hasPortrait = Object.prototype.hasOwnProperty.call(result.portraitUrls, sid);
        const scriptError = errorsByScript.get(sid);

        if (!hasUpdatedState && !hasPortrait && scriptError === undefined) continue;

        const patch = buildPersistPatchFromRecord(existingRecords[sid], {
            state: hasUpdatedState ? result.updatedStates[sid] : existingRecords[sid]?.state,
            hasPortraitUrl: hasPortrait,
            portraitUrl: hasPortrait ? result.portraitUrls[sid] : undefined,
            error: scriptError ?? null,
        });
        setChatScriptRecord(settings, cid, sid, patch);
    }

    applyScriptMemoPatches(settings, result.memoPatches);

    const eventLines = [];
    for (const inj of result.promptInjections || []) {
        const text = typeof inj?.text === 'string' ? inj.text.trim() : '';
        if (!text) continue;
        const header = inj.scriptName ? `[${inj.scriptName}] ` : '';
        eventLines.push(`${header}${text}`);
    }

    const handledPreEntries = [];
    for (const [sid, entries] of Object.entries(ledger.handledInPreTurn || {})) {
        if (!Array.isArray(entries) || entries.length === 0) continue;
        const script = scripts.find(s => s.id === sid);
        const toolHint = script?.toolEnabled ? deriveScriptToolName(script) : '';
        for (const entry of entries) {
            const cmdLabel = entry?.subcommand || 'command';
            handledPreEntries.push(toolHint ? `${cmdLabel} (${toolHint})` : cmdLabel);
        }
    }

    if (handledPreEntries.length > 0) {
        eventLines.push(
            `Note: Pre-turn user command(s) already executed (${handledPreEntries.join(', ')}). Do not re-call the script tool to repeat them this turn.`,
        );
    }

    const promptInjection = eventLines.length > 0
        ? `[SCRIPT_EVENT]\n${eventLines.join('\n')}\n[/SCRIPT_EVENT]`
        : '';

    return {
        ran: true,
        promptInjection,
        stripCommand: Boolean(result.stripCommand),
        strippedMessage: result.strippedMessage,
        memoPatches: result.memoPatches,
        errors: result.errors,
    };
}

/**
 * Runs active Game Scripts after LLM generation, persists state/portrait/memo
 * updates, appends any non-duplicate markdown snippets onto `lastAiMsg`, and
 * stamps swipe rollback snapshots.
 *
 * @param {{ chat?: any[], lastAiMsg?: object|null, settings?: object, chatId?: string|null }} [options={}]
 * @returns {Promise<{
 *   ran: boolean,
 *   appendedMarkdown: string[],
 *   errors: Array<{ scriptId: string, hook: string, error: string }>,
 * }>}
 */
export async function runHostScriptsAfterGenerate({
    chat = [],
    lastAiMsg = null,
    settings = getSettings(),
    chatId = getActiveChatId(),
} = {}) {
    const cid = resolveChatId(chatId);
    const scripts = getActiveChatScripts(settings, cid);
    if (!scripts.length) {
        _activeTurn = null;
        return {
            ran: false,
            appendedMarkdown: [],
            errors: [],
        };
    }

    const sameTurn = _activeTurn && (!_activeTurn.chatId || !cid || _activeTurn.chatId === cid);
    const ledger = sameTurn ? _activeTurn.ledger : createTurnLedger();
    const beforeSnapshot = sameTurn ? _activeTurn.beforeSnapshot : captureScriptSnapshot(settings, cid);
    const priorMemo = sameTurn ? _activeTurn.priorMemo : '';

    const statesById = getRecordsStatesMap(settings, cid);
    const baseCtx = buildHostContext(settings, cid, {
        assistantMessage: typeof lastAiMsg?.mes === 'string' ? lastAiMsg.mes : '',
        priorMemo,
    });
    const runnerOpts = buildRunnerOpts(settings);

    const afterRes = await runScriptsAfterGenerate(scripts, statesById, baseCtx, ledger, runnerOpts);

    const errorsByScript = new Map();
    for (const err of afterRes.errors || []) {
        if (!err?.scriptId) continue;
        if (!errorsByScript.has(err.scriptId)) {
            errorsByScript.set(err.scriptId, err.error || 'Script hook failed');
        }
    }

    const existingRecords = getChatScriptRecords(settings, cid);
    for (const script of scripts) {
        const sid = script.id;
        const hasUpdatedState = Object.prototype.hasOwnProperty.call(afterRes.updatedStates, sid);
        const hasPortrait = Object.prototype.hasOwnProperty.call(afterRes.portraitUrls, sid);
        const scriptError = errorsByScript.get(sid);

        if (!hasUpdatedState && !hasPortrait && scriptError === undefined) continue;

        const patch = buildPersistPatchFromRecord(existingRecords[sid], {
            state: hasUpdatedState ? afterRes.updatedStates[sid] : existingRecords[sid]?.state,
            hasPortraitUrl: hasPortrait,
            portraitUrl: hasPortrait ? afterRes.portraitUrls[sid] : undefined,
            error: scriptError ?? null,
        });
        setChatScriptRecord(settings, cid, sid, patch);
    }

    applyScriptMemoPatches(settings, afterRes.memoPatches);

    const candidateMarkdowns = [];
    const seenSnippets = new Set();
    for (const entry of [
        ...(ledger.pendingAppendMarkdown || []),
        ...(afterRes.appendMarkdowns || []),
    ]) {
        const snippet = typeof entry?.markdown === 'string' ? entry.markdown.trim() : '';
        if (!snippet || seenSnippets.has(snippet)) continue;
        seenSnippets.add(snippet);
        candidateMarkdowns.push(snippet);
    }

    const appendedMarkdown = [];
    if (candidateMarkdowns.length > 0 && lastAiMsg && typeof lastAiMsg.mes === 'string') {
        const ctx = getStContextSafe();
        let messageModified = false;

        for (const snippet of candidateMarkdowns) {
            if (lastAiMsg.mes.includes(snippet)) continue;
            const baseText = lastAiMsg.mes.trimEnd();
            lastAiMsg.mes = baseText ? `${baseText}\n\n${snippet}` : snippet;
            appendedMarkdown.push(snippet);
            messageModified = true;
        }

        if (messageModified) {
            if (typeof lastAiMsg.content === 'string') {
                lastAiMsg.content = lastAiMsg.mes;
            }
            if (Array.isArray(lastAiMsg.swipes) && lastAiMsg.swipes.length > 0) {
                const swipeIdx = Math.max(0, Math.min(lastAiMsg.swipes.length - 1, Number(lastAiMsg.swipe_id) || 0));
                lastAiMsg.swipes[swipeIdx] = lastAiMsg.mes;
            }
            const chatArray = Array.isArray(chat) && chat.length > 0 ? chat : (Array.isArray(ctx?.chat) ? ctx.chat : []);
            const msgIndex = chatArray.indexOf(lastAiMsg);
            if (msgIndex >= 0 && typeof ctx?.updateMessageBlock === 'function') {
                try {
                    ctx.updateMessageBlock(msgIndex, lastAiMsg);
                } catch (_) {
                    // Best-effort UI message update
                }
            }
            if (typeof ctx?.saveChatDebounced === 'function') {
                try {
                    ctx.saveChatDebounced();
                } catch (_) {
                    // Best-effort chat save
                }
            }
        }
    }

    if (lastAiMsg) {
        const afterSnapshot = captureScriptSnapshot(settings, cid);
        stampScriptSwipeSnapshot(lastAiMsg, lastAiMsg?.swipe_id ?? 0, beforeSnapshot, afterSnapshot);
    }

    saveSettingsSafe();
    _activeTurn = null;

    return {
        ran: true,
        appendedMarkdown,
        errors: afterRes.errors || [],
    };
}

/**
 * Restores script state snapshots on swipe change and re-syncs active script
 * `[TAG]` memo blocks from restored state.
 *
 * @param {object} lastAiMsg
 * @param {object} [settings=getSettings()]
 * @param {string|null} [chatId=getActiveChatId()]
 * @returns {Promise<{ anyChanged: boolean }>}
 */
export async function handleHostScriptSwipeRollback(lastAiMsg, settings = getSettings(), chatId = getActiveChatId()) {
    const cid = resolveChatId(chatId);
    const { anyChanged } = restoreScriptSwipeSnapshot(lastAiMsg, settings, cid);
    if (!anyChanged) {
        return { anyChanged: false };
    }

    const scripts = getActiveChatScripts(settings, cid);
    const records = getChatScriptRecords(settings, cid);
    const baseCtx = buildHostContext(settings, cid);
    const runnerOpts = buildRunnerOpts(settings);
    const memoPatches = {};

    for (const script of scripts) {
        const trackerTag = sanitizeTrackerTag(script?.trackerTag);
        if (!trackerTag) continue;
        const record = records[script.id];
        if (!record || record.state === null || record.state === undefined) {
            memoPatches[trackerTag] = '';
            continue;
        }
        const memoRes = await renderScriptMemo(script, record.state, baseCtx, runnerOpts);
        if (memoRes.ok && memoRes.memoBlock !== null) {
            memoPatches[trackerTag] = memoRes.memoBlock;
        }
    }

    if (Object.keys(memoPatches).length > 0) {
        applyScriptMemoPatches(settings, memoPatches);
    }

    return { anyChanged: true };
}

/**
 * Re-synchronizes script tool registrations, Python runner configuration,
 * background warmup when Python scripts are active, and seeds initial state for
 * active tracker-backed scripts that have no state yet in the current chat.
 */
export async function onScriptChatChanged() {
    const settings = getSettings();
    const chatId = resolveChatId(getActiveChatId());

    syncPythonRunnerConfig(settings);
    syncScriptToolRegistrations(settings, chatId);

    if (!chatId) return;

    const scripts = getActiveChatScripts(settings, chatId);
    if (scripts.some((script) => String(script?.lang || '').trim().toLowerCase() === 'python')) {
        Promise.resolve(warmupRunner('python')).catch(() => {});
    }

    const existingRecords = getChatScriptRecords(settings, chatId);
    let seededAny = false;

    for (const script of scripts) {
        const trackerTag = sanitizeTrackerTag(script?.trackerTag);
        if (!trackerTag) continue;
        if (Object.prototype.hasOwnProperty.call(existingRecords, script.id)) continue;
        try {
            const res = await seedInitialScriptStateForChat(settings, chatId, script.id);
            if (res.initialized) {
                seededAny = true;
            }
        } catch (err) {
            console.warn(`[RPG Tracker] Failed to seed initial state for script "${script.id}":`, err);
        }
    }

    if (seededAny) {
        saveSettingsSafe();
    }
}

/**
 * Registers the renderer script card metadata resolver, syncs Python runner
 * configuration, and synchronizes active script function tools on startup.
 */
export function initScriptHostAdapter() {
    const settings = getSettings();

    registerScriptCardMetaResolver((tag) => {
        const curSettings = getSettings();
        const chatId = getActiveChatId();
        const script = findScriptOwningTag(tag, curSettings, chatId);
        if (!script) return null;
        const record = chatId ? getChatScriptRecord(curSettings, chatId, script.id) : null;
        return {
            icon: script.icon || '',
            label: script.name || '',
            portraitUrl: record?.portraitUrl || '',
        };
    });

    syncPythonRunnerConfig(settings);
    syncScriptToolRegistrations();
}
