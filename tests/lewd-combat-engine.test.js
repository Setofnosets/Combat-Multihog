import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    applyLewdAction,
    canLewdParticipantAct,
    checkLewdEncounterEnd,
    climaxParticipant,
    createLewdEncounterState,
    hydrateLewdState,
    joinParticipant,
    LEWD_POSTURES,
    listLegalActions,
    resolveLewdOpponentTurn,
    rollLewdDice,
    serializeLewdState,
    setSpectator,
    stopLewdEncounter,
    surrenderParticipant,
} from '../src/features/lewd-combat/lewd-combat-engine.js';
import { upsertEngagement } from '../src/features/lewd-combat/lewd-combat-pairing.js';

afterEach(() => {
    vi.restoreAllMocks();
});

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
        arousal: '10',
        poise: '3',
        uses: { max: null },
    },
    'marathon-kiss': {
        id: 'marathon-kiss',
        name: 'Marathon Kiss',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'single',
        tags: ['teasing'],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '99',
        poise: '0',
    },
    'body-caress': {
        id: 'body-caress',
        name: 'Body Caress',
        category: 'technique',
        posture: 'either',
        zones: ['full_body'],
        targetMode: 'single',
        tags: [],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '10',
        poise: '0',
    },
    'wild-swing': {
        id: 'wild-swing',
        name: 'Wild Swing',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'single',
        tags: [],
        check: { stat: 'cha', accuracy: -100 },
        arousal: '10',
        poise: '3',
    },
    'firm-grip': {
        id: 'firm-grip',
        name: 'Firm Grip',
        category: 'hold',
        posture: 'lead',
        zones: ['waist'],
        targetMode: 'single',
        tags: ['dominance'],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '0',
        poise: '0',
        hold: { id: 'grappled', label: 'Grappled', poiseBonus: 2, dc: 12 },
    },
    'finish-hold': {
        id: 'finish-hold',
        name: 'Finish Hold',
        category: 'finisher',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'single',
        tags: [],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '99',
        poise: '0',
        staminaDrain: 2,
        requires: { hold: 'grappled' },
    },
    'normal-climax': {
        id: 'normal-climax',
        name: 'Normal Climax',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'single',
        tags: [],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '99',
        poise: '0',
    },
    'marking-kiss': {
        id: 'marking-kiss',
        name: 'Marking Kiss',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'single',
        tags: ['marking'],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '10',
        poise: '0',
    },
    'commanding-pose': {
        id: 'commanding-pose',
        name: 'Commanding Pose',
        category: 'stance',
        posture: 'either',
        zones: [],
        targetMode: 'self',
        tags: [],
        check: { stat: 'cha', accuracy: 0 },
        arousal: '0',
        poise: '0',
        applies: { stance: { id: 'commanding', label: 'Commanding', poiseBonus: 2 } },
    },
    'flushed-kiss': {
        id: 'flushed-kiss',
        name: 'Flushed Kiss',
        category: 'tease',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'single',
        tags: [],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '1',
        poise: '0',
        applies: { status: { label: 'Flushed', rounds: 1, arousalBonus: 1 } },
    },
    'pair-embrace': {
        id: 'pair-embrace',
        name: 'Pair Embrace',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'pair',
        tags: [],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '5',
        poise: '0',
    },
    'group-tease': {
        id: 'group-tease',
        name: 'Group Tease',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'group',
        tags: [],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '5',
        poise: '0',
    },
    'aura-tease': {
        id: 'aura-tease',
        name: 'Aura Tease',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'aura',
        tags: [],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '5',
        poise: '0',
    },
};

function fixture({
    seed = 'lewd-test-seed',
    settings = {},
    aria = {},
    bran = {},
    mode = 'duel',
    extra = [],
} = {}) {
    const { participant: ariaParticipant, ...ariaOverrides } = aria;
    const { participant: branParticipant, ...branOverrides } = bran;
    return createLewdEncounterState({
        seed,
        settings,
        mode,
        participants: [
            {
                id: 'aria',
                name: 'Aria',
                side: 'player',
                profile: profile('Aria', { maxStamina: 4, maxArousal: 20, maxPoise: 8, ...ariaOverrides }),
                ...(ariaParticipant || {}),
            },
            {
                id: 'bran',
                name: 'Bran',
                side: 'opponent',
                profile: profile('Bran', { maxStamina: 3, maxArousal: 30, maxPoise: 8, ...branOverrides }),
                ...(branParticipant || {}),
            },
            ...extra,
        ],
    });
}

function act(state, action, techniques = TECHNIQUES) {
    return applyLewdAction(state, action, { techniques });
}

