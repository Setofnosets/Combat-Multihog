import { describe, expect, it, vi } from 'vitest';

import {
    applyLewdAction,
    createLewdEncounterState,
    listLegalActions,
    resolveLewdOpponentTurn,
    stopLewdEncounter,
    surrenderParticipant,
} from '../src/features/lewd-combat/lewd-combat-engine.js';
import {
    generateLewdProse,
    buildLewdProsePrompt,
} from '../src/features/lewd-combat/lewd-combat-prose.js';
import { isBlockedByLimits } from '../src/features/lewd-combat/lewd-combat-profile.js';

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
    'marking-kiss': {
        id: 'marking-kiss',
        name: 'Marking Kiss',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'single',
        tags: ['marking'],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '3',
        poise: '0',
        ai: { priority: 5 },
    },
    'neck-kiss': {
        id: 'neck-kiss',
        name: 'Neck Kiss',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'single',
        tags: ['teasing'],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '3',
        poise: '0',
        ai: { priority: 1 },
    },
};

function buildState() {
    return createLewdEncounterState({
        id: 'lewd-consent-test',
        seed: 'lewd-consent-seed',
        mode: 'duel',
        settings: { lewdCombatExplicitness: 'explicit', lewdCombatDarkerThemes: false },
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
                profile: profile('Bran', { limits: ['marking'] }),
            },
        ],
    });
}

describe('Lewd Combat consent rails', () => {
    it('treats hard limits as blocking in the engine and in legal actions', () => {
        expect(isBlockedByLimits(profile('Aria', { limits: ['marking'] }), ['marking'])).toBe('marking');

        const state = buildState();
        const actions = listLegalActions(state, 'aria', { techniques: Object.values(TECHNIQUES) });
        const marking = actions.find(action => action.id === 'marking-kiss');
        const neck = actions.find(action => action.id === 'neck-kiss');
        expect(marking.disabled).toBe(true);
        expect(marking.reasons.join(' ')).toMatch(/No legal targets/);
        expect(marking.targets[0].reasons.join(' ')).toMatch(/Blocked by limit: marking/);
        expect(neck.disabled).toBe(false);

        const rejected = applyLewdAction(state, {
            type: 'technique',
            unitId: 'aria',
            techniqueId: 'marking-kiss',
            targetIds: ['bran'],
            zone: 'neck',
        }, { techniques: Object.values(TECHNIQUES) });
        expect(rejected.ok).toBe(false);
        expect(rejected.reason).toMatch(/Blocked by limit: marking/);
        // A rejected action must not mutate the board.
        expect(state.round).toBe(1);
        expect(state.log).toHaveLength(0);
    });

    it('rejects an AI action that targets a hard limit and falls back deterministically', () => {
        const state = buildState();
        const result = resolveLewdOpponentTurn(state, [{
            type: 'technique',
            unitId: 'bran',
            techniqueId: 'marking-kiss',
            targetIds: ['aria'],
            zone: 'neck',
        }], { techniques: Object.values(TECHNIQUES) });

        expect(result.ok).toBe(true);
        expect(result.beat.technique.id).toBe('neck-kiss');
        expect(state.actionLog.some(entry => entry.type === 'rejected-ai-action')).toBe(true);
        expect(result.beat.technique.id).not.toBe('marking-kiss');
    });

    it('ends immediately and neutrally on the safe word', () => {
        const state = buildState();
        const result = stopLewdEncounter(state);
        expect(result).toBe('stopped');
        expect(state.status).toBe('ended');
        expect(state.outcome).toBe('stopped');
        expect(state.stopped).toBe(true);
        expect(state.summary).toMatch(/safe word/i);
        expect(state.summary).not.toMatch(/winner/i);
    });

    it('treats surrender as a hard yield, not a posture', () => {
        const state = buildState();
        const participant = surrenderParticipant(state, 'bran');
        expect(participant.surrendered).toBe(true);
        expect(participant.atMercy).toBe(false);
        expect(state.status).toBe('ended');
        expect(state.outcome).toBe('surrendered');
    });

    it('suppresses the model prose pass entirely under fade-to-black', async () => {
        const state = buildState();
        state.round = 2;
        const beat = {
            round: 2,
            actor: { id: 'aria', name: 'Aria' },
            posture: 'lead',
            technique: { id: 'neck-kiss', name: 'Neck Kiss' },
            targets: [{ name: 'Bran', zone: 'neck', hit: true }],
            stateChanges: [],
        };
        const sendStateRequest = vi.fn();
        const result = await generateLewdProse(
            state,
            beat,
            { lewdCombatExplicitness: 'fade-to-black', lewdCombatProseFrequency: 'per-exchange' },
            { sendStateRequest },
        );

        expect(sendStateRequest).not.toHaveBeenCalled();
        expect(result.ok).toBe(true);
        expect(result.suppressed).toBe(true);
        expect(result.prose).toMatch(/fades to black/i);
    });

    it('keeps darker themes subordinate to declared limits in the prompt', () => {
        const state = buildState();
        const prompt = buildLewdProsePrompt(state, [], {
            lewdCombatExplicitness: 'explicit',
            lewdCombatDarkerThemes: true,
        });
        expect(prompt.user).toContain('Darker themes: on');
        expect(prompt.user).toContain('Hard limits: marking');
        expect(prompt.user).toContain('Never change state or invent numbers');
    });
});
