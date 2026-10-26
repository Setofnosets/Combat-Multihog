/**
 * tactical-combat-store.js — per-chat persistence for tactical encounters.
 *
 * The board lives in `extension_settings.rpg_tracker.tacticalCombatByChat[chatId]`
 * rather than a chatStates partition. That keeps it out of the chat-link
 * projection (which would overwrite the board on every tracker save) and makes
 * chat switching cheap: each chat reads its own encounter directly.
 */

import { saveSettings } from '../../app/runtime-bridge.js';
import { getActiveChatId } from '../../../state-manager.js';
import { hydrateEncounterState } from './tactical-combat-engine.js';
import { TRADITIONAL_STATE_FORMAT } from '../traditional-combat/traditional-combat-constants.js';

export const TC_BY_CHAT_KEY = 'tacticalCombatByChat';
export const TRADITIONAL_BY_CHAT_KEY = 'traditionalCombatByChat';
const MAX_STORED_CHATS = 16;

function storeKey(value, fallback = TC_BY_CHAT_KEY) {
    return String(value || fallback);
}

function persist() {
    try {
        saveSettings();
    } catch (error) {
        // Boot-time/runtime bridge may not be installed yet; the in-memory copy is
        // still valid and the next successful save will persist it.
        console.warn('[RPG Tracker] Tactical Combat save deferred:', error);
    }
}

function ensureMap(settings, key = TC_BY_CHAT_KEY) {
    const storageKey = storeKey(key);
    if (!settings[storageKey] || typeof settings[storageKey] !== 'object' || Array.isArray(settings[storageKey])) {
        settings[storageKey] = {};
    }
    return settings[storageKey];
}

function pruneOldEncounters(map) {
    const entries = Object.entries(map);
    if (entries.length <= MAX_STORED_CHATS) return;
    entries
        .filter(([, state]) => state?.status && state.status !== 'active')
        .sort((a, b) => Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0))
        .slice(0, Math.max(0, entries.length - MAX_STORED_CHATS))
        .forEach(([chatId]) => { delete map[chatId]; });
}

export function getActiveTacticalChatId() {
    return getActiveChatId();
}

/**
 * @param {string} chatId
 * @param {Record<string, any>} settings
 * @param {{ key?: string }} [options]
 * @returns {object|null}
 */
export function getEncounterForChat(chatId, settings, options = {}) {
    if (!chatId || !settings) return null;
    const map = ensureMap(settings, options.key);
    const state = map[chatId];
    if (!state || typeof state !== 'object' || !Array.isArray(state.units)) return null;
    const traditional = state.mode === 'traditional' || state.format === TRADITIONAL_STATE_FORMAT;
    if (!traditional && !state.grid) return null;
    return hydrateEncounterState(state);
}

/**
 * @param {string} chatId
 * @param {object} state
 * @param {Record<string, any>} settings
 * @param {{ persist?: boolean, key?: string }} [options]
 */
export function setEncounterForChat(chatId, state, settings, options = {}) {
    if (!chatId || !settings || !state) return;
    const map = ensureMap(settings, options.key);
    state.chatId = String(chatId);
    state.updatedAt = Date.now();
    map[chatId] = state;
    pruneOldEncounters(map);
    if (options.persist !== false) persist();
}

/**
 * @param {string} chatId
 * @param {Record<string, any>} settings
 * @param {{ persist?: boolean, key?: string }} [options]
 */
export function removeEncounterForChat(chatId, settings, options = {}) {
    if (!chatId || !settings) return;
    const map = ensureMap(settings, options.key);
    if (Object.prototype.hasOwnProperty.call(map, chatId)) {
        delete map[chatId];
        if (options.persist !== false) persist();
    }
}

/**
 * @param {Record<string, any>} settings
 * @param {{ chatId?: string, key?: string }} [options]
 */
