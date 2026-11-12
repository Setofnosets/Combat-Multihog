import { describe, expect, it } from 'vitest';
import {
    applyAction,
    beginRound,
    createEncounterState,
    getStatusAcBonus,
    getStatusAttackBonus,
    getStatusDamageBonus,
    getStatusDamageReduction,
    getUnitById,
} from '../src/features/tactical-combat/tactical-combat-engine.js';
import {
    buildCombatVariableContext,
    combatConditionMet,
    evaluateCombatFormula,
    normalizeCombatCondition,
    normalizeCombatScale,
} from '../src/features/tactical-combat/tactical-combat-variables.js';
import {
    builtinPassiveRecipe,
    describePassiveTrigger,
    normalizePassiveTrigger,
} from '../src/features/tactical-combat/tactical-combat-passives.js';
import { hasPendingPassiveRecipes } from '../src/features/tactical-combat/tactical-combat-agent.js';
import {
    applyTraditionalAction,
    createTraditionalEncounterState,
} from '../src/features/traditional-combat/traditional-combat-engine.js';

function createBattlefield() {
    return createEncounterState({
        seed: 11,
        grid: { rows: 7, cols: 7 },
        terrainRows: Array.from({ length: 7 }, () => '.......'),
        units: [
            {
                id: 'pc-1',
                name: 'Aria',
                side: 'player',
                maxHp: 30,
                hp: 20,
                ac: 12,
                attackBonus: 30,
                attackRange: 1,
                damage: '1',
            },
            {
                id: 'ally-1',
                name: 'Sera',
                side: 'ally',
                maxHp: 18,
                hp: 18,
                ac: 12,
                attackBonus: 2,
                attackRange: 1,
                damage: '1',
            },
            {
                id: 'enemy-1',
                name: 'Goblin',
                side: 'enemy',
                maxHp: 40,
                hp: 40,
                ac: 5,
                attackBonus: 0,
                attackRange: 1,
                damage: '1',
            },
            {
                id: 'enemy-2',
                name: 'Goblin Archer',
                side: 'enemy',
                maxHp: 20,
                hp: 20,
                ac: 5,
                attackBonus: 0,
                attackRange: 6,
                damage: '1',
            },
            {
                id: 'enemy-3',
                name: 'Wolf',
                side: 'enemy',
                maxHp: 16,
                hp: 16,
                ac: 5,
                attackBonus: 0,
                attackRange: 1,
                damage: '1',
            },
        ],
    });
}

describe('combat variable evaluator', () => {
    it('counts living sides, outnumbered, and grid adjacency relative to the unit', () => {
        const state = createBattlefield();
        const pc = getUnitById(state, 'pc-1');
        const ally = getUnitById(state, 'ally-1');
        const [goblin, archer, wolf] = ['enemy-1', 'enemy-2', 'enemy-3'].map(id => getUnitById(state, id));
        pc.x = 3; pc.y = 3;
        ally.x = 2; ally.y = 3;
        goblin.x = 4; goblin.y = 3;
        archer.x = 5; archer.y = 5;
        wolf.x = 0; wolf.y = 0;

        const context = buildCombatVariableContext(state, { unit: pc, target: goblin });
        expect(context.enemies).toBe(3);
        expect(context.allies).toBe(1);
        expect(context.alliesIncludingSelf).toBe(2);
        expect(context.outnumbered).toBe(2);
        expect(context.adjacentEnemies).toBe(1);
        expect(context.adjacentAllies).toBe(1);
        expect(context.nearbyEnemies).toBe(2);
    });

    it('interpolates @variables into dice formulas and supports multiplication', () => {
        const state = createBattlefield();
        const pc = getUnitById(state, 'pc-1');
        const goblin = getUnitById(state, 'enemy-1');
        pc.x = 3; pc.y = 3;
        goblin.x = 4; goblin.y = 3;

        const context = buildCombatVariableContext(state, { unit: pc, target: goblin });
        const flat = evaluateCombatFormula('1d8 + @enemies', context, () => 0.5);
        expect(flat.total).toBe(8); // 1d8 -> 5, + 3 living enemies

        const multiplied = evaluateCombatFormula('1d6 * @outnumbered', context, () => 0.5);
        expect(multiplied.total).toBe(8); // 1d6 -> 4, x2 outnumbered

        const adjacent = evaluateCombatFormula('@adjacentEnemiesd6', context, () => 0.5);
        expect(adjacent.total).toBe(4);
    });

    it('evaluates structured conditions and missing-HP variables', () => {
        const state = createBattlefield();
        const pc = getUnitById(state, 'pc-1');
        pc.hp = 9;
        const context = buildCombatVariableContext(state, { unit: pc });
        expect(context.missingHp).toBe(21);
        expect(context.missingHpPct).toBe(70);
        expect(context.missingHpTens).toBe(7);

        expect(combatConditionMet({ variable: 'missingHpPct', op: 'gte', value: 50 }, context)).toBe(true);
        expect(combatConditionMet({ variable: 'enemies', op: 'lt', value: 1 }, context)).toBe(false);
        expect(normalizeCombatCondition({ variable: 'enemies', op: '>=', value: 2 })).toMatchObject({ op: 'gte' });
    });

    it('normalizes scale blocks and clamps their step count', () => {
        const state = createBattlefield();
        const pc = getUnitById(state, 'pc-1');
        const context = buildCombatVariableContext(state, { unit: pc });
        const scale = normalizeCombatScale({ variable: 'enemies', per: 1, min: 0, max: 2, damageBonus: 2 });
        expect(scale).toMatchObject({ variable: 'enemies', per: 1, min: 0, max: 2, damageBonus: 2 });
        expect(evaluateCombatFormula('@enemies', context).total).toBe(3);
    });
});

