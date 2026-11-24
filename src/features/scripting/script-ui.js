/**
 * script-ui.js — Settings UI controller for Combat-Multihog Game Scripts:
 * master toggle, script list CRUD/reordering/import/export, collision banner,
 * live per-chat state inspector modal, and Script Studio launch wiring.
 */

import {
    deriveScriptToolName,
    detectScriptCollisions,
    normalizeScriptDefinition,
    parseScriptFromJson,
    sanitizeCommandPrefix,
    sanitizeScriptId,
    sanitizeTrackerTag,
    serializeScriptToJson,
} from './core/script-schema.js';
import {
    deleteScript,
    getChatScriptRecord,
    getChatScriptRecords,
    getScriptById,
    isScriptEnabledForChat,
    listScripts,
    reorderScripts,
    resetChatScriptState,
    resolveEnabledScriptsForChat,
    setChatScriptEnabled,
    setChatScriptRecord,
    upsertScript,
} from './script-store.js';
import {
    applyScriptMemoPatches,
    getActiveCharacterName as defaultGetActiveCharacterName,
    seedInitialScriptStateForChat,
    syncScriptToolRegistrations,
} from './script-host-adapter.js';
import { openScriptStudio } from './script-studio.js';
import { renderScriptMemo } from './core/script-engine.js';
import { getActiveChatId as defaultGetActiveChatId, getSettings as defaultGetSettings } from '../../../state-manager.js';
import {
    autoApplySysprompt as defaultApplySysprompt,
    refreshRenderedView as defaultRefreshRenderedView,
    saveSettings as defaultSaveSettings,
    syncMemoView as defaultSyncMemoView,
} from '../../app/runtime-bridge.js';
import { getSettingsOverlayAppearance } from '../../ui/settings-overlay.js';

const STATE_INSPECTOR_OVERLAY_ID = 'rt-script-state-inspector-overlay';

let _bound = false;
let _deps = {};

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function toast(level, message, title = 'Game Scripts') {
    try {
        const fn = globalThis?.toastr?.[level];
        if (typeof fn === 'function') {
            fn.call(globalThis.toastr, String(message ?? ''), title);
            return;
        }
    } catch (_) {
        // Fallback below
    }
    const logger = level === 'error' ? console.warn : console.log;
    logger('[RPG Tracker][Game Scripts]', message);
}

function getSettingsSafe() {
    if (typeof _deps.getSettings === 'function') {
        return _deps.getSettings();
    }
    return defaultGetSettings();
}

function saveSettingsSafe() {
    if (typeof _deps.saveSettings === 'function') {
        return _deps.saveSettings();
    }
    try {
        return defaultSaveSettings();
    } catch (_) {
        return undefined;
    }
}

function getActiveChatIdSafe() {
    if (typeof _deps.getActiveChatId === 'function') {
        return _deps.getActiveChatId();
    }
    try {
        return defaultGetActiveChatId();
    } catch (_) {
        return '';
    }
}

function getActiveCharacterNameSafe() {
    if (typeof _deps.getActiveCharacterName === 'function') {
        return String(_deps.getActiveCharacterName() || '').trim();
    }
    try {
        return defaultGetActiveCharacterName();
    } catch (_) {
        return '';
    }
}

function syncToolsSafe(settings, chatId) {
    if (typeof _deps.syncTools === 'function') {
        return _deps.syncTools(settings, chatId);
    }
    try {
        return syncScriptToolRegistrations(settings, chatId);
    } catch (_) {
        return undefined;
    }
}

async function applySyspromptSafe() {
    if (typeof _deps.applySysprompt === 'function') {
        return _deps.applySysprompt(true);
    }
    try {
        return await defaultApplySysprompt(true);
    } catch (_) {
        return undefined;
    }
}

