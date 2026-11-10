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
    attackKeywords: [
        'attack', 'strike', 'bash', 'smash', 'slash', 'pierce', 'cleave', 'shot', 'bolt',
        'arrow', 'blade', 'sword', 'axe', 'hammer', 'mace', 'spear', 'claw', 'bite',
        'punch', 'kick', 'wound', 'damage', 'blast', 'beam', 'zap', 'burst', 'missile',
        'lance', 'javelin', 'dart', 'slam', 'smite', 'rend',
    ],
    damageKeywords: [
        'damage', 'deal', 'deals', 'dealing', 'drain', 'drains', 'harm', 'injure',
        'burn', 'burns', 'freeze', 'freezes', 'shock', 'shocks', 'strike', 'strikes',
        'hit', 'hits', 'attack', 'attacks', 'wound', 'wounds', 'blast', 'detonate',
        'explode', 'explosion', 'slam', 'slash', 'pierce', 'punch', 'kick', 'bite', 'claw',
    ],
    damageTypeKeywords: [
        'acid', 'cold', 'fire', 'force', 'lightning', 'thunder', 'necrotic', 'poison',
        'psychic', 'radiant', 'slashing', 'piercing', 'bludgeoning',
    ],
    passiveKeywords: [
        'passive', 'always active', 'always-on', 'always on', 'on hit', 'on a hit',
        'when hit', 'whenever', 'advantage on',
    ],
    passiveNames: [
        'pack tactics', 'spellcasting', 'darkvision', 'keen senses', 'legendary resistance',
        'magic resistance', 'evasion', 'uncanny dodge', 'sneak attack', 'brutal strike',
        'dual strike', 'regeneration', 'fast healing', 'multiattack', 'turn resistance',
        'undead fortitude', 'pack hunter', 'relentless', 'brave', 'stone cunning',
        'fey ancestry', 'hellish resistance', 'damage resistance', 'damage immunity',
    ],
    utilityKeywords: [
        'teleport', 'blink', 'misty step', 'disengage', 'dash', 'dodge', 'hide', 'stealth',
        'invisible', 'invisibility', 'levitate', 'fly', 'feather fall', 'jump', 'climb',
        'swim', 'water walk', 'water breathing', 'light', 'darkness', 'detect',
        'see invisibility', 'truesight', 'true sight', 'identify', 'dispel', 'counterspell',
        'action surge', 'extra action', 'bonus action', 'reaction', 'grapple', 'shove',
        'push', 'pull', 'restrain', 'knock prone', 'blind', 'silence', 'calm', 'purify',
        'freedom', 'remove curse', 'disguise', 'locate', 'scrying', 'speak with',
        'unseen servant', 'floating disk', 'mage hand', 'minor illusion', 'silent image',
        'detect magic', 'pass without trace', 'fog cloud', 'daylight',
    ],
    complexKeywords: [
        'summon', 'conjure', 'terrain', 'vein', 'shapechange', 'transform', 'transformation',
        'polymorph', 'banish', 'wall of', 'pillar', 'create', 'illusion', 'dominate',
        'mind control', 'possession', 'plane shift', 'resurrection', 'revive',
    ],
    noncombatKeywords: [
        'telepath', 'telepathy', 'mind link', 'comprehend language', 'comprehend languages',
        'languages', 'tongues', 'mending', 'repair', 'prestidigitation', 'druidcraft',
        'thaumaturgy', 'message', 'sending', 'arcane lock', 'knock', 'alarm', 'identify',
        'silver tongue', 'persuasion', 'deception', 'quick lie', 'haggle', 'barter',
        'craft', 'cook', 'forge', 'navigate', 'sail', 'track', 'arcane recovery',
        'spell slots', 'regain spell slots', 'recover spell slots', 'downtime', 'ritual',
        'lore', 'history',
    ],
    defensiveKeywords: [
        'ward', 'stance', 'resist', 'resistance', 'immune', 'immunity', 'protect',
        'protective', 'against', 'clear', 'remove', 'cure', 'freedom', 'shield', 'barrier',
        'sanctuary', 'calm', 'soothe', 'purify', 'negate', 'prevent', 'deflect', 'block',
    ],
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
            { outcome: 'flee', keywords: ['fear', 'terror', 'frighten', 'terrif', 'panic', 'dread', 'demoraliz', 'intimidat', 'despair'] },
            { outcome: 'switch_side', keywords: ['dominat', 'mind control', 'charm', 'seduc', 'possess', 'compel', 'enslav'] },
            { outcome: 'incapacitate', keywords: ['sleep', 'slumber', 'hypnot', 'stun', 'paralyz', 'daz', 'coma', 'petrif', 'hold person', 'hold monster'] },
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
        attackKeywords: keywordList(value.attackKeywords, defaults.attackKeywords),
        damageKeywords: keywordList(value.damageKeywords, defaults.damageKeywords),
        damageTypeKeywords: keywordList(value.damageTypeKeywords, defaults.damageTypeKeywords),
        passiveKeywords: keywordList(value.passiveKeywords, defaults.passiveKeywords),
        passiveNames: keywordList(value.passiveNames, defaults.passiveNames),
        utilityKeywords: keywordList(value.utilityKeywords, defaults.utilityKeywords),
        complexKeywords: keywordList(value.complexKeywords, defaults.complexKeywords),
        noncombatKeywords: keywordList(value.noncombatKeywords, defaults.noncombatKeywords),
        defensiveKeywords: keywordList(value.defensiveKeywords, defaults.defensiveKeywords),
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
        // Very short/ambiguous words must match as whole words. The suffix
        // allowance exists for natural stems ("regenerat", "invisib").
        if (clean === 'light' || clean === 'ft') {
            return new RegExp(`\\b${escaped}\\b`, 'i').test(source);
        }
        const regex = new RegExp(
            `\\b${escaped}((?:s|es|ed|d|ing|er|ers|ion|ions|ment|ments|ive|ives|al|ic|ous|ful|fully|ly|ness|some|le|e|ize|ized|izing|ise|ised|ising|ned|ning|led|ling|ied|ying)?)\\b`,
            'gi',
        );
        for (const match of source.matchAll(regex)) {
            const suffix = String(match[1] || '').toLowerCase();
            // "fearless" is not fear, and "restoration-proof" is not a
            // restoration consumable. Other natural inflections are allowed.
            if (!/(?:less|proof|free)$/.test(suffix)) return true;
        }
        return false;
    });
}

