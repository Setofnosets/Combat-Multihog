/**
 * Canonical schema, normalization, validation, tool-schema compilation,
 * user-command parsing, and serialization helpers for Combat-Multihog
 * Game Scripts.
 *
 * Pure ESM module: zero SillyTavern, DOM, or Multihog imports.
 */

export const SCRIPT_SCHEMA_VERSION = 1;

export const SCRIPT_SCOPES = Object.freeze(['chat', 'global', 'character']);

export const SCRIPT_LANGUAGES = Object.freeze(['js', 'python']);

export const SCRIPT_HOOK_NAMES = Object.freeze([
    'initState',
    'onBeforeGenerate',
    'onToolCall',
    'onAfterGenerate',
    'renderMemo',
]);

const VALID_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;
const VALID_ACTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const VALID_PARAM_TYPES = new Set(['string', 'number', 'boolean']);
const DEFAULT_SCRIPT_ICON = '📜';

/**
 * Sanitize an arbitrary string into a lowercase snake_case `[a-z0-9_]+` script ID.
 * Falls back to `'custom_script'` when blank or containing no valid characters.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeScriptId(raw) {
    const cleaned = String(raw ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return cleaned || 'custom_script';
}

/**
 * Normalize a tracker tag into `UPPER_SNAKE_CASE` (`[A-Z0-9_]+`).
 * Returns `''` if blank.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeTrackerTag(raw) {
    return String(raw ?? '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * Trim, strip whitespace, and ensure a leading `!` for a command prefix.
 * Returns `''` if blank or only `!`.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeCommandPrefix(raw) {
    const compact = String(raw ?? '').trim().replace(/\s+/g, '');
    if (!compact) return '';
    const body = compact.replace(/^!+/, '');
    if (!body) return '';
    return `!${body}`;
}

/**
 * Convert an arbitrary label into a PascalCase alphanumeric segment.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function toPascalCaseSegment(raw) {
    const words = String(raw ?? '')
        .trim()
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);
    if (!words.length) return '';
    return words
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join('');
}

/**
 * Keep `script.toolName` if it matches `^[A-Za-z][A-Za-z0-9_]{1,63}$`;
 * otherwise derive `Script_<PascalCaseNameOrId>` matching the same constraint.
 *
 * @param {object} script
 * @returns {string}
 */
export function deriveScriptToolName(script) {
    const src = (script && typeof script === 'object') ? script : {};
    const explicit = typeof src.toolName === 'string' ? src.toolName.trim() : '';
    if (VALID_TOOL_NAME_RE.test(explicit)) {
        return explicit;
    }

    const segment =
        toPascalCaseSegment(src.name) ||
        toPascalCaseSegment(src.id) ||
        'Custom';
    const derived = `Script_${segment}`.slice(0, 64);
    if (VALID_TOOL_NAME_RE.test(derived)) {
        return derived;
    }
    return 'Script_Custom';
}

/**
 * Allow only trimmed URLs starting with `https://`, `http://`, `/`, or `data:image/`.
 * Rejects `javascript:`, `vbscript:`, `data:text/html`, etc.
 *
 * @param {unknown} url
 * @returns {string}
 */
export function sanitizePortraitUrl(url) {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed) return '';
    const lower = trimmed.toLowerCase();
    if (
        lower.startsWith('https://') ||
        lower.startsWith('http://') ||
        lower.startsWith('/') ||
        lower.startsWith('data:image/')
    ) {
        return trimmed;
    }
    return '';
}

/**
 * Normalize a single tool action parameter descriptor.
 *
 * @param {unknown} raw
 * @returns {{ name: string, type: 'string'|'number'|'boolean', required: boolean, enum?: string[], description: string }}
 */
export function normalizeToolParam(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const name = String(src.name ?? '').trim();
    const rawType = String(src.type ?? '').trim().toLowerCase();
    const type = VALID_PARAM_TYPES.has(rawType) ? rawType : 'string';
    const required = Boolean(src.required);
    const description = String(src.description ?? '').trim();

    const normalized = {
        name,
        type,
        required,
        description,
    };

    if (Array.isArray(src.enum)) {
        const enumValues = [];
        const seen = new Set();
        for (const item of src.enum) {
            const val = String(item ?? '').trim();
            if (!val || seen.has(val)) continue;
            seen.add(val);
            enumValues.push(val);
        }
        if (enumValues.length > 0) {
            normalized.enum = enumValues;
        }
    }

    return normalized;
}