export function removeAllEncounters(settings, options = {}) {
    if (!settings) return;
    if (options.chatId) {
        removeEncounterForChat(options.chatId, settings, options);
        return;
    }
    settings[storeKey(options.key)] = {};
    if (options.persist !== false) persist();
}

export function hasActiveEncounter(settings, chatId = getActiveChatId(), options = {}) {
    const state = getEncounterForChat(chatId, settings, options);
    return !!state && state.status === 'active';
}

function pendingByChat(settings) {
    if (!settings.tacticalCombatReturnByChat || typeof settings.tacticalCombatReturnByChat !== 'object'
        || Array.isArray(settings.tacticalCombatReturnByChat)) {
        settings.tacticalCombatReturnByChat = {};
    }
    return settings.tacticalCombatReturnByChat;
}

/**
 * Queue the authoritative post-combat result for the next narrator generation.
 * Results are stored per chat so ending two fights in different chats cannot
 * overwrite the first narration. `tacticalCombatReturn` remains a legacy mirror
 * of the most recently queued payload.
 * @param {Record<string, any>} settings
 * @param {object} payload
 * @param {{ persist?: boolean, chatId?: string }} [options]
 */
export function setPendingNarration(settings, payload, options = {}) {
    if (!settings) return;
    if (!payload) {
        const chatId = String(options.chatId || '');
        if (chatId) delete pendingByChat(settings)[chatId];
        else settings.tacticalCombatReturnByChat = {};
        const legacy = settings.tacticalCombatReturn;
        if (!chatId || !legacy?.chatId || String(legacy.chatId) === chatId) {
            settings.tacticalCombatReturn = null;
        }
        if (options.persist !== false) persist();
        return;
    }
    const copy = { ...payload };
    const chatId = String(copy.chatId || options.chatId || '');
    if (!copy.chatId && chatId) copy.chatId = chatId;
    if (chatId) {
        const map = pendingByChat(settings);
        map[chatId] = copy;
        const entries = Object.entries(map);
        if (entries.length > 12) {
            entries
                .filter(([key]) => key !== chatId)
                .sort((a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0))
                .slice(0, entries.length - 12)
                .forEach(([key]) => { delete map[key]; });
        }
    }
    settings.tacticalCombatReturn = copy;
    if (options.persist !== false) persist();
}

/**
 * @param {Record<string, any>} settings
 * @param {string|{ chatId?: string }} [chatIdOrOptions]
 * @returns {object|null}
 */
export function getPendingNarration(settings, chatIdOrOptions = null) {
    const chatId = typeof chatIdOrOptions === 'string'
        ? chatIdOrOptions
        : String(chatIdOrOptions?.chatId || '');
    const map = settings?.tacticalCombatReturnByChat;
    if (chatId && map && typeof map === 'object' && map[chatId]) return map[chatId];
    const pending = settings?.tacticalCombatReturn;
    if (!pending || typeof pending !== 'object') return null;
    if (chatId && pending.chatId && String(pending.chatId) !== String(chatId)) return null;
    return pending;
}

/**
 * @param {Record<string, any>} settings
 * @param {string} [chatId]
 * @returns {boolean}
 */
export function hasPendingNarration(settings, chatId = '') {
    return !!getPendingNarration(settings, chatId || null);
}

/**
 * @param {Record<string, any>} settings
 * @param {{ chatId?: string, persist?: boolean }} [options]
 */
export function clearPendingNarration(settings, options = {}) {
    if (!settings) return;
    if (options.chatId) {
        delete pendingByChat(settings)[String(options.chatId)];
    } else {
        settings.tacticalCombatReturnByChat = {};
    }
    const pending = settings.tacticalCombatReturn;
    if (!pending) {
        if (options.persist !== false) persist();
        return;
    }
    if (options.chatId && pending.chatId && String(pending.chatId) !== String(options.chatId)) {
        if (options.persist !== false) persist();
        return;
    }
    settings.tacticalCombatReturn = null;
    if (options.persist !== false) persist();
}
