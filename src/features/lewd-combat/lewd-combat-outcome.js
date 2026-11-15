/**
 * lewd-combat-outcome.js — end-of-scene handoff to the main narrator.
 *
 * The lewd board is authoritative for its own numbers, but it never touches
 * [COMBAT], HP, or Willpower. When a scene ends this module builds one
 * `kind: 'lewd'` payload, queues it through the shared narration store, and
 * renders it back into the narrator prompt as `[LEWD_COMBAT_CONTEXT]`.
 *
 * Everything here is pure data assembly plus one queue write. It never calls
 * the engine, never rolls dice, and never mutates the board.
 */

import { getActiveChatId } from '../../../state-manager.js';
import { saveSettings } from '../../app/runtime-bridge.js';
import { renderTacticalTemplate } from '../tactical-combat/tactical-combat-prompts.js';
import { DEFAULT_LEWD_OUTCOME_PROMPT } from './lewd-combat-prompts.js';
import { getPendingNarration, setPendingNarration } from '../tactical-combat/tactical-combat-store.js';

export const LEWD_COMBAT_CONTEXT_LABEL = 'LEWD_COMBAT_CONTEXT';

export const LEWD_COMBAT_RESULT_NOTICE = `[LEWD_COMBAT_RESULT_NOTICE]
An intimate Lewd Combat scene triggered by the previous player action has just resolved. It is OVER; this turn is the aftermath. The full authoritative result is attached as a system note after this message. It is not a new player action; continue from its aftermath. Do not replay the scene, do not roll new exchanges, and do not declare a death or lasting injury from a Lewd Combat loss. Do not rewrite [COMBAT], HP, or Willpower, and do not re-open [COMBAT] for this scene.
[/LEWD_COMBAT_RESULT_NOTICE]

`;

function text(value) {
    return String(value ?? '').trim();
}

function namesForIds(state, ids) {
    const participants = Array.isArray(state?.participants) ? state.participants : [];
    return (Array.isArray(ids) ? ids : [])
        .map(id => participants.find(participant => String(participant.id) === String(id))?.name)
        .filter(Boolean);
}

function activeNames(state) {
    return (state?.participants || [])
        .filter(participant => !participant?.spectator && !participant?.atMercy && !participant?.surrendered)
        .map(participant => participant?.name)
        .filter(Boolean);
}

function outNames(state) {
    return (state?.participants || [])
        .filter(participant => !participant?.spectator && (participant?.atMercy || participant?.surrendered))
        .map(participant => participant?.name)
        .filter(Boolean);
}

/**
 * Describe a finished scene without implying death or lasting injury.
 *
 * @param {object} state
 * @returns {{ key: string, label: string, mercy?: boolean, winners: string[], losers: string[] }}
 */
export function describeLewdOutcome(state) {
    const key = text(state?.outcome);
    const declaredWinners = namesForIds(state, state?.winnerIds);
    const winners = declaredWinners.length ? declaredWinners : activeNames(state);
    const losers = outNames(state);
    const winnerText = winners.join(', ');
    const loserText = losers.join(', ');

    if (key === 'atMercy') {
        const verb = losers.length > 1 ? 'are' : 'is';
        return {
            key,
            label: `${loserText || 'The loser'} ${verb} at the mercy of ${winnerText || 'the winner'}`,
            mercy: true,
            winners,
            losers,
        };
    }
    if (key === 'surrendered') {
        return {
            key,
            label: `${loserText || 'The loser'} surrendered to ${winnerText || 'the winner'}; the partner decides the aftermath`,
            winners,
            losers,
        };
    }
    if (key === 'stopped') {
        return { key, label: 'Stopped by safe word — no winner, no aftermath imposed', winners: [], losers: [] };
    }
    if (key === 'draw') {
        return { key, label: 'Draw — round cap reached', winners: [], losers: [] };
    }
    if (key === 'mutual') {
        return { key, label: 'Mutual climax — shared outcome', winners: [], losers: [] };
    }
    if (key === 'sideVictory') {
        return { key, label: `Side victory: ${winnerText || 'unknown'}`, winners, losers: [] };
    }
    return { key, label: 'Encounter ended', winners: [], losers: [] };
}

function limitUnion(state) {
    const limits = [];
    for (const participant of state?.participants || []) {
        if (participant?.spectator) continue;
        for (const limit of participant?.profile?.limits || []) {
            const value = text(limit);
            if (value && !limits.includes(value)) limits.push(value);
        }
    }
    return limits;
}

