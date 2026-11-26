import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import './setup.js';

vi.mock('../portrait-storage.js', () => ({
    lookupCustomPortraitSrc: () => '',
}));

import {
    buildToolSchemaFromActions,
    parseScriptFromJson,
    validateScriptDefinition,
} from '../src/features/scripting/core/script-schema.js';
import {
    createTurnLedger,
    ensureScriptState,
    renderScriptMemo,
    runScriptToolAction,
    runScriptsAfterGenerate,
    runScriptsBeforeGenerate,
} from '../src/features/scripting/core/script-engine.js';
import { renderMemoAsCards } from '../renderer.js';

const FIXTURE_RAW = readFileSync(
    new URL('./fixtures/my-monster-farm-v2.script.json', import.meta.url),
    'utf8',
);

function loadScript() {
    const parsed = parseScriptFromJson(FIXTURE_RAW);
    expect(parsed.ok).toBe(true);
    const validation = validateScriptDefinition(parsed.script);
    expect(validation.valid).toBe(true);
    return parsed.script;
}

describe('My Monster Farm v.2 Python Companion Script', () => {
    it('passes schema validation, character binding, and tool schema compilation', () => {
        const script = loadScript();
        expect(script.id).toBe('my_monster_farm_v2');
        expect(script.name).toBe('My Monster Farm v.2');
        expect(script.lang).toBe('python');
        expect(script.scope).toBe('character');
        expect(script.boundCharacters).toEqual(['My Monster Farm v.2']);
        expect(script.trackerTag).toBe('MONSTER_FARM');
        expect(script.commandPrefix).toBe('!farm');
        expect(script.toolEnabled).toBe(true);
        expect(script.toolName).toBe('Script_MonsterFarm');
        expect(script.toolActions.length).toBe(13);

        const toolSchema = buildToolSchemaFromActions(script);
        expect(toolSchema.name).toBe('Script_MonsterFarm');
        expect(toolSchema.parameters.properties.action.enum).toContain('set_active_path');
        expect(toolSchema.parameters.properties.action.enum).toContain('feed_request');
    });

    it('initializes Day 1 farm state, residents, and hornet scouts quest', async () => {
        const script = loadScript();
        const ensured = await ensureScriptState(script, null, {});
        expect(ensured.ok).toBe(true);
        const s = ensured.state;
        expect(s.day).toBe(1);
        expect(s.season).toBe('Early Spring');
        expect(s.funds).toBe(120);
        expect(s.debt).toBe(0);
        expect(s.food).toEqual({ general_feed: 35, fresh_greens: 8, meat: 1 });
        expect(Object.keys(s.residents)).toEqual(['mira', 'nettie', 'lopa', 'brielle']);
        expect(s.quests[0]).toMatchObject({
            id: 'hornet_scouts',
            status: 'active',
            reward_flag: 'hornet_scouts_cleared',
        });
    }, 15000);

    it('supports both !farm plumbing commands (stripped) and raw /commands (kept for RP)', async () => {
        const script = loadScript();
        let state = (await ensureScriptState(script, null, {})).state;

        // Meta plumbing command -> stripCommand: true
        const flagRun = await runScriptsBeforeGenerate(
            [script],
            { [script.id]: state },
            { userMessage: '!farm flag holstaur_asked_halter true' },
        );
        expect(flagRun.stripCommand).toBe(true);
        state = flagRun.updatedStates[script.id];
        expect(state.flags.holstaur_asked_halter).toBe(true);

        // Raw card /command -> stripCommand: false
        const marketRun = await runScriptsBeforeGenerate(
            [script],
            { [script.id]: state },
            { userMessage: '/market silk' },
        );
        expect(marketRun.stripCommand).toBe(false);
        expect(marketRun.promptInjections[0].text).toContain('Silk Lane');
        expect(marketRun.promptInjections[0].text).toContain('spider_silk 14g');
    }, 15000);

    it('enforces gate prerequisites strictly, applies Fx on 3-stage TF paths, and supports --force', async () => {
        const script = loadScript();
        let state = (await ensureScriptState(script, null, {})).state;

        // Unmet gate should block
        const blocked = await runScriptToolAction(
            script,
            state,
            'set_active_path',
            { resident: 'mira', target_id: 'holstaur_halter_and_bell' },
            {},
            createTurnLedger(),
        );
        expect(blocked.toolResult.ok).toBe(false);
        expect(blocked.toolResult.blocked).toBe(true);
        expect(blocked.toolResult.missing.length).toBeGreaterThan(0);

        // Satisfy gates for holstaur_herd_kindred S1 -> S2 -> S3
        state.residents.mira.trust = 88;
        state.upgrades.mineral_lick = 1;
        state.ecology.field_health = 60;
        state.counters.direct_milk_scenes = 5;
        state.counters.pasture_nights = 6;
        state.flags.player_consent_holstaur_tf_1 = true;
        state.flags.player_consent_holstaur_tf_2 = true;
        state.flags.holstaur_cream_gift_accepted = true;
        state.flags.player_confirm_holstaur_tf_3 = true;

        const s2Res = await runScriptToolAction(
            script,
            state,
            'set_active_path',
            { resident: 'mira', target_id: 'holstaur_herd_kindred', stage: 'S2' },
            {},
            createTurnLedger(),
        );
        expect(s2Res.toolResult.ok).toBe(true);
        state = s2Res.state;
        expect(state.residents.mira.active_path).toBe('holstaur_herd_kindred');
        expect(state.residents.mira.path_stage).toBe('S2');
        expect(state.player.tf.holstaur).toBe(2);
        expect(state.player.traits.herd_empathy).toBe(true);

        const s3Res = await runScriptToolAction(
            script,
            state,
            'set_active_path',
            { resident: 'mira', target_id: 'holstaur_herd_kindred', stage: 'S3' },
            {},
            createTurnLedger(),
        );
        expect(s3Res.toolResult.ok).toBe(true);
        state = s3Res.state;
        expect(state.player.tf.holstaur).toBe(3);
        expect(state.player.traits.pasture_kin).toBe(true);

        // Stage-3 TF purify blocked without Unicorn Purge, allowed with flag
        const purifyBlocked = await runScriptToolAction(
            script,
            state,
            'farm_action',
            { op: 'purify', target: 'holstaur' },
            {},
            createTurnLedger(),
        );
        expect(purifyBlocked.toolResult.ok).toBe(false);

        state.flags.unicorn_purge_available = true;
        const purifyOk = await runScriptToolAction(
            script,
            state,
            'farm_action',
            { op: 'purify', target: 'holstaur' },
            {},
            createTurnLedger(),
        );
        expect(purifyOk.toolResult.ok).toBe(true);
        expect(purifyOk.state.player.tf.holstaur).toBeUndefined();
    }, 15000);

    it('enforces safeword consent boundary, Bad Ending Warning Gate sequence, and /feed confirmation', async () => {
        const script = loadScript();
        let state = (await ensureScriptState(script, null, {})).state;

        // 1. Two-step /feed -> /confirm feed safety gate
        const reqRun = await runScriptsBeforeGenerate(
            [script],
            { [script.id]: state },
            { userMessage: '/feed Fenris with Lopa' },
        );
        state = reqRun.updatedStates[script.id];
        expect(state.pending_feed).toEqual({ predator: 'Fenris', target: 'Lopa' });
        expect(state.residents.lopa).toBeDefined();

        const confRun = await runScriptsBeforeGenerate(
            [script],
            { [script.id]: state },
            { userMessage: '/confirm feed' },
        );
        state = confRun.updatedStates[script.id];
        expect(state.pending_feed).toBeNull();
        expect(state.residents.lopa).toBeUndefined();
        expect(state.reputation.dark_whispers).toBe(15);

        // 2. Wild Threat route refuses safeword, and Bad Ending requires Warning Gate first
        state.flags.lamia_grapple_lost = true;
        const threatRes = await runScriptToolAction(
            script,
            state,
            'set_active_path',
            { target_id: 'threat_lamia_coiled_and_kept' },
            {},
            createTurnLedger(),
        );
        expect(threatRes.toolResult.ok).toBe(true);
        state = threatRes.state;
        expect(state.player.statuses.captive_lamia).toBe(true);

        const safewordDenied = await runScriptToolAction(
            script,
            state,
            'farm_action',
            { op: 'safeword' },
            {},
            createTurnLedger(),
        );
        expect(safewordDenied.toolResult.ok).toBe(false);

        // Trigger Warning Gate on /endday when Autumn/Winter, days_captive >= 8, food.meat == 0
        state.season = 'Winter';
        state.food.meat = 0;
        state.player.days_captive = 8;
        const dayRes = await runScriptToolAction(
            script,
            state,
            'end_day',
            { days: 1 },
            {},
            createTurnLedger(),
        );
        state = dayRes.state;
        expect(state.flags.lamia_hunger_warning).toBe(true);
    }, 15000);

    it('handles Corvin Vale 5% merchant fee, species aliases, quests, turn dedup, and HUD rendering', async () => {
        const script = loadScript();
        let state = (await ensureScriptState(script, null, {})).state;
        state.products.spider_silk = 10; // 10 * 14g = 140g gross, 5% fee = 7g, net = 133g

        const sellRes = await runScriptToolAction(
            script,
            state,
            'economy_tx',
            { op: 'sell', target: 'spider_silk', amount: 10 },
            {},
            createTurnLedger(),
        );
        expect(sellRes.toolResult.ok).toBe(true);
        state = sellRes.state;
        expect(state.funds).toBe(120 + 133);
        expect(state.products.spider_silk).toBe(0);

        // Species alias canonicalization (Drider -> arachne)
        const addRes = await runScriptToolAction(
            script,
            state,
            'manage_resident',
            { op: 'add', resident: 'Vespera', species: 'Drider', subtype: 'Drider' },
            {},
            createTurnLedger(),
        );
        state = addRes.state;
        expect(state.residents.vespera.species).toBe('arachne');

        // Quest completion sets hornet_scouts_cleared
        const qRes = await runScriptToolAction(
            script,
            state,
            'farm_action',
            { op: 'quest_complete', target: 'hornet_scouts' },
            {},
            createTurnLedger(),
        );
        state = qRes.state;
        expect(state.flags.hornet_scouts_cleared).toBe(true);

        // Pre-turn command + turn-ledger deduplication
        const beforeRun = await runScriptsBeforeGenerate(
            [script],
            { [script.id]: state },
            { userMessage: '!farm end_day' },
        );
        state = beforeRun.updatedStates[script.id];
        expect(state.day).toBe(2);

        const dupTool = await runScriptToolAction(
            script,
            state,
            'end_day',
            {},
            {},
            beforeRun.ledger,
        );
        expect(dupTool.deduped).toBe(true);

        const afterRun = await runScriptsAfterGenerate(
            [script],
            { [script.id]: state },
            { assistantMessage: 'Day 2 dawns over Thalorim.' },
            beforeRun.ledger,
        );
        state = afterRun.updatedStates[script.id];

        // HUD rendering with ((BAR)) and ((PILLS))
        const memoRes = await renderScriptMemo(script, state, {});
        const memoBody = memoRes.memoBlock;
        expect(memoBody).toContain('Day 2 | Early Spring');
        expect(memoBody).toContain('((BARGREEN))');
        expect(memoBody).toContain('((PILLS))');
        const html = renderMemoAsCards(`[MONSTER_FARM]\n${memoBody}\n[/MONSTER_FARM]`, null, {});
        expect(html).toContain('MONSTER_FARM');
    }, 15000);
});