/**
 * Normalize a single tool action descriptor.
 *
 * @param {unknown} raw
 * @returns {{ name: string, description: string, params: Array }}
 */
export function normalizeToolAction(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const name = String(src.name ?? '').trim();
    const description = String(src.description ?? '').trim();

    const params = [];
    const seenParams = new Set();
    if (Array.isArray(src.params)) {
        for (const rawParam of src.params) {
            const param = normalizeToolParam(rawParam);
            if (!param.name || seenParams.has(param.name)) continue;
            seenParams.add(param.name);
            params.push(param);
        }
    }

    return {
        name,
        description,
        params,
    };
}

/**
 * Normalize a script definition into its canonical schema shape.
 *
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeScriptDefinition(raw) {
    const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const now = Date.now();

    const name = String(src.name ?? '').trim();
    const id = sanitizeScriptId(src.id || name);
    const icon = String(src.icon ?? '').trim() || DEFAULT_SCRIPT_ICON;
    const description = String(src.description ?? '').trim();

    const rawLang = String(src.lang ?? '').trim().toLowerCase();
    const lang = SCRIPT_LANGUAGES.includes(rawLang) ? rawLang : 'js';

    const rawScope = String(src.scope ?? '').trim().toLowerCase();
    const scope = SCRIPT_SCOPES.includes(rawScope) ? rawScope : 'chat';

    const boundCharacters = [];
    const seenChars = new Set();
    if (Array.isArray(src.boundCharacters)) {
        for (const entry of src.boundCharacters) {
            const charKey = String(entry ?? '').trim();
            if (!charKey || seenChars.has(charKey)) continue;
            seenChars.add(charKey);
            boundCharacters.push(charKey);
        }
    }

    const globalEnabled = Boolean(src.globalEnabled);
    const trackerTag = sanitizeTrackerTag(src.trackerTag);
    const commandPrefix = sanitizeCommandPrefix(src.commandPrefix);
    const stripCommandFromPrompt = Boolean(src.stripCommandFromPrompt);
    const toolEnabled = Boolean(src.toolEnabled);

    const toolActions = [];
    const seenActions = new Set();
    if (Array.isArray(src.toolActions)) {
        for (const rawAction of src.toolActions) {
            const action = normalizeToolAction(rawAction);
            if (!action.name || seenActions.has(action.name)) continue;
            seenActions.add(action.name);
            toolActions.push(action);
        }
    }

    const toolName = deriveScriptToolName({
        toolName: src.toolName,
        name,
        id,
    });
    const toolDescription = String(src.toolDescription ?? '').trim();
    const gmPrompt = String(src.gmPrompt ?? '').trim();
    const code = typeof src.code === 'string' ? src.code : String(src.code ?? '');

    const rawCreated = Number(src.createdAt);
    const createdAt = Number.isFinite(rawCreated) && rawCreated > 0 ? rawCreated : now;
    const rawUpdated = Number(src.updatedAt);
    const updatedAt = Number.isFinite(rawUpdated) && rawUpdated > 0 ? rawUpdated : createdAt;

    return {
        schemaVersion: SCRIPT_SCHEMA_VERSION,
        id,
        name,
        icon,
        description,
        lang,
        scope,
        boundCharacters,
        globalEnabled,
        trackerTag,
        commandPrefix,
        stripCommandFromPrompt,
        toolEnabled,
        toolName,
        toolDescription,
        toolActions,
        gmPrompt,
        code,
        createdAt,
        updatedAt,
    };
}

/**
 * Validate a script definition object.
 *
 * @param {unknown} def
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateScriptDefinition(def) {
    const errors = [];
    const warnings = [];

    if (!def || typeof def !== 'object' || Array.isArray(def)) {
        return {
            valid: false,
            errors: ['Script definition must be an object.'],
            warnings,
        };
    }

    const id = typeof def.id === 'string' ? def.id.trim() : '';
    if (!id) {
        errors.push('Script id is required.');
    } else if (!/^[a-z0-9_]+$/.test(id)) {
        errors.push('Script id must match lowercase snake_case [a-z0-9_]+.');
    }

    const name = typeof def.name === 'string' ? def.name.trim() : '';
    if (!name) {
        errors.push('Script name is required.');
    }

    const lang = typeof def.lang === 'string' ? def.lang.trim().toLowerCase() : '';
    if (!SCRIPT_LANGUAGES.includes(lang)) {
        errors.push(`Invalid script language "${def.lang ?? ''}". Expected one of: ${SCRIPT_LANGUAGES.join(', ')}.`);
    } else if (lang === 'python') {
        warnings.push('Python scripts are targeted for Phase 2 and are not yet executable in the Phase 1 JS sandbox.');
    }

    const scope = typeof def.scope === 'string' ? def.scope.trim().toLowerCase() : '';
    if (!SCRIPT_SCOPES.includes(scope)) {
        errors.push(`Invalid script scope "${def.scope ?? ''}". Expected one of: ${SCRIPT_SCOPES.join(', ')}.`);
    }

    const code = typeof def.code === 'string' ? def.code : '';
    if (!code.trim()) {
        errors.push('Script code must not be empty.');
    }

    if (def.toolEnabled) {
        const actions = Array.isArray(def.toolActions) ? def.toolActions : [];
        if (actions.length === 0) {
            warnings.push('Tool calling is enabled, but no tool actions are defined.');
        } else {
            const seenNames = new Set();
            actions.forEach((action, index) => {
                const actionName = action && typeof action.name === 'string' ? action.name.trim() : '';
                if (!actionName) {
                    errors.push(`Tool action at index ${index} must have a non-empty name.`);
                } else if (!VALID_ACTION_NAME_RE.test(actionName)) {
                    errors.push(`Tool action name "${actionName}" must contain only letters, digits, underscores, or hyphens.`);
                } else if (seenNames.has(actionName)) {
                    errors.push(`Duplicate tool action name "${actionName}".`);
                } else {
                    seenNames.add(actionName);
                }

                if (action && Array.isArray(action.params)) {
                    for (const param of action.params) {
                        const paramName = param && typeof param.name === 'string' ? param.name.trim() : '';
                        if (!paramName) {
                            errors.push(`Tool action "${actionName || index}" has a parameter with an empty name.`);
                        } else if (paramName === 'action') {
                            errors.push(`Tool action "${actionName || index}" cannot define a parameter named "action" (reserved).`);
                        }
                    }
                }
            });
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

/**
 * Build a SillyTavern `registerFunctionTool`-compatible schema from a normalized script.
 * Returns `null` when `!script.toolEnabled` or there are no valid `toolActions`.
 *
 * @param {object} script
 * @returns {{ name: string, displayName: string, description: string, parameters: object } | null}
 */
