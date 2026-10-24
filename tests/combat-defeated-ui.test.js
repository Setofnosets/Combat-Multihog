import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../portrait-storage.js', () => ({
    lookupCustomPortraitSrc: () => '',
}));

import {
    buildCombatDisplayMemo,
    parseCombatants,
    partitionResolvedCombatants,
} from '../src/state/combat-persistence.js';
import { getSettings } from '../state-manager.js';
import {
    buildModulesInstructionText,
    memoForGmContext,
    memoForTrackerContext,
    mergeMemo,
} from '../memo-processor.js';
import { blockToItems } from '../renderer.js';

const styles = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

const ACTIVE_COMBAT = `[COMBAT]
COMBAT ROUND 1
Ghoul: 6/24 HP
Att/def: Claws
Status: Healthy
Bandit: 8/18 HP
Att/def: Shortsword
Status: Healthy
[/COMBAT]`;

describe('UI-only defeated combatants', () => {
    beforeEach(() => {
        getSettings().combatDefeatedUi = [];
    });

    it('requires an explicit resolved status rather than zero HP alone', () => {
        const result = partitionResolvedCombatants(`COMBAT ROUND 2
Ghoul: 0/24 HP
Att/def: Claws
Status: Dying (Death Saves 1/3)
Bandit: 0/18 HP
Att/def: Shortsword
Status: Defeated`);

        expect(result.activeContent).toContain('Ghoul: 0/24 HP');
        expect(result.activeContent).toContain('Death Saves 1/3');
        expect(result.activeContent).not.toContain('Bandit:');
        expect(result.defeatedCombatants).toEqual([{
            name: 'Bandit',
            content: 'Bandit: 0/18 HP\nAtt/def: Shortsword\nStatus: Defeated',
        }]);

        const inline = partitionResolvedCombatants('Wight: 0/45 HP | Status: ((DEBUFF)) Dead');
        expect(inline.activeContent).toBe('');
        expect(inline.defeatedCombatants[0].name).toBe('Wight');
    });

    it('archives and renders explicitly defeated combatants with negative HP', () => {
        const content = `COMBAT ROUND 5
Novice Assassin C: -4/15 HP
Att/def: Shortsword (1 attack, +4 / 1d6+2 Piercing) | Leather Armor (AC: 14)
Saves: Fort +1, Ref +5, Will +0
Abilities: Sneak Attack (+1d6), Nimble Escape
Status: Defeated
Shadowblade Mentor: 45/45 HP
Status: Healthy`;

        const partitioned = partitionResolvedCombatants(content);
        expect(partitioned.activeContent).not.toContain('Novice Assassin C');
        expect(partitioned.activeContent).toContain('Shadowblade Mentor: 45/45 HP');
        expect(partitioned.defeatedCombatants).toEqual([{
            name: 'Novice Assassin C',
            content: `Novice Assassin C: -4/15 HP
Att/def: Shortsword (1 attack, +4 / 1d6+2 Piercing) | Leather Armor (AC: 14)
Saves: Fort +1, Ref +5, Will +0
Abilities: Sneak Attack (+1d6), Nimble Escape
Status: Defeated`,
        }]);

        const html = blockToItems('COMBAT', content).join('');
        expect(html).toContain('data-defeated-combatant="Novice Assassin C"');
        expect(html).toContain('<span class="rt-hp-label">-4/15</span>');
        expect(html).toContain('width:0.0%');
    });

    it('parses optional enemy and temporary-ally sections without crossing entity boundaries', () => {
        const content = `COMBAT ROUND 3
ENEMIES:
Cultist: 0/15 HP
Status: Defeated
NON-PARTY ALLIES:
City Guard: 0/22 HP
Status: Defeated`;

        expect(parseCombatants(content).map(({ name, side }) => ({ name, side }))).toEqual([
            { name: 'Cultist', side: 'enemies' },
            { name: 'City Guard', side: 'allies' },
        ]);

        const partitioned = partitionResolvedCombatants(content);
        expect(partitioned.activeContent).toContain('ENEMIES:');
        expect(partitioned.activeContent).not.toContain('Cultist:');
        expect(partitioned.activeContent).toContain('NON-PARTY ALLIES:\nCity Guard: 0/22 HP');
        expect(partitioned.defeatedCombatants.map(entry => entry.name)).toEqual(['Cultist']);

        const display = buildCombatDisplayMemo(
            `[COMBAT]\n${partitioned.activeContent}\n[/COMBAT]`,
            partitioned.defeatedCombatants,
        );
        expect(display.indexOf('Cultist: 0/15 HP')).toBeLessThan(display.indexOf('NON-PARTY ALLIES:'));
    });

    it('renders red ENEMIES and blue ALLIES headers while retaining headerless compatibility', () => {
        const groupedHtml = blockToItems('COMBAT', `COMBAT ROUND 1
ENEMIES:
Bandit: 10/10 HP
Status: Healthy
NON-PARTY ALLIES:
Town Guard: 12/12 HP
Status: Healthy`).join('');

        expect(groupedHtml).toContain('rt-combat-side-header--enemies">ENEMIES</div>');
        expect(groupedHtml).toContain('rt-combat-side-header--allies">ALLIES</div>');
        expect(groupedHtml).toContain('Bandit');
        expect(groupedHtml).toContain('Town Guard');
        expect(styles).toMatch(/\.rt-combat-side-header--enemies\s*\{[^}]*color:\s*#f87171/s);
        expect(styles).toMatch(/\.rt-combat-side-header--allies\s*\{[^}]*color:\s*#60a5fa/s);

        const headerlessHtml = blockToItems('COMBAT', `COMBAT ROUND 1
Bandit: 10/10 HP
Status: Healthy`).join('');
        expect(headerlessHtml).toContain('class="rt-entity-name">Bandit</div>');
        expect(headerlessHtml).not.toContain('rt-combat-side-header');

        const legacyAlliesHtml = blockToItems('COMBAT', `COMBAT ROUND 1
ALLIES:
Town Guard: 12/12 HP
Status: Healthy`).join('');
        expect(legacyAlliesHtml).toContain('rt-combat-side-header--allies">ALLIES</div>');
    });

    it('strips resolved enemies from model state while retaining them in the display memo', () => {
        const merged = mergeMemo(ACTIVE_COMBAT, `[COMBAT]
COMBAT ROUND 2
Ghoul: 0/24 HP
Att/def: Claws
Status: Dying (Death Saves 1/3)
Bandit: 0/18 HP
Att/def: Shortsword
Status: Dead
[/COMBAT]`);

        expect(merged).toContain('Ghoul: 0/24 HP');
        expect(merged).not.toContain('Bandit:');
        expect(memoForGmContext(merged)).not.toContain('Bandit');

        const displayMemo = buildCombatDisplayMemo(merged, getSettings().combatDefeatedUi);
        expect(displayMemo).toContain('Ghoul: 0/24 HP');
        expect(displayMemo).toContain('Bandit: 0/18 HP');
        expect(displayMemo).toContain('Status: Dead');
    });

    it('filters resolved entries from outgoing contexts even in legacy or manually edited memos', () => {
        const legacyMemo = `[COMBAT]
COMBAT ROUND 7
Ghoul: 0/24 HP
Status: Dying (Death Saves 1/3)
Bandit: 0/18 HP
Status: Dead
[/COMBAT]`;

        for (const outgoing of [
            memoForTrackerContext(legacyMemo),
            memoForGmContext(legacyMemo),
        ]) {
            expect(outgoing).toContain('Ghoul: 0/24 HP');
            expect(outgoing).toContain('Death Saves 1/3');
            expect(outgoing).not.toContain('Bandit:');
            expect(outgoing).not.toContain('Status: Dead');
        }
    });

    it('enforces explicit resolution semantics without overwriting custom combat prompts', () => {
        const customCombatPrompt = 'Render combat in a cyberpunk style.';
        const settings = {
            stockPrompts: { combat: customCombatPrompt },
            modules: { combat: true },
            syspromptModules: {},
            customFields: [],
            initialDate: '',
            currentMemo: '',
        };

        const instructions = buildModulesInstructionText(settings);
        expect(settings.stockPrompts.combat).toBe(customCombatPrompt);
        expect(instructions).toContain(customCombatPrompt);
        expect(instructions).toContain('DEFEATED COMBATANTS: While a fight is active, mark defeated enemies as Status: Defeated');
        expect(instructions).toContain('COMBAT SIDES: Group combatants under ENEMIES: and NON-PARTY ALLIES: headers');
        expect(instructions).toContain('COMBAT STATE: Begin every [COMBAT] block');
        expect(instructions).toContain('COMBAT RESOLUTION: Close [COMBAT]');
        expect(instructions).toContain('Never put any [PARTY] member in [COMBAT].');

        settings.stockPrompts.combat = 'Group combatants under ENEMIES: and ALLIES:.';
        const migratedInstructions = buildModulesInstructionText(settings);
        expect(migratedInstructions).toContain('Group combatants under ENEMIES: and ALLIES:.');
        expect(migratedInstructions).toContain('COMBAT SIDES: Group combatants under ENEMIES: and NON-PARTY ALLIES: headers');
    });

    it('keeps the UI archive across rounds, removes revived names, and clears it at END_COMBAT', () => {
        mergeMemo(ACTIVE_COMBAT, `[COMBAT]
COMBAT ROUND 2
Bandit: 0/18 HP
Status: Defeated
[/COMBAT]`);
        expect(getSettings().combatDefeatedUi.map(entry => entry.name)).toEqual(['Bandit']);

        const revived = mergeMemo('[COMBAT]\nCOMBAT ROUND 2\n[/COMBAT]', `[COMBAT]
COMBAT ROUND 3
Bandit: 5/18 HP
Status: Prone
[/COMBAT]`);
        expect(revived).toContain('Bandit: 5/18 HP');
        expect(getSettings().combatDefeatedUi).toEqual([]);

        getSettings().combatDefeatedUi = [{ name: 'Bandit', content: 'Bandit: 0/18 HP\nStatus: Defeated' }];
        const ended = mergeMemo(revived, '[COMBAT]END_COMBAT[/COMBAT]');
        expect(ended).not.toContain('[COMBAT]');
        expect(getSettings().combatDefeatedUi).toEqual([]);
    });

    it('marks only explicitly resolved UI entries as defeated', () => {
        const html = blockToItems('COMBAT', `COMBAT ROUND 2
Ghoul: 0/24 HP
Status: Dying (Death Saves 1/3)
Bandit: 0/18 HP
Status: Defeated`).join('');

        expect(html).toContain('Ghoul');
        expect(html).toContain('Death Saves 1/3');
        expect(html).toContain('data-defeated-combatant="Bandit"');
        expect(html.match(/rt-combatant-defeated/g)).toHaveLength(1);
    });

    it('renders temporary allies with unknown ?/? or ??/?? HP as complete combatants', () => {
        const content = `COMBAT ROUND 1
NON-PARTY ALLIES:
Schwarzenegger: ?/? HP
Att/def: Schwarzenminigun (1 attack, +12 / firearm damage unspecified) | Armor (AC: unknown)
Saves: Fort unknown, Ref unknown, Will unknown
Abilities: None declared
Other: Temporary allied combatant
Status: Active (this combat)
Schwarzenegev: ??/?? HP
Att/def: Argument Ender (1 attack, +8 / firearm damage unspecified) | Armor (AC: unknown)
Status: Active (this combat)`;

        expect(parseCombatants(content).map(({ name, side }) => ({ name, side }))).toEqual([
            { name: 'Schwarzenegger', side: 'allies' },
            { name: 'Schwarzenegev', side: 'allies' },
        ]);

        const html = blockToItems('COMBAT', content).join('');
        expect(html).toContain('Schwarzenegger');
        expect(html).toContain('Schwarzenegev');
        expect(html).toContain('Schwarzenminigun');
        expect(html).toContain('Argument Ender');
        expect(html).toContain('>?/?</span>');
        expect(html).toContain('>??/??</span>');
        expect(html.match(/rt-hp-unknown/g)).toHaveLength(2);
        expect(html).not.toContain('data-rt-bar-current');
    });
});