const DEFAULT_ATTACK_DAMAGE_HINTS = new Set(['1d8', '1d10', '2d6', '1d6']);

export const SKILL_INTENTS = Object.freeze([
    'attack', 'heal', 'buff', 'special', 'utility', 'passive', 'noncombat', 'unknown',
]);

const INTENT_SET = new Set(SKILL_INTENTS);

/** @param {any} value */
export function normalizeSkillIntent(value) {
    const intent = String(value || '').trim().toLowerCase();
    return INTENT_SET.has(intent) ? intent : '';
}

/**
 * Heal words are only healing when they refer to HP, wounds, life, or a dice
 * expression. "Recover spell slots" must not become a healing spell.
 * @param {string} text
 * @param {object} [config]
 */
export function hasHealingSignal(text, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    const source = String(text || '');
    if (!source.trim()) return false;
    const healRule = (config?.skillRules || []).find(rule => rule.kind === 'heal');
    const healWord = healRule ? matchesAnyWord(source, healRule.keywords) : false;
    if (!healWord) return false;
    const hpContext = /\b(?:hp|hit points?|health|wounds?|injuries|injur(?:y|ed)|life|dying|dead)\b/i.test(source)
        || /\b\d+d\d+(?:\s*[+-]\s*\d+)?\s*(?:hp|hit points?|health)\b/i.test(source);
    const willContext = /\b(?:willpower|will)\b/i.test(source)
        && /\b(?:heal|healing|restore|restored|recover|recovery)\b/i.test(source);
    return hpContext || willContext;
}

/** @param {string} text @param {object} [config] */
export function hasActiveCombatMechanics(text, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    const source = String(text || '');
    if (!source.trim()) return false;
    const dice = /\b\d+d\d+(?:\s*[+-]\s*\d+)?\b/i.test(source);
    const damageWord = matchesAnyWord(source, config?.damageKeywords || DEFAULT_LOADOUT_CLASSIFIER_CONFIG.damageKeywords);
    const damageType = matchesAnyWord(source, config?.damageTypeKeywords || DEFAULT_LOADOUT_CLASSIFIER_CONFIG.damageTypeKeywords);
    const numericBuff = /(?:[+-]\s*\d+\s*(?:ac|attack|armor class|attack bonus)|(?:ac|attack|armor class|attack bonus)\s*(?:bonus|penalty)?\s*[+-]\s*\d+|saving throw|save dc)/i.test(source);
    const willpower = /\b(?:willpower|will)\b/i.test(source)
        && /\b(?:damage|drain|loss|heal|healing|restore|recover)\b/i.test(source);
    if (willpower && (dice || /\b\d+\b/.test(source))) return true;
    if (hasHealingSignal(source, config)) return true;
    if (dice && (damageWord || damageType)) return true;
    if (numericBuff) return true;
    return false;
}