describe('deterministic encounter setup', () => {
    it('normalizes participants, starts pools full, and rolls initiative from the seed', () => {
        const first = fixture();
        const second = fixture();

        expect(first.status).toBe('active');
        expect(first.round).toBe(1);
        expect(first.roundCap).toBe(12);
        expect(first.log).toEqual([]);
        expect(first.seed).toBe('lewd-test-seed');
        expect(first.rollCount).toBeGreaterThan(0);

        const aria = first.participants.find(p => p.id === 'aria');
        expect(aria.maxStamina).toBe(4);
        expect(aria.stamina).toBe(4);
        expect(aria.arousal).toBe(0);
        expect(aria.poise).toBe(8);
        expect(aria.spectator).toBe(false);

        expect(first.participants.map(p => p.id)).toEqual(second.participants.map(p => p.id));
        expect(first.participants.map(p => p.initiative)).toEqual(second.participants.map(p => p.initiative));
        expect(first.rngState).toBe(second.rngState);
    });

    it('uses settings for the round cap and supports group/spectator participants', () => {
        const state = fixture({
            settings: { lewdCombatRoundCap: 3, lewdCombatMaxPartners: 4 },
            mode: 'group',
            extra: [{ id: 'cora', name: 'Cora', side: 'opponent', spectator: true }],
        });
        expect(state.roundCap).toBe(3);
        expect(state.maxPartners).toBe(4);
        const cora = state.participants.find(p => p.id === 'cora');
        expect(cora.spectator).toBe(true);
        expect(cora.initiative).toBe(0);
    });

    it('never uses Math.random', () => {
        vi.spyOn(Math, 'random').mockImplementation(() => {
            throw new Error('Math.random must not be used');
        });
        const state = fixture({ seed: 'no-random' });
        const result = act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
        });
        expect(result.ok).toBe(true);
    });
});

