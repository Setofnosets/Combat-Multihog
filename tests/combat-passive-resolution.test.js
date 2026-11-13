import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendStateRequest } = vi.hoisted(() => ({ sendStateRequest: vi.fn() }));
vi.mock('../llm-client.js', () => ({ sendStateRequest }));

import { createEmptySkillRegistry } from '../src/features/skill-registry/skill-registry.js';
import {
    applyPassiveRecipesToState,
    hasPendingPassiveRecipes,
    resolveAgentEncounterPassives,
    resolvePassiveRecipeWithAgent,
    resolvePassiveSkillWithAgent,
    resolvePendingPassives,
} from '../src/features/tactical-combat/tactical-combat-agent.js';
import { buildEncounterFromContext, mergeAgentEncounterPassives } from '../src/features/tactical-combat/tactical-combat-context.js';
import {
    isPassiveFlavourOnly,
    isPassiveRecipePending,
    isPassiveRecipeResolved,
} from '../src/features/tactical-combat/tactical-combat-passives.js';

const CHAT_ID = 'passive-resolution-chat';

function makeSettings() {
    return { skillRegistry: createEmptySkillRegistry() };
}

function makeUnit(name, skills) {
    return {
        id: 'pc-1',
        name,
        side: 'player',
        maxHp: 20,
        hp: 20,
        ac: 12,
        attackBonus: 3,
        damage: '1d6',
        skills,
    };
}

function makeContext(unit) {
    return {
        chatId: CHAT_ID,
        playerUnits: [unit],
        allies: [],
        enemies: [],
        existingCombat: false,
    };
}

function flavourPassive(name = 'Noble Bearing') {
    return {
        id: 'noble-bearing',
        name,
        kind: 'special',
        passive: true,
        unlimited: true,
        maxUses: 0,
        uses: 0,
        trigger: null,
        effectTemplate: null,
    };
}

beforeEach(() => {
    sendStateRequest.mockReset();
});

describe('empty-effects contract', () => {
    it('persists effects: [] as resolved and never recompiles it', async () => {
        sendStateRequest.mockResolvedValue(JSON.stringify({
            trigger: { event: 'battle-start', limit: 'per-encounter' },
            effects: [],
        }));
        const settings = makeSettings();
        const skill = flavourPassive();
        const firstContext = makeContext(makeUnit('Aria', [skill]));
        const first = await resolvePendingPassives(firstContext, settings, { chatId: CHAT_ID });
        expect(first.changed).toBe(1);
        expect(first.warnings).toEqual([]);
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
        expect(isPassiveRecipePending(skill)).toBe(false);
        expect(isPassiveRecipeResolved(skill)).toBe(true);
        expect(isPassiveFlavourOnly(skill)).toBe(true);

        // A fresh encounter with the same prose passive must reuse the stored
        // resolved no-op instead of calling the resolver again.
        const nextSkill = flavourPassive();
        const secondContext = makeContext(makeUnit('Aria', [nextSkill]));
        const second = await resolvePendingPassives(secondContext, settings, { chatId: CHAT_ID });
        expect(second.changed).toBe(0);
        expect(second.warnings).toEqual([]);
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
        expect(isPassiveRecipePending(nextSkill)).toBe(false);
        expect(isPassiveFlavourOnly(nextSkill)).toBe(true);
    });

    it('rejects a malformed response that lacks an effects array', async () => {
        sendStateRequest.mockResolvedValue(JSON.stringify({
            trigger: { event: 'hit', attack: 'melee' },
        }));
        const compiled = await resolvePassiveRecipeWithAgent({
            name: 'Unclear Passive',
            type: 'ability',
            brief: 'Passive: something happens.',
            mechanics: { kind: 'special', passive: true },
        }, makeSettings(), { mode: 'tactical' });
        expect(compiled.ok).toBe(false);
        expect(compiled.error).toBeTruthy();
        expect(isPassiveRecipePending({
            passive: true,
            trigger: compiled.trigger,
            effectTemplate: [],
        })).toBe(true);
    });

    it('remaps targetId-only effects before the emptiness check', async () => {
        sendStateRequest.mockResolvedValue(JSON.stringify({
            trigger: { event: 'round-start' },
            effects: [
                { type: 'status', targetId: 'aria-1', label: 'Shielded', rounds: 1, acBonus: 1 },
                { type: 'damage', targetId: 'goblin-1', amount: '1d4', resource: 'hp' },
            ],
        }));
        const compiled = await resolvePassiveRecipeWithAgent({
            name: 'Warded Stance',
            type: 'ability',
            brief: 'Passive: shields the owner each round.',
            owners: [{ type: 'character', name: 'Aria' }],
            mechanics: { kind: 'special', passive: true },
        }, makeSettings(), { mode: 'tactical', casterId: 'aria-1', casterName: 'Aria' });
        expect(compiled.ok).toBe(true);
        expect(compiled.effects).toHaveLength(2);
        expect(compiled.effects[0]).toMatchObject({ target: '$caster' });
        expect(compiled.effects[0].targetId).toBeUndefined();
        expect(compiled.effects[1]).toMatchObject({ target: '$target' });
    });
});

