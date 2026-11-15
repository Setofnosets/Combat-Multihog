/**
 * lewd-combat-store.js — per-chat persistence for Lewd Combat boards.
 *
 * The board lives in `extension_settings.rpg_tracker.lewdCombatByChat[chatId]`
 * for the same reason the tactical/traditional boards do: it stays out of the
 * chatStates partition, so a tracker save cannot overwrite a running encounter.
 *
 * This store deliberately does **not** route through `getEncounterForChat`:
 * that helper hydrates through the HP/AC engine and rejects states without a
 * `grid`. Lewd states are a different shape (participants, stamina, arousal,
 * poise) and are hydrated by the lewd engine itself in a later unit.
 *
 * U1 keeps reads/writes raw. When the lewd engine lands it can plug its
 * hydrate/serialize step in here without changing these function signatures.
 */

import { saveSettings } from '../../app/runtime-bridge.js';
import { getActiveChatId } from '../../../state-manager.js';
import { LEWD_BY_CHAT_KEY } from './lewd-combat-constants.js';

export { LEWD_BY_CHAT_KEY };

const MAX_STORED_CHATS = 16;

function persist() {
    try {
        saveSettings();
    } catch (error) {
        // Boot-time/runtime bridge may not be installed yet; the in-memory copy
        // is still valid and the next successful save will persist it.
        console.warn('[RPG Tracker] Lewd Combat save deferred:', error);
    }
}

function ensureMap(settings) {
    if (!settings[LEWD_BY_CHAT_KEY] || typeof settings[LEWD_BY_CHAT_KEY] !== 'object'
        || Array.isArray(settings[LEWD_BY_CHAT_KEY])) {
        settings[LEWD_BY_CHAT_KEY] = {};
    }
    return settings[LEWD_BY_CHAT_KEY];
}

function pruneOldEncounters(map) {
    const entries = Object.entries(map);
    if (entries.length <= MAX_STORED_CHATS) return;
    // Only finished boards are evictable. A running board must never be dropped
    // silently: the cap is a housekeeping aid, not a way to lose an encounter.
    entries
        .filter(([, state]) => state?.status && state.status !== 'active')
        .sort((a, b) => Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0))
        .slice(0, Math.max(0, entries.length - MAX_STORED_CHATS))
        .forEach(([chatId]) => { delete map[chatId]; });
}

export function getActiveLewdChatId() {
    return getActiveChatId();
}

/**
 * Read the saved lewd board for a chat. No hydration and no grid check: a lewd
 * board is valid as soon as it is a plain object.
 * @param {string} chatId
 * @param {Record<string, any>} settings
 * @returns {object|null}
 */
export function getLewdEncounterForChat(chatId, settings) {
    if (!chatId || !settings) return null;
    const map = ensureMap(settings);
    const state = map[String(chatId)];
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    return state;
}

/**
 * Save the board for a chat and stamp its bookkeeping fields.
 * @param {string} chatId
 * @param {object} state
 * @param {Record<string, any>} settings
 * @param {{ persist?: boolean }} [options]
 */
export function setLewdEncounterForChat(chatId, state, settings, options = {}) {
    if (!chatId || !settings || !state || typeof state !== 'object') return;
    const map = ensureMap(settings);
    state.chatId = String(chatId);
    state.updatedAt = Date.now();
    map[String(chatId)] = state;
    pruneOldEncounters(map);
    if (options.persist !== false) persist();
}

/**
 * @param {string} chatId
 * @param {Record<string, any>} settings
 * @param {{ persist?: boolean }} [options]
 */
export function removeLewdEncounterForChat(chatId, settings, options = {}) {
    if (!chatId || !settings) return;
    const map = ensureMap(settings);
    if (Object.prototype.hasOwnProperty.call(map, String(chatId))) {
        delete map[String(chatId)];
        if (options.persist !== false) persist();
    }
}

/**
 * @param {Record<string, any>} settings
 * @param {{ chatId?: string, persist?: boolean }} [options]
 */
export function removeAllLewdEncounters(settings, options = {}) {
    if (!settings) return;
    if (options.chatId) {
        removeLewdEncounterForChat(options.chatId, settings, options);
        return;
    }
    settings[LEWD_BY_CHAT_KEY] = {};
    if (options.persist !== false) persist();
}

/**
 * @param {Record<string, any>} settings
 * @param {string} [chatId]
 * @returns {boolean}
 */
export function hasActiveLewdEncounter(settings, chatId = getActiveLewdChatId()) {
    if (!settings?.lewdCombatEnabled) return false;
    const state = getLewdEncounterForChat(chatId, settings);
    return !!state && state.status === 'active';
}
