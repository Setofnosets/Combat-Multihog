/**
 * tactical-combat-engine.js — pure, framework-free tactical combat model.
 *
 * No DOM, no SillyTavern imports. Everything here is testable in Node:
 * grid generation, placement, movement, line of sight, attacks, skills, items,
 * initiative/phase turn flow, agent action interpretation, and outcomes.
 *
 * The board UI and the combat agent both treat this module as the authority.
 */

import {
    DEFAULT_TACTICAL_ACTION_CATALOG,
    TC_DEFAULT_MOVEMENT,
    TC_DEFAULT_TERRAIN_DENSITY,
    TC_MAX_DIMENSION,
    TC_MAX_LOG_ENTRIES,
    TC_MIN_DIMENSION,
    TC_SIDE_COLORS,
    TC_STATE_FORMAT,
    TC_TERRAIN,
    TC_TERRAIN_CHARS,
    TC_TERRAIN_CHAR_BY_ID,
    TC_TERRAIN_KEYS,
    TC_TERRAIN_THEME_CONFIG,
    TC_UNIT_COLORS,
    TC_VERSION,
    clampInt,
    clampIntOr,
    terrainChar,
} from './tactical-combat-constants.js';
import { describeActionCatalog, isActionEnabled, getEnabledActions } from './tactical-combat-actions.js';
import {
    deriveMaxWillpower,
    isWillpowerImmune,
    normalizeStatusBehavior,
    normalizeWillpowerOutcome,
    normalizeWillpowerResource,
    willpowerOutcomeLabel,
} from './tactical-combat-willpower.js';

// ── RNG & dice ───────────────────────────────────────────────────────────────

/**
 * Deterministic 32-bit RNG. The state stores a seed and an incrementing roll
 * counter so a reloaded encounter produces the same sequence for the same rolls.
 * @param {number} seed
 * @returns {() => number}
 */
export function makeRng(seed) {
    let a = (Number(seed) || 1) >>> 0;
    return function next() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * @param {number} seed
 * @returns {number}
 */
export function normalizeSeed(seed) {
    const n = Number(seed);
    if (Number.isFinite(n) && n !== 0) return Math.abs(Math.trunc(n)) >>> 0;
    return 1;
}

/**
 * RNG bound to a persistent encounter state. Every roll advances rollCount so
 * the sequence survives saving/reloading.
 * @param {object} state
 * @returns {() => number}
 */
export function createStateRng(state) {
    return function next() {
        state.rollCount = (Number(state.rollCount) || 0) + 1;
        const mixed = (normalizeSeed(state.seed) ^ Math.imul(state.rollCount + 1, 0x9e3779b1)) >>> 0;
        return makeRng(mixed)();
    };
}

/**
 * Roll XdY+Z (also accepts `d20`, plain numbers, and whitespace).
 * Invalid expressions return 0 rather than throwing.
 * @param {string|number} expression
 * @param {(() => number)|null} [rng]
 * @returns {{ total: number, rolls: number[], modifier: number, expression: string }}
 */
export function rollDice(expression, rng = Math.random) {
    const source = String(expression ?? '').trim().toLowerCase();
    if (!source) return { total: 0, rolls: [], modifier: 0, expression: source };
    if (/^[+-]?\d+(?:\.\d+)?$/.test(source)) {
        const flat = Math.trunc(Number(source));
        return { total: flat, rolls: [], modifier: flat, expression: source };
    }
    const match = source.match(/^(\d*)d(\d+)([+-]\d+)?$/);
    if (!match) {
        // Accept "2d6 + 3" and "1d8-1".
        const loose = source.replace(/\s+/g, '').match(/^(\d*)d(\d+)([+-]\d+)?$/);
        if (!loose) return { total: 0, rolls: [], modifier: 0, expression: source };
        return rollDice(loose[0], rng);
    }
    const count = Math.max(1, Math.min(20, parseInt(match[1] || '1', 10) || 1));
    const sides = Math.max(2, Math.min(1000, parseInt(match[2], 10) || 6));
    const modifier = parseInt(match[3] || '0', 10) || 0;
    const rolls = [];
    for (let i = 0; i < count; i += 1) rolls.push(1 + Math.floor(rng() * sides));
    return { total: rolls.reduce((sum, roll) => sum + roll, 0) + modifier, rolls, modifier, expression: source };
}

/**
 * @param {number} count
 * @param {number} sides
 * @param {(() => number)|null} rng
 * @returns {number}
 */
export function rollDie(sides, rng = Math.random) {
    return 1 + Math.floor(rng() * Math.max(2, Math.min(1000, Number(sides) || 20)));
}

// ── Grid helpers ─────────────────────────────────────────────────────────────

export function cellKey(x, y) {
    return `${x},${y}`;
}

export function inBounds(state, x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return false;
    // Theater combat (the traditional turn-based mode) has no grid. Units all
    // live at an abstract (0,0) position, so coordinates are always "in bounds"
    // for the shared attack/status/special-effect paths.
    if (!state?.grid) return true;
    return x < state.grid.cols && y < state.grid.rows;
}

export function getTerrain(state, x, y) {
    if (!inBounds(state, x, y)) return TC_TERRAIN.wall;
    const id = state.terrain?.[y]?.[x];
    return TC_TERRAIN[id] || TC_TERRAIN.floor;
}

export function isWalkableTerrain(state, x, y) {
    return getTerrain(state, x, y).walkable !== false;
}

export function movementCost(state, x, y) {
    const terrain = getTerrain(state, x, y);
    return Math.max(1, Number(terrain.moveCost) || 1);
}

export function chebyshev(a, b) {
    return Math.max(Math.abs(Number(a.x) - Number(b.x)), Math.abs(Number(a.y) - Number(b.y)));
}

export function manhattan(a, b) {
    return Math.abs(Number(a.x) - Number(b.x)) + Math.abs(Number(a.y) - Number(b.y));
}

/**
 * @param {object} state
 * @param {object} unit
 * @param {{ includeSelf?: boolean }} [options]
 * @returns {Map<string, number>}
 */
export function computeReachableCells(state, unit, options = {}) {
    const result = new Map();
    if (!unit || unit.defeated || unit.fled) return result;
    const budget = Math.max(0, (Number(unit.speed) || TC_DEFAULT_MOVEMENT) - (Number(unit.movementUsed) || 0));
    if (budget <= 0) return result;

    /** @type {Map<string, number>} */
    const costs = new Map([[cellKey(unit.x, unit.y), 0]]);
    const queue = [{ x: unit.x, y: unit.y, cost: 0 }];
    const blocked = new Set(
        state.units
            .filter(other => other !== unit && !other.defeated && !other.fled)
            .map(other => cellKey(other.x, other.y)),
    );

    while (queue.length) {
        queue.sort((a, b) => a.cost - b.cost);
        const current = queue.shift();
        if (!current || current.cost > budget) continue;
        if (costs.get(cellKey(current.x, current.y)) < current.cost) continue;
        if (current.x !== unit.x || current.y !== unit.y) result.set(cellKey(current.x, current.y), current.cost);

        for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
                if (!dx && !dy) continue;
                const nx = current.x + dx;
                const ny = current.y + dy;
                if (!inBounds(state, nx, ny)) continue;
                if (!isWalkableTerrain(state, nx, ny)) continue;
                const key = cellKey(nx, ny);
                if (blocked.has(key)) continue;
                const nextCost = current.cost + movementCost(state, nx, ny);
                if (nextCost > budget) continue;
                if (costs.has(key) && costs.get(key) <= nextCost) continue;
                costs.set(key, nextCost);
                // Track the cheapest way to stand on this cell.
                if (nextCost > 0) result.set(key, nextCost);
                queue.push({ x: nx, y: ny, cost: nextCost });
            }
        }
    }

    if (options.includeSelf) result.set(cellKey(unit.x, unit.y), 0);
    return result;
}

/**
 * Shortest legal path using terrain costs. Returns cells excluding the start,
 * or null when the destination is unreachable.
 * @param {object} state
 * @param {object} unit
 * @param {{x:number,y:number}} target
 * @returns {{x:number,y:number}[]|null}
 */
export function findPath(state, unit, target) {
    if (!unit || !inBounds(state, target?.x, target?.y)) return null;
    if (unit.x === target.x && unit.y === target.y) return [];
    if (!isWalkableTerrain(state, target.x, target.y)) return null;
    const occupied = new Set(
        state.units
            .filter(other => other !== unit && !other.defeated && !other.fled)
            .map(other => cellKey(other.x, other.y)),
    );
    if (occupied.has(cellKey(target.x, target.y))) return null;

    /** @type {Map<string, {cost:number, prev:string|null, x:number, y:number}>} */
    const best = new Map([[cellKey(unit.x, unit.y), { cost: 0, prev: null, x: unit.x, y: unit.y }]]);
    /** @type {{x:number,y:number,cost:number}[]} */
    const queue = [{ x: unit.x, y: unit.y, cost: 0 }];
    while (queue.length) {
        queue.sort((a, b) => a.cost - b.cost);
        const current = queue.shift();
        if (!current) continue;
        const currentKey = cellKey(current.x, current.y);
        if (best.get(currentKey)?.cost < current.cost) continue;
        if (current.x === target.x && current.y === target.y) break;
        for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
                if (!dx && !dy) continue;
                const nx = current.x + dx;
                const ny = current.y + dy;
                if (!inBounds(state, nx, ny) || !isWalkableTerrain(state, nx, ny)) continue;
                const key = cellKey(nx, ny);
                if (occupied.has(key) && key !== cellKey(target.x, target.y)) continue;
                const nextCost = current.cost + movementCost(state, nx, ny);
                if (best.has(key) && best.get(key).cost <= nextCost) continue;
                best.set(key, { cost: nextCost, prev: currentKey, x: nx, y: ny });
                queue.push({ x: nx, y: ny, cost: nextCost });
            }
        }
    }

    const destination = best.get(cellKey(target.x, target.y));
    if (!destination) return null;
    const path = [];
    let key = cellKey(target.x, target.y);
    while (key && key !== cellKey(unit.x, unit.y)) {
        const node = best.get(key);
        if (!node) return null;
        path.push({ x: node.x, y: node.y });
        key = node.prev;
    }
    path.reverse();
    return path;
}

export function pathCost(state, path) {
    return (path || []).reduce((sum, cell) => sum + movementCost(state, cell.x, cell.y), 0);
}

/**
 * Bresenham line of sight. Walls and out-of-bounds cells block sight.
 * @returns {boolean}
 */
export function hasLineOfSight(state, from, to) {
    let x0 = Number(from.x);
    let y0 = Number(from.y);
    const x1 = Number(to.x);
    const y1 = Number(to.y);
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let error = dx - dy;
    let guard = 0;
    while (guard++ < 500) {
        if (x0 === x1 && y0 === y1) return true;
        const e2 = error * 2;
        if (e2 > -dy) { error -= dy; x0 += sx; }
        if (e2 < dx) { error += dx; y0 += sy; }
        if (x0 === x1 && y0 === y1) return true;
        if (!inBounds(state, x0, y0)) return false;
        if (getTerrain(state, x0, y0).blocksLos) return false;
    }
    return false;
}

// ── Terrain generation ───────────────────────────────────────────────────────

function weightedTerrainPick(pools, rng) {
    const entries = Object.entries(pools || {}).filter(([, weight]) => Number(weight) > 0);
    if (!entries.length) return 'floor';
    const total = entries.reduce((sum, [, weight]) => sum + Number(weight), 0);
    let roll = rng() * total;
    for (const [id, weight] of entries) {
        roll -= Number(weight);
        if (roll <= 0) return id;
    }
    return entries[entries.length - 1][0];
}

/**
 * Procedural, deterministic terrain with a clear player/enemy deployment strip.
 * @param {{ rows?: number, cols?: number, theme?: string, density?: number, seed?: number }} options
 * @returns {{ rows: number, cols: number, terrain: string[][], theme: string }}
 */
export function createProceduralTerrain(options = {}) {
    const rows = clampIntOr(options.rows, 15, TC_MIN_DIMENSION, TC_MAX_DIMENSION);
    const cols = clampIntOr(options.cols, 15, TC_MIN_DIMENSION, TC_MAX_DIMENSION);
    const themeId = TC_TERRAIN_THEME_CONFIG[options.theme] ? options.theme : 'dungeon';
    const theme = TC_TERRAIN_THEME_CONFIG[themeId];
    const density = clampIntOr(options.density, TC_DEFAULT_TERRAIN_DENSITY, 0, 100);
    const rng = makeRng(options.seed || 1);

    /** @type {string[][]} */
    const terrain = Array.from({ length: rows }, () => Array.from({ length: cols }, () => theme.base));
    const area = rows * cols;
    const clusterCount = Math.max(0, Math.round((area * density) / 100 / 4.5));

    const protectedCell = (x, y) => {
        // Keep deployment strips and a central lane usable.
        const left = x <= 1;
        const right = x >= cols - 2;
        const lane = Math.abs(y - Math.floor(rows / 2)) <= 1;
        return (left || right) && (lane || x === 0 || x === cols - 1);
    };

    const paintCluster = (startX, startY, terrainId, size) => {
        let x = startX;
        let y = startY;
        for (let i = 0; i < size; i += 1) {
            if (inBounds({ grid: { rows, cols } }, x, y) && !protectedCell(x, y)) {
                terrain[y][x] = terrainId;
            }
            const dir = Math.floor(rng() * 4);
            if (dir === 0) x += 1;
            else if (dir === 1) x -= 1;
            else if (dir === 2) y += 1;
            else y -= 1;
        }
    };

    for (let i = 0; i < clusterCount; i += 1) {
        const id = weightedTerrainPick(theme.pools, rng);
        const size = 1 + Math.floor(rng() * 4);
        paintCluster(
            1 + Math.floor(rng() * Math.max(1, cols - 2)),
            1 + Math.floor(rng() * Math.max(1, rows - 2)),
            id,
            size,
        );
    }

    // A handful of deliberate tactical features makes the board readable.
    const featureCount = density <= 0 ? 0 : density >= 55 ? 3 : density >= 25 ? 2 : 1;
    for (let i = 0; i < featureCount; i += 1) {
        const fx = 3 + Math.floor(rng() * Math.max(1, cols - 6));
        const fy = 2 + Math.floor(rng() * Math.max(1, rows - 4));
        const featureId = i === 0 ? 'cover' : i === 1 ? 'high' : 'hazard';
        if (!protectedCell(fx, fy)) terrain[fy][fx] = featureId;
    }
    if (rows >= 8 && cols >= 8) {
        terrain[Math.floor(rows / 2)][Math.floor(cols / 2)] = 'objective';
    }

    // Guarantee the deployment strips are walkable.
    for (let y = 0; y < rows; y += 1) {
        for (const x of [0, 1, cols - 2, cols - 1]) {
            if (x >= 0 && x < cols && !TC_TERRAIN[terrain[y][x]]?.walkable) terrain[y][x] = theme.base;
        }
    }

    return { rows, cols, terrain, theme: themeId };
}

/**
 * Decode agent-authored terrain rows. Returns null if dimensions or content are
 * invalid so the caller can fall back to procedural terrain.
 * @param {string[]|string[][]|null|undefined} rows
 * @param {number} expectedRows
 * @param {number} expectedCols
 * @returns {{ terrain: string[][], errors: string[] }|null}
 */
export function decodeTerrainRows(rows, expectedRows, expectedCols) {
    if (!Array.isArray(rows) || rows.length !== expectedRows) return null;
    /** @type {string[][]} */
    const terrain = [];
    for (const row of rows) {
        const chars = Array.isArray(row) ? row : String(row || '').split('');
        if (chars.length !== expectedCols) return null;
        const decoded = chars.map(char => {
            const id = TC_TERRAIN_CHARS[char] || (TC_TERRAIN[char] ? char : null);
            return id && TC_TERRAIN[id] ? id : 'floor';
        });
        terrain.push(decoded);
    }
    return { terrain, errors: [] };
}

// ── Units ────────────────────────────────────────────────────────────────────

function slug(value, fallback = 'unit') {
    const out = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return out || fallback;
}

