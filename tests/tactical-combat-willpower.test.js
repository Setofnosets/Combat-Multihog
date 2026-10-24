import { describe, expect, it } from 'vitest';
import {
    applyAction,
    applySpecialEffects,
    buildAgentGameState,
    buildOutcomeSummary,
    createEncounterState,
    getStatusAcBonus,
    hydrateEncounterState,
    prepareSpecialAction,
    restoreCombatScopedState,
} from '../src/features/tactical-combat/tactical-combat-engine.js';
import { deriveMaxWillpower } from '../src/features/tactical-combat/tactical-combat-willpower.js';

function openTerrain(rows = 8, cols = 8) {
    return Array.from({ length: rows }, () => '.'.repeat(cols));
}

function makeState(units = null) {
    const state = createEncounterState({
        seed: 123,
        grid: { rows: 8, cols: 8 },
        terrainRows: openTerrain(),
        turnStyle: 'phase',
        units: units || [
            { id: 'pc-1', name: 'Aria', side: 'player', maxHp: 40, hp: 40, ac: 12, attackBonus: 20, damage: '1d8', stats: { wis: 12, wisMod: 1 }, willpowerSave: 2 },
            { id: 'enemy-2', name: 'Cultist', side: 'enemy', maxHp: 15, hp: 15, ac: 10, attackBonus: 3, damage: '1d6', maxWillpower: 3, willpower: 3 },
        ],
    });
    state.units[0].x = 1;
    state.units[0].y = 1;
    state.units[1].x = 2;
    state.units[1].y = 1;
    state.terrain = openTerrain().map(row => row.split('').map(() => 'floor'));
    return state;
}

describe('Willpower derivation', () => {
    it('derives a deterministic max below HP and respects the Will save', () => {
        expect(deriveMaxWillpower(40, 1, 2)).toBe(17);
        expect(deriveMaxWillpower(12, 0, 1)).toBe(7);
        const state = makeState();
        expect(state.units[0].maxWillpower).toBe(17);
        expect(state.units[0].willpower).toBe(17);
    });

    it('supports explicit max and mindless immunity', () => {
        const state = makeState([
            { id: 'pc-1', name: 'Aria', side: 'player', maxHp: 20, hp: 20, maxWillpower: 8, willpower: 3 },
            { id: 'enemy-2', name: 'Construct', side: 'enemy', maxHp: 20, hp: 20, maxWillpower: 0 },
        ]);
        expect(state.units[0].maxWillpower).toBe(8);
        expect(state.units[0].willpower).toBe(3);
        expect(state.units[1].maxWillpower).toBe(0);
        expect(state.units[1].willpowerImmune).toBe(true);
    });

    it('hydrates boards saved before Willpower existed', () => {
        const state = makeState();
        delete state.units[0].maxWillpower;
        delete state.units[0].willpower;
        hydrateEncounterState(state);
        expect(state.units[0].maxWillpower).toBeGreaterThan(0);
        expect(state.units[0].willpower).toBe(state.units[0].maxWillpower);
    });

    it('includes Willpower and its targeting metadata in the agent game state', () => {
        const state = makeState();
        const enemy = state.units[1];
        enemy.skills = [{ id: 'dread', name: 'Dread', kind: 'attack', resource: 'willpower', damage: '1d6', willpowerOutcome: 'flee', range: 1, uses: 1, maxUses: 1 }];
        const payload = buildAgentGameState(state, ['enemy-2']);
        const serializedEnemy = payload.units.find(unit => unit.id === 'enemy-2');
        expect(serializedEnemy.willpower).toBe(3);
        expect(serializedEnemy.maxWillpower).toBe(3);
        expect(serializedEnemy.skills[0]).toMatchObject({ resource: 'willpower', willpowerOutcome: 'flee' });
        expect(payload.rules.willpower).toContain('morale');
    });
});