describe('action resolution', () => {
    it('resolves a hit with arousal, poise, engagement, and one log beat', () => {
        const state = fixture();
        const result = act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck', posture: 'switch',
        });

        expect(result.ok).toBe(true);
        const beat = result.beat;
        expect(beat.round).toBe(1);
        expect(beat.actor.name).toBe('Aria');
        expect(beat.posture).toBe('switch');
        expect(beat.targets).toHaveLength(1);
        expect(beat.targets[0]).toMatchObject({
            name: 'Bran', zone: 'neck', hit: true, defense: 8, arousalDelta: 13, poiseDelta: -3,
        });
        expect(beat.targets[0].check).toBeGreaterThanOrEqual(beat.targets[0].defense);

        const bran = state.participants.find(p => p.id === 'bran');
        expect(bran.arousal).toBe(13);
        expect(bran.poise).toBe(5);
        expect(state.engagements).toHaveLength(1);
        expect(state.engagements[0]).toMatchObject({ a: 'aria', b: 'bran' });
        expect(state.log).toHaveLength(1);
        expect(state.log[0]).toEqual(beat);
        expect(state.actionLog.at(-1)).toMatchObject({
            unitId: 'aria', type: 'technique', techniqueId: 'neck-kiss', targetIds: ['bran'], posture: 'switch',
        });
    });

    it('misses without arousal or engagement and leaves state pools alone', () => {
        const state = fixture();
        const result = act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'wild-swing', targetIds: ['bran'], zone: 'neck',
        });

        expect(result.ok).toBe(true);
        expect(result.beat.targets[0].hit).toBe(false);
        expect(result.beat.targets[0].arousalDelta).toBe(0);
        const bran = state.participants.find(p => p.id === 'bran');
        expect(bran.arousal).toBe(0);
        expect(state.engagements).toHaveLength(0);
    });

    it('applies posture accuracy/arousal modifiers and poise regen', () => {
        const lead = fixture();
        const follow = fixture();
        const leadResult = act(lead, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck', posture: 'lead',
        });
        const followResult = act(follow, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck', posture: 'follow',
        });

        expect(LEWD_POSTURES.lead).toMatchObject({ accuracy: 2, arousal: 1, poiseDefense: -2, poiseRegen: 0 });
        expect(LEWD_POSTURES.follow).toMatchObject({ accuracy: -1, arousal: -1, poiseDefense: 2, poiseRegen: 2 });
        expect(leadResult.beat.targets[0].accuracy - followResult.beat.targets[0].accuracy).toBe(3);
        expect(leadResult.beat.targets[0].arousalDelta).toBeGreaterThan(followResult.beat.targets[0].arousalDelta);

        const leadRegen = fixture();
        const followRegen = fixture();
        leadRegen.participants.find(p => p.id === 'aria').poise = 5;
        followRegen.participants.find(p => p.id === 'aria').poise = 5;
        act(leadRegen, {
            type: 'technique', unitId: 'aria', techniqueId: 'body-caress', targetIds: ['bran'], zone: 'full_body', posture: 'lead',
        });
        act(followRegen, {
            type: 'technique', unitId: 'aria', techniqueId: 'body-caress', targetIds: ['bran'], zone: 'full_body', posture: 'follow',
        });
        expect(leadRegen.participants.find(p => p.id === 'aria').poise).toBe(5);
        expect(followRegen.participants.find(p => p.id === 'aria').poise).toBe(7);
    });

    it('multiplies by zone sensitivity and like/dislike preferences', () => {
        const neck = fixture();
        const body = fixture();
        const neckResult = act(neck, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
        });
        const bodyResult = act(body, {
            type: 'technique', unitId: 'aria', techniqueId: 'body-caress', targetIds: ['bran'], zone: 'full_body',
        });
        expect(neckResult.beat.targets[0].arousalDelta).toBe(13); // 10 × neck 1.3
        expect(bodyResult.beat.targets[0].arousalDelta).toBe(10); // 10 × full_body 1.0

        const likes = fixture({ bran: { preference: { teasing: 'like' } } });
        const dislikes = fixture({ bran: { preference: { teasing: 'dislike' } } });
        const liked = act(likes, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
        });
        const disliked = act(dislikes, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
        });
        expect(liked.beat.targets[0].arousalDelta).toBe(16); // 10 × 1.25 × 1.3
        expect(disliked.beat.targets[0].arousalDelta).toBe(7); // 10 × 0.5 × 1.3, rounded
    });

    it('rejects actions blocked by a hard limit', () => {
        const state = fixture({ bran: { limits: ['marking'] } });
        const result = act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'marking-kiss', targetIds: ['bran'], zone: 'neck',
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Blocked by limit: marking');
        expect(state.log).toHaveLength(0);
        expect(state.participants.find(p => p.id === 'bran').arousal).toBe(0);
    });

    it('enforces hold requirements and unlocks hold-only finishers', () => {
        const locked = fixture();
        const lockedResult = act(locked, {
            type: 'technique', unitId: 'aria', techniqueId: 'finish-hold', targetIds: ['bran'], zone: 'neck',
        });
        expect(lockedResult.ok).toBe(false);
        expect(lockedResult.reason).toContain('Requires a hold');

        const state = fixture();
        const hold = act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'firm-grip', targetIds: ['bran'], zone: 'waist', posture: 'lead',
        });
        expect(hold.ok).toBe(true);
        expect(state.engagements[0].hold.id).toBe('grappled');

        // One action per round: let Bran's turn pass (round 2) before Aria acts again.
        expect(act(state, { type: 'wait', unitId: 'bran' }).ok).toBe(true);
        expect(state.round).toBe(2);
        const finish = act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'finish-hold', targetIds: ['bran'], zone: 'neck',
        });
        expect(finish.ok).toBe(true);
        expect(finish.beat.targets[0].climaxed).toBe(true);
        expect(finish.beat.targets[0].staminaDelta).toBe(-2);
    });

    it('applies self stances without a target roll', () => {
        const state = fixture();
        const result = act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'commanding-pose', posture: 'switch',
        });
        expect(result.ok).toBe(true);
        const aria = state.participants.find(p => p.id === 'aria');
        expect(aria.stance).toMatchObject({ id: 'commanding', poiseBonus: 2 });
    });

    it('is deterministic for the same state, action, and seed', () => {
        const run = () => {
            const state = fixture();
            act(state, {
                type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
            });
            return serializeLewdState(state);
        };
        expect(run()).toEqual(run());
    });

    it('allows only one action per participant per round', () => {
        const state = fixture();
        expect(act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
        }).ok).toBe(true);
        const second = act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
        });
        expect(second.ok).toBe(false);
        expect(second.reason).toContain('already acted');
        expect(state.log).toHaveLength(1);
    });

    it('keeps a one-round status through the following round', () => {
        const state = fixture();
        expect(act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'flushed-kiss', targetIds: ['bran'], zone: 'neck',
        }).ok).toBe(true);
        const bran = state.participants.find(p => p.id === 'bran');
        expect(bran.status.some(status => status.id === 'flushed')).toBe(true);

        expect(act(state, { type: 'wait', unitId: 'bran' }).ok).toBe(true); // round 2
        expect(state.round).toBe(2);
        expect(bran.status.some(status => status.id === 'flushed')).toBe(true);

        expect(act(state, { type: 'wait', unitId: 'aria' }).ok).toBe(true);
        expect(act(state, { type: 'wait', unitId: 'bran' }).ok).toBe(true); // round 3
        expect(state.round).toBe(3);
        expect(bran.status.some(status => status.id === 'flushed')).toBe(false);
    });

    it('resolves pair, group, and aura target modes', () => {
        const pair = fixture();
        const pairResult = act(pair, {
            type: 'technique', unitId: 'aria', techniqueId: 'pair-embrace', targetIds: ['bran'], zone: 'neck',
        });
        expect(pairResult.ok).toBe(true);
        expect(pairResult.beat.targets.map(target => target.name).sort()).toEqual(['Aria', 'Bran']);
        expect(pair.participants.find(p => p.id === 'aria').arousal).toBeGreaterThan(0);
        expect(pair.participants.find(p => p.id === 'bran').arousal).toBeGreaterThan(0);

        const group = fixture({
            mode: 'group',
            extra: [{ id: 'cora', name: 'Cora', side: 'opponent', profile: profile('Cora') }],
        });
        const groupResult = act(group, {
            type: 'technique', unitId: 'aria', techniqueId: 'group-tease', zone: 'neck',
        });
        expect(groupResult.ok).toBe(true);
        expect(groupResult.beat.targets.map(target => target.name).sort()).toEqual(['Bran', 'Cora']);

        const aura = fixture();
        expect(act(aura, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
        }).ok).toBe(true);
        expect(act(aura, { type: 'wait', unitId: 'bran' }).ok).toBe(true);
        const auraResult = act(aura, {
            type: 'technique', unitId: 'aria', techniqueId: 'aura-tease', zone: 'neck',
        });
        expect(auraResult.ok).toBe(true);
        expect(auraResult.beat.targets.map(target => target.name)).toEqual(['Bran']);
    });
});