/** Two-letter token mark: "Goblin Archer" -> GA, "Sera the Guide" -> SG. */
function makeUnitGlyph(name) {
    const stopWords = new Set(['the', 'of', 'a', 'an', 'and', 'de', 'von', 'van', 'el', 'la', 'le', 'da', 'di']);
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    const meaningful = words.filter(word => !stopWords.has(word.toLowerCase()));
    if (meaningful.length >= 2) {
        return `${meaningful[0][0] || ''}${meaningful[1][0] || ''}`.toUpperCase();
    }
    if (words.length >= 2) {
        return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
    }
    return String(name || '??').slice(0, 2).toUpperCase();
}

function normalizeStatus(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const rounds = clampInt(raw.rounds, 1, 99) || 1;
    const maxStacks = clampInt(raw.maxStacks ?? 1, 1, 10) || 1;
    return {
        id: String(raw.id || raw.name || 'status').slice(0, 40),
        label: String(raw.label || raw.name || raw.id || 'Status').slice(0, 60),
        rounds,
        acBonus: Number(raw.acBonus) || 0,
        attackBonus: Number(raw.attackBonus) || 0,
        damage: String(raw.damage || '').trim(),
        damageResource: normalizeWillpowerResource(raw.damageResource || raw.resource, 'hp'),
        willpowerOutcome: normalizeWillpowerOutcome(raw.willpowerOutcome ?? raw.willOutcome, 'defeat'),
        behavior: normalizeStatusBehavior(raw.behavior),
        sourceId: String(raw.sourceId || raw.casterId || '').slice(0, 60),
        stacks: clampInt(raw.stacks ?? 1, 1, maxStacks) || 1,
        maxStacks,
        description: String(raw.description || '').slice(0, 300),
    };
}

function normalizeSkill(raw, index, side) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || raw.label || `Skill ${index + 1}`).trim().slice(0, 80);
    const kindRaw = String(raw.kind || raw.type || 'attack').toLowerCase();
    const kind = ['attack', 'heal', 'buff', 'special'].includes(kindRaw) ? kindRaw : 'attack';
    const maxUses = clampInt(raw.maxUses ?? raw.uses ?? 1, 0, 99);
    const range = kind === 'buff' ? clampInt(raw.range, 0, 24)
        : kind === 'special' ? (raw.range == null ? 6 : clampInt(raw.range, 1, 24))
            : clampInt(raw.range, 1, 24) || 1;
    const resource = normalizeWillpowerResource(raw.resource ?? raw.targetResource ?? raw.stat, 'hp');
    return {
        id: String(raw.id || `skill-${slug(name, `skill-${index + 1}`)}`).slice(0, 60),
        name,
        description: String(raw.description || raw.effect || '').slice(0, 500),
        kind,
        resource,
        target: String(raw.target || (kind === 'attack' ? 'enemy' : kind === 'special' ? 'any' : 'ally')).toLowerCase(),
        range,
        damage: String(raw.damage || (kind === 'attack' ? '1d8' : '')).trim().slice(0, 40),
        willpowerDamage: String(raw.willpowerDamage ?? raw.willDamage ?? '').trim().slice(0, 40),
        willpowerOutcome: normalizeWillpowerOutcome(raw.willpowerOutcome ?? raw.willOutcome, 'defeat'),
        heal: String(raw.heal || (kind === 'heal' ? '1d8+2' : '')).trim().slice(0, 40),
        acBonus: Number(raw.acBonus) || 0,
        attackBonus: Number(raw.attackBonus) || 0,
        bonusAction: !!raw.bonusAction,
        rounds: clampInt(raw.rounds, 1, 10) || 2,
        maxUses,
        uses: raw.uses == null ? maxUses : clampInt(raw.uses, 0, maxUses),
        effectTemplate: Array.isArray(raw.effectTemplate)
            ? raw.effectTemplate.filter(entry => entry && typeof entry === 'object').slice(0, 6)
            : null,
        side,
    };
}

function normalizeItem(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || `Item ${index + 1}`).trim().slice(0, 80);
    const maxUses = clampInt(raw.maxUses ?? raw.uses ?? 1, 0, 99);
    const rawTarget = String(raw.target || 'ally').toLowerCase();
    return {
        id: String(raw.id || `item-${slug(name, `item-${index + 1}`)}`).slice(0, 60),
        name,
        description: String(raw.description || '').slice(0, 300),
        kind: ['heal', 'buff', 'special'].includes(String(raw.kind || '').toLowerCase())
            ? String(raw.kind).toLowerCase()
            : 'heal',
        resource: normalizeWillpowerResource(raw.resource ?? raw.stat, 'hp'),
        target: ['ally', 'enemy', 'any'].includes(rawTarget) ? rawTarget : 'ally',
        amount: String(raw.amount || raw.heal || ((raw.kind || 'heal') === 'heal' ? '2d4+2' : '')).slice(0, 40),
        maxUses,
        uses: raw.uses == null ? maxUses : clampInt(raw.uses, 0, maxUses),
        range: raw.range == null ? 0 : clampInt(raw.range, 0, 12),
    };
}

/**
 * Normalize a unit seed (from the memo parser, encounter agent, or tests).
 * @param {object} seed
 * @param {{ index: number, side: string, idPrefix?: string }} meta
 * @returns {object}
 */
export function normalizeUnitSeed(seed, meta) {
    const side = ['player', 'enemy', 'ally'].includes(seed?.side) ? seed.side : meta.side;
    const index = meta.index;
    const name = String(seed?.name || `Combatant ${index + 1}`).trim().slice(0, 80);
    const maxHp = clampIntOr(seed?.maxHp ?? seed?.hp, 12, 1, 999);
    const hp = Math.max(1, clampIntOr(seed?.hp, maxHp, 0, maxHp));
    const dexMod = Number(seed?.stats?.dexMod);
    const statMod = Number.isFinite(dexMod) ? dexMod : 0;
    const initiativeBonus = Number.isFinite(Number(seed?.initiativeBonus))
        ? clampInt(seed.initiativeBonus, -10, 20)
        : clampInt(statMod, -10, 20);
    const attackBonus = Number.isFinite(Number(seed?.attackBonus))
        ? clampInt(seed.attackBonus, -10, 30)
        : 3;
    const attackRange = clampInt(seed?.attackRange, 1, 24) || 1;
    const speed = clampIntOr(seed?.speed, clampIntOr(meta?.defaultSpeed, TC_DEFAULT_MOVEMENT, 1, 30), 1, 30);
    const skills = (Array.isArray(seed?.skills) ? seed.skills : [])
        .map((skill, skillIndex) => normalizeSkill(skill, skillIndex, side))
        .filter(Boolean);
    const items = (Array.isArray(seed?.items) ? seed.items : [])
        .map((item, itemIndex) => normalizeItem(item, itemIndex))
        .filter(Boolean);
    const prefix = meta.idPrefix || (side === 'player' ? 'pc' : side === 'ally' ? 'ally' : 'enemy');
    const stats = {
        str: clampIntOr(seed?.stats?.str, 10, 1, 30),
        dex: clampIntOr(seed?.stats?.dex, 10, 1, 30),
        con: clampIntOr(seed?.stats?.con, 10, 1, 30),
        int: clampIntOr(seed?.stats?.int, 10, 1, 30),
        wis: clampIntOr(seed?.stats?.wis, 10, 1, 30),
        cha: clampIntOr(seed?.stats?.cha, 10, 1, 30),
        dexMod: Number.isFinite(dexMod) ? clampInt(dexMod, -10, 20) : Math.floor((clampIntOr(seed?.stats?.dex, 10, 1, 30) - 10) / 2),
    };
    for (const key of ['str', 'con', 'int', 'wis', 'cha']) {
        const explicit = Number(seed?.stats?.[`${key}Mod`]);
        stats[`${key}Mod`] = Number.isFinite(explicit)
            ? clampInt(explicit, -10, 20)
            : Math.floor((stats[key] - 10) / 2);
    }
    const willSave = Number.isFinite(Number(seed?.willpowerSave ?? seed?.willSave ?? seed?.stats?.willSave))
        ? clampInt(seed.willpowerSave ?? seed.willSave ?? seed.stats.willSave, -10, 30)
        : 0;
    const hasExplicitMaxWillpower = seed?.maxWillpower != null || seed?.maxWill != null;
    const explicitMaxWillpower = Number(seed?.maxWillpower ?? seed?.maxWill);
    const maxWillpower = hasExplicitMaxWillpower && Number.isFinite(explicitMaxWillpower)
        ? clampInt(explicitMaxWillpower, 0, 99)
        : deriveMaxWillpower(maxHp, stats.wisMod, willSave, meta?.willpowerMaxPercent);
    const explicitWillpower = Number(seed?.willpower ?? seed?.will);
    const willpower = Number.isFinite(explicitWillpower)
        ? clampInt(explicitWillpower, 0, maxWillpower)
        : maxWillpower;
    const attackResource = normalizeWillpowerResource(seed?.attackResource, 'hp');

    return {
        id: String(seed?.id || `${prefix}-${index + 1}`).slice(0, 60),
        name,
        classLabel: String(seed?.classLabel || seed?.className || '').slice(0, 80),
        side,
        originalSide: side,
        sideChanged: false,
        x: 0,
        y: 0,
        hp,
        maxHp,
        willpower,
        maxWillpower,
        willpowerSave: willSave,
        willpowerImmune: maxWillpower === 0,
        willpowerBroken: false,
        willpowerOutcome: '',
        willpowerBreakSource: '',
        willpowerBreakAt: 0,
        defeatCause: '',
        incapacitated: false,
        surrendered: false,
        transform: null,
        ac: clampIntOr(seed?.ac, 12, 1, 40),
        attackBonus,
        attackRange,
        damage: String(seed?.damage || '1d6').slice(0, 40),
        damageType: String(seed?.damageType || '').slice(0, 20),
        attackResource,
        willpowerDamage: String(seed?.willpowerDamage ?? seed?.willDamage ?? '').trim().slice(0, 40),
        attackWillpowerOutcome: normalizeWillpowerOutcome(seed?.attackWillpowerOutcome ?? seed?.willOutcome, 'defeat'),
        initiativeBonus,
        initiative: 0,
        speed,
        movementUsed: 0,
        actionUsed: false,
        bonusUsed: false,
        reactionUsed: false,
        doneForRound: false,
        defending: false,
        surprised: false,
        defeated: false,
        fled: false,
        statuses: [],
        skills,
        items,
        inventory: (Array.isArray(seed?.inventory) ? seed.inventory : [])
            .filter(entry => entry && typeof entry === 'object')
            .slice(0, 30)
            .map(entry => ({
                name: String(entry.name || '').slice(0, 80),
                description: String(entry.description || '').slice(0, 300),
                section: String(entry.section || '').slice(0, 20),
                equipped: !!entry.equipped,
                rarity: String(entry.rarity || '').slice(0, 20),
                quantity: clampIntOr(entry.quantity, 1, 1, 99),
            }))
            .filter(entry => entry.name),
        stats,
        level: clampInt(seed?.level, 1, 30) || 1,
        notes: String(seed?.notes || '').slice(0, 500),
        color: String(seed?.color || TC_SIDE_COLORS[side] || TC_SIDE_COLORS.enemy),
        glyph: String(seed?.glyph || makeUnitGlyph(name)).slice(0, 3),
        source: seed?.source || '',
    };
}

/**
 * Find a free walkable cell near an anchor. Used for deployment and tests.
 * @param {object} state
 * @param {number} anchorX
 * @param {number} anchorY
 * @param {Set<string>} occupied
 * @returns {{x:number,y:number}|null}
 */
export function findFreeCell(state, anchorX, anchorY, occupied = new Set()) {
    const startX = clampInt(anchorX, 0, state.grid.cols - 1);
    const startY = clampInt(anchorY, 0, state.grid.rows - 1);
    if (!occupied.has(cellKey(startX, startY)) && isWalkableTerrain(state, startX, startY)) {
        return { x: startX, y: startY };
    }
    const maxRadius = Math.max(state.grid.rows, state.grid.cols);
    for (let radius = 1; radius <= maxRadius; radius += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
            for (let dx = -radius; dx <= radius; dx += 1) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                const x = startX + dx;
                const y = startY + dy;
                if (!inBounds(state, x, y)) continue;
                if (!isWalkableTerrain(state, x, y)) continue;
                const key = cellKey(x, y);
                if (occupied.has(key)) continue;
                return { x, y };
            }
        }
    }
    return null;
}

/**
 * Deploy players/allies on the left and enemies on the right.
 * @param {object} state
 * @param {object[]} units
 * @param {() => number} rng
 */
export function placeUnits(state, units, rng = Math.random) {
    const occupied = new Set();
    const groups = [
        units.filter(unit => unit.side === 'player'),
        units.filter(unit => unit.side === 'ally'),
        units.filter(unit => unit.side === 'enemy'),
    ];
    const placeGroup = (group, xCandidates) => {
        const center = Math.floor(state.grid.rows / 2);
        group.forEach((unit, index) => {
            const spread = Math.ceil(group.length / 2);
            const offset = index % 2 === 0 ? Math.ceil(index / 2) : -Math.ceil(index / 2);
            const preferredY = center + (index % 2 === 0 ? Math.ceil(index / 2) : -Math.ceil(index / 2));
            let placed = null;
            for (const x of xCandidates) {
                placed = findFreeCell(state, x, preferredY, occupied);
                if (placed) break;
            }
            if (!placed) {
                // Last-resort scan: any free walkable cell.
                for (let y = 0; y < state.grid.rows && !placed; y += 1) {
                    for (let x = 0; x < state.grid.cols && !placed; x += 1) {
                        if (isWalkableTerrain(state, x, y) && !occupied.has(cellKey(x, y))) placed = { x, y };
                    }
                }
            }
            if (!placed) {
                // Extremely small/full grids: mark the unit as fled rather than overlap.
                unit.x = 0;
                unit.y = 0;
                unit.fled = true;
                return;
            }
            unit.x = placed.x;
            unit.y = placed.y;
            occupied.add(cellKey(placed.x, placed.y));
            void spread;
            void offset;
            void rng;
        });
    };

    placeGroup(groups[0], [1, 0, 2]);
    placeGroup(groups[1], [2, 1, 0]);
    placeGroup(groups[2], [state.grid.cols - 2, state.grid.cols - 1, state.grid.cols - 3]);
}

// ── Deployment phase ─────────────────────────────────────────────────────────

/**
 * Start a pre-battle deployment phase. Player units may be repositioned inside
 * the left deployment lane before the first normal turn.
 * @param {object} state
 * @param {{ columns?: number }} [options]
 * @returns {boolean}
 */
export function beginDeployment(state, options = {}) {
    if (!state || state.status !== 'active') return false;
    const players = state.units.filter(unit => unit.side === 'player' && !unit.defeated && !unit.fled);
    if (!players.length) return false;
    const configured = Number(options.columns);
    const columns = Number.isFinite(configured)
        ? clampInt(configured, 1, state.grid.cols - 1)
        : Math.max(2, Math.min(6, Math.ceil(state.grid.cols * 0.25)));
    state.deployment = {
        active: true,
        maxX: columns - 1,
        columns,
        startedAt: Date.now(),
    };
    state.phase = 'player';
    state.pendingAgentUnitIds = [];
    state.turnIndex = 0;
    addLog(state, 'deployment', `Deployment: place player units within the left ${columns} column${columns === 1 ? '' : 's'}.`, null);
    return true;
}

/**
 * @param {object} state
 * @returns {{ x: number, y: number }[]}
 */
export function getDeploymentCells(state) {
    const cells = [];
    if (!state?.deployment?.active) return cells;
    const maxX = clampInt(state.deployment.maxX, 0, state.grid.cols - 1);
    for (let y = 0; y < state.grid.rows; y += 1) {
        for (let x = 0; x <= maxX; x += 1) {
            if (isWalkableTerrain(state, x, y)) cells.push({ x, y });
        }
    }
    return cells;
}

/**
 * Move one player unit to a deployment cell.
 * @param {object} state
 * @param {string} unitId
 * @param {number} x
 * @param {number} y
 * @returns {{ ok: boolean, error?: string }}
 */
