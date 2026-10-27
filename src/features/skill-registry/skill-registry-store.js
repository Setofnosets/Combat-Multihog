/**
 * skill-registry-store.js — per-chat persistence bookkeeping for the Skill
 * Registry. The registry lives in live settings for synchronous combat use and
 * is snapshotted into chatStates so it follows reloads, renames, and branches.
 */

import { getActiveChatId, saveChatState } from '../../../state-manager.js';
import { ensureSkillBookRegistered, scheduleSkillLorebookMirror } from './skill-lorebook.js';

let dirtyChatId = '';

/**
 * Mark the active chat's registry snapshot as stale. Chat-scoped so a resolution
 * that finishes after a switch cannot write into the arriving chat.
 * @param {string|null} [chatId]
 */
export function markSkillRegistryDirty(chatId = getActiveChatId()) {
    if (!chatId) return;
    dirtyChatId = String(chatId);
}

/** @param {string|null} [chatId] */
export function clearSkillRegistryDirty(chatId = getActiveChatId()) {
    if (!chatId || dirtyChatId === String(chatId)) dirtyChatId = '';
}

/**
 * Snapshot the live registry into the chat partition without a duplicate disk
 * save. The normal board/settings save persists the top-level object.
 * @param {Record<string, any>} settings
 * @param {string|null} [chatId]
 * @returns {boolean}
 */
export function flushSkillRegistry(settings, chatId = getActiveChatId()) {
    if (!settings || !chatId) return false;
    if (!dirtyChatId) return false;
    if (dirtyChatId !== String(chatId)) return false;
    try {
        ensureSkillBookRegistered(settings, chatId);
        saveChatState(chatId, { skipDiskWrite: true });
        dirtyChatId = '';
        scheduleSkillLorebookMirror(settings, chatId);
        return true;
    } catch (error) {
        console.warn('[RPG Tracker] Skill Registry snapshot failed:', error);
        return false;
    }
}

/** @param {string|null} [chatId] */
export function isSkillRegistryDirty(chatId = getActiveChatId()) {
    return !!dirtyChatId && dirtyChatId === String(chatId || '');
}
