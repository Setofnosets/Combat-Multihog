import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
    applyLewdCombatTrigger,
    buildLewdCombatTriggerInstruction,
    stripLewdCombatTrigger,
} from '../src/features/lewd-combat/lewd-combat-trigger.js';
import {
    LEWD_COMBAT_TRIGGER_MODES,
    resolveLewdCombatTriggerMode,
} from '../src/features/lewd-combat/lewd-combat-constants.js';

const constantsSource = readFileSync(new URL('../constants.js', import.meta.url), 'utf8');
const syspromptSource = readFileSync(new URL('../sysprompt.txt', import.meta.url), 'utf8');
const legacySource = readFileSync(new URL('../sysprompt_legacy.txt', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

const SECTION = `<lewd_combat>\nLEWD COMBAT (SECONDARY)\nBody text.\n</lewd_combat>`;

describe('Lewd Combat trigger modes', () => {
    it('documents both modes and defaults unknown values to competitions', () => {
        expect(LEWD_COMBAT_TRIGGER_MODES).toEqual(['competitions', 'always']);
        expect(resolveLewdCombatTriggerMode('always')).toBe('always');
        expect(resolveLewdCombatTriggerMode('competitions')).toBe('competitions');
        expect(resolveLewdCombatTriggerMode('nope')).toBe('competitions');
        expect(resolveLewdCombatTriggerMode(undefined)).toBe('competitions');
    });

    it('builds the competitions-only instruction', () => {
        const text = buildLewdCombatTriggerInstruction('competitions');
        expect(text).toContain('ONLY');
        expect(text).toContain('competition');
        expect(text).toContain('isContest=true');
        expect(text).toMatch(/narrate it normally/i);
    });

    it('builds the legacy broad instruction for always mode', () => {
        const text = buildLewdCombatTriggerInstruction('always');
        expect(text).toContain('When the scene becomes intimate and the player initiates, call StartLewdCombat once.');
        expect(text).not.toContain('isContest=true');
    });
});

describe('applyLewdCombatTrigger', () => {
    it('injects the block immediately after the open tag', () => {
        const result = applyLewdCombatTrigger(SECTION, 'competitions');
        expect(result).toContain('<lewd_combat>\n<lewd_combat_trigger>');
        expect(result.indexOf('<lewd_combat_trigger>')).toBeLessThan(result.indexOf('Body text.'));
        expect(result.match(/<lewd_combat_trigger>/g)).toHaveLength(1);
    });

    it('is idempotent and replaces a stale block when the mode changes', () => {
        const first = applyLewdCombatTrigger(SECTION, 'competitions');
        const second = applyLewdCombatTrigger(first, 'competitions');
        expect(second).toBe(first);

        const switched = applyLewdCombatTrigger(first, 'always');
        expect(switched.match(/<lewd_combat_trigger>/g)).toHaveLength(1);
        expect(switched).toContain('When the scene becomes intimate and the player initiates, call StartLewdCombat once.');
        expect(switched).not.toContain('ONLY');
    });

    it('prepends the block when the section tag is absent', () => {
        const result = applyLewdCombatTrigger('bare content', 'always');
        expect(result.startsWith('<lewd_combat_trigger>')).toBe(true);
        expect(result).toContain('bare content');
    });

    it('strips injected blocks without touching the section body', () => {
        const injected = applyLewdCombatTrigger(SECTION, 'always');
        const stripped = stripLewdCombatTrigger(injected);
        expect(stripped).not.toContain('<lewd_combat_trigger>');
        expect(stripped).toBe(SECTION);
        expect(stripped).toBe(stripLewdCombatTrigger(stripped));
        expect(stripLewdCombatTrigger(SECTION)).toBe(SECTION);
    });

    it('applies to a verbatim unlocked override exactly once', () => {
        const unlocked = `<lewd_combat>\nLEWD COMBAT (SECONDARY)\nOld broad wording from an unlocked override.\n</lewd_combat>`;
        const once = applyLewdCombatTrigger(unlocked, 'competitions');
        const twice = applyLewdCombatTrigger(once, 'competitions');
        expect(twice).toBe(once);
        expect(once.match(/<lewd_combat_trigger>/g)).toHaveLength(1);
        expect(once).toContain('Old broad wording from an unlocked override.');
    });
});

describe('shipped lewd sections and assembly', () => {
    it('no longer hard-codes the broad trigger in any shipped source', () => {
        for (const source of [constantsSource, syspromptSource, legacySource]) {
            const normalized = source.replaceAll('\r\n', '\n');
            expect(normalized).toMatch(/<lewd_combat[\s>]/);
            expect(normalized).not.toContain('When the scene becomes intimate and the player initiates, call StartLewdCombat once.');
            expect(normalized).toContain('Whether to call StartLewdCombat is decided by the <lewd_combat_trigger> rule');
        }
        expect(constantsSource.match(/<lewd_combat>/g)).toHaveLength(2);
    });

    it('injects the trigger block for both base and unlocked rows at assembly', () => {
        expect(indexSource).toContain("import { applyLewdCombatTrigger } from './src/features/lewd-combat/lewd-combat-trigger.js';");
        expect(indexSource).toContain('applyLewdCombatTrigger(lewdContent, s.lewdCombatTriggerMode)');
        expect(indexSource).toContain("row.kind === 'base'");
    });
});
