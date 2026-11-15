import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BLOCK_ORDER,
    DEFAULT_STOCK_PROMPTS,
    NO_PAGINATE,
} from '../constants.js';
import {
    applyProfileTraits,
    findLewdProfile,
    inferProfile,
    isBlockedByLimits,
    maxStaminaFromProfile,
    normalizeLewdProfile,
    normalizeLewdZone,
    parseLewdProfileLine,
    parseLewdProfiles,
    parseLewdTraits,
    preferenceMultiplier,
    resolveLewdProfile,
    zoneMultiplier,
} from '../src/features/lewd-combat/lewd-combat-profile.js';
import { LEWD_DESIRES_SECTION } from '../src/state/schema-sections.js';
import { buildLewdInstruction } from '../src/state/module-instructions.js';

afterEach(() => {
    vi.restoreAllMocks();
});

const FULL_MEMO = `[LEWD]
- Aria: role=switch | orientation=bisexual | stamina=4/4 | sensitivity=neck:high, groin:medium, ears:low | likes=praise, teasing | dislikes=pain | limits=breath play, marking | endurance=+1 | experience=2 | traits=stamina+1, drain-1, sensitivity:neck+1
- Bran: role=dominant | stamina=3/3 | sensitivity=neck:medium, chest:low | likes=being guided | dislikes=humiliation | limits=none declared | endurance=+0 | experience=1 | traits=poise+1
[/LEWD]`;

