import { describe, expect, it } from 'vitest';
import { buildTacticalCombatMarkup, escapeHtml } from '../src/features/tactical-combat/tactical-combat-markup.js';
import {
    createEncounterState,
    getUnitById,
    retreatEncounter,
} from '../src/features/tactical-combat/tactical-combat-engine.js';
import { TC_TERRAIN, TC_TERRAIN_KEYS } from '../src/features/tactical-combat/tactical-combat-constants.js';

function makeState() {
    const state = createEncounterState({
        seed: 21,
        grid: { rows: 10, cols: 10 },
        terrainRows: Array.from({ length: 10 }, (_, y) => (y === 3 ? '..##..oo..' : '..........')),
        terrainTheme: 'dungeon',
        turnStyle: 'phase',
        movement: 6,
        units: [
            { id: 'pc-1', name: 'Aria', side: 'player', maxHp: 30, hp: 22, ac: 15, attackBonus: 5, damage: '1d8+3', initiativeBonus: 3, items: [{ id: 'potion', name: 'Potion', kind: 'heal', amount: '2d4+2', uses: 2, maxUses: 2, range: 0 }], skills: [{ id: 'firebolt', name: 'Firebolt', kind: 'attack', range: 6, damage: '1d10', uses: 3, maxUses: 3 }] },
            { id: 'pc-2', name: 'Borin', side: 'player', maxHp: 40, hp: 40, ac: 17, attackBonus: 4, damage: '1d10+2', initiativeBonus: 1 },
            { id: 'enemy-3', name: 'Goblin Archer', side: 'enemy', maxHp: 12, hp: 12, ac: 13, attackBonus: 5, damage: '1d6+2', attackRange: 6 },
        ],
    });
    state.units[0].x = 1;
    state.units[0].y = 1;
    state.units[1].x = 1;
    state.units[1].y = 2;
    state.units[2].x = 8;
    state.units[2].y = 1;
    return state;
}

