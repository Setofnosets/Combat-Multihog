import { describe, expect, it } from 'vitest';
import {
    isNarrativeCombatMode,
    isTacticalCombatMode,
    hasActiveCombatBoard,
    isTraditionalCombatMode,
    resolveCombatStyle,
    setCombatStyle,
} from '../src/features/combat/combat-mode.js';

describe('combat mode resolution', () => {
    it('resolves legacy tactical settings when no explicit style exists', () => {
        expect(resolveCombatStyle({})).toBe('narrative');
        expect(resolveCombatStyle({ tacticalCombatEnabled: true })).toBe('tactical');
        expect(resolveCombatStyle({ combatStyle: 'traditional', tacticalCombatEnabled: true })).toBe('traditional');
    });

    it('keeps the legacy tactical flag in sync when setting a style', () => {
        const settings = {};
        expect(setCombatStyle(settings, 'tactical')).toBe('tactical');
        expect(settings.tacticalCombatEnabled).toBe(true);
        expect(isTacticalCombatMode(settings)).toBe(true);

        setCombatStyle(settings, 'traditional');
        expect(settings.tacticalCombatEnabled).toBe(false);
        expect(isTraditionalCombatMode(settings)).toBe(true);
        expect(isNarrativeCombatMode(settings)).toBe(false);

        setCombatStyle(settings, 'narrative');
        expect(settings.tacticalCombatEnabled).toBe(false);
        expect(isNarrativeCombatMode(settings)).toBe(true);
    });

    it('falls back to narrative for invalid explicit styles', () => {
        const settings = { combatStyle: 'nonsense', tacticalCombatEnabled: true };
        expect(resolveCombatStyle(settings)).toBe('tactical');
        setCombatStyle(settings, 'nonsense');
        expect(settings.combatStyle).toBe('narrative');
    });
});

describe('combat style switching guard', () => {
    it('detects active, preparing, and finalizing boards across both stores', () => {
        expect(hasActiveCombatBoard({})).toBe(false);
        expect(hasActiveCombatBoard({ tacticalCombatByChat: { a: { status: 'ended' } } })).toBe(false);
        expect(hasActiveCombatBoard({ tacticalCombatByChat: { a: { status: 'active' } } })).toBe(true);
        expect(hasActiveCombatBoard({ traditionalCombatByChat: { b: { preparing: { active: true } } } })).toBe(true);
        expect(hasActiveCombatBoard({ tacticalCombatByChat: { c: { finalization: { finalizing: true } } } })).toBe(true);
    });
});
