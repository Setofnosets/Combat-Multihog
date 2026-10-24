/**
 * tactical-combat-constants.js — static Tactical Combat data.
 *
 * This module is intentionally dependency-free so the pure engine, the agent
 * prompt builder, and the board markup can share exactly the same terrain and
 * action definitions without pulling in SillyTavern state.
 */

export const TC_VERSION = 2;
export const TC_STATE_FORMAT = 'multihog-tactical-combat';
export const TC_MAX_LOG_ENTRIES = 240;

/** Grid presets exposed in settings. `rows`/`cols` are null for computed modes. */
export const TC_GRID_PRESETS = [
    { id: '10x10', label: '10 x 10 — Skirmish', rows: 10, cols: 10 },
    { id: '15x15', label: '15 x 15 — Standard', rows: 15, cols: 15 },
    { id: '20x20', label: '20 x 20 — Battlefield', rows: 20, cols: 20 },
    { id: 'dynamic', label: 'Dynamic — scales to combatants', rows: null, cols: null },
    { id: 'custom', label: 'Custom size…', rows: null, cols: null },
];

export const TC_TURN_STYLES = [
    { id: 'phase', label: 'Phased — move every allied unit, then the enemy phase' },
    { id: 'initiative', label: 'Initiative — one unit acts at a time in initiative order' },
];

export const TC_ENCOUNTER_SOURCES = [
    { id: 'auto', label: 'Auto — reuse active [COMBAT], otherwise ask the agent' },
    { id: 'existing', label: 'Existing [COMBAT] only' },
    { id: 'agent', label: 'Always ask the combat agent to design a new encounter' },
];

export const TC_TERRAIN_THEMES = [
    { id: 'auto', label: 'Auto — match the current location' },
    { id: 'dungeon', label: 'Dungeon' },
    { id: 'forest', label: 'Forest / wilds' },
    { id: 'cave', label: 'Cave / crypt' },
    { id: 'city', label: 'City / streets' },
    { id: 'interior', label: 'Interior / tavern' },
    { id: 'plain', label: 'Open plain' },
];

/**
 * Terrain catalogue. Colours are deliberately distinct in both light and dark
 * chat themes and are paired with a glyph + legend label (never colour alone).
 */
export const TC_TERRAIN = {
    floor: {
        id: 'floor',
        label: 'Open floor',
        glyph: '·',
        color: '#3c4652',
        textColor: '#dbe4ee',
        walkable: true,
        moveCost: 1,
        cover: 0,
        attackBonus: 0,
        blocksLos: false,
        description: 'Clear ground. Normal movement.',
    },
    grass: {
        id: 'grass',
        label: 'Grass / scrub',
        glyph: '"',
        color: '#3d5a3d',
        textColor: '#dcefd8',
        walkable: true,
        moveCost: 1,
        cover: 0,
        attackBonus: 0,
        blocksLos: false,
        description: 'Open ground. Normal movement.',
    },
    rubble: {
        id: 'rubble',
        label: 'Rubble (difficult)',
        glyph: '▲',
        color: '#6b5a45',
        textColor: '#f2e5d2',
        walkable: true,
        moveCost: 2,
        cover: 0,
        attackBonus: 0,
        blocksLos: false,
        description: 'Difficult terrain. Each cell costs 2 movement.',
    },
    water: {
        id: 'water',
        label: 'Water (impassable)',
        glyph: '≈',
        color: '#2b567a',
        textColor: '#d7ecff',
        walkable: false,
        moveCost: 1,
        cover: 0,
        attackBonus: 0,
        blocksLos: false,
        description: 'Too deep to cross. Impassable and blocks movement.',
    },
    wall: {
        id: 'wall',
        label: 'Wall / rock',
        glyph: '■',
        color: '#20242c',
        textColor: '#b9c3cf',
        walkable: false,
        moveCost: 1,
        cover: 0,
        attackBonus: 0,
        blocksLos: true,
        description: 'Impassable and blocks line of sight.',
    },
    cover: {
        id: 'cover',
        label: 'Cover (+2 AC)',
        glyph: '◈',
        color: '#7a6a3a',
        textColor: '#fff2c7',
        walkable: true,
        moveCost: 1,
        cover: 2,
        attackBonus: 0,
        blocksLos: false,
        description: 'Crates, pillars, or boulders. +2 AC while standing here.',
    },
    high: {
        id: 'high',
        label: 'High ground (+1 atk)',
        glyph: '↑',
        color: '#7a522f',
        textColor: '#ffe6c9',
        walkable: true,
        moveCost: 2,
        cover: 0,
        attackBonus: 1,
        blocksLos: false,
        description: 'Elevated ground. Costs 2 movement; +1 to attack rolls from here.',
    },
    hazard: {
        id: 'hazard',
        label: 'Hazard (1d4)',
        glyph: '✶',
        color: '#8f3328',
        textColor: '#ffd7d0',
        walkable: true,
        moveCost: 1,
        cover: 0,
        attackBonus: 0,
        blocksLos: false,
        description: 'Fire, acid, or spikes. 1d4 damage at the start of each round spent here.',
    },
    objective: {
        id: 'objective',
        label: 'Objective',
        glyph: '◆',
        color: '#5c467f',
        textColor: '#e8dcff',
        walkable: true,
        moveCost: 1,
        cover: 0,
        attackBonus: 0,
        blocksLos: false,
        description: 'A tactical objective. Holding it is narrative flavour.',
    },
};

