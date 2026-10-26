/**
 * tactical-combat-classifiers.js — user-editable classification rules for the
 * memo loadout parser. Kept dependency-free so settings can validate the JSON
 * without pulling in the full combat context.
 *
 * The config controls:
 *  - skill kind precedence (heal / special / buff / fallback attack)
 *  - Willpower damage/outcome keywords for mental and morale effects
 *  - buff AC/attack modifiers and duration
 *  - ranged and bonus-action detection
 *  - inventory consumable / healing / special-item keywords
 */

export const DEFAULT_LOADOUT_CLASSIFIER_CONFIG = {
    skillRules: [
        {
            kind: 'heal',
            keywords: ['heal', 'cure', 'restore', 'mend', 'regenerat', 'reviv', 'recover', 'second wind', 'potion'],
        },
        {
            kind: 'special',
            keywords: [
                'summon', 'conjure', 'terrain', 'vein', 'shapechange', 'teleport', 'banish', 'create',
                'wall of', 'pillar', 'hydrokinesis', 'illusion', 'charm', 'dominate', 'stun', 'paralyze',
                'petrify', 'fear', 'prestidigitation', 'thaumaturgy', 'druidcraft', 'minor illusion',
                'mage hand', 'message', 'light', 'transform', 'transformation', 'polymorph',
            ],
        },
        {
            kind: 'buff',
            keywords: [
                'bless', 'shield', 'ward', 'guard', 'haste', 'inspire', 'rage', 'protect', 'sanctuary',
                'invisib', 'mirror image', 'resist', 'aura',
            ],
        },
    ],
    buff: {
        acBonus: 2,
        attackBonus: 1,
        rounds: 2,
        acKeywords: ['shield', 'ward', 'guard', 'protect', 'armor', 'barrier', 'sanctuary'],
        attackKeywords: ['bless', 'inspire', 'haste', 'rage'],
    },
    rangedKeywords: ['ranged', 'range', 'ranged attack', 'at range', 'bolt', 'arrow', 'missile', 'blast', 'ray', 'cone', 'line', 'ft'],
    bonusActionKeyword: 'bonus action',
    area: {
        burstKeywords: [
            'fireball', 'explosion', 'explode', 'detonation', 'nova', 'shockwave', 'eruption',
            'area of effect', 'aoe', 'burst', 'blast radius', 'radius', 'all enemies within',
            'all allies within', 'all creatures within', 'every enemy within', 'every ally within',
            'hits all', 'hits every', 'each creature within',
        ],
        selfKeywords: [
            'aura', 'emanation', 'around you', 'around yourself', 'centered on you',
            'centred on you', 'within range of you', 'centered on yourself', 'centred on yourself',
            'around the caster', 'centered on the caster', 'centred on the caster', 'from the caster',
        ],
        friendlyFireKeywords: ['friendly fire', 'indiscriminate', 'all creatures', 'including allies', 'including your allies'],
        singleTargetKeywords: ['single target', 'one target', 'single creature', 'one creature', 'one enemy', 'one ally'],
        defaultRadius: 1,
        maxRadius: 6,
    },
    items: {
        usableKeywords: ['potion', 'elixir', 'tonic', 'salve', 'remedy', 'antidote', 'scroll', 'bomb', 'flask', 'powder', 'poison', 'poultice', 'ration', 'food', 'vial', 'restoration', 'curative', 'draught'],
        healingKeywords: ['potion', 'elixir', 'tonic', 'salve', 'remedy', 'antidote', 'heal', 'cure', 'restore', 'poultice', 'ration', 'food'],
        willpowerHealingKeywords: ['willpower', 'morale', 'resolve', 'courage', 'spirit'],
        specialItemKeywords: ['scroll', 'bomb', 'flask', 'powder', 'poison', 'vial', 'restoration', 'curative', 'draught', 'curse', 'malady', 'condition'],
    },
    willpower: {
        damageKeywords: ['willpower', 'will damage', 'morale', 'resolve'],
        outcomeRules: [
            { outcome: 'flee', keywords: ['fear', 'terror', 'frighten', 'panic', 'dread', 'demoraliz', 'intimidat', 'despair'] },
            { outcome: 'switch_side', keywords: ['dominate', 'mind control', 'charm', 'seduce', 'possess', 'compel', 'enslave'] },
            { outcome: 'incapacitate', keywords: ['sleep', 'slumber', 'hypnot', 'stun', 'paralyze', 'daze', 'coma'] },
            { outcome: 'surrender', keywords: ['surrender', 'yield', 'submit', 'cower'] },
        ],
        complexKeywords: ['summon', 'conjure', 'terrain', 'vein', 'teleport', 'banish', 'illusion', 'wall of', 'pillar', 'polymorph', 'transform', 'create'],
    },
};

