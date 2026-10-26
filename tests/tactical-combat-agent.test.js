import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendStateRequest } = vi.hoisted(() => ({ sendStateRequest: vi.fn() }));
vi.mock('../llm-client.js', () => ({ sendStateRequest }));

import {
    buildAgentPrompts,
    buildEncounterRequestPayload,
    buildEncounterUserPrompt,
    buildLocalAiActions,
    namedEnemyMismatch,
    normalizeEncounterPayload,
    normalizeSpecialEffects,
    parseAgentActionResponse,
    requestAgentActions,
    resolveSpecialEffectWithAgent,
    runAgentTurn,
} from '../src/features/tactical-combat/tactical-combat-agent.js';
import {
    getActionCatalog,
    describeActionCatalog,
    parseActionCatalog,
    parseActionsResponse,
    sanitizeActionsPayload,
} from '../src/features/tactical-combat/tactical-combat-actions.js';
import {
    applyAction,
    buildAgentGameState,
    completeAgentTurn,
    createEncounterState,
    endTurn,
    getPendingAgentUnitIds,
    getUnitById,
    interpretActions,
} from '../src/features/tactical-combat/tactical-combat-engine.js';

const SETTINGS = {
    tacticalCombatAgentPrompt: 'You are a test agent.',
    tacticalCombatEncounterPrompt: 'You are a test architect.',
    tacticalCombatConnectionSource: 'default',
    tacticalCombatMaxTokens: 6000,
    tacticalCombatActionCatalogJson: '',
    tacticalCombatEncounterSource: 'auto',
    tacticalCombatGridPreset: '10x10',
};

function makeState() {
    const state = createEncounterState({
        seed: 11,
        grid: { rows: 8, cols: 8 },
        terrainRows: Array.from({ length: 8 }, () => '........'),
        turnStyle: 'phase',
        movement: 6,
        units: [
            { id: 'pc-1', name: 'Aria', side: 'player', maxHp: 24, hp: 24, ac: 14, attackBonus: 5, damage: '1d8+2' },
            { id: 'enemy-2', name: 'Goblin', side: 'enemy', maxHp: 9, hp: 9, ac: 11, attackBonus: 3, damage: '1d6' },
        ],
    });
    state.units[0].x = 1;
    state.units[0].y = 1;
    state.units[1].x = 2;
    state.units[1].y = 1;
    state.phase = 'enemy';
    state.pendingAgentUnitIds = ['enemy-2'];
    return state;
}

describe('tactical action catalogue', () => {
    it('validates the shipped catalogue and accepts an object wrapper', () => {
        const direct = parseActionCatalog(JSON.stringify([{ type: 'move', label: 'Move' }, { type: 'attack', enabled: false }]));
        expect(direct.ok).toBe(true);
        expect(direct.catalog).toHaveLength(2);
        expect(direct.catalog[1].enabled).toBe(false);
        const wrapped = parseActionCatalog({ actions: [{ type: 'wait' }] });
        expect(wrapped.ok).toBe(true);
    });

    it('rejects unknown, duplicate, and malformed action types', () => {
        expect(parseActionCatalog('[{"type":"teleport"}]').ok).toBe(false);
        expect(parseActionCatalog('[{"type":"wait"},{"type":"wait"}]').ok).toBe(false);
        expect(parseActionCatalog('not json').ok).toBe(false);
        expect(parseActionCatalog('[]').ok).toBe(false);
    });

    it('falls back to the shipped catalogue when settings JSON is invalid', () => {
        const result = getActionCatalog({ tacticalCombatActionCatalogJson: '{"broken":' });
        expect(result.usingDefault).toBe(true);
        expect(result.error).toMatch(/invalid json/i);
        expect(result.catalog.some(entry => entry.type === 'attack')).toBe(true);
    });

    it('describes enabled actions for the agent', () => {
        const { catalog } = getActionCatalog({ tacticalCombatActionCatalogJson: '' });
        const description = describeActionCatalog(catalog.map(entry => entry.type === 'flee' ? { ...entry, enabled: false } : entry));
        expect(description).toContain('attack');
        expect(description).not.toContain('flee');
    });
});

