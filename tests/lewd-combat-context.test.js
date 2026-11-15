import { describe, expect, it } from 'vitest';
import {
    applyLewdOpeningExchange,
    buildLewdParticipantSeeds,
    canStartLewdEncounter,
    collectLewdContext,
    consumeDeliveredLewdResolution,
    consumeLewdResolution,
    createLewdEncounterFromContext,
    isLewdStartLatched,
    markLewdResolutionDelivered,
    resolveLewdStartMode,
} from '../src/features/lewd-combat/lewd-combat-context.js';
import {
    hydrateLewdState,
    serializeLewdState,
} from '../src/features/lewd-combat/lewd-combat-engine.js';
import { normalizeLewdName } from '../src/features/lewd-combat/lewd-combat-profile.js';
import { setLewdEncounterForChat } from '../src/features/lewd-combat/lewd-combat-store.js';

const MEMO = `[CHARACTER]
Aria: 24/24 HP | AC 14
Attr: STR 10 DEX 14 CON 12 INT 10 WIS 12 CHA 16
[/CHARACTER]

[PARTY]
- Bran: 18/18 HP | AC 13
Attr: STR 10 DEX 12 CON 10 INT 10 WIS 14 CHA 10
[/PARTY]

[COMBAT]
Enemies:
- Goblin: 12/12 HP | AC 11 | Str 12
[/COMBAT]

[LEWD]
- Aria: role=switch | stamina=4/4 | sensitivity=neck:high | likes=praise | limits=marking
- Nyx: role=dominant | stamina=3/3 | limits=breath play
[/LEWD]`;

// Deterministic stand-in catalog: accuracy +100 guarantees the opening lands so
// the test can assert on the engagement edge without relying on a lucky roll.
const OPEN_TECHNIQUES = [
    {
        id: 'sure-kiss',
        name: 'Sure Kiss',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'single',
        tags: [],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '1d4',
        poise: '1d4',
        uses: { max: null },
        ai: { priority: 1, conditions: [] },
    },
];

function makeSettings(overrides = {}) {
    return {
        currentMemo: MEMO,
        lewdCombatEnabled: true,
        lewdCombatRoundCap: 8,
        lewdCombatMaxPartners: 2,
        lewdCombatExplicitness: 'suggestive',
        lewdCombatDarkerThemes: false,
        ...overrides,
    };
}

function candidate(context, name) {
    const key = normalizeLewdName(name);
    return context.candidates.find(entry => entry.normalizedName === key) || null;
}

