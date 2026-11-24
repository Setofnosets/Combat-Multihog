/**
 * script-studio.js — Floating 4-tab Script Studio modal for creating, editing,
 * validating, and live-testing Combat-Multihog Game Scripts.
 */

import {
    SCRIPT_LANGUAGES,
    SCRIPT_SCOPES,
    buildToolSchemaFromActions,
    deriveScriptToolName,
    normalizeScriptDefinition,
    normalizeToolAction,
    normalizeToolParam,
    sanitizeCommandPrefix,
    sanitizePortraitUrl,
    sanitizeScriptId,
    sanitizeTrackerTag,
    validateScriptDefinition,
} from './core/script-schema.js';
import {
    SCRIPT_PATTERN_SNIPPETS,
    SCRIPT_STARTER_TEMPLATES,
    getStarterTemplateById,
} from './core/script-templates.js';
import {
    createTurnLedger,
    runSandboxSimulation,
} from './core/script-engine.js';
import { renderMemoAsCards } from '../../../renderer.js';
import { getSettingsOverlayAppearance } from '../../ui/settings-overlay.js';

const STUDIO_OVERLAY_ID = 'rt-script-studio-overlay';

const TAB_DEFS = [
    { id: 'setup', label: '1. Setup & Binding', icon: 'fa-sliders' },
    { id: 'prompt', label: '2. Narrator Prompt & Actions', icon: 'fa-wrench' },
    { id: 'code', label: '3. Code & Templates', icon: 'fa-code' },
    { id: 'sandbox', label: '4. Live Test Sandbox', icon: 'fa-flask' },
];

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function deepClone(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return value;
    }
}

function prettyJson(value) {
    if (value === undefined) return '';
    try {
        return JSON.stringify(value, null, 2);
    } catch (_) {
        return String(value ?? '');
    }
}

function normalizeTemplateActionsForDraft(rawActions) {
    if (!Array.isArray(rawActions)) return [];
    return rawActions.map((item) => {
        if (typeof item === 'string') {
            return normalizeToolAction({ name: item, description: '', params: [] });
        }
        return normalizeToolAction(item);
    }).filter((a) => a.name);
}

function buildInitialDraft(scriptOrNull) {
    if (scriptOrNull && typeof scriptOrNull === 'object') {
        const rawCopy = deepClone(scriptOrNull);
        const normalized = normalizeScriptDefinition(rawCopy);
        // Preserve explicit blank toolName only if user had cleared it; otherwise normalizeScriptDefinition handles it
        return normalized;
    }
    const blank = getStarterTemplateById('blank') || {
        name: 'New Game Script',
        icon: '📜',
        description: '',
        lang: 'js',
        scope: 'chat',
        boundCharacters: [],
        globalEnabled: false,
        trackerTag: 'SCRIPT_STATE',
        commandPrefix: '!script',
        stripCommandFromPrompt: true,
        toolEnabled: false,
        toolName: '',
        toolDescription: '',
        toolActions: [],
        gmPrompt: '',
        code: 'function initState() {\n    return {};\n}\n',
    };
    const draft = normalizeScriptDefinition({
        ...blank,
        id: '',
        name: 'New Game Script',
        toolName: '',
        toolActions: normalizeTemplateActionsForDraft(blank.toolActions),
    });
    return draft;
}

function parseCommaList(text) {
    const out = [];
    const seen = new Set();
    for (const part of String(text ?? '').split(',')) {
        const clean = part.trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
    }
    return out;
}

function buildDefaultArgsForAction(action) {
    if (!action || !Array.isArray(action.params)) return {};
    const out = {};
    for (const p of action.params) {
        if (!p?.name || p.name === 'action') continue;
        if (Array.isArray(p.enum) && p.enum.length > 0) {
            out[p.name] = p.enum[0];
        } else if (p.type === 'number') {
            out[p.name] = 1;
        } else if (p.type === 'boolean') {
            out[p.name] = false;
        } else {
            out[p.name] = '';
        }
    }
    return out;
}

function insertTextAtCursor(textarea, snippetText) {
    if (!textarea) return '';
    const value = textarea.value ?? '';
    const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : value.length;
    const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start;
    const prefixNeedsNewline = start > 0 && value[start - 1] !== '\n';
    const suffixNeedsNewline = end < value.length && value[end] !== '\n';
    const insertion = `${prefixNeedsNewline ? '\n' : ''}${snippetText}${suffixNeedsNewline ? '\n' : ''}`;
    const nextValue = value.slice(0, start) + insertion + value.slice(end);
    textarea.value = nextValue;
    const caret = start + insertion.length;
    try {
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
    } catch (_) {
        // Ignore selection errors in non-visual contexts
    }
    return nextValue;
}

function renderValidationMessageBox(validation, simResult = null) {
    const errors = [...(validation?.errors || [])];
    const warnings = [...(validation?.warnings || [])];
    if (simResult && !simResult.ok && simResult.error) {
        errors.push(`Sandbox initState() failed: ${simResult.error}`);
    }

    const parts = [];
    if (errors.length > 0) {
        parts.push(
            `<div class="rt-script-error-box" role="alert"><strong>Validation Errors:</strong>\n${errors.map((e) => `• ${escapeHtml(e)}`).join('\n')}</div>`,
        );
    } else if (validation) {
        parts.push(
            `<div style="padding:8px 10px;border-radius:8px;border:1px solid rgba(46,204,113,0.45);background:rgba(46,204,113,0.12);font-size:0.84em;line-height:1.4;">✅ <strong>Validation passed</strong>${simResult?.ok ? ` (${Number(simResult.durationMs || 0)}ms)` : ''}</div>`,
        );
    }

    if (warnings.length > 0) {
        parts.push(
            `<div style="padding:8px 10px;border-radius:8px;border:1px solid rgba(245,166,35,0.45);background:rgba(245,166,35,0.12);font-size:0.83em;line-height:1.4;white-space:pre-wrap;"><strong>Warnings:</strong>\n${warnings.map((w) => `• ${escapeHtml(w)}`).join('\n')}</div>`,
        );
    }

    return parts.join('');
}

function getAppearanceSafe() {
    try {
        return getSettingsOverlayAppearance() === 'dark' ? 'dark' : 'light';
    } catch (_) {
        return 'dark';
    }
}