describe('pair-level act and bindings state', () => {
    const pairState = state => state.engagements.find(edge => pairKeyOf(edge) === 'aria|bran');
    const pairKeyOf = edge => [edge.a, edge.b].sort().join('|');
    const allowAnotherAction = state => {
        state.participants.find(participant => participant.id === 'aria').acted = false;
    };

    it('starts, raises (clamped), lowers, and clears a penetration act', () => {
        const state = fixture({ aria: { anatomy: ['penis'] }, bran: { anatomy: ['vagina'] } });
        const bran = state.participants.find(participant => participant.id === 'bran');
        bran.poise = 0;
        bran.maxArousal = 100;
        bran.arousal = 0;
        const start = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'penetration-start', targetIds: ['bran'], zone: 'genitals', posture: 'lead',
        });
        expect(start.ok).toBe(true);
        const edge = pairState(state);
        expect(edge).toMatchObject({
            act: 'penetration', actType: 'penetration', actRole: 'give', actIntensity: 1, actStartedRound: 1,
        });
        expect(start.beat.targets[0].pair).toMatchObject({ act: 'penetration', actIntensity: 1 });
        expect(start.beat.stateChanges.join(' ')).toContain('penetration intensity 1');

        allowAnotherAction(state);
        const harder = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'thrust-harder', targetIds: ['bran'], zone: 'genitals', posture: 'lead',
        });
        expect(harder.ok).toBe(true);
        expect(pairState(state).actIntensity).toBe(2);

        pairState(state).actIntensity = 5;
        allowAnotherAction(state);
        expect(applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'thrust-harder', targetIds: ['bran'], zone: 'genitals', posture: 'lead',
        }).ok).toBe(true);
        expect(pairState(state).actIntensity).toBe(5);

        allowAnotherAction(state);
        const slower = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'slow-down', targetIds: ['bran'], zone: 'genitals', posture: 'lead',
        });
        expect(slower.ok).toBe(true);
        expect(pairState(state).actIntensity).toBe(4);

        allowAnotherAction(state);
        const withdraw = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'withdraw', targetIds: ['bran'], zone: 'genitals', posture: 'lead',
        });
        expect(withdraw.ok).toBe(true);
        expect(pairState(state).act).toBeNull();
        expect(pairState(state).actIntensity).toBe(0);
    });

    it('raises and clears bindings and gates tease-bound on them', () => {
        const state = fixture({ aria: { anatomy: ['bondage-gear'], skills: ['bondage'] } });
        const bran = state.participants.find(participant => participant.id === 'bran');
        bran.poise = 0;
        bran.maxArousal = 100;
        bran.arousal = 0;
        const teaseAtZero = listLegalActions(state, 'aria').find(entry => entry.id === 'tease-bound');
        expect(teaseAtZero.disabled).toBe(true);
        expect(teaseAtZero.targets[0].reasons.join(' ')).toContain('Requires bindings 1.');

        const tie = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'tie-bindings', targetIds: ['bran'], zone: 'hands', posture: 'lead',
        });
        expect(tie.ok).toBe(true);
        expect(pairState(state)).toMatchObject({
            act: 'bondage', actIntensity: 1, bindings: 1, bindingsStartedRound: 1,
        });
        allowAnotherAction(state);
        expect(listLegalActions(state, 'aria').find(entry => entry.id === 'tease-bound').disabled).toBe(false);

        allowAnotherAction(state);
        const tighten = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'tighten-bindings', targetIds: ['bran'], zone: 'hands', posture: 'lead',
        });
        expect(tighten.ok).toBe(true);
        expect(pairState(state).bindings).toBe(2);
        expect(pairState(state).actIntensity).toBe(1);

        allowAnotherAction(state);
        const release = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'release-bindings', targetIds: ['bran'], zone: 'hands',
        });
        expect(release.ok).toBe(true);
        expect(pairState(state).act).toBeNull();
        expect(pairState(state).bindings).toBe(0);
        expect(pairState(state).bindingsStartedRound).toBe(0);
    });

    it('writes a pair stance to the edge and both participants', () => {
        const state = fixture({ aria: { anatomy: ['penis'] }, bran: { anatomy: ['vagina'] } });
        const bran = state.participants.find(participant => participant.id === 'bran');
        bran.poise = 0;
        bran.maxArousal = 100;
        bran.arousal = 0;
        expect(applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'penetration-start', targetIds: ['bran'], zone: 'genitals', posture: 'lead',
        }).ok).toBe(true);

        allowAnotherAction(state);
        const positioned = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'change-position', targetIds: ['bran'], zone: 'genitals',
        });
        expect(positioned.ok).toBe(true);
        const edge = pairState(state);
        expect(edge.pairStance).toMatchObject({ id: 'entwined', label: 'Entwined' });
        expect(edge.stance).toBe(edge.pairStance);
        expect(state.participants.find(participant => participant.id === 'aria').stance).toMatchObject({ id: 'entwined' });
        expect(state.participants.find(participant => participant.id === 'bran').stance).toMatchObject({ id: 'entwined' });
        expect(positioned.beat.targets[0].pair.pairStance).toMatchObject({ id: 'entwined' });
    });

    it("scopes applies.stance.target='target' to the target only", () => {
        const targetStance = {
            id: 'guarded-touch', name: 'Guarded Touch', category: 'technique', posture: 'either',
            zones: ['neck'], targetMode: 'single',
            check: { stat: 'cha', accuracy: 100 }, arousal: '0', poise: '0',
            applies: { stance: { id: 'guarded', label: 'Guarded', target: 'target' } },
        };
        const state = fixture();
        const result = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'guarded-touch', targetIds: ['bran'], zone: 'neck',
        }, { techniques: [targetStance] });
        expect(result.ok).toBe(true);
        expect(state.participants.find(participant => participant.id === 'bran').stance).toMatchObject({ id: 'guarded' });
        expect(state.participants.find(participant => participant.id === 'aria').stance).toBeNull();
    });

    it('leaves other pairs untouched and never mutates pair state on a miss', () => {
        const state = fixture({
            mode: 'group',
            aria: { anatomy: ['penis'] },
            bran: { anatomy: ['vagina'] },
            extra: [{ id: 'cora', name: 'Cora', side: 'opponent', profile: profile('Cora') }],
        });
        const bran = state.participants.find(participant => participant.id === 'bran');
        bran.poise = 0;
        bran.maxArousal = 100;
        bran.arousal = 0;
        upsertEngagement(state, 'aria', 'bran', {
            act: { id: 'penetration', type: 'penetration', role: 'give' }, actIntensity: 1, actStartedRound: 1,
        });
        const coraEdge = upsertEngagement(state, 'aria', 'cora', {
            act: { id: 'oral', type: 'oral' }, actIntensity: 2, actStartedRound: 1, bindings: 1,
        });
        const coraBefore = JSON.stringify(coraEdge);

        const result = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'change-position', targetIds: ['bran'], zone: 'genitals',
        });
        expect(result.ok).toBe(true);
        expect(JSON.stringify(coraEdge)).toBe(coraBefore);

        const missTechnique = {
            id: 'miss-pair', name: 'Miss Pair', category: 'technique', posture: 'either',
            zones: ['genitals'], targetMode: 'single',
            check: { stat: 'cha', accuracy: -100 }, arousal: '0', poise: '0',
            applies: { act: { id: 'penetration', intensity: 5 }, bindingsDelta: 2 },
        };
        const before = JSON.stringify(pairState(state));
        state.participants.find(participant => participant.id === 'aria').acted = false;
        const miss = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'miss-pair', targetIds: ['bran'], zone: 'genitals',
        }, { techniques: [missTechnique] });
        expect(miss.ok).toBe(true);
        expect(miss.beat.targets[0].hit).toBe(false);
        expect(JSON.stringify(pairState(state))).toBe(before);
    });
});

