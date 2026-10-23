import { describe, expect, it } from 'vitest';
import {
    applyAction,
    applyOpeningAction,
    applySpecialEffects,
    applySurprise,
    beginRound,
    buildAgentGameState,
    buildOutcomeSummary,
    checkEncounterEnd,
    chebyshev,
    completeAgentTurn,
    createEncounterState,
    createProceduralTerrain,
    decodeTerrainRows,
    endTurn,
    findPath,
    getActiveUnit,
    getEffectiveAc,
    getPendingAgentUnitIds,
    getUnitById,
    hasLineOfSight,
    interpretActions,
    pathCost,
    retreatEncounter,
    rollDice,
    serializeAgentGameState,
} from '../src/features/tactical-combat/tactical-combat-engine.js';
import { resolveGridDimensions, TC_TERRAIN } from '../src/features/tactical-combat/tactical-combat-constants.js';

const ROWS = 8;
const COLS = 8;

function openTerrain(rows = ROWS, cols = COLS) {
    return Array.from({ length: rows }, () => '.'.repeat(cols));
}

function makeState({ turnStyle = 'phase', units = null, rows = ROWS, cols = COLS } = {}) {
    const state = createEncounterState({
        seed: 1234,
        grid: { rows, cols },
        terrainRows: openTerrain(rows, cols),
        terrainTheme: 'dungeon',
        turnStyle,
        movement: 6,
        units: units || [
            { id: 'pc-1', name: 'Aria', side: 'player', maxHp: 20, hp: 20, ac: 12, attackBonus: 5, damage: '1d8+2', initiativeBonus: 5 },
            { id: 'pc-2', name: 'Borin', side: 'player', maxHp: 24, hp: 24, ac: 14, attackBonus: 4, damage: '1d10+1', initiativeBonus: 1 },
            { id: 'enemy-3', name: 'Goblin', side: 'enemy', maxHp: 8, hp: 8, ac: 10, attackBonus: 3, damage: '1d6', initiativeBonus: 0 },
        ],
    });
    const [pc1, pc2, enemy] = state.units;
    pc1.x = 1; pc1.y = 1;
    pc2.x = 1; pc2.y = 2;
    enemy.x = 3; enemy.y = 1;
    state.terrain = openTerrain(rows, cols).map(row => row.split('').map(char => ({ '.': 'floor' }[char] || 'floor')));
    return state;
}

const lowRoll = () => 0.25; // d20 = 6, d8 = 3
const midRoll = () => 0.5; // d20 = 11, d8 = 5
const highRoll = () => 0.99; // d20 = 20 (crit), d8 = 8

