import { describe, expect, it } from 'vitest';
import * as ui from '../src/features/tactical-combat/tactical-combat-ui.js';
import { createEncounterState } from '../src/features/tactical-combat/tactical-combat-engine.js';

function makeViewState() {
    const state = createEncounterState({
        seed: 7,
        grid: { rows: 8, cols: 8 },
        terrainRows: Array.from({ length: 8 }, () => '........'),
        turnStyle: 'phase',
        units: [
            { id: 'pc-1', name: 'Aria', side: 'player', maxHp: 24, hp: 24, ac: 14, attackBonus: 5, damage: '1d8+2' },
            { id: 'pc-2', name: 'Borin', side: 'player', maxHp: 24, hp: 24, ac: 14, attackBonus: 5, damage: '1d8+2' },
            { id: 'enemy-1', name: 'Goblin A', side: 'enemy', maxHp: 12, hp: 12, ac: 11, attackBonus: 3, damage: '1d6' },
            { id: 'enemy-2', name: 'Goblin B', side: 'enemy', maxHp: 12, hp: 12, ac: 11, attackBonus: 3, damage: '1d6' },
        ],
    });
    const positions = {
        'pc-1': [1, 1],
        'pc-2': [1, 2],
        'enemy-1': [3, 1],
        'enemy-2': [3, 2],
    };
    for (const unit of state.units) {
        const [x, y] = positions[unit.id];
        unit.x = x;
        unit.y = y;
        unit.skills = [];
    }
    state.units[0].skills.push({
        id: 'fireball', name: 'Fireball', kind: 'attack', range: 6, damage: '2d6', uses: 2, maxUses: 2,
        area: { shape: 'burst', radius: 1, origin: 'target', friendlyFire: false },
    }, {
        id: 'rally', name: 'Rallying Aura', kind: 'heal', heal: '1d8+2', range: 0, uses: 1, maxUses: 1,
        area: { shape: 'burst', radius: 2, origin: 'self', friendlyFire: false },
    });
    return state;
}

describe('tactical combat UI module', () => {
    it('builds range, anchor, target, and self-aura preview data', () => {
        const state = makeViewState();
        const view = ui.buildTacticalView(state, { selectedUnitId: 'pc-1', mode: 'skill', selectedSkillId: 'fireball' });
        expect(view.area).toMatchObject({ shape: 'burst', radius: 1, origin: 'target' });
        expect(view.rangeCells.has('3,1')).toBe(true);
        expect(view.anchorCells.has('4,1')).toBe(true);
        expect(view.targetCells.has('3,1')).toBe(true);
        expect(view.targetCells.has('3,2')).toBe(true);
        expect(view.targetHint).toMatch(/Burst 1/);

        const aura = ui.buildTacticalView(state, { selectedUnitId: 'pc-1', mode: 'skill', selectedSkillId: 'rally' });
        expect(aura.aoePreview).toMatchObject({ kind: 'support' });
        expect(aura.aoePreview.cells.has('1,1')).toBe(true);
        expect(aura.aoePreview.targetCells.has('1,1')).toBe(true);
        expect(aura.aoePreview.targetCells.has('1,2')).toBe(true);
    });


    it('exports the narrator, board, and lifecycle entry points without touching the DOM at import time', () => {
        expect(typeof ui.startTacticalCombatFromNarrator).toBe('function');
        expect(typeof ui.startTacticalCombatFlow).toBe('function');
        expect(typeof ui.openTacticalCombatBoard).toBe('function');
        expect(typeof ui.onTacticalCombatChatChanged).toBe('function');
        expect(typeof ui.liveUnitAtCell).toBe('function');
    });

    it('ignores defeated combatants when resolving a tile click', () => {
        const defeated = { id: 'dead', x: 1, y: 1, defeated: true, fled: false };
        const live = { id: 'live', x: 1, y: 1, defeated: false, fled: false };
        expect(ui.liveUnitAtCell({ units: [defeated, live] }, 1, 1)).toBe(live);
        expect(ui.liveUnitAtCell({ units: [defeated] }, 1, 1)).toBe(null);
        expect(ui.liveUnitAtCell({ units: [{ ...live, fled: true }] }, 1, 1)).toBe(null);
    });
});
