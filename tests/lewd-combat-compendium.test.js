import { describe, expect, it, vi } from 'vitest';
import {
    buildLewdTechniqueCatalog,
    findCachedTechnique,
    normalizeLewdTechniqueCompendium,
    parseLewdTechniqueBlock,
    readTechniqueCache,
    writeTechniqueCache,
} from '../src/features/lewd-combat/lewd-combat-compendium.js';
import {
    compileLewdTechnique,
    parseLewdCompilerResponse,
} from '../src/features/lewd-combat/lewd-combat-compiler.js';
import { LEWD_TECHNIQUES } from '../src/features/lewd-combat/lewd-combat-techniques.js';
import { buildDefaultSettings } from '../src/state/defaults.js';

function compiledPayload(overrides = {}) {
    return {
        id: 'moonlit-kiss',
        name: 'Moonlit Kiss',
        category: 'technique',
        description: 'A slow kiss in the dark.',
        posture: 'either',
        zones: ['lips'],
        targetMode: 'single',
        tags: ['praise'],
        check: { stat: 'cha', accuracy: 1 },
        arousal: '1d6+1',
        poise: '1d4',
        requires: { hold: null, stance: null, overwhelmed: false },
        uses: { max: null, recharge: 'at-will' },
        ai: { priority: 2, conditions: [] },
        ...overrides,
    };
}