export const DEFAULT_LOADOUT_CLASSIFIER_JSON = JSON.stringify(DEFAULT_LOADOUT_CLASSIFIER_CONFIG, null, 2);

const VALID_KINDS = new Set(['attack', 'heal', 'buff', 'special']);

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function keywordList(value, fallback) {
    if (!Array.isArray(value)) return [...fallback];
    return value
        .map(entry => String(entry || '').trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 80);
}

function numberOr(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeSkillRules(value, fallback) {
    if (!Array.isArray(value)) return [...fallback];
    const rules = [];
    for (const entry of value.slice(0, 12)) {
        if (!entry || typeof entry !== 'object') continue;
        const kind = String(entry.kind || '').toLowerCase();
        if (!VALID_KINDS.has(kind)) continue;
        const keywords = keywordList(entry.keywords, []);
        if (!keywords.length) continue;
        rules.push({ kind, keywords });
    }
    return rules.length ? rules : [...fallback];
}

/**
 * @param {unknown} raw JSON string or object
 * @returns {{ ok: boolean, config: object, error: string, usingDefault: boolean }}
 */
export function normalizeClassifierConfig(raw) {
    const defaults = clone(DEFAULT_LOADOUT_CLASSIFIER_CONFIG);
    if (raw == null || String(raw).trim() === '') {
        return { ok: true, config: defaults, error: '', usingDefault: true };
    }
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch (error) {
            return { ok: false, config: defaults, error: `Invalid JSON: ${error.message}`, usingDefault: true };
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, config: defaults, error: 'Classifier config must be a JSON object.', usingDefault: true };
    }
    const buff = value.buff && typeof value.buff === 'object' ? value.buff : {};
    const area = value.area && typeof value.area === 'object' && !Array.isArray(value.area) ? value.area : {};
    const items = value.items && typeof value.items === 'object' ? value.items : {};
    const config = {
        skillRules: normalizeSkillRules(value.skillRules, defaults.skillRules),
        buff: {
            acBonus: numberOr(buff.acBonus, defaults.buff.acBonus, 0, 20),
            attackBonus: numberOr(buff.attackBonus, defaults.buff.attackBonus, 0, 20),
            rounds: numberOr(buff.rounds, defaults.buff.rounds, 1, 20),
            acKeywords: keywordList(buff.acKeywords, defaults.buff.acKeywords),
            attackKeywords: keywordList(buff.attackKeywords, defaults.buff.attackKeywords),
        },
        rangedKeywords: keywordList(value.rangedKeywords, defaults.rangedKeywords),
        bonusActionKeyword: String(value.bonusActionKeyword || defaults.bonusActionKeyword).trim().toLowerCase() || defaults.bonusActionKeyword,
        area: {
            burstKeywords: keywordList(area.burstKeywords, defaults.area.burstKeywords),
            selfKeywords: keywordList(area.selfKeywords, defaults.area.selfKeywords),
            friendlyFireKeywords: keywordList(area.friendlyFireKeywords, defaults.area.friendlyFireKeywords),
            singleTargetKeywords: keywordList(area.singleTargetKeywords, defaults.area.singleTargetKeywords),
            defaultRadius: numberOr(area.defaultRadius, defaults.area.defaultRadius, 1, defaults.area.maxRadius),
            maxRadius: numberOr(area.maxRadius, defaults.area.maxRadius, 1, 6),
        },
        items: {
            usableKeywords: [...new Set([...keywordList(items.usableKeywords, defaults.items.usableKeywords), ...defaults.items.usableKeywords])],
            healingKeywords: [...new Set([...keywordList(items.healingKeywords, defaults.items.healingKeywords), ...defaults.items.healingKeywords])],
            willpowerHealingKeywords: [...new Set([...keywordList(items.willpowerHealingKeywords, defaults.items.willpowerHealingKeywords), ...defaults.items.willpowerHealingKeywords])],
            specialItemKeywords: [...new Set([...keywordList(items.specialItemKeywords, defaults.items.specialItemKeywords), ...defaults.items.specialItemKeywords])],
        },
        willpower: {
            damageKeywords: keywordList(value.willpower?.damageKeywords, defaults.willpower.damageKeywords),
            outcomeRules: Array.isArray(value.willpower?.outcomeRules)
                ? value.willpower.outcomeRules
                    .filter(rule => rule && typeof rule === 'object' && keywordList(rule.keywords, []).length)
                    .slice(0, 8)
                    .map(rule => ({
                        outcome: ['defeat', 'flee', 'switch_side', 'incapacitate', 'surrender'].includes(String(rule.outcome || '').toLowerCase())
                            ? String(rule.outcome).toLowerCase()
                            : 'defeat',
                        keywords: keywordList(rule.keywords, []),
                    }))
                : defaults.willpower.outcomeRules,
            complexKeywords: keywordList(value.willpower?.complexKeywords, defaults.willpower.complexKeywords),
        },
    };
    return { ok: true, config, error: '', usingDefault: false };
}

