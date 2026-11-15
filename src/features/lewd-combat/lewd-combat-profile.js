/**
 * lewd-combat-profile.js — the `[LEWD]` profile contract.
 *
 * A profile is *data*: the engine owns all math, the narrator never edits it.
 * Profiles come from three sources, in precedence order:
 *
 *   1. `[LEWD]` memo block — one line per named character.
 *   2. Inline `Lewd:` / `Desires:` / `Sensitive:` / `Limits:` lines inside
 *      `[CHARACTER]`, `[PARTY]`, or `[COMBAT]` entries.
 *   3. `inferProfile(unit, settings)` — neutral, visibly marked `inferred`.
 *
 * Canonical shape (all consumers rely on these names):
 * {
 *   name, role, orientation,
 *   stamina, maxStamina,
 *   maxArousal, maxPoise,
 *   sensitivity: { [zone]: multiplier },   // multiplier over the shipped zone value
 *   preference: { [token]: 'like'|'dislike' },
 *   limits: string[],
 *   endurance, experience,
 *   traits: { stamina?, drain?, maxArousal?, poise?, endurance?, sensitivity?: { [zone]: delta } },
 *   notes, source: 'lewd'|'inline'|'inferred', inferred: boolean, warnings: string[],
 * }
 *
 * Trait semantics (applied exactly once, after base derivation, before clamping):
 * - `stamina+N` / `endurance+N` → add N to max Stamina (clamp 1–6)
 * - `drain-N` → reduce the Stamina cost of a climax by N (never below 1)
 * - `maxArousal+N` → add N to max Arousal (clamp 8–30)
 * - `poise+N` → add N to max Poise (clamp 4–16)
 * - `sensitivity:<zone>+N` → add N × 0.1 to that zone's sensitivity multiplier
 * - `endurance` is the character's baseline endurance stat; the `endurance+N`
 *   trait is a separate modifier and stacks with it by design
 *
 * A bare `sensitivity=neck` (no level) means `high` (1.3) — the attribute is
 * only listed when the character is notably sensitive.
 *
 * Unparseable or unknown zones/traits are ignored and recorded in `warnings`;
 * they never become invented limits or silent stat changes.
 */

import { LEWD_ANATOMY_ALIASES, LEWD_ANATOMY_TAGS } from './lewd-combat-constants.js';

export const LEWD_ZONES = Object.freeze([
    'lips', 'mouth', 'throat', 'neck', 'ears', 'chest', 'breasts', 'nipples',
    'back', 'waist', 'hips', 'groin', 'genitals', 'tail', 'thighs', 'hands',
    'feet', 'full_body',
]);

export const DEFAULT_ZONE_SENSITIVITY = Object.freeze({
    lips: 1.0,
    mouth: 1.3,
    throat: 1.4,
    neck: 1.3,
    ears: 1.2,
    chest: 0.9,
    breasts: 1.3,
    nipples: 1.6,
    back: 0.8,
    waist: 1.0,
    hips: 1.2,
    groin: 1.8,
    genitals: 1.9,
    tail: 1.3,
    thighs: 1.2,
    hands: 0.9,
    feet: 0.7,
    full_body: 1.0,
});

export const LEWD_ROLES = Object.freeze(['dominant', 'submissive', 'switch']);

const ROLE_SYNONYMS = {
    dom: 'dominant',
    dominant: 'dominant',
    top: 'dominant',
    sub: 'submissive',
    submissive: 'submissive',
    bottom: 'submissive',
    switch: 'switch',
    vers: 'switch',
    versatile: 'switch',
};

const SENSITIVITY_LEVELS = {
    low: 0.7,
    medium: 1.0,
    normal: 1.0,
    high: 1.3,
    'very high': 1.6,
    veryhigh: 1.6,
    extreme: 1.8,
};

const ZONE_ALIASES = {
    lip: 'lips',
    neck: 'neck',
    ear: 'ears',
    chest: 'chest',
    breast: 'breasts',
    breasts: 'breasts',
    nipple: 'nipples',
    nipples: 'nipples',
    back: 'back',
    waist: 'waist',
    hip: 'hips',
    hips: 'hips',
    groin: 'groin',
    genital: 'genitals',
    genitals: 'genitals',
    tail: 'tail',
    throat: 'throat',
    mouth: 'mouth',
    thigh: 'thighs',
    thighs: 'thighs',
    hand: 'hands',
    hands: 'hands',
    foot: 'feet',
    feet: 'feet',
    fullbody: 'full_body',
    'full body': 'full_body',
    full_body: 'full_body',
};

const FIELD_ALIASES = {
    name: 'name',
    role: 'role',
    dynamic: 'role',
    'dynamic role': 'role',
    orientation: 'orientation',
    orient: 'orientation',
    sexuality: 'orientation',
    stamina: 'stamina',
    sensitivity: 'sensitivity',
    sensitive: 'sensitivity',
    sensitivities: 'sensitivity',
    zones: 'sensitivity',
    likes: 'likes',
    like: 'likes',
    preference: 'likes',
    preferences: 'likes',
    desires: 'likes',
    dislikes: 'dislikes',
    dislike: 'dislikes',
    aversions: 'dislikes',
    limits: 'limits',
    limit: 'limits',
    boundaries: 'limits',
    'hard limits': 'limits',
    endurance: 'endurance',
    experience: 'experience',
    exp: 'experience',
    skill: 'experience',
    traits: 'traits',
    modifiers: 'traits',
    anatomy: 'anatomy',
    skills: 'skills',
    kinks: 'kinks',
    body: 'body',
    species: 'species',
    notes: 'notes',
    note: 'notes',
};

const NONE_LIMIT_RX = /^(?:none|none declared|no limits?|n\/?a|—|-|nothing)$/i;
const TRAIT_RX = /^(stamina|drain|maxarousal|poise|endurance|sensitivity)\s*(?::\s*([a-z_ ]+))?\s*([+-]\s*\d+(?:\.\d+)?)$/i;