describe('lewd profile parsing', () => {
    it('parses every canonical field from the [LEWD] block', () => {
        const profiles = parseLewdProfiles(FULL_MEMO);
        const aria = findLewdProfile(profiles, 'aria');

        expect(aria).toBeTruthy();
        expect(aria.name).toBe('Aria');
        expect(aria.role).toBe('switch');
        expect(aria.orientation).toBe('bisexual');
        expect(aria.source).toBe('lewd');
        expect(aria.inferred).toBe(false);
        expect(aria.endurance).toBe(1);
        expect(aria.experience).toBe(2);
        expect(aria.limits).toEqual(['breath play', 'marking']);

        // Stamina 4 + stamina+1 trait, applied once.
        expect(aria.maxStamina).toBe(5);
        expect(aria.stamina).toBe(4);
        expect(maxStaminaFromProfile(aria)).toBe(5);

        // Level modifiers: high = 1.3, medium = 1.0, low = 0.7.
        expect(aria.sensitivity.neck).toBe(1.4); // high + sensitivity:neck+1 (+0.1)
        expect(zoneMultiplier(aria, 'neck')).toBe(1.82); // shipped 1.3 × 1.4
        expect(zoneMultiplier(aria, 'groin')).toBe(1.8);
        expect(zoneMultiplier(aria, 'ears')).toBe(0.84);

        expect(aria.drain).toBe(-1);
        expect(preferenceMultiplier(aria, 'praise')).toBe(1.25);
        expect(preferenceMultiplier(aria, 'teasing')).toBe(1.25);
        expect(preferenceMultiplier(aria, 'pain')).toBe(0.5);
        expect(preferenceMultiplier(aria, 'marking')).toBe(1);

        expect(isBlockedByLimits(aria, ['breath play'])).toBe('breath play');
        expect(isBlockedByLimits(aria, ['marking'])).toBe('marking');
        expect(isBlockedByLimits(aria, ['neck', 'teasing'])).toBe('');

        const bran = findLewdProfile(profiles, 'Bran');
        expect(bran.role).toBe('dominant');
        expect(bran.limits).toEqual([]);
        expect(bran.traits.poise).toBe(1);
        expect(bran.maxPoise).toBe(7); // neutral 6 + poise+1
    });

    it('accepts synonyms, alternate separators, and unknown fields with warnings', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const profiles = parseLewdProfiles(`[LEWD]
- Mira: dynamic=dom; sensitive=neck:1.5, tail:high | desires=praise | aversions=humiliation | hard limits=no marking | exp=3 | stamina=2 | traits=stamina+2, luck+1
[/LEWD]`);

        const mira = findLewdProfile(profiles, 'mira');
        expect(mira.role).toBe('dominant');
        expect(mira.sensitivity.neck).toBe(1.5);
        expect(mira.sensitivity.tail).toBeUndefined();
        expect(mira.maxStamina).toBe(4); // 2 + stamina+2
        expect(mira.experience).toBe(3);
        expect(mira.preference.praise).toBe('like');
        expect(mira.preference.humiliation).toBe('dislike');
        expect(mira.limits).toEqual(['no marking']);
        expect(isBlockedByLimits(mira, ['marking'])).toBe('no marking');
        expect(mira.warnings.join(' ')).toContain('unknown sensitivity zone "tail"');
        expect(mira.warnings.join(' ')).toContain('unknown trait "luck+1"');
        expect(warn).toHaveBeenCalled();
    });

    it('falls back to inline Lewd/Desires/Sensitive/Limits lines when no [LEWD] entry exists', () => {
        const memo = `[CHARACTER]
{{user}} (Fighter): 30/30 HP
Lewd: role=submissive | likes=praise, being guided
[/CHARACTER]

[PARTY]
Elara (Ranger): 26/45 HP
Desires: teasing
Sensitive: neck, ears
Limits: marking
[/PARTY]`;

        const profiles = parseLewdProfiles(memo);
        const player = findLewdProfile(profiles, '{{user}}');
        expect(player).toBeTruthy();
        expect(player.role).toBe('submissive');
        expect(player.source).toBe('inline');
        expect(preferenceMultiplier(player, 'praise')).toBe(1.25);

        const elara = findLewdProfile(profiles, 'Elara');
        expect(elara).toBeTruthy();
        expect(elara.source).toBe('inline');
        expect(zoneMultiplier(elara, 'neck')).toBe(1.69); // bare Sensitive: means high (1.3)
        expect(preferenceMultiplier(elara, 'teasing')).toBe(1.25);
        expect(isBlockedByLimits(elara, ['marking'])).toBe('marking');
    });

    it('lets the [LEWD] block win over inline lines for the same character', () => {
        const memo = `[PARTY]
Elara (Ranger): 26/45 HP
Limits: marking
[/PARTY]

[LEWD]
- Elara: role=dominant | limits=none declared
[/LEWD]`;

        const elara = findLewdProfile(parseLewdProfiles(memo), 'elara');
        expect(elara.source).toBe('lewd');
        expect(elara.role).toBe('dominant');
        expect(elara.limits).toEqual([]);
    });

    it('normalizes zones and ignores malformed lines instead of guessing', () => {
        expect(normalizeLewdZone('full body')).toBe('full_body');
        expect(normalizeLewdZone('Nipple')).toBe('nipples');
        expect(normalizeLewdZone('tail')).toBe('');
        expect(parseLewdProfileLine('')).toBeNull();
        expect(parseLewdProfileLine('just prose without a colon')).toBeNull();
    });

    it('merges duplicate [LEWD] entries deeply and warns', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const profiles = parseLewdProfiles(`[LEWD]
- Aria: role=switch | limits=marking | traits=stamina+1, sensitivity:neck+1
- Aria: likes=praise | traits=drain-1
[/LEWD]`);

        const aria = findLewdProfile(profiles, 'aria');
        expect(aria.role).toBe('switch');
        expect(aria.limits).toEqual(['marking']);
        expect(preferenceMultiplier(aria, 'praise')).toBe(1.25);
        expect(aria.traits).toEqual({
            stamina: 1,
            drain: -1,
            sensitivity: { neck: 1 },
        });
        expect(aria.maxStamina).toBe(3); // 2 + stamina+1
        expect(aria.drain).toBe(-1);
        expect(aria.warnings).toEqual([]);
        expect(warn.mock.calls.flat().join(' ')).toContain('duplicate [LEWD] entry');
    });

    it('uses unit stats for derived pools when participant units are supplied', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const profiles = parseLewdProfiles(
            '[LEWD]\n- Aria: stamina=4/4 | traits=stamina+1\n[/LEWD]',
            {},
            {
                units: [{
                    name: 'aria',
                    level: 5,
                    stats: { conMod: 2, wisMod: 1, chaMod: 3 },
                }],
            },
        );

        const aria = findLewdProfile(profiles, 'Aria');
        expect(aria.maxStamina).toBe(5);
        expect(aria.maxArousal).toBe(14); // 10 + floor(5/2) + 2
        expect(aria.maxPoise).toBe(10); // 6 + 1 + 3
    });

    it('stacks the endurance field with the endurance trait by design', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const profile = normalizeLewdProfile({ name: 'Aria', endurance: '+1', traits: 'endurance+1' });
        expect(profile.endurance).toBe(1);
        expect(profile.traits.endurance).toBe(1);
        expect(profile.maxStamina).toBe(4); // 2 + 1 (field) + 1 (trait)
    });

    it('does not treat a leading "no" in a like as a limit negation', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const profile = normalizeLewdProfile(parseLewdProfileLine('Aria: likes=no pain'));
        expect(profile.preference['no pain']).toBe('like');
        expect(preferenceMultiplier(profile, 'pain')).toBe(1);
    });
});

