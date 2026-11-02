/**
 * tactical-combat-status.js — shared status formatting and memo parsing.
 *
 * The State Tracker uses lines such as:
 *   Status: (-) Bleed (1d4 HP damage per turn, 1 turn), (+) Heroism (+2 attack, 3 turns)
 *
 * Combat statuses use the same vocabulary so a condition can survive a fight,
 * be written back to [CHARACTER]/[PARTY], and be imported by the next encounter.
 */

import { clampInt } from './tactical-combat-constants.js';
import { normalizeStatusBehavior } from './tactical-combat-willpower.js';

function stringValue(value, max = 400) {
    return String(value == null ? '' : value).slice(0, max);
}

function slug(value, fallback = 'status') {
    const out = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return out || fallback;
}

function splitTopLevel(value, separator = ',') {
    const source = String(value || '');
    const parts = [];
    let current = '';
    let depth = 0;
    for (const char of source) {
        if (char === '(') depth += 1;
        else if (char === ')') depth = Math.max(0, depth - 1);
        if (char === separator && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    if (current.trim()) parts.push(current);
    return parts;
}

/**
 * Infer the tracker's (+)/(-) prefix when a status does not declare one.
 * @param {object|null|undefined} status
 * @returns {'positive'|'negative'|''}
 */
export function inferStatusPolarity(status) {
    if (!status || typeof status !== 'object') return '';
    const explicit = String(status.polarity || '').toLowerCase();
    if (explicit === 'positive' || explicit === 'negative') return explicit;
    if (status.damage || Number(status.acBonus) < 0 || Number(status.attackBonus) < 0) return 'negative';
    if (['stunned', 'confused', 'frightened', 'charmed', 'berserk'].includes(String(status.behavior || ''))) return 'negative';
    if (Number(status.acBonus) > 0 || Number(status.attackBonus) > 0) return 'positive';
    return '';
}

/**
 * Format the duration half of a tracker status string.
 * @param {object} status
 * @returns {string}
 */
export function formatStatusDuration(status) {
    if (status?.permanent === true) return 'until cured';
    const rounds = Math.max(0, Number(status?.rounds) || 0);
    if (rounds > 0) return `${rounds} turn${rounds === 1 ? '' : 's'}`;
    if (status?.expiresAfterTurn === true) return '1 turn';
    const minutes = Math.max(0, Number(status?.durationMinutes) || 0);
    if (minutes > 0) {
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        if (hours && rest) return `${hours}h ${rest}m`;
        if (hours) return `${hours}h`;
        return `${rest}m`;
    }
    return '';
}

/**
 * Describe a status's mechanical effect in tracker-readable prose.
 * @param {object} status
 * @returns {string}
 */
export function formatStatusEffect(status) {
    const bits = [];
    if (status?.damage) {
        const resource = status.damageResource === 'willpower'
            ? 'Willpower '
            : status.damageResource === 'both' ? 'HP+Willpower ' : '';
        const type = status.damageType ? ` ${stringValue(status.damageType, 20)}` : '';
        bits.push(`${status.damage}${type} ${resource}damage per turn`);
    }
    if (Number(status?.acBonus)) bits.push(`${Number(status.acBonus) >= 0 ? '+' : ''}${Number(status.acBonus)} AC`);
    if (Number(status?.attackBonus)) bits.push(`${Number(status.attackBonus) >= 0 ? '+' : ''}${Number(status.attackBonus)} attack`);
    if (status?.behavior) bits.push(stringValue(status.behavior, 20));
    const description = stringValue(status?.description, 120).trim();
    if (description && !bits.length
        && !/^\d+\s*(?:turns?|rounds?|hours?|hrs?|h|minutes?|mins?|m)$/i.test(description)
        && !/^(?:until cured|permanent|until (?:long|short) rest)$/i.test(description)) {
        bits.push(description);
    }
    return bits.filter(Boolean).join(', ');
}

/**
 * @param {object} status
 * @returns {string}
 */
export function formatStatusCondition(status) {
    if (!status || typeof status !== 'object') return '';
    const label = stringValue(status.label || status.name || status.id || 'Condition', 60).trim();
    if (!label) return '';
    const polarity = inferStatusPolarity(status);
    const prefix = polarity === 'negative' ? '(-) ' : polarity === 'positive' ? '(+) ' : '';
    const stacks = Math.max(1, Number(status.stacks) || 1);
    const stackLabel = stacks > 1 ? ` x${stacks}` : '';
    const effect = formatStatusEffect(status);
    const duration = formatStatusDuration(status);
    const details = [effect, duration].filter(Boolean).join(', ');
    return `${prefix}${label}${stackLabel}${details ? ` (${details})` : ''}`;
}

/**
 * @param {object[]} statuses
 * @returns {string}
 */
export function formatStatusLine(statuses) {
    const list = (Array.isArray(statuses) ? statuses : [])
        .map(formatStatusCondition)
        .filter(Boolean);
    return list.length ? list.join(', ') : 'Healthy';
}

function parseDuration(content) {
    const source = String(content || '');
    const rounds = source.match(/(\d+)\s*(?:turns?|rounds?)\b/i);
    if (rounds) return { rounds: clampInt(rounds[1], 1, 99, 1) };
    if (/\b(?:until cured|permanent|until (?:long|short) rest)\b/i.test(source)) {
        return { permanent: true };
    }
    const hours = source.match(/(\d+)\s*(?:hours?|hrs?|h)\b(?:\s*(\d+)\s*(?:minutes?|mins?|m)\b)?/i);
    if (hours) {
        return {
            durationMinutes: clampInt(hours[1], 1, 9999, 1) * 60
                + (hours[2] ? clampInt(hours[2], 0, 59, 0) : 0),
        };
    }
    const minutes = source.match(/(\d+)\s*(?:minutes?|mins?|m)\b/i);
    if (minutes) return { durationMinutes: clampInt(minutes[1], 1, 9999, 1) };
    return {};
}

function parseDamage(content) {
    const source = String(content || '');
    const both = source.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?|\d+)\s*(?:([A-Za-z]+)\s+)?HP\s*\+\s*(?:Willpower|WP)/i);
    if (both) {
        const type = both[2] && !/^(?:hp|damage|per|each)$/i.test(both[2]) ? both[2] : '';
        return {
            damage: both[1].replace(/\s+/g, ''),
            damageResource: 'both',
            ...(type ? { damageType: type.slice(0, 20) } : {}),
        };
    }
    const match = source.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?|\d+)\s*(?:([A-Za-z]+)\s+)?(HP|hit points?|health|willpower|WP)(?:\s+damage)?/i);
    if (match) {
        const rawResource = String(match[3] || '').toLowerCase();
        const damageType = match[2] && !/^(?:hp|willpower|wp|hit|points?|health)$/i.test(match[2])
            ? match[2]
            : '';
        return {
            damage: match[1].replace(/\s+/g, ''),
            damageResource: /willpower|wp/i.test(rawResource) ? 'willpower' : 'hp',
            ...(damageType ? { damageType: damageType.slice(0, 20) } : {}),
        };
    }
    const generic = source.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?|\d+)\s*(?:([A-Za-z]+)\s+)?(?:damage|dmg)\b/i);
    if (!generic) return {};
    const type = generic[2] && !/^(?:damage|dmg|per|each|a|an|the)$/i.test(generic[2]) ? generic[2] : '';
    return {
        damage: generic[1].replace(/\s+/g, ''),
        damageResource: 'hp',
        ...(type ? { damageType: type.slice(0, 20) } : {}),
    };
}

