/**
 * script-wizard.js — AI Script Wizard orchestration, sandbox verification &
 * auto-repair loop, character card hydration, and Wizard/Iterate modals for
 * Combat-Multihog Phase 2 Game Scripts.
 *
 * Keeps imports clean (zero game-systems.js import) so headless Vitest tests
 * stay fast and free of heavy circular DOM dependencies.
 */

import {
    SCRIPT_LANGUAGES,
    SCRIPT_SCOPES,
    sanitizeTrackerTag,
    validateScriptDefinition,
} from './core/script-schema.js';
import {
    renderScriptMemo,
    runSandboxSimulation,
} from './core/script-engine.js';
import {
    SCRIPT_WIZARD_INTERACTION_MODES,
    buildScriptWizardDraftUserPrompt,
    buildScriptWizardIterateUserPrompt,
    buildScriptWizardSystemPrompt,
    extractCharacterCardSummary,
    parseScriptWizardResponse,
} from './script-wizard-prompts.js';
import {
    buildGameSystemWizardLoreContext,
    buildGameSystemWizardStoryContext,
} from '../game-system-wizard-context.js';
import {
    createCharacterCardHydrator,
    getCharacterCardField,
    isShallowCharacterCard,
} from '../../state/character-cards.js';
import { sendStateRequest } from '../../../llm-client.js';
import { memoForGmContext } from '../../../memo-processor.js';
import { getSettings } from '../../../state-manager.js';
import { getSettingsOverlayAppearance } from '../../ui/settings-overlay.js';

const WIZARD_OVERLAY_ID = 'rt-script-wizard-overlay';
const ITERATE_OVERLAY_ID = 'rt-script-iterate-overlay';
const WIZARD_STYLE_ID = 'rt-script-wizard-styles';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function uniqueStrings(list) {
    const out = [];
    const seen = new Set();
    for (const item of list || []) {
        const clean = String(item ?? '').trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
    }
    return out;
}

function normalizeWizardLang(lang) {
    const clean = String(lang ?? 'js').trim().toLowerCase();
    return clean === 'python' ? 'python' : 'js';
}

function normalizeInteractionMode(mode) {
    const clean = String(mode ?? 'both').trim().toLowerCase();
    return SCRIPT_WIZARD_INTERACTION_MODES.includes(clean) ? clean : 'both';
}

function createAbortError(message = 'Operation aborted.') {
    if (typeof DOMException === 'function') {
        return new DOMException(message, 'AbortError');
    }
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
}

