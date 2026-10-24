import { describe, expect, it } from 'vitest';
import { getCombatMemoState } from '../src/state/combat-persistence.js';

function memo(body) {
    return `[CHARACTER]\nAria: 20/20 HP\n[/CHARACTER]\n\n[COMBAT]\n${body}\n[/COMBAT]`;
}

describe('combat engagement state', () => {
    it('distinguishes dormant, engaged, ended, and absent rosters', () => {
        expect(getCombatMemoState('')).toBe('absent');
        expect(getCombatMemoState(memo('END_COMBAT'))).toBe('ended');
        expect(getCombatMemoState(memo('COMBAT STATE: DORMANT\nCOMBAT ROUND 0\nENEMIES:\nGoblin: 8/8 HP'))).toBe('dormant');
        expect(getCombatMemoState(memo('COMBAT STATE: PARLEY\nENEMIES:\nGoblin: 8/8 HP'))).toBe('dormant');
        expect(getCombatMemoState(memo('COMBAT STATE: HOSTILE\nCOMBAT ROUND 1\nENEMIES:\nGoblin: 8/8 HP'))).toBe('engaged');
        expect(getCombatMemoState(memo('COMBAT STATE: ACTIVE\nCOMBAT ROUND 2\nENEMIES:\nGoblin: 8/8 HP'))).toBe('engaged');
    });

    it('treats COMBAT ROUND 0 as staged but legacy round blocks as engaged', () => {
        expect(getCombatMemoState(memo('COMBAT ROUND 0\nENEMIES:\nGoblin: 8/8 HP'))).toBe('dormant');
        expect(getCombatMemoState(memo('COMBAT ROUND 1\nENEMIES:\nGoblin: 8/8 HP'))).toBe('engaged');
        expect(getCombatMemoState(memo('ENEMIES:\nGoblin: 8/8 HP'))).toBe('engaged');
    });

    it('treats resolved or empty rosters as ended even when the state line is stale', () => {
        expect(getCombatMemoState(memo('COMBAT STATE: HOSTILE\nCOMBAT ROUND 3\nENEMIES:\nGoblin: 0/8 HP\nStatus: Defeated'))).toBe('ended');
        expect(getCombatMemoState(memo('COMBAT STATE: ACTIVE\nCOMBAT ROUND 3\nENEMIES:'))).toBe('ended');
        expect(getCombatMemoState(memo('COMBAT ROUND 2\nENEMIES:'))).toBe('ended');
        expect(getCombatMemoState(memo('COMBAT STATE: DORMANT\nENEMIES:\nGoblin: 0/8 HP\nStatus: Dead'))).toBe('ended');
    });

    it('recognizes terminal and idle state synonyms', () => {
        expect(getCombatMemoState(memo('COMBAT STATE: NONE\nENEMIES:\nGoblin: 8/8 HP'))).toBe('ended');
        expect(getCombatMemoState(memo('COMBAT STATE: CLEARED\nENEMIES:\nGoblin: 8/8 HP'))).toBe('ended');
        expect(getCombatMemoState(memo('COMBAT STATE: IDLE\nENEMIES:\nGoblin: 8/8 HP'))).toBe('dormant');
    });
});
