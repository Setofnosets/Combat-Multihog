import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../portrait-storage.js', () => ({
    lookupCustomPortraitSrc: () => '',
}));

import { getSettings } from '../state-manager.js';
import { mergeMemo } from '../memo-processor.js';

const ACTIVE = `[CHARACTER]
Aria: 20/20 HP
[/CHARACTER]

[COMBAT]
COMBAT STATE: HOSTILE
COMBAT ROUND 2
ENEMIES:
Goblin: 8/8 HP
Status: Healthy
Wolf: 10/10 HP
Status: Healthy
[/COMBAT]`;

describe('combat resolution cleanup', () => {
    beforeEach(() => {
        getSettings().combatDefeatedUi = [];
    });

    it('removes a dormant encounter when END_COMBAT is emitted', () => {
        const dormant = `[COMBAT]
COMBAT STATE: DORMANT
ENEMIES:
Goblin: 8/8 HP
Status: Healthy
[/COMBAT]`;
        const merged = mergeMemo(dormant, '[COMBAT]END_COMBAT[/COMBAT]');
        expect(merged).not.toContain('[COMBAT]');
    });

    it('accepts END_COMBAT with an explanation as a removal marker', () => {
        const merged = mergeMemo(ACTIVE, `[COMBAT]
END_COMBAT
The goblins flee into the trees.
[/COMBAT]`);
        expect(merged).not.toContain('[COMBAT]');
        expect(getSettings().combatDefeatedUi).toEqual([]);
    });

    it('closes the block automatically when every previously active enemy is resolved', () => {
        const merged = mergeMemo(ACTIVE, `[COMBAT]
COMBAT STATE: HOSTILE
COMBAT ROUND 3
ENEMIES:
Goblin: 0/8 HP
Status: Defeated
Wolf: 0/10 HP
Status: Dead
[/COMBAT]`);
        expect(merged).not.toContain('[COMBAT]');
        expect(getSettings().combatDefeatedUi).toEqual([]);
    });

    it('keeps the block when the update omits a surviving enemy', () => {
        const merged = mergeMemo(ACTIVE, `[COMBAT]
COMBAT STATE: HOSTILE
COMBAT ROUND 3
ENEMIES:
Goblin: 0/8 HP
Status: Defeated
[/COMBAT]`);
        expect(merged).toContain('[COMBAT]');
    });

    it('keeps the block when a new active enemy appears', () => {
        const merged = mergeMemo(ACTIVE, `[COMBAT]
COMBAT STATE: HOSTILE
COMBAT ROUND 3
ENEMIES:
Goblin: 0/8 HP
Status: Defeated
Wolf: 10/10 HP
Status: Healthy
Orc: 12/12 HP
Status: Healthy
[/COMBAT]`);
        expect(merged).toContain('[COMBAT]');
        expect(merged).toContain('Orc: 12/12 HP');
    });

    it('honours a bare END_COMBAT even without a valid tag pair', () => {
        const merged = mergeMemo(ACTIVE, 'END_COMBAT');
        expect(merged).not.toContain('[COMBAT]');
    });

    it('replaces duplicate combat blocks so a stale copy cannot win', () => {
        const duplicate = `${ACTIVE}

[COMBAT]
COMBAT STATE: HOSTILE
COMBAT ROUND 1
ENEMIES:
Stale Goblin: 8/8 HP
[/COMBAT]`;
        const merged = mergeMemo(duplicate, `[COMBAT]
COMBAT STATE: HOSTILE
COMBAT ROUND 4
ENEMIES:
Orc: 12/12 HP
Status: Healthy
[/COMBAT]`);
        expect(merged.match(/\[COMBAT\]/g)).toHaveLength(1);
        expect(merged).toContain('Orc: 12/12 HP');
        expect(merged).not.toContain('Stale Goblin');
    });
});
