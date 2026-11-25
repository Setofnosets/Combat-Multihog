/**
 * script-wizard-prompts.js — Pure prompt engineering, character card summary
 * extraction, and response parsing helpers for the Game Script AI Wizard.
 *
 * Pure ESM module: zero SillyTavern, DOM, or Multihog runtime imports.
 */

import {
    SCRIPT_LANGUAGES,
    SCRIPT_SCHEMA_VERSION,
    SCRIPT_SCOPES,
    normalizeScriptDefinition,
    validateScriptDefinition,
} from './core/script-schema.js';
import { getCharacterCardField } from '../../state/character-cards.js';

export const SCRIPT_WIZARD_INTERACTION_MODES = Object.freeze(['both', 'tools', 'commands']);

const DEFAULT_MAX_CARD_SUMMARY_CHARS = 16000;

const PYTHON_ALLOWED_STDLIB = Object.freeze([
    'math',
    're',
    'json',
    'random',
    'datetime',
    'collections',
    'itertools',
    'functools',
    'dataclasses',
    'copy',
    'statistics',
    'string',
]);

function normalizeLang(lang) {
    const clean = String(lang ?? 'js').trim().toLowerCase();
    return clean === 'python' ? 'python' : 'js';
}

function normalizeInteractionMode(mode) {
    const clean = String(mode ?? 'both').trim().toLowerCase();
    return SCRIPT_WIZARD_INTERACTION_MODES.includes(clean) ? clean : 'both';
}

function readCardFieldTrimmed(cardObj, field) {
    const value = getCharacterCardField(cardObj, field);
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    if (cardObj && typeof cardObj === 'object' && cardObj.data && typeof cardObj.data === 'object') {
        const nested = cardObj.data[field];
        if (typeof nested === 'string' && nested.trim()) {
            return nested.trim();
        }
    }
    return '';
}

function truncateTextCleanly(text, maxLen) {
    const str = String(text ?? '');
    if (str.length <= maxLen) {
        return { value: str, truncated: false };
    }
    if (maxLen <= 0) {
        return { value: '', truncated: true };
    }

    const marker = maxLen >= 40 ? '\n...[truncated]' : (maxLen >= 4 ? '...' : '');
    const budget = maxLen - marker.length;
    if (budget <= 0) {
        return { value: str.slice(0, maxLen), truncated: true };
    }

    let slice = str.slice(0, budget);
    const minKeep = Math.floor(budget * 0.6);
    const lastNewline = slice.lastIndexOf('\n');
    const lastSpace = slice.lastIndexOf(' ');

    if (lastNewline >= minKeep) {
        slice = slice.slice(0, lastNewline);
    } else if (lastSpace >= minKeep) {
        slice = slice.slice(0, lastSpace);
    }

    slice = slice.trimEnd();
    return {
        value: `${slice}${marker}`,
        truncated: true,
    };
}

/**
 * Extracts a compact, Markdown-formatted character card summary from V1 or V2
 * character card payloads, prioritizing `Scenario` and `Description` first and
 * truncating long `Example Dialogs` / `Creator Notes` cleanly within `maxChars`.
 *
 * @param {object|null|undefined} cardObj
 * @param {{ maxChars?: number }} [options={}]
 * @returns {{ name: string, text: string, truncated: boolean }}
 */
