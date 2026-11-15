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
    it('ships 45–70 valid techniques covering every category', () => {
        expect(LEWD_TECHNIQUES.length).toBeGreaterThanOrEqual(45);
        expect(LEWD_TECHNIQUES.length).toBeLessThanOrEqual(70);
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

describe('explicit act catalog', () => {
    const byId = id => LEWD_TECHNIQUES.find(entry => entry.id === id);
    const base = () => ({
        id: 'act-test',
        name: 'Act Test',
        category: 'technique',
        zones: ['genitals'],
        targetMode: 'single',
        arousal: '1',
        poise: '0',
    });

    it('accepts actType/actRole and rejects unknown enum values', () => {
        expect(validateLewdTechnique({ ...base(), actType: 'penetration', actRole: 'give' }).ok).toBe(true);
        expect(validateLewdTechnique({ ...base(), actType: 'nonsense' }).errors.join(' ')).toContain('Unknown actType');
        expect(validateLewdTechnique({ ...base(), actRole: 'both' }).errors.join(' ')).toContain('Unknown actRole');
        expect(validateLewdTechnique({ ...base(), requires: { actType: 'nonsense' } }).errors.join(' '))
            .toContain('Unknown actType');
        expect(validateLewdTechnique({ ...base(), requires: { actRole: 'both' } }).errors.join(' '))
            .toContain('Unknown actRole');
    });

    it('gates a follow-up act on an active engagement act', () => {
        const state = fixture();
        const before = listLegalActions(state, 'aria').find(entry => entry.id === 'thrust-harder');
        expect(before.disabled).toBe(true);
        expect(before.targets.find(target => target.id === 'bran').reasons.join(' '))
            .toContain('Requires active act: penetration.');

        upsertEngagement(state, 'aria', 'bran');
        state.engagements[0].act = 'penetration';
        state.engagements[0].actIntensity = 1;
        const afterString = listLegalActions(state, 'aria').find(entry => entry.id === 'thrust-harder');
        expect(afterString.disabled).toBe(false);

        state.engagements[0].act = { id: 'penetration', type: 'penetration' };
        expect(listLegalActions(state, 'aria').find(entry => entry.id === 'thrust-harder').disabled).toBe(false);
    });

    it('matches requires.actRole exactly except for mutual', () => {
        const custom = {
            ...base(),
            id: 'role-gate',
            name: 'Role Gate',
            requires: { actType: 'penetration', actRole: 'give' },
        };
        const state = fixture({ techniques: [custom] });
        upsertEngagement(state, 'aria', 'bran');
        state.engagements[0].act = { id: 'penetration', type: 'penetration', role: 'receive' };
        const denied = listLegalActions(state, 'aria', { techniques: [custom] })[0];
        expect(denied.disabled).toBe(true);
        expect(denied.targets[0].reasons.join(' ')).toContain('Requires act role: give.');

        state.engagements[0].act.role = 'give';
        expect(listLegalActions(state, 'aria', { techniques: [custom] })[0].disabled).toBe(false);

        const mutual = { ...custom, id: 'mutual-gate', requires: { actRole: 'mutual' } };
        state.engagements[0].act.role = 'receive';
        expect(listLegalActions(state, 'aria', { techniques: [mutual] })[0].disabled).toBe(false);

        // A bare pairing edge with no act never satisfies an act-role gate.
        state.engagements[0].act = null;
        const bare = listLegalActions(state, 'aria', { techniques: [mutual] })[0];
        expect(bare.disabled).toBe(true);
        expect(bare.targets[0].reasons.join(' ')).toContain('Requires act role: mutual.');
    });

    it('normalizes act-adjacent requirements and rejects unknown anatomy', () => {
        const result = validateLewdTechnique({
            ...base(),
            requires: {
                anatomy: 'tail',
                skill: 'Bondage',
                trait: ['Tail'],
                kink: 'Praise, Ropes',
                actType: 'bondage',
            },
        });
        expect(result.ok).toBe(true);
        expect(result.technique.requires).toMatchObject({
            anatomy: { all: ['tail'], any: [] },
            skill: ['bondage'],
            trait: ['tail'],
            kink: ['praise', 'ropes'],
            actType: 'bondage',
        });
        expect(validateLewdTechnique({ ...base(), requires: { anatomy: { any: ['penis', 'wings'] } } }).ok).toBe(true);
        expect(validateLewdTechnique({ ...base(), requires: { anatomy: 'flipper' } }).errors.join(' '))
            .toContain('Unknown anatomy tag');
    });

    it('keeps applies.act normalized and preserves null clears', () => {
        expect(byId('withdraw').applies.act).toBeNull();
        expect(byId('release-bindings').applies.act).toBeNull();
        expect(byId('penetration-start').applies.act).toMatchObject({
            id: 'penetration', type: 'penetration', role: 'give', intensity: 1,
        });
        expect(byId('thrust-harder').applies.act).toBeUndefined();
        expect(byId('thrust-harder').applies.intensityDelta).toBe(1);
    });

    it('lists act metadata and gates bondage follow-ups on the act', () => {
        const state = fixture({ aria: { skills: ['bondage'] } });
        const entry = listLegalActions(state, 'aria').find(candidate => candidate.id === 'penetration-start');
        expect(entry.actType).toBe('penetration');
        expect(entry.actRole).toBe('give');

        const before = listLegalActions(state, 'aria').find(candidate => candidate.id === 'tighten-bindings');
        expect(before.actType).toBe('bondage');
        expect(before.disabled).toBe(true);
        expect(before.targets[0].reasons.join(' ')).toContain('Requires active act: bondage.');

        upsertEngagement(state, 'aria', 'bran');
        state.engagements[0].act = { id: 'bondage', type: 'bondage', role: 'give' };
        state.engagements[0].bindings = 1;
        expect(listLegalActions(state, 'aria').find(candidate => candidate.id === 'tighten-bindings').disabled)
            .toBe(false);
    });

    it('ships the bondage acts with explicit zones and a real hold', () => {
        for (const id of ['tie-bindings', 'tighten-bindings', 'loosen-bindings', 'tease-bound', 'release-bindings']) {
            const entry = byId(id);
            expect(entry, id).toBeTruthy();
            expect(entry.actType).toBe('bondage');
            expect(entry.zones.length).toBeGreaterThan(0);
        }
        expect(byId('tie-bindings').hold).toMatchObject({ id: 'bound' });
        expect(byId('tighten-bindings').requires.act).toBe('bondage');
        expect(byId('tie-bindings').requires.anatomy).toMatchObject({ all: ['bondage-gear'] });
    });

    it('gates thrust-harder on an active penetration act at intensity 1', () => {
        const state = fixture();
        const before = listLegalActions(state, 'aria').find(entry => entry.id === 'thrust-harder');
        expect(before.disabled).toBe(true);
        expect(before.targets.find(target => target.id === 'bran').reasons.join(' '))
            .toContain('Requires active act: penetration.');

        upsertEngagement(state, 'aria', 'bran', {
            act: { id: 'penetration', type: 'penetration', role: 'give' },
        });
        const atZero = listLegalActions(state, 'aria').find(entry => entry.id === 'thrust-harder');
        expect(atZero.disabled).toBe(true);
        expect(atZero.targets.find(target => target.id === 'bran').reasons.join(' '))
            .toContain('Requires act intensity 1.');

        state.engagements[0].actIntensity = 1;
        expect(listLegalActions(state, 'aria').find(entry => entry.id === 'thrust-harder').disabled).toBe(false);
    });

    it('requires bindings for tighten-bindings and validates level requirements', () => {
        const state = fixture({ aria: { skills: ['bondage'] } });
        upsertEngagement(state, 'aria', 'bran', {
            act: { id: 'bondage', type: 'bondage', role: 'give' },
        });
        const noBindings = listLegalActions(state, 'aria').find(entry => entry.id === 'tighten-bindings');
        expect(noBindings.disabled).toBe(true);
        expect(noBindings.targets[0].reasons.join(' ')).toContain('Requires bindings 1.');

        state.engagements[0].bindings = 1;
        expect(listLegalActions(state, 'aria').find(entry => entry.id === 'tighten-bindings').disabled).toBe(false);

        const valid = validateLewdTechnique({
            ...base(),
            requires: { minIntensity: 2, bindings: 1, pairStance: 'entwined' },
        });
        expect(valid.ok).toBe(true);
        expect(valid.technique.requires).toMatchObject({ minIntensity: 2, bindings: 1, pairStance: 'entwined' });

        const bad = validateLewdTechnique({
            ...base(),
            requires: { minIntensity: 6, bindings: -1, pairStance: 3 },
        });
        expect(bad.ok).toBe(false);
        expect(bad.errors.join(' ')).toContain('requires.minIntensity');
        expect(bad.errors.join(' ')).toContain('requires.bindings');
        expect(bad.errors.join(' ')).toContain('requires.pairStance');
    });

    it('gates a technique on the pair stance', () => {
        const custom = {
            ...base(),
            id: 'pair-stance-gate',
            name: 'Pair Stance Gate',
            requires: { pairStance: 'entwined' },
        };
        const state = fixture({ techniques: [custom] });
        upsertEngagement(state, 'aria', 'bran', { pairStance: { id: 'guarded', label: 'Guarded' } });
        const denied = listLegalActions(state, 'aria', { techniques: [custom] })[0];
        expect(denied.disabled).toBe(true);
        expect(denied.targets[0].reasons.join(' ')).toContain('Requires pair stance: entwined.');

        state.engagements[0].pairStance = { id: 'entwined', label: 'Entwined' };
        expect(listLegalActions(state, 'aria', { techniques: [custom] })[0].disabled).toBe(false);
    });

    it('normalizes pair-state applications and stance targeting', () => {
        const applied = validateLewdTechnique({
            ...base(),
            applies: {
                intensityDelta: 2,
                bindingsDelta: -1,
                bindings: 3,
                pairStance: 'entwined',
                stance: { id: 'guarded', target: 'pair' },
            },
        });
        expect(applied.ok).toBe(true);
        expect(applied.technique.applies.intensityDelta).toBe(2);
        expect(applied.technique.applies.bindingsDelta).toBe(-1);
        expect(applied.technique.applies.bindings).toBe(3);
        expect(applied.technique.applies.pairStance).toMatchObject({ id: 'entwined' });
        expect(applied.technique.applies.stance).toMatchObject({ id: 'guarded', target: 'pair' });

        const defaultTarget = validateLewdTechnique({ ...base(), applies: { stance: { id: 'teasing' } } });
        expect(defaultTarget.technique.applies.stance.target).toBe('actor');

        const badTarget = validateLewdTechnique({
            ...base(),
            applies: { stance: { id: 'teasing', target: 'everyone' } },
        });
        expect(badTarget.ok).toBe(false);
        expect(badTarget.errors.join(' ')).toContain('Unknown stance target');

        expect(validateLewdTechnique({ ...base(), applies: { intensityDelta: 9 } }).ok).toBe(false);
        expect(validateLewdTechnique({ ...base(), applies: { bindings: 6 } }).ok).toBe(false);
        expect(validateLewdTechnique({ ...base(), applies: { bindingsDelta: -9 } }).ok).toBe(false);
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

describe('deterministic requirement gating', () => {
    const base = () => ({
        id: 'penis-gate',
        name: 'Penis Gate',
        category: 'technique',
        zones: ['genitals'],
        targetMode: 'single',
        arousal: '1',
        poise: '0',
    });

    it('gates a genital technique on declared actor anatomy', () => {
        const custom = { ...base(), requires: { anatomy: { all: [], any: ['penis'] } } };
        const unknown = listLegalActions(fixture({ techniques: [custom] }), 'aria')[0];
        expect(unknown.disabled).toBe(true);
        expect(unknown.reasons.join(' ')).toContain('Set anatomy in [LEWD]');

        const withPenis = listLegalActions(
            fixture({ aria: { anatomy: ['penis'] }, techniques: [custom] }),
            'aria',
        )[0];
        expect(withPenis.disabled).toBe(false);

        const withVagina = listLegalActions(
            fixture({ aria: { anatomy: ['vagina'] }, techniques: [custom] }),
            'aria',
        )[0];
        expect(withVagina.disabled).toBe(true);
        expect(withVagina.reasons).toContain('Requires penis.');
        expect(withVagina.reasons.join(' ')).not.toContain('Set anatomy');
    });

    it('blocks genital acts but not neutral techniques when anatomy is unknown', () => {
        const genital = { ...base(), requires: { anatomy: { all: [], any: ['penis'] } } };
        const neutral = { ...base(), id: 'neutral-touch', name: 'Neutral Touch', requires: {} };
        const legal = listLegalActions(fixture({ techniques: [genital, neutral] }), 'aria');
        expect(legal.find(entry => entry.id === 'penis-gate').disabled).toBe(true);
        expect(legal.find(entry => entry.id === 'neutral-touch').disabled).toBe(false);
    });

    it('reports tail, skill, trait, and kink requirement reasons', () => {
        const tail = { ...base(), id: 'tail-gate', requires: { anatomy: { all: [], any: ['tail'] } } };
        const unknown = listLegalActions(fixture({ techniques: [tail] }), 'aria')[0];
        expect(unknown.reasons).toContain('Requires tail. Set anatomy in [LEWD].');

        const knownMissing = listLegalActions(
            fixture({ aria: { anatomy: ['vagina'] }, techniques: [tail] }),
            'aria',
        )[0];
        expect(knownMissing.reasons).toContain('Requires tail.');
        expect(knownMissing.reasons.join(' ')).not.toContain('Set anatomy');

        const skill = { ...base(), id: 'skill-gate', requires: { skill: ['bondage'] } };
        expect(listLegalActions(fixture({ techniques: [skill] }), 'aria')[0].reasons)
            .toContain('Requires bondage skill.');

        const trait = { ...base(), id: 'trait-gate', requires: { trait: ['tail'] } };
        expect(listLegalActions(fixture({ techniques: [trait] }), 'aria')[0].reasons)
            .toContain('Requires tail trait.');

        const kink = { ...base(), id: 'kink-gate', requires: { kink: ['praise'] } };
        expect(listLegalActions(fixture({ techniques: [kink] }), 'aria')[0].reasons)
            .toContain('Requires praise kink.');

        const satisfied = listLegalActions(
            fixture({
                aria: { skills: ['bondage'], sourceTraits: ['tail'], kinks: ['praise'] },
                techniques: [skill, trait, kink],
            }),
            'aria',
        );
        expect(satisfied.every(entry => !entry.disabled)).toBe(true);
    });

    it('filters only the target without receptive anatomy in a group action', () => {
        const group = {
            ...base(),
            id: 'receptive-group',
            name: 'Receptive Group',
            targetMode: 'group',
            requires: { targetAnatomy: { all: [], any: ['penis'] } },
        };
        const state = fixture({
            mode: 'group',
            speccy: true,
            bran: { anatomy: ['penis'] },
            techniques: [group],
        });
        const entry = listLegalActions(state, 'aria')[0];
        expect(entry.targets.find(target => target.id === 'bran').disabled).toBe(false);
        const cora = entry.targets.find(target => target.id === 'cora');
        expect(cora.disabled).toBe(true);
        expect(cora.reasons.join(' ')).toContain('Set anatomy in [LEWD]');
    });

    it('normalizes requires.targetAnatomy shapes and rejects unknown tags', () => {
        expect(validateLewdTechnique({ ...base(), requires: { targetAnatomy: 'Penis' } })
            .technique.requires.targetAnatomy).toEqual({ all: ['penis'], any: [] });
        expect(validateLewdTechnique({ ...base(), requires: { targetAnatomy: ['vagina', 'anus'] } })
            .technique.requires.targetAnatomy).toEqual({ all: ['vagina', 'anus'], any: [] });
        expect(validateLewdTechnique({
            ...base(),
            requires: { targetAnatomy: { all: ['tail'], any: ['penis', 'vagina'] } },
        }).technique.requires.targetAnatomy).toEqual({ all: ['tail'], any: ['penis', 'vagina'] });
        const bad = validateLewdTechnique({ ...base(), requires: { targetAnatomy: { any: ['flipper'] } } });
        expect(bad.ok).toBe(false);
        expect(bad.errors.join(' ')).toContain('Unknown anatomy tag');
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
