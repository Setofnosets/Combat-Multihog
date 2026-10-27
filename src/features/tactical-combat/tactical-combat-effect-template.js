/**
 * tactical-combat-effect-template.js — shared normalization for deterministic
 * special-effect recipes.
 *
 * A special ability is authored once (by the resolver, the encounter architect,
 * or a user) and then stored as a list of engine primitives. These helpers keep
 * the compendium and the campaign Skill Registry using the same shape.
 */

export const EFFECT_PRIMITIVE_TYPES = Object.freeze([
    'damage',
    'heal',
    'status',
    'cure',
    'terrain',
    'summon',
    'transform',
    'defeat',
    'log',
]);

const EFFECT_TYPE_SET = new Set(EFFECT_PRIMITIVE_TYPES);

function cloneJson(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function stringValue(value, max = 400) {
    return String(value == null ? '' : value).slice(0, max);
}

function optionalInt(value, min, max) {
    if (value == null || value === '') return null;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, n));
}

function normalizeCellOffset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const dx = Number(raw.dx ?? raw.x);
    const dy = Number(raw.dy ?? raw.y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    return {
        dx: Math.max(-64, Math.min(64, Math.round(dx))),
        dy: Math.max(-64, Math.min(64, Math.round(dy))),
    };
}

function normalizeCell(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (x < 0 || y < 0 || x > 512 || y > 512) return null;
    const cell = { x, y };
    if (raw.terrain != null) cell.terrain = stringValue(raw.terrain, 20).toLowerCase();
    return cell;
}

function normalizeSkillArray(raw, max = 8) {
    if (!Array.isArray(raw)) return null;
    return raw
        .filter(entry => entry && typeof entry === 'object')
        .slice(0, max)
        .map(entry => {
            const copy = cloneJson(entry);
            if (!copy || typeof copy !== 'object') return null;
            if (copy.name != null) copy.name = stringValue(copy.name, 80);
            if (copy.description != null) copy.description = stringValue(copy.description, 400);
            if (copy.damage != null) copy.damage = stringValue(copy.damage, 40);
            if (copy.heal != null) copy.heal = stringValue(copy.heal, 40);
            return copy;
        })
        .filter(Boolean);
}

function normalizeItemArray(raw, max = 8) {
    if (!Array.isArray(raw)) return null;
    return raw
        .filter(entry => entry && typeof entry === 'object')
        .slice(0, max)
        .map(entry => cloneJson(entry));
}

/**
 * Sanitize one effect primitive inside a stored template. Unknown primitives
 * are dropped rather than being sent to the model or engine.
 * @param {any} raw
 * @returns {object|null}
 */
export function normalizeEffectPrimitive(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const type = stringValue(raw.type, 20).toLowerCase();
    if (!EFFECT_TYPE_SET.has(type)) return null;
    const effect = { type };

    if (raw.target != null) effect.target = stringValue(raw.target, 32);
    if (raw.targetId != null) effect.targetId = stringValue(raw.targetId, 80);
    if (raw.resource != null) {
        const resource = stringValue(raw.resource, 12).toLowerCase();
        if (['hp', 'willpower', 'both'].includes(resource)) effect.resource = resource;
    }
    if (raw.amount != null) effect.amount = stringValue(raw.amount, 40);
    if (raw.damage != null) effect.damage = stringValue(raw.damage, 40);
    if (raw.heal != null) effect.heal = stringValue(raw.heal, 40);
    if (raw.willpowerOutcome != null) effect.willpowerOutcome = stringValue(raw.willpowerOutcome, 20).toLowerCase();
    if (raw.outcome != null) effect.outcome = stringValue(raw.outcome, 20).toLowerCase();
    if (raw.reason != null) effect.reason = stringValue(raw.reason, 200);

    if (type === 'status') {
        if (raw.label != null) effect.label = stringValue(raw.label, 60);
        if (raw.name != null) effect.name = stringValue(raw.name, 60);
        effect.rounds = optionalInt(raw.rounds, 1, 10) ?? 2;
        if (raw.acBonus != null) effect.acBonus = optionalInt(raw.acBonus, -10, 10) || 0;
        if (raw.attackBonus != null) effect.attackBonus = optionalInt(raw.attackBonus, -10, 10) || 0;
        if (raw.damage != null) effect.damage = stringValue(raw.damage, 40);
        if (raw.damageResource != null) effect.damageResource = stringValue(raw.damageResource, 12).toLowerCase();
        if (raw.behavior != null) effect.behavior = stringValue(raw.behavior, 20).toLowerCase();
        if (raw.sourceId != null) effect.sourceId = stringValue(raw.sourceId, 60);
        effect.stacks = optionalInt(raw.stacks, 1, 5) ?? 1;
        effect.maxStacks = optionalInt(raw.maxStacks, 1, 10) ?? 1;
        if (raw.description != null) effect.description = stringValue(raw.description, 300);
    }

    if (type === 'terrain') {
        if (raw.terrain != null) effect.terrain = stringValue(raw.terrain, 20).toLowerCase();
        const cells = Array.isArray(raw.cells) ? raw.cells.map(normalizeCell).filter(Boolean).slice(0, 64) : [];
        const offsets = Array.isArray(raw.cellOffsets)
            ? raw.cellOffsets.map(normalizeCellOffset).filter(Boolean).slice(0, 64)
            : [];
        if (cells.length) effect.cells = cells;
        if (offsets.length) effect.cellOffsets = offsets;
        if (raw.x != null && raw.y != null) {
            const cell = normalizeCell(raw);
            if (cell) effect.cells = [cell];
        }
    }

    if (type === 'summon') {
        if (raw.name != null) effect.name = stringValue(raw.name, 60);
        if (raw.formId != null) effect.formId = stringValue(raw.formId, 80);
        for (const key of ['maxHp', 'maxWillpower', 'ac', 'attackBonus', 'attackRange']) {
            if (raw[key] != null) effect[key] = optionalInt(raw[key], key === 'attackBonus' ? -10 : 0, key === 'maxHp' ? 999 : 99);
        }
        if (raw.damage != null) effect.damage = stringValue(raw.damage, 40);
        const summonSkills = normalizeSkillArray(raw.skills);
        if (summonSkills) effect.skills = summonSkills;
        if (raw.unit && typeof raw.unit === 'object') effect.unit = cloneJson(raw.unit);
    }

    if (type === 'transform') {
        if (raw.formId != null) effect.formId = stringValue(raw.formId, 80);
        if (raw.name != null) effect.name = stringValue(raw.name, 80);
        if (raw.classLabel != null) effect.classLabel = stringValue(raw.classLabel, 80);
        for (const key of ['maxHp', 'hp', 'maxWillpower', 'willpower', 'ac', 'attackBonus', 'spellAttackBonus', 'spellSaveDC', 'attackRange', 'speed', 'level']) {
            if (raw[key] != null) effect[key] = optionalInt(raw[key], -10, key === 'maxHp' || key === 'hp' ? 999 : 60);
        }
        for (const key of ['damage', 'damageType', 'notes', 'glyph', 'color', 'attackResource', 'willpowerDamage', 'attackWillpowerOutcome']) {
            if (raw[key] != null) effect[key] = stringValue(raw[key], key === 'notes' ? 500 : 80);
        }
        if (raw.replaceSkills != null) effect.replaceSkills = raw.replaceSkills === true;
        const skills = normalizeSkillArray(raw.skills);
        if (skills) effect.skills = skills;
        const items = normalizeItemArray(raw.items);
        if (items) effect.items = items;
        const inventory = normalizeItemArray(raw.inventory, 24);
        if (inventory) effect.inventory = inventory;
        if (raw.permanent != null) effect.permanent = raw.permanent === true;
        effect.rounds = optionalInt(raw.rounds, 0, 99) ?? 0;
    }

    if (type === 'log') {
        if (raw.text == null) return null;
        effect.text = stringValue(raw.text, 400);
    }

    if (raw.limit != null) effect.limit = optionalInt(raw.limit, 1, 64);
    return effect;
}