export function buildToolSchemaFromActions(script) {
    if (!script || typeof script !== 'object' || !script.toolEnabled) {
        return null;
    }

    const rawActions = Array.isArray(script.toolActions) ? script.toolActions : [];
    const validActions = [];
    const seenActions = new Set();

    for (const rawAction of rawActions) {
        const action = normalizeToolAction(rawAction);
        if (!action.name || seenActions.has(action.name)) continue;
        seenActions.add(action.name);
        validActions.push(action);
    }

    if (validActions.length === 0) {
        return null;
    }

    const toolName = deriveScriptToolName(script);
    const displayName = String(script.name ?? '').trim() || toolName;
    const actionNames = validActions.map(a => a.name);

    const unionProperties = {};
    const actionNotes = [];

    for (const action of validActions) {
        const usableParams = action.params.filter(p => p.name && p.name !== 'action');
        for (const param of usableParams) {
            if (!unionProperties[param.name]) {
                const prop = {
                    type: param.type,
                    description: param.description || `${param.name} parameter`,
                };
                if (Array.isArray(param.enum) && param.enum.length > 0) {
                    prop.enum = [...param.enum];
                }
                unionProperties[param.name] = prop;
            } else {
                const existing = unionProperties[param.name];
                if (Array.isArray(param.enum) && param.enum.length > 0) {
                    const mergedEnum = Array.from(new Set([...(existing.enum || []), ...param.enum]));
                    if (mergedEnum.length > 0) {
                        existing.enum = mergedEnum;
                    }
                }
                if (!existing.description && param.description) {
                    existing.description = param.description;
                }
            }
        }

        const paramSummary = usableParams.length > 0
            ? `params: ${usableParams.map(p => (p.required ? `${p.name} (required)` : `${p.name} (optional)`)).join(', ')}`
            : 'no extra params';
        const descPart = action.description ? `${action.description} ` : '';
        actionNotes.push(`${action.name}: ${descPart}[${paramSummary}]`);
    }

    const baseDescription =
        String(script.toolDescription ?? '').trim() ||
        String(script.description ?? '').trim() ||
        `Invoke actions for ${displayName}.`;
    const description = `${baseDescription} Actions — ${actionNotes.join('; ')}.`;

    const actionEnumDescriptions = validActions
        .map(a => (a.description ? `${a.name} (${a.description})` : a.name))
        .join('; ');

    return {
        name: toolName,
        displayName,
        description,
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: actionNames,
                    description: `Action to perform. Valid actions: ${actionEnumDescriptions}.`,
                },
                ...unionProperties,
            },
            required: ['action'],
        },
    };
}

