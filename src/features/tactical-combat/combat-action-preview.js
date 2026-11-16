/**
 * combat-action-preview.js — read-only action predictions shared by the
 * Tactical and Traditional boards.
 *
 * Every number here comes from the same engine helpers that resolve an action:
 * `getEffectiveAttackBonus`, `getSourceAttackBonus`, `getEffectiveAc`,
 * `scaledSourceExpression`, and the status damage modifiers. The module never
 * rolls dice, mutates state, consumes uses, or writes a log; it only formats a
 * deterministic prediction for the UI.
 */

import {
    getEffectiveAc,
    getEffectiveAttackBonus,
    getSourceAttackBonus,
    getStatusDamageBonus,
    getStatusDamageReduction,
    scaledSourceExpression,
} from './tactical-combat-engine.js';
import { summarizeEffectTemplate } from './tactical-combat-effect-template.js';

const NATURAL_CRIT_CHANCE = 5;

/**
 * Resolve the raw (possibly scale-adjusted) expression for a source field.
 * Thin wrapper over the engine's own helper so previews never fork the math.
 *
 * @param {object|null} source
 * @param {object} state
 * @param {object} unit
 * @param {object|null} target
 * @param {'damage'|'heal'|'willpowerDamage'} [field]
 * @returns {string}
 */
export function resolvePreviewExpression(source, state, unit, target, field = 'damage') {
    return scaledSourceExpression(source || {}, state, unit, target, field);
}

/**
 * Average/min/max for a simple dice expression. Supports `XdY`, flat `+N`/`-N`,
 * bare numbers, and sums of those terms (`1d8+1d4+2`). Returns null when the
 * expression contains unresolved `@` scale tokens or any unparseable fragment,
 * rather than reporting a misleading number.
 *
 * @param {string|number} expression
 * @returns {{min:number, avg:number, max:number}|null}
 */
export function averageDiceExpression(expression) {
    const source = String(expression ?? '').trim().toLowerCase();
    if (!source || source.includes('@')) return null;
    const compact = source.replace(/\s+/g, '');
    const pattern = /([+-]?)(?:(\d*)d(\d+)|(\d+(?:\.\d+)?))/g;
    let min = 0;
    let avg = 0;
    let max = 0;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(compact))) {
        if (match.index !== cursor) return null;
        cursor = pattern.lastIndex;
        const sign = match[1] === '-' ? -1 : 1;
        if (match[3] != null) {
            const count = Math.max(1, Math.min(20, Number.parseInt(match[2] || '1', 10) || 1));
            const sides = Math.max(2, Math.min(1000, Number.parseInt(match[3], 10) || 6));
            min += sign * count;
            max += sign * count * sides;
            avg += sign * count * (sides + 1) / 2;
        } else {
            const flat = Number(match[4]);
            if (!Number.isFinite(flat)) return null;
            min += sign * flat;
            avg += sign * flat;
            max += sign * flat;
        }
    }
    if (cursor !== compact.length || cursor === 0) return null;
    return { min, avg, max };
}

/**
 * Probability (integer percent) that a d20 attack roll hits. Natural 20 always
 * hits, natural 1 always misses, otherwise `d20 + bonus >= ac`.
 *
 * @param {number} attackBonus
 * @param {number} ac
 * @returns {number} 0–100
 */
export function estimateHitChance(attackBonus, ac) {
    const bonus = Number(attackBonus) || 0;
    const targetAc = Number(ac);
    if (!Number.isFinite(targetAc)) return 0;
    let hits = 0;
    for (let face = 1; face <= 20; face += 1) {
        if (face === 20) hits += 1;
        else if (face !== 1 && face + bonus >= targetAc) hits += 1;
    }
    return hits * 5;
}

function numberText(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '?';
    return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
}

function expressionText(expression, stats, extra = 0) {
    const raw = String(expression || '').trim();
    if (!raw) return 'no fixed value';
    if (!stats) return raw;
    const min = Math.max(0, stats.min + extra);
    const avg = Math.max(0, stats.avg + extra);
    const max = Math.max(0, stats.max + extra);
    const range = max > min ? `, ${numberText(min)}–${numberText(max)}` : '';
    return `${raw} (avg ${numberText(avg)}${range})`;
}

