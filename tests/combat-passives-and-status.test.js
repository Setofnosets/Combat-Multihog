import { describe, expect, it } from 'vitest';
import {
    applyAction,
    beginRound,
    createEncounterState,
    describeUnitOptions,
    getUnitById,
} from '../src/features/tactical-combat/tactical-combat-engine.js';
import { parseStatusConditions, formatStatusLine } from '../src/features/tactical-combat/tactical-combat-status.js';
import { syncCombatResultToMemo } from '../src/features/tactical-combat/tactical-combat-memo.js';
import { parsePlayerUnits, parseXpLevel, collectEncounterContext } from '../src/features/tactical-combat/tactical-combat-context.js';
import {
    normalizeSkillRegistryEntry,
    registryEntryToDefinition,
} from '../src/features/skill-registry/skill-registry.js';

const BLOOD_BANK = {
    id: 'blood-bank',
    name: 'Blood Bank',
    kind: 'heal',
    passive: true,
    unlimited: true,
    maxUses: 0,
    uses: 0,
    description: 'Passive: each melee hit drains 1d6 HP from the target, heals half, and leaves a lingering bleed.',
    trigger: { event: 'hit', attack: 'melee', action: 'any', limit: 'per-hit' },
    effectTemplate: [
        {
            type: 'drain',
            target: '$target',
            amount: '1d6',
            resource: 'hp',
            healRatio: 0.5,
        },
        {
            type: 'status',
            target: '$target',
            label: 'Bleed',
            rounds: 1,
            damage: '1d4',
            damageResource: 'hp',
            damageType: 'Arts',
        },
    ],
};

function makePassiveState({ targetHp = 20, casterHp = 10, withPassive = true } = {}) {
    const state = createEncounterState({
        seed: 7,
        grid: { rows: 5, cols: 5 },
        terrainRows: Array.from({ length: 5 }, () => '.....'),
        units: [
            {
                id: 'pc-1',
                name: 'Entelechia',
                side: 'player',
                maxHp: 30,
                hp: casterHp,
                ac: 10,
                attackBonus: 20,
                attackRange: 1,
                damage: '1',
                skills: withPassive ? [BLOOD_BANK] : [],
            },
            {
                id: 'enemy-1',
                name: 'Goblin',
                side: 'enemy',
                maxHp: 20,
                hp: targetHp,
                ac: 10,
                attackBonus: 0,
                attackRange: 1,
                damage: '1',
            },
        ],
    });
    const pc = getUnitById(state, 'pc-1');
    const enemy = getUnitById(state, 'enemy-1');
    pc.x = 2;
    pc.y = 2;
    enemy.x = 3;
    enemy.y = 2;
    state.phase = 'player';
    return { state, pc, enemy };
}

