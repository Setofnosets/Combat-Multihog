/**
 * lewd-combat-techniques.js — the shipped technique catalog and its schema.
 *
 * Lewd Combat never routes sexual techniques through `[ABILITIES]` or
 * `classifySkillIntent()`. That pipeline is keyword-driven, lossy, and capped;
 * a technique needs exact, stable numbers. Instead every technique is a plain
 * object in the canonical shape below, and the engine reads only these fields.
 *
 * Canonical shape (all fields are normalized by `validateLewdTechnique`):
 * {
 *   id, name, category, description,
 *   posture: 'either'|'lead'|'follow'|'switch' (or an array of those),
 *   zones: string[], targetMode: 'self'|'single'|'pair'|'group'|'aura',
 *   tags: string[],
 *   check: { stat: 'cha'|..., accuracy: number },
 *   arousal: dice expression, poise: dice expression,
 *   staminaDrain: number,
 *   actType: 'penetration'|'oral'|'manual'|'bondage'|'masturbation'|'other'|null,
 *   actRole: 'give'|'receive'|'mutual'|null,
 *   requires: {
 *     hold: string|true|null, stance: string|null, overwhelmed: boolean,
 *     act: string|null, actType: string|null, actRole: string|null,
 *     anatomy: { all: string[], any: string[] }|null,
 *     skill: string[]|null, trait: string[]|null, kink: string[]|null,
 *   },
 *   applies: {
 *     status?: object, stance?: object,
 *     act?: { id, type, role, intensity? }|null, // null clears the pair's act
 *   },
 *   hold: { id, label, poiseBonus, accuracyBonus, escapeDC } | null,
 *   stance: { poiseBonus, accuracyBonus },
 *   uses: { max: number|null, recharge: string },
 *   ai: { priority: number, conditions: string[] },
 * }
 *
 * The shipped catalog covers stance, hold, technique, counter, finisher, tease,
 * command, recover, and submit. Users can override entries by id through the
 * compendium (U5) or add strict `[LEWD_TECHNIQUES]` lines; both paths validate
 * through this module so a bad entry is dropped with a diagnostic instead of
 * being silently coerced by the engine.
 */

import {
    DEFAULT_ZONE_SENSITIVITY,
    isBlockedByLimits,
    normalizeLewdAnatomy,
    normalizeLewdName,
    normalizeLewdZone,
} from './lewd-combat-profile.js';
import { canEngageWith } from './lewd-combat-pairing.js';

export const LEWD_TECHNIQUE_CATEGORIES = Object.freeze([
    'stance', 'hold', 'technique', 'counter', 'finisher', 'tease', 'command', 'recover', 'submit',
]);

export const LEWD_TARGET_MODES = Object.freeze(['self', 'single', 'pair', 'group', 'aura']);

export const LEWD_TECHNIQUE_POSTURES = Object.freeze(['lead', 'follow', 'switch']);

export const LEWD_TECHNIQUE_CHECK_STATS = Object.freeze(['str', 'dex', 'con', 'int', 'wis', 'cha']);

/** Explicit act families. `other` covers acts that fit none of the rest. */
export const LEWD_ACT_TYPES = Object.freeze([
    'penetration', 'oral', 'manual', 'bondage', 'masturbation', 'other',
]);

/** Which side of an act the technique represents. */
export const LEWD_ACT_ROLES = Object.freeze(['give', 'receive', 'mutual']);

export const LEWD_TECHNIQUE_SCHEMA_VERSION = 1;

export const DEFAULT_LEWD_TECHNIQUE = Object.freeze({
    posture: 'either',
    targetMode: 'single',
    zones: [],
    tags: [],
    check: { stat: 'cha', accuracy: 0 },
    arousal: '0',
    poise: '0',
    staminaDrain: 0,
    actType: null,
    actRole: null,
    requires: { hold: null, stance: null, overwhelmed: false },
    applies: {},
    hold: null,
    stance: { poiseBonus: 0, accuracyBonus: 0 },
    uses: { max: null, recharge: 'at-will' },
    ai: { priority: 0, conditions: [] },
});

const SELF_TARGET_CATEGORIES = new Set(['stance', 'recover']);
const DICE_RX = /^(\d*)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?$/i;

function clamp(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function slug(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'technique';
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null || value === '') return [];
    return [value];
}

function splitList(value) {
    if (Array.isArray(value)) return value;
    return String(value ?? '')
        .split(/[,;]/)
        .map(item => item.trim())
        .filter(Boolean);
}

const REQUIREMENT_KEYS = [
    'hold', 'stance', 'overwhelmed',
    'act', 'actType', 'actRole', 'anatomy', 'skill', 'trait', 'kink',
];
const APPLICATION_KEYS = ['status', 'stance', 'act'];

function lowerOrNull(value) {
    const text = String(value ?? '').trim().toLowerCase();
    return text || null;
}

/** Accept a string id/type or `{ id, type }` and return the lower-case key. */
function actReference(value) {
    if (value == null) return null;
    if (typeof value === 'object') {
        return lowerOrNull(value.id ?? value.type ?? '');
    }
    return lowerOrNull(value);
}

/**
 * Normalize `requires.skill`/`trait`/`kink` to unique lower-case tokens.
 * Returns null when nothing was supplied so the canonical shape stays stable.
 */
function requirementTokens(value) {
    if (value == null || value === '') return null;
    const tokens = [];
    for (const item of asArray(value)) {
        const parts = Array.isArray(item) ? item : String(item ?? '').split(/[,;]/);
        for (const part of parts) {
            const token = lowerOrNull(part);
            if (token && !tokens.includes(token)) tokens.push(token);
        }
    }
    return tokens.length ? tokens : null;
}

/**
 * Normalize `requires.anatomy`: a string, a string array (all-of), or
 * `{ all, any }`. Every tag must be a canonical anatomy tag.
 */
function requirementAnatomy(value, errors) {
    if (value == null || value === '') return null;
    const all = [];
    const any = [];
    const addTag = (tag, bucket) => {
        const normalized = normalizeLewdAnatomy(tag);
        if (!normalized) {
            errors.push(`Unknown anatomy tag "${String(tag ?? '').trim()}".`);
            return;
        }
        if (!bucket.includes(normalized)) bucket.push(normalized);
    };
    if (typeof value === 'string' || Array.isArray(value)) {
        for (const tag of asArray(value)) addTag(tag, all);
    } else if (typeof value === 'object') {
        for (const key of Object.keys(value)) {
            if (!['all', 'any'].includes(key)) errors.push(`Unknown anatomy requirement "${key}".`);
        }
        for (const tag of asArray(value.all)) addTag(tag, all);
        for (const tag of asArray(value.any)) addTag(tag, any);
    } else {
        errors.push('requires.anatomy must be a string, a string array, or { all, any }.');
    }
    if (!all.length && !any.length) return null;
    return { all, any };
}

function diceExpression(value, fallback = '0') {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    const text = String(value ?? '').trim();
    if (!text) return fallback;
    if (DICE_RX.test(text) || Number.isFinite(Number(text))) return text;
    return '';
}

/**
 * Validate and normalize one technique. Unknown categories, zones, check stats,
 * requirements, or target modes fail loudly; the caller drops the entry and
 * surfaces the errors.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, technique: object|null, errors: string[] }}
 */