export function extractCharacterCardSummary(cardObj, options = {}) {
    if (!cardObj || typeof cardObj !== 'object' || Array.isArray(cardObj)) {
        return { name: '', text: '', truncated: false };
    }

    const opts = (options && typeof options === 'object') ? options : {};
    const rawMax = opts.maxChars === undefined ? DEFAULT_MAX_CARD_SUMMARY_CHARS : Number(opts.maxChars);
    const limit = Number.isFinite(rawMax) ? Math.max(0, Math.floor(rawMax)) : DEFAULT_MAX_CARD_SUMMARY_CHARS;

    const name = readCardFieldTrimmed(cardObj, 'name');
    const scenario = readCardFieldTrimmed(cardObj, 'scenario');
    const description = readCardFieldTrimmed(cardObj, 'description');
    const personality = readCardFieldTrimmed(cardObj, 'personality');
    const firstMes = readCardFieldTrimmed(cardObj, 'first_mes');
    const mesExample = readCardFieldTrimmed(cardObj, 'mes_example');
    const creatorNotes = readCardFieldTrimmed(cardObj, 'creator_notes');

    const primarySections = [
        { heading: 'Name', value: name },
        { heading: 'Scenario', value: scenario },
        { heading: 'Description', value: description },
        { heading: 'Personality', value: personality },
        { heading: 'First Message', value: firstMes },
    ].filter((s) => s.value.length > 0);

    const secondarySections = [
        { heading: 'Example Dialogs', value: mesExample },
        { heading: 'Creator Notes', value: creatorNotes },
    ].filter((s) => s.value.length > 0);

    const allSections = [...primarySections, ...secondarySections];
    if (allSections.length === 0) {
        return { name, text: '', truncated: false };
    }

    const fullText = allSections.map((s) => `### ${s.heading}\n${s.value}`).join('\n\n');
    if (fullText.length <= limit) {
        return { name, text: fullText, truncated: false };
    }

    if (limit === 0) {
        return { name, text: '', truncated: true };
    }

    const parts = [];
    let usedLen = 0;
    let truncated = false;

    const appendSectionWithinBudget = (section, maxBlockBudget) => {
        const header = `### ${section.heading}\n`;
        const fullBlock = `${header}${section.value}`;
        if (fullBlock.length <= maxBlockBudget) {
            parts.push(fullBlock);
            usedLen += (parts.length > 1 ? 2 : 0) + fullBlock.length;
            return { added: true, sectionTruncated: false };
        }

        const bodyBudget = maxBlockBudget - header.length;
        if (bodyBudget >= 24) {
            const cut = truncateTextCleanly(section.value, bodyBudget);
            if (cut.value) {
                const block = `${header}${cut.value}`;
                parts.push(block);
                usedLen += (parts.length > 1 ? 2 : 0) + block.length;
                return { added: true, sectionTruncated: true };
            }
        }

        if (parts.length === 0 && maxBlockBudget > 0) {
            const cut = truncateTextCleanly(fullBlock, maxBlockBudget);
            if (cut.value) {
                parts.push(cut.value);
                usedLen += cut.value.length;
                return { added: true, sectionTruncated: true };
            }
        }

        return { added: false, sectionTruncated: true };
    };

    for (const sec of primarySections) {
        const sepLen = parts.length > 0 ? 2 : 0;
        const available = limit - usedLen - sepLen;
        if (available <= 0) {
            truncated = true;
            break;
        }
        const res = appendSectionWithinBudget(sec, available);
        if (res.sectionTruncated) {
            truncated = true;
            break;
        }
    }

    if (!truncated && secondarySections.length > 0) {
        if (secondarySections.length === 1) {
            const sec = secondarySections[0];
            const sepLen = parts.length > 0 ? 2 : 0;
            const available = limit - usedLen - sepLen;
            if (available > 0) {
                const res = appendSectionWithinBudget(sec, available);
                if (res.sectionTruncated) truncated = true;
            } else {
                truncated = true;
            }
        } else {
            const exampleSec = secondarySections[0];
            const notesSec = secondarySections[1];
            const exSep = parts.length > 0 ? 2 : 0;
            const remaining = limit - usedLen;
            const notesFullLen = `### ${notesSec.heading}\n${notesSec.value}`.length;

            if (remaining >= 240) {
                const reservedForNotes = Math.min(
                    notesFullLen + 2,
                    Math.max(120, Math.floor(remaining * 0.35)),
                );
                const exBudget = remaining - exSep - reservedForNotes;
                if (exBudget > 0) {
                    const exRes = appendSectionWithinBudget(exampleSec, exBudget);
                    if (exRes.sectionTruncated) truncated = true;
                } else {
                    truncated = true;
                }

                const notesSep = parts.length > 0 ? 2 : 0;
                const notesBudget = limit - usedLen - notesSep;
                if (notesBudget > 0) {
                    const notesRes = appendSectionWithinBudget(notesSec, notesBudget);
                    if (notesRes.sectionTruncated) truncated = true;
                } else {
                    truncated = true;
                }
            } else {
                const exBudget = remaining - exSep;
                if (exBudget > 0) {
                    appendSectionWithinBudget(exampleSec, exBudget);
                }
                truncated = true;
            }
        }
    }

    let text = parts.join('\n\n');
    if (text.length > limit) {
        text = truncateTextCleanly(text, limit).value;
        truncated = true;
    }

    return {
        name,
        text,
        truncated,
    };
}

function buildInteractionModeSection(mode, lang) {
    const isPy = lang === 'python';
    const reducerExample = isPy
        ? '`apply_action(state, action, args)`'
        : '`applyAction(state, action, args)`';
    const preHook = isPy ? '`on_before_generate(state, ctx)`' : '`onBeforeGenerate(state, ctx)`';
    const toolHook = isPy ? '`on_tool_call(state, call, ctx)`' : '`onToolCall(state, call, ctx)`';

    if (mode === 'tools') {
        return [
            '### Interaction Mode: `tools` (Natural-RP Function Tool Only)',
            '- Set `"commandPrefix": ""`, `"stripCommandFromPrompt": false`, and `"toolEnabled": true`.',
            '- Define a clear `"toolName"`, `"toolDescription"`, and well-typed `"toolActions"` (use `"enum"` arrays for finite choices and clear parameter descriptions).',
            `- Handle all state mutations from natural RP in ${toolHook}.`,
            `- Still implement ${preHook} to advance passive time ticks (\`ctx.time.deltaMinutes\`, \`ctx.time.dayChanged\`) and emit initial or threshold \`promptInjection\` cues.`,
            '- In `gmPrompt`, clearly tell the Narrator when during natural RP to invoke the registered tool.',
        ].join('\n');
    }

    if (mode === 'commands') {
        return [
            '### Interaction Mode: `commands` (Explicit `!prefix` Commands Only)',
            '- Set a short, intuitive `"commandPrefix"` starting with `!` (e.g., `"!hearth"`), and set `"toolEnabled": false` with `"toolActions": []`.',
            `- Parse \`ctx.command\` inside ${preHook} (\`subcommand\` is lowercased with any trailing \`:\` stripped; \`rawArgs\` holds the remainder).`,
            '- Support clear, intuitive subcommands (plus a helpful `status` / `help` subcommand when appropriate) and gracefully emit helpful `promptInjection` feedback if a subcommand or argument is invalid.',
            '- Omit tool-calling boilerplate; in `gmPrompt`, instruct the Narrator to treat `[TRACKER_TAG]` and `[SCRIPT_EVENT]` command outcomes as authoritative.',
        ].join('\n');
    }

    return [
        '### Interaction Mode: `both` (Dual Adjudication: `!prefix` Commands + Natural-RP Tools)',
        '- Set BOTH a non-empty `"commandPrefix"` (e.g., `"!hearth"`) AND `"toolEnabled": true` with full `"toolName"`, `"toolDescription"`, and `"toolActions"`.',
        `- Share ONE pure reducer helper (e.g., ${reducerExample}) called by BOTH ${preHook} (when \`ctx.command\` is present) and ${toolHook} (when the Narrator invokes the tool) — NEVER duplicate game math or state rules across hooks.`,
        '- The engine’s `turnLedger` automatically prevents double-firing when a `!prefix <action>` command runs pre-turn.',
        '- In `gmPrompt`, instruct the Narrator to call the registered tool mid-turn for matching natural-RP events ONLY when no `!prefix` command already executed pre-turn (and never re-call it when `[SCRIPT_EVENT]` reports the command was already handled).',
    ].join('\n');
}