/** @param {string} text @param {object} [config] */
export function isDefensiveSkillText(text, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    return matchesAnyWord(text, config?.defensiveKeywords || DEFAULT_LOADOUT_CLASSIFIER_CONFIG.defensiveKeywords);
}

/**
 * True when the text contains actual damage language rather than merely
 * mentioning attack rolls. "Bless: add 1d4 to attack rolls" is not damage.
 * @param {string} text
 * @param {object} [config]
 */
export function hasDamageSignal(text, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    const source = String(text || '');
    if (!source.trim()) return false;
    const dice = /\b\d+d\d+(?:\s*[+-]\s*\d+)?\b/i.test(source);
    const damageType = matchesAnyWord(source, config?.damageTypeKeywords || DEFAULT_LOADOUT_CLASSIFIER_CONFIG.damageTypeKeywords);
    const damageVerb = matchesAnyWord(source, [
        'damage', 'drain', 'deal', 'deals', 'wound', 'wounds', 'harm', 'strike', 'strikes',
        'blast', 'burn', 'burns', 'freeze', 'shock', 'bite', 'claw', 'punch',
        'kick', 'slash', 'pierce', 'smash', 'slam', 'rend', 'detonate', 'explode',
    ]);
    return damageVerb || (dice && damageType) || (dice && /\b(?:damage|drain)\b/i.test(source));
}

/**
 * @param {string} name
 * @param {string} description
 * @param {object} [config]
 * @returns {{ explicit:boolean, resource:'hp'|'willpower'|'both', heal:boolean, damage:string, willpowerDamage:string, willpowerOutcome:string, outcome:string }}
 */
export function detectWillpowerProfile(name, description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    const text = `${name || ''} ${description || ''}`;
    const bothMatch = text.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?|\d+)\s*HP\s*\+\s*(\d+d\d+(?:\s*[+-]\s*\d+)?|\d+)\s*(?:willpower|will)\b/i);
    const willHealMatch = text.match(/(?:willpower|will)\s+heal(?:ing)?\s*:?\s*(\d+d\d+(?:\s*[+-]\s*\d+)?|\d+)|\bheal(?:ing)?\s+(\d+d\d+(?:\s*[+-]\s*\d+)?|\d+)\s+(?:willpower|will)\b/i);
    const willAmountMatch = text.match(/(?:willpower|will)\s*(?:damage|drain|loss|cost)?\s*:?\s*(\d+d\d+(?:\s*[+-]\s*\d+)?|\d+)|\b(\d+d\d+(?:\s*[+-]\s*\d+)?|\d+)\s*(?:points?\s+of\s+)?(?:willpower|will)\b/i)
        || text.match(/\b(?:damage|drain|loss|cost)\s+(?:to\s+)?(?:willpower|will)\b/i);
    const explicitDamage = /\b(?:willpower|will)\s+(?:damage|drain|loss)\b|\b(?:damage|drain|loss)\s+(?:to\s+)?(?:willpower|will)\b|\b(?:morale|resolve|sanity)\s+(?:damage|drain|loss)\b/i.test(text);
    const outcome = willpowerOutcomeFor(name, description, config);
    const offensiveOutcome = outcome !== 'defeat' && !isDefensiveSkillText(text, config);
    const explicit = !!bothMatch || !!willHealMatch || !!willAmountMatch || explicitDamage || offensiveOutcome;
    const heal = !!willHealMatch;
    let resource = 'hp';
    if (bothMatch) resource = 'both';
    else if (willHealMatch || explicitDamage || offensiveOutcome) resource = 'willpower';
    const damage = bothMatch
        ? String(bothMatch[1]).replace(/\s+/g, '')
        : (willHealMatch
            ? String(willHealMatch[1] || willHealMatch[2] || '').replace(/\s+/g, '')
            : String(willAmountMatch?.[1] || willAmountMatch?.[2] || '').replace(/\s+/g, ''));
    const willpowerDamage = bothMatch ? String(bothMatch[2]).replace(/\s+/g, '') : '';
    return {
        explicit,
        resource,
        heal,
        damage,
        willpowerDamage,
        willpowerOutcome: heal ? 'defeat' : outcome,
        outcome,
    };
}