function isAbortError(err) {
    return Boolean(err && (err.name === 'AbortError' || err.code === 20));
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

function getStContextSafe(overrideCtx = null) {
    if (overrideCtx && typeof overrideCtx === 'object') {
        return overrideCtx;
    }
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch (_) {
        return null;
    }
}

function getSettingsSafe(overrideSettings = null) {
    if (overrideSettings && typeof overrideSettings === 'object') {
        return overrideSettings;
    }
    try {
        return getSettings() || {};
    } catch (_) {
        return {};
    }
}

function getAppearanceSafe() {
    try {
        return getSettingsOverlayAppearance() === 'dark' ? 'dark' : 'light';
    } catch (_) {
        return 'dark';
    }
}

function tryParseScriptObject(scriptOrJson) {
    if (!scriptOrJson) return null;
    if (typeof scriptOrJson === 'object' && !Array.isArray(scriptOrJson)) {
        return scriptOrJson;
    }
    if (typeof scriptOrJson === 'string') {
        try {
            const parsed = JSON.parse(scriptOrJson);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch (_) {
            return null;
        }
    }
    return null;
}

function inferInteractionModeFromScript(scriptObj) {
    if (!scriptObj || typeof scriptObj !== 'object') return 'both';
    const hasPrefix = Boolean(String(scriptObj.commandPrefix ?? '').trim());
    const hasTool = Boolean(scriptObj.toolEnabled);
    if (hasPrefix && hasTool) return 'both';
    if (hasTool && !hasPrefix) return 'tools';
    if (hasPrefix && !hasTool) return 'commands';
    return 'both';
}

/**
 * Persona / player names that must not be baked into wizard output (use `{{user}}` instead).
 * Mirrors `game-systems.js` without importing it.
 *
 * @returns {Promise<string[]>}
 */
async function getPlayerMacroReplacementNames() {
    const names = new Set();
    try {
        const ctx = getStContextSafe();
        if (typeof ctx?.name1 === 'string' && ctx.name1.trim()) {
            names.add(ctx.name1.trim());
        }
    } catch (_) {
        // Optional in headless environments
    }
    try {
        const script = await import('../../../../../../../script.js');
        if (typeof script?.name1 === 'string' && script.name1.trim()) {
            names.add(script.name1.trim());
        }
    } catch (_) {
        // Optional in headless environments
    }
    try {
        const [{ user_avatar }, { power_user }] = await Promise.all([
            import('../../../../../../personas.js'),
            import('../../../../../../power-user.js'),
        ]);
        const personaName = user_avatar ? String(power_user?.personas?.[user_avatar] ?? '').trim() : '';
        if (personaName) {
            names.add(personaName);
        }
    } catch (_) {
        // Optional in headless environments
    }
    return [...names];
}

function buildValidationFromParse(parsed, extraErrors = []) {
    const errors = uniqueStrings([...(parsed?.errors || []), ...extraErrors]);
    const warnings = uniqueStrings(parsed?.warnings || []);
    return {
        valid: Boolean(parsed?.ok) && errors.length === 0,
        errors,
        warnings,
    };
}

function normalizeRawRequestOutput(rawResponse) {
    if (typeof rawResponse === 'string') return rawResponse;
    if (rawResponse && typeof rawResponse === 'object' && typeof rawResponse.raw === 'string') {
        return rawResponse.raw;
    }
    return rawResponse == null ? '' : String(rawResponse);
}

/**
 * Builds the LLM connection overlay reading `gameSystemWizard*` keys from `settings`
 * (reusing the same connection slot as the Game System Wizard).
 *
 * @param {object} [settings]
 * @returns {{
 *   connectionSource: string,
 *   connectionProfileId: string,
 *   completionPresetId: string,
 *   ollamaUrl: string,
 *   ollamaModel: string,
 *   openaiUrl: string,
 *   openaiKey: string,
 *   openaiModel: string,
 *   maxTokens: number|undefined,
 *   debugMode: boolean|undefined,
 * }}
 */
export function getScriptWizardConnectionSettings(settings) {
    const s = getSettingsSafe(settings);
    return {
        connectionSource: s.gameSystemWizardConnectionSource || 'default',
        connectionProfileId: s.gameSystemWizardConnectionProfileId || '',
        completionPresetId: s.gameSystemWizardCompletionPresetId || '',
        ollamaUrl: s.gameSystemWizardOllamaUrl || 'http://localhost:11434',
        ollamaModel: s.gameSystemWizardOllamaModel || '',
        openaiUrl: s.gameSystemWizardOpenaiUrl || '',
        openaiKey: s.gameSystemWizardOpenaiKey || '',
        openaiModel: s.gameSystemWizardOpenaiModel || '',
        maxTokens: s.maxTokens,
        debugMode: s.debugMode,
    };
}

/**
 * Validates a script definition and executes `initState` + `onBeforeGenerate`
 * (and `renderMemo` when `trackerTag` is set) inside the sandbox simulator.
 *
 * @param {object|null|undefined} script
 * @returns {Promise<{
 *   ok: boolean,
 *   validation: { valid: boolean, errors: string[], warnings: string[] },
 *   sandboxErrors: string[],
 *   statePreview: any,
 *   memoPreview: string|null,
 * }>}
 */
export async function verifyScriptDraftInSandbox(script) {
    const validation = validateScriptDefinition(script);
    if (!validation.valid) {
        return {
            ok: false,
            validation,
            sandboxErrors: [],
            statePreview: null,
            memoPreview: null,
        };
    }

    const sandboxErrors = [];
    let statePreview = null;
    let memoPreview = null;

    let initRes;
    try {
        initRes = await runSandboxSimulation(script, null, { type: 'init' });
    } catch (err) {
        initRes = {
            ok: false,
            state: null,
            memoBlock: null,
            error: err?.message || String(err),
        };
    }

    if (!initRes?.ok) {
        sandboxErrors.push(initRes?.error || 'initState() execution failed in sandbox.');
        return {
            ok: false,
            validation,
            sandboxErrors,
            statePreview: null,
            memoPreview: null,
        };
    }

    statePreview = initRes.state ?? null;
    if (initRes.memoBlock !== null && initRes.memoBlock !== undefined) {
        memoPreview = initRes.memoBlock;
    }

    let preRes;
    try {
        preRes = await runSandboxSimulation(script, initRes.state, {
            type: 'beforeGenerate',
            userMessage: 'Hello.',
        });
    } catch (err) {
        preRes = {
            ok: false,
            state: initRes.state,
            memoBlock: null,
            error: err?.message || String(err),
        };
    }

    if (!preRes?.ok) {
        sandboxErrors.push(preRes?.error || 'onBeforeGenerate() execution failed in sandbox.');
    } else {
        statePreview = preRes.state ?? statePreview;
        if (preRes.memoBlock !== null && preRes.memoBlock !== undefined) {
            memoPreview = preRes.memoBlock;
        }
    }

    const trackerTag = sanitizeTrackerTag(script?.trackerTag);
    if (trackerTag && preRes?.ok && memoPreview === null) {
        try {
            const simScript = {
                ...script,
                id: String(script?.id ?? '').trim() || 'sandbox_script',
            };
            const memoRes = await renderScriptMemo(simScript, statePreview, { userMessage: 'Hello.' });
            if (!memoRes?.ok) {
                sandboxErrors.push(memoRes?.error || 'renderMemo() execution failed in sandbox.');
            } else if (memoRes.memoBlock !== null && memoRes.memoBlock !== undefined) {
                memoPreview = memoRes.memoBlock;
            }
        } catch (err) {
            sandboxErrors.push(err?.message || String(err));
        }
    }

    return {
        ok: Boolean(validation.valid && sandboxErrors.length === 0),
        validation,
        sandboxErrors,
        statePreview,
        memoPreview,
    };
}

/**
 * Pure orchestrator for drafting a new Game Script with an LLM, validating and
 * running it in the sandbox, and performing up to 1 automatic self-repair pass.
 *
 * @param {{
 *   settings?: object,
 *   description?: string,
 *   characterCard?: object|null,
 *   characterName?: string,
 *   lang?: 'js'|'python',
 *   interactionMode?: 'both'|'tools'|'commands',
 *   includeStory?: boolean,
 *   includeLore?: boolean,
 *   includeMemo?: boolean,
 *   autoRepair?: boolean,
 *   signal?: AbortSignal|null,
 *   onStatus?: ((message: string) => void)|null,
 *   sendRequest?: ((systemPrompt: string, userPrompt: string, signal: AbortSignal|null) => Promise<string>)|null,
 * }} [options={}]
 * @returns {Promise<{
 *   ok: boolean,
 *   script: object|null,
 *   validation: { valid: boolean, errors: string[], warnings: string[] },
 *   sandboxCheck: { ok: boolean, validation: object, sandboxErrors: string[], statePreview: any, memoPreview: string|null },
 *   repaired: boolean,
 *   attempts: number,
 *   warnings: string[],
 *   errors: string[],
 * }>}
 */
export async function draftScriptWithAi(options = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    const settings = getSettingsSafe(opts.settings);
    const description = String(opts.description ?? '').trim();
    const characterCard = opts.characterCard && typeof opts.characterCard === 'object' ? opts.characterCard : null;
    const lang = normalizeWizardLang(opts.lang);
    const interactionMode = normalizeInteractionMode(opts.interactionMode);
    const includeStory = Boolean(opts.includeStory);
    const includeLore = Boolean(opts.includeLore);
    const includeMemo = Boolean(opts.includeMemo);
    const autoRepair = opts.autoRepair !== false;
    const signal = opts.signal ?? null;
    const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
    const customSendRequest = typeof opts.sendRequest === 'function' ? opts.sendRequest : null;

    throwIfAborted(signal);

    const cardSummary = characterCard
        ? extractCharacterCardSummary(characterCard)
        : { name: '', text: '', truncated: false };
    const characterCardSummary = cardSummary.text || '';
    const resolvedCharName = String(opts.characterName || cardSummary.name || '').trim();

    let storyContext = '';
    if (includeStory) {
        try {
            const ctx = getStContextSafe();
            const storySettings = (
                Number(settings?.gameSystemWizardLookback) === 0 &&
                !settings?.gameSystemWizardLookbackAll
            )
                ? { ...settings, gameSystemWizardLookback: 10 }
                : settings;
            storyContext = buildGameSystemWizardStoryContext(ctx?.chat, storySettings) || '';
        } catch (_) {
            storyContext = '';
        }
    }

    let loreContext = '';
    if (includeLore) {
        try {
            const ctx = getStContextSafe();
            loreContext = await buildGameSystemWizardLoreContext(
                { ...settings, gameSystemWizardInjectLore: true },
                ctx,
            ) || '';
        } catch (_) {
            loreContext = '';
        }
    }

    let currentMemo = '';
    if (includeMemo && typeof settings?.currentMemo === 'string' && settings.currentMemo.trim()) {
        try {
            currentMemo = memoForGmContext(settings.currentMemo).trim();
        } catch (_) {
            currentMemo = '';
        }
    }

    const systemPrompt = buildScriptWizardSystemPrompt({ lang, interactionMode });
    const userPrompt = buildScriptWizardDraftUserPrompt({
        description,
        characterCardSummary,
        characterName: resolvedCharName,
        storyContext,
        loreContext,
        currentMemo,
        lang,
        interactionMode,
    });

    const parseOptions = {
        fallbackLang: lang,
        fallbackScope: resolvedCharName ? 'character' : 'chat',
        fallbackBoundCharacters: resolvedCharName ? [resolvedCharName] : [],
    };

    const invokeRequest = customSendRequest
        ? (sys, usr, abortSignal) => customSendRequest(sys, usr, abortSignal)
        : async (sys, usr, abortSignal) => {
            const userMacroNames = await getPlayerMacroReplacementNames();
            return sendStateRequest(
                getScriptWizardConnectionSettings(settings),
                sys,
                usr,
                abortSignal,
                { preserveUserMacro: true, userMacroNames, debugSource: 'Script Wizard' },
            );
        };

    onStatus?.('Drafting Game Script with AI...');
    throwIfAborted(signal);

    const raw = normalizeRawRequestOutput(await invokeRequest(systemPrompt, userPrompt, signal));
    throwIfAborted(signal);

    onStatus?.('Validating & testing script in sandbox...');
    let parsed = parseScriptWizardResponse(raw, parseOptions);
    let langMismatchErrors = (parsed.ok && parsed.script && parsed.script.lang !== lang)
        ? [`Expected target language "${lang}", but generated script had lang "${parsed.script.lang}".`]
        : [];

    let validation = buildValidationFromParse(parsed, langMismatchErrors);
    let sandboxCheck = (parsed.ok && parsed.script && langMismatchErrors.length === 0)
        ? await verifyScriptDraftInSandbox(parsed.script)
        : {
            ok: false,
            validation,
            sandboxErrors: [],
            statePreview: null,
            memoPreview: null,
        };

    let attempts = 1;
    let repaired = false;

    const needsRepair = !parsed.ok || langMismatchErrors.length > 0 || !sandboxCheck.ok;
    if (needsRepair && autoRepair && !signal?.aborted) {
        onStatus?.('Validation issues found — running automatic self-repair pass...');

        const combinedValidationErrors = uniqueStrings([
            ...parsed.errors,
            ...langMismatchErrors,
            ...(sandboxCheck?.validation?.errors || []),
        ]);
        const combinedSandboxErrors = uniqueStrings(sandboxCheck?.sandboxErrors || []);

        const repairInstruction = (!parsed.script && !parsed.rawJson && description)
            ? `Fix all validation and runtime sandbox errors while preserving all requested mechanics. Original brief: ${description}`
            : 'Fix all validation and runtime sandbox errors while preserving all requested mechanics.';

        const repairUserPrompt = buildScriptWizardIterateUserPrompt({
            currentScript: parsed.script || parsed.rawJson || {},
            instruction: repairInstruction,
            validationErrors: combinedValidationErrors,
            sandboxErrors: combinedSandboxErrors,
            targetLang: lang,
        });

        attempts += 1;
        throwIfAborted(signal);
        const repairRaw = normalizeRawRequestOutput(await invokeRequest(systemPrompt, repairUserPrompt, signal));
        throwIfAborted(signal);

        onStatus?.('Re-validating repaired script in sandbox...');
        const repairParsed = parseScriptWizardResponse(repairRaw, parseOptions);
        const repairLangErrors = (repairParsed.ok && repairParsed.script && repairParsed.script.lang !== lang)
            ? [`Expected target language "${lang}", but generated script had lang "${repairParsed.script.lang}".`]
            : [];
        const repairValidation = buildValidationFromParse(repairParsed, repairLangErrors);
        const repairSandboxCheck = (repairParsed.ok && repairParsed.script && repairLangErrors.length === 0)
            ? await verifyScriptDraftInSandbox(repairParsed.script)
            : {
                ok: false,
                validation: repairValidation,
                sandboxErrors: [],
                statePreview: null,
                memoPreview: null,
            };

        parsed = repairParsed;
        langMismatchErrors = repairLangErrors;
        validation = repairSandboxCheck.validation || repairValidation;
        sandboxCheck = repairSandboxCheck;
        repaired = Boolean(parsed.ok && langMismatchErrors.length === 0 && sandboxCheck.ok);
    }

    const finalValidation = sandboxCheck?.validation || validation;
    const errors = uniqueStrings([
        ...(parsed.errors || []),
        ...langMismatchErrors,
        ...(finalValidation?.errors || []),
        ...(sandboxCheck?.sandboxErrors || []),
    ]);
    const warnings = uniqueStrings([
        ...(parsed.warnings || []),
        ...(finalValidation?.warnings || []),
    ]);
    const ok = Boolean(parsed.ok && langMismatchErrors.length === 0 && sandboxCheck?.ok && errors.length === 0);

    return {
        ok,
        script: parsed.script || null,
        validation: finalValidation,
        sandboxCheck,
        repaired,
        attempts,
        warnings,
        errors,
    };
}

/**
 * Iterates on, repairs, or converts (`js` <-> `python`) an existing Game Script
 * using an LLM, validates & tests in sandbox, and performs up to 1 auto-repair pass.
 *
 * @param {{
 *   settings?: object,
 *   currentScript: object|string,
 *   instruction?: string,
 *   targetLang?: ''|'js'|'python',
 *   validationErrors?: string[],
 *   sandboxErrors?: string[],
 *   autoRepair?: boolean,
 *   signal?: AbortSignal|null,
 *   onStatus?: ((message: string) => void)|null,
 *   sendRequest?: ((systemPrompt: string, userPrompt: string, signal: AbortSignal|null) => Promise<string>)|null,
 * }} [options={}]
 * @returns {Promise<{
 *   ok: boolean,
 *   script: object|null,
 *   validation: { valid: boolean, errors: string[], warnings: string[] },
 *   sandboxCheck: { ok: boolean, validation: object, sandboxErrors: string[], statePreview: any, memoPreview: string|null },
 *   repaired: boolean,
 *   attempts: number,
 *   warnings: string[],
 *   errors: string[],
 * }>}
 */
export async function iterateScriptWithAi(options = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    const settings = getSettingsSafe(opts.settings);
    const currentScript = opts.currentScript;
    const parsedCurrent = tryParseScriptObject(currentScript);
    const instruction = String(opts.instruction ?? '').trim();
    const rawTargetLang = String(opts.targetLang ?? '').trim().toLowerCase();
    const explicitTargetLang = SCRIPT_LANGUAGES.includes(rawTargetLang) ? rawTargetLang : '';
    const resolvedLang = normalizeWizardLang(explicitTargetLang || parsedCurrent?.lang || 'js');
    const validationErrors = Array.isArray(opts.validationErrors) ? opts.validationErrors : [];
    const sandboxErrors = Array.isArray(opts.sandboxErrors) ? opts.sandboxErrors : [];
    const autoRepair = opts.autoRepair !== false;
    const signal = opts.signal ?? null;
    const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
    const customSendRequest = typeof opts.sendRequest === 'function' ? opts.sendRequest : null;

    throwIfAborted(signal);

    const interactionMode = inferInteractionModeFromScript(parsedCurrent);
    const systemPrompt = buildScriptWizardSystemPrompt({
        lang: resolvedLang,
        interactionMode,
    });
    const userPrompt = buildScriptWizardIterateUserPrompt({
        currentScript: currentScript ?? {},
        instruction,
        validationErrors,
        sandboxErrors,
        targetLang: resolvedLang,
    });

    const rawCurrentScope = String(parsedCurrent?.scope ?? '').trim().toLowerCase();
    const fallbackScope = SCRIPT_SCOPES.includes(rawCurrentScope) ? rawCurrentScope : 'chat';
    const fallbackBoundCharacters = Array.isArray(parsedCurrent?.boundCharacters)
        ? parsedCurrent.boundCharacters.map((c) => String(c ?? '').trim()).filter(Boolean)
        : [];

    const parseOptions = {
        fallbackLang: resolvedLang,
        fallbackScope,
        fallbackBoundCharacters,
    };

    const invokeRequest = customSendRequest
        ? (sys, usr, abortSignal) => customSendRequest(sys, usr, abortSignal)
        : async (sys, usr, abortSignal) => {
            const userMacroNames = await getPlayerMacroReplacementNames();
            return sendStateRequest(
                getScriptWizardConnectionSettings(settings),
                sys,
                usr,
                abortSignal,
                { preserveUserMacro: true, userMacroNames, debugSource: 'Script Wizard' },
            );
        };

    onStatus?.('Updating Game Script with AI...');
    throwIfAborted(signal);

    const raw = normalizeRawRequestOutput(await invokeRequest(systemPrompt, userPrompt, signal));
    throwIfAborted(signal);

    onStatus?.('Validating & testing updated script in sandbox...');
    let parsed = parseScriptWizardResponse(raw, parseOptions);
    let langMismatchErrors = (
        explicitTargetLang &&
        parsed.ok &&
        parsed.script &&
        parsed.script.lang !== resolvedLang
    )
        ? [`Expected target language "${resolvedLang}", but updated script had lang "${parsed.script.lang}".`]
        : [];

    let validation = buildValidationFromParse(parsed, langMismatchErrors);
    let sandboxCheck = (parsed.ok && parsed.script && langMismatchErrors.length === 0)
        ? await verifyScriptDraftInSandbox(parsed.script)
        : {
            ok: false,
            validation,
            sandboxErrors: [],
            statePreview: null,
            memoPreview: null,
        };

    let attempts = 1;
    let repaired = false;

    const needsRepair = !parsed.ok || langMismatchErrors.length > 0 || !sandboxCheck.ok;
    if (needsRepair && autoRepair && !signal?.aborted) {
        onStatus?.('Validation issues found — running automatic self-repair pass...');

        const combinedValidationErrors = uniqueStrings([
            ...parsed.errors,
            ...langMismatchErrors,
            ...(sandboxCheck?.validation?.errors || []),
        ]);
        const combinedSandboxErrors = uniqueStrings(sandboxCheck?.sandboxErrors || []);

        const repairUserPrompt = buildScriptWizardIterateUserPrompt({
            currentScript: parsed.script || parsed.rawJson || currentScript || {},
            instruction: 'Fix all validation and runtime sandbox errors while preserving all requested mechanics.',
            validationErrors: combinedValidationErrors,
            sandboxErrors: combinedSandboxErrors,
            targetLang: resolvedLang,
        });

        attempts += 1;
        throwIfAborted(signal);
        const repairRaw = normalizeRawRequestOutput(await invokeRequest(systemPrompt, repairUserPrompt, signal));
        throwIfAborted(signal);

        onStatus?.('Re-validating repaired script in sandbox...');
        const repairParsed = parseScriptWizardResponse(repairRaw, parseOptions);
        const repairLangErrors = (
            explicitTargetLang &&
            repairParsed.ok &&
            repairParsed.script &&
            repairParsed.script.lang !== resolvedLang
        )
            ? [`Expected target language "${resolvedLang}", but updated script had lang "${repairParsed.script.lang}".`]
            : [];
        const repairValidation = buildValidationFromParse(repairParsed, repairLangErrors);
        const repairSandboxCheck = (repairParsed.ok && repairParsed.script && repairLangErrors.length === 0)
            ? await verifyScriptDraftInSandbox(repairParsed.script)
            : {
                ok: false,
                validation: repairValidation,
                sandboxErrors: [],
                statePreview: null,
                memoPreview: null,
            };

        parsed = repairParsed;
        langMismatchErrors = repairLangErrors;
        validation = repairSandboxCheck.validation || repairValidation;
        sandboxCheck = repairSandboxCheck;
        repaired = Boolean(parsed.ok && langMismatchErrors.length === 0 && sandboxCheck.ok);
    }

    const finalValidation = sandboxCheck?.validation || validation;
    const errors = uniqueStrings([
        ...(parsed.errors || []),
        ...langMismatchErrors,
        ...(finalValidation?.errors || []),
        ...(sandboxCheck?.sandboxErrors || []),
    ]);
    const warnings = uniqueStrings([
        ...(parsed.warnings || []),
        ...(finalValidation?.warnings || []),
    ]);
    const ok = Boolean(parsed.ok && langMismatchErrors.length === 0 && sandboxCheck?.ok && errors.length === 0);

    return {
        ok,
        script: parsed.script || null,
        validation: finalValidation,
        sandboxCheck,
        repaired,
        attempts,
        warnings,
        errors,
    };
}

/**
 * Hydrates the active character card from `ctx` if it is shallow (lazy-loaded),
 * returning the hydrated card or falling back safely to the raw card on failure.
 *
 * @param {object|null|undefined} [ctx]
 * @param {{ fetchImpl?: typeof fetch, getHeaders?: (() => Record<string, string>) | Record<string, string> }} [options={}]
 * @returns {Promise<object|null>}
 */
export async function hydrateActiveCharacterCard(ctx, options = {}) {
    const resolvedCtx = getStContextSafe(ctx);
    if (!resolvedCtx) return null;

    const charId = resolvedCtx.characterId ?? resolvedCtx.this_chid;
    const card = (charId != null && resolvedCtx.characters)
        ? resolvedCtx.characters[charId]
        : null;
    if (!card || typeof card !== 'object') {
        return null;
    }

    if (!isShallowCharacterCard(card)) {
        return card;
    }

    try {
        const getHeaders = options.getHeaders ?? (() => {
            if (typeof resolvedCtx.getRequestHeaders === 'function') {
                return resolvedCtx.getRequestHeaders() || {};
            }
            try {
                return globalThis.SillyTavern?.getContext?.()?.getRequestHeaders?.() || {};
            } catch (_) {
                return {};
            }
        });
        const hydrator = createCharacterCardHydrator({
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            getHeaders,
        });
        const hydrated = await hydrator.hydrate(card, { strict: false });
        return hydrated || card;
    } catch (_) {
        return card;
    }
}

function ensureWizardStyles() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById(WIZARD_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = WIZARD_STYLE_ID;
    style.textContent = `
        .rt-script-wizard-modal {
            width: min(680px, 95vw);
        }
        .rt-script-iterate-modal {
            width: min(620px, 95vw);
        }
        .rt-script-wizard-field {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .rt-script-wizard-grid-2 {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px;
        }
        @media (max-width: 600px) {
            .rt-script-wizard-grid-2 {
                grid-template-columns: 1fr;
            }
        }
        .rt-script-wizard-source-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .rt-script-wizard-source-opt {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            border-radius: 8px;
            border: 1px solid var(--rt-studio-border);
            background: var(--rt-studio-bg);
            color: var(--rt-studio-fg);
            cursor: pointer;
            font-size: 0.88em;
        }
        .rt-script-wizard-source-opt:hover {
            border-color: var(--rt-studio-accent);
        }
        .rt-script-wizard-checks {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 9px 11px;
            border-radius: 8px;
            border: 1px solid var(--rt-studio-border);
            background: var(--rt-studio-bg);
        }
        .rt-script-wizard-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        .rt-script-wizard-chip {
            appearance: none;
            padding: 4px 10px;
            border-radius: 999px;
            border: 1px solid var(--rt-studio-border);
            background: var(--rt-studio-btn-bg);
            color: var(--rt-studio-fg);
            font-size: 0.8em;
            font-weight: 500;
            cursor: pointer;
            transition: background-color 0.15s ease, border-color 0.15s ease;
        }
        .rt-script-wizard-chip:hover:not(:disabled) {
            background: var(--rt-studio-btn-hover);
            border-color: var(--rt-studio-accent);
        }
        .rt-script-wizard-chip:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .rt-script-wizard-status {
            padding: 9px 11px;
            border-radius: 8px;
            border: 1px solid var(--rt-studio-border);
            background: var(--rt-studio-bg);
            color: var(--rt-studio-fg);
            font-size: 0.83em;
            line-height: 1.45;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .rt-script-wizard-status.is-info {
            border-color: rgba(110, 168, 255, 0.45);
            background: rgba(110, 168, 255, 0.12);
        }
        .rt-script-wizard-status.is-warning {
            border-color: rgba(245, 166, 35, 0.45);
            background: rgba(245, 166, 35, 0.12);
        }
        .rt-script-wizard-status.is-error {
            border-color: rgba(224, 90, 90, 0.5);
            background: rgba(224, 90, 90, 0.12);
            color: #ffb8b8;
        }
        .rt-so-mode-light .rt-script-wizard-status.is-error {
            border-color: rgba(185, 36, 36, 0.4);
            background: rgba(220, 53, 69, 0.1);
            color: #8f1d1d;
        }
        .rt-script-wizard-status.is-success {
            border-color: rgba(46, 204, 113, 0.45);
            background: rgba(46, 204, 113, 0.12);
        }
    `;
    document.head.appendChild(style);
}

function renderStatusBox(statusEl, kind, messageHtml) {
    if (!statusEl) return;
    if (!messageHtml) {
        statusEl.style.display = 'none';
        statusEl.className = 'rt-script-wizard-status';
        statusEl.innerHTML = '';
        return;
    }
    statusEl.style.display = 'block';
    statusEl.className = `rt-script-wizard-status is-${kind || 'info'}`;
    statusEl.innerHTML = messageHtml;
}

/**
 * Opens the AI Game Script Wizard modal, appending it to `document.body`.
 * On successful generation, closes the modal and passes `(result.script, result)`
 * to `deps.onDraftReady` so it opens directly inside Script Studio.
 *
 * @param {{
 *   getSettings?: () => object,
 *   getContext?: () => object|null,
 *   hydrateActiveCharacterCard?: (ctx: object) => Promise<object|null>,
 *   sendRequest?: ((systemPrompt: string, userPrompt: string, signal: AbortSignal|null) => Promise<string>)|null,
 *   onDraftReady?: (script: object, result: object) => (void|Promise<void>),
 *   onCancel?: () => void,
 *   defaultLang?: 'js'|'python',
 * }} [deps={}]
 * @returns {{ close: () => void, abort: () => void } | null}
 */
export function openScriptWizardModal(deps = {}) {
    if (typeof document === 'undefined' || !document.body) {
        return null;
    }

    ensureWizardStyles();
    document.getElementById(WIZARD_OVERLAY_ID)?.remove();

    const getCtx = () => getStContextSafe(typeof deps?.getContext === 'function' ? deps.getContext() : null);
    const getLiveSettings = () => getSettingsSafe(typeof deps?.getSettings === 'function' ? deps.getSettings() : null);

    const initialCtx = getCtx();
    const initialCharId = initialCtx?.characterId ?? initialCtx?.this_chid;
    const activeCardRaw = (initialCharId != null && initialCtx?.characters)
        ? initialCtx.characters[initialCharId]
        : null;
    const activeCharName = String(
        getCharacterCardField(activeCardRaw, 'name') || initialCtx?.name2 || '',
    ).trim();

    let sourceMode = activeCardRaw ? 'active' : 'custom';
    let uploadedCard = null;
    let uploadedCardName = '';
    let isRunning = false;
    let closed = false;
    let activeController = null;

    const defaultLang = normalizeWizardLang(deps?.defaultLang || 'js');
    const appearance = getAppearanceSafe();

    const overlay = document.createElement('div');
    overlay.id = WIZARD_OVERLAY_ID;
    overlay.className = `rt-so-mode-${appearance}`;
    overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:10160',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:14px',
        'background:rgba(0,0,0,0.58)',
        'box-sizing:border-box',
    ].join(';');

    const modal = document.createElement('div');
    modal.className = `rt-script-studio-modal rt-script-wizard-modal rt-so-mode-${appearance}`;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'AI Game Script Wizard');

    const activeLabelSuffix = activeCharName
        ? `(${escapeHtml(activeCharName)})`
        : '(none selected)';

    modal.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                <span style="font-size:1.2em;">✨</span>
                <strong style="font-size:1em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">AI Game Script Wizard</strong>
            </div>
            <button type="button" id="rt-sw-close-x" class="menu_button interactable" title="Close (Esc)">✕</button>
        </div>

        <div class="rt-script-studio-pane">
            <div class="rt-script-wizard-field">
                <label style="font-size:0.84em;font-weight:600;">Source Material</label>
                <div class="rt-script-wizard-source-list">
                    <label class="rt-script-wizard-source-opt">
                        <input type="radio" name="rt_sw_source" value="active"${sourceMode === 'active' ? ' checked' : ''} />
                        <span><strong>Active Character Card</strong> <span style="opacity:0.75;">${activeLabelSuffix}</span></span>
                    </label>
                    <label class="rt-script-wizard-source-opt">
                        <input type="radio" name="rt_sw_source" value="upload"${sourceMode === 'upload' ? ' checked' : ''} />
                        <span><strong>Upload Character Card (.json)</strong> <span style="opacity:0.75;">V1 / V2 card JSON</span></span>
                    </label>
                    <label class="rt-script-wizard-source-opt">
                        <input type="radio" name="rt_sw_source" value="custom"${sourceMode === 'custom' ? ' checked' : ''} />
                        <span><strong>Custom Description Only</strong></span>
                    </label>
                </div>
                <div id="rt-sw-upload-row" style="display:none;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border-radius:6px;border:1px dashed var(--rt-studio-border);background:var(--rt-studio-bg);">
                    <input type="file" id="rt-sw-card-file" accept=".json,application/json" style="display:none;" />
                    <button type="button" id="rt-sw-card-pick-btn" class="menu_button interactable">Choose Card .json</button>
                    <span id="rt-sw-card-file-label" style="font-size:0.8em;opacity:0.78;">No character card file loaded.</span>
                </div>
            </div>

            <div class="rt-script-wizard-field">
                <label for="rt-sw-description" style="font-size:0.84em;font-weight:600;">
                    Description / Custom Rules
                    <span id="rt-sw-desc-hint" style="font-weight:400;opacity:0.72;"></span>
                </label>
                <textarea id="rt-sw-description" class="text_pole" rows="4" placeholder="Describe the RPG mechanics, meters, progression, !commands, or custom behavior to automate..."></textarea>
            </div>

            <div class="rt-script-wizard-grid-2">
                <div class="rt-script-wizard-field">
                    <label for="rt-sw-lang" style="font-size:0.84em;font-weight:600;">Target Language</label>
                    <select id="rt-sw-lang" class="text_pole">
                        <option value="js"${defaultLang === 'js' ? ' selected' : ''}>JavaScript (Sandboxed Worker)</option>
                        <option value="python"${defaultLang === 'python' ? ' selected' : ''}>Python (Pyodide)</option>
                    </select>
                </div>
                <div class="rt-script-wizard-field">
                    <label for="rt-sw-interaction" style="font-size:0.84em;font-weight:600;">Interaction Style</label>
                    <select id="rt-sw-interaction" class="text_pole">
                        <option value="both" selected>Both !commands &amp; Tool Calls</option>
                        <option value="tools">Natural RP Tool Calls Only</option>
                        <option value="commands">Explicit !commands Only</option>
                    </select>
                </div>
            </div>

            <div class="rt-script-wizard-checks">
                <label class="checkbox_label" style="margin:0;">
                    <input type="checkbox" id="rt-sw-inc-story" />
                    <span>Include recent chat messages</span>
                </label>
                <label class="checkbox_label" style="margin:0;">
                    <input type="checkbox" id="rt-sw-inc-lore" />
                    <span>Include active Lorebook entries</span>
                </label>
                <label class="checkbox_label" style="margin:0;">
                    <input type="checkbox" id="rt-sw-inc-memo" />
                    <span>Include current State Memo</span>
                </label>
                <label class="checkbox_label" style="margin:0;">
                    <input type="checkbox" id="rt-sw-auto-repair" checked />
                    <span>Auto-validate &amp; self-repair in sandbox</span>
                </label>
            </div>

            <div id="rt-sw-status" class="rt-script-wizard-status" role="status" aria-live="polite" style="display:none;"></div>
        </div>

        <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <button type="button" id="rt-sw-cancel" class="menu_button interactable">Cancel</button>
            <button type="button" id="rt-sw-generate" class="menu_button interactable" style="background:var(--rt-studio-accent);border-color:var(--rt-studio-accent);color:#fff;font-weight:600;">✨ Generate Script</button>
        </div>
    `;

    overlay.appendChild(modal);

    const statusEl = modal.querySelector('#rt-sw-status');
    const uploadRow = modal.querySelector('#rt-sw-upload-row');
    const fileInput = /** @type {HTMLInputElement|null} */ (modal.querySelector('#rt-sw-card-file'));
    const pickFileBtn = /** @type {HTMLButtonElement|null} */ (modal.querySelector('#rt-sw-card-pick-btn'));
    const fileLabelEl = modal.querySelector('#rt-sw-card-file-label');
    const descTa = /** @type {HTMLTextAreaElement|null} */ (modal.querySelector('#rt-sw-description'));
    const descHintEl = modal.querySelector('#rt-sw-desc-hint');
    const langSel = /** @type {HTMLSelectElement|null} */ (modal.querySelector('#rt-sw-lang'));
    const modeSel = /** @type {HTMLSelectElement|null} */ (modal.querySelector('#rt-sw-interaction'));
    const incStoryChk = /** @type {HTMLInputElement|null} */ (modal.querySelector('#rt-sw-inc-story'));
    const incLoreChk = /** @type {HTMLInputElement|null} */ (modal.querySelector('#rt-sw-inc-lore'));
    const incMemoChk = /** @type {HTMLInputElement|null} */ (modal.querySelector('#rt-sw-inc-memo'));
    const autoRepairChk = /** @type {HTMLInputElement|null} */ (modal.querySelector('#rt-sw-auto-repair'));
    const generateBtn = /** @type {HTMLButtonElement|null} */ (modal.querySelector('#rt-sw-generate'));
    const cancelBtn = /** @type {HTMLButtonElement|null} */ (modal.querySelector('#rt-sw-cancel'));
    const closeXBtn = /** @type {HTMLButtonElement|null} */ (modal.querySelector('#rt-sw-close-x'));

    function syncSourceUi() {
        if (uploadRow) {
            uploadRow.style.display = sourceMode === 'upload' ? 'flex' : 'none';
        }
        if (descHintEl) {
            descHintEl.textContent = sourceMode === 'custom'
                ? '(required)'
                : '(optional extra rules or focus)';
        }
    }

    function setBusyState(busy) {
        isRunning = busy;
        if (generateBtn) {
            generateBtn.disabled = busy;
            generateBtn.textContent = busy ? 'Generating...' : '✨ Generate Script';
        }
        modal.querySelectorAll('input[name="rt_sw_source"], #rt-sw-card-pick-btn, #rt-sw-description, #rt-sw-lang, #rt-sw-interaction, #rt-sw-inc-story, #rt-sw-inc-lore, #rt-sw-inc-memo, #rt-sw-auto-repair').forEach((el) => {
            if ('disabled' in el) {
                el.disabled = busy;
            }
        });
    }

    function closeModal(cancelled = false) {
        if (closed) return;
        closed = true;
        if (activeController) {
            try {
                activeController.abort();
            } catch (_) {
                // Ignore abort failures
            }
            activeController = null;
        }
        document.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        if (cancelled) {
            try {
                deps?.onCancel?.();
            } catch (_) {
                // Non-fatal
            }
        }
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeModal(true);
        }
    }

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeModal(true);
        }
    });
    document.addEventListener('keydown', onKeyDown, true);

    closeXBtn?.addEventListener('click', () => closeModal(true));
    cancelBtn?.addEventListener('click', () => closeModal(true));

    modal.querySelectorAll('input[name="rt_sw_source"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            if (/** @type {HTMLInputElement} */ (radio).checked) {
                sourceMode = /** @type {HTMLInputElement} */ (radio).value;
                renderStatusBox(statusEl, 'info', '');
                syncSourceUi();
            }
        });
    });

    pickFileBtn?.addEventListener('click', () => {
        if (!fileInput || isRunning) return;
        fileInput.value = '';
        fileInput.click();
    });

    fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const rawText = String(event?.target?.result || '');
            let parsed;
            try {
                parsed = JSON.parse(rawText);
            } catch (err) {
                uploadedCard = null;
                uploadedCardName = '';
                if (fileLabelEl) fileLabelEl.textContent = 'Invalid JSON file.';
                renderStatusBox(statusEl, 'error', `Failed to parse character card JSON: ${escapeHtml(err?.message || String(err))}`);
                return;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                uploadedCard = null;
                uploadedCardName = '';
                if (fileLabelEl) fileLabelEl.textContent = 'Invalid character card payload.';
                renderStatusBox(statusEl, 'error', 'Character card JSON must represent an object.');
                return;
            }
            const summary = extractCharacterCardSummary(parsed);
            if (!summary.name && !summary.text) {
                uploadedCard = null;
                uploadedCardName = '';
                if (fileLabelEl) fileLabelEl.textContent = 'Unrecognized card JSON.';
                renderStatusBox(statusEl, 'error', 'Uploaded JSON does not contain V1/V2 character card fields (name, description, scenario, etc.).');
                return;
            }
            uploadedCard = parsed;
            uploadedCardName = summary.name || file.name;
            if (fileLabelEl) {
                fileLabelEl.textContent = `Loaded: ${uploadedCardName} (${file.name})`;
            }
            renderStatusBox(statusEl, 'info', '');
        };
        reader.onerror = () => {
            renderStatusBox(statusEl, 'error', 'Failed to read the selected character card file.');
        };
        reader.readAsText(file);
        fileInput.value = '';
    });

    generateBtn?.addEventListener('click', async () => {
        if (isRunning || closed) return;

        const description = String(descTa?.value ?? '').trim();
        const lang = normalizeWizardLang(langSel?.value || 'js');
        const interactionMode = normalizeInteractionMode(modeSel?.value || 'both');
        const includeStory = Boolean(incStoryChk?.checked);
        const includeLore = Boolean(incLoreChk?.checked);
        const includeMemo = Boolean(incMemoChk?.checked);
        const autoRepair = autoRepairChk ? Boolean(autoRepairChk.checked) : true;

        if (sourceMode === 'custom' && !description) {
            renderStatusBox(statusEl, 'warning', 'Please enter a Description / Custom Rules prompt when using Custom Description Only.');
            descTa?.focus();
            return;
        }
        if (sourceMode === 'upload' && !uploadedCard) {
            renderStatusBox(statusEl, 'warning', 'Please upload a valid V1 or V2 character card .json file.');
            return;
        }
        if (sourceMode === 'active' && !activeCardRaw) {
            renderStatusBox(statusEl, 'warning', 'No active character card is selected. Choose Upload Character Card or Custom Description Only.');
            return;
        }

        const controller = new AbortController();
        activeController = controller;
        setBusyState(true);

        try {
            let characterCard = null;
            let characterName = '';

            if (sourceMode === 'active') {
                renderStatusBox(statusEl, 'info', 'Hydrating active character card...');
                const hydrateFn = typeof deps?.hydrateActiveCharacterCard === 'function'
                    ? deps.hydrateActiveCharacterCard
                    : hydrateActiveCharacterCard;
                characterCard = await hydrateFn(getCtx());
                if (closed || controller.signal.aborted) return;
                characterName = String(
                    getCharacterCardField(characterCard, 'name') || activeCharName || '',
                ).trim();
            } else if (sourceMode === 'upload') {
                characterCard = uploadedCard;
                characterName = String(
                    getCharacterCardField(uploadedCard, 'name') || uploadedCardName || '',
                ).trim();
            }

            const result = await draftScriptWithAi({
                settings: getLiveSettings(),
                description,
                characterCard,
                characterName,
                lang,
                interactionMode,
                includeStory,
                includeLore,
                includeMemo,
                autoRepair,
                signal: controller.signal,
                onStatus: (msg) => {
                    if (!closed && !controller.signal.aborted) {
                        renderStatusBox(statusEl, 'info', escapeHtml(msg));
                    }
                },
                sendRequest: deps?.sendRequest,
            });

            if (closed || controller.signal.aborted) return;

            if (result.ok && result.script) {
                closeModal(false);
                if (typeof deps?.onDraftReady === 'function') {
                    await deps.onDraftReady(result.script, result);
                }
                return;
            }

            const errLines = (result.errors?.length ? result.errors : ['Script generation failed validation.'])
                .map((e) => `• ${escapeHtml(e)}`)
                .join('\n');
            const warnLines = result.warnings?.length
                ? `\n\n<strong>Warnings:</strong>\n${result.warnings.map((w) => `• ${escapeHtml(w)}`).join('\n')}`
                : '';

            renderStatusBox(
                statusEl,
                'error',
                `<strong>Generation completed with errors (after ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}):</strong>\n${errLines}${warnLines}` +
                (result.script
                    ? '<div style="margin-top:8px;"><button type="button" id="rt-sw-open-anyway" class="menu_button interactable">Open Draft in Script Studio Anyway</button></div>'
                    : ''),
            );
            if (result.script) {
                statusEl?.querySelector('#rt-sw-open-anyway')?.addEventListener('click', async () => {
                    closeModal(false);
                    if (typeof deps?.onDraftReady === 'function') {
                        await deps.onDraftReady(result.script, result);
                    }
                });
            }
        } catch (err) {
            if (closed || isAbortError(err) || controller.signal.aborted) {
                return;
            }
            renderStatusBox(
                statusEl,
                'error',
                `<strong>Error:</strong> ${escapeHtml(err?.message || String(err))}`,
            );
        } finally {
            if (activeController === controller) {
                activeController = null;
            }
            if (!closed) {
                setBusyState(false);
            }
        }
    });

    syncSourceUi();
    document.body.appendChild(overlay);

    return {
        close: () => closeModal(true),
        abort: () => activeController?.abort(),
    };
}

const ITERATE_QUICK_CHIPS = Object.freeze([
    {
        id: 'fix-errors',
        label: 'Fix validation/sandbox errors',
        targetLang: '',
        instruction: 'Fix all validation and runtime sandbox errors while preserving all existing mechanics and prompts.',
    },
    {
        id: 'convert-python',
        label: 'Convert to Python',
        targetLang: 'python',
        instruction: 'Convert this script to idiomatic Python 3 (Pyodide sandbox) while preserving all mechanics, state shape, trackerTag, commandPrefix, toolActions, and gmPrompt.',
    },
    {
        id: 'convert-js',
        label: 'Convert to JavaScript',
        targetLang: 'js',
        instruction: 'Convert this script to clean ES2020 JavaScript (Sandboxed Worker) while preserving all mechanics, state shape, trackerTag, commandPrefix, toolActions, and gmPrompt.',
    },
    {
        id: 'add-status-tools',
        label: 'Add !status & tool actions',
        targetLang: '',
        instruction: 'Add a !status command summary and structured Narrator toolActions with clear parameter schemas backed by a shared action reducer.',
    },
    {
        id: 'improve-hud',
        label: 'Improve HUD bars & pills',
        targetLang: '',
        instruction: 'Improve the renderMemo HUD output using Combat-Multihog native ((BAR)), ((BARGREEN)), ((BARRED)), and ((PILLS)) markers for clearer visual status display.',
    },
]);

/**
 * Opens the compact AI Iterate modal from inside Script Studio to refine,
 * fix errors, or convert an existing script draft between JS and Python.
 *
 * @param {object} currentDraft
 * @param {{
 *   getSettings?: () => object,
 *   validationErrors?: string[],
 *   sandboxErrors?: string[],
 *   sendRequest?: ((systemPrompt: string, userPrompt: string, signal: AbortSignal|null) => Promise<string>)|null,
 *   onApply?: (script: object, result: object) => (void|Promise<void>),
 *   onCancel?: () => void,
 * }} [deps={}]
 * @returns {{ close: () => void, abort: () => void } | null}
 */
export function openScriptIterateModal(currentDraft, deps = {}) {
    if (typeof document === 'undefined' || !document.body) {
        return null;
    }

    ensureWizardStyles();
    document.getElementById(ITERATE_OVERLAY_ID)?.remove();

    const getLiveSettings = () => getSettingsSafe(typeof deps?.getSettings === 'function' ? deps.getSettings() : null);
    const currentObj = tryParseScriptObject(currentDraft) || {};
    const currentLang = normalizeWizardLang(currentObj.lang || 'js');
    const currentLangLabel = currentLang === 'python' ? 'Python (Pyodide)' : 'JavaScript';
    const appearance = getAppearanceSafe();

    let isRunning = false;
    let closed = false;
    let activeController = null;

    const overlay = document.createElement('div');
    overlay.id = ITERATE_OVERLAY_ID;
    overlay.className = `rt-so-mode-${appearance}`;
    overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:10170',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:14px',
        'background:rgba(0,0,0,0.58)',
        'box-sizing:border-box',
    ].join(';');

    const modal = document.createElement('div');
    modal.className = `rt-script-studio-modal rt-script-iterate-modal rt-so-mode-${appearance}`;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Iterate Script with AI');

    modal.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                <span style="font-size:1.15em;">✨</span>
                <strong style="font-size:0.98em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Iterate Script — ${escapeHtml(currentObj.name || currentObj.id || 'Current Draft')}</strong>
            </div>
            <button type="button" id="rt-si-close-x" class="menu_button interactable" title="Close (Esc)">✕</button>
        </div>

        <div class="rt-script-studio-pane">
            <div class="rt-script-wizard-field">
                <span style="font-size:0.8em;font-weight:600;opacity:0.82;">Quick Actions</span>
                <div class="rt-script-wizard-chips">
                    ${ITERATE_QUICK_CHIPS.map((chip) => `
                        <button type="button" class="rt-script-wizard-chip" data-chip-id="${escapeHtml(chip.id)}">${escapeHtml(chip.label)}</button>
                    `).join('')}
                </div>
            </div>

            <div class="rt-script-wizard-field">
                <label for="rt-si-instruction" style="font-size:0.84em;font-weight:600;">Refinement Instruction</label>
                <textarea id="rt-si-instruction" class="text_pole" rows="4" placeholder="Describe what to change, add, fix, or convert..."></textarea>
            </div>

            <div class="rt-script-wizard-field">
                <label for="rt-si-target-lang" style="font-size:0.84em;font-weight:600;">Target Language</label>
                <select id="rt-si-target-lang" class="text_pole">
                    <option value="" selected>Keep current (${escapeHtml(currentLangLabel)})</option>
                    <option value="js">JavaScript</option>
                    <option value="python">Python (Pyodide)</option>
                </select>
            </div>

            <div id="rt-si-status" class="rt-script-wizard-status" role="status" aria-live="polite" style="display:none;"></div>
        </div>

        <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <button type="button" id="rt-si-cancel" class="menu_button interactable">Cancel</button>
            <button type="button" id="rt-si-apply" class="menu_button interactable" style="background:var(--rt-studio-accent);border-color:var(--rt-studio-accent);color:#fff;font-weight:600;">✨ Apply Changes</button>
        </div>
    `;

    overlay.appendChild(modal);

    const statusEl = modal.querySelector('#rt-si-status');
    const instructionTa = /** @type {HTMLTextAreaElement|null} */ (modal.querySelector('#rt-si-instruction'));
    const targetLangSel = /** @type {HTMLSelectElement|null} */ (modal.querySelector('#rt-si-target-lang'));
    const applyBtn = /** @type {HTMLButtonElement|null} */ (modal.querySelector('#rt-si-apply'));
    const cancelBtn = /** @type {HTMLButtonElement|null} */ (modal.querySelector('#rt-si-cancel'));
    const closeXBtn = /** @type {HTMLButtonElement|null} */ (modal.querySelector('#rt-si-close-x'));

    function setBusyState(busy) {
        isRunning = busy;
        if (applyBtn) {
            applyBtn.disabled = busy;
            applyBtn.textContent = busy ? 'Applying...' : '✨ Apply Changes';
        }
        modal.querySelectorAll('.rt-script-wizard-chip, #rt-si-instruction, #rt-si-target-lang').forEach((el) => {
            if ('disabled' in el) {
                el.disabled = busy;
            }
        });
    }

    function closeModal(cancelled = false) {
        if (closed) return;
        closed = true;
        if (activeController) {
            try {
                activeController.abort();
            } catch (_) {
                // Ignore abort failures
            }
            activeController = null;
        }
        document.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        if (cancelled) {
            try {
                deps?.onCancel?.();
            } catch (_) {
                // Non-fatal
            }
        }
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeModal(true);
        }
    }

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeModal(true);
        }
    });
    document.addEventListener('keydown', onKeyDown, true);

    closeXBtn?.addEventListener('click', () => closeModal(true));
    cancelBtn?.addEventListener('click', () => closeModal(true));

    modal.querySelectorAll('.rt-script-wizard-chip').forEach((chipBtn) => {
        chipBtn.addEventListener('click', () => {
            if (isRunning) return;
            const chipId = chipBtn.getAttribute('data-chip-id');
            const chip = ITERATE_QUICK_CHIPS.find((c) => c.id === chipId);
            if (!chip) return;

            if (instructionTa) {
                instructionTa.value = chip.instruction;
                instructionTa.focus();
            }
            if (targetLangSel && chip.targetLang) {
                targetLangSel.value = chip.targetLang;
            }
            renderStatusBox(statusEl, 'info', '');
        });
    });

    applyBtn?.addEventListener('click', async () => {
        if (isRunning || closed) return;

        const instruction = String(instructionTa?.value ?? '').trim();
        const targetLang = String(targetLangSel?.value ?? '').trim().toLowerCase();
        const providedValidationErrors = Array.isArray(deps?.validationErrors) ? deps.validationErrors : [];
        const providedSandboxErrors = Array.isArray(deps?.sandboxErrors) ? deps.sandboxErrors : [];
        const draftValidationErrors = providedValidationErrors.length > 0
            ? providedValidationErrors
            : (validateScriptDefinition(currentObj).errors || []);

        const hasActionableWork = Boolean(
            instruction ||
            (targetLang && targetLang !== currentLang) ||
            draftValidationErrors.length > 0 ||
            providedSandboxErrors.length > 0,
        );

        if (!hasActionableWork) {
            renderStatusBox(statusEl, 'warning', 'Please enter a refinement instruction, pick a quick-action chip, or choose a different target language.');
            instructionTa?.focus();
            return;
        }

        const controller = new AbortController();
        activeController = controller;
        setBusyState(true);

        try {
            const result = await iterateScriptWithAi({
                settings: getLiveSettings(),
                currentScript: currentDraft,
                instruction,
                targetLang,
                validationErrors: draftValidationErrors,
                sandboxErrors: providedSandboxErrors,
                autoRepair: true,
                signal: controller.signal,
                onStatus: (msg) => {
                    if (!closed && !controller.signal.aborted) {
                        renderStatusBox(statusEl, 'info', escapeHtml(msg));
                    }
                },
                sendRequest: deps?.sendRequest,
            });

            if (closed || controller.signal.aborted) return;

            if (result.ok && result.script) {
                closeModal(false);
                if (typeof deps?.onApply === 'function') {
                    await deps.onApply(result.script, result);
                }
                return;
            }

            const errLines = (result.errors?.length ? result.errors : ['Updated script failed validation.'])
                .map((e) => `• ${escapeHtml(e)}`)
                .join('\n');
            const warnLines = result.warnings?.length
                ? `\n\n<strong>Warnings:</strong>\n${result.warnings.map((w) => `• ${escapeHtml(w)}`).join('\n')}`
                : '';

            renderStatusBox(
                statusEl,
                'error',
                `<strong>Update completed with errors (after ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}):</strong>\n${errLines}${warnLines}` +
                (result.script
                    ? '<div style="margin-top:8px;"><button type="button" id="rt-si-apply-anyway" class="menu_button interactable">Apply Draft Anyway</button></div>'
                    : ''),
            );
            if (result.script) {
                statusEl?.querySelector('#rt-si-apply-anyway')?.addEventListener('click', async () => {
                    closeModal(false);
                    if (typeof deps?.onApply === 'function') {
                        await deps.onApply(result.script, result);
                    }
                });
            }
        } catch (err) {
            if (closed || isAbortError(err) || controller.signal.aborted) {
                return;
            }
            renderStatusBox(
                statusEl,
                'error',
                `<strong>Error:</strong> ${escapeHtml(err?.message || String(err))}`,
            );
        } finally {
            if (activeController === controller) {
                activeController = null;
            }
            if (!closed) {
                setBusyState(false);
            }
        }
    });

    document.body.appendChild(overlay);

    return {
        close: () => closeModal(true),
        abort: () => activeController?.abort(),
    };
}