/**
 * Parse a user command line matching `prefix` from a user message.
 *
 * @param {string} message
 * @param {string} prefix
 * @returns {{ prefix: string, subcommand: string, rawArgs: string, fullMatch: string, line: string, strippedMessage: string } | null}
 */
export function parseUserCommand(message, prefix) {
    if (typeof message !== 'string' || !message) return null;

    const normalizedPrefix = sanitizeCommandPrefix(prefix);
    if (!normalizedPrefix) return null;

    const escapedPrefix = normalizedPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lineRe = new RegExp(`^[ \\t]*(${escapedPrefix})(?:[ \\t]+(.*)|[ \\t]*)$`, 'i');

    const lines = message.split(/\r?\n/);
    let matchIndex = -1;
    let matchedLine = '';
    let matchedRest = '';

    for (let i = 0; i < lines.length; i++) {
        const m = lineRe.exec(lines[i]);
        if (m) {
            matchIndex = i;
            matchedLine = lines[i];
            matchedRest = (m[2] ?? '').trim();
            break;
        }
    }

    if (matchIndex === -1) return null;

    let subcommand = '';
    let rawArgs = '';

    if (matchedRest) {
        const wsMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(matchedRest);
        if (wsMatch) {
            const firstToken = wsMatch[1];
            const afterFirst = (wsMatch[2] ?? '').trim();
            const colonIdx = firstToken.indexOf(':');

            if (colonIdx > 0 && colonIdx < firstToken.length - 1) {
                subcommand = firstToken.slice(0, colonIdx).toLowerCase();
                const colonTail = firstToken.slice(colonIdx + 1);
                rawArgs = afterFirst ? `${colonTail} ${afterFirst}`.trim() : colonTail.trim();
            } else if (colonIdx > 0 && colonIdx === firstToken.length - 1) {
                subcommand = firstToken.slice(0, -1).toLowerCase();
                rawArgs = afterFirst;
            } else {
                subcommand = firstToken.toLowerCase();
                rawArgs = afterFirst;
            }
        }
    }

    const remainingLines = [...lines.slice(0, matchIndex), ...lines.slice(matchIndex + 1)];
    const strippedMessage = remainingLines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return {
        prefix: normalizedPrefix,
        subcommand,
        rawArgs,
        fullMatch: matchedLine,
        line: matchedLine,
        strippedMessage,
    };
}

