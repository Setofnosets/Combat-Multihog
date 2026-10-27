import { describe, expect, it } from 'vitest';
import {
    buildCombatMemoBlock,
    buildCombatTrackerReport,
    clearStaleCombatMemo,
    patchPartyMemoFromBoard,
    seedCombatMemo,
    syncCombatResultToMemo,
} from '../src/features/tactical-combat/tactical-combat-memo.js';
import {
    applySpecialEffects,
    createEncounterState,
    restoreCombatScopedState,
} from '../src/features/tactical-combat/tactical-combat-engine.js';
import { parseCombatUnits } from '../src/features/tactical-combat/tactical-combat-context.js';

function makeState() {
    return createEncounterState({
        chatId: 'chat-A',
        seed: 9,
        grid: { rows: 6, cols: 6 },
        terrainRows: Array.from({ length: 6 }, () => '......'),
        units: [
            { id: 'pc-1', name: 'Aria', side: 'player', maxHp: 20, hp: 14, ac: 13, attackBonus: 5, damage: '1d8+2' },
            { id: 'pc-2', name: 'Mira', side: 'player', maxHp: 18, hp: 18, ac: 12, attackBonus: 4, damage: '1d10' },
            { id: 'enemy-3', name: 'Goblin Archer', side: 'enemy', maxHp: 12, hp: 7, ac: 13, attackBonus: 5, damage: '1d6+2', attackRange: 6 },
        ],
    });
}

describe('tactical combat memo synchronization', () => {
    it('seeds a missing COMBAT block from the board roster', () => {
        const state = makeState();
        const settings = { currentMemo: '[CHARACTER]\nAria: 14/20 HP\n[/CHARACTER]' };
        const memo = seedCombatMemo(state, settings);
        expect(memo).toContain('[COMBAT]');
        expect(memo).toContain('ENEMIES:');
        expect(memo).toContain('Goblin Archer: 7/12 HP');
        expect(memo).toContain('Aria: 14/20 HP');
        expect(buildCombatMemoBlock(state)).toContain('COMBAT ROUND 1');
    });

    it('produces a COMBAT block that the memo parser can read back', () => {
        const state = makeState();
        const { enemies } = parseCombatUnits(buildCombatMemoBlock(state));
        expect(enemies.map(unit => unit.name)).toEqual(['Goblin Archer']);
        expect(enemies[0].hp).toBe(7);
        expect(enemies[0].maxHp).toBe(12);
        expect(enemies[0].attackBonus).toBe(5);
        expect(enemies[0].damage).toBe('1d6+2');
    });

    it('patches party HP by name and {{user}} fallback without touching other sections', () => {
        const state = makeState();
        const memo = `[CHARACTER]
{{user}} (Fighter): 20/20 HP
Status: Healthy
[/CHARACTER]

[PARTY]
Mira (Wizard): 18/18 HP
Status: Healthy
[/PARTY]

[EVENT]
Unchanged | keep me
[/EVENT]`;
        const patched = patchPartyMemoFromBoard(memo, state);
        expect(patched).toContain('{{user}} (Fighter): 14/20 HP');
        expect(patched).toContain('Mira (Wizard): 18/18 HP');
        expect(patched).toContain('Unchanged | keep me');
    });

    it('closes combat and patches final HP before narration', () => {
        const state = makeState();
        state.units.find(unit => unit.id === 'enemy-3').defeated = true;
        state.units.find(unit => unit.id === 'enemy-3').hp = 0;
        const settings = {
            currentMemo: '[CHARACTER]\nAria: 20/20 HP\n[/CHARACTER]\n[COMBAT]\nGoblin Archer: 12/12 HP\n[/COMBAT]',
            combatDefeatedUi: [{ name: 'old' }],
        };
        const result = syncCombatResultToMemo(state, settings);
        expect(result.changed).toBe(true);
        expect(settings.currentMemo).toContain('[COMBAT]END_COMBAT[/COMBAT]');
        expect(settings.currentMemo).toContain('Aria: 14/20 HP');
        expect(settings.currentMemo).not.toContain('Goblin Archer: 12/12 HP');
        expect(state.finalization.memoSynced).toBe(true);
        expect(settings.combatDefeatedUi).toEqual([]);
    });

    it('clears archived or matching stale COMBAT blocks before a new encounter', () => {
        const oldState = makeState();
        const settings = {
            currentMemo: '[CHARACTER]\nAria: 20/20 HP\n[/CHARACTER]\n[COMBAT]\nGoblin Archer: 12/12 HP\n[/COMBAT]',
        };
        expect(clearStaleCombatMemo(oldState, settings).removed).toBe(true);
        expect(settings.currentMemo).not.toContain('[COMBAT]');

        const ended = { currentMemo: '[COMBAT]END_COMBAT[/COMBAT]' };
        expect(clearStaleCombatMemo(null, ended).removed).toBe(true);
        expect(ended.currentMemo).toBe('');

        const fresh = {
            currentMemo: '[COMBAT]\nHobgoblin: 20/20 HP\n[/COMBAT]',
        };
        expect(clearStaleCombatMemo(oldState, fresh).removed).toBe(false);
        expect(fresh.currentMemo).toContain('Hobgoblin');
    });

    it('round-trips Willpower and restores it to max when combat ends', () => {
        const state = makeState();
        const enemy = state.units.find(unit => unit.id === 'enemy-3');
        enemy.willpower = 2;
        const block = buildCombatMemoBlock(state);
        expect(block).toContain('Willpower: 2/');
        const parsed = parseCombatUnits(block).enemies[0];
        expect(parsed.maxWillpower).toBe(enemy.maxWillpower);
        expect(parsed.willpower).toBe(2);

        const settings = {
            currentMemo: `[CHARACTER]\nAria: 14/20 HP\nWillpower: 2/12\n[/CHARACTER]\n[COMBAT]\nGoblin Archer: 7/12 HP\n[/COMBAT]`,
        };
        syncCombatResultToMemo(state, settings);
        expect(settings.currentMemo).toContain('Willpower: 8/8');
        expect(settings.currentMemo).toContain('[COMBAT]END_COMBAT[/COMBAT]');
    });

    it('writes an active combat state into the board-generated memo block', () => {
        const state = makeState();
        const block = buildCombatMemoBlock(state);
        expect(block).toContain('COMBAT STATE: ACTIVE');
        expect(block).toContain('COMBAT ROUND 1');
    });

    it('can keep current Willpower when recovery is disabled', () => {
        const state = makeState();
        const aria = state.units.find(unit => unit.id === 'pc-1');
        aria.maxWillpower = 8;
        aria.willpower = 3;
        const settings = {
            currentMemo: '[CHARACTER]\nAria: 14/20 HP\nWillpower: 3/8\n[/CHARACTER]',
            tacticalCombatWillpowerRecoverAfterCombat: false,
        };
        syncCombatResultToMemo(state, settings);
        expect(settings.currentMemo).toContain('Willpower: 3/8');
        expect(settings.currentMemo).not.toContain('Willpower: 8/8');
    });

    it('builds a compact tracker final-state report with all sides and resources', () => {
        const state = makeState();
        state.status = 'victory';
        state.outcome = {
            label: 'Victory',
            highlights: ['Goblin Archer is defeated.'],
        };
        state.opening = { text: 'Aria fires an arrow', resolved: true };
        const report = buildCombatTrackerReport(state);
        expect(report).toContain('TACTICAL COMBAT FINAL STATE');
        expect(report).toContain('[Player] Aria: 14/20 HP');
        expect(report).toContain('[Enemy] Goblin Archer: 7/12 HP');
        expect(report).toContain('Opening action: Aria fires an arrow');
        expect(report).toContain('Do not re-adjudicate');
    });
});

