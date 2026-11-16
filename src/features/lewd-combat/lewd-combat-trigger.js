/**
 * lewd-combat-trigger.js — mode-aware narrator trigger rule for Lewd Combat.
 *
 * The shipped `<lewd_combat>` section describes the board but no longer owns
 * the call decision. This module builds the short `<lewd_combat_trigger>`
 * block that `buildSysprompt()` injects immediately after `<lewd_combat>` for
 * both base and unlocked/verbatim rows.
 *
 * The helper is pure: no RNG, no settings mutation, no DOM. `applyLewdCombatTrigger`
 * is idempotent — it strips any previously injected block before adding a fresh
 * one, so repeated assembly never duplicates instructions.
 */

import { resolveLewdCombatTriggerMode } from './lewd-combat-constants.js';

const TRIGGER_BLOCK_PATTERN = /<lewd_combat_trigger>[\s\S]*?<\/lewd_combat_trigger>\r?\n?/gi;
const OPEN_TAG_PATTERN = /<lewd_combat>/i;

/** Instruction text for each trigger mode. */
export const LEWD_COMBAT_TRIGGER_INSTRUCTIONS = Object.freeze({
    always: [
        'TRIGGER RULE (ALWAYS). When the scene becomes intimate and the player initiates, call StartLewdCombat once.',
        'Do not narrate the intimate contest yourself; the board resolves it and returns the authoritative aftermath.',
        'This rule overrides any broader or narrower trigger wording in the enclosing <lewd_combat> section.',
    ].join(' '),
    competitions: [
        'TRIGGER RULE (COMPETITIONS ONLY): call StartLewdCombat ONLY when the player initiates an intimate competition — a contest with stakes and a winner such as a struggle for dominance, a wager, a challenge, or a duel of technique.',
        'Routine intimacy, affection, flirting, kissing, and casual acts must be narrated normally; do not open the board for them.',
        'When you call the tool for a genuine competition, pass isContest=true. If you are unsure whether the moment is a real competition, do not call the tool; narrate it normally instead.',
        'This rule overrides any broader trigger wording in the enclosing <lewd_combat> section.',
    ].join(' '),
});

/**
 * Build the inner instruction for a trigger mode.
 * @param {any} mode
 * @returns {string}
 */
export function buildLewdCombatTriggerInstruction(mode) {
    return LEWD_COMBAT_TRIGGER_INSTRUCTIONS[resolveLewdCombatTriggerMode(mode)];
}

/**
 * Remove every previously injected trigger block from a section body.
 * @param {string} content
 * @returns {string}
 */
export function stripLewdCombatTrigger(content) {
    return String(content ?? '').replace(TRIGGER_BLOCK_PATTERN, '');
}

/**
 * Inject the mode-aware trigger block immediately after the first
 * `<lewd_combat>` open tag (or prepend it when the tag is absent). Any prior
 * trigger block is removed first, keeping the result idempotent.
 *
 * @param {string} content
 * @param {any} mode
 * @returns {string}
 */
export function applyLewdCombatTrigger(content, mode) {
    const source = String(content ?? '');
    if (!source.trim()) return source;
    const stripped = stripLewdCombatTrigger(source);
    const block = `<lewd_combat_trigger>\n${buildLewdCombatTriggerInstruction(mode)}\n</lewd_combat_trigger>`;
    const openTag = stripped.match(OPEN_TAG_PATTERN);
    if (!openTag) return `${block}\n\n${stripped}`;
    // `stripLewdCombatTrigger` consumes the newline the injector itself adds, so
    // re-running with the same mode reproduces the same bytes and any original
    // blank line inside a user override stays intact.
    const index = stripped.indexOf(openTag[0]) + openTag[0].length;
    const head = stripped.slice(0, index);
    const tail = stripped.slice(index);
    return `${head}\n${block}${tail}`;
}