function buildLanguageRulesSection(lang, mode) {
    if (lang === 'python') {
        const hookList = [
            '- `def init_state(ctx=None):` — return the initial JSON-serializable state `dict`.',
            '- `def on_before_generate(state, ctx):` — pre-turn hook; handle time ticks (`ctx.get("time")`), `!commands` (`ctx.get("command")`), and pre-turn `prompt_injection`.',
            mode === 'commands'
                ? '- (`on_tool_call` is not required when `toolEnabled` is `false`.)'
                : '- `def on_tool_call(state, call, ctx):` — mid-turn hook where `call` is `{"action": str, "args": dict}`; return `{"state": ..., "tool_result": ...}`.',
            '- `def on_after_generate(state, ctx):` — optional post-turn hook receiving `ctx.get("assistantMessage")` and `ctx.get("turnLedger")` (useful for turn counters, cleanup, or non-tool fallback).',
            '- `def render_memo(state, ctx=None):` — return a plain multi-line `str` for the HUD card whenever `trackerTag` is non-empty (do NOT include `[TAG]...[/TAG]` wrappers).',
        ].join('\n');

        return [
            '### Language Rules: Python 3 (`"lang": "python"`)',
            'Write clean, idiomatic Python 3 defining top-level hook functions:',
            hookList,
            '- **Context dictionary keys (`ctx`) are camelCase** because `ctx` is JSON-cloned from the JS host engine: e.g. `ctx.get("userMessage")`, `ctx.get("assistantMessage")`, `ctx.get("command")` (`prefix`, `subcommand`, `rawArgs`, `strippedMessage`), `ctx.get("memoBlocks")`, `ctx.get("time")` (`current`, `prior`, `deltaMinutes`, `dayChanged`), `ctx.get("character")`, `ctx.get("user")`, `ctx.get("otherScripts")`, `ctx.get("turnLedger")`.',
            `- **Allowed Python stdlib modules ONLY:** ${PYTHON_ALLOWED_STDLIB.map((m) => `\`${m}\``).join(', ')}.`,
            '- **Strictly forbidden:** `os`, `sys`, `open`, `pathlib`, `io`, `urllib`, `http`, `requests`, `socket`, `subprocess`, `shutil`, `importlib`, `eval`, `exec`, `compile`, `__import__`, relative imports, network/filesystem access, or dunder introspection (`__subclasses__`, `__globals__`, `__builtins__`).',
            '- **Pure JSON-serializable state `dict`s only:** use only `dict`, `list`, `str`, `int`, `float`, `bool`, and `None`. Never store `set`, `tuple` dict keys, `datetime` instances, custom classes, `NaN`, or `Infinity` in `state` or return values.',
            '- Copy `state` before mutating (e.g., `next_state = copy.deepcopy(state)` or `dict(state)`), handle missing/malformed inputs defensively, and keep execution well under 1500ms (no unbounded loops).',
        ].join('\n');
    }

    const hookList = [
        '- `function initState()` (or `function initState(ctx)`) — return the initial plain JSON state object.',
        '- `function onBeforeGenerate(state, ctx)` — pre-turn hook; handle time ticks (`ctx.time`), `!commands` (`ctx.command`), and pre-turn `promptInjection`.',
        mode === 'commands'
            ? '- (`onToolCall` is not required when `toolEnabled` is `false`.)'
            : '- `function onToolCall(state, call, ctx)` — mid-turn hook where `call` is `{ action, args }`; return `{ state, toolResult, ... }`.',
        '- `function onAfterGenerate(state, ctx)` — optional post-turn hook receiving `ctx.assistantMessage` and `ctx.turnLedger` (useful for turn counters, cleanup, or non-tool fallback).',
        '- `function renderMemo(state)` (or `function renderMemo(state, ctx)`) — return a plain multi-line string for the HUD card whenever `trackerTag` is non-empty (do NOT include `[TAG]...[/TAG]` wrappers).',
    ].join('\n');

    return [
        '### Language Rules: JavaScript ES2020 (`"lang": "js"`)',
        'Write plain ES2020 using top-level named `function` declarations (NO `import`/`export`, NO `require`, NO `module.exports` wrapper needed):',
        hookList,
        '- **Strictly sandboxed:** NO `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `window`, `document`, DOM APIs, `localStorage`, `indexedDB`, `importScripts`, `self`, `globalThis`, `eval`, `new Function`, `process`, or `require`.',
        '- **Pure JSON state only:** use only plain objects, arrays, finite numbers, strings, booleans, and `null`. Never store `Map`, `Set`, `Date`, `RegExp`, functions, or `NaN`/`Infinity` in `state`.',
        '- Avoid mutating caller references unexpectedly (clone with `{ ...state }` / `Object.assign({}, state)`), guard numbers with `clamp`, and keep execution fast (<1500ms; no unbounded `while` loops).',
    ].join('\n');
}

