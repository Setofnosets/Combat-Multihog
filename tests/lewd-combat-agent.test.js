import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    applyLewdAction,
    createLewdEncounterState,
    listLegalActions,
    resolveLewdOpponentTurn,
} from '../src/features/lewd-combat/lewd-combat-engine.js';
import {
    validateLewdTechnique,
} from '../src/features/lewd-combat/lewd-combat-techniques.js';
import {
    DEFAULT_LEWD_AGENT_PROMPT,
} from '../src/features/lewd-combat/lewd-combat-prompts.js';
import {
    buildLewdAgentPayload,
    buildLewdAgentPrompts,
    lewdAgentConfigured,
    lewdAgentRequestSettings,
    normalizeLewdAgentAction,
    normalizeLewdAgentResponse,
    parseLewdAgentResponse,
    requestLewdOpponentAction,
} from '../src/features/lewd-combat/lewd-combat-agent.js';

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis._rpgGenerationBusy;
});

function profile(name, overrides = {}) {
    return {
        name,
        role: 'switch',
        orientation: '',
        stamina: 3,
        maxStamina: 3,
        maxArousal: 20,
        maxPoise: 8,
        sensitivity: {},
        preference: {},
        limits: [],
        endurance: 0,
        experience: 0,
        traits: {},
        drain: 0,
        notes: '',
        source: 'lewd',
        inferred: false,
        warnings: [],
        ...overrides,
    };
}

function makeState(overrides = {}) {
    return createLewdEncounterState({
        seed: 'agent-seed',
        participants: [
            { name: 'Aria', side: 'player', stats: { cha: 16, chaMod: 3 }, profile: profile('Aria', { limits: ['feet'] }) },
            {
                name: 'Bran',
                side: 'opponent',
                stats: { cha: 14, chaMod: 2 },
                profile: profile('Bran', { role: 'dominant', limits: ['neck'], source: 'inferred', inferred: true }),
            },
        ],
        ...overrides,
    });
}

function unit(state, name) {
    return state.participants.find(participant => participant.name === name);
}

function firstLegalProposal(legal) {
    const entry = legal.find(candidate => {
        if (candidate.disabled) return false;
        if (candidate.technique?.targetMode === 'self') return true;
        return candidate.targets.some(target => !target.disabled);
    });
    const target = entry.technique?.targetMode === 'self'
        ? null
        : entry.targets.find(candidate => !candidate.disabled);
    return {
        actions: [{
            type: 'technique',
            techniqueId: entry.id,
            ...(target ? { targetIds: [target.id] } : {}),
            ...(entry.zones.length ? { zone: entry.zones[0] } : {}),
            posture: entry.posture,
        }],
    };
}

