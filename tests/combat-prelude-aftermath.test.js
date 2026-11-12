import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testExtensionSettings } from './setup.js';

vi.mock('../portrait-storage.js', () => ({
    lookupCustomPortraitSrc: () => '',
}));
vi.mock('../../../../script.js', () => ({
    getRequestHeaders: () => ({}),
}));

import {
    getCombatMemoState,
    stripEndedCombatFromMemo,
} from '../src/state/combat-persistence.js';
import { getSettings } from '../state-manager.js';
import { buildCombatTrackerReport } from '../src/features/tactical-combat/tactical-combat-memo.js';
import {
    memoForGmContext,
    memoForTrackerContext,
    mergeMemo,
} from '../memo-processor.js';
import { parseMemoBlocks } from '../renderer.js';
import {
    buildTacticalCombatRuntimeOverride,
    buildTraditionalCombatRuntimeOverride,
} from '../narrative-hooks.js';

const hooksSource = readFileSync(new URL('../narrative-hooks.js', import.meta.url), 'utf8');
const constantsSource = readFileSync(new URL('../constants.js', import.meta.url), 'utf8');
const syspromptSource = readFileSync(new URL('../sysprompt.txt', import.meta.url), 'utf8');

describe('combat prelude discipline', () => {
    beforeEach(() => {
        for (const key of Object.keys(testExtensionSettings)) delete testExtensionSettings[key];
        testExtensionSettings.rpg_tracker = {
            combatStyle: 'tactical',
            tacticalCombatEnabled: true,
            syspromptModules: { tactical_combat: true, traditional_combat: true },
            currentMemo: '[COMBAT]\nCOMBAT STATE: DORMANT\nENEMIES:\nGoblin: 10/10 HP\n[/COMBAT]',
        };
        vi.spyOn(SillyTavern, 'getContext').mockReturnValue({
            extensionSettings: testExtensionSettings,
            chatId: 'vitest-chat',
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('keeps a dormant encounter in Beat 1 without demanding the tool', () => {
        const settings = testExtensionSettings.rpg_tracker;
        const tactical = buildTacticalCombatRuntimeOverride(settings);
        expect(tactical).toContain('DORMANT_ENCOUNTER');
        expect(tactical).toContain('Beat 1');
        expect(tactical).toContain("player's current input initiates hostilities");
        expect(tactical).not.toContain('Call the StartTacticalCombat function tool exactly once');

        settings.combatStyle = 'traditional';
        const traditional = buildTraditionalCombatRuntimeOverride(settings);
        expect(traditional).toContain('DORMANT_ENCOUNTER');
        expect(traditional).toContain('Beat 1');
        expect(traditional).not.toContain('Call the StartTraditionalCombat function tool exactly once');
    });

    it('documents the Two-Beat Encounter Rule in both prompt sources and tool descriptions', () => {
        for (const source of [constantsSource, syspromptSource]) {
            expect(source).toContain('Two-Beat Encounter Rule');
            expect(source).toContain('Beat 1');
            expect(source).toContain('Beat 2');
            expect(source).toContain('prelude');
            expect(source).toContain('Never introduce new enemies and call');
        }
        expect(hooksSource).toContain('Follow the Two-Beat Encounter Rule');
        expect(hooksSource).toContain('Beat 1 — Prelude (DO NOT CALL)');
    });
});

describe('combat aftermath cleanup', () => {
    const ACTIVE = `[CHARACTER]
Aria: 20/20 HP
[/CHARACTER]

[COMBAT]
COMBAT STATE: HOSTILE
COMBAT ROUND 2
ENEMIES:
Goblin: 8/8 HP
Status: Healthy
[/COMBAT]`;

    beforeEach(() => {
        getSettings().combatDefeatedUi = [];
    });

    it('removes END_COMBAT and other ended blocks instead of leaving ghost cards', () => {
        const memo = `[CHARACTER]\nAria: 20/20 HP\n[/CHARACTER]\n\n[COMBAT]END_COMBAT[/COMBAT]`;
        expect(stripEndedCombatFromMemo(memo)).not.toContain('[COMBAT]');

        const endedHeader = `[COMBAT]\nCOMBAT STATE: ENDED\nCOMBAT ROUND 3\nENEMIES:\nGoblin: 0/8 HP\nStatus: Defeated\n[/COMBAT]`;
        expect(stripEndedCombatFromMemo(endedHeader)).toBe('');
        expect(getCombatMemoState(endedHeader)).toBe('ended');
    });

    it('hides closed combat from rendering and from GM/tracker context', () => {
        const closed = `[COMBAT]END_COMBAT[/COMBAT]`;
        expect(parseMemoBlocks(closed).COMBAT).toBeUndefined();
        expect(parseMemoBlocks(ACTIVE).COMBAT).toContain('Goblin');

        expect(memoForGmContext(closed)).not.toContain('[COMBAT]');
        expect(memoForTrackerContext(closed)).not.toContain('[COMBAT]');
    });

    it('never persists a header-only combat shell after a partial tracker response', () => {
        const merged = mergeMemo(ACTIVE, `[COMBAT]
COMBAT STATE: HOSTILE
COMBAT ROUND 3
ENEMIES:
Goblin: 0/8 HP
Status: Defeated
[/COMBAT]`);
        expect(merged).not.toContain('[COMBAT]');
        expect(merged).not.toContain('ENEMIES:');
        expect(getSettings().combatDefeatedUi).toEqual([]);
    });

    it('closes a combat that the tracker marks ENDED even without a full roster', () => {
        const merged = mergeMemo(ACTIVE, `[COMBAT]
COMBAT STATE: ENDED
[/COMBAT]`);
        expect(merged).not.toContain('[COMBAT]');
        expect(merged).toContain('[CHARACTER]');
    });

    it('tells the tracker this pass is post-combat aftermath and must not reopen combat', () => {
        const report = buildCombatTrackerReport({
            status: 'victory',
            round: 2,
            units: [
                { id: 'pc-1', name: 'Aria', side: 'player', hp: 14, maxHp: 20, willpower: 8, maxWillpower: 8 },
                { id: 'enemy-1', name: 'Goblin', side: 'enemy', hp: 0, maxHp: 8, defeated: true },
            ],
        });
        expect(report).toContain('Combat is OVER');
        expect(report).toContain('post-combat aftermath');
        expect(report).toContain('[COMBAT]END_COMBAT[/COMBAT]');
        expect(report).toMatch(/never re-open \[COMBAT\]/i);
        expect(report).toContain('Do not re-adjudicate');
    });
});
