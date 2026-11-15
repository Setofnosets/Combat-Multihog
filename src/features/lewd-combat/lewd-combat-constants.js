/**
 * lewd-combat-constants.js — frozen names for the optional Lewd Combat module.
 *
 * Lewd Combat is a secondary, opt-in board. It is intentionally *not* part of
 * `COMBAT_STYLES`: the primary style selector keeps choosing the board for
 * ordinary hostile fights, while the lewd board is opened independently from
 * the header button or the Combat settings drawer.
 *
 * These key/event names are the U1 contract later units build on. Changing
 * them means migrating saved settings, so treat them as stable.
 */

/** Board style key used by the shared combat-board helpers (not a COMBAT_STYLES entry). */
export const LEWD_COMBAT_STYLE = 'lewd';

/** Per-chat board map in extension settings. */
export const LEWD_BY_CHAT_KEY = 'lewdCombatByChat';

/** Fired after the lewd board for any chat changes (set, remove, reset). */
export const LEWD_CHANGED_EVENT = 'rt_lewd_combat_changed';

/**
 * Fired when the header button or the settings drawer wants the board opened.
 * The board UI (a later unit) listens and calls `preventDefault()` when it
 * actually opens, so the router knows whether a fallback is needed.
 */
export const LEWD_OPEN_EVENT = 'rt_lewd_combat_open';

/** Name reported to the narrator and the open-encounter list. */
export const LEWD_COMBAT_LABEL = 'Lewd Combat';

/**
 * Defaults for the module settings introduced in U1. Values are plain data so
 * `src/state/defaults.js` stays the single persisted source of truth; this map
 * only documents the allowed values and fallbacks.
 */
export const LEWD_COMBAT_DEFAULTS = Object.freeze({
    enabled: false,
    explicitness: 'explicit',
    darkerThemes: false,
    proseFrequency: 'per-exchange',
    roundCap: 12,
    maxPartners: 2,
    postEncounterLatch: true,
    postEncounterCooldownMs: 60000,
});

/**
 * Canonical anatomy tags. These are capability/body descriptors, never inferred
 * from gender or from an assumed default body.
 */
export const LEWD_ANATOMY_TAGS = Object.freeze([
    'penis', 'testes', 'vagina', 'vulva', 'anus', 'breasts', 'tail', 'wings',
    'tentacles', 'knot', 'bondage-gear',
]);

/**
 * Literal anatomy words mapped to their canonical tag. Only these words map;
 * nothing here is derived from gender words such as `female` or `male`.
 */
export const LEWD_ANATOMY_ALIASES = Object.freeze({
    cock: 'penis',
    dick: 'penis',
    balls: 'testes',
    testicles: 'testes',
    pussy: 'vagina',
    cunt: 'vagina',
    anus: 'anus',
    ass: 'anus',
    boobs: 'breasts',
    breast: 'breasts',
    tail: 'tail',
    tails: 'tail',
    wing: 'wings',
    wings: 'wings',
    tentacle: 'tentacles',
    tentacles: 'tentacles',
    restrained: 'bondage-gear',
    restraints: 'bondage-gear',
    'bondage gear': 'bondage-gear',
});

export const LEWD_EXPLICITNESS_OPTIONS = Object.freeze(['explicit', 'suggestive', 'fade-to-black']);

export const LEWD_PROSE_FREQUENCY_OPTIONS = Object.freeze(['off', 'per-exchange', 'per-round', 'climax-only']);
