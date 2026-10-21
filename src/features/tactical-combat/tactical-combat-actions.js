/**
 * tactical-combat-actions.js — the action contract shared by the combat agent,
 * the local fallback AI, the pure engine, and the board UI.
 *
 * The model never mutates the game directly. It emits a list of declarative
 * actions, and this module + the engine are the only interpreters.
 */

import {
    DEFAULT_TACTICAL_ACTION_CATALOG,
    DEFAULT_TACTICAL_ACTION_CATALOG_JSON,
    TC_ACTION_TYPES,
} from './tactical-combat-constants.js';

const ACTION_TYPE_SET = new Set(TC_ACTION_TYPES);
const MAX_AGENT_ACTIONS = 40;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function asInt(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: boolean, catalog?: object[], error?: string }}
 */
export function parseActionCatalog(raw) {
    let value = raw;
    if (typeof value === 'string') {
        const source = value.trim();
        if (!source) return { ok: false, error: 'The action catalogue is empty.' };
        try {
            value = JSON.parse(source);
        } catch (error) {
            return { ok: false, error: `Invalid JSON: ${error.message}` };
        }
    }
    if (value && !Array.isArray(value) && Array.isArray(value.actions)) value = value.actions;
    if (!Array.isArray(value)) {
        return { ok: false, error: 'The action catalogue must be a JSON array of actions.' };
    }
    if (!value.length) {
        return { ok: false, error: 'The action catalogue must contain at least one action.' };
    }

    /** @type {object[]} */
    const catalog = [];
    const seen = new Set();
    for (let index = 0; index < value.length; index += 1) {
        const entry = value[index];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, error: `Action ${index + 1} must be a JSON object.` };
        }
        const type = String(entry.type || '').trim().toLowerCase();
        if (!ACTION_TYPE_SET.has(type)) {
            return {
                ok: false,
                error: `Action ${index + 1}: unsupported type "${entry.type || ''}". Use one of: ${TC_ACTION_TYPES.join(', ')}.`,
            };
        }
        if (seen.has(type)) {
            return { ok: false, error: `Action ${index + 1}: duplicate type "${type}".` };
        }
        seen.add(type);
        const fallback = DEFAULT_TACTICAL_ACTION_CATALOG.find(item => item.type === type);
        catalog.push({
            type,
            label: String(entry.label || fallback?.label || type).slice(0, 60),
            enabled: entry.enabled !== false,
            description: String(entry.description || fallback?.description || '').slice(0, 600),
        });
    }
    return { ok: true, catalog };
}

/**
 * Read and validate the user-edited catalogue. Invalid JSON never breaks
 * combat: the shipped catalogue is used and the error is surfaced in settings.
 *
 * @param {Record<string, any>} settings
 * @returns {{ catalog: object[], error: string, usingDefault: boolean }}
 */
export function getActionCatalog(settings) {
    const raw = settings?.tacticalCombatActionCatalogJson;
    if (raw == null || String(raw).trim() === '') {
        const parsed = parseActionCatalog(DEFAULT_TACTICAL_ACTION_CATALOG_JSON);
        return { catalog: parsed.catalog || clone(DEFAULT_TACTICAL_ACTION_CATALOG), error: '', usingDefault: true };
    }
    const parsed = parseActionCatalog(raw);
    if (parsed.ok) return { catalog: parsed.catalog, error: '', usingDefault: false };
    return {
        catalog: clone(DEFAULT_TACTICAL_ACTION_CATALOG),
        error: parsed.error,
        usingDefault: true,
    };
}

export function serializeActionCatalog(catalog) {
    return JSON.stringify(catalog, null, 2);
}

/**
 * @param {object[]} catalog
 * @param {string} type
 * @returns {boolean}
 */
export function isActionEnabled(catalog, type) {
    return (catalog || []).some(entry => entry.type === type && entry.enabled !== false);
}

/**
 * @param {object[]} catalog
 * @returns {object[]}
 */
export function getEnabledActions(catalog) {
    return (catalog || []).filter(entry => entry.enabled !== false);
}

/**
 * Compact text form injected into the agent prompt and game state.
 * @param {object[]} catalog
 * @returns {string}
 */
export function describeActionCatalog(catalog) {
    return getEnabledActions(catalog)
        .map(entry => `- ${entry.type}: ${entry.label} — ${entry.description}`)
        .join('\n');
}

/**
 * Normalize one declared action from the model. Structurally invalid actions
 * are rejected here; semantic validity (range, resources, terrain) is the
 * engine's job.
 *
 * @param {unknown} raw
 * @returns {{ action: object|null, error: string }}
 */