/**
 * Builds the system prompt for the Game Script AI Wizard.
 *
 * @param {{ lang?: 'js'|'python', interactionMode?: 'both'|'tools'|'commands' }} [options={}]
 * @returns {string}
 */
export function buildScriptWizardSystemPrompt(options = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    const lang = normalizeLang(opts.lang);
    const mode = normalizeInteractionMode(opts.interactionMode);

    const returnKeysBlock = lang === 'python'
        ? [
            '### Hook Return Dictionary Keys',
            'Hooks (`on_before_generate`, `on_tool_call`, `on_after_generate`) return a plain `dict` with any subset of these keys (prefer Python `snake_case`; `camelCase` equivalents are also accepted):',
            '- `"state"`: updated JSON-serializable `dict` (omit to leave state unchanged).',
            '- `"memo_block"` (`"memoBlock"`): optional `str` overriding `render_memo(state)` for this turn (`""` clears the `[TAG]` block).',
            '- `"prompt_injection"` (`"promptInjection"`): one-shot `str` injected into `[SCRIPT_EVENT]` for the Narrator on this turn only.',
            '- `"tool_result"` (`"toolResult"`): JSON-serializable verdict returned directly to the Narrator from `on_tool_call`.',
            '- `"strip_command"` (`"stripCommand"`): `bool` removing the matched `!command` line from the outgoing user prompt this turn.',
            '- `"portrait_url"` (`"portraitUrl"`): safe image URL (`https://`, `http://`, `/`, or `data:image/`, or `""` to clear) displayed on the HUD card.',
            '- `"append_markdown"` (`"appendMarkdown"`): one-shot Markdown snippet deterministically appended once to the finished assistant reply (track shown keys/URLs in `state` so it never repeats across turns).',
        ].join('\n')
        : [
            '### Hook Return Object Fields',
            'Hooks (`onBeforeGenerate`, `onToolCall`, `onAfterGenerate`) return a plain object with any subset of these optional fields:',
            '- `state`: updated plain JSON object (omit to leave state unchanged).',
            '- `memoBlock`: optional string overriding `renderMemo(state)` for this turn (`""` clears the `[TAG]` block).',
            '- `promptInjection`: one-shot string injected into `[SCRIPT_EVENT]` for the Narrator on this turn only.',
            '- `toolResult`: JSON-serializable verdict returned directly to the Narrator from `onToolCall`.',
            '- `stripCommand`: boolean removing the matched `!command` line from the outgoing user prompt this turn.',
            '- `portraitUrl`: safe image URL (`https://`, `http://`, `/`, or `data:image/`, or `""` to clear) displayed on the HUD card.',
            '- `appendMarkdown`: one-shot Markdown snippet deterministically appended once to the finished assistant reply (track shown keys/URLs in `state` so it never repeats across turns).',
        ].join('\n');

    return [
        'You are the Combat-Multihog Game Script Architect. Your job is to design deterministic, sandboxed Game Scripts that manage stateful RPG mechanics, meters, progression, commands, and Narrator tool calls without LLM arithmetic drift.',
        '',
        '### STRICT OUTPUT FORMAT',
        '- Output **ONLY** a single valid JSON object wrapped inside `<script_json>...</script_json>` tags.',
        '- Include **NO** prose, explanations, greetings, or markdown code fences outside `<script_json>...</script_json>` — and do **NOT** put markdown fences inside `<script_json>`.',
        '- Ensure the JSON is strictly valid (double-quoted keys/strings, escaped `\\n` and `\\"` inside `"code"` and `"gmPrompt"`, no trailing commas, no comments).',
        '',
        `### Canonical \`schemaVersion: ${SCRIPT_SCHEMA_VERSION}\` Script JSON Fields`,
        'Return a JSON object containing these exact top-level fields:',
        `- \`schemaVersion\`: \`${SCRIPT_SCHEMA_VERSION}\``,
        '- `id`: lowercase `snake_case` identifier matching `^[a-z0-9_]+$` (e.g. `"hearth_companion"`).',
        '- `name`: human-readable title shown in Settings and as the HUD card header fallback.',
        '- `icon`: single emoji or short glyph (e.g. `"🔥"`, `"📜"`).',
        '- `description`: concise 1-2 sentence summary of the mechanics simulated by this script.',
        `- \`lang\`: must be \`"${lang}"\`.`,
        `- \`scope\`: one of ${SCRIPT_SCOPES.map((s) => `\`"${s}"\``).join(', ')}.`,
        '- `boundCharacters`: array of character name strings for `"character"` scope (case-insensitive match); `[]` otherwise.',
        '- `globalEnabled`: boolean (`true` only when `scope === "global"` and active across all chats by default; otherwise `false`).',
        '- `trackerTag`: `UPPER_SNAKE_CASE` tag matching `^[A-Z0-9_]+$` (e.g. `"HEARTH_COMPANION"`), or `""` for headless scripts. Claimed tags are excluded from the LLM State Tracker automatically.',
        '- `commandPrefix`: leading `!` prefix with no spaces (e.g. `"!hearth"`), or `""` to disable `!command` parsing.',
        '- `stripCommandFromPrompt`: boolean (`true` to strip matched `!command` lines from the Narrator prompt).',
        '- `toolEnabled`: boolean (`true` to register a Narrator function tool).',
        '- `toolName`: valid identifier matching `^[A-Za-z][A-Za-z0-9_]{1,63}$` (typically `Script_<PascalCaseName>`, e.g. `"Script_HearthCompanion"`).',
        '- `toolDescription`: clear summary telling the Narrator when and why to call this tool.',
        '- `toolActions`: array of action objects:',
        '  `{ "name": "action_name", "description": "...", "params": [{ "name": "param_name", "type": "string"|"number"|"boolean", "required": true|false, "enum": ["..."], "description": "..." }] }`',
        '  - Action `name` must match `^[A-Za-z0-9][A-Za-z0-9_-]*$` and be unique.',
        '  - Parameter `name` MUST NEVER be `"action"` (reserved discriminator).',
        '  - Parameter `type` MUST be `"string"`, `"number"`, or `"boolean"` only (never `"integer"`/`"float"`/`"object"`/`"array"`).',
        '  - Omit `"enum"` when any freeform value is allowed.',
        '- `gmPrompt`: concise `<snake_case_tag>...</snake_case_tag>` instructions injected into the Narrator system prompt while active.',
        '  - Preserve literal `{{user}}` and `{{char}}` macros in `gmPrompt` (and in `promptInjection` guidance when referring to player/character) wherever appropriate.',
        '  - State explicitly that `[TRACKER_TAG]` is maintained deterministically by script and the Narrator must never invent, alter, or recalculate those numbers.',
        '  - Explain when to call `toolName` (if enabled) and never to ask the Narrator to write raw image URLs if `appendMarkdown` handles them.',
        `- \`code\`: complete, self-contained ${lang === 'python' ? 'Python 3' : 'ES2020 JavaScript'} source code string implementing the hooks.`,
        '',
        buildInteractionModeSection(mode, lang),
        '',
        '### Runtime Context (`ctx`) Reference',
        'Every hook receives a clean JSON-cloned `ctx` object with these fields:',
        '- `userMessage` (`string`): current user message.',
        '- `assistantMessage` (`string`): finished assistant reply (populated in `onAfterGenerate` / `on_after_generate`).',
        '- `command` (`null` or `{ prefix, subcommand, rawArgs, fullMatch, line, strippedMessage }`): parsed `!prefix` command; `subcommand` is lowercased with trailing `:` stripped (e.g. `!hearth comfort: embrace` -> `subcommand: "comfort"`, `rawArgs: "embrace"`).',
        '- `memoBlocks` (`Record<string, string>`): read-only map of parsed `[TAG]` bodies from `currentMemo`.',
        '- `time` (`{ current, prior, deltaMinutes, dayChanged }`): parsed `[TIME]` comparison (`deltaMinutes >= 0`, `dayChanged` boolean).',
        '- `character` (`{ name }`): active character metadata.',
        '- `user` (`{ name }`): active user/persona metadata.',
        '- `otherScripts` (`Record<string, object>`): read-only state snapshots of other active scripts keyed by script `id`.',
        '- `turnLedger` (`{ handledInPreTurn, handledInToolCall, toolCallCount, maxToolCallsPerTurn }`): read-only per-turn deduplication ledger.',
        '',
        returnKeysBlock,
        '',
        '### Native HUD Markers (`renderMemo` / `render_memo`)',
        'Return clean multi-line plain text (joined by `\\n`) without `[TAG]...[/TAG]` wrappers. Use Combat-Multihog’s native markers for rich HUD cards:',
        '- `Warmth ((BAR)) 65/100` — themed progress/resource bar',
        '- `Trust ((BARGREEN)) 80/100` — green bar (vitality, trust, affinity, stability)',
        '- `Danger ((BARRED)) 25/100` — red bar (threat, corruption, heat, drain)',
        '- `Status: ((PILLS)) Stage 2, Focused, Guarded` — comma-separated status pill badges',
        '',
        buildLanguageRulesSection(lang, mode),
    ].join('\n');
}

