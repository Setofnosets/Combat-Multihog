/**
 * tactical-combat-spell-compendium.js — dynamic spell metadata.
 *
 * The State Memo only stores spell NAMES and slot pools, not the full mechanical
 * definition of every spell. This module resolves names against:
 *   1. a small shipped catalog of common tabletop spells,
 *   2. a user-editable JSON override (`tacticalCombatSpellCompendiumJson`),
 *   3. conservative inference for names that appear in the current memo.
 *
 * The catalog is rebuilt for every encounter, so different chats/settings with
 * different spell lists get their own definitions without leaking state.
 */

import {
    DEFAULT_LOADOUT_CLASSIFIER_CONFIG,
    classifyAbility,
    isBonusAction,
    isRangedAbility,
    matchesAnyWord,
    normalizeClassifierConfig,
    parseAreaKeywords,
    willpowerOutcomeFor,
} from './tactical-combat-classifiers.js';
import {
    normalizeEffectCheck,
    sanitizeEffectTemplate,
} from './tactical-combat-effect-template.js';

const CORE_SPELLS = {
    fireball: {
        kind: 'attack',
        damage: '8d6',
        range: 8,
        area: { shape: 'burst', radius: 2, origin: 'target', friendlyFire: false },
        save: 'dex',
        description: 'A bright streak blossoms into a roaring ball of fire.',
    },
    'magic missile': {
        kind: 'attack',
        damage: '3d4+3',
        range: 6,
        description: 'Three glowing darts of magical force unerringly strike their target.',
    },
    'fire bolt': { kind: 'attack', damage: '1d10', range: 6 },
    'ray of frost': { kind: 'attack', damage: '1d8', range: 6 },
    'eldritch blast': { kind: 'attack', damage: '1d10', range: 6 },
    'sacred flame': { kind: 'attack', damage: '1d8', range: 6, save: 'dex' },
    'toll the dead': { kind: 'attack', damage: '1d8', range: 6, save: 'will' },
    'vicious mockery': { kind: 'attack', damage: '1d4', range: 6, resource: 'willpower', willpowerOutcome: 'flee' },
    'guiding bolt': { kind: 'attack', damage: '4d6', range: 6 },
    'burning hands': {
        kind: 'attack',
        damage: '3d6',
        range: 1,
        area: { shape: 'burst', radius: 1, origin: 'target', friendlyFire: false },
        save: 'dex',
    },
    shatter: {
        kind: 'attack',
        damage: '3d8',
        range: 6,
        area: { shape: 'burst', radius: 1, origin: 'target', friendlyFire: false },
        save: 'con',
    },
    thunderwave: {
        kind: 'attack',
        damage: '2d8',
        range: 0,
        area: { shape: 'burst', radius: 1, origin: 'self', friendlyFire: false },
        save: 'con',
    },
    'cure wounds': { kind: 'heal', heal: '1d8+2', range: 1, target: 'ally' },
    'healing word': { kind: 'heal', heal: '1d4+2', range: 6, target: 'ally', bonusAction: true },
    'mass cure wounds': {
        kind: 'heal',
        heal: '3d8+2',
        range: 6,
        target: 'ally',
        area: { shape: 'burst', radius: 2, origin: 'target', friendlyFire: false },
    },
    'healing spirit': {
        kind: 'heal',
        heal: '1d6',
        range: 6,
        target: 'ally',
        area: { shape: 'burst', radius: 1, origin: 'target', friendlyFire: false },
    },
    shield: { kind: 'buff', acBonus: 5, rounds: 1, range: 0, target: 'self', description: 'A shimmering barrier of force.' },
    bless: { kind: 'buff', attackBonus: 1, rounds: 3, range: 6, target: 'ally' },
    haste: { kind: 'buff', acBonus: 2, attackBonus: 1, rounds: 3, range: 6, target: 'ally' },
    'shield of faith': { kind: 'buff', acBonus: 2, rounds: 3, range: 6, target: 'ally' },
    'mage armor': { kind: 'buff', acBonus: 3, rounds: 8, range: 1, target: 'ally' },
    invisibility: { kind: 'buff', acBonus: 0, attackBonus: 0, rounds: 3, range: 1, target: 'ally' },
    'detect magic': { kind: 'special', range: 6, target: 'self', utility: true },
    light: { kind: 'special', range: 1, target: 'any', utility: true },
    'mage hand': { kind: 'special', range: 6, target: 'any', utility: true },
    message: { kind: 'special', range: 12, target: 'any', utility: true },
    prestidigitation: { kind: 'special', range: 1, target: 'any', utility: true },
    thaumaturgy: { kind: 'special', range: 1, target: 'any', utility: true },
    druidcraft: { kind: 'special', range: 1, target: 'any', utility: true },
    'minor illusion': { kind: 'special', range: 6, target: 'any', utility: true },
    'silent image': { kind: 'special', range: 12, target: 'any', utility: true },
    'misty step': { kind: 'special', range: 1, target: 'self', utility: true, bonusAction: true },
    'charm person': { kind: 'attack', resource: 'willpower', willpowerOutcome: 'switch_side', damage: '1d6', range: 6, save: 'will' },
    'hold person': { kind: 'attack', resource: 'willpower', willpowerOutcome: 'incapacitate', damage: '1d6', range: 6, save: 'will' },
    sleep: { kind: 'attack', resource: 'willpower', willpowerOutcome: 'incapacitate', damage: '1d6', range: 6, save: 'will' },
    fear: { kind: 'attack', resource: 'willpower', willpowerOutcome: 'flee', damage: '1d6', range: 6, save: 'will' },
    'cause fear': { kind: 'attack', resource: 'willpower', willpowerOutcome: 'flee', damage: '1d6', range: 6, save: 'will' },
    command: { kind: 'attack', resource: 'willpower', willpowerOutcome: 'surrender', damage: '1d6', range: 6, save: 'will' },
    'dread wail': { kind: 'attack', resource: 'willpower', willpowerOutcome: 'flee', damage: '2d6', range: 6, save: 'will' },
    'psychic lance': { kind: 'attack', resource: 'both', damage: '2d6', willpowerDamage: '1d6', willpowerOutcome: 'surrender', range: 8, save: 'will' },
    'mind ward': { kind: 'heal', resource: 'willpower', heal: '1d6', range: 0, target: 'self' },
    'dissonant whispers': { kind: 'attack', resource: 'willpower', willpowerOutcome: 'flee', damage: '3d6', range: 6, save: 'will' },
    'spirit guardians': {
        kind: 'attack',
        damage: '3d8',
        range: 0,
        resource: 'willpower',
        willpowerOutcome: 'flee',
        area: { shape: 'burst', radius: 2, origin: 'self', friendlyFire: false },
        save: 'will',
    },
    'mass healing word': {
        kind: 'heal',
        heal: '1d4+2',
        range: 6,
        target: 'ally',
        bonusAction: true,
        area: { shape: 'burst', radius: 2, origin: 'target', friendlyFire: false },
    },
};

