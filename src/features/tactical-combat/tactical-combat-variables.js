/**
 * tactical-combat-variables.js — deterministic battlefield variables and
 * variable-scaled formulas for tactical and traditional combat.
 *
 * The same engine powers both modes, so this module deliberately has no DOM or
 * framework imports. Expressions are evaluated live against the encounter
 * state: `@enemies`, `@outnumbered`, `@missingHpPct`, and the other supported
 * tokens are replaced with numbers before dice are rolled.
 */

const FRIENDLY_SIDES = new Set(['player', 'ally']);

const VARIABLE_ALIASES = new Map();
const CANONICAL_VARIABLES = [
    'enemies',
    'outnumbered',
    'allies',
    'alliesIncludingSelf',
    'adjacentEnemies',
    'nearbyEnemies',
    'adjacentAllies',
    'round',
    'missingHp',
    'missingHpPct',
    'missingHpTens',
    'hpPct',
    'targetMissingHpPct',
    'targetHpPct',
    'casterLevel',
    'level',
    'targetStacks',
];

function normalizeVariableKey(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/^@/, '')
        .replace(/[\s_-]+/g, '');
}

for (const canonical of CANONICAL_VARIABLES) {
    VARIABLE_ALIASES.set(normalizeVariableKey(canonical), canonical);
}

