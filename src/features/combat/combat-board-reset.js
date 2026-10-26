/**
 * combat-board-reset.js — escape hatch for the combat style guard.
 *
 * A saved board is keyed by chat id and can outlive the situation that created
 * it: the chat was deleted, the architect request was interrupted, or the
 * narrator handoff never finished. Those boards keep
 * `hasActiveCombatBoard()` true with no visible encounter and no per-chat UI in
 * the settings pane, so style switching looks permanently broken.
 *
 * Clearing removes only boards that are still running (active / preparing /
 * finalizing). Finished boards keep their outcome so "Return to narration" and
 * the result panel keep working.
 */

import { getActiveChatId } from '../../../state-manager.js';
import { listActiveCombatBoards } from './combat-mode.js';
import {
    TC_BY_CHAT_KEY,
    TRADITIONAL_BY_CHAT_KEY,
    clearPendingNarration,
    removeEncounterForChat,
} from '../tactical-combat/tactical-combat-store.js';
import { resetTacticalCombatEncounter } from '../tactical-combat/tactical-combat-ui.js';
import { resetTraditionalCombatEncounter } from '../traditional-combat/traditional-combat-ui.js';

const STORE_KEYS = {
    tactical: TC_BY_CHAT_KEY,
    traditional: TRADITIONAL_BY_CHAT_KEY,
};

const CHANGE_EVENTS = {
    tactical: 'rt_tactical_combat_changed',
    traditional: 'rt_traditional_combat_changed',
};

function activeChatId() {
    try {
        return String(getActiveChatId() || '');
    } catch (_) {
        return '';
    }
}

function notifyChanged(style) {
    try {
        document.dispatchEvent(new CustomEvent(CHANGE_EVENTS[style]));
    } catch (_) {
        // No DOM (unit tests) — the settings object is already up to date.
    }
}

/**
 * Remove one running board. The active chat goes through the style's own reset
 * so its `[COMBAT]` memo block, pending narration, and in-flight agent request
 * are cleaned up too. Other chats only own their saved board entry.
 * @param {{ chatId: string, style: 'tactical'|'traditional' }} board
 * @param {Record<string, any>} settings
 * @param {string} chatId
 */
function clearBoard(board, settings, chatId) {
    if (chatId && chatId === activeChatId()) {
        try {
            if (board.style === 'tactical') resetTacticalCombatEncounter();
            else resetTraditionalCombatEncounter();
            return;
        } catch (error) {
            console.warn('[RPG Tracker] Combat board reset failed, removing the saved board instead:', error);
        }
    }
    removeEncounterForChat(chatId, settings, { key: STORE_KEYS[board.style] });
    clearPendingNarration(settings, { chatId });
}

/**
 * Clear every board that is still running, across all chats.
 * @param {Record<string, any>} settings
 * @param {{ now?: number }} [options]
 * @returns {{ cleared: number, chatIds: string[] }}
 */
export function clearActiveCombatEncounters(settings, options = {}) {
    if (!settings) return { cleared: 0, chatIds: [] };
    const boards = listActiveCombatBoards(settings, options);
    const chatIds = [];
    let cleared = 0;
    for (const board of boards) {
        const chatId = String(board.chatId || '');
        if (!chatId) continue;
        clearBoard(board, settings, chatId);
        cleared += 1;
        if (!chatIds.includes(chatId)) chatIds.push(chatId);
    }
    if (cleared) {
        // Both panes refresh: one chat can hold boards for either style.
        notifyChanged('tactical');
        notifyChanged('traditional');
    }
    return { cleared, chatIds };
}
