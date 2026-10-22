/**
 * tactical-combat-classifiers.js — user-editable classification rules for the
 * memo loadout parser. Kept dependency-free so settings can validate the JSON
 * without pulling in the full combat context.
 *
 * The config controls:
 *  - skill kind precedence (heal / special / buff / fallback attack)
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
    items: {
        usableKeywords: ['potion', 'elixir', 'tonic', 'salve', 'remedy', 'antidote', 'scroll', 'bomb', 'flask', 'powder', 'poison', 'poultice', 'ration', 'food', 'vial', 'restoration', 'curative', 'draught'],
        healingKeywords: ['potion', 'elixir', 'tonic', 'salve', 'remedy', 'antidote', 'heal', 'cure', 'restore', 'poultice', 'ration', 'food'],
        specialItemKeywords: ['scroll', 'bomb', 'flask', 'powder', 'poison', 'vial', 'restoration', 'curative', 'draught', 'curse', 'malady', 'condition'],
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
        items: {
            usableKeywords: [...new Set([...keywordList(items.usableKeywords, defaults.items.usableKeywords), ...defaults.items.usableKeywords])],
            healingKeywords: [...new Set([...keywordList(items.healingKeywords, defaults.items.healingKeywords), ...defaults.items.healingKeywords])],
            specialItemKeywords: [...new Set([...keywordList(items.specialItemKeywords, defaults.items.specialItemKeywords), ...defaults.items.specialItemKeywords])],
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

export function isBonusAction(description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    return matchesAny(description, [config?.bonusActionKeyword || 'bonus action']);
}
