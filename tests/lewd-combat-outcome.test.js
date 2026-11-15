import { describe, expect, it } from 'vitest';
import {
    applyLewdAction,
    createLewdEncounterState,
} from '../src/features/lewd-combat/lewd-combat-engine.js';
import {
    buildLewdNarrationBlock,
    buildLewdOutcomePayload,
    describeLewdOutcome,
    LEWD_COMBAT_CONTEXT_LABEL,
    LEWD_COMBAT_RESULT_NOTICE,
    queueLewdOutcome,
} from '../src/features/lewd-combat/lewd-combat-outcome.js';
import { DEFAULT_LEWD_OUTCOME_PROMPT } from '../src/features/lewd-combat/lewd-combat-prompts.js';
import { buildNarrationBlock, clearNarrationAfterGeneration, markNarrationInjected } from '../src/features/tactical-combat/tactical-combat-outcome.js';
import { getPendingNarration } from '../src/features/tactical-combat/tactical-combat-store.js';

function profile(name, overrides = {}) {
    return {
        name,
        role: 'switch',
        orientation: '',
        stamina: 4,
        maxStamina: 4,
        maxArousal: 20,
        maxPoise: 8,
        sensitivity: {},
        preference: {},
        limits: [],
        endurance: 0,
        experience: 0,
        traits: {},
        drain: 0,
        notes: '',
        source: 'lewd',
        inferred: false,
        warnings: [],
        ...overrides,
    };
}

const TECHNIQUES = {
    'neck-kiss': {
        id: 'neck-kiss',
        name: 'Neck Kiss',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'single',
        tags: ['teasing'],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '6',
        poise: '0',
    },
};

function buildState({ chatId = 'chat-A', status = 'active' } = {}) {
    const state = createLewdEncounterState({
        id: 'lewd-outcome-test',
        seed: 'lewd-outcome-seed',
        mode: 'duel',
        settings: { lewdCombatExplicitness: 'explicit', lewdCombatDarkerThemes: false },
        participants: [
            {
                id: 'aria',
                name: 'Aria',
                side: 'player',
                profile: profile('Aria', { maxStamina: 4, maxArousal: 20, maxPoise: 8, limits: ['marking'] }),
            },
            {
                id: 'bran',
                name: 'Bran',
                side: 'opponent',
                profile: profile('Bran', { maxStamina: 3, maxArousal: 30, maxPoise: 8, limits: ['breath play'] }),
            },
        ],
    });
    state.chatId = chatId;
    state.title = 'The Alcove';
    state.location = 'The Gilded Inn';
    state.status = status;
    return state;
}

function endedState() {
    const state = buildState();
    const hit = applyLewdAction(state, {
        type: 'technique',
        unitId: 'aria',
        techniqueId: 'neck-kiss',
        targetIds: ['bran'],
        zone: 'neck',
    }, { techniques: TECHNIQUES });
    expect(hit.ok).toBe(true);
    const yielded = applyLewdAction(state, { type: 'surrender', unitId: 'bran' });
    expect(yielded.ok).toBe(true);
    expect(state.status).toBe('ended');
    state.prose = { text: 'Aria eases back and lets Bran breathe.', round: state.endedRound };
    return state;
}

function openStateWithOutcome(outcome, participants, extra = {}) {
    return {
        status: 'ended',
        outcome,
        participants,
        ...extra,
    };
}

