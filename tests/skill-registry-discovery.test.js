import { describe, expect, it } from 'vitest';

import {
    createEmptySkillRegistry,
    findSkillRegistryEntry,
    mergeSkillRegistries,
    upsertSkillRegistryEntry,
} from '../src/features/skill-registry/skill-registry.js';
import {
    backfillSkillRegistry,
    registerSkillsFromEncounterState,
    registerSkillsFromMemo,
} from '../src/features/skill-registry/skill-registry-discovery.js';
import { createEncounterState, normalizeSkillList } from '../src/features/tactical-combat/tactical-combat-engine.js';

function makeSettings(memo = '') {
    return {
        currentMemo: memo,
        skillRegistry: createEmptySkillRegistry(),
    };
}

const MEMO = `[CHARACTER]
Aria (Elf Wizard): 30/30 HP
Combat: BAB: +2 | Melee: +4 | Ranged: +6
Gear: Staff (1d6)
Attr: STR 8 (-1), DEX 16 (+3), CON 12 (+1), INT 18 (+4), WIS 12 (+1), CHA 10 (0)
Saves: Fort +3 | Ref +5 | Will +5
Abilities: Misty Step (teleport 30 ft)
Status: Healthy
[/CHARACTER]

[COMBAT]
Goblin Shaman (Goblin Shaman): 10/10 HP
Combat: BAB: +1 | Melee: +3
Gear: Dagger (1d4+1)
Attr: STR 10 (0), DEX 14 (+2), CON 10 (0), INT 8 (-1), WIS 8 (-1), CHA 8 (-1)
Saves: Fort +2 | Ref +4 | Will +1
Abilities: Spirit Summon (summons a spectral guardian, 1/1)
Status: Healthy
[/COMBAT]`;

describe('skill registry discovery backfill', () => {
    it('discovers specials from the memo without building an encounter', () => {
        const settings = makeSettings(MEMO);
        const changed = registerSkillsFromMemo(settings, { chatId: 'chat-1', name1: 'Aria' }, {
            chatId: 'chat-1',
            persist: false,
        });
        expect(changed).toBeGreaterThan(0);
        expect(findSkillRegistryEntry(settings, 'Misty Step')).toMatchObject({
            source: 'memo',
            mechanics: { kind: 'special' },
        });
        expect(findSkillRegistryEntry(settings, 'Spirit Summon')).toMatchObject({
            mechanics: { kind: 'special' },
        });
        expect(settings.skillRegistry.classes['elf-wizard'].skillIds).toContain('Misty Step');
    });

    it('registers saved-board skills and skips synthetic fallback loadouts', () => {
        const settings = makeSettings();
        const state = {
            units: [{
                id: 'pc-1',
                name: 'Aria',
                side: 'player',
                classLabel: 'Wizard',
                skills: [
                    { id: 'hydrokinesis', name: 'Hydrokinesis', kind: 'special', source: 'memo' },
                    { id: 'cleave', name: 'Cleave', kind: 'attack', source: 'fallback' },
                    { id: 'legacy-cleave', name: 'Cleave', kind: 'attack' },
                ],
            }],
        };
        const changed = registerSkillsFromEncounterState(settings, state, { persist: false });
        expect(changed).toBeGreaterThan(0);
        expect(findSkillRegistryEntry(settings, 'Hydrokinesis')).toBeTruthy();
        expect(findSkillRegistryEntry(settings, 'Cleave')).toBeNull();
    });

    it('backfills both the current memo and a saved board', () => {
        const settings = makeSettings(MEMO);
        settings.tacticalCombatByChat = {
            'chat-1': {
                units: [{
                    id: 'enemy-1',
                    name: 'Bone Collector',
                    side: 'enemy',
                    skills: [{ id: 'bone-wall', name: 'Wall of Bone', kind: 'special' }],
                }],
            },
        };
        const changed = backfillSkillRegistry(settings, {
            chatId: 'chat-1',
            ctx: { chatId: 'chat-1', name1: 'Aria' },
            persist: false,
        });
        expect(changed).toBeGreaterThan(0);
        expect(findSkillRegistryEntry(settings, 'Misty Step')).toBeTruthy();
        expect(findSkillRegistryEntry(settings, 'Wall of Bone')).toBeTruthy();
    });

    it('merges an older saved registry without erasing live recipes', () => {
        const live = createEmptySkillRegistry();
        const saved = createEmptySkillRegistry();
        upsertSkillRegistryEntry(live, {
            name: 'Dread Wail',
            source: 'resolver',
            status: 'resolved',
            mechanics: {
                kind: 'special',
                effectTemplate: [{ type: 'damage', target: '$target', amount: '2d6' }],
            },
        });
        upsertSkillRegistryEntry(saved, {
            name: 'Dread Wail',
            source: 'memo',
            status: 'confirmed',
            mechanics: { kind: 'special', range: 6 },
        });
        upsertSkillRegistryEntry(saved, {
            name: 'Shield',
            source: 'memo',
            status: 'confirmed',
            mechanics: { kind: 'buff', acBonus: 2 },
        });
        saved.classes.wizard = {
            id: 'wizard',
            name: 'Wizard',
            skillIds: ['Dread Wail'],
            source: 'memo',
        };

        const merged = mergeSkillRegistries(saved, live);
        const entry = findSkillRegistryEntry(merged, 'Dread Wail');
        expect(entry.status).toBe('resolved');
        expect(entry.mechanics.effectTemplate[0].amount).toBe('2d6');
        expect(findSkillRegistryEntry(merged, 'Shield')).toBeTruthy();
        expect(merged.classes.wizard.skillIds).toContain('Dread Wail');
    });
});

describe('skill registry board metadata', () => {
    it('preserves registry provenance and item recipes through normalization', () => {
        const [skill] = normalizeSkillList([{
            name: 'Hydrokinesis',
            kind: 'special',
            source: 'memo',
            registryId: 'hydrokinesis',
            registryStatus: 'resolved',
            effectTemplate: [{ type: 'damage', target: '$target', amount: '2d6' }],
        }], 'player');
        expect(skill).toMatchObject({
            source: 'memo',
            registryId: 'hydrokinesis',
            registryStatus: 'resolved',
        });
        expect(skill.effectTemplate[0].amount).toBe('2d6');

        const state = createEncounterState({
            seed: 1,
            grid: { rows: 5, cols: 5 },
            units: [{
                id: 'pc-1',
                name: 'Aria',
                side: 'player',
                maxHp: 20,
                hp: 20,
                items: [{
                    id: 'scroll',
                    name: 'Scroll of Walls',
                    kind: 'special',
                    source: 'memo',
                    registryId: 'scroll-of-walls',
                    effectTemplate: [{ type: 'terrain', terrain: 'stone', cells: [{ x: 1, y: 1 }] }],
                }],
            }],
        });
        expect(state.units[0].items[0]).toMatchObject({
            registryId: 'scroll-of-walls',
            source: 'memo',
        });
        expect(state.units[0].items[0].effectTemplate[0].type).toBe('terrain');
    });
});