/**
 * @param {Record<string, any>} settings
 * @returns {{ config: object, error: string, usingDefault: boolean }}
 */
export function getLoadoutClassifier(settings) {
    const result = normalizeClassifierConfig(settings?.tacticalCombatClassifierJson);
    return { config: result.config, error: result.error, usingDefault: result.usingDefault };
}

export function matchesAny(text, keywords) {
    const source = String(text || '').toLowerCase();
    return (keywords || []).some(keyword => keyword && source.includes(keyword));
}

/**
 * Word-aware match for short inventory keywords. Allows common suffixes
 * (heal/healing, cure/cures, ration/rations) without matching a keyword inside
 * an unrelated word (ration inside Restoration).
 * @param {string} text
 * @param {string[]} keywords
 * @returns {boolean}
 */
export function matchesAnyWord(text, keywords) {
    const source = String(text || '').toLowerCase();
    return (keywords || []).some(keyword => {
        const clean = String(keyword || '').trim().toLowerCase();
        if (!clean) return false;
        const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}[a-z]{0,5}\\b`, 'i').test(source);
    });
}

/**
 * First matching rule wins; unmatched abilities fall back to attack.
 * @param {string} name
 * @param {string} description
 * @param {object} config
 * @returns {'attack'|'heal'|'buff'|'special'}
 */
export function classifyAbility(name, description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    const text = `${name || ''} ${description || ''}`;
    for (const rule of config?.skillRules || []) {
        if (matchesAny(text, rule.keywords)) return rule.kind;
    }
    return 'attack';
}

/**
 * Resolve a source's terminal Willpower outcome from explicit text/keywords.
 * Explicit "on Willpower break: X" syntax is handled by the parser first.
 * @param {string} name
 * @param {string} description
 * @param {object} [config]
 * @returns {'defeat'|'flee'|'switch_side'|'incapacitate'|'surrender'}
 */
export function willpowerOutcomeFor(name, description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    const text = `${name || ''} ${description || ''}`;
    const rules = config?.willpower?.outcomeRules || DEFAULT_LOADOUT_CLASSIFIER_CONFIG.willpower.outcomeRules;
    for (const rule of rules || []) {
        if (matchesAny(text, rule.keywords)) return rule.outcome;
    }
    return 'defeat';
}

export function buffModifiers(name, description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    const text = `${name || ''} ${description || ''}`;
    const buff = config?.buff || DEFAULT_LOADOUT_CLASSIFIER_CONFIG.buff;
    return {
        acBonus: matchesAny(text, buff.acKeywords) ? buff.acBonus : 0,
        attackBonus: matchesAny(text, buff.attackKeywords) ? buff.attackBonus : 0,
        rounds: buff.rounds,
    };
}

export function isRangedAbility(name, description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    return matchesAny(`${name || ''} ${description || ''}`, config?.rangedKeywords);
}

/**
 * Infer an area template from ability/item text. Explicit `Area: burst N` /
 * `Area: aura N` syntax always wins; otherwise conservative keywords are used.
 * A plain "N cells" phrase is treated as range, not radius, so it is ignored
 * here. Returns null for ordinary single-target sources.
 *
 * @param {string} name
 * @param {string} description
 * @param {object} [config]
 * @returns {{ shape: 'burst', radius: number, origin: 'target'|'self', friendlyFire: boolean }|null}
 */
export function parseAreaKeywords(name, description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    const areaConfig = config?.area || DEFAULT_LOADOUT_CLASSIFIER_CONFIG.area;
    const text = `${name || ''} ${description || ''}`.toLowerCase();
    if (!text.trim()) return null;

    const explicitArea = /\b(?:area|aoe)\s*:\s*(?:burst|aura|sphere|radius)\b/i.test(text);
    if (matchesAny(text, areaConfig.singleTargetKeywords || []) && !explicitArea) return null;

    const selfMatched = matchesAny(text, areaConfig.selfKeywords || []);
    const burstMatched = matchesAny(text, areaConfig.burstKeywords || []);
    if (!explicitArea && !selfMatched && !burstMatched) return null;

    const maxRadius = Math.max(1, Math.min(24, Math.round(Number(areaConfig.maxRadius) || 6)));
    const defaultRadius = Math.max(1, Math.min(maxRadius, Math.round(Number(areaConfig.defaultRadius) || 1)));
    const explicitShape = text.match(/\b(?:area|aoe)\s*:\s*(burst|aura|sphere|radius)\b/i);
    const explicitShapeValue = String(explicitShape?.[1] || '').toLowerCase();
    const origin = explicitShapeValue === 'aura'
        ? 'self'
        : explicitShapeValue
            ? 'target'
            : (selfMatched ? 'self' : 'target');

    const radiusPatterns = [
        { pattern: /\b(?:area|aoe)\s*:\s*(?:burst|aura|sphere|radius)\s*(\d+)/i, feet: false },
        { pattern: /\b(?:burst|aura|sphere)\s+(?:of\s*)?(\d+)\b/i, feet: false },
        { pattern: /\bradius\s*(?:of\s*)?(\d+)\s*(?:ft|feet|foot)\b/i, feet: true },
        { pattern: /\b(\d+)\s*(?:ft|feet|foot)\s*radius\b/i, feet: true },
        { pattern: /\bradius\s*(?:of\s*)?(\d+)/i, feet: false },
        { pattern: /\b(\d+)\s*[-\s]?(?:cell|square|tile|space)s?\s*radius\b/i, feet: false },
        { pattern: /\b(?:all|every|each)\s+(?:enemies|allies|creatures|units)\s+(?:within|in)\s+(\d+)\s*(?:-|\s*)?(?:cells?|squares?|tiles?|spaces?)/i, feet: false },
        { pattern: /\b(?:area|aoe)\s*:\s*(?:burst|aura|sphere)\s*(?:of\s*)?(\d+)\s*(?:-|\s*)?(?:cells?|squares?|tiles?|spaces?)\b/i, feet: false },
    ];
    let radius = defaultRadius;
    for (const entry of radiusPatterns) {
        const match = text.match(entry.pattern);
        if (!match) continue;
        const parsed = Math.round(Number(match[1]));
        if (!Number.isFinite(parsed) || parsed <= 0) continue;
        radius = Math.max(1, Math.min(maxRadius, entry.feet ? Math.ceil(parsed / 5) : parsed));
        break;
    }

    return {
        shape: 'burst',
        radius,
        origin,
        friendlyFire: matchesAny(text, areaConfig.friendlyFireKeywords || []),
    };
}

export function isBonusAction(description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    return matchesAny(description, [config?.bonusActionKeyword || 'bonus action']);
}
