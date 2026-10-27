import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendStateRequest } = vi.hoisted(() => ({ sendStateRequest: vi.fn() }));
vi.mock('../llm-client.js', () => ({ sendStateRequest }));

import {
    buildSkillCatalog,
    canonicalizeSpecialEffects,
    createEmptySkillRegistry,
    findSkillRegistryEntry,
    normalizeSkillRegistry,
    registerSkillsFromUnits,
    rememberSpecialResolution,
    upsertSkillRegistryEntry,
} from '../src/features/skill-registry/skill-registry.js';
import { resolveSpecialSource, normalizeEncounterPayload, runAgentTurn } from '../src/features/tactical-combat/tactical-combat-agent.js';
import { collectEncounterContext } from '../src/features/tactical-combat/tactical-combat-context.js';
import {
    createEncounterState,
    getUnitById,
    prepareSpecialAction,
    resolveEffectTemplate,
} from '../src/features/tactical-combat/tactical-combat-engine.js';

function makeState() {
    const state = createEncounterState({
        seed: 21,
        grid: { rows: 8, cols: 8 },
        terrainRows: Array.from({ length: 8 }, () => '........'),
        turnStyle: 'phase',
        movement: 6,
        units: [
            { id: 'pc-1', name: 'Aria', side: 'player', maxHp: 30, hp: 30, ac: 14, attackBonus: 5, damage: '1d8+2' },
            { id: 'enemy-2', name: 'Goblin', side: 'enemy', maxHp: 14, hp: 14, ac: 12, attackBonus: 3, damage: '1d6' },
        ],
    });
    state.units[0].x = 1;
    state.units[0].y = 1;
    state.units[1].x = 3;
    state.units[1].y = 1;
    return state;
}

function makeSettings() {
    return {
        skillRegistry: createEmptySkillRegistry(),
        tacticalCombatAgentPrompt: 'agent',
        tacticalCombatSpecialPrompt: 'special',
        traditionalCombatSpecialPrompt: 'special',
        tacticalCombatConnectionSource: 'default',
        tacticalCombatMaxTokens: 4000,
    };
}

describe('skill registry normalization and merge', () => {
    it('normalizes skills, classes, and forms into one versioned registry', () => {
        const parsed = normalizeSkillRegistry(JSON.stringify({
            skills: {
                fireball: {
                    name: 'Fireball',
                    type: 'spell',
                    brief: 'A roaring ball of fire.',
                    status: 'confirmed',
                    mechanics: {
                        kind: 'attack',
                        damage: '8d6',
                        range: 8,
                        area: { shape: 'burst', radius: 2, origin: 'target' },
                        effectTemplate: [{ type: 'damage', target: '$target', amount: '8d6' }],
                    },
                },
            },
            forms: {
                dragon: { name: 'Dragon Form', maxHp: 40, ac: 17, skills: [{ name: 'Dragon Breath', kind: 'attack', damage: '4d6' }] },
            },
            classes: {
                wizard: { name: 'Wizard', skillIds: ['Fireball'] },
            },
        }));
        expect(parsed.ok).toBe(true);
        expect(parsed.registry.skills.fireball).toMatchObject({ name: 'Fireball', status: 'confirmed' });
        expect(parsed.registry.skills.fireball.mechanics.effectTemplate).toHaveLength(1);
        expect(parsed.registry.forms.dragon.skills[0].name).toBe('Dragon Breath');
        expect(parsed.registry.classes.wizard.skillIds).toEqual(['Fireball']);
    });

    it('upgrades a confirmed special with the first resolved recipe', () => {
        const registry = createEmptySkillRegistry();
        upsertSkillRegistryEntry(registry, {
            name: 'Cinder Burst',
            source: 'memo',
            status: 'confirmed',
            mechanics: { kind: 'special', range: 6 },
        });
        const result = upsertSkillRegistryEntry(registry, {
            name: 'Cinder Burst',
            source: 'architect',
            status: 'resolved',
            mechanics: {
                kind: 'special',
                effectTemplate: [{ type: 'damage', target: '$target', amount: '3d6' }],
            },
        });
        expect(result.entry.status).toBe('resolved');
        expect(result.entry.mechanics.effectTemplate[0].amount).toBe('3d6');
    });


    it('does not overwrite a resolved recipe or locked entry with a conflicting auto-discovery', () => {
        const registry = createEmptySkillRegistry();
        upsertSkillRegistryEntry(registry, {
            name: 'Dread Wail',
            source: 'resolver',
            status: 'resolved',
            mechanics: { kind: 'special', effectTemplate: [{ type: 'damage', target: '$target', amount: '2d6' }] },
        });
        const entry = findSkillRegistryEntry(registry, 'Dread Wail');
        entry.locked = true;
        const result = upsertSkillRegistryEntry(registry, {
            name: 'Dread Wail',
            source: 'memo',
            status: 'confirmed',
            mechanics: { kind: 'attack', damage: '1d4' },
        });
        expect(result.entry.mechanics.effectTemplate[0].amount).toBe('2d6');
        expect(result.entry.mechanics.damage).toBe('');
        expect(result.entry.status).toBe('resolved');
    });

    it('merges a confirmed registry entry over the global compendium in the catalog', () => {
        const settings = makeSettings();
        upsertSkillRegistryEntry(settings.skillRegistry, {
            name: 'Fireball',
            source: 'resolver',
            status: 'resolved',
            mechanics: {
                kind: 'special',
                effectTemplate: [{ type: 'damage', target: '$areaHostile', amount: '10d6' }],
            },
        });
        const catalog = buildSkillCatalog(settings, 'Spells: Level 3 (1/1): Fireball');
        expect(catalog.spells.fireball.kind).toBe('special');
        expect(catalog.spells.fireball.effectTemplate[0].amount).toBe('10d6');
    });
});