export function deployUnit(state, unitId, x, y) {
    if (!state || state.status !== 'active') return { ok: false, error: 'The encounter is over.' };
    if (!state.deployment?.active) return { ok: false, error: 'Deployment is not active.' };
    const unit = getUnitById(state, unitId);
    if (!unit || unit.side !== 'player') return { ok: false, error: 'Only player units can be deployed.' };
    if (unit.defeated || unit.fled) return { ok: false, error: `${unit.name} cannot deploy.` };
    if (!inBounds(state, x, y)) return { ok: false, error: 'That cell is outside the grid.' };
    if (x > Number(state.deployment.maxX)) return { ok: false, error: 'That cell is outside the deployment lane.' };
    if (!isWalkableTerrain(state, x, y)) return { ok: false, error: 'That cell is impassable terrain.' };
    const occupant = state.units.find(other => other.id !== unit.id && !other.defeated && !other.fled && other.x === x && other.y === y);
    if (occupant) return { ok: false, error: `${occupant.name} is standing there.` };
    const from = { x: unit.x, y: unit.y };
    unit.x = x;
    unit.y = y;
    addLog(state, 'deployment', `${unit.name} deploys from (${from.x},${from.y}) to (${x},${y}).`, unit.id);
    return { ok: true };
}

/**
 * End deployment and hand the first turn to the normal turn-order logic.
 * @param {object} state
 * @returns {boolean}
 */
export function finishDeployment(state) {
    if (!state?.deployment?.active) return false;
    state.deployment.active = false;
    state.deployment.finishedAt = Date.now();
    if (state.turnStyle === 'initiative') {
        state.turnIndex = 0;
        state.pendingAgentUnitIds = [];
        advanceTurnPointerToLiving(state);
        const active = getActiveUnit(state);
        state.phase = active && active.side !== 'player' ? 'enemy' : 'player';
        state.pendingAgentUnitIds = state.phase === 'enemy' ? collectConsecutiveAgentUnits(state) : [];
    } else {
        state.phase = 'player';
        state.pendingAgentUnitIds = [];
    }
    addLog(state, 'deployment', 'Deployment complete. Battle begins.', null);
    return true;
}

// ── Initiative & turn flow ───────────────────────────────────────────────────

export function getUnitById(state, unitId) {
    return state.units.find(unit => unit.id === unitId) || null;
}

export function livingUnits(state, side = null) {
    return state.units.filter(unit => !unit.defeated && !unit.fled && (side == null || unit.side === side));
}

export function getActiveUnit(state) {
    if (state.turnStyle === 'phase') return null;
    const id = state.initiativeOrder?.[state.turnIndex];
    return id ? getUnitById(state, id) : null;
}

export function getPlayerControlledUnits(state) {
    return livingUnits(state, 'player');
}

export function getAgentControlledUnits(state) {
    return state.units.filter(unit => unit.side === 'enemy' || unit.side === 'ally').filter(unit => !unit.defeated && !unit.fled);
}

export function rollInitiative(state, rng = Math.random) {
    for (const unit of state.units) {
        unit.initiative = rollDie(20, rng) + (Number(unit.initiativeBonus) || 0);
    }
    const sideOrder = { player: 0, ally: 1, enemy: 2 };
    state.initiativeOrder = [...state.units]
        .filter(unit => !unit.defeated)
        .sort((a, b) => (b.initiative - a.initiative)
            || ((sideOrder[a.side] ?? 9) - (sideOrder[b.side] ?? 9))
            || a.name.localeCompare(b.name))
        .map(unit => unit.id);
    return state.initiativeOrder;
}

/**
 * @param {object} unit
 * @param {object} state
 * @param {() => number} rng
 * @param {{ initial?: boolean }} [options]
 */
export function resetUnitForTurn(unit, state, rng, options = {}) {
    unit.movementUsed = 0;
    unit.actionUsed = false;
    unit.bonusUsed = false;
    unit.reactionUsed = false;
    unit.doneForRound = false;
    unit.defending = false;
    if (!options.initial) {
        tickStatuses(unit, state, rng);
    }
}

function tickStatuses(unit, state, rng) {
    if (!Array.isArray(unit.statuses) || !unit.statuses.length) return;
    const remaining = [];
    for (const status of unit.statuses) {
        if (status.damage) {
            const stacks = Math.max(1, Number(status.stacks) || 1);
            const damage = rollDice(status.damage, rng).total * stacks;
            if (damage > 0) {
                if (status.damageResource === 'willpower') {
                    applyWillpowerDamageToUnit(state, unit, damage, status.label, {
                        outcome: status.willpowerOutcome,
                    });
                } else if (status.damageResource === 'both') {
                    applyDamageToUnit(state, unit, damage, `${status.label}`);
                    if (!unit.defeated) {
                        applyWillpowerDamageToUnit(state, unit, damage, status.label, {
                            outcome: status.willpowerOutcome,
                        });
                    }
                } else {
                    applyDamageToUnit(state, unit, damage, `${status.label}`);
                }
            }
        }
        status.rounds = Math.max(0, Number(status.rounds || 0) - 1);
        if (status.rounds > 0 && !unit.defeated) remaining.push(status);
    }
    unit.statuses = remaining;
}

export function getStatusAcBonus(unit) {
    return (unit.statuses || []).reduce(
        (sum, status) => sum + (Number(status.acBonus) || 0) * Math.max(1, Number(status.stacks) || 1),
        0,
    );
}

export function getStatusAttackBonus(unit) {
    return (unit.statuses || []).reduce(
        (sum, status) => sum + (Number(status.attackBonus) || 0) * Math.max(1, Number(status.stacks) || 1),
        0,
    );
}

export function getStatusBehavior(unit, behavior) {
    if (!behavior) return null;
    return (unit?.statuses || []).find(status => status.behavior === behavior) || null;
}

function isStunned(unit) {
    return !!getStatusBehavior(unit, 'stunned');
}

export function getEffectiveAc(state, unit) {
    const terrain = getTerrain(state, unit.x, unit.y);
    return Math.max(1, (Number(unit.ac) || 10) + (Number(terrain.cover) || 0) + getStatusAcBonus(unit));
}

export function getEffectiveAttackBonus(state, unit, extra = 0) {
    const terrain = getTerrain(state, unit.x, unit.y);
    return (Number(unit.attackBonus) || 0) + (Number(terrain.attackBonus) || 0) + getStatusAttackBonus(unit) + (Number(extra) || 0);
}

function applyHazardAtRoundStart(state, unit, rng) {
    if (!unit || unit.defeated || unit.fled) return;
    const terrain = getTerrain(state, unit.x, unit.y);
    if (terrain.id !== 'hazard') return;
    const damage = rollDie(4, rng);
    addLog(state, 'hazard', `${unit.name} is caught in ${terrain.label.toLowerCase()} for ${damage} damage.`, unit.id);
    applyDamageToUnit(state, unit, damage, 'Hazard');
}

function applyBehaviorAtRoundStart(state, rng) {
    for (const unit of livingUnits(state)) {
        if (isStunned(unit)) {
            unit.actionUsed = true;
            unit.doneForRound = true;
            addLog(state, 'status', `${unit.name} is stunned and cannot act.`, unit.id);
            continue;
        }
        if (getStatusBehavior(unit, 'confused') && rollDie(2, rng) === 1) {
            unit.actionUsed = true;
            unit.doneForRound = true;
            addLog(state, 'status', `${unit.name} is confused and loses the action.`, unit.id);
        }
    }
}

/**
 * Start a new round. At combat start pass `{ initial: true }` so statuses do not
 * tick before anyone has acted.
 * @param {object} state
 * @param {() => number} rng
 * @param {{ initial?: boolean }} [options]
 */
export function beginRound(state, rng = Math.random, options = {}) {
    if (state.status !== 'active') return state;
    state.round = options.initial ? 1 : (Number(state.round) || 1) + 1;
    state.turnIndex = 0;
    state.pendingAgentUnitIds = [];
    state.phase = state.turnStyle === 'phase' ? 'player' : 'enemy';
    if (state.round > 1) {
        state.surprise = null;
        for (const unit of state.units) unit.surprised = false;
        revertExpiredTransforms(state);
    }

    for (const unit of state.units) {
        if (unit.defeated || unit.fled) continue;
        resetUnitForTurn(unit, state, rng, { initial: !!options.initial });
    }
    if (!options.initial) {
        for (const unit of livingUnits(state)) applyHazardAtRoundStart(state, unit, rng);
        applyBehaviorAtRoundStart(state, rng);
    }

    // If a DOT or hazard ended the fight, stop before assigning turns.
    if (checkEncounterEnd(state)) return state;

    if (state.turnStyle === 'initiative') {
        advanceTurnPointerToLiving(state);
        const active = getActiveUnit(state);
        state.phase = active && active.side !== 'player' ? 'enemy' : 'player';
    } else {
        state.phase = 'player';
    }
    addLog(state, 'round', `Round ${state.round} begins.`, null);
    return state;
}

function isSurprisedThisRound(state, unit) {
    return !!unit?.surprised && Number(state.round) === 1 && Number(state.surprise?.remaining) > 0;
}

function advanceTurnPointerToLiving(state) {
    while ((state.turnIndex || 0) < state.initiativeOrder.length) {
        const unit = getUnitById(state, state.initiativeOrder[state.turnIndex]);
        if (unit && !unit.defeated && !unit.fled && !unit.doneForRound && !isStunned(unit) && !isSurprisedThisRound(state, unit)) return;
        state.turnIndex += 1;
    }
}

function collectConsecutiveAgentUnits(state) {
    const ids = [];
    let index = Number(state.turnIndex) || 0;
    while (index < state.initiativeOrder.length) {
        const unit = getUnitById(state, state.initiativeOrder[index]);
        if (!unit || unit.defeated || unit.fled || unit.doneForRound || isStunned(unit)) {
            index += 1;
            continue;
        }
        if (unit.side === 'player') break;
        if (!isSurprisedThisRound(state, unit)) ids.push(unit.id);
        index += 1;
    }
    return ids;
}

/**
 * Advance initiative to the next living unit, wrapping into a new round when
 * needed. Returns the next batch of agent-controlled units, if any.
 * @param {object} state
 * @param {() => number} rng
 * @returns {{ agentUnitIds: string[], roundAdvanced: boolean }}
 */
export function advanceInitiative(state, rng = Math.random) {
    if (state.status !== 'active') return { agentUnitIds: [], roundAdvanced: false };
    let roundAdvanced = false;
    for (let guard = 0; guard < 200; guard += 1) {
        advanceTurnPointerToLiving(state);
        if (state.turnIndex < state.initiativeOrder.length) {
            const active = getActiveUnit(state);
            if (active && active.side === 'player') {
                state.phase = 'player';
                state.pendingAgentUnitIds = [];
                return { agentUnitIds: [], roundAdvanced };
            }
            const ids = collectConsecutiveAgentUnits(state);
            state.phase = ids.length ? 'enemy' : 'player';
            state.pendingAgentUnitIds = ids;
            return { agentUnitIds: ids, roundAdvanced };
        }
        beginRound(state, rng);
        roundAdvanced = true;
        if (state.status !== 'active') return { agentUnitIds: [], roundAdvanced };
        continue;
    }
    return { agentUnitIds: [], roundAdvanced };
}

/**
 * Phase style: enter the enemy phase. Initiative style: end the active player
 * unit's turn and advance until a player unit or an agent batch is reached.
 * @param {object} state
 * @param {() => number} rng
 * @returns {{ agentUnitIds: string[], phase: string, roundAdvanced: boolean }}
 */
export function endTurn(state, rng = Math.random) {
    if (state.status !== 'active') return { agentUnitIds: [], phase: state.phase, roundAdvanced: false };
    if (state.turnStyle === 'phase') {
        if (state.phase === 'enemy') {
            beginRound(state, rng);
            return { agentUnitIds: [], phase: state.phase, roundAdvanced: true };
        }
        const ids = getAgentControlledUnits(state)
            .filter(unit => !isSurprisedThisRound(state, unit) && !unit.doneForRound && !isStunned(unit))
            .map(unit => unit.id);
        state.phase = 'enemy';
        state.pendingAgentUnitIds = ids;
        if (!ids.length) {
            if (Number(state.surprise?.remaining) > 0 && Number(state.round) === 1) {
                addLog(state, 'round', 'The surprised side loses its first activation.', null);
            }
            beginRound(state, rng);
            return { agentUnitIds: [], phase: state.phase, roundAdvanced: true };
        }
        addLog(state, 'phase', 'Enemy phase begins.', null);
        return { agentUnitIds: ids, phase: 'enemy', roundAdvanced: false };
    }

    if (state.phase === 'enemy') {
        return completeAgentTurn(state, rng);
    }

    const active = getActiveUnit(state);
    if (active && active.side === 'player') active.doneForRound = true;
    state.turnIndex = (Number(state.turnIndex) || 0) + 1;
    const advanced = advanceInitiative(state, rng);
    if (state.status !== 'active') return { agentUnitIds: [], phase: state.phase, roundAdvanced: advanced.roundAdvanced };
    return { agentUnitIds: advanced.agentUnitIds, phase: state.phase, roundAdvanced: advanced.roundAdvanced };
}

/**
 * Finish the agent's phase/turn batch and begin the next player turn.
 * In phase style this starts a new round. In initiative style it jumps past the
 * units that just acted and may return another agent batch.
 * @param {object} state
 * @param {() => number} rng
 * @returns {{ agentUnitIds: string[], phase: string, roundAdvanced: boolean }}
 */
export function completeAgentTurn(state, rng = Math.random) {
    if (state.status !== 'active') return { agentUnitIds: [], phase: state.phase, roundAdvanced: false };
    if (state.turnStyle === 'phase') {
        state.pendingAgentUnitIds = [];
        beginRound(state, rng);
        return { agentUnitIds: [], phase: state.phase, roundAdvanced: true };
    }

    const acted = Array.isArray(state.pendingAgentUnitIds) ? state.pendingAgentUnitIds : [];
    let maxIndex = Number(state.turnIndex) || 0;
    for (const id of acted) {
        const index = state.initiativeOrder.indexOf(id);
        if (index > maxIndex) maxIndex = index;
    }
    state.turnIndex = maxIndex + 1;
    state.pendingAgentUnitIds = [];
    const advanced = advanceInitiative(state, rng);
    if (state.status !== 'active') return { agentUnitIds: [], phase: state.phase, roundAdvanced: advanced.roundAdvanced };
    return { agentUnitIds: advanced.agentUnitIds, phase: state.phase, roundAdvanced: advanced.roundAdvanced };
}

// ── Logging ──────────────────────────────────────────────────────────────────

export function addLog(state, type, text, unitId = null) {
    const entry = {
        at: Date.now(),
        round: Number(state.round) || 1,
        phase: String(state.phase || 'player'),
        type: String(type || 'info').slice(0, 24),
        unitId: unitId || null,
        text: String(text || '').slice(0, 600),
    };
    state.log.push(entry);
    if (state.log.length > TC_MAX_LOG_ENTRIES) state.log.splice(0, state.log.length - TC_MAX_LOG_ENTRIES);
    state.updatedAt = entry.at;
    return entry;
}

// ── Damage & outcomes ────────────────────────────────────────────────────────

function isHostile(attackerSide, targetSide) {
    const friendly = new Set(['player', 'ally']);
    return (friendly.has(attackerSide) && targetSide === 'enemy')
        || (attackerSide === 'enemy' && friendly.has(targetSide));
}

function isFriendly(attackerSide, targetSide) {
    return attackerSide === targetSide
        || (new Set(['player', 'ally']).has(attackerSide) && new Set(['player', 'ally']).has(targetSide));
}

function canTarget(unit, target, kind) {
    if (!target || target === unit) return kind !== 'attack';
    if (getStatusBehavior(unit, 'berserk')) return true;
    if (kind === 'attack') {
        const charmed = getStatusBehavior(unit, 'charmed');
        const frightened = getStatusBehavior(unit, 'frightened');
        if ((charmed?.sourceId && charmed.sourceId === target.id)
            || (frightened?.sourceId && frightened.sourceId === target.id)) return false;
        return isHostile(unit.side, target.side);
    }
    return isFriendly(unit.side, target.side);
}

export function applyDamageToUnit(state, target, amount, sourceLabel = '') {
    if (!target || target.defeated) return 0;
    const damage = Math.max(0, Math.round(Number(amount) || 0));
    if (!damage) return 0;
    target.hp = Math.max(0, Number(target.hp) - damage);
    addLog(state, 'damage', `${target.name} takes ${damage} damage${sourceLabel ? ` from ${sourceLabel}` : ''} (${target.hp}/${target.maxHp} HP).`, target.id);
    if (target.hp <= 0) {
        target.defeated = true;
        target.hp = 0;
        target.defeatCause = target.defeatCause || 'hp';
        addLog(state, 'defeat', `${target.name} is defeated.`, target.id);
    }
    return damage;
}

