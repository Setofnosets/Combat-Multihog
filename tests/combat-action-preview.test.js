import { describe, expect, it } from 'vitest';

import {
    averageDiceExpression,
    buildActionPreview,
    estimateHitChance,
    resolvePreviewExpression,
} from '../src/features/tactical-combat/combat-action-preview.js';
import {
    createEncounterState,
    getEffectiveAc,
    getEffectiveAttackBonus,
    getSourceAttackBonus,
} from '../src/features/tactical-combat/tactical-combat-engine.js';

const ROWS = 8;
const COLS = 8;

function openTerrain() {
    return Array.from({ length: ROWS }, () => '.'.repeat(COLS));
}

function makeState(unitOverrides = {}, targetOverrides = {}) {
    return createEncounterState({
        seed: 1234,
        grid: { rows: ROWS, cols: COLS },
        terrainRows: openTerrain(),
        terrainTheme: 'dungeon',
        turnStyle: 'phase',
        movement: 6,
        units: [
            {
                id: 'pc-1', name: 'Aria', side: 'player', maxHp: 20, hp: 20,
                ac: 13, attackBonus: 5, damage: '1d8+2', initiativeBonus: 5,
                ...unitOverrides,
            },
            {
                id: 'enemy-1', name: 'Goblin', side: 'enemy', maxHp: 12, hp: 12,
                ac: 10, attackBonus: 3, damage: '1d6', initiativeBonus: 0,
                ...targetOverrides,
            },
        ],
    });
}

function unitsOf(state) {
    return {
        unit: state.units.find(entry => entry.id === 'pc-1'),
        target: state.units.find(entry => entry.id === 'enemy-1'),
    };
}

describe('averageDiceExpression', () => {
    it('parses dice, flats, bare numbers, and sums', () => {
        expect(averageDiceExpression('1d8+3')).toEqual({ min: 4, avg: 7.5, max: 11 });
        expect(averageDiceExpression('2d6')).toEqual({ min: 2, avg: 7, max: 12 });
        expect(averageDiceExpression('1d8 - 1')).toEqual({ min: 0, avg: 3.5, max: 7 });
        expect(averageDiceExpression('+4')).toEqual({ min: 4, avg: 4, max: 4 });
        expect(averageDiceExpression('12')).toEqual({ min: 12, avg: 12, max: 12 });
        expect(averageDiceExpression('1d6+1d4+2')).toEqual({ min: 4, avg: 8, max: 12 });
    });

    it('refuses scale tokens and unparseable fragments', () => {
        expect(averageDiceExpression('@enemiesd6')).toBeNull();
        expect(averageDiceExpression('1d8+@allies')).toBeNull();
        expect(averageDiceExpression('1d8 fire')).toBeNull();
        expect(averageDiceExpression('')).toBeNull();
        expect(averageDiceExpression(null)).toBeNull();
    });
});

describe('estimateHitChance', () => {
    it('treats natural 1 as a miss and natural 20 as a hit', () => {
        expect(estimateHitChance(0, 21)).toBe(5);
        expect(estimateHitChance(50, 10)).toBe(95);
        expect(estimateHitChance(100, 1)).toBe(95);
        expect(estimateHitChance(5, 10)).toBe(80);
        expect(estimateHitChance(0, 10)).toBe(55);
    });
});

