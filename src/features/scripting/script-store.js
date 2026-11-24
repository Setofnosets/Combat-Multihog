/**
 * script-store.js — Catalog CRUD, per-chat activation overrides, runtime state
 * persistence, and swipe rollback snapshots for Combat-Multihog Game Scripts.
 */

import {
    normalizeScriptDefinition,
    sanitizePortraitUrl,
    sanitizeScriptId,
    sanitizeTrackerTag,
} from './core/script-schema.js';
import { removeChatSetupCatalogEntries } from '../../state/chat-setup.js';

function clone(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return null;
    }
}

function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeChatId(chatId) {
    if (chatId === null || chatId === undefined) return '';
    return String(chatId).trim();
}

function ensureCatalogContainers(settings) {
    if (!isPlainObject(settings)) return null;
    if (!Array.isArray(settings.gameScriptDatabase)) {
        settings.gameScriptDatabase = [];
    }
    if (!Array.isArray(settings.gameScriptOrder)) {
        settings.gameScriptOrder = [];
    }
    if (!isPlainObject(settings.gameScriptStatesByChat)) {
        settings.gameScriptStatesByChat = {};
    }
    return settings;
}

function normalizeRecord(raw) {
    const src = isPlainObject(raw) ? raw : {};
    const state = Object.prototype.hasOwnProperty.call(src, 'state') && src.state !== undefined
        ? clone(src.state)
        : null;

    let portraitUrl = '';
    if (typeof src.portraitUrl === 'string') {
        portraitUrl = src.portraitUrl.trim() ? sanitizePortraitUrl(src.portraitUrl) : '';
    }

    const rawUpdated = Number(src.lastUpdatedAt);
    const lastUpdatedAt = Number.isFinite(rawUpdated) && rawUpdated >= 0 ? rawUpdated : 0;

    const lastError = (src.lastError === null || src.lastError === undefined || src.lastError === '')
        ? null
        : String(src.lastError);

    return {
        state,
        portraitUrl,
        lastUpdatedAt,
        lastError,
    };
}

// ── 1. Catalog CRUD ────────────────────────────────────────────────────────────

/**
 * Returns normalized script definitions sorted by `settings.gameScriptOrder`
 * (appending any unordered ones stably in database order).
 *
 * @param {object} settings
 * @returns {Array<object>}
 */
export function listScripts(settings) {
    if (!isPlainObject(settings) || !Array.isArray(settings.gameScriptDatabase)) {
        return [];
    }

    const byId = new Map();
    const databaseOrderIds = [];
    for (const raw of settings.gameScriptDatabase) {
        if (!isPlainObject(raw)) continue;
        const normalized = normalizeScriptDefinition(raw);
        if (!byId.has(normalized.id)) {
            databaseOrderIds.push(normalized.id);
        }
        byId.set(normalized.id, normalized);
    }

    const ordered = [];
    const seen = new Set();
    const explicitOrder = Array.isArray(settings.gameScriptOrder) ? settings.gameScriptOrder : [];

    for (const rawId of explicitOrder) {
        const id = String(rawId ?? '').trim();
        if (!id || seen.has(id) || !byId.has(id)) continue;
        seen.add(id);
        ordered.push(byId.get(id));
    }

    for (const id of databaseOrderIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        ordered.push(byId.get(id));
    }

    return ordered;
}

/**
 * Returns a normalized script definition by ID, or `null` if not found.
 *
 * @param {object} settings
 * @param {string} scriptId
 * @returns {object|null}
 */
export function getScriptById(settings, scriptId) {
    if (!isPlainObject(settings) || !Array.isArray(settings.gameScriptDatabase)) {
        return null;
    }
    const targetId = String(scriptId ?? '').trim();
    if (!targetId) return null;

    for (const raw of settings.gameScriptDatabase) {
        if (!isPlainObject(raw)) continue;
        const rawId = raw.id ? sanitizeScriptId(raw.id) : '';
        if (rawId === targetId || String(raw.id ?? '').trim() === targetId) {
            return normalizeScriptDefinition(raw);
        }
        const normalized = normalizeScriptDefinition(raw);
        if (normalized.id === targetId) {
            return normalized;
        }
    }
    return null;
}