export function applyWillpowerDamageToUnit(state, target, amount, sourceLabel = '', options = {}) {
    if (!target || target.defeated || target.fled) return 0;
    if (isWillpowerImmune(target)) return 0;
    const before = Math.max(0, Number(target.willpower) || 0);
    if (before <= 0 && !target.willpowerBroken) {
        breakWillpower(state, target, {
            outcome: options.outcome ?? options.willpowerOutcome,
            source: sourceLabel || options.source || '',
            casterId: options.casterId,
        });
        return 0;
    }
    const damage = Math.max(0, Math.round(Number(amount) || 0));
    if (!damage) return 0;
    target.willpower = Math.max(0, before - damage);
    const dealt = before - target.willpower;
    if (!dealt) return 0;
    addLog(
        state,
        'willpower-damage',
        `${target.name} loses ${dealt} Willpower${sourceLabel ? ` from ${sourceLabel}` : ''} (${target.willpower}/${target.maxWillpower} WP).`,
        target.id,
    );
    if (target.willpower <= 0 && !target.willpowerBroken) {
        breakWillpower(state, target, {
            outcome: options.outcome ?? options.willpowerOutcome,
            source: sourceLabel || options.source || '',
            casterId: options.casterId,
        });
    }
    return dealt;
}

export function healUnit(state, target, amount, sourceLabel = '', resource = 'hp') {
    if (!target || target.defeated || target.fled) return 0;
    if (normalizeWillpowerResource(resource, 'hp') === 'willpower') {
        if (isWillpowerImmune(target)) return 0;
        const before = Number(target.willpower) || 0;
        const healed = Math.max(0, Math.round(Number(amount) || 0));
        target.willpower = Math.min(Number(target.maxWillpower) || before, before + healed);
        const gained = target.willpower - before;
        if (gained > 0) {
            addLog(state, 'willpower-heal', `${target.name} recovers ${gained} Willpower${sourceLabel ? ` (${sourceLabel})` : ''} (${target.willpower}/${target.maxWillpower} WP).`, target.id);
        }
        return gained;
    }
    const before = Number(target.hp) || 0;
    const healed = Math.max(0, Math.round(Number(amount) || 0));
    target.hp = Math.min(Number(target.maxHp) || before, before + healed);
    const gained = target.hp - before;
    if (gained > 0) {
        addLog(state, 'heal', `${target.name} recovers ${gained} HP${sourceLabel ? ` (${sourceLabel})` : ''} (${target.hp}/${target.maxHp} HP).`, target.id);
    }
    return gained;
}

/**
 * Mark a unit as Willpower-broken and apply the source-specific terminal
 * outcome. Idempotent: the first outcome wins for the encounter.
 *
 * @param {object} state
 * @param {object} target
 * @param {{ outcome?: string, source?: string }} [options]
 * @returns {boolean}
 */
export function breakWillpower(state, target, options = {}) {
    if (!target || target.defeated || target.fled) return false;
    if (target.willpowerBroken) return false;
    const outcome = normalizeWillpowerOutcome(options.outcome, 'defeat');
    target.willpower = 0;
    target.willpowerBroken = true;
    target.willpowerOutcome = outcome;
    target.willpowerBreakSource = String(options.source || '').slice(0, 120);
    target.willpowerBreakAt = Date.now();
    target.doneForRound = true;

    if (outcome === 'flee') {
        target.fled = true;
    } else if (outcome === 'switch_side') {
        applySideChange(state, target, options);
    } else if (outcome === 'incapacitate') {
        target.defeated = true;
        target.incapacitated = true;
        target.defeatCause = 'willpower';
    } else if (outcome === 'surrender') {
        target.defeated = true;
        target.surrendered = true;
        target.defeatCause = 'willpower';
    } else {
        target.defeated = true;
        target.defeatCause = 'willpower';
    }

    addLog(
        state,
        'willpower-break',
        `${target.name}'s Willpower breaks — ${willpowerOutcomeLabel(outcome)}.`,
        target.id,
    );
    checkEncounterEnd(state);
    return true;
}

function applySideChange(state, target, options = {}) {
    const caster = options.casterId ? getUnitById(state, options.casterId) : null;
    const casterFriendly = caster ? (caster.side === 'player' || caster.side === 'ally') : null;
    const currentSide = target.side;
    let nextSide = currentSide;
    if (casterFriendly === true) {
        nextSide = currentSide === 'enemy' ? 'ally' : currentSide;
    } else if (casterFriendly === false) {
        nextSide = 'enemy';
    } else {
        nextSide = currentSide === 'enemy' ? 'ally' : 'enemy';
    }
    if (nextSide === currentSide) return;
    target.originalSide = target.originalSide || currentSide;
    target.side = nextSide;
    target.sideChanged = true;
    target.actionUsed = true;
    target.bonusUsed = true;
    target.doneForRound = true;
    const source = caster ? caster.name : (options.source || 'the effect');
    addLog(state, 'side-change', `${target.name} turns against their former allies under ${source}.`, target.id);
    if (state.turnStyle === 'phase') {
        state.pendingAgentUnitIds = (state.pendingAgentUnitIds || []).filter(id => {
            const unit = getUnitById(state, id);
            return unit && !unit.doneForRound && !unit.defeated && !unit.fled;
        });
    }
}

function addStatus(unit, status) {
    const normalized = normalizeStatus(status);
    if (!normalized) return;
    unit.statuses = Array.isArray(unit.statuses) ? unit.statuses : [];
    const existing = unit.statuses.find(item => item.id === normalized.id);
    if (existing && normalized.maxStacks > 1) {
        existing.stacks = Math.min(normalized.maxStacks, Math.max(1, Number(existing.stacks) || 1) + Math.max(1, normalized.stacks || 1));
        existing.rounds = Math.max(Number(existing.rounds) || 0, normalized.rounds);
        Object.assign(existing, { ...normalized, stacks: existing.stacks });
    } else if (existing) {
        Object.assign(existing, normalized);
    } else {
        unit.statuses.push(normalized);
    }
    if (normalized.behavior === 'stunned') {
        unit.actionUsed = true;
        unit.doneForRound = true;
    }
}

/**
 * @param {object} state
 * @returns {object|null}
 */
function buildFinalUnit(unit) {
    return {
        id: unit.id,
        name: unit.name,
        originalName: unit.transform?.original?.name || unit.name,
        side: unit.side,
        originalSide: unit.originalSide || unit.side,
        sideChanged: !!unit.sideChanged,
        classLabel: unit.classLabel || '',
        hp: Math.max(0, Number(unit.hp) || 0),
        maxHp: Math.max(1, Number(unit.maxHp) || 1),
        willpower: Math.max(0, Number(unit.willpower) || 0),
        maxWillpower: Math.max(0, Number(unit.maxWillpower) || 0),
        willpowerBroken: !!unit.willpowerBroken,
        willpowerOutcome: unit.willpowerOutcome || '',
        defeatCause: unit.defeatCause || '',
        incapacitated: !!unit.incapacitated,
        surrendered: !!unit.surrendered,
        transformed: !!unit.transform,
        transformName: unit.transform ? unit.name : '',
        defeated: !!unit.defeated,
        fled: !!unit.fled,
        statuses: (unit.statuses || []).map(status => ({
            label: status.label || status.id || 'Afflicted',
            rounds: Number(status.rounds) || 0,
            acBonus: Number(status.acBonus) || 0,
            attackBonus: Number(status.attackBonus) || 0,
            behavior: status.behavior || '',
            stacks: Number(status.stacks) || 1,
        })),
    };
}

function buildCombatHighlights(state) {
    const highlights = [];
    const seen = new Set();
    for (const entry of state.log || []) {
        const text = String(entry?.text || '').trim();
        if (!text || seen.has(text)) continue;
        const type = String(entry?.type || '');
        const important = type === 'defeat'
            || type === 'special'
            || type === 'summon'
            || type === 'terrain'
            || type === 'flee'
            || type === 'opening'
            || type === 'surprise'
            || type === 'willpower-break'
            || type === 'transform'
            || type === 'side-change'
            || /critical|crit\b|killing blow|falls|defeated|surrenders|willpower breaks/i.test(text);
        if (!important) continue;
        seen.add(text);
        highlights.push(text);
    }
    return highlights.slice(-10);
}

export function buildOutcomeSummary(state) {
    const status = state.status === 'active' ? 'draw' : state.status;
    const label = status === 'victory' ? 'Victory'
        : status === 'defeat' ? 'Defeat'
            : status === 'retreat' ? 'Retreat'
                : 'Draw';
    // A unit that fled is still a survivor; only 0 HP counts as fallen.
    const realUnits = state.units.filter(unit => !unit.summoned);
    const originalSideOf = unit => unit.originalSide || unit.side;
    const playerSurvivors = realUnits.filter(unit => originalSideOf(unit) === 'player' && !unit.defeated);
    const playerFallen = realUnits.filter(unit => originalSideOf(unit) === 'player' && unit.defeated);
    const playerFled = realUnits.filter(unit => originalSideOf(unit) === 'player' && unit.fled && !unit.defeated);
    const enemyDefeated = realUnits.filter(unit => unit.side === 'enemy' && unit.defeated);
    const enemyFled = realUnits.filter(unit => unit.side === 'enemy' && unit.fled && !unit.defeated);
    const enemySurvivors = realUnits.filter(unit => unit.side === 'enemy' && !unit.defeated && !unit.fled && !unit.sideChanged);
    const allySurvivors = realUnits.filter(unit => unit.side === 'ally' && !unit.defeated);
    const allyFallen = realUnits.filter(unit => unit.side === 'ally' && unit.defeated);
    const allyFled = realUnits.filter(unit => unit.side === 'ally' && unit.fled && !unit.defeated);
    const willpowerBreaks = realUnits
        .filter(unit => unit.willpowerBroken)
        .map(unit => ({
            id: unit.id,
            name: unit.name,
            side: unit.side,
            originalSide: originalSideOf(unit),
            outcome: unit.willpowerOutcome || 'defeat',
            source: unit.willpowerBreakSource || '',
        }));
    const sideChanges = realUnits
        .filter(unit => unit.sideChanged)
        .map(unit => ({
            id: unit.id,
            name: unit.name,
            originalSide: originalSideOf(unit),
            side: unit.side,
        }));
    const transformations = realUnits
        .filter(unit => unit.transform)
        .map(unit => ({
            id: unit.id,
            name: unit.name,
            originalName: unit.transform?.original?.name || unit.name,
            permanent: !!unit.transform?.permanent,
            expiresRound: unit.transform?.expiresRound || 0,
        }));
    const details = [];

    if (status === 'victory') {
        details.push(enemyDefeated.length
            ? `The opposition is broken. ${enemyDefeated.map(unit => unit.name).join(', ')} were defeated.`
            : 'The opposition is broken; the remaining enemies flee the field.');
        if (enemyFled.length) details.push(`Driven off: ${enemyFled.map(unit => unit.name).join(', ')}.`);
    } else if (status === 'defeat') {
        details.push(`The party has fallen. ${playerFallen.map(unit => unit.name).join(', ') || 'Every player unit'} can fight no longer.`);
        if (playerFled.length) details.push(`Escaped: ${playerFled.map(unit => unit.name).join(', ')}.`);
    } else if (status === 'retreat') {
        details.push(`The party withdraws from the field. ${playerFled.map(unit => unit.name).join(', ') || 'The survivors'} escape the encounter.`);
        if (playerFallen.length) details.push(`Left behind: ${playerFallen.map(unit => unit.name).join(', ')}.`);
    } else {
        details.push('Both sides are spent. The fighting ends without a clear victor.');
    }
    if (playerSurvivors.length) {
        details.push(`Survivors: ${playerSurvivors.map(unit => `${unit.name} (${unit.hp}/${unit.maxHp} HP, ${unit.willpower}/${unit.maxWillpower} WP)`).join(', ')}.`);
    }
    if (enemySurvivors.length) {
        details.push(`Still standing: ${enemySurvivors.map(unit => `${unit.name} (${unit.hp}/${unit.maxHp} HP, ${unit.willpower}/${unit.maxWillpower} WP)`).join(', ')}.`);
    }
    if (enemyFled.length) details.push(`Enemies driven off: ${enemyFled.map(unit => unit.name).join(', ')}.`);
    if (allySurvivors.length) {
        details.push(`Allies standing: ${allySurvivors.map(unit => `${unit.name} (${unit.hp}/${unit.maxHp} HP, ${unit.willpower}/${unit.maxWillpower} WP)`).join(', ')}.`);
    }
    if (allyFallen.length) details.push(`Fallen allies: ${allyFallen.map(unit => unit.name).join(', ')}.`);
    if (allyFled.length) details.push(`Allies withdrawn: ${allyFled.map(unit => unit.name).join(', ')}.`);
    if (willpowerBreaks.length) {
        details.push(`Willpower broken: ${willpowerBreaks.map(entry => `${entry.name} (${entry.outcome.replace(/_/g, ' ')})`).join(', ')}.`);
    }
    if (sideChanges.length) {
        details.push(`Changed sides: ${sideChanges.map(entry => `${entry.name} (${entry.originalSide} → ${entry.side})`).join(', ')}.`);
    }
    if (transformations.length) {
        details.push(`Transformed: ${transformations.map(entry => `${entry.originalName}${entry.permanent ? ' (permanent)' : ''}`).join(', ')}.`);
    }

    const summary = `${label} after ${state.round} round${state.round === 1 ? '' : 's'} at ${state.location || 'the battlefield'}.`;
    const finalUnits = realUnits.map(buildFinalUnit);
    return {
        status,
        label,
        title: state.title || 'Tactical encounter',
        location: state.location || '',
        rounds: state.round,
        survivors: playerSurvivors.map(unit => ({ id: unit.id, name: unit.name, hp: unit.hp, maxHp: unit.maxHp, willpower: unit.willpower, maxWillpower: unit.maxWillpower })),
        fallen: playerFallen.map(unit => ({ id: unit.id, name: unit.name })),
        fled: playerFled.map(unit => ({ id: unit.id, name: unit.name })),
        defeatedEnemies: enemyDefeated.map(unit => ({ id: unit.id, name: unit.name })),
        enemySurvivors: enemySurvivors.map(unit => ({ id: unit.id, name: unit.name, hp: unit.hp, maxHp: unit.maxHp, willpower: unit.willpower, maxWillpower: unit.maxWillpower })),
        enemyFled: enemyFled.map(unit => ({ id: unit.id, name: unit.name })),
        allySurvivors: allySurvivors.map(unit => ({ id: unit.id, name: unit.name, hp: unit.hp, maxHp: unit.maxHp, willpower: unit.willpower, maxWillpower: unit.maxWillpower })),
        allyFallen: allyFallen.map(unit => ({ id: unit.id, name: unit.name })),
        allyFled: allyFled.map(unit => ({ id: unit.id, name: unit.name })),
        willpowerBreaks,
        sideChanges,
        transformations,
        finalUnits,
        highlights: buildCombatHighlights(state),
        opening: state.opening ? {
            text: String(state.opening.text || ''),
            resolved: !!state.opening.resolved,
            surprise: !!state.opening.surprise,
            actorId: state.opening.actorId || '',
            targetId: state.opening.targetId || '',
        } : null,
        summary,
        details,
        endedAt: Date.now(),
    };
}

/**
 * Evaluate victory/defeat/retreat. Sets state.status and state.outcome.
 * @param {object} state
 * @returns {boolean} true when the encounter is over
 */
export function checkEncounterEnd(state) {
    if (!state || state.status !== 'active') return !!state && state.status !== 'active';
    const players = state.units.filter(unit => unit.side === 'player' && !unit.summoned);
    const livingPlayers = players.filter(unit => !unit.defeated && !unit.fled);
    const livingEnemies = state.units.filter(unit => unit.side === 'enemy' && !unit.summoned && !unit.defeated && !unit.fled);
    const livingAllUnits = state.units.filter(unit => !unit.defeated && !unit.fled);

    let status = null;
    if (!livingPlayers.length) {
        status = players.length > 0 && players.every(unit => unit.fled) ? 'retreat' : 'defeat';
    } else if (!livingEnemies.length) {
        status = 'victory';
    } else if (!livingAllUnits.length) {
        status = 'draw';
    }
    if (!status) return false;

    state.status = status;
    state.phase = 'ended';
    state.pendingAgentUnitIds = [];
    state.outcome = buildOutcomeSummary(state);
    addLog(state, 'end', state.outcome.summary, null);
    return true;
}

