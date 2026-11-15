import { describe, expect, it } from 'vitest';
import {
    buildLewdCombatMarkup,
    describeLewdBeat,
    describePostureTradeoff,
    staminaPips,
} from '../src/features/lewd-combat/lewd-combat-markup.js';
import {
    createLewdEncounterState,
    LEWD_POSTURES,
} from '../src/features/lewd-combat/lewd-combat-engine.js';
import * as ui from '../src/features/lewd-combat/lewd-combat-ui.js';
import { upsertEngagement } from '../src/features/lewd-combat/lewd-combat-pairing.js';

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

function makeState(participants, options = {}) {
    return createLewdEncounterState({
        seed: options.seed || 'markup-seed',
        participants,
        ...options,
    });
}

function participantId(state, name) {
    return state.participants.find(participant => participant.name === name)?.id || '';
}

describe('lewd-combat-markup', () => {
    it('renders a start screen with candidate checkboxes and no grid', () => {
        const html = buildLewdCombatMarkup(null, {
            startOpen: true,
            startCandidates: [
                { name: 'Aria', normalizedName: 'aria', side: 'player', sources: ['lewd'], profile: profile('Aria'), inferred: false },
                { name: 'Bran', normalizedName: 'bran', side: 'player', sources: ['party'], profile: profile('Bran', { inferred: true }), inferred: true },
            ],
            startSelected: ['Aria'],
            startMode: 'duel',
        });

        expect(html).toContain('data-lc-start-participant');
        expect(html).toContain('data-lc-start-spectator');
        expect(html).toContain('data-lc-start-mode');
        expect(html).toContain('data-lc-start-control-mode');
        expect(html).toContain('value="auto"');
        expect(html).toContain('value="player-all"');
        expect(html).toContain('value="ai-others"');
        expect(html).toContain('data-lc-action="start"');
        expect(html).toContain('value="Aria"');
        expect(html).not.toContain('data-tc-cell');
        expect(html).not.toContain('rt-tc-grid');
    });

    it('renders the rail, matrix, composer, log, prose, and debug sections', () => {
        const state = makeState([
            { name: 'Aria', side: 'player', stats: { cha: 16, chaMod: 3 }, profile: profile('Aria') },
            { name: 'Bran', side: 'player', stats: { dex: 12, dexMod: 1 }, profile: profile('Bran') },
            { name: 'Goblin', side: 'enemy', profile: profile('Goblin', { maxStamina: 2 }) },
        ]);
        const ariaId = participantId(state, 'Aria');
        const branId = participantId(state, 'Bran');
        const html = buildLewdCombatMarkup(state, { actorId: ariaId });

        expect(html).toContain('Lewd Combat');
        expect(html).toContain('rt-lc-rail');
        expect(html).toContain('rt-lc-card');
        expect(html).toContain(`data-lc-unit-id="${ariaId}"`);
        expect(html).toContain('S 3/3');
        expect(html).toContain('rt-lc-pips');
        expect(html).toContain('rt-lc-arousal');
        expect(html).toContain('rt-lc-poise');
        expect(html).toContain('rt-lc-matrix');
        expect(html).toContain('data-lc-pair-a');
        expect(html).toContain(`data-lc-pair-b="${branId}"`);
        expect(html).toContain('rt-lc-composer');
        expect(html).toContain('data-lc-technique');
        expect(html).toContain('data-lc-target');
        expect(html).toContain('rt-lc-log');
        expect(html).toContain('rt-lc-prose');
        expect(html).toContain('rt-lc-debug');
        expect(html).toContain('data-lc-action="resolve"');

        expect(staminaPips(3, 3)).toBe('●●●');
        expect(staminaPips(1, 3)).toBe('●○○');
        expect(describeLewdBeat(null)).toMatch(/no exchange yet/i);
    });

    it('renders pair act state in the matrix and composer with follow-up groups', () => {
        const state = makeState([
            { name: 'Aria', side: 'player', stats: { cha: 16, chaMod: 3 }, profile: profile('Aria') },
            { name: 'Bran', side: 'player', profile: profile('Bran') },
        ]);
        const ariaId = participantId(state, 'Aria');
        const branId = participantId(state, 'Bran');
        upsertEngagement(state, ariaId, branId, {
            act: { id: 'penetration', type: 'penetration', role: 'give' },
            actIntensity: 2,
            actStartedRound: 1,
            bindings: 1,
            bindingsStartedRound: 1,
            pairStance: { id: 'entwined', label: 'Entwined', roundsLeft: 3 },
        });

        const html = buildLewdCombatMarkup(state, { actorId: ariaId });

        // Matrix cell carries the act ladder, restraint, and pair stance.
        expect(html).toContain('rt-lc-matrix');
        expect(html).toContain('penetration 2');
        expect(html).toContain('bindings 1');
        expect(html.toLowerCase()).toContain('entwined');

        // Composer pair header above the technique buttons.
        expect(html).toContain('rt-lc-pair-state');
        expect(html).toContain('Pair: Aria');
        expect(html).toContain('act: penetration');
        expect(html).toContain('intensity 2');
        expect(html).toContain('stance: Entwined');

        // Follow-up techniques are grouped under the act label.
        expect(html).toContain('Follow-ups · Penetration');
        expect(html).toContain('data-lc-technique="thrust-harder"');
    });

    it('renders a not-paired composer state when the actor is unengaged', () => {
        const state = makeState([
            { name: 'Aria', side: 'player', profile: profile('Aria') },
            { name: 'Bran', side: 'player', profile: profile('Bran') },
        ]);
        const html = buildLewdCombatMarkup(state, { actorId: participantId(state, 'Aria') });
        expect(html).toContain('rt-lc-pair-state');
        expect(html).toContain('Pair: not paired');
    });

    it('escapes script tags in participant names, titles, and prose', () => {
        const state = makeState([
            { name: '<script>alert(1)</script>', side: 'player', profile: profile('<script>alert(1)</script>') },
            { name: 'Bran', side: 'player', profile: profile('Bran') },
        ]);
        state.title = '<script>bad title</script>';
        const html = buildLewdCombatMarkup(state, { actorId: participantId(state, 'Bran') });

        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).not.toContain('<script>bad title</script>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).toContain('&lt;script&gt;bad title&lt;/script&gt;');
    });

    it('renders hard-limit targets as disabled with the literal reason', () => {
        const state = makeState([
            { name: 'Aria', side: 'player', stats: { cha: 16, chaMod: 3 }, profile: profile('Aria') },
            { name: 'Bran', side: 'player', profile: profile('Bran', { limits: ['neck'] }) },
        ]);
        const ariaId = participantId(state, 'Aria');
        const branId = participantId(state, 'Bran');
        const html = buildLewdCombatMarkup(state, { actorId: ariaId, techniqueId: 'neck-kiss' });

        expect(html).toContain('Blocked by limit: neck');
        expect(html).toMatch(new RegExp(`<input[^>]*data-lc-target="${branId}"[^>]*disabled`));
        expect(html).toMatch(/data-lc-technique="neck-kiss"[^>]*disabled/);
    });

    it('matches the engine posture numbers exactly', () => {
        for (const key of ['lead', 'follow', 'switch']) {
            const tradeoff = describePostureTradeoff(key);
            expect(tradeoff).toMatchObject({
                key,
                accuracy: LEWD_POSTURES[key].accuracy,
                arousal: LEWD_POSTURES[key].arousal,
                poiseDefense: LEWD_POSTURES[key].poiseDefense,
                poiseRegen: LEWD_POSTURES[key].poiseRegen,
            });
        }
        expect(describePostureTradeoff('unknown').key).toBe('switch');

        const state = makeState([
            { name: 'Aria', side: 'player', stats: { cha: 16, chaMod: 3 }, profile: profile('Aria') },
            { name: 'Bran', side: 'player', profile: profile('Bran') },
        ]);
        const html = buildLewdCombatMarkup(state, {
            actorId: participantId(state, 'Aria'),
            techniqueId: 'firm-grip',
        });
        // Firm Grip is Lead-only; the default Switch selection must not show as
        // pressed when the technique cannot use it.
        expect(html).toMatch(/data-lc-posture="lead" aria-pressed="true"/);
        expect(html).toMatch(/data-lc-posture="switch" aria-pressed="false"/);
    });

    it('shows the outcome and hides the composer once the encounter ends', () => {
        const state = makeState([
            { name: 'Aria', side: 'player', profile: profile('Aria') },
            { name: 'Bran', side: 'player', profile: profile('Bran') },
        ]);
        const ended = {
            ...state,
            status: 'ended',
            outcome: 'atMercy',
            summary: 'Aria wins the encounter. Bran 0/3 Stamina.',
        };
        const html = buildLewdCombatMarkup(ended, {});

        expect(html).toContain('Outcome');
        expect(html.toLowerCase()).toContain('at mercy');
        expect(html).toContain('Aria wins the encounter');
        expect(html).not.toContain('data-lc-action="resolve"');
        expect(html).toContain('data-lc-action="new-encounter"');
        expect(html).toContain('data-lc-action="reset"');
        expect(html).toContain('data-lc-action="close"');
    });

    it('renders a capped prose transcript with per-entry data attributes', () => {
        const state = makeState([
            { name: 'Aria', side: 'player', profile: profile('Aria') },
            { name: 'Bran', side: 'player', profile: profile('Bran') },
        ]);
        state.proseLog = [1, 2, 3].map(index => ({
            id: `prose-${index}`,
            stateId: state.id,
            round: 1,
            text: `Beat number ${index}.`,
            source: index === 3 ? 'fallback' : 'model',
        }));

        const html = buildLewdCombatMarkup(state, {});

        expect(html).toContain('rt-lc-prose-scroll');
        expect((html.match(/data-lc-prose-entry/g) || [])).toHaveLength(3);
        expect(html).toContain('data-lc-prose-id="prose-1"');
        expect(html).toContain('data-lc-prose-source="fallback"');
        expect(html.indexOf('Beat number 1.')).toBeLessThan(html.indexOf('Beat number 3.'));
        expect(html).toContain('rt-lc-log');
    });

    it('renders the control chip from control with a legacy ai fallback', () => {
        const state = makeState([
            { name: 'Aria', side: 'player', profile: profile('Aria') },
            { name: 'Bran', side: 'enemy', profile: profile('Bran') },
        ]);
        const html = buildLewdCombatMarkup(state, { actorId: participantId(state, 'Aria') });

        const aria = state.participants.find(participant => participant.name === 'Aria');
        const bran = state.participants.find(participant => participant.name === 'Bran');
        expect(aria.control).toBe('player');
        expect(bran.control).toBe('ai');
        expect(html).toContain('rt-lc-chip-player');
        expect(html).toContain('rt-lc-chip-ai');

        // A participant whose control is player must never be labelled AI even
        // when its legacy side is hostile.
        const overridden = makeState([
            { name: 'Aria', side: 'player', profile: profile('Aria') },
            { name: 'Bran', side: 'enemy', control: 'player', profile: profile('Bran') },
        ]);
        const card = buildLewdCombatMarkup(overridden, {})
            .split('data-lc-unit-id=')
            .find(chunk => chunk.includes('Bran'));
        expect(card).toBeTruthy();
        expect(card).toContain('rt-lc-chip-player');
        expect(card).not.toContain('rt-lc-chip-ai');
    });

    it('previews the start control badges and shows Player for every row under player-all', () => {
        const candidates = [
            { name: 'Aria', normalizedName: 'aria', side: 'player', sources: ['party'], control: 'player', profile: profile('Aria') },
            { name: 'Nyx', normalizedName: 'nyx', side: 'player', sources: ['lewd'], control: 'ai', profile: profile('Nyx') },
        ];

        const auto = buildLewdCombatMarkup(null, {
            startOpen: true,
            startCandidates: candidates,
            startControlMode: 'auto',
        });
        expect(auto).toContain('data-lc-control="player"');
        expect(auto).toContain('data-lc-control="ai"');

        const playerAll = buildLewdCombatMarkup(null, {
            startOpen: true,
            startCandidates: candidates,
            startControlMode: 'player-all',
        });
        expect(playerAll).toContain('data-lc-control="player"');
        expect(playerAll).not.toContain('data-lc-control="ai"');
    });

    it('renders the inferred action strip with a refresh button', () => {
        const state = makeState([
            { name: 'Aria', side: 'player', profile: profile('Aria') },
            { name: 'Bran', side: 'enemy', profile: profile('Bran') },
        ]);
        // A legacy board without inference has no strip.
        expect(buildLewdCombatMarkup(state, { actorId: participantId(state, 'Aria') }))
            .not.toContain('rt-lc-inference');
        state.inferredActions = {
            stateId: state.id,
            completedAt: 1,
            source: 'deterministic-fallback',
            availableTechniqueIds: ['neck-kiss'],
            perParticipant: {},
            diagnostics: ['offline'],
        };
        const html = buildLewdCombatMarkup(state, { actorId: participantId(state, 'Aria') });
        expect(html).toContain('rt-lc-inference');
        expect(html).toContain('data-lc-action="refresh-actions"');
        expect(html).toContain('1 inferred action');
        expect(html).toContain('offline fallback');
        expect(html).toContain('1 diagnostic');
    });

    it('exports the UI lifecycle functions without touching the DOM at import', () => {
        expect(typeof ui.installLewdCombatUi).toBe('function');
        expect(typeof ui.openLewdCombatBoard).toBe('function');
        expect(typeof ui.startLewdCombatFlow).toBe('function');
        expect(typeof ui.stopLewdCombatEncounter).toBe('function');
        expect(typeof ui.resetLewdCombatEncounter).toBe('function');
        expect(typeof ui.refreshLewdCombatUi).toBe('function');
        expect(typeof ui.onLewdCombatChatChanged).toBe('function');
        expect(typeof ui.isLewdCombatBusy).toBe('function');
    });
});