describe('tactical combat grid & encounter construction', () => {
    it('creates deterministic procedural terrain with the requested dimensions and clear deployment lanes', () => {
        const a = createProceduralTerrain({ rows: 10, cols: 12, theme: 'forest', density: 55, seed: 42 });
        const b = createProceduralTerrain({ rows: 10, cols: 12, theme: 'forest', density: 55, seed: 42 });
        expect(a).toEqual(b);
        expect(a.rows).toBe(10);
        expect(a.cols).toBe(12);
        expect(a.terrain).toHaveLength(10);
        expect(a.terrain.every(row => row.length === 12)).toBe(true);
        for (let y = 0; y < 10; y += 1) {
            expect(TC_TERRAIN[a.terrain[y][0]].walkable).toBe(true);
            expect(TC_TERRAIN[a.terrain[y][1]].walkable).toBe(true);
            expect(TC_TERRAIN[a.terrain[y][10]].walkable).toBe(true);
            expect(TC_TERRAIN[a.terrain[y][11]].walkable).toBe(true);
        }
        expect(a.terrain.flat().every(id => TC_TERRAIN[id])).toBe(true);
    });

    it('resolves fixed, dynamic, and custom grid presets', () => {
        expect(resolveGridDimensions({ tacticalCombatGridPreset: '20x20' }, 4)).toMatchObject({ rows: 20, cols: 20, mode: '20x20' });
        const dynamic = resolveGridDimensions({ tacticalCombatGridPreset: 'dynamic' }, 12);
        expect(dynamic.rows).toBeGreaterThanOrEqual(8);
        expect(dynamic.rows).toBeLessThanOrEqual(24);
        expect(dynamic.rows).toBe(dynamic.cols);
        expect(resolveGridDimensions({ tacticalCombatGridPreset: 'custom', tacticalCombatGridRows: 9, tacticalCombatGridCols: 13 }, 4))
            .toEqual({ rows: 9, cols: 13, mode: 'custom' });
        expect(resolveGridDimensions({ tacticalCombatGridPreset: 'custom' }, 4)).toEqual({ rows: 15, cols: 15, mode: 'custom' });
    });

    it('decodes agent terrain rows and rejects bad dimensions', () => {
        const decoded = decodeTerrainRows(['..o.', '###.', '....'], 3, 4);
        expect(decoded?.terrain[0]).toEqual(['floor', 'floor', 'cover', 'floor']);
        expect(decoded?.terrain[1]).toEqual(['wall', 'wall', 'wall', 'floor']);
        expect(decodeTerrainRows(['..'], 3, 4)).toBeNull();
        expect(decodeTerrainRows(['...', '..'], 2, 3)).toBeNull();
    });

    it('places every combatant on a distinct walkable cell and rolls initiative', () => {
        const state = createEncounterState({
            seed: 5,
            grid: { rows: 10, cols: 10 },
            terrainRows: openTerrain(10, 10),
            turnStyle: 'initiative',
            units: [
                { name: 'A', side: 'player', maxHp: 10, hp: 10, ac: 12, attackBonus: 3, damage: '1d6' },
                { name: 'B', side: 'player', maxHp: 10, hp: 10, ac: 12, attackBonus: 3, damage: '1d6' },
                { name: 'C', side: 'enemy', maxHp: 10, hp: 10, ac: 12, attackBonus: 3, damage: '1d6' },
                { name: 'D', side: 'ally', maxHp: 10, hp: 10, ac: 12, attackBonus: 3, damage: '1d6' },
            ],
        });
        const cells = new Set(state.units.map(unit => `${unit.x},${unit.y}`));
        expect(cells.size).toBe(4);
        expect(state.units.every(unit => TC_TERRAIN[state.terrain[unit.y][unit.x]].walkable)).toBe(true);
        expect(state.initiativeOrder).toHaveLength(4);
        expect(state.units.map(unit => unit.glyph)).toEqual(['A', 'B', 'C', 'D']);
        expect(state.round).toBe(1);
        expect(state.status).toBe('active');
    });

    it('uses agent-authored terrain when dimensions match', () => {
        const state = createEncounterState({
            seed: 1,
            grid: { rows: 6, cols: 6 },
            terrainRows: openTerrain(6, 6).map((row, index) => index === 2 ? '..##..' : row),
            units: [
                { name: 'A', side: 'player', maxHp: 10, hp: 10, ac: 12, attackBonus: 3, damage: '1d6' },
                { name: 'C', side: 'enemy', maxHp: 10, hp: 10, ac: 12, attackBonus: 3, damage: '1d6' },
            ],
        });
        expect(state.terrain[2][2]).toBe('wall');
        expect(state.terrain[2][3]).toBe('wall');
    });
});

