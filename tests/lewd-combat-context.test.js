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
    resolveLewdControlMode,
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

// A scene with no `[COMBAT]`: `[COMBAT]` is the only hostile roster source, so
// the only hostile-ish name here is a `[LEWD]`-only NPC.
const MEMO_NO_COMBAT = `[CHARACTER]
Aria: 24/24 HP | AC 14
Attr: STR 10 DEX 14 CON 12 INT 10 WIS 12 CHA 16
[/CHARACTER]

[PARTY]
- Bran: 18/18 HP | AC 13
Attr: STR 10 DEX 12 CON 10 INT 10 WIS 14 CHA 10
[/PARTY]

[LEWD]
- Aria: role=switch | stamina=4/4 | limits=marking
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
        expect(goblin.control).toBe('ai');

        // A profile that is absent from [PARTY]/[COMBAT] is still a candidate.
        const nyx = candidate(context, 'Nyx');
        expect(nyx).toBeTruthy();
        expect(nyx.unit).toBeNull();
        expect(nyx.side).toBe('player');
        expect(nyx.sources).toContain('lewd');
        expect(nyx.profile.inferred).toBe(false);
        // A `[LEWD]`-only NPC is AI-controlled even though its side is player.
        expect(nyx.control).toBe('ai');

        // Party/character names stay player-controlled.
        expect(aria.control).toBe('player');
        expect(bran.control).toBe('player');
    });

    it('resolves control modes without [COMBAT] and never infers control from gender', () => {
        expect(resolveLewdControlMode('player-all')).toBe('player-all');
        expect(resolveLewdControlMode('ai-others')).toBe('ai-others');
        expect(resolveLewdControlMode('AUTO')).toBe('auto');
        expect(resolveLewdControlMode('nonsense')).toBe('auto');
        expect(resolveLewdControlMode()).toBe('auto');

        const settings = makeSettings({ currentMemo: MEMO_NO_COMBAT });
        const ctx = { chatId: 'no-combat-chat' };

        const auto = collectLewdContext(settings, ctx);
        expect(candidate(auto, 'Aria').control).toBe('player');
        expect(candidate(auto, 'Bran').control).toBe('player');
        expect(candidate(auto, 'Nyx').control).toBe('ai');

        const playerAll = collectLewdContext(settings, ctx, { controlMode: 'player-all' });
        expect(candidate(playerAll, 'Aria').control).toBe('player');
        expect(candidate(playerAll, 'Bran').control).toBe('player');
        expect(candidate(playerAll, 'Nyx').control).toBe('player');

        const aiOthers = collectLewdContext(settings, ctx, { controlMode: 'ai-others' });
        expect(candidate(aiOthers, 'Aria').control).toBe('player');
        expect(candidate(aiOthers, 'Bran').control).toBe('player');
        expect(candidate(aiOthers, 'Nyx').control).toBe('ai');

        // A `[COMBAT]` enemy is AI-controlled under auto; `player-all` puts every
        // participant, including that enemy, under the player's control.
        const combat = collectLewdContext(makeSettings(), ctx);
        expect(candidate(combat, 'Goblin').control).toBe('ai');
        const combatAll = collectLewdContext(makeSettings(), ctx, { controlMode: 'player-all' });
        expect(candidate(combatAll, 'Goblin').control).toBe('player');
    });

    it('keeps the player persona on the player side and treats unknown session names as AI', () => {
        const settings = makeSettings({ currentMemo: MEMO_NO_COMBAT });
        const context = collectLewdContext(settings, { chatId: 'session-chat', name1: 'Aria' });
        expect(candidate(context, 'Aria').control).toBe('player');

        const auto = buildLewdParticipantSeeds(context, {
            participantNames: ['Aria', 'Stranger'],
            settings,
        });
        const stranger = auto.find(seed => seed.name === 'Stranger');
        expect(stranger.control).toBe('ai');
        expect(stranger.ai).toBe(true);

        const aiOthers = buildLewdParticipantSeeds(context, {
            participantNames: ['Aria', 'Stranger'],
            settings,
            controlMode: 'ai-others',
        });
        expect(aiOthers.find(seed => seed.name === 'Stranger').control).toBe('ai');

        const playerAll = buildLewdParticipantSeeds(context, {
            participantNames: ['Aria', 'Stranger'],
            settings,
            controlMode: 'player-all',
        });
        expect(playerAll.find(seed => seed.name === 'Stranger').control).toBe('player');
        expect(playerAll.find(seed => seed.name === 'Stranger').ai).toBe(false);

        // A narrator-supplied explicit player list keeps a known name on the
        // player side even when the memo has no party sheet for it.
        const explicitPlayers = buildLewdParticipantSeeds(context, {
            participantNames: ['Aria', 'Stranger'],
            settings,
            playerNames: ['Stranger'],
        });
        expect(explicitPlayers.find(seed => seed.name === 'Stranger').control).toBe('player');
    });

    it('stores the control mode on the board and keeps a combat enemy AI-controlled', () => {
        const result = createLewdEncounterFromContext(
            makeSettings(),
            { chatId: 'mode-chat' },
            { participantNames: ['Aria', 'Nyx'], seed: 'mode-seed', controlMode: 'auto' },
        );
        expect(result.state.controlMode).toBe('auto');
        const aria = result.state.participants.find(participant => participant.name === 'Aria');
        const nyx = result.state.participants.find(participant => participant.name === 'Nyx');
        expect(aria.control).toBe('player');
        expect(aria.ai).toBe(false);
        expect(nyx.control).toBe('ai');
        expect(nyx.ai).toBe(true);

        const all = createLewdEncounterFromContext(
            makeSettings(),
            { chatId: 'mode-chat-2' },
            { participantNames: ['Aria', 'Nyx'], seed: 'mode-seed-2', controlMode: 'player-all' },
        );
        expect(all.state.controlMode).toBe('player-all');
        expect(all.state.participants.every(participant => participant.control === 'player')).toBe(true);

        // A settings-level default is honoured when no explicit mode is passed.
        const fromSettings = createLewdEncounterFromContext(
            makeSettings({ lewdCombatControlMode: 'ai-others' }),
            { chatId: 'mode-chat-3' },
            { participantNames: ['Aria', 'Nyx'], seed: 'mode-seed-3' },
        );
        expect(fromSettings.state.controlMode).toBe('ai-others');
    });

    it('lets only a player-controlled participant open a narrator-declared exchange', () => {
        // Under `auto` both Goblin ([COMBAT]) and Nyx ([LEWD]-only) are AI, so
        // there is no player-controlled actor to open the exchange.
        const auto = createLewdEncounterFromContext(
            makeSettings(),
            { chatId: 'opening-chat' },
            {
                participantNames: ['Goblin', 'Nyx'],
                seed: 'opening-seed',
                techniques: OPEN_TECHNIQUES,
            },
        );
        const blocked = applyLewdOpeningExchange(auto.state, { openingTechnique: 'sure-kiss' });
        expect(blocked.ok).toBe(false);
        expect(blocked.reason).toMatch(/no player participant/i);
        expect(auto.state.log).toHaveLength(0);

        // `player-all` puts everyone under player control, so the same opening
        // is legal and resolved by a player-controlled participant.
        const all = createLewdEncounterFromContext(
            makeSettings(),
            { chatId: 'opening-chat-2' },
            {
                participantNames: ['Goblin', 'Nyx'],
                seed: 'opening-seed-2',
                controlMode: 'player-all',
                techniques: OPEN_TECHNIQUES,
            },
        );
        const opened = applyLewdOpeningExchange(all.state, { openingTechnique: 'sure-kiss' });
        expect(opened.ok).toBe(true);
        const opener = all.state.participants.find(participant => participant.id === opened.beat?.actor?.id);
        expect(opener?.control).toBe('player');
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

    it('infers a card/tracker profile for a no-[LEWD] character and preserves explicit anatomy', () => {
        const inferMemo = `[CHARACTER]
