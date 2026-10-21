import { describe, expect, it } from 'vitest';
import {
    buildEncounterFromContext,
    buildFallbackEnemies,
    buildFallbackPlayer,
    collectEncounterContext,
    inferTerrainTheme,
    parseCombatUnits,
    parseInventoryItems,
    parsePlayerUnits,
    resolveTerrainTheme,
} from '../src/features/tactical-combat/tactical-combat-context.js';
import { buildEncounterRequestPayload } from '../src/features/tactical-combat/tactical-combat-agent.js';

const MEMO = `[CHARACTER]
{{user}} (Fighter): 34/40 HP
Combat: BAB: +5 | Ranged (1 attack): +6 | Melee (1 attack / 2 attacks): +8 | Base AC: 14 | Total AC: 18
Gear: Longsword (1d8+4 Slashing) | Shield (+2 AC)
Attr: STR 16 (+3), DEX 14 (+2), CON 14 (+2), INT 10 (+0), WIS 12 (+1), CHA 10 (+0)
Saves: Fort +5 | Ref +3 | Will +2
Skills: Athletics +6, Perception +3
Traits: Action Surge (extra action)
HD: d10 (5/5)
Status: Healthy
[/CHARACTER]

[PARTY]
Mira (Wizard): 22/24 HP
Combat: BAB: +2 | Ranged (1 attack): +7 | Melee (1 attack): +3 | Base AC: 11 | Total AC: 13
Gear: Wand (1d10 Fire) | Robes (+1 AC)
Attr: STR 8 (-1), DEX 14 (+2), CON 12 (+1), INT 17 (+3), WIS 12 (+1), CHA 10 (+0)
Abilities: Arcane Recovery (1/1, recover spell slots)
Spells: Cantrips: Firebolt, Mage Hand
Spells: Level 1 (2/2): Magic Missile, Shield
Status: Healthy
[/PARTY]

[INVENTORY]
- Gear: Longsword [Common]
- Other Items: Healing Potion x2 [Common]
[/INVENTORY]

[COMBAT]
ENEMIES:
Goblin Archer: 12/12 HP
Att/def: Shortbow (1 attack, +5 / 1d6+2 Piercing) | Leather (AC: 13)
Saves: Fort +2, Ref +4, Will +1
Abilities: Nimble Escape (disengage as a bonus action)
Status: Healthy
Goblin Brute: 20/20 HP
Att/def: Club (1 attack, +4 / 1d8+2 Bludgeoning) | Hide (AC: 12)
Status: Healthy
NON-PARTY ALLIES:
Sera: 15/15 HP
Att/def: Dagger (1 attack, +4 / 1d4+2) | Leather (AC: 12)
Abilities: Sneak Attack (extra 1d6)
[/COMBAT]

[TIME]
Day 1, 12:00
(Location: The Sunken Keep, Gatehouse)
[/TIME]`;

const CTX = {
    name1: 'Aria',
    chatId: 'chat-1',
    chat: [
        { mes: 'The gatehouse reeks of rot. Arrows hiss from the murder holes. *(Location: The Sunken Keep, Gatehouse)*' },
    ],
};

const BASE_SETTINGS = {
    tacticalCombatMovement: 6,
    tacticalCombatTerrainTheme: 'auto',
    tacticalCombatGridPreset: '15x15',
    tacticalCombatTurnStyle: 'phase',
    tacticalCombatTerrainDensity: 35,
    tacticalCombatEncounterSource: 'auto',
};

