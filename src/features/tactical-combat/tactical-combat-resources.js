/**
 * tactical-combat-resources.js — spell slots, ability uses, and the
 * per-encounter resource ledger.
 *
 * The memo format distinguishes:
 *  - spell slots: `Level N (avail/max): Spell A, Spell B` (one shared pool)
 *  - ability uses: `Ability (description, 1/2 per rest)` (per ability)
 *  - at-will abilities: no uses notation
 *  - item quantities: `Healing Potion x2` (one pool per inventory line)
 *
 * The engine must consume the shared spell-slot pool, not one private uses
 * counter per spell. This module is deliberately dependency-light so the
 * context parser, engine, memo synchronizer, UI, and tests can share it.
 */

import { clampInt } from './tactical-combat-constants.js';

/**
 * Parse a usage fragment. Accepts "2/3", "2 uses", and absent usage.
 * @param {unknown} text
 * @param {{ fallbackMax?: number|null, fallbackUnlimited?: boolean }} [options]
 * @returns {{ current:number|null, max:number|null, unlimited:boolean }}
 */
export function parseUsageState(text, options = {}) {
    const source = String(text ?? '');
    const slash = source.match(/(\d+)\s*\/\s*(\d+)/);
    if (slash) {
        const max = clampInt(slash[2], 0, 99);
        const current = clampInt(slash[1], 0, max);
        return { current, max, unlimited: false };
    }
    const uses = source.match(/(\d+)\s*uses?\b/i)
        || source.match(/(\d+)\s*(?:\/|\bper\b)\s*(?:day|rest|short rest|long rest|encounter)\b/i);
    if (uses) {
        const max = clampInt(uses[1], 0, 99);
        return { current: max, max, unlimited: false };
    }
    if (options.fallbackMax != null && Number.isFinite(Number(options.fallbackMax))) {
        const max = clampInt(options.fallbackMax, 0, 99);
        return { current: max, max, unlimited: false };
    }
    if (options.fallbackUnlimited === true) {
        return { current: null, max: null, unlimited: true };
    }
    return { current: null, max: null, unlimited: true };
}

/**
 * Resolve the live resource state for a skill/item. Spell slots live on the
 * owning unit, so a shared pool is represented once and every spell reads it.
 * @param {object|null|undefined} source
 * @param {object|null|undefined} unit
 * @returns {{ current:number|null, max:number|null, unlimited:boolean, slotKey:string }}
 */
export function getResourceState(source, unit) {
    if (!source) return { current: 0, max: 0, unlimited: false, slotKey: '' };
    if (source.unlimited === true) {
        return { current: null, max: null, unlimited: true, slotKey: '' };
    }
    const slotKey = String(source.slotKey || '');
    const pool = slotKey ? unit?.spellSlots?.[slotKey] : null;
    if (pool && typeof pool === 'object') {
        const max = Math.max(0, Number(pool.max) || 0);
        return {
            current: Math.min(max, Math.max(0, Number(pool.current) || 0)),
            max,
            unlimited: false,
            slotKey,
        };
    }
    const maxUses = Math.max(0, Number(source.maxUses) || 0);
    const rawUses = source.uses == null ? maxUses : Number(source.uses);
    return {
        current: Math.min(maxUses, Math.max(0, Number.isFinite(rawUses) ? rawUses : 0)),
        max: maxUses,
        unlimited: false,
        slotKey,
    };
}

/** @param {object|null|undefined} source @param {object|null|undefined} unit */
export function hasUses(source, unit) {
    if (!source) return false;
    const state = getResourceState(source, unit);
    return state.unlimited || state.current > 0;
}

/**
 * Consume one use from a skill/item. Spell-slot sources decrement the shared
 * pool and mirror the new current value into every spell using that pool so
 * legacy UI/payload code remains consistent.
 * @param {object} source
 * @param {object} unit
 * @returns {boolean} true when a use was consumed
 */
