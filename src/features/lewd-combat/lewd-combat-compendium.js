/**
 * lewd-combat-compendium.js — user techniques, strict validation, and the
 * merge order used by the board.
 *
 * Sources are merged deterministically:
 *   1. shipped catalog (`LEWD_TECHNIQUES`)
 *   2. compile-once cache (`lewdCombatTechniqueCache`) for novel techniques
 *   3. user JSON (`lewdCombatTechniqueCompendiumJson`), overriding by id
 *   4. `[LEWD_TECHNIQUES]` memo lines from the current scene
 *
 * Invalid JSON falls back to the shipped catalog and reports an error. Invalid
 * entries are dropped individually with a diagnostic; one bad homebrew line
 * never removes the rest of the catalog.
 *
 * This module deliberately knows nothing about `[ABILITIES]`,
 * `classifySkillIntent`, or the skill registry. Sexual techniques are data, not
 * prose to be classified.
 */

import {
    LEWD_TECHNIQUES,
    findLewdTechnique,
    validateLewdTechnique,
} from './lewd-combat-techniques.js';
import { normalizeLewdName } from './lewd-combat-profile.js';

export const LEWD_COMPENDIUM_KEY = 'lewdCombatTechniqueCompendiumJson';
export const LEWD_TECHNIQUE_CACHE_KEY = 'lewdCombatTechniqueCache';
export const LEWD_COMPILER_PROMPT_KEY = 'lewdCombatCompilerPrompt';
export const DEFAULT_LEWD_TECHNIQUE_COMPENDIUM_JSON = '';

function slug(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'technique';
}