describe('tactical combat memo context', () => {
    it('parses the player character and party with stats, skills, and inventory items', () => {
        const party = parsePlayerUnits(MEMO, CTX);
        expect(party.map(unit => unit.name)).toEqual(['Aria', 'Mira']);
        const aria = party[0];
        expect(aria.hp).toBe(34);
        expect(aria.maxHp).toBe(40);
        expect(aria.ac).toBe(18);
        expect(aria.attackBonus).toBe(8);
        expect(aria.attackRange).toBe(1);
        expect(aria.damage).toBe('1d8+4');
        expect(aria.stats.str).toBe(16);
        expect(aria.stats.dexMod).toBe(2);

        const mira = party[1];
        expect(mira.classLabel).toBe('Wizard');
        expect(mira.ac).toBe(13);
        expect(mira.attackRange).toBe(6);
        expect(mira.damage).toBe('1d10');
        expect(mira.skills.map(skill => skill.name)).toEqual(expect.arrayContaining(['Firebolt', 'Magic Missile', 'Shield']));
    });

    it('parses enemies and non-party allies from the [COMBAT] block', () => {
        const { enemies, allies } = parseCombatUnits(MEMO);
        expect(enemies.map(unit => unit.name)).toEqual(['Goblin Archer', 'Goblin Brute']);
        expect(enemies[0].ac).toBe(13);
        expect(enemies[0].attackBonus).toBe(5);
        expect(enemies[0].attackRange).toBe(6);
        expect(enemies[0].damage).toBe('1d6+2');
        expect(enemies[1].attackRange).toBe(1);
        expect(enemies[1].damage).toBe('1d8+2');
        expect(allies).toHaveLength(1);
        expect(allies[0].name).toBe('Sera');
        expect(allies[0].side).toBe('ally');
    });

    it('extracts healing consumables only', () => {
        const items = parseInventoryItems(MEMO);
        expect(items).toHaveLength(1);
        expect(items[0].name).toBe('Healing Potion');
        expect(items[0].uses).toBe(2);
        expect(items[0].amount).toBe('2d4+2');
    });

    it('collects location, scene, theme, and the complete roster', () => {
        const context = collectEncounterContext({ ...BASE_SETTINGS, currentMemo: MEMO }, CTX);
        expect(context.location).toBe('The Sunken Keep, Gatehouse');
        expect(context.theme).toBe('dungeon');
        expect(context.existingCombat).toBe(true);
        expect(context.partySize).toBe(2);
        expect(context.playerUnits[0].items[0].name).toBe('Healing Potion');
        expect(context.sceneExcerpt).toContain('gatehouse');
        expect(context.summary.party.length).toBe(2);
    });

    it('falls back to a playable adventurer and themed enemies when the memo is empty', () => {
        const context = collectEncounterContext({ ...BASE_SETTINGS, currentMemo: '' }, { name1: 'Rook', chatId: 'empty', chat: [] });
        expect(context.playerUnits).toHaveLength(1);
        expect(context.playerUnits[0].name).toBe('Rook');
        expect(context.playerUnits[0].hp).toBeGreaterThan(0);
        expect(context.existingCombat).toBe(false);
        const enemies = buildFallbackEnemies({ ...context, theme: 'forest', partySize: 3 }, 7);
        expect(enemies.length).toBe(3);
        expect(enemies.every(enemy => enemy.side === 'enemy' && enemy.maxHp > 0 && enemy.damage)).toBe(true);
    });

    it('infers themes from the location and honours an explicit setting', () => {
        expect(inferTerrainTheme('The Sunken Keep, Crypt')).toBe('dungeon');
        expect(inferTerrainTheme('Whispering Woods')).toBe('forest');
        expect(inferTerrainTheme('Market Square, Docks')).toBe('city');
        expect(inferTerrainTheme('The Rusty Tankard inn')).toBe('interior');
        expect(resolveTerrainTheme({ tacticalCombatTerrainTheme: 'forest' }, { location: 'Dungeon', sceneExcerpt: '' })).toBe('forest');
        expect(resolveTerrainTheme({ tacticalCombatTerrainTheme: 'auto' }, { location: 'Cave', sceneExcerpt: '' })).toBe('cave');
    });

    it('builds an encounter from an existing [COMBAT] block with the configured grid and turn style', () => {
        const context = collectEncounterContext({ ...BASE_SETTINGS, currentMemo: MEMO }, CTX);
        const { state, warnings } = buildEncounterFromContext(context, {
            ...BASE_SETTINGS,
            tacticalCombatGridPreset: '10x10',
            tacticalCombatTurnStyle: 'initiative',
            tacticalCombatEncounterSource: 'existing',
        }, { seed: 77 });
        expect(warnings).toEqual([]);
        expect(state.grid).toEqual({ rows: 10, cols: 10 });
        expect(state.turnStyle).toBe('initiative');
        expect(state.location).toBe('The Sunken Keep, Gatehouse');
        expect(state.units.filter(unit => unit.side === 'player').map(unit => unit.name)).toEqual(['Aria', 'Mira']);
        expect(state.units.filter(unit => unit.side === 'enemy').map(unit => unit.name)).toEqual(['Goblin Archer', 'Goblin Brute']);
        expect(state.units.filter(unit => unit.side === 'ally').map(unit => unit.name)).toEqual(['Sera']);
        expect(state.status).toBe('active');
    });

    it('uses agent-authored enemies and terrain when the agent source is selected', () => {
        const context = collectEncounterContext({ ...BASE_SETTINGS, currentMemo: '' }, { name1: 'Rook', chatId: 'empty', chat: [] });
        const agentEncounter = {
            title: 'Bridge Ambush',
            description: 'Raiders block the bridge.',
            terrainTheme: 'city',
            grid: { rows: 8, cols: 8 },
            terrain: Array.from({ length: 8 }, (_, index) => index === 2 ? '..oo....' : '........'),
            enemies: [
                { name: 'Bridge Raider', maxHp: 14, ac: 12, attackBonus: 4, damage: '1d6+2' },
                { name: 'Bridge Archer', maxHp: 10, ac: 11, attackBonus: 5, damage: '1d8+1', attackRange: 6 },
            ],
        };
        const { state } = buildEncounterFromContext(context, {
            ...BASE_SETTINGS,
            tacticalCombatGridPreset: 'dynamic',
            tacticalCombatEncounterSource: 'agent',
        }, { agentEncounter, seed: 99 });
        expect(state.title).toBe('Bridge Ambush');
        expect(state.grid).toEqual({ rows: 8, cols: 8 });
        expect(state.terrainTheme).toBe('city');
        expect(state.terrain[2][2]).toBe('cover');
        expect(state.units.filter(unit => unit.side === 'enemy').map(unit => unit.name)).toEqual(['Bridge Raider', 'Bridge Archer']);
    });

    it('parses the standalone [ABILITIES], [SPELLS], and [INVENTORY] blocks into the character loadout', () => {
        const memo = `[CHARACTER]
Corrin (Manakete): 68/68 HP
Combat: BAB: +6 | Ranged (1 attack): +9 | Melee (1 attack): +11 | Base AC: 15 | Total AC: 18
Gear: Yato (1d8+3 Slashing, +2 to hit) | Dragonstone (transformation focus) | Scale Armor (+3 AC)
Attr: STR 16 (+3), DEX 14 (+2), CON 16 (+3), INT 12 (+1), WIS 14 (+2), CHA 16 (+3)
HD: d10 (6/6)
Status: Healthy
[/CHARACTER]

[ABILITIES]
- Dragonstone Transformation (Bonus action, assume partial or full dragon form; gains scales, spear-like appendages, and hydrokinetic attacks; 2/2 per long rest)
- Hydrokinesis (While transformed, summon water pillars or blast foes with water projectiles; 3/3 per long rest)
- Dragon Vein Manipulation (Alter terrain for tactical advantage within a sensed Dragon Vein; 1/1 per long rest)
[/ABILITIES]

[SPELLS]
Cantrips: Prestidigitation
Level 1 (2/2): Cure Wounds, Shield of Faith
[/SPELLS]

[INVENTORY]
Gear:
- ⚔️ [Epic] [E] Yato (1d8+3 Slashing, +2 to hit) (~5,000 GP)
- 🐉 [Rare] [E] Dragonstone (Transformation focus; enables dragon form) (~2,500 GP)
- 🛡️ [Uncommon] [E] Scale Armor (AC +3) (~150 GP)
Other Items:
- 💰 45 GP
- 🧪 Healing Potion x2 [Common]
[/INVENTORY]`;
        const context = collectEncounterContext({ ...BASE_SETTINGS, currentMemo: memo }, { name1: 'Corrin', chatId: 'loadout', chat: [] });
        const corrin = context.playerUnits[0];
        expect(corrin.name).toBe('Corrin');
        const skills = Object.fromEntries(corrin.skills.map(skill => [skill.name, skill]));
        expect(skills['Dragonstone Transformation']).toMatchObject({ kind: 'special', maxUses: 2 });
        expect(skills.Hydrokinesis).toMatchObject({ kind: 'special', maxUses: 3 });
        expect(skills['Dragon Vein Manipulation']).toMatchObject({ kind: 'special', maxUses: 1 });
        expect(skills['Cure Wounds']).toMatchObject({ kind: 'heal' });
        expect(skills['Shield of Faith']).toMatchObject({ kind: 'buff' });
        expect(skills.Prestidigitation).toMatchObject({ kind: 'special' });
        expect(corrin.inventory.map(entry => entry.name)).toEqual(expect.arrayContaining(['Yato', 'Dragonstone', 'Scale Armor']));
        expect(corrin.inventory.map(entry => entry.name)).not.toContain('45 GP');
        expect(corrin.items.map(item => item.name)).toContain('Healing Potion');
    });

    it('passes abilities, spells, items, and inventory to the encounter architect payload', () => {
        const context = {
            playerUnits: [{
                name: 'Corrin', classLabel: 'Manakete', hp: 68, maxHp: 68, ac: 18, attackBonus: 11,
                attackRange: 1, damage: '1d8+3', skills: [
                    { name: 'Dragonstone Transformation', kind: 'special', range: 6, maxUses: 2, description: 'Transform.' },
                    { name: 'Cure Wounds', kind: 'heal', range: 6, heal: '1d8+2', maxUses: 2 },
                ], items: [{ name: 'Healing Potion', kind: 'heal', amount: '2d4+2', maxUses: 2 }],
                inventory: [{ name: 'Yato', description: '1d8+3', equipped: true }],
            }],
            allies: [], enemies: [], location: "Dragon's Gate", sceneExcerpt: '', summary: {},
        };
        const payload = buildEncounterRequestPayload(context, BASE_SETTINGS);
        expect(payload.party[0].skills.map(skill => skill.name)).toContain('Dragonstone Transformation');
        expect(payload.party[0].items[0].name).toBe('Healing Potion');
        expect(payload.party[0].inventory[0].name).toBe('Yato');
    });

    it('applies user-edited classifier rules and buff defaults to the loadout', () => {
        const memo = `[CHARACTER]
Corrin (Manakete): 68/68 HP
Status: Healthy
[/CHARACTER]

[ABILITIES]
- Dragon Breath (Exhale a cone of draconic energy; 1/1 per rest)
[/ABILITIES]

[INVENTORY]
Other Items:
- Relic of Tides (Unleash a wave; 1/1)
[/INVENTORY]`;
        const classifier = {
            skillRules: [{ kind: 'buff', keywords: ['dragon breath'] }],
            buff: { acBonus: 5, attackBonus: 3, rounds: 4, acKeywords: ['dragon'], attackKeywords: ['dragon'] },
            items: {
                usableKeywords: ['relic'],
                healingKeywords: [],
                specialItemKeywords: ['relic'],
            },
        };
        const context = collectEncounterContext({
            ...BASE_SETTINGS,
            currentMemo: memo,
            tacticalCombatClassifierJson: JSON.stringify(classifier),
        }, { name1: 'Corrin', chatId: 'classifier', chat: [] });
        const skill = context.playerUnits[0].skills.find(entry => entry.name === 'Dragon Breath');
        expect(skill).toMatchObject({ kind: 'buff', acBonus: 5, attackBonus: 3, rounds: 4 });
        const item = context.playerUnits[0].items.find(entry => entry.name === 'Relic of Tides');
        expect(item).toMatchObject({ kind: 'special' });
    });

    it('falls back to the shipped classifier when the setting is invalid', () => {
        const memo = `[CHARACTER]\nCorrin (Manakete): 10/10 HP\n[/CHARACTER]\n[ABILITIES]\n- Cure Wounds (Restore 1d8 HP; 1/1)\n[/ABILITIES]`;
        const context = collectEncounterContext({
            ...BASE_SETTINGS,
            currentMemo: memo,
            tacticalCombatClassifierJson: '{"skillRules": broken}',
        }, { name1: 'Corrin', chatId: 'bad-classifier', chat: [] });
        expect(context.playerUnits[0].skills.find(entry => entry.name === 'Cure Wounds').kind).toBe('heal');
    });

    it('fails clearly when existing-only mode has no active [COMBAT] block', () => {
        const context = collectEncounterContext({ ...BASE_SETTINGS, currentMemo: '' }, { name1: 'Rook', chatId: 'empty', chat: [] });
        expect(() => buildEncounterFromContext(context, {
            ...BASE_SETTINGS,
            tacticalCombatEncounterSource: 'existing',
        }, { seed: 1 })).toThrow(/No active \[COMBAT\] enemies/i);
    });

    it('provides a usable fallback player', () => {
        const player = buildFallbackPlayer({ name1: 'Rook' }, 5);
        expect(player.name).toBe('Rook');
        expect(player.skills.length).toBeGreaterThan(0);
        expect(player.items.length).toBeGreaterThan(0);
        expect(player.speed).toBe(5);
    });
});