/**
 * Player-initiated withdrawal. Marks every living player unit as fled and ends
 * the encounter with a retreat outcome.
 * @param {object} state
 * @returns {boolean}
 */
export function retreatEncounter(state) {
    if (!state || state.status !== 'active') return false;
    for (const unit of state.units) {
        const partySide = (unit.originalSide || unit.side) === 'player';
        if (partySide && !unit.defeated) {
            unit.fled = true;
            unit.doneForRound = true;
        }
    }
    state.status = 'retreat';
    state.phase = 'ended';
    state.pendingAgentUnitIds = [];
    state.outcome = buildOutcomeSummary(state);
    addLog(state, 'end', state.outcome.summary, null);
    return true;
}

// ── Transformations ─────────────────────────────────────────────────────────

function cloneJson(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function snapshotUnitForm(unit) {
    return {
        name: unit.name,
        classLabel: unit.classLabel,
        ac: unit.ac,
        maxHp: unit.maxHp,
        hp: unit.hp,
        maxWillpower: unit.maxWillpower,
        willpower: unit.willpower,
        attackBonus: unit.attackBonus,
        attackRange: unit.attackRange,
        damage: unit.damage,
        damageType: unit.damageType,
        speed: unit.speed,
        level: unit.level,
        notes: unit.notes,
        glyph: unit.glyph,
        color: unit.color,
        attackResource: unit.attackResource,
        willpowerDamage: unit.willpowerDamage,
        attackWillpowerOutcome: unit.attackWillpowerOutcome,
        skills: cloneJson(unit.skills || []),
        items: cloneJson(unit.items || []),
        inventory: cloneJson(unit.inventory || []),
    };
}

function normalizeTransformInventory(value) {
    return (Array.isArray(value) ? value : [])
        .filter(entry => entry && typeof entry === 'object')
        .slice(0, 24)
        .map(entry => ({
            name: String(entry.name || '').slice(0, 80),
            description: String(entry.description || '').slice(0, 300),
            section: String(entry.section || '').slice(0, 20),
            equipped: !!entry.equipped,
            rarity: String(entry.rarity || '').slice(0, 20),
            quantity: clampIntOr(entry.quantity, 1, 1, 99),
        }))
        .filter(entry => entry.name);
}

function applyTransform(state, target, effect) {
    if (!target || target.fled) return { ok: false, error: 'Invalid transform target.' };
    if (!target.transform) {
        target.transform = {
            original: snapshotUnitForm(target),
            permanent: false,
            appliedAt: Date.now(),
            expiresRound: 0,
        };
    }
    const transform = target.transform;
    transform.permanent = effect.permanent === true;
    transform.expiresRound = Number(effect.rounds) > 0 ? (Number(state.round) || 1) + Number(effect.rounds) : 0;

    if (effect.name != null) target.name = String(effect.name).slice(0, 80) || target.name;
    if (effect.classLabel != null) target.classLabel = String(effect.classLabel).slice(0, 80);
    if (effect.ac != null) target.ac = clampIntOr(effect.ac, target.ac, 1, 40);
    if (effect.maxHp != null) target.maxHp = clampIntOr(effect.maxHp, target.maxHp, 1, 999);
    if (effect.hp != null) target.hp = clampInt(effect.hp, 0, target.maxHp);
    else target.hp = Math.min(Math.max(0, Number(target.hp) || 0), target.maxHp);
    if (effect.maxWillpower != null) target.maxWillpower = clampIntOr(effect.maxWillpower, target.maxWillpower, 0, 99);
    if (effect.willpower != null) target.willpower = clampInt(effect.willpower, 0, target.maxWillpower);
    else target.willpower = Math.min(Math.max(0, Number(target.willpower) || 0), target.maxWillpower);
    target.willpowerImmune = target.maxWillpower === 0;
    if (effect.attackBonus != null) target.attackBonus = clampInt(effect.attackBonus, -10, 30);
    if (effect.attackRange != null) target.attackRange = clampIntOr(effect.attackRange, target.attackRange, 1, 24);
    if (effect.damage != null) target.damage = String(effect.damage || '1d6').slice(0, 40);
    if (effect.damageType != null) target.damageType = String(effect.damageType).slice(0, 20);
    if (effect.speed != null) target.speed = clampIntOr(effect.speed, target.speed, 1, 30);
    target.movementUsed = Math.min(Number(target.movementUsed) || 0, Number(target.speed) || 1);
    if (effect.notes != null) target.notes = String(effect.notes).slice(0, 500);
    if (effect.glyph != null) target.glyph = String(effect.glyph).slice(0, 3);
    if (effect.color != null) target.color = String(effect.color).slice(0, 30);
    if (effect.attackResource != null) target.attackResource = normalizeWillpowerResource(effect.attackResource, target.attackResource);
    if (effect.willpowerDamage != null) target.willpowerDamage = String(effect.willpowerDamage).slice(0, 40);
    if (effect.attackWillpowerOutcome != null) target.attackWillpowerOutcome = normalizeWillpowerOutcome(effect.attackWillpowerOutcome, target.attackWillpowerOutcome);
    if (Array.isArray(effect.skills)) {
        target.skills = effect.skills
            .slice(0, 8)
            .map((skill, index) => normalizeSkill(skill, index, target.side))
            .filter(Boolean);
    }
    if (Array.isArray(effect.items)) {
        target.items = effect.items
            .slice(0, 8)
            .map((item, index) => normalizeItem(item, index))
            .filter(Boolean);
    }
    if (Array.isArray(effect.inventory)) {
        target.inventory = normalizeTransformInventory(effect.inventory);
    }
    addLog(state, 'transform', `${target.name} is transformed${transform.permanent ? ' permanently' : ''}.`, target.id);
    return {
        ok: true,
        name: target.name,
        permanent: transform.permanent,
        expiresRound: transform.expiresRound,
    };
}

function revertTransform(state, unit, reason = '') {
    if (!unit?.transform || unit.transform.permanent) return false;
    const original = unit.transform.original || {};
    for (const key of [
        'name', 'classLabel', 'ac', 'maxHp', 'maxWillpower', 'attackBonus', 'attackRange',
        'damage', 'damageType', 'speed', 'level', 'notes', 'glyph', 'color',
        'attackResource', 'willpowerDamage', 'attackWillpowerOutcome', 'skills', 'items', 'inventory',
    ]) {
        if (Object.prototype.hasOwnProperty.call(original, key)) {
            unit[key] = cloneJson(original[key]);
        }
    }
    unit.hp = Math.min(Math.max(0, Number(unit.hp) || 0), Number(unit.maxHp) || 1);
    unit.willpower = Math.min(Math.max(0, Number(unit.willpower) || 0), Number(unit.maxWillpower) || 0);
    unit.willpowerImmune = Number(unit.maxWillpower) === 0;
    unit.movementUsed = Math.min(Number(unit.movementUsed) || 0, Number(unit.speed) || 1);
    unit.transform = null;
    addLog(state, 'transform', `${unit.name} returns to their original form${reason ? ` (${reason})` : ''}.`, unit.id);
    return true;
}

export function revertExpiredTransforms(state) {
    const round = Number(state?.round) || 1;
    for (const unit of state?.units || []) {
        if (unit?.transform && !unit.transform.permanent && unit.transform.expiresRound > 0 && round >= unit.transform.expiresRound) {
            revertTransform(state, unit, 'duration expired');
        }
    }
}

/**
 * Revert encounter-scoped side changes and temporary transformations after the
 * outcome has been captured. Called before the deterministic memo sync.
 * @param {object} state
 */
export function restoreCombatScopedState(state) {
    if (!state || state.finalization?.scopedStateRestored) return false;
    for (const unit of state.units || []) {
        if (unit.transform && !unit.transform.permanent) revertTransform(state, unit, 'combat ended');
        if (unit.sideChanged) {
            unit.side = unit.originalSide || unit.side;
            unit.sideChanged = false;
        }
    }
    state.finalization = {
        ...(state.finalization || {}),
        scopedStateRestored: true,
        scopedStateRestoredAt: Date.now(),
    };
    return true;
}

/**
 * Apply a resolved special-ability effect list. This is the only mutation path
 * for `kind: 'special'` skills/items: the combat agent converts a freeform
 * ability description into these primitives, then the engine validates them.
 *
 * Supported effects:
 *   {type:'damage', targetId, amount, resource:'hp'|'willpower'|'both', willpowerOutcome?}
 *   {type:'heal', targetId, amount, resource:'hp'|'willpower'|'both'}
 *   {type:'status', targetId, label, rounds, acBonus, attackBonus, damage, damageResource?, behavior?, stacks?}
 *   {type:'defeat', targetId, outcome, reason?}
 *   {type:'transform', targetId, name?, maxHp?, ac?, ...}
 *   {type:'terrain', cells:[{x,y,terrain}], terrain?}
 *   {type:'summon', name, maxHp, ac, attackBonus, damage, attackRange, skills?}
 *   {type:'log', text}
 *
 * @param {object} state
 * @param {object[]} effects
 * @param {{ casterId?: string, skillId?: string, itemId?: string, log?: string, rng?: () => number }} [options]
 * @returns {{ ok: boolean, error?: string, applied: object[], rejected: string[], ended: boolean }}
 */
export function applySpecialEffects(state, effects, options = {}) {
    if (!state || state.status !== 'active') return { ok: false, error: 'The encounter is over.', applied: [], rejected: [], ended: true };
    const caster = getUnitById(state, options.casterId);
    if (!caster || caster.defeated || caster.fled) {
        return { ok: false, error: 'The caster is not available.', applied: [], rejected: [], ended: false };
    }
    const skill = options.skillId ? findSkill(caster, options.skillId) : null;
    const item = options.itemId ? findItem(caster, options.itemId) : null;
    if (options.skillId && !skill) return { ok: false, error: 'Unknown ability.', applied: [], rejected: [], ended: false };
    if (options.itemId && !item) return { ok: false, error: 'Unknown item.', applied: [], rejected: [], ended: false };
    if (skill && skill.uses <= 0) return { ok: false, error: `${skill.name} has no uses left.`, applied: [], rejected: [], ended: false };
    if (item && item.uses <= 0) return { ok: false, error: `${item.name} has no uses left.`, applied: [], rejected: [], ended: false };
    if (skill && (skill.bonusAction ? caster.bonusUsed : caster.actionUsed)) {
        return { ok: false, error: 'That action is already spent.', applied: [], rejected: [], ended: false };
    }
    if (item && caster.actionUsed) return { ok: false, error: 'The main action is already spent.', applied: [], rejected: [], ended: false };

    const rng = options.rng || createStateRng(state);
    const label = options.label || skill?.name || item?.name || options.log || 'Special ability';
    const narrative = options.narrative || '';
    const applied = [];
    const rejected = [];
    const list = Array.isArray(effects) ? effects.slice(0, 8) : [];

    for (const effect of list) {
        if (!effect || typeof effect !== 'object') {
            rejected.push('Effect was not an object.');
            continue;
        }
        const type = String(effect.type || '').toLowerCase();
        if (type === 'damage' || type === 'heal' || type === 'status' || type === 'cure') {
            const target = getUnitById(state, effect.targetId);
            if (!target || target.defeated || target.fled) {
                rejected.push(`Unknown target "${effect.targetId}".`);
                continue;
            }
            const resource = normalizeWillpowerResource(effect.resource ?? effect.stat, 'hp');
            if (type === 'damage') {
                const amount = rollDice(effect.amount ?? effect.damage ?? '1d6', rng).total;
                let hpDamage = 0;
                let willpowerDamage = 0;
                if (resource === 'hp' || resource === 'both') hpDamage = applyDamageToUnit(state, target, amount, label);
                if ((resource === 'willpower' || resource === 'both') && !target.defeated) {
                    willpowerDamage = applyWillpowerDamageToUnit(state, target, amount, label, {
                        outcome: effect.willpowerOutcome ?? effect.willOutcome,
                        casterId: caster.id,
                    });
                }
                applied.push({ type, targetId: target.id, amount: hpDamage || willpowerDamage, resource, hpDamage, willpowerDamage });
            } else if (type === 'heal') {
                const amount = rollDice(effect.amount ?? effect.heal ?? '1d8+2', rng).total;
                let hpHealed = 0;
                let willpowerHealed = 0;
                if (resource === 'hp' || resource === 'both') hpHealed = healUnit(state, target, amount, label, 'hp');
                if (resource === 'willpower' || resource === 'both') willpowerHealed = healUnit(state, target, amount, label, 'willpower');
                applied.push({ type, targetId: target.id, amount: hpHealed || willpowerHealed, resource, hpHealed, willpowerHealed });
            } else if (type === 'cure') {
                const removed = (target.statuses || []).map(status => status.label);
                target.statuses = [];
                applied.push({ type, targetId: target.id, removed });
            } else {
                addStatus(target, {
                    id: String(effect.id || effect.label || label).slice(0, 40),
                    label: String(effect.label || effect.name || label).slice(0, 60),
                    rounds: effect.rounds ?? 2,
                    acBonus: effect.acBonus,
                    attackBonus: effect.attackBonus,
                    damage: effect.damage || '',
                    damageResource: effect.damageResource ?? effect.resource,
                    willpowerOutcome: effect.willpowerOutcome ?? effect.willOutcome,
                    behavior: effect.behavior,
                    sourceId: effect.sourceId || caster.id,
                    stacks: effect.stacks,
                    maxStacks: effect.maxStacks,
                    description: effect.description || '',
                });
                applied.push({ type, targetId: target.id, label: effect.label || label });
            }
            continue;
        }
        if (type === 'defeat') {
            const target = getUnitById(state, effect.targetId);
            if (!target || target.defeated || target.fled) {
                rejected.push(`Unknown target "${effect.targetId}".`);
                continue;
            }
            if (!target.willpowerBroken && Number(target.willpower) > 0) {
                rejected.push(`${target.name} still has Willpower; a defeat effect is not legal.`);
                continue;
            }
            if (target.willpowerBroken) {
                rejected.push(`${target.name} has already been broken.`);
                continue;
            }
            const outcome = normalizeWillpowerOutcome(effect.outcome ?? effect.willpowerOutcome, 'defeat');
            if (breakWillpower(state, target, { outcome, source: effect.reason || label, casterId: caster.id })) {
                applied.push({ type, targetId: target.id, outcome });
            } else {
                rejected.push(`Could not apply the defeat outcome to ${target.name}.`);
            }
            continue;
        }
        if (type === 'transform') {
            const target = getUnitById(state, effect.targetId);
            if (!target || target.defeated || target.fled) {
                rejected.push(`Unknown target "${effect.targetId}".`);
                continue;
            }
            if (effect.permanent === true && caster.side !== 'player') {
                rejected.push('Enemy-authored permanent transformations are disabled.');
                continue;
            }
            const transformed = applyTransform(state, target, effect);
            if (transformed.ok) applied.push({ type, targetId: target.id, ...transformed });
            else rejected.push(transformed.error || 'Transform failed.');
            continue;
        }
        if (type === 'terrain') {
            if (state.theater || !Array.isArray(state.terrain)) {
                rejected.push('Terrain effects are not supported in traditional combat.');
                continue;
            }
            const cells = Array.isArray(effect.cells) ? effect.cells
                : Array.isArray(effect.tiles) ? effect.tiles
                    : effect.x != null && effect.y != null ? [effect] : [];
            let changed = 0;
            for (const cell of cells.slice(0, 24)) {
                const x = Number(cell?.x);
                const y = Number(cell?.y);
                const terrainId = String(cell?.terrain || effect.terrain || '').toLowerCase();
                if (!inBounds(state, x, y) || !TC_TERRAIN[terrainId]) continue;
                state.terrain[y][x] = terrainId;
                changed += 1;
            }
            if (changed) {
                applied.push({ type, cells: changed, terrain: effect.terrain || '' });
                addLog(state, 'terrain', `${caster.name} reshapes the battlefield (${changed} cell${changed === 1 ? '' : 's'}).`, caster.id);
            } else {
                rejected.push('Terrain effect had no valid cells.');
            }
            continue;
        }
        if (type === 'summon') {
            const seed = effect.unit && typeof effect.unit === 'object' ? effect.unit : effect;
            const summon = normalizeUnitSeed({
                ...seed,
                name: seed.name || 'Summon',
                side: caster.side,
                color: seed.color || caster.color,
            }, {
                index: state.units.length,
                side: caster.side,
                defaultSpeed: caster.speed,
            });
            summon.summoned = true;
            summon.summonedBy = caster.id;
            summon.doneForRound = true;
            summon.actionUsed = true;
            summon.bonusUsed = true;
            const usedIds = new Set(state.units.map(unit => unit.id));
            let summonId = summon.id;
            let suffix = 2;
            while (usedIds.has(summonId)) {
                summonId = `${summon.id}-${suffix}`;
                suffix += 1;
            }
            summon.id = summonId;
            if (state.theater) {
                // No grid in traditional combat; every unit shares the abstract
                // theater position. The UI never renders coordinates.
                summon.x = 0;
                summon.y = 0;
            } else {
                const occupied = new Set(state.units.filter(unit => !unit.defeated && !unit.fled).map(unit => cellKey(unit.x, unit.y)));
                const spot = findFreeCell(state, caster.x, caster.y, occupied);
                if (!spot) {
                    rejected.push(`No free cell for ${summon.name}.`);
                    continue;
                }
                summon.x = spot.x;
                summon.y = spot.y;
            }
            state.units.push(summon);
            if (state.turnStyle === 'initiative' && Array.isArray(state.initiativeOrder) && !state.initiativeOrder.includes(summon.id)) {
                state.initiativeOrder.push(summon.id);
            }
            addLog(state, 'summon', `${caster.name} summons ${summon.name} (${summon.hp}/${summon.maxHp} HP).`, caster.id);
            applied.push({ type, unitId: summon.id, name: summon.name });
            continue;
        }
        if (type === 'log' || type === 'note') {
            if (effect.text) addLog(state, 'special', String(effect.text).slice(0, 400), caster.id);
            applied.push({ type: 'log' });
            continue;
        }
        rejected.push(`Unsupported effect type "${type}".`);
    }

    if (!applied.length) {
        return { ok: false, error: rejected.join(' ') || 'No usable effects were returned.', applied, rejected, ended: false };
    }

    if (skill) {
        skill.uses = Math.max(0, Number(skill.uses) - 1);
        if (skill.bonusAction) caster.bonusUsed = true;
        else caster.actionUsed = true;
    }
    if (item) {
        item.uses = Math.max(0, Number(item.uses) - 1);
        caster.actionUsed = true;
    }
    if (narrative) addLog(state, 'special', String(narrative).slice(0, 600), caster.id);
    addLog(state, 'special', `${caster.name} uses ${label}.`, caster.id);
    checkEncounterEnd(state);
    return { ok: true, applied, rejected, ended: state.status !== 'active' };
}

// ── Action interpretation ────────────────────────────────────────────────────

function rejectAction(state, action, error, source) {
    addLog(
        state,
        'rejected',
        `${source === 'agent' ? 'Agent' : 'Player'} action rejected${action?.type ? ` (${action.type})` : ''}: ${error}`,
        action?.unitId || null,
    );
    return { ok: false, error };
}

function validateActor(state, action, options) {
    const unit = getUnitById(state, action.unitId);
    if (!unit) return { error: `Unknown unit "${action.unitId}".` };
    if (unit.defeated) return { error: `${unit.name} is defeated.` };
    if (unit.fled) return { error: `${unit.name} has fled.` };
    if (isStunned(unit)) return { error: `${unit.name} is stunned.` };
    if (unit.doneForRound && !options.ignoreTurn) return { error: `${unit.name} has already finished acting this round.` };

    const actorSide = options.actorSide || (unit.side === 'player' ? 'player' : 'agent');
    if (actorSide === 'player' && unit.side !== 'player') {
        return { error: `${unit.name} is not player-controlled.` };
    }
    if (actorSide === 'agent' && unit.side === 'player') {
        return { error: `${unit.name} is player-controlled and cannot be moved by the combat agent.` };
    }

    if (state.turnStyle === 'phase') {
        if (state.phase === 'player' && unit.side !== 'player') {
            return { error: 'Only player units can act during the player phase.' };
        }
        if (state.phase === 'enemy' && unit.side === 'player') {
            return { error: 'Player units cannot act during the enemy phase.' };
        }
    } else if (!options.ignoreTurn) {
        const pending = state.phase === 'enemy' && Array.isArray(state.pendingAgentUnitIds)
            ? state.pendingAgentUnitIds
            : [];
        if (!pending.includes(unit.id)) {
            const active = getActiveUnit(state);
            if (active && active.id !== unit.id) {
                return { error: `It is ${active.name}'s turn, not ${unit.name}'s.` };
            }
        }
    }
    return { unit };
}

function findSkill(unit, skillId) {
    const needle = String(skillId || '').toLowerCase();
    return (unit.skills || []).find(skill => skill.id.toLowerCase() === needle || skill.name.toLowerCase() === needle) || null;
}

function findItem(unit, itemId) {
    const needle = String(itemId || '').toLowerCase();
    return (unit.items || []).find(item => item.id.toLowerCase() === needle || item.name.toLowerCase() === needle) || null;
}

/**
 * Validate a special skill/item declaration without consuming its action.
 * Used by the enemy-agent special resolver and the player UI before a resolver
 * call, so invalid declarations never reach the model.
 *
 * @param {object} state
 * @param {object} action
 * @param {{ actorSide?: 'player'|'agent', ignoreTurn?: boolean, ignoreRange?: boolean, ignoreDeployment?: boolean }} [options]
 * @returns {{ ok: boolean, error?: string, unit?: object, skill?: object|null, item?: object|null, target?: object, label?: string }}
 */
export function prepareSpecialAction(state, action, options = {}) {
    if (!state || state.status !== 'active') return { ok: false, error: 'The encounter is over.' };
    if (state.preparing?.active) return { ok: false, error: 'The encounter is still being prepared.' };
    if (state.deployment?.active && !options.ignoreDeployment) return { ok: false, error: 'Finish deployment before taking combat actions.' };
    if (!action || !action.type) return { ok: false, error: 'Invalid action.' };
    const actorCheck = validateActor(state, action, options);
    if (actorCheck.error) return { ok: false, error: actorCheck.error };
    const unit = actorCheck.unit;
    const skill = action.skillId ? findSkill(unit, action.skillId) : null;
    const item = action.itemId ? findItem(unit, action.itemId) : null;
    if (action.skillId && !skill) return { ok: false, error: `Unknown skill "${action.skillId}".` };
    if (action.itemId && !item) return { ok: false, error: `Unknown item "${action.itemId}".` };
    const source = skill || item;
    if (!source) return { ok: false, error: 'Special action needs a skillId or itemId.' };
    if (source.kind !== 'special') return { ok: false, error: `${source.name} does not require special resolution.` };
    if (source.uses <= 0) return { ok: false, error: `${source.name} has no uses left.` };
    const resourceKey = skill?.bonusAction ? 'bonusUsed' : 'actionUsed';
    if (unit[resourceKey]) {
        return { ok: false, error: skill?.bonusAction ? `${unit.name} has already used a bonus action.` : `${unit.name} has already used their action.` };
    }
    const targetId = String(action.targetId || unit.id).trim();
    const target = getUnitById(state, targetId);
    if (!target) return { ok: false, error: `Unknown target "${targetId}".` };
    if (target.defeated) return { ok: false, error: `${target.name} is already defeated.` };
    if (target.fled) return { ok: false, error: `${target.name} has fled.` };
    const charmed = getStatusBehavior(unit, 'charmed');
    const frightened = getStatusBehavior(unit, 'frightened');
    if (target.id !== unit.id && ((charmed?.sourceId && charmed.sourceId === target.id)
        || (frightened?.sourceId && frightened.sourceId === target.id))) {
        return { ok: false, error: `${unit.name} cannot direct a harmful effect at ${target.name}.` };
    }
    const distance = unit.id === target.id ? 0 : chebyshev(unit, target);
    if (!options.ignoreRange && distance > (Number(source.range) || 0)) {
        return { ok: false, error: `${target.name} is out of ${source.name}'s range (${distance} cells, range ${source.range}).` };
    }
    return {
        ok: true,
        unit,
        skill,
        item,
        target,
        label: source.name,
    };
}

/**
 * Replace $caster / $target placeholders in a pre-authored effect template.
 * @param {object[]} effects
 * @param {{ casterId?: string, targetId?: string }} ids
 * @returns {object[]}
 */
export function resolveEffectTemplate(effects, ids = {}) {
    const source = Array.isArray(effects) ? effects : [];
    const replace = value => {
        if (typeof value === 'string') {
            if (value === '$caster') return ids.casterId || '';
            if (value === '$target') return ids.targetId || '';
            return value;
        }
        if (Array.isArray(value)) return value.map(replace);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
        }
        return value;
    };
    return cloneJson(source.map(replace));
}