/**
 * Normalizes a script definition, inserts or updates it by `id` in
 * `settings.gameScriptDatabase`, ensures its `id` is in `settings.gameScriptOrder`,
 * updates `createdAt`/`updatedAt`, and returns the saved normalized definition.
 *
 * @param {object} settings
 * @param {object} rawDef
 * @returns {object|null}
 */
export function upsertScript(settings, rawDef) {
    if (!ensureCatalogContainers(settings)) return null;

    const now = Date.now();
    const incoming = isPlainObject(rawDef) ? rawDef : {};
    const normalized = normalizeScriptDefinition(incoming);

    const existingIndex = settings.gameScriptDatabase.findIndex((item) => {
        if (!isPlainObject(item)) return false;
        const itemId = String(item.id ?? '').trim();
        return itemId === normalized.id || sanitizeScriptId(item.id || item.name) === normalized.id;
    });

    if (existingIndex >= 0) {
        const prev = normalizeScriptDefinition(settings.gameScriptDatabase[existingIndex]);
        const prevCreated = Number(prev.createdAt);
        const rawCreated = Number(incoming.createdAt);
        normalized.createdAt = (Number.isFinite(rawCreated) && rawCreated > 0)
            ? rawCreated
            : (Number.isFinite(prevCreated) && prevCreated > 0 ? prevCreated : now);
        normalized.updatedAt = now;
        settings.gameScriptDatabase[existingIndex] = normalized;
    } else {
        const rawCreated = Number(incoming.createdAt);
        normalized.createdAt = Number.isFinite(rawCreated) && rawCreated > 0 ? rawCreated : now;
        normalized.updatedAt = now;
        settings.gameScriptDatabase.push(normalized);
    }

    const cleanOrder = [];
    const seenOrder = new Set();
    for (const rawId of settings.gameScriptOrder) {
        const id = String(rawId ?? '').trim();
        if (!id || seenOrder.has(id)) continue;
        seenOrder.add(id);
        cleanOrder.push(id);
    }
    if (!seenOrder.has(normalized.id)) {
        cleanOrder.push(normalized.id);
    }
    settings.gameScriptOrder = cleanOrder;

    return clone(normalized);
}

/**
 * Deletes a script from `gameScriptDatabase`, `gameScriptOrder`, all per-chat
 * runtime state maps `gameScriptStatesByChat[*][scriptId]`, and per-chat setup
 * overrides via `removeChatSetupCatalogEntries`.
 *
 * @param {object} settings
 * @param {string} scriptId
 * @returns {boolean}
 */
export function deleteScript(settings, scriptId) {
    if (!isPlainObject(settings)) return false;
    const targetId = String(scriptId ?? '').trim();
    if (!targetId) return false;

    const hadInDb = Array.isArray(settings.gameScriptDatabase)
        && settings.gameScriptDatabase.some(item => String(item?.id ?? '').trim() === targetId);
    const hadInOrder = Array.isArray(settings.gameScriptOrder)
        && settings.gameScriptOrder.some(id => String(id ?? '').trim() === targetId);

    if (Array.isArray(settings.gameScriptDatabase)) {
        settings.gameScriptDatabase = settings.gameScriptDatabase.filter(
            item => String(item?.id ?? '').trim() !== targetId,
        );
    }

    if (Array.isArray(settings.gameScriptOrder)) {
        settings.gameScriptOrder = settings.gameScriptOrder.filter(
            id => String(id ?? '').trim() !== targetId,
        );
    }

    let hadChatRuntimeState = false;
    if (isPlainObject(settings.gameScriptStatesByChat)) {
        for (const chatMap of Object.values(settings.gameScriptStatesByChat)) {
            if (isPlainObject(chatMap) && Object.prototype.hasOwnProperty.call(chatMap, targetId)) {
                delete chatMap[targetId];
                hadChatRuntimeState = true;
            }
        }
    }

    removeChatSetupCatalogEntries(settings, { gameScriptIds: [targetId] });

    return hadInDb || hadInOrder || hadChatRuntimeState;
}