describe('agent-authored enemy passives', () => {
    it('merges the architect roster into the compile set and resolves it before Round 1', async () => {
        sendStateRequest.mockResolvedValue(JSON.stringify({
            trigger: { event: 'round-start' },
            effects: [{ type: 'heal', target: '$caster', amount: '1d4', resource: 'hp' }],
        }));
        const settings = makeSettings();
        const agentEncounter = {
            enemies: [{
                name: 'Goblin Archer',
                side: 'enemy',
                maxHp: 12,
                hp: 12,
                ac: 12,
                attackBonus: 3,
                damage: '1d6',
                skills: [{ id: 'steady-aim', name: 'Steady Aim', passive: true, description: 'Passive: steadies the shot.' }],
            }],
        };
        const context = {
            chatId: CHAT_ID,
            playerUnits: [makeUnit('Aria', [])],
            allies: [],
            enemies: [],
            existingCombat: false,
            movement: 6,
            willpowerMaxPercent: 30,
            theme: 'plain',
        };
        const merged = mergeAgentEncounterPassives(context, agentEncounter, { source: 'agent' });
        expect(merged).not.toBe(context);
        expect(hasPendingPassiveRecipes(merged)).toBe(true);

        const compiled = await resolveAgentEncounterPassives(context, agentEncounter, settings, {
            mode: 'tactical',
            source: 'agent',
            chatId: CHAT_ID,
        });
        expect(compiled.pending).toBe(false);
        expect(compiled.changed).toBe(1);
        expect(sendStateRequest).toHaveBeenCalledTimes(1);

        const built = buildEncounterFromContext(compiled.context, settings, {
            agentEncounter,
            source: 'agent',
            seed: 12,
        });
        const enemy = built.state.units.find(unit => unit.name === 'Goblin Archer');
        const passive = enemy.skills.find(skill => skill.name === 'Steady Aim');
        expect(passive).toMatchObject({ passive: true, registryStatus: 'resolved' });
        expect(passive.trigger).toMatchObject({ event: 'round-start' });
        expect(passive.effectTemplate).toHaveLength(1);
    });

    it('keeps the passive pending and reports a named warning when the resolver fails', async () => {
        sendStateRequest.mockRejectedValue(new Error('provider offline'));
        const settings = makeSettings();
        const agentEncounter = {
            enemies: [{
                name: 'Goblin Archer',
                side: 'enemy',
                skills: [{ id: 'steady-aim', name: 'Steady Aim', passive: true, description: 'Passive: steady.' }],
            }],
        };
        const context = {
            chatId: CHAT_ID,
            playerUnits: [makeUnit('Aria', [])],
            allies: [],
            enemies: [],
            existingCombat: false,
        };
        const compiled = await resolveAgentEncounterPassives(context, agentEncounter, settings, {
            mode: 'tactical',
            source: 'agent',
            chatId: CHAT_ID,
        });
        expect(compiled.pending).toBe(true);
        expect(compiled.warnings[0]).toMatch(/Steady Aim/i);
    });
});