export const TC_TERRAIN_KEYS = Object.keys(TC_TERRAIN);

/** Single-character terrain map used by agent-authored terrain rows. */
export const TC_TERRAIN_CHARS = {
    '.': 'floor',
    ',': 'grass',
    '#': 'wall',
    '~': 'water',
    'o': 'cover',
    '^': 'high',
    'x': 'hazard',
    '*': 'objective',
    '%': 'rubble',
};

export const TC_TERRAIN_CHAR_BY_ID = Object.fromEntries(
    Object.entries(TC_TERRAIN_CHARS).map(([char, id]) => [id, char]),
);

/** Theme base terrain plus weighted obstacle pools for procedural maps. */
export const TC_TERRAIN_THEME_CONFIG = {
    dungeon: {
        label: 'Dungeon',
        base: 'floor',
        pools: { wall: 4, rubble: 4, water: 1, cover: 2, high: 1, hazard: 1, objective: 1 },
    },
    forest: {
        label: 'Forest',
        base: 'grass',
        pools: { rubble: 3, water: 2, cover: 5, high: 2, hazard: 1, wall: 1, objective: 1 },
    },
    cave: {
        label: 'Cave',
        base: 'floor',
        pools: { wall: 4, rubble: 4, water: 2, cover: 2, high: 2, hazard: 2, objective: 1 },
    },
    city: {
        label: 'City',
        base: 'floor',
        pools: { wall: 4, rubble: 2, cover: 3, high: 2, water: 0, hazard: 1, objective: 2 },
    },
    interior: {
        label: 'Interior',
        base: 'floor',
        pools: { wall: 3, rubble: 1, cover: 4, high: 0, water: 0, hazard: 1, objective: 2 },
    },
    plain: {
        label: 'Open plain',
        base: 'grass',
        pools: { rubble: 2, water: 2, cover: 2, high: 3, hazard: 0, wall: 0, objective: 1 },
    },
};

export const TC_SIDE_LABELS = {
    player: 'Player',
    enemy: 'Enemy',
    ally: 'Ally',
};

export const TC_SIDE_COLORS = {
    player: '#3f8cff',
    ally: '#2fb98a',
    enemy: '#e05252',
};

export const TC_UNIT_COLORS = ['#5aa9ff', '#ffb347', '#6fd08c', '#c58cff', '#ff7b7b', '#53d4e0'];