export function consumeUse(source, unit) {
    if (!source || !unit) return false;
    if (source.unlimited === true) return true;
    const state = getResourceState(source, unit);
    if (state.current <= 0) return false;
    if (state.slotKey && unit.spellSlots?.[state.slotKey]) {
        const pool = unit.spellSlots[state.slotKey];
        pool.current = Math.max(0, (Number(pool.current) || 0) - 1);
        for (const skill of unit.skills || []) {
            if (skill && skill.slotKey === state.slotKey) {
                skill.uses = pool.current;
                skill.maxUses = Math.max(Number(skill.maxUses) || 0, Number(pool.max) || 0);
            }
        }
        return true;
    }
    source.uses = Math.max(0, (Number(source.uses) || 0) - 1);
    return true;
}

/**
 * Build shared pools from every skill carrying a slotKey. Current values come
 * from the skill's parsed `uses`; max from `maxUses`. Duplicate keys merge to
 * the most conservative current value and the largest max.
 * @param {object[]} skills
 * @returns {Record<string,{current:number,max:number}>}
 */
export function buildSpellSlots(skills) {
    const pools = {};
    for (const skill of Array.isArray(skills) ? skills : []) {
        const slotKey = String(skill?.slotKey || '');
        if (!slotKey) continue;
        const max = Math.max(0, Number(skill.maxUses) || 0);
        const current = Math.max(0, Math.min(max, Number(skill.uses) || 0));
        if (!pools[slotKey]) {
            pools[slotKey] = { current, max };
        } else {
            pools[slotKey].max = Math.max(pools[slotKey].max, max);
            pools[slotKey].current = Math.min(pools[slotKey].current, current);
        }
    }
    return pools;
}

/**
 * Ensure a unit has a spellSlots map. Existing values win so hydration and
 * encounter restoration do not reset a pool to its original maximum.
 * @param {object} unit
 * @returns {Record<string,{current:number,max:number}>}
 */
export function ensureSpellSlots(unit) {
    if (!unit || typeof unit !== 'object') return {};
    if (!unit.spellSlots || typeof unit.spellSlots !== 'object' || Array.isArray(unit.spellSlots)) {
        unit.spellSlots = buildSpellSlots(unit.skills || []);
        return unit.spellSlots;
    }
    const parsed = buildSpellSlots(unit.skills || []);
    for (const [key, pool] of Object.entries(parsed)) {
        if (!unit.spellSlots[key] || typeof unit.spellSlots[key] !== 'object') {
            unit.spellSlots[key] = pool;
        } else {
            unit.spellSlots[key].max = Math.max(
                Number(unit.spellSlots[key].max) || 0,
                Number(pool.max) || 0,
            );
            unit.spellSlots[key].current = Math.min(
                Number(unit.spellSlots[key].current) || 0,
                Number(pool.current) || 0,
            );
        }
    }
    return unit.spellSlots;
}

/**
 * Merge pools from newly added skills (e.g. a standalone [SPELLS] block after
 * the character sheet has already been parsed). Does not overwrite a pool that
 * already exists.
 * @param {object} unit
 * @param {object[]} skills
 */
export function mergeSpellSlotsFromSkills(unit, skills) {
    if (!unit || !Array.isArray(skills)) return;
    const parsed = buildSpellSlots(skills);
    if (!unit.spellSlots || typeof unit.spellSlots !== 'object') unit.spellSlots = {};
    for (const [key, pool] of Object.entries(parsed)) {
        if (!unit.spellSlots[key]) unit.spellSlots[key] = { ...pool };
    }
}

/**
 * Display metadata for UI/payloads.
 * @param {object} source
 * @param {object} unit
 * @returns {{ current:number|null, max:number|null, unlimited:boolean, label:string, slotKey:string }}
 */
export function describeResource(source, unit) {
    const state = getResourceState(source, unit);
    return {
        ...state,
        label: state.unlimited ? '∞' : `${state.current}/${state.max}`,
    };
}

/**
 * Build the authoritative resource ledger for a state. This is intentionally
 * independent of the memo so the result payload and UI can show the same
 * numbers the board used.
 * @param {object} state
 * @returns {{ units: object[], generatedAt: number }}
 */
