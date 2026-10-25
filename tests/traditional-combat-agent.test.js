import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendStateRequest } = vi.hoisted(() => ({ sendStateRequest: vi.fn() }));
vi.mock('../llm-client.js', () => ({ sendStateRequest }));

import {
    buildTraditionalAgentPrompts,
    runTraditionalAgentTurn,
} from '../src/features/traditional-combat/traditional-combat-agent.js';
import {
    buildTraditionalAgentGameState,
    createTraditionalEncounterState,
    getTraditionalActionCatalog,
} from '../src/features/traditional-combat/traditional-combat-engine.js';
import { buildLocalAiActions } from '../src/features/tactical-combat/tactical-combat-agent.js';
import { sanitizeActionsPayload } from '../src/features/tactical-combat/tactical-combat-actions.js';
import { DEFAULT_TRADITIONAL_ACTION_CATALOG } from '../src/features/traditional-combat/traditional-combat-constants.js';

function makeState() {
    return createTraditionalEncounterState({
        seed: 7,
        turnStyle: 'phase',
        units: [
            {
                id: 'pc-1', name: 'Aria', side: 'player', maxHp: 20, hp: 20, ac: 12,
                attackBonus: 5, damage: '1d8', initiativeBonus: 4,
                skills: [{ id: 'heal-1', name: 'Mend', kind: 'heal', heal: '1d8', target: 'ally', maxUses: 2 }],
            },
            {
                id: 'enemy-2', name: 'Goblin', side: 'enemy', maxHp: 10, hp: 10, ac: 10,
                attackBonus: 2, damage: '1d4', initiativeBonus: 0,
                skills: [{ id: 'wail-1', name: 'Wail', kind: 'attack', resource: 'willpower', damage: '1d4', maxUses: 1 }],
            },
        ],
        actionCatalog: DEFAULT_TRADITIONAL_ACTION_CATALOG,
    });
}

describe('traditional combat agent contract', () => {
    beforeEach(() => {
        sendStateRequest.mockReset();
    });

    it('builds a traditional prompt and payload without movement or grid data', () => {
        const state = makeState();
        const catalog = getTraditionalActionCatalog({}).catalog;
        const prompts = buildTraditionalAgentPrompts(state, ['enemy-2'], {}, catalog);
        expect(prompts.system).toMatch(/There is NO move action/i);
        expect(prompts.user).toContain('"mode":"traditional"');
        expect(prompts.payload.unitsToAct[0].attackTargets).toContain('pc-1');
        expect(prompts.payload.rules.actionTypes).not.toContain('move');
        expect(prompts.payload.grid).toBeUndefined();
        expect(prompts.payload.units[0].x).toBeUndefined();
    });

    it('rejects a move action before it reaches the engine', () => {
        const state = makeState();
        const catalog = getTraditionalActionCatalog({}).catalog;
        const sanitized = sanitizeActionsPayload([
            { type: 'move', unitId: 'enemy-2', to: { x: 1, y: 1 } },
        ], { unitIds: ['enemy-2'], catalog });
        expect(sanitized.actions).toEqual([]);
        expect(sanitized.rejected[0].error).toMatch(/disabled|unsupported/i);
    });

    it('never emits movement from the local fallback in theater mode', () => {
        const state = makeState();
        state.units.forEach(unit => { unit.x = 0; unit.y = 0; });
        const actions = buildLocalAiActions(state, ['enemy-2'], { allowMove: false, theater: true });
        expect(actions.length).toBeGreaterThan(0);
        expect(actions.every(action => action.type !== 'move')).toBe(true);
    });

    it('includes legal targets for every enemy skill', () => {
        const state = makeState();
        const payload = buildTraditionalAgentGameState(state, ['enemy-2']);
        expect(payload.unitsToAct[0].skillTargets['wail-1']).toEqual(expect.arrayContaining(['pc-1']));
    });

    it('falls back to deterministic local actions when the connection fails', async () => {
        sendStateRequest.mockRejectedValue(new Error('offline'));
        const state = makeState();
        state.phase = 'enemy';
        const result = await runTraditionalAgentTurn(state, ['enemy-2'], {
            traditionalCombatActionCatalogJson: JSON.stringify(DEFAULT_TRADITIONAL_ACTION_CATALOG),
        }, { rng: () => 0.5 });
        expect(['local', 'mixed']).toContain(result.source);
        expect(result.applied.length).toBeGreaterThan(0);
    });

    it('resolves a valid agent attack through the traditional interpreter', async () => {
        sendStateRequest.mockResolvedValue('{"actions":[{"type":"attack","unitId":"enemy-2","targetId":"pc-1"}]}');
        const state = makeState();
        state.phase = 'enemy';
        const result = await runTraditionalAgentTurn(state, ['enemy-2'], {
            traditionalCombatActionCatalogJson: JSON.stringify(DEFAULT_TRADITIONAL_ACTION_CATALOG),
        }, { rng: () => 0.5 });
        expect(result.source).toBe('agent');
        expect(result.applied.length).toBe(1);
        expect(sendStateRequest.mock.calls[0][1]).toMatch(/Traditional Combat Agent/i);
    });
});