/**
 * Builds the user prompt for drafting a brand-new Game Script from a natural-language
 * brief and optional character card / story / lore / memo context.
 *
 * @param {{
 *   description?: string,
 *   characterCardSummary?: string,
 *   characterName?: string,
 *   storyContext?: string,
 *   loreContext?: string,
 *   currentMemo?: string,
 *   lang?: 'js'|'python',
 *   interactionMode?: 'both'|'tools'|'commands',
 * }} [options={}]
 * @returns {string}
 */
export function buildScriptWizardDraftUserPrompt(options = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    const lang = normalizeLang(opts.lang);
    const mode = normalizeInteractionMode(opts.interactionMode);

    const description = String(opts.description ?? '').trim();
    const characterCardSummary = String(opts.characterCardSummary ?? '').trim();
    const characterName = String(opts.characterName ?? '').trim();
    const storyContext = String(opts.storyContext ?? '').trim();
    const loreContext = String(opts.loreContext ?? '').trim();
    const currentMemo = String(opts.currentMemo ?? '').trim();

    const sections = [
        'Draft a complete, production-ready Combat-Multihog Game Script (`schemaVersion: 1`) matching the requirements below.',
        '',
        '### Target Configuration',
        `- Language: \`${lang}\``,
        `- Interaction Mode: \`${mode}\``,
        characterName
            ? `- Character Auto-Binding: Target character is **${characterName}**. Set \`"scope": "character"\` and \`"boundCharacters": [${JSON.stringify(characterName)}]\` (and \`"globalEnabled": false\`).`
            : '- Activation Scope: Unless the brief specifically asks for a global ruleset, default to `"scope": "chat"`, `"boundCharacters": []`, `"globalEnabled": false`.',
    ];

    if (description) {
        sections.push('', '### User Design Brief', description);
    } else if (characterCardSummary) {
        sections.push(
            '',
            '### User Design Brief',
            'No custom brief was entered — faithfully translate the mechanics, trackers, progression stages, resources, and rules described in the character card below into deterministic script logic.',
        );
    } else {
        sections.push(
            '',
            '### User Design Brief',
            'Design a clean, self-contained RPG state tracking script with deterministic state updates and clear HUD rendering.',
        );
    }

    if (characterCardSummary) {
        sections.push(
            '',
            '### Character Card Reference',
            characterCardSummary,
        );
    }

    if (storyContext) {
        sections.push(
            '',
            '### Recent Story Context',
            storyContext,
        );
    }

    if (loreContext) {
        sections.push(
            '',
            '### Active Lorebook / World Context',
            loreContext,
        );
    }

    if (currentMemo) {
        sections.push(
            '',
            '### Current State Memo Snapshot',
            'Use this only to understand existing tracker tags and tone (choose a distinct `trackerTag` that does not collide with unrelated stock/custom blocks unless intentionally replacing one):',
            currentMemo,
        );
    }

    sections.push(
        '',
        'Output ONLY the single `<script_json>...</script_json>` block containing the complete valid JSON object.',
    );

    return sections.join('\n');
}