function renderPreviewHud(tag, memoBlock) {
    const cleanTag = sanitizeTrackerTag(tag) || 'SCRIPT_PREVIEW';
    const body = String(memoBlock ?? '').trim();
    if (!body) {
        return '<div style="opacity:0.65;font-size:0.84em;font-style:italic;">No memoBlock returned. Set a Tracker [TAG] and implement renderMemo(state) to preview HUD cards.</div>';
    }
    const memoText = `[${cleanTag}]\n${body}\n[/${cleanTag}]`;
    try {
        return `<div class="rpg-tracker-panel rt-theme-native" style="position:relative;top:auto;right:auto;width:100%;height:auto;min-width:0;min-height:0;box-shadow:none;"><div class="rpg-tracker-render-view" style="padding:0;overflow:visible;">${renderMemoAsCards(memoText, cleanTag, {})}</div></div>`;
    } catch (err) {
        return `<div class="rt-script-error-box">HUD render failed: ${escapeHtml(err?.message || String(err))}</div>`;
    }
}

/**
 * Opens the floating Script Studio modal for creating or editing a Game Script.
 *
 * @param {object|null} scriptOrNull
 * @param {{
 *   onSave?: (normalizedDraft: object) => (void|Promise<void>),
 *   onCancel?: () => void,
 *   getActiveCharacterName?: () => string,
 *   isNew?: boolean,
 * }} [deps={}]
 * @returns {{ close: () => void, getDraft: () => object } | null}
 */