/**
 * Safely normalize a script hook's return value.
 *
 * @param {unknown} raw
 * @returns {{
 *   hasState: boolean,
 *   state: any,
 *   hasMemoBlock: boolean,
 *   memoBlock: string|null,
 *   promptInjection: string,
 *   hasToolResult: boolean,
 *   toolResult: any,
 *   stripCommand: boolean,
 *   hasPortraitUrl: boolean,
 *   portraitUrl: string|null,
 *   appendMarkdown: string,
 *   logs: string[],
 * }}
 */
export function normalizeScriptResult(raw) {
    const empty = {
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
    };

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return empty;
    }

    const hasState = Object.prototype.hasOwnProperty.call(raw, 'state') && raw.state !== undefined;
    const state = hasState ? raw.state : undefined;

    const hasMemoProp = Object.prototype.hasOwnProperty.call(raw, 'memoBlock') && raw.memoBlock !== undefined;
    let hasMemoBlock = false;
    let memoBlock = null;
    if (hasMemoProp) {
        hasMemoBlock = true;
        memoBlock = raw.memoBlock === null ? null : String(raw.memoBlock);
    }

    const promptInjection = raw.promptInjection == null ? '' : String(raw.promptInjection);

    const hasToolResult = Object.prototype.hasOwnProperty.call(raw, 'toolResult') && raw.toolResult !== undefined;
    const toolResult = hasToolResult ? raw.toolResult : undefined;

    const stripCommand = Boolean(raw.stripCommand);

    let hasPortraitUrl = false;
    let portraitUrl = null;
    if (Object.prototype.hasOwnProperty.call(raw, 'portraitUrl') && raw.portraitUrl !== undefined) {
        if (raw.portraitUrl === null) {
            hasPortraitUrl = true;
            portraitUrl = null;
        } else if (typeof raw.portraitUrl === 'string') {
            if (raw.portraitUrl.trim() === '') {
                hasPortraitUrl = true;
                portraitUrl = '';
            } else {
                const safeUrl = sanitizePortraitUrl(raw.portraitUrl);
                if (safeUrl) {
                    hasPortraitUrl = true;
                    portraitUrl = safeUrl;
                }
            }
        }
    }

    const appendMarkdown = raw.appendMarkdown == null ? '' : String(raw.appendMarkdown);

    const logs = Array.isArray(raw.logs)
        ? raw.logs.map(entry => String(entry ?? ''))
        : [];

    return {
        hasState,
        state,
        hasMemoBlock,
        memoBlock,
        promptInjection,
        hasToolResult,
        toolResult,
        stripCommand,
        hasPortraitUrl,
        portraitUrl,
        appendMarkdown,
        logs,
    };
}

/**
 * Collect collisions for a given key extractor over script objects.
 *
 * @param {Array<{ key: string, value: string, script: object }>} entries
 * @returns {Array<{ value: string, scriptIds: string[], scriptNames: string[] }>}
 */
function collectCollisionGroups(entries) {
    const groups = new Map();
    for (const entry of entries) {
        if (!entry.key) continue;
        let bucket = groups.get(entry.key);
        if (!bucket) {
            bucket = {
                value: entry.value,
                scriptIds: [],
                scriptNames: [],
            };
            groups.set(entry.key, bucket);
        }
        const scriptId = String(entry.script?.id ?? '');
        const scriptName = String(entry.script?.name ?? scriptId);
        bucket.scriptIds.push(scriptId);
        bucket.scriptNames.push(scriptName);
    }

    const collisions = [];
    for (const bucket of groups.values()) {
        if (bucket.scriptIds.length > 1) {
            collisions.push(bucket);
        }
    }
    return collisions;
}

/**
 * Detect duplicate `trackerTag`, `commandPrefix` (case-insensitive), and active `toolName`
 * across a list of enabled script definitions.
 *
 * @param {Array<object>} enabledScripts
 * @returns {{
 *   trackerTagCollisions: Array<{ value: string, scriptIds: string[], scriptNames: string[] }>,
 *   commandPrefixCollisions: Array<{ value: string, scriptIds: string[], scriptNames: string[] }>,
 *   toolNameCollisions: Array<{ value: string, scriptIds: string[], scriptNames: string[] }>,
 *   hasCollisions: boolean,
 * }}
 */