function updateMemoUiSafe(settings) {
    const memoText = typeof settings?.currentMemo === 'string' ? settings.currentMemo : '';
    if (typeof _deps.updateUIMemo === 'function') {
        _deps.updateUIMemo(memoText);
        return;
    }
    try {
        globalThis._rpgUpdateUIMemo?.(memoText);
    } catch (_) {
        // Non-fatal
    }
    try {
        defaultSyncMemoView();
        return;
    } catch (_) {
        // Fallback below
    }
    try {
        defaultRefreshRenderedView();
    } catch (_) {
        // Non-fatal
    }
}

async function seedInitialStateSafe(settings, chatId, scriptId) {
    if (typeof _deps.seedInitialState === 'function') {
        return _deps.seedInitialState(settings, chatId, scriptId);
    }
    if (!chatId) return null;
    return seedInitialScriptStateForChat(settings, chatId, scriptId);
}

async function rerenderScriptMemoIntoChat(settings, chatId, script) {
    const tag = sanitizeTrackerTag(script?.trackerTag);
    if (!tag) return;
    const record = chatId ? getChatScriptRecord(settings, chatId, script.id) : null;
    if (!record || record.state === null || record.state === undefined) {
        applyScriptMemoPatches(settings, { [tag]: '' });
        updateMemoUiSafe(settings);
        return;
    }
    const memoRes = await renderScriptMemo(script, record.state, {});
    if (memoRes.ok && memoRes.memoBlock != null) {
        applyScriptMemoPatches(settings, { [tag]: memoRes.memoBlock });
        updateMemoUiSafe(settings);
    }
}

function getAppearanceSafe() {
    try {
        return getSettingsOverlayAppearance() === 'dark' ? 'dark' : 'light';
    } catch (_) {
        return 'dark';
    }
}

function formatScopeBadge(script) {
    const scope = String(script?.scope || 'chat').toLowerCase();
    if (scope === 'global') {
        return script?.globalEnabled ? 'Scope: Global (On)' : 'Scope: Global (Off)';
    }
    if (scope === 'character') {
        const chars = Array.isArray(script?.boundCharacters) ? script.boundCharacters : [];
        return chars.length > 0 ? `Scope: Char (${chars.join(', ')})` : 'Scope: Char (none)';
    }
    return 'Scope: Chat';
}

function formatReasonLabel(status) {
    if (!status) return '';
    switch (status.reason) {
        case 'disabled_master':
            return 'Master engine disabled';
        case 'override':
            return status.enabled ? 'Enabled in this chat (override)' : 'Disabled in this chat (override)';
        case 'global':
            return status.enabled ? 'Active via Global scope' : 'Inactive Global script';
        case 'character':
            return status.enabled ? 'Active via Character Auto-Bind' : 'Inactive (character mismatch)';
        case 'chat':
        default:
            return status.enabled ? 'Active in this chat' : 'Inactive in this chat';
    }
}

function formatTimestamp(ts) {
    const num = Number(ts);
    if (!Number.isFinite(num) || num <= 0) return 'Never updated';
    try {
        return new Date(num).toLocaleString();
    } catch (_) {
        return String(num);
    }
}

function makeUniqueScriptId(settings, baseId) {
    const existing = new Set(listScripts(settings).map((s) => s.id));
    const cleanBase = sanitizeScriptId(baseId);
    if (!existing.has(cleanBase)) return cleanBase;
    let suffix = 2;
    while (existing.has(`${cleanBase}_${suffix}`)) {
        suffix += 1;
    }
    return `${cleanBase}_${suffix}`;
}

function downloadScriptJson(script) {
    if (typeof document === 'undefined' || !document.body) return;
    const json = serializeScriptToJson(script);
    const filename = `${sanitizeScriptId(script?.id || script?.name || 'script')}.script.json`;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => {
        try {
            URL.revokeObjectURL(url);
        } catch (_) {
            // Ignore cleanup errors
        }
    }, 1000);
}

/**
 * Opens the inline JSON State Inspector modal for a script in the active chat.
 */