const UTILITY_KEYWORDS = [
    'detect', 'identify', 'alarm', 'comprehend', 'disguise', 'feather fall', 'levitate',
    'unseen servant', 'floating disk', 'locate', 'speak with', 'water breathing',
    'arcane lock', 'knock', 'nondetection', 'scrying', 'teleport', 'plane shift',
];

function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function normalizeKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[’']/g, "'");
}

function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const kindRaw = String(raw.kind || raw.type || 'attack').toLowerCase();
    const kind = ['attack', 'heal', 'buff', 'special'].includes(kindRaw) ? kindRaw : 'attack';
    const typeRaw = String(raw.category || raw.skillType || raw.type || (raw.spell === true ? 'spell' : '')).toLowerCase();
    const type = ['spell', 'ability', 'item', 'trait', 'technique', 'class-feature'].includes(typeRaw)
        ? typeRaw
        : (raw.spell === true ? 'spell' : 'ability');
    const resource = ['hp', 'willpower', 'both'].includes(String(raw.resource || '').toLowerCase())
        ? String(raw.resource).toLowerCase()
        : 'hp';
    const area = raw.area && typeof raw.area === 'object' ? raw.area : null;
    const target = ['enemy', 'ally', 'self', 'any'].includes(String(raw.target || '').toLowerCase())
        ? String(raw.target).toLowerCase()
        : (kind === 'attack' ? 'enemy' : kind === 'special' ? 'any' : 'ally');
    const effectTemplate = sanitizeEffectTemplate(raw.effectTemplate ?? raw.effects ?? raw.template, { max: 16 });
    return {
        kind,
        type,
        resource,
        damage: String(raw.damage || '').slice(0, 40),
        willpowerDamage: String(raw.willpowerDamage ?? raw.willDamage ?? '').slice(0, 40),
        willpowerOutcome: String(raw.willpowerOutcome ?? raw.willOutcome ?? 'defeat').toLowerCase(),
        heal: String(raw.heal || '').slice(0, 40),
        range: raw.range == null ? null : Math.max(0, Math.min(24, Math.round(Number(raw.range)) || 0)),
        area: area ? clone(area) : null,
        acBonus: Number(raw.acBonus) || 0,
        attackBonus: Number(raw.attackBonus) || 0,
        rounds: Math.max(1, Math.min(10, Math.round(Number(raw.rounds) || 2))),
        bonusAction: raw.bonusAction === true,
        target,
        save: ['dex', 'con', 'will', 'str', 'int', 'cha'].includes(String(raw.save || '').toLowerCase())
            ? String(raw.save).toLowerCase()
            : '',
        check: normalizeEffectCheck(raw.check ? {
            ...raw.check,
            save: raw.check.save ?? raw.save,
            type: raw.check.type ?? (raw.save ? 'save' : undefined),
        } : { type: raw.save ? 'save' : undefined, save: raw.save }),
        utility: raw.utility === true,
        description: String(raw.description || raw.brief || '').slice(0, 400),
        aliases: Array.isArray(raw.aliases)
            ? raw.aliases.map(alias => String(alias || '').trim()).filter(Boolean).slice(0, 12)
            : [],
        tags: Array.isArray(raw.tags)
            ? raw.tags.map(tag => String(tag || '').trim()).filter(Boolean).slice(0, 20)
            : [],
        maxUses: raw.maxUses == null ? null : Math.max(0, Math.min(99, Math.round(Number(raw.maxUses)) || 0)),
        unlimited: raw.unlimited === true,
        effectTemplate: effectTemplate.length ? effectTemplate : null,
        registryId: String(raw.registryId || '').slice(0, 80),
        status: String(raw.status || '').slice(0, 20),
        source: String(raw.source || 'config'),
    };
}