export function normalizeCombatAction(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { action: null, error: 'Action must be a JSON object.' };
    }
    const type = String(raw.type || '').trim().toLowerCase();
    if (!ACTION_TYPE_SET.has(type)) {
        return { action: null, error: `Unsupported action type "${raw.type || ''}".` };
    }
    const unitId = String(raw.unitId || raw.unit || '').trim();
    if (!unitId) return { action: null, error: 'Action is missing unitId.' };

    const action = { type, unitId };
    if (type === 'move') {
        const to = raw.to && typeof raw.to === 'object' ? raw.to : raw;
        const x = asInt(to.x);
        const y = asInt(to.y);
        if (x == null || y == null) return { action: null, error: 'Move action needs integer to.x and to.y.' };
        action.to = { x, y };
        if (Array.isArray(raw.path) && raw.path.length) {
            const path = raw.path.map(cell => ({ x: asInt(cell?.x), y: asInt(cell?.y) }));
            if (path.every(cell => cell.x != null && cell.y != null)) action.path = path;
        }
    } else if (type === 'attack') {
        const targetId = String(raw.targetId || raw.target || '').trim();
        if (!targetId) return { action: null, error: 'Attack action is missing targetId.' };
        action.targetId = targetId;
    } else if (type === 'skill') {
        const skillId = String(raw.skillId || raw.skill || '').trim();
        if (!skillId) return { action: null, error: 'Skill action is missing skillId.' };
        action.skillId = skillId;
        const targetId = String(raw.targetId || raw.target || '').trim();
        if (targetId) action.targetId = targetId;
    } else if (type === 'item') {
        const itemId = String(raw.itemId || raw.item || '').trim();
        if (!itemId) return { action: null, error: 'Item action is missing itemId.' };
        action.itemId = itemId;
        const targetId = String(raw.targetId || raw.target || '').trim();
        if (targetId) action.targetId = targetId;
    }
    // defend / wait / flee need no extra fields.
    return { action, error: '' };
}

/**
 * Validate the shape of a model response: an object with `actions`, a bare
 * array, or a fenced JSON payload. Unknown wrapper text is ignored.
 *
 * @param {string|object|unknown[]} text
 * @returns {{ actions: object[], payload: any, error: string }}
 */
export function parseActionsResponse(text) {
    if (Array.isArray(text)) {
        return { actions: text, payload: { actions: text }, error: '' };
    }
    if (text && typeof text === 'object') {
        const candidate = Array.isArray(text.actions) ? text.actions : null;
        if (candidate) return { actions: candidate, payload: text, error: '' };
        return { actions: [], payload: text, error: 'Response object has no "actions" array.' };
    }
    const source = String(text || '').trim();
    if (!source) return { actions: [], payload: null, error: 'The agent returned an empty response.' };

    // Strip a fenced block if present.
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = (fenced ? fenced[1] : source).trim();

    const attempts = [body];
    // Also try the largest balanced {...} or [...] region.
    const objectStart = body.indexOf('{');
    const arrayStart = body.indexOf('[');
    if (objectStart >= 0) {
        const extracted = extractBalanced(body, objectStart, '{', '}');
        if (extracted) attempts.push(extracted);
    }
    if (arrayStart >= 0) {
        const extracted = extractBalanced(body, arrayStart, '[', ']');
        if (extracted) attempts.push(extracted);
    }

    let parseError = '';
    for (const attempt of attempts) {
        try {
            const payload = JSON.parse(attempt);
            if (Array.isArray(payload)) {
                return { actions: payload, payload: { actions: payload }, error: '' };
            }
            if (payload && Array.isArray(payload.actions)) {
                return { actions: payload.actions, payload, error: '' };
            }
            if (payload && Array.isArray(payload.action)) {
                return { actions: payload.action, payload, error: '' };
            }
            parseError = 'JSON was valid but did not contain an "actions" array.';
        } catch (error) {
            parseError = `Invalid JSON: ${error.message}`;
        }
    }
    return { actions: [], payload: null, error: parseError || 'No JSON action list was found.' };
}

function extractBalanced(source, start, open, close) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') { inString = true; continue; }
        if (char === open) depth += 1;
        if (char === close) {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    return '';
}

/**
 * Normalize a list of model actions and enforce the combatant allow-list.
 * @param {unknown[]} rawActions
 * @param {{ unitIds?: string[], catalog?: object[], maxActions?: number }} [options]
 * @returns {{ actions: object[], rejected: { action: any, error: string }[] }}
 */
export function sanitizeActionsPayload(rawActions, options = {}) {
    const list = Array.isArray(rawActions) ? rawActions : [];
    const max = Math.max(1, Math.min(Number(options.maxActions) || MAX_AGENT_ACTIONS, 100));
    const allowedUnits = Array.isArray(options.unitIds) && options.unitIds.length
        ? new Set(options.unitIds.map(String))
        : null;
    const catalog = Array.isArray(options.catalog) ? options.catalog : DEFAULT_TACTICAL_ACTION_CATALOG;

    /** @type {object[]} */
    const actions = [];
    /** @type {{ action: any, error: string }[]} */
    const rejected = [];

    for (const raw of list.slice(0, max)) {
        const { action, error } = normalizeCombatAction(raw);
        if (!action) {
            rejected.push({ action: raw, error });
            continue;
        }
        if (allowedUnits && !allowedUnits.has(action.unitId)) {
            rejected.push({ action: raw, error: `Unit "${action.unitId}" is not in unitsToMove.` });
            continue;
        }
        if (!isActionEnabled(catalog, action.type)) {
            rejected.push({ action: raw, error: `Action type "${action.type}" is disabled by the action catalogue.` });
            continue;
        }
        actions.push(action);
    }
    if (list.length > max) {
        rejected.push({
            action: null,
            error: `Only the first ${max} actions were considered (the agent returned ${list.length}).`,
        });
    }
    return { actions, rejected };
}
