import { describe, expect, it } from 'vitest';
import { buildTraditionalCombatMarkup } from '../src/features/traditional-combat/traditional-combat-markup.js';
import { createTraditionalEncounterState } from '../src/features/traditional-combat/traditional-combat-engine.js';

function makeState() {
    return createTraditionalEncounterState({
        title: 'The <Gate>',
        seed: 1,
        turnStyle: 'phase',
        units: [
            { name: 'Aria <script>', side: 'player', maxHp: 20, hp: 20, ac: 12, attackBonus: 4, damage: '1d8' },
            { name: 'Goblin', side: 'enemy', maxHp: 10, hp: 10, ac: 10, attackBonus: 2, damage: '1d4' },
        ],
    });
}

describe('traditional combat markup', () => {
    it('renders a roster board without any grid cells', () => {
        const state = makeState();
        const html = buildTraditionalCombatMarkup(state, { selectedUnitId: state.units[0].id, mode: 'attack', targetIds: [state.units[1].id] });
        expect(html).toContain('Traditional Combat');
        expect(html).toContain('rt-trad-roster');
        expect(html).toContain('data-trad-select-unit');
        expect(html).toContain('data-trad-target');
        expect(html).not.toContain('data-tc-cell');
        expect(html).not.toContain('rt-tc-grid');
    });

    it('escapes names and titles and renders the target list', () => {
        const state = makeState();
        const html = buildTraditionalCombatMarkup(state, {
            selectedUnitId: state.units[0].id,
            mode: 'attack',
            targetIds: [state.units[1].id],
            targetLabels: { [state.units[1].id]: 'Goblin (10/10 HP)' },
        });
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('<script>');
        expect(html).toContain('The &lt;Gate&gt;');
        expect(html).toContain('Goblin (10/10 HP)');
    });

    it('renders the empty state and the outcome dialog', () => {
        const empty = buildTraditionalCombatMarkup(null, {});
        expect(empty).toContain('No encounter on the board');
        const state = makeState();
        state.status = 'victory';
        state.phase = 'ended';
        state.outcome = {
            label: 'Victory',
            summary: 'Victory after 1 round.',
            details: ['The opposition is broken.'],
        };
        const html = buildTraditionalCombatMarkup(state, {});
        expect(html).toContain('Encounter complete');
        expect(html).toContain('Return to narration');
    });
});