/**
 * @param {unknown} raw
 * @returns {{ ok:boolean, config:{spells:Record<string,object>, skills:Record<string,object>}, error:string, usingDefault:boolean }}
 */
export function normalizeSkillCompendium(raw) {
    const defaults = Object.fromEntries(
        Object.entries(CORE_SPELLS).map(([name, entry]) => [normalizeKey(name), normalizeEntry(entry)]),
    );
    if (raw == null || String(raw).trim() === '') {
        return {
            ok: true,
            config: { spells: defaults, skills: defaults },
            error: '',
            usingDefault: true,
        };
    }
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch (error) {
            return {
                ok: false,
                config: { spells: defaults, skills: defaults },
                error: `Invalid JSON: ${error.message}`,
                usingDefault: true,
            };
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            ok: false,
            config: { spells: defaults, skills: defaults },
            error: 'Skill compendium must be a JSON object.',
            usingDefault: true,
        };
    }
    const sectionKeys = ['skills', 'spells', 'abilities', 'items'];
    const hasSections = sectionKeys.some(key => value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]));
    const sources = [];
    if (hasSections) {
        for (const key of sectionKeys) {
            const section = value[key];
            if (section && typeof section === 'object' && !Array.isArray(section)) sources.push(section);
        }
    } else {
        sources.push(value);
    }
    const spells = { ...defaults };
    for (const source of sources) {
        for (const [name, entry] of Object.entries(source)) {
            if (!name || sectionKeys.includes(name)) continue;
            const normalized = normalizeEntry(entry);
            if (normalized) spells[normalizeKey(name)] = normalized;
        }
    }
    return {
        ok: true,
        config: { spells, skills: spells },
        error: '',
        usingDefault: false,
    };
}

/** Legacy name kept for imports and settings from older builds. */
export const normalizeSpellCompendium = normalizeSkillCompendium;

/**
 * Extract every spell name mentioned in a memo. Used to build a per-encounter
 * inferred catalog so a homebrew setting gets meaningful defaults without a
 * hardcoded global list.
 * @param {string} memo
 * @returns {{ name:string, level:number }[]}
 */
export function extractSpellNamesFromMemo(memo) {
    const source = String(memo || '');
    const entries = new Map();
    const add = (name, level = 0) => {
        const cleaned = String(name || '').trim();
        if (!cleaned || cleaned.length < 2) return;
        if (/^(level|cantrips?|spells?|abilities|prepared|unprepared|known|memorized|memorised)$/i.test(cleaned)) return;
        const key = normalizeKey(cleaned);
        if (!entries.has(key)) entries.set(key, { name: cleaned, level });
    };
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim().replace(/^\s*[-*+•]\s*/, '');
        if (!/^Spells:/i.test(line) && !/^Level\s+\d+/i.test(line) && !/^Cantrips:/i.test(line)) continue;
        let working = line.replace(/^Spells:\s*/i, '');
        const levelMatch = working.match(/^Level\s+(\d+)\b/i);
        const cantrip = /^Cantrips:/i.test(working);
        const level = cantrip ? 0 : (levelMatch ? Number(levelMatch[1]) : 0);
        working = working
            .replace(/^Level\s+\d+\s*(?:\([^)]*\))?\s*:?\s*/i, '')
            .replace(/^Cantrips:\s*/i, '')
            .replace(/\([^)]*\)/g, '');
        for (const part of working.split(/[,;]/)) add(part, level);
    }
    return [...entries.values()];
}