describe('tactical action response parsing', () => {
    it('parses plain objects, bare arrays, and fenced JSON', () => {
        expect(parseActionsResponse('{"actions":[{"type":"wait","unitId":"enemy-2"}]}').actions).toHaveLength(1);
        expect(parseActionsResponse('[{"type":"wait","unitId":"enemy-2"}]').actions).toHaveLength(1);
        expect(parseActionsResponse('```json\n{"actions":[{"type":"wait","unitId":"enemy-2"}]}\n```').actions).toHaveLength(1);
        expect(parseActionsResponse('Sure! {"actions":[{"type":"wait","unitId":"enemy-2"}]} done').actions).toHaveLength(1);
        expect(parseActionsResponse('Reasoning: {"note":"not actions"} then {"actions":[{"type":"wait","unitId":"enemy-2"}]}').actions).toHaveLength(1);
    });

    it('reports empty and malformed responses instead of throwing', () => {
        expect(parseActionsResponse('').error).toMatch(/empty/i);
        expect(parseActionsResponse('hello').error).toMatch(/JSON/i);
        expect(parseActionsResponse('{"foo":1}').error).toMatch(/actions/i);
    });

    it('normalizes fields and keeps targetCell for area abilities', () => {
        const result = sanitizeActionsPayload([{
            type: 'skill', unitId: 'enemy-2', skillId: 'fireball', targetCell: { x: 3, y: 4 },
        }], { unitIds: ['enemy-2'] });
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0]).toMatchObject({ type: 'skill', skillId: 'fireball', targetCell: { x: 3, y: 4 } });
        const malformed = sanitizeActionsPayload([{
            type: 'skill', unitId: 'enemy-2', skillId: 'fireball', targetCell: { x: 'bad' },
        }], { unitIds: ['enemy-2'] });
        expect(malformed.actions).toHaveLength(0);
        expect(malformed.rejected[0].error).toMatch(/targetCell/i);
    });

    it('normalizes fields and enforces the units-to-move allow-list', () => {
        const sanitized = sanitizeActionsPayload([
            { type: 'move', unitId: 'enemy-2', to: { x: '3', y: 4 } },
            { type: 'attack', unitId: 'pc-1', targetId: 'enemy-2' },
            { type: 'flee', unitId: 'enemy-2' },
            { type: 'teleport', unitId: 'enemy-2' },
        ], { unitIds: ['enemy-2'], catalog: getActionCatalog({}).catalog });
        expect(sanitized.actions).toHaveLength(2);
        expect(sanitized.actions[0].to).toEqual({ x: 3, y: 4 });
        expect(sanitized.rejected).toHaveLength(2);
        expect(sanitized.rejected[0].error).toMatch(/player|unitsToMove/i);
        expect(sanitized.rejected[1].error).toMatch(/unsupported/i);
    });

    it('rejects disabled action types', () => {
        const catalog = getActionCatalog({}).catalog.map(entry => entry.type === 'wait' ? { ...entry, enabled: false } : entry);
        const sanitized = sanitizeActionsPayload([{ type: 'wait', unitId: 'enemy-2' }], { unitIds: ['enemy-2'], catalog });
        expect(sanitized.actions).toHaveLength(0);
        expect(sanitized.rejected[0].error).toMatch(/disabled/i);
    });

    it('parses a full agent response through the public helper', () => {
        const parsed = parseAgentActionResponse('{"actions":[{"type":"move","unitId":"enemy-2","to":{"x":2,"y":2}},{"type":"attack","unitId":"enemy-2","targetId":"pc-1"}]}', {
            unitIds: ['enemy-2'],
            catalog: getActionCatalog({}).catalog,
        });
        expect(parsed.actions).toHaveLength(2);
        expect(parsed.rejected).toEqual([]);
    });
});