describe('tactical combat movement & actions', () => {
    it('moves along a legal path and spends movement', () => {
        const state = makeState();
        const unit = getUnitById(state, 'pc-1');
        const result = applyAction(state, { type: 'move', unitId: 'pc-1', to: { x: 2, y: 1 } }, { actorSide: 'player', rng: midRoll });
        expect(result.ok).toBe(true);
        expect(unit.x).toBe(2);
        expect(unit.y).toBe(1);
        expect(unit.movementUsed).toBe(1);
        expect(unit.movementUsed).toBeLessThanOrEqual(unit.speed);
    });

    it('rejects walls, water, occupied cells, and over-budget moves', () => {
        const state = makeState();
        state.terrain[1][2] = 'wall';
        expect(applyAction(state, { type: 'move', unitId: 'pc-1', to: { x: 2, y: 1 } }, { actorSide: 'player' }).ok).toBe(false);
        state.terrain[1][2] = 'water';
        expect(applyAction(state, { type: 'move', unitId: 'pc-1', to: { x: 2, y: 1 } }, { actorSide: 'player' }).ok).toBe(false);
        state.terrain[1][2] = 'floor';
        expect(applyAction(state, { type: 'move', unitId: 'pc-1', to: { x: 1, y: 2 } }, { actorSide: 'player' }).ok).toBe(false);
        const unit = getUnitById(state, 'pc-1');
        unit.speed = 4;
        const far = applyAction(state, { type: 'move', unitId: 'pc-1', to: { x: 7, y: 7 } }, { actorSide: 'player' });
        expect(far.ok).toBe(false);
        expect(far.error).toMatch(/movement|path|unreachable|Not enough/i);
    });

    it('charges two movement for difficult terrain and one for diagonals', () => {
        const state = makeState();
        state.terrain[1][2] = 'rubble';
        const unit = getUnitById(state, 'pc-1');
        const path = findPath(state, unit, { x: 2, y: 1 });
        expect(path).toEqual([{ x: 2, y: 1 }]);
        expect(pathCost(state, path)).toBe(2);
        const diagonal = findPath(state, unit, { x: 2, y: 2 });
        expect(pathCost(state, diagonal)).toBe(1);
    });

    it('resolves a hit, a miss, and a critical hit with the injected RNG', () => {
        const state = makeState();
        state.units[0].attackBonus = 20;
        state.units[2].x = 2;
        state.units[2].y = 1;
        state.units[2].ac = 10;
        state.units[2].maxHp = 100;
        state.units[2].hp = 100;
        const hit = applyAction(state, { type: 'attack', unitId: 'pc-1', targetId: 'enemy-3' }, { actorSide: 'player', rng: midRoll });
        expect(hit.ok).toBe(true);
        expect(state.units[2].hp).toBeLessThan(100);
        expect(state.units[0].actionUsed).toBe(true);

        const missState = makeState();
        missState.units[2].x = 2;
        missState.units[2].y = 1;
        missState.units[2].ac = 30;
        const miss = applyAction(missState, { type: 'attack', unitId: 'pc-1', targetId: 'enemy-3' }, { actorSide: 'player', rng: lowRoll });
        expect(miss.ok).toBe(true);
        expect(missState.units[2].hp).toBe(8);

        const critState = makeState();
        critState.units[0].attackBonus = 20;
        critState.units[2].x = 2;
        critState.units[2].y = 1;
        critState.units[2].maxHp = 100;
        critState.units[2].hp = 100;
        critState.units[2].ac = 10;
        applyAction(critState, { type: 'attack', unitId: 'pc-1', targetId: 'enemy-3' }, { actorSide: 'player', rng: highRoll });
        // 1d8+2 = 10, critical extra dice = 8 → 18.
        expect(critState.units[2].hp).toBe(82);
    });

    it('enforces range and line of sight', () => {
        const state = makeState();
        state.units[2].x = 5;
        state.units[2].y = 1;
        expect(applyAction(state, { type: 'attack', unitId: 'pc-1', targetId: 'enemy-3' }, { actorSide: 'player' }).ok).toBe(false);

        const ranged = makeState();
        ranged.units[0].attackRange = 6;
        ranged.units[2].x = 5;
        ranged.units[2].y = 1;
        ranged.terrain[1][3] = 'wall';
        const blocked = applyAction(ranged, { type: 'attack', unitId: 'pc-1', targetId: 'enemy-3' }, { actorSide: 'player' });
        expect(blocked.ok).toBe(false);
        expect(blocked.error).toMatch(/line of sight/i);
    });

    it('heals with skills and items and consumes the right resources', () => {
        const state = makeState();
        const unit = getUnitById(state, 'pc-1');
        unit.hp = 5;
        unit.skills.push({
            id: 'second-wind', name: 'Second Wind', kind: 'heal', heal: '1d8+2', range: 0,
            target: 'self', maxUses: 1, uses: 1, bonusAction: true,
        });
        unit.items.push({ id: 'potion', name: 'Potion', kind: 'heal', amount: '2d4+2', maxUses: 2, uses: 2, range: 0 });
        const healed = applyAction(state, { type: 'skill', unitId: 'pc-1', skillId: 'second-wind', targetId: 'pc-1' }, { actorSide: 'player', rng: midRoll });
        expect(healed.ok).toBe(true);
        expect(unit.hp).toBe(12); // 5 + (5 + 2)
        expect(unit.bonusUsed).toBe(true);
        expect(unit.actionUsed).toBe(false);
        expect(unit.skills[0].uses).toBe(0);

        const itemHeal = applyAction(state, { type: 'item', unitId: 'pc-1', itemId: 'potion', targetId: 'pc-1' }, { actorSide: 'player', rng: midRoll });
        expect(itemHeal.ok).toBe(true);
        expect(unit.hp).toBe(20); // 12 + (3+3+2)
        expect(unit.actionUsed).toBe(true);
        expect(unit.items[0].uses).toBe(1);
    });

    it('applies defend AC and status expiry', () => {
        const state = makeState();
        const unit = getUnitById(state, 'pc-1');
        const before = getEffectiveAc(state, unit);
        expect(applyAction(state, { type: 'defend', unitId: 'pc-1' }, { actorSide: 'player' }).ok).toBe(true);
        expect(getEffectiveAc(state, unit)).toBe(before + 4);
        expect(unit.actionUsed).toBe(true);
        // Beginning a new round expires the 1-round status.
        beginRound(state, midRoll);
        expect(getEffectiveAc(state, unit)).toBe(before);
    });

    it('rejects disabled catalog actions and unowned units', () => {
        const state = makeState();
        state.actionCatalog = state.actionCatalog.map(entry => entry.type === 'wait' ? { ...entry, enabled: false } : entry);
        const disabled = applyAction(state, { type: 'wait', unitId: 'pc-1' }, { actorSide: 'player' });
        expect(disabled.ok).toBe(false);
        expect(disabled.error).toMatch(/disabled/i);

        const wrongSide = applyAction(state, { type: 'wait', unitId: 'enemy-3' }, { actorSide: 'player' });
        expect(wrongSide.ok).toBe(false);
    });

    it('applies resolved special effects (damage, terrain, summon) and consumes the ability', () => {
        const state = makeState();
        const caster = getUnitById(state, 'pc-1');
        caster.skills.push({
            id: 'dragon-vein', name: 'Dragon Vein Manipulation', kind: 'special',
            description: 'Alter terrain and call a water pillar.', range: 6, maxUses: 1, uses: 1,
        });
        const beforeHp = state.units[2].hp;
        const result = applySpecialEffects(state, [
            { type: 'damage', targetId: 'enemy-3', amount: '1d6+1' },
            { type: 'terrain', terrain: 'water', cells: [{ x: 4, y: 4 }, { x: 5, y: 4 }] },
            { type: 'summon', name: 'Water Pillar', maxHp: 12, ac: 13, attackBonus: 4, damage: '1d8', attackRange: 6 },
        ], { casterId: 'pc-1', skillId: 'dragon-vein', log: 'Dragon Vein Manipulation' });
        expect(result.ok).toBe(true);
        expect(state.units[2].hp).toBeLessThan(beforeHp);
        expect(state.terrain[4][4]).toBe('water');
        expect(state.terrain[4][5]).toBe('water');
        expect(state.units).toHaveLength(4);
        const summon = state.units[3];
        expect(summon.name).toBe('Water Pillar');
        expect(summon.side).toBe('player');
        expect(summon.doneForRound).toBe(true);
        expect(caster.skills.find(skill => skill.id === 'dragon-vein').uses).toBe(0);
        expect(caster.actionUsed).toBe(true);
    });

    it('does not consume a special ability when no effect is legal', () => {
        const state = makeState();
        const caster = getUnitById(state, 'pc-1');
        caster.skills.push({ id: 'bad-special', name: 'Bad Special', kind: 'special', maxUses: 1, uses: 1, range: 6 });
        const result = applySpecialEffects(state, [
            { type: 'damage', targetId: 'missing', amount: '1d6' },
            { type: 'terrain', terrain: 'not-terrain', cells: [{ x: 4, y: 4 }] },
        ], { casterId: 'pc-1', skillId: 'bad-special' });
        expect(result.ok).toBe(false);
        expect(caster.skills.find(skill => skill.id === 'bad-special').uses).toBe(1);
        expect(caster.actionUsed).toBe(false);
    });

    it('cures statuses with a resolved special item effect', () => {
        const state = makeState();
        const caster = getUnitById(state, 'pc-1');
        caster.statuses = [{ id: 'cursed', label: 'Cursed', rounds: 3, acBonus: -1, attackBonus: -1, damage: '' }];
        caster.items.push({ id: 'restoration-vial', name: 'Restoration Vial', kind: 'special', maxUses: 1, uses: 1, range: 6 });
        const result = applySpecialEffects(state, [{ type: 'cure', targetId: 'pc-1' }], {
            casterId: 'pc-1',
            itemId: 'restoration-vial',
            label: 'Restoration Vial',
        });
        expect(result.ok).toBe(true);
        expect(caster.statuses).toHaveLength(0);
        expect(caster.items.find(item => item.id === 'restoration-vial').uses).toBe(0);
        expect(caster.actionUsed).toBe(true);
    });

    it('interprets an action list, stops on end, and rejects units outside the allow-list', () => {
        const state = makeState();
        state.units[2].hp = 1;
        state.units[2].maxHp = 1;
        state.units[0].attackBonus = 20;
        const result = interpretActions(state, [
            { type: 'attack', unitId: 'pc-1', targetId: 'enemy-3' },
            { type: 'wait', unitId: 'pc-1' },
            { type: 'wait', unitId: 'enemy-3' },
        ], { unitIds: ['enemy-3'], actorSide: 'agent', rng: midRoll, source: 'agent' });
        expect(result.rejected.length).toBeGreaterThan(0);
        expect(result.rejected[0].error).toMatch(/not in the units-to-move/i);
        expect(state.status).toBe('active');

        state.units[2].hp = 1;
        state.units[2].x = 2;
        state.units[2].y = 1;
        const victory = applyAction(state, { type: 'attack', unitId: 'pc-1', targetId: 'enemy-3' }, { actorSide: 'player', rng: midRoll });
        expect(victory.ok).toBe(true);
        expect(state.status).toBe('victory');
        expect(state.outcome.label).toBe('Victory');
        expect(checkEncounterEnd(state)).toBe(true);
    });
});