Aria: 24/24 HP | AC 14
Attr: STR 10 DEX 14 CON 12 INT 10 WIS 12 CHA 16
[/CHARACTER]

[PARTY]
- Bran: 18/18 HP | AC 13
Attr: STR 10 DEX 12 CON 10 INT 10 WIS 14 CHA 10
- Nyx: 12/12 HP | AC 12
Species: kitsune
Body: Slim, silver-furred, with a long tail.
[/PARTY]`;
        const settings = makeSettings({ currentMemo: inferMemo });
        const ctx = {
            chatId: 'infer-chat',
            characters: [{ name: 'Nyx', description: 'A tall kitsune with a long tail.' }],
        };

        const inferred = candidate(collectLewdContext(settings, ctx), 'Nyx');
        expect(inferred.profile.inferred).toBe(true);
        expect(inferred.profile.anatomy).toContain('tail');
        expect(['card', 'tracker']).toContain(inferred.profile.provenance.anatomy.tail);

        const explicitMemo = `${inferMemo}

[LEWD]
- Nyx: anatomy=wings
[/LEWD]`;
        const explicit = candidate(
            collectLewdContext(makeSettings({ currentMemo: explicitMemo }), ctx),
            'Nyx',
        );
        expect(explicit.profile.inferred).toBe(false);
        expect(explicit.profile.anatomy).toEqual(expect.arrayContaining(['wings', 'tail']));
        expect(explicit.profile.provenance.anatomy.wings).toBe('lewd');
    });

    it('records profileInference and persists capability fields through hydrate', () => {
        const inferMemo = `[CHARACTER]