export function validateLewdTechnique(raw) {
    const errors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, technique: null, errors: ['Technique must be a JSON object.'] };
    }

    const name = String(raw.name ?? raw.label ?? '').trim().slice(0, 80);
    if (!name) errors.push('Technique name is required.');

    const category = String(raw.category ?? raw.type ?? 'technique').trim().toLowerCase();
    if (!LEWD_TECHNIQUE_CATEGORIES.includes(category)) {
        errors.push(`Unknown category "${raw.category ?? raw.type ?? ''}".`);
    }

    let posture = raw.posture ?? (category === 'hold' || category === 'command' ? 'lead' : 'either');
    if (Array.isArray(posture)) {
        const allowed = posture
            .map(value => String(value ?? '').toLowerCase())
            .filter(value => value === 'either' || value === 'any' || LEWD_TECHNIQUE_POSTURES.includes(value));
        if (allowed.length !== posture.length || !allowed.length) {
            errors.push(`Unknown posture "${posture.join(', ')}".`);
            posture = 'either';
        } else {
            posture = [...new Set(allowed)];
        }
    } else {
        const normalizedPosture = String(posture ?? '').trim().toLowerCase();
        if (!['either', 'any', ...LEWD_TECHNIQUE_POSTURES].includes(normalizedPosture)) {
            errors.push(`Unknown posture "${raw.posture ?? ''}".`);
            posture = 'either';
        } else {
            posture = normalizedPosture;
        }
    }

    const rawZones = splitList(raw.zones ?? raw.zone ?? []);
    const zones = [];
    for (const zone of rawZones) {
        const normalized = normalizeLewdZone(zone);
        if (!normalized) {
            errors.push(`Unknown zone "${String(zone).trim()}".`);
            continue;
        }
        if (!zones.includes(normalized)) zones.push(normalized);
    }
    if (!zones.length && !SELF_TARGET_CATEGORIES.has(category)) {
        errors.push('Technique needs at least one body zone.');
    }

    const defaultTargetMode = SELF_TARGET_CATEGORIES.has(category) ? 'self' : 'single';
    const targetMode = String(raw.targetMode ?? raw.target ?? defaultTargetMode).trim().toLowerCase();
    if (!LEWD_TARGET_MODES.includes(targetMode)) {
        errors.push(`Unknown targetMode "${raw.targetMode ?? raw.target ?? ''}".`);
    }

    const rawCheck = raw.check && typeof raw.check === 'object' && !Array.isArray(raw.check) ? raw.check : {};
    const stat = String(rawCheck.stat ?? raw.stat ?? 'cha').trim().toLowerCase();
    if (!LEWD_TECHNIQUE_CHECK_STATS.includes(stat)) {
        errors.push(`Unknown check stat "${rawCheck.stat ?? raw.stat ?? ''}".`);
    }
    const accuracy = rawCheck.accuracy ?? raw.accuracy ?? 0;
    if (!Number.isFinite(Number(accuracy))) {
        errors.push(`Check accuracy must be a number (got "${accuracy}").`);
    }

    const arousal = diceExpression(raw.arousal, '0');
    if (arousal === '') errors.push(`Invalid arousal dice "${raw.arousal}".`);
    const poise = diceExpression(raw.poise, '0');
    if (poise === '') errors.push(`Invalid poise dice "${raw.poise}".`);

    const staminaDrain = clamp(raw.staminaDrain ?? 0, 0, 5, 0);
    if (raw.staminaDrain != null && !Number.isFinite(Number(raw.staminaDrain))) {
        errors.push(`staminaDrain must be a number (got "${raw.staminaDrain}").`);
    }

    const actType = lowerOrNull(raw.actType);
    if (actType && !LEWD_ACT_TYPES.includes(actType)) {
        errors.push(`Unknown actType "${raw.actType}".`);
    }
    const actRole = lowerOrNull(raw.actRole);
    if (actRole && !LEWD_ACT_ROLES.includes(actRole)) {
        errors.push(`Unknown actRole "${raw.actRole}".`);
    }

    const rawRequires = raw.requires && typeof raw.requires === 'object' && !Array.isArray(raw.requires)
        ? raw.requires
        : {};
    for (const key of Object.keys(rawRequires)) {
        if (!REQUIREMENT_KEYS.includes(key)) {
            errors.push(`Unknown requirement "${key}".`);
        }
    }
    const requiresHold = rawRequires.hold === true
        ? true
        : rawRequires.hold == null || rawRequires.hold === false || rawRequires.hold === ''
            ? null
            : String(rawRequires.hold).trim();
    const requiresStance = rawRequires.stance == null || rawRequires.stance === ''
        ? null
        : String(rawRequires.stance).trim();
    const requiresAct = actReference(rawRequires.act);
    const requiresActType = lowerOrNull(rawRequires.actType);
    if (requiresActType && !LEWD_ACT_TYPES.includes(requiresActType)) {
        errors.push(`Unknown actType "${rawRequires.actType}".`);
    }
    const requiresActRole = lowerOrNull(rawRequires.actRole);
    if (requiresActRole && !LEWD_ACT_ROLES.includes(requiresActRole)) {
        errors.push(`Unknown actRole "${rawRequires.actRole}".`);
    }
    const requiresAnatomy = requirementAnatomy(rawRequires.anatomy, errors);
    const requiresSkill = requirementTokens(rawRequires.skill);
    const requiresTrait = requirementTokens(rawRequires.trait);
    const requiresKink = requirementTokens(rawRequires.kink);

    const rawApplies = raw.applies && typeof raw.applies === 'object' && !Array.isArray(raw.applies)
        ? raw.applies
        : {};
    for (const key of Object.keys(rawApplies)) {
        if (!APPLICATION_KEYS.includes(key)) {
            errors.push(`Unknown application "${key}".`);
        }
    }
    const applies = {};
    if (rawApplies.status != null) {
        const statusSource = typeof rawApplies.status === 'string' ? { label: rawApplies.status } : rawApplies.status;
        const label = String(statusSource?.label ?? statusSource?.name ?? '').trim();
        if (!label) errors.push('Applied status needs a label.');
        applies.status = {
            id: slug(statusSource?.id || label),
            label: label || 'Status',
            roundsLeft: clamp(statusSource?.roundsLeft ?? statusSource?.rounds ?? 1, 1, 99, 1),
            sensitivityBonus: Number(statusSource?.sensitivityBonus) || 0,
            arousalBonus: Number(statusSource?.arousalBonus) || 0,
        };
    }
    if (rawApplies.stance != null) {
        const stanceSource = typeof rawApplies.stance === 'string' ? { label: rawApplies.stance } : rawApplies.stance;
        const label = String(stanceSource?.label ?? stanceSource?.name ?? stanceSource?.id ?? '').trim();
        if (!label) errors.push('Applied stance needs a label.');
        applies.stance = {
            id: slug(stanceSource?.id || label),
            label: label || 'Stance',
            poiseBonus: Number(stanceSource?.poiseBonus) || 0,
            accuracyBonus: Number(stanceSource?.accuracyBonus) || 0,
            roundsLeft: clamp(stanceSource?.roundsLeft ?? stanceSource?.rounds ?? 3, 1, 99, 3),
        };
    }
    if ('act' in rawApplies) {
        if (rawApplies.act == null) {
            // Explicit null is meaningful: the technique clears the pair's act.
            applies.act = null;
        } else {
            const actSource = typeof rawApplies.act === 'object' ? rawApplies.act : { id: rawApplies.act };
            const id = lowerOrNull(actSource?.id ?? actSource?.type ?? '');
            if (!id) errors.push('Applied act needs an id.');
            const type = lowerOrNull(actSource?.type ?? actType);
            if (type && !LEWD_ACT_TYPES.includes(type)) {
                errors.push(`Unknown actType "${actSource?.type}".`);
            }
            const role = lowerOrNull(actSource?.role ?? actRole);
            if (role && !LEWD_ACT_ROLES.includes(role)) {
                errors.push(`Unknown actRole "${actSource?.role}".`);
            }
            const intensity = actSource?.intensity == null ? null : Number(actSource.intensity);
            if (actSource?.intensity != null && !Number.isFinite(intensity)) {
                errors.push(`Invalid act intensity "${actSource.intensity}".`);
            }
            if (id) {
                const applied = { id, type: type && LEWD_ACT_TYPES.includes(type) ? type : null, role: role && LEWD_ACT_ROLES.includes(role) ? role : null };
                if (Number.isFinite(intensity)) applied.intensity = intensity;
                applies.act = applied;
            }
        }
    }

    let hold = null;
    if (raw.hold != null) {
        const holdSource = typeof raw.hold === 'string' ? { label: raw.hold } : raw.hold;
        const fallbackLabel = category === 'hold' ? name : '';
        const label = String(holdSource?.label ?? holdSource?.name ?? holdSource?.id ?? fallbackLabel).trim();
        if (!label) {
            errors.push('Hold needs a label.');
        } else {
            hold = {
                id: slug(holdSource?.id || label),
                label,
                poiseBonus: Number(holdSource?.poiseBonus) || 0,
                accuracyBonus: Number(holdSource?.accuracyBonus) || 0,
                escapeDC: clamp(holdSource?.escapeDC ?? holdSource?.dc ?? 12, 1, 40, 12),
            };
        }
    } else if (category === 'hold') {
        hold = {
            id: slug(raw.id || name),
            label: name || 'Hold',
            poiseBonus: 0,
            accuracyBonus: 0,
            escapeDC: clamp(raw.escapeDC ?? raw.dc ?? 12, 1, 40, 12),
        };
    }

    const rawStance = raw.stance && typeof raw.stance === 'object' && !Array.isArray(raw.stance)
        ? raw.stance
        : {};
    const stance = {
        poiseBonus: Number(rawStance.poiseBonus) || 0,
        accuracyBonus: Number(rawStance.accuracyBonus) || 0,
    };

    const rawUses = raw.uses && typeof raw.uses === 'object' && !Array.isArray(raw.uses) ? raw.uses : {};
    const max = rawUses.max == null && raw.maxUses == null
        ? null
        : clamp(rawUses.max ?? raw.maxUses, 0, 99, 0);
    const uses = {
        max,
        recharge: String(rawUses.recharge ?? (max == null ? 'at-will' : 'encounter')).trim().slice(0, 40) || 'at-will',
    };

    const rawAi = raw.ai && typeof raw.ai === 'object' && !Array.isArray(raw.ai) ? raw.ai : {};
    const ai = {
        priority: Number(rawAi.priority) || 0,
        conditions: asArray(rawAi.conditions).map(condition => String(condition).trim()).filter(Boolean).slice(0, 20),
    };

    if (!LEWD_TECHNIQUE_CATEGORIES.includes(category)
        || !LEWD_TARGET_MODES.includes(targetMode)
        || !LEWD_TECHNIQUE_CHECK_STATS.includes(stat)
        || arousal === ''
        || poise === '') {
        return { ok: false, technique: null, errors };
    }
    if (errors.length) return { ok: false, technique: null, errors };

    return {
        ok: true,
        technique: {
            id: slug(raw.id || name),
            name,
            category,
            description: String(raw.description ?? raw.brief ?? '').trim().slice(0, 500),
            posture,
            zones,
            targetMode,
            tags: asArray(raw.tags).map(tag => String(tag).trim().toLowerCase()).filter(Boolean).slice(0, 20),
            check: { stat, accuracy: Number(accuracy) || 0 },
            arousal,
            poise,
            staminaDrain,
            actType,
            actRole,
            requires: {
                hold: requiresHold,
                stance: requiresStance,
                overwhelmed: rawRequires.overwhelmed === true,
                act: requiresAct,
                actType: requiresActType,
                actRole: requiresActRole,
                anatomy: requiresAnatomy,
                skill: requiresSkill,
                trait: requiresTrait,
                kink: requiresKink,
            },
            applies,
            hold,
            stance,
            uses,
            ai,
            schemaVersion: LEWD_TECHNIQUE_SCHEMA_VERSION,
        },
        errors: [],
    };
}