/**
 * Updates `settings.gameScriptOrder` according to `orderedIds`, preserving
 * any valid existing IDs in `gameScriptDatabase` (or previous order) that were omitted.
 *
 * @param {object} settings
 * @param {Array<string>} orderedIds
 * @returns {Array<string>}
 */
export function reorderScripts(settings, orderedIds) {
    if (!ensureCatalogContainers(settings)) return [];

    const validIds = new Set();
    const dbIds = [];
    for (const raw of settings.gameScriptDatabase) {
        if (!isPlainObject(raw)) continue;
        const id = normalizeScriptDefinition(raw).id;
        if (!validIds.has(id)) {
            validIds.add(id);
            dbIds.push(id);
        }
    }

    const nextOrder = [];
    const seen = new Set();

    for (const rawId of Array.isArray(orderedIds) ? orderedIds : []) {
        const id = String(rawId ?? '').trim();
        if (!id || seen.has(id) || !validIds.has(id)) continue;
        seen.add(id);
        nextOrder.push(id);
    }

    for (const rawId of settings.gameScriptOrder) {
        const id = String(rawId ?? '').trim();
        if (!id || seen.has(id) || !validIds.has(id)) continue;
        seen.add(id);
        nextOrder.push(id);
    }

    for (const id of dbIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        nextOrder.push(id);
    }

    settings.gameScriptOrder = nextOrder;
    return [...nextOrder];
}

// ── 2. Per-Chat Activation Override & Scope / Character Auto-Binding ──────────

/**
 * Reads explicit per-chat boolean override from
 * `settings.chatStates?.[chatId]?.setup?.gameScriptStates?.[scriptId]`.
 *
 * @param {object} settings
 * @param {string} chatId
 * @param {string} scriptId
 * @returns {boolean|undefined}
 */
export function getChatScriptOverride(settings, chatId, scriptId) {
    const cid = normalizeChatId(chatId);
    const sid = String(scriptId ?? '').trim();
    if (!cid || !sid || !isPlainObject(settings)) return undefined;

    const states = settings.chatStates?.[cid]?.setup?.gameScriptStates;
    if (!isPlainObject(states)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(states, sid)) return undefined;

    const val = states[sid];
    return typeof val === 'boolean' ? val : undefined;
}

/**
 * Sets or clears an explicit per-chat boolean override in
 * `settings.chatStates[chatId].setup.gameScriptStates[scriptId]`.
 * Passing `null` or `undefined` clears the override back to default scope behavior.
 *
 * @param {object} settings
 * @param {string} chatId
 * @param {string} scriptId
 * @param {boolean|null|undefined} enabled
 * @returns {boolean|undefined}
 */
export function setChatScriptEnabled(settings, chatId, scriptId, enabled) {
    const cid = normalizeChatId(chatId);
    const sid = String(scriptId ?? '').trim();
    if (!cid || !sid || !isPlainObject(settings)) return undefined;

    if (enabled === null || enabled === undefined) {
        const states = settings.chatStates?.[cid]?.setup?.gameScriptStates;
        if (isPlainObject(states)) {
            delete states[sid];
        }
        return undefined;
    }

    if (!isPlainObject(settings.chatStates)) {
        settings.chatStates = {};
    }
    if (!isPlainObject(settings.chatStates[cid])) {
        settings.chatStates[cid] = {};
    }
    if (!isPlainObject(settings.chatStates[cid].setup)) {
        settings.chatStates[cid].setup = {};
    }
    if (!isPlainObject(settings.chatStates[cid].setup.gameScriptStates)) {
        settings.chatStates[cid].setup.gameScriptStates = {};
    }

    const boolVal = Boolean(enabled);
    settings.chatStates[cid].setup.gameScriptStates[sid] = boolVal;
    return boolVal;
}