describe('combat resource writeback', () => {
    function resourceState() {
        const state = createEncounterState({
            chatId: 'chat-A',
            seed: 12,
            grid: { rows: 6, cols: 6 },
            terrainRows: Array.from({ length: 6 }, () => '......'),
            units: [
                {
                    id: 'pc-1', name: 'Aria', side: 'player', isPlayerCharacter: true,
                    maxHp: 20, hp: 12, ac: 13, attackBonus: 5, damage: '1d8+2',
                    skills: [
                        { id: 'missile', name: 'Magic Missile', kind: 'attack', spell: true, slotLevel: 1, slotKey: 'spell-1', damage: '1d4+1', uses: 1, maxUses: 2 },
                        { id: 'shield', name: 'Shield', kind: 'buff', spell: true, slotLevel: 1, slotKey: 'spell-1', target: 'self', uses: 1, maxUses: 2 },
                        { id: 'surge', name: 'Action Surge', kind: 'buff', uses: 0, maxUses: 1, description: 'Extra action; 1/1 per rest' },
                        { id: 'lie', name: 'Silver Tongue', unlimited: true, uses: 0, maxUses: 0, description: 'A quick lie' },
                    ],
                    items: [{ id: 'potion', name: 'Healing Potion', kind: 'heal', amount: '2d4+2', uses: 1, maxUses: 2 }],
                },
                { id: 'enemy-2', name: 'Goblin', side: 'enemy', maxHp: 8, hp: 0, ac: 11, attackBonus: 3, damage: '1d6' },
            ],
        });
        state.units[1].defeated = true;
        state.status = 'victory';
        state.outcome = { label: 'Victory', summary: 'The goblin falls.' };
        return state;
    }

    it('writes shared spell slots, ability uses, and item quantities back to the memo', () => {
        const state = resourceState();
        state.terrain = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 'floor'));
        const settings = {
            currentMemo: `[CHARACTER]
Aria (Fighter): 20/20 HP
Abilities: Action Surge (Extra action; 1/1 per rest), Silver Tongue (A quick lie)
Spells: Level 1 (2/2): Magic Missile, Shield
Status: Healthy
[/CHARACTER]

[INVENTORY]
- Healing Potion x2 [restores 2d4+2]
[/INVENTORY]`,
        };
        syncCombatResultToMemo(state, settings);
        expect(settings.currentMemo).toContain('Aria (Fighter): 12/20 HP');
        expect(settings.currentMemo).toContain('Level 1 (1/2): Magic Missile, Shield');
        expect(settings.currentMemo).toContain('Action Surge (Extra action; 0/1 per rest)');
        expect(settings.currentMemo).toContain('Silver Tongue (A quick lie)');
        expect(settings.currentMemo).toContain('- Healing Potion x1');
    });

    it('writes spent uses back to standalone abilities after a temporary self-transformation', () => {
        const state = createEncounterState({
            chatId: 'chat-A',
            seed: 21,
            grid: { rows: 6, cols: 6 },
            terrainRows: Array.from({ length: 6 }, () => '......'),
            units: [
                {
                    id: 'pc-1', name: 'Corrin', side: 'player', isPlayerCharacter: true,
                    maxHp: 30, hp: 30, ac: 14, attackBonus: 5, damage: '1d8',
                    skills: [{
                        id: 'dragonstone', name: 'Dragonstone Transformation', kind: 'special',
                        description: 'Assume a dragon form; 2/2 per long rest', range: 0, target: 'self',
                        maxUses: 2, uses: 2,
                    }],
                },
                { id: 'enemy-2', name: 'Goblin', side: 'enemy', maxHp: 8, hp: 8, ac: 11, attackBonus: 3, damage: '1d6' },
            ],
        });
        const applied = applySpecialEffects(state, [{
            type: 'transform',
            targetId: 'pc-1',
            name: 'Dragon Form',
            ac: 17,
            maxHp: 45,
            damage: '2d8+4',
            skills: [{ id: 'dragon-breath', name: 'Dragon Breath', kind: 'attack', damage: '4d6', maxUses: 2 }],
            permanent: false,
        }], { casterId: 'pc-1', skillId: 'dragonstone' });
        expect(applied.ok).toBe(true);
        restoreCombatScopedState(state);

        const settings = {
            currentMemo: `[CHARACTER]
Corrin (Manakete): 30/30 HP
Abilities: None declared
Status: Healthy
[/CHARACTER]

[ABILITIES]
- Dragonstone Transformation (Assume a dragon form; 2/2 per long rest)
[/ABILITIES]`,
        };
        syncCombatResultToMemo(state, settings);
        expect(settings.currentMemo).toContain('Dragonstone Transformation (Assume a dragon form; 1/2 per long rest)');
    });

    it('inserts a terminal Status when the memo entry has no Status line', () => {
        const state = resourceState();
        state.terrain = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 'floor'));
        const aria = state.units[0];
        aria.fled = true;
        aria.willpowerBroken = true;
        aria.willpower = 0;
        const settings = {
            currentMemo: `[CHARACTER]
Aria (Fighter): 12/20 HP
Willpower: 0/8
[/CHARACTER]`,
            tacticalCombatWillpowerRecoverAfterCombat: true,
        };
        syncCombatResultToMemo(state, settings);
        expect(settings.currentMemo).toContain('Status: Fled (Willpower broken)');
        expect(settings.currentMemo).toContain('Willpower: 0/8');
    });

    it('does not restore Willpower for a defeated unit', () => {
        const state = resourceState();
        state.terrain = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 'floor'));
        const aria = state.units[0];
        aria.defeated = true;
        aria.defeatCause = 'willpower';
        aria.willpower = 0;
        aria.maxWillpower = 8;
        const settings = {
            currentMemo: `[CHARACTER]
Aria (Fighter): 12/20 HP
Willpower: 0/8
Status: Healthy
[/CHARACTER]`,
        };
        syncCombatResultToMemo(state, settings);
        expect(settings.currentMemo).toContain('Status: Defeated (Willpower broken)');
        expect(settings.currentMemo).toContain('Willpower: 0/8');
    });

    it('includes the resource ledger in the authoritative tracker report', () => {
        const state = resourceState();
        state.terrain = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 'floor'));
        const report = buildCombatTrackerReport(state);
        expect(report).toContain('Resource ledger:');
        expect(report).toContain('Aria: L1 1/2');
        expect(report).toContain('Action Surge 0/1');
        expect(report).toContain('Healing Potion 1/2');
    });
});