/** Normalize a trusted catalog entry. Throws on invalid shipped data. */
export function normalizeLewdTechnique(raw) {
    const result = validateLewdTechnique(raw);
    if (!result.ok) throw new Error(`Invalid Lewd Combat technique "${raw?.name ?? raw?.id ?? '?'}": ${result.errors.join(' ')}`);
    return result.technique;
}

function technique(definition) {
    return validateLewdTechnique(definition).technique;
}

/**
 * The shipped catalog. Users can override entries by id via the compendium; the
 * baseline stays available so a bad compendium never leaves the board without
 * legal actions.
 */
export const LEWD_TECHNIQUES = Object.freeze([
    // ── stance ────────────────────────────────────────────────────────────
    technique({
        id: 'commanding-pose', name: 'Commanding Pose', category: 'stance', posture: 'either',
        description: 'Draw yourself up and take control of the room.',
        zones: [], targetMode: 'self', tags: ['dominance'],
        applies: { stance: { id: 'commanding', label: 'Commanding', poiseBonus: 2 } },
        ai: { priority: 2, conditions: ['role:dominant'] },
    }),
    technique({
        id: 'yielding-guard', name: 'Yielding Guard', category: 'stance', posture: 'follow',
        description: 'Soften your guard and let their attention come to you.',
        zones: [], targetMode: 'self', tags: ['submission'],
        applies: { stance: { id: 'yielding', label: 'Yielding', poiseBonus: 1 } },
        ai: { priority: 2, conditions: ['role:submissive'] },
    }),
    technique({
        id: 'entwining-embrace', name: 'Entwining Embrace', category: 'stance', posture: 'either',
        description: 'Close the distance until there is no space left between you.',
        zones: [], targetMode: 'self', tags: ['intimacy'],
        applies: { stance: { id: 'entwined', label: 'Entwined', poiseBonus: 1 } },
        ai: { priority: 1 },
    }),
    technique({
        id: 'teasing-smile', name: 'Teasing Smile', category: 'stance', posture: 'either',
        description: 'Make them wonder what you are going to do next.',
        zones: [], targetMode: 'self', tags: ['teasing'],
        applies: { stance: { id: 'teasing', label: 'Teasing', poiseBonus: 0 } },
        ai: { priority: 1 },
    }),

    // ── hold ──────────────────────────────────────────────────────────────
    technique({
        id: 'firm-grip', name: 'Firm Grip', category: 'hold', posture: 'lead',
        description: 'A steady hand at the waist that leaves no doubt who is leading.',
        zones: ['waist', 'hips'], targetMode: 'single', tags: ['dominance'],
        check: { stat: 'str', accuracy: 2 }, arousal: '1d4', poise: '1d4',
        hold: { id: 'grappled', label: 'Grappled', poiseBonus: 2, escapeDC: 12 },
        ai: { priority: 3 },
    }),
    technique({
        id: 'pin-wrists', name: 'Pin Wrists', category: 'hold', posture: 'lead',
        description: 'Catch their hands and hold them gently but firmly in place.',
        zones: ['hands'], targetMode: 'single', tags: ['dominance', 'restraint'],
        check: { stat: 'str', accuracy: 1 }, arousal: '1d4', poise: '1d4',
        hold: { id: 'pinned', label: 'Pinned', poiseBonus: 2, escapeDC: 13 },
        ai: { priority: 3 },
    }),
    technique({
        id: 'straddle', name: 'Straddle', category: 'hold', posture: 'lead',
        description: 'Settle into their lap and take the angle you want.',
        zones: ['hips', 'thighs'], targetMode: 'single', tags: ['dominance', 'intimacy'],
        check: { stat: 'cha', accuracy: 2 }, arousal: '1d6', poise: '1d4',
        hold: { id: 'straddled', label: 'Straddled', poiseBonus: 1, escapeDC: 13 },
        ai: { priority: 3 },
    }),
    technique({
        id: 'close-embrace', name: 'Close Embrace', category: 'hold', posture: 'either',
        description: 'Wrap around them and hold the contact as long as they will allow.',
        zones: ['full_body'], targetMode: 'single', tags: ['intimacy'],
        check: { stat: 'cha', accuracy: 3 }, arousal: '1d4', poise: '1d4',
        hold: { id: 'embraced', label: 'Embraced', poiseBonus: 1, escapeDC: 11 },
        ai: { priority: 2 },
    }),
    technique({
        id: 'silken-restraint', name: 'Silken Restraint', category: 'hold', posture: 'lead',
        description: 'A scarf, a sash, or simply a promise keeps their hands where you want them.',
        zones: ['hands'], targetMode: 'single', tags: ['restraint', 'dominance'],
        check: { stat: 'dex', accuracy: 1 }, arousal: '1d4', poise: '1d6',
        hold: { id: 'restrained', label: 'Restrained', poiseBonus: 3, escapeDC: 14 },
        ai: { priority: 3, conditions: ['darker'] },
    }),

    // ── technique ─────────────────────────────────────────────────────────
    technique({
        id: 'neck-kiss', name: 'Neck Kiss', category: 'technique', posture: 'either',
        description: 'Soft, deliberate attention down the side of the neck.',
        zones: ['neck'], targetMode: 'single', tags: ['teasing', 'praise'],
        arousal: '1d6+2', poise: '1d4', ai: { priority: 2, conditions: ['targetSensitive:neck'] },
    }),
    technique({
        id: 'ear-whisper', name: 'Ear Whisper', category: 'technique', posture: 'either',
        description: 'A low murmur and a warm breath at the ear.',
        zones: ['ears'], targetMode: 'single', tags: ['teasing', 'praise'],
        arousal: '1d6+1', poise: '1d4', ai: { priority: 2, conditions: ['targetSensitive:ears'] },
    }),
    technique({
        id: 'chest-caress', name: 'Chest Caress', category: 'technique', posture: 'either',
        description: 'Slow, open-handed attention across the chest.',
        zones: ['chest'], targetMode: 'single', tags: ['intimacy'],
        arousal: '1d8+1', poise: '1d4', ai: { priority: 2 },
    }),
    technique({
        id: 'breast-play', name: 'Breast Play', category: 'technique', posture: 'either',
        description: 'Deliberate, unhurried attention that rewards patience.',
        zones: ['breasts'], targetMode: 'single', tags: ['intimacy'],
        arousal: '1d8+2', poise: '1d4', ai: { priority: 2, conditions: ['targetSensitive:breasts'] },
    }),
    technique({
        id: 'nipple-tease', name: 'Nipple Tease', category: 'technique', posture: 'either',
        description: 'Light, precise teasing that is hard to ignore.',
        zones: ['nipples'], targetMode: 'single', tags: ['teasing'],
        arousal: '1d6+3', poise: '1d4', ai: { priority: 3, conditions: ['targetSensitive:nipples'] },
    }),
    technique({
        id: 'hip-grind', name: 'Hip Grind', category: 'technique', posture: 'lead',
        description: 'A slow roll of the hips that sets the rhythm for both of you.',
        zones: ['hips', 'groin'], targetMode: 'single', tags: ['dominance', 'intimacy'],
        check: { stat: 'cha', accuracy: 1 }, arousal: '1d8+3', poise: '1d4',
        ai: { priority: 3 },
    }),
    technique({
        id: 'thigh-stroke', name: 'Thigh Stroke', category: 'technique', posture: 'either',
        description: 'A teasing line traced along the thigh, stopping just short.',
        zones: ['thighs'], targetMode: 'single', tags: ['teasing'],
        arousal: '1d6+2', poise: '1d4', ai: { priority: 2, conditions: ['targetSensitive:thighs'] },
    }),
    technique({
        id: 'deep-kiss', name: 'Deep Kiss', category: 'technique', posture: 'either',
        description: 'A kiss that starts soft and does not stay that way.',
        zones: ['lips'], targetMode: 'single', tags: ['intimacy', 'praise'],
        arousal: '1d6+2', poise: '1d4', ai: { priority: 2 },
    }),

    // ── counter ───────────────────────────────────────────────────────────
    technique({
        id: 'twist-free', name: 'Twist Free', category: 'counter', posture: 'follow',
        description: 'Use their momentum to slip out of a hold.',
        zones: ['full_body'], targetMode: 'single', tags: ['escape'],
        arousal: '0', poise: '1d4', ai: { priority: 3, conditions: ['held'] },
    }),
    technique({
        id: 'breath-catch', name: 'Breath Catch', category: 'counter', posture: 'follow',
        description: 'Steady yourself against the rush and turn it back on them.',
        zones: ['chest'], targetMode: 'self', tags: ['recovery'],
        arousal: '0', poise: '0', ai: { priority: 2, conditions: ['overwhelmed'] },
    }),
    technique({
        id: 'reverse-grip', name: 'Reverse Grip', category: 'counter', posture: 'follow',
        description: 'Turn their hold against them and take the angle.',
        zones: ['hands', 'waist'], targetMode: 'single', tags: ['escape', 'submission'],
        arousal: '1d4', poise: '1d4', ai: { priority: 3, conditions: ['held'] },
    }),

    // ── finisher ──────────────────────────────────────────────────────────
    technique({
        id: 'finish-hold', name: 'Finish Hold', category: 'finisher', posture: 'either',
        description: 'Use the hold you already have to push them over the edge.',
        zones: ['full_body', 'groin'], targetMode: 'single', tags: ['dominance', 'intimacy'],
        arousal: '2d8+4', poise: '1d6', staminaDrain: 2,
        requires: { hold: 'grappled' }, ai: { priority: 4 },
    }),
    technique({
        id: 'final-thrust', name: 'Final Thrust', category: 'finisher', posture: 'lead',
        description: 'Commit fully to the finish once their guard is gone.',
        zones: ['groin'], targetMode: 'single', tags: ['dominance', 'intimacy'],
        check: { stat: 'cha', accuracy: 1 }, arousal: '3d8+6', poise: '2d6', staminaDrain: 2,
        requires: { overwhelmed: true }, ai: { priority: 5, conditions: ['overwhelmed'] },
    }),
    technique({
        id: 'shared-climax', name: 'Shared Climax', category: 'finisher', posture: 'either',
        description: 'Take them with you instead of holding back.',
        zones: ['groin', 'full_body'], targetMode: 'pair', tags: ['intimacy'],
        arousal: '2d6+4', poise: '1d6', staminaDrain: 2,
        requires: { overwhelmed: true }, ai: { priority: 4 },
    }),

    // ── tease ─────────────────────────────────────────────────────────────
    technique({
        id: 'flushed-whisper', name: 'Flushed Whisper', category: 'tease', posture: 'either',
        description: 'Say exactly the thing they were hoping you would not.',
        zones: ['ears'], targetMode: 'single', tags: ['teasing', 'praise'],
        arousal: '1d4', poise: '0',
        applies: { status: { label: 'Flushed', rounds: 2, sensitivityBonus: 0.1 } },
        ai: { priority: 2 },
    }),
    technique({
        id: 'lingering-touch', name: 'Lingering Touch', category: 'tease', posture: 'either',
        description: 'A touch that stays a heartbeat longer than it should.',
        zones: ['hands', 'waist'], targetMode: 'single', tags: ['teasing'],
        arousal: '1d4', poise: '1d4',
        applies: { status: { label: 'Sensitive', rounds: 2, sensitivityBonus: 0.2 } },
        ai: { priority: 2 },
    }),
    technique({
        id: 'teasing-denial', name: 'Teasing Denial', category: 'tease', posture: 'lead',
        description: 'Give them almost what they want, then take it away.',
        zones: ['neck', 'chest'], targetMode: 'single', tags: ['teasing', 'dominance'],
        arousal: '1d4', poise: '1d4',
        applies: { status: { label: 'Frustrated', rounds: 1, sensitivityBonus: 0.1 } },
        ai: { priority: 3 },
    }),

    // ── command ───────────────────────────────────────────────────────────
    technique({
        id: 'commanding-word', name: 'Commanding Word', category: 'command', posture: 'lead',
        description: 'One quiet order, delivered as though obedience is a foregone conclusion.',
        zones: ['ears'], targetMode: 'single', tags: ['dominance'],
        check: { stat: 'cha', accuracy: 2 }, arousal: '0', poise: '1d4',
        applies: { status: { label: 'Commanded', rounds: 1, sensitivityBonus: 0.1 } },
        ai: { priority: 2 },
    }),
    technique({
        id: 'praise', name: 'Praise', category: 'command', posture: 'lead',
        description: 'Tell them how well they are doing, and watch what it does to them.',
        zones: ['ears'], targetMode: 'single', tags: ['praise', 'dominance'],
        check: { stat: 'cha', accuracy: 3 }, arousal: '0', poise: '0',
        applies: { status: { label: 'Praised', rounds: 2, sensitivityBonus: 0.1 } },
        ai: { priority: 2, conditions: ['role:dominant'] },
    }),

    // ── recover ───────────────────────────────────────────────────────────
    technique({
        id: 'steady-breath', name: 'Steady Breath', category: 'recover', posture: 'either',
        description: 'Slow your breathing and rebuild your composure.',
        zones: [], targetMode: 'self', tags: ['recovery'],
        arousal: '1d4', poise: '1d4+1', ai: { priority: 1 },
    }),
    technique({
        id: 'afterglow', name: 'Afterglow', category: 'recover', posture: 'either',
        description: 'Let the aftershocks pass and find your center again.',
        zones: [], targetMode: 'self', tags: ['recovery'],
        arousal: '1d4+1', poise: '1d4+1', ai: { priority: 1 },
    }),

    // ── submit ────────────────────────────────────────────────────────────
    technique({
        id: 'offer', name: 'Offer', category: 'submit', posture: 'follow',
        description: 'Invite them to take what they want and make it easy to accept.',
        zones: ['neck', 'chest'], targetMode: 'single', tags: ['submission', 'praise'],
        arousal: '0', poise: '0',
        applies: { stance: { id: 'devoted', label: 'Devoted', poiseBonus: 1 } },
        ai: { priority: 2, conditions: ['role:submissive'] },
    }),
    technique({
        id: 'bare', name: 'Bare', category: 'submit', posture: 'follow',
        description: 'Expose a zone and trust them to be careful with it.',
        zones: ['full_body'], targetMode: 'self', tags: ['submission'],
        arousal: '0', poise: '0',
        applies: { status: { label: 'Bared', rounds: 1, sensitivityBonus: 0.1 } },
        ai: { priority: 1 },
    }),
    technique({
        id: 'beg', name: 'Beg', category: 'submit', posture: 'follow',
        description: 'Ask for it plainly, and let them hear how much you mean it.',
        zones: ['ears'], targetMode: 'single', tags: ['submission'],
        arousal: '1d4', poise: '0',
        applies: { stance: { id: 'devoted', label: 'Devoted', poiseBonus: 2 } },
        ai: { priority: 2, conditions: ['role:submissive'] },
    }),
    technique({
        id: 'endure', name: 'Endure', category: 'submit', posture: 'follow',
        description: 'Take what is given without breaking, and make them work for more.',
        zones: ['full_body'], targetMode: 'self', tags: ['submission', 'recovery'],
        arousal: '0', poise: '1d4', ai: { priority: 2 },
    }),
    technique({
        id: 'devote', name: 'Devote', category: 'submit', posture: 'follow',
        description: 'Give them your full attention and let the next exchange be theirs.',
        zones: ['full_body'], targetMode: 'pair', tags: ['submission', 'intimacy'],
        arousal: '1d4', poise: '0',
        applies: { stance: { id: 'devoted', label: 'Devoted', poiseBonus: 1 } },
        ai: { priority: 2 },
    }),

    // ── explicit acts: penetration ────────────────────────────────────────
    technique({
        id: 'penetration-start', name: 'Penetration', category: 'technique', posture: 'lead',
        description: 'Commit to the first deep contact and set the pace.',
        zones: ['genitals'], targetMode: 'single', tags: ['penetration', 'intimacy'],
        actType: 'penetration', actRole: 'give',
        check: { stat: 'cha', accuracy: 1 }, arousal: '2d6+2', poise: '1d6', staminaDrain: 2,
        requires: { anatomy: { any: ['penis', 'vagina', 'tail'] } },
        applies: { act: { id: 'penetration' } },
        ai: { priority: 3 },
    }),
    technique({
        id: 'penetration-receive', name: 'Take It', category: 'technique', posture: 'follow',
        description: 'Open up and take the contact at your own pace.',
        zones: ['genitals'], targetMode: 'single', tags: ['penetration', 'submission'],
        actType: 'penetration', actRole: 'receive',
        arousal: '2d6+2', poise: '1d6', staminaDrain: 2,
        requires: { anatomy: { any: ['vagina', 'anus'] } },
        applies: { act: { id: 'penetration', role: 'receive' } },
        ai: { priority: 2, conditions: ['role:submissive'] },
    }),
    technique({
        id: 'thrust', name: 'Thrust', category: 'technique', posture: 'lead',
        description: 'Set a steady rhythm and keep it.',
        zones: ['genitals', 'hips'], targetMode: 'single', tags: ['penetration'],
        actType: 'penetration', actRole: 'give',
        arousal: '1d8+2', poise: '1d4', staminaDrain: 1,
        requires: { act: 'penetration' },
        applies: { act: { id: 'penetration', intensity: 1 } },
        ai: { priority: 3 },
    }),
    technique({
        id: 'thrust-harder', name: 'Thrust Harder', category: 'technique', posture: 'lead',
        description: 'Push the rhythm harder than before.',
        zones: ['genitals'], targetMode: 'single', tags: ['penetration', 'dominance'],
        actType: 'penetration', actRole: 'give',
        check: { stat: 'str', accuracy: 1 }, arousal: '2d6+3', poise: '1d6', staminaDrain: 2,
        requires: { act: 'penetration' },
        applies: { act: { id: 'penetration', intensity: 2 } },
        ai: { priority: 4 },
    }),
    technique({
        id: 'slow-down', name: 'Slow Down', category: 'technique', posture: 'lead',
        description: 'Ease the pace back and make them wait for it.',
        zones: ['genitals'], targetMode: 'single', tags: ['penetration', 'teasing'],
        actType: 'penetration', actRole: 'give',
        arousal: '1d6+1', poise: '1d4',
        requires: { act: 'penetration' },
        applies: { act: { id: 'penetration', intensity: 1 } },
        ai: { priority: 2 },
    }),
    technique({
        id: 'deepen', name: 'Deeper', category: 'technique', posture: 'lead',
        description: 'Press in as far as the angle allows.',
        zones: ['genitals'], targetMode: 'single', tags: ['penetration', 'dominance'],
        actType: 'penetration', actRole: 'give',
        check: { stat: 'str', accuracy: 2 }, arousal: '2d8+4', poise: '1d6', staminaDrain: 2,
        requires: { act: 'penetration' },
        applies: { act: { id: 'penetration', intensity: 3 } },
        ai: { priority: 4, conditions: ['overwhelmed'] },
    }),
    technique({
        id: 'withdraw', name: 'Withdraw', category: 'technique', posture: 'lead',
        description: 'Pull back and leave the contact open.',
        zones: ['genitals'], targetMode: 'single', tags: ['penetration', 'teasing'],
        actType: 'penetration', actRole: 'give',
        arousal: '1d4', poise: '1d4',
        requires: { act: 'penetration' },
        applies: { act: null },
        ai: { priority: 2 },
    }),
    technique({
        id: 'change-position', name: 'Change Position', category: 'technique', posture: 'either',
        description: 'Shift the angle without breaking the rhythm.',
        zones: ['genitals', 'full_body'], targetMode: 'single', tags: ['penetration', 'intimacy'],
        actType: 'penetration', actRole: 'mutual',
        arousal: '1d6', poise: '1d4',
        requires: { act: 'penetration' },
        applies: { stance: { id: 'entwined', label: 'Entwined', poiseBonus: 1 } },
        ai: { priority: 2 },
    }),

    // ── explicit acts: oral ───────────────────────────────────────────────
    technique({
        id: 'oral-give', name: 'Go Down', category: 'technique', posture: 'lead',
        description: 'Kneel and use the mouth with deliberate patience.',
        zones: ['mouth', 'genitals'], targetMode: 'single', tags: ['oral', 'intimacy'],
        actType: 'oral', actRole: 'give',
        check: { stat: 'cha', accuracy: 1 }, arousal: '1d8+2', poise: '1d4',
        applies: { act: { id: 'oral' } },
        ai: { priority: 3 },
    }),
    technique({
        id: 'oral-receive', name: 'Receive Oral', category: 'technique', posture: 'follow',
        description: 'Let them work and guide with small shifts.',
        zones: ['mouth', 'genitals'], targetMode: 'single', tags: ['oral', 'submission'],
        actType: 'oral', actRole: 'receive',
        arousal: '1d8+2', poise: '1d4',
        requires: { anatomy: { any: ['penis', 'vagina', 'vulva'] } },
        applies: { act: { id: 'oral', role: 'receive' } },
        ai: { priority: 2, conditions: ['role:submissive'] },
    }),
    technique({
        id: 'oral-deepen', name: 'Take It Deeper', category: 'technique', posture: 'lead',
        description: 'Press the pace and see how much they can take.',
        zones: ['throat', 'mouth'], targetMode: 'single', tags: ['oral', 'dominance'],
        actType: 'oral', actRole: 'give',
        check: { stat: 'str', accuracy: 1 }, arousal: '1d10+3', poise: '1d6', staminaDrain: 1,
        requires: { actType: 'oral' },
        applies: { act: { id: 'oral', intensity: 2 } },
        ai: { priority: 3 },
    }),
    technique({
        id: 'sixty-nine', name: 'Sixty-Nine', category: 'technique', posture: 'either',
        description: 'Both mouths busy, both pace honest.',
        zones: ['mouth', 'genitals'], targetMode: 'pair', tags: ['oral', 'intimacy'],
        actType: 'oral', actRole: 'mutual',
        arousal: '1d8+2', poise: '1d4',
        requires: { anatomy: { any: ['penis', 'vagina', 'vulva', 'anus'] } },
        applies: { act: { id: 'oral', role: 'mutual', intensity: 2 } },
        ai: { priority: 3 },
    }),

    // ── explicit acts: manual / masturbation ──────────────────────────────
    technique({
        id: 'manual-stroke', name: 'Stroke', category: 'technique', posture: 'lead',
        description: 'A firm, steady hand and a rhythm that builds.',
        zones: ['genitals'], targetMode: 'single', tags: ['manual'],
        actType: 'manual', actRole: 'give',
        arousal: '1d6+2', poise: '1d4',
        requires: { anatomy: { any: ['penis', 'vagina'] } },
        applies: { act: { id: 'manual' } },
        ai: { priority: 2 },
    }),
    technique({
        id: 'manual-tease', name: 'Light Fingers', category: 'technique', posture: 'either',
        description: 'Barely-there touches that keep them guessing.',
        zones: ['genitals', 'thighs'], targetMode: 'single', tags: ['manual', 'teasing'],
        actType: 'manual', actRole: 'give',
        arousal: '1d6+1', poise: '1d4',
        requires: { actType: 'manual' },
        applies: { act: { id: 'manual', intensity: 1 } },
        ai: { priority: 2 },
    }),
    technique({
        id: 'mutual-masturbation', name: 'Mutual Masturbation', category: 'technique', posture: 'either',
        description: 'Hands on each other, matching pace.',
        zones: ['genitals'], targetMode: 'pair', tags: ['masturbation', 'intimacy'],
        actType: 'masturbation', actRole: 'mutual',
        arousal: '1d8+2', poise: '1d4',
        applies: { act: { id: 'masturbation', role: 'mutual' } },
        ai: { priority: 3 },
    }),
    technique({
        id: 'paizuri', name: 'Paizuri', category: 'technique', posture: 'either',
        description: 'Use the chest to build a slow, warm rhythm.',
        zones: ['breasts'], targetMode: 'single', tags: ['manual', 'intimacy'],
        actType: 'manual', actRole: 'give',
        arousal: '1d8+2', poise: '1d4',
        requires: { anatomy: 'breasts' },
        applies: { act: { id: 'paizuri', type: 'manual' } },
        ai: { priority: 2 },
    }),
    technique({
        id: 'intercrural', name: 'Between the Thighs', category: 'technique', posture: 'lead',
        description: 'Work the contact between closed thighs.',
        zones: ['thighs', 'genitals'], targetMode: 'single', tags: ['manual', 'intimacy'],
        actType: 'manual', actRole: 'give',
        arousal: '1d6+2', poise: '1d4',
        applies: { act: { id: 'intercrural', type: 'manual' } },
        ai: { priority: 2 },
    }),

    // ── explicit acts: bondage ────────────────────────────────────────────
    technique({
        id: 'tie-bindings', name: 'Tie Bindings', category: 'hold', posture: 'lead',
        description: 'Wrap the wrists and settle the knots.',
        zones: ['hands'], targetMode: 'single', tags: ['bondage', 'restraint'],
        actType: 'bondage', actRole: 'give',
        check: { stat: 'dex', accuracy: 1 }, arousal: '1d4', poise: '1d6',
        requires: { anatomy: 'bondage-gear' },
        hold: { id: 'bound', label: 'Bound', poiseBonus: 3, escapeDC: 14 },
        applies: { act: { id: 'bondage' } },
        ai: { priority: 2 },
    }),
    technique({
        id: 'tighten-bindings', name: 'Tighten Bindings', category: 'technique', posture: 'lead',
        description: 'Pull the knots tighter and take away another inch.',
        zones: ['hands'], targetMode: 'single', tags: ['bondage', 'dominance'],
        actType: 'bondage', actRole: 'give',
        arousal: '1d4', poise: '1d6',
        requires: { act: 'bondage', skill: 'bondage' },
        applies: { act: { id: 'bondage', intensity: 2 } },
        ai: { priority: 3 },
    }),
    technique({
        id: 'loosen-bindings', name: 'Loosen Bindings', category: 'technique', posture: 'either',
        description: 'Ease the knots and give a little room back.',
        zones: ['hands'], targetMode: 'single', tags: ['bondage'],
        actType: 'bondage', actRole: 'receive',
        arousal: '1d4', poise: '1d4',
        requires: { act: 'bondage' },
        applies: { act: { id: 'bondage', intensity: 1 } },
        ai: { priority: 1 },
    }),
    technique({
        id: 'tease-bound', name: 'Tease the Bound', category: 'tease', posture: 'lead',
        description: 'Let them wait, unable to reach back.',
        zones: ['full_body', 'neck'], targetMode: 'single', tags: ['bondage', 'teasing'],
        actType: 'bondage', actRole: 'give',
        arousal: '1d6+2', poise: '1d4',
        requires: { act: 'bondage' },
        applies: { status: { label: 'Bound', rounds: 2, sensitivityBonus: 0.1 } },
        ai: { priority: 3 },
    }),
    technique({
        id: 'release-bindings', name: 'Release Bindings', category: 'technique', posture: 'either',
        description: 'Undo the last knot and set them free.',
        zones: ['hands'], targetMode: 'single', tags: ['bondage'],
        actType: 'bondage', actRole: 'give',
        arousal: '0', poise: '1d4',
        requires: { act: 'bondage' },
        applies: { act: null },
        ai: { priority: 1 },
    }),

    // ── explicit acts: tail ───────────────────────────────────────────────
    technique({
        id: 'tail-wrap', name: 'Tail Wrap', category: 'technique', posture: 'either',
        description: 'Curl the tail around a thigh and hold it there.',
        zones: ['tail', 'thighs'], targetMode: 'single', tags: ['tail', 'restraint'],
        actType: 'other', actRole: 'give',
        arousal: '1d4', poise: '1d4',
        requires: { anatomy: 'tail' },
        applies: { act: { id: 'tail-wrap', type: 'other' } },
        ai: { priority: 2 },
    }),
    technique({
        id: 'tail-penetration', name: 'Tail Penetration', category: 'technique', posture: 'lead',
        description: 'Use the tail to press in and take the angle.',
        zones: ['tail', 'genitals'], targetMode: 'single', tags: ['tail', 'penetration'],
        actType: 'penetration', actRole: 'give',
        check: { stat: 'dex', accuracy: 1 }, arousal: '2d6+2', poise: '1d6', staminaDrain: 2,
        requires: { anatomy: 'tail', act: 'penetration' },
        applies: { act: { id: 'tail-penetration', type: 'penetration' } },
        ai: { priority: 3 },
    }),
]);

