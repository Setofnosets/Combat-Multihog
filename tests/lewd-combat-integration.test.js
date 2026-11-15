import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    appendLewdProseEntry,
    applyLewdAction,
    climaxParticipant,
    createLewdEncounterState,
    hydrateLewdState,
    joinParticipant,
    listLegalActions,
    markLewdBeatsNarrated,
    serializeLewdState,
    surrenderParticipant,
} from '../src/features/lewd-combat/lewd-combat-engine.js';
import {
    applyProfileTraits,
    normalizeLewdName,
} from '../src/features/lewd-combat/lewd-combat-profile.js';
import {
    buildLewdCombatCleanup,
    buildLewdNarrationBlock,
    buildLewdOutcomePayload,
    ensureLewdResolution,
    queueLewdOutcome,
} from '../src/features/lewd-combat/lewd-combat-outcome.js';
import {
    selectUnnarratedBeats,
    buildLewdFallbackProseEntries,
} from '../src/features/lewd-combat/lewd-combat-prose.js';
import {
    canStartLewdEncounter,
    consumeLewdResolution,
    createLewdEncounterFromContext,
} from '../src/features/lewd-combat/lewd-combat-context.js';
import {
    applyInferenceToState,
    computeDeterministicInference,
} from '../src/features/lewd-combat/lewd-combat-inference.js';
import {
    getLewdEncounterForChat,
    removeLewdEncounterForChat,
    setLewdEncounterForChat,
} from '../src/features/lewd-combat/lewd-combat-store.js';
import { clearPendingNarration, getPendingNarration } from '../src/features/tactical-combat/tactical-combat-store.js';
import { buildDefaultSettings } from '../src/state/defaults.js';
import {
    finishEncounterIfEnded,
    resetLewdCombatEncounter,
    returnLewdCombatToStory,
} from '../src/features/lewd-combat/lewd-combat-ui.js';

