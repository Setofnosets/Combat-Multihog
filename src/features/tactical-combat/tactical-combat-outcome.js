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
import { DEFAULT_TRADITIONAL_OUTCOME_PROMPT } from '../traditional-combat/traditional-combat-prompts.js';
import { buildOutcomeSummary, restoreCombatScopedState } from './tactical-combat-engine.js';
import { syncCombatResultToMemo } from './tactical-combat-memo.js';
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
        kind: state.mode === 'traditional' || state.format === 'multihog-traditional-combat' ? 'traditional' : 'tactical',
        title: state.title,
        location: state.location,
        outcome,
        trigger: state.opening?.text || '',
        finalState: outcome.finalUnits || [],
        createdAt: Date.now(),
        injectedAt: 0,
        injectedFor: '',
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

    // Capture the outcome first, then revert encounter-scoped side changes and
    // temporary transformations before the deterministic memo sync.
    restoreCombatScopedState(state);

    // Board state wins over prose. This is the machinery that updates the
    // tracker state before the narrator ever sees the result block.
    syncCombatResultToMemo(state, settings);

    state.finalization = {
        ...(state.finalization || {}),
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
function describeUnitList(units, empty = 'None') {
    const list = Array.isArray(units) ? units : [];
    if (!list.length) return empty;
    return list.map(unit => {
        const hp = unit.hp != null ? ` (${unit.hp}/${unit.maxHp} HP${unit.maxWillpower ? `, ${unit.willpower ?? 0}/${unit.maxWillpower} WP` : ''})` : '';
        return `${unit.name}${hp}`;
    }).join(', ');
}

function describeHighlights(outcome) {
    const list = Array.isArray(outcome.highlights) ? outcome.highlights : [];
    return list.length ? list.map(item => `- ${item}`).join('\n') : '- No decisive highlight was recorded.';
}

function describeFinalUnits(outcome) {
    const list = Array.isArray(outcome.finalUnits) ? outcome.finalUnits : [];
    if (!list.length) return 'None recorded.';
    return list.map(unit => {
        const flags = [
            unit.defeated ? (unit.defeatCause === 'willpower' ? 'willpower-broken' : 'defeated') : '',
            unit.willpowerBroken && !unit.defeated ? 'willpower-broken' : '',
            unit.fled ? 'fled' : '',
            unit.surrendered ? 'surrendered' : '',
            unit.incapacitated ? 'incapacitated' : '',
            unit.sideChanged ? `changed side (${unit.originalSide} → ${unit.side})` : '',
            unit.transformed ? 'transformed' : '',
        ].filter(Boolean).join(', ');
        const wp = unit.maxWillpower ? `, ${unit.willpower ?? 0}/${unit.maxWillpower} WP` : '';
        return `- ${unit.name} [${unit.side}]: ${unit.hp}/${unit.maxHp} HP${wp}${flags ? ` (${flags})` : ''}`;
    }).join('\n');
}

export function buildNarrationBlock(settings, chatId = getActiveChatId()) {
    if (!settings) return '';
    const pending = getPendingNarration(settings);
    if (!pending || !pending.outcome) return '';
    if (chatId && pending.chatId && String(pending.chatId) !== String(chatId)) return '';
    const outcome = pending.outcome;
    const isTraditional = pending.kind === 'traditional' || outcome.mode === 'traditional';
    const template = String(isTraditional
        ? (settings.traditionalCombatOutcomePrompt || DEFAULT_TRADITIONAL_OUTCOME_PROMPT)
        : (settings.tacticalCombatOutcomePrompt || DEFAULT_TACTICAL_OUTCOME_PROMPT));
    const details = Array.isArray(outcome.details) && outcome.details.length
        ? `Details:\n${outcome.details.map(item => `- ${item}`).join('\n')}`
        : '';
    const survivors = describeUnitList(outcome.survivors);
    const fallen = (outcome.fallen || []).map(unit => unit.name).join(', ');
    const fled = (outcome.fled || []).map(unit => unit.name).join(', ');
    const defeated = (outcome.defeatedEnemies || []).map(unit => unit.name).join(', ');
    const enemiesRemaining = describeUnitList(outcome.enemySurvivors);
    const partyState = describeUnitList(outcome.survivors);
    const allyState = [
        describeUnitList(outcome.allySurvivors, ''),
        (outcome.allyFallen || []).length ? `Fallen: ${(outcome.allyFallen || []).map(unit => unit.name).join(', ')}` : '',
        (outcome.allyFled || []).length ? `Withdrawn: ${(outcome.allyFled || []).map(unit => unit.name).join(', ')}` : '',
    ].filter(Boolean).join('; ') || 'None';
    const trigger = pending.trigger || outcome.opening?.text || 'The player triggered the encounter.';
    const willpowerBreaks = (outcome.willpowerBreaks || []).length
        ? outcome.willpowerBreaks.map(entry => `${entry.name} (${String(entry.outcome || 'broken').replace(/_/g, ' ')}${entry.source ? `; ${entry.source}` : ''})`).join(', ')
        : 'None';
    const sideChanges = (outcome.sideChanges || []).length
        ? outcome.sideChanges.map(entry => `${entry.name} (${entry.originalSide} → ${entry.side})`).join(', ')
        : 'None';
    const transformations = (outcome.transformations || []).length
        ? outcome.transformations.map(entry => `${entry.originalName || entry.name}${entry.permanent ? ' (permanent)' : ' (temporary)'}`).join(', ')
        : 'None';
    const rendered = renderTacticalTemplate(template, {
        title: pending.title || outcome.title || (isTraditional ? 'Traditional encounter' : 'Tactical encounter'),
        location: pending.location || outcome.location || 'the battlefield',
        outcome: outcome.label || outcome.status || 'Ended',
        rounds: outcome.rounds || 0,
        survivors,
        fallen: fallen || 'None',
        fled: fled || 'None',
        defeated: defeated || 'None',
        enemies_remaining: enemiesRemaining,
        enemiesRemaining,
        partyState,
        allyState,
        trigger,
        willpowerBreaks,
        sideChanges,
        transformations,
        highlights: describeHighlights(outcome),
        finalState: describeFinalUnits(outcome),
        details,
        summary: outcome.summary || '',
    }).trim();
    if (!rendered) return '';
    const label = isTraditional ? 'TRADITIONAL_COMBAT_CONTEXT' : 'TACTICAL_COMBAT_CONTEXT';
    const bridge = `[${label}]\nA ${isTraditional ? 'traditional turn-based' : 'tactical'} encounter triggered by the player's previous message has just been resolved on the board. That previous message is not a new action and must not be replayed. Treat the result below as authoritative over stale State Memo or chat-history assumptions. The fight is over unless the result explicitly leaves enemies standing.\n[/${label}]\n\n`;
    return `${bridge}${rendered}\n\n`;
}

/**
 * Mark that the pending result was actually placed in this generation's prompt.
 * @param {Record<string, any>} settings
 * @param {string} [chatId]
 */
export function markNarrationInjected(settings, chatId = getActiveChatId()) {
    const pending = getPendingNarration(settings);
    if (!pending) return;
    pending.injectedAt = Date.now();
    pending.injectedFor = String(chatId || pending.chatId || '');
}

/**
 * Called after a real narrator generation ended. Quiet/agent generations must
 * not clear the result before the narrator sees it.
 * @param {Record<string, any>} settings
 * @param {string} [chatId]
 * @param {{ save?: boolean }} [options]
 */
export function clearNarrationAfterGeneration(settings, chatId = getActiveChatId(), options = {}) {
    const pending = getPendingNarration(settings);
    if (!pending) return;
    if (!options.force && !pending.injectedAt) return;
    if (!options.force && pending.injectedFor && chatId && String(pending.injectedFor) !== String(chatId)) return;
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