const TECHNIQUE_BY_ID = new Map(LEWD_TECHNIQUES.map(entry => [entry.id, entry]));

/** Shipped technique by id (or a catalog supplied by the caller). */
export function getLewdTechnique(idOrName, catalog = LEWD_TECHNIQUES) {
    const key = String(idOrName ?? '').trim().toLowerCase();
    if (!key) return null;
    const entries = Array.isArray(catalog) ? catalog : Object.values(catalog || {});
    return entries.find(entry => String(entry?.id || '').toLowerCase() === key) || null;
}

/**
 * Build an id-keyed registry. Later entries override earlier ones, which is how
 * the compendium merge order works.
 * @param {object[]} entries
 * @returns {Map<string, object>}
 */
export function createLewdTechniqueRegistry(entries = LEWD_TECHNIQUES) {
    const registry = new Map(TECHNIQUE_BY_ID);
    if (entries !== LEWD_TECHNIQUES) {
        registry.clear();
        for (const entry of entries || []) {
            if (entry?.id) registry.set(entry.id, entry);
        }
    }
    return registry;
}

function findParticipant(state, reference) {
    if (!state || reference == null) return null;
    if (typeof reference === 'object') {
        if (reference.id && state.participants?.includes(reference)) return reference;
        if (reference.id) return state.participants?.find(participant => participant.id === reference.id) || null;
        if (reference.name) return findParticipant(state, reference.name);
        return null;
    }
    const text = String(reference).trim().toLowerCase();
    if (!text) return null;
    return state.participants?.find(participant => String(participant.id).toLowerCase() === text)
        || state.participants?.find(participant => String(participant.name).toLowerCase() === text)
        || null;
}