describe('deterministic Willpower combat', () => {
    it('damages Willpower without touching HP and applies flee at 0', () => {
        const state = makeState();
        const caster = state.units[0];
        const target = state.units[1];
        caster.skills.push({
            id: 'dread-wail',
            name: 'Dread Wail',
            kind: 'attack',
            resource: 'willpower',
            damage: '1d6',
            willpowerOutcome: 'flee',
            range: 1,
            maxUses: 1,
            uses: 1,
        });
        const hpBefore = target.hp;
        const result = applyAction(state, {
            type: 'skill',
            unitId: caster.id,
            skillId: 'dread-wail',
            targetId: target.id,
        }, { actorSide: 'player', rng: () => 0.99 });
        expect(result.ok).toBe(true);
        expect(target.hp).toBe(hpBefore);
        expect(target.willpower).toBe(0);
        expect(target.willpowerBroken).toBe(true);
        expect(target.fled).toBe(true);
        expect(caster.skills[0].uses).toBe(0);
    });

    it('supports a hit that damages both HP and Willpower', () => {
        const state = makeState();
        const caster = state.units[0];
        const target = state.units[1];
        target.maxWillpower = 6;
        target.willpower = 3;
        caster.skills.push({
            id: 'psychic-lance',
            name: 'Psychic Lance',
            kind: 'attack',
            resource: 'both',
            damage: '1d6',
            willpowerDamage: '1d6',
            willpowerOutcome: 'surrender',
            range: 1,
            maxUses: 1,
            uses: 1,
        });
        const result = applyAction(state, {
            type: 'skill',
            unitId: caster.id,
            skillId: 'psychic-lance',
            targetId: target.id,
        }, { actorSide: 'player', rng: () => 0.5 });
        expect(result.ok).toBe(true);
        expect(target.hp).toBeLessThan(15);
        expect(target.willpower).toBe(0);
        expect(target.surrendered).toBe(true);
        expect(target.defeatCause).toBe('willpower');
    });

    it('switches sides when the source says switch_side', () => {
        const state = makeState();
        const caster = state.units[0];
        const target = state.units[1];
        target.maxWillpower = 2;
        target.willpower = 2;
        caster.skills.push({
            id: 'dominate',
            name: 'Dominate',
            kind: 'attack',
            resource: 'willpower',
            damage: '2',
            willpowerOutcome: 'switch_side',
            range: 1,
            maxUses: 1,
            uses: 1,
        });
        const result = applyAction(state, {
            type: 'skill',
            unitId: caster.id,
            skillId: 'dominate',
            targetId: target.id,
        }, { actorSide: 'player', rng: () => 0.5 });
        expect(result.ok).toBe(true);
        expect(target.willpower).toBe(0);
        expect(target.side).toBe('ally');
        expect(target.originalSide).toBe('enemy');
        expect(target.sideChanged).toBe(true);
        expect(state.status).toBe('victory');
    });
});