export function buildResourceLedger(state) {
    const units = [];
    for (const unit of state?.units || []) {
        if (!unit || unit.summoned) continue;
        ensureSpellSlots(unit);
        const spells = [];
        const abilities = [];
        for (const skill of unit.skills || []) {
            if (!skill || skill.passive) continue;
            const resource = describeResource(skill, unit);
            const entry = {
                id: skill.id,
                name: skill.name,
                kind: skill.kind,
                resource: skill.resource || 'hp',
                slotKey: resource.slotKey,
                slotLevel: Number(skill.slotLevel) || 0,
                current: resource.current,
                max: resource.max,
                unlimited: resource.unlimited,
                label: resource.label,
                usesText: resource.unlimited ? '∞' : `${resource.current}/${resource.max}`,
            };
            if (skill.slotKey || skill.spell === true) spells.push(entry);
            else abilities.push(entry);
        }
        const items = (unit.items || []).map(item => {
            const resource = describeResource(item, unit);
            return {
                id: item.id,
                name: item.name,
                kind: item.kind,
                current: resource.current,
                max: resource.max,
                unlimited: resource.unlimited,
                label: resource.label,
            };
        });
        units.push({
            id: unit.id,
            name: unit.name,
            side: unit.side,
            originalSide: unit.originalSide || unit.side,
            defeated: !!unit.defeated,
            fled: !!unit.fled,
            willpowerBroken: !!unit.willpowerBroken,
            spellSlots: Object.fromEntries(
                Object.entries(unit.spellSlots || {}).map(([key, pool]) => [key, {
                    current: Math.max(0, Number(pool?.current) || 0),
                    max: Math.max(0, Number(pool?.max) || 0),
                }]),
            ),
            spells,
            abilities,
            items,
        });
    }
    return { units, generatedAt: Date.now() };
}

/**
 * Compact one-line ledger for narration/result dialogs.
 * @param {object} ledger
 * @param {{ includeEnemies?: boolean }} [options]
 * @returns {string}
 */
export function formatResourceLedger(ledger, options = {}) {
    const lines = [];
    for (const unit of ledger?.units || []) {
        if (!options.includeEnemies && (unit.originalSide || unit.side) === 'enemy') continue;
        const parts = [];
        for (const [slotKey, pool] of Object.entries(unit.spellSlots || {})) {
            const level = String(slotKey).replace(/^spell-/, '');
            parts.push(`L${level} ${pool.current}/${pool.max}`);
        }
        for (const ability of unit.abilities || []) {
            if (ability.unlimited) continue;
            parts.push(`${ability.name} ${ability.label}`);
        }
        if (unit.items?.length) {
            for (const item of unit.items) {
                if (item.unlimited) continue;
                parts.push(`${item.name} ${item.label}`);
            }
        }
        if (parts.length) lines.push(`${unit.name}: ${parts.join(' · ')}`);
    }
    return lines.join('; ') || 'None tracked.';
}

/**
 * Update a level-pool text such as `(2/2)` or `(0/3)`.
 * @param {string} content
 * @param {Record<string,{current:number,max:number}>} spellSlots
 * @returns {string}
 */
export function patchSpellLevelLines(content, spellSlots) {
    return String(content || '').replace(
        /^(\s*(?:[-*+•]\s*)?(?:Spells:\s*)?Level\s+(\d+)\s*\()\s*(\d+)\s*\/\s*(\d+)\s*(\)\s*:?)/gim,
        (full, prefix, level, _current, max, suffix) => {
            const pool = spellSlots?.[`spell-${level}`];
            if (!pool) return full;
            const current = Math.max(0, Math.min(Number(pool.max) || Number(max) || 0, Number(pool.current) || 0));
            return `${prefix}${current}/${Math.max(Number(pool.max) || 0, Number(max) || 0)}${suffix}`;
        },
    );
}

/**
 * Replace the usage suffix in an ability description. The parser stores the
 * original description before appending `; current/max`, so update the final
 * `current/max` token rather than rebuilding the whole line.
 * @param {string} description
 * @param {number} current
 * @param {number} max
 * @returns {string}
 */