describe('effect template expansion', () => {
    it('expands role selectors and re-anchors terrain offsets', () => {
        const expanded = resolveEffectTemplate([
            { type: 'damage', target: '$areaHostile', amount: '2d6' },
            { type: 'heal', target: '$areaFriendly', amount: '1d6' },
            { type: 'terrain', terrain: 'water', cellOffsets: [{ dx: -1, dy: 0 }, { dx: 0, dy: 0 }] },
        ], {
            casterId: 'pc-1',
            targetId: 'enemy-2',
            targetIds: ['enemy-2', 'pc-1'],
            hostileIds: ['enemy-2'],
            friendlyIds: ['pc-1'],
            anchor: { x: 4, y: 4 },
        });
        expect(expanded).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'damage', targetId: 'enemy-2' }),
            expect.objectContaining({ type: 'heal', targetId: 'pc-1' }),
            expect.objectContaining({
                type: 'terrain',
                cells: [{ x: 3, y: 4, terrain: 'water' }, { x: 4, y: 4, terrain: 'water' }],
            }),
        ]));
    });

    it('expands a stored transformation form into a complete transform effect', () => {
        const expanded = resolveEffectTemplate([
            { type: 'transform', target: '$caster', formId: 'dragon', rounds: 3 },
        ], {
            casterId: 'pc-1',
            targetId: 'pc-1',
            forms: {
                dragon: {
                    id: 'dragon',
                    name: 'Dragon Form',
                    maxHp: 45,
                    ac: 17,
                    attackBonus: 7,
                    damage: '2d8+4',
                    replaceSkills: true,
                    skills: [{ name: 'Dragon Breath', kind: 'attack', damage: '4d6', range: 6 }],
                    duration: { rounds: 3, permanent: false },
                },
            },
        });
        expect(expanded[0]).toMatchObject({
            type: 'transform',
            targetId: 'pc-1',
            name: 'Dragon Form',
            maxHp: 45,
            ac: 17,
            rounds: 3,
        });
        expect(expanded[0].skills[0].name).toBe('Dragon Breath');
    });
});

