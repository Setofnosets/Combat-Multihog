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
        expect(html).toContain('rt-tc-log-list');
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

    it('renders escaped action previews and per-target prediction lines', () => {
        const state = makeState();
        const targetId = state.units[1].id;
        const html = buildTraditionalCombatMarkup(state, {
            selectedUnitId: state.units[0].id,
            mode: 'attack',
            targetIds: [targetId],
            targetLabels: { [targetId]: 'Goblin (10/10 HP) — 65% hit · 1d8 (avg 4.5) · AC 10 <b>' },
            actionPreview: {
                title: 'Fire <bolt>',
                description: 'A "fiery" idea & more.',
                lines: ['<img src=x onerror=alert(1)>'],
                special: false,
            },
        });
        expect(html).toContain('rt-trad-action-preview');
        expect(html).toContain('Fire &lt;bolt&gt;');
        expect(html).toContain('A &quot;fiery&quot; idea &amp; more.');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).toContain('<small>65% hit · 1d8 (avg 4.5) · AC 10 &lt;b&gt;</small>');
    });

    it('uses effective AC and attack values in the card chips', () => {
        const state = makeState();
        const unit = state.units[0];
        unit.statuses = [{ id: 'focus', label: 'Focus', acBonus: 2, attackBonus: 3 }];
        const html = buildTraditionalCombatMarkup(state, { selectedUnitId: unit.id, mode: 'attack' });
        expect(html).toContain(`AC ${12 + 2}`);
        expect(html).toContain('ATK +7');
        expect(html).not.toContain('AC 12');
        expect(html).not.toContain('ATK +4');
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

    it('offers a click-to-compile retry for pending passives', () => {
        const state = makeState();
        state.units[0].skills.push({
            id: 'noble-bearing',
            name: 'Noble Bearing',
            kind: 'special',
            passive: true,
            unlimited: true,
            maxUses: 0,
            uses: 0,
            effectTemplate: null,
        });
        const html = buildTraditionalCombatMarkup(state, { selectedUnitId: state.units[0].id, mode: 'attack' });
        expect(html).toContain('data-trad-action="resolve-passive"');
        expect(html).toContain(`data-trad-unit-id="${state.units[0].id}"`);
        expect(html).toContain('data-trad-skill-id="noble-bearing"');
        const busyHtml = buildTraditionalCombatMarkup(state, { selectedUnitId: state.units[0].id, mode: 'attack', busy: true });
        expect(busyHtml).toMatch(/data-trad-action="resolve-passive"[^>]*disabled/);
    });

    it('shows a resolved flavour passive as inactive, not pending', () => {
        const state = makeState();
        state.units[0].skills.push({
            id: 'noble-bearing',
            name: 'Noble Bearing',
            kind: 'special',
            passive: true,
            unlimited: true,
            maxUses: 0,
            uses: 0,
            trigger: { event: 'battle-start' },
            effectTemplate: [],
            registryStatus: 'resolved',
        });
        const html = buildTraditionalCombatMarkup(state, { selectedUnitId: state.units[0].id, mode: 'attack' });
        expect(html).not.toContain('data-trad-action="resolve-passive"');
        expect(html).toContain('flavour, no mechanical effect');
    });
});