function isOut(participant) {
    return !!participant?.atMercy || !!participant?.surrendered;
}

function isActive(participant) {
    return !!participant && !participant.spectator && !isOut(participant);
}

function postureAllowed(technique, posture) {
    const allowed = technique?.posture;
    if (!allowed || allowed === 'either' || allowed === 'any') return true;
    if (Array.isArray(allowed)) return allowed.includes(posture) || allowed.includes('either') || allowed.includes('any');
    return allowed === posture;
}

function defaultPosture(technique) {
    const allowed = technique?.posture;
    if (typeof allowed === 'string' && LEWD_TECHNIQUE_POSTURES.includes(allowed)) return allowed;
    if (Array.isArray(allowed)) {
        const found = allowed.find(value => LEWD_TECHNIQUE_POSTURES.includes(value));
        if (found) return found;
    }
    return 'switch';
}

function allowedPostures(technique) {
    const allowed = technique?.posture;
    if (!allowed || allowed === 'either' || allowed === 'any') return [...LEWD_TECHNIQUE_POSTURES];
    if (Array.isArray(allowed)) {
        const list = allowed.filter(value => LEWD_TECHNIQUE_POSTURES.includes(value));
        return list.length ? list : [...LEWD_TECHNIQUE_POSTURES];
    }
    return LEWD_TECHNIQUE_POSTURES.includes(allowed) ? [allowed] : [...LEWD_TECHNIQUE_POSTURES];
}

