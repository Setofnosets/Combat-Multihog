import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    applyLewdAction,
    createLewdEncounterState,
} from '../src/features/lewd-combat/lewd-combat-engine.js';
import {
    buildLewdCombatMarkup,
    describeLewdBeat,
} from '../src/features/lewd-combat/lewd-combat-markup.js';
import {
    buildLewdBeatSheet,
    buildLewdProsePrompt,
    generateLewdProse,
    isNarratorBusy,
    lewdProseRequestSettings,
    parseLewdProseResponse,
    shouldGenerateLewdProse,
} from '../src/features/lewd-combat/lewd-combat-prose.js';

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis._rpgGenerationBusy;
    delete globalThis._rpgStateModelRunning;
    delete globalThis.SillyTavern;
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

const TECHNIQUE = {
    id: 'test-touch',
    name: 'Test Touch',
    category: 'technique',
    posture: 'either',
    zones: ['waist'],
    targetMode: 'single',
    tags: [],
    check: { stat: 'cha', accuracy: 100 },
    arousal: '2',
    poise: '1',
    staminaDrain: 0,
    requires: { hold: null, stance: null, overwhelmed: false },
    applies: {},
    hold: null,
    uses: { max: null },
};

function makeFight(settings = {}) {
    return createLewdEncounterState({
        seed: 'prose-seed',
        techniques: [TECHNIQUE],
        settings,
        participants: [
            {
                name: 'Aria',
                side: 'player',
                stats: { cha: 16, chaMod: 3 },
                profile: profile('Aria', { limits: ['feet'], notes: 'Warm, teasing voice.' }),
            },
            {
                name: 'Bran',
                side: 'opponent',
                stats: { cha: 12, chaMod: 1 },
                profile: profile('Bran', { role: 'dominant', limits: ['hands'] }),
            },
        ],
    });
}

function resolveOne(state) {
    const aria = state.participants.find(participant => participant.name === 'Aria');
    const bran = state.participants.find(participant => participant.name === 'Bran');
    const result = applyLewdAction(state, {
        type: 'technique',
        unitId: aria.id,
        techniqueId: TECHNIQUE.id,
        targetIds: [bran.id],
        zone: 'waist',
        posture: 'switch',
    });
    return { result, aria, bran };
}

