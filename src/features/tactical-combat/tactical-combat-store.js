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

export const TC_BY_CHAT_KEY = 'tacticalCombatByChat';
const MAX_STORED_CHATS = 16;

function persist() {
    try {
        saveSettings();
    } catch (error) {
        // Boot-time/runtime bridge may not be installed yet; the in-memory copy is
        // still valid and the next successful save will persist it.
        console.warn('[RPG Tracker] Tactical Combat save deferred:', error);
    }
}

function ensureMap(settings) {
    if (!settings[TC_BY_CHAT_KEY] || typeof settings[TC_BY_CHAT_KEY] !== 'object' || Array.isArray(settings[TC_BY_CHAT_KEY])) {
        settings[TC_BY_CHAT_KEY] = {};
    }
    return settings[TC_BY_CHAT_KEY];
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
 * @returns {object|null}
 */
export function getEncounterForChat(chatId, settings) {
    if (!chatId || !settings) return null;
    const map = ensureMap(settings);
    const state = map[chatId];
    if (!state || typeof state !== 'object' || !state.grid || !Array.isArray(state.units)) return null;
    return hydrateEncounterState(state);
}

/**
 * @param {string} chatId
 * @param {object} state
 * @param {Record<string, any>} settings
 * @param {{ persist?: boolean }} [options]
 */
export function setEncounterForChat(chatId, state, settings, options = {}) {
    if (!chatId || !settings || !state) return;
    const map = ensureMap(settings);
    state.chatId = String(chatId);
    state.updatedAt = Date.now();
    map[chatId] = state;
    pruneOldEncounters(map);
    if (options.persist !== false) persist();
}

/**
 * @param {string} chatId
 * @param {Record<string, any>} settings
 * @param {{ persist?: boolean }} [options]
 */
export function removeEncounterForChat(chatId, settings, options = {}) {
    if (!chatId || !settings) return;
    const map = ensureMap(settings);
    if (Object.prototype.hasOwnProperty.call(map, chatId)) {
        delete map[chatId];
        if (options.persist !== false) persist();
    }
}

/**
 * @param {Record<string, any>} settings
 * @param {{ chatId?: string }} [options]
 */
export function removeAllEncounters(settings, options = {}) {
    if (!settings) return;
    if (options.chatId) {
        removeEncounterForChat(options.chatId, settings, options);
        return;
    }
    settings[TC_BY_CHAT_KEY] = {};
    if (options.persist !== false) persist();
}

export function hasActiveEncounter(settings, chatId = getActiveChatId()) {
    const state = getEncounterForChat(chatId, settings);
    return !!state && state.status === 'active';
}

/**
 * Queue the authoritative post-combat result for the next narrator generation.
 * @param {Record<string, any>} settings
 * @param {object} payload
 * @param {{ persist?: boolean }} [options]
 */
export function setPendingNarration(settings, payload, options = {}) {
    if (!settings) return;
    settings.tacticalCombatReturn = payload ? { ...payload } : null;
    if (options.persist !== false) persist();
}

/**
 * @param {Record<string, any>} settings
 * @returns {object|null}
 */
export function getPendingNarration(settings) {
    const pending = settings?.tacticalCombatReturn;
    if (!pending || typeof pending !== 'object') return null;
    return pending;
}

/**
 * @param {Record<string, any>} settings
 * @param {{ chatId?: string, persist?: boolean }} [options]
 */
export function clearPendingNarration(settings, options = {}) {
    if (!settings) return;
    const pending = settings.tacticalCombatReturn;
    if (!pending) return;
    if (options.chatId && pending.chatId && String(pending.chatId) !== String(options.chatId)) return;
    settings.tacticalCombatReturn = null;
    if (options.persist !== false) persist();
}