describe('lewd combat outcome payload', () => {
    it('builds an authoritative lewd payload with pools, pairings, limits, and highlights', () => {
        const state = endedState();
        const snapshot = JSON.stringify(state);

        const payload = buildLewdOutcomePayload(state);

        expect(payload.kind).toBe('lewd');
        expect(payload.chatId).toBe('chat-A');
        expect(payload.stateId).toBe(state.id);
        expect(payload.title).toBe('The Alcove');
        expect(payload.location).toBe('The Gilded Inn');
        expect(payload.outcome).toBe('surrendered');
        expect(payload.outcomeLabel).toMatch(/surrendered to Aria/);

        const aria = payload.participants.find(participant => participant.name === 'Aria');
        expect(aria.stamina).toBe(4);
        expect(aria.maxStamina).toBe(4);
        expect(aria.arousal).toBeDefined();
        expect(aria.maxArousal).toBe(20);
        expect(aria.poise).toBeDefined();
        expect(aria.maxPoise).toBe(8);
        expect(JSON.stringify(payload)).not.toMatch(/"hp"|"maxHp"|willpower/i);

        expect(payload.pairings).toHaveLength(1);
        expect(payload.pairings[0]).toMatchObject({ a: 'Aria', b: 'Bran' });
        expect(payload.limits).toEqual(['marking', 'breath play']);

        expect(payload.highlights).toHaveLength(1);
        expect(payload.highlights[0]).toContain('Aria used Neck Kiss on Bran');
        expect(payload.highlights[0]).toMatch(/Arousal/);
        expect(payload.finalProse).toBe('Aria eases back and lets Bran breathe.');

        expect(JSON.stringify(state)).toBe(snapshot);
    });

    it('keeps only the last six technique highlights and records winner ids', () => {
        const state = endedState();
        state.winnerIds = ['aria'];
        state.log = Array.from({ length: 8 }, (_, index) => ({
            type: 'technique',
            round: index + 1,
            actor: { id: 'aria', name: 'Aria' },
            technique: { id: 'neck-kiss', name: `Move ${index + 1}` },
            targets: [{ id: 'bran', name: 'Bran', hit: true, arousalDelta: 1 }],
        }));
        state.log.unshift({ type: 'wait', round: 0, actor: { id: 'aria', name: 'Aria' } });

        const payload = buildLewdOutcomePayload(state);

        expect(payload.winnerIds).toEqual(['aria']);
        expect(payload.highlights).toHaveLength(6);
        expect(payload.highlights[0]).toContain('Move 3');
        expect(payload.highlights[5]).toContain('Move 8');
    });

    it('queues one payload, is idempotent, and never touches [COMBAT]', () => {
        const state = endedState();
        const settings = {
            currentMemo: '[CHARACTER]\nAria\n[/CHARACTER]\n[COMBAT]\nGoblin: 1/1 HP\n[/COMBAT]',
        };
        const memoBefore = settings.currentMemo;

        const first = queueLewdOutcome(state, settings, { persist: false });
        expect(first.kind).toBe('lewd');
        expect(state.finalization.narrationQueued).toBe(true);
        expect(getPendingNarration(settings, 'chat-A')).toStrictEqual(first);
        expect(settings.currentMemo).toBe(memoBefore);

        const second = queueLewdOutcome(state, settings, { persist: false });
        expect(second).toBe(first);
        expect(getPendingNarration(settings, 'chat-A').createdAt).toBe(first.createdAt);
        expect(settings.currentMemo).toBe(memoBefore);
    });

    it('renders the lewd block through buildNarrationBlock and keeps tactical rendering intact', () => {
        const state = endedState();
        const settings = {};
        queueLewdOutcome(state, settings, { persist: false });

        const block = buildNarrationBlock(settings, 'chat-A');
        expect(block.startsWith(`[${LEWD_COMBAT_CONTEXT_LABEL}]`)).toBe(true);
        expect(block).toContain('authoritative over stale memo/history');
        expect(block).toContain('Stamina');
        expect(block).toContain('Aria');
        expect(block).not.toContain('[TACTICAL_COMBAT_CONTEXT]');
        expect(block).not.toContain('[TRADITIONAL_COMBAT_CONTEXT]');

        const tacticalSettings = {
            tacticalCombatReturn: {
                chatId: 'chat-A',
                stateId: 'tactical-1',
                outcome: { label: 'Victory', rounds: 2 },
            },
        };
        const tacticalBlock = buildNarrationBlock(tacticalSettings, 'chat-A');
        expect(tacticalBlock).toContain('[TACTICAL_COMBAT_CONTEXT]');
        expect(tacticalBlock).not.toContain('[LEWD_COMBAT_CONTEXT]');
    });

    it('describes every outcome without implying death', () => {
        const mercy = describeLewdOutcome(openStateWithOutcome('atMercy', [
            { id: 'aria', name: 'Aria', side: 'player' },
            { id: 'bran', name: 'Bran', side: 'opponent', atMercy: true },
        ], { winnerIds: ['aria'] }));
        expect(mercy.label).toBe('Bran is at the mercy of Aria');
        expect(mercy.label).not.toMatch(/dead|killed/i);
        expect(mercy.winners).toEqual(['Aria']);
        expect(mercy.losers).toEqual(['Bran']);

        const surrendered = describeLewdOutcome(openStateWithOutcome('surrendered', [
            { id: 'aria', name: 'Aria', side: 'player' },
            { id: 'bran', name: 'Bran', side: 'opponent', surrendered: true },
        ], { winnerIds: ['aria'] }));
        expect(surrendered.label).toMatch(/surrendered to Aria/);
        expect(surrendered.label).toMatch(/partner decides the aftermath/);

        const stopped = describeLewdOutcome(openStateWithOutcome('stopped', []));
        expect(stopped.label).toMatch(/safe word/i);
        expect(stopped.label).toMatch(/no winner/i);
        expect(stopped.winners).toEqual([]);

        expect(describeLewdOutcome(openStateWithOutcome('draw', [])).label).toBe('Draw — round cap reached');
        expect(describeLewdOutcome(openStateWithOutcome('mutual', [])).label).toBe('Mutual climax — shared outcome');
        expect(describeLewdOutcome(openStateWithOutcome('sideVictory', [
            { id: 'aria', name: 'Aria' },
        ], { winnerIds: ['aria'] })).label).toBe('Side victory: Aria');
        expect(describeLewdOutcome(openStateWithOutcome('mystery', [])).label).toBe('Encounter ended');
        expect(describeLewdOutcome(undefined).label).toBe('Encounter ended');
    });

    it('clears the queued payload only after injection', () => {
        const injectedSettings = {};
        queueLewdOutcome(endedState(), injectedSettings, { persist: false });
        expect(getPendingNarration(injectedSettings, 'chat-A')).not.toBeNull();
        markNarrationInjected(injectedSettings, 'chat-A');
        clearNarrationAfterGeneration(injectedSettings, 'chat-A', { save: false });
        expect(getPendingNarration(injectedSettings, 'chat-A')).toBeNull();

        const awaitingSettings = {};
        queueLewdOutcome(endedState(), awaitingSettings, { persist: false });
        clearNarrationAfterGeneration(awaitingSettings, 'chat-A', { save: false });
        expect(getPendingNarration(awaitingSettings, 'chat-A')).not.toBeNull();
    });

    it('ships the no-replay, no-death, and no-[COMBAT] rules in the notice and template', () => {
        expect(LEWD_COMBAT_RESULT_NOTICE).toContain('[LEWD_COMBAT_RESULT_NOTICE]');
        expect(LEWD_COMBAT_RESULT_NOTICE).toMatch(/do not replay/i);
        expect(LEWD_COMBAT_RESULT_NOTICE).toMatch(/death/i);
        expect(LEWD_COMBAT_RESULT_NOTICE).toContain('[COMBAT]');

        expect(DEFAULT_LEWD_OUTCOME_PROMPT).toMatch(/do not replay/i);
        expect(DEFAULT_LEWD_OUTCOME_PROMPT).toMatch(/death/i);
        expect(DEFAULT_LEWD_OUTCOME_PROMPT).toContain('[COMBAT]');
        expect(DEFAULT_LEWD_OUTCOME_PROMPT).toContain('{{participants}}');
    });

    it('renders a custom template and stays empty for other chats', () => {
        const state = endedState();
        const settings = { lewdCombatOutcomePrompt: 'RESULT={{outcome}} {{unknown}}' };
        queueLewdOutcome(state, settings, { persist: false });
        const block = buildLewdNarrationBlock(settings, 'chat-A');
        expect(block).toContain(`RESULT=${state.finalization.payload.outcomeLabel}`);
        expect(block).toContain('{{unknown}}');
        expect(buildLewdNarrationBlock(settings, 'chat-B')).toBe('');
        expect(buildLewdNarrationBlock(null, 'chat-A')).toBe('');
    });
});