describe('tactical encounter architect payloads', () => {
    it('normalizes a valid encounter and applies safe defaults', () => {
        const result = normalizeEncounterPayload({
            title: 'Bridge Ambush',
            description: 'Raiders hold the bridge.',
            terrainTheme: 'city',
            grid: { rows: 9, cols: 11 },
            terrain: ['...........', '....oo.....'],
            enemies: [
                { name: 'Raider', maxHp: '14', ac: '12', attackBonus: '4', damage: '1d6+2', attackRange: '1' },
                { name: 'Archer', maxHp: 10, ac: 11, attackBonus: 5, damage: '1d8+1', attackRange: 6, skills: [{ name: 'Aimed Shot', kind: 'attack', range: 6, damage: '1d8', maxUses: 2 }] },
            ],
        });
        expect(result.ok).toBe(true);
        expect(result.encounter.grid).toEqual({ rows: 9, cols: 11 });
        expect(result.encounter.enemies).toHaveLength(2);
        expect(result.encounter.enemies[0].maxHp).toBe(14);
        expect(result.encounter.enemies[0].initiativeBonus).toBe(0);
        expect(result.encounter.enemies[1].skills[0].maxUses).toBe(2);
    });

    it('normalizes architect area templates end-to-end', () => {
        const normalized = normalizeEncounterPayload({
            title: 'Cinder Hall',
            enemies: [{
                name: 'Cinder Adept',
                maxHp: 20,
                ac: 12,
                attackBonus: 4,
                damage: '1d6',
                skills: [{
                    name: 'Cinder Burst',
                    kind: 'attack',
                    range: 8,
                    damage: '3d6',
                    area: { shape: 'burst', radius: 2, origin: 'target', friendlyFire: true },
                    maxUses: 1,
                }, {
                    name: 'Burning Aura',
                    kind: 'buff',
                    range: 0,
                    acBonus: 1,
                    area: { shape: 'aura', radius: 1 },
                    maxUses: 1,
                }],
            }],
        });
        expect(normalized.ok).toBe(true);
        const [burst, aura] = normalized.encounter.enemies[0].skills;
        expect(burst.area).toMatchObject({ shape: 'burst', radius: 2, origin: 'target', friendlyFire: true });
        expect(aura.area).toMatchObject({ shape: 'burst', radius: 1, origin: 'self', friendlyFire: false });
        const state = createEncounterState({
            seed: 1,
            grid: { rows: 8, cols: 8 },
            terrainRows: Array.from({ length: 8 }, () => '........'),
            units: normalized.encounter.enemies,
        });
        const payload = buildAgentGameState(state, [state.units[0].id]);
        expect(payload.rules.area).toMatch(/aoeTargets/i);
        expect(payload.units[0].skills[0].area).toMatchObject({ radius: 2, origin: 'target' });
        expect(payload.units[0].skills[1].area).toMatchObject({ origin: 'self' });
    });

    it('reports missing titles/enemies and invalid terrain widths', () => {
        expect(normalizeEncounterPayload({ enemies: [] }).errors).toEqual(expect.arrayContaining([expect.stringMatching(/title/i), expect.stringMatching(/enemy/i)]));
        const badTerrain = normalizeEncounterPayload({
            title: 'Bad',
            terrain: ['...', '..'],
            enemies: [{ name: 'X', maxHp: 5, ac: 10, attackBonus: 1, damage: '1d4' }],
        });
        expect(badTerrain.ok).toBe(false);
        expect(badTerrain.errors.join(' ')).toMatch(/terrain/i);
    });

    it('builds an architect request with party, enemies, location, and grid rules', () => {
        const context = {
            playerUnits: [{ name: 'Aria', classLabel: 'Fighter', hp: 20, maxHp: 24, ac: 15, attackBonus: 5, attackRange: 1, damage: '1d8+2', skills: [] }],
            allies: [],
            enemies: [{ name: 'Goblin', hp: 9, maxHp: 9, ac: 11, attackBonus: 3, attackRange: 1, damage: '1d6', skills: [] }],
            location: 'The Sunken Keep',
            sceneExcerpt: 'Arrows hiss from the murder holes.',
            playerDeclaration: 'I attack the goblins.',
            enemyNames: ['Goblin'],
            freshStart: false,
            summary: { party: ['Aria (Fighter, 20/24 HP)'] },
            existingCombat: true,
        };
        const payload = buildEncounterRequestPayload(context, SETTINGS);
        expect(payload.party[0].name).toBe('Aria');
        expect(payload.existingCombat[0].name).toBe('Goblin');
        expect(payload.playerDeclaration).toBe('I attack the goblins.');
        expect(payload.enemyNames).toEqual(['Goblin']);
        expect(payload.freshStart).toBe(false);
        expect(payload.location).toBe('The Sunken Keep');
        expect(payload.requestedGrid.rows).toBe(10);
        expect(payload.terrainLegend['#']).toMatch(/wall/i);
        const prompt = buildEncounterUserPrompt(context, SETTINGS);
        expect(prompt).toContain('ENCOUNTER REQUEST');
        expect(prompt).toContain('The Sunken Keep');
    });

    it('rejects architect rosters that replace named enemies with a generic theme roster', () => {
        const context = { enemyNames: ['Goblin'] };
        expect(namedEnemyMismatch({ enemies: [{ name: 'Kobold' }, { name: 'Cave Bat' }] }, context)).toMatch(/must use the named enemy/i);
        expect(namedEnemyMismatch({ enemies: [{ name: 'Goblin' }, { name: 'Goblin Archer' }] }, context)).toBe('');
        expect(namedEnemyMismatch({ enemies: [{ name: 'Goblin Chief' }] }, context)).toBe('');
    });

    it('normalizes resolver effects and drops invalid targets/terrain', () => {
        const state = makeState();
        const normalized = normalizeSpecialEffects({
            log: 'Water bursts from the stones.',
            effects: [
                { type: 'damage', targetId: 'enemy-2', amount: '2d6' },
                { type: 'damage', targetId: 'missing', amount: '2d6' },
                { type: 'terrain', terrain: 'water', cells: [{ x: 3, y: 3 }, { x: 99, y: 3 }] },
                { type: 'summon', name: 'Water Pillar', maxHp: 12, ac: 13, attackBonus: 4, damage: '1d8', attackRange: 6 },
            ],
        }, state);
        expect(normalized.effects).toHaveLength(3);
        expect(normalized.effects[1]).toMatchObject({ type: 'terrain', cells: [{ x: 3, y: 3, terrain: 'water' }] });
        expect(normalized.rejected.join(' ')).toMatch(/missing/);
        expect(normalized.log).toContain('Water bursts');
    });

    it('honours an area target allow-list and a larger effect cap', () => {
        const state = makeState();
        const effect = id => ({ type: 'damage', targetId: id, amount: '1d6' });
        const normalized = normalizeSpecialEffects({
            effects: [effect('pc-1'), effect('missing'), ...Array.from({ length: 8 }, () => effect('pc-1'))],
        }, state, {
            maxEffects: 10,
            allowedTargetIds: ['pc-1'],
        });
        expect(normalized.effects).toHaveLength(9);
        expect(normalized.rejected.join(' ')).toMatch(/unknown target/i);
        const denied = normalizeSpecialEffects({ effects: [effect('enemy-2')] }, state, {
            allowedTargetIds: ['pc-1'],
        });
        expect(denied.effects).toHaveLength(0);
        expect(denied.rejected[0]).toMatch(/outside the ability's area/i);
    });

    it('normalizes Willpower, defeat, transform, and status behavior effects', () => {
        const state = makeState();
        const enemy = getUnitById(state, 'enemy-2');
        enemy.maxWillpower = 5;
        enemy.willpower = 5;
        const normalized = normalizeSpecialEffects({
            effects: [
                { type: 'damage', targetId: 'enemy-2', amount: '2d6', resource: 'willpower', willpowerOutcome: 'flee' },
                { type: 'transform', targetId: 'enemy-2', name: 'Stone Statue', skills: [], permanent: false },
                { type: 'status', targetId: 'enemy-2', label: 'Confused', behavior: 'confused', stacks: 2, maxStacks: 3 },
                { type: 'defeat', targetId: 'enemy-2', outcome: 'incapacitate' },
            ],
        }, state);
        expect(normalized.effects[0]).toMatchObject({ resource: 'willpower', willpowerOutcome: 'flee' });
        expect(normalized.effects[1]).toMatchObject({ type: 'transform', name: 'Stone Statue' });
        expect(normalized.effects[2]).toMatchObject({ behavior: 'confused', stacks: 2 });
        // Defeat is rejected while the target still has Willpower.
        expect(normalized.rejected.join(' ')).toMatch(/still has Willpower/);
    });

    it('normalizes Willpower and special skill metadata from the encounter architect', () => {
        const normalized = normalizeEncounterPayload({
            title: 'Wail in the Dark',
            enemies: [{
                name: 'Wailing Horror',
                maxHp: 20,
                maxWillpower: 8,
                ac: 12,
                attackBonus: 4,
                damage: '1d6+1',
                skills: [{
                    name: 'Dread Wail',
                    kind: 'special',
                    resource: 'willpower',
                    range: 6,
                    damage: '2d6',
                    willpowerOutcome: 'flee',
                    maxUses: 1,
                    effectTemplate: [{ type: 'damage', targetId: '$target', amount: '2d6', resource: 'willpower', willpowerOutcome: 'flee' }],
                }],
            }],
        });
        expect(normalized.ok).toBe(true);
        expect(normalized.encounter.enemies[0].maxWillpower).toBe(8);
        expect(normalized.encounter.enemies[0].skills[0]).toMatchObject({
            kind: 'special',
            resource: 'willpower',
            willpowerOutcome: 'flee',
        });
        expect(normalized.encounter.enemies[0].skills[0].effectTemplate[0].targetId).toBe('$target');
    });

    it('carries architect Willpower metadata end-to-end into the board and agent state', () => {
        const normalized = normalizeEncounterPayload({
            title: 'Wail in the Dark',
            enemies: [{
                name: 'Wailing Horror',
                maxHp: 20,
                maxWillpower: 8,
                ac: 12,
                attackBonus: 4,
                damage: '1d6+1',
                skills: [{ name: 'Dread Wail', kind: 'attack', resource: 'willpower', range: 6, damage: '2d6', willpowerOutcome: 'flee', maxUses: 1 }],
            }],
        });
        const state = createEncounterState({
            seed: 1,
            grid: { rows: 8, cols: 8 },
            terrainRows: Array.from({ length: 8 }, () => '........'),
            units: normalized.encounter.enemies,
        });
        const enemy = state.units.find(unit => unit.name === 'Wailing Horror');
        expect(enemy.maxWillpower).toBe(8);
        expect(enemy.skills[0]).toMatchObject({ resource: 'willpower', willpowerOutcome: 'flee' });
        const payload = buildAgentGameState(state, [enemy.id]);
        expect(payload.units.find(unit => unit.id === enemy.id).skills[0]).toMatchObject({
            resource: 'willpower',
            willpowerOutcome: 'flee',
        });
    });

    it('rejects architect skills that use both pools without a Willpower damage expression', () => {
        const normalized = normalizeEncounterPayload({
            title: 'Broken Metadata',
            enemies: [{
                name: 'Wailing Horror',
                maxHp: 20,
                ac: 12,
                attackBonus: 4,
                damage: '1d6',
                skills: [{ name: 'Psychic Lance', kind: 'attack', resource: 'both', damage: '2d6' }],
            }],
        });
        expect(normalized.ok).toBe(false);
        expect(normalized.errors.join(' ')).toMatch(/missing willpowerDamage/i);
    });

    it('resolves an enemy special skill declaration in the agent turn after the tactical answer', async () => {
        sendStateRequest.mockReset();
        const state = makeState();
        const enemy = getUnitById(state, 'enemy-2');
        const aria = getUnitById(state, 'pc-1');
        enemy.maxWillpower = 4;
        enemy.willpower = 4;
        aria.maxWillpower = 4;
        aria.willpower = 4;
        enemy.skills = [{ id: 'dread-wail', name: 'Dread Wail', kind: 'special', range: 6, maxUses: 1, uses: 1, description: 'A fearful wail.' }];
        sendStateRequest
            .mockResolvedValueOnce('{"actions":[{"type":"skill","unitId":"enemy-2","skillId":"dread-wail","targetId":"pc-1"}]}')
            .mockResolvedValueOnce(JSON.stringify({
                log: 'The wail scrapes at Aria’s resolve.',
                effects: [{ type: 'damage', targetId: 'pc-1', amount: '4', resource: 'willpower', willpowerOutcome: 'flee' }],
            }));
        const result = await runAgentTurn(state, ['enemy-2'], SETTINGS, { rng: () => 0.99 });
        expect(result.source).toBe('agent');
        expect(result.applied).toHaveLength(1);
        expect(sendStateRequest).toHaveBeenCalledTimes(2);
        expect(getUnitById(state, 'pc-1').willpower).toBe(0);
        expect(getUnitById(state, 'pc-1').fled).toBe(true);
        expect(enemy.skills[0].uses).toBe(0);
    });

    it('sends area targets and limit metadata to the special resolver', async () => {
        sendStateRequest.mockReset();
        const state = makeState();
        sendStateRequest.mockResolvedValue(JSON.stringify({
            log: 'Fire washes over the goblin.',
            effects: [{ type: 'damage', targetId: 'enemy-2', amount: '1d6' }],
        }));
        const result = await resolveSpecialEffectWithAgent(
            state,
            state.units[0],
            { kind: 'skill', name: 'Cinder Burst', description: 'A burst of flame.', area: { shape: 'burst', radius: 1 } },
            state.units[1],
            SETTINGS,
            {
                targets: [state.units[1]],
                area: { shape: 'burst', radius: 1 },
                anchor: { x: 2, y: 1 },
                areaCells: [{ x: 2, y: 1 }],
                maxEffects: 8,
            },
        );
        expect(result.ok).toBe(true);
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
        const prompt = sendStateRequest.mock.calls[0][2];
        const payload = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1]);
        expect(payload.ability.area).toMatchObject({ shape: 'burst', radius: 1 });
        expect(payload.areaTargets).toHaveLength(1);
        expect(payload.areaTargets[0].id).toBe('enemy-2');
        expect(payload.anchor).toEqual({ x: 2, y: 1 });
        expect(payload.limits.maxEffects).toBe(8);
        expect(payload.rules.areaTargets).toMatch(/areaTargets/i);
    });

    it('resolves a special ability through the compact resolver call', async () => {
        sendStateRequest.mockReset();
        const state = makeState();
        sendStateRequest.mockResolvedValue(JSON.stringify({
            log: 'Water bursts from the stones.',
            effects: [{ type: 'damage', targetId: 'enemy-2', amount: '2d6' }],
        }));
        const result = await resolveSpecialEffectWithAgent(
            state,
            state.units[0],
            { kind: 'skill', name: 'Hydrokinesis', description: 'Blast a foe with water.' },
            state.units[1],
            SETTINGS,
        );
        expect(result.ok).toBe(true);
        expect(result.effects).toHaveLength(1);
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
        expect(sendStateRequest.mock.calls[0][2]).toContain('SPECIAL ABILITY');
    });
});