describe('technique compendium', () => {
    it('uses the shipped catalog when the JSON is empty', () => {
        const catalog = buildLewdTechniqueCatalog({});
        expect(catalog.error).toBe('');
        expect(catalog.usingDefault).toBe(true);
        expect(catalog.techniques).toHaveLength(LEWD_TECHNIQUES.length);
        expect(catalog.byId['neck-kiss']).toBeTruthy();
    });

    it('falls back to the shipped catalog for invalid JSON and reports the error', () => {
        const catalog = buildLewdTechniqueCatalog({ lewdCombatTechniqueCompendiumJson: '{ nope' });
        expect(catalog.error).toContain('Invalid JSON');
        expect(catalog.techniques).toHaveLength(LEWD_TECHNIQUES.length);
        expect(catalog.usingDefault).toBe(true);
    });

    it('overrides a shipped technique by id', () => {
        const raw = JSON.stringify({
            techniques: [{
                id: 'neck-kiss',
                name: 'Custom Neck Kiss',
                category: 'technique',
                zones: ['neck'],
                targetMode: 'single',
                arousal: '9',
                poise: '0',
            }],
        });
        const catalog = buildLewdTechniqueCatalog({ lewdCombatTechniqueCompendiumJson: raw });
        expect(catalog.byId['neck-kiss'].name).toBe('Custom Neck Kiss');
        expect(catalog.byId['neck-kiss'].arousal).toBe('9');
        expect(catalog.techniques).toHaveLength(LEWD_TECHNIQUES.length);
    });

    it('drops invalid entries individually with diagnostics', () => {
        const raw = JSON.stringify({
            techniques: [
                { id: 'good', name: 'Good', category: 'technique', zones: ['neck'], targetMode: 'single' },
                { id: 'bad', name: 'Bad', category: 'nonsense', zones: ['neck'], targetMode: 'single' },
                { id: 'bad-zone', name: 'Bad Zone', category: 'technique', zones: ['flipper'], targetMode: 'single' },
            ],
        });
        const normalized = normalizeLewdTechniqueCompendium(raw);
        expect(normalized.ok).toBe(true);
        expect(normalized.techniques.good).toBeTruthy();
        expect(normalized.techniques.bad).toBeUndefined();
        expect(normalized.techniques['bad-zone']).toBeUndefined();
        expect(normalized.diagnostics).toHaveLength(2);
        expect(normalized.diagnostics.join(' ')).toContain('Unknown category');
        expect(normalized.diagnostics.join(' ')).toContain('Unknown zone');
    });

    it('parses [LEWD_TECHNIQUES] lines into the canonical shape', () => {
        const memo = `
            [LEWD_TECHNIQUES]
            - Moonlit Kiss | technique | either | zones: lips | tags: praise | arousal: 1d6+1 | poise: 1d4 | at-will
            - Firm Grip | hold | lead | zones: waist, hips | tags: dominance | check: str | hold: grappled | dc: 12
            - Broken Line | nope | zones: neck
            [/LEWD_TECHNIQUES]
        `;
        const parsed = parseLewdTechniqueBlock(memo);
        expect(parsed.entries).toHaveLength(2);
        expect(parsed.diagnostics).toHaveLength(1);
        const kiss = parsed.entries.find(entry => entry.id === 'moonlit-kiss');
        expect(kiss).toMatchObject({
            name: 'Moonlit Kiss', category: 'technique', posture: 'either', zones: ['lips'],
            tags: ['praise'], arousal: '1d6+1', poise: '1d4',
        });
        expect(kiss.uses).toMatchObject({ max: null, recharge: 'at-will' });
        const grip = parsed.entries.find(entry => entry.id === 'firm-grip');
        expect(grip.hold).toMatchObject({ id: 'grappled', label: 'grappled', escapeDC: 12 });
        expect(grip.check.stat).toBe('str');
    });

    it('parses explicit act fields and drops only the invalid line', () => {
        const memo = `
            [LEWD_TECHNIQUES]
            - Press | technique | lead | zones: genitals | acttype: penetration | actrole: give | requiresact: penetration | appliesact: penetration | appliesintensity: 2
            - Receive | technique | follow | zones: genitals | acttype: oral | actrole: receive | requiresanatomy: bondage-gear | requiresskill: Bondage | appliesact: none
            - Broken Line | technique | lead | zones: genitals | acttype: nonsense
            [/LEWD_TECHNIQUES]
        `;
        const parsed = parseLewdTechniqueBlock(memo);
        expect(parsed.entries).toHaveLength(2);
        expect(parsed.diagnostics).toHaveLength(1);
        expect(parsed.diagnostics[0]).toContain('Unknown actType');
        const press = parsed.entries.find(entry => entry.id === 'press');
        expect(press).toMatchObject({ actType: 'penetration', actRole: 'give' });
        expect(press.requires).toMatchObject({ act: 'penetration' });
        expect(press.applies.act).toMatchObject({
            id: 'penetration', type: 'penetration', role: 'give', intensity: 2,
        });
        const receive = parsed.entries.find(entry => entry.id === 'receive');
        expect(receive.applies.act).toBeNull();
        expect(receive.requires).toMatchObject({
            anatomy: { all: ['bondage-gear'], any: [] },
            skill: ['bondage'],
        });
    });

    it('ignores a bare appliesact flag and rejects a non-numeric intensity', () => {
        const memo = `
            [LEWD_TECHNIQUES]
            - Flagged | technique | lead | zones: genitals | appliesact
            - Bad Intensity | technique | lead | zones: genitals | appliesact: penetration | appliesintensity: strong
            [/LEWD_TECHNIQUES]
        `;
        const parsed = parseLewdTechniqueBlock(memo);
        expect(parsed.entries).toHaveLength(1);
        expect(parsed.entries[0].id).toBe('flagged');
        expect(parsed.entries[0].applies.act).toBeUndefined();
        expect(parsed.diagnostics).toHaveLength(1);
        expect(parsed.diagnostics[0]).toContain('Invalid act intensity');
    });

    it('keeps explicit acts through the catalog and cache round-trips', () => {
        const catalog = buildLewdTechniqueCatalog({});
        expect(catalog.diagnostics).toEqual([]);
        expect(catalog.byId.withdraw.applies.act).toBeNull();
        expect(catalog.byId['thrust-harder'].requires.act).toBe('penetration');
        expect(catalog.byId['penetration-start'].applies.act).toMatchObject({
            id: 'penetration', type: 'penetration', role: 'give',
        });

        const settings = {};
        writeTechniqueCache(settings, compiledPayload({
            actType: 'penetration',
            applies: { act: { id: 'penetration' } },
        }));
        const cached = buildLewdTechniqueCatalog(settings);
        expect(cached.byId['moonlit-kiss'].applies.act).toMatchObject({
            id: 'penetration', type: 'penetration',
        });
    });

    it('applies the documented merge order (shipped → cache → JSON → block)', () => {
        const settings = {};
        writeTechniqueCache(settings, {
            id: 'cached-lips', name: 'Cached Lips', category: 'technique', zones: ['lips'],
            targetMode: 'single', arousal: '1d4', poise: '0',
        });
        settings.lewdCombatTechniqueCompendiumJson = JSON.stringify({
            techniques: [{
                id: 'neck-kiss', name: 'User Neck Kiss', category: 'technique', zones: ['neck'],
                targetMode: 'single', arousal: '1d4', poise: '0',
            }],
        });
        const memo = '[LEWD_TECHNIQUES]\n- Block Kiss | technique | either | id: neck-kiss | zones: neck | arousal: 1d6 | poise: 0\n[/LEWD_TECHNIQUES]';
        const catalog = buildLewdTechniqueCatalog(settings, memo);
        expect(catalog.sources).toMatchObject({ cache: 1, user: 1, memo: 1 });
        expect(catalog.byId['cached-lips']).toBeTruthy();
        // The memo block is merged last and wins over the user JSON.
        expect(catalog.byId['neck-kiss'].name).toBe('Block Kiss');
    });

    it('reads and caches compiled techniques once', () => {
        const settings = {};
        const technique = { ...compiledPayload(), id: 'cached-only', name: 'Cached Only' };
        expect(writeTechniqueCache(settings, technique)).toMatchObject({ id: 'cached-only' });
        expect(findCachedTechnique(settings, 'Cached Only').id).toBe('cached-only');
        expect(readTechniqueCache(settings).entries).toHaveLength(1);
        const catalog = buildLewdTechniqueCatalog(settings);
        expect(catalog.byId['cached-only']).toBeTruthy();
        expect(catalog.sources.cache).toBe(1);
    });

    it('does not scan unrelated settings keys as cached techniques', () => {
        const cache = readTechniqueCache({
            lewdCombatEnabled: true,
            lewdCombatRoundCap: 12,
            lewdCombatCompilerPrompt: 'not a technique',
        });
        expect(cache.entries).toEqual([]);
        expect(cache.diagnostics).toEqual([]);
    });

    it('ships the new compendium settings defaults', () => {
        const defaults = buildDefaultSettings();
        expect(defaults.lewdCombatTechniqueCompendiumJson).toBe('');
        expect(defaults.lewdCombatTechniqueCache).toEqual({});
        expect(String(defaults.lewdCombatCompilerPrompt)).toContain('Lewd Combat technique compiler');
    });
});