Aria: 24/24 HP | AC 14
Attr: STR 10 DEX 14 CON 12 INT 10 WIS 12 CHA 16
[/CHARACTER]

[PARTY]
- Bran: 18/18 HP | AC 13
- Nyx: 12/12 HP | AC 12
Species: kitsune
Body: Slim, silver-furred, with a long tail.
[/PARTY]`;
        const settings = makeSettings({ currentMemo: inferMemo });
        const ctx = {
            chatId: 'profile-inference-chat',
            characters: [{ name: 'Nyx', description: 'A tall kitsune with a long tail.' }],
        };
        const { state } = createLewdEncounterFromContext(settings, ctx, {
            participantNames: ['Aria', 'Nyx'],
            seed: 'profile-inference-seed',
        });

        expect(state.profileInference).toBeTruthy();
        expect(state.profileInference.completedAt).toBeGreaterThan(0);
        expect(state.profileInference.sources).toEqual(expect.arrayContaining(['card', 'tracker', 'unit']));

        const nyx = state.participants.find(participant => participant.name === 'Nyx');
        expect(nyx.anatomy).toContain('tail');
        expect(nyx.skills).toEqual(expect.any(Array));
        expect(nyx.kinks).toEqual(expect.any(Array));
        expect(nyx.sourceSkills).toEqual(expect.any(Array));
        expect(nyx.sourceTraits).toEqual(expect.any(Array));
        expect(typeof nyx.notes).toBe('string');

        const restored = hydrateLewdState(serializeLewdState(state));
        const restoredNyx = restored.participants.find(participant => participant.name === 'Nyx');
        expect(restoredNyx.anatomy).toEqual(nyx.anatomy);
        expect(restoredNyx.skills).toEqual(nyx.skills);
        expect(restoredNyx.kinks).toEqual(nyx.kinks);
        expect(restoredNyx.sourceSkills).toEqual(nyx.sourceSkills);
        expect(restoredNyx.sourceTraits).toEqual(nyx.sourceTraits);
    });

    it('drops unknown anatomy tokens without throwing', () => {
        const memo = `[CHARACTER]
Aria: 24/24 HP
[/CHARACTER]

[PARTY]
- Nyx: 12/12 HP
Body: A strange flipper and a soul.
[/PARTY]`;
        const settings = makeSettings({ currentMemo: memo });
        expect(() => collectLewdContext(settings, { chatId: 'garbage-anatomy' })).not.toThrow();
        const nyx = candidate(collectLewdContext(settings, { chatId: 'garbage-anatomy' }), 'Nyx');
        expect(nyx.profile.anatomy).toEqual([]);
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