describe('tactical combat opening actions', () => {
    it('resolves a declared opening attack before normal turn budgets', () => {
        const state = makeState();
        const enemy = getUnitById(state, 'enemy-3');
        enemy.x = 7;
        enemy.y = 7;
        const result = applyOpeningAction(state, {
            text: 'Aria looses an arrow at the Goblin',
            targetName: 'Goblin',
        }, { rng: midRoll });
        expect(result.ok).toBe(true);
        expect(enemy.hp).toBeLessThan(enemy.maxHp);
        expect(getUnitById(state, 'pc-1').actionUsed).toBe(false);
        expect(state.opening.resolved).toBe(true);
    });

    it('can mark surprise without an opening action', () => {
        const state = makeState();
        expect(applySurprise(state, 'player')).toBe(true);
        expect(state.surprise.remaining).toBe(1);
        expect(state.units.find(unit => unit.side === 'enemy').surprised).toBe(true);
        expect(applySurprise(state, 'player')).toBe(true);
    });

    it('advances past a surprised opening unit in initiative mode', () => {
        const state = makeState({ turnStyle: 'initiative' });
        state.initiativeOrder = ['enemy-3', 'pc-1', 'pc-2'];
        state.turnIndex = 0;
        state.phase = 'enemy';
        expect(applySurprise(state, 'player')).toBe(true);
        expect(state.phase).toBe('player');
        expect(getActiveUnit(state)?.id).toBe('pc-1');
    });

    it('marks ambushes as a surprise round and defers special abilities', () => {
        const state = makeState();
        const aria = getUnitById(state, 'pc-1');
        aria.skills = [{
            id: 'skill-fireball',
            name: 'Fireball',
            kind: 'special',
            uses: 1,
            maxUses: 1,
            range: 6,
            description: 'A burst of fire.',
        }];
        const result = applyOpeningAction(state, {
            text: 'Aria casts Fireball at the Goblin',
            targetName: 'Goblin',
            surprise: true,
        }, { rng: midRoll });
        expect(result.requiresAgent).toBe(true);
        expect(state.opening.requiresAgent).toBe(true);
        expect(state.surprise.remaining).toBe(1);
        expect(getUnitById(state, 'enemy-3').surprised).toBe(true);
    });
});