describe('special Willpower effects and transformations', () => {
    it('rejects a defeat effect while the target still has Willpower', () => {
        const state = makeState();
        const caster = state.units[0];
        caster.skills.push({ id: 'sleep', name: 'Sleep', kind: 'special', range: 6, maxUses: 1, uses: 1 });
        const result = applySpecialEffects(state, [
            { type: 'defeat', targetId: 'enemy-2', outcome: 'incapacitate' },
        ], { casterId: 'pc-1', skillId: 'sleep' });
        expect(result.ok).toBe(false);
        expect(caster.skills[0].uses).toBe(1);
        expect(state.units[1].defeated).toBe(false);
    });

    it('applies Willpower damage with a non-default outcome through the resolver path', () => {
        const state = makeState();
        const caster = state.units[0];
        const target = state.units[1];
        caster.skills.push({ id: 'fear', name: 'Fear', kind: 'special', range: 6, maxUses: 1, uses: 1 });
        const result = applySpecialEffects(state, [
            { type: 'damage', targetId: target.id, amount: '3', resource: 'willpower', willpowerOutcome: 'flee' },
        ], { casterId: caster.id, skillId: 'fear' });
        expect(result.ok).toBe(true);
        expect(target.willpower).toBe(0);
        expect(target.fled).toBe(true);
        expect(target.willpowerOutcome).toBe('flee');
    });

    it('transforms loadout fields temporarily and restores them after combat', () => {
        const state = makeState();
        const target = state.units[1];
        target.skills = [{ id: 'old-skill', name: 'Old Skill', kind: 'attack', uses: 1, maxUses: 1 }];
        target.items = [{ id: 'old-item', name: 'Old Item', kind: 'heal', uses: 1, maxUses: 1 }];
        const caster = state.units[0];
        caster.skills.push({ id: 'polymorph', name: 'Polymorph', kind: 'special', range: 6, maxUses: 1, uses: 1 });
        const result = applySpecialEffects(state, [
            {
                type: 'transform',
                targetId: target.id,
                name: 'Stone Statue',
                ac: 18,
                maxHp: 30,
                hp: 30,
                skills: [],
                items: [],
                inventory: [],
            },
        ], { casterId: caster.id, skillId: 'polymorph' });
        expect(result.ok).toBe(true);
        expect(target.name).toBe('Stone Statue');
        expect(target.ac).toBe(18);
        expect(target.skills).toEqual([]);
        expect(target.items).toEqual([]);
        expect(target.transform).toBeTruthy();
        restoreCombatScopedState(state);
        expect(target.name).toBe('Cultist');
        expect(target.ac).toBe(10);
        expect(target.skills[0].name).toBe('Old Skill');
        expect(target.transform).toBeNull();
    });

    it('stacks progressive statuses and applies a Willpower damage-over-time outcome', () => {
        const state = makeState();
        const target = state.units[1];
        target.maxWillpower = 6;
        target.willpower = 6;
        const caster = state.units[0];
        caster.skills.push({ id: 'despair', name: 'Despair', kind: 'special', range: 6, maxUses: 2, uses: 2 });
        applySpecialEffects(state, [
            { type: 'status', targetId: target.id, label: 'Despair', rounds: 2, behavior: 'confused', stacks: 1, maxStacks: 3, acBonus: -2 },
        ], { casterId: caster.id, skillId: 'despair' });
        caster.actionUsed = false;
        applySpecialEffects(state, [
            { type: 'status', targetId: target.id, label: 'Despair', rounds: 2, behavior: 'confused', stacks: 1, maxStacks: 3, acBonus: -2 },
        ], { casterId: caster.id, skillId: 'despair' });
        expect(target.statuses[0].stacks).toBe(2);
        expect(getStatusAcBonus(target)).toBe(-4);
        const summary = buildOutcomeSummary(state);
        expect(summary.finalUnits[1]).toMatchObject({ maxWillpower: 6, willpower: 6 });
    });
});

describe('special action preparation', () => {
    it('validates special uses and consumes nothing before resolution', () => {
        const state = makeState();
        const caster = state.units[0];
        caster.skills.push({ id: 'fear', name: 'Fear', kind: 'special', range: 1, maxUses: 1, uses: 1 });
        const prepared = prepareSpecialAction(state, {
            type: 'skill', unitId: caster.id, skillId: 'fear', targetId: 'enemy-2',
        }, { actorSide: 'player' });
        expect(prepared.ok).toBe(true);
        expect(caster.actionUsed).toBe(false);
        expect(caster.skills[0].uses).toBe(1);
    });

    it('rejects a special declaration outside range', () => {
        const state = makeState();
        const caster = state.units[0];
        const target = state.units[1];
        target.x = 7;
        target.y = 7;
        caster.skills.push({ id: 'fear', name: 'Fear', kind: 'special', range: 1, maxUses: 1, uses: 1 });
        const prepared = prepareSpecialAction(state, {
            type: 'skill', unitId: caster.id, skillId: 'fear', targetId: target.id,
        }, { actorSide: 'player' });
        expect(prepared.ok).toBe(false);
    });
});
