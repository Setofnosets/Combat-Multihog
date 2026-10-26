import { describe, expect, it } from 'vitest';
import {
    combatBoardPhase,
    isNarrativeCombatMode,
    isTacticalCombatMode,
    hasActiveCombatBoard,
    isTraditionalCombatMode,
    listActiveCombatBoards,
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

    it('ignores lifecycle markers left behind by a previous page session', () => {
        const hourAgo = Date.now() - 60 * 60 * 1000;
        // A finished fight still blocks: the board is genuinely running.
        expect(hasActiveCombatBoard({ tacticalCombatByChat: { a: { status: 'active', updatedAt: hourAgo } } })).toBe(true);
        // Preparations and narrator handoffs cannot survive a reload.
        expect(hasActiveCombatBoard({
            tacticalCombatByChat: { a: { status: 'active', preparing: { active: true, startedAt: hourAgo } } },
        })).toBe(true);
        expect(hasActiveCombatBoard({
            traditionalCombatByChat: { b: { preparing: { active: true, startedAt: hourAgo } } },
        })).toBe(false);
        expect(hasActiveCombatBoard({
            tacticalCombatByChat: { c: { finalization: { finalizing: true, finalizingStartedAt: hourAgo } } },
        })).toBe(false);
    });

    it('keeps a preparation started in this page session blocking while it is plausibly running', () => {
        const now = 5_000_000;
        const fresh = { preparing: { active: true, startedAt: now - 30_000 } };
        expect(combatBoardPhase(fresh, { now, sessionStartedAt: 0 })).toBe('preparing');
        const expired = { preparing: { active: true, startedAt: now - 16 * 60 * 1000 } };
        expect(combatBoardPhase(expired, { now, sessionStartedAt: 0 })).toBe('idle');
    });

    it('expires a stuck finalizing marker after 90 seconds', () => {
        const now = 5_000_000;
        const finishing = { finalization: { finalizing: true, finalizingStartedAt: now - 10_000 } };
        expect(combatBoardPhase(finishing, { now, sessionStartedAt: 0 })).toBe('finalizing');
        expect(combatBoardPhase(finishing, { now: now + 120_000, sessionStartedAt: 0 })).toBe('idle');
    });

    it('classifies boards for the settings list, newest first', () => {
        const settings = {
            tacticalCombatByChat: {
                'Old Hero - 2026-1-1': { status: 'active', round: 4, title: 'Gate ambush', updatedAt: 10 },
                'Old Hero - 2026-1-2': { status: 'victory', updatedAt: 30 },
            },
            traditionalCombatByChat: {
                'Other Hero - 2026-1-3': { preparing: { active: true }, updatedAt: 20 },
            },
        };
        const boards = listActiveCombatBoards(settings);
        expect(boards.map(board => [board.chatId, board.style, board.phase])).toEqual([
            ['Other Hero - 2026-1-3', 'traditional', 'preparing'],
            ['Old Hero - 2026-1-1', 'tactical', 'active'],
        ]);
        const fight = boards.find(board => board.phase === 'active');
        expect(fight.round).toBe(4);
        expect(fight.title).toBe('Gate ambush');
    });
});