describe('recipe application and retry guards', () => {
    it('matches by registryId first so renamed/suffixed enemies receive their recipe', () => {
        const context = {
            playerUnits: [],
            allies: [],
            enemies: [{
                name: 'Goblin',
                side: 'enemy',
                skills: [{
                    name: 'Pack Tactics',
                    passive: true,
                    trigger: { event: 'hit' },
                    effectTemplate: [{ type: 'status', target: '$caster', label: 'Pack Tactics', rounds: 1, attackBonus: 2 }],
                    registryId: 'pack-tactics',
                    registryStatus: 'resolved',
                }],
            }],
        };
        const state = {
            units: [{
                id: 'enemy-1',
                name: 'Goblin Archer (elite)',
                side: 'enemy',
                skills: [{ id: 'elite-volley', name: 'Elite Volley', passive: true, registryId: 'pack-tactics', effectTemplate: null }],
            }],
        };
        expect(applyPassiveRecipesToState(context, state)).toBe(1);
        expect(state.units[0].skills[0].registryStatus).toBe('resolved');
        expect(state.units[0].skills[0].effectTemplate).toHaveLength(1);
    });

    it('never cross-applies a same-named passive across sides', () => {
        const context = {
            playerUnits: [{
                name: 'Aria',
                side: 'player',
                skills: [{
                    name: 'Pack Tactics',
                    passive: true,
                    trigger: { event: 'hit' },
                    effectTemplate: [{ type: 'status', target: '$caster', label: 'Pack Tactics', rounds: 1, attackBonus: 2 }],
                    registryStatus: 'resolved',
                }],
            }],
            allies: [],
            enemies: [],
        };
        const state = {
            units: [{
                id: 'enemy-1',
                name: 'Goblin',
                side: 'enemy',
                skills: [{ id: 'enemy-pack', name: 'Pack Tactics', passive: true, effectTemplate: null }],
            }],
        };
        expect(applyPassiveRecipesToState(context, state)).toBe(0);
    });

    it('retries a single pending passive in place and is a no-op once resolved', async () => {
        sendStateRequest.mockResolvedValue(JSON.stringify({
            trigger: { event: 'attacked' },
            effects: [{ type: 'damage', target: '$target', amount: '1d4', resource: 'hp' }],
        }));
        const settings = makeSettings();
        const unit = makeUnit('Aria', [flavourPassive('Thorn Mail')]);
        const state = { units: [unit], status: 'active' };
        const result = await resolvePassiveSkillWithAgent(state, 'pc-1', 'noble-bearing', settings, { mode: 'tactical' });
        expect(result).toMatchObject({ ok: true, changed: true, flavour: false });
        expect(unit.skills[0].registryStatus).toBe('resolved');
        const again = await resolvePassiveSkillWithAgent(state, 'pc-1', 'noble-bearing', settings, { mode: 'tactical' });
        expect(again).toMatchObject({ ok: true, alreadyResolved: true, changed: false });
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
    });

    it('refuses to re-resolve a passive on a board that is no longer active', async () => {
        const unit = makeUnit('Aria', [flavourPassive('Thorn Mail')]);
        const state = { units: [unit], status: 'victory' };
        const result = await resolvePassiveSkillWithAgent(state, 'pc-1', 'noble-bearing', makeSettings(), { mode: 'tactical' });
        expect(result).toMatchObject({ ok: false });
        expect(result.error).toMatch(/no longer active/i);
        expect(sendStateRequest).not.toHaveBeenCalled();
    });
});