function normalizeErrorList(list) {
    if (typeof list === 'string') {
        const clean = list.trim();
        return clean ? [clean] : [];
    }
    if (!Array.isArray(list)) return [];
    return list
        .map((item) => String(item ?? '').trim())
        .filter(Boolean);
}

function serializeCurrentScriptForIterate(currentScript) {
    if (typeof currentScript === 'string') {
        const trimmed = currentScript.trim();
        if (!trimmed) return '{}';
        try {
            const parsed = JSON.parse(trimmed);
            return JSON.stringify(parsed, null, 2);
        } catch (_) {
            return trimmed;
        }
    }
    if (currentScript && typeof currentScript === 'object') {
        try {
            return JSON.stringify(currentScript, null, 2);
        } catch (_) {
            return '{}';
        }
    }
    return '{}';
}

function detectCurrentScriptLang(currentScript) {
    if (currentScript && typeof currentScript === 'object' && !Array.isArray(currentScript)) {
        const raw = String(currentScript.lang ?? '').trim().toLowerCase();
        return raw || 'js';
    }
    if (typeof currentScript === 'string') {
        try {
            const parsed = JSON.parse(currentScript);
            if (parsed && typeof parsed === 'object') {
                const raw = String(parsed.lang ?? '').trim().toLowerCase();
                return raw || 'js';
            }
        } catch (_) {
            // Fall through
        }
    }
    return 'js';
}

/**
 * Builds the user prompt for iterating on, converting, or auto-repairing an
 * existing Game Script JSON payload.
 *
 * @param {{
 *   currentScript: object|string,
 *   instruction?: string,
 *   validationErrors?: string[],
 *   sandboxErrors?: string[],
 *   targetLang?: ''|'js'|'python',
 * }} [options={}]
 * @returns {string}
 */