function splitList(value) {
    if (Array.isArray(value)) return value;
    return String(value ?? '')
        .split(/[,;]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function fieldKey(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function numberOf(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * Parse and validate user JSON. Accepts `{ techniques: [...] }`,
 * `{ techniques: { id: {...} } }`, a bare array, or a bare id-keyed object.
 *
 * @param {unknown} raw
 * @returns {{
 *   ok: boolean, entries: object[], techniques: Record<string, object>,
 *   diagnostics: string[], error: string, usingDefault: boolean
 * }}
 */
export function normalizeLewdTechniqueCompendium(raw) {
    const empty = {
        ok: true,
        entries: [],
        techniques: {},
        diagnostics: [],
        error: '',
        usingDefault: true,
    };
    if (raw == null || String(raw).trim() === '') return empty;

    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch (error) {
            return {
                ...empty,
                ok: false,
                error: `Invalid JSON: ${error.message}`,
            };
        }
    }
    if (!value || typeof value !== 'object') {
        return {
            ...empty,
            ok: false,
            error: 'Technique compendium must be a JSON object or array.',
        };
    }

    let source = value;
    if (!Array.isArray(value)) {
        if (value.techniques != null) source = value.techniques;
        else if (value.entries != null) source = value.entries;
    }

    const entries = [];
    if (Array.isArray(source)) {
        entries.push(...source);
    } else if (source && typeof source === 'object') {
        for (const [key, entry] of Object.entries(source)) {
            if (!entry || typeof entry !== 'object') {
                entries.push({ __key: key, __invalid: true });
                continue;
            }
            entries.push(entry.id ? entry : { ...entry, id: key });
        }
    } else {
        return {
            ...empty,
            ok: false,
            error: 'Technique compendium must contain a techniques array or object.',
        };
    }

    const techniques = {};
    const diagnostics = [];
    for (const entry of entries) {
        const label = String(entry?.name || entry?.id || entry?.__key || 'unnamed technique');
        if (entry?.__invalid) {
            diagnostics.push(`${label}: entry must be a JSON object.`);
            continue;
        }
        const result = validateLewdTechnique(entry);
        if (!result.ok) {
            diagnostics.push(`${label}: ${result.errors.join(' ')}`);
            continue;
        }
        techniques[result.technique.id] = result.technique;
    }

    return {
        ok: true,
        entries: Object.values(techniques),
        techniques,
        diagnostics,
        error: '',
        usingDefault: false,
    };
}

function parseTechniqueLine(line, index) {
    const text = String(line ?? '').replace(/^\s*[-*+•]\s*/, '').trim();
    if (!text || text.startsWith('#')) return { technique: null, diagnostic: '' };
    const parts = text.split('|').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return { technique: null, diagnostic: '' };
    const name = parts[0];
    const category = (parts[1] || 'technique').toLowerCase();
    let posture = 'either';
    let rest = parts.slice(2);
    if (rest.length && !rest[0].includes(':')) {
        posture = rest[0].toLowerCase();
        rest = rest.slice(1);
    }
    const fields = {};
    for (const part of rest) {
        const colon = part.indexOf(':');
        if (colon < 0) {
            const key = fieldKey(part);
            if (key) fields[key] = true;
            continue;
        }
        fields[fieldKey(part.slice(0, colon))] = part.slice(colon + 1).trim();
    }

    const raw = {
        id: fields.id || slug(name),
        name: fields.name || name,
        category,
        posture,
        description: String(fields.description || '').trim(),
        zones: splitList(fields.zones || fields.zone || ''),
        tags: splitList(fields.tags || ''),
        targetMode: fields.targetmode || fields.target || (['stance', 'recover'].includes(category) ? 'self' : 'single'),
        check: {
            stat: fields.check || 'cha',
            accuracy: numberOf(fields.accuracy, 0),
        },
        arousal: fields.arousal || '0',
        poise: fields.poise || '0',
        staminaDrain: numberOf(fields.staminadrain ?? fields.stamina ?? fields.drain, 0),
        requires: {},
        applies: {},
        ai: { priority: numberOf(fields.priority, 1) },
    };
    if (fields.requireshold) raw.requires.hold = fields.requireshold;
    if (fields.requiresstance) raw.requires.stance = fields.requiresstance;
    if (fields.overwhelmed === true || /^(?:yes|true|1)$/i.test(String(fields.overwhelmed || ''))) {
        raw.requires.overwhelmed = true;
    }
    if (fields.hold) {
        raw.hold = {
            id: slug(fields.hold),
            label: String(fields.hold),
            dc: numberOf(fields.dc, 12),
            poiseBonus: numberOf(fields.holdpoisebonus ?? fields.poisebonus, 0),
        };
    } else if (category === 'hold') {
        raw.hold = {
            id: slug(fields.holdid || name),
            label: String(fields.holdlabel || name),
            dc: numberOf(fields.dc, 12),
        };
    }
    if (fields.status) {
        raw.applies.status = {
            label: fields.status,
            rounds: numberOf(fields.rounds, 1),
        };
    }
    if (fields.stance) {
        raw.applies.stance = {
            id: slug(fields.stance),
            label: fields.stance,
            poiseBonus: numberOf(fields.stancebonus, 0),
        };
    }
    if (fields.uses === 'at-will' || fields['at-will'] === true || fields.atwill === true) {
        raw.uses = { max: null, recharge: 'at-will' };
    } else if (fields.uses != null) {
        raw.uses = { max: numberOf(fields.uses, 1), recharge: fields.recharge || 'encounter' };
    } else if (fields.maxuses != null) {
        raw.uses = { max: numberOf(fields.maxuses, 1), recharge: fields.recharge || 'encounter' };
    }

    const result = validateLewdTechnique(raw);
    if (!result.ok) {
        return { technique: null, diagnostic: `Line ${index + 1} (${name}): ${result.errors.join(' ')}` };
    }
    return { technique: result.technique, diagnostic: '' };
}

/**
 * Parse the optional convenience block:
 * `- Neck Kiss | technique | either | zones: neck | tags: teasing | arousal: 1d6+2`
 *
 * @param {string} memo
 * @returns {{ entries: object[], diagnostics: string[] }}
 */
export function parseLewdTechniqueBlock(memo) {
    const match = String(memo ?? '').match(/\[LEWD_TECHNIQUES\]\s*([\s\S]*?)\s*\[\/LEWD_TECHNIQUES\]/i);
    if (!match) return { entries: [], diagnostics: [] };
    const entries = [];
    const diagnostics = [];
    const lines = match[1].split(/\r?\n/);
    lines.forEach((line, index) => {
        const parsed = parseTechniqueLine(line, index);
        if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
        if (parsed.technique) entries.push(parsed.technique);
    });
    return { entries, diagnostics };
}

/**
 * Read and validate the compile-once cache. Invalid cached entries are ignored
 * rather than breaking the catalog.
 * @param {Record<string, any>} settings
 * @returns {{ entries: object[], techniques: Record<string, object>, diagnostics: string[] }}
 */
export function readTechniqueCache(settings) {
    let raw = settings?.[LEWD_TECHNIQUE_CACHE_KEY] ?? {};
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch (_) {
            raw = null;
        }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { entries: [], techniques: {}, diagnostics: [] };
    }
    const entries = [];
    const techniques = {};
    const diagnostics = [];
    for (const [key, entry] of Object.entries(raw)) {
        const result = validateLewdTechnique(entry?.id ? entry : { ...(entry || {}), id: key });
        if (!result.ok) {
            diagnostics.push(`${key}: ${result.errors.join(' ')}`);
            continue;
        }
        techniques[result.technique.id] = result.technique;
        entries.push(result.technique);
    }
    return { entries, techniques, diagnostics };
}

/**
 * Cache a compiled technique for later boards. Mutates the settings object;
 * the caller persists it with the normal settings save path.
 */
export function writeTechniqueCache(settings, technique) {
    if (!settings || typeof settings !== 'object') return null;
    const result = validateLewdTechnique(technique);
    if (!result.ok) return null;
    const cache = settings[LEWD_TECHNIQUE_CACHE_KEY] && typeof settings[LEWD_TECHNIQUE_CACHE_KEY] === 'object'
        ? settings[LEWD_TECHNIQUE_CACHE_KEY]
        : {};
    cache[result.technique.id] = result.technique;
    settings[LEWD_TECHNIQUE_CACHE_KEY] = cache;
    return result.technique;
}

/** Cached technique by id or name, or null. */
export function findCachedTechnique(settings, idOrName) {
    return findLewdTechnique(readTechniqueCache(settings).entries, idOrName);
}

/** Remove every cached compiled technique. */
export function clearTechniqueCache(settings) {
    if (!settings || typeof settings !== 'object') return;
    settings[LEWD_TECHNIQUE_CACHE_KEY] = {};
}

/**
 * Build the effective catalog for a board.
 *
 * @param {Record<string, any>} [settings]
 * @param {string} [memo]
 * @param {{ shipped?: object[] }} [options]
 * @returns {{
 *   techniques: object[], byId: Record<string, object>,
 *   diagnostics: string[], error: string, usingDefault: boolean,
 *   sources: { shipped: number, cache: number, user: number, memo: number }
 * }}
 */
export function buildLewdTechniqueCatalog(settings = {}, memo = '', options = {}) {
    const shippedSource = Array.isArray(options.shipped) ? options.shipped : LEWD_TECHNIQUES;
    const shipped = [];
    const diagnostics = [];
    for (const entry of shippedSource) {
        const result = validateLewdTechnique(entry);
        if (!result.ok) {
            diagnostics.push(`Shipped technique ${entry?.name || entry?.id || '?'}: ${result.errors.join(' ')}`);
            continue;
        }
        shipped.push(result.technique);
    }

    const cache = readTechniqueCache(settings);
    const user = normalizeLewdTechniqueCompendium(settings?.[LEWD_COMPENDIUM_KEY]);
    const block = parseLewdTechniqueBlock(memo);

    const merged = new Map();
    for (const entry of shipped) merged.set(entry.id, entry);
    for (const entry of cache.entries) merged.set(entry.id, entry);
    for (const entry of user.entries) merged.set(entry.id, entry);
    for (const entry of block.entries) merged.set(entry.id, entry);

    const techniques = [...merged.values()];
    return {
        techniques,
        byId: Object.fromEntries(merged),
        diagnostics: [...diagnostics, ...cache.diagnostics, ...user.diagnostics, ...block.diagnostics],
        error: user.error,
        usingDefault: user.usingDefault && !cache.entries.length && !block.entries.length,
        sources: {
            shipped: shipped.length,
            cache: cache.entries.length,
            user: user.entries.length,
            memo: block.entries.length,
        },
    };
}

/** A visible one-line status for the settings pane. */
export function describeLewdCatalog(catalog) {
    if (!catalog) return 'Technique catalog unavailable.';
    if (catalog.error) {
        return `Invalid technique compendium: ${catalog.error} The shipped definitions are used until this is fixed.`;
    }
    const count = catalog.techniques?.length || 0;
    const diagnostics = catalog.diagnostics?.length || 0;
    const suffix = diagnostics ? ` · ${diagnostics} entr${diagnostics === 1 ? 'y' : 'ies'} dropped` : '';
    return `Technique catalog · ${count} definitions${suffix}.`;
}

/** Normalize a technique name for cache lookup and matching. */
export function normalizeTechniqueName(name) {
    return normalizeLewdName(name);
}
