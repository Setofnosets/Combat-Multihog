import { describe, expect, it } from 'vitest';
import {
    buildPairingMatrix,
    canEngageWith,
    engagementCount,
    expireEngagements,
    findEngagement,
    holdsOn,
    pairKey,
    releaseHold,
    upsertEngagement,
} from '../src/features/lewd-combat/lewd-combat-pairing.js';
import {
    applyStance,
    attemptEscape,
    isOverwhelmed,
    markOverwhelmed,
    normalizeStance,
    tickOverwhelmed,
    tickStance,
    expireStanceOnPostureChange,
} from '../src/features/lewd-combat/lewd-combat-states.js';
import {
    applyLewdAction,
    createLewdEncounterState,
} from '../src/features/lewd-combat/lewd-combat-engine.js';

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

function participant(id, name, side) {
    return { id, name, side, profile: profile(name) };
}

function board({ seed = 'pairing-seed', mode = 'group', settings = {}, extra = [] } = {}) {
    return createLewdEncounterState({
        seed,
        mode,
        settings,
        participants: [
            participant('aria', 'Aria', 'player'),
            participant('bran', 'Bran', 'opponent'),
            ...(mode === 'duel' ? [] : [participant('cora', 'Cora', 'opponent')]),
            ...extra,
        ],
    });
}

describe('engagement edges', () => {
    it('creates, refreshes, and expires edges deterministically', () => {
        const state = board();
        const edge = upsertEngagement(state, 'aria', 'bran', {
            hold: { id: 'grappled', label: 'Grappled', escapeDC: 12 },
        });
        expect(edge).toMatchObject({ a: 'aria', b: 'bran', sinceRound: 1, refreshedRound: 1, intensity: 1 });
        expect(findEngagement(state, 'bran', 'aria')).toBe(edge);
        expect(state.participants.find(p => p.id === 'aria').engagedWith).toEqual(['bran']);

        state.round = 2;
        upsertEngagement(state, 'aria', 'bran');
        expect(findEngagement(state, 'aria', 'bran').intensity).toBe(2);
        expect(expireEngagements(state, 2)).toHaveLength(0);

        state.round = 3;
        expect(expireEngagements(state, 3)).toHaveLength(0);
        state.round = 4;
        expect(expireEngagements(state, 4)).toHaveLength(1);
        expect(findEngagement(state, 'aria', 'bran')).toBeNull();
        expect(state.participants.find(p => p.id === 'bran').engagedWith).toEqual([]);
    });

    it('uses a stable undirected pair key and partner cap', () => {
        expect(pairKey('aria', 'bran')).toBe(pairKey('bran', 'aria'));
        const state = board({ settings: { lewdCombatMaxPartners: 1 } });
        upsertEngagement(state, 'aria', 'bran');
        expect(engagementCount(state, 'aria')).toBe(1);
        expect(canEngageWith(state, 'aria', 'bran')).toBe(true);
        expect(canEngageWith(state, 'aria', 'cora')).toBe(false);
        expect(canEngageWith(state, 'cora', 'aria')).toBe(false);
        // Bran is already at the cap too, so neither side may open a new edge.
        expect(canEngageWith(state, 'bran', 'cora')).toBe(false);
    });

    it('releases a hold without deleting the pairing', () => {
        const state = board();
        const hold = { id: 'grappled', label: 'Grappled', escapeDC: 12 };
        upsertEngagement(state, 'aria', 'bran', { hold });
        expect(holdsOn(state, 'bran')).toHaveLength(1);
        expect(releaseHold(state, 'aria', 'bran')).toBe(hold);
        expect(findEngagement(state, 'aria', 'bran')).toBeTruthy();
        expect(findEngagement(state, 'aria', 'bran').hold).toBeNull();
    });

    it('builds a pairing matrix that matches the engine edges', () => {
        const state = board();
        const hold = { id: 'grappled', label: 'Grappled', escapeDC: 12 };
        upsertEngagement(state, 'aria', 'bran', { hold });
        const matrix = buildPairingMatrix(state);
        expect(matrix.participants.map(p => p.id)).toEqual(['aria', 'bran', 'cora']);
        expect(matrix.cells).toHaveLength(3);
        const cell = matrix.cells.find(entry => pairKey(entry.a, entry.b) === pairKey('aria', 'bran'));
        expect(cell).toMatchObject({ engaged: true, hold, intensity: 1 });
        const empty = matrix.cells.find(entry => pairKey(entry.a, entry.b) === pairKey('aria', 'cora'));
        expect(empty.engaged).toBe(false);
    });
});