function resourceLabel(resource) {
    if (resource === 'willpower') return 'Willpower';
    if (resource === 'both') return 'HP+WP';
    return 'HP';
}

function damageKind(source, mode) {
    if (!source) return 'attack';
    const kind = String(source.kind || '').toLowerCase();
    if (kind === 'special') return 'special';
    // The engine treats every non-heal item as a buff; only heal items roll amount.
    if (mode === 'item') return kind === 'heal' ? 'heal' : 'buff';
    return kind || 'attack';
}

function bonusLines(source, targetSuffix) {
    const lines = [];
    if (Number(source.acBonus)) lines.push(`${Number(source.acBonus) > 0 ? '+' : ''}${numberText(source.acBonus)} AC${targetSuffix}`);
    if (Number(source.attackBonus)) lines.push(`${Number(source.attackBonus) > 0 ? '+' : ''}${numberText(source.attackBonus)} attack bonus${targetSuffix}`);
    if (Number(source.damageBonus)) lines.push(`${Number(source.damageBonus) > 0 ? '+' : ''}${numberText(source.damageBonus)} damage${targetSuffix}`);
    if (Number(source.damageReduction)) lines.push(`-${numberText(source.damageReduction)} damage taken${targetSuffix}`);
    return lines;
}

function bonusSummary(source) {
    const parts = [];
    if (Number(source.acBonus)) parts.push(`${Number(source.acBonus) > 0 ? '+' : ''}${numberText(source.acBonus)} AC`);
    if (Number(source.attackBonus)) parts.push(`${Number(source.attackBonus) > 0 ? '+' : ''}${numberText(source.attackBonus)} ATK`);
    if (Number(source.damageBonus)) parts.push(`${Number(source.damageBonus) > 0 ? '+' : ''}${numberText(source.damageBonus)} dmg`);
    if (Number(source.damageReduction)) parts.push(`-${numberText(source.damageReduction)} taken`);
    return parts.join(' · ');
}

function rangeLine(source) {
    if (!source) return '';
    const parts = [];
    if (source.range != null && Number(source.range) > 0) parts.push(`Range: ${numberText(source.range)} cells`);
    if (source.area && typeof source.area === 'object') {
        const shape = String(source.area.shape || source.area.type || '').trim();
        const size = Number(source.area.radius || source.area.size || 0);
        if (shape) parts.push(`Area: ${shape}${size ? ` ${numberText(size)}` : ''}`);
    }
    return parts.join(' · ');
}

/**
 * Build a printable preview for one action. Plain text only; callers escape.
 *
 * @param {object} state
 * @param {object} unit
 * @param {object|null} source - skill/item, or null for a basic attack.
 * @param {{target?: object|null, mode?: 'attack'|'skill'|'item'}} [options]
 * @returns {{title:string, description:string, kind:string, special:boolean, lines:string[], summary:string, prediction:object}}
 */