function resolveTarget(state, unit, action, options) {
    const targetId = String(action.targetId || options.defaultTargetId || '').trim();
    if (!targetId) return { target: null };
    const target = getUnitById(state, targetId);
    if (!target) return { target: null, error: `Unknown target "${targetId}".` };
    if (target.defeated) return { target: null, error: `${target.name} is already defeated.` };
    return { target };
}

/**
 * Apply one already-normalized action.
 * @param {object} state
 * @param {object} action
 * @param {{ rng?: () => number, actorSide?: 'player'|'agent', ignoreTurn?: boolean, source?: string }} [options]
 * @returns {{ ok: boolean, error?: string, log?: string, ended?: boolean }}
 */
export function applyAction(state, action, options = {}) {
    if (!state || state.status !== 'active') return { ok: false, error: 'The encounter is over.' };
    if (state.preparing?.active) return { ok: false, error: 'The encounter is still being prepared.' };
    if (state.deployment?.active && !options.ignoreDeployment) {
        return { ok: false, error: 'Finish deployment before taking combat actions.' };
    }
    if (!action || !action.type) return { ok: false, error: 'Invalid action.' };
    const catalog = Array.isArray(state.actionCatalog) && state.actionCatalog.length
        ? state.actionCatalog
        : DEFAULT_TACTICAL_ACTION_CATALOG;
    if (!isActionEnabled(catalog, action.type)) {
        return rejectAction(state, action, `Action "${action.type}" is disabled in the action catalogue.`, options.source);
    }

    const actorCheck = validateActor(state, action, options);
    if (actorCheck.error) return rejectAction(state, action, actorCheck.error, options.source);
    const unit = actorCheck.unit;
    const rng = options.rng || createStateRng(state);
    const source = options.source || 'player';

    switch (action.type) {
        case 'move': {
            if (unit.doneForRound) return rejectAction(state, action, 'This unit has finished acting.', source);
            const destination = action.to;
            if (!destination || !Number.isInteger(destination.x) || !Number.isInteger(destination.y)) {
                return rejectAction(state, action, 'Move destination must contain integer x and y.', source);
            }
            if (!inBounds(state, destination.x, destination.y)) {
                return rejectAction(state, action, 'Move destination is outside the grid.', source);
            }
            if (!isWalkableTerrain(state, destination.x, destination.y)) {
                return rejectAction(state, action, 'Move destination is impassable terrain.', source);
            }
            const occupant = state.units.find(other => other !== unit && !other.defeated && !other.fled
                && other.x === destination.x && other.y === destination.y);
            if (occupant) return rejectAction(state, action, `${occupant.name} is standing there.`, source);
            const path = Array.isArray(action.path) && action.path.length
                ? action.path
                : findPath(state, unit, destination);
            if (!path) return rejectAction(state, action, 'No legal path to that cell.', source);
            const last = path[path.length - 1];
            if (!last || last.x !== destination.x || last.y !== destination.y) {
                const resolved = findPath(state, unit, destination);
                if (!resolved) return rejectAction(state, action, 'No legal path to that cell.', source);
                return applyMove(state, unit, resolved, rng, source);
            }
            return applyMove(state, unit, path, rng, source);
        }

        case 'attack': {
            if (unit.actionUsed) return rejectAction(state, action, `${unit.name} has already used their action.`, source);
            const { target, error } = resolveTarget(state, unit, action, options);
            if (!target) return rejectAction(state, action, error || 'Attack needs a targetId.', source);
            if (!canTarget(unit, target, 'attack')) return rejectAction(state, action, 'That target is not hostile.', source);
            const distance = chebyshev(unit, target);
            if (!options.ignoreRange && distance > (Number(unit.attackRange) || 1)) {
                return rejectAction(state, action, `${target.name} is out of range (${distance} cells, range ${unit.attackRange}).`, source);
            }
            if (!options.ignoreLineOfSight && (Number(unit.attackRange) || 1) > 1 && !hasLineOfSight(state, unit, target)) {
                return rejectAction(state, action, 'Line of sight is blocked.', source);
            }
            return resolveAttack(state, unit, target, {
                rng,
                source,
                attackBonus: getEffectiveAttackBonus(state, unit),
                damage: unit.damage,
                resource: unit.attackResource,
                willpowerDamage: unit.willpowerDamage,
                willpowerOutcome: unit.attackWillpowerOutcome,
                label: 'attack',
                consumeAction: true,
            });
        }

        case 'skill': {
            const skill = findSkill(unit, action.skillId);
            if (!skill) return rejectAction(state, action, `Unknown skill "${action.skillId}".`, source);
            if (skill.kind === 'special') {
                return rejectAction(state, action, `${skill.name} requires special resolution by the combat agent.`, source);
            }
            if (skill.uses <= 0) return rejectAction(state, action, `${skill.name} has no uses left.`, source);
            const resourceKey = skill.bonusAction ? 'bonusUsed' : 'actionUsed';
            if (unit[resourceKey]) {
                return rejectAction(state, action, skill.bonusAction
                    ? `${unit.name} has already used a bonus action.`
                    : `${unit.name} has already used their action.`, source);
            }
            const wantsSelf = skill.target === 'self' || (skill.kind !== 'attack' && !action.targetId);
            const targetResult = wantsSelf ? { target: unit } : resolveTarget(state, unit, action, options);
            const target = targetResult.target;
            if (!target) return rejectAction(state, action, targetResult.error || `${skill.name} needs a target.`, source);
            if (!canTarget(unit, target, skill.kind)) {
                return rejectAction(state, action, `${skill.name} cannot target ${target.name}.`, source);
            }
            const distance = unit.id === target.id ? 0 : chebyshev(unit, target);
            if (!options.ignoreRange && distance > (Number(skill.range) || 1)) {
                return rejectAction(state, action, `${target.name} is out of ${skill.name}'s range (${distance} cells, range ${skill.range}).`, source);
            }
            if (!options.ignoreLineOfSight && skill.kind === 'attack' && (Number(skill.range) || 1) > 1 && !hasLineOfSight(state, unit, target)) {
                return rejectAction(state, action, 'Line of sight is blocked.', source);
            }
            unit[resourceKey] = true;
            skill.uses = Math.max(0, Number(skill.uses) - 1);
            if (skill.kind === 'attack') {
                return resolveAttack(state, unit, target, {
                    rng,
                    source,
                    attackBonus: getEffectiveAttackBonus(state, unit, skill.attackBonus),
                    damage: skill.damage || '1d6',
                    resource: skill.resource,
                    willpowerDamage: skill.willpowerDamage,
                    willpowerOutcome: skill.willpowerOutcome,
                    label: skill.name,
                    consumeAction: !skill.bonusAction,
                });
            }
            if (skill.kind === 'heal') {
                const heal = rollDice(skill.heal || '1d8+2', rng).total;
                if (skill.resource === 'both') {
                    healUnit(state, target, heal, skill.name, 'hp');
                    healUnit(state, target, heal, skill.name, 'willpower');
                } else {
                    healUnit(state, target, heal, skill.name, skill.resource);
                }
                addLog(state, 'skill', `${unit.name} uses ${skill.name} on ${target.name}.`, unit.id);
            } else {
                addStatus(target, {
                    id: slug(skill.name, 'buff'),
                    label: skill.name,
                    rounds: skill.rounds || 2,
                    acBonus: skill.acBonus,
                    attackBonus: skill.attackBonus,
                    description: skill.description,
                });
                addLog(state, 'skill', `${unit.name} uses ${skill.name} on ${target.name}.`, unit.id);
            }
            checkEncounterEnd(state);
            return { ok: true, log: `${skill.name} used.`, ended: state.status !== 'active' };
        }

        case 'item': {
            if (unit.actionUsed) return rejectAction(state, action, `${unit.name} has already used their action.`, source);
            const item = findItem(unit, action.itemId);
            if (!item) return rejectAction(state, action, `Unknown item "${action.itemId}".`, source);
            if (item.kind === 'special') {
                return rejectAction(state, action, `${item.name} requires special resolution by the combat agent.`, source);
            }
            if (item.uses <= 0) return rejectAction(state, action, `${item.name} has no uses left.`, source);
            const targetResult = action.targetId ? resolveTarget(state, unit, action, options) : { target: unit };
            const target = targetResult.target;
            if (!target) return rejectAction(state, action, targetResult.error || 'Item target is invalid.', source);
            const itemTarget = item.target || 'ally';
            if (itemTarget === 'ally' && !isFriendly(unit.side, target.side)) {
                return rejectAction(state, action, 'This item can only target allies.', source);
            }
            if (itemTarget === 'enemy' && !isHostile(unit.side, target.side)) {
                return rejectAction(state, action, 'This item can only target enemies.', source);
            }
            const distance = unit.id === target.id ? 0 : chebyshev(unit, target);
            if (distance > (Number(item.range) || 0)) {
                return rejectAction(state, action, `${target.name} is out of item range.`, source);
            }
            unit.actionUsed = true;
            item.uses = Math.max(0, Number(item.uses) - 1);
            if (item.kind === 'heal') {
                const amount = rollDice(item.amount || '2d4+2', rng).total;
                if (item.resource === 'both') {
                    healUnit(state, target, amount, item.name, 'hp');
                    healUnit(state, target, amount, item.name, 'willpower');
                } else {
                    healUnit(state, target, amount, item.name, item.resource);
                }
            } else {
                addStatus(target, { id: slug(item.name, 'item'), label: item.name, rounds: 2, description: item.description });
            }
            checkEncounterEnd(state);
            return { ok: true, log: `${item.name} used.`, ended: state.status !== 'active' };
        }

        case 'defend': {
            if (unit.actionUsed) return rejectAction(state, action, `${unit.name} has already used their action.`, source);
            unit.actionUsed = true;
            addStatus(unit, {
                id: 'defending',
                label: 'Defending',
                rounds: 1,
                acBonus: 4,
                description: '+4 AC until the next round.',
            });
            addLog(state, 'defend', `${unit.name} takes a defensive stance (+4 AC).`, unit.id);
            return { ok: true, log: 'Defending.' };
        }

        case 'wait': {
            unit.actionUsed = true;
            unit.doneForRound = true;
            addLog(state, 'wait', `${unit.name} waits.`, unit.id);
            return { ok: true, log: 'Waited.' };
        }

        case 'flee': {
            if (unit.fled || unit.defeated) return rejectAction(state, action, `${unit.name} cannot flee.`, source);
            if (state.rules?.allowFlee === false) return rejectAction(state, action, 'Fleeing is disabled for this encounter.', source);
            unit.fled = true;
            unit.doneForRound = true;
            addLog(state, 'flee', `${unit.name} flees the battlefield.`, unit.id);
            checkEncounterEnd(state);
            return { ok: true, log: 'Fled.', ended: state.status !== 'active' };
        }

        default:
            return rejectAction(state, action, `Unsupported action type "${action.type}".`, source);
    }
}