describe('capability gating', () => {
    const anatomyTechnique = {
        id: 'penis-gate',
        name: 'Penis Gate',
        category: 'technique',
        posture: 'either',
        zones: ['genitals'],
        targetMode: 'single',
        tags: [],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '5',
        poise: '0',
        requires: { anatomy: { all: [], any: ['penis'] } },
    };
    const receptiveTechnique = {
        ...anatomyTechnique,
        id: 'receptive-gate',
        name: 'Receptive Gate',
        requires: { targetAnatomy: { all: [], any: ['penis'] } },
    };
    const combinedTechnique = {
        ...anatomyTechnique,
        id: 'combined-gate',
        requires: { anatomy: { all: [], any: ['penis'] }, targetAnatomy: { all: [], any: ['vagina'] } },
    };

    it('rejects an anatomy-gated technique for an actor without anatomy', () => {
        const state = fixture();
        const before = JSON.stringify(state);
        const result = act(state, {
            type: 'technique',
            unitId: 'aria',
            techniqueId: 'penis-gate',
            targetIds: ['bran'],
            zone: 'genitals',
        }, [anatomyTechnique]);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Set anatomy in [LEWD]');
        expect(JSON.stringify(state)).toBe(before);
    });

    it('rejects a receptive action whose only target lacks the anatomy', () => {
        const state = fixture();
        const before = JSON.stringify(state);
        const result = act(state, {
            type: 'technique',
            unitId: 'aria',
            techniqueId: 'receptive-gate',
            targetIds: ['bran'],
            zone: 'genitals',
        }, [receptiveTechnique]);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Set anatomy in [LEWD]');
        expect(JSON.stringify(state)).toBe(before);
    });

    it('succeeds with a direct technique object when both anatomies are present', () => {
        const state = fixture({ aria: { anatomy: ['penis'] }, bran: { anatomy: ['vagina'] } });
        const result = act(state, {
            type: 'technique',
            unitId: 'aria',
            technique: combinedTechnique,
            targetIds: ['bran'],
            zone: 'genitals',
        }, [combinedTechnique]);
        expect(result.ok).toBe(true);
        expect(result.beat.targets.map(target => target.name)).toContain('Bran');
    });

    it('falls back deterministically when an AI action fails capability gating', () => {
        const state = fixture();
        const result = resolveLewdOpponentTurn(state, [{
            unitId: 'bran',
            type: 'technique',
            techniqueId: 'penetration-start',
            targetIds: ['aria'],
        }]);
        expect(result.ok).toBe(true);
        expect(state.actionLog.some(entry =>
            entry.type === 'rejected-ai-action'
            && String(entry.reason).includes('Set anatomy in [LEWD]'))).toBe(true);
    });

    it('still resolves a neutral technique for an actor with no anatomy', () => {
        const state = fixture();
        const result = act(state, {
            type: 'technique',
            unitId: 'aria',
            techniqueId: 'neck-kiss',
            targetIds: ['bran'],
            zone: 'neck',
        });
        expect(result.ok).toBe(true);
        expect(result.beat.technique.id).toBe('neck-kiss');
    });
});

