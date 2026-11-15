import { describe, expect, it, vi } from 'vitest';
import {
    LEWD_TECHNIQUES,
    LEWD_TECHNIQUE_CATEGORIES,
    listLegalActions,
    validateLewdTechnique,
} from '../src/features/lewd-combat/lewd-combat-techniques.js';
import {
    applyLewdAction,
    chooseOpponentAction,
    createLewdEncounterState,
    resolveLewdOpponentTurn,
} from '../src/features/lewd-combat/lewd-combat-engine.js';
import { upsertEngagement } from '../src/features/lewd-combat/lewd-combat-pairing.js';
import { isBlockedByLimits } from '../src/features/lewd-combat/lewd-combat-profile.js';

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

function participant(id, name, side, profileOverrides = {}) {
    return {
        id,
        name,
        side,
        profile: profile(name, profileOverrides),
    };
}

function fixture({
    seed = 'technique-seed',
    mode = 'duel',
    speccy = false,
    aria = {},
    bran = {},
    extra = [],
    settings = {},
    techniques,
} = {}) {
    return createLewdEncounterState({
        seed,
        mode,
        settings,
        ...(techniques ? { techniques } : {}),
        participants: [
            participant('aria', 'Aria', 'player', aria),
            participant('bran', 'Bran', 'opponent', bran),
            ...(speccy ? [participant('cora', 'Cora', 'opponent')] : []),
            ...extra,
        ],
    });
}