function openingNameMatch(candidate, wanted) {
    const left = String(candidate || '').trim().toLowerCase();
    const right = String(wanted || '').trim().toLowerCase();
    if (!left || !right) return false;
    return left === right || left.includes(right) || right.includes(left);
}

function findOpeningUnit(state, wanted, side) {
    const needle = String(wanted || '').trim();
    if (!needle) return null;
    return state.units.find(unit => unit.side === side && openingNameMatch(unit.name, needle)) || null;
}

/**
 * Mark the opposing side as surprised for the first round. The enemy loses its
 * first activation; normal turns resume in round 2.
 * @param {object} state
 * @param {'player'} [side]
 * @returns {boolean}
 */
export function applySurprise(state, side = 'player') {
    if (!state || state.status !== 'active') return false;
    if (side !== 'player') return false;
    const enemies = state.units.filter(unit => unit.side === 'enemy' && !unit.defeated && !unit.fled);
    if (!enemies.length) return false;
    if (Number(state.surprise?.remaining) > 0 && enemies.every(unit => unit.surprised)) return true;
    state.surprise = { remaining: 1, side: 'player' };
    for (const enemy of enemies) enemy.surprised = true;
    addLog(state, 'surprise', 'The enemy is caught off guard and loses their first activation.', null);
    if (state.turnStyle === 'phase') {
        state.phase = 'player';
    } else {
        state.turnIndex = 0;
        state.pendingAgentUnitIds = [];
        advanceTurnPointerToLiving(state);
        const active = getActiveUnit(state);
        state.phase = active && active.side !== 'player' ? 'enemy' : 'player';
    }
    return true;
}

/**
 * Resolve the player's declared pre-combat action on the freshly built board.
 * Ordinary attacks and parsed skills/items are deterministic and apply here.
 * Special/freeform effects return `requiresAgent: true` so the UI can invoke
 * the special resolver after the narrator generation has finished.
 *
 * @param {object} state
 * @param {object|string} opening
 * @param {{ rng?: () => number }} [options]
 * @returns {{ ok: boolean, requiresAgent?: boolean, actorId?: string, targetId?: string, skillId?: string, itemId?: string, ended?: boolean, error?: string }}
 */
export function applyOpeningAction(state, opening, options = {}) {
    if (!state || state.status !== 'active') return { ok: false, error: 'The encounter is already over.' };
    const request = typeof opening === 'string' ? { text: opening } : { ...(opening || {}) };
    const text = String(request.text || request.description || '').trim();
    if (!text) return { ok: false, error: 'No opening action was supplied.' };

    const players = state.units.filter(unit => unit.side === 'player' && !unit.defeated && !unit.fled);
    if (!players.length) return { ok: false, error: 'No player unit can perform the opening action.' };
    const actor = findOpeningUnit(state, request.actorName, 'player')
        || players.find(unit => text.toLowerCase().includes(String(unit.name || '').toLowerCase()))
        || players[0];
    const enemies = state.units.filter(unit => unit.side === 'enemy' && !unit.defeated && !unit.fled);
    const target = (request.targetId ? getUnitById(state, String(request.targetId)) : null)
        || findOpeningUnit(state, request.targetName, 'enemy')
        || (request.targetName ? findOpeningUnit(state, request.targetName, 'ally') : null)
        || enemies[0]
        || null;

    const inferSurprise = request.surprise === true
        || /\b(ambush|ambushes|surprise|surprised|sneak attack|from behind|caught off guard)\b/i.test(text);
    if (inferSurprise) applySurprise(state, 'player');

    const skill = (actor.skills || []).find(entry => {
        if (request.skillName && openingNameMatch(entry.name, request.skillName)) return true;
        return text.toLowerCase().includes(String(entry.name || '').toLowerCase());
    }) || null;
    const item = !skill ? (actor.items || []).find(entry => {
        if (request.itemName && openingNameMatch(entry.name, request.itemName)) return true;
        return text.toLowerCase().includes(String(entry.name || '').toLowerCase());
    }) || null : null;

    const looksFreeform = !skill && !item
        && /\b(cast|casting|spell|summon|summons|conjure|invoke|unleash|channel|ritual|scroll|wand|potion|vial)\b/i.test(text);
    if (skill?.kind === 'special' || item?.kind === 'special' || looksFreeform) {
        state.opening = {
            ...request,
            text,
            surprise: inferSurprise,
            resolved: false,
            requiresAgent: true,
            actorId: actor.id,
            targetId: target?.id || '',
            skillId: skill?.id || '',
            itemId: item?.id || '',
            log: '',
            error: '',
            resolvedAt: 0,
        };
        return {
            ok: false,
            requiresAgent: true,
            actorId: actor.id,
            targetId: target?.id || '',
            skillId: skill?.id || '',
            itemId: item?.id || '',
            error: 'The opening action needs special resolution.',
        };
    }

    let action;
    if (skill) {
        action = { type: 'skill', unitId: actor.id, skillId: skill.id, targetId: target?.id };
    } else if (item) {
        action = { type: 'item', unitId: actor.id, itemId: item.id, targetId: target?.id || actor.id };
    } else {
        if (!target || target.side === 'player') {
            return { ok: false, error: 'No hostile target was found for the opening action.' };
        }
        action = { type: 'attack', unitId: actor.id, targetId: target.id };
    }

    state.opening = {
        ...request,
        text,
        surprise: inferSurprise,
        resolved: false,
        actorId: actor.id,
        targetId: target?.id || '',
        skillId: skill?.id || '',
        itemId: item?.id || '',
        log: '',
        error: '',
        resolvedAt: 0,
    };
    const result = applyAction(state, action, {
        rng: options.rng || createStateRng(state),
        actorSide: 'player',
        source: 'opening',
        ignoreTurn: true,
        ignoreRange: true,
        ignoreLineOfSight: true,
    });
    state.opening = {
        ...request,
        text,
        surprise: inferSurprise,
        resolved: !!result.ok,
        actorId: actor.id,
        targetId: target?.id || '',
        skillId: skill?.id || '',
        itemId: item?.id || '',
        log: result.log || '',
        error: result.ok ? '' : (result.error || ''),
        resolvedAt: result.ok ? Date.now() : 0,
    };
    if (!result.ok) {
        addLog(state, 'opening', `Opening action could not be resolved: ${result.error || 'unknown error'}.`, actor.id);
        return { ok: false, actorId: actor.id, targetId: target?.id || '', error: result.error };
    }
    if (state.status !== 'active') {
        state.outcome = buildOutcomeSummary(state);
    }

    // A pre-combat action does not consume the first normal round's budget.
    actor.actionUsed = false;
    actor.bonusUsed = false;
    actor.doneForRound = false;
    actor.movementUsed = 0;
    addLog(
        state,
        'opening',
        `${actor.name} opens the fight: ${text}${target ? ` → ${target.name}` : ''}.`,
        actor.id,
    );
    return {
        ok: true,
        actorId: actor.id,
        targetId: target?.id || '',
        skillId: skill?.id || '',
        itemId: item?.id || '',
        ended: state.status !== 'active',
    };
}

function applyMove(state, unit, path, rng, source) {
    const cost = pathCost(state, path);
    const budget = Math.max(0, (Number(unit.speed) || TC_DEFAULT_MOVEMENT) - (Number(unit.movementUsed) || 0));
    if (cost > budget) {
        return rejectAction(state, { type: 'move', unitId: unit.id }, `Not enough movement (needs ${cost}, has ${budget}).`, source);
    }
    // Validate each step individually so the agent cannot tunnel through walls.
    let cursor = { x: unit.x, y: unit.y };
    for (const step of path) {
        if (!inBounds(state, step.x, step.y)) return rejectAction(state, { type: 'move', unitId: unit.id }, 'Path leaves the grid.', source);
        if (!isWalkableTerrain(state, step.x, step.y)) return rejectAction(state, { type: 'move', unitId: unit.id }, 'Path crosses impassable terrain.', source);
        if (chebyshev(cursor, step) !== 1) return rejectAction(state, { type: 'move', unitId: unit.id }, 'Path has a gap.', source);
        const occupant = state.units.find(other => other !== unit && !other.defeated && !other.fled
            && other.x === step.x && other.y === step.y);
        if (occupant) return rejectAction(state, { type: 'move', unitId: unit.id }, `${occupant.name} blocks the path.`, source);
        cursor = step;
    }
    const destination = path[path.length - 1];
    const from = { x: unit.x, y: unit.y };
    unit.x = destination.x;
    unit.y = destination.y;
    unit.movementUsed = Number(unit.movementUsed || 0) + cost;
    addLog(
        state,
        'move',
        `${unit.name} moves from (${from.x},${from.y}) to (${unit.x},${unit.y}) [${cost} movement, ${Math.max(0, unit.speed - unit.movementUsed)} left].`,
        unit.id,
    );
    void rng;
    return { ok: true, log: `Moved ${cost} cells.`, ended: false };
}

function rollDamagePool(expression, critical, rng) {
    const source = String(expression || '1d6');
    const base = rollDice(source, rng);
    let damage = base.total;
    if (critical) {
        const diceMatch = source.toLowerCase().match(/^(\d*)d(\d+)([+-]\d+)?$/);
        if (diceMatch) {
            damage += rollDice(`${diceMatch[1] || 1}d${diceMatch[2]}`, rng).total;
        } else {
            damage *= 2;
        }
    }
    return damage;
}

function resolveAttack(state, unit, target, options) {
    const rng = options.rng;
    const attackBonus = Number(options.attackBonus) || 0;
    const roll = rollDie(20, rng);
    const natural = roll;
    const total = roll + attackBonus;
    const ac = getEffectiveAc(state, target);
    const label = options.label || 'attack';
    const crit = natural === 20;
    const miss = natural === 1 || (!crit && total < ac);

    addLog(
        state,
        'attack',
        `${unit.name} uses ${label} on ${target.name}: d20(${roll}) + ${attackBonus} = ${total} vs AC ${ac}${crit ? ' — CRITICAL!' : miss ? ' — miss.' : ' — hit.'}`,
        unit.id,
    );

    if (miss) {
        if (options.consumeAction !== false) unit.actionUsed = true;
        checkEncounterEnd(state);
        return { ok: true, log: 'Missed.', ended: state.status !== 'active' };
    }

    const resource = normalizeWillpowerResource(options.resource, 'hp');
    let hpDamage = 0;
    let willpowerDamage = 0;
    if (resource === 'hp' || resource === 'both') {
        hpDamage = rollDamagePool(options.damage || unit.damage || '1d6', crit, rng);
        applyDamageToUnit(state, target, hpDamage, `${unit.name}'s ${label}`);
    }
    if ((resource === 'willpower' || resource === 'both') && !target.defeated) {
        const expression = options.willpowerDamage || options.damage || unit.willpowerDamage || '1d6';
        willpowerDamage = rollDamagePool(expression, crit, rng);
        applyWillpowerDamageToUnit(state, target, willpowerDamage, `${unit.name}'s ${label}`, {
            outcome: options.willpowerOutcome,
            casterId: unit.id,
        });
    }
    if (options.consumeAction !== false) unit.actionUsed = true;
    checkEncounterEnd(state);
    const parts = [];
    if (hpDamage) parts.push(`${hpDamage} HP`);
    if (willpowerDamage) parts.push(`${willpowerDamage} Willpower`);
    return { ok: true, log: parts.length ? `Hit for ${parts.join(' and ')}.` : 'Hit.', ended: state.status !== 'active' };
}

/**
 * Interpret a list of agent or player actions sequentially.
 * @param {object} state
 * @param {object[]} actions
 * @param {{ unitIds?: string[], actorSide?: 'player'|'agent', source?: string, rng?: () => number }} [options]
 * @returns {{ applied: object[], rejected: {action: object, error: string}[], ended: boolean, actedUnitIds: string[] }}
 */
export function interpretActions(state, actions, options = {}) {
    const allowed = Array.isArray(options.unitIds) && options.unitIds.length
        ? new Set(options.unitIds)
        : null;
    const rng = options.rng || createStateRng(state);
    /** @type {object[]} */
    const applied = [];
    /** @type {{action: object, error: string}[]} */
    const rejected = [];
    const actedUnitIds = [];

    for (const action of actions || []) {
        if (state.status !== 'active') break;
        if (allowed && !allowed.has(action.unitId)) {
            rejected.push({ action, error: `Unit "${action.unitId}" is not in the units-to-move list.` });
            continue;
        }
        const result = applyAction(state, action, {
            rng,
            actorSide: options.actorSide,
            source: options.source || 'agent',
        });
        if (result.ok) {
            applied.push(action);
            if (!actedUnitIds.includes(action.unitId)) actedUnitIds.push(action.unitId);
        } else {
            rejected.push({ action, error: result.error || 'Rejected.' });
        }
    }
    return { applied, rejected, ended: state.status !== 'active', actedUnitIds };
}

/**
 * Compact, model-friendly list of legal targets/reachable cells for a unit.
 * @param {object} state
 * @param {object} unit
 * @returns {{ reachableCells: string[], attackTargets: string[], skillTargets: Record<string,string[]> }}
 */