describe('climaxes and stamina', () => {
    it('drains one stamina, resets arousal, and applies overstimulated', () => {
        const state = fixture();
        const bran = state.participants.find(p => p.id === 'bran');
        bran.arousal = 12;
        const result = climaxParticipant(state, bran);

        expect(result.cost).toBe(1);
        expect(bran.stamina).toBe(2);
        expect(bran.arousal).toBe(0);
        expect(bran.poise).toBe(6);
        expect(bran.status.some(status => status.id === 'overstimulated')).toBe(true);
        expect(bran.atMercy).toBe(false);
    });

    it('applies finisher cost, the drain trait, and never drops below one', () => {
        const finisherState = fixture();
        const bran = finisherState.participants.find(p => p.id === 'bran');
        bran.arousal = 12;
        const normal = climaxParticipant(finisherState, bran, { finisherExtra: 1 });
        expect(normal.cost).toBe(2);
        expect(bran.stamina).toBe(1);

        const drainState = fixture({ bran: { drain: -1 } });
        const drained = drainState.participants.find(p => p.id === 'bran');
        drained.arousal = 12;
        expect(climaxParticipant(drainState, drained, { finisherExtra: 1 }).cost).toBe(1);
        expect(drained.stamina).toBe(2);

        const overDrainedState = fixture({ bran: { drain: -5 } });
        const overDrained = overDrainedState.participants.find(p => p.id === 'bran');
        expect(climaxParticipant(overDrainedState, overDrained).cost).toBe(1);
    });

    it('reaches atMercy after enough climaxes and ends a duel', () => {
        const state = fixture();
        const bran = state.participants.find(p => p.id === 'bran');
        bran.arousal = 12;
        climaxParticipant(state, bran); // 3 → 2
        bran.arousal = 12;
        climaxParticipant(state, bran); // 2 → 1
        bran.arousal = 12;
        climaxParticipant(state, bran); // 1 → 0
        expect(bran.stamina).toBe(0);
        expect(bran.atMercy).toBe(true);
        expect(bran.active).toBe(false);

        expect(checkLewdEncounterEnd(state)).toBe('atMercy');
        expect(state.status).toBe('ended');
        expect(state.winnerIds).toEqual(['aria']);
        expect(state.summary).toContain('Aria');
    });

    it('triggers a climax from an action and records the stamina delta', () => {
        const state = fixture({ bran: { maxArousal: 8 } });
        const result = act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'marathon-kiss', targetIds: ['bran'], zone: 'neck',
        });
        expect(result.ok).toBe(true);
        expect(result.beat.targets[0].climaxed).toBe(true);
        expect(result.beat.targets[0].staminaDelta).toBe(-1);
        expect(result.beat.targets[0].status).toContain('Overstimulated (1 round)');
    });
});

describe('end conditions and membership', () => {
    it('stops immediately on a safe word with no winner', () => {
        const state = fixture();
        const result = act(state, { type: 'stop', unitId: 'aria' });
        expect(result.ok).toBe(true);
        expect(result.outcome).toBe('stopped');
        expect(state.status).toBe('ended');
        expect(state.outcome).toBe('stopped');
        expect(state.summary).toContain('stopped');
    });

    it('ends a duel on surrender and bars re-entry', () => {
        const state = fixture();
        surrenderParticipant(state, 'bran');

        const bran = state.participants.find(p => p.id === 'bran');
        expect(bran.surrendered).toBe(true);
        expect(bran.active).toBe(false);
        expect(state.outcome).toBe('surrendered');
        expect(state.winnerIds).toEqual(['aria']);

        expect(joinParticipant(state, { name: 'Bran', side: 'opponent' })).toEqual({
            ok: false,
            reason: 'A surrendered participant cannot re-enter this encounter.',
        });
        expect(setSpectator(state, 'bran', false)).toEqual({
            ok: false,
            reason: 'A surrendered participant cannot re-enter this encounter.',
        });
    });

    it('reaches a draw at the round cap', () => {
        const state = fixture({ settings: { lewdCombatRoundCap: 1 } });
        expect(act(state, { type: 'wait', unitId: 'aria' }).ok).toBe(true);
        const result = act(state, { type: 'wait', unitId: 'bran' });
        expect(result.ok).toBe(true);
        expect(result.outcome).toBe('draw');
        expect(state.round).toBe(2);
        expect(state.status).toBe('ended');
    });

    it('maps group elimination to sideVictory and a mutual duel to mutual', () => {
        const group = fixture({
            mode: 'group',
            extra: [{ id: 'cora', name: 'Cora', side: 'opponent', profile: profile('Cora') }],
        });
        for (const id of ['bran', 'cora']) {
            const participant = group.participants.find(p => p.id === id);
            participant.stamina = 0;
            participant.atMercy = true;
            participant.active = false;
        }
        expect(checkLewdEncounterEnd(group)).toBe('sideVictory');
        expect(group.winnerIds).toEqual(['aria']);

        const duel = fixture();
        for (const id of ['aria', 'bran']) {
            const participant = duel.participants.find(p => p.id === id);
            participant.stamina = 0;
            participant.atMercy = true;
            participant.active = false;
        }
        expect(checkLewdEncounterEnd(duel)).toBe('mutual');
    });

    it('rejects spectator actions and reports who may act', () => {
        const state = fixture({ extra: [{ id: 'cora', name: 'Cora', side: 'player', spectator: true }] });
        const result = act(state, { type: 'wait', unitId: 'cora' });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Spectators cannot act');
        expect(canLewdParticipantAct(state, 'aria')).toBe(true);
        expect(canLewdParticipantAct(state, 'cora')).toBe(false);
    });

    it('can move a participant to the spectator rail and back', () => {
        const state = fixture({ extra: [{ id: 'cora', name: 'Cora', side: 'player', spectator: true }] });
        const joined = setSpectator(state, 'cora', false);
        expect(joined.ok).toBe(true);
        expect(joined.participant.spectator).toBe(false);
        expect(setSpectator(state, 'cora', true).participant.spectator).toBe(true);
    });

    it('joins new participants and spectators', () => {
        const state = fixture();
        const joined = joinParticipant(state, {
            name: 'Cora',
            side: 'player',
            profile: profile('Cora', { maxStamina: 2 }),
        });
        expect(joined.ok).toBe(true);
        expect(joined.participant.acted).toBe(true);
        expect(state.participants.find(p => p.id === 'cora')).toBeTruthy();
    });
});