describe('stances and holds', () => {
    it('applies, replaces, and expires stances', () => {
        const state = board();
        const aria = state.participants.find(p => p.id === 'aria');
        expect(applyStance(aria, 'commanding', { round: state.round })).toMatchObject({
            id: 'commanding', poiseBonus: 2, roundsLeft: 3,
        });
        expect(applyStance(aria, { id: 'guarded', label: 'Guarded', poiseBonus: 2 }).id).toBe('guarded');
        expect(expireStanceOnPostureChange(aria, 'lead')).toBeNull();
        aria.lastPosture = 'switch';
        expect(expireStanceOnPostureChange(aria, 'lead')).toBeTruthy();
        expect(aria.stance).toBeNull();

        applyStance(aria, 'teasing');
        tickStance(aria);
        tickStance(aria);
        expect(aria.stance).not.toBeNull();
        tickStance(aria);
        expect(aria.stance).toBeNull();
    });

    it('normalizes unknown stances without inventing bonuses', () => {
        expect(normalizeStance('homebrew')).toMatchObject({ id: 'homebrew', poiseBonus: 0, roundsLeft: 3 });
    });

    it('resolves escape checks from an injected d20 and releases the hold on success', () => {
        const state = board();
        upsertEngagement(state, 'aria', 'bran', {
            hold: { id: 'grappled', label: 'Grappled', escapeDC: 12 },
        });
        const aria = state.participants.find(p => p.id === 'aria');
        const failed = attemptEscape(state, aria, 'bran', { roll: 3, poiseBonus: 2, escapeBonus: 1 });
        expect(failed).toMatchObject({ resolved: true, success: false, total: 6, dc: 12 });
        expect(findEngagement(state, 'aria', 'bran').hold).toBeTruthy();

        const succeeded = attemptEscape(state, aria, 'bran', { roll: 15, poiseBonus: 0, escapeBonus: 0 });
        expect(succeeded).toMatchObject({ resolved: true, success: true, total: 15, dc: 12 });
        expect(findEngagement(state, 'aria', 'bran').hold).toBeNull();
    });

    it('opens the overwhelmed window for one round and then refreshes half Poise', () => {
        const state = board();
        const aria = state.participants.find(p => p.id === 'aria');
        aria.poise = 1;
        markOverwhelmed(state, aria);
        expect(aria.overwhelmedUntilRound).toBe(2);
        expect(aria.stance).toBeNull();
        expect(isOverwhelmed(state, aria)).toBe(true);
        state.round = 2;
        expect(isOverwhelmed(state, aria)).toBe(true);
        state.round = 3;
        expect(tickOverwhelmed(state, aria)).toBe(true);
        expect(isOverwhelmed(state, aria)).toBe(false);
        expect(aria.poise).toBe(4);
    });
});

describe('engine integration', () => {
    it('supports an escape action for a held participant', () => {
        const state = board({ mode: 'duel' });
        const grip = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'firm-grip', targetIds: ['bran'], zone: 'waist', posture: 'lead',
        });
        expect(grip.ok).toBe(true);
        expect(findEngagement(state, 'aria', 'bran').hold).toBeTruthy();
        applyLewdAction(state, { type: 'wait', unitId: 'bran' });

        const escape = applyLewdAction(state, { type: 'escape', unitId: 'bran', targetIds: ['aria'] });
        expect(escape.ok).toBe(true);
        expect(escape.beat.type).toBe('escape');
        expect(escape.beat.hold.id).toBe('grappled');
        expect(typeof escape.beat.success).toBe('boolean');
        expect(findEngagement(state, 'aria', 'bran').hold === null).toBe(escape.beat.success);
    });

    it('rejects a new partner once maxPartners is reached', () => {
        const state = board({ settings: { lewdCombatMaxPartners: 1 } });
        const first = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
        });
        expect(first.ok).toBe(true);
        // Let Aria take another action without advancing the round: the partner
        // cap, not the one-action-per-round rule, must be the reason for the
        // rejection.
        state.participants.find(p => p.id === 'aria').acted = false;
        const second = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['cora'], zone: 'neck',
        });
        expect(second.ok).toBe(false);
        expect(second.reason).toContain('Partner limit reached');
    });

    it('applies recover techniques to the actor rather than damaging them', () => {
        const state = board({ mode: 'duel' });
        const aria = state.participants.find(p => p.id === 'aria');
        aria.arousal = 8;
        aria.poise = 2;
        const result = applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'steady-breath', posture: 'switch',
        });
        expect(result.ok).toBe(true);
        expect(aria.poise).toBeGreaterThan(2);
        expect(aria.arousal).toBeLessThan(8);
        expect(result.beat.targets[0].poiseDelta).toBeGreaterThan(0);
        expect(result.beat.targets[0].arousalDelta).toBeLessThan(0);
    });
});
