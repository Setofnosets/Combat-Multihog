import { describe, expect, it, vi } from 'vitest';
import {
    buildNarrationBlock,
    closeCombatBlockInMemo,
    clearNarrationAfterGeneration,
    queueCombatOutcome,
} from '../src/features/tactical-combat/tactical-combat-outcome.js';
import {
    clearPendingNarration,
    getEncounterForChat,
    getPendingNarration,
    removeEncounterForChat,
    setEncounterForChat,
    setPendingNarration,
} from '../src/features/tactical-combat/tactical-combat-store.js';
import {
    createEncounterState,
    retreatEncounter,
} from '../src/features/tactical-combat/tactical-combat-engine.js';
import { DEFAULT_TACTICAL_OUTCOME_PROMPT } from '../src/features/tactical-combat/tactical-combat-prompts.js';

function makeState(chatId = 'chat-A') {
    const state = createEncounterState({
        chatId,
        seed: 3,
        grid: { rows: 6, cols: 6 },
        terrainRows: Array.from({ length: 6 }, () => '......'),
        units: [
            { name: 'Aria', side: 'player', maxHp: 20, hp: 14, ac: 13, attackBonus: 4, damage: '1d8+1' },
            { name: 'Goblin', side: 'enemy', maxHp: 8, hp: 0, ac: 11, attackBonus: 3, damage: '1d6' },
        ],
    });
    state.units[1].defeated = true;
    state.status = 'victory';
    state.phase = 'ended';
    state.outcome = {
        status: 'victory',
        label: 'Victory',
        title: state.title,
        location: state.location || 'The Sunken Keep',
        rounds: 3,
        survivors: [{ id: 'pc-1', name: 'Aria', hp: 14, maxHp: 20 }],
        fallen: [],
        defeatedEnemies: [{ id: 'enemy-2', name: 'Goblin' }],
        summary: 'Victory after 3 rounds.',
        details: ['The opposition is broken.', 'Survivors: Aria (14/20 HP).'],
    };
    return state;
}