describe('opponent turn resolution', () => {
    it('applies a valid provided AI action and records it', () => {
        const state = fixture();
        const result = resolveLewdOpponentTurn(state, [{
            unitId: 'bran',
            type: 'technique',
            techniqueId: 'neck-kiss',
            targetIds: ['aria'],
            zone: 'neck',
            posture: 'switch',
        }], { techniques: TECHNIQUES });

        expect(result.ok).toBe(true);
        expect(result.beat.actor.name).toBe('Bran');
        expect(state.actionLog.at(-1)).toMatchObject({ unitId: 'bran', source: 'ai' });
    });

    it('falls back to the deterministic local policy for an illegal AI action', () => {
        const state = fixture();
        const result = resolveLewdOpponentTurn(state, [{
            unitId: 'bran',
            type: 'technique',
            techniqueId: 'does-not-exist',
            targetIds: ['aria'],
        }], { techniques: TECHNIQUES });

        expect(result.ok).toBe(true);
        expect(state.actionLog.some(entry => entry.type === 'rejected-ai-action')).toBe(true);
        expect(state.actionLog.at(-1).source).toBe('ai');
        expect(state.log.length).toBeGreaterThan(0);
    });

    it('never selects a technique blocked by the target hard limit', () => {
        const state = fixture({ aria: { limits: ['teasing', 'marking'] } });
        resolveLewdOpponentTurn(state, [], { techniques: TECHNIQUES });
        const last = state.actionLog.at(-1);
        expect(['wait', 'technique']).toContain(last.type);
        if (last.type === 'technique') {
            // Both techniques would hit Aria's hard limits; a legal action or a
            // wait is acceptable, a blocked technique is not.
            expect(['neck-kiss', 'marking-kiss']).not.toContain(last.techniqueId);
        }
    });

    it('uses only the seeded RNG in the local fallback', () => {
        vi.spyOn(Math, 'random').mockImplementation(() => {
            throw new Error('Math.random must not be used');
        });
        const state = fixture();
        const result = resolveLewdOpponentTurn(state, [], { techniques: TECHNIQUES });
        expect(result.ok).toBe(true);
    });
});

