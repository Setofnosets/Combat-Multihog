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

export const LEWD_ZONES = Object.freeze([
    'lips', 'neck', 'ears', 'chest', 'breasts', 'nipples', 'back', 'waist',
    'hips', 'groin', 'thighs', 'hands', 'feet', 'full_body',
]);

export const DEFAULT_ZONE_SENSITIVITY = Object.freeze({
    lips: 1.0,
    neck: 1.3,
    ears: 1.2,
    chest: 0.9,
    breasts: 1.3,
    nipples: 1.6,
    back: 0.8,
    waist: 1.0,
    hips: 1.2,
    groin: 1.8,
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

function parseTraits(value, warnings) {
    const traits = {};
    for (const item of splitList(value)) {
        const match = String(item).trim().match(TRAIT_RX);
        if (!match) {
            warnings.push(`unknown trait "${String(item).trim()}"`);
            continue;
        }
        const key = match[1].toLowerCase();
        const delta = Number.parseFloat(String(match[3]).replace(/\s+/g, ''));
        if (!Number.isFinite(delta)) {
            warnings.push(`unknown trait "${String(item).trim()}"`);
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
    return traits;
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
    const traits = fields.traits && typeof fields.traits === 'object'
        ? fields.traits
        : parseTraits(fields.traits || '', warnings);

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
        source: String(options.source || fields.source || 'lewd'),
        inferred: options.source === 'inferred' || fields.inferred === true,
        warnings,
    };
}

/**
 * Neutral profile for a character with no `[LEWD]` entry. Derived from CON/WIS/
 * CHA and level; never invents a hard limit and is always marked inferred.
 * @param {object} unit
 * @param {Record<string, any>} [settings]
 * @returns {object}
 */
export function inferProfile(unit = {}, settings = {}) {
    void settings;
    return normalizeLewdProfile({ name: unit?.name || 'Unknown' }, { unit, source: 'inferred' });
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
            const parsed = parseTraits(value, warnings);
            fields.traits = { ...(fields.traits || {}) };
            for (const [traitKey, delta] of Object.entries(parsed)) {
                if (traitKey === 'sensitivity') {
                    fields.traits.sensitivity = { ...(fields.traits.sensitivity || {}), ...delta };
                } else {
                    fields.traits[traitKey] = (fields.traits[traitKey] || 0) + delta;
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
 * Parse explicit lewd profiles (no inferred entries) from the memo.
 *
 * @param {string} memo
 * @param {Record<string, any>} [settings]
 * @param {{ units?: Array<object> }} [options]
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

    const profiles = {};
    for (const [key, raw] of explicit) {
        // `[LEWD]` wins over inline lines for the same character.
        profiles[key] = normalizeLewdProfile(raw, {
            unit: unitsByName.get(key),
            source: 'lewd',
            warnings: [...(raw.warnings || [])],
        });
    }
    for (const [key, raw] of inline) {
        if (profiles[key]) continue;
        profiles[key] = normalizeLewdProfile(raw, {
            unit: unitsByName.get(key),
            source: 'inline',
            warnings: [...(raw.warnings || [])],
        });
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
