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
import { COMBATANT_HP_RX, parseCombatants } from '../../state/combat-persistence.js';
import { DEFAULT_LEWD_OUTCOME_PROMPT } from './lewd-combat-prompts.js';
import { getPendingNarration, setPendingNarration } from '../tactical-combat/tactical-combat-store.js';

export const LEWD_COMBAT_CONTEXT_LABEL = 'LEWD_COMBAT_CONTEXT';

export const LEWD_COMBAT_CLEANUP_MODES = Object.freeze(['off', 'mark', 'close']);

const COMBAT_SOURCED_SIDES = new Set(['ally', 'enemy', 'opponent']);
const NO_SATED_OUTCOMES = new Set(['stopped', 'draw', 'mutual']);
const STATUS_LINE_RX = /^(\s*\|?\s*)Status\s*:/i;

export const LEWD_COMBAT_RESULT_NOTICE = `[LEWD_COMBAT_RESULT_NOTICE]
An intimate Lewd Combat scene triggered by the previous player action has just resolved. It is OVER; this turn is the aftermath. The full authoritative result is attached as a system note after this message. It is not a new player action; continue from its aftermath. Do not resume or restart the encounter, do not replay exchanges, and do not call StartLewdCombat. Defeated or surrendered participants are at the winner's mercy and remain in the scene with status At Mercy; they are not new hostiles and must not be attacked or treated as a new encounter. There is no new sexual encounter unless the player explicitly starts one after a new scene turn. Do not declare a death or lasting injury from a Lewd Combat loss. Do not rewrite [COMBAT], HP, or Willpower, and do not re-open [COMBAT] for this scene.
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

/** A combat-sourced participant is a non-spectator on ally/enemy/opponent side. */
function isCombatSourcedParticipant(participant) {
    if (!participant || participant.spectator) return false;
    return COMBAT_SOURCED_SIDES.has(text(participant.side).toLowerCase());
}

function normalizeCombatName(value) {
    return text(value).replace(/^[-*•]\s*/, '').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Per-target mercy entries. Pure; never mutates `state`.
 *
 * @param {object} state
 * @returns {{ holderIds: any[], holderNames: string[], targetIds: any[], targetNames: string[], status: 'at-mercy'|'surrendered' }[]}
 */
export function buildLewdMercy(state) {
    const participants = Array.isArray(state?.participants) ? state.participants : [];
    const nonSpectators = participants.filter(participant => !participant?.spectator);
    const declared = Array.isArray(state?.winnerIds) ? state.winnerIds : [];
    let holders = declared
        .map(id => participants.find(participant => String(participant?.id) === String(id)))
        .filter(participant => !!participant && !participant.spectator);
    if (!holders.length) {
        holders = nonSpectators.filter(participant => !participant?.atMercy && !participant?.surrendered);
    }
    const holderIds = holders.map(participant => participant?.id).filter(id => id != null);
    const holderNames = holders.map(participant => text(participant?.name)).filter(Boolean);

    return nonSpectators
        .filter(participant => participant?.atMercy || participant?.surrendered)
        .map(participant => ({
            holderIds: [...holderIds],
            holderNames: [...holderNames],
            targetIds: [participant?.id],
            targetNames: [text(participant?.name)].filter(Boolean),
            status: participant?.atMercy ? 'at-mercy' : 'surrendered',
        }));
}

/**
 * Human-readable mercy summary for the narrator template.
 *
 * @param {object} state
 * @returns {string}
 */
export function buildMercyText(state) {
    const entries = buildLewdMercy(state);
    if (!entries.length) return 'None recorded.';
    return entries.map(entry => {
        const target = entry.targetNames.join(', ') || 'The loser';
        const holders = entry.holderNames.join(', ') || 'the winner';
        if (entry.status === 'surrendered') return `${target} surrendered to ${holders}.`;
        return `${target} is at the mercy of ${holders}.`;
    }).join(' ');
}

/**
 * Resolve the persisted cleanup mode, defaulting unknown values to `mark`.
 *
 * @param {any} value
 * @returns {'off'|'mark'|'close'}
 */
export function resolveLewdCombatCleanupMode(value) {
    const mode = text(value);
    return LEWD_COMBAT_CLEANUP_MODES.includes(mode) ? mode : 'mark';
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
        atMercyIds: participants.filter(participant => !participant.spectator && participant.atMercy).map(participant => participant.id),
        surrenderedIds: participants.filter(participant => !participant.spectator && participant.surrendered).map(participant => participant.id),
        mercy: buildLewdMercy(state),
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
 * Build the durable resolution recorded on an ended board. Pure.
 *
 * @param {object} state
 * @param {{ now?: number }} [options]
 * @returns {object|null}
 */
export function buildLewdResolution(state, options = {}) {
    if (!state || !state.status || state.status === 'active') return null;
    const participants = Array.isArray(state.participants) ? state.participants : [];
    const ids = predicate => participants
        .filter(participant => !participant?.spectator && predicate(participant))
        .map(participant => participant.id)
        .filter(id => id != null);
    return {
        stateId: state.id ?? '',
        endedAt: Number(state.endedAt) || Number(options.now) || Date.now(),
        consumedAt: 0,
        consumedFor: '',
        deliveredAt: 0,
        outcome: state.outcome || '',
        winnerIds: Array.isArray(state.winnerIds) ? [...state.winnerIds] : [],
        atMercyIds: ids(participant => !!participant.atMercy),
        surrenderedIds: ids(participant => !!participant.surrendered),
        mercy: buildLewdMercy(state),
        finalProse: String(state?.prose?.text || ''),
        highlights: buildHighlights(state),
        source: 'lewd',
    };
}

/**
 * Ensure the board carries exactly one resolution object. Existing records are
 * never replaced, so repeated finish calls cannot duplicate or reset the latch.
 *
 * @param {object} state
 * @param {{ now?: number }} [options]
 * @returns {object|null}
 */
export function ensureLewdResolution(state, options = {}) {
    if (!state || state.status === 'active') return null;
    const built = buildLewdResolution(state, options);
    if (state.resolution && typeof state.resolution === 'object') {
        // Backfill the extended fields on legacy records without replacing the
        // object reference and without touching the consumed/delivered latch.
        for (const key of [
            'stateId', 'endedAt', 'outcome', 'winnerIds', 'atMercyIds',
            'surrenderedIds', 'mercy', 'finalProse', 'highlights', 'source',
        ]) {
            if (!(key in state.resolution) && built && built[key] !== undefined) {
                state.resolution[key] = built[key];
            }
        }
        return state.resolution;
    }
    state.resolution = built;
    return state.resolution;
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
    const now = Date.now();
    setPendingNarration(settings, payload, { persist: false });
    state.finalization = {
        ...(state.finalization || {}),
        narrationQueued: true,
        queuedAt: now,
        finalizing: true,
        finalizingStartedAt: now,
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

function buildCleanupScene(state) {
    const participants = Array.isArray(state?.participants) ? state.participants : [];
    const nonSpectators = participants.filter(participant => !participant?.spectator);
    const combatSourced = nonSpectators.filter(isCombatSourcedParticipant);
    const byName = new Map();
    for (const participant of combatSourced) {
        const name = normalizeCombatName(participant?.name);
        if (name) byName.set(name, participant);
    }
    const declaredWinners = Array.isArray(state?.winnerIds)
        ? state.winnerIds.map(id => String(id)).filter(Boolean)
        : [];
    return {
        combatSourced: combatSourced.length > 0,
        byName,
        winnerIds: new Set(declaredWinners),
        hasWinners: declaredWinners.length > 0,
        activeIds: new Set(combatSourced
            .filter(participant => !participant?.atMercy && !participant?.surrendered)
            .map(participant => String(participant?.id))),
        outcome: text(state?.outcome),
        noSated: NO_SATED_OUTCOMES.has(text(state?.outcome)),
        sceneNames: new Set(nonSpectators.map(participant => normalizeCombatName(participant?.name)).filter(Boolean)),
    };
}

function statusForParticipant(scene, participant) {
    if (!participant) return '';
    if (participant.atMercy || participant.surrendered) return 'At Mercy';
    if (scene.noSated) return '';
    if (scene.hasWinners) {
        return scene.winnerIds.has(String(participant.id)) ? 'Sated' : '';
    }
    return scene.activeIds.has(String(participant.id)) ? 'Sated' : '';
}

/** Rewrite only the matched combatants' status lines inside one block body. */
function applyMarksToBlock(content, scene) {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(eol);
    const groups = [];
    let current = null;
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].trim().match(COMBATANT_HP_RX);
        if (!match) continue;
        if (current) current.end = index;
        current = { name: match[1].trim(), start: index, end: lines.length };
        groups.push(current);
    }

    const marks = [];
    for (let index = groups.length - 1; index >= 0; index -= 1) {
        const group = groups[index];
        const participant = scene.byName.get(normalizeCombatName(group.name));
        const status = statusForParticipant(scene, participant);
        if (!status) continue;
        let replaced = false;
        for (let line = group.start + 1; line < group.end; line += 1) {
            const match = lines[line].match(STATUS_LINE_RX);
            if (!match) continue;
            lines[line] = `${match[1]}Status: ${status}`;
            replaced = true;
            break;
        }
        if (!replaced) lines.splice(group.start + 1, 0, `Status: ${status}`);
        marks.unshift({ name: participant?.name || group.name, status });
    }
    return { content: marks.length ? lines.join(eol) : content, marks };
}

/**
 * Pure `[COMBAT]` cleanup summary for the finished lewd scene.
 *
 * @param {object} state
 * @param {Record<string, any>} settings
 * @returns {{ mode: string, writeback: boolean, combatSourced: boolean, memo: string, changed: boolean, closed: boolean, marked: { name: string, status: string }[] }}
 */
export function buildLewdCombatCleanup(state, settings) {
    const mode = resolveLewdCombatCleanupMode(settings?.lewdCombatCombatCleanup);
    const writeback = settings?.lewdCombatMercyStatusWriteback !== false;
    const memo = String(settings?.currentMemo ?? '');
    const scene = buildCleanupScene(state);
    const summary = { mode, writeback, combatSourced: scene.combatSourced, memo, changed: false, closed: false, marked: [] };
    if (mode === 'off' || !scene.combatSourced || !memo) return summary;

    let closed = false;
    const marked = [];
    const nextMemo = memo.replace(/\[COMBAT\]([\s\S]*?)\[\/COMBAT\]/gi, (full, content) => {
        const marks = writeback ? applyMarksToBlock(content, scene) : { content, marks: [] };
        if (mode === 'close') {
            const combatants = parseCombatants(content);
            const matchesScene = combatants.length > 0
                && combatants.every(combatant => scene.sceneNames.has(normalizeCombatName(combatant.name)));
            if (matchesScene) {
                closed = true;
                marked.push(...marks.marks);
                return '[COMBAT]END_COMBAT[/COMBAT]';
            }
        }
        if (!marks.marks.length) return full;
        marked.push(...marks.marks);
        return `[COMBAT]${marks.content}[/COMBAT]`;
    });

    summary.memo = nextMemo;
    summary.changed = nextMemo !== memo;
    summary.closed = closed;
    summary.marked = marked;
    return summary;
}

/**
 * Apply the cleanup once to the persisted memo and record the summary on the
 * board's resolution. Idempotent and never throws to the caller.
 *
 * @param {object} state
 * @param {Record<string, any>} settings
 * @param {{ persist?: boolean, now?: number }} [options]
 * @returns {object|null}
 */
export function applyLewdCombatCleanup(state, settings, options = {}) {
    if (!state || !settings) return null;
    try {
        const resolution = state.resolution && typeof state.resolution === 'object'
            ? state.resolution
            : ensureLewdResolution(state, { now: options.now });
        if (resolution?.cleanupAt) return resolution.cleanup || null;

        const summary = buildLewdCombatCleanup(state, settings);
        if (resolution && summary.changed) settings.currentMemo = summary.memo;
        if (resolution) {
            resolution.cleanup = {
                mode: summary.mode,
                writeback: summary.writeback,
                combatSourced: summary.combatSourced,
                closed: summary.closed,
                marked: summary.marked,
            };
            resolution.cleanupAt = Number(options.now) || Date.now();
        }
        if (options.persist !== false) saveSettings();
        return resolution?.cleanup || null;
    } catch (error) {
        console.warn('[RPG Tracker] Lewd Combat cleanup deferred:', error);
        return null;
    }
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
    const mercy = buildMercyText(pending);

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
            mercy,
            highlights,
            finalProse: pending.finalProse || 'None recorded.',
            summary: pending.summary || '',
            darkerThemes: pending.darkerThemes ? 'Yes' : 'No',
        },
    ).trim();
    if (!rendered) return '';

    const bridge = `[${LEWD_COMBAT_CONTEXT_LABEL}]
An intimate Lewd Combat scene just resolved on the board. It is OVER; this is the aftermath. The previous message is not a new action and must not be replayed. Do not resume or restart the encounter, do not replay exchanges, and do not call StartLewdCombat. Treat the result below as authoritative over stale memo/history. Defeated or surrendered participants are at the winner's mercy and remain in the scene with status At Mercy; they are not new hostiles and must not be attacked or treated as a new encounter. There is no new sexual encounter unless the player explicitly starts one after a new scene turn. Do not resolve another exchange, do not add a climax, and do not declare a death or lasting injury from a Lewd Combat loss. Never rewrite [COMBAT], HP, or Willpower; this module never touched them. The scene stays stopped unless the result explicitly says otherwise.
[/${LEWD_COMBAT_CONTEXT_LABEL}]

`;
    return `${bridge}${rendered}\n\n`;
}