/**
 * Resolves whether a script is enabled in a given chat and character context.
 *
 * @param {object} settings
 * @param {object} script
 * @param {string} chatId
 * @param {string} [characterName='']
 * @returns {{ enabled: boolean, reason: 'override' | 'global' | 'character' | 'chat' | 'disabled_master' }}
 */
export function isScriptEnabledForChat(settings, script, chatId, characterName = '') {
    if (settings?.gameScriptsEnabled === false) {
        return { enabled: false, reason: 'disabled_master' };
    }

    const scriptId = String(script?.id ?? '').trim();
    const override = scriptId ? getChatScriptOverride(settings, chatId, scriptId) : undefined;
    if (typeof override === 'boolean') {
        return { enabled: override, reason: 'override' };
    }

    const scope = String(script?.scope ?? 'chat').trim().toLowerCase();
    if (scope === 'global') {
        return { enabled: Boolean(script?.globalEnabled), reason: 'global' };
    }

    if (scope === 'character') {
        const targetChar = String(characterName ?? '').trim().toLowerCase();
        const bound = Array.isArray(script?.boundCharacters) ? script.boundCharacters : [];
        const matched = Boolean(
            targetChar && bound.some(entry => String(entry ?? '').trim().toLowerCase() === targetChar),
        );
        return { enabled: matched, reason: 'character' };
    }

    return { enabled: false, reason: 'chat' };
}

/**
 * Returns enabled normalized scripts for `chatId` in `gameScriptOrder` priority order.
 *
 * @param {object} settings
 * @param {string} chatId
 * @param {string} [characterName='']
 * @returns {Array<object>}
 */
export function resolveEnabledScriptsForChat(settings, chatId, characterName = '') {
    if (settings?.gameScriptsEnabled === false) return [];
    const scripts = listScripts(settings);
    return scripts.filter(script => isScriptEnabledForChat(settings, script, chatId, characterName).enabled);
}

/**
 * Returns a `Set<string>` of uppercase `trackerTag` strings owned by enabled scripts in this chat.
 *
 * @param {object} settings
 * @param {string} chatId
 * @param {string} [characterName='']
 * @returns {Set<string>}
 */
export function getClaimedScriptTags(settings, chatId, characterName = '') {
    const tags = new Set();
    const enabledScripts = resolveEnabledScriptsForChat(settings, chatId, characterName);
    for (const script of enabledScripts) {
        const tag = sanitizeTrackerTag(script?.trackerTag);
        if (tag) {
            tags.add(tag);
        }
    }
    return tags;
}

// ── 3. Per-Chat Runtime State ──────────────────────────────────────────────────

/**
 * Returns a plain object map `{ [scriptId]: record }` for `chatId` (never `null`).
 *
 * @param {object} settings
 * @param {string} chatId
 * @returns {Record<string, { state: any, portraitUrl: string, lastUpdatedAt: number, lastError: string|null }>}
 */
export function getChatScriptRecords(settings, chatId) {
    const cid = normalizeChatId(chatId);
    if (!cid || !isPlainObject(settings?.gameScriptStatesByChat)) return {};

    const rawChatMap = settings.gameScriptStatesByChat[cid];
    if (!isPlainObject(rawChatMap)) return {};

    const result = {};
    for (const [scriptId, record] of Object.entries(rawChatMap)) {
        const sid = String(scriptId ?? '').trim();
        if (!sid || !isPlainObject(record)) continue;
        result[sid] = normalizeRecord(record);
    }
    return result;
}

/**
 * Returns the runtime record for `(chatId, scriptId)` or `null`.
 *
 * @param {object} settings
 * @param {string} chatId
 * @param {string} scriptId
 * @returns {{ state: any, portraitUrl: string, lastUpdatedAt: number, lastError: string|null }|null}
 */