describe('passive abilities', () => {
    it('triggers on a melee hit, drains effective HP, heals half, and applies bleed', () => {
        const { state, pc, enemy } = makePassiveState();
        const result = applyAction(state, {
            type: 'attack',
            unitId: pc.id,
            targetId: enemy.id,
        }, { actorSide: 'player', rng: () => 0.5 });

        expect(result.ok).toBe(true);
        // Base 1 damage + drain 4; target 20 -> 15. Caster heals floor(4 * 0.5).
        expect(enemy.hp).toBe(15);
        expect(pc.hp).toBe(12);
        expect(enemy.statuses).toHaveLength(1);
        expect(enemy.statuses[0]).toMatchObject({
            label: 'Bleed',
            rounds: 1,
            damage: '1d4',
            damageResource: 'hp',
            damageType: 'Arts',
            polarity: 'negative',
        });
        expect(formatStatusLine(enemy.statuses)).toBe('(-) Bleed (1d4 Arts damage per turn, 1 turn)');
    });

    it('does not heal from drain overkill damage', () => {
        const { state, pc, enemy } = makePassiveState({ targetHp: 2, casterHp: 10 });
        applyAction(state, {
            type: 'attack',
            unitId: pc.id,
            targetId: enemy.id,
        }, { actorSide: 'player', rng: () => 0.5 });

        // Base hit leaves 1 HP. The 1d6 drain only removes 1 effective HP.
        expect(enemy.defeated).toBe(true);
        expect(enemy.hp).toBe(0);
        expect(pc.hp).toBe(10);
    });

    it('ticks a lingering bleed at the next round and then removes it', () => {
        const { state, enemy } = makePassiveState();
        applyAction(state, {
            type: 'attack',
            unitId: 'pc-1',
            targetId: enemy.id,
        }, { actorSide: 'player', rng: () => 0.5 });
        expect(enemy.hp).toBe(15);

        beginRound(state, () => 0.5);
        // 1d4 bleed with this RNG rolls 3 and expires after ticking.
        expect(enemy.hp).toBe(12);
        expect(enemy.statuses).toHaveLength(0);
    });

    it('is not offered as an active skill or action target', () => {
        const { state, pc, enemy } = makePassiveState();
        const options = describeUnitOptions(state, pc);
        expect(options.skillTargets['blood-bank']).toBeUndefined();

        const result = applyAction(state, {
            type: 'skill',
            unitId: pc.id,
            skillId: 'blood-bank',
            targetId: enemy.id,
        }, { actorSide: 'player', rng: () => 0.5 });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/passive/i);
    });

    it('keeps a one-round control status through the affected turn', () => {
        const { state, enemy } = makePassiveState({ withPassive: false });
        enemy.statuses = [{
            id: 'stunned',
            label: 'Stunned',
            behavior: 'stunned',
            rounds: 1,
            stacks: 1,
            maxStacks: 1,
            damage: '',
        }];
        beginRound(state, () => 0.5);
        expect(enemy.statuses[0]).toMatchObject({ label: 'Stunned', expiresAfterTurn: true });
        beginRound(state, () => 0.5);
        expect(enemy.statuses).toHaveLength(0);
    });

    it('applies a non-special attack skill effectTemplate on hit', () => {
        const { state, pc, enemy } = makePassiveState({ withPassive: false });
        pc.skills = [{
            id: 'bleeding-strike',
            name: 'Bleeding Strike',
            kind: 'attack',
            range: 1,
            damage: '1',
            unlimited: true,
            effectTemplate: [{
                type: 'status',
                target: '$target',
                label: 'Bleed',
                rounds: 1,
                damage: '1d4',
                damageResource: 'hp',
            }],
        }];

        const result = applyAction(state, {
            type: 'skill',
            unitId: pc.id,
            skillId: 'bleeding-strike',
            targetId: enemy.id,
        }, { actorSide: 'player', rng: () => 0.5 });

        expect(result.ok).toBe(true);
        expect(enemy.statuses.find(status => status.label === 'Bleed')).toBeTruthy();
    });
});

describe('status memo round-trip', () => {
    it('parses duration, damage type, and polarity from tracker text', () => {
        const parsed = parseStatusConditions('(-) Bleed (1d4 Arts damage per turn, 1 turn), (+) Heroism (+2 attack, 3 turns)');
        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toMatchObject({
            label: 'Bleed',
            rounds: 1,
            damage: '1d4',
            damageType: 'Arts',
            damageResource: 'hp',
            polarity: 'negative',
        });
        expect(parsed[1]).toMatchObject({
            label: 'Heroism',
            rounds: 3,
            attackBonus: 2,
            polarity: 'positive',
        });
        expect(formatStatusLine(parsed)).toContain('(-) Bleed (1d4 Arts damage per turn, 1 turn)');
    });

    it('writes surviving conditions back to CHARACTER without deleting unrelated ones', () => {
        const { state, pc, enemy } = makePassiveState();
        applyAction(state, {
            type: 'attack',
            unitId: pc.id,
            targetId: enemy.id,
        }, { actorSide: 'player', rng: () => 0.5 });
        state.units.find(unit => unit.id === 'pc-1').statuses.push({
            id: 'inspired',
            label: 'Inspired',
            rounds: 2,
            attackBonus: 1,
            polarity: 'positive',
        });

        const settings = {
            currentMemo: '[CHARACTER]\nEntelechia (Fighter): 10/30 HP\nStatus: (-) Poisoned (1d4 damage per turn, 2 turns)\n[/CHARACTER]',
        };
        state.units.find(unit => unit.id === 'pc-1').statuses.push({
            id: 'bleed',
            label: 'Bleed',
            rounds: 1,
            damage: '1d4',
            damageResource: 'hp',
            damageType: 'Arts',
        });
        syncCombatResultToMemo(state, settings);

        expect(settings.currentMemo).toContain('Entelechia (Fighter): 12/30 HP');
        expect(settings.currentMemo).toContain('Poisoned');
        expect(settings.currentMemo).toContain('Inspired');
        expect(settings.currentMemo).toContain('Bleed');
    });

    it('re-imports a persisted bleed when the next encounter is built', () => {
        const memo = `[CHARACTER]
Entelechia (Fighter): 12/30 HP
Status: (-) Bleed (1d4 Arts damage per turn, 1 turn)
[/CHARACTER]`;
        const [unit] = parsePlayerUnits(memo, { name1: 'Entelechia' });
        expect(unit.statuses[0]).toMatchObject({
            label: 'Bleed',
            rounds: 1,
            damage: '1d4',
            damageType: 'Arts',
        });

        const state = createEncounterState({
            seed: 3,
            grid: { rows: 5, cols: 5 },
            terrainRows: Array.from({ length: 5 }, () => '.....'),
            units: [
                { ...unit, id: 'pc-1', side: 'player' },
                { id: 'enemy-1', name: 'Goblin', side: 'enemy', maxHp: 10, hp: 10, ac: 10, damage: '1' },
            ],
        });
        const pc = getUnitById(state, 'pc-1');
        // A carried condition ticks once at the start of round 1, then expires.
        expect(pc.hp).toBeLessThan(12);
        expect(pc.statuses).toHaveLength(0);
    });
});