describe('tactical local AI & agent turn execution', () => {
    beforeEach(() => {
        sendStateRequest.mockReset();
    });

    it('builds local actions that move into range and attack', () => {
        const state = makeState();
        getUnitById(state, 'enemy-2').x = 6;
        getUnitById(state, 'enemy-2').y = 6;
        const actions = buildLocalAiActions(state, ['enemy-2']);
        expect(actions.length).toBeGreaterThan(0);
        expect(actions[0].type).toBe('move');
        expect(['attack', 'defend', 'wait']).toContain(actions[actions.length - 1].type);
        const applied = interpretActions(state, actions, { unitIds: ['enemy-2'], actorSide: 'agent', source: 'agent', rng: () => 0.5 });
        expect(applied.applied.length).toBeGreaterThan(0);
        expect(applied.rejected).toEqual([]);
    });

    it('prefers a multi-target area skill when two enemies are clustered', () => {
        const state = createEncounterState({
            seed: 3,
            grid: { rows: 8, cols: 8 },
            terrainRows: Array.from({ length: 8 }, () => '........'),
            turnStyle: 'phase',
            units: [
                { id: 'pc-1', name: 'Aria', side: 'player', maxHp: 24, hp: 24, ac: 14, attackBonus: 5, damage: '1d8+2' },
                { id: 'pc-2', name: 'Borin', side: 'player', maxHp: 24, hp: 24, ac: 14, attackBonus: 5, damage: '1d8+2' },
                {
                    id: 'enemy-2', name: 'Pyromancer', side: 'enemy', maxHp: 20, hp: 20, ac: 11, attackBonus: 3, damage: '1d6',
                    skills: [{
                        id: 'fireball', name: 'Fireball', kind: 'attack', range: 6, damage: '1d6', maxUses: 2, uses: 2,
                        area: { shape: 'burst', radius: 1, origin: 'target', friendlyFire: false },
                    }],
                },
            ],
        });
        const [pc1, pc2, enemy] = state.units;
        enemy.x = 3; enemy.y = 3;
        pc1.x = 2; pc1.y = 2;
        pc2.x = 2; pc2.y = 3;
        state.phase = 'enemy';
        state.pendingAgentUnitIds = ['enemy-2'];
        const actions = buildLocalAiActions(state, ['enemy-2']);
        expect(actions.some(action => action.type === 'skill' && action.skillId === 'fireball')).toBe(true);
        const applied = interpretActions(state, actions, {
            unitIds: ['enemy-2'], actorSide: 'agent', source: 'agent', rng: () => 0.5,
        });
        expect(applied.rejected).toEqual([]);
        expect(pc1.hp).toBeLessThan(24);
        expect(pc2.hp).toBeLessThan(24);
    });

    it('uses the agent action list when the connection returns valid JSON', async () => {
        const state = makeState();
        sendStateRequest.mockResolvedValue('{"actions":[{"type":"wait","unitId":"enemy-2"}]}');
        const result = await runAgentTurn(state, ['enemy-2'], SETTINGS);
        expect(result.source).toBe('agent');
        expect(result.applied).toHaveLength(1);
        expect(getUnitById(state, 'enemy-2').doneForRound).toBe(true);
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
        const call = sendStateRequest.mock.calls[0];
        expect(call[1]).toBe(SETTINGS.tacticalCombatAgentPrompt);
        expect(call[2]).toContain('GAME STATE');
        expect(call[2]).toContain('"unitId":"enemy-2"');
    });

    it('falls back to local tactics when the connection fails', async () => {
        const state = makeState();
        sendStateRequest.mockRejectedValue(new Error('offline'));
        const result = await runAgentTurn(state, ['enemy-2'], SETTINGS);
        expect(result.source).toBe('local');
        expect(result.error).toMatch(/offline/i);
        expect(result.applied.length).toBeGreaterThan(0);
        expect(state.status).toBe('active');
    });

    it('retries once with a correction prompt when the first response is malformed', async () => {
        const state = makeState();
        sendStateRequest
            .mockResolvedValueOnce('not json')
            .mockResolvedValueOnce('{"actions":[{"type":"wait","unitId":"enemy-2"}]}');
        const result = await requestAgentActions(state, ['enemy-2'], SETTINGS);
        expect(result.ok).toBe(true);
        expect(result.attempts).toBe(2);
        expect(sendStateRequest).toHaveBeenCalledTimes(2);
        expect(sendStateRequest.mock.calls[1][2]).toContain('CORRECTION');
    });

    it('completes an agent phase and starts the next player round', async () => {
        const state = makeState();
        sendStateRequest.mockResolvedValue('{"actions":[{"type":"wait","unitId":"enemy-2"}]}');
        const result = await runAgentTurn(state, ['enemy-2'], SETTINGS);
        expect(result.applied).toHaveLength(1);
        const completion = completeAgentTurn(state, () => 0.5);
        expect(completion.phase).toBe('player');
        expect(state.round).toBe(2);
        expect(getUnitById(state, 'pc-1').movementUsed).toBe(0);
    });

    it('honours the configured special-resolution cap', async () => {
        const state = makeState();
        const enemy = getUnitById(state, 'enemy-2');
        enemy.skills = [{ id: 'dread-wail', name: 'Dread Wail', kind: 'special', range: 6, maxUses: 1, uses: 1, description: 'A fearful wail.' }];
        sendStateRequest.mockReset();
        sendStateRequest.mockResolvedValueOnce('{"actions":[{"type":"skill","unitId":"enemy-2","skillId":"dread-wail","targetId":"pc-1"}]}');
        const result = await runAgentTurn(state, ['enemy-2'], { ...SETTINGS, tacticalCombatMaxSpecialResolutions: 0 }, { rng: () => 0.99 });
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
        expect(result.rejected.some(entry => /Special resolution limit/i.test(entry.error))).toBe(true);
    });

    it('never lets the agent act for player units', async () => {
        const state = makeState();
        const actions = buildLocalAiActions(state, ['pc-1']);
        const applied = interpretActions(state, actions, { unitIds: ['pc-1'], actorSide: 'agent', source: 'agent' });
        expect(applied.applied).toHaveLength(0);
        expect(applied.rejected.length).toBeGreaterThan(0);
        expect(applied.rejected[0].error).toMatch(/player-controlled/i);
    });

    it('bundles the game state and action contract into the prompt', () => {
        const state = makeState();
        const { catalog } = getActionCatalog(SETTINGS);
        const prompts = buildAgentPrompts(state, ['enemy-2'], SETTINGS, catalog);
        expect(prompts.payload.unitsToMove[0].unitId).toBe('enemy-2');
        expect(prompts.user).toContain('GAME STATE');
        expect(prompts.user).toContain('enemy-2');
        expect(prompts.system).toBe(SETTINGS.tacticalCombatAgentPrompt);
    });
});