describe('tactical combat markup', () => {
    it('renders a centered empty state with start/settings actions', () => {
        const html = buildTacticalCombatMarkup(null, { error: 'No encounter.' });
        expect(html).toContain('rt-tc-empty');
        expect(html).toContain('No encounter on the board');
        expect(html).toContain('data-tc-action="start"');
        expect(html).toContain('data-tc-action="settings"');
        expect(html).toContain('No encounter.');
    });

    it('renders every grid cell, terrain glyph, token, and the full legend', () => {
        const state = makeState();
        const html = buildTacticalCombatMarkup(state, {
            selectedUnitId: 'pc-1',
            mode: 'move',
            reachableCells: new Set(['2,1', '2,2']),
            targetCells: new Set(),
        });
        expect(html.match(/data-tc-cell=/g)).toHaveLength(100);
        expect(html).toContain('rt-tc-grid');
        expect(html).toContain('Aria');
        expect(html).toContain('Borin');
        expect(html).toContain('Goblin Archer');
        expect(html).toContain('rt-tc-token');
        expect(html).toContain('is-reachable');
        expect(html).toContain('data-tc-select-unit="pc-1"');
        expect(html).toContain('Round 1');
        expect(html).toContain('Player Phase');
        expect(html).toContain('Terrain key');
        for (const key of TC_TERRAIN_KEYS) {
            expect(html).toContain(TC_TERRAIN_KEYS.includes(key) ? TC_TERRAIN[key].label : key);
        }
        expect(html).toContain('rt-tc-terrain-wall');
        expect(html).toContain('rt-tc-terrain-cover');
        expect(html).toContain('is-selected');
        expect(html).toContain('rt-tc-hpbar');
    });

    it('renders the action bar, skills, items, and turn controls for the selected player unit', () => {
        const state = makeState();
        const html = buildTacticalCombatMarkup(state, { selectedUnitId: 'pc-1', mode: 'move' });
        expect(html).toContain('data-tc-action="mode-move"');
        expect(html).toContain('data-tc-action="mode-attack"');
        expect(html).toContain('data-tc-action="defend"');
        expect(html).toContain('data-tc-action="wait"');
        expect(html).toContain('data-tc-action="flee"');
        expect(html).toContain('Firebolt');
        expect(html).toContain('Potion');
        expect(html).toContain('End player phase');
        expect(html).toContain('Retreat');
        expect(html).toContain('Combat log');
    });

    it('hides disabled catalogue actions', () => {
        const state = makeState();
        state.actionCatalog = state.actionCatalog.map(entry => entry.type === 'attack' ? { ...entry, enabled: false } : entry);
        const html = buildTacticalCombatMarkup(state, { selectedUnitId: 'pc-1' });
        expect(html).not.toContain('data-tc-action="mode-attack"');
        expect(html).toContain('data-tc-action="mode-move"');
    });

    it('uses catalogue labels for the board buttons', () => {
        const state = makeState();
        state.actionCatalog = state.actionCatalog.map(entry => entry.type === 'attack' ? { ...entry, label: 'Strike' } : entry);
        const html = buildTacticalCombatMarkup(state, { selectedUnitId: 'pc-1' });
        expect(html).toContain('⚔</span>Strike');
        expect(html).toContain('title="Make one weapon or cantrip attack against a target in range."');
    });

    it('is safe against model-authored HTML in names and descriptions', () => {
        const state = makeState();
        state.title = '<img src=x onerror=alert(1)>';
        state.units[0].name = '<script>alert(1)</script>';
        state.description = '<b>unsafe</b>';
        const html = buildTacticalCombatMarkup(state, { selectedUnitId: 'pc-1' });
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&lt;img src=x');
        expect(escapeHtml('"quoted" & <tag>')).toBe('&quot;quoted&quot; &amp; &lt;tag&gt;');
    });

    it('renders a result dialog for a finished encounter', () => {
        const state = makeState();
        retreatEncounter(state);
        const html = buildTacticalCombatMarkup(state, { selectedUnitId: 'pc-1' });
        expect(html).toContain('rt-tc-result');
        expect(html).toContain('Retreat');
        expect(html).toContain('data-tc-action="continue-narration"');
        expect(html).toContain('data-tc-action="dismiss-result"');
        expect(html).toContain('data-tc-action="new-encounter"');
    });

    it('renders the resume banner for a pending agent turn and a busy state', () => {
        const state = makeState();
        state.phase = 'enemy';
        state.pendingAgentUnitIds = ['enemy-3'];
        const pending = buildTacticalCombatMarkup(state, { selectedUnitId: 'pc-1' });
        expect(pending).toContain('Enemy turn pending');
        expect(pending).toContain('data-tc-action="resume-agent"');

        const busy = buildTacticalCombatMarkup(state, {
            selectedUnitId: 'pc-1',
            busy: true,
            busyLabel: 'Agent thinking',
            abortable: true,
        });
        expect(busy).toContain('Agent thinking');
        expect(busy).toContain('data-tc-action="abort-agent"');
    });

    it('renders initiative order and the active-unit end-turn button', () => {
        const state = makeState();
        state.turnStyle = 'initiative';
        state.initiativeOrder = ['pc-1', 'enemy-3', 'pc-2'];
        state.turnIndex = 0;
        state.phase = 'player';
        // Make it Aria's turn without relying on deployment randomness.
        const html = buildTacticalCombatMarkup(state, { selectedUnitId: 'pc-1' });
        expect(html).toContain('rt-tc-initiative');
        expect(html).toContain('rt-tc-init-item');
        expect(html).toMatch(/rt-tc-init-item[^"]*is-active/);
        expect(html).toContain('End Aria');
        expect(html).toContain('Initiative');
    });

    it('marks a defeated token as a corpse instead of an interactive token', () => {
        const state = makeState();
        getUnitById(state, 'enemy-3').defeated = true;
        getUnitById(state, 'enemy-3').hp = 0;
        const html = buildTacticalCombatMarkup(state, { selectedUnitId: 'pc-1' });
        expect(html).toContain('rt-tc-corpse');
    });
});