export function describeUnitOptions(state, unit) {
    const reachable = [...computeReachableCells(state, unit).keys()]
        .map(key => key.split(',').map(Number));
    const attackTargets = state.units
        .filter(target => target.id !== unit.id && !target.defeated && !target.fled && canTarget(unit, target, 'attack'))
        .filter(target => chebyshev(unit, target) <= (Number(unit.attackRange) || 1))
        .filter(target => (Number(unit.attackRange) || 1) <= 1 || hasLineOfSight(state, unit, target))
        .map(target => target.id);
    const skillTargets = {};
    for (const skill of unit.skills || []) {
        if (skill.uses <= 0) continue;
        const options = state.units
            .filter(target => !target.defeated && !target.fled)
            .filter(target => skill.kind === 'special' || canTarget(unit, target, skill.kind))
            .filter(target => (unit.id === target.id ? 0 : chebyshev(unit, target)) <= (Number(skill.range) || 1))
            .filter(target => skill.kind !== 'attack' || (Number(skill.range) || 1) <= 1 || hasLineOfSight(state, unit, target))
            .map(target => target.id);
        skillTargets[skill.id] = options;
    }
    return { reachableCells: reachable, attackTargets, skillTargets };
}

/**
 * Build the JSON payload sent to the combat agent (and downloadable from the
 * board). Player units are included for target/stat context; `unitsToMove` is
 * the authoritative list the agent may act for.
 * @param {object} state
 * @param {string[]} unitIds
 * @param {object[]} [catalog]
 * @returns {object}
 */
export function buildAgentGameState(state, unitIds, catalog = state.actionCatalog, options = {}) {
    const ids = Array.isArray(unitIds) ? unitIds : [];
    const compact = options.compact === true;
    const units = state.units.map(unit => {
        if (compact && unit.side === 'player') {
            return {
                id: unit.id,
                name: unit.name,
                side: unit.side,
                originalSide: unit.originalSide || unit.side,
                classLabel: unit.classLabel,
                x: unit.x,
                y: unit.y,
                hp: unit.hp,
                maxHp: unit.maxHp,
                willpower: unit.willpower,
                maxWillpower: unit.maxWillpower,
                willpowerBroken: !!unit.willpowerBroken,
                ac: getEffectiveAc(state, unit),
                statuses: (unit.statuses || []).map(status => ({ label: status.label, rounds: status.rounds, behavior: status.behavior, stacks: status.stacks })),
                inventory: (unit.inventory || []).slice(0, 20).map(entry => ({
                    name: entry.name,
                    equipped: !!entry.equipped,
                    section: entry.section || '',
                })),
                defeated: unit.defeated,
                fled: unit.fled,
            };
        }
        return {
        id: unit.id,
        name: unit.name,
        side: unit.side,
        originalSide: unit.originalSide || unit.side,
        sideChanged: !!unit.sideChanged,
        classLabel: unit.classLabel,
        x: unit.x,
        y: unit.y,
        hp: unit.hp,
        maxHp: unit.maxHp,
        willpower: unit.willpower,
        maxWillpower: unit.maxWillpower,
        willpowerSave: unit.willpowerSave,
        willpowerBroken: !!unit.willpowerBroken,
        willpowerOutcome: unit.willpowerOutcome || '',
        defeatedBy: unit.defeatCause || '',
        ac: getEffectiveAc(state, unit),
        attackBonus: getEffectiveAttackBonus(state, unit),
        attackRange: unit.attackRange,
        damage: unit.damage,
        attackResource: unit.attackResource || 'hp',
        willpowerDamage: unit.willpowerDamage || '',
        attackWillpowerOutcome: unit.attackWillpowerOutcome || 'defeat',
        speed: unit.speed,
        movementUsed: unit.movementUsed,
        movementLeft: Math.max(0, (Number(unit.speed) || 0) - (Number(unit.movementUsed) || 0)),
        actionUsed: unit.actionUsed,
        bonusUsed: unit.bonusUsed,
        defeated: unit.defeated,
        fled: unit.fled,
        defending: !!unit.defending || (unit.statuses || []).some(status => status.id === 'defending'),
        statuses: (unit.statuses || []).map(status => ({
            label: status.label,
            rounds: status.rounds,
            acBonus: status.acBonus,
            attackBonus: status.attackBonus,
            behavior: status.behavior || '',
            stacks: status.stacks || 1,
        })),
        stats: unit.stats,
        initiative: unit.initiative,
        skills: (unit.skills || []).map(skill => ({
            id: skill.id,
            name: skill.name,
            kind: skill.kind,
            resource: skill.resource || 'hp',
            range: skill.range,
            damage: skill.damage,
            willpowerDamage: skill.willpowerDamage || '',
            willpowerOutcome: skill.willpowerOutcome || 'defeat',
            heal: skill.heal,
            uses: skill.uses,
            maxUses: skill.maxUses,
            bonusAction: skill.bonusAction,
            description: skill.description,
            usable: true,
            resolvable: skill.kind === 'special',
        })),
        items: (unit.items || []).map(item => ({
            id: item.id,
            name: item.name,
            kind: item.kind,
            resource: item.resource || 'hp',
            target: item.target || 'ally',
            uses: item.uses,
            maxUses: item.maxUses,
            amount: item.amount,
            description: item.description,
            usable: true,
            resolvable: item.kind === 'special',
        })),
        ...(compact ? {} : {
            inventory: (unit.inventory || []).slice(0, 24).map(entry => ({
                name: entry.name,
                description: entry.description,
                equipped: !!entry.equipped,
                section: entry.section,
                rarity: entry.rarity,
                quantity: entry.quantity,
            })),
        }),
        notes: unit.notes,
        };
    });

    const unitsToMove = ids.map(id => {
        const unit = getUnitById(state, id);
        if (!unit) return null;
        const options = describeUnitOptions(state, unit);
        return {
            unitId: unit.id,
            name: unit.name,
            side: unit.side,
            reachableCells: options.reachableCells,
            attackTargets: options.attackTargets,
            skillTargets: options.skillTargets,
        };
    }).filter(Boolean);

    return {
        format: TC_STATE_FORMAT,
        version: TC_VERSION,
        encounter: {
            title: state.title,
            location: state.location,
            description: state.description,
            round: state.round,
            phase: state.phase,
            turnStyle: state.turnStyle,
        },
        grid: {
            rows: state.grid.rows,
            cols: state.grid.cols,
            coordinates: 'x = column, y = row, both 0-indexed',
            legend: Object.fromEntries(TC_TERRAIN_KEYS.map(id => [terrainChar(id), TC_TERRAIN[id].label])),
            terrain: state.terrain.map(row => row.map(id => terrainChar(id)).join('')),
        },
        rules: {
            movement: Number(state.rules?.movement) || TC_DEFAULT_MOVEMENT,
            allowFlee: state.rules?.allowFlee !== false,
            victory: 'Defeat every enemy unit.',
            defeat: 'All player units are defeated.',
            willpower: 'Willpower is a morale pool. Ordinary attacks target HP only. Skills/items with resource "willpower" or "both" damage it. At 0 Willpower the unit breaks according to willpowerOutcome. Willpower recovers after combat.',
            actions: describeActionCatalog(catalog),
            actionTypes: getEnabledActions(catalog).map(entry => entry.type),
        },
        units,
        unitsToMove,
        activationOrder: ids,
        recentLog: (state.log || []).slice(compact ? -8 : -12).map(entry => `R${entry.round} ${entry.type}: ${entry.text}`),
    };
}

/**
 * Pretty JSON for the board's "Export state" button.
 * @param {object} state
 * @param {string[]} [unitIds]
 * @returns {string}
 */
export function serializeAgentGameState(state, unitIds = []) {
    const ids = unitIds.length ? unitIds : getAgentControlledUnits(state).map(unit => unit.id);
    return JSON.stringify(buildAgentGameState(state, ids), null, 2);
}

// ── Encounter construction ───────────────────────────────────────────────────

/**
 * @param {{
 *   chatId?: string,
 *   title?: string,
 *   description?: string,
 *   location?: string,
 *   terrainTheme?: string,
 *   grid?: {rows:number, cols:number},
 *   terrainRows?: string[]|null,
 *   units?: object[],
 *   turnStyle?: string,
 *   movement?: number,
 *   density?: number,
 *   seed?: number,
 *   actionCatalog?: object[],
 *   encounterSource?: string,
 *   allowFlee?: boolean,
 * }} options
 * @returns {object}
 */
export function createEncounterState(options = {}) {
    const turnStyle = options.turnStyle === 'initiative' ? 'initiative' : 'phase';
    const rows = clampIntOr(options.grid?.rows, 15, TC_MIN_DIMENSION, TC_MAX_DIMENSION);
    const cols = clampIntOr(options.grid?.cols, 15, TC_MIN_DIMENSION, TC_MAX_DIMENSION);
    const seed = normalizeSeed(options.seed);
    const rng = makeRng(seed);
    const themeId = TC_TERRAIN_THEME_CONFIG[options.terrainTheme] ? options.terrainTheme : 'dungeon';
    const densityInput = options.density == null ? TC_DEFAULT_TERRAIN_DENSITY : options.density;
    const density = clampInt(densityInput, 0, 100);
    const decoded = decodeTerrainRows(options.terrainRows, rows, cols);
    const generated = decoded
        ? { rows, cols, terrain: decoded.terrain, theme: themeId }
        : createProceduralTerrain({ rows, cols, theme: themeId, density, seed });

    const units = (Array.isArray(options.units) ? options.units : [])
        .map((seedUnit, index) => normalizeUnitSeed(seedUnit, {
            index,
            side: seedUnit?.side || 'enemy',
            defaultSpeed: options.movement,
            willpowerMaxPercent: options.willpowerMaxPercent,
        }))
        .filter(Boolean);

    const seenIds = new Set();
    for (const unit of units) {
        let id = unit.id;
        let suffix = 2;
        while (seenIds.has(id)) {
            id = `${unit.id}-${suffix}`;
            suffix += 1;
        }
        unit.id = id;
        seenIds.add(id);
    }

    const state = {
        version: TC_VERSION,
        format: TC_STATE_FORMAT,
        id: `tc-${Date.now().toString(36)}-${Math.floor(rng() * 1e6).toString(36)}`,
        chatId: String(options.chatId || ''),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'active',
        title: String(options.title || 'Tactical encounter').slice(0, 140),
        description: String(options.description || '').slice(0, 4000),
        location: String(options.location || '').slice(0, 200),
        terrainTheme: generated.theme,
        turnStyle,
        grid: { rows: generated.rows, cols: generated.cols },
        terrain: generated.terrain,
        units,
        initiativeOrder: [],
        turnIndex: 0,
        round: 1,
        phase: 'player',
        pendingAgentUnitIds: [],
        surprise: null,
        opening: null,
        deployment: null,
        preparing: null,
        log: [],
        outcome: null,
        seed,
        rollCount: 0,
        rules: {
            movement: clampIntOr(options.movement, TC_DEFAULT_MOVEMENT, 1, 24),
            allowFlee: options.allowFlee !== false,
            willpowerMaxPercent: clampIntOr(options.willpowerMaxPercent, 30, 10, 60),
            victory: 'Defeat every enemy unit.',
            defeat: 'All player units are defeated.',
        },
        actionCatalog: Array.isArray(options.actionCatalog) && options.actionCatalog.length
            ? options.actionCatalog.map(entry => ({ ...entry }))
            : DEFAULT_TACTICAL_ACTION_CATALOG.map(entry => ({ ...entry })),
        encounterSource: String(options.encounterSource || 'local'),
        finalization: null,
    };

    placeUnits(state, state.units, rng);
    rollInitiative(state, rng);
    beginRound(state, rng, { initial: true });
    addLog(state, 'start', `${state.title} begins${state.location ? ` at ${state.location}` : ''}. ${state.units.length} combatants deployed.`, null);
    if (state.turnStyle === 'initiative') {
        const order = state.initiativeOrder
            .map(id => getUnitById(state, id))
            .filter(Boolean)
            .map(unit => `${unit.name} (${unit.initiative})`)
            .join(' → ');
        addLog(state, 'initiative', `Initiative: ${order}.`, null);
        const active = getActiveUnit(state);
        if (active && active.side !== 'player') {
            state.phase = 'enemy';
            state.pendingAgentUnitIds = collectConsecutiveAgentUnits(state);
        }
    }
    return state;
}

/**
 * Return the ids the UI should send to the agent right now.
 * @param {object} state
 * @returns {string[]}
 */
export function getPendingAgentUnitIds(state) {
    if (!state || state.status !== 'active' || state.deployment?.active || state.preparing?.active) return [];
    if (Array.isArray(state.pendingAgentUnitIds) && state.pendingAgentUnitIds.length) {
        return state.pendingAgentUnitIds.filter(id => {
            const unit = getUnitById(state, id);
            return unit && !unit.defeated && !unit.fled && !unit.doneForRound && !isStunned(unit) && !isSurprisedThisRound(state, unit);
        });
    }
    if (state.turnStyle === 'phase') {
        return state.phase === 'enemy'
            ? getAgentControlledUnits(state)
                .filter(unit => !isSurprisedThisRound(state, unit) && !unit.doneForRound && !isStunned(unit))
                .map(unit => unit.id)
            : [];
    }
    if (state.phase === 'enemy') {
        return collectConsecutiveAgentUnits(state);
    }
    return [];
}

/**
 * Hydrate a board saved before Willpower existed. Safe to call repeatedly.
 * @param {object} state
 * @returns {object}
 */
export function hydrateEncounterState(state) {
    if (!state || !Array.isArray(state.units)) return state;
    state.version = TC_VERSION;
    for (const unit of state.units) {
        unit.stats = unit.stats && typeof unit.stats === 'object' ? unit.stats : {};
        if (!Number.isFinite(Number(unit.willpowerSave))) {
            unit.willpowerSave = Number.isFinite(Number(unit.willSave ?? unit.stats.willSave))
                ? clampInt(unit.willSave ?? unit.stats.willSave, -10, 30)
                : 0;
        }
        if (!Number.isFinite(Number(unit.maxWillpower))) {
            const explicit = Number(unit.maxWill ?? unit.maxWillpower);
            unit.maxWillpower = Number.isFinite(explicit)
                ? clampInt(explicit, 0, 99)
                : deriveMaxWillpower(unit.maxHp, unit.stats.wisMod, unit.willpowerSave, state.rules?.willpowerMaxPercent);
        }
        if (!Number.isFinite(Number(unit.willpower))) {
            const explicit = Number(unit.will ?? unit.willpower);
            unit.willpower = Number.isFinite(explicit) ? clampInt(explicit, 0, unit.maxWillpower) : unit.maxWillpower;
        }
        unit.willpowerImmune = Number(unit.maxWillpower) === 0;
        unit.willpowerBroken = !!unit.willpowerBroken;
        const storedWillpowerOutcome = unit.willpowerOutcome ?? unit.willOutcome;
        unit.willpowerOutcome = storedWillpowerOutcome
            ? normalizeWillpowerOutcome(storedWillpowerOutcome, 'defeat')
            : '';
        if (!unit.willpowerOutcome && unit.willpowerBroken) unit.willpowerOutcome = 'defeat';
        unit.willpowerBreakSource = String(unit.willpowerBreakSource || '');
        unit.originalSide = unit.originalSide || unit.side;
        unit.sideChanged = !!unit.sideChanged;
        unit.defeatCause = unit.defeatCause || '';
        unit.incapacitated = !!unit.incapacitated;
        unit.surrendered = !!unit.surrendered;
        unit.transform = unit.transform && typeof unit.transform === 'object' ? unit.transform : null;
        unit.attackResource = normalizeWillpowerResource(unit.attackResource, 'hp');
        unit.willpowerDamage = String(unit.willpowerDamage ?? unit.willDamage ?? '');
        unit.attackWillpowerOutcome = normalizeWillpowerOutcome(unit.attackWillpowerOutcome ?? unit.willOutcome, 'defeat');
        unit.statuses = (Array.isArray(unit.statuses) ? unit.statuses : []).map(status => normalizeStatus(status)).filter(Boolean);
        unit.skills = (Array.isArray(unit.skills) ? unit.skills : []).map((skill, index) => normalizeSkill(skill, index, unit.side)).filter(Boolean);
        unit.items = (Array.isArray(unit.items) ? unit.items : []).map((item, index) => normalizeItem(item, index)).filter(Boolean);
    }
    return state;
}
