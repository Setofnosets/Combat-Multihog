/**
 * skill-registry-store.js — per-chat persistence bookkeeping for the Skill
 * Registry. The registry lives in live settings for synchronous combat use and
 * is snapshotted into chatStates so it follows reloads, renames, and branches.
 */

import { getActiveChatId, saveChatState } from '../../../state-manager.js';
import { saveSettings as requestSettingsSave } from '../../app/runtime-bridge.js';
import { ensureSkillBookRegistered, scheduleSkillLorebookMirror } from './skill-lorebook.js';

let dirtyChatIds = new Set();
let registryOwnerChatId = '';

/**
 * Mark the active chat's registry snapshot as stale. Chat-scoped so a resolution
 * that finishes after a switch cannot write into the arriving chat.
 * @param {string|null} [chatId]
 */
export function markSkillRegistryDirty(chatId = getActiveChatId()) {
    if (!chatId) return;
    dirtyChatIds.add(String(chatId));
}

/** @param {string|null} [chatId] */
export function clearSkillRegistryDirty(chatId = getActiveChatId()) {
    if (!chatId) dirtyChatIds.clear();
    else dirtyChatIds.delete(String(chatId));
}

/**
 * Record which chat the live registry currently belongs to. Used by the chat
 * loader so a switch cannot merge the departing chat's skills into the
 * arriving chat.
 * @param {string|null} [chatId]
 */
export function claimSkillRegistry(chatId = getActiveChatId()) {
    registryOwnerChatId = String(chatId || '');
}

/** @returns {string} */
export function getSkillRegistryOwner() {
    return registryOwnerChatId;
}

/**
 * Snapshot the live registry into the chat partition, request a normal settings
 * save, and schedule the lorebook mirror. This is the deterministic persistence
 * entry point for discoveries and resolved recipes.
 * @param {Record<string, any>} settings
 * @param {string|null} [chatId]
 * @param {{ force?: boolean }} [options]
 * @returns {boolean}
 */
export function persistSkillRegistry(settings, chatId = getActiveChatId(), options = {}) {
    if (!settings || !chatId) return false;
    markSkillRegistryDirty(chatId);
    const ok = flushSkillRegistry(settings, chatId, { force: options.force !== false });
    if (ok) {
        try { requestSettingsSave(); } catch (_) { /* bridge not ready; a later normal save persists it */ }
        try { document.dispatchEvent(new CustomEvent('rt_tactical_combat_changed')); } catch (_) { /* non-DOM */ }
    }
    return ok;
}

/**
 * Snapshot the live registry into the chat partition without a duplicate disk
 * save. The normal board/settings save persists the top-level object.
 * @param {Record<string, any>} settings
 * @param {string|null} [chatId]
 * @param {{ force?: boolean }} [options]
 * @returns {boolean}
 */
export function flushSkillRegistry(settings, chatId = getActiveChatId(), options = {}) {
    if (!settings || !chatId) return false;
    const id = String(chatId);
    if (!options.force && !dirtyChatIds.has(id)) return false;
    registryOwnerChatId = id;
    let snapshotOk = false;
    try {
        ensureSkillBookRegistered(settings, id);
        saveChatState(id, { skipDiskWrite: true });
        snapshotOk = true;
    } catch (error) {
        console.warn('[RPG Tracker] Skill Registry snapshot failed:', error);
    }
    // The mirror is a readable backup and must not depend on the transient
    // dirty flag or on a successful chat-partition write.
    try {
        scheduleSkillLorebookMirror(settings, id);
    } catch (error) {
        if (settings.debugMode) console.warn('[RPG Tracker] Skill mirror scheduling failed:', error);
    }
    if (snapshotOk) dirtyChatIds.delete(id);
    return snapshotOk;
}

/** @param {string|null} [chatId] */
export function isSkillRegistryDirty(chatId = getActiveChatId()) {
    if (!chatId) return dirtyChatIds.size > 0;
    return dirtyChatIds.has(String(chatId));
}
