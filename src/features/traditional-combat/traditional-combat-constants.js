/**
 * traditional-combat-constants.js — static data for the no-grid combat mode.
 *
 * Traditional combat deliberately has no movement action. The shared tactical
 * engine still powers attack/skill/item/defend/wait/flee resolution; the action
 * catalogue is the contract that keeps `move` out of this mode.
 */

export const TRADITIONAL_VERSION = 1;
export const TRADITIONAL_STATE_FORMAT = 'multihog-traditional-combat';
export const TRADITIONAL_MAX_LOG_ENTRIES = 240;

export const TRADITIONAL_TURN_STYLES = [
    { id: 'initiative', label: 'Initiative — 1d20 + initiative modifier, one unit at a time' },
    { id: 'phase', label: 'Phased — every party unit acts, then every enemy unit' },
];

export const TRADITIONAL_ENCOUNTER_SOURCES = [
    { id: 'auto', label: 'Auto — reuse active [COMBAT], otherwise ask the agent' },
    { id: 'existing', label: 'Existing [COMBAT] only' },
    { id: 'agent', label: 'Always ask the combat agent to design a new encounter' },
];

export const TRADITIONAL_DEFAULT_TURN_STYLE = 'initiative';
export const TRADITIONAL_DEFAULT_MAX_TOKENS = 6000;
export const TRADITIONAL_DEFAULT_MAX_SPECIAL_RESOLUTIONS = 2;

export const TRADITIONAL_ACTION_TYPES = ['attack', 'skill', 'item', 'defend', 'wait', 'flee'];

export const DEFAULT_TRADITIONAL_ACTION_CATALOG = [
    {
        type: 'attack',
        label: 'Attack',
        enabled: true,
        description: 'Make one weapon or cantrip attack against a single enemy.',
    },
    {
        type: 'skill',
        label: 'Skill',
        enabled: true,
        description: 'Spend a listed ability or spell on a legal target.',
    },
    {
        type: 'item',
        label: 'Item',
        enabled: true,
        description: 'Use a consumable on a legal target. Consumes your main action.',
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
        description: 'Leave the fight. If every player unit flees, combat ends in retreat.',
    },
];

export const DEFAULT_TRADITIONAL_ACTION_CATALOG_JSON = JSON.stringify(
    DEFAULT_TRADITIONAL_ACTION_CATALOG,
    null,
    2,
);