describe('buildActionPreview', () => {
    it('mirrors basic-attack bonuses and target AC', () => {
        const state = makeState();
        const { unit, target } = unitsOf(state);
        const preview = buildActionPreview(state, unit, null, { mode: 'attack', target });

        const expectedBonus = getEffectiveAttackBonus(state, unit, 0, target);
        const expectedAc = getEffectiveAc(state, target, unit);
        expect(preview.title).toBe('Basic attack');
        expect(preview.kind).toBe('attack');
        expect(preview.special).toBe(false);
        expect(preview.prediction.ac).toBe(expectedAc);
        expect(preview.prediction.hitChance).toBe(estimateHitChance(expectedBonus, expectedAc));
        expect(preview.prediction.critChance).toBe(5);
        expect(preview.prediction.averageDamage).toBe(6.5);
        expect(preview.summary).toContain(`AC ${expectedAc}`);
        expect(preview.lines.join('\n')).toContain('Target AC');
    });

    it('uses skill attack bonuses and applies outgoing/incoming damage modifiers', () => {
        const state = makeState({ spellAttackBonus: 9 });
        const { unit, target } = unitsOf(state);
        unit.statuses = [{ id: 'rage', label: 'Rage', damageBonus: 2 }];
        target.statuses = [{ id: 'guard', label: 'Guard', damageReduction: 1 }];
        const skill = { name: 'Fire Bolt', kind: 'attack', spell: true, damage: '1d8', resource: 'willpower', range: 6, description: 'A bolt of flame.' };
        const preview = buildActionPreview(state, unit, skill, { mode: 'skill', target });

        const expectedBonus = getSourceAttackBonus(state, unit, skill, target);
        expect(preview.description).toBe('A bolt of flame.');
        expect(preview.prediction.hitChance).toBe(estimateHitChance(expectedBonus, getEffectiveAc(state, target, unit)));
        // 1d8 average 4.5 + 2 outgoing - 1 incoming = 5.5
        expect(preview.prediction.averageDamage).toBe(5.5);
        expect(preview.lines.join('\n')).toMatch(/Damage \(Willpower\)/);
    });

    it('previews skill and item heals with their own fields', () => {
        const state = makeState();
        const { unit, target } = unitsOf(state);

        const heal = buildActionPreview(state, unit, { name: 'Mend', kind: 'heal', heal: '1d8+2', resource: 'hp' }, { mode: 'skill', target });
        expect(heal.prediction.averageHeal).toBe(6.5);
        expect(heal.prediction.averageDamage).toBeUndefined();
        expect(heal.summary).toContain('heal 1d8+2 (avg 6.5)');

        const potion = buildActionPreview(state, unit, { name: 'Potion', kind: 'heal', amount: '2d4+2', resource: 'both' }, { mode: 'item', target });
        expect(potion.prediction.averageHeal).toBe(7);
        expect(potion.lines.join('\n')).toContain('Heal HP+WP');
        expect(potion.summary).toContain('HP+WP');
    });

    it('previews buffs without inventing damage', () => {
        const state = makeState();
        const { unit, target } = unitsOf(state);
        const preview = buildActionPreview(state, unit, {
            name: 'Shield', kind: 'buff', acBonus: 2, damageReduction: 1, rounds: 3,
        }, { mode: 'skill', target });

        expect(preview.kind).toBe('buff');
        expect(preview.prediction).toEqual({});
        expect(preview.lines.join('\n')).toContain('+2 AC');
        expect(preview.lines.join('\n')).toContain('Duration: 3 rounds');
        expect(preview.summary).toContain('for 3 rounds');
    });

    it('renders specials as description plus recipe and a resolver notice', () => {
        const state = makeState();
        const { unit, target } = unitsOf(state);
        const preview = buildActionPreview(state, unit, {
            name: 'Time Stop',
            kind: 'special',
            description: 'Freezes the battlefield.',
            effectTemplate: [{ type: 'status', label: 'Stunned', rounds: 2, target: '$areaHostile' }],
        }, { mode: 'skill', target });

        expect(preview.special).toBe(true);
        expect(preview.prediction).toEqual({});
        expect(preview.lines.join('\n')).toContain('Freezes the battlefield.');
        expect(preview.lines.join('\n')).toContain('Recipe:');
        expect(preview.lines.join('\n')).toMatch(/Resolved by the combat agent/);
        expect(preview.summary).toMatch(/resolved by the combat agent/);
    });

    it('uses the raw expression when scale tokens cannot be averaged', () => {
        const state = makeState();
        const { unit, target } = unitsOf(state);
        const preview = buildActionPreview(state, unit, {
            name: 'Swarm Shot', kind: 'attack', damage: '@enemiesd6',
        }, { mode: 'skill', target });

        expect(preview.prediction.averageDamage).toBeUndefined();
        expect(preview.lines.join('\n')).toContain('@enemiesd6');
        expect(preview.summary).toContain('@enemiesd6');
    });

    it('resolves expressions through the engine helper', () => {
        const state = makeState();
        const { unit, target } = unitsOf(state);
        expect(resolvePreviewExpression({ damage: '1d8+1' }, state, unit, target, 'damage')).toBe('1d8+1');
    });

    it('never mutates state or rolls dice', () => {
        const state = makeState();
        const { unit, target } = unitsOf(state);
        const before = JSON.stringify(state);
        const rollCount = state.rollCount;

        buildActionPreview(state, unit, null, { mode: 'attack', target });
        buildActionPreview(state, unit, { name: 'Mend', kind: 'heal', heal: '1d8+2' }, { mode: 'skill', target });
        buildActionPreview(state, unit, { name: 'Shield', kind: 'buff', acBonus: 2 }, { mode: 'skill', target });
        buildActionPreview(state, unit, { name: 'Weird', kind: 'special', effectTemplate: [] }, { mode: 'skill', target });

        expect(JSON.stringify(state)).toBe(before);
        expect(state.rollCount).toBe(rollCount);
    });
});