describe('participant control', () => {
    it('honours an explicit control and mirrors it into the legacy ai flag', () => {
        const state = createLewdEncounterState({
            seed: 'control-seed',
            participants: [
                { id: 'aria', name: 'Aria', side: 'player', control: 'ai', profile: profile('Aria') },
                { id: 'bran', name: 'Bran', side: 'enemy', control: 'player', profile: profile('Bran') },
            ],
        });

        const aria = state.participants.find(participant => participant.id === 'aria');
        const bran = state.participants.find(participant => participant.id === 'bran');
        expect(aria.control).toBe('ai');
        expect(aria.ai).toBe(true);
        expect(bran.control).toBe('player');
        expect(bran.ai).toBe(false);
    });

    it('derives the default from side under auto and lets player-all override it', () => {
        const participants = [
            { id: 'aria', name: 'Aria', side: 'player', profile: profile('Aria') },
            { id: 'goblin', name: 'Goblin', side: 'enemy', profile: profile('Goblin') },
        ];

        const auto = createLewdEncounterState({ seed: 'control-auto', participants });
        expect(auto.controlMode).toBe('auto');
        expect(auto.participants.find(p => p.id === 'aria').control).toBe('player');
        expect(auto.participants.find(p => p.id === 'goblin').control).toBe('ai');

        const playerAll = createLewdEncounterState({
            seed: 'control-all',
            controlMode: 'player-all',
            participants,
        });
        expect(playerAll.controlMode).toBe('player-all');
        expect(playerAll.participants.every(participant => participant.control === 'player')).toBe(true);
        expect(playerAll.participants.every(participant => participant.ai === false)).toBe(true);

        // Unknown/missing mode falls back to auto rather than throwing.
        const garbage = createLewdEncounterState({ seed: 'control-garbage', controlMode: 'nonsense', participants });
        expect(garbage.controlMode).toBe('auto');
    });

    it('lets joinParticipant take an explicit control and honour the board mode', () => {
        const state = fixture();
        const explicit = joinParticipant(state, {
            name: 'Cora',
            side: 'player',
            control: 'ai',
            profile: profile('Cora', { maxStamina: 2 }),
        });
        expect(explicit.ok).toBe(true);
        expect(explicit.participant.control).toBe('ai');
        expect(explicit.participant.ai).toBe(true);

        const derived = joinParticipant(state, {
            name: 'Dax',
            side: 'enemy',
            profile: profile('Dax', { maxStamina: 2 }),
        });
        expect(derived.participant.control).toBe('ai');
        expect(derived.participant.ai).toBe(true);
    });

    it('refuses to run an AI turn for a player-controlled participant', () => {
        const state = fixture({
            bran: { participant: { control: 'player' } },
        });
        const bran = state.participants.find(participant => participant.id === 'bran');
        expect(bran.control).toBe('player');
        expect(bran.ai).toBe(false);

        const result = resolveLewdOpponentTurn(state, [{
            unitId: 'bran',
            type: 'technique',
            techniqueId: 'neck-kiss',
            targetIds: ['aria'],
            zone: 'neck',
        }], { techniques: TECHNIQUES });

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/no opponent/i);
        expect(state.actionLog).toHaveLength(0);
        expect(state.log).toHaveLength(0);

        // Making the same participant AI-controlled restores the AI turn.
        const aiState = fixture({ bran: { participant: { control: 'ai' } } });
        const aiResult = resolveLewdOpponentTurn(aiState, [], { techniques: TECHNIQUES });
        expect(aiResult.ok).toBe(true);
        expect(aiState.actionLog.at(-1).source).toBe('ai');
    });

    it('preserves control on hydrate and backfills a legacy ai-only board', () => {
        const state = fixture();
        const hydrated = hydrateLewdState(serializeLewdState(state));
        expect(hydrated.controlMode).toBe('auto');
        expect(hydrated.participants.find(p => p.id === 'aria').control).toBe('player');
        expect(hydrated.participants.find(p => p.id === 'bran').control).toBe('ai');

        // A pre-control board carries only `ai`; hydrate must mirror it.
        const legacy = serializeLewdState(state);
        legacy.controlMode = undefined;
        for (const participant of legacy.participants) delete participant.control;
        legacy.participants.find(p => p.id === 'aria').ai = false;
        legacy.participants.find(p => p.id === 'bran').ai = true;
        const restored = hydrateLewdState(legacy);
        expect(restored.controlMode).toBe('auto');
        expect(restored.participants.find(p => p.id === 'aria').control).toBe('player');
        expect(restored.participants.find(p => p.id === 'bran').control).toBe('ai');
        expect(restored.participants.find(p => p.id === 'bran').ai).toBe(true);
    });
});

describe('storage', () => {
    it('round-trips seed, roll count, profiles, holds, stances, and logs', () => {
        const state = fixture();
        act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'firm-grip', targetIds: ['bran'], zone: 'waist', posture: 'lead',
        });
        const saved = serializeLewdState(state);
        const hydrated = hydrateLewdState(saved);

        expect(hydrated.seed).toBe(state.seed);
        expect(hydrated.rollCount).toBe(state.rollCount);
        expect(hydrated.round).toBe(state.round);
        expect(hydrated.participants[0].profile).toEqual(state.participants[0].profile);
        expect(hydrated.engagements[0].hold.id).toBe('grappled');
        expect(hydrated.actionLog).toEqual(state.actionLog);
        expect(hydrated.log).toEqual(state.log);
    });

    it('continues the same RNG stream after hydration', () => {
        const original = fixture();
        act(original, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
        });
        const hydrated = hydrateLewdState(serializeLewdState(original));

        const action = {
            type: 'technique', unitId: 'bran', techniqueId: 'neck-kiss', targetIds: ['aria'], zone: 'neck',
        };
        act(original, action);
        act(hydrated, action);
        expect(serializeLewdState(hydrated)).toEqual(serializeLewdState(original));
    });

    it('reconstructs RNG state from seed and rollCount when it is missing', () => {
        const state = fixture();
        act(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
        });
        const saved = serializeLewdState(state);
        delete saved.rngState;
        const hydrated = hydrateLewdState(saved);

        const originalNext = applyLewdAction(state, {
            type: 'wait', unitId: 'bran',
        });
        const hydratedNext = applyLewdAction(hydrated, {
            type: 'wait', unitId: 'bran',
        });
        expect(hydratedNext).toEqual(originalNext);
    });

    it('rejects invalid stored boards', () => {
        expect(hydrateLewdState(null)).toBeNull();
        expect(hydrateLewdState([])).toBeNull();
        expect(hydrateLewdState('nope')).toBeNull();
    });

    it('preserves an ended board and its outcome', () => {
        const state = fixture();
        stopLewdEncounter(state);
        const hydrated = hydrateLewdState(serializeLewdState(state));
        expect(hydrated.status).toBe('ended');
        expect(hydrated.outcome).toBe('stopped');
        expect(hydrated.stopped).toBe(true);
        expect(hydrated.endedRound).toBe(state.endedRound);
    });
});

describe('dice helper', () => {
    it('rolls deterministically and parses flat numbers', () => {
        const first = fixture();
        const second = fixture();
        expect(rollLewdDice(first, '2d6+1')).toEqual(rollLewdDice(second, '2d6+1'));
        expect(rollLewdDice(first, '5')).toEqual({ total: 5, rolls: [] });
        expect(rollLewdDice(first, 'garbage')).toEqual({ total: 0, rolls: [] });
    });
});