/**
 * @param {any} raw
 * @param {{ max?: number }} [options]
 * @returns {object[]}
 */
export function sanitizeEffectTemplate(raw, options = {}) {
    if (!Array.isArray(raw)) return [];
    const max = Math.max(1, Math.min(16, Number(options.max) || 8));
    return raw
        .slice(0, max)
        .map(normalizeEffectPrimitive)
        .filter(Boolean);
}

/**
 * @param {any} raw
 * @returns {{ type: 'attack'|'save'|'none', save: string, dc: number|null, halfOnSave: boolean }}
 */
export function normalizeEffectCheck(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const typeRaw = stringValue(source.type, 12).toLowerCase();
    const type = ['attack', 'save', 'none'].includes(typeRaw)
        ? typeRaw
        : (source.save ? 'save' : 'attack');
    const save = ['str', 'dex', 'con', 'int', 'wis', 'will', 'cha'].includes(stringValue(source.save, 12).toLowerCase())
        ? stringValue(source.save, 12).toLowerCase()
        : '';
    return {
        type,
        save,
        dc: optionalInt(source.dc, 1, 40),
        halfOnSave: source.halfOnSave === true,
    };
}

/**
 * Human-readable one-line summary of a stored effect list.
 * @param {object[]} effects
 * @param {number} [maxLength]
 * @returns {string}
 */
export function summarizeEffectTemplate(effects, maxLength = 260) {
    const list = Array.isArray(effects) ? effects : [];
    const labels = {
        '$caster': 'self',
        '$target': 'primary target',
        '$area': 'area',
        '$areaHostile': 'hostile area',
        '$areaFriendly': 'friendly area',
    };
    const parts = [];
    for (const effect of list) {
        const target = labels[effect?.target] || '';
        const prefix = target ? ` to ${target}` : '';
        if (!effect || typeof effect !== 'object') continue;
        switch (effect.type) {
            case 'damage':
                parts.push(`${effect.amount || effect.damage || '?'} ${effect.resource === 'willpower' ? 'Willpower' : effect.resource === 'both' ? 'HP+WP' : 'HP'} damage${prefix}`);
                break;
            case 'heal':
                parts.push(`heal ${effect.amount || effect.heal || '?'} ${effect.resource === 'willpower' ? 'Willpower' : 'HP'}${prefix}`);
                break;
            case 'status':
                parts.push(`${effect.label || effect.name || 'status'} for ${effect.rounds || 2} round(s)${prefix}`);
                break;
            case 'cure':
                parts.push(`cure${prefix}`);
                break;
            case 'defeat':
                parts.push(`defeat (${effect.outcome || effect.willpowerOutcome || 'defeat'})${prefix}`);
                break;
            case 'terrain': {
                const count = (effect.cellOffsets || effect.cells || []).length;
                parts.push(`${effect.terrain || 'terrain'} change${count ? ` (${count} cells)` : ''}`);
                break;
            }
            case 'summon':
                parts.push(`summon ${effect.name || effect.formId || 'creature'}`);
                break;
            case 'transform':
                parts.push(`transform into ${effect.name || effect.formId || 'a new form'}${target ? ` (${target})` : ''}`);
                break;
            case 'log':
                parts.push('narrative effect');
                break;
            default:
                break;
        }
    }
    return parts.join('; ').slice(0, maxLength);
}