function usesRemaining(participant, technique) {
    const max = technique?.uses?.max;
    if (max == null) return Infinity;
    const used = Number(participant?.uses?.[technique.id]) || 0;
    return Math.max(0, Number(max) - used);
}

function stanceMatches(participant, technique) {
    const required = technique?.requires?.stance;
    if (!required) return true;
    const stance = participant?.stance;
    if (!stance) return false;
    const key = String(required).toLowerCase();
    return stance.id === key || String(stance.label || '').toLowerCase() === key;
}

function holdMatches(state, actor, target, technique) {
    const required = technique?.requires?.hold;
    if (!required || target?.id === actor?.id) return true;
    const edge = state?.engagements?.find(candidate =>
        (candidate.a === actor.id && candidate.b === target.id)
        || (candidate.a === target.id && candidate.b === actor.id)) || null;
    if (!edge?.hold) return false;
    if (required === true) return true;
    const key = String(required).toLowerCase();
    return edge.hold.id === key || String(edge.hold.label || '').toLowerCase() === key;
}

/** Read an engagement edge's act as `{ id, type, role }` (empty when absent). */
function engagementAct(edge) {
    const source = edge?.act;
    const act = typeof source === 'string'
        ? { id: source }
        : source && typeof source === 'object'
            ? source
            : {};
    return {
        id: String(act.id ?? '').trim().toLowerCase(),
        type: String(act.type ?? edge?.actType ?? '').trim().toLowerCase(),
        role: String(act.role ?? edge?.actRole ?? '').trim().toLowerCase(),
    };
}

