/**
 * skill-registry.js — per-campaign catalogue of skills, spells, abilities,
 * items, classes, and reusable transformation/summon forms.
 *
 * The registry is deliberately pure: callers own settings/chat persistence and
 * lorebook mirroring. It compiles special resolutions into reusable engine
 * recipes so the same named ability behaves consistently across uses and
 * encounters.
 */

import { normalizeArea } from '../tactical-combat/tactical-combat-constants.js';
import {
    extractSpellNamesFromMemo,
    inferSpellDefinition,
    normalizeSkillCompendium,
} from '../tactical-combat/tactical-combat-spell-compendium.js';
import {
    normalizeClassifierConfig,
} from '../tactical-combat/tactical-combat-classifiers.js';
import {
    normalizeEffectCheck,
    sanitizeEffectTemplate,
    summarizeEffectTemplate,
} from '../tactical-combat/tactical-combat-effect-template.js';

export const SKILL_REGISTRY_VERSION = 1;
export const MAX_REGISTRY_SKILLS = 400;
export const MAX_REGISTRY_FORMS = 120;
export const MAX_REGISTRY_CLASSES = 80;

const SKILL_TYPES = new Set(['spell', 'ability', 'item', 'trait', 'technique', 'class-feature']);
const SKILL_KINDS = new Set(['attack', 'heal', 'buff', 'special']);
const STATUS_RANK = { inferred: 0, confirmed: 1, resolved: 2, conflict: 3 };
const SOURCE_RANK = { inferred: 0, memo: 1, global: 2, architect: 3, lorebook: 3, resolver: 4, manual: 5 };

function cloneJson(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function clampInt(value, min, max, fallback = null) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function stringValue(value, max = 400) {
    return String(value == null ? '' : value).slice(0, max);
}

export function normalizeSkillKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[’']/g, "'");
}

export function slugifySkill(value, fallback = 'skill') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || fallback;
}

function normalizeAliases(raw, name = '') {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const aliases = [];
    for (const alias of list) {
        const value = stringValue(alias, 80).trim();
        const key = normalizeSkillKey(value);
        if (!key || key === normalizeSkillKey(name) || seen.has(key)) continue;
        seen.add(key);
        aliases.push(value);
        if (aliases.length >= 16) break;
    }
    return aliases;
}

function normalizeTags(raw) {
    return (Array.isArray(raw) ? raw : [])
        .map(tag => stringValue(tag, 40).trim())
        .filter(Boolean)
        .slice(0, 24);
}

