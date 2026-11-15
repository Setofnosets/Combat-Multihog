import { describe, expect, it } from 'vitest';
import {
    COMBAT_STYLES,
    COMBAT_STYLE_LABELS,
    listActiveCombatBoards,
} from '../src/features/combat/combat-mode.js';
import {
    LEWD_BY_CHAT_KEY,
    LEWD_CHANGED_EVENT,
    LEWD_OPEN_EVENT,
} from '../src/features/lewd-combat/lewd-combat-constants.js';
import {
    getLewdEncounterForChat,
    hasActiveLewdEncounter,
    removeAllLewdEncounters,
    removeLewdEncounterForChat,
    setLewdEncounterForChat,
} from '../src/features/lewd-combat/lewd-combat-store.js';

describe('Lewd Combat scaffold contract (U1)', () => {
    it('is a secondary style, not a selectable combat style', () => {
        expect(COMBAT_STYLES).toEqual(['narrative', 'tactical', 'traditional']);
        expect(COMBAT_STYLES).not.toContain('lewd');
        expect(COMBAT_STYLE_LABELS.lewd).toBe('Lewd');
        expect(LEWD_BY_CHAT_KEY).toBe('lewdCombatByChat');
        expect(LEWD_CHANGED_EVENT).toBe('rt_lewd_combat_changed');
        expect(LEWD_OPEN_EVENT).toBe('rt_lewd_combat_open');
    });

    it('lets a running lewd board take part in the open-encounter guard', () => {
        const settings = {
            lewdCombatByChat: {
                'lewd-chat': { status: 'active', round: 3, participants: [], updatedAt: 10 },
            },
        };
        const boards = listActiveCombatBoards(settings);
        expect(boards).toHaveLength(1);
        expect(boards[0].style).toBe('lewd');
        expect(boards[0].phase).toBe('active');
        expect(boards[0].round).toBe(3);
        // Finished lewd boards never block a style switch.
        expect(listActiveCombatBoards({
            lewdCombatByChat: { 'done-chat': { status: 'victory', updatedAt: 5 } },
        })).toEqual([]);
    });
});

describe('lewd-combat-store', () => {
    it('saves and reads a board per chat, stamping chatId and updatedAt', () => {
        const settings = {};
        const state = { status: 'active', participants: [] };
        setLewdEncounterForChat('chat-a', state, settings, { persist: false });

        expect(settings[LEWD_BY_CHAT_KEY]['chat-a']).toBe(state);
        expect(state.chatId).toBe('chat-a');
        expect(typeof state.updatedAt).toBe('number');
        expect(getLewdEncounterForChat('chat-a', settings)).toBe(state);
        expect(getLewdEncounterForChat('chat-b', settings)).toBeNull();
    });

    it('creates the map on demand and ignores invalid input', () => {
        const settings = {};
        expect(getLewdEncounterForChat('chat-a', settings)).toBeNull();
        expect(settings[LEWD_BY_CHAT_KEY]).toEqual({});

        setLewdEncounterForChat('', { status: 'active' }, settings, { persist: false });
        setLewdEncounterForChat('chat-a', null, settings, { persist: false });
        setLewdEncounterForChat('chat-a', { status: 'active' }, null, { persist: false });
        expect(settings[LEWD_BY_CHAT_KEY]).toEqual({});

        // Corrupt entries are ignored instead of crashing the board list.
        settings[LEWD_BY_CHAT_KEY]['bad-chat'] = ['not', 'a', 'state'];
        expect(getLewdEncounterForChat('bad-chat', settings)).toBeNull();
        expect(getLewdEncounterForChat('chat-a', null)).toBeNull();
    });

    it('reports an active board only while the module is enabled', () => {
        const settings = {
            lewdCombatEnabled: true,
            lewdCombatByChat: {
                'chat-a': { status: 'active' },
                'chat-b': { status: 'won' },
            },
        };
        expect(hasActiveLewdEncounter(settings, 'chat-a')).toBe(true);
        expect(hasActiveLewdEncounter(settings, 'chat-b')).toBe(false);
        expect(hasActiveLewdEncounter(settings, 'missing-chat')).toBe(false);
        settings.lewdCombatEnabled = false;
        expect(hasActiveLewdEncounter(settings, 'chat-a')).toBe(false);
    });

    it('removes one chat or every board', () => {
        const settings = {
            lewdCombatByChat: {
                'chat-a': { status: 'active' },
                'chat-b': { status: 'active' },
            },
        };
        removeLewdEncounterForChat('chat-a', settings, { persist: false });
        expect(settings.lewdCombatByChat['chat-a']).toBeUndefined();
        expect(settings.lewdCombatByChat['chat-b']).toBeTruthy();

        removeAllLewdEncounters(settings, { persist: false });
        expect(settings.lewdCombatByChat).toEqual({});
    });

    it('prunes the oldest finished boards but never a running one', () => {
        const settings = { lewdCombatByChat: {} };
        // The running board is the oldest entry: age must not evict it.
        settings.lewdCombatByChat.running = { status: 'active', updatedAt: 0 };
        for (let index = 1; index <= 17; index += 1) {
            settings.lewdCombatByChat[`finished-${index}`] = {
                status: 'victory',
                updatedAt: index,
            };
        }
        setLewdEncounterForChat('extra-finished', { status: 'victory' }, settings, { persist: false });

        const keys = Object.keys(settings[LEWD_BY_CHAT_KEY]);
        expect(keys).toContain('running');
        expect(keys).toContain('finished-17');
        expect(keys).toContain('extra-finished');
        expect(keys.length).toBe(16);
        // The oldest finished boards are the ones dropped.
        expect(keys).not.toContain('finished-1');
        expect(keys).not.toContain('finished-2');
        expect(keys).not.toContain('finished-3');
    });
});