export function detectScriptCollisions(enabledScripts) {
    const scripts = Array.isArray(enabledScripts) ? enabledScripts.filter(s => s && typeof s === 'object') : [];

    const trackerEntries = [];
    const prefixEntries = [];
    const toolEntries = [];

    for (const script of scripts) {
        const tag = sanitizeTrackerTag(script.trackerTag);
        if (tag) {
            trackerEntries.push({ key: tag, value: tag, script });
        }

        const prefix = sanitizeCommandPrefix(script.commandPrefix);
        if (prefix) {
            prefixEntries.push({ key: prefix.toLowerCase(), value: prefix, script });
        }

        const hasValidAction =
            Boolean(script.toolEnabled) &&
            Array.isArray(script.toolActions) &&
            script.toolActions.some(a => a && typeof a.name === 'string' && a.name.trim().length > 0);
        if (hasValidAction) {
            const toolName = deriveScriptToolName(script);
            toolEntries.push({ key: toolName, value: toolName, script });
        }
    }

    const trackerTagCollisions = collectCollisionGroups(trackerEntries);
    const commandPrefixCollisions = collectCollisionGroups(prefixEntries);
    const toolNameCollisions = collectCollisionGroups(toolEntries);

    return {
        trackerTagCollisions,
        commandPrefixCollisions,
        toolNameCollisions,
        hasCollisions:
            trackerTagCollisions.length > 0 ||
            commandPrefixCollisions.length > 0 ||
            toolNameCollisions.length > 0,
    };
}

/**
 * Serialize a script definition to pretty-printed canonical JSON.
 *
 * @param {unknown} script
 * @returns {string}
 */
export function serializeScriptToJson(script) {
    return JSON.stringify(normalizeScriptDefinition(script), null, 2);
}

/**
 * Parse JSON text into a normalized, validated script definition.
 *
 * @param {unknown} jsonText
 * @returns {{ ok: boolean, script: object|null, errors: string[], warnings: string[] }}
 */
export function parseScriptFromJson(jsonText) {
    if (typeof jsonText !== 'string' || !jsonText.trim()) {
        return {
            ok: false,
            script: null,
            errors: ['Script JSON text is empty.'],
            warnings: [],
        };
    }

    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (error) {
        return {
            ok: false,
            script: null,
            errors: [`Invalid JSON: ${error?.message || String(error)}`],
            warnings: [],
        };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            ok: false,
            script: null,
            errors: ['Script JSON must represent an object.'],
            warnings: [],
        };
    }

    const preNormalizeErrors = [];
    const preNormalizeWarnings = [];

    if (parsed.schemaVersion !== undefined && Number(parsed.schemaVersion) !== SCRIPT_SCHEMA_VERSION) {
        preNormalizeWarnings.push(
            `Script schemaVersion ${parsed.schemaVersion} differs from supported version ${SCRIPT_SCHEMA_VERSION}.`
        );
    }

    if (parsed.lang !== undefined) {
        const rawLang = String(parsed.lang ?? '').trim().toLowerCase();
        if (!SCRIPT_LANGUAGES.includes(rawLang)) {
            preNormalizeErrors.push(
                `Invalid script language "${parsed.lang}". Expected one of: ${SCRIPT_LANGUAGES.join(', ')}.`
            );
        }
    }

    if (parsed.scope !== undefined) {
        const rawScope = String(parsed.scope ?? '').trim().toLowerCase();
        if (!SCRIPT_SCOPES.includes(rawScope)) {
            preNormalizeErrors.push(
                `Invalid script scope "${parsed.scope}". Expected one of: ${SCRIPT_SCOPES.join(', ')}.`
            );
        }
    }

    const normalized = normalizeScriptDefinition(parsed);
    const validation = validateScriptDefinition(normalized);

    const errors = [...preNormalizeErrors, ...validation.errors];
    const warnings = [...preNormalizeWarnings, ...validation.warnings];
    const ok = errors.length === 0;

    return {
        ok,
        script: ok ? normalized : null,
        errors,
        warnings,
    };
}