function openLiveStateInspectorModal(script) {
    if (typeof document === 'undefined' || !document.body || !script) return;
    document.getElementById(STATE_INSPECTOR_OVERLAY_ID)?.remove();

    const settings = getSettingsSafe();
    const chatId = getActiveChatIdSafe();
    if (!chatId) {
        toast('warning', 'Open a chat to inspect per-chat script state.');
        return;
    }

    const record = getChatScriptRecord(settings, chatId, script.id);
    const initialJson = JSON.stringify(record?.state ?? {}, null, 2);
    const appearance = getAppearanceSafe();

    const overlay = document.createElement('div');
    overlay.id = STATE_INSPECTOR_OVERLAY_ID;
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
    modal.className = `rt-script-studio-modal rt-so-mode-${appearance}`;
    modal.style.width = 'min(680px, 94vw)';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', `Live State Inspector: ${script.name || script.id}`);

    modal.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <strong style="font-size:0.98em;">${escapeHtml(script.icon || '📜')} Live State Inspector — ${escapeHtml(script.name || script.id)}</strong>
            <button type="button" id="rt-ssi-close" class="menu_button interactable" title="Close (Esc)">✕</button>
        </div>
        <div style="font-size:0.78em;opacity:0.76;">
            Chat: <code>${escapeHtml(chatId)}</code> · Last updated: ${escapeHtml(formatTimestamp(record?.lastUpdatedAt))}
        </div>
        ${record?.lastError ? `<div class="rt-script-error-box">Last Error: ${escapeHtml(record.lastError)}</div>` : ''}
        <textarea id="rt-ssi-json" class="rt-script-code-editor" style="min-height:260px;" spellcheck="false">${escapeHtml(initialJson)}</textarea>
        <div id="rt-ssi-error" style="display:none;"></div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <button type="button" id="rt-ssi-reset" class="menu_button interactable" style="color:#ff7b7b;">Reset State</button>
            <div style="display:flex;gap:8px;">
                <button type="button" id="rt-ssi-cancel" class="menu_button interactable">Cancel</button>
                <button type="button" id="rt-ssi-save" class="menu_button interactable" style="background:var(--rt-studio-accent);border-color:var(--rt-studio-accent);color:#fff;font-weight:600;">Save &amp; Render</button>
            </div>
        </div>
    `;

    overlay.appendChild(modal);

    const onKeyDown = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeInspector();
        }
    };

    const closeInspector = () => {
        document.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
    };

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeInspector();
    });
    document.addEventListener('keydown', onKeyDown, true);

    modal.querySelector('#rt-ssi-close')?.addEventListener('click', closeInspector);
    modal.querySelector('#rt-ssi-cancel')?.addEventListener('click', closeInspector);

    modal.querySelector('#rt-ssi-save')?.addEventListener('click', async () => {
        const ta = modal.querySelector('#rt-ssi-json');
        const errBox = modal.querySelector('#rt-ssi-error');
        const rawText = String(ta?.value ?? '').trim();
        let parsed;
        try {
            parsed = rawText ? JSON.parse(rawText) : {};
        } catch (err) {
            if (errBox) {
                errBox.style.display = 'block';
                errBox.className = 'rt-script-error-box';
                errBox.textContent = `Invalid JSON: ${err?.message || String(err)}`;
            }
            return;
        }
        if (errBox) {
            errBox.style.display = 'none';
        }
        const liveSettings = getSettingsSafe();
        setChatScriptRecord(liveSettings, chatId, script.id, {
            state: parsed,
            lastError: null,
        });
        await rerenderScriptMemoIntoChat(liveSettings, chatId, script);
        saveSettingsSafe();
        refreshScriptsUi();
        closeInspector();
        toast('success', `Saved state for "${script.name || script.id}".`);
    });

    modal.querySelector('#rt-ssi-reset')?.addEventListener('click', async () => {
        if (typeof globalThis.confirm === 'function') {
            const ok = globalThis.confirm(`Reset live state for "${script.name || script.id}" in this chat?`);
            if (!ok) return;
        }
        const liveSettings = getSettingsSafe();
        resetChatScriptState(liveSettings, chatId, script.id);
        await seedInitialStateSafe(liveSettings, chatId, script.id);
        updateMemoUiSafe(liveSettings);
        saveSettingsSafe();
        refreshScriptsUi();
        closeInspector();
        toast('info', `Reset state for "${script.name || script.id}".`);
    });

    document.body.appendChild(overlay);
}

function renderCollisionBanner(bannerEl, enabledScripts) {
    if (!bannerEl) return;
    const collisions = detectScriptCollisions(enabledScripts);
    if (!collisions.hasCollisions) {
        bannerEl.style.display = 'none';
        bannerEl.innerHTML = '';
        return;
    }

    const lines = [];
    for (const c of collisions.trackerTagCollisions) {
        lines.push(`Duplicate Tracker [${escapeHtml(c.value)}]: ${c.scriptNames.map(escapeHtml).join(', ')}`);
    }
    for (const c of collisions.commandPrefixCollisions) {
        lines.push(`Duplicate Command Prefix ${escapeHtml(c.value)}: ${c.scriptNames.map(escapeHtml).join(', ')}`);
    }
    for (const c of collisions.toolNameCollisions) {
        lines.push(`Duplicate Tool Name ${escapeHtml(c.value)}: ${c.scriptNames.map(escapeHtml).join(', ')}`);
    }

    bannerEl.style.display = 'flex';
    bannerEl.innerHTML = `
        <i class="fa-solid fa-triangle-exclamation" style="margin-top:2px;flex-shrink:0;"></i>
        <div>
            <strong>Active Script Collision Warning</strong>
            <div style="margin-top:2px;">${lines.join('<br/>')}</div>
        </div>
    `;
}

function openStudioForScript(scriptOrNull) {
    const isNew = !(scriptOrNull && scriptOrNull.id);
    openScriptStudio(scriptOrNull, {
        isNew,
        getActiveCharacterName: () => getActiveCharacterNameSafe(),
        onSave: async (normalizedDraft) => {
            const settings = getSettingsSafe();
            const chatId = getActiveChatIdSafe();
            const saved = upsertScript(settings, normalizedDraft);
            if (!saved) {
                throw new Error('Could not save script definition.');
            }
            if (isNew && saved.scope === 'chat' && chatId) {
                setChatScriptEnabled(settings, chatId, saved.id, true);
            }
            saveSettingsSafe();
            syncToolsSafe(settings, chatId);
            await applySyspromptSafe();
            if (chatId) {
                const status = isScriptEnabledForChat(settings, saved, chatId, getActiveCharacterNameSafe());
                if (status.enabled) {
                    await seedInitialStateSafe(settings, chatId, saved.id);
                    updateMemoUiSafe(settings);
                    saveSettingsSafe();
                }
            }
            refreshScriptsUi();
            toast('success', `Saved script "${saved.name || saved.id}".`);
        },
    });
}

async function handleImportedJsonText(rawText) {
    const parsed = parseScriptFromJson(rawText);
    if (!parsed.ok || !parsed.script) {
        const msg = (parsed.errors || ['Invalid script JSON file.']).join('\n');
        toast('error', msg);
        return;
    }

    const settings = getSettingsSafe();
    const chatId = getActiveChatIdSafe();
    const candidate = normalizeScriptDefinition(parsed.script);
    const existing = getScriptById(settings, candidate.id);

    if (existing) {
        const overwrite = typeof globalThis.confirm === 'function'
            ? globalThis.confirm(
                `A script with ID "${candidate.id}" ("${existing.name}") already exists.\n\nPress OK to overwrite it, or Cancel to import as a copy with a new ID.`,
            )
            : false;
        if (!overwrite) {
            candidate.id = makeUniqueScriptId(settings, candidate.id);
            candidate.name = `${candidate.name || candidate.id} (Imported)`;
        }
    }

    const saved = upsertScript(settings, candidate);
    if (!saved) {
        toast('error', 'Failed to import script.');
        return;
    }
    if (saved.scope === 'chat' && chatId) {
        setChatScriptEnabled(settings, chatId, saved.id, true);
    }

    saveSettingsSafe();
    syncToolsSafe(settings, chatId);
    await applySyspromptSafe();
    if (chatId) {
        const status = isScriptEnabledForChat(settings, saved, chatId, getActiveCharacterNameSafe());
        if (status.enabled) {
            await seedInitialStateSafe(settings, chatId, saved.id);
            updateMemoUiSafe(settings);
            saveSettingsSafe();
        }
    }
    refreshScriptsUi();
    if (parsed.warnings?.length) {
        toast('warning', `Imported "${saved.name}" with warnings: ${parsed.warnings.join('; ')}`);
    } else {
        toast('success', `Imported script "${saved.name || saved.id}".`);
    }
}

/**
 * Re-renders the Scripts settings tab list, collision banner, and live state section.
 */
export function refreshScriptsUi() {
    if (typeof document === 'undefined') return;

    const settings = getSettingsSafe();
    const chatId = getActiveChatIdSafe();
    const charName = getActiveCharacterNameSafe();

    const masterToggle = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_scripts_enabled'));
    if (masterToggle) {
        masterToggle.checked = settings?.gameScriptsEnabled !== false;
    }

    const allScripts = listScripts(settings);
    const enabledScripts = resolveEnabledScriptsForChat(settings, chatId, charName);

    const bannerEl = document.getElementById('rpg_scripts_collision_banner');
    renderCollisionBanner(bannerEl, enabledScripts);

    const listEl = document.getElementById('rpg_scripts_list');
    if (listEl) {
        if (allScripts.length === 0) {
            listEl.innerHTML = '<div style="padding:10px;border:1px dashed var(--rt-so-border,rgba(255,255,255,0.16));border-radius:8px;opacity:0.74;font-size:0.84em;">No Game Scripts yet. Click <strong>+ New Script</strong> to build one or <strong>Import .json</strong> to load a script file.</div>';
        } else {
            listEl.innerHTML = allScripts.map((script, idx) => {
                const status = isScriptEnabledForChat(settings, script, chatId, charName);
                const tag = sanitizeTrackerTag(script.trackerTag);
                const prefix = sanitizeCommandPrefix(script.commandPrefix);
                const actionsCount = Array.isArray(script.toolActions) ? script.toolActions.length : 0;
                const toolName = script.toolEnabled ? deriveScriptToolName(script) : '';
                const reasonLabel = formatReasonLabel(status);

                return `
                    <div class="rt-script-row" data-script-id="${escapeHtml(script.id)}">
                        <div class="rt-script-row-main">
                            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                                <label class="checkbox_label" style="margin:0;" title="${escapeHtml(reasonLabel)}">
                                    <input type="checkbox" class="rt-script-enable-chk" data-script-id="${escapeHtml(script.id)}"${status.enabled ? ' checked' : ''}${status.reason === 'disabled_master' ? ' disabled' : ''} />
                                    <span style="font-size:1.05em;">${escapeHtml(script.icon || '📜')}</span>
                                    <strong>${escapeHtml(script.name || script.id)}</strong>
                                </label>
                                <span style="font-size:0.76em;opacity:0.7;">${escapeHtml(reasonLabel)}</span>
                            </div>
                            ${script.description ? `<div style="font-size:0.8em;opacity:0.78;line-height:1.35;">${escapeHtml(script.description)}</div>` : ''}
                            <div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;">
                                <span class="rt-script-badge rt-script-badge--scope">${escapeHtml(formatScopeBadge(script))}</span>
                                <span class="rt-script-badge rt-script-badge--lang">${escapeHtml(String(script.lang || 'js').toUpperCase())}</span>
                                ${tag ? `<span class="rt-script-badge rt-script-badge--tag">[${escapeHtml(tag)}]</span>` : ''}
                                ${prefix ? `<span class="rt-script-badge rt-script-badge--prefix">${escapeHtml(prefix)}</span>` : ''}
                                ${script.toolEnabled ? `<span class="rt-script-badge" title="${escapeHtml(toolName)}">Tool: ${actionsCount} action${actionsCount === 1 ? '' : 's'}</span>` : ''}
                            </div>
                        </div>
                        <div class="rt-script-row-actions">
                            <button type="button" class="menu_button interactable rt-script-move-up" data-script-id="${escapeHtml(script.id)}" title="Move Up"${idx === 0 ? ' disabled' : ''}>↑</button>
                            <button type="button" class="menu_button interactable rt-script-move-down" data-script-id="${escapeHtml(script.id)}" title="Move Down"${idx === allScripts.length - 1 ? ' disabled' : ''}>↓</button>
                            <button type="button" class="menu_button interactable rt-script-edit" data-script-id="${escapeHtml(script.id)}">Edit</button>
                            <button type="button" class="menu_button interactable rt-script-state" data-script-id="${escapeHtml(script.id)}">Live State</button>
                            <button type="button" class="menu_button interactable rt-script-export" data-script-id="${escapeHtml(script.id)}">Export</button>
                            <button type="button" class="menu_button interactable rt-script-dup" data-script-id="${escapeHtml(script.id)}">Duplicate</button>
                            <button type="button" class="menu_button interactable rt-script-del" data-script-id="${escapeHtml(script.id)}" style="color:#ff6b6b;">Delete</button>
                        </div>
                    </div>
                `;
            }).join('');

            listEl.querySelectorAll('.rt-script-enable-chk').forEach((chk) => {
                chk.addEventListener('change', async () => {
                    const sid = chk.getAttribute('data-script-id');
                    if (!sid) return;
                    const liveSettings = getSettingsSafe();
                    const liveChatId = getActiveChatIdSafe();
                    if (!liveChatId) {
                        toast('warning', 'Open a chat to toggle per-chat script activation.');
                        refreshScriptsUi();
                        return;
                    }
                    const nextEnabled = Boolean(chk.checked);
                    setChatScriptEnabled(liveSettings, liveChatId, sid, nextEnabled);
                    const script = getScriptById(liveSettings, sid);
                    if (script) {
                        if (nextEnabled) {
                            await seedInitialStateSafe(liveSettings, liveChatId, sid);
                        } else if (sanitizeTrackerTag(script.trackerTag)) {
                            applyScriptMemoPatches(liveSettings, { [sanitizeTrackerTag(script.trackerTag)]: '' });
                        }
                    }
                    updateMemoUiSafe(liveSettings);
                    saveSettingsSafe();
                    syncToolsSafe(liveSettings, liveChatId);
                    await applySyspromptSafe();
                    refreshScriptsUi();
                });
            });

            listEl.querySelectorAll('.rt-script-move-up').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const sid = btn.getAttribute('data-script-id');
                    const liveSettings = getSettingsSafe();
                    const ids = listScripts(liveSettings).map((s) => s.id);
                    const i = ids.indexOf(sid);
                    if (i <= 0) return;
                    [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                    reorderScripts(liveSettings, ids);
                    saveSettingsSafe();
                    syncToolsSafe(liveSettings, getActiveChatIdSafe());
                    refreshScriptsUi();
                });
            });

            listEl.querySelectorAll('.rt-script-move-down').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const sid = btn.getAttribute('data-script-id');
                    const liveSettings = getSettingsSafe();
                    const ids = listScripts(liveSettings).map((s) => s.id);
                    const i = ids.indexOf(sid);
                    if (i === -1 || i >= ids.length - 1) return;
                    [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
                    reorderScripts(liveSettings, ids);
                    saveSettingsSafe();
                    syncToolsSafe(liveSettings, getActiveChatIdSafe());
                    refreshScriptsUi();
                });
            });

            listEl.querySelectorAll('.rt-script-edit').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const sid = btn.getAttribute('data-script-id');
                    const script = getScriptById(getSettingsSafe(), sid);
                    if (script) openStudioForScript(script);
                });
            });

            listEl.querySelectorAll('.rt-script-state').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const sid = btn.getAttribute('data-script-id');
                    const script = getScriptById(getSettingsSafe(), sid);
                    if (script) openLiveStateInspectorModal(script);
                });
            });

            listEl.querySelectorAll('.rt-script-export').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const sid = btn.getAttribute('data-script-id');
                    const script = getScriptById(getSettingsSafe(), sid);
                    if (script) downloadScriptJson(script);
                });
            });

            listEl.querySelectorAll('.rt-script-dup').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const sid = btn.getAttribute('data-script-id');
                    const liveSettings = getSettingsSafe();
                    const liveChatId = getActiveChatIdSafe();
                    const source = getScriptById(liveSettings, sid);
                    if (!source) return;
                    const newId = makeUniqueScriptId(liveSettings, `${source.id}_copy`);
                    const copy = normalizeScriptDefinition({
                        ...source,
                        id: newId,
                        name: `${source.name || source.id} (Copy)`,
                        toolName: '',
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    });
                    upsertScript(liveSettings, copy);
                    saveSettingsSafe();
                    syncToolsSafe(liveSettings, liveChatId);
                    await applySyspromptSafe();
                    refreshScriptsUi();
                    toast('success', `Duplicated as "${copy.name}".`);
                });
            });

            listEl.querySelectorAll('.rt-script-del').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const sid = btn.getAttribute('data-script-id');
                    const liveSettings = getSettingsSafe();
                    const liveChatId = getActiveChatIdSafe();
                    const script = getScriptById(liveSettings, sid);
                    if (!script) return;
                    if (typeof globalThis.confirm === 'function') {
                        const ok = globalThis.confirm(
                            `Delete Game Script "${script.name || script.id}"?\n\nThis removes the script definition and all per-chat saved script states.`,
                        );
                        if (!ok) return;
                    }
                    const tag = sanitizeTrackerTag(script.trackerTag);
                    deleteScript(liveSettings, sid);
                    if (tag) {
                        applyScriptMemoPatches(liveSettings, { [tag]: '' });
                        updateMemoUiSafe(liveSettings);
                    }
                    saveSettingsSafe();
                    syncToolsSafe(liveSettings, liveChatId);
                    await applySyspromptSafe();
                    refreshScriptsUi();
                    toast('info', `Deleted "${script.name || script.id}".`);
                });
            });
        }
    }

    const liveEl = document.getElementById('rpg_scripts_live_section');
    if (liveEl) {
        if (!chatId) {
            liveEl.innerHTML = '<div style="margin-top:8px;font-size:0.8em;opacity:0.7;">Open a chat to view live script states for that conversation.</div>';
            return;
        }
        const records = getChatScriptRecords(settings, chatId);
        if (enabledScripts.length === 0) {
            liveEl.innerHTML = '<div style="margin-top:8px;font-size:0.8em;opacity:0.7;">No Game Scripts active in the current chat.</div>';
            return;
        }

        liveEl.innerHTML = `
            <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--rt-so-border,rgba(255,255,255,0.12));display:flex;flex-direction:column;gap:6px;">
                <strong style="font-size:0.86em;">Active in Current Chat (${enabledScripts.length})</strong>
                ${enabledScripts.map((script) => {
                    const rec = records[script.id];
                    const updatedText = rec?.lastUpdatedAt ? formatTimestamp(rec.lastUpdatedAt) : 'Not initialized yet';
                    const errHtml = rec?.lastError
                        ? `<div class="rt-script-error-box" style="margin-top:4px;padding:5px 8px;">${escapeHtml(rec.lastError)}</div>`
                        : '';
                    return `
                        <div class="rt-script-row" style="padding:8px 10px;">
                            <div class="rt-script-row-main">
                                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                                    <span>${escapeHtml(script.icon || '📜')}</span>
                                    <strong style="font-size:0.92em;">${escapeHtml(script.name || script.id)}</strong>
                                    <span style="font-size:0.76em;opacity:0.72;">Last updated: ${escapeHtml(updatedText)}</span>
                                </div>
                                ${errHtml}
                            </div>
                            <div class="rt-script-row-actions">
                                <button type="button" class="menu_button interactable rt-script-live-inspect" data-script-id="${escapeHtml(script.id)}">Inspect State</button>
                                <button type="button" class="menu_button interactable rt-script-live-reset" data-script-id="${escapeHtml(script.id)}" style="color:#ff6b6b;">Reset</button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        liveEl.querySelectorAll('.rt-script-live-inspect').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sid = btn.getAttribute('data-script-id');
                const script = getScriptById(getSettingsSafe(), sid);
                if (script) openLiveStateInspectorModal(script);
            });
        });

        liveEl.querySelectorAll('.rt-script-live-reset').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const sid = btn.getAttribute('data-script-id');
                const liveSettings = getSettingsSafe();
                const liveChatId = getActiveChatIdSafe();
                const script = getScriptById(liveSettings, sid);
                if (!script || !liveChatId) return;
                if (typeof globalThis.confirm === 'function') {
                    const ok = globalThis.confirm(`Reset live state for "${script.name || script.id}" in this chat?`);
                    if (!ok) return;
                }
                resetChatScriptState(liveSettings, liveChatId, sid);
                await seedInitialStateSafe(liveSettings, liveChatId, sid);
                updateMemoUiSafe(liveSettings);
                saveSettingsSafe();
                refreshScriptsUi();
                toast('info', `Reset state for "${script.name || script.id}".`);
            });
        });
    }
}

/**
 * Binds settings-tab event listeners once and renders the initial Scripts UI.
 *
 * @param {{
 *   getSettings?: () => object,
 *   saveSettings?: () => any,
 *   getActiveChatId?: () => (string|null),
 *   getActiveCharacterName?: () => string,
 *   syncTools?: (settings: object, chatId: string|null) => any,
 *   applySysprompt?: (force?: boolean) => any,
 *   updateUIMemo?: (memoText: string) => any,
 *   seedInitialState?: (settings: object, chatId: string, scriptId: string) => Promise<any>,
 * }} [deps={}]
 */
export function installScriptsUi(deps = {}) {
    _deps = (deps && typeof deps === 'object') ? { ...deps } : {};

    if (typeof document !== 'undefined' && !_bound) {
        _bound = true;

        const masterChk = document.getElementById('rpg_scripts_enabled');
        masterChk?.addEventListener('change', async () => {
            const settings = getSettingsSafe();
            const chatId = getActiveChatIdSafe();
            settings.gameScriptsEnabled = Boolean(masterChk.checked);
            saveSettingsSafe();
            syncToolsSafe(settings, chatId);
            await applySyspromptSafe();
            refreshScriptsUi();
        });

        const newBtn = document.getElementById('rpg_scripts_new_btn');
        newBtn?.addEventListener('click', () => {
            openStudioForScript(null);
        });

        const importBtn = document.getElementById('rpg_scripts_import_btn');
        const importFile = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_scripts_import_file'));

        importBtn?.addEventListener('click', () => {
            if (!importFile) return;
            importFile.value = '';
            importFile.click();
        });

        importFile?.addEventListener('change', () => {
            const file = importFile.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                const text = String(event?.target?.result || '');
                await handleImportedJsonText(text);
            };
            reader.onerror = () => {
                toast('error', 'Failed to read the selected script file.');
            };
            reader.readAsText(file);
            importFile.value = '';
        });
    }

    refreshScriptsUi();
}