describe('lewd-combat-prose', () => {
    it('maps a real engine beat to a beat sheet without mutating state', () => {
        const state = makeFight();
        const { result } = resolveOne(state);
        expect(result.ok).toBe(true);
        const before = JSON.stringify(state);

        const sheet = buildLewdBeatSheet(state, result.beat);

        expect(JSON.stringify(state)).toBe(before);
        expect(sheet.actor).toBe('Aria');
        expect(sheet.posture).toBe('switch');
        expect(sheet.technique).toBe('Test Touch');
        expect(sheet.targets[0]).toMatchObject({
            name: 'Bran',
            zone: 'waist',
            check: result.beat.targets[0].check,
            defense: result.beat.targets[0].defense,
            hit: result.beat.targets[0].hit,
            arousalDelta: result.beat.targets[0].arousalDelta,
            poiseDelta: result.beat.targets[0].poiseDelta,
            staminaDelta: result.beat.targets[0].staminaDelta,
        });
        expect(sheet.stateChanges.length).toBeGreaterThan(0);
        expect(sheet.limits).toEqual(expect.arrayContaining(['feet', 'hands']));
        expect(sheet.voices.Aria).toBe('Warm, teasing voice.');
        expect(sheet.voices.Bran).toBe('dominant');
    });

    it('honours all four frequency modes and skips wait beats', () => {
        const state = makeFight();
        const { result } = resolveOne(state);
        const beat = result.beat;
        const waitBeat = { type: 'wait', round: state.round, actor: { name: 'Bran' }, stateChanges: [] };

        expect(shouldGenerateLewdProse(state, beat, { lewdCombatProseFrequency: 'off' })).toBe(false);
        expect(shouldGenerateLewdProse(state, beat, { lewdCombatProseFrequency: 'per-exchange' })).toBe(true);
        expect(shouldGenerateLewdProse(state, waitBeat, { lewdCombatProseFrequency: 'per-exchange' })).toBe(false);
        expect(shouldGenerateLewdProse(state, waitBeat, { lewdCombatProseFrequency: 'per-exchange' }, { roundEnded: true })).toBe(false);
        expect(shouldGenerateLewdProse({ ...state, status: 'ended' }, waitBeat, { lewdCombatProseFrequency: 'per-exchange' })).toBe(true);

        expect(shouldGenerateLewdProse(state, beat, { lewdCombatProseFrequency: 'per-round' })).toBe(false);
        expect(shouldGenerateLewdProse(state, beat, { lewdCombatProseFrequency: 'per-round' }, { roundEnded: true })).toBe(true);
        expect(shouldGenerateLewdProse({ ...state, status: 'ended' }, beat, { lewdCombatProseFrequency: 'per-round' })).toBe(true);

        expect(shouldGenerateLewdProse(state, beat, { lewdCombatProseFrequency: 'climax-only' })).toBe(false);
        const climaxBeat = { ...beat, targets: [{ ...beat.targets[0], climaxed: true }] };
        expect(shouldGenerateLewdProse(state, climaxBeat, { lewdCombatProseFrequency: 'climax-only' })).toBe(true);
        expect(shouldGenerateLewdProse({ ...state, status: 'ended' }, beat, { lewdCombatProseFrequency: 'climax-only' })).toBe(true);

        expect(shouldGenerateLewdProse(null, beat, {})).toBe(false);
    });

    it('builds a prose prompt with the explicitness directive, darker flag, limits, and rule', () => {
        const state = makeFight({
            lewdCombatExplicitness: 'fade-to-black',
            lewdCombatDarkerThemes: true,
        });
        const { result } = resolveOne(state);
        const prompt = buildLewdProsePrompt(state, result.beat, {});

        expect(prompt.system).toContain('Lewd Combat scene narrator');
        expect(prompt.user).toContain('Explicitness: fade-to-black');
        expect(prompt.user).toContain('Darker themes: on');
        expect(prompt.user).toContain('feet');
        expect(prompt.user).toContain('hands');
        expect(prompt.user).toContain('Never change state or invent numbers, participants, or outcomes.');
        expect(prompt.sheet.tone).toBe('fade-to-black');
        expect(prompt.sheet.darkerThemes).toBe(true);
    });

    it('uses the Main connection and leaves state byte-identical', async () => {
        const state = makeFight();
        const { result } = resolveOne(state);
        const before = JSON.stringify(state);
        const send = vi.fn(async () => 'Aria leans close and breathes against his ear. Bran shivers, exactly as the numbers already decided.');

        const prose = await generateLewdProse(state, result.beat, {
            lewdCombatConnectionSource: 'openai',
            lewdCombatOllamaModel: 'lewd-agent-model',
            lewdCombatProseFrequency: 'per-exchange',
        }, { sendStateRequest: send });

        expect(prose.ok).toBe(true);
        expect(prose.prose).toContain('Aria leans close');
        expect(send).toHaveBeenCalledTimes(1);
        const requestSettings = send.mock.calls[0][0];
        expect(requestSettings.connectionSource).toBe('default');
        expect(requestSettings.ollamaModel).toBe('');
        expect(requestSettings.openaiModel).toBe('');
        expect(JSON.stringify(state)).toBe(before);
    });

    it('defers without calling the model while a narrator generation is busy', async () => {
        const state = makeFight();
        const { result } = resolveOne(state);
        const send = vi.fn(async () => 'Should not be called.');
        globalThis._rpgGenerationBusy = true;

        const prose = await generateLewdProse(state, result.beat, {}, { sendStateRequest: send });

        expect(prose.deferred).toBe(true);
        expect(prose.ok).toBe(false);
        expect(send).not.toHaveBeenCalled();
        expect(isNarratorBusy()).toBe(true);
    });

    it('returns the templated fallback when the request fails', async () => {
        const state = makeFight();
        const { result } = resolveOne(state);
        const send = vi.fn(async () => { throw new Error('connection down'); });

        const prose = await generateLewdProse(state, result.beat, {}, { sendStateRequest: send });
        expect(prose.ok).toBe(false);
        expect(prose.error).toContain('connection down');
        expect(prose.fallback).toBe(describeLewdBeat(result.beat, state));

        const empty = await generateLewdProse(state, result.beat, {}, { sendStateRequest: vi.fn(async () => '') });
        expect(empty.ok).toBe(false);
        expect(empty.fallback).toBe(describeLewdBeat(result.beat, state));
    });

    it('parses fenced text and unwraps JSON prose', () => {
        expect(parseLewdProseResponse('```\nAria leans close.\n```')).toBe('Aria leans close.');
        expect(parseLewdProseResponse('{"prose":"  Aria   leans close. "}')).toBe('Aria leans close.');
        expect(parseLewdProseResponse('"Aria leans close."')).toBe('Aria leans close.');
        expect(parseLewdProseResponse('   ')).toBe('');
        expect(parseLewdProseResponse('word '.repeat(400)).length).toBeLessThanOrEqual(1200);

        const settings = lewdProseRequestSettings({ lewdCombatProseMaxTokens: 10, debugMode: true });
        expect(settings.connectionSource).toBe('default');
        expect(settings.maxTokens).toBe(400);
        expect(settings.debugMode).toBe(true);
    });

    it('renders supplied prose in the Scene pane and falls back to the templated sentence', () => {
        const state = makeFight();
        const { result } = resolveOne(state);

        const withProse = buildLewdCombatMarkup(state, { prose: 'Aria leans close.' });
        expect(withProse).toContain('rt-lc-prose-text');
        expect(withProse).toContain('Aria leans close.');

        const templated = describeLewdBeat(result.beat, state);
        const withoutProse = buildLewdCombatMarkup(state, {});
        expect(withoutProse).toContain(templated);

        const stored = { ...state, prose: { text: 'Stored scene prose.', round: state.round } };
        expect(buildLewdCombatMarkup(stored, {})).toContain('Stored scene prose.');
    });
});