for (const alias of [
    ['enemy', 'enemies'],
    ['enemycount', 'enemies'],
    ['livingEnemies', 'enemies'],
    ['livingenemycount', 'enemies'],
    ['allies', 'allies'],
    ['allycount', 'allies'],
    ['livingAllies', 'allies'],
    ['livingallycount', 'allies'],
    ['adjacentenemy', 'adjacentEnemies'],
    ['nearbyenemy', 'nearbyEnemies'],
    ['adjacentally', 'adjacentAllies'],
    ['combatRound', 'round'],
    ['missinghp', 'missingHp'],
    ['missinghp%', 'missingHpPct'],
    ['missinghppercent', 'missingHpPct'],
    ['missinghptens', 'missingHpTens'],
    ['hp%', 'hpPct'],
    ['hppct', 'hpPct'],
    ['hpPercent', 'hpPct'],
    ['unitHpPct', 'hpPct'],
    ['ownerHpPct', 'hpPct'],
    ['selfHpPct', 'hpPct'],
    ['casterHpPct', 'hpPct'],
    ['targetHpPct', 'targetHpPct'],
    ['targetHp%', 'targetHpPct'],
    ['targetMissingHp%', 'targetMissingHpPct'],
    ['targetMissingHpPercent', 'targetMissingHpPct'],
    ['casterlevel', 'casterLevel'],
    ['unitLevel', 'level'],
    ['targetstacks', 'targetStacks'],
    ['targetStacks', 'targetStacks'],
]) {
    VARIABLE_ALIASES.set(normalizeVariableKey(alias[0]), alias[1]);
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function numberOr(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function isFriendlySide(attackerSide, targetSide) {
    return attackerSide === targetSide
        || (FRIENDLY_SIDES.has(attackerSide) && FRIENDLY_SIDES.has(targetSide));
}

function isHostileSide(attackerSide, targetSide) {
    return (FRIENDLY_SIDES.has(attackerSide) && targetSide === 'enemy')
        || (attackerSide === 'enemy' && FRIENDLY_SIDES.has(targetSide));
}

function livingCombatants(state) {
    return (Array.isArray(state?.units) ? state.units : [])
        .filter(unit => unit && !unit.defeated && !unit.fled);
}

function hasGridPosition(unit) {
    return Number.isFinite(Number(unit?.x)) && Number.isFinite(Number(unit?.y));
}

function withinCells(a, b, radius) {
    if (!hasGridPosition(a) || !hasGridPosition(b)) return false;
    const dx = Math.abs(Number(a.x) - Number(b.x));
    const dy = Math.abs(Number(a.y) - Number(b.y));
    return Math.max(dx, dy) <= radius;
}

function statusStacks(target, statusId) {
    const wanted = String(statusId || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const statuses = Array.isArray(target?.statuses) ? target.statuses : [];
    if (!statuses.length) return 0;
    if (!wanted) {
        return statuses.reduce((max, status) => Math.max(max, Math.max(1, Number(status?.stacks) || 1)), 0);
    }
    const match = statuses.find(status => {
        const id = String(status?.id || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const label = String(status?.label || status?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return id === wanted || label === wanted || id.includes(wanted) || label.includes(wanted);
    });
    return match ? Math.max(1, Number(match.stacks) || 1) : 0;
}

/**
 * @param {string} value
 * @returns {string} canonical variable name, or ''
 */
export function canonicalCombatVariable(value) {
    return VARIABLE_ALIASES.get(normalizeVariableKey(value)) || '';
}

/**
 * Resolve the live value of one supported variable.
 * @param {string} name
 * @param {object} context
 * @returns {number}
 */
export function resolveCombatVariable(name, context) {
    const canonical = canonicalCombatVariable(name);
    if (!canonical) return 0;
    return numberOr(context?.[canonical], 0);
}

/**
 * Build the live variable bag for one caster/unit and optional target.
 *
 * @param {object} state
 * @param {{ unit?: object, caster?: object, target?: object, statusId?: string, status?: string, side?: string }} [options]
 * @returns {object}
 */
export function buildCombatVariableContext(state, options = {}) {
    const unit = options.unit || options.caster || null;
    const target = options.target || null;
    const side = String(unit?.side || options.side || 'player');
    const living = livingCombatants(state);
    const hostiles = living.filter(other => other !== unit && isHostileSide(side, other.side));
    const friendlies = living.filter(other => other !== unit && isFriendlySide(side, other.side));
    const theater = !state?.grid || state?.theater === true;

    const adjacentEnemies = theater
        ? Math.max(1, hostiles.length)
        : hostiles.filter(other => withinCells(unit, other, 1)).length;
    const nearbyEnemies = theater
        ? Math.max(1, hostiles.length)
        : hostiles.filter(other => withinCells(unit, other, 2)).length;
    const adjacentAllies = theater
        ? friendlies.length
        : friendlies.filter(other => withinCells(unit, other, 1)).length;

    const maxHp = Math.max(0, numberOr(unit?.maxHp, 0));
    const hp = Math.max(0, numberOr(unit?.hp, 0));
    const missingHp = Math.max(0, maxHp - hp);
    const missingHpPct = maxHp > 0 ? Math.round((missingHp / maxHp) * 100) : 0;
    const targetMaxHp = Math.max(0, numberOr(target?.maxHp, 0));
    const targetHp = Math.max(0, numberOr(target?.hp, 0));
    const targetMissingHpPct = targetMaxHp > 0
        ? Math.round(((Math.max(0, targetMaxHp - targetHp)) / targetMaxHp) * 100)
        : 0;

    return {
        enemies: hostiles.length,
        outnumbered: Math.max(0, hostiles.length - friendlies.length),
        allies: friendlies.length,
        alliesIncludingSelf: friendlies.length + (FRIENDLY_SIDES.has(side) ? 1 : 0),
        adjacentEnemies,
        nearbyEnemies,
        adjacentAllies,
        round: Math.max(0, numberOr(state?.round, 0)),
        missingHp,
        missingHpPct,
        missingHpTens: Math.floor(missingHpPct / 10),
        hpPct: Math.max(0, Math.min(100, 100 - missingHpPct)),
        targetMissingHpPct,
        targetHpPct: Math.max(0, Math.min(100, 100 - targetMissingHpPct)),
        casterLevel: Math.max(0, numberOr(unit?.level, 0)),
        level: Math.max(0, numberOr(unit?.level, 0)),
        targetStacks: statusStacks(target, options.statusId || options.status || ''),
    };
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const VARIABLE_TOKEN_RX = new RegExp(
    `@(${[...VARIABLE_ALIASES.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})`,
    'gi',
);

/**
 * Replace @variable tokens with their live numeric values.
 * @param {string} expression
 * @param {object} context
 * @returns {string}
 */
export function interpolateCombatVariables(expression, context) {
    return String(expression ?? '').replace(VARIABLE_TOKEN_RX, (match, token) => {
        const canonical = canonicalCombatVariable(token);
        return canonical ? String(resolveCombatVariable(canonical, context)) : match;
    });
}

function rollDiceGroup(count, sides, rng) {
    const safeCount = Math.max(1, Math.min(20, Number(count) || 1));
    const safeSides = Math.max(2, Math.min(1000, Number(sides) || 6));
    const rolls = [];
    for (let index = 0; index < safeCount; index += 1) {
        rolls.push(1 + Math.floor(rng() * safeSides));
    }
    return rolls;
}

function tokenizeArithmetic(source) {
    const tokens = [];
    let index = 0;
    while (index < source.length) {
        const char = source[index];
        if (/\s/.test(char)) {
            index += 1;
            continue;
        }
        if (/[0-9.]/.test(char)) {
            let end = index;
            while (end < source.length && /[0-9.]/.test(source[end])) end += 1;
            const value = Number(source.slice(index, end));
            if (!Number.isFinite(value)) return null;
            tokens.push({ type: 'number', value });
            index = end;
            continue;
        }
        if ('+-*/()'.includes(char)) {
            tokens.push({ type: char });
            index += 1;
            continue;
        }
        return null;
    }
    return tokens;
}

function evaluateArithmetic(source) {
    const tokens = tokenizeArithmetic(String(source || ''));
    if (!tokens || !tokens.length) return null;
    let index = 0;
    const peek = () => tokens[index];
    const take = () => tokens[index++];

    const parseFactor = () => {
        const token = peek();
        if (!token) return null;
        if (token.type === '+' || token.type === '-') {
            take();
            const value = parseFactor();
            if (value == null) return null;
            return token.type === '-' ? -value : value;
        }
        if (token.type === 'number') {
            take();
            return token.value;
        }
        if (token.type === '(') {
            take();
            const value = parseExpression();
            if (value == null || !peek() || peek().type !== ')') return null;
            take();
            return value;
        }
        return null;
    };

    const parseTerm = () => {
        let value = parseFactor();
        if (value == null) return null;
        while (peek() && (peek().type === '*' || peek().type === '/')) {
            const op = take().type;
            const right = parseFactor();
            if (right == null) return null;
            if (op === '/') value = right === 0 ? 0 : value / right;
            else value *= right;
        }
        return value;
    };

    const parseExpression = () => {
        let value = parseTerm();
        if (value == null) return null;
        while (peek() && (peek().type === '+' || peek().type === '-')) {
            const op = take().type;
            const right = parseTerm();
            if (right == null) return null;
            value = op === '+' ? value + right : value - right;
        }
        return value;
    };

    const value = parseExpression();
    if (value == null || index !== tokens.length) return null;
    return value;
}

/**
 * Evaluate a combat formula with @variables and dice terms. Supports
 * `1d8 + @enemies`, `1d6 * @outnumbered`, and `@adjacentEnemiesd6`.
 * Invalid formulas return zero instead of throwing.
 *
 * @param {string|number} expression
 * @param {object} context live variable bag
 * @param {(() => number)|null} [rng]
 * @returns {{ total: number, diceTotal: number, rolls: number[], expression: string, resolved: string }}
 */
export function evaluateCombatFormula(expression, context, rng = Math.random) {
    const source = String(expression ?? '').trim();
    if (!source) return { total: 0, diceTotal: 0, rolls: [], expression: source, resolved: '' };
    if (/^[+-]?\d+(?:\.\d+)?$/.test(source)) {
        const flat = Math.trunc(Number(source));
        return { total: flat, diceTotal: 0, rolls: [], expression: source, resolved: source };
    }

    const interpolated = interpolateCombatVariables(source, context);
    const rolls = [];
    let diceTotal = 0;
    const resolved = interpolated.replace(/(\d*)d(\d+)/gi, (match, count, sides) => {
        const group = rollDiceGroup(count || 1, sides, rng);
        rolls.push(...group);
        diceTotal += group.reduce((sum, roll) => sum + roll, 0);
        return String(group.reduce((sum, roll) => sum + roll, 0));
    });
    const value = evaluateArithmetic(resolved);
    if (value == null) {
        return { total: 0, diceTotal: 0, rolls: [], expression: source, resolved };
    }
    const total = Math.round(value);
    return {
        total,
        diceTotal,
        rolls,
        expression: source,
        resolved,
    };
}

/**
 * Convenience wrapper that builds the variable bag and evaluates a formula.
 * @param {object} state
 * @param {string|number} expression
 * @param {object} [options] buildCombatVariableContext options plus `rng`
 * @returns {{ total: number, diceTotal: number, rolls: number[], expression: string, resolved: string }}
 */
export function rollCombatExpression(state, expression, options = {}) {
    const context = buildCombatVariableContext(state, options);
    return evaluateCombatFormula(expression, context, options.rng || Math.random);
}

/**
 * Normalize a structured condition block.
 * @param {any} raw
 * @returns {{ variable: string, op: string, value: number, statusId?: string }|null}
 */
export function normalizeCombatCondition(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const variable = canonicalCombatVariable(raw.variable ?? raw.var ?? raw.name);
    if (!variable) return null;
    const opRaw = String(raw.op ?? raw.operator ?? 'gte').toLowerCase();
    const op = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', '==', '!=', '>', '>=', '<', '<='].includes(opRaw)
        ? opRaw
        : 'gte';
    const condition = {
        variable,
        op: op === '==' ? 'eq' : op === '!=' ? 'neq' : op === '>' ? 'gt' : op === '>=' ? 'gte' : op === '<' ? 'lt' : op === '<=' ? 'lte' : op,
        value: numberOr(raw.value ?? raw.threshold, 0),
    };
    const statusId = raw.statusId ?? raw.status;
    if (statusId != null) condition.statusId = String(statusId).slice(0, 60);
    return condition;
}

/**
 * @param {any} condition
 * @param {object} context
 * @returns {boolean}
 */
export function combatConditionMet(condition, context) {
    const normalized = normalizeCombatCondition(condition);
    if (!normalized) return true;
    const left = resolveCombatVariable(normalized.variable, context);
    const right = normalized.value;
    switch (normalized.op) {
        case 'gt': return left > right;
        case 'lt': return left < right;
        case 'lte': return left <= right;
        case 'eq': return left === right;
        case 'neq': return left !== right;
        case 'gte':
        default: return left >= right;
    }
}

/**
 * Normalize a structured scale block.
 * @param {any} raw
 * @returns {object|null}
 */
export function normalizeCombatScale(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const variable = canonicalCombatVariable(raw.variable ?? raw.var ?? raw.name);
    if (!variable) return null;
    const scale = {
        variable,
        per: clampNumber(raw.per ?? raw.every ?? 1, 0.1, 1000, 1),
        min: Math.round(clampNumber(raw.min, 0, 100, 0)),
        max: Math.round(clampNumber(raw.max, 0, 100, 20)),
    };
    for (const key of ['damage', 'heal', 'amount']) {
        if (raw[key] != null) scale[key] = String(raw[key]).slice(0, 40);
    }
    for (const key of ['attackBonus', 'acBonus', 'damageBonus', 'damageReduction', 'rounds', 'stacks', 'maxStacks', 'limit', 'healRatio']) {
        if (raw[key] == null) continue;
        const value = Number(raw[key]);
        if (!Number.isFinite(value)) continue;
        scale[key] = key === 'healRatio'
            ? Math.max(0, Math.min(1, value))
            : Math.round(value);
    }
    const statusId = raw.statusId ?? raw.status;
    if (statusId != null) scale.statusId = String(statusId).slice(0, 60);
    return scale;
}

/**
 * Compute how many scale steps are active in the current context.
 * @param {object} scale
 * @param {object} context
 * @returns {number}
 */
export function evaluateCombatScale(scale, context) {
    const normalized = normalizeCombatScale(scale);
    if (!normalized) return 0;
    const value = resolveCombatVariable(normalized.variable, context);
    const per = normalized.per > 0 ? normalized.per : 1;
    const steps = Math.floor(value / per);
    return Math.max(normalized.min, Math.min(normalized.max, steps));
}

function joinScaledExpression(base, perStep, steps) {
    const baseText = String(base ?? '').trim();
    const stepText = String(perStep ?? '').trim();
    if (!steps || !stepText) return baseText;
    if (!baseText) return `${steps} * (${stepText})`;
    return `${baseText} + ${steps} * (${stepText})`;
}

/**
 * Bake a non-status effect's scale into concrete formulas/numbers. Status
 * effects keep their scale so the engine can evaluate it live every time.
 * @param {object} effect
 * @param {object} context
 * @returns {object|null}
 */
export function applyCombatScaleToEffect(effect, context) {
    if (!effect || typeof effect !== 'object') return null;
    const scale = normalizeCombatScale(effect.scale);
    if (!scale) return { ...effect };
    const steps = evaluateCombatScale(scale, context);
    const next = { ...effect };
    for (const key of ['damage', 'heal', 'amount']) {
        if (scale[key] == null) continue;
        const targetKey = (key === 'damage' || key === 'heal')
            && next[key] == null
            && next.amount != null
            ? 'amount'
            : key;
        next[targetKey] = joinScaledExpression(next[targetKey], scale[key], steps);
    }
    for (const key of ['attackBonus', 'acBonus', 'damageBonus', 'damageReduction', 'rounds', 'stacks', 'maxStacks', 'limit']) {
        if (scale[key] == null) continue;
        next[key] = numberOr(next[key], 0) + numberOr(scale[key], 0) * steps;
    }
    if (scale.healRatio != null) {
        next.healRatio = numberOr(next.healRatio, 0) + numberOr(scale.healRatio, 0) * steps;
    }
    return next;
}

/**
 * Human-readable condition text for prompts/debugging.
 * @param {any} raw
 * @returns {string}
 */
export function describeCombatCondition(raw) {
    const condition = normalizeCombatCondition(raw);
    if (!condition) return '';
    const op = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=', neq: '!=' }[condition.op] || '>=';
    return `${condition.variable} ${op} ${condition.value}`;
}

export { CANONICAL_VARIABLES as COMBAT_VARIABLES };
