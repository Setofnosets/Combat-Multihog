import { describe, expect, it } from 'vitest';
import * as ui from '../src/features/tactical-combat/tactical-combat-ui.js';

describe('tactical combat UI module', () => {
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