function clamp(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function round2(value) {
    return Math.round(Number(value) * 100) / 100;
}

/** Lower-case, trim, collapse whitespace — the key used for names and lookups. */
export function normalizeLewdName(name) {
    return String(name ?? '').replace(/^[-*+•]\s*/, '').trim().toLowerCase();
}

/** Canonical zone id, or '' when the zone is not part of the shipped set. */
export function normalizeLewdZone(zone) {
    const raw = String(zone ?? '')
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/[^a-z ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';
    const direct = ZONE_ALIASES[raw] || (LEWD_ZONES.includes(raw) ? raw : '');
    return direct || '';
}

/**
 * Canonical anatomy tag, or '' when the word is not one of the literal anatomy
 * words. Never derived from gender or an assumed body.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLewdAnatomy(value) {
    const raw = String(value ?? '')
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/[^a-z ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';
    if (LEWD_ANATOMY_TAGS.includes(raw)) return raw;
    return LEWD_ANATOMY_ALIASES[raw] || '';
}

function normalizeToken(token, { stripNo = false } = {}) {
    let text = String(token ?? '')
        .toLowerCase()
        .replace(/[’']/g, '');
    if (stripNo) text = text.replace(/^no\s+/, '');
    return text
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const CAPABILITY_FIELDS = Object.freeze(['skills', 'sourceSkills', 'kinks', 'sourceTraits', 'anatomy']);

function capabilityTokensFor(participant, fields) {
    const profile = participant?.profile && typeof participant.profile === 'object'
        ? participant.profile
        : {};
    const tokens = new Set();
    for (const field of fields) {
        for (const source of [participant?.[field], profile[field]]) {
            for (const item of asList(source)) {
                const raw = item && typeof item === 'object' ? item.name ?? item.id : item;
                const token = normalizeToken(raw);
                if (token) tokens.add(token);
                // Anatomy aliases (`pussy`, `cock`, `bondage gear`) also match
                // their canonical anatomy tag.
                const anatomy = normalizeLewdAnatomy(raw);
                if (anatomy) tokens.add(anatomy);
            }
        }
    }
    return tokens;
}

/**
 * Every capability token a participant has declared, normalized for matching.
 * Pure: reads plain data and returns a fresh Set. Never infers a body.
 *
 * @param {object} participant
 * @returns {Set<string>}
 */
export function participantCapabilityTokens(participant) {
    return capabilityTokensFor(participant, CAPABILITY_FIELDS);
}

/**
 * True when the participant declares one capability token of the given kind.
 * `kind` accepts `anatomy`, `skill`, `trait`, or `kink`; anything else searches
 * every capability bucket. Pure and case-insensitive.
 *
 * @param {object} participant
 * @param {'anatomy'|'skill'|'trait'|'kink'|string} kind
 * @param {string} token
 * @returns {boolean}
 */
export function hasCapability(participant, kind, token) {
    const field = String(kind ?? '').trim().toLowerCase();
    const fields = field === 'anatomy'
        ? ['anatomy']
        : field === 'skill' || field === 'skills'
            ? ['skills', 'sourceSkills']
            : field === 'trait' || field === 'traits'
                ? ['sourceTraits']
                : field === 'kink' || field === 'kinks'
                    ? ['kinks']
                    : CAPABILITY_FIELDS;
    const tokens = capabilityTokensFor(participant, fields);
    const key = normalizeToken(token);
    if (key && tokens.has(key)) return true;
    const anatomy = normalizeLewdAnatomy(token);
    return !!anatomy && tokens.has(anatomy);
}

/**
 * True only when a participant has a real anatomy declaration. A missing or
 * explicitly-empty anatomy list is unknown; inferred-empty is unknown too.
 * Provenance anatomy keys count as known even if the list is empty.
 *
 * @param {object} participant
 * @returns {boolean}
 */
export function hasKnownAnatomy(participant) {
    const profile = participant?.profile && typeof participant.profile === 'object'
        ? participant.profile
        : {};
    if (asList(participant?.anatomy).length || asList(profile.anatomy).length) return true;
    const provenance = participant?.provenance && typeof participant.provenance === 'object'
        ? participant.provenance
        : profile.provenance && typeof profile.provenance === 'object'
            ? profile.provenance
            : {};
    const anatomyProvenance = provenance.anatomy;
    return !!anatomyProvenance
        && typeof anatomyProvenance === 'object'
        && !Array.isArray(anatomyProvenance)
        && Object.keys(anatomyProvenance).length > 0;
}

function phraseIncludes(haystack, needle) {
    if (!haystack || !needle) return false;
    return ` ${haystack} `.includes(` ${needle} `);
}

function splitList(value) {
    return String(value ?? '')
        .split(/[,;]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function stripBullet(line) {
    return String(line ?? '').replace(/^\s*[-*+•]\s*/, '').trim();
}

function asList(value) {
    if (Array.isArray(value)) return value;
    if (value == null || value === '') return [];
    return splitList(value);
}

/**
 * Canonical, de-duplicated list of tokens. Arrays and comma lists both work, so
 * the function is idempotent for an already-normalized profile.
 */
function normalizeTokenList(value, normalizer = normalizeToken) {
    const seen = new Set();
    const out = [];
    for (const item of asList(value)) {
        const token = normalizer(item);
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push(token);
    }
    return out;
}

/**
 * Readable names (skills, traits) are trimmed but keep their original casing;
 * de-duplication is case-insensitive.
 */
function normalizeNameList(value) {
    const seen = new Set();
    const out = [];
    for (const item of asList(value)) {
        const name = String(item ?? '').trim().slice(0, 80);
        const key = normalizeToken(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(name);
    }
    return out;
}

function extractBlock(memo, tag) {
    const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(memo ?? '').match(new RegExp(`\\[${escaped}\\]\\s*([\\s\\S]*?)\\s*\\[\\/${escaped}\\]`, 'i'));
    return match ? match[1].trim() : '';
}

function fieldKey(raw) {
    const key = String(raw ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
    return FIELD_ALIASES[key] || '';
}

function parseInteger(value, fallback = 0) {
    const match = String(value ?? '').match(/[+-]?\d+/);
    return match ? Number.parseInt(match[0], 10) : fallback;
}

function parseSensitivity(value, warnings, { bareMeansHigh = true } = {}) {
    const map = {};
    for (const item of splitList(value)) {
        let zonePart = item;
        let levelPart = '';
        const colon = item.indexOf(':');
        if (colon >= 0) {
            zonePart = item.slice(0, colon);
            levelPart = item.slice(colon + 1);
        }
        const zone = normalizeLewdZone(zonePart);
        if (!zone) {
            warnings.push(`unknown sensitivity zone "${String(zonePart).trim()}"`);
            continue;
        }
        let multiplier = SENSITIVITY_LEVELS[String(levelPart).trim().toLowerCase()];
        if (multiplier == null && levelPart !== '') {
            const numeric = Number.parseFloat(levelPart);
            multiplier = Number.isFinite(numeric) ? numeric : null;
        }
        if (multiplier == null) multiplier = bareMeansHigh ? SENSITIVITY_LEVELS.high : SENSITIVITY_LEVELS.medium;
        map[zone] = round2(clamp(multiplier, 0.2, 3, 1));
    }
    return map;
}

function parseTraitValue(value, warnings) {
    const traits = {};
    const capabilities = [];
    for (const item of splitList(value)) {
        const token = String(item).trim();
        if (!token) continue;
        const match = token.match(TRAIT_RX);
        if (!match) {
            // A token with no +/- is a capability tag (`tail`, `bondage`), not a
            // malformed modifier. A numeric-looking token is still an error.
            if (/[+-]/.test(token) || /^\d+(?:\.\d+)?$/.test(token)) {
                warnings.push(`unknown trait "${token}"`);
            } else {
                const capability = normalizeToken(token);
                if (capability) capabilities.push(capability);
            }
            continue;
        }
        const key = match[1].toLowerCase();
        const delta = Number.parseFloat(String(match[3]).replace(/\s+/g, ''));
        if (!Number.isFinite(delta)) {
            warnings.push(`unknown trait "${token}"`);
            continue;
        }
        if (key === 'sensitivity') {
            const zone = normalizeLewdZone(match[2]);
            if (!zone) {
                warnings.push(`unknown sensitivity trait zone "${String(match[2] || '').trim()}"`);
                continue;
            }
            if (!traits.sensitivity) traits.sensitivity = {};
            traits.sensitivity[zone] = (traits.sensitivity[zone] || 0) + delta;
            continue;
        }
        const canonical = key === 'maxarousal' ? 'maxArousal' : key;
        traits[canonical] = (traits[canonical] || 0) + delta;
    }
    return { traits, capabilities };
}

function parseTraits(value, warnings) {
    return parseTraitValue(value, warnings).traits;
}

function parseLimits(value) {
    return splitList(value)
        .map(item => item.trim())
        .filter(item => item && !NONE_LIMIT_RX.test(item));
}

function parsePreference(likes, dislikes) {
    const preference = {};
    for (const token of splitList(likes)) {
        const normalized = normalizeToken(token);
        if (normalized && !NONE_LIMIT_RX.test(normalized)) preference[normalized] = 'like';
    }
    for (const token of splitList(dislikes)) {
        const normalized = normalizeToken(token);
        if (normalized && !NONE_LIMIT_RX.test(normalized)) preference[normalized] = 'dislike';
    }
    return preference;
}

/** Parse `sensitivity=` into numeric multipliers over the shipped zone values. */
export function parseSensitivityList(value) {
    return parseSensitivity(value, []);
}

/**
 * Parse `traits=` into a typed modifier map. Unknown traits are dropped.
 * @param {string} value
 * @returns {object}
 */
export function parseLewdTraits(value) {
    return parseTraits(value, []);
}

function normalizeRole(value, warnings) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return 'switch';
    const role = ROLE_SYNONYMS[raw];
    if (!role) {
        warnings.push(`unknown role "${String(value).trim()}"`);
        return 'switch';
    }
    return role;
}

function statsFromUnit(unit) {
    const stats = unit?.stats || unit?.attributes || {};
    const mod = (key) => {
        const modKey = `${key}Mod`;
        if (Number.isFinite(Number(stats[modKey]))) return Number(stats[modKey]);
        const score = Number(stats[key]);
        return Number.isFinite(score) ? Math.floor((score - 10) / 2) : 0;
    };
    return { conMod: mod('con'), wisMod: mod('wis'), chaMod: mod('cha') };
}

function unitSkillNames(unit) {
    return asList(unit?.skills).map(entry =>
        (entry && typeof entry === 'object' ? entry.name ?? entry.id : entry));
}

function cloneProvenance(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
        copy[key] = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? { ...entry }
            : entry;
    }
    return copy;
}

function recordTokenProvenance(provenance, field, tokens, source) {
    if (!tokens.length) return;
    const existing = provenance[field] && typeof provenance[field] === 'object'
        ? { ...provenance[field] }
        : {};
    for (const token of tokens) {
        if (!existing[token]) existing[token] = source;
    }
    provenance[field] = existing;
}

/**
 * Apply profile traits to base derived stats. Pure: the input base and the
 * profile are not mutated, so calling this with the same inputs is idempotent.
 *
 * @param {object} profile
 * @param {{ maxStamina?: number, maxArousal?: number, maxPoise?: number, sensitivity?: Record<string, number>, drain?: number }} [base]
 * @returns {{ maxStamina?: number, maxArousal?: number, maxPoise?: number, sensitivity: Record<string, number>, drain: number }}
 */
export function applyProfileTraits(profile, base = {}) {
    const traits = profile?.traits && typeof profile.traits === 'object' ? profile.traits : {};
    const source = base && typeof base === 'object' ? base : {};
    const result = { ...source, sensitivity: { ...(source.sensitivity || {}) } };

    if (source.maxStamina != null) {
        const staminaDelta = Number(traits.stamina) || 0;
        const enduranceDelta = Number(traits.endurance) || 0;
        result.maxStamina = clamp(Number(source.maxStamina) + staminaDelta + enduranceDelta, 1, 6);
    }
    if (source.maxArousal != null) {
        result.maxArousal = clamp(Number(source.maxArousal) + (Number(traits.maxArousal) || 0), 8, 30);
    }
    if (source.maxPoise != null) {
        result.maxPoise = clamp(Number(source.maxPoise) + (Number(traits.poise) || 0), 4, 16);
    }
    for (const [zone, delta] of Object.entries(traits.sensitivity || {})) {
        const normalized = normalizeLewdZone(zone);
        if (!normalized) continue;
        const current = Number(result.sensitivity[normalized]);
        const baseValue = Number.isFinite(current) ? current : 1;
        result.sensitivity[normalized] = round2(clamp(baseValue + (Number(delta) || 0) * 0.1, 0.2, 3));
    }
    result.drain = (Number(source.drain) || 0) + (Number(traits.drain) || 0);
    return result;
}

/**
 * Build the canonical profile from raw parsed fields.
 * @param {object} fields
 * @param {{ unit?: object, source?: string, warnings?: string[] }} [options]
 * @returns {object}
 */
export function normalizeLewdProfile(fields = {}, options = {}) {
    const warnings = Array.isArray(options.warnings) ? options.warnings : [];
    const name = String(fields.name || options.unit?.name || 'Unknown').trim().slice(0, 80);
    const unit = options.unit || null;
    const mods = statsFromUnit(unit);
    const level = clamp(unit?.level, 1, 30, 1);
    const endurance = clamp(parseInteger(fields.endurance, 0), -3, 5, 0);
    const experience = clamp(parseInteger(fields.experience, 0), 0, 10, 0);
    let traits;
    let traitCapabilities = [];
    if (fields.traits && typeof fields.traits === 'object') {
        traits = fields.traits;
    } else {
        const parsedTraits = parseTraitValue(fields.traits || '', warnings);
        traits = parsedTraits.traits;
        traitCapabilities = parsedTraits.capabilities;
    }

    let baseMaxStamina;
    let stamina = null;
    const staminaText = String(fields.stamina ?? '').trim();
    if (staminaText) {
        const pair = staminaText.match(/(\d+)\s*\/\s*(\d+)/);
        if (pair) {
            baseMaxStamina = clamp(Number(pair[2]), 1, 6, 2);
            stamina = clamp(Number(pair[1]), 0, baseMaxStamina, baseMaxStamina);
        } else {
            const value = clamp(parseInteger(staminaText, 2), 1, 6, 2);
            baseMaxStamina = value;
            stamina = value;
        }
    } else {
        baseMaxStamina = clamp(2 + endurance, 1, 6, 2);
    }

    const baseMaxArousal = clamp(10 + Math.floor(level / 2) + mods.conMod, 8, 30, 10);
    const baseMaxPoise = clamp(6 + mods.wisMod + mods.chaMod, 4, 16, 6);
    const sensitivity = fields.sensitivity && typeof fields.sensitivity === 'object'
        ? { ...fields.sensitivity }
        : parseSensitivity(fields.sensitivity || '', warnings);

    const derived = applyProfileTraits({ traits }, {
        maxStamina: baseMaxStamina,
        maxArousal: baseMaxArousal,
        maxPoise: baseMaxPoise,
        sensitivity,
        drain: 0,
    });

    const preference = {
        ...parsePreference(fields.likes, fields.dislikes),
        ...(fields.preference && typeof fields.preference === 'object' ? fields.preference : {}),
    };

    const anatomy = normalizeTokenList([
        ...asList(fields.anatomy),
        ...traitCapabilities,
    ], normalizeLewdAnatomy);
    const skills = normalizeTokenList(fields.skills);
    const kinks = normalizeTokenList(fields.kinks);
    const sourceSkills = normalizeNameList([
        ...unitSkillNames(unit),
        ...asList(fields.sourceSkills),
        ...asList(options.sourceSkills),
    ]);
    const sourceTraits = normalizeTokenList([
        ...asList(fields.sourceTraits),
        ...traitCapabilities,
        ...asList(options.sourceTraits),
    ]);
    const body = String(fields.body ?? '').trim().slice(0, 300);
    const species = String(fields.species ?? '').trim().slice(0, 80);
    const provenance = cloneProvenance(fields.provenance);
    const sourceBucket = String(options.source || fields.source || 'lewd');
    recordTokenProvenance(provenance, 'anatomy', anatomy, sourceBucket);
    recordTokenProvenance(provenance, 'skills', skills, sourceBucket);
    recordTokenProvenance(provenance, 'kinks', kinks, sourceBucket);
    if (body && !provenance.body) provenance.body = sourceBucket;
    if (species && !provenance.species) provenance.species = sourceBucket;
    const inferredFields = Array.isArray(fields.inferredFields)
        ? [...new Set(fields.inferredFields.map(String).filter(Boolean))]
        : [];

    return {
        name,
        role: fields.role && LEWD_ROLES.includes(String(fields.role))
            ? String(fields.role)
            : normalizeRole(fields.role, warnings),
        orientation: String(fields.orientation ?? '').trim().slice(0, 80),
        stamina: stamina == null ? derived.maxStamina : clamp(stamina, 0, derived.maxStamina, derived.maxStamina),
        maxStamina: derived.maxStamina,
        maxArousal: derived.maxArousal,
        maxPoise: derived.maxPoise,
        sensitivity: derived.sensitivity,
        preference,
        limits: Array.isArray(fields.limits) ? fields.limits.map(limit => String(limit).trim()).filter(Boolean) : parseLimits(fields.limits),
        endurance,
        experience,
        traits,
        drain: derived.drain,
        notes: String(fields.notes ?? '').trim().slice(0, 500),
        anatomy,
        skills,
        kinks,
        sourceSkills,
        sourceTraits,
        body,
        species,
        provenance,
        inferredFields,
        source: String(options.source || fields.source || 'lewd'),
        inferred: options.source === 'inferred' || fields.inferred === true,
        warnings,
    };
}

const PROFILE_SKILL_WORDS = Object.freeze([
    'bondage', 'ropework', 'shibari', 'restraint', 'seduction', 'teasing',
    'massage', 'oral', 'penetration',
]);

const PROFILE_KINK_WORDS = Object.freeze([
    'bondage', 'praise', 'teasing', 'tail', 'tentacles', 'submission', 'dominance',
]);

function cardText(card) {
    if (!card) return '';
    if (typeof card === 'string') return card;
    return [card.description, card.personality, card.scenario, card.mes_example, card.example_dialogue]
        .map(entry => String(entry ?? ''))
        .filter(Boolean)
        .join('\n');
}

function wordsOf(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[’']/g, '')
        .split(/[^a-z]+/)
        .filter(Boolean);
}

function wordSet(value) {
    return new Set(wordsOf(value));
}

function includesWord(set, word) {
    if (!set || !word) return false;
    return set.has(word) || set.has(`${word}s`);
}

function labeledValues(value, labels) {
    const source = String(value ?? '');
    if (!source) return [];
    const escaped = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const rx = new RegExp(`^[\\s*•+-]*(?:${escaped})\\s*:\\s*(.+)$`, 'gim');
    const out = [];
    let match;
    while ((match = rx.exec(source))) out.push(match[1].trim());
    return out;
}

function labeledValue(value, labels) {
    const values = labeledValues(value, labels);
    return values.length ? values[0].split(/[|;]/)[0].trim() : '';
}

function anatomyTokensIn(value) {
    const found = [];
    const text = String(value ?? '');
    for (const word of new Set(wordsOf(text))) {
        const tag = normalizeLewdAnatomy(word);
        if (tag && !found.includes(tag)) found.push(tag);
    }
    if (/bondage[-\s]?gear/i.test(text) && !found.includes('bondage-gear')) {
        found.push('bondage-gear');
    }
    return found;
}

/**
 * Read the tracker lines that belong to one character. Header rules match the
 * inline-profile reader, so another combatant's lines are never returned.
 *
 * @param {string} memo
 * @param {string} name
 * @returns {string}
 */
export function extractProfileSourceText(memo, name) {
    const key = normalizeLewdName(name);
    if (!key) return '';
    const sections = [];
    for (const tag of ['CHARACTER', 'PARTY', 'COMBAT']) {
        const content = extractBlock(memo, tag);
        if (!content) continue;
        let currentName = tag === 'CHARACTER' ? '{{user}}' : '';
        let lines = [];
        const flush = () => {
            if (currentName && normalizeLewdName(currentName) === key && lines.length) {
                sections.push(lines.join('\n'));
            }
            lines = [];
        };
        for (const line of content.split(/\r?\n/)) {
            const cleaned = stripBullet(line);
            if (!cleaned) continue;
            if (/^(?:enemies|non-party allies|allies|party)\s*:/i.test(cleaned)) {
                flush();
                currentName = '';
                continue;
            }
            const header = cleaned.match(CHARACTER_HEADER_RX);
            if (header) {
                flush();
                currentName = header[1].trim();
                continue;
            }
            if (!currentName) continue;
            lines.push(cleaned);
        }
        flush();
    }
    return sections.join('\n').trim();
}

/**
 * Collect anatomy/skill/kink/body/species signals from every supplied source.
 * Pure: it reads plain data only and never touches state or the network.
 *
 * @param {{ unit?: object, card?: object|string, trackerText?: string, lorebookText?: string, notes?: string }} [sources]
 * @returns {{ anatomy: string[], skills: string[], kinks: string[], body: string, species: string, provenance: object }}
 */
export function collectProfileSignals(sources = {}) {
    const unit = sources.unit && typeof sources.unit === 'object' ? sources.unit : {};
    const trackerText = String(sources.trackerText ?? '');
    const lorebookText = String(sources.lorebookText ?? '');
    const notes = String(sources.notes ?? '');
    const cardValue = sources.card;
    const cardSource = cardText(cardValue);
    const unitText = [
        unit.description,
        unit.appearance,
        unit.personality,
        unit.notes,
        notes,
    ].map(entry => String(entry ?? '')).filter(Boolean).join('\n');

    const buckets = [
        { source: 'unit', text: unitText },
        { source: 'card', text: cardSource },
        { source: 'tracker', text: trackerText },
        { source: 'lorebook', text: lorebookText },
    ];

    const anatomy = [];
    const anatomySource = {};
    const skills = [];
    const skillSource = {};
    const kinks = [];
    const kinkSource = {};

    const add = (list, map, token, source) => {
        if (!token) return;
        if (!list.includes(token)) list.push(token);
        if (!map[token]) map[token] = source;
    };

    for (const bucket of buckets) {
        if (!bucket.text) continue;
        for (const tag of anatomyTokensIn(bucket.text)) add(anatomy, anatomySource, tag, bucket.source);

        const words = wordSet(bucket.text);
        for (const word of PROFILE_SKILL_WORDS) {
            if (includesWord(words, word)) add(skills, skillSource, word, bucket.source);
        }
        for (const word of PROFILE_KINK_WORDS) {
            if (includesWord(words, word)) add(kinks, kinkSource, word, bucket.source);
        }
        for (const value of labeledValues(bucket.text, ['skills', 'abilities'])) {
            for (const token of splitList(value)) {
                add(skills, skillSource, normalizeToken(token), bucket.source);
            }
        }
    }

    for (const token of asList(unit.anatomy)) {
        add(anatomy, anatomySource, normalizeLewdAnatomy(token), 'unit');
    }
    // Capability traits are signals, not engine modifiers.
    for (const token of asList(unit.traits)) {
        const text = token && typeof token === 'object' ? token.name ?? token.id : token;
        const tag = normalizeLewdAnatomy(text);
        if (tag) add(anatomy, anatomySource, tag, 'unit');
    }
    // `unit.skills` are source names, not engine skill tags: they are carried
    // into `sourceSkills` by `normalizeLewdProfile`, never into `skills`.

    let body = '';
    let bodySource = '';
    for (const bucket of buckets) {
        const found = labeledValue(bucket.text, ['body', 'appearance']);
        if (found) {
            body = found;
            bodySource = bucket.source;
            break;
        }
    }
    if (!body && cardValue) {
        const fallback = (typeof cardValue === 'string' ? cardValue : String(cardValue.description ?? '')).trim();
        if (fallback) {
            body = fallback.slice(0, 200);
            bodySource = 'card';
        }
    }

    let species = '';
    let speciesSource = '';
    for (const bucket of buckets) {
        const found = labeledValue(bucket.text, ['species', 'race']);
        if (found) {
            species = found;
            speciesSource = bucket.source;
            break;
        }
    }
    if (!species && cardSource) {
        const match = cardSource.match(/\b(?:species|race)\s*(?:is|:)\s*([a-z][a-z' -]{2,40})/i);
        if (match) {
            species = match[1].trim();
            speciesSource = 'card';
        }
    }

    const provenance = {};
    if (anatomy.length) provenance.anatomy = anatomySource;
    if (skills.length) provenance.skills = skillSource;
    if (kinks.length) provenance.kinks = kinkSource;
    if (body) provenance.body = bodySource;
    if (species) provenance.species = speciesSource;

    return { anatomy, skills, kinks, body, species, provenance };
}

function applySignalsToInferredProfile(unit, signals, options = {}) {
    const profile = normalizeLewdProfile({ name: unit?.name || 'Unknown' }, {
        unit,
        source: 'inferred',
        sourceTraits: options.sourceTraits,
    });
    const anatomy = normalizeTokenList([...profile.anatomy, ...signals.anatomy], normalizeLewdAnatomy);
    const skills = normalizeTokenList([...profile.skills, ...signals.skills]);
    const kinks = normalizeTokenList([...profile.kinks, ...signals.kinks]);
    const body = profile.body || signals.body;
    const species = profile.species || signals.species;
    const provenance = cloneProvenance(profile.provenance);

    for (const field of ['anatomy', 'skills', 'kinks']) {
        const tokens = field === 'anatomy' ? anatomy : field === 'skills' ? skills : kinks;
        const signalMap = signals.provenance?.[field];
        if (!signalMap) continue;
        const map = provenance[field] && typeof provenance[field] === 'object'
            ? { ...provenance[field] }
            : {};
        for (const token of tokens) {
            if (signalMap[token]) map[token] = signalMap[token];
        }
        if (Object.keys(map).length) provenance[field] = map;
    }
    if (signals.body && body === signals.body) {
        provenance.body = signals.provenance?.body || 'inferred';
    }
    if (signals.species && species === signals.species) {
        provenance.species = signals.provenance?.species || 'inferred';
    }

    const inferredFields = [];
    if (signals.anatomy.length) inferredFields.push('anatomy');
    if (signals.skills.length) inferredFields.push('skills');
    if (signals.kinks.length) inferredFields.push('kinks');
    if (signals.body) inferredFields.push('body');
    if (signals.species) inferredFields.push('species');

    return {
        ...profile,
        anatomy,
        skills,
        kinks,
        body: String(body ?? '').slice(0, 300),
        species: String(species ?? '').slice(0, 80),
        provenance,
        inferredFields: [...new Set([...profile.inferredFields, ...inferredFields])],
        inferred: true,
        source: 'inferred',
    };
}

/**
 * Build an inferred profile from a unit plus optional card/tracker/lorebook
 * sources. Never invents a limit; inference only adds capability tags.
 *
 * @param {object} [unit]
 * @param {{ unit?: object, card?: object|string, trackerText?: string, lorebookText?: string, notes?: string }} [sources]
 * @returns {object}
 */
export function inferProfileFromSources(unit = {}, sources = {}) {
    const baseUnit = sources.unit && typeof sources.unit === 'object' ? sources.unit : unit;
    const signals = collectProfileSignals({
        unit: baseUnit,
        card: sources.card,
        trackerText: sources.trackerText,
        lorebookText: sources.lorebookText,
        notes: sources.notes ?? baseUnit?.notes,
    });
    // Capability words on `unit.traits` are source tags, never engine modifiers.
    const sourceTraits = asList(baseUnit?.traits)
        .map(entry => (entry && typeof entry === 'object' ? entry.name ?? entry.id : entry))
        .map(normalizeToken)
        .filter(Boolean);
    return applySignalsToInferredProfile(baseUnit, signals, { sourceTraits });
}

/**
 * Merge an inferred signal set into an explicit profile. The explicit profile
 * wins for body/species and duplicate tokens; inference only fills gaps and
 * records lower-priority provenance. Pure: returns a new object.
 *
 * @param {object} profile
 * @param {object} inferred
 * @returns {object}
 */
export function mergeProfileInference(profile, inferred = {}) {
    const base = profile && typeof profile === 'object' ? profile : {};
    const extra = inferred && typeof inferred === 'object' ? inferred : {};
    const anatomy = normalizeTokenList([...asList(base.anatomy), ...asList(extra.anatomy)], normalizeLewdAnatomy);
    const skills = normalizeTokenList([...asList(base.skills), ...asList(extra.skills)]);
    const kinks = normalizeTokenList([...asList(base.kinks), ...asList(extra.kinks)]);
    const body = String(base.body ?? '').trim() || String(extra.body ?? '').trim();
    const species = String(base.species ?? '').trim() || String(extra.species ?? '').trim();

    const provenance = cloneProvenance(extra.provenance);
    const baseProvenance = base.provenance && typeof base.provenance === 'object' ? base.provenance : {};
    for (const field of ['anatomy', 'skills', 'kinks']) {
        const map = baseProvenance[field];
        if (!map || typeof map !== 'object') continue;
        const mergedMap = provenance[field] && typeof provenance[field] === 'object'
            ? { ...provenance[field] }
            : {};
        for (const [token, source] of Object.entries(map)) mergedMap[token] = source;
        provenance[field] = mergedMap;
    }
    if (base.body) provenance.body = baseProvenance.body || 'lewd';
    else if (extra.body) provenance.body = extra.provenance?.body || 'inferred';
    if (base.species) provenance.species = baseProvenance.species || 'lewd';
    else if (extra.species) provenance.species = extra.provenance?.species || 'inferred';

    const inferredFields = [...new Set([
        ...(Array.isArray(base.inferredFields) ? base.inferredFields : []),
        ...(Array.isArray(extra.inferredFields) ? extra.inferredFields : []),
    ])];

    return {
        ...extra,
        ...base,
        anatomy,
        skills,
        kinks,
        body,
        species,
        provenance,
        inferredFields,
        sourceSkills: normalizeNameList([...asList(base.sourceSkills), ...asList(extra.sourceSkills)]),
        sourceTraits: normalizeTokenList([...asList(base.sourceTraits), ...asList(extra.sourceTraits)]),
    };
}

/**
 * Neutral profile for a character with no `[LEWD]` entry. Derived from CON/WIS/
 * CHA and level; never invents a hard limit and is always marked inferred.
 * The optional third argument lets callers feed card/tracker/lorebook text
 * through the same signal collector as `inferProfileFromSources`.
 *
 * @param {object} unit
 * @param {Record<string, any>} [settings]
 * @param {{ card?: object|string, trackerText?: string, lorebookText?: string, notes?: string }} [sources]
 * @returns {object}
 */
export function inferProfile(unit = {}, settings = {}, sources = {}) {
    void settings;
    return inferProfileFromSources(unit, sources);
}

/**
 * Final max Stamina from a canonical profile. Traits were already folded in by
 * `normalizeLewdProfile`, so this is a read, not a second application.
 * @param {object} profile
 * @returns {number}
 */
export function maxStaminaFromProfile(profile) {
    const max = Number(profile?.maxStamina);
    if (Number.isFinite(max)) return clamp(max, 1, 6, 2);
    const traits = profile?.traits && typeof profile.traits === 'object' ? profile.traits : {};
    return clamp(
        2 + (Number(profile?.endurance) || 0) + (Number(traits.stamina) || 0) + (Number(traits.endurance) || 0),
        1,
        6,
        2,
    );
}

/**
 * Zone sensitivity multiplier: shipped zone value × the character's modifier.
 * @param {object} profile
 * @param {string} zone
 * @returns {number}
 */
export function zoneMultiplier(profile, zone) {
    const normalized = normalizeLewdZone(zone);
    if (!normalized) return 1;
    const base = Number(DEFAULT_ZONE_SENSITIVITY[normalized]);
    const modifier = Number(profile?.sensitivity?.[normalized]);
    const safeBase = Number.isFinite(base) ? base : 1;
    const safeModifier = Number.isFinite(modifier) && modifier > 0 ? modifier : 1;
    return round2(safeBase * safeModifier);
}

/**
 * Like/dislike multiplier for a tag or zone token.
 * @param {object} profile
 * @param {string} token
 * @returns {number}
 */
export function preferenceMultiplier(profile, token) {
    const normalized = normalizeToken(token);
    if (!normalized) return 1;
    const preference = profile?.preference?.[normalized];
    if (preference === 'like') return 1.25;
    if (preference === 'dislike') return 0.5;
    return 1;
}

/**
 * Return the first hard limit that blocks any of the supplied tags/zones.
 * @param {object} profile
 * @param {string|string[]} tagsOrZones
 * @returns {string} the blocking limit (original text), or ''
 */
export function isBlockedByLimits(profile, tagsOrZones) {
    const limits = Array.isArray(profile?.limits) ? profile.limits : [];
    if (!limits.length) return '';
    const candidates = (Array.isArray(tagsOrZones) ? tagsOrZones : [tagsOrZones])
        .map(token => normalizeToken(token, { stripNo: true }))
        .filter(Boolean);
    for (const limit of limits) {
        const normalizedLimit = normalizeToken(limit, { stripNo: true });
        if (!normalizedLimit) continue;
        for (const candidate of candidates) {
            if (candidate === normalizedLimit
                || phraseIncludes(candidate, normalizedLimit)
                || phraseIncludes(normalizedLimit, candidate)) {
                return String(limit).trim();
            }
        }
    }
    return '';
}

function parseKeyValueFields(body, warnings) {
    const fields = {};
    for (const segment of String(body ?? '').split(/\s*[|;]\s*/)) {
        const equals = segment.indexOf('=');
        if (equals < 0) continue;
        const key = fieldKey(segment.slice(0, equals));
        if (!key) {
            warnings.push(`unknown profile field "${segment.slice(0, equals).trim()}"`);
            continue;
        }
        const value = segment.slice(equals + 1).trim();
        if (key === 'name') {
            fields.name = value;
        } else if (key === 'sensitivity') {
            const parsed = parseSensitivity(value, warnings);
            fields.sensitivity = { ...(fields.sensitivity || {}), ...parsed };
        } else if (key === 'traits') {
            const parsed = parseTraitValue(value, warnings);
            fields.traits = { ...(fields.traits || {}) };
            for (const [traitKey, delta] of Object.entries(parsed.traits)) {
                if (traitKey === 'sensitivity') {
                    fields.traits.sensitivity = { ...(fields.traits.sensitivity || {}), ...delta };
                } else {
                    fields.traits[traitKey] = (fields.traits[traitKey] || 0) + delta;
                }
            }
            if (parsed.capabilities.length) {
                fields.sourceTraits = [...asList(fields.sourceTraits), ...parsed.capabilities];
                const traitAnatomy = parsed.capabilities
                    .map(capability => normalizeLewdAnatomy(capability))
                    .filter(Boolean);
                if (traitAnatomy.length) {
                    fields.anatomy = [...asList(fields.anatomy), ...traitAnatomy];
                }
            }
        } else if (key === 'likes' || key === 'dislikes') {
            fields[key] = value;
        } else {
            fields[key] = value;
        }
    }
    return fields;
}

/**
 * Parse one `[LEWD]` line: `Name: role=... | sensitivity=... | ...`
 * @param {string} line
 * @param {{ warnings?: string[], source?: string }} [options]
 * @returns {object|null} raw fields (feed to `normalizeLewdProfile`)
 */
export function parseLewdProfileLine(line, options = {}) {
    const text = stripBullet(line);
    if (!text || text.startsWith('#')) return null;
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    const warnings = Array.isArray(options.warnings) ? options.warnings : [];
    let name = text.slice(0, colon).trim();
    const fields = parseKeyValueFields(text.slice(colon + 1), warnings);
    if (fields.name) name = fields.name;
    if (!name) return null;
    return { ...fields, name, source: options.source || 'lewd', warnings };
}

function mergeRawProfile(target, incoming) {
    const merged = { ...target, ...incoming };
    merged.sensitivity = { ...(target.sensitivity || {}), ...(incoming.sensitivity || {}) };
    merged.preference = { ...(target.preference || {}), ...(incoming.preference || {}) };
    if (target.traits || incoming.traits) {
        const targetTraits = target.traits && typeof target.traits === 'object' ? target.traits : {};
        const incomingTraits = incoming.traits && typeof incoming.traits === 'object' ? incoming.traits : {};
        merged.traits = { ...targetTraits, ...incomingTraits };
        if (targetTraits.sensitivity || incomingTraits.sensitivity) {
            merged.traits.sensitivity = {
                ...(targetTraits.sensitivity || {}),
                ...(incomingTraits.sensitivity || {}),
            };
        }
    }
    const targetLimits = Array.isArray(target.limits) ? target.limits : splitList(target.limits);
    const incomingLimits = Array.isArray(incoming.limits) ? incoming.limits : splitList(incoming.limits);
    merged.limits = [...new Set([...targetLimits, ...incomingLimits])];
    for (const listKey of ['anatomy', 'skills', 'kinks', 'sourceTraits', 'sourceSkills']) {
        if (target[listKey] == null && incoming[listKey] == null) continue;
        merged[listKey] = [...new Set([...asList(target[listKey]), ...asList(incoming[listKey])])];
    }
    merged.warnings = [...(target.warnings || []), ...(incoming.warnings || [])];
    return merged;
}

function parseLewdMemoBlock(memo, warnings) {
    const content = extractBlock(memo, 'LEWD');
    const rawProfiles = new Map();
    if (!content) return rawProfiles;
    for (const line of content.split(/\r?\n/)) {
        const lineWarnings = [];
        const parsed = parseLewdProfileLine(line, { warnings: lineWarnings, source: 'lewd' });
        if (!parsed) continue;
        warnings.push(...lineWarnings);
        const key = normalizeLewdName(parsed.name);
        if (!key) continue;
        if (rawProfiles.has(key)) {
            warnings.push(`duplicate [LEWD] entry for "${parsed.name}" — later values win`);
            rawProfiles.set(key, mergeRawProfile(rawProfiles.get(key), parsed));
        } else {
            rawProfiles.set(key, parsed);
        }
    }
    return rawProfiles;
}

const CHARACTER_HEADER_RX = /^(.+?)(?:\s*\([^)]*\))?\s*:\s*[\d?]+\s*\/\s*[\d?]+\s*HP\b/i;

function parseInlineLines(memo, warnings) {
    const rawProfiles = new Map();
    for (const tag of ['CHARACTER', 'PARTY', 'COMBAT']) {
        const content = extractBlock(memo, tag);
        if (!content) continue;
        let currentName = tag === 'CHARACTER' ? '{{user}}' : '';
        for (const line of content.split(/\r?\n/)) {
            const cleaned = stripBullet(line);
            if (!cleaned) continue;
            const header = cleaned.match(CHARACTER_HEADER_RX);
            if (header && !/^(?:enemies|non-party allies|allies|party)\s*:/i.test(cleaned)) {
                currentName = header[1].trim();
                continue;
            }
            if (!currentName) continue;
            const inline = cleaned.match(/^(Lewd|Desires|Sensitive|Limits)\s*:\s*(.+)$/i);
            if (!inline) continue;
            const key = normalizeLewdName(currentName);
            const existing = rawProfiles.get(key) || { name: currentName, source: 'inline', warnings: [] };
            const label = inline[1].toLowerCase();
            const value = inline[2].trim();
            const lineWarnings = [];
            if (label === 'lewd') {
                const fields = parseKeyValueFields(value, lineWarnings);
                rawProfiles.set(key, mergeRawProfile(existing, {
                    ...fields,
                    name: fields.name || existing.name,
                    source: 'inline',
                    warnings: lineWarnings,
                }));
            } else if (label === 'desires') {
                const likes = [existing.likes, value].filter(Boolean).join(', ');
                rawProfiles.set(key, mergeRawProfile(existing, { likes, source: 'inline', warnings: lineWarnings }));
            } else if (label === 'sensitive') {
                const sensitivity = parseSensitivity(value, lineWarnings, { bareMeansHigh: true });
                rawProfiles.set(key, mergeRawProfile(existing, { sensitivity, source: 'inline', warnings: lineWarnings }));
            } else if (label === 'limits') {
                const existingLimits = Array.isArray(existing.limits) ? existing.limits : splitList(existing.limits);
                const limits = [...existingLimits, ...parseLimits(value)];
                rawProfiles.set(key, mergeRawProfile(existing, { limits, source: 'inline', warnings: lineWarnings }));
            }
            warnings.push(...lineWarnings);
        }
    }
    return rawProfiles;
}

/**
 * Resolve a character card by name. Accepts a map (`{ [name]: card }`), an
 * array of cards, or a single card. Matching is case-insensitive.
 *
 * @param {object|Array<object>|Record<string, object>|null} cards
 * @param {string} name
 * @returns {object|string|null}
 */
export function findProfileCard(cards, name) {
    if (!cards || typeof cards === 'string') return null;
    const key = normalizeLewdName(name);
    if (!key) return null;
    if (Array.isArray(cards)) {
        return cards.find(card => normalizeLewdName(card?.name) === key) || null;
    }
    if (typeof cards !== 'object') return null;
    for (const [cardKey, card] of Object.entries(cards)) {
        if (!card) continue;
        const cardName = typeof card === 'object' ? card.name : '';
        if (normalizeLewdName(cardKey) === key || normalizeLewdName(cardName) === key) return card;
    }
    return null;
}

/**
 * Parse explicit lewd profiles (no inferred entries) from the memo.
 *
 * Optional `cards`/`card`/`lorebookText` sources enrich every explicit profile
 * through `inferProfileFromSources` + `mergeProfileInference`; explicit
 * `[LEWD]` values keep their own provenance and win duplicate tokens.
 *
 * @param {string} memo
 * @param {Record<string, any>} [settings]
 * @param {{ units?: Array<object>, cards?: object, card?: object|string, lorebookText?: string }} [options]
 * @returns {Record<string, object>} keyed by `normalizeLewdName(profile.name)`
 */
export function parseLewdProfiles(memo, settings = {}, options = {}) {
    void settings;
    const warnings = [];
    const explicit = parseLewdMemoBlock(memo, warnings);
    const inline = parseInlineLines(memo, warnings);
    const unitsByName = new Map();
    for (const unit of options.units || []) {
        const key = normalizeLewdName(unit?.name);
        if (key) unitsByName.set(key, unit);
    }
    const cards = options.cards || null;
    const lorebookText = String(options.lorebookText ?? '');

    const enrich = (profile) => {
        const key = normalizeLewdName(profile.name);
        const unit = unitsByName.get(key) || null;
        const matchingCard = findProfileCard(cards, profile.name)
            || (options.card && normalizeLewdName(options.card?.name) === key ? options.card : null);
        const inferred = inferProfileFromSources(unit || { name: profile.name }, {
            card: matchingCard,
            trackerText: extractProfileSourceText(memo, profile.name),
            lorebookText,
        });
        return mergeProfileInference(profile, inferred);
    };

    const profiles = {};
    for (const [key, raw] of explicit) {
        // `[LEWD]` wins over inline lines for the same character.
        profiles[key] = enrich(normalizeLewdProfile(raw, {
            unit: unitsByName.get(key),
            source: 'lewd',
            warnings: [...(raw.warnings || [])],
        }));
    }
    for (const [key, raw] of inline) {
        if (profiles[key]) continue;
        profiles[key] = enrich(normalizeLewdProfile(raw, {
            unit: unitsByName.get(key),
            source: 'inline',
            warnings: [...(raw.warnings || [])],
        }));
    }
    if (warnings.length) {
        console.warn('[RPG Tracker] Lewd Combat profile warnings:', warnings);
    }
    return profiles;
}

/**
 * Case-insensitive profile lookup.
 * @param {Record<string, object>} profiles
 * @param {string} name
 * @returns {object|null}
 */
export function findLewdProfile(profiles, name) {
    const key = normalizeLewdName(name);
    if (!key) return null;
    return profiles?.[key] || null;
}

/**
 * Profile for a participant: explicit memo profile, else neutral inferred.
 * @param {Record<string, object>} profiles
 * @param {object} unit
 * @param {Record<string, any>} [settings]
 * @returns {object}
 */
export function resolveLewdProfile(profiles, unit, settings = {}) {
    return findLewdProfile(profiles, unit?.name) || inferProfile(unit, settings);
}