export const TC_DEFAULT_GRID_PRESET = '15x15';
export const TC_DEFAULT_TURN_STYLE = 'phase';
export const TC_DEFAULT_TERRAIN_THEME = 'auto';
export const TC_DEFAULT_TERRAIN_DENSITY = 35;
export const TC_DEFAULT_MOVEMENT = 6;
export const TC_DEFAULT_MAX_TOKENS = 6000;
export const TC_MIN_DIMENSION = 5;
export const TC_MAX_DIMENSION = 40;
export const TC_DYNAMIC_MIN = 8;
export const TC_DYNAMIC_MAX = 24;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(value, min, max) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return min;
    return Math.max(min, Math.min(max, parsed));
}

/**
 * Like clampInt, but an absent/non-numeric value uses a real fallback instead
 * of the range minimum. Use this for every optional setting/stat field.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampIntOr(value, fallback, min, max) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

/**
 * Resolve configured grid dimensions. Dynamic mode scales with the roster so
 * large parties still get room to maneuver.
 *
 * @param {{ tacticalCombatGridPreset?: string, tacticalCombatGridRows?: number, tacticalCombatGridCols?: number }} settings
 * @param {number} [unitCount]
 * @returns {{ rows: number, cols: number, mode: string }}
 */
export function resolveGridDimensions(settings, unitCount = 4) {
    const presetId = String(settings?.tacticalCombatGridPreset || TC_DEFAULT_GRID_PRESET);
    const preset = TC_GRID_PRESETS.find(entry => entry.id === presetId) || TC_GRID_PRESETS[1];
    if (preset.rows && preset.cols) {
        return { rows: preset.rows, cols: preset.cols, mode: preset.id };
    }
    if (preset.id === 'custom') {
        return {
            rows: clampIntOr(settings?.tacticalCombatGridRows, 15, TC_MIN_DIMENSION, TC_MAX_DIMENSION),
            cols: clampIntOr(settings?.tacticalCombatGridCols, 15, TC_MIN_DIMENSION, TC_MAX_DIMENSION),
            mode: 'custom',
        };
    }
    // Dynamic: 8 minimum, 24 maximum. 8 cells per combatant leaves tactical room.
    const units = Math.max(2, Number(unitCount) || 4);
    const size = clampInt(Math.ceil(Math.sqrt(units * 8)), TC_DYNAMIC_MIN, TC_DYNAMIC_MAX);
    return { rows: size, cols: size, mode: 'dynamic' };
}

/**
 * Convert a terrain id into its legend char, defaulting to floor.
 * @param {string} id
 * @returns {string}
 */
export function terrainChar(id) {
    return TC_TERRAIN_CHAR_BY_ID[id] || '.';
}

/**
 * Shape of an action catalogue entry sent to the agent and shown in the UI.
 * `type` is intentionally a fixed vocabulary: the engine interprets only these.
 */
export const TC_ACTION_TYPES = ['move', 'attack', 'skill', 'item', 'defend', 'wait', 'flee'];

export const DEFAULT_TACTICAL_ACTION_CATALOG = [
    {
        type: 'move',
        label: 'Move',
        enabled: true,
        description: 'Move up to your remaining movement. You may move before or after your action.',
    },
    {
        type: 'attack',
        label: 'Attack',
        enabled: true,
        description: 'Make one weapon or cantrip attack against a target in range.',
    },
    {
        type: 'skill',
        label: 'Use Skill',
        enabled: true,
        description: 'Spend a listed ability or spell. Bonus-action skills do not consume your main action.',
    },
    {
        type: 'item',
        label: 'Use Item',
        enabled: true,
        description: 'Use a consumable such as a healing potion. Consumes your main action.',
    },
    {
        type: 'defend',
        label: 'Defend',
        enabled: true,
        description: '+4 AC until the start of your next turn. Consumes your main action.',
    },
    {
        type: 'wait',
        label: 'Wait',
        enabled: true,
        description: 'End this unit\'s turn without taking an action.',
    },
    {
        type: 'flee',
        label: 'Flee',
        enabled: true,
        description: 'Leave the battlefield. If every player unit flees, combat ends in retreat.',
    },
];

export const DEFAULT_TACTICAL_ACTION_CATALOG_JSON = JSON.stringify(
    DEFAULT_TACTICAL_ACTION_CATALOG,
    null,
    2,
);