export function buildActionPreview(state, unit, source = null, options = {}) {
    const mode = options.mode || (source ? 'skill' : 'attack');
    const target = options.target || null;
    const kind = damageKind(source, mode);
    const title = String(source?.name || 'Basic attack');
    const description = String(source?.description || '');
    const special = kind === 'special';
    const targetSuffix = target ? ` to ${target.name}` : '';
    const targetArrow = target ? ` → ${target.name}` : '';
    const lines = [];
    const prediction = {};
    let summary = title;

    if (special) {
        if (description) lines.push(description);
        const recipe = summarizeEffectTemplate(source?.effectTemplate);
        if (recipe) lines.push(`Recipe: ${recipe}`);
        lines.push('Resolved by the combat agent when cast; no fixed numbers.');
        summary = `${title}${targetArrow}: ${recipe ? `${recipe} · ` : ''}resolved by the combat agent`;
        return { title, description, kind, special, lines, summary, prediction };
    }

    if (kind === 'heal') {
        const isItem = mode === 'item';
        const expression = isItem
            ? String(source?.amount || '2d4+2')
            : resolvePreviewExpression(
                { heal: source?.heal || '1d8+2', scale: source?.scale },
                state,
                unit,
                target,
                'heal',
            );
        const stats = averageDiceExpression(expression);
        if (stats) {
            prediction.averageHeal = stats.avg;
        }
        lines.push(`Heal ${resourceLabel(source?.resource)}: ${expressionText(expression, stats)}${targetSuffix}`);
        const line = rangeLine(source);
        if (line) lines.push(line);
        summary = `${title}${targetArrow}: heal ${expression}${stats ? ` (avg ${numberText(stats.avg)})` : ''}`;
        if (source?.resource === 'both') summary += ' HP+WP';
        return { title, description, kind, special, lines, summary, prediction };
    }

    if (kind === 'buff') {
        const bonuses = bonusLines(source, targetSuffix);
        lines.push(...bonuses);
        lines.push(`Duration: ${numberText(source?.rounds || 2)} rounds`);
        const line = rangeLine(source);
        if (line) lines.push(line);
        summary = `${title}${targetArrow}: ${bonusSummary(source) || 'no numeric bonuses'} for ${numberText(source?.rounds || 2)} rounds`;
        return { title, description, kind, special, lines, summary, prediction };
    }

    // Attack (basic, skill, or damaging area).
    const isItem = mode === 'item';
    const attackBonus = source
        ? getSourceAttackBonus(state, unit, source, target)
        : getEffectiveAttackBonus(state, unit, 0, target);
    const resource = String((source ? source.resource : unit?.attackResource) || 'hp');
    const baseDamage = source?.damage || unit?.damage || '1d6';
    const damageExpression = isItem
        ? String(source?.amount || '1d6')
        : resolvePreviewExpression(
            { damage: baseDamage, scale: source?.scale },
            state,
            unit,
            target,
            'damage',
        );
    // Mirror resolveAttack exactly: options.willpowerDamage || options.damage ||
    // (basic only) unit.willpowerDamage || '1d6'.
    const willpowerBase = source
        ? (source.willpowerDamage || baseDamage)
        : (unit?.willpowerDamage || unit?.damage || '1d6');
    const willpowerExpression = isItem
        ? damageExpression
        : resolvePreviewExpression(
            { damage: willpowerBase, scale: source?.scale },
            state,
            unit,
            target,
            'damage',
        );
    const outgoing = getStatusDamageBonus(unit, state, target);
    const incoming = target ? getStatusDamageReduction(target, state, unit) : 0;
    const delta = outgoing - incoming;
    const ac = target ? getEffectiveAc(state, target, unit) : null;
    const critChance = NATURAL_CRIT_CHANCE;
    const hitChance = target ? estimateHitChance(attackBonus, ac) : null;

    if (hitChance != null) {
        prediction.hitChance = hitChance;
        prediction.ac = ac;
        lines.push(`Hit chance: ${hitChance}% (crit ${critChance}%)`);
        lines.push(`Target AC: ${numberText(ac)}`);
    } else {
        lines.push(`Attack bonus: ${numberText(attackBonus)} (crit ${critChance}%)`);
    }
    prediction.critChance = critChance;

    const showHp = resource === 'hp' || resource === 'both';
    const showWillpower = resource === 'willpower' || resource === 'both';
    if (showHp) {
        const stats = averageDiceExpression(damageExpression);
        if (stats) {
            prediction.averageDamage = Math.max(0, stats.avg + delta);
        }
        lines.push(`Damage (HP): ${expressionText(damageExpression, stats, delta)}${targetSuffix}`);
    }
    if (showWillpower) {
        const stats = averageDiceExpression(willpowerExpression);
        if (stats && prediction.averageDamage == null) {
            prediction.averageDamage = Math.max(0, stats.avg + delta);
        }
        lines.push(`Damage (Willpower): ${expressionText(willpowerExpression, stats, delta)}${targetSuffix}`);
    }
    if (!showHp && !showWillpower) {
        lines.push(`Damage: ${damageExpression}${targetSuffix}`);
    }
    const line = rangeLine(source);
    if (line) lines.push(line);

    const primaryExpression = showHp ? damageExpression : willpowerExpression;
    const primaryStats = averageDiceExpression(primaryExpression);
    summary = `${title}${targetArrow}: ${hitChance != null ? `${hitChance}% hit · ` : ''}${primaryExpression}${primaryStats ? ` (avg ${numberText(Math.max(0, primaryStats.avg + delta))})` : ''}`;
    if (ac != null) summary += ` · AC ${numberText(ac)}`;

    return { title, description, kind, special, lines, summary, prediction };
}