describe('scaled statuses', () => {
    it('evaluates AC, attack, damage bonus, and damage reduction live per living enemy', () => {
        const state = createBattlefield();
        const pc = getUnitById(state, 'pc-1');
        pc.statuses = [{
            id: 'last-stand',
            label: 'Last Stand',
            rounds: 3,
            acBonus: 1,
            attackBonus: 1,
            damageBonus: 1,
            damageReduction: 1,
            scale: {
                variable: 'enemies',
                per: 1,
                min: 0,
                max: 5,
                acBonus: 1,
                attackBonus: 1,
                damageBonus: 2,
                damageReduction: 1,
            },
        }];

        expect(getStatusAcBonus(pc, state)).toBe(4); // 1 base + 3 enemies
        expect(getStatusAttackBonus(pc, state)).toBe(4);
        expect(getStatusDamageBonus(pc, state)).toBe(7); // 1 base + 2 per enemy
        expect(getStatusDamageReduction(pc, state)).toBe(4);

        getUnitById(state, 'enemy-3').fled = true;
        expect(getStatusAcBonus(pc, state)).toBe(3);
        expect(getStatusDamageBonus(pc, state)).toBe(5);
    });

    it('applies outgoing damageBonus and incoming damageReduction in attacks', () => {
        const state = createBattlefield();
        const pc = getUnitById(state, 'pc-1');
        const goblin = getUnitById(state, 'enemy-1');
        pc.x = 3; pc.y = 3;
        goblin.x = 4; goblin.y = 3;
        pc.damage = '1';
        pc.statuses = [{ id: 'fury', label: 'Fury', rounds: 2, damageBonus: 2 }];
        goblin.statuses = [{ id: 'guard', label: 'Guard', rounds: 2, damageReduction: 1 }];

        const result = applyAction(state, {
            type: 'attack',
            unitId: pc.id,
            targetId: goblin.id,
        }, { actorSide: 'player', rng: () => 0.5 });

        expect(result.ok).toBe(true);
        expect(goblin.hp).toBe(38); // 1 base + 2 bonus - 1 reduction
    });
});