export function patchAbilityUsageText(description, current, max) {
    const source = String(description || '');
    const limit = Math.max(0, Number(max) || 0);
    const value = Math.max(0, Math.min(limit, Number(current) || 0));
    const usage = `${value}/${limit}`;
    const matches = [...source.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
    if (matches.length) {
        const last = matches[matches.length - 1];
        return `${source.slice(0, last.index)}${usage}${source.slice(last.index + last[0].length)}`;
    }
    return source ? `${source}; ${usage}` : usage;
}

/**
 * Update `Abilities: Name (desc; a/max), Other (...)` lines by skill name.
 * @param {string} line
 * @param {object[]} skills
 * @returns {string}
 */
export function patchAbilityLine(line, skills) {
    const text = String(line || '');
    const prefixMatch = text.match(/^(\s*Abilities:\s*)/i);
    if (!prefixMatch) return text;
    const byName = new Map((skills || [])
        .filter(skill => skill && !skill.slotKey)
        .map(skill => [String(skill.name || '').trim().toLowerCase(), skill]));
    const body = text.slice(prefixMatch[0].length);
    // Split on top-level commas. Ability descriptions can contain commas, so
    // only split when the next token looks like a new `Name (` entry.
    const parts = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < body.length; i += 1) {
        const char = body[i];
        if (char === '(') depth += 1;
        else if (char === ')') depth = Math.max(0, depth - 1);
        if (char === ',' && depth === 0) {
            const rest = body.slice(i + 1).trimStart();
            if (/^[^,()]{2,80}\s*\(/.test(rest)) {
                parts.push(current.trim());
                current = '';
                continue;
            }
        }
        current += char;
    }
    if (current.trim()) parts.push(current.trim());
    const updated = parts.map(part => {
        const match = part.match(/^(\s*)(.*?)\s*\(([\s\S]*)\)\s*$/);
        if (!match) return part;
        const skill = byName.get(match[2].trim().toLowerCase());
        if (!skill) return part;
        const resource = describeResource(skill, { skills: skills || [] });
        if (resource.unlimited || resource.max <= 0) return part;
        return `${match[1]}${match[2]} (${patchAbilityUsageText(match[3], resource.current, resource.max)})`;
    }).join(', ');
    return `${prefixMatch[1]}${updated}`;
}

/**
 * Update standalone [ABILITIES] bullet entries by skill name.
 * @param {string} content
 * @param {object[]} skills
 * @returns {string}
 */
export function patchStandaloneAbilities(content, skills) {
    const byName = new Map((skills || [])
        .filter(skill => skill && !skill.slotKey)
        .map(skill => [String(skill.name || '').trim().toLowerCase(), skill]));
    return String(content || '').split(/\r?\n/).map(rawLine => {
        const match = rawLine.match(/^(\s*(?:[-*+•]\s*)?)(.*?)\s*\(([\s\S]*)\)\s*$/);
        if (!match) return rawLine;
        const skill = byName.get(match[2].trim().toLowerCase());
        if (!skill) return rawLine;
        const resource = describeResource(skill, { skills: skills || [] });
        if (resource.unlimited || resource.max <= 0) return rawLine;
        return `${match[1]}${match[2]} (${patchAbilityUsageText(match[3], resource.current, resource.max)})`;
    }).join('\n');
}

/**
 * Update an inventory line quantity from the board's remaining item uses.
 * Returns '' when the item is exhausted so the caller can drop the line.
 * @param {string} line
 * @param {object[]} items
 * @returns {string}
 */
export function patchInventoryLine(line, items) {
    const source = String(line || '');
    if (!source.trim()) return source;
    const byName = new Map((items || []).map(item => [String(item.name || '').trim().toLowerCase(), item]));
    const cleaned = source.replace(/^\s*[-*+•]\s*/, '');
    const name = cleaned
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/\s+(?:x|×)\s*\d+.*$/i, '')
        .replace(/^[^A-Za-z0-9]+/, '')
        .split(',')[0]
        .trim()
        .toLowerCase();
    const item = byName.get(name);
    if (!item) return source;
    const resource = describeResource(item, { items: items || [] });
    if (resource.unlimited) return source;
    if (resource.current <= 0) return '';
    const quantity = Math.max(1, resource.current);
    if (/\b(?:x|×)\s*\d+\b/i.test(source)) {
        return source.replace(/\b(?:x|×)\s*\d+\b/i, `x${quantity}`);
    }
    // A single copy with no explicit quantity: keep the line unless the item
    // had multiple copies originally.
    if (Number(item.maxUses) > 1) {
        return `${source} x${quantity}`;
    }
    return source;
}
