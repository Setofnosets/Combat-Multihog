import { describe, expect, it } from 'vitest';
import {
    buildResourceLedger,
    buildSpellSlots,
    consumeUse,
    describeResource,
    ensureSpellSlots,
    formatResourceLedger,
    getResourceState,
    hasUses,
    parseUsageState,
    patchAbilityLine,
    patchInventoryLine,
    patchSpellLevelLines,
} from '../src/features/tactical-combat/tactical-combat-resources.js';

function spell(name, overrides = {}) {
    return {
        id: `skill-${name.toLowerCase().replace(/\s+/g, '-')}`,
        name,
        kind: 'attack',
        spell: true,
        slotLevel: 1,
        slotKey: 'spell-1',
        damage: '1d4+1',
        uses: 2,
        maxUses: 2,
        ...overrides,
    };
}

describe('combat resource parsing', () => {
    it('keeps the current value from a slash pair instead of treating max as current', () => {
        expect(parseUsageState('0/2')).toMatchObject({ current: 0, max: 2, unlimited: false });
        expect(parseUsageState('1/3 per rest')).toMatchObject({ current: 1, max: 3, unlimited: false });
        expect(parseUsageState('2 uses')).toMatchObject({ current: 2, max: 2, unlimited: false });
        expect(parseUsageState('1/day')).toMatchObject({ current: 1, max: 1, unlimited: false });
    });

    it('treats missing usage text as at-will', () => {
        expect(parseUsageState('A silver tongue and a quick lie.')).toMatchObject({ unlimited: true });
        expect(parseUsageState('', { fallbackMax: 2 })).toMatchObject({ current: 2, max: 2, unlimited: false });
    });
});

describe('spell slot pools', () => {
    it('builds one shared pool per spell level', () => {
        const slots = buildSpellSlots([
            spell('Magic Missile', { uses: 0, maxUses: 2 }),
            spell('Shield', { uses: 0, maxUses: 2 }),
            spell('Burning Hands', { slotLevel: 2, slotKey: 'spell-2', uses: 1, maxUses: 3 }),
        ]);
        expect(slots).toEqual({
            'spell-1': { current: 0, max: 2 },
            'spell-2': { current: 1, max: 3 },
        });
    });

    it('consumes from the shared pool and mirrors the value to every spell in it', () => {
        const unit = {
            name: 'Aria',
            skills: [spell('Magic Missile'), spell('Shield')],
        };
        ensureSpellSlots(unit);
        expect(unit.spellSlots['spell-1']).toEqual({ current: 2, max: 2 });

        expect(consumeUse(unit.skills[0], unit)).toBe(true);
        expect(unit.spellSlots['spell-1'].current).toBe(1);
        expect(unit.skills.map(skill => skill.uses)).toEqual([1, 1]);
        expect(describeResource(unit.skills[1], unit).label).toBe('1/2');

        expect(consumeUse(unit.skills[1], unit)).toBe(true);
        expect(unit.spellSlots['spell-1'].current).toBe(0);
        expect(hasUses(unit.skills[0], unit)).toBe(false);
        expect(consumeUse(unit.skills[0], unit)).toBe(false);
    });

    it('does not consume at-will abilities', () => {
        const unit = { skills: [{ id: 'at-will', name: 'At Will', unlimited: true, uses: 0, maxUses: 0 }] };
        const state = getResourceState(unit.skills[0], unit);
        expect(state.unlimited).toBe(true);
        expect(hasUses(unit.skills[0], unit)).toBe(true);
        expect(consumeUse(unit.skills[0], unit)).toBe(true);
        expect(unit.skills[0].uses).toBe(0);
    });

    it('honours an existing lowered pool when hydrating', () => {
        const unit = {
            spellSlots: { 'spell-1': { current: 0, max: 2 } },
            skills: [spell('Magic Missile', { uses: 2 })],
        };
        ensureSpellSlots(unit);
        expect(unit.spellSlots['spell-1']).toEqual({ current: 0, max: 2 });
    });
});

describe('resource ledger and memo patches', () => {
    it('reports spell slots, abilities, and item quantities', () => {
        const unit = {
            id: 'pc-1',
            name: 'Aria',
            side: 'player',
            spellSlots: { 'spell-1': { current: 1, max: 2 } },
            skills: [
                spell('Magic Missile', { uses: 1 }),
                { id: 'skill-surge', name: 'Action Surge', kind: 'buff', uses: 0, maxUses: 1, description: 'Extra action' },
                { id: 'skill-lie', name: 'Silver Tongue', unlimited: true, uses: 0, maxUses: 0 },
            ],
            items: [{ id: 'item-potion', name: 'Healing Potion', kind: 'heal', uses: 1, maxUses: 2 }],
        };
        const ledger = buildResourceLedger({ units: [unit] });
        const entry = ledger.units[0];
        expect(entry.spellSlots['spell-1']).toEqual({ current: 1, max: 2 });
        expect(entry.spells[0]).toMatchObject({ name: 'Magic Missile', usesText: '1/2' });
        expect(entry.abilities.find(ability => ability.name === 'Action Surge')).toMatchObject({ label: '0/1' });
        expect(entry.abilities.find(ability => ability.name === 'Silver Tongue')).toMatchObject({ unlimited: true, label: '∞' });
        expect(entry.items[0]).toMatchObject({ label: '1/2' });
        expect(formatResourceLedger(ledger)).toContain('Aria: L1 1/2');
        expect(formatResourceLedger(ledger)).toContain('Action Surge 0/1');
    });

    it('patches level pool lines, including bulleted standalone spell blocks', () => {
        expect(patchSpellLevelLines('Spells: Level 1 (2/2): Magic Missile, Shield', { 'spell-1': { current: 0, max: 2 } }))
            .toBe('Spells: Level 1 (0/2): Magic Missile, Shield');
        expect(patchSpellLevelLines('- Level 2 (1/3): Misty Step, Shatter', { 'spell-2': { current: 3, max: 3 } }))
            .toBe('- Level 2 (3/3): Misty Step, Shatter');
    });

    it('patches ability usage without losing the rest of the description', () => {
        const skills = [{ name: 'Action Surge', uses: 0, maxUses: 1, description: 'Extra action; 1/1 per rest' }];
        expect(patchAbilityLine('Abilities: Action Surge (Extra action; 1/1 per rest), Silver Tongue (at will)', skills))
            .toBe('Abilities: Action Surge (Extra action; 0/1 per rest), Silver Tongue (at will)');
    });

    it('updates and removes inventory quantities', () => {
        expect(patchInventoryLine('- Healing Potion x2 [restores 2d4+2]', [{ name: 'Healing Potion', uses: 1, maxUses: 2 }]))
            .toBe('- Healing Potion x1 [restores 2d4+2]');
        expect(patchInventoryLine('- Healing Potion x1', [{ name: 'Healing Potion', uses: 0, maxUses: 1 }]))
            .toBe('');
    });
});
