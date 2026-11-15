import { describe, expect, it } from 'vitest';

import {
    applyLewdAction,
    climaxParticipant,
    createLewdEncounterState,
    joinParticipant,
    surrenderParticipant,
} from '../src/features/lewd-combat/lewd-combat-engine.js';
import {
    applyProfileTraits,
} from '../src/features/lewd-combat/lewd-combat-profile.js';
import {
    buildLewdNarrationBlock,
    queueLewdOutcome,
} from '../src/features/lewd-combat/lewd-combat-outcome.js';
import {
    getLewdEncounterForChat,
    removeLewdEncounterForChat,
    setLewdEncounterForChat,
} from '../src/features/lewd-combat/lewd-combat-store.js';
import { clearPendingNarration, getPendingNarration } from '../src/features/tactical-combat/tactical-combat-store.js';
import { buildDefaultSettings } from '../src/state/defaults.js';

function profile(name, overrides = {}) {
    return {
        name,
        role: 'switch',
        orientation: '',
        stamina: 3,
        maxStamina: 3,
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
        arousal: '4',
        poise: '0',
        ai: { priority: 1 },
    },
};

function createState(settings, overrides = {}) {
    const state = createLewdEncounterState({
        id: 'lewd-integration',
        seed: 'lewd-integration-seed',
        mode: 'duel',
        settings,
        participants: [
            {
                id: 'aria',
                name: 'Aria',
                side: 'player',
                profile: profile('Aria', { limits: ['marking'] }),
            },
            {
                id: 'bran',
                name: 'Bran',
                side: 'opponent',
                profile: profile('Bran', { maxStamina: 3, drain: 1 }),
            },
            {
                id: 'cass',
                name: 'Cass',
                side: 'player',
                spectator: true,
                profile: profile('Cass'),
            },
        ],
        ...overrides,
    });
    state.chatId = 'chat-A';
    state.title = 'The Alcove';
    state.location = 'The Gilded Inn';
    return state;
}

function prepareSettings() {
    const settings = buildDefaultSettings();
    settings.lewdCombatEnabled = true;
    settings.currentMemo = '[COMBAT]\n- none\nHP: 10/10\nWillpower: 4/4\n[/COMBAT]';
    settings.tacticalCombatReturnByChat = {};
    settings.tacticalCombatReturn = null;
    return settings;
}

describe('Lewd Combat end-to-end integration', () => {
    it('runs a deterministic scene from start to narrator handoff without touching [COMBAT]', () => {
        const settings = prepareSettings();
        const memoBefore = settings.currentMemo;
        const state = createState(settings);
        setLewdEncounterForChat('chat-A', state, settings, { persist: false });
        expect(getLewdEncounterForChat('chat-A', settings)).toBe(state);

        const replay = createState(settings);
        for (const board of [state, replay]) {
            const aria = applyLewdAction(board, {
                type: 'technique',
                unitId: 'aria',
                techniqueId: 'neck-kiss',
                targetIds: ['bran'],
                zone: 'neck',
            }, { techniques: TECHNIQUES });
            expect(aria.ok).toBe(true);
            const bran = applyLewdAction(board, {
                type: 'technique',
                unitId: 'bran',
                techniqueId: 'neck-kiss',
                targetIds: ['aria'],
                zone: 'neck',
            }, { techniques: TECHNIQUES });
            expect(bran.ok).toBe(true);
        }
        expect(state.log.map(beat => beat.targets?.[0]?.arousalDelta))
            .toEqual(replay.log.map(beat => beat.targets?.[0]?.arousalDelta));
        expect(state.rollCount).toBe(replay.rollCount);

        // A drain-1 profile still pays at least 1 Stamina per climax.
        const bran = state.participants.find(participant => participant.id === 'bran');
        const first = climaxParticipant(state, bran);
        expect(first.cost).toBe(1);
        expect(bran.stamina).toBe(2);
        expect(bran.arousal).toBe(0);
        expect(bran.status.some(status => status.id === 'overstimulated')).toBe(true);
        climaxParticipant(state, bran);
        expect(bran.stamina).toBe(1);

        // A surrendered participant is out of the queue and cannot re-enter.
        surrenderParticipant(state, 'aria');
        expect(state.status).toBe('ended');
        expect(state.outcome).toBe('surrendered');
        const reentry = joinParticipant(state, { id: 'aria', name: 'Aria', side: 'player' });
        expect(reentry.ok).toBe(false);
        expect(reentry.reason).toMatch(/cannot re-enter/i);

        // The remaining participant can still be brought to 0 Stamina.
        const last = climaxParticipant(state, bran);
        expect(last.cost).toBe(1);
        expect(bran.stamina).toBe(0);
        expect(bran.atMercy).toBe(true);
        expect(bran.stance).toBeNull();

        const payload = queueLewdOutcome(state, settings, { persist: false });
        expect(payload.kind).toBe('lewd');
        expect(payload.outcome).toBe('surrendered');
        expect(getPendingNarration(settings, 'chat-A')?.kind).toBe('lewd');

        const block = buildLewdNarrationBlock(settings, 'chat-A');
        expect(block).toContain('[LEWD_COMBAT_CONTEXT]');
        expect(block).not.toContain('[TACTICAL_COMBAT_CONTEXT]');
        expect(block).toContain('Stamina');
        expect(block).toMatch(/surrendered to/i);

        // The module never rewrote the memo or invented HP/Willpower state.
        expect(settings.currentMemo).toBe(memoBefore);
        expect(state).not.toHaveProperty('units');
        expect(state).not.toHaveProperty('hp');

        // The queued handoff is one-shot.
        expect(getPendingNarration(settings, 'chat-A')).not.toBeNull();
        clearPendingNarration(settings, { chatId: 'chat-A', persist: false });
        expect(getPendingNarration(settings, 'chat-A')).toBeNull();
        expect(buildLewdNarrationBlock(settings, 'chat-A')).toBe('');

        removeLewdEncounterForChat('chat-A', settings, { persist: false });
        expect(getLewdEncounterForChat('chat-A', settings)).toBeNull();
    });

    it('applies a trait-modified drain exactly once and keeps Stamina above zero per climax', () => {
        const settings = prepareSettings();
        const state = createState(settings);
        const bran = state.participants.find(participant => participant.id === 'bran');
        expect(bran.maxStamina).toBe(3);

        const withTrait = applyProfileTraits(
            profile('Bran', { traits: { drain: 1, stamina: 1 } }),
            { maxStamina: 3, drain: 0 },
        );
        expect(withTrait.drain).toBe(1);
        expect(withTrait.maxStamina).toBe(4);
        expect(state.participants.every(participant => participant.stamina <= participant.maxStamina)).toBe(true);
    });

    it('keeps the module inert when disabled', () => {
        const settings = buildDefaultSettings();
        expect(settings.lewdCombatEnabled).toBe(false);
        expect(settings.lewdCombatByChat).toEqual({});
        expect(getLewdEncounterForChat('chat-A', settings)).toBeNull();
    });
});
