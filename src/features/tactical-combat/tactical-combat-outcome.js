/**
 * tactical-combat-outcome.js — end-of-combat handoff to the main narration.
 *
 * When a tactical encounter ends:
 *  1. the [COMBAT] memo block is closed (or left alone if the tracker already
 *     resolved it),
 *  2. the authoritative result is queued for the next narrator generation,
 *  3. the caller can immediately continue the main story.
 *
 * The narration interceptor consumes the queued block and this module clears it
 * after GENERATION_ENDED, so the result cannot leak into later turns.
 */

import { getActiveChatId } from '../../../state-manager.js';
import { mergeMemo } from '../../../memo-processor.js';
import { refreshRenderedView, saveSettings, syncMemoView } from '../../app/runtime-bridge.js';
import { DEFAULT_TACTICAL_OUTCOME_PROMPT, renderTacticalTemplate } from './tactical-combat-prompts.js';
import { buildOutcomeSummary } from './tactical-combat-engine.js';
import { clearPendingNarration, getPendingNarration, setPendingNarration } from './tactical-combat-store.js';

function defaultPersist() {
    try { saveSettings(); } catch (error) { console.warn('[RPG Tracker] Tactical Combat outcome save deferred:', error); }
}

function defaultRefresh() {
    try { syncMemoView(); } catch (_) { /* runtime bridge not ready */ }
    try { refreshRenderedView(); } catch (_) { /* runtime bridge not ready */ }
}

/**
 * Close the active [COMBAT] block in the memo. Returns the new memo.
 * @param {string} memo
 * @param {{ merge?: (memo: string, ai: string) => string }} [options]
 * @returns {string}
 */
export function closeCombatBlockInMemo(memo, options = {}) {
    const source = String(memo || '');
    const block = source.match(/\[COMBAT\]([\s\S]*?)\[\/COMBAT\]/i);
    if (!block) return source;
    if (/^\s*END_COMBAT\s*$/i.test(block[1])) return source;
    const merge = options.merge || mergeMemo;
    try {
        const merged = merge(source, '[COMBAT]END_COMBAT[/COMBAT]');
        return typeof merged === 'string' ? merged : source;
    } catch (error) {
        console.warn('[RPG Tracker] Could not close the COMBAT block cleanly:', error);
        // Fail safe: remove the stale block rather than leaving dead enemies in context.
        return source.replace(/\[COMBAT\][\s\S]*?\[\/COMBAT\]/i, '[COMBAT]END_COMBAT[/COMBAT]');
    }
}

/**
 * @param {object} state
 * @param {{ outcome?: object }} [options]
 * @returns {object}
 */
export function buildOutcomePayload(state, options = {}) {
    const outcome = options.outcome || state.outcome || buildOutcomeSummary(state);
    return {
        chatId: String(state.chatId || getActiveChatId() || ''),
        stateId: state.id,
        title: state.title,
        location: state.location,
        outcome,
        createdAt: Date.now(),
    };
}

/**
 * Queue the outcome for the next narration and close the memo's combat block.
 * Idempotent.
 *
 * @param {object} state
 * @param {Record<string, any>} settings
 * @param {{ persist?: boolean, refresh?: boolean, merge?: Function, save?: Function, refreshView?: Function }} [options]
 * @returns {object} the queued payload
 */
export function queueCombatOutcome(state, settings, options = {}) {
    const payload = buildOutcomePayload(state);
    if (state.finalization?.narrationQueued) return state.finalization.payload || payload;

    const memo = String(settings?.currentMemo || '');
    const nextMemo = closeCombatBlockInMemo(memo, { merge: options.merge });
    if (nextMemo !== memo) {
        settings.currentMemo = nextMemo;
    }

    state.finalization = {
        narrationQueued: true,
        queuedAt: Date.now(),
        payload,
        outcome: payload.outcome,
    };
    setPendingNarration(settings, payload, { persist: false });

    if (options.persist !== false) {
        if (typeof options.save === 'function') options.save();
        else defaultPersist();
    }
    if (options.refresh !== false) {
        if (typeof options.refreshView === 'function') options.refreshView();
        else defaultRefresh();
    }
    return payload;
}

/**
 * The text injected into the narrator prompt. Returns '' for other chats.
 * @param {Record<string, any>} settings
 * @param {string} [chatId]
 * @returns {string}
 */
export function buildNarrationBlock(settings, chatId = getActiveChatId()) {
    if (!settings) return '';
    const pending = getPendingNarration(settings);
    if (!pending || !pending.outcome) return '';
    if (chatId && pending.chatId && String(pending.chatId) !== String(chatId)) return '';
    const outcome = pending.outcome;
    const template = String(settings.tacticalCombatOutcomePrompt || DEFAULT_TACTICAL_OUTCOME_PROMPT);
    const details = Array.isArray(outcome.details) && outcome.details.length
        ? `Details:\n${outcome.details.map(item => `- ${item}`).join('\n')}`
        : '';
    const survivors = (outcome.survivors || []).map(unit => `${unit.name} (${unit.hp}/${unit.maxHp} HP)`).join(', ') || 'None';
    const fallen = (outcome.fallen || []).map(unit => unit.name).join(', ');
    const fled = (outcome.fled || []).map(unit => unit.name).join(', ');
    const defeated = (outcome.defeatedEnemies || []).map(unit => unit.name).join(', ');
    const rendered = renderTacticalTemplate(template, {
        title: pending.title || outcome.title || 'Tactical encounter',
        location: pending.location || outcome.location || 'the battlefield',
        outcome: outcome.label || outcome.status || 'Ended',
        rounds: outcome.rounds || 0,
        survivors,
        fallen: fallen || 'None',
        fled: fled || 'None',
        defeated: defeated || 'None',
        details,
        summary: outcome.summary || '',
    }).trim();
    return rendered ? `${rendered}\n\n` : '';
}

/**
 * Called after a real narrator generation ended. Quiet/agent generations must
 * not clear the result before the narrator sees it.
 * @param {Record<string, any>} settings
 * @param {string} [chatId]
 * @param {{ save?: boolean }} [options]
 */
export function clearNarrationAfterGeneration(settings, chatId = getActiveChatId(), options = {}) {
    if (!settings?.tacticalCombatReturn) return;
    clearPendingNarration(settings, { chatId, persist: options.save === true });
}

/**
 * Trigger the main model so the queued aftermath is narrated immediately.
 * Returns false when no generation API is available; the queued block then
 * applies to the user's next message instead.
 *
 * @param {Record<string, any>} settings
 * @returns {Promise<boolean>}
 */
export async function continueToNarration(settings) {
    if (!getPendingNarration(settings)) return false;
    try {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
        if (!ctx || typeof ctx.generate !== 'function') return false;
        await ctx.generate('normal');
        return true;
    } catch (error) {
        console.warn('[RPG Tracker] Could not continue narration automatically:', error);
        return false;
    }
}