function normalizeOwners(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const owners = [];
    for (const owner of list) {
        const obj = typeof owner === 'string'
            ? { type: 'character', name: owner }
            : (owner && typeof owner === 'object' ? owner : null);
        if (!obj) continue;
        const name = stringValue(obj.name, 80).trim();
        if (!name) continue;
        const type = ['character', 'class', 'form', 'system', 'enemy'].includes(String(obj.type || '').toLowerCase())
            ? String(obj.type).toLowerCase()
            : 'character';
        const key = `${type}:${normalizeSkillKey(name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        owners.push({ type, name });
        if (owners.length >= 32) break;
    }
    return owners;
}

function mergeOwners(...lists) {
    return normalizeOwners(lists.flat());
}

function normalizeMechanics(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const kindRaw = stringValue(source.kind, 20).toLowerCase();
    const effectTemplate = sanitizeEffectTemplate(source.effectTemplate ?? source.effects ?? source.template, { max: 16 });
    const kind = SKILL_KINDS.has(kindRaw)
        ? kindRaw
        : (effectTemplate.length ? 'special' : 'attack');
    const resourceRaw = stringValue(source.resource, 12).toLowerCase();
    const targetRaw = stringValue(source.target, 12).toLowerCase();
    const saveRaw = stringValue(source.save, 12).toLowerCase();
    return {
        kind,
        resource: ['hp', 'willpower', 'both'].includes(resourceRaw) ? resourceRaw : 'hp',
        target: ['enemy', 'ally', 'self', 'any'].includes(targetRaw)
            ? targetRaw
            : (kind === 'attack' ? 'enemy' : kind === 'special' ? 'any' : 'ally'),
        range: source.range == null ? null : clampInt(source.range, 0, 24, 0),
        area: normalizeArea(source.area ?? source.aoe),
        damage: stringValue(source.damage, 40),
        willpowerDamage: stringValue(source.willpowerDamage ?? source.willDamage, 40),
        willpowerOutcome: stringValue(source.willpowerOutcome ?? source.willOutcome ?? 'defeat', 20).toLowerCase(),
        heal: stringValue(source.heal, 40),
        acBonus: clampInt(source.acBonus, -10, 20, 0),
        attackBonus: clampInt(source.attackBonus, -10, 20, 0),
        rounds: clampInt(source.rounds, 1, 10, 2),
        bonusAction: source.bonusAction === true,
        save: ['str', 'dex', 'con', 'int', 'wis', 'will', 'cha'].includes(saveRaw) ? saveRaw : '',
        utility: source.utility === true,
        maxUses: source.maxUses == null ? null : clampInt(source.maxUses, 0, 99, 0),
        unlimited: source.unlimited === true,
        effectTemplate,
    };
}

function normalizeStatus(raw, mechanics) {
    const value = stringValue(raw, 20).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(STATUS_RANK, value)) return value;
    return mechanics.effectTemplate.length ? 'resolved' : 'confirmed';
}

function normalizeCheck(raw, mechanics, type) {
    if (raw && typeof raw === 'object') {
        const check = normalizeEffectCheck(raw);
        if (!check.save && mechanics.save) check.save = mechanics.save;
        if (mechanics.save && check.type === 'attack' && raw.type == null) check.type = 'save';
        return check;
    }
    return normalizeEffectCheck({
        type: mechanics.save ? 'save' : (type === 'spell' || mechanics.kind === 'special' ? 'none' : 'attack'),
        save: mechanics.save,
    });
}

function titleFromKey(key) {
    return String(key || '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase())
        .trim();
}

/**
 * @returns {{version:number, skills:Record<string,object>, forms:Record<string,object>, classes:Record<string,object>, updatedAt:number}}
 */
export function createEmptySkillRegistry() {
    return {
        version: SKILL_REGISTRY_VERSION,
        skills: {},
        forms: {},
        classes: {},
        updatedAt: 0,
    };
}

/**
 * @param {any} raw
 * @param {string} [fallbackKey]
 * @returns {object|null}
 */
export function normalizeSkillRegistryEntry(raw, fallbackKey = '') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = stringValue(raw.name || raw.label || titleFromKey(fallbackKey), 80).trim();
    if (!name) return null;
    const mechanics = normalizeMechanics(raw.mechanics || raw);
    const typeRaw = stringValue(raw.type || raw.category || (raw.spell === true ? 'spell' : ''), 20).toLowerCase();
    const type = SKILL_TYPES.has(typeRaw)
        ? typeRaw
        : (raw.spell === true ? 'spell' : 'ability');
    const aliases = normalizeAliases(raw.aliases, name);
    const status = normalizeStatus(raw.status, mechanics);
    const brief = stringValue(raw.brief || raw.description || '', 400).trim();
    const entry = {
        id: slugifySkill(raw.id || name, 'skill'),
        name,
        aliases,
        type,
        brief,
        tags: normalizeTags(raw.tags),
        source: stringValue(raw.source || 'manual', 20).toLowerCase(),
        status,
        locked: raw.locked === true,
        owners: normalizeOwners(raw.owners),
        check: normalizeCheck(raw.check, mechanics, type),
        mechanics,
        effectSummary: stringValue(raw.effectSummary, 300)
            || summarizeEffectTemplate(mechanics.effectTemplate)
            || summarizeMechanics(mechanics),
        resolutionCount: clampInt(raw.resolutionCount, 0, 999999, 0),
        resolvedAt: clampInt(raw.resolvedAt, 0, Number.MAX_SAFE_INTEGER, 0),
        firstSeenAt: clampInt(raw.firstSeenAt, 0, Number.MAX_SAFE_INTEGER, 0),
        lastSeenAt: clampInt(raw.lastSeenAt, 0, Number.MAX_SAFE_INTEGER, 0),
        conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.slice(-10) : [],
    };
    return entry;
}

function summarizeMechanics(mechanics) {
    if (!mechanics) return '';
    const bits = [];
    if (mechanics.kind === 'attack') {
        bits.push(mechanics.damage ? `${mechanics.damage} damage` : 'attack');
    } else if (mechanics.kind === 'heal') {
        bits.push(mechanics.heal ? `heal ${mechanics.heal}` : 'healing');
    } else if (mechanics.kind === 'buff') {
        const bonuses = [];
        if (mechanics.acBonus) bonuses.push(`+${mechanics.acBonus} AC`);
        if (mechanics.attackBonus) bonuses.push(`+${mechanics.attackBonus} attack`);
        bits.push(bonuses.length ? `buff ${bonuses.join(', ')}` : 'buff');
    } else {
        bits.push('special');
    }
    if (mechanics.resource && mechanics.resource !== 'hp') bits.push(mechanics.resource);
    if (mechanics.range != null) bits.push(`range ${mechanics.range}`);
    if (mechanics.area) bits.push(`${mechanics.area.origin === 'self' ? 'aura' : 'burst'} ${mechanics.area.radius}`);
    if (mechanics.save) bits.push(`${mechanics.save.toUpperCase()} save`);
    if (mechanics.maxUses != null && !mechanics.unlimited) bits.push(`${mechanics.maxUses} use(s)`);
    return bits.join(' · ').slice(0, 300);
}

/**
 * @param {any} raw
 * @param {string} [fallbackKey]
 * @returns {object|null}
 */
export function normalizeSkillForm(raw, fallbackKey = '') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = stringValue(raw.name || titleFromKey(fallbackKey), 80).trim();
    if (!name) return null;
    const skills = Array.isArray(raw.skills)
        ? raw.skills.filter(entry => entry && typeof entry === 'object').slice(0, 16).map(entry => cloneJson(entry))
        : null;
    const replaceSkills = raw.replaceSkills == null ? Array.isArray(skills) : raw.replaceSkills === true;
    const durationSource = raw.duration && typeof raw.duration === 'object' ? raw.duration : raw;
    const form = {
        id: slugifySkill(raw.id || fallbackKey || name, 'form'),
        name,
        aliases: normalizeAliases(raw.aliases, name),
        classLabel: stringValue(raw.classLabel, 80),
        maxHp: clampInt(raw.maxHp, 1, 999, null),
        hp: clampInt(raw.hp, 0, 999, null),
        maxWillpower: clampInt(raw.maxWillpower, 0, 99, null),
        willpower: clampInt(raw.willpower, 0, 99, null),
        ac: clampInt(raw.ac, 1, 40, null),
        attackBonus: clampInt(raw.attackBonus, -10, 30, null),
        spellAttackBonus: clampInt(raw.spellAttackBonus, -10, 30, null),
        spellSaveDC: clampInt(raw.spellSaveDC, 1, 40, null),
        attackRange: clampInt(raw.attackRange, 1, 24, null),
        damage: stringValue(raw.damage, 40),
        damageType: stringValue(raw.damageType, 20),
        speed: clampInt(raw.speed, 1, 30, null),
        level: clampInt(raw.level, 1, 30, null),
        notes: stringValue(raw.notes, 500),
        glyph: stringValue(raw.glyph, 3),
        color: stringValue(raw.color, 30),
        attackResource: stringValue(raw.attackResource, 12).toLowerCase(),
        willpowerDamage: stringValue(raw.willpowerDamage, 40),
        attackWillpowerOutcome: stringValue(raw.attackWillpowerOutcome, 20).toLowerCase(),
        replaceSkills,
        skills: replaceSkills ? (skills || []) : [],
        items: Array.isArray(raw.items) ? raw.items.slice(0, 8).map(item => cloneJson(item)) : [],
        inventory: Array.isArray(raw.inventory) ? raw.inventory.slice(0, 24).map(item => cloneJson(item)) : [],
        duration: {
            rounds: clampInt(durationSource.rounds, 0, 99, 0),
            permanent: durationSource.permanent === true,
        },
        source: stringValue(raw.source || 'resolver', 20).toLowerCase(),
        status: stringValue(raw.status || (replaceSkills || skills ? 'resolved' : 'confirmed'), 20).toLowerCase(),
        incomplete: raw.incomplete === true,
        owners: normalizeOwners(raw.owners),
        updatedAt: clampInt(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
    };
    return form;
}

/**
 * @param {any} raw
 * @param {string} [fallbackKey]
 * @returns {object|null}
 */
export function normalizeSkillClass(raw, fallbackKey = '') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = stringValue(raw.name || titleFromKey(fallbackKey), 80).trim();
    if (!name) return null;
    return {
        id: slugifySkill(raw.id || fallbackKey || name, 'class'),
        name,
        brief: stringValue(raw.brief || raw.description, 400),
        tags: normalizeTags(raw.tags),
        skillIds: Array.isArray(raw.skillIds)
            ? raw.skillIds.map(id => stringValue(id, 80).trim()).filter(Boolean).slice(0, 80)
            : [],
        source: stringValue(raw.source || 'memo', 20).toLowerCase(),
        owners: normalizeOwners(raw.owners),
        updatedAt: clampInt(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
    };
}

function isNormalizedRegistry(value) {
    return !!value
        && typeof value === 'object'
        && value.version === SKILL_REGISTRY_VERSION
        && value.skills && typeof value.skills === 'object' && !Array.isArray(value.skills)
        && value.forms && typeof value.forms === 'object' && !Array.isArray(value.forms)
        && value.classes && typeof value.classes === 'object' && !Array.isArray(value.classes);
}

/**
 * @param {any} raw
 * @returns {{ ok:boolean, registry:object, error:string }}
 */
export function normalizeSkillRegistry(raw) {
    const empty = createEmptySkillRegistry();
    if (raw == null || String(raw).trim() === '') return { ok: true, registry: empty, error: '' };
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch (error) {
            return { ok: false, registry: empty, error: `Invalid JSON: ${error.message}` };
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, registry: empty, error: 'Skill registry must be a JSON object.' };
    }
    const registry = createEmptySkillRegistry();
    registry.updatedAt = clampInt(value.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0);
    const rawSkills = value.skills && typeof value.skills === 'object' && !Array.isArray(value.skills)
        ? value.skills
        : {};
    for (const [key, entry] of Object.entries(rawSkills)) {
        const normalized = normalizeSkillRegistryEntry(entry, key);
        if (normalized) registry.skills[normalizeSkillKey(normalized.name)] = normalized;
    }
    const rawForms = value.forms && typeof value.forms === 'object' && !Array.isArray(value.forms)
        ? value.forms
        : {};
    for (const [key, form] of Object.entries(rawForms)) {
        const normalized = normalizeSkillForm(form, key);
        if (normalized) registry.forms[slugifySkill(normalized.id || key, 'form')] = normalized;
    }
    const rawClasses = value.classes && typeof value.classes === 'object' && !Array.isArray(value.classes)
        ? value.classes
        : {};
    for (const [key, cls] of Object.entries(rawClasses)) {
        const normalized = normalizeSkillClass(cls, key);
        if (normalized) registry.classes[slugifySkill(normalized.id || key, 'class')] = normalized;
    }
    return { ok: true, registry, error: '' };
}

/** @param {Record<string, any>} settings */
export function ensureSkillRegistry(settings) {
    if (!settings || typeof settings !== 'object') return createEmptySkillRegistry();
    if (isNormalizedRegistry(settings.skillRegistry)) return settings.skillRegistry;
    settings.skillRegistry = normalizeSkillRegistry(settings.skillRegistry).registry;
    return settings.skillRegistry;
}

/** @param {Record<string, any>} settings */
export function getSkillRegistry(settings) {
    return ensureSkillRegistry(settings);
}

function registryFrom(input) {
    if (!input || typeof input !== 'object') return createEmptySkillRegistry();
    if (isNormalizedRegistry(input)) return input;
    if (input.skillRegistry && typeof input.skillRegistry === 'object') return ensureSkillRegistry(input);
    if (input.skills && typeof input.skills === 'object' && !Array.isArray(input.skills)) {
        return normalizeSkillRegistry(input).registry;
    }
    return ensureSkillRegistry(input);
}

/**
 * @param {Record<string, any>|object} input settings or registry
 * @param {string} name
 * @param {{ ownerName?: string, formId?: string }} [options]
 * @returns {object|null}
 */
export function findSkillRegistryEntry(input, name, options = {}) {
    const registry = registryFrom(input);
    const key = normalizeSkillKey(name);
    if (!key) return null;
    const direct = registry.skills[key];
    if (direct) return direct;
    const matches = [];
    for (const entry of Object.values(registry.skills)) {
        if (normalizeSkillKey(entry.name) === key
            || (entry.aliases || []).some(alias => normalizeSkillKey(alias) === key)) {
            matches.push(entry);
        }
    }
    if (!matches.length) return null;
    if (options.ownerName) {
        const ownerKey = normalizeSkillKey(options.ownerName);
        const owned = matches.find(entry => (entry.owners || []).some(owner => normalizeSkillKey(owner.name) === ownerKey));
        if (owned) return owned;
    }
    if (options.formId) {
        const formKey = slugifySkill(options.formId, '');
        const formOwned = matches.find(entry => (entry.owners || []).some(owner => owner.type === 'form' && slugifySkill(owner.name, '') === formKey));
        if (formOwned) return formOwned;
    }
    return matches[0];
}

export function getSkillRegistryForm(input, formIdOrName) {
    const registry = registryFrom(input);
    const key = slugifySkill(formIdOrName, '');
    if (!key) return null;
    if (registry.forms[key]) return registry.forms[key];
    const nameKey = normalizeSkillKey(formIdOrName);
    return Object.values(registry.forms).find(form =>
        normalizeSkillKey(form.name) === nameKey
        || (form.aliases || []).some(alias => normalizeSkillKey(alias) === nameKey)
    ) || null;
}

function mergeEntryMechanics(existing, incoming, opts = {}) {
    const out = { ...existing };
    const conflicts = [];
    const force = opts.force === true;
    const existingInferred = opts.existingStatus === 'inferred';
    const incomingStronger = (STATUS_RANK[opts.incomingStatus] || 0) > (STATUS_RANK[opts.existingStatus] || 0);
    if (force || existingInferred || incomingStronger) {
        if (incoming.effectTemplate.length) {
            if (!existing.effectTemplate.length || force || existingInferred) {
                out.effectTemplate = cloneJson(incoming.effectTemplate);
            } else if (JSON.stringify(existing.effectTemplate) !== JSON.stringify(incoming.effectTemplate)) {
                conflicts.push({
                    field: 'effectTemplate',
                    existing: cloneJson(existing.effectTemplate),
                    incoming: cloneJson(incoming.effectTemplate),
                    at: Date.now(),
                });
            }
        }
        if (incoming.kind) out.kind = incoming.kind;
        if (incoming.resource) out.resource = incoming.resource;
        if (incoming.target) out.target = incoming.target;
        if (incoming.range != null) out.range = incoming.range;
        if (incoming.area) out.area = cloneJson(incoming.area);
        if (incoming.damage) out.damage = incoming.damage;
        if (incoming.willpowerDamage) out.willpowerDamage = incoming.willpowerDamage;
        if (incoming.willpowerOutcome) out.willpowerOutcome = incoming.willpowerOutcome;
        if (incoming.heal) out.heal = incoming.heal;
        if (incoming.acBonus) out.acBonus = incoming.acBonus;
        if (incoming.attackBonus) out.attackBonus = incoming.attackBonus;
        if (incoming.rounds) out.rounds = incoming.rounds;
        if (incoming.bonusAction) out.bonusAction = true;
        if (incoming.save) out.save = incoming.save;
        if (incoming.utility) out.utility = true;
        if (incoming.maxUses != null) out.maxUses = incoming.maxUses;
        if (incoming.unlimited) out.unlimited = true;
    } else if (!existing.effectTemplate.length && incoming.effectTemplate.length) {
        out.effectTemplate = cloneJson(incoming.effectTemplate);
    } else if (existing.effectTemplate.length && incoming.effectTemplate.length
        && JSON.stringify(existing.effectTemplate) !== JSON.stringify(incoming.effectTemplate)) {
        conflicts.push({
            field: 'effectTemplate',
            existing: cloneJson(existing.effectTemplate),
            incoming: cloneJson(incoming.effectTemplate),
            at: Date.now(),
        });
    }
    // Fill gaps even when the incoming entry is not considered stronger.
    for (const key of ['damage', 'heal', 'willpowerDamage', 'save', 'target']) {
        if (!out[key] && incoming[key]) out[key] = incoming[key];
    }
    if (out.range == null && incoming.range != null) out.range = incoming.range;
    if (!out.area && incoming.area) out.area = cloneJson(incoming.area);
    return { mechanics: out, conflicts };
}

/**
 * Insert or merge an entry. Auto-discovery never silently overwrites a locked
 * entry or an already-resolved special recipe.
 * @param {object} registry
 * @param {any} rawEntry
 * @param {{ force?: boolean }} [options]
 * @returns {{ entry: object|null, created: boolean, changed: boolean }}
 */
export function upsertSkillRegistryEntry(registry, rawEntry, options = {}) {
    if (!isNormalizedRegistry(registry)) return { entry: null, created: false, changed: false };
    const entry = normalizeSkillRegistryEntry(rawEntry);
    if (!entry) return { entry: null, created: false, changed: false };
    const existing = findSkillRegistryEntry(registry, entry.name, { ownerName: entry.owners[0]?.name });
    const now = Date.now();
    entry.firstSeenAt = entry.firstSeenAt || now;
    entry.lastSeenAt = now;
    if (!existing) {
        if (Object.keys(registry.skills).length >= MAX_REGISTRY_SKILLS) pruneSkillRegistry(registry);
        registry.skills[normalizeSkillKey(entry.name)] = entry;
        registry.updatedAt = now;
        return { entry, created: true, changed: true };
    }
    const before = JSON.stringify(existing);
    const priorStatus = existing.status;
    existing.aliases = normalizeAliases([...(existing.aliases || []), entry.name, ...(entry.aliases || [])], existing.name);
    existing.owners = mergeOwners(existing.owners, entry.owners);
    existing.tags = [...new Set([...(existing.tags || []), ...(entry.tags || [])])].slice(0, 24);
    existing.lastSeenAt = now;
    const existingRank = SOURCE_RANK[existing.source] || 0;
    const incomingRank = SOURCE_RANK[entry.source] || 0;
    if (incomingRank > existingRank) existing.source = entry.source;
    if ((STATUS_RANK[entry.status] || 0) > (STATUS_RANK[existing.status] || 0)) existing.status = entry.status;
    if (!existing.brief && entry.brief) existing.brief = entry.brief;
    if (entry.locked) existing.locked = true;
    if (!existing.locked || options.force === true) {
        const merged = mergeEntryMechanics(existing.mechanics, entry.mechanics, {
            ...options,
            force: options.force === true || priorStatus === 'inferred',
            existingStatus: priorStatus,
            incomingStatus: entry.status,
        });
        existing.mechanics = merged.mechanics;
        if (!existing.mechanics.effectTemplate.length && entry.mechanics.effectTemplate.length) {
            existing.status = 'resolved';
        }
        if (merged.conflicts.length) {
            existing.conflicts = [...(existing.conflicts || []), ...merged.conflicts].slice(-10);
            existing.status = 'conflict';
        }
        if (!existing.check || (entry.check && entry.check.type !== 'none')) {
            existing.check = normalizeCheck(entry.check, existing.mechanics, existing.type);
        }
    }
    if (!existing.effectSummary || (entry.mechanics.effectTemplate.length && existing.mechanics.effectTemplate.length)) {
        existing.effectSummary = entry.effectSummary
            || summarizeEffectTemplate(existing.mechanics.effectTemplate)
            || summarizeMechanics(existing.mechanics);
    }
    if (entry.resolutionCount > (existing.resolutionCount || 0)) existing.resolutionCount = entry.resolutionCount;
    if (entry.resolvedAt) existing.resolvedAt = entry.resolvedAt;
    registry.updatedAt = now;
    return { entry: existing, created: false, changed: before !== JSON.stringify(existing) };
}

function pruneSkillRegistry(registry) {
    const candidates = Object.entries(registry.skills)
        .filter(([, entry]) => !entry.locked && entry.status === 'inferred' && !entry.mechanics.effectTemplate.length)
        .sort((a, b) => Number(a[1].lastSeenAt || 0) - Number(b[1].lastSeenAt || 0));
    const remove = Math.max(1, candidates.length - Math.floor(MAX_REGISTRY_SKILLS * 0.9));
    for (const [key] of candidates.slice(0, remove)) delete registry.skills[key];
}

function upsertForm(registry, rawForm, options = {}) {
    const form = normalizeSkillForm(rawForm);
    if (!form) return null;
    const key = slugifySkill(form.id || form.name, 'form');
    const existing = registry.forms[key];
    if (!existing) {
        if (Object.keys(registry.forms).length >= MAX_REGISTRY_FORMS) {
            const oldest = Object.entries(registry.forms)
                .sort((a, b) => Number(a[1].updatedAt || 0) - Number(b[1].updatedAt || 0))[0];
            if (oldest) delete registry.forms[oldest[0]];
        }
        form.updatedAt = Date.now();
        registry.forms[key] = form;
        return form;
    }
    const before = JSON.stringify(existing);
    existing.aliases = normalizeAliases([...(existing.aliases || []), form.name, ...(form.aliases || [])], existing.name);
    existing.owners = mergeOwners(existing.owners, form.owners);
    if (options.force === true || (existing.status !== 'resolved' && form.status === 'resolved')) {
        const keepSkills = existing.status === 'resolved' && Array.isArray(existing.skills) && existing.skills.length;
        Object.assign(existing, form, { id: existing.id });
        if (keepSkills && (!form.skills || !form.skills.length)) existing.skills = cloneJson(existing.skills);
        existing.status = 'resolved';
    } else {
        if (!existing.classLabel && form.classLabel) existing.classLabel = form.classLabel;
        if (existing.maxHp == null && form.maxHp != null) existing.maxHp = form.maxHp;
        if (existing.ac == null && form.ac != null) existing.ac = form.ac;
        if (existing.attackBonus == null && form.attackBonus != null) existing.attackBonus = form.attackBonus;
        if (existing.attackRange == null && form.attackRange != null) existing.attackRange = form.attackRange;
        if (!existing.damage && form.damage) existing.damage = form.damage;
        if (existing.status !== 'resolved' && !existing.skills?.length && form.skills?.length) {
            existing.skills = cloneJson(form.skills);
            existing.replaceSkills = true;
        }
        if (form.duration?.rounds && !existing.duration?.rounds) existing.duration = cloneJson(form.duration);
    }
    existing.updatedAt = Date.now();
    registry.updatedAt = existing.updatedAt;
    return before !== JSON.stringify(existing) ? existing : existing;
}

/**
 * Convert a stored registry entry to the compendium/parser definition shape.
 * @param {object} entry
 * @returns {object|null}
 */
export function registryEntryToDefinition(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const mechanics = normalizeMechanics(entry.mechanics || entry);
    return {
        kind: mechanics.kind,
        type: entry.type || 'ability',
        resource: mechanics.resource,
        target: mechanics.target,
        range: mechanics.range,
        area: mechanics.area ? cloneJson(mechanics.area) : null,
        damage: mechanics.damage,
        willpowerDamage: mechanics.willpowerDamage,
        willpowerOutcome: mechanics.willpowerOutcome,
        heal: mechanics.heal,
        acBonus: mechanics.acBonus,
        attackBonus: mechanics.attackBonus,
        rounds: mechanics.rounds,
        bonusAction: mechanics.bonusAction,
        save: mechanics.save,
        check: entry.check ? cloneJson(entry.check) : undefined,
        utility: mechanics.utility,
        description: entry.brief || '',
        maxUses: mechanics.maxUses,
        unlimited: mechanics.unlimited,
        effectTemplate: mechanics.effectTemplate.length ? cloneJson(mechanics.effectTemplate) : null,
        registryId: entry.id,
        status: entry.status,
        source: entry.source || 'registry',
    };
}

/**
 * Merge the shipped/global compendium with the campaign registry and memo
 * inference. Registry entries win when confirmed/resolved; inferred registry
 * entries do not override a shipped definition.
 * @param {Record<string, any>} settings
 * @param {string} memo
 * @param {{ registry?: object }} [options]
 * @returns {object}
 */
export function buildSkillCatalog(settings, memo, options = {}) {
    const normalized = normalizeSkillCompendium(settings?.tacticalCombatSpellCompendiumJson);
    const registry = options.registry && isNormalizedRegistry(options.registry)
        ? options.registry
        : getSkillRegistry(settings);
    const spells = { ...normalized.config.spells };
    for (const entry of Object.values(registry.skills || {})) {
        const definition = registryEntryToDefinition(entry);
        if (!definition) continue;
        const key = normalizeSkillKey(entry.name);
        const existing = spells[key];
        const authoritative = entry.locked || entry.status === 'resolved' || entry.status === 'confirmed';
        if (!existing) {
            spells[key] = definition;
        } else if (authoritative) {
            spells[key] = { ...existing, ...definition };
        }
    }
    const classifierResult = normalizeClassifierConfig(settings?.tacticalCombatClassifierJson).config;
    const inferred = [];
    for (const entry of extractSpellNamesFromMemo(memo)) {
        const key = normalizeSkillKey(entry.name);
        if (spells[key]) continue;
        const definition = inferSpellDefinition(entry.name, entry.level, classifierResult);
        if (!definition) continue;
        spells[key] = definition;
        inferred.push(entry.name);
    }
    return {
        spells,
        skills: spells,
        registry,
        error: normalized.error,
        usingDefault: normalized.usingDefault,
        inferred,
    };
}

function ownerForUnit(unit, extra = []) {
    const owners = [];
    if (unit?.name) owners.push({ type: unit.side === 'enemy' ? 'enemy' : 'character', name: unit.name });
    if (unit?.classLabel && unit.side !== 'enemy') owners.push({ type: 'class', name: unit.classLabel });
    return normalizeOwners([...owners, ...extra]);
}

function entryFromSkill(skill, options = {}) {
    if (!skill || typeof skill !== 'object' || !skill.name) return null;
    const type = options.type || (skill.spell === true ? 'spell' : 'ability');
    return {
        name: skill.name,
        type,
        brief: skill.description || '',
        aliases: skill.aliases || [],
        tags: skill.tags || [],
        source: options.source || skill.source || 'memo',
        status: skill.effectTemplate && skill.effectTemplate.length
            ? 'resolved'
            : (skill.registryStatus === 'inferred' || skill.source === 'inferred' ? 'inferred' : 'confirmed'),
        owners: options.owners || [],
        check: {
            type: skill.save ? 'save' : (skill.kind === 'special' ? 'none' : 'attack'),
            save: skill.save || '',
        },
        mechanics: {
            kind: skill.kind,
            resource: skill.resource,
            target: skill.target,
            range: skill.range,
            area: skill.area,
            damage: skill.damage,
            willpowerDamage: skill.willpowerDamage,
            willpowerOutcome: skill.willpowerOutcome,
            heal: skill.heal,
            acBonus: skill.acBonus,
            attackBonus: skill.attackBonus,
            rounds: skill.rounds,
            bonusAction: skill.bonusAction,
            save: skill.save,
            utility: skill.utility,
            maxUses: skill.maxUses,
            unlimited: skill.unlimited,
            effectTemplate: skill.effectTemplate || [],
        },
    };
}

function registerClassForUnit(registry, unit) {
    const name = stringValue(unit?.classLabel, 80).trim();
    if (!name || unit?.side === 'enemy') return false;
    const key = slugifySkill(name, 'class');
    const skillIds = (unit.skills || [])
        .filter(skill => skill.source !== 'fallback' && skill.synthetic !== true)
        .map(skill => skill.name)
        .filter(Boolean)
        .slice(0, 80);
    if (!skillIds.length) return false;
    const existing = registry.classes[key];
    if (!existing) {
        const cls = normalizeSkillClass({
            name,
            brief: `${name} combat loadout.`,
            skillIds,
            source: 'memo',
            owners: [{ type: 'character', name: unit.name }],
            updatedAt: Date.now(),
        });
        if (!cls) return false;
        if (Object.keys(registry.classes).length >= MAX_REGISTRY_CLASSES) return false;
        registry.classes[key] = cls;
        return true;
    }
    const before = JSON.stringify(existing);
    existing.skillIds = [...new Set([...(existing.skillIds || []), ...skillIds])].slice(0, 80);
    existing.owners = mergeOwners(existing.owners, [{ type: 'character', name: unit.name }]);
    existing.updatedAt = Date.now();
    return before !== JSON.stringify(existing);
}

/**
 * Register parsed unit skills/items. Player and party members contribute every
 * skill; enemies contribute only specials or skills that already have a
 * deterministic recipe.
 * @param {Record<string, any>} settings
 * @param {{ playerUnits?: object[], allies?: object[], enemies?: object[] }} units
 * @param {{ source?: string }} [options]
 * @returns {number}
 */
export function registerSkillsFromUnits(settings, units = {}, options = {}) {
    const registry = ensureSkillRegistry(settings);
    let changed = 0;
    const groups = [
        ...(units.playerUnits || []).map(unit => ({ unit, friendly: true })),
        ...(units.allies || []).map(unit => ({ unit, friendly: true })),
        ...(units.enemies || []).map(unit => ({ unit, friendly: false })),
    ];
    for (const { unit, friendly } of groups) {
        const owners = ownerForUnit(unit);
        for (const skill of unit?.skills || []) {
            if (skill?.source === 'fallback' || skill?.synthetic === true) continue;
            if (!friendly && skill.kind !== 'special' && !(skill.effectTemplate && skill.effectTemplate.length)) continue;
            const raw = entryFromSkill(skill, { source: options.source || 'memo', owners });
            if (!raw) continue;
            const result = upsertSkillRegistryEntry(registry, raw, { force: false });
            if (result.changed) changed += 1;
        }
        if (friendly) {
            for (const item of unit?.items || []) {
                if (item?.kind !== 'special') continue;
                const raw = entryFromSkill({ ...item, description: item.description || '' }, {
                    source: options.source || 'memo',
                    owners,
                    type: 'item',
                });
                if (!raw) continue;
                const result = upsertSkillRegistryEntry(registry, raw, { force: false });
                if (result.changed) changed += 1;
            }
            if (registerClassForUnit(registry, unit)) changed += 1;
        }
    }
    if (changed) registry.updatedAt = Date.now();
    return changed;
}

function targetSelectorFor(groupIds, ctx) {
    const set = new Set(groupIds.map(String));
    const size = set.size;
    if (!size) return { selector: '' };
    const isArea = ctx.isArea === true || (ctx.targetIds || []).length > 1;
    if (!isArea) {
        const only = [...set][0];
        if (only === String(ctx.casterId || '')) return { selector: '$caster' };
        return { selector: '$target' };
    }
    const hostile = new Set((ctx.hostileIds || []).map(String));
    const friendly = new Set((ctx.friendlyIds || []).map(String));
    const all = new Set((ctx.targetIds || []).map(String));
    const equals = (a, b) => a.size > 0 && a.size === b.size && [...a].every(id => b.has(id));
    if (equals(set, hostile)) return { selector: '$areaHostile' };
    if (equals(set, friendly)) return { selector: '$areaFriendly' };
    if (equals(set, all)) return { selector: '$area' };
    if (size === 1) {
        const only = [...set][0];
        if (only === String(ctx.casterId || '')) return { selector: '$caster' };
        if (only === String(ctx.primaryTargetId || '')) return { selector: '$target' };
    }
    const allHostile = [...set].every(id => hostile.has(id));
    const allFriendly = [...set].every(id => friendly.has(id));
    if (allHostile) return { selector: '$areaHostile', limit: size };
    if (allFriendly) return { selector: '$areaFriendly', limit: size };
    return { selector: '$area', limit: size };
}

function formFromTransformEffect(effect, ctx = {}) {
    const formId = slugifySkill(effect.formId || effect.name || effect.classLabel || 'form', 'form');
    const replaceSkills = Array.isArray(effect.skills) || effect.replaceSkills === true;
    const incomplete = effect.skillsResolutionFailed === true;
    return normalizeSkillForm({
        id: formId,
        name: effect.name || effect.classLabel || 'Transformed Form',
        classLabel: effect.classLabel || '',
        maxHp: effect.maxHp,
        hp: effect.hp,
        maxWillpower: effect.maxWillpower,
        willpower: effect.willpower,
        ac: effect.ac,
        attackBonus: effect.attackBonus,
        spellAttackBonus: effect.spellAttackBonus,
        spellSaveDC: effect.spellSaveDC,
        attackRange: effect.attackRange,
        damage: effect.damage,
        damageType: effect.damageType,
        speed: effect.speed,
        level: effect.level,
        notes: effect.notes,
        glyph: effect.glyph,
        color: effect.color,
        attackResource: effect.attackResource,
        willpowerDamage: effect.willpowerDamage,
        attackWillpowerOutcome: effect.attackWillpowerOutcome,
        replaceSkills,
        skills: replaceSkills ? (effect.skills || []) : [],
        items: effect.items || [],
        inventory: effect.inventory || [],
        duration: { rounds: effect.rounds || 0, permanent: effect.permanent === true },
        source: 'resolver',
        status: incomplete ? 'inferred' : (replaceSkills || effect.name || effect.ac != null ? 'resolved' : 'confirmed'),
        incomplete,
        owners: ctx.casterName ? [{ type: 'character', name: ctx.casterName }] : [],
        updatedAt: Date.now(),
    });
}

/**
 * Turn concrete resolver effects into a reusable template. Target IDs become
 * role selectors, terrain cells become anchor-relative offsets, and
 * transformations become form references.
 * @param {object[]} effects
 * @param {object} ctx
 * @returns {{ effects: object[], forms: object[] }}
 */
export function canonicalizeSpecialEffects(effects, ctx = {}) {
    const normalized = Array.isArray(effects) ? effects : [];
    const forms = [];
    const prepared = [];
    for (const raw of normalized) {
        if (!raw || typeof raw !== 'object') continue;
        const effect = cloneJson(raw);
        if (effect.type === 'log' && ctx.keepLogs !== true) continue;
        if (effect.type === 'terrain') {
            const anchor = ctx.anchor || (ctx.casterX != null && ctx.casterY != null
                ? { x: Number(ctx.casterX), y: Number(ctx.casterY) }
                : null);
            const cells = Array.isArray(effect.cells) ? effect.cells : [];
            if (anchor && cells.length) {
                effect.cellOffsets = cells
                    .map(cell => {
                        const x = Number(cell?.x);
                        const y = Number(cell?.y);
                        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                        return { dx: x - anchor.x, dy: y - anchor.y };
                    })
                    .filter(Boolean)
                    .slice(0, 64);
                delete effect.cells;
            }
            if (effect.terrain) effect.terrain = String(effect.terrain).toLowerCase();
            prepared.push({ effect, untargeted: true });
            continue;
        }
        if (effect.type === 'transform') {
            const form = formFromTransformEffect(effect, ctx);
            if (form) forms.push(form);
            prepared.push({
                effect: {
                    type: 'transform',
                    targetId: effect.targetId,
                    formId: form?.id || slugifySkill(effect.name || 'form', 'form'),
                    rounds: effect.rounds ?? form?.duration?.rounds ?? 0,
                    ...(effect.permanent != null ? { permanent: effect.permanent === true } : {}),
                },
                targetId: effect.targetId,
            });
            continue;
        }
        if (effect.type === 'summon') {
            prepared.push({ effect, untargeted: true });
            continue;
        }
        if (effect.type === 'log') {
            prepared.push({ effect, untargeted: true });
            continue;
        }
        prepared.push({ effect, targetId: effect.targetId });
    }

    const groups = new Map();
    const untargeted = [];
    for (const item of prepared) {
        if (item.untargeted || !item.targetId) {
            untargeted.push(item.effect);
            continue;
        }
        const signatureEffect = cloneJson(item.effect);
        delete signatureEffect.targetId;
        const signature = JSON.stringify(signatureEffect);
        if (!groups.has(signature)) groups.set(signature, { effect: signatureEffect, targetIds: new Set() });
        groups.get(signature).targetIds.add(String(item.targetId));
    }
    const template = [];
    for (const group of groups.values()) {
        const { selector, limit } = targetSelectorFor([...group.targetIds], ctx);
        if (!selector) continue;
        const effect = { ...cloneJson(group.effect), target: selector };
        if (limit) effect.limit = limit;
        template.push(effect);
    }
    template.push(...untargeted.map(cloneJson));
    const order = {
        damage: 0, heal: 1, status: 2, defeat: 3, cure: 4, transform: 5,
        terrain: 6, summon: 7, log: 8,
    };
    template.sort((a, b) => {
        const orderDiff = (order[a.type] ?? 99) - (order[b.type] ?? 99);
        if (orderDiff) return orderDiff;
        return JSON.stringify(a).localeCompare(JSON.stringify(b));
    });
    return { effects: template, forms };
}

/**
 * Store a successful special resolution as the canonical recipe for its skill.
 * @param {Record<string, any>} settings
 * @param {object} prepared result of prepareSpecialAction
 * @param {{ kind?: string, name: string, description?: string, resource?: string, willpowerOutcome?: string, area?: object, target?: string, damage?: string, heal?: string, willpowerDamage?: string, maxUses?: number }} source
 * @param {object[]} effects
 * @param {{ force?: boolean, keepLogs?: boolean }} [options]
 * @returns {{ entry: object|null, forms: object[] }}
 */
export function rememberSpecialResolution(settings, prepared, source, effects, options = {}) {
    const registry = ensureSkillRegistry(settings);
    const caster = prepared?.unit || null;
    const targets = Array.isArray(prepared?.targets) && prepared.targets.length
        ? prepared.targets
        : (prepared?.target ? [prepared.target] : []);
    const targetIds = targets.map(target => target.id).filter(Boolean);
    const hostileIds = [];
    const friendlyIds = [];
    for (const target of targets) {
        const targetFriendly = target.side === 'player' || target.side === 'ally';
        const casterFriendly = caster?.side === 'player' || caster?.side === 'ally';
        if (castsHostile(caster?.side, target.side)) hostileIds.push(target.id);
        else if (targetFriendly === casterFriendly) friendlyIds.push(target.id);
    }
    const canonical = canonicalizeSpecialEffects(effects, {
        casterId: caster?.id || '',
        casterName: caster?.name || '',
        casterX: caster?.x,
        casterY: caster?.y,
        primaryTargetId: prepared?.target?.id || targetIds[0] || '',
        targetIds,
        hostileIds,
        friendlyIds,
        anchor: prepared?.anchor || null,
        isArea: !!prepared?.area,
        keepLogs: options.keepLogs === true,
    });
    for (const form of canonical.forms) upsertForm(registry, form, { force: options.force === true });
    const owners = caster?.name
        ? [{ type: caster.side === 'enemy' ? 'enemy' : 'character', name: caster.name }]
        : [];
    const raw = {
        name: source?.name || prepared?.label || 'Special ability',
        type: source?.type || (source?.kind === 'item' ? 'item' : (prepared?.skill?.spell === true ? 'spell' : 'ability')),
        brief: source?.description || '',
        source: 'resolver',
        status: 'resolved',
        owners,
        check: {
            type: source?.save ? 'save' : 'none',
            save: source?.save || '',
        },
        mechanics: {
            kind: 'special',
            resource: source?.resource || 'hp',
            target: source?.target || (prepared?.area ? 'any' : 'enemy'),
            range: source?.range ?? (prepared?.skill?.range ?? prepared?.item?.range ?? 6),
            area: source?.area ?? prepared?.area ?? null,
            damage: source?.damage || '',
            willpowerDamage: source?.willpowerDamage || '',
            willpowerOutcome: source?.willpowerOutcome || 'defeat',
            heal: source?.heal || '',
            bonusAction: prepared?.skill?.bonusAction === true,
            maxUses: source?.maxUses ?? prepared?.skill?.maxUses ?? prepared?.item?.maxUses ?? null,
            unlimited: !!(prepared?.skill?.unlimited || prepared?.item?.unlimited),
            effectTemplate: canonical.effects,
        },
        effectSummary: summarizeEffectTemplate(canonical.effects),
        resolutionCount: 1,
        resolvedAt: Date.now(),
    };
    const existing = findSkillRegistryEntry(registry, raw.name, { ownerName: owners[0]?.name });
    if (existing?.locked && !options.force) {
        existing.lastSeenAt = Date.now();
        return { entry: existing, forms: canonical.forms };
    }
    if (existing) raw.resolutionCount = (existing.resolutionCount || 0) + 1;
    const result = upsertSkillRegistryEntry(registry, raw, { force: options.force === true });
    if (result.entry) {
        result.entry.status = result.entry.conflicts?.length ? 'conflict' : 'resolved';
        result.entry.resolvedAt = Date.now();
        result.entry.effectSummary = summarizeEffectTemplate(result.entry.mechanics.effectTemplate)
            || raw.effectSummary;
    }
    registry.updatedAt = Date.now();
    return { entry: result.entry, forms: canonical.forms };
}

function castsHostile(casterSide, targetSide) {
    const friendly = casterSide === 'player' || casterSide === 'ally';
    const targetFriendly = targetSide === 'player' || targetSide === 'ally';
    return friendly ? targetSide === 'enemy' : targetFriendly;
}

export function touchSkillRegistryEntry(settings, name, options = {}) {
    const registry = ensureSkillRegistry(settings);
    const entry = findSkillRegistryEntry(registry, name, options);
    if (!entry) return null;
    entry.lastSeenAt = Date.now();
    entry.resolutionCount = (entry.resolutionCount || 0) + 1;
    registry.updatedAt = entry.lastSeenAt;
    return entry;
}

/**
 * Register a form that was authored by the encounter architect or a manual
 * editor without going through the resolver path.
 * @param {Record<string, any>} settings
 * @param {object} rawForm
 * @returns {object|null}
 */
export function rememberSkillForm(settings, rawForm) {
    const registry = ensureSkillRegistry(settings);
    const form = upsertForm(registry, rawForm);
    if (form) registry.updatedAt = Date.now();
    return form;
}