/**
 * Declarative act gating for one target: an edge must exist between actor and
 * target carrying a matching act/actType/actRole. Pure; never mutates state.
 */
function actRequirementReason(state, actor, target, technique) {
    const required = technique?.requires || {};
    const act = required.act;
    const actType = required.actType;
    const role = required.actRole;
    if ((!act && !actType && !role) || target?.id === actor?.id) return '';
    const edge = (state?.engagements || []).find(candidate =>
        (candidate.a === actor.id && candidate.b === target.id)
        || (candidate.a === target.id && candidate.b === actor.id)) || null;
    if (!edge) {
        return act || actType
            ? `Requires active act: ${act || actType}.`
            : `Requires act role: ${role}.`;
    }
    const current = engagementAct(edge);
    // `act` matches the edge act id or type, and `actType` matches either, so a
    // catalog id (`penetration`) and a family (`penetration`) are interchangeable.
    if (act && current.id !== act && current.type !== act) {
        return `Requires active act: ${act}.`;
    }
    if (actType && current.type !== actType && current.id !== actType) {
        return `Requires active act: ${actType}.`;
    }
    // `mutual` accepts any role, but only once an actual act exists on the edge;
    // a bare pairing with no act never satisfies an act-role requirement.
    if (role && !current.id && !current.type) {
        return `Requires act role: ${role}.`;
    }
    if (role && role !== 'mutual' && current.role !== role) {
        return `Requires act role: ${role}.`;
    }
    return '';
}