/**
 * Parse a memo Status line into status seeds. This intentionally accepts both
 * the combat writer's output and the State Tracker's freeform condition text;
 * unknown prose is preserved as a descriptive condition.
 * @param {string} value
 * @returns {object[]}
 */
export function parseStatusConditions(value) {
    const source = String(value || '')
        .replace(/^\s*[-*+•]\s*/, '')
        .replace(/^\s*Status\s*:\s*/i, '')
        .trim();
    if (!source || /^healthy\b/i.test(source)) return [];
    if (/^(?:defeated|fled|willpower broken)\b/i.test(source)) return [];
    const results = [];
    for (const rawPart of splitTopLevel(source)) {
        const part = rawPart.trim();
        if (!part) continue;
        if (/^(?:defeated|fled|willpower broken)\b/i.test(part)) continue;
        const polarityMatch = part.match(/^\(([+-])\)\s*/);
        const polarity = polarityMatch
            ? (polarityMatch[1] === '-' ? 'negative' : 'positive')
            : '';
        const body = polarityMatch ? part.slice(polarityMatch[0].length) : part;
        const match = body.match(/^(.+?)\s*(?:\(([\s\S]*)\))?$/);
        if (!match) continue;
        let label = stringValue(match[1], 60).trim();
        if (!label) continue;
        let stacks = 1;
        const stackMatch = label.match(/\s+x(\d+)$/i);
        if (stackMatch) {
            stacks = clampInt(stackMatch[1], 1, 10, 1);
            label = label.slice(0, stackMatch.index).trim();
        }
        const content = match[2] || '';
        const duration = parseDuration(content);
        const damage = parseDamage(content);
        const acBonus = Number((content.match(/([+-]\d+)\s*AC\b/i) || [])[1]) || 0;
        const attackBonus = Number((content.match(/([+-]\d+)\s*(?:attack|atk)\b/i) || [])[1]) || 0;
        const behaviorMatch = content.match(/\b(stunned|confused|frightened|charmed|berserk)\b/i);
        const description = content
            .replace(/\d+\s*(?:turns?|rounds?)\b/gi, '')
            .replace(/\d+\s*(?:hours?|hrs?|h)\b(?:\s*\d+\s*(?:minutes?|mins?|m)\b)?/gi, '')
            .replace(/\d+\s*(?:minutes?|mins?|m)\b/gi, '')
            .replace(/\b(?:until cured|permanent|until (?:long|short) rest)\b/gi, '')
            .replace(/\s*,\s*$/, '')
            .trim();
        const status = {
            id: slug(label),
            label: label.slice(0, 60),
            polarity,
            stacks,
            maxStacks: Math.max(1, stacks),
            ...duration,
            ...damage,
            acBonus,
            attackBonus,
            behavior: behaviorMatch ? normalizeStatusBehavior(behaviorMatch[1]) : '',
            ...(description ? { description: stringValue(description, 300) } : {}),
            source: 'memo',
        };
        if (!status.polarity) delete status.polarity;
        results.push(status);
    }
    return results;
}

export { splitTopLevel, parseDuration, parseDamage };