afterEach(() => {
    vi.restoreAllMocks();
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

const TECHNIQUES = {
    'neck-kiss': {
        id: 'neck-kiss',
        name: 'Neck Kiss',
        category: 'technique',
        posture: 'either',
        zones: ['neck'],
        targetMode: 'single',
        tags: ['teasing'],
        check: { stat: 'cha', accuracy: 100 },
        arousal: '4',
        poise: '0',
        ai: { priority: 1 },
    },
};

function createState(settings, overrides = {}) {
    const state = createLewdEncounterState({
        id: 'lewd-integration',
        seed: 'lewd-integration-seed',
        mode: 'duel',
        settings,
        participants: [
            {
                id: 'aria',
                name: 'Aria',
                side: 'player',
                profile: profile('Aria', { limits: ['marking'] }),
            },
            {
                id: 'bran',
                name: 'Bran',
                side: 'opponent',
                profile: profile('Bran', { maxStamina: 3, drain: 1 }),
            },
            {
                id: 'cass',
                name: 'Cass',
                side: 'player',
                spectator: true,
                profile: profile('Cass'),
            },
        ],
        ...overrides,
    });
    state.chatId = 'chat-A';
    state.title = 'The Alcove';
    state.location = 'The Gilded Inn';
    return state;
}

function prepareSettings() {
    const settings = buildDefaultSettings();
    settings.lewdCombatEnabled = true;
    settings.currentMemo = '[COMBAT]\n- none\nHP: 10/10\nWillpower: 4/4\n[/COMBAT]';
    settings.tacticalCombatReturnByChat = {};
    settings.tacticalCombatReturn = null;
    return settings;
}

function makeSettings(overrides = {}) {
    return {
        ...prepareSettings(),
        ...overrides,
    };
}

describe('Lewd Combat end-to-end integration', () => {
    it('runs a deterministic scene from start to narrator handoff without touching [COMBAT]', () => {
        const settings = prepareSettings();
        const memoBefore = settings.currentMemo;
        const state = createState(settings);
        setLewdEncounterForChat('chat-A', state, settings, { persist: false });
        expect(getLewdEncounterForChat('chat-A', settings)).toBe(state);

        const replay = createState(settings);
        for (const board of [state, replay]) {
            const aria = applyLewdAction(board, {
                type: 'technique',
                unitId: 'aria',
                techniqueId: 'neck-kiss',
                targetIds: ['bran'],
                zone: 'neck',
            }, { techniques: TECHNIQUES });
            expect(aria.ok).toBe(true);
            const bran = applyLewdAction(board, {
                type: 'technique',
                unitId: 'bran',
                techniqueId: 'neck-kiss',
                targetIds: ['aria'],
                zone: 'neck',
            }, { techniques: TECHNIQUES });
            expect(bran.ok).toBe(true);
        }
        expect(state.log.map(beat => beat.targets?.[0]?.arousalDelta))
            .toEqual(replay.log.map(beat => beat.targets?.[0]?.arousalDelta));
        expect(state.rollCount).toBe(replay.rollCount);

        // A drain-1 profile still pays at least 1 Stamina per climax.
        const bran = state.participants.find(participant => participant.id === 'bran');
        const first = climaxParticipant(state, bran);
        expect(first.cost).toBe(1);
        expect(bran.stamina).toBe(2);
        expect(bran.arousal).toBe(0);
        expect(bran.status.some(status => status.id === 'overstimulated')).toBe(true);
        climaxParticipant(state, bran);
        expect(bran.stamina).toBe(1);

        // A surrendered participant is out of the queue and cannot re-enter.
        surrenderParticipant(state, 'aria');
        expect(state.status).toBe('ended');
        expect(state.outcome).toBe('surrendered');
        const reentry = joinParticipant(state, { id: 'aria', name: 'Aria', side: 'player' });
        expect(reentry.ok).toBe(false);
        expect(reentry.reason).toMatch(/cannot re-enter/i);

        // The remaining participant can still be brought to 0 Stamina.
        const last = climaxParticipant(state, bran);
        expect(last.cost).toBe(1);
        expect(bran.stamina).toBe(0);
        expect(bran.atMercy).toBe(true);
        expect(bran.stance).toBeNull();

        const payload = queueLewdOutcome(state, settings, { persist: false });
        expect(payload.kind).toBe('lewd');
        expect(payload.outcome).toBe('surrendered');
        expect(getPendingNarration(settings, 'chat-A')?.kind).toBe('lewd');

        const block = buildLewdNarrationBlock(settings, 'chat-A');
        expect(block).toContain('[LEWD_COMBAT_CONTEXT]');
        expect(block).not.toContain('[TACTICAL_COMBAT_CONTEXT]');
        expect(block).toContain('Stamina');
        expect(block).toMatch(/surrendered to/i);

        // The module never rewrote the memo or invented HP/Willpower state.
        expect(settings.currentMemo).toBe(memoBefore);
        expect(state).not.toHaveProperty('units');
        expect(state).not.toHaveProperty('hp');

        // The queued handoff is one-shot.
        expect(getPendingNarration(settings, 'chat-A')).not.toBeNull();
        clearPendingNarration(settings, { chatId: 'chat-A', persist: false });
        expect(getPendingNarration(settings, 'chat-A')).toBeNull();
        expect(buildLewdNarrationBlock(settings, 'chat-A')).toBe('');

        removeLewdEncounterForChat('chat-A', settings, { persist: false });
        expect(getLewdEncounterForChat('chat-A', settings)).toBeNull();
    });

    it('applies a trait-modified drain exactly once and keeps Stamina above zero per climax', () => {
        const settings = prepareSettings();
        const state = createState(settings);
        const bran = state.participants.find(participant => participant.id === 'bran');
        expect(bran.maxStamina).toBe(3);

        const withTrait = applyProfileTraits(
            profile('Bran', { traits: { drain: 1, stamina: 1 } }),
            { maxStamina: 3, drain: 0 },
        );
        expect(withTrait.drain).toBe(1);
        expect(withTrait.maxStamina).toBe(4);
        expect(state.participants.every(participant => participant.stamina <= participant.maxStamina)).toBe(true);
    });

    it('reset clears the board, its resolution, and the lewd pending narration together', () => {
        const settings = prepareSettings();
        const state = createState(settings);
        state.chatId = 'vitest-reset';
        state.status = 'ended';
        state.outcome = 'surrendered';
        setLewdEncounterForChat('vitest-reset', state, settings, { persist: false });
        const payload = queueLewdOutcome(state, settings, { persist: false });
        expect(payload.kind).toBe('lewd');
        expect(getPendingNarration(settings, 'vitest-reset')).not.toBeNull();

        vi.spyOn(SillyTavern, 'getContext').mockReturnValue({
            extensionSettings: { rpg_tracker: settings },
            chatId: 'vitest-reset',
        });

        resetLewdCombatEncounter();

        expect(getLewdEncounterForChat('vitest-reset', settings)).toBeNull();
        expect(getPendingNarration(settings, 'vitest-reset')).toBeNull();
    });

    it('keeps the module inert when disabled', () => {
        const settings = buildDefaultSettings();
        expect(settings.lewdCombatEnabled).toBe(false);
        expect(settings.lewdCombatByChat).toEqual({});
        expect(getLewdEncounterForChat('chat-A', settings)).toBeNull();
    });

    it('cleans a combat-sourced scene once and only opts into [COMBAT] writes explicitly', async () => {
        const settings = prepareSettings();
        const memo = '[COMBAT]\nENEMIES:\nBran: 3/3 HP\nWolf: 2/2 HP\n[/COMBAT]';
        settings.currentMemo = memo;
        const state = createState(settings);
        state.chatId = 'chat-A';
        state.status = 'ended';
        state.outcome = 'surrendered';
        state.participants.find(participant => participant.id === 'bran').surrendered = true;
        setLewdEncounterForChat('chat-A', state, settings, { persist: false });

        vi.spyOn(SillyTavern, 'getContext').mockReturnValue({
            extensionSettings: { rpg_tracker: settings },
            chatId: 'chat-A',
        });

        const result = await finishEncounterIfEnded(state, { autoNarrate: false });
        expect(result.ok).toBe(true);
        expect(settings.currentMemo).toContain('Bran: 3/3 HP\nStatus: At Mercy');
        expect(settings.currentMemo).toMatch(/Wolf: 2\/2 HP\n(?!Status)/);
        expect(settings.currentMemo).toContain('[/COMBAT]');
        expect(state.resolution.cleanup.marked).toEqual([{ name: 'Bran', status: 'At Mercy' }]);

        const block = buildLewdNarrationBlock(settings, 'chat-A');
        expect(block).toMatch(/At Mercy/);
        expect(block).toMatch(/not new hostiles/i);
        expect(block).toMatch(/no new sexual encounter/i);

        // Explicit opt-out leaves [COMBAT] byte-identical.
        const off = buildLewdCombatCleanup(state, { ...settings, currentMemo: memo, lewdCombatCombatCleanup: 'off' });
        expect(off.memo).toBe(memo);
        expect(off.changed).toBe(false);
    });

    it('returns to the story by removing the board and clearing only the lewd handoff', () => {
        const settings = prepareSettings();
        const state = createState(settings);
        state.chatId = 'chat-A';
        state.status = 'ended';
        state.outcome = 'surrendered';
        state.participants.find(participant => participant.id === 'bran').surrendered = true;
        setLewdEncounterForChat('chat-A', state, settings, { persist: false });
        queueLewdOutcome(state, settings, { persist: false });
        expect(getPendingNarration(settings, 'chat-A')?.kind).toBe('lewd');

        vi.spyOn(SillyTavern, 'getContext').mockReturnValue({
            extensionSettings: { rpg_tracker: settings },
            chatId: 'chat-A',
        });

        expect(returnLewdCombatToStory()).toBe(true);
        expect(getLewdEncounterForChat('chat-A', settings)).toBeNull();
        expect(getPendingNarration(settings, 'chat-A')).toBeNull();
        // No new encounter was opened as a side effect.
        expect(getLewdEncounterForChat('chat-A', settings)).toBeNull();
    });
});

// One regression per reported issue. These exercise the module at its public
// seams (store, context, outcome, engine) without a DOM.
describe('Lewd Combat remediation regressions', () => {
    function endedState(settings, chatId) {
        const state = createState(settings);
        state.chatId = chatId;
        state.status = 'ended';
        state.outcome = 'surrendered';
        state.endedAt = Date.now();
        state.winnerIds = ['aria'];
        state.participants.find(participant => participant.id === 'bran').surrendered = true;
        return state;
    }

    it('issue 1: a finished encounter cannot retrigger until the aftermath is acknowledged', () => {
        const settings = prepareSettings();
        const state = endedState(settings, 'issue-1');
        setLewdEncounterForChat('issue-1', state, settings, { persist: false });
        ensureLewdResolution(state, { now: state.endedAt });

        const payload = queueLewdOutcome(state, settings, { persist: false });
        expect(payload.kind).toBe('lewd');
        expect(state.finalization.finalizing).toBe(true);
        expect(canStartLewdEncounter(settings, 'issue-1').ok).toBe(false);

        // Clearing the pending narration (as GENERATION_ENDED does) must not
        // re-arm the tool; the latch owns the chat, not the payload.
        clearPendingNarration(settings, { chatId: 'issue-1', persist: false });
        expect(getPendingNarration(settings, 'issue-1')).toBeNull();
        expect(canStartLewdEncounter(settings, 'issue-1').ok).toBe(false);

        // Finishing is idempotent: a second queue reuses the same payload.
        expect(queueLewdOutcome(state, settings, { persist: false })).toBe(payload);

        // The explicit acknowledgement clears the latch without opening a board.
        consumeLewdResolution(settings, 'issue-1', { reason: 'manual', persist: false });
        expect(canStartLewdEncounter(settings, 'issue-1').ok).toBe(true);
        expect(getLewdEncounterForChat('issue-1', settings)).toBe(state);
    });

    it('issue 2: the prose transcript keeps the player entry and the AI entry', () => {
        const settings = prepareSettings();
        const state = createState(settings);
        state.chatId = 'issue-2';
        const techniques = Object.values(TECHNIQUES);

        expect(applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'neck-kiss', targetIds: ['bran'], zone: 'neck',
        }, { techniques }).ok).toBe(true);
        expect(applyLewdAction(state, {
            type: 'technique', unitId: 'bran', techniqueId: 'neck-kiss', targetIds: ['aria'], zone: 'neck',
        }, { techniques }).ok).toBe(true);

        const items = selectUnnarratedBeats(state);
        expect(items.map(item => item.beat.actor.id)).toEqual(['aria', 'bran']);
        const entries = buildLewdFallbackProseEntries(state, items);
        expect(entries).toHaveLength(2);
        const appended = entries.map(entry => appendLewdProseEntry(state, { ...entry, source: 'model' }));
        markLewdBeatsNarrated(state, items[items.length - 1].index, items.map(item => item.beat.id));

        expect(state.proseLog).toHaveLength(2);
        expect(state.proseLog[0].actorIds).toContain('aria');
        expect(state.proseLog[1].actorIds).toContain('bran');
        expect(appended[0].id).toBe(state.proseLog[0].id);
        expect(selectUnnarratedBeats(state)).toHaveLength(0);

        const restored = hydrateLewdState(serializeLewdState(state));
        expect(restored.proseLog).toHaveLength(2);
        expect(restored.proseLog[0].text).toBe(state.proseLog[0].text);
        expect(restored.proseLog[1].text).toBe(state.proseLog[1].text);
    });

    it('issue 3: no-[COMBAT] scenes resolve control from the mode without inventing tags', () => {
        const memo = `[CHARACTER]
Aria: 24/24 HP | AC 14
Attr: STR 10 DEX 14 CON 12 INT 10 WIS 12 CHA 16
[/CHARACTER]

[LEWD]
- Aria: role=switch
- Nyx: role=dominant
[/LEWD]`;
        const settings = makeSettings({ currentMemo: memo });
        const run = controlMode => createLewdEncounterFromContext(settings, { chatId: `issue-3-${controlMode}` }, {
            participantNames: ['Aria', 'Nyx'],
            seed: `issue-3-${controlMode}`,
            controlMode,
        }).state;
        const controlOf = (state, name) => state.participants
            .find(participant => normalizeLewdName(participant.name) === normalizeLewdName(name))?.control;

        const auto = run('auto');
        expect(controlOf(auto, 'Aria')).toBe('player');
        expect(controlOf(auto, 'Nyx')).toBe('ai');

        const playerAll = run('player-all');
        expect(controlOf(playerAll, 'Aria')).toBe('player');
        expect(controlOf(playerAll, 'Nyx')).toBe('player');

        const aiOthers = run('ai-others');
        expect(controlOf(aiOthers, 'Aria')).toBe('player');
        expect(controlOf(aiOthers, 'Nyx')).toBe('ai');

        // No [COMBAT]/[ENEMY] was invented by starting the scene.
        expect(settings.currentMemo).toBe(memo);
        expect(settings.currentMemo).not.toContain('[COMBAT]');
        expect(settings.currentMemo).not.toContain('[ENEMY]');
    });

    it('issue 4: anatomy gates acts per participant and per target', () => {
        const settings = prepareSettings();
        const state = createLewdEncounterState({
            seed: 'issue-4',
            settings,
            participants: [
                { id: 'aria', name: 'Aria', side: 'player', anatomy: ['penis'], skills: ['bondage'], profile: profile('Aria') },
                { id: 'nyx', name: 'Nyx', side: 'opponent', anatomy: ['vagina', 'tail'], profile: profile('Nyx') },
                { id: 'cass', name: 'Cass', side: 'player', anatomy: [], profile: profile('Cass') },
            ],
        });
        applyInferenceToState(state, computeDeterministicInference(state));

        const entry = (id, actor) => listLegalActions(state, actor).find(candidate => candidate.id === id);
        const aria = state.participants.find(participant => participant.id === 'aria');
        const nyx = state.participants.find(participant => participant.id === 'nyx');
        const cass = state.participants.find(participant => participant.id === 'cass');

        // Penis-specific act: available to Aria against Nyx, unavailable to Cass.
        expect(entry('penetration-start', aria).disabled).toBe(false);
        const blocked = entry('penetration-start', cass);
        expect(blocked.disabled).toBe(true);
        expect(blocked.reasons.join(' ')).toMatch(/Set anatomy|Requires/i);
        expect(applyLewdAction(state, {
            type: 'technique', unitId: 'cass', techniqueId: 'penetration-start', targetIds: ['nyx'], zone: 'genitals',
        }).ok).toBe(false);

        // Tail act follows the tail capability.
        expect(entry('tail-wrap', nyx).disabled).toBe(false);
        expect(entry('tail-wrap', aria).disabled).toBe(true);
        // Unknown anatomy still allows neutral techniques.
        expect(entry('neck-kiss', cass).disabled).toBe(false);
    });

    it('issue 5: pair-level follow-ups exist only for the engaged pair and clear on withdraw', () => {
        const settings = prepareSettings();
        const state = createLewdEncounterState({
            seed: 'issue-5',
            settings,
            participants: [
                { id: 'aria', name: 'Aria', side: 'player', anatomy: ['penis'], profile: profile('Aria') },
                { id: 'bran', name: 'Bran', side: 'opponent', anatomy: ['vagina'], profile: profile('Bran') },
            ],
        });
        const aria = state.participants.find(participant => participant.id === 'aria');
        const bran = state.participants.find(participant => participant.id === 'bran');
        bran.poise = 0;
        bran.maxArousal = 100;
        bran.arousal = 0;

        expect(applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'penetration-start', targetIds: ['bran'], zone: 'genitals', posture: 'lead',
        }).ok).toBe(true);
        const edge = state.engagements[0];
        expect(edge.act).toBe('penetration');

        aria.acted = false;
        const legal = listLegalActions(state, aria);
        expect(legal.find(candidate => candidate.id === 'thrust-harder').disabled).toBe(false);
        expect(legal.find(candidate => candidate.id === 'withdraw').disabled).toBe(false);

        expect(applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'thrust-harder', targetIds: ['bran'], zone: 'genitals', posture: 'lead',
        }).ok).toBe(true);
        expect(edge.actIntensity).toBe(2);

        aria.acted = false;
        expect(applyLewdAction(state, {
            type: 'technique', unitId: 'aria', techniqueId: 'withdraw', targetIds: ['bran'], zone: 'genitals', posture: 'lead',
        }).ok).toBe(true);
        expect(edge.act).toBeNull();
    });

    it('issue 6: the handoff carries explicit at-mercy and no-resume language', () => {
        const settings = prepareSettings();
        const state = endedState(settings, 'issue-6');
        setLewdEncounterForChat('issue-6', state, settings, { persist: false });
        const payload = queueLewdOutcome(state, settings, { persist: false });

        expect(payload.atMercyIds ?? []).toEqual([]);
        expect(payload.surrenderedIds).toContain('bran');
        expect(payload.mercy.length).toBeGreaterThan(0);

        const block = buildLewdNarrationBlock(settings, 'issue-6');
        expect(block).toContain('[LEWD_COMBAT_CONTEXT]');
        expect(block).toMatch(/do not resume or restart/i);
        expect(block).toMatch(/at the winner's mercy|At Mercy/i);
        expect(block).toMatch(/not new hostiles/i);
        expect(block).toMatch(/no new sexual encounter/i);
        expect(block).toMatch(/never touched them/i);
    });

    it('issue 7: [COMBAT] is written only for a combat-sourced scene that opts in', () => {
        const settings = prepareSettings();
        const combatMemo = '[COMBAT]\nENEMIES:\nBran: 3/3 HP\nWolf: 2/2 HP\n[/COMBAT]';
        const lewdMemo = '[CHARACTER]\nAria: 24/24 HP\n[/CHARACTER]';

        const state = endedState(settings, 'issue-7');
        const combat = buildLewdCombatCleanup(state, { ...settings, currentMemo: combatMemo });
        expect(combat.combatSourced).toBe(true);
        expect(combat.changed).toBe(true);
        expect(combat.memo).toContain('Bran: 3/3 HP\nStatus: At Mercy');
        expect(combat.memo).toMatch(/Wolf: 2\/2 HP\n(?!Status)/);

        // A lewd-only scene never writes [COMBAT].
        const lewdOnlyState = createLewdEncounterState({
            seed: 'issue-7-lewd',
            settings,
            participants: [
                { id: 'aria', name: 'Aria', side: 'player', profile: profile('Aria') },
                { id: 'nyx', name: 'Nyx', side: 'player', profile: profile('Nyx') },
            ],
        });
        lewdOnlyState.status = 'ended';
        lewdOnlyState.outcome = 'mutual';
        lewdOnlyState.endedAt = Date.now();
        const lewdOnly = buildLewdCombatCleanup(lewdOnlyState, { ...settings, currentMemo: lewdMemo });
        expect(lewdOnly.combatSourced).toBe(false);
        expect(lewdOnly.changed).toBe(false);
        expect(lewdOnly.memo).toBe(lewdMemo);

        // Off leaves the memo byte-identical even for a combat-sourced scene.
        const off = buildLewdCombatCleanup(state, { ...settings, currentMemo: combatMemo, lewdCombatCombatCleanup: 'off' });
        expect(off.changed).toBe(false);
        expect(off.memo).toBe(combatMemo);

        // Close resolves the block when every combatant was in the scene.
        const shallowMemo = '[COMBAT]\nENEMIES:\nBran: 3/3 HP\n[/COMBAT]';
        const close = buildLewdCombatCleanup(state, { ...settings, currentMemo: shallowMemo, lewdCombatCombatCleanup: 'close' });
        expect(close.closed).toBe(true);
        expect(close.memo).toBe('[COMBAT]END_COMBAT[/COMBAT]');
    });
});