describe('variable-scaled skills and passives', () => {
    it('evaluates @variables in a skill damage expression at attack time', () => {
        const state = createBattlefield();
        const pc = getUnitById(state, 'pc-1');
        const goblin = getUnitById(state, 'enemy-1');
        pc.x = 3; pc.y = 3;
        goblin.x = 4; goblin.y = 3;
        pc.skills = [{
            id: 'horde-breaker',
            name: 'Horde Breaker',
            kind: 'attack',
            range: 1,
            damage: '1d6 + @enemies',
            unlimited: true,
            maxUses: 0,
            uses: 0,
        }];

        const result = applyAction(state, {
            type: 'skill',
            unitId: pc.id,
            skillId: 'horde-breaker',
            targetId: goblin.id,
        }, { actorSide: 'player', rng: () => 0.5 });

        expect(result.ok).toBe(true);
        expect(goblin.hp).toBe(33); // 1d6 -> 4, + 3 enemies
    });

    it('skips a skill whose structured condition is not met', () => {
        const state = createBattlefield();
        const pc = getUnitById(state, 'pc-1');
        const goblin = getUnitById(state, 'enemy-1');
        pc.x = 3; pc.y = 3;
        goblin.x = 4; goblin.y = 3;
        pc.skills = [{
            id: 'executioner',
            name: 'Executioner',
            kind: 'attack',
            range: 1,
            damage: '1d6',
            condition: { variable: 'targetMissingHpPct', op: 'gte', value: 50 },
            unlimited: true,
            maxUses: 0,
            uses: 0,
        }];

        const result = applyAction(state, {
            type: 'skill',
            unitId: pc.id,
            skillId: 'executioner',
            targetId: goblin.id,
        }, { actorSide: 'player', rng: () => 0.5 });

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/condition/i);
        expect(goblin.hp).toBe(40);
    });

    it('expands $areaHostile for a battle-start aura passive', () => {
        const state = createEncounterState({
            seed: 5,
            grid: { rows: 5, cols: 5 },
            terrainRows: Array.from({ length: 5 }, () => '.....'),
            units: [
                {
                    id: 'pc-1',
                    name: 'Aria',
                    side: 'player',
                    maxHp: 30,
                    hp: 30,
                    ac: 12,
                    attackBonus: 3,
                    attackRange: 1,
                    damage: '1',
                    skills: [{
                        id: 'battle-aura',
                        name: 'Battle Aura',
                        kind: 'special',
                        passive: true,
                        unlimited: true,
                        trigger: { event: 'battle-start', limit: 'per-encounter' },
                        effectTemplate: [{ type: 'damage', target: '$areaHostile', amount: '1' }],
                    }],
                },
                ...['Goblin', 'Goblin Archer', 'Wolf'].map((name, index) => ({
                    id: `enemy-${index + 1}`,
                    name,
                    side: 'enemy',
                    maxHp: 12,
                    hp: 12,
                    ac: 10,
                    attackBonus: 1,
                    attackRange: 1,
                    damage: '1',
                })),
            ],
        });

        for (const id of ['enemy-1', 'enemy-2', 'enemy-3']) {
            expect(getUnitById(state, id).hp).toBe(11);
        }
    });

    it('fires turn-start passives once per round and damaged passives on HP loss', () => {
        const state = createBattlefield();
        const pc = getUnitById(state, 'pc-1');
        const goblin = getUnitById(state, 'enemy-1');
        pc.x = 3; pc.y = 3;
        goblin.x = 4; goblin.y = 3;
        pc.skills = [{
            id: 'battle-focus',
            name: 'Battle Focus',
            kind: 'special',
            passive: true,
            unlimited: true,
            trigger: { event: 'turn-start', limit: 'per-round' },
            effectTemplate: [{ type: 'heal', target: '$caster', amount: '1' }],
        }];
        pc.hp = 20;

        beginRound(state, () => 0.5);
        expect(pc.hp).toBe(21);
        beginRound(state, () => 0.5);
        expect(pc.hp).toBe(22);

        goblin.skills = [{
            id: 'retaliate',
            name: 'Retaliate',
            kind: 'special',
            passive: true,
            unlimited: true,
            trigger: { event: 'damaged', limit: 'per-hit' },
            effectTemplate: [{ type: 'damage', target: '$target', amount: '1' }],
        }];
        goblin.hp = 10;
        applyAction(state, {
            type: 'attack',
            unitId: pc.id,
            targetId: goblin.id,
        }, { actorSide: 'player', rng: () => 0.5 });

        expect(pc.hp).toBe(21); // 22 - 1 retaliation
        expect(goblin.hp).toBe(9);
    });

    it('normalizes new passive events, conditions, and built-in tabletop recipes', () => {
        const trigger = normalizePassiveTrigger({
            event: 'damaged',
            limit: 'per-turn',
            condition: { variable: 'hpPct', op: 'lte', value: 50 },
        });
        expect(trigger).toMatchObject({ event: 'damaged', limit: 'per-turn' });
        expect(trigger.condition).toMatchObject({ variable: 'hpPct', op: 'lte', value: 50 });
        expect(describePassiveTrigger({ event: 'battle-start' })).toContain('battle start');

        const pack = builtinPassiveRecipe('Pack Tactics');
        expect(pack.trigger.event).toBe('hit');
        expect(pack.trigger.condition.variable).toBe('allies');
        expect(pack.effects[0].type).toBe('status');
    });

    it('treats unresolved enemy passives as pending recipes', () => {
        const context = {
            playerUnits: [],
            allies: [],
            enemies: [{
                name: 'Goblin',
                skills: [{
                    name: 'Pack Tactics',
                    passive: true,
                    effectTemplate: [],
                }],
            }],
        };
        expect(hasPendingPassiveRecipes(context)).toBe(true);
    });

    it('evaluates the same formulas in traditional theater mode', () => {
        const state = createTraditionalEncounterState({
            seed: 13,
            units: [
                {
                    id: 'pc-1',
                    name: 'Aria',
                    side: 'player',
                    maxHp: 20,
                    hp: 20,
                    ac: 10,
                    attackBonus: 30,
                    damage: '1',
                    skills: [{
                        id: 'horde-breaker',
                        name: 'Horde Breaker',
                        kind: 'attack',
                        target: 'enemy',
                        damage: '1d6 + @adjacentEnemies',
                        unlimited: true,
                        maxUses: 0,
                        uses: 0,
                    }],
                },
                {
                    id: 'enemy-1',
                    name: 'Goblin',
                    side: 'enemy',
                    maxHp: 20,
                    hp: 20,
                    ac: 5,
                    attackBonus: 0,
                    damage: '1',
                },
                {
                    id: 'enemy-2',
                    name: 'Wolf',
                    side: 'enemy',
                    maxHp: 10,
                    hp: 10,
                    ac: 5,
                    attackBonus: 0,
                    damage: '1',
                },
            ],
        });
        state.phase = 'player';

        const result = applyTraditionalAction(state, {
            type: 'skill',
            unitId: 'pc-1',
            skillId: 'horde-breaker',
            targetId: 'enemy-1',
        }, { actorSide: 'player', rng: () => 0.5 });

        expect(result.ok).toBe(true);
        expect(getUnitById(state, 'enemy-1').hp).toBe(14); // 1d6 -> 4, + 2 living enemies
    });
});