describe('tactical combat outcome handoff', () => {
    it('closes an active COMBAT block and leaves END_COMBAT untouched', () => {
        const merge = vi.fn((memo) => memo.replace(/\[COMBAT\][\s\S]*?\[\/COMBAT\]/i, '[COMBAT]END_COMBAT[/COMBAT]'));
        const active = closeCombatBlockInMemo('[CHARACTER]\nX\n[/CHARACTER]\n[COMBAT]\nGoblin: 1/8 HP\n[/COMBAT]', { merge });
        expect(active).toContain('[COMBAT]END_COMBAT[/COMBAT]');
        expect(merge).toHaveBeenCalledWith(expect.any(String), '[COMBAT]END_COMBAT[/COMBAT]');
        const alreadyEnded = closeCombatBlockInMemo('[COMBAT]END_COMBAT[/COMBAT]', { merge });
        expect(alreadyEnded).toBe('[COMBAT]END_COMBAT[/COMBAT]');
        expect(closeCombatBlockInMemo('[CHARACTER]\nX\n[/CHARACTER]', { merge })).toBe('[CHARACTER]\nX\n[/CHARACTER]');
    });

    it('queues an idempotent authoritative outcome and closes the memo block', () => {
        const state = makeState();
        const settings = {
            currentMemo: '[CHARACTER]\nAria\n[/CHARACTER]\n[COMBAT]\nGoblin: 0/8 HP\n[/COMBAT]',
            tacticalCombatOutcomePrompt: DEFAULT_TACTICAL_OUTCOME_PROMPT,
        };
        const merge = (memo) => memo.replace(/\[COMBAT\][\s\S]*?\[\/COMBAT\]/i, '[COMBAT]END_COMBAT[/COMBAT]');
        const first = queueCombatOutcome(state, settings, { persist: false, refresh: false, merge });
        expect(first.chatId).toBe('chat-A');
        expect(settings.currentMemo).toContain('[COMBAT]END_COMBAT[/COMBAT]');
        expect(settings.tacticalCombatReturn).toMatchObject({ chatId: 'chat-A', stateId: state.id });
        expect(state.finalization.narrationQueued).toBe(true);

        const memoAfterFirst = settings.currentMemo;
        const second = queueCombatOutcome(state, settings, { persist: false, refresh: false, merge });
        expect(second).toEqual(first);
        expect(settings.currentMemo).toBe(memoAfterFirst);
    });

    it('renders the outcome template with authoritative placeholders', () => {
        const state = makeState();
        const settings = { tacticalCombatOutcomePrompt: DEFAULT_TACTICAL_OUTCOME_PROMPT };
        settings.tacticalCombatReturn = {
            chatId: 'chat-A',
            title: 'The Sunken Keep',
            location: 'Gatehouse',
            outcome: state.outcome,
        };
        const block = buildNarrationBlock(settings, 'chat-A');
        expect(block).toContain('TACTICAL COMBAT RESULT');
        expect(block).toContain('Victory');
        expect(block).toContain('Gatehouse');
        expect(block).toContain('3');
        expect(block).toContain('Aria (14/20 HP)');
        expect(block).toContain('Goblin');
        expect(block).toContain('The opposition is broken.');
        expect(buildNarrationBlock(settings, 'chat-B')).toBe('');
    });

    it('reports surviving enemies, the trigger, highlights, and the final state', () => {
        const state = makeState();
        state.opening = { text: 'Aria fires an arrow at the Goblin', resolved: true };
        state.outcome.enemySurvivors = [{ id: 'enemy-3', name: 'Goblin Archer', hp: 7, maxHp: 12 }];
        state.outcome.highlights = ['Aria critically hits the Goblin.'];
        state.outcome.finalUnits = [
            { name: 'Aria', side: 'player', hp: 14, maxHp: 20, defeated: false, fled: false },
            { name: 'Goblin Archer', side: 'enemy', hp: 7, maxHp: 12, defeated: false, fled: false },
        ];
        const settings = { tacticalCombatOutcomePrompt: DEFAULT_TACTICAL_OUTCOME_PROMPT };
        settings.tacticalCombatReturn = {
            chatId: 'chat-A',
            title: 'The Sunken Keep',
            location: 'Gatehouse',
            trigger: state.opening.text,
            outcome: state.outcome,
        };
        const block = buildNarrationBlock(settings, 'chat-A');
        expect(block).toContain('TACTICAL_COMBAT_CONTEXT');
        expect(block).toContain('not a new action');
        expect(block).toContain('Remaining enemies: Goblin Archer (7/12 HP)');
        expect(block).toContain('Aria fires an arrow');
        expect(block).toContain('Aria critically hits the Goblin.');
        expect(block).toContain('Goblin Archer [enemy]: 7/12 HP');
    });

    it('supports a user-authored outcome template and leaves unknown placeholders intact', () => {
        const state = makeState();
        const settings = { tacticalCombatOutcomePrompt: 'RESULT={{outcome}} {{unknown}}' };
        settings.tacticalCombatReturn = { chatId: 'chat-A', outcome: state.outcome };
        const block = buildNarrationBlock(settings, 'chat-A');
        expect(block).toContain('RESULT=Victory {{unknown}}');
    });

    it('reports Willpower breaks, side changes, and transformations', () => {
        const state = makeState();
        const settings = { tacticalCombatOutcomePrompt: DEFAULT_TACTICAL_OUTCOME_PROMPT };
        settings.tacticalCombatReturn = {
            chatId: 'chat-A',
            title: 'The Sunken Keep',
            location: 'Gatehouse',
            outcome: {
                ...state.outcome,
                willpowerBreaks: [{ name: 'Goblin Archer', outcome: 'flee', source: 'Dread Wail' }],
                sideChanges: [{ name: 'Aria', originalSide: 'player', side: 'enemy' }],
                transformations: [{ name: 'Stone Statue', originalName: 'Cultist', permanent: false }],
                finalUnits: [{ name: 'Aria', side: 'player', originalSide: 'player', hp: 14, maxHp: 20, willpower: 3, maxWillpower: 8 }],
            },
        };
        const block = buildNarrationBlock(settings, 'chat-A');
        expect(block).toContain('Willpower breaks: Goblin Archer (flee; Dread Wail)');
        expect(block).toContain('Side changes: Aria (player → enemy)');
        expect(block).toContain('Transformations: Cultist (temporary)');
        expect(block).toContain('3/8 WP');
    });

    it('clears the queued block only after injection and only for the matching chat', () => {
        const settings = {
            tacticalCombatReturn: {
                chatId: 'chat-A',
                outcome: { label: 'Victory' },
                injectedAt: Date.now(),
                injectedFor: 'chat-A',
            },
        };
        clearNarrationAfterGeneration(settings, 'chat-B', { save: false });
        expect(settings.tacticalCombatReturn).not.toBeNull();
        clearNarrationAfterGeneration(settings, 'chat-A', { save: false });
        expect(settings.tacticalCombatReturn).toBeNull();
    });

    it('keeps a queued result that was never injected into a prompt', () => {
        const settings = { tacticalCombatReturn: { chatId: 'chat-A', outcome: { label: 'Victory' }, injectedAt: 0 } };
        clearNarrationAfterGeneration(settings, 'chat-A', { save: false });
        expect(settings.tacticalCombatReturn).not.toBeNull();
    });
});

describe('tactical combat per-chat store', () => {
    it('stores, reads, and removes an encounter per chat', () => {
        const settings = {};
        const state = makeState('chat-A');
        setEncounterForChat('chat-A', state, settings, { persist: false });
        expect(getEncounterForChat('chat-A', settings)).toBe(state);
        expect(state.chatId).toBe('chat-A');
        expect(getEncounterForChat('chat-B', settings)).toBeNull();
        removeEncounterForChat('chat-A', settings, { persist: false });
        expect(getEncounterForChat('chat-A', settings)).toBeNull();
    });

    it('rejects malformed stored encounters', () => {
        const settings = { tacticalCombatByChat: { broken: { units: [] } } };
        expect(getEncounterForChat('broken', settings)).toBeNull();
    });

    it('stores and clears a pending narration payload', () => {
        const settings = {};
        setPendingNarration(settings, { chatId: 'chat-A', outcome: { label: 'Victory' } }, { persist: false });
        expect(getPendingNarration(settings).chatId).toBe('chat-A');
        clearPendingNarration(settings, { chatId: 'chat-B', persist: false });
        expect(getPendingNarration(settings)).not.toBeNull();
        clearPendingNarration(settings, { chatId: 'chat-A', persist: false });
        expect(getPendingNarration(settings)).toBeNull();
    });

    it('uses a retreat outcome for player withdrawal', () => {
        const state = makeState();
        state.status = 'active';
        state.phase = 'player';
        state.outcome = null;
        retreatEncounter(state);
        expect(state.outcome.label).toBe('Retreat');
        expect(state.outcome.details.join(' ')).toMatch(/withdraw|escape/i);
    });
});
