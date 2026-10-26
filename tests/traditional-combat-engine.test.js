import { describe, expect, it } from 'vitest';
import {
    applySpecialEffects,
    applyTraditionalAction,
    buildTraditionalAgentGameState,
    buildTraditionalEncounterFromContext,
    createTraditionalEncounterState,
    describeTraditionalUnitOptions,
    getActiveUnit,
    getPendingAgentUnitIds,
    getTraditionalActionCatalog,
} from '../src/features/traditional-combat/traditional-combat-engine.js';
import { endTurn, completeAgentTurn, getUnitById } from '../src/features/tactical-combat/tactical-combat-engine.js';
import {
    DEFAULT_TRADITIONAL_ACTION_CATALOG_JSON,
} from '../src/features/traditional-combat/traditional-combat-constants.js';

const highRoll = () => 0.99;

function units() {
    return [
        {
            id: 'pc-1',
            name: 'Aria',
            side: 'player',
            maxHp: 20,
            hp: 20,
            ac: 12,
            attackBonus: 20,
            damage: '1d8+2',
            initiativeBonus: 10,
            skills: [
                { id: 'heal-1', name: 'Mend', kind: 'heal', heal: '1d8+2', target: 'ally', maxUses: 2 },
                { id: 'buff-1', name: 'Ward', kind: 'buff', acBonus: 2, target: 'ally', maxUses: 1, bonusAction: true },
            ],
            items: [{ id: 'potion-1', name: 'Potion', kind: 'heal', amount: '1d4+1', target: 'ally', maxUses: 1 }],
        },
        {
            id: 'pc-2',
            name: 'Borin',
            side: 'player',
            maxHp: 18,
            hp: 18,
            ac: 14,
            attackBonus: 3,
            damage: '1d6+1',
            initiativeBonus: 2,
        },
        {
            id: 'enemy-3',
            name: 'Goblin',
            side: 'enemy',
            maxHp: 12,
            hp: 12,
            ac: 10,
            attackBonus: 2,
            damage: '1d4',
            initiativeBonus: 0,
        },
    ];
}

function makeState(turnStyle = 'phase') {
    return createTraditionalEncounterState({
        seed: 42,
        turnStyle,
        units: units(),
        actionCatalog: JSON.parse(DEFAULT_TRADITIONAL_ACTION_CATALOG_JSON),
    });
}