describe('lewd-combat-context', () => {
    it('builds candidates from [LEWD] plus [PARTY]/[COMBAT] and dedupes names', () => {
        const context = collectLewdContext(makeSettings(), { chatId: 'lewd-chat' });

        expect(context.chatId).toBe('lewd-chat');
        expect(context.candidates.length).toBeGreaterThanOrEqual(4);

        const aria = candidate(context, 'Aria');
        expect(aria).toBeTruthy();
        expect(aria.unit).toBeTruthy();
        expect(aria.side).toBe('player');
        expect(aria.sources).toEqual(expect.arrayContaining(['lewd', 'party']));
        expect(aria.profile.inferred).toBe(false);
        expect(aria.profile.limits).toContain('marking');
        // The unit's stat sheet is attached for accuracy/stamina derivation.
        expect(aria.unit.stats.cha).toBe(16);

        // Duplicate names (profile + party sheet) collapse into one candidate.
        const ariaRows = context.candidates.filter(entry => entry.normalizedName === normalizeLewdName('Aria'));
        expect(ariaRows).toHaveLength(1);

        const bran = candidate(context, 'Bran');
        expect(bran).toBeTruthy();
        expect(bran.unit).toBeTruthy();
        expect(bran.sources).toContain('party');
        expect(bran.profile.inferred).toBe(true);

        const goblin = candidate(context, 'Goblin');
        expect(goblin).toBeTruthy();
        expect(goblin.side).toBe('enemy');
        expect(goblin.sources).toContain('combat');

        // A profile that is absent from [PARTY]/[COMBAT] is still a candidate.
        const nyx = candidate(context, 'Nyx');
        expect(nyx).toBeTruthy();
        expect(nyx.unit).toBeNull();
        expect(nyx.side).toBe('player');
        expect(nyx.sources).toContain('lewd');
        expect(nyx.profile.inferred).toBe(false);
    });

    it('starts with two named participants and puts a spectator off the acting roster', () => {
        const result = createLewdEncounterFromContext(
            makeSettings(),
            { chatId: 'lewd-chat' },
            {
                participantNames: ['aria', 'BRAN'],
                spectatorNames: ['Nyx'],
                mode: 'group',
                seed: 'seed-42',
            },
        );

        const { state } = result;
        expect(state.participants).toHaveLength(3);
        expect(state.participants.filter(participant => !participant.spectator)).toHaveLength(2);

        const nyx = state.participants.find(participant => participant.name === 'Nyx');
        expect(nyx.spectator).toBe(true);
        expect(state.participants[state.participants.length - 1].spectator).toBe(true);

        const aria = state.participants.find(participant => participant.name === 'Aria');
        expect(aria.profile.inferred).toBe(false);
        expect(aria.profile.maxStamina).toBeGreaterThan(0);

        const bran = state.participants.find(participant => participant.name === 'Bran');
        expect(bran.profile.inferred).toBe(true);
        expect(bran.stats.dex).toBe(12);

        expect(state.seed).toBe('seed-42');
        expect(state.mode).toBe('group');
    });

    it('rejects a start with fewer than two active participants', () => {
        const context = collectLewdContext(makeSettings(), { chatId: 'lewd-chat' });
        expect(() => buildLewdParticipantSeeds(context, {
            participantNames: ['Aria'],
            settings: makeSettings(),
        })).toThrow(/at least two active participants/i);

        expect(() => buildLewdParticipantSeeds(context, {
            participantNames: [],
            settings: makeSettings(),
        })).toThrow(/at least two active participants/i);

        expect(() => createLewdEncounterFromContext(
            makeSettings(),
            { chatId: 'lewd-chat' },
            { participantNames: ['Aria'] },
        )).toThrow(/at least two active participants/i);
    });

    it('blocks an active board, allows a finished board, and requires the module and a chat', () => {
        const chatId = 'can-start-chat';
        const settings = makeSettings({ lewdCombatByChat: {} });

        expect(canStartLewdEncounter(settings, chatId).ok).toBe(true);

        setLewdEncounterForChat(chatId, { status: 'active', participants: [] }, settings, { persist: false });
        const blocked = canStartLewdEncounter(settings, chatId);
        expect(blocked.ok).toBe(false);
        expect(blocked.reason).toMatch(/already active/i);

        setLewdEncounterForChat(chatId, { status: 'ended', participants: [] }, settings, { persist: false });
        expect(canStartLewdEncounter(settings, chatId).ok).toBe(true);

        expect(canStartLewdEncounter({ lewdCombatByChat: {} }, chatId).ok).toBe(false);
        expect(canStartLewdEncounter(settings, '').ok).toBe(false);

        expect(resolveLewdStartMode('free-for-all')).toBe('free-for-all');
        expect(resolveLewdStartMode('group')).toBe('group');
        expect(resolveLewdStartMode('nonsense')).toBe('duel');
        expect(resolveLewdStartMode()).toBe('duel');
    });

    it('latches an unconsumed resolution, honours the cooldown, and clears on manual consumption', () => {
        const chatId = 'latch-chat';
        const settings = makeSettings({
            lewdCombatByChat: {},
            lewdCombatPostEncounterCooldownMs: 60000,
        });
        const ended = {
            id: 'lewd-latch',
            status: 'ended',
            endedAt: Date.now(),
            outcome: 'atMercy',
            winnerIds: ['aria'],
            participants: [],
            resolution: {
                stateId: 'lewd-latch',
                endedAt: Date.now(),
                consumedAt: 0,
                consumedFor: '',
                deliveredAt: 0,
                outcome: 'atMercy',
                winnerIds: ['aria'],
                atMercyIds: ['bran'],
                surrenderedIds: [],
                source: 'lewd',
            },
        };
        setLewdEncounterForChat(chatId, ended, settings, { persist: false });

        const blocked = canStartLewdEncounter(settings, chatId);
        expect(blocked.ok).toBe(false);
        expect(blocked.reason).toMatch(/not been acknowledged/i);
        expect(isLewdStartLatched(settings, chatId).latched).toBe(true);

        // Manual consumption clears the latch and bypasses the cooldown.
        consumeLewdResolution(settings, chatId, { reason: 'manual', persist: false });
        expect(canStartLewdEncounter(settings, chatId).ok).toBe(true);

        // Automatic consumption still honours the safety cooldown.
        const auto = {
            ...ended,
            resolution: {
                ...ended.resolution,
                consumedAt: 0,
                consumedFor: '',
                deliveredAt: Date.now(),
            },
        };
        setLewdEncounterForChat(chatId, auto, settings, { persist: false });
        consumeDeliveredLewdResolution(settings, chatId, { persist: false });
        expect(auto.resolution.consumedFor).toBe('user-turn');
        expect(canStartLewdEncounter(settings, chatId).ok).toBe(false);

        const expired = {
            ...auto,
            endedAt: Date.now() - 61000,
            resolution: { ...auto.resolution, endedAt: Date.now() - 61000 },
        };
        setLewdEncounterForChat(chatId, expired, settings, { persist: false });
        expect(canStartLewdEncounter(settings, chatId).ok).toBe(true);

        // Only delivered resolutions are consumed by the user turn.
        const undelivered = {
            ...ended,
            resolution: { ...ended.resolution, deliveredAt: 0 },
        };
        setLewdEncounterForChat(chatId, undelivered, settings, { persist: false });
        expect(consumeDeliveredLewdResolution(settings, chatId, { persist: false })).toBeNull();
        expect(markLewdResolutionDelivered(settings, chatId, 'lewd-latch', { persist: false })).toBe(true);
        expect(undelivered.resolution.deliveredAt).toBeGreaterThan(0);
    });

    it('resolves a legal opening exchange and leaves state untouched on an illegal one', () => {
        const { state } = createLewdEncounterFromContext(
            makeSettings(),
            { chatId: 'lewd-chat' },
            { participantNames: ['Aria', 'Bran'], seed: 'open-seed', techniques: OPEN_TECHNIQUES },
        );

        const opened = applyLewdOpeningExchange(state, { openingTechnique: 'sure-kiss' });
        expect(opened.ok).toBe(true);
        expect(state.engagements.length).toBeGreaterThan(0);
        expect(state.log.some(beat => beat.type === 'technique')).toBe(true);

        const before = JSON.stringify(serializeLewdState(state));
        const illegal = applyLewdOpeningExchange(state, { openingTechnique: 'not-a-real-technique' });
        expect(illegal.ok).toBe(false);
        expect(illegal.reason).toMatch(/unknown/i);
        expect(JSON.stringify(serializeLewdState(state))).toBe(before);
    });

    it('round-trips participants, engagements, pools, seed, and roll count', () => {
        const { state } = createLewdEncounterFromContext(
            makeSettings(),
            { chatId: 'lewd-chat' },
            { participantNames: ['Aria', 'Bran'], seed: 'hydrate-seed', techniques: OPEN_TECHNIQUES },
        );
        applyLewdOpeningExchange(state, { openingTechnique: 'sure-kiss' });
        state.round = 3;

        const restored = hydrateLewdState(serializeLewdState(state));
        expect(restored.seed).toBe(state.seed);
        expect(restored.rollCount).toBe(state.rollCount);
        expect(restored.participants.map(participant => participant.id))
            .toEqual(state.participants.map(participant => participant.id));
        expect(restored.engagements).toHaveLength(state.engagements.length);

        for (const participant of state.participants) {
            const copy = restored.participants.find(entry => entry.id === participant.id);
            expect(copy.stamina).toBe(participant.stamina);
            expect(copy.arousal).toBe(participant.arousal);
            expect(copy.poise).toBe(participant.poise);
        }
    });
});