function describeHighlight(beat) {
    const actor = text(beat?.actor?.name) || 'Someone';
    const technique = text(beat?.technique?.name) || 'a technique';
    const targets = Array.isArray(beat?.targets) ? beat.targets : [];
    const targetNames = targets.map(target => text(target?.name)).filter(Boolean).join(', ') || 'no target';
    const hits = targets.filter(target => target?.hit);
    const arousal = hits.reduce((sum, target) => sum + (Number(target?.arousalDelta) || 0), 0);
    const climax = targets.some(target => target?.climaxed);
    const extras = [];
    if (arousal) extras.push(`${arousal > 0 ? '+' : ''}${arousal} Arousal`);
    if (climax) extras.push('climax');
    const suffix = extras.length ? `; ${extras.join('; ')}` : '';
    return `${actor} used ${technique} on ${targetNames} (${hits.length ? 'hit' : 'miss'}${suffix})`;
}

function buildHighlights(state) {
    return (state?.log || [])
        .filter(beat => beat?.type === 'technique')
        .slice(-6)
        .map(describeHighlight);
}

function buildPairings(state) {
    const byId = new Map((state?.participants || []).map(participant => [String(participant.id), participant]));
    return (state?.engagements || []).map(edge => ({
        a: byId.get(String(edge?.a))?.name || String(edge?.a || ''),
        b: byId.get(String(edge?.b))?.name || String(edge?.b || ''),
        hold: text(edge?.hold?.label) || text(edge?.hold?.id) || null,
        stance: text(edge?.stance?.label) || text(edge?.stance?.id) || null,
        intensity: Number(edge?.intensity) || 0,
    }));
}

/**
 * Build the authoritative endpoint payload. Never mutates `state`.
 *
 * @param {object} state
 * @param {{ chatId?: string }} [options]
 * @returns {object}
 */
export function buildLewdOutcomePayload(state, options = {}) {
    const outcome = describeLewdOutcome(state);
    const participants = (state?.participants || []).map(participant => ({
        id: participant?.id,
        name: participant?.name,
        side: participant?.side,
        spectator: !!participant?.spectator,
        role: text(participant?.profile?.role),
        stance: text(participant?.stance?.label) || text(participant?.stance?.id) || null,
        stamina: Number(participant?.stamina) || 0,
        maxStamina: Number(participant?.maxStamina) || 0,
        arousal: Number(participant?.arousal) || 0,
        maxArousal: Number(participant?.maxArousal) || 0,
        poise: Number(participant?.poise) || 0,
        maxPoise: Number(participant?.maxPoise) || 0,
        atMercy: !!participant?.atMercy,
        surrendered: !!participant?.surrendered,
        limits: Array.isArray(participant?.profile?.limits) ? [...participant.profile.limits] : [],
    }));

    return {
        chatId: String(options.chatId || state?.chatId || getActiveChatId() || ''),
        stateId: state?.id,
        kind: 'lewd',
        title: text(state?.title) || 'Lewd Combat',
        location: text(state?.location),
        mode: state?.mode,
        tone: text(state?.tone) || text(state?.settings?.lewdCombatExplicitness) || 'explicit',
        darkerThemes: !!state?.settings?.lewdCombatDarkerThemes,
        outcome: state?.outcome,
        outcomeLabel: outcome.label,
        winnerIds: Array.isArray(state?.winnerIds) ? [...state.winnerIds] : [],
        rounds: Number(state?.endedRound || state?.round) || 1,
        summary: text(state?.summary),
        participants,
        pairings: buildPairings(state),
        highlights: buildHighlights(state),
        limits: limitUnion(state),
        limitsRespected: true,
        finalProse: String(state?.prose?.text || ''),
        createdAt: Date.now(),
        injectedAt: 0,
        injectedFor: '',
    };
}

/**
 * Queue exactly one lewd result for the next narrator generation. Idempotent.
 *
 * @param {object} state
 * @param {Record<string, any>} settings
 * @param {{ persist?: boolean, save?: Function, chatId?: string }} [options]
 * @returns {object|null}
 */
