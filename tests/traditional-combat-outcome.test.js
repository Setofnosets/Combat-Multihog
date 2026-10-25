import { describe, expect, it } from 'vitest';
import { buildNarrationBlock, queueCombatOutcome } from '../src/features/tactical-combat/tactical-combat-outcome.js';
import { createTraditionalEncounterState, applyTraditionalAction } from '../src/features/traditional-combat/traditional-combat-engine.js';
import { getPendingNarration } from '../src/features/tactical-combat/tactical-combat-store.js';
import { DEFAULT_TRADITIONAL_OUTCOME_PROMPT } from '../src/features/traditional-combat/traditional-combat-prompts.js';

const highRoll = () => 0.99;

function makeState() {
    const state = createTraditionalEncounterState({
        chatId: 'chat-trad',
        seed: 3,
        turnStyle: 'phase',
        title: 'The Broken Gate',
        location: 'The Broken Gate',
        units: [
            { name: 'Aria', side: 'player', maxHp: 20, hp: 14, ac: 13, attackBonus: 50, damage: '1d8+1' },
            { name: 'Goblin', side: 'enemy', maxHp: 8, hp: 8, ac: 11, attackBonus: 3, damage: '1d6' },
        ],
    });
    const player = state.units.find(unit => unit.side === 'player');
    const enemy = state.units.find(unit => unit.side === 'enemy');
    applyTraditionalAction(state, { type: 'attack', unitId: player.id, targetId: enemy.id }, {
        actorSide: 'player',
        rng: highRoll,
    });
    return state;
}

describe('traditional combat outcome handoff', () => {
    it('queues a traditional outcome with its own kind and narration bridge', () => {
        const state = makeState();
        expect(state.status).toBe('victory');
        const settings = {
            currentMemo: '[CHARACTER]\nAria: 14/20 HP\n[/CHARACTER]\n[COMBAT]\nGoblin: 8/8 HP\n[/COMBAT]',
            traditionalCombatOutcomePrompt: DEFAULT_TRADITIONAL_OUTCOME_PROMPT,
        };
        const merge = (memo) => memo.replace(/\[COMBAT\][\s\S]*?\[\/COMBAT\]/i, '[COMBAT]END_COMBAT[/COMBAT]');
        const payload = queueCombatOutcome(state, settings, { persist: false, refresh: false, merge });
        expect(payload.kind).toBe('traditional');
        expect(settings.currentMemo).toContain('[COMBAT]END_COMBAT[/COMBAT]');
        expect(getPendingNarration(settings)).toMatchObject({ chatId: 'chat-trad', kind: 'traditional' });

        const narration = buildNarrationBlock(settings, 'chat-trad');
        expect(narration).toContain('[TRADITIONAL_COMBAT_CONTEXT]');
        expect(narration).toContain('TRADITIONAL COMBAT RESULT');
        expect(narration).not.toContain('[TACTICAL_COMBAT_CONTEXT]');
    });
});
