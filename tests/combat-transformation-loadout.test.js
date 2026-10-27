import { describe, expect, it } from 'vitest';
import {
    applySpecialEffects,
    createEncounterState,
    normalizeSkillList,
} from '../src/features/tactical-combat/tactical-combat-engine.js';
import {
    DEFAULT_TACTICAL_SPECIAL_RESOLUTION_PROMPT,
    DEFAULT_TRANSFORMATION_LOADOUT_PROMPT,
} from '../src/features/tactical-combat/tactical-combat-prompts.js';
import { DEFAULT_TRADITIONAL_SPECIAL_RESOLUTION_PROMPT } from '../src/features/traditional-combat/traditional-combat-prompts.js';

function makeState() {
    return createEncounterState({
        seed: 7,
        grid: { rows: 6, cols: 6 },
        terrainRows: Array.from({ length: 6 }, () => '......'),
        units: [
            {
                id: 'pc-1', name: 'Corrin', side: 'player', maxHp: 30, hp: 30, ac: 14,
                attackBonus: 5, damage: '1d8',
                skills: [
                    { id: 'dragonstone', name: 'Dragonstone Transformation', kind: 'special', maxUses: 2, uses: 2, target: 'self' },
                    { id: 'guard', name: 'Guard', kind: 'buff', maxUses: 2, uses: 2, target: 'self' },
                ],
            },
            { id: 'enemy-2', name: 'Goblin', side: 'enemy', maxHp: 10, hp: 10, ac: 11, attackBonus: 3, damage: '1d6' },
        ],
    });
}

describe('transformation replacement loadouts', () => {
    it('ships prompt guidance that asks for replacement skills', () => {
        expect(DEFAULT_TACTICAL_SPECIAL_RESOLUTION_PROMPT).toContain('2-5 complete replacement skills');
        expect(DEFAULT_TRADITIONAL_SPECIAL_RESOLUTION_PROMPT).toContain('2-5 complete replacement skills');
        expect(DEFAULT_TACTICAL_SPECIAL_RESOLUTION_PROMPT).toContain('Dragon Breath');
        expect(DEFAULT_TRADITIONAL_SPECIAL_RESOLUTION_PROMPT).toContain('Dragon Breath');
        expect(DEFAULT_TRANSFORMATION_LOADOUT_PROMPT).toContain('{"skills":[...]}');
    });

    it('normalizes generated form skills with the engine rules', () => {
        const skills = normalizeSkillList([
            { name: 'Dragon Breath', kind: 'attack', damage: '4d6', maxUses: 2 },
            { name: 'Dragon Claw', kind: 'attack', damage: '2d8+4', unlimited: true },
        ], 'player');
        expect(skills).toHaveLength(2);
        expect(skills[0]).toMatchObject({ name: 'Dragon Breath', maxUses: 2, uses: 2, unlimited: false });
        expect(skills[1]).toMatchObject({ name: 'Dragon Claw', unlimited: true, maxUses: 0, uses: 0 });
    });

    it('retains the existing loadout when a transform omits skills', () => {
        const state = makeState();
        const caster = state.units[0];
        const result = applySpecialEffects(state, [{
            type: 'transform',
            targetId: caster.id,
            name: 'Dragon Form',
            ac: 17,
            maxHp: 45,
            permanent: false,
        }], { casterId: caster.id, skillId: 'dragonstone' });

        expect(result.ok).toBe(true);
        expect(caster.name).toBe('Dragon Form');
        expect(caster.skills.map(skill => skill.name)).toEqual(['Dragonstone Transformation', 'Guard']);
    });

    it('uses provided replacement skills during the transformed form', () => {
        const state = makeState();
        const caster = state.units[0];
        const result = applySpecialEffects(state, [{
            type: 'transform',
            targetId: caster.id,
            name: 'Dragon Form',
            ac: 17,
            maxHp: 45,
            damage: '2d8+4',
            skills: [
                { name: 'Dragon Breath', kind: 'attack', damage: '4d6', maxUses: 2 },
                { name: 'Dragon Claw', kind: 'attack', damage: '2d8+4', unlimited: true },
            ],
            permanent: false,
        }], { casterId: caster.id, skillId: 'dragonstone' });

        expect(result.ok).toBe(true);
        expect(caster.skills.map(skill => skill.name)).toEqual(['Dragon Breath', 'Dragon Claw']);
        expect(caster.skills[0]).toMatchObject({ maxUses: 2, uses: 2 });
    });
});