describe('tactical combat turn flow & outcomes', () => {
    it('runs a phased round: player phase, enemy phase, then a fresh player round', () => {
        const state = makeState();
        const unit = getUnitById(state, 'pc-1');
        applyAction(state, { type: 'move', unitId: 'pc-1', to: { x: 2, y: 1 } }, { actorSide: 'player', rng: midRoll });
        const enemyTurn = endTurn(state, midRoll);
        expect(enemyTurn.phase).toBe('enemy');
        expect(enemyTurn.agentUnitIds).toEqual(['enemy-3']);
        expect(getPendingAgentUnitIds(state)).toEqual(['enemy-3']);

        const acted = interpretActions(state, [{ type: 'wait', unitId: 'enemy-3' }], {
            unitIds: enemyTurn.agentUnitIds,
            actorSide: 'agent',
            source: 'agent',
            rng: midRoll,
        });
        expect(acted.applied).toHaveLength(1);
        const completed = completeAgentTurn(state, midRoll);
        expect(completed.phase).toBe('player');
        expect(state.round).toBe(2);
        expect(unit.movementUsed).toBe(0);
        expect(unit.actionUsed).toBe(false);
    });

    it('runs initiative batches and advances past consecutive agent units', () => {
        const state = makeState({ turnStyle: 'initiative' });
        state.initiativeOrder = ['pc-1', 'enemy-3', 'pc-2'];
        state.turnIndex = 0;
        state.phase = 'player';
        const first = endTurn(state, midRoll);
        expect(first.agentUnitIds).toEqual(['enemy-3']);
        interpretActions(state, [{ type: 'wait', unitId: 'enemy-3' }], {
            unitIds: ['enemy-3'], actorSide: 'agent', source: 'agent', rng: midRoll,
        });
        const completed = completeAgentTurn(state, midRoll);
        expect(completed.agentUnitIds).toEqual([]);
        expect(state.phase).toBe('player');
        expect(getActiveUnit(state)?.id).toBe('pc-2');
        const wrapped = endTurn(state, midRoll);
        expect(wrapped.roundAdvanced).toBe(true);
        expect(state.round).toBe(2);
        expect(state.phase).toBe('player');
        expect(getActiveUnit(state)?.id).toBe('pc-1');
    });

    it('returns victory when the last enemy falls and defeat when the party falls', () => {
        const state = makeState();
        state.units.filter(unit => unit.side === 'enemy').forEach(unit => { unit.hp = 0; unit.defeated = true; });
        expect(checkEncounterEnd(state)).toBe(true);
        expect(state.status).toBe('victory');
        expect(buildOutcomeSummary(state).survivors).toHaveLength(2);

        const defeatState = makeState();
        defeatState.units.filter(unit => unit.side === 'player').forEach(unit => { unit.hp = 0; unit.defeated = true; });
        expect(checkEncounterEnd(defeatState)).toBe(true);
        expect(defeatState.status).toBe('defeat');
    });

    it('skips the first enemy phase when the party has surprise', () => {
        const state = makeState();
        state.surprise = { remaining: 1, side: 'player' };
        state.units.filter(unit => unit.side === 'enemy').forEach(unit => { unit.surprised = true; });
        const result = endTurn(state, midRoll);
        expect(result.agentUnitIds).toEqual([]);
        expect(state.round).toBe(2);
        expect(state.phase).toBe('player');
        expect(state.surprise).toBeNull();
        expect(state.units.find(unit => unit.side === 'enemy').surprised).toBe(false);
    });

    it('reports surviving enemies, final units, and highlights in the outcome', () => {
        const state = makeState();
        state.log.push({ type: 'defeat', text: 'Goblin is defeated.', round: 1 });
        const summary = buildOutcomeSummary(state);
        expect(summary.enemySurvivors).toHaveLength(1);
        expect(summary.enemySurvivors[0].name).toBe('Goblin');
        expect(summary.finalUnits).toHaveLength(state.units.length);
        expect(summary.highlights).toContain('Goblin is defeated.');
    });

    it('supports player retreat', () => {
        const state = makeState();
        expect(retreatEncounter(state)).toBe(true);
        expect(state.status).toBe('retreat');
        expect(state.outcome.label).toBe('Retreat');
        expect(state.units.filter(unit => unit.side === 'player').every(unit => unit.fled)).toBe(true);
    });

    it('builds a compact agent state with grid, terrain, units, reachable cells, and legal targets', () => {
        const state = makeState();
        getUnitById(state, 'enemy-3').x = 2;
        getUnitById(state, 'enemy-3').y = 1;
        const payload = buildAgentGameState(state, ['enemy-3']);
        expect(payload.format).toBe('multihog-tactical-combat');
        expect(payload.grid.rows).toBe(8);
        expect(payload.grid.terrain).toHaveLength(8);
        expect(payload.grid.terrain[0]).toHaveLength(8);
        expect(payload.units).toHaveLength(3);
        expect(payload.unitsToMove).toHaveLength(1);
        expect(payload.unitsToMove[0].unitId).toBe('enemy-3');
        expect(Array.isArray(payload.unitsToMove[0].reachableCells[0])).toBe(true);
        expect(payload.unitsToMove[0].attackTargets).toContain('pc-1');
        expect(payload.activationOrder).toEqual(['enemy-3']);
        expect(payload.rules.actionTypes).toContain('attack');
        const serialized = serializeAgentGameState(state, ['enemy-3']);
        expect(() => JSON.parse(serialized)).not.toThrow();
    });
});