export function queueLewdOutcome(state, settings, options = {}) {
    if (!state || !state.status || state.status === 'active') return null;
    if (state.finalization?.narrationQueued) {
        return state.finalization.payload || buildLewdOutcomePayload(state, options);
    }

    const payload = buildLewdOutcomePayload(state, options);
    setPendingNarration(settings, payload, { persist: false });
    state.finalization = {
        ...(state.finalization || {}),
        narrationQueued: true,
        queuedAt: Date.now(),
        payload,
        outcome: payload.outcome,
    };

    if (options.persist !== false) {
        if (typeof options.save === 'function') options.save();
        else {
            try {
                saveSettings();
            } catch (error) {
                console.warn('[RPG Tracker] Lewd Combat outcome save deferred:', error);
            }
        }
    }
    return payload;
}

function describeParticipants(payload) {
    const list = Array.isArray(payload.participants) ? payload.participants : [];
    if (!list.length) return 'None recorded.';
    return list.map(participant => {
        const role = text(participant.role) || 'participant';
        const status = participant.spectator
            ? 'spectator'
            : participant.atMercy
                ? 'at mercy'
                : participant.surrendered
                    ? 'surrendered'
                    : 'active';
        return `- ${participant.name} [${participant.side}/${role}]: ${participant.stamina}/${participant.maxStamina} Stamina, ${participant.arousal}/${participant.maxArousal} Arousal, ${participant.poise}/${participant.maxPoise} Poise — ${status}`;
    }).join('\n');
}

function describePairings(payload) {
    const list = Array.isArray(payload.pairings) ? payload.pairings : [];
    if (!list.length) return 'None recorded.';
    return list.map(pairing => `- ${pairing.a} ↔ ${pairing.b}: hold ${pairing.hold || 'none'}, stance ${pairing.stance || 'none'} (intensity ${Number(pairing.intensity) || 0})`).join('\n');
}

/**
 * Render the queued lewd result for the narrator prompt. Returns '' for other
 * chats, other payload kinds, or when nothing is queued.
 *
 * @param {Record<string, any>} settings
 * @param {string} [chatId]
 * @returns {string}
 */
export function buildLewdNarrationBlock(settings, chatId = getActiveChatId()) {
    if (!settings) return '';
    const pending = getPendingNarration(settings, chatId || null);
    if (!pending || pending.kind !== 'lewd') return '';
    if (chatId && pending.chatId && String(pending.chatId) !== String(chatId)) return '';

    const labels = describeLewdOutcome({
        outcome: pending.outcome,
        winnerIds: pending.winnerIds,
        participants: (pending.participants || []).map(participant => ({
            id: participant.id,
            name: participant.name,
            spectator: participant.spectator,
            atMercy: participant.atMercy,
            surrendered: participant.surrendered,
        })),
    });
    const highlights = Array.isArray(pending.highlights) && pending.highlights.length
        ? pending.highlights.map(item => `- ${item}`).join('\n')
        : '- No decisive highlight was recorded.';
    const limits = Array.isArray(pending.limits) && pending.limits.length
        ? pending.limits.join(', ')
        : 'None declared.';

    const rendered = renderTacticalTemplate(
        settings.lewdCombatOutcomePrompt || DEFAULT_LEWD_OUTCOME_PROMPT,
        {
            title: pending.title || 'Lewd Combat',
            location: pending.location || '',
            mode: pending.mode || 'duel',
            outcome: pending.outcomeLabel || labels.label,
            rounds: pending.rounds || 0,
            tone: pending.tone || 'explicit',
            participants: describeParticipants(pending),
            pairings: describePairings(pending),
            limitsRespected: pending.limitsRespected === false ? 'No' : 'Yes',
            limits,
            highlights,
            finalProse: pending.finalProse || 'None recorded.',
            summary: pending.summary || '',
            darkerThemes: pending.darkerThemes ? 'Yes' : 'No',
        },
    ).trim();
    if (!rendered) return '';

    const bridge = `[${LEWD_COMBAT_CONTEXT_LABEL}]
An intimate Lewd Combat scene just resolved on the board. It is OVER; this is the aftermath. The previous message is not a new action and must not be replayed. Treat the result below as authoritative over stale memo/history. Do not resolve another exchange, do not add a climax, and do not declare a death or lasting injury from a Lewd Combat loss. Never rewrite [COMBAT], HP, or Willpower; this module never touched them. The scene stays stopped unless the result explicitly says otherwise.
[/${LEWD_COMBAT_CONTEXT_LABEL}]

`;
    return `${bridge}${rendered}\n\n`;
}