export function getChatScriptRecord(settings, chatId, scriptId) {
    const cid = normalizeChatId(chatId);
    const sid = String(scriptId ?? '').trim();
    if (!cid || !sid || !isPlainObject(settings?.gameScriptStatesByChat)) return null;

    const rawRecord = settings.gameScriptStatesByChat[cid]?.[sid];
    if (!isPlainObject(rawRecord)) return null;
    return normalizeRecord(rawRecord);
}

/**
 * Returns deep-cloned `record.state` or `null`.
 *
 * @param {object} settings
 * @param {string} chatId
 * @param {string} scriptId
 * @returns {any}
 */
export function getChatScriptState(settings, chatId, scriptId) {
    const record = getChatScriptRecord(settings, chatId, scriptId);
    if (!record || record.state === null || record.state === undefined) return null;
    return clone(record.state);
}

/**
 * Updates or creates the runtime record at `settings.gameScriptStatesByChat[chatId][scriptId]`.
 *
 * @param {object} settings
 * @param {string} chatId
 * @param {string} scriptId
 * @param {object} patch
 * @returns {{ state: any, portraitUrl: string, lastUpdatedAt: number, lastError: string|null }|null}
 */
export function setChatScriptRecord(settings, chatId, scriptId, patch = {}) {
    const cid = normalizeChatId(chatId);
    const sid = String(scriptId ?? '').trim();
    if (!cid || !sid || !ensureCatalogContainers(settings)) return null;

    if (!isPlainObject(settings.gameScriptStatesByChat[cid])) {
        settings.gameScriptStatesByChat[cid] = {};
    }

    const existingRaw = settings.gameScriptStatesByChat[cid][sid];
    const current = isPlainObject(existingRaw)
        ? normalizeRecord(existingRaw)
        : { state: null, portraitUrl: '', lastUpdatedAt: 0, lastError: null };

    const p = isPlainObject(patch) ? patch : {};
    const next = { ...current };

    if (Object.prototype.hasOwnProperty.call(p, 'state')) {
        next.state = p.state === undefined ? null : clone(p.state);
    }

    if (Object.prototype.hasOwnProperty.call(p, 'portraitUrl')) {
        if (p.portraitUrl === null || p.portraitUrl === undefined || p.portraitUrl === '') {
            next.portraitUrl = '';
        } else if (typeof p.portraitUrl === 'string') {
            next.portraitUrl = sanitizePortraitUrl(p.portraitUrl);
        }
    }

    if (Object.prototype.hasOwnProperty.call(p, 'lastError')) {
        next.lastError = (p.lastError === null || p.lastError === undefined || p.lastError === '')
            ? null
            : String(p.lastError);
    }

    if (Object.prototype.hasOwnProperty.call(p, 'lastUpdatedAt')) {
        const ts = Number(p.lastUpdatedAt);
        next.lastUpdatedAt = Number.isFinite(ts) && ts >= 0 ? ts : Date.now();
    } else {
        next.lastUpdatedAt = Date.now();
    }

    settings.gameScriptStatesByChat[cid][sid] = next;
    return normalizeRecord(next);
}

/**
 * Removes `settings.gameScriptStatesByChat[chatId][scriptId]` so the next run
 * re-initializes state via `initState()`.
 *
 * @param {object} settings
 * @param {string} chatId
 * @param {string} scriptId
 * @returns {boolean}
 */
export function resetChatScriptState(settings, chatId, scriptId) {
    const cid = normalizeChatId(chatId);
    const sid = String(scriptId ?? '').trim();
    if (!cid || !sid || !isPlainObject(settings?.gameScriptStatesByChat)) return false;

    const chatMap = settings.gameScriptStatesByChat[cid];
    if (!isPlainObject(chatMap) || !Object.prototype.hasOwnProperty.call(chatMap, sid)) {
        return false;
    }

    delete chatMap[sid];
    return true;
}