describe('tactical combat geometry & dice', () => {
    it('computes distance, paths, and wall line of sight', () => {
        const state = makeState();
        expect(chebyshev({ x: 1, y: 1 }, { x: 4, y: 4 })).toBe(3);
        expect(hasLineOfSight(state, { x: 1, y: 1 }, { x: 4, y: 1 })).toBe(true);
        state.terrain[1][2] = 'wall';
        expect(hasLineOfSight(state, { x: 1, y: 1 }, { x: 4, y: 1 })).toBe(false);
    });

    it('parses dice expressions safely', () => {
        expect(rollDice('1d8+3', midRoll).total).toBe(8);
        expect(rollDice('2d6', midRoll).total).toBe(8);
        expect(rollDice('7', midRoll).total).toBe(7);
        expect(rollDice('not dice', midRoll).total).toBe(0);
    });

    it('persists RNG progress through the encounter roll counter', () => {
        const state = makeState();
        const first = state.rollCount;
        state.units[2].x = 2;
        state.units[2].y = 1;
        applyAction(state, { type: 'attack', unitId: 'pc-1', targetId: 'enemy-3' }, { actorSide: 'player' });
        expect(state.rollCount).toBeGreaterThan(first);
        const exported = buildAgentGameState(state, []);
        expect(exported.version).toBeGreaterThanOrEqual(1);
    });
});