describe('shipped technique catalog', () => {
    it('ships 25–35 valid techniques covering every category', () => {
        expect(LEWD_TECHNIQUES.length).toBeGreaterThanOrEqual(25);
        expect(LEWD_TECHNIQUES.length).toBeLessThanOrEqual(35);
        const ids = new Set();
        for (const technique of LEWD_TECHNIQUES) {
            expect(validateLewdTechnique(technique).ok, technique.id).toBe(true);
            expect(ids.has(technique.id)).toBe(false);
            ids.add(technique.id);
        }
        for (const category of LEWD_TECHNIQUE_CATEGORIES) {
            expect(LEWD_TECHNIQUES.some(technique => technique.category === category), category).toBe(true);
        }
    });

    it('validates the canonical shape and rejects unknown schema values', () => {
        const base = {
            id: 'test-technique',
            name: 'Test Technique',
            category: 'technique',
            zones: ['neck'],
            targetMode: 'single',
            check: { stat: 'cha', accuracy: 1 },
            arousal: '1d6+2',
            poise: '1d4',
        };
        expect(validateLewdTechnique(base).ok).toBe(true);
        expect(validateLewdTechnique({ ...base, category: 'nonsense' }).errors.join(' ')).toContain('Unknown category');
        expect(validateLewdTechnique({ ...base, zones: ['flipper'] }).errors.join(' ')).toContain('Unknown zone');
        expect(validateLewdTechnique({ ...base, check: { stat: 'luck' } }).errors.join(' ')).toContain('Unknown check stat');
        expect(validateLewdTechnique({ ...base, targetMode: 'all' }).errors.join(' ')).toContain('Unknown targetMode');
        expect(validateLewdTechnique({ ...base, requires: { tentacles: true } }).errors.join(' ')).toContain('Unknown requirement');
        expect(validateLewdTechnique({ ...base, name: '' }).ok).toBe(false);
    });

    it('stores the darker-theme flag used by the opponent policy', () => {
        const state = fixture({ settings: { lewdCombatDarkerThemes: true } });
        expect(state.settings).toMatchObject({ lewdCombatDarkerThemes: true });
    });

    it('creates an encounter with the shipped catalog by default', () => {
        const state = fixture();
        expect(state.techniques).toBe(LEWD_TECHNIQUES);
        const result = applyLewdAction(state, {
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

describe('listLegalActions', () => {
    it('marks hold requirements, hard limits, and partner caps on targets', () => {
        const state = fixture({ bran: { limits: ['teasing'] } });
        const legal = listLegalActions(state, 'aria');
        const neckKiss = legal.find(entry => entry.id === 'neck-kiss');
        expect(neckKiss.targets.find(target => target.id === 'bran')).toMatchObject({
            disabled: true,
            reasons: ['Blocked by limit: teasing'],
        });
        const finisher = legal.find(entry => entry.id === 'finish-hold');
        expect(finisher.targets.find(target => target.id === 'bran').reasons.join(' ')).toContain('Requires hold');
        expect(legal.every(entry => entry.disabled === false || entry.reasons.length > 0)).toBe(true);
    });

    it('marks exhausted uses and self techniques without a target', () => {
        const custom = {
            id: 'once-only',
            name: 'Once Only',
            category: 'technique',
            zones: ['neck'],
            targetMode: 'single',
            arousal: '1',
            poise: '0',
            uses: { max: 1, recharge: 'encounter' },
        };
        const state = fixture({ techniques: [custom] });
        state.participants.find(p => p.id === 'aria').uses['once-only'] = 1;
        const legal = listLegalActions(state, 'aria', { techniques: [custom] });
        expect(legal[0].disabled).toBe(true);
        expect(legal[0].reasons).toContain('No uses remaining for this technique.');

        const stance = LEWD_TECHNIQUES.find(entry => entry.id === 'commanding-pose');
        const stanceEntry = listLegalActions(state, 'aria', { techniques: [stance] })[0];
        expect(stanceEntry.disabled).toBe(false);
        expect(stanceEntry.targets[0]).toMatchObject({ id: 'aria', self: true });
    });

    it('never marks a target legal once the partner cap is reached', () => {
        const state = fixture({ mode: 'group', speccy: true, settings: { lewdCombatMaxPartners: 1 } });
        upsertEngagement(state, 'aria', 'bran');
        const legal = listLegalActions(state, 'aria');
        const neckKiss = legal.find(entry => entry.id === 'neck-kiss');
        expect(neckKiss.targets.find(target => target.id === 'cora').reasons.join(' ')).toContain('Partner limit reached');
        expect(neckKiss.targets.find(target => target.id === 'bran').disabled).toBe(false);
    });

    it('does not list an action as legal when the actor cannot act', () => {
        const state = fixture();
        state.participants.find(p => p.id === 'aria').acted = true;
        const legal = listLegalActions(state, 'aria');
        expect(legal.every(entry => entry.disabled)).toBe(true);
        expect(legal[0].reasons).toContain('This participant has already acted this round.');
    });
});

describe('deterministic opponent policy', () => {
    it('returns the same action for identical states and never targets a hard limit', () => {
        const first = fixture({ seed: 'policy-seed', aria: { limits: ['teasing'] } });
        const second = fixture({ seed: 'policy-seed', aria: { limits: ['teasing'] } });
        const chosenFirst = chooseOpponentAction(first, 'bran');
        const chosenSecond = chooseOpponentAction(second, 'bran');
        expect(chosenFirst.action).toEqual(chosenSecond.action);

        const technique = chosenFirst.technique;
        if (chosenFirst.action.targetIds?.includes('aria')) {
            expect(isBlockedByLimits(
                first.participants.find(p => p.id === 'aria').profile,
                [...(technique.tags || []), ...(technique.zones || [])],
            )).toBe('');
        }
    });

    it('penalizes repetition so an equal-priority alternative wins', () => {
        const alpha = {
            id: 'alpha', name: 'Alpha', category: 'technique', zones: ['neck'], targetMode: 'single',
            arousal: '1', poise: '0', ai: { priority: 2 },
        };
        const beta = {
            id: 'beta', name: 'Beta', category: 'technique', zones: ['neck'], targetMode: 'single',
            arousal: '1', poise: '0', ai: { priority: 2 },
        };
        const state = fixture({ techniques: [alpha, beta] });
        state.actionLog.push({ round: 1, unitId: 'bran', techniqueId: 'alpha', type: 'technique' });
        const chosen = chooseOpponentAction(state, 'bran', { techniques: [alpha, beta] });
        expect(chosen.action.techniqueId).toBe('beta');
    });

    it('falls back deterministically when the supplied AI action is illegal', () => {
        const state = fixture();
        const result = resolveLewdOpponentTurn(state, [{
            unitId: 'bran',
            type: 'technique',
            techniqueId: 'does-not-exist',
            targetIds: ['aria'],
        }]);
        expect(result.ok).toBe(true);
        expect(state.actionLog.some(entry => entry.type === 'rejected-ai-action')).toBe(true);
        expect(vi.isMockFunction(Math.random)).toBe(false);
    });
});

describe('multi-target resolution', () => {
    it('applies per-target preferences and excludes only the blocked target', () => {
        const group = {
            id: 'group-tease',
            name: 'Group Tease',
            category: 'technique',
            zones: ['neck'],
            targetMode: 'group',
            tags: ['teasing'],
            arousal: '5',
            poise: '0',
        };
        const state = fixture({ mode: 'group', speccy: true, bran: { limits: ['teasing'] }, techniques: [group] });
        const result = applyLewdAction(state, {
            type: 'technique',
            unitId: 'aria',
            techniqueId: 'group-tease',
            targetIds: ['bran', 'cora'],
            zone: 'neck',
        }, { techniques: [group] });
        expect(result.ok).toBe(true);
        expect(result.beat.targets.map(target => target.name)).toEqual(['Cora']);
        expect(result.beat.excluded[0]).toMatchObject({ name: 'Bran', reason: 'Blocked by limit: teasing' });
        expect(state.participants.find(p => p.id === 'bran').arousal).toBe(0);
    });

    it('reports over-cap targets for group actions instead of dropping them silently', () => {
        const group = {
            id: 'group-hum',
            name: 'Group Hum',
            category: 'technique',
            zones: ['neck'],
            targetMode: 'group',
            arousal: '1',
            poise: '0',
        };
        const state = fixture({
            mode: 'group',
            speccy: true,
            settings: { lewdCombatMaxPartners: 1 },
            techniques: [group],
        });
        upsertEngagement(state, 'aria', 'bran');
        const result = applyLewdAction(state, {
            type: 'technique',
            unitId: 'aria',
            techniqueId: 'group-hum',
            targetIds: ['bran', 'cora'],
            zone: 'neck',
        }, { techniques: [group] });
        expect(result.ok).toBe(true);
        expect(result.beat.targets.map(target => target.name)).toEqual(['Bran']);
        expect(result.beat.excluded[0]).toMatchObject({ name: 'Cora', reason: 'Partner limit reached (1).' });
    });

    it('requires only the target to be overwhelmed for pair finishers', () => {
        const state = fixture();
        const bran = state.participants.find(p => p.id === 'bran');
        bran.overwhelmedUntilRound = state.round;
        const result = applyLewdAction(state, {
            type: 'technique',
            unitId: 'aria',
            techniqueId: 'shared-climax',
            targetIds: ['bran'],
            zone: 'groin',
        });
        expect(result.ok).toBe(true);
        expect(result.beat.targets.map(target => target.name).sort()).toEqual(['Aria', 'Bran']);
    });
});