function hasStrongPassivePattern(name, description, config) {
    const nameText = String(name || '').toLowerCase().trim();
    const descriptionText = String(description || '').trim();
    const text = `${nameText} ${descriptionText}`.toLowerCase();
    if (!text.trim()) return false;
    const normalizedName = nameText.replace(/\s+/g, ' ').trim();
    if ((config?.passiveNames || []).some(entry => String(entry || '').trim().toLowerCase().replace(/\s+/g, ' ') === normalizedName)) return true;
    if (matchesAnyWord(text, config?.passiveKeywords || []) && !hasActiveCombatMechanics(text, config)) return true;
    if (/\bpassive\s*:/i.test(text) || /^\s*passive\b/i.test(descriptionText)) return true;
    if (/\b(?:always active|always-on|always on)\b/i.test(text)) return true;
    if (/\b(?:on|when) (?:a |the |an |each |every )?(?:melee |ranged |weapon )?hit\b/i.test(text)) return true;
    if (/\bon (?:a |the |an )?[a-z' -]{0,25}\bhit\b/i.test(text)) return true;
    if (/\bwhen [^.;]{0,35}\b(?:hit|hits)\b/i.test(text)) return true;
    if (/\bwhenever\b/i.test(text)) return true;
    if (/\bextra\s+\d+d\d+\b|\badditional\s+\d+d\d+\b|\bdeal(?:s|ing)? an extra\b/i.test(text)) return true;
    if (/\badvantage on\b/i.test(text) && !/\bdamage\b/i.test(text)) return true;
    if (/\b(?:you|the owner|this creature)\s+(?:gain|gains|have|has)\b/i.test(text)
        && !hasActiveCombatMechanics(text, config)) return true;
    return false;
}

/**
 * Classify what a named ability is for. The intent layer is deliberately
 * separate from the engine's four `kind` values so utility/passive/non-combat
 * skills can be carried without pretending they are attacks.
 *
 * @param {string} name
 * @param {string} [description]
 * @param {{ config?:object, type?:string, passive?:boolean, utility?:boolean, noncombat?:boolean, intent?:string, definition?:any, definitionAuthoritative?:boolean, usage?:string }} [options]
 * @returns {{ intent:string, kind:'attack'|'heal'|'buff'|'special', passive:boolean, utility:boolean, noncombat:boolean, resource:'hp'|'willpower'|'both', willpowerOutcome:string, damage:string, heal:string, confidence:string, reason:string }}
 */
export function classifySkillIntent(name, description = '', options = {}) {
    const config = options.config || DEFAULT_LOADOUT_CLASSIFIER_CONFIG;
    const sourceName = String(name || '').trim();
    const sourceDescription = String(description || '').trim();
    const text = `${sourceName} ${sourceDescription}`;
    const definition = options.definition && typeof options.definition === 'object' ? options.definition : null;
    const definitionAuthoritative = options.definitionAuthoritative === true
        || ['config', 'manual', 'resolver', 'architect', 'lorebook', 'ai', 'ai-intent'].includes(String(definition?.source || '').toLowerCase())
        || ['ai', 'manual', 'explicit', 'definition', 'resolved'].includes(String(definition?.intentSource || '').toLowerCase())
        || definition?.locked === true
        || definition?.status === 'resolved'
        || (Array.isArray(definition?.effectTemplate) && definition.effectTemplate.length > 0);
    const definitionIntent = definitionAuthoritative ? normalizeSkillIntent(definition?.intent) : '';
    const explicitIntent = normalizeSkillIntent(options.intent) || definitionIntent;
    const make = (intent, extra = {}) => {
        const kind = extra.kind || (intent === 'attack' ? 'attack'
            : intent === 'heal' ? 'heal'
                : intent === 'buff' ? 'buff'
                    : 'special');
        return {
            intent,
            kind,
            passive: intent === 'passive' || extra.passive === true,
            utility: intent === 'utility' || extra.utility === true,
            noncombat: intent === 'noncombat' || extra.noncombat === true,
            resource: extra.resource || 'hp',
            willpowerOutcome: extra.willpowerOutcome || 'defeat',
            damage: String(extra.damage || ''),
            heal: String(extra.heal || ''),
            confidence: extra.confidence || 'inferred',
            reason: extra.reason || '',
        };
    };

    if (explicitIntent) {
        return make(explicitIntent, {
            resource: definition?.resource,
            willpowerOutcome: definition?.willpowerOutcome,
            damage: definition?.damage,
            heal: definition?.heal,
            confidence: 'explicit',
            reason: 'explicit intent',
        });
    }
    if (/^\s*non[- ]?combat\s*:/i.test(sourceDescription) || /^\s*non[- ]?combat\s*:/i.test(sourceName) || /^\s*social\s*:/i.test(sourceDescription)) {
        return make('noncombat', { confidence: 'explicit', reason: 'explicit non-combat prefix' });
    }
    if (/^\s*utility\s*:/i.test(sourceDescription) || /^\s*utility\s*:/i.test(sourceName)) {
        return make('utility', { confidence: 'explicit', reason: 'explicit utility prefix' });
    }
    if (options.passive === true
        || definition?.passive === true
        || /^\s*passive\b/i.test(sourceDescription)
        || /^\s*passive\s*:/i.test(sourceName)) {
        return make('passive', { confidence: 'explicit', reason: 'explicit passive marker' });
    }
    if (options.utility === true || definition?.utility === true) {
        return make('utility', { confidence: 'explicit', reason: 'explicit utility flag' });
    }
    if (options.noncombat === true || definition?.noncombat === true) {
        return make('noncombat', { confidence: 'explicit', reason: 'explicit non-combat flag' });
    }
    if (definitionAuthoritative && Array.isArray(definition?.effectTemplate) && definition.effectTemplate.length) {
        return make('special', {
            resource: definition.resource,
            willpowerOutcome: definition.willpowerOutcome,
            damage: definition.damage,
            heal: definition.heal,
            confidence: 'resolved',
            reason: 'resolved effect template',
        });
    }

    const passive = hasStrongPassivePattern(sourceName, sourceDescription, config);
    const active = hasActiveCombatMechanics(text, config);
    const willpower = detectWillpowerProfile(sourceName, sourceDescription, config);
    if (passive) {
        return make('passive', { confidence: 'pattern', reason: 'passive pattern' });
    }
    if (willpower.explicit) {
        return make(willpower.heal ? 'heal' : 'attack', {
            resource: willpower.resource,
            willpowerOutcome: willpower.willpowerOutcome,
            damage: willpower.damage,
            heal: willpower.heal ? (willpower.damage || '') : '',
            confidence: 'pattern',
            reason: 'explicit willpower profile',
        });
    }
    if (active) {
        const kind = classifyAbility(sourceName, sourceDescription, config);
        const buffRule = (config?.skillRules || []).find(rule => rule.kind === 'buff');
        const buffSignal = buffRule ? matchesAnyWord(text, buffRule.keywords) : false;
        const damageSignal = hasDamageSignal(text, config);
        const supportSignal = /\b(?:attack rolls?|to hit|attack bonus|armor class|ac|saving throws?|save dc)\b/i.test(text);
        if (kind === 'heal') {
            return make('heal', { confidence: 'pattern', reason: 'healing signal' });
        }
        if ((buffSignal || supportSignal) && !damageSignal) {
            return make('buff', { confidence: 'pattern', reason: 'buff signal without damage' });
        }
        if (kind === 'buff') {
            return make('buff', { confidence: 'pattern', reason: 'buff signal' });
        }
        if (kind === 'special') {
            const complex = matchesAnyWord(text, config?.complexKeywords || []);
            return make(complex ? 'special' : 'attack', { confidence: 'pattern', reason: complex ? 'complex combat effect' : 'damage signal' });
        }
        return make('attack', { confidence: 'pattern', reason: 'attack signal' });
    }
    if (matchesAnyWord(text, config?.noncombatKeywords || [])) {
        return make('noncombat', { confidence: 'pattern', reason: 'non-combat keyword' });
    }
    if (definitionAuthoritative) {
        const definitionKind = String(definition?.kind || '').toLowerCase();
        const definitionIntent = normalizeSkillIntent(definition?.intent)
            || (definition?.passive ? 'passive' : definition?.utility ? 'utility' : definition?.noncombat ? 'noncombat' : '');
        if (definitionIntent) {
            return make(definitionIntent, {
                resource: definition?.resource,
                willpowerOutcome: definition?.willpowerOutcome,
                damage: definition?.damage,
                heal: definition?.heal,
                confidence: 'definition',
                reason: 'authoritative definition',
            });
        }
        if (['attack', 'heal', 'buff', 'special'].includes(definitionKind)) {
            return make(definitionKind, {
                resource: definition?.resource,
                willpowerOutcome: definition?.willpowerOutcome,
                damage: definition?.damage,
                heal: definition?.heal,
                confidence: 'definition',
                reason: 'authoritative definition kind',
            });
        }
    }
    const definitionDamage = String(definition?.damage || '').trim();
    if (definitionDamage
        && (!DEFAULT_ATTACK_DAMAGE_HINTS.has(definitionDamage.toLowerCase())
            || matchesAnyWord(sourceName, config?.attackKeywords || [])
            || matchesAnyWord(sourceDescription, config?.attackKeywords || []))) {
        return make('attack', {
            resource: definition?.resource,
            willpowerOutcome: definition?.willpowerOutcome,
            damage: definitionDamage,
            confidence: 'definition',
            reason: 'explicit definition damage',
        });
    }
    if (matchesAnyWord(text, config?.utilityKeywords || [])) {
        const complex = matchesAnyWord(text, config?.complexKeywords || []);
        return make(complex ? 'special' : 'utility', { confidence: 'pattern', reason: complex ? 'complex utility effect' : 'utility keyword' });
    }
    if (matchesAnyWord(text, config?.complexKeywords || [])) {
        return make('special', { confidence: 'pattern', reason: 'complex effect keyword' });
    }
    const kind = classifyAbility(sourceName, sourceDescription, config);
    if (kind === 'attack') return make('attack', { confidence: 'pattern', reason: 'attack keyword' });
    if (kind === 'buff') return make('buff', { confidence: 'pattern', reason: 'buff keyword' });
    if (kind === 'heal') return make('heal', { confidence: 'pattern', reason: 'heal keyword' });
    return make('unknown', { confidence: 'fallback', reason: 'no explicit intent signal' });
}

/**
 * First matching rule wins. Damage/attack language takes precedence over broad
 * support keywords so "Shield Bash" remains an attack instead of becoming a
 * buff, while ordinary "Shield" still resolves as a buff.
 * Unknown abilities fall back to `special`; they never become attacks without
 * positive damage/attack evidence.
 * @param {string} name
 * @param {string} description
 * @param {object} config
 * @returns {'attack'|'heal'|'buff'|'special'}
 */
export function classifyAbility(name, description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    const text = `${name || ''} ${description || ''}`;
    const explicitHeal = hasHealingSignal(text, config);
    const dice = /\b\d+d\d+(?:\s*[+-]\s*\d+)?\b/i.test(text);
    const damageWord = matchesAnyWord(text, config?.damageKeywords || DEFAULT_LOADOUT_CLASSIFIER_CONFIG.damageKeywords || []);
    const damageType = matchesAnyWord(text, config?.damageTypeKeywords || DEFAULT_LOADOUT_CLASSIFIER_CONFIG.damageTypeKeywords || []);
    const attackWord = matchesAnyWord(text, config?.attackKeywords || DEFAULT_LOADOUT_CLASSIFIER_CONFIG.attackKeywords || []);
    const compoundAttack = /\b[a-z]*(?:bolt|blast|strike|shot|beam|ray|zap|burst|slash|smash)\b/i.test(text);
    if (!explicitHeal && (attackWord || compoundAttack || (dice && (damageWord || damageType)))) return 'attack';
    for (const rule of config?.skillRules || []) {
        if (matchesAnyWord(text, rule.keywords)) return rule.kind;
    }
    return 'special';
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
        if (matchesAnyWord(text, rule.keywords)) return rule.outcome;
    }
    return 'defeat';
}

export function buffModifiers(name, description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    const text = `${name || ''} ${description || ''}`;
    const buff = config?.buff || DEFAULT_LOADOUT_CLASSIFIER_CONFIG.buff;
    return {
        acBonus: matchesAnyWord(text, buff.acKeywords) ? buff.acBonus : 0,
        attackBonus: matchesAnyWord(text, buff.attackKeywords) ? buff.attackBonus : 0,
        rounds: buff.rounds,
    };
}

export function isRangedAbility(name, description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    return matchesAnyWord(`${name || ''} ${description || ''}`, config?.rangedKeywords);
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
    if (matchesAnyWord(text, areaConfig.singleTargetKeywords || []) && !explicitArea) return null;

    const selfMatched = matchesAnyWord(text, areaConfig.selfKeywords || []);
    const burstMatched = matchesAnyWord(text, areaConfig.burstKeywords || []);
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
        friendlyFire: matchesAnyWord(text, areaConfig.friendlyFireKeywords || []),
    };
}

export function isBonusAction(description, config = DEFAULT_LOADOUT_CLASSIFIER_CONFIG) {
    return matchesAny(description, [config?.bonusActionKeyword || 'bonus action']);
}
