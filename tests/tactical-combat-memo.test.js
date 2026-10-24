import { describe, expect, it } from 'vitest';
import {
    buildCombatMemoBlock,
    buildCombatTrackerReport,
    clearStaleCombatMemo,
    patchPartyMemoFromBoard,
    seedCombatMemo,
    syncCombatResultToMemo,
} from '../src/features/tactical-combat/tactical-combat-memo.js';
import { createEncounterState } from '../src/features/tactical-combat/tactical-combat-engine.js';
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