function targetEntriesFor(state, actor, technique) {
    const mode = technique.targetMode || 'single';
    if (mode === 'self') {
        return [{
            id: actor.id,
            name: actor.name,
            self: true,
            disabled: false,
            reasons: [],
            zones: [...(technique.zones || [])],
        }];
    }
    const others = (state.participants || []).filter(participant => participant.id !== actor.id);
    let pool = others;
    if (mode === 'aura') {
        const engaged = (actor.engagedWith || [])
            .map(id => findParticipant(state, id))
            .filter(participant => isActive(participant) && participant.id !== actor.id);
        pool = engaged.length ? engaged : others;
    }
    return pool.map(target => {
        const reasons = [];
        if (!isActive(target)) reasons.push('Target is out of the encounter.');
        const blocked = isBlockedByLimits(target.profile, [
            ...(technique.tags || []),
            ...(technique.zones || []),
        ]);
        if (blocked) reasons.push(`Blocked by limit: ${blocked}`);
        if (!holdMatches(state, actor, target, technique)) {
            reasons.push(`Requires hold: ${technique.requires.hold === true ? 'any hold' : technique.requires.hold}.`);
        }
        const actReason = actRequirementReason(state, actor, target, technique);
        if (actReason) reasons.push(actReason);
        if (technique.requires?.overwhelmed && !(Number(target.overwhelmedUntilRound) >= Number(state.round))) {
            reasons.push('Requires an overwhelmed target.');
        }
        if (!canEngageWith(state, actor.id, target.id, state.maxPartners)) {
            reasons.push(`Partner limit reached (${state.maxPartners}).`);
        }
        return {
            id: target.id,
            name: target.name,
            disabled: reasons.length > 0,
            reasons,
            zones: [...(technique.zones || [])],
        };
    });
}

/**
 * List every catalog technique with the reason it is or is not legal right now.
 * `listLegalActions` never mutates the board and never returns a legal-looking
 * action with an illegal target.
 *
 * @param {object} state
 * @param {object|string} unit
 * @param {{ techniques?: object[] }} [options]
 * @returns {object[]}
 */
export function listLegalActions(state, unit, options = {}) {
    const actor = findParticipant(state, unit);
    const catalog = Array.isArray(options.techniques)
        ? options.techniques
        : Array.isArray(state?.techniques)
            ? state.techniques
            : LEWD_TECHNIQUES;
    const actorReasons = [];
    if (!state || state.status !== 'active') actorReasons.push('Encounter is not active.');
    if (!actor) actorReasons.push('Participant not found.');
    else {
        if (actor.spectator) actorReasons.push('Spectators cannot act.');
        if (isOut(actor)) actorReasons.push('This participant is out of the encounter.');
        if (actor.acted) actorReasons.push('This participant has already acted this round.');
    }

    return catalog.filter(Boolean).map(technique => {
        const reasons = [...actorReasons];
        if (!stanceMatches(actor, technique)) {
            reasons.push(`Requires stance: ${technique.requires.stance}.`);
        }
        if (usesRemaining(actor, technique) <= 0) {
            reasons.push('No uses remaining for this technique.');
        }
        const targets = actor ? targetEntriesFor(state, actor, technique) : [];
        if (technique.targetMode !== 'self' && !targets.some(target => !target.disabled)) {
            reasons.push('No legal targets.');
        }
        return {
            id: technique.id,
            name: technique.name,
            category: technique.category,
            technique,
            actType: technique.actType ?? null,
            actRole: technique.actRole ?? null,
            disabled: reasons.length > 0,
            reasons,
            posture: defaultPosture(technique),
            postures: allowedPostures(technique),
            zones: [...(technique.zones || [])],
            targets,
            usesRemaining: usesRemaining(actor, technique),
        };
    });
}

/**
 * Body-zone advice for a target: shipped sensitivity times the profile's
 * modifier. Kept here so the action composer and the AI score the same way.
 * @param {object} profile
 * @param {string} zone
 * @returns {number}
 */
export function techniqueZoneWeight(profile, zone) {
    const normalized = normalizeLewdZone(zone);
    if (!normalized) return 0;
    const base = Number(DEFAULT_ZONE_SENSITIVITY[normalized]) || 1;
    const modifier = Number(profile?.sensitivity?.[normalized]);
    return base * (Number.isFinite(modifier) && modifier > 0 ? modifier : 1);
}

/** Stable key used by the action log and the compendium cache. */
export function lewdTechniqueKey(technique) {
    return String(technique?.id || slug(technique?.name || 'technique'));
}

/** Lookup helper that accepts a name as well as an id. */
export function findLewdTechnique(catalog, idOrName) {
    const key = String(idOrName ?? '').trim().toLowerCase();
    if (!key) return null;
    const entries = Array.isArray(catalog) ? catalog : Object.values(catalog || {});
    return entries.find(entry => String(entry?.id || '').toLowerCase() === key)
        || entries.find(entry => normalizeLewdName(entry?.name) === normalizeLewdName(key))
        || null;
}