describe('resolved special reuse', () => {
    beforeEach(() => {
        sendStateRequest.mockReset();
    });

    it('resolves a special once and reuses its recipe without another AI call', async () => {
        const state = makeState();
        const settings = makeSettings();
        const caster = getUnitById(state, 'pc-1');
        const enemy = getUnitById(state, 'enemy-2');
        caster.skills = [{
            id: 'dread-wail',
            name: 'Dread Wail',
            kind: 'special',
            range: 6,
            maxUses: 2,
            uses: 2,
            description: 'A wail that breaks resolve.',
        }];
        sendStateRequest.mockResolvedValue(JSON.stringify({
            log: 'The wail cuts through the air.',
            effects: [{ type: 'damage', targetId: 'enemy-2', amount: '2d6', resource: 'hp' }],
        }));
        const prepared = prepareSpecialAction(state, {
            type: 'skill', unitId: 'pc-1', skillId: 'dread-wail', targetId: 'enemy-2',
        }, { actorSide: 'player' });
        expect(prepared.ok).toBe(true);
        const first = await resolveSpecialSource(state, prepared, {
            kind: 'skill',
            name: 'Dread Wail',
            description: 'A wail that breaks resolve.',
            range: 6,
            maxUses: 2,
        }, settings);
        expect(first.ok).toBe(true);
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
        const entry = findSkillRegistryEntry(settings, 'Dread Wail');
        expect(entry.status).toBe('resolved');
        expect(entry.mechanics.effectTemplate[0]).toMatchObject({ type: 'damage', target: '$target', amount: '2d6' });

        sendStateRequest.mockReset();
        caster.actionUsed = false;
        const secondPrepared = prepareSpecialAction(state, {
            type: 'skill', unitId: 'pc-1', skillId: 'dread-wail', targetId: 'enemy-2',
        }, { actorSide: 'player' });
        const second = await resolveSpecialSource(state, secondPrepared, {
            kind: 'skill',
            name: 'Dread Wail',
            description: 'A wail that breaks resolve.',
            range: 6,
            maxUses: 2,
        }, settings);
        expect(second.ok).toBe(true);
        expect(second.fromRegistry).toBe(true);
        expect(sendStateRequest).not.toHaveBeenCalled();
        expect(second.effects[0]).toMatchObject({ type: 'damage', targetId: 'enemy-2', amount: '2d6' });
    });

    it('stores transformation forms and reuses the same skills on later casts', async () => {
        const state = makeState();
        const settings = makeSettings();
        const caster = getUnitById(state, 'pc-1');
        caster.skills = [{
            id: 'dragon-form',
            name: 'Dragon Form',
            kind: 'special',
            range: 0,
            target: 'self',
            maxUses: 2,
            uses: 2,
            description: 'Become a dragon.',
        }];
        sendStateRequest.mockResolvedValue(JSON.stringify({
            log: 'Aria becomes a dragon.',
            effects: [{
                type: 'transform',
                targetId: 'pc-1',
                name: 'Dragon Form',
                classLabel: 'Dragon',
                maxHp: 45,
                ac: 17,
                attackBonus: 7,
                damage: '2d8+4',
                skills: [
                    { name: 'Dragon Breath', kind: 'attack', damage: '4d6', range: 6, maxUses: 2 },
                    { name: 'Claw and Bite', kind: 'attack', damage: '2d8+4', range: 1, unlimited: true },
                ],
                rounds: 3,
            }],
        }));
        const prepared = prepareSpecialAction(state, {
            type: 'skill', unitId: 'pc-1', skillId: 'dragon-form', targetId: 'pc-1',
        }, { actorSide: 'player' });
        const first = await resolveSpecialSource(state, prepared, {
            kind: 'skill',
            name: 'Dragon Form',
            description: 'Become a dragon.',
            range: 0,
            target: 'self',
            maxUses: 2,
        }, settings);
        expect(first.ok).toBe(true);
        const form = settings.skillRegistry.forms['dragon-form'];
        expect(form).toBeTruthy();
        expect(form.skills.map(skill => skill.name)).toEqual(['Dragon Breath', 'Claw and Bite']);

        sendStateRequest.mockReset();
        caster.actionUsed = false;
        const secondPrepared = prepareSpecialAction(state, {
            type: 'skill', unitId: 'pc-1', skillId: 'dragon-form', targetId: 'pc-1',
        }, { actorSide: 'player' });
        const second = await resolveSpecialSource(state, secondPrepared, {
            kind: 'skill',
            name: 'Dragon Form',
            description: 'Become a dragon.',
            range: 0,
            target: 'self',
            maxUses: 2,
        }, settings);
        expect(second.ok).toBe(true);
        expect(sendStateRequest).not.toHaveBeenCalled();
        expect(second.effects[0].name).toBe('Dragon Form');
        expect(second.effects[0].skills.map(skill => skill.name)).toEqual(['Dragon Breath', 'Claw and Bite']);
        expect(second.effects[0].rounds).toBe(3);
    });

    it('reuses a registered enemy special across encounters through the agent loop', async () => {
        const settings = makeSettings();
        const prepareEnemy = () => {
            const state = makeState();
            const enemy = getUnitById(state, 'enemy-2');
            enemy.skills = [{
                id: 'dread-wail',
                name: 'Dread Wail',
                kind: 'special',
                range: 6,
                maxUses: 1,
                uses: 1,
                description: 'A wail that breaks resolve.',
            }];
            state.phase = 'enemy';
            state.pendingAgentUnitIds = ['enemy-2'];
            return state;
        };
        sendStateRequest
            .mockResolvedValueOnce('{"actions":[{"type":"skill","unitId":"enemy-2","skillId":"dread-wail","targetId":"pc-1"}]}')
            .mockResolvedValueOnce(JSON.stringify({
                effects: [{ type: 'damage', targetId: 'pc-1', amount: '2d6', resource: 'hp' }],
            }));
        const firstState = prepareEnemy();
        const first = await runAgentTurn(firstState, ['enemy-2'], settings, { rng: () => 0.5 });
        expect(first.applied).toHaveLength(1);
        expect(sendStateRequest).toHaveBeenCalledTimes(2);

        sendStateRequest.mockReset();
        sendStateRequest.mockResolvedValueOnce('{"actions":[{"type":"skill","unitId":"enemy-2","skillId":"dread-wail","targetId":"pc-1"}]}');
        const secondState = prepareEnemy();
        const second = await runAgentTurn(secondState, ['enemy-2'], settings, { rng: () => 0.5 });
        expect(second.applied).toHaveLength(1);
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
        expect(getUnitById(secondState, 'pc-1').hp).toBeLessThan(30);
    });

    it('applies a resolved registry special to an architect-authored enemy skill', () => {
        const settings = makeSettings();
        upsertSkillRegistryEntry(settings.skillRegistry, {
            name: 'Dread Wail',
            source: 'resolver',
            status: 'resolved',
            mechanics: {
                kind: 'special',
                resource: 'willpower',
                effectTemplate: [{ type: 'damage', target: '$target', amount: '2d6', resource: 'willpower', willpowerOutcome: 'flee' }],
            },
        });
        const normalized = normalizeEncounterPayload({
            title: 'Wail in the Dark',
            enemies: [{
                name: 'Wailing Horror',
                maxHp: 20,
                ac: 12,
                attackBonus: 4,
                damage: '1d6+1',
                skills: [{ name: 'Dread Wail', kind: 'attack', range: 6, damage: '1d4', maxUses: 2 }],
            }],
        }, { skillRegistry: settings.skillRegistry });
        expect(normalized.ok).toBe(true);
        const skill = normalized.encounter.enemies[0].skills[0];
        expect(skill.kind).toBe('special');
        expect(skill.effectTemplate[0].amount).toBe('2d6');
        expect(skill.resource).toBe('willpower');
    });

    it('attaches a registered effect template to a memo spell', () => {
        const settings = {
            ...makeSettings(),
            currentMemo: `[CHARACTER]
Aria (Mage): 20/20 HP
Spells: Level 1 (1/1): Dread Wail
Status: Healthy
[/CHARACTER]`,
        };
        upsertSkillRegistryEntry(settings.skillRegistry, {
            name: 'Dread Wail',
            type: 'spell',
            source: 'resolver',
            status: 'resolved',
            mechanics: {
                kind: 'special',
                effectTemplate: [{ type: 'damage', target: '$target', amount: '2d6', resource: 'willpower' }],
            },
        });
        const context = collectEncounterContext(settings, { name1: 'Aria', chatId: 'registry-context', chat: [] });
        const skill = context.playerUnits[0].skills.find(entry => entry.name === 'Dread Wail');
        expect(skill.kind).toBe('special');
        expect(skill.effectTemplate[0].amount).toBe('2d6');
        expect(skill.registryId).toBe('dread-wail');
    });

    it('does not count a cached deterministic special against the resolver cap', async () => {
        const settings = {
            ...makeSettings(),
            tacticalCombatMaxSpecialResolutions: 0,
        };
        upsertSkillRegistryEntry(settings.skillRegistry, {
            name: 'Dread Wail',
            source: 'resolver',
            status: 'resolved',
            mechanics: {
                kind: 'special',
                effectTemplate: [{ type: 'damage', target: '$target', amount: '2d6', resource: 'hp' }],
            },
        });
        const state = makeState();
        const enemy = getUnitById(state, 'enemy-2');
        enemy.skills = [{ id: 'dread-wail', name: 'Dread Wail', kind: 'special', range: 6, maxUses: 1, uses: 1 }];
        state.phase = 'enemy';
        state.pendingAgentUnitIds = ['enemy-2'];
        sendStateRequest.mockReset();
        sendStateRequest.mockResolvedValueOnce('{"actions":[{"type":"skill","unitId":"enemy-2","skillId":"dread-wail","targetId":"pc-1"}]}');
        const result = await runAgentTurn(state, ['enemy-2'], settings, { rng: () => 0.5 });
        expect(result.applied).toHaveLength(1);
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
        expect(result.rejected.some(entry => /Special resolution limit/.test(entry.error))).toBe(false);
    });

    it('retries loadout authoring instead of freezing an incomplete transformation form', async () => {
        const state = makeState();
        const settings = makeSettings();
        const caster = getUnitById(state, 'pc-1');
        caster.skills = [{ id: 'dragon-form', name: 'Dragon Form', kind: 'special', range: 0, target: 'self', maxUses: 2, uses: 2 }];
        upsertSkillRegistryEntry(settings.skillRegistry, {
            name: 'Dragon Form',
            source: 'resolver',
            status: 'resolved',
            mechanics: {
                kind: 'special',
                effectTemplate: [{ type: 'transform', target: '$caster', formId: 'dragon-form', rounds: 3 }],
            },
        });
        settings.skillRegistry.forms['dragon-form'] = {
            id: 'dragon-form',
            name: 'Dragon Form',
            ac: 17,
            maxHp: 45,
            replaceSkills: false,
            skills: [],
            status: 'inferred',
            incomplete: true,
            duration: { rounds: 3, permanent: false },
        };
        sendStateRequest.mockReset();
        sendStateRequest.mockResolvedValueOnce(JSON.stringify({
            effects: [{
                type: 'transform',
                targetId: 'pc-1',
                name: 'Dragon Form',
                maxHp: 45,
                ac: 17,
                skills: [{ name: 'Dragon Breath', kind: 'attack', damage: '4d6', range: 6, maxUses: 2 }],
                rounds: 3,
            }],
        }));
        const prepared = prepareSpecialAction(state, {
            type: 'skill', unitId: 'pc-1', skillId: 'dragon-form', targetId: 'pc-1',
        }, { actorSide: 'player' });
        const resolved = await resolveSpecialSource(state, prepared, {
            kind: 'skill',
            name: 'Dragon Form',
            range: 0,
            target: 'self',
            maxUses: 2,
        }, settings);
        expect(resolved.ok).toBe(true);
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
        const form = settings.skillRegistry.forms['dragon-form'];
        expect(form.incomplete).toBe(false);
        expect(form.skills.map(skill => skill.name)).toEqual(['Dragon Breath']);
    });

    it('records parsed unit skills and class skeletons', () => {
        const settings = makeSettings();
        const state = makeState();
        const caster = getUnitById(state, 'pc-1');
        caster.classLabel = 'Wizard';
        caster.skills = [{ name: 'Magic Missile', kind: 'attack', damage: '3d4+3', range: 6, maxUses: 2, spell: true }];
        const changed = registerSkillsFromUnits(settings, { playerUnits: [caster], enemies: [] });
        expect(changed).toBeGreaterThan(0);
        expect(findSkillRegistryEntry(settings, 'Magic Missile')).toMatchObject({ type: 'spell' });
        expect(settings.skillRegistry.classes.wizard.skillIds).toContain('Magic Missile');
    });
});

describe('canonicalization', () => {
    it('turns concrete resolver targets into role selectors and stable terrain offsets', () => {        const result = canonicalizeSpecialEffects([
            { type: 'damage', targetId: 'enemy-1', amount: '2d6' },
            { type: 'damage', targetId: 'enemy-2', amount: '2d6' },
            { type: 'heal', targetId: 'pc-1', amount: '1d6' },
            { type: 'terrain', terrain: 'water', cells: [{ x: 4, y: 4 }, { x: 5, y: 4 }] },
        ], {
            casterId: 'pc-1',
            primaryTargetId: 'enemy-2',
            targetIds: ['enemy-1', 'enemy-2', 'pc-1'],
            hostileIds: ['enemy-1', 'enemy-2'],
            friendlyIds: ['pc-1'],
            anchor: { x: 5, y: 4 },
            isArea: true,
        });
        expect(result.effects).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'damage', target: '$areaHostile', amount: '2d6' }),
            expect.objectContaining({ type: 'heal', target: '$areaFriendly', amount: '1d6' }),
            expect.objectContaining({ type: 'terrain', cellOffsets: [{ dx: -1, dy: 0 }, { dx: 0, dy: 0 }] }),
        ]));
    });
});