export function buildScriptWizardIterateUserPrompt(options = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    const currentScript = opts.currentScript;
    const instruction = String(opts.instruction ?? '').trim();
    const validationErrors = normalizeErrorList(opts.validationErrors);
    const sandboxErrors = normalizeErrorList(opts.sandboxErrors);
    const rawTargetLang = String(opts.targetLang ?? '').trim().toLowerCase();

    const currentLang = detectCurrentScriptLang(currentScript);
    const hasLangConversion = Boolean(
        rawTargetLang &&
        SCRIPT_LANGUAGES.includes(rawTargetLang) &&
        rawTargetLang !== currentLang,
    );

    const serializedScript = serializeCurrentScriptForIterate(currentScript);

    const sections = [
        'Update the existing Combat-Multihog Game Script JSON below and return the complete revised script inside `<script_json>...</script_json>`.',
        '',
        '### Current Script JSON',
        serializedScript,
    ];

    if (hasLangConversion) {
        if (rawTargetLang === 'python') {
            sections.push(
                '',
                '### Language Conversion Directive (`js` -> `python`)',
                '- Convert `"lang"` to `"python"` and rewrite `"code"` into idiomatic Python 3 (`init_state(ctx=None)`, `on_before_generate(state, ctx)`, `on_tool_call(state, call, ctx)`, `on_after_generate(state, ctx)`, `render_memo(state, ctx=None)`).',
                '- Use snake_case return dictionary keys (`memo_block`, `prompt_injection`, `tool_result`, `strip_command`, `portrait_url`, `append_markdown`) while reading camelCase `ctx` keys (`ctx.get("time", {}).get("deltaMinutes")`, `ctx.get("command")`, etc.).',
                `- Use ONLY allowed Python stdlib modules (${PYTHON_ALLOWED_STDLIB.join(', ')}) and pure JSON-serializable state dicts.`,
                '- Preserve all gameplay mechanics, state fields, `trackerTag`, `commandPrefix`, `toolActions`, and `gmPrompt` behavior.',
            );
        } else {
            sections.push(
                '',
                '### Language Conversion Directive (`python` -> `js`)',
                '- Convert `"lang"` to `"js"` and rewrite `"code"` into plain ES2020 top-level named functions (`initState`, `onBeforeGenerate(state, ctx)`, `onToolCall(state, call, ctx)`, `onAfterGenerate(state, ctx)`, `renderMemo(state)`).',
                '- Use camelCase return fields (`state`, `memoBlock`, `promptInjection`, `toolResult`, `stripCommand`, `portraitUrl`, `appendMarkdown`) and pure JSON state.',
                '- Preserve all gameplay mechanics, state fields, `trackerTag`, `commandPrefix`, `toolActions`, and `gmPrompt` behavior.',
            );
        }
    }

    if (instruction) {
        sections.push('', '### Refinement Instruction', instruction);
    } else if (validationErrors.length > 0 || sandboxErrors.length > 0) {
        sections.push(
            '',
            '### Repair Directive',
            'Fix every validation and sandbox execution error listed below while preserving the script’s intended mechanics, schema fields, and `gmPrompt`.',
        );
    }

    if (validationErrors.length > 0) {
        sections.push(
            '',
            '### Schema / Validation Errors to Fix',
            ...validationErrors.map((err) => `- ${err}`),
        );
    }

    if (sandboxErrors.length > 0) {
        sections.push(
            '',
            '### Sandbox Execution Errors to Fix',
            ...sandboxErrors.map((err) => `- ${err}`),
        );
    }

    sections.push(
        '',
        'Return ONLY the complete, corrected JSON object inside `<script_json>...</script_json>` with no commentary outside the tag.',
    );

    return sections.join('\n');
}

function stripOptionalInnerFence(text) {
    const trimmed = String(text ?? '').trim();
    const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function scanBalancedBracesFrom(text, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i += 1) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            if (inString) escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === '{') {
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return {
                    endIndex: i,
                    slice: text.slice(startIndex, i + 1),
                    balanced: true,
                };
            }
        }
    }

    return {
        endIndex: text.length - 1,
        slice: text.slice(startIndex),
        balanced: false,
    };
}

function extractOutermostBalancedObject(text) {
    const raw = String(text ?? '');
    let searchFrom = 0;
    let firstCandidate = '';

    while (searchFrom < raw.length) {
        const start = raw.indexOf('{', searchFrom);
        if (start === -1) break;

        const scan = scanBalancedBracesFrom(raw, start);
        if (!firstCandidate) {
            firstCandidate = scan.slice.trim();
        }

        if (scan.balanced) {
            try {
                const parsed = JSON.parse(scan.slice);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return scan.slice.trim();
                }
            } catch (_) {
                // Keep scanning in case earlier braces appeared in reasoning prose.
            }
            searchFrom = scan.endIndex + 1;
        } else {
            break;
        }
    }

    return firstCandidate;
}

function extractJsonCandidateFromResponse(rawText) {
    const text = String(rawText ?? '');

    // 1. Explicit <script_json>...</script_json> wrapper (case-insensitive)
    const xmlMatch = /<script_json>([\s\S]*?)<\/script_json>/i.exec(text);
    if (xmlMatch) {
        const inner = stripOptionalInnerFence(xmlMatch[1]);
        try {
            JSON.parse(inner);
            return inner;
        } catch (_) {
            const balanced = extractOutermostBalancedObject(inner);
            if (balanced) {
                try {
                    JSON.parse(balanced);
                    return balanced;
                } catch (_) {
                    // Return the exact inner content so JSON.parse reports accurate syntax error.
                }
            }
            return inner;
        }
    }

    // 2. Fenced ```json ... ``` or ``` ... ``` block
    const fenceRe = /```(json)?\s*([\s\S]*?)```/gi;
    const fencedMatches = [];
    let match;
    while ((match = fenceRe.exec(text)) !== null) {
        fencedMatches.push({
            isJsonHint: Boolean(match[1]),
            body: String(match[2] ?? '').trim(),
        });
    }

    if (fencedMatches.length > 0) {
        const ordered = [
            ...fencedMatches.filter((m) => m.isJsonHint),
            ...fencedMatches.filter((m) => !m.isJsonHint),
        ];

        for (const candidate of ordered) {
            try {
                const parsed = JSON.parse(candidate.body);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return candidate.body;
                }
            } catch (_) {
                const balanced = extractOutermostBalancedObject(candidate.body);
                if (balanced) {
                    try {
                        const parsed = JSON.parse(balanced);
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            return balanced;
                        }
                    } catch (_) {
                        // Continue to next fence
                    }
                }
            }
        }

        return ordered[0].body;
    }

    // 3. Outermost balanced { ... } substring
    return extractOutermostBalancedObject(text);
}