function levelDamage(level) {
    if (!level) return '1d10';
    if (level === 1) return '2d6';
    if (level === 2) return '3d6';
    if (level === 3) return '5d6';
    if (level === 4) return '6d6';
    if (level === 5) return '7d6';
    if (level === 6) return '8d6';
    if (level === 7) return '9d6';
    if (level === 8) return '10d6';
    return '12d6';
}

/**
 * Conservative inference for homebrew names. This is intentionally less
 * ambitious than the shipped catalog: it only fills in obvious archetypes and
 * leaves genuinely ambiguous names to the existing classifier/resolver.
 * @param {string} name
 * @param {number} level
 * @param {object} classifier
 * @returns {object|null}
 */
export function inferSpellDefinition(name, level, classifier = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    const cleaned = String(name || '').trim();
    if (!cleaned) return null;
    const text = cleaned.toLowerCase();
    if (matchesAnyWord(text, UTILITY_KEYWORDS)) {
        return normalizeEntry({
            kind: 'special', range: 6, target: 'any', utility: true,
            description: `${cleaned} is a utility spell.`,
            source: 'inferred',
        });
    }
    const kind = classifyAbility(cleaned, '', classifier);
    const area = parseAreaKeywords(cleaned, '', classifier);
    const outcome = willpowerOutcomeFor(cleaned, '', classifier);
    const willpower = outcome !== 'defeat'
        || matchesAnyWord(text, classifier?.willpower?.damageKeywords || []);
    if (kind === 'heal' || kind === 'buff') {
        return normalizeEntry({
            kind,
            heal: kind === 'heal' ? (level ? `${Math.max(1, level)}d8+2` : '1d8+2') : '',
            range: kind === 'buff' ? 6 : (/\btouch\b/.test(text) ? 1 : 6),
            target: 'ally',
            area,
            bonusAction: isBonusAction(text, classifier),
            description: `${cleaned} is inferred from its name.`,
            source: 'inferred',
        });
    }
    if (kind === 'special' && !willpower && !area) {
        return normalizeEntry({
            kind: 'special', range: 6, target: 'any', area,
            description: `${cleaned} is inferred as a freeform spell.`,
            source: 'inferred',
        });
    }
    return normalizeEntry({
        kind: willpower && !area ? 'attack' : kind,
        resource: willpower ? 'willpower' : 'hp',
        willpowerOutcome: willpower ? outcome : 'defeat',
        damage: levelDamage(level),
        range: area && area.origin === 'self' ? 0 : (isRangedAbility(cleaned, '', classifier) || area ? 6 : 1),
        area,
        bonusAction: isBonusAction(text, classifier),
        description: `${cleaned} is inferred from its name and spell level.`,
        source: 'inferred',
    });
}

/**
 * Build the encounter's spell catalog.
 * @param {Record<string,any>} settings
 * @param {string} memo
 * @returns {{ spells:Record<string,object>, error:string, usingDefault:boolean, inferred:string[] }}
 */
export function buildSpellCompendium(settings, memo) {
    const normalized = normalizeSpellCompendium(settings?.tacticalCombatSpellCompendiumJson);
    const classifierResult = normalizeClassifierConfig(settings?.tacticalCombatClassifierJson).config;
    const spells = { ...normalized.config.spells };
    const inferred = [];
    for (const entry of extractSpellNamesFromMemo(memo)) {
        const key = normalizeKey(entry.name);
        if (spells[key]) continue;
        const definition = inferSpellDefinition(entry.name, entry.level, classifierResult);
        if (!definition) continue;
        spells[key] = definition;
        inferred.push(entry.name);
    }
    return {
        spells,
        error: normalized.error,
        usingDefault: normalized.usingDefault,
        inferred,
    };
}

/**
 * @param {object} compendium
 * @param {string} name
 * @returns {object|null}
 */
export function getSpellDefinition(compendium, name) {
    if (!compendium?.spells) return null;
    return compendium.spells[normalizeKey(name)] || null;
}

export const DEFAULT_SPELL_COMPENDIUM_JSON = JSON.stringify(
    { spells: CORE_SPELLS },
    null,
    2,
);

/** General-purpose aliases. The legacy spell names remain for compatibility. */
export const DEFAULT_SKILL_COMPENDIUM_JSON = DEFAULT_SPELL_COMPENDIUM_JSON;
export const getSkillDefinition = getSpellDefinition;
export const buildSkillCompendium = buildSpellCompendium;