describe('traditional combat theater engine', () => {
    it('ignores tactical area metadata and keeps traditional actions single-target', () => {
        const state = makeState();
        const caster = getUnitById(state, 'pc-1');
        const ally = getUnitById(state, 'pc-2');
        caster.hp = 5;
        ally.hp = 5;
        caster.skills.push({
            id: 'mass-mend', name: 'Mass Mend', kind: 'heal', heal: '1d8+2', range: 0,
            maxUses: 1, uses: 1, area: { shape: 'burst', radius: 2, origin: 'self' },
        });
        const result = applyTraditionalAction(state, {
            type: 'skill', unitId: 'pc-1', skillId: 'mass-mend', targetId: 'pc-1',
        }, { actorSide: 'player', rng: () => 0.5 });
        expect(result.ok).toBe(true);
        expect(caster.hp).toBeGreaterThan(5);
        expect(ally.hp).toBe(5);
    });


    it('builds a no-grid state with theater invariants and no move action', () => {
        const state = makeState();
        expect(state.format).toBe('multihog-traditional-combat');
        expect(state.theater).toBe(true);
        expect(state.grid).toBeNull();
        expect(state.terrain).toBeNull();
        expect(state.units.every(unit => unit.x === 0 && unit.y === 0)).toBe(true);
        const catalog = getTraditionalActionCatalog({ traditionalCombatActionCatalogJson: DEFAULT_TRADITIONAL_ACTION_CATALOG_JSON });
        expect(catalog.catalog.map(entry => entry.type)).toEqual(['attack', 'skill', 'item', 'defend', 'wait', 'flee']);
        expect(state.actionCatalog.some(entry => entry.type === 'move')).toBe(false);
    });

    it('resolves attacks without range or line-of-sight checks', () => {
        const state = makeState('phase');
        const player = getUnitById(state, 'pc-1');
        const enemy = getUnitById(state, 'enemy-3');
        const result = applyTraditionalAction(state, { type: 'attack', unitId: player.id, targetId: enemy.id }, {
            actorSide: 'player',
            rng: highRoll,
        });
        expect(result.ok).toBe(true);
        expect(enemy.hp).toBe(0);
        expect(state.status).toBe('victory');
        expect(player.actionUsed).toBe(true);
    });

    it('rejects movement as a traditional action', () => {
        const state = makeState('phase');
        const result = applyTraditionalAction(state, { type: 'move', unitId: 'pc-1', to: { x: 1, y: 1 } }, {
            actorSide: 'player',
            rng: highRoll,
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/movement/i);
    });

    it('resolves skills, bonus buffs, items, defend, wait, and flee', () => {
        const state = makeState('phase');
        const player = getUnitById(state, 'pc-1');
        player.hp = 5;

        const heal = applyTraditionalAction(state, { type: 'skill', unitId: player.id, skillId: 'heal-1', targetId: player.id }, {
            actorSide: 'player',
            rng: highRoll,
        });
        expect(heal.ok).toBe(true);
        expect(player.hp).toBeGreaterThan(5);
        expect(player.actionUsed).toBe(true);

        player.actionUsed = false;
        player.bonusUsed = false;
        const buff = applyTraditionalAction(state, { type: 'skill', unitId: player.id, skillId: 'buff-1', targetId: player.id }, {
            actorSide: 'player',
            rng: highRoll,
        });
        expect(buff.ok).toBe(true);
        expect(player.bonusUsed).toBe(true);
        expect(player.actionUsed).toBe(false);
        expect(player.statuses.some(status => status.label === 'Ward')).toBe(true);

        player.actionUsed = false;
        player.hp = 5;
        const item = applyTraditionalAction(state, { type: 'item', unitId: player.id, itemId: 'potion-1', targetId: player.id }, {
            actorSide: 'player',
            rng: highRoll,
        });
        expect(item.ok).toBe(true);
        expect(player.hp).toBeGreaterThan(5);

        const defend = applyTraditionalAction(state, { type: 'defend', unitId: 'pc-2' }, { actorSide: 'player', rng: highRoll });
        expect(defend.ok).toBe(true);
        expect(getUnitById(state, 'pc-2').statuses.some(status => status.id === 'defending')).toBe(true);

        const wait = applyTraditionalAction(state, { type: 'wait', unitId: 'pc-2' }, { actorSide: 'player', rng: highRoll });
        expect(wait.ok).toBe(true);
        expect(getUnitById(state, 'pc-2').doneForRound).toBe(true);

        const pc2 = getUnitById(state, 'pc-2');
        pc2.doneForRound = false;
        pc2.actionUsed = false;
        const flee = applyTraditionalAction(state, { type: 'flee', unitId: 'pc-2' }, { actorSide: 'player', rng: highRoll });
        expect(flee.ok).toBe(true);
        expect(getUnitById(state, 'pc-2').fled).toBe(true);
    });

    it('runs phased player and enemy batches', () => {
        const state = makeState('phase');
        expect(state.phase).toBe('player');
        const player = getUnitById(state, 'pc-1');
        applyTraditionalAction(state, { type: 'wait', unitId: player.id }, { actorSide: 'player', rng: highRoll });
        const enemyPhase = endTurn(state, highRoll);
        expect(enemyPhase.phase).toBe('enemy');
        expect(enemyPhase.agentUnitIds).toContain('enemy-3');
        const completion = completeAgentTurn(state, highRoll);
        expect(state.round).toBe(2);
        expect(completion.phase).toBe('player');
    });

    it('runs initiative order and exposes the active unit', () => {
        const state = makeState('initiative');
        expect(state.initiativeOrder).toHaveLength(3);
        state.initiativeOrder = ['pc-1', 'pc-2', 'enemy-3'];
        state.turnIndex = 0;
        state.phase = 'player';
        state.pendingAgentUnitIds = [];
        expect(getActiveUnit(state).id).toBe('pc-1');
        const result = endTurn(state, highRoll);
        expect(getActiveUnit(state).id).toBe('pc-2');
        expect(result.agentUnitIds).toEqual([]);
    });

    it('builds an agent payload with explicit legal targets and no grid', () => {
        const state = makeState('phase');
        const payload = buildTraditionalAgentGameState(state, ['enemy-3']);
        expect(payload.mode).toBe('traditional');
        expect(payload.rules.grid).toBe('none');
        expect(payload.rules.actionTypes).not.toContain('move');
        expect(payload.unitsToAct[0].attackTargets).toContain('pc-1');
        expect(payload.units[0].x).toBeUndefined();
        expect(payload.grid).toBeUndefined();
    });

    it('describes special, heal, and item targets without range limits', () => {
        const state = makeState('phase');
        const player = getUnitById(state, 'pc-1');
        player.skills.push({ id: 'special-1', name: 'Wave', kind: 'special', target: 'any', maxUses: 1 });
        const options = describeTraditionalUnitOptions(state, player);
        expect(options.skillTargets['special-1']).toEqual(expect.arrayContaining(['pc-1', 'pc-2', 'enemy-3']));
        expect(options.skillTargets['heal-1']).toEqual(expect.arrayContaining(['pc-1', 'pc-2']));
        expect(options.itemTargets['potion-1']).toEqual(expect.arrayContaining(['pc-1', 'pc-2']));
    });

    it('supports theater summons and rejects terrain effects', () => {
        const state = makeState('phase');
        const caster = getUnitById(state, 'pc-1');
        const before = state.units.length;
        const summon = applySpecialEffects(state, [{ type: 'summon', name: 'Spirit', maxHp: 10, ac: 12, attackBonus: 3, damage: '1d6' }], {
            casterId: caster.id,
            label: 'Summon Spirit',
            rng: highRoll,
        });
        expect(summon.ok).toBe(true);
        expect(state.units.length).toBe(before + 1);
        const summoned = state.units[state.units.length - 1];
        expect(summoned.x).toBe(0);
        expect(summoned.y).toBe(0);

        const terrain = applySpecialEffects(state, [{ type: 'terrain', terrain: 'wall', cells: [{ x: 0, y: 0 }] }], {
            casterId: caster.id,
            label: 'Shape Stone',
            rng: highRoll,
        });
        expect(terrain.ok).toBe(false);
    });

    it('exposes pending agent units for the UI', () => {
        const state = makeState('phase');
        state.phase = 'enemy';
        expect(getPendingAgentUnitIds(state)).toContain('enemy-3');
    });

    it('builds a traditional encounter from the shared memo context', () => {
        const context = {
            chatId: 'chat-x',
            location: 'The Old Road',
            sceneExcerpt: 'Bandits block the road.',
            existingCombat: true,
            playerUnits: [{ name: 'Aria', side: 'player', maxHp: 20, hp: 20, ac: 13, attackBonus: 4, damage: '1d8' }],
            allies: [],
            enemies: [{ name: 'Bandit', side: 'enemy', maxHp: 10, hp: 10, ac: 11, attackBonus: 2, damage: '1d6' }],
            willpowerMaxPercent: 30,
        };
        const settings = { traditionalCombatTurnStyle: 'phase' };
        const built = buildTraditionalEncounterFromContext(context, settings, { source: 'existing', seed: 5 });
        expect(built.state.status).toBe('active');
        expect(built.state.theater).toBe(true);
        expect(built.state.units.map(unit => unit.name)).toEqual(['Aria', 'Bandit']);
        expect(built.state.turnStyle).toBe('phase');
    });
});