// ── 4. Swipe Rollback Snapshots ────────────────────────────────────────────────

/**
 * Deep-clones `settings.gameScriptStatesByChat?.[chatId] || {}`.
 *
 * @param {object} settings
 * @param {string} chatId
 * @returns {Record<string, object>}
 */
export function captureScriptSnapshot(settings, chatId) {
    const cid = normalizeChatId(chatId);
    if (!cid || !isPlainObject(settings?.gameScriptStatesByChat)) return {};
    const chatMap = settings.gameScriptStatesByChat[cid];
    if (!isPlainObject(chatMap)) return {};
    return clone(chatMap) || {};
}

/**
 * Attaches before/after script runtime snapshots for `swipeId` onto `lastAiMsg.extra`.
 *
 * @param {object} lastAiMsg
 * @param {number|string} swipeId
 * @param {object} beforeSnap
 * @param {object} afterSnap
 */
export function stampScriptSwipeSnapshot(lastAiMsg, swipeId, beforeSnap, afterSnap) {
    if (!isPlainObject(lastAiMsg)) return;
    if (!isPlainObject(lastAiMsg.extra)) {
        lastAiMsg.extra = {};
    }
    if (!isPlainObject(lastAiMsg.extra.rpgScriptRollback)) {
        lastAiMsg.extra.rpgScriptRollback = {};
    }
    if (!isPlainObject(lastAiMsg.extra.rpgScriptResult)) {
        lastAiMsg.extra.rpgScriptResult = {};
    }

    const key = swipeId ?? 0;
    lastAiMsg.extra.rpgScriptRollback[key] = isPlainObject(beforeSnap) ? clone(beforeSnap) : {};
    lastAiMsg.extra.rpgScriptResult[key] = isPlainObject(afterSnap) ? clone(afterSnap) : {};
    lastAiMsg.extra.rpgScriptActiveSwipe = key;
}

/**
 * Restores per-chat script runtime state when the user swipes to a different
 * generation on the last AI message (mirroring `applyMemoSwipeRollback`).
 *
 * @param {object} lastAiMsg
 * @param {object} settings
 * @param {string} chatId
 * @returns {{ anyChanged: boolean, restored: object|null }}
 */
export function restoreScriptSwipeSnapshot(lastAiMsg, settings, chatId) {
    const cid = normalizeChatId(chatId);
    if (!isPlainObject(lastAiMsg) || !isPlainObject(settings) || !cid) {
        return { anyChanged: false, restored: null };
    }

    if (!isPlainObject(lastAiMsg.extra)) {
        lastAiMsg.extra = {};
    }

    const swipeId = lastAiMsg.swipe_id ?? 0;
    const prevSwipeId = lastAiMsg.extra.rpgScriptActiveSwipe;

    if (prevSwipeId !== undefined && prevSwipeId !== swipeId) {
        const resultMap = isPlainObject(lastAiMsg.extra.rpgScriptResult)
            ? lastAiMsg.extra.rpgScriptResult
            : null;
        const rollbackMap = isPlainObject(lastAiMsg.extra.rpgScriptRollback)
            ? lastAiMsg.extra.rpgScriptRollback
            : null;

        let target = resultMap?.[swipeId];
        if (!isPlainObject(target)) {
            target = rollbackMap?.[prevSwipeId] ?? rollbackMap?.[swipeId];
        }

        if (isPlainObject(target)) {
            ensureCatalogContainers(settings);
            const restored = clone(target) || {};
            settings.gameScriptStatesByChat[cid] = restored;
            if (rollbackMap) {
                delete rollbackMap[swipeId];
            }
            lastAiMsg.extra.rpgScriptActiveSwipe = swipeId;
            return { anyChanged: true, restored: clone(restored) };
        }
    }

    lastAiMsg.extra.rpgScriptActiveSwipe = swipeId;
    return { anyChanged: false, restored: null };
}