describe('lewd-combat-agent', () => {
    it('builds a payload with only legal entries/targets, recent actions, profiles, and rules', () => {
        const state = makeState();
        const actor = unit(state, 'Bran');
        const aria = unit(state, 'Aria');
        state.actionLog.push({
            round: 1,
            unitId: aria.id,
            type: 'technique',
            techniqueId: 'neck-kiss',
            targetIds: [actor.id],
            zones: ['neck'],
            posture: 'switch',
            source: 'player',
        });

        const payload = buildLewdAgentPayload(state, actor);
        const legal = listLegalActions(state, actor);
        const disabledIds = legal.filter(entry => entry.disabled).map(entry => entry.id);

        expect(payload.actor.id).toBe(actor.id);
        expect(payload.legalActions.length).toBeGreaterThan(0);
        expect(disabledIds.length).toBeGreaterThan(0);
        expect(payload.legalActions.some(entry => disabledIds.includes(entry.id))).toBe(false);
        for (const entry of payload.legalActions) {
            const source = legal.find(candidate => candidate.id === entry.id);
            expect(entry.targets).toEqual(source.targets.filter(target => !target.disabled).map(target => target.name));
        }
        expect(payload.recentActions).toHaveLength(1);
        expect(payload.recentActions[0].techniqueId).toBe('neck-kiss');
        expect(payload.knownProfiles[aria.id].limits).toEqual(['feet']);
        expect(payload.knownProfiles[actor.id].limits).toBeUndefined();
        expect(payload.rules.constraints.join(' ')).toContain('Never invent numbers, targets, body zones, or outcomes.');
    });

    it('builds prompts with the payload and actor name', () => {
        const state = makeState();
        const actor = unit(state, 'Bran');
        const prompts = buildLewdAgentPrompts(state, actor, {});

        expect(prompts.system).toBe(DEFAULT_LEWD_AGENT_PROMPT);
        expect(prompts.user).toContain(JSON.stringify(prompts.payload));
        expect(prompts.user).toContain('Bran');
        expect(prompts.user).toContain('{"actions":[...]}');
    });

    it('accepts a valid technique and rejects unknown, disabled, target, zone, and posture errors', () => {
        const state = makeState();
        const actor = unit(state, 'Bran');
        const aria = unit(state, 'Aria');
        const legal = listLegalActions(state, actor);

        const valid = normalizeLewdAgentAction({
            type: 'technique',
            techniqueId: 'neck-kiss',
            targetIds: [aria.id],
            zone: 'neck',
            posture: 'switch',
            flavor: '  Come here.  ',
        }, legal, actor);
        expect(valid.ok).toBe(true);
        expect(valid.action).toMatchObject({
            type: 'technique',
            unitId: actor.id,
            techniqueId: 'neck-kiss',
            targetIds: [aria.id],
            zone: 'neck',
            posture: 'switch',
            flavor: 'Come here.',
        });

        // The payload exposes target names, so a compliant model may echo the
        // name; the validator must canonicalize it back to the participant id.
        const byName = normalizeLewdAgentAction({
            type: 'technique',
            techniqueId: 'neck-kiss',
            targetIds: ['Aria'],
            zone: 'neck',
        }, legal, actor);
        expect(byName.ok).toBe(true);
        expect(byName.action.targetIds).toEqual([aria.id]);

        const unknown = normalizeLewdAgentAction({ type: 'technique', techniqueId: 'nope' }, legal, actor);
        expect(unknown.ok).toBe(false);
        expect(unknown.error).toBeTruthy();

        const disabled = normalizeLewdAgentAction({ type: 'technique', techniqueId: 'finish-hold', targetIds: [aria.id] }, legal, actor);
        expect(disabled.ok).toBe(false);
        expect(disabled.error).toBeTruthy();

        const badTarget = normalizeLewdAgentAction({ type: 'technique', techniqueId: 'neck-kiss', targetIds: ['ghost'] }, legal, actor);
        expect(badTarget.ok).toBe(false);
        expect(badTarget.error).toBeTruthy();

        const badZone = normalizeLewdAgentAction({ type: 'technique', techniqueId: 'neck-kiss', targetIds: [aria.id], zone: 'groin' }, legal, actor);
        expect(badZone.ok).toBe(false);
        expect(badZone.error).toBeTruthy();

        const badPosture = normalizeLewdAgentAction({ type: 'technique', techniqueId: 'firm-grip', targetIds: [aria.id], posture: 'follow' }, legal, actor);
        expect(badPosture.ok).toBe(false);
        expect(badPosture.error).toBeTruthy();

        const join = normalizeLewdAgentAction({ type: 'join' }, legal, actor);
        expect(join.ok).toBe(false);
        expect(join.error).toBeTruthy();
    });

    it('parses prose before a fenced JSON object and surfaces novelTechnique', () => {
        const raw = 'I will choose carefully.\n```json\n{"actions":[{"type":"technique","techniqueId":"neck-kiss"}],"novelTechnique":{"name":"Silk Slide"}}\n```';
        const parsed = parseLewdAgentResponse(raw);

        expect(parsed.actions).toHaveLength(1);
        expect(parsed.novelTechnique).toEqual({ name: 'Silk Slide' });
        expect(parsed.error).toBe('');
        expect(normalizeLewdAgentResponse('not json', [], { id: 'x' }).ok).toBe(false);
    });

    it('returns a normalized action from a mocked response and never throws on illegal responses', async () => {
        const state = makeState();
        const actor = unit(state, 'Bran');
        const legal = listLegalActions(state, actor);
        const proposal = firstLegalProposal(legal);
        const send = vi.fn(async () => JSON.stringify(proposal));

        const result = await requestLewdOpponentAction(state, actor, {}, { sendStateRequest: send });
        expect(result.ok).toBe(true);
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0].unitId).toBe(actor.id);

        const illegalSend = vi.fn(async () => '{"actions":[{"type":"technique","techniqueId":"ghost"}]}');
        const illegal = await requestLewdOpponentAction(state, actor, {}, { sendStateRequest: illegalSend });
        expect(illegal.ok).toBe(false);
        expect(illegal.rejected.length).toBeGreaterThan(0);
        expect(illegal.error).toBeTruthy();
        expect(illegalSend).toHaveBeenCalledTimes(2);
    });

    it('resolves a valid AI action exactly like the same player action', () => {
        const playerState = makeState();
        const aiState = makeState();
        const aria = unit(playerState, 'Aria');
        const bran = unit(playerState, 'Bran');
        const action = {
            type: 'technique',
            unitId: bran.id,
            techniqueId: 'neck-kiss',
            targetIds: [aria.id],
            zone: 'neck',
            posture: 'switch',
        };

        const playerResult = applyLewdAction(playerState, { ...action, source: 'player' });
        const aiResult = resolveLewdOpponentTurn(aiState, [{ ...action, source: 'ai' }]);

        expect(playerResult.ok).toBe(true);
        expect(aiResult.ok).toBe(true);
        const playerTarget = playerResult.beat.targets[0];
        const aiTarget = aiResult.beat.targets[0];
        expect({
            natural: aiTarget.natural,
            check: aiTarget.check,
            accuracy: aiTarget.accuracy,
            defense: aiTarget.defense,
            hit: aiTarget.hit,
            arousalDelta: aiTarget.arousalDelta,
            poiseDelta: aiTarget.poiseDelta,
            staminaDelta: aiTarget.staminaDelta,
            climaxed: aiTarget.climaxed,
        }).toEqual({
            natural: playerTarget.natural,
            check: playerTarget.check,
            accuracy: playerTarget.accuracy,
            defense: playerTarget.defense,
            hit: playerTarget.hit,
            arousalDelta: playerTarget.arousalDelta,
            poiseDelta: playerTarget.poiseDelta,
            staminaDelta: playerTarget.staminaDelta,
            climaxed: playerTarget.climaxed,
        });
        expect(playerState.actionLog.at(-1).techniqueId).toBe(aiState.actionLog.at(-1).techniqueId);
    });

    it('falls back deterministically and records a rejected-ai-action entry', () => {
        const first = makeState();
        const second = makeState();
        const firstActor = unit(first, 'Bran');
        const secondActor = unit(second, 'Bran');

        const firstResult = resolveLewdOpponentTurn(first, [{ type: 'technique', techniqueId: 'ghost', unitId: firstActor.id }]);
        const secondResult = resolveLewdOpponentTurn(second, [{ type: 'technique', techniqueId: 'ghost', unitId: secondActor.id }]);

        expect(firstResult.ok).toBe(true);
        expect(secondResult.ok).toBe(true);
        expect(first.actionLog.some(entry => entry.type === 'rejected-ai-action')).toBe(true);
        expect(first.log.at(-1).targets[0]).toMatchObject({
            check: second.log.at(-1).targets[0].check,
            defense: second.log.at(-1).targets[0].defense,
            hit: second.log.at(-1).targets[0].hit,
            arousalDelta: second.log.at(-1).targets[0].arousalDelta,
        });
    });

    it('compiles a novel technique exactly once and reuses it from state.techniques', async () => {
        const state = makeState();
        const actor = unit(state, 'Bran');
        const aria = unit(state, 'Aria');
        const novel = validateLewdTechnique({
            id: 'silk-slide',
            name: 'Silk Slide',
            category: 'technique',
            posture: 'either',
            zones: ['neck'],
            targetMode: 'single',
            tags: ['teasing'],
            check: { stat: 'cha', accuracy: 2 },
            arousal: '1d4',
            poise: '1d4',
        }).technique;
        const resolveNovelTechnique = vi.fn(async () => ({ ok: true, technique: novel }));
        const send = vi.fn(async () => JSON.stringify({
            actions: [{ type: 'technique', techniqueId: novel.id, targetIds: [aria.id], zone: 'neck', posture: 'switch' }],
            novelTechnique: { name: novel.name, description: 'A slow slide.' },
        }));

        const first = await requestLewdOpponentAction(state, actor, {}, { sendStateRequest: send, resolveNovelTechnique });
        const second = await requestLewdOpponentAction(state, actor, {}, { sendStateRequest: send, resolveNovelTechnique });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(resolveNovelTechnique).toHaveBeenCalledTimes(1);
        expect(state.techniques.filter(entry => entry.id === novel.id)).toHaveLength(1);
    });

    it('only reports the lewd agent as configured when its own keys are set', () => {
        expect(lewdAgentConfigured({})).toBe(false);
        expect(lewdAgentConfigured({
            tacticalCombatConnectionSource: 'ollama',
            tacticalCombatOllamaModel: 'tactical-model',
            tacticalCombatOpenaiModel: 'tactical-openai',
        })).toBe(false);
        expect(lewdAgentConfigured({ lewdCombatConnectionSource: 'profile' })).toBe(true);
        expect(lewdAgentConfigured({ lewdCombatOllamaModel: 'lewd-model' })).toBe(true);

        const request = lewdAgentRequestSettings({
            tacticalCombatConnectionSource: 'tactical',
            tacticalCombatOllamaModel: 'tactical-model',
            lewdCombatAgentMaxTokens: 100,
        });
        expect(request.connectionSource).toBe('tactical');
        expect(request.ollamaModel).toBe('tactical-model');
        expect(request.maxTokens).toBe(600);
    });
});
