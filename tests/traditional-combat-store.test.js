import { describe, expect, it } from 'vitest';
import {
    getEncounterForChat,
    setEncounterForChat,
    TRADITIONAL_BY_CHAT_KEY,
} from '../src/features/tactical-combat/tactical-combat-store.js';
import { createTraditionalEncounterState } from '../src/features/traditional-combat/traditional-combat-engine.js';

describe('traditional combat per-chat store', () => {
    it('stores a no-grid traditional board under its own key', () => {
        const state = createTraditionalEncounterState({
            chatId: 'chat-trad',
            seed: 2,
            units: [
                { name: 'Aria', side: 'player', maxHp: 20, hp: 20, ac: 12, attackBonus: 3, damage: '1d8' },
                { name: 'Goblin', side: 'enemy', maxHp: 10, hp: 10, ac: 10, attackBonus: 2, damage: '1d4' },
            ],
        });
        const settings = {};
        setEncounterForChat('chat-trad', state, settings, { key: TRADITIONAL_BY_CHAT_KEY, persist: false });
        expect(settings[TRADITIONAL_BY_CHAT_KEY]['chat-trad']).toBeTruthy();
        expect(settings.tacticalCombatByChat).toBeUndefined();
        const loaded = getEncounterForChat('chat-trad', settings, { key: TRADITIONAL_BY_CHAT_KEY });
        expect(loaded.id).toBe(state.id);
        expect(loaded.theater).toBe(true);
        expect(getEncounterForChat('chat-trad', settings)).toBeNull();
    });

    it('rejects malformed stored traditional boards', () => {
        const settings = { [TRADITIONAL_BY_CHAT_KEY]: { broken: { units: [] } } };
        expect(getEncounterForChat('broken', settings, { key: TRADITIONAL_BY_CHAT_KEY })).toBeNull();
    });
});