describe('one-time technique compiler', () => {
    it('compiles once, caches the validated technique, and reuses it', async () => {
        const settings = {};
        const calls = [];
        const sendStateRequest = vi.fn(async () => {
            calls.push(1);
            return JSON.stringify(compiledPayload());
        });
        const first = await compileLewdTechnique({ name: 'Moonlit Kiss' }, settings, { sendStateRequest });
        expect(first.ok).toBe(true);
        expect(first.cached).toBe(false);
        expect(first.technique).toMatchObject({ id: 'moonlit-kiss', name: 'Moonlit Kiss', zones: ['lips'] });
        expect(settings.lewdCombatTechniqueCache['moonlit-kiss']).toBeTruthy();
        expect(sendStateRequest).toHaveBeenCalledTimes(1);

        const second = await compileLewdTechnique({ name: 'Moonlit Kiss' }, settings, { sendStateRequest });
        expect(second.ok).toBe(true);
        expect(second.cached).toBe(true);
        expect(sendStateRequest).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(1);
    });

    it('rejects an invalid compiler response without caching it', async () => {
        const settings = {};
        const sendStateRequest = vi.fn(async () => JSON.stringify(compiledPayload({ zones: ['flipper'] })));
        const result = await compileLewdTechnique({ name: 'Tail Trick' }, settings, { sendStateRequest });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Unknown zone');
        expect(settings.lewdCombatTechniqueCache).toBeUndefined();
    });

    it('returns a visible error when the connection is unavailable', async () => {
        const result = await compileLewdTechnique({ name: 'No Connection' }, {}, {
            sendStateRequest: async () => { throw new Error('offline'); },
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('offline');
    });

    it('accepts a valid explicit act payload and still rejects an invalid zone', () => {
        const payload = compiledPayload({
            actType: 'penetration',
            actRole: 'give',
            requires: { actType: 'penetration', anatomy: { any: ['penis'] } },
            applies: { act: { id: 'penetration', intensity: 1 } },
        });
        const parsed = parseLewdCompilerResponse(payload);
        expect(parsed.ok).toBe(true);
        expect(parsed.technique).toMatchObject({ actType: 'penetration', actRole: 'give' });
        expect(parsed.technique.applies.act).toMatchObject({
            id: 'penetration', type: 'penetration', role: 'give', intensity: 1,
        });

        const rejected = parseLewdCompilerResponse(compiledPayload({ zones: ['flipper'] }));
        expect(rejected.ok).toBe(false);
        expect(rejected.error).toContain('Unknown zone');
    });

    it('parses fenced and prose-wrapped JSON responses', () => {
        const fenced = parseLewdCompilerResponse('```json\n' + JSON.stringify(compiledPayload()) + '\n```');
        expect(fenced.ok).toBe(true);
        const prose = parseLewdCompilerResponse(`Here is the technique:\n${JSON.stringify(compiledPayload())}\nEnjoy.`);
        expect(prose.ok).toBe(true);
        expect(prose.technique.id).toBe('moonlit-kiss');
    });
});