/**
 * Parses and validates an LLM response from the Script Wizard.
 *
 * Extraction order:
 * 1. `<script_json>...</script_json>` (case-insensitive)
 * 2. Fenced ```` ```json ... ``` ```` or ```` ``` ... ``` ````
 * 3. Outermost balanced `{ ... }` substring
 *
 * @param {string} rawText
 * @param {{
 *   fallbackLang?: 'js'|'python',
 *   fallbackScope?: ''|'chat'|'global'|'character',
 *   fallbackBoundCharacters?: string[],
 * }} [options={}]
 * @returns {{
 *   ok: boolean,
 *   script: object|null,
 *   errors: string[],
 *   warnings: string[],
 *   rawJson: string,
 * }}
 */
export function parseScriptWizardResponse(rawText, options = {}) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
        return {
            ok: false,
            script: null,
            errors: ['Wizard response is empty.'],
            warnings: [],
            rawJson: '',
        };
    }

    const opts = (options && typeof options === 'object') ? options : {};
    const rawFallbackLang = String(opts.fallbackLang ?? 'js').trim().toLowerCase();
    const fallbackLang = SCRIPT_LANGUAGES.includes(rawFallbackLang) ? rawFallbackLang : 'js';

    const rawFallbackScope = String(opts.fallbackScope ?? '').trim().toLowerCase();
    const fallbackScope = SCRIPT_SCOPES.includes(rawFallbackScope) ? rawFallbackScope : '';

    const fallbackBoundCharacters = Array.isArray(opts.fallbackBoundCharacters)
        ? opts.fallbackBoundCharacters.map((c) => String(c ?? '').trim()).filter(Boolean)
        : (typeof opts.fallbackBoundCharacters === 'string' && opts.fallbackBoundCharacters.trim()
            ? [opts.fallbackBoundCharacters.trim()]
            : []);

    const rawJson = extractJsonCandidateFromResponse(rawText);
    if (!rawJson) {
        return {
            ok: false,
            script: null,
            errors: ['Could not locate a JSON object in the wizard response.'],
            warnings: [],
            rawJson: '',
        };
    }

    let parsed;
    try {
        parsed = JSON.parse(rawJson);
    } catch (error) {
        return {
            ok: false,
            script: null,
            errors: [`Invalid JSON: ${error?.message || String(error)}`],
            warnings: [],
            rawJson,
        };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            ok: false,
            script: null,
            errors: ['Wizard response JSON must represent an object.'],
            warnings: [],
            rawJson,
        };
    }

    const preNormalizeErrors = [];
    const preNormalizeWarnings = [];
    const candidate = { ...parsed };

    if (candidate.schemaVersion !== undefined && Number(candidate.schemaVersion) !== SCRIPT_SCHEMA_VERSION) {
        preNormalizeWarnings.push(
            `Script schemaVersion ${candidate.schemaVersion} differs from supported version ${SCRIPT_SCHEMA_VERSION}.`,
        );
    }

    const hasExplicitLang = candidate.lang !== undefined
        && candidate.lang !== null
        && String(candidate.lang).trim() !== '';
    if (!hasExplicitLang) {
        candidate.lang = fallbackLang;
    } else {
        const cleanLang = String(candidate.lang).trim().toLowerCase();
        if (!SCRIPT_LANGUAGES.includes(cleanLang)) {
            preNormalizeErrors.push(
                `Invalid script language "${candidate.lang}". Expected one of: ${SCRIPT_LANGUAGES.join(', ')}.`,
            );
        }
    }

    const hasExplicitScope = candidate.scope !== undefined
        && candidate.scope !== null
        && String(candidate.scope).trim() !== '';
    if (!hasExplicitScope) {
        if (fallbackScope) {
            candidate.scope = fallbackScope;
        }
    } else {
        const cleanScope = String(candidate.scope).trim().toLowerCase();
        if (!SCRIPT_SCOPES.includes(cleanScope)) {
            preNormalizeErrors.push(
                `Invalid script scope "${candidate.scope}". Expected one of: ${SCRIPT_SCOPES.join(', ')}.`,
            );
        }
    }

    const hasExplicitBound = candidate.boundCharacters !== undefined && candidate.boundCharacters !== null;
    if (!hasExplicitBound) {
        if (fallbackBoundCharacters.length > 0) {
            candidate.boundCharacters = [...fallbackBoundCharacters];
        }
    } else if (
        String(candidate.scope ?? '').trim().toLowerCase() === 'character'
        && Array.isArray(candidate.boundCharacters)
        && candidate.boundCharacters.length === 0
        && fallbackBoundCharacters.length > 0
    ) {
        candidate.boundCharacters = [...fallbackBoundCharacters];
    }

    const normalized = normalizeScriptDefinition(candidate);
    const validation = validateScriptDefinition(normalized);

    const errors = [...preNormalizeErrors, ...validation.errors];
    const warnings = [...preNormalizeWarnings, ...validation.warnings];
    const ok = errors.length === 0;

    return {
        ok,
        script: ok ? normalized : null,
        errors,
        warnings,
        rawJson,
    };
}