describe('inferred profiles and trait math', () => {
    it('derives a neutral inferred profile from CON/WIS/CHA and level', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const profile = inferProfile({
            name: 'Bran',
            level: 5,
            stats: { conMod: 2, wisMod: 1, chaMod: 3, cha: 16 },
        });

        expect(profile.inferred).toBe(true);
        expect(profile.source).toBe('inferred');
        expect(profile.maxStamina).toBe(2);
        expect(profile.maxArousal).toBe(14); // 10 + floor(5/2) + 2
        expect(profile.maxPoise).toBe(10); // 6 + 1 + 3
        expect(profile.limits).toEqual([]);
        expect(profile.traits).toEqual({});
        expect(profile.sensitivity).toEqual({});
    });

    it('applies traits once and is idempotent for the same base', () => {
        const profile = parseLewdProfileLine(
            'Aria: traits=stamina+1, drain-1, maxArousal+2, poise+1, sensitivity:neck+1',
        );
        const base = {
            maxStamina: 3,
            maxArousal: 10,
            maxPoise: 8,
            sensitivity: { neck: 1.3 },
            drain: 0,
        };

        const first = applyProfileTraits(profile, base);
        const second = applyProfileTraits(profile, base);

        expect(first).toEqual(second);
        expect(first.maxStamina).toBe(4);
        expect(first.maxArousal).toBe(12);
        expect(first.maxPoise).toBe(9);
        expect(first.sensitivity.neck).toBe(1.4);
        expect(first.drain).toBe(-1);
        // The input base and the profile are untouched.
        expect(base.maxStamina).toBe(3);
        expect(base.sensitivity.neck).toBe(1.3);
    });

    it('clamps trait-modified pools to their designed ranges', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const profile = { traits: { stamina: 5, maxArousal: 50, poise: 50 } };
        const applied = applyProfileTraits(profile, {
            maxStamina: 6,
            maxArousal: 30,
            maxPoise: 16,
            sensitivity: {},
        });
        expect(applied.maxStamina).toBe(6);
        expect(applied.maxArousal).toBe(30);
        expect(applied.maxPoise).toBe(16);
    });

    it('resolves explicit profiles first and inferred profiles otherwise', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const profiles = parseLewdProfiles('[LEWD]\n- Aria: role=switch\n[/LEWD]');
        expect(resolveLewdProfile(profiles, { name: 'Aria' }).source).toBe('lewd');
        const unknown = resolveLewdProfile(profiles, { name: 'Nobody', level: 2 });
        expect(unknown.inferred).toBe(true);
    });
});

describe('[LEWD] memo contract', () => {
    it('registers the block in tracker order and keeps it unsplit', () => {
        expect(BLOCK_ORDER[BLOCK_ORDER.length - 1]).toBe('LEWD');
        expect(NO_PAGINATE.has('LEWD')).toBe(true);
        expect(LEWD_DESIRES_SECTION.id).toBe('sec_desires');
        expect(LEWD_DESIRES_SECTION.name).toBe('Desires');
    });

    it('ships a stock prompt describing the profile grammar and consent rules', () => {
        const prompt = DEFAULT_STOCK_PROMPTS.lewd;
        expect(prompt).toContain('[LEWD]');
        expect(prompt).toContain('[/LEWD]');
        expect(prompt).toContain('role=dominant|submissive|switch');
        expect(prompt).toContain('limits');
        expect(prompt).toContain('NEVER invent a hard limit');
        expect(prompt).toContain('maintain entries for characters');
    });

    it('is only emitted when the module is enabled', () => {
        expect(buildLewdInstruction({ lewdCombatEnabled: false })).toBe('');
        expect(buildLewdInstruction({})).toBe('');

        const enabled = buildLewdInstruction({
            lewdCombatEnabled: true,
            stockPrompts: { lewd: 'Custom LEWD instruction' },
        });
        expect(enabled).toBe('Custom LEWD instruction');

        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const defaults = buildLewdInstruction({ lewdCombatEnabled: true });
        expect(defaults).toContain('[LEWD]');
    });

    it('parses traits into a typed modifier map', () => {
        expect(parseLewdTraits('stamina+1, drain-1, sensitivity:neck+1')).toEqual({
            stamina: 1,
            drain: -1,
            sensitivity: { neck: 1 },
        });
    });
});
