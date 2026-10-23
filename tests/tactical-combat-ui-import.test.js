import { describe, expect, it } from 'vitest';
import * as ui from '../src/features/tactical-combat/tactical-combat-ui.js';

describe('tactical combat UI module', () => {
    it('exports the narrator, board, and lifecycle entry points without touching the DOM at import time', () => {
        expect(typeof ui.startTacticalCombatFromNarrator).toBe('function');
        expect(typeof ui.startTacticalCombatFlow).toBe('function');
        expect(typeof ui.openTacticalCombatBoard).toBe('function');
        expect(typeof ui.onTacticalCombatChatChanged).toBe('function');
    });
});