export function openScriptStudio(scriptOrNull, deps = {}) {
    if (typeof document === 'undefined' || !document.body) {
        return null;
    }

    document.getElementById(STUDIO_OVERLAY_ID)?.remove();

    const isEditingExisting = Boolean(scriptOrNull && typeof scriptOrNull === 'object' && scriptOrNull.id);
    const idManuallyLocked = { value: isEditingExisting };
    const draft = buildInitialDraft(scriptOrNull);

    let activeTab = 'setup';
    let validationReportHtml = '';
    let footerErrorHtml = '';

    // In-memory sandbox state isolated from live RP chats.
    const sandbox = {
        state: null,
        hasInitialized: false,
        ledger: createTurnLedger(),
        userMessage: '',
        deltaMinutes: 0,
        dayChanged: false,
        selectedAction: draft.toolActions[0]?.name || '',
        argsText: JSON.stringify(buildDefaultArgsForAction(draft.toolActions[0]), null, 2),
        assistantMessage: '',
        lastOutput: null,
        running: false,
    };

    const appearance = getAppearanceSafe();
    const overlay = document.createElement('div');
    overlay.id = STUDIO_OVERLAY_ID;
    overlay.className = `rt-so-mode-${appearance}`;
    overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:10150',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:12px',
        'background:rgba(0,0,0,0.58)',
        'box-sizing:border-box',
    ].join(';');

    const modal = document.createElement('div');
    modal.className = `rt-script-studio-modal rt-so-mode-${appearance}`;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', isEditingExisting ? `Edit Script: ${draft.name || draft.id}` : 'Script Studio');

    overlay.appendChild(modal);

    const onKeyDown = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeStudio(true);
        }
    };

    const closeStudio = (cancelled = false) => {
        document.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        if (cancelled) {
            try {
                deps?.onCancel?.();
            } catch (_) {
                // Non-fatal
            }
        }
    };

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeStudio(true);
        }
    });
    document.addEventListener('keydown', onKeyDown, true);

    function syncNormalizedDerivedFields() {
        if (!idManuallyLocked.value) {
            draft.id = sanitizeScriptId(draft.name);
        } else {
            draft.id = sanitizeScriptId(draft.id || draft.name);
        }
        draft.trackerTag = sanitizeTrackerTag(draft.trackerTag);
        draft.commandPrefix = sanitizeCommandPrefix(draft.commandPrefix);
    }

    function getNormalizedDraftSnapshot() {
        syncNormalizedDerivedFields();
        const normalized = normalizeScriptDefinition(draft);
        normalized.toolName = deriveScriptToolName({
            toolName: draft.toolName,
            name: normalized.name,
            id: normalized.id,
        });
        return normalized;
    }

    function getValidationCandidate() {
        const normalized = getNormalizedDraftSnapshot();
        // Preserve raw draft toolActions/params when toolEnabled is true so
        // validateScriptDefinition catches empty action or parameter names.
        if (normalized.toolEnabled && Array.isArray(draft.toolActions)) {
            normalized.toolActions = draft.toolActions.map((a) => ({
                name: String(a?.name ?? '').trim(),
                description: String(a?.description ?? '').trim(),
                params: Array.isArray(a?.params)
                    ? a.params.map((p) => ({
                        name: String(p?.name ?? '').trim(),
                        type: String(p?.type ?? 'string').trim().toLowerCase(),
                        required: Boolean(p?.required),
                        ...(Array.isArray(p?.enum) && p.enum.length > 0 ? { enum: [...p.enum] } : {}),
                        description: String(p?.description ?? '').trim(),
                    }))
                    : [],
            }));
        }
        return normalized;
    }

    function syncSandboxSelectedAction() {
        const actions = Array.isArray(draft.toolActions) ? draft.toolActions.filter((a) => a && a.name) : [];
        if (actions.length === 0) {
            sandbox.selectedAction = '';
            return;
        }
        const match = actions.find((a) => a.name === sandbox.selectedAction);
        if (!match) {
            sandbox.selectedAction = actions[0].name;
            sandbox.argsText = JSON.stringify(buildDefaultArgsForAction(actions[0]), null, 2);
        }
    }

    function renderSetupTabHtml() {
        const cleanTag = sanitizeTrackerTag(draft.trackerTag);
        const cleanPrefix = sanitizeCommandPrefix(draft.commandPrefix);
        const derivedTool = deriveScriptToolName(draft);
        const activeChar = typeof deps?.getActiveCharacterName === 'function'
            ? String(deps.getActiveCharacterName() || '').trim()
            : '';

        return `
            <div style="display:grid;grid-template-columns:minmax(0,1fr) 90px;gap:10px;">
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <label style="font-size:0.82em;font-weight:600;">Script Name</label>
                    <input type="text" id="rt-ss-name" class="text_pole" value="${escapeHtml(draft.name)}" placeholder="e.g. Stamina & Focus Meter" />
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <label style="font-size:0.82em;font-weight:600;">Icon</label>
                    <input type="text" id="rt-ss-icon" class="text_pole" value="${escapeHtml(draft.icon || '📜')}" maxlength="16" style="text-align:center;" />
                </div>
            </div>

            <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;">
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <label style="font-size:0.82em;font-weight:600;">Script ID <span style="opacity:0.65;font-weight:400;">(snake_case)</span></label>
                    <input type="text" id="rt-ss-id" class="text_pole" value="${escapeHtml(draft.id)}" ${isEditingExisting ? 'readonly title="Script ID is fixed while editing"' : ''} placeholder="auto_from_name" />
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <label style="font-size:0.82em;font-weight:600;">Language</label>
                    <select id="rt-ss-lang" class="text_pole">
                        ${SCRIPT_LANGUAGES.map((lang) => {
                            if (lang === 'js') {
                                return `<option value="js"${draft.lang === 'js' ? ' selected' : ''}>JavaScript (Sandboxed Worker)</option>`;
                            }
                            return `<option value="python" disabled${draft.lang === 'python' ? ' selected' : ''}>Python (Pyodide — Phase 2)</option>`;
                        }).join('')}
                    </select>
                    <small style="opacity:0.7;font-size:0.75em;">Python (Pyodide — Phase 2) coming soon; Phase 1 executes sandboxed JavaScript.</small>
                </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:4px;">
                <label style="font-size:0.82em;font-weight:600;">Description</label>
                <textarea id="rt-ss-desc" class="text_pole" rows="2" placeholder="What does this Game Script simulate?">${escapeHtml(draft.description)}</textarea>
            </div>

            <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:start;">
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:0.82em;font-weight:600;">Activation Scope</label>
                    <select id="rt-ss-scope" class="text_pole">
                        <option value="chat"${draft.scope === 'chat' ? ' selected' : ''}>Chat-specific (manual per chat)</option>
                        <option value="global"${draft.scope === 'global' ? ' selected' : ''}>Global (available everywhere)</option>
                        <option value="character"${draft.scope === 'character' ? ' selected' : ''}>Character Auto-Bind</option>
                    </select>
                </div>
                <div id="rt-ss-scope-extra" style="display:flex;flex-direction:column;gap:6px;padding-top:2px;">
                    ${draft.scope === 'global' ? `
                        <label class="checkbox_label" style="margin-top:20px;">
                            <input type="checkbox" id="rt-ss-global-enabled"${draft.globalEnabled ? ' checked' : ''} />
                            <span>Enabled globally by default</span>
                        </label>
                    ` : ''}
                    ${draft.scope === 'character' ? `
                        <label style="font-size:0.82em;font-weight:600;">Bound Character Names <span style="opacity:0.65;font-weight:400;">(comma-separated)</span></label>
                        <div style="display:flex;gap:6px;align-items:center;">
                            <input type="text" id="rt-ss-bound-chars" class="text_pole" style="flex:1;" value="${escapeHtml((draft.boundCharacters || []).join(', '))}" placeholder="e.g. Seraphina, Elena" />
                            <button type="button" id="rt-ss-add-current-char" class="menu_button interactable" ${activeChar ? '' : 'disabled title="No active character selected"'} style="white-space:nowrap;">Add Current Character${activeChar ? ` (${escapeHtml(activeChar)})` : ''}</button>
                        </div>
                    ` : ''}
                    ${draft.scope === 'chat' ? `
                        <div style="font-size:0.78em;opacity:0.72;margin-top:22px;">Enable or disable per chat in the Scripts settings list.</div>
                    ` : ''}
                </div>
            </div>

            <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;">
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <label style="font-size:0.82em;font-weight:600;">Tracker [TAG] <span style="opacity:0.65;font-weight:400;">(optional)</span></label>
                    <input type="text" id="rt-ss-tracker-tag" class="text_pole" value="${escapeHtml(draft.trackerTag)}" placeholder="e.g. VITAL_METER" />
                    <small style="opacity:0.72;font-size:0.76em;">Sanitized block preview: <code id="rt-ss-tag-preview">${cleanTag ? `[${escapeHtml(cleanTag)}]...[/ ${escapeHtml(cleanTag)}]`.replace('[/ ', '[/') : '(none — headless script)'}</code></small>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <label style="font-size:0.82em;font-weight:600;">!commandPrefix <span style="opacity:0.65;font-weight:400;">(optional)</span></label>
                    <input type="text" id="rt-ss-cmd-prefix" class="text_pole" value="${escapeHtml(draft.commandPrefix)}" placeholder="e.g. !meter" />
                    <small style="opacity:0.72;font-size:0.76em;">Normalized prefix: <code id="rt-ss-prefix-preview">${cleanPrefix ? escapeHtml(cleanPrefix) : '(none)'}</code></small>
                </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--rt-studio-border);border-radius:8px;background:var(--rt-studio-bg);">
                <label class="checkbox_label">
                    <input type="checkbox" id="rt-ss-strip-cmd"${draft.stripCommandFromPrompt ? ' checked' : ''} />
                    <span>Strip !command line from Narrator prompt</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="rt-ss-tool-enabled"${draft.toolEnabled ? ' checked' : ''} />
                    <span>Enable Narrator Tool Call</span>
                </label>
                <div id="rt-ss-tool-meta" style="display:${draft.toolEnabled ? 'grid' : 'none'};grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:10px;margin-top:4px;">
                    <div style="display:flex;flex-direction:column;gap:4px;">
                        <label style="font-size:0.8em;font-weight:600;">Tool Name <span style="opacity:0.65;font-weight:400;">(optional)</span></label>
                        <input type="text" id="rt-ss-tool-name" class="text_pole" value="${escapeHtml(draft.toolName)}" placeholder="${escapeHtml(derivedTool)}" />
                        <small style="opacity:0.7;font-size:0.75em;">Effective tool name: <code id="rt-ss-tool-name-preview">${escapeHtml(derivedTool)}</code></small>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:4px;">
                        <label style="font-size:0.8em;font-weight:600;">Tool Description <span style="opacity:0.65;font-weight:400;">(optional)</span></label>
                        <input type="text" id="rt-ss-tool-desc" class="text_pole" value="${escapeHtml(draft.toolDescription)}" placeholder="Shown to the Narrator LLM alongside action schemas" />
                    </div>
                </div>
            </div>
        `;
    }

    function renderActionBuilderCardsHtml() {
        const actions = Array.isArray(draft.toolActions) ? draft.toolActions : [];
        if (actions.length === 0) {
            return '<div style="padding:10px;border:1px dashed var(--rt-studio-border);border-radius:8px;opacity:0.75;font-size:0.85em;">No tool actions defined yet. Click "+ Add Action" to define structured actions the Narrator can invoke.</div>';
        }
        return actions.map((action, aIdx) => {
            const params = Array.isArray(action.params) ? action.params : [];
            const paramsHtml = params.length === 0
                ? '<div style="font-size:0.78em;opacity:0.65;">No parameters for this action.</div>'
                : params.map((param, pIdx) => `
                    <div class="rt-script-param-row" data-action-idx="${aIdx}" data-param-idx="${pIdx}">
                        <input type="text" class="text_pole rt-ss-param-name" value="${escapeHtml(param.name || '')}" placeholder="param_name" title="Parameter name" />
                        <select class="text_pole rt-ss-param-type" title="Parameter JSON type">
                            <option value="string"${param.type === 'string' ? ' selected' : ''}>string</option>
                            <option value="number"${param.type === 'number' ? ' selected' : ''}>number</option>
                            <option value="boolean"${param.type === 'boolean' ? ' selected' : ''}>boolean</option>
                        </select>
                        <label class="checkbox_label" style="font-size:0.8em;white-space:nowrap;">
                            <input type="checkbox" class="rt-ss-param-req"${param.required ? ' checked' : ''} />
                            <span>Required</span>
                        </label>
                        <input type="text" class="text_pole rt-ss-param-enum" value="${escapeHtml(Array.isArray(param.enum) ? param.enum.join(', ') : '')}" placeholder="Enum (comma-separated, optional)" title="Optional allowed enum values (comma-separated)" />
                        <button type="button" class="menu_button interactable rt-ss-remove-param" title="Remove Parameter" style="padding:4px 8px;">✕</button>
                        <input type="text" class="text_pole rt-ss-param-desc" value="${escapeHtml(param.description || '')}" placeholder="Parameter description for Narrator LLM" style="grid-column:1 / -1;" />
                    </div>
                `).join('');

            return `
                <div class="rt-script-action-card" data-action-idx="${aIdx}">
                    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                        <input type="text" class="text_pole rt-ss-action-name" value="${escapeHtml(action.name || '')}" placeholder="action_name (e.g. recover)" style="flex:1 1 170px;" />
                        <input type="text" class="text_pole rt-ss-action-desc" value="${escapeHtml(action.description || '')}" placeholder="Action description" style="flex:2 1 260px;" />
                        <button type="button" class="menu_button interactable rt-ss-remove-action" style="color:#ff7b7b;">Remove Action</button>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:6px;padding-left:6px;">
                        ${paramsHtml}
                        <div>
                            <button type="button" class="menu_button interactable rt-ss-add-param" style="font-size:0.8em;">+ Add Parameter</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderSchemaPreviewJson() {
        const previewDraft = getNormalizedDraftSnapshot();
        const schema = buildToolSchemaFromActions(previewDraft);
        if (!schema) {
            return previewDraft.toolEnabled
                ? '// Enable at least one action with a valid name to generate the function-calling tool schema.'
                : '// "Enable Narrator Tool Call" is currently off (enable it in Setup & Binding to expose this tool to the Narrator).';
        }
        return prettyJson(schema);
    }

    function renderPromptAndActionsTabHtml() {
        return `
            <div style="display:flex;flex-direction:column;gap:4px;">
                <label style="font-size:0.82em;font-weight:600;">&lt;gm_section&gt; Narrator Prompt</label>
                <small style="opacity:0.72;font-size:0.76em;">Injected into the Narrator system prompt while this script is active in the current chat.</small>
                <textarea id="rt-ss-gm-prompt" class="text_pole" rows="4" placeholder="Instruct the Narrator how to read the [TAG] block and when to invoke the tool...">${escapeHtml(draft.gmPrompt)}</textarea>
            </div>

            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                <div>
                    <strong style="font-size:0.9em;">Tool Action Builder</strong>
                    <div style="font-size:0.76em;opacity:0.72;">Compiled into the single <code>action</code>-discriminated tool schema registered with SillyTavern.</div>
                </div>
                <button type="button" id="rt-ss-add-action" class="menu_button interactable">+ Add Action</button>
            </div>

            <div id="rt-ss-actions-list" style="display:flex;flex-direction:column;gap:8px;">
                ${renderActionBuilderCardsHtml()}
            </div>

            <div style="display:flex;flex-direction:column;gap:4px;">
                <label style="font-size:0.82em;font-weight:600;">Generated Tool Schema Preview (Read-Only)</label>
                <pre id="rt-ss-schema-preview" style="margin:0;padding:10px;border-radius:8px;border:1px solid var(--rt-studio-border);background:var(--rt-studio-input-bg);color:var(--rt-studio-fg);font-family:var(--rt-font-mono,ui-monospace,monospace);font-size:11.5px;line-height:1.45;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;">${escapeHtml(renderSchemaPreviewJson())}</pre>
            </div>
        `;
    }

    function renderCodeAndTemplatesTabHtml() {
        return `
            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--rt-studio-border);background:var(--rt-studio-bg);">
                <label style="font-size:0.82em;font-weight:600;">Starter Template:</label>
                <select id="rt-ss-template-select" class="text_pole" style="flex:1 1 240px;">
                    ${SCRIPT_STARTER_TEMPLATES.map((tpl) => `<option value="${escapeHtml(tpl.id)}">${escapeHtml(tpl.icon || '📜')} ${escapeHtml(tpl.name)} — ${escapeHtml(tpl.description || '')}</option>`).join('')}
                </select>
                <button type="button" id="rt-ss-apply-template" class="menu_button interactable">Apply Template</button>
            </div>

            <div style="display:flex;flex-direction:column;gap:5px;">
                <label style="font-size:0.8em;font-weight:600;">Pattern Snippets <span style="opacity:0.68;font-weight:400;">(insert at cursor)</span>:</label>
                <div style="display:flex;flex-wrap:wrap;gap:6px;">
                    ${SCRIPT_PATTERN_SNIPPETS.map((snip) => `
                        <button type="button" class="menu_button interactable rt-ss-snippet-btn" data-snippet-id="${escapeHtml(snip.id)}" title="${escapeHtml(snip.description || '')}" style="font-size:0.78em;">+ ${escapeHtml(snip.label)}</button>
                    `).join('')}
                </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:4px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                    <label style="font-size:0.82em;font-weight:600;">JavaScript Sandbox Code</label>
                    <button type="button" id="rt-ss-validate-btn" class="menu_button interactable">Validate Script</button>
                </div>
                <textarea id="rt-ss-code" class="rt-script-code-editor" spellcheck="false" placeholder="Define initState(), onBeforeGenerate(state, ctx), onToolCall(state, call, ctx), onAfterGenerate(state, ctx), renderMemo(state, ctx)...">${escapeHtml(draft.code)}</textarea>
            </div>

            <div id="rt-ss-validation-box" style="display:flex;flex-direction:column;gap:6px;">
                ${validationReportHtml}
            </div>
        `;
    }

    function renderSandboxTabHtml() {
        syncSandboxSelectedAction();
        const actions = (Array.isArray(draft.toolActions) ? draft.toolActions : []).filter((a) => a && a.name);
        const out = sandbox.lastOutput;
        const stateText = sandbox.hasInitialized ? prettyJson(sandbox.state) : '// Click "Init / Reset State" or any Run button to initialize sandbox state.';

        const hudHtml = out?.memoBlock && String(out.memoBlock).trim()
            ? renderPreviewHud(draft.trackerTag, out.memoBlock)
            : '<div style="opacity:0.65;font-size:0.84em;font-style:italic;">Run Init or any hook with a Tracker [TAG] and renderMemo(state) to preview the rendered HUD card.</div>';

        const portraitUrl = sanitizePortraitUrl(out?.portraitUrl);
        const portraitPreviewHtml = portraitUrl
            ? `
                <div style="margin-top:8px;">
                    <div style="font-size:0.78em;font-weight:600;margin-bottom:4px;">portraitUrl Preview:</div>
                    <img src="${escapeHtml(portraitUrl)}" alt="Sandbox portrait" class="rt-script-card-portrait" style="max-height:180px;border-radius:6px;border:1px solid var(--rt-studio-border);" />
                    <div style="font-size:0.75em;opacity:0.75;word-break:break-all;margin-top:3px;">${escapeHtml(portraitUrl)}</div>
                </div>
            `
            : '';

        const diagParts = [];
        if (out) {
            diagParts.push(`Status: ${out.ok ? 'OK' : 'ERROR'} (${Number(out.durationMs || 0)}ms)`);
            if (out.error) diagParts.push(`Error: ${out.error}`);
            if (out.stripCommand) diagParts.push(`stripCommand: true\nstrippedMessage: ${JSON.stringify(out.strippedMessage)}`);
            if (out.promptInjection) diagParts.push(`promptInjection:\n${out.promptInjection}`);
            if (out.toolResult !== undefined) diagParts.push(`toolResult:\n${prettyJson(out.toolResult)}`);
            if (out.appendMarkdown) diagParts.push(`appendMarkdown:\n${out.appendMarkdown}`);
            if (out.portraitUrl !== undefined) diagParts.push(`portraitUrl: ${String(out.portraitUrl ?? '(cleared)')}`);
            if (Array.isArray(out.logs) && out.logs.length > 0) {
                diagParts.push(`Console Logs:\n${out.logs.map((l) => `  ${l}`).join('\n')}`);
            }
        } else {
            diagParts.push('No sandbox simulation run yet.');
        }

        return `
            <div style="display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:8px;border:1px solid var(--rt-studio-border);background:var(--rt-studio-bg);">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:0.8em;opacity:0.78;">Runs purely in memory inside this modal — zero impact on active chat state.</span>
                    <button type="button" id="rt-ss-sb-init" class="menu_button interactable"${sandbox.running ? ' disabled' : ''}>Init / Reset State</button>
                </div>

                <div style="display:grid;grid-template-columns:minmax(0,1fr) 120px auto auto;gap:8px;align-items:end;">
                    <div style="display:flex;flex-direction:column;gap:3px;">
                        <label style="font-size:0.78em;font-weight:600;">!command / User Message</label>
                        <input type="text" id="rt-ss-sb-user-msg" class="text_pole" value="${escapeHtml(sandbox.userMessage)}" placeholder="e.g. ${escapeHtml(sanitizeCommandPrefix(draft.commandPrefix) || '!script')} status" />
                    </div>
                    <div style="display:flex;flex-direction:column;gap:3px;">
                        <label style="font-size:0.78em;font-weight:600;">[TIME] +Minutes</label>
                        <input type="number" id="rt-ss-sb-delta-min" class="text_pole" min="0" step="1" value="${escapeHtml(String(sandbox.deltaMinutes ?? 0))}" />
                    </div>
                    <label class="checkbox_label" style="padding-bottom:6px;">
                        <input type="checkbox" id="rt-ss-sb-day-changed"${sandbox.dayChanged ? ' checked' : ''} />
                        <span>Day Changed</span>
                    </label>
                    <button type="button" id="rt-ss-sb-run-before" class="menu_button interactable"${sandbox.running ? ' disabled' : ''}>Run Pre-Turn</button>
                </div>

                <div style="display:grid;grid-template-columns:minmax(150px,220px) minmax(0,1fr) auto;gap:8px;align-items:end;">
                    <div style="display:flex;flex-direction:column;gap:3px;">
                        <label style="font-size:0.78em;font-weight:600;">Tool Action</label>
                        <select id="rt-ss-sb-action" class="text_pole">
                            ${actions.length > 0
                                ? actions.map((a) => `<option value="${escapeHtml(a.name)}"${a.name === sandbox.selectedAction ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('')
                                : '<option value="">(no toolActions defined)</option>'}
                        </select>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:3px;">
                        <label style="font-size:0.78em;font-weight:600;">JSON Args</label>
                        <textarea id="rt-ss-sb-args" class="text_pole" rows="2" style="font-family:var(--rt-font-mono,ui-monospace,monospace);font-size:12px;">${escapeHtml(sandbox.argsText)}</textarea>
                    </div>
                    <button type="button" id="rt-ss-sb-run-tool" class="menu_button interactable"${sandbox.running ? ' disabled' : ''}>Run Tool Call</button>
                </div>

                <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end;">
                    <div style="display:flex;flex-direction:column;gap:3px;">
                        <label style="font-size:0.78em;font-weight:600;">Assistant Reply</label>
                        <input type="text" id="rt-ss-sb-assistant-msg" class="text_pole" value="${escapeHtml(sandbox.assistantMessage)}" placeholder="Simulated Narrator reply for onAfterGenerate(state, ctx)" />
                    </div>
                    <button type="button" id="rt-ss-sb-run-after" class="menu_button interactable"${sandbox.running ? ' disabled' : ''}>Run Post-Turn</button>
                </div>
            </div>

            <div class="rt-script-sandbox-grid">
                <div class="rt-script-sandbox-pane">
                    <strong style="font-size:0.84em;">State JSON</strong>
                    <pre style="margin:0;max-height:260px;overflow:auto;font-family:var(--rt-font-mono,ui-monospace,monospace);font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;">${escapeHtml(stateText)}</pre>
                </div>
                <div class="rt-script-sandbox-pane">
                    <strong style="font-size:0.84em;">Rendered HUD Preview</strong>
                    <div style="max-height:260px;overflow:auto;">${hudHtml}${portraitPreviewHtml}</div>
                </div>
                <div class="rt-script-sandbox-pane" style="grid-column:1 / -1;">
                    <strong style="font-size:0.84em;">Prompt Injection / Tool Result / Media / Logs &amp; Errors</strong>
                    ${out && !out.ok && out.error ? `<div class="rt-script-error-box">${escapeHtml(out.error)}</div>` : ''}
                    <pre style="margin:0;max-height:220px;overflow:auto;font-family:var(--rt-font-mono,ui-monospace,monospace);font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;">${escapeHtml(diagParts.join('\n\n'))}</pre>
                </div>
            </div>
        `;
    }

    function bindActivePaneEvents() {
        const pane = modal.querySelector('.rt-script-studio-pane');
        if (!pane) return;

        if (activeTab === 'setup') {
            const nameInput = pane.querySelector('#rt-ss-name');
            const iconInput = pane.querySelector('#rt-ss-icon');
            const idInput = pane.querySelector('#rt-ss-id');
            const langSelect = pane.querySelector('#rt-ss-lang');
            const descInput = pane.querySelector('#rt-ss-desc');
            const scopeSelect = pane.querySelector('#rt-ss-scope');
            const globalChk = pane.querySelector('#rt-ss-global-enabled');
            const boundCharsInput = pane.querySelector('#rt-ss-bound-chars');
            const addCharBtn = pane.querySelector('#rt-ss-add-current-char');
            const tagInput = pane.querySelector('#rt-ss-tracker-tag');
            const tagPreview = pane.querySelector('#rt-ss-tag-preview');
            const prefixInput = pane.querySelector('#rt-ss-cmd-prefix');
            const prefixPreview = pane.querySelector('#rt-ss-prefix-preview');
            const stripChk = pane.querySelector('#rt-ss-strip-cmd');
            const toolEnabledChk = pane.querySelector('#rt-ss-tool-enabled');
            const toolMeta = pane.querySelector('#rt-ss-tool-meta');
            const toolNameInput = pane.querySelector('#rt-ss-tool-name');
            const toolNamePreview = pane.querySelector('#rt-ss-tool-name-preview');
            const toolDescInput = pane.querySelector('#rt-ss-tool-desc');

            nameInput?.addEventListener('input', () => {
                draft.name = nameInput.value;
                if (!idManuallyLocked.value && idInput) {
                    draft.id = sanitizeScriptId(draft.name);
                    idInput.value = draft.id;
                }
                if (toolNamePreview) {
                    toolNamePreview.textContent = deriveScriptToolName(draft);
                }
                if (toolNameInput) {
                    toolNameInput.placeholder = deriveScriptToolName({ ...draft, toolName: '' });
                }
            });

            iconInput?.addEventListener('input', () => {
                draft.icon = iconInput.value;
            });

            idInput?.addEventListener('input', () => {
                if (isEditingExisting) return;
                idManuallyLocked.value = Boolean(idInput.value.trim());
                draft.id = idInput.value;
                if (toolNamePreview) {
                    toolNamePreview.textContent = deriveScriptToolName(draft);
                }
            });

            langSelect?.addEventListener('change', () => {
                if (langSelect.value === 'js') {
                    draft.lang = 'js';
                }
            });

            descInput?.addEventListener('input', () => {
                draft.description = descInput.value;
            });

            scopeSelect?.addEventListener('change', () => {
                const nextScope = SCRIPT_SCOPES.includes(scopeSelect.value) ? scopeSelect.value : 'chat';
                draft.scope = nextScope;
                renderModal();
            });

            globalChk?.addEventListener('change', () => {
                draft.globalEnabled = Boolean(globalChk.checked);
            });

            boundCharsInput?.addEventListener('input', () => {
                draft.boundCharacters = parseCommaList(boundCharsInput.value);
            });

            addCharBtn?.addEventListener('click', () => {
                const activeChar = typeof deps?.getActiveCharacterName === 'function'
                    ? String(deps.getActiveCharacterName() || '').trim()
                    : '';
                if (!activeChar) return;
                const current = Array.isArray(draft.boundCharacters) ? [...draft.boundCharacters] : [];
                if (!current.some((c) => c.toLowerCase() === activeChar.toLowerCase())) {
                    current.push(activeChar);
                }
                draft.boundCharacters = current;
                if (boundCharsInput) {
                    boundCharsInput.value = current.join(', ');
                }
            });

            tagInput?.addEventListener('input', () => {
                draft.trackerTag = tagInput.value;
                const clean = sanitizeTrackerTag(tagInput.value);
                if (tagPreview) {
                    tagPreview.textContent = clean ? `[${clean}]...[/${clean}]` : '(none — headless script)';
                }
            });

            prefixInput?.addEventListener('input', () => {
                draft.commandPrefix = prefixInput.value;
                const clean = sanitizeCommandPrefix(prefixInput.value);
                if (prefixPreview) {
                    prefixPreview.textContent = clean || '(none)';
                }
            });

            stripChk?.addEventListener('change', () => {
                draft.stripCommandFromPrompt = Boolean(stripChk.checked);
            });

            toolEnabledChk?.addEventListener('change', () => {
                draft.toolEnabled = Boolean(toolEnabledChk.checked);
                if (toolMeta) {
                    toolMeta.style.display = draft.toolEnabled ? 'grid' : 'none';
                }
            });

            toolNameInput?.addEventListener('input', () => {
                draft.toolName = toolNameInput.value;
                if (toolNamePreview) {
                    toolNamePreview.textContent = deriveScriptToolName(draft);
                }
            });

            toolDescInput?.addEventListener('input', () => {
                draft.toolDescription = toolDescInput.value;
            });
            return;
        }

        if (activeTab === 'prompt') {
            const gmPromptTa = pane.querySelector('#rt-ss-gm-prompt');
            const schemaPre = pane.querySelector('#rt-ss-schema-preview');
            const refreshSchemaOnly = () => {
                if (schemaPre) {
                    schemaPre.textContent = renderSchemaPreviewJson();
                }
            };

            gmPromptTa?.addEventListener('input', () => {
                draft.gmPrompt = gmPromptTa.value;
            });

            pane.querySelector('#rt-ss-add-action')?.addEventListener('click', () => {
                if (!Array.isArray(draft.toolActions)) draft.toolActions = [];
                draft.toolActions.push({
                    name: `action_${draft.toolActions.length + 1}`,
                    description: '',
                    params: [],
                });
                renderModal();
            });

            pane.querySelectorAll('.rt-script-action-card').forEach((card) => {
                const aIdx = Number(card.getAttribute('data-action-idx'));
                const action = draft.toolActions?.[aIdx];
                if (!action) return;

                const nameInp = card.querySelector('.rt-ss-action-name');
                const descInp = card.querySelector('.rt-ss-action-desc');

                nameInp?.addEventListener('input', () => {
                    action.name = nameInp.value;
                    refreshSchemaOnly();
                });

                descInp?.addEventListener('input', () => {
                    action.description = descInp.value;
                    refreshSchemaOnly();
                });

                card.querySelector('.rt-ss-remove-action')?.addEventListener('click', () => {
                    draft.toolActions.splice(aIdx, 1);
                    renderModal();
                });

                card.querySelector('.rt-ss-add-param')?.addEventListener('click', () => {
                    if (!Array.isArray(action.params)) action.params = [];
                    action.params.push(normalizeToolParam({
                        name: `param_${action.params.length + 1}`,
                        type: 'string',
                        required: false,
                        description: '',
                    }));
                    renderModal();
                });

                card.querySelectorAll('.rt-script-param-row').forEach((row) => {
                    const pIdx = Number(row.getAttribute('data-param-idx'));
                    const param = action.params?.[pIdx];
                    if (!param) return;

                    const pNameInp = row.querySelector('.rt-ss-param-name');
                    const pTypeSel = row.querySelector('.rt-ss-param-type');
                    const pReqChk = row.querySelector('.rt-ss-param-req');
                    const pEnumInp = row.querySelector('.rt-ss-param-enum');
                    const pDescInp = row.querySelector('.rt-ss-param-desc');

                    pNameInp?.addEventListener('input', () => {
                        param.name = pNameInp.value;
                        refreshSchemaOnly();
                    });

                    pTypeSel?.addEventListener('change', () => {
                        param.type = pTypeSel.value;
                        refreshSchemaOnly();
                    });

                    pReqChk?.addEventListener('change', () => {
                        param.required = Boolean(pReqChk.checked);
                        refreshSchemaOnly();
                    });

                    pEnumInp?.addEventListener('input', () => {
                        const values = parseCommaList(pEnumInp.value);
                        if (values.length > 0) {
                            param.enum = values;
                        } else {
                            delete param.enum;
                        }
                        refreshSchemaOnly();
                    });

                    pDescInp?.addEventListener('input', () => {
                        param.description = pDescInp.value;
                        refreshSchemaOnly();
                    });

                    row.querySelector('.rt-ss-remove-param')?.addEventListener('click', () => {
                        action.params.splice(pIdx, 1);
                        renderModal();
                    });
                });
            });
            return;
        }

        if (activeTab === 'code') {
            const codeEditor = pane.querySelector('#rt-ss-code');
            const templateSelect = pane.querySelector('#rt-ss-template-select');

            codeEditor?.addEventListener('input', () => {
                draft.code = codeEditor.value;
            });

            pane.querySelector('#rt-ss-apply-template')?.addEventListener('click', () => {
                const templateId = templateSelect?.value;
                const tpl = getStarterTemplateById(templateId);
                if (!tpl) return;

                const hasExistingCode = Boolean(String(draft.code || '').trim());
                if (hasExistingCode && typeof globalThis.confirm === 'function') {
                    const confirmed = globalThis.confirm(
                        `Apply the "${tpl.name}" template? This will replace the current code, tracker tag, command prefix, narrator prompt, and action list in this draft.`,
                    );
                    if (!confirmed) return;
                }

                if (!isEditingExisting && (!draft.name || draft.name === 'New Game Script')) {
                    draft.name = tpl.name;
                    if (!idManuallyLocked.value) {
                        draft.id = sanitizeScriptId(tpl.name);
                    }
                }
                if (tpl.icon) draft.icon = tpl.icon;
                if (tpl.description && !draft.description) draft.description = tpl.description;
                draft.trackerTag = sanitizeTrackerTag(tpl.trackerTag);
                draft.commandPrefix = sanitizeCommandPrefix(tpl.commandPrefix);
                draft.stripCommandFromPrompt = Boolean(tpl.stripCommandFromPrompt);
                draft.toolEnabled = Boolean(tpl.toolEnabled);
                draft.toolName = tpl.toolName || '';
                draft.toolDescription = tpl.toolDescription || '';
                draft.toolActions = normalizeTemplateActionsForDraft(tpl.toolActions);
                draft.gmPrompt = tpl.gmPrompt || '';
                draft.code = tpl.code || '';

                validationReportHtml = '';
                sandbox.state = null;
                sandbox.hasInitialized = false;
                sandbox.ledger = createTurnLedger();
                sandbox.lastOutput = null;
                syncSandboxSelectedAction();
                renderModal();
            });

            pane.querySelectorAll('.rt-ss-snippet-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const snipId = btn.getAttribute('data-snippet-id');
                    const snip = SCRIPT_PATTERN_SNIPPETS.find((s) => s.id === snipId);
                    if (!snip || !codeEditor) return;
                    draft.code = insertTextAtCursor(codeEditor, snip.code);
                });
            });

            pane.querySelector('#rt-ss-validate-btn')?.addEventListener('click', async () => {
                const candidate = getValidationCandidate();
                const validation = validateScriptDefinition(candidate);
                let simRes = null;
                if (validation.valid && candidate.lang === 'js') {
                    simRes = await runSandboxSimulation(getNormalizedDraftSnapshot(), null, { type: 'init' });
                }
                validationReportHtml = renderValidationMessageBox(validation, simRes);
                const box = pane.querySelector('#rt-ss-validation-box');
                if (box) {
                    box.innerHTML = validationReportHtml;
                }
            });
            return;
        }

        if (activeTab === 'sandbox') {
            const userMsgInp = pane.querySelector('#rt-ss-sb-user-msg');
            const deltaMinInp = pane.querySelector('#rt-ss-sb-delta-min');
            const dayChangedChk = pane.querySelector('#rt-ss-sb-day-changed');
            const actionSel = pane.querySelector('#rt-ss-sb-action');
            const argsTa = pane.querySelector('#rt-ss-sb-args');
            const assistantMsgInp = pane.querySelector('#rt-ss-sb-assistant-msg');

            userMsgInp?.addEventListener('input', () => {
                sandbox.userMessage = userMsgInp.value;
            });
            deltaMinInp?.addEventListener('input', () => {
                const n = Number(deltaMinInp.value);
                sandbox.deltaMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
            });
            dayChangedChk?.addEventListener('change', () => {
                sandbox.dayChanged = Boolean(dayChangedChk.checked);
            });
            actionSel?.addEventListener('change', () => {
                sandbox.selectedAction = actionSel.value;
                const found = (draft.toolActions || []).find((a) => a.name === sandbox.selectedAction);
                if (found) {
                    sandbox.argsText = JSON.stringify(buildDefaultArgsForAction(found), null, 2);
                    if (argsTa) argsTa.value = sandbox.argsText;
                }
            });
            argsTa?.addEventListener('input', () => {
                sandbox.argsText = argsTa.value;
            });
            assistantMsgInp?.addEventListener('input', () => {
                sandbox.assistantMessage = assistantMsgInp.value;
            });

            const runSim = async (simEvent) => {
                if (sandbox.running) return;
                sandbox.running = true;
                renderModal();
                try {
                    const candidate = getNormalizedDraftSnapshot();
                    const res = await runSandboxSimulation(candidate, sandbox.state, simEvent);
                    if (simEvent.type === 'init') {
                        sandbox.ledger = createTurnLedger();
                    }
                    if (res.ok || simEvent.type === 'init') {
                        sandbox.state = res.state;
                        sandbox.hasInitialized = true;
                    }
                    sandbox.lastOutput = res;
                } catch (err) {
                    sandbox.lastOutput = {
                        ok: false,
                        state: sandbox.state,
                        memoBlock: null,
                        promptInjection: '',
                        toolResult: undefined,
                        portraitUrl: undefined,
                        appendMarkdown: '',
                        stripCommand: false,
                        strippedMessage: sandbox.userMessage,
                        logs: [],
                        error: err?.message || String(err),
                        durationMs: 0,
                    };
                } finally {
                    sandbox.running = false;
                    renderModal();
                }
            };

            pane.querySelector('#rt-ss-sb-init')?.addEventListener('click', () => {
                sandbox.state = null;
                sandbox.hasInitialized = false;
                sandbox.ledger = createTurnLedger();
                void runSim({ type: 'init' });
            });

            pane.querySelector('#rt-ss-sb-run-before')?.addEventListener('click', () => {
                void runSim({
                    type: 'beforeGenerate',
                    userMessage: sandbox.userMessage,
                    time: {
                        deltaMinutes: Number(sandbox.deltaMinutes || 0),
                        dayChanged: Boolean(sandbox.dayChanged),
                    },
                    ledger: sandbox.ledger,
                });
            });

            pane.querySelector('#rt-ss-sb-run-tool')?.addEventListener('click', () => {
                let parsedArgs = {};
                const rawArgsText = String(sandbox.argsText || '').trim();
                if (rawArgsText) {
                    try {
                        parsedArgs = JSON.parse(rawArgsText);
                    } catch (err) {
                        sandbox.lastOutput = {
                            ok: false,
                            state: sandbox.state,
                            memoBlock: null,
                            promptInjection: '',
                            toolResult: undefined,
                            portraitUrl: undefined,
                            appendMarkdown: '',
                            stripCommand: false,
                            strippedMessage: sandbox.userMessage,
                            logs: [],
                            error: `Invalid Tool JSON Args: ${err?.message || String(err)}`,
                            durationMs: 0,
                        };
                        renderModal();
                        return;
                    }
                }
                void runSim({
                    type: 'toolCall',
                    action: sandbox.selectedAction,
                    args: parsedArgs,
                    ledger: sandbox.ledger,
                });
            });

            pane.querySelector('#rt-ss-sb-run-after')?.addEventListener('click', () => {
                void runSim({
                    type: 'afterGenerate',
                    assistantMessage: sandbox.assistantMessage,
                    ledger: sandbox.ledger,
                });
            });
        }
    }

    function renderModal() {
        let activeBodyHtml = '';
        if (activeTab === 'setup') activeBodyHtml = renderSetupTabHtml();
        else if (activeTab === 'prompt') activeBodyHtml = renderPromptAndActionsTabHtml();
        else if (activeTab === 'code') activeBodyHtml = renderCodeAndTemplatesTabHtml();
        else activeBodyHtml = renderSandboxTabHtml();

        modal.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                    <span style="font-size:1.25em;">${escapeHtml(draft.icon || '📜')}</span>
                    <strong style="font-size:1em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${isEditingExisting ? 'Edit Game Script' : 'New Game Script'} — ${escapeHtml(draft.name || draft.id || 'Untitled')}</strong>
                </div>
                <button type="button" id="rt-ss-close-x" class="menu_button interactable" title="Close (Esc)">✕</button>
            </div>

            <div class="rt-script-studio-tabs" role="tablist">
                ${TAB_DEFS.map((t) => `
                    <button type="button" role="tab" aria-selected="${activeTab === t.id ? 'true' : 'false'}" class="rt-script-studio-tab${activeTab === t.id ? ' active' : ''}" data-studio-tab="${t.id}">
                        <i class="fa-solid ${t.icon}" style="margin-right:5px;"></i>${escapeHtml(t.label)}
                    </button>
                `).join('')}
            </div>

            <div class="rt-script-studio-pane">
                ${activeBodyHtml}
            </div>

            ${footerErrorHtml ? `<div id="rt-ss-footer-error">${footerErrorHtml}</div>` : ''}

            <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
                <button type="button" id="rt-ss-cancel" class="menu_button interactable">Cancel</button>
                <button type="button" id="rt-ss-save" class="menu_button interactable" style="background:var(--rt-studio-accent);border-color:var(--rt-studio-accent);color:#fff;font-weight:600;">Save Script</button>
            </div>
        `;

        modal.querySelector('#rt-ss-close-x')?.addEventListener('click', () => closeStudio(true));
        modal.querySelector('#rt-ss-cancel')?.addEventListener('click', () => closeStudio(true));

        modal.querySelectorAll('.rt-script-studio-tab').forEach((tabBtn) => {
            tabBtn.addEventListener('click', () => {
                const nextTab = tabBtn.getAttribute('data-studio-tab');
                if (!nextTab || nextTab === activeTab) return;
                activeTab = nextTab;
                footerErrorHtml = '';
                renderModal();
            });
        });

        modal.querySelector('#rt-ss-save')?.addEventListener('click', async () => {
            const candidate = getValidationCandidate();
            const validation = validateScriptDefinition(candidate);
            if (!validation.valid) {
                footerErrorHtml = `<div class="rt-script-error-box" role="alert"><strong>Cannot save script:</strong>\n${validation.errors.map((e) => `• ${escapeHtml(e)}`).join('\n')}</div>`;
                renderModal();
                return;
            }
            const normalized = getNormalizedDraftSnapshot();
            footerErrorHtml = '';
            try {
                if (typeof deps?.onSave === 'function') {
                    await deps.onSave(normalized);
                }
                closeStudio(false);
            } catch (err) {
                footerErrorHtml = `<div class="rt-script-error-box" role="alert">${escapeHtml(err?.message || String(err))}</div>`;
                renderModal();
            }
        });

        bindActivePaneEvents();
    }

    renderModal();
    document.body.appendChild(overlay);

    return {
        close: () => closeStudio(true),
        getDraft: () => getNormalizedDraftSnapshot(),
    };
}
