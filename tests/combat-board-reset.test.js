import { describe, expect, it } from 'vitest';
import { clearActiveCombatEncounters } from '../src/features/combat/combat-board-reset.js';
import { hasActiveCombatBoard } from '../src/features/combat/combat-mode.js';

describe('clearing open combat encounters', () => {
    it('removes running boards in other chats and keeps finished ones', () => {
        const settings = {
            tacticalCombatByChat: {
                // The active chat keeps a finished board: its outcome is still shown.
                'vitest-chat': { status: 'victory', units: [], updatedAt: 40 },
                'other-chat': { status: 'active', units: [], updatedAt: 30 },
            },
            traditionalCombatByChat: {
                'third-chat': { preparing: { active: true, startedAt: Date.now() }, units: [] },
            },
            tacticalCombatReturnByChat: { 'other-chat': { chatId: 'other-chat' } },
        };

        const result = clearActiveCombatEncounters(settings);

        expect(result.cleared).toBe(2);
        expect(result.chatIds).toEqual(['other-chat', 'third-chat']);
        expect(settings.tacticalCombatByChat['other-chat']).toBeUndefined();
        expect(settings.traditionalCombatByChat['third-chat']).toBeUndefined();
        expect(settings.tacticalCombatByChat['vitest-chat'].status).toBe('victory');
        expect(settings.tacticalCombatReturnByChat['other-chat']).toBeUndefined();
        expect(hasActiveCombatBoard(settings)).toBe(false);
    });

    it('leaves stale markers alone once they no longer block', () => {
        const settings = {
            tacticalCombatByChat: {
                'old-chat': { preparing: { active: true, startedAt: Date.now() - 60 * 60 * 1000 } },
            },
        };
        expect(clearActiveCombatEncounters(settings).cleared).toBe(0);
        expect(settings.tacticalCombatByChat['old-chat']).toBeTruthy();
    });

    it('is a no-op without settings', () => {
        expect(clearActiveCombatEncounters(null)).toEqual({ cleared: 0, chatIds: [] });
    });
});