describe('character level from [XP]', () => {
    it('reads both XP level formats', () => {
        expect(parseXpLevel('[XP]\nLevel: 7 | XP: 23,000/34,000\n[/XP]')).toBe(7);
        expect(parseXpLevel('[XP]\nTotal: 23,000 / 34,000 XP (Level 7)\n[/XP]')).toBe(7);
    });

    it('uses the tracker level instead of the HP/12 heuristic', () => {
        const memo = `[CHARACTER]
Aria (Fighter): 45/45 HP
Status: Healthy
[/CHARACTER]

[XP]
Level: 7 | XP: 23,000/34,000
[/XP]`;
        const [unit] = parsePlayerUnits(memo, { name1: 'Aria' });
        expect(unit.level).toBe(7);
    });
});

describe('passive registry normalization', () => {
    it('detects a passive from the brief and preserves the trigger/recipe', () => {
        const entry = normalizeSkillRegistryEntry({
            name: 'Blood Bank',
            type: 'ability',
            brief: 'Passive: each melee hit drains 1d6 HP and causes a lingering bleed.',
            mechanics: {
                kind: 'heal',
                heal: '1d6',
                maxUses: 0,
                unlimited: true,
            },
        });
        expect(entry.mechanics.passive).toBe(true);
        expect(entry.mechanics.unlimited).toBe(true);
        expect(entry.mechanics.maxUses).toBe(0);
        expect(entry.effectSummary).toContain('Passive');

        const definition = registryEntryToDefinition(entry);
        expect(definition.passive).toBe(true);
        expect(definition.trigger.event).toBe('hit');
    });

    it('attaches an owned registry passive that is missing from [ABILITIES]', () => {
        const entry = normalizeSkillRegistryEntry({
            name: 'Blood Bank',
            type: 'ability',
            brief: 'Passive: each melee hit drains 1d6 HP and causes a lingering bleed.',
            owners: [{ type: 'character', name: 'Entelechia' }],
            mechanics: {
                kind: 'heal',
                heal: '1d6',
                passive: true,
                trigger: { event: 'hit', attack: 'melee', action: 'any', limit: 'per-hit' },
                effectTemplate: BLOOD_BANK.effectTemplate,
                maxUses: 0,
                unlimited: true,
            },
        });
        const memo = `[CHARACTER]
Entelechia (Reaper): 30/30 HP
Status: Healthy
[/CHARACTER]`;
        const context = collectEncounterContext({
            currentMemo: memo,
            skillRegistry: {
                version: 2,
                skills: { 'blood-bank': entry },
                forms: {},
                classes: {},
                updatedAt: 0,
            },
        }, { name1: 'Entelechia', chatId: 'passive-attach', chat: [] });

        const bloodBank = context.playerUnits[0].skills.find(skill => skill.name === 'Blood Bank');
        expect(bloodBank).toMatchObject({
            passive: true,
            unlimited: true,
            maxUses: 0,
            uses: 0,
        });
        expect(bloodBank.trigger).toMatchObject({ event: 'hit', attack: 'melee' });
        expect(bloodBank.effectTemplate[0].type).toBe('drain');
    });
});
