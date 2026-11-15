/**
 * lewd-combat-agent.js — the model-facing opponent contract.
 *
 * The agent never resolves anything: it receives a compact payload of legal
 * actions and visible state, and returns a proposal that is validated against
 * the catalog before the engine resolves it. A proposal that is missing,
 * malformed, or illegal falls back to `chooseOpponentAction` through
 * `resolveLewdOpponentTurn`; no model/connection error escapes this module.
 */

import {
    findCachedTechnique,
} from './lewd-combat-compendium.js';
import {
    compileLewdTechnique,
} from './lewd-combat-compiler.js';
import {
    LEWD_AGENT_JSON_SCHEMA,
    DEFAULT_LEWD_AGENT_PROMPT,
} from './lewd-combat-prompts.js';
import {
    findLewdTechnique,
    listLegalActions,
} from './lewd-combat-techniques.js';
import {
    normalizeLewdZone,
} from './lewd-combat-profile.js';
import {
    holdsOn,
} from './lewd-combat-pairing.js';
import {
    isOverwhelmed,
} from './lewd-combat-states.js';
import {
    lewdParticipantControl,
} from './lewd-combat-engine.js';

export const LEWD_AGENT_MAX_ATTEMPTS = 2;

const RULE_TEXT = 'Never invent numbers, targets, body zones, or outcomes.';

function text(value) {
    return String(value ?? '').trim();
}

function arr(value) {
    if (Array.isArray(value)) return value;
    if (value == null || value === '') return [];
    return [value];
}

function capabilityList(participant, key) {
    const profile = participant?.profile || {};
    return arr(participant?.[key] ?? profile[key]).map(String);
}

function findParticipant(state, reference) {
    if (!state || reference == null) return null;
    if (typeof reference === 'object') {
        if (reference.id && state.participants?.includes(reference)) return reference;
        if (reference.id) return state.participants?.find(participant => participant.id === reference.id) || null;
        if (reference.name) return findParticipant(state, reference.name);
        return null;
    }
    const key = text(reference).toLowerCase();
    if (!key) return null;
    return state.participants?.find(participant => String(participant.id).toLowerCase() === key)
        || state.participants?.find(participant => String(participant.name).toLowerCase() === key)
        || null;
}

function sanitizeLine(value) {
    return text(value).replace(/\s+/g, ' ').slice(0, 240);
}

function preferenceTokens(profile, kind) {
    const preference = profile?.preference && typeof profile.preference === 'object' ? profile.preference : {};
    return Object.entries(preference)
        .filter(([, value]) => value === kind)
        .map(([key]) => key);
}

/**
 * True only when the dedicated lewd agent connection is explicitly set. A
 * tactical-only configuration must not make the agent look configured.
 * @param {Record<string, any>} [settings]
 * @returns {boolean}
 */
export function lewdAgentConfigured(settings = {}) {
    const source = text(settings?.lewdCombatConnectionSource);
    if (source && source !== 'default') return true;
    return !!(
        text(settings?.lewdCombatConnectionProfileId)
        || text(settings?.lewdCombatOllamaModel)
        || text(settings?.lewdCombatOpenaiModel)
    );
}

/**
 * Connection settings for the opponent agent. Lewd keys win; the tactical
 * connection is a compatibility fallback, exactly like the compiler.
 * @param {Record<string, any>} [settings]
 * @returns {object}
 */
export function lewdAgentRequestSettings(settings = {}) {
    return {
        connectionSource: settings?.lewdCombatConnectionSource
            || settings?.tacticalCombatConnectionSource
            || 'default',
        connectionProfileId: settings?.lewdCombatConnectionProfileId
            || settings?.tacticalCombatConnectionProfileId
            || '',
        completionPresetId: settings?.lewdCombatCompletionPresetId
            || settings?.tacticalCombatCompletionPresetId
            || '',
        ollamaUrl: settings?.lewdCombatOllamaUrl || settings?.tacticalCombatOllamaUrl || 'http://localhost:11434',
        ollamaModel: settings?.lewdCombatOllamaModel || settings?.tacticalCombatOllamaModel || '',
        openaiUrl: settings?.lewdCombatOpenaiUrl || settings?.tacticalCombatOpenaiUrl || '',
        openaiKey: settings?.lewdCombatOpenaiKey || settings?.tacticalCombatOpenaiKey || '',
        openaiModel: settings?.lewdCombatOpenaiModel || settings?.tacticalCombatOpenaiModel || '',
        maxTokens: Math.max(600, Number(settings?.lewdCombatAgentMaxTokens) || 2000),
        debugMode: !!settings?.debugMode,
    };
}

function compactActionLog(state) {
    return arr(state?.actionLog).slice(-8).map(entry => {
        const row = {
            round: entry?.round,
            unitId: entry?.unitId,
            type: entry?.type,
            source: entry?.source,
        };
        if (entry?.techniqueId) row.techniqueId = entry.techniqueId;
        if (arr(entry?.targetIds).length) row.targetIds = arr(entry.targetIds).map(String);
        if (arr(entry?.zones).length) row.zones = arr(entry.zones).map(String);
        if (entry?.posture) row.posture = entry.posture;
        if (entry?.reason) row.reason = entry.reason;
        if (entry?.flavor) row.flavor = entry.flavor;
        return row;
    });
}

function payloadLegalActions(entries) {
    return arr(entries)
        .filter(entry => entry && !entry.disabled)
        .map(entry => {
            const technique = entry.technique || {};
            return {
                id: entry.id,
                name: entry.name,
                category: entry.category,
                posture: entry.posture,
                postures: arr(entry.postures).map(String),
                zones: arr(entry.zones).map(String),
                targetMode: technique.targetMode || 'single',
                targets: arr(entry.targets)
                    .filter(target => target && !target.disabled)
                    .map(target => target.name),
                usesRemaining: entry.usesRemaining === Infinity ? 'unlimited' : entry.usesRemaining,
                effects: {
                    arousal: technique.arousal ?? '0',
                    poise: technique.poise ?? '0',
                    staminaDrain: Number(technique.staminaDrain) || 0,
                    requires: technique.requires || {},
                },
            };
        });
}

function payloadDisabledActions(entries) {
    return arr(entries)
        .filter(entry => entry && arr(entry.requirementReasons).length)
        .map(entry => ({
            id: entry.id,
            name: entry.name,
            reasons: arr(entry.requirementReasons).map(String),
        }));
}

function payloadProfiles(state) {
    const profiles = {};
    for (const participant of arr(state?.participants)) {
        if (participant?.spectator) continue;
        const profile = participant.profile || {};
        const entry = {
            role: profile.role || 'switch',
            orientation: profile.orientation || '',
            sensitivity: { ...(profile.sensitivity || {}) },
            likes: preferenceTokens(profile, 'like'),
            dislikes: preferenceTokens(profile, 'dislike'),
            endurance: Number(profile.endurance) || 0,
            experience: Number(profile.experience) || 0,
            inferred: profile.inferred === true,
            body: String(participant.body ?? profile.body ?? ''),
            species: String(participant.species ?? profile.species ?? ''),
            anatomy: capabilityList(participant, 'anatomy'),
            skills: capabilityList(participant, 'skills'),
            kinks: capabilityList(participant, 'kinks'),
            sourceSkills: capabilityList(participant, 'sourceSkills'),
            sourceTraits: capabilityList(participant, 'sourceTraits'),
            inferredFields: capabilityList(participant, 'inferredFields'),
        };
        // Inferred profiles never declare limits; exposing an empty list would
        // look like a declaration the player never made.
        if (profile.source !== 'inferred') {
            entry.limits = arr(profile.limits).map(String);
        }
        profiles[participant.id] = entry;
    }
    return profiles;
}

/**
 * Build the compact, non-authoritative state the opponent agent sees.
 *
 * @param {object} state
 * @param {object|string} unit
 * @param {{ legalActions?: object[] }} [options]
 * @returns {object}
 */
export function buildLewdAgentPayload(state, unit, options = {}) {
    const actor = findParticipant(state, unit);
    const legalEntries = Array.isArray(options.legalActions)
        ? options.legalActions
        : (state && actor ? listLegalActions(state, actor) : []);
    const participants = arr(state?.participants);
    const nameById = new Map(participants.map(participant => [participant.id, participant.name]));

    return {
        encounter: {
            round: Number(state?.round) || 1,
            roundCap: Number(state?.roundCap) || 12,
            mode: state?.mode || 'duel',
            tone: state?.settings?.lewdCombatExplicitness || 'explicit',
            darkerThemes: !!state?.settings?.lewdCombatDarkerThemes,
        },
        actor: {
            id: actor?.id || '',
            name: actor?.name || '',
            side: actor?.side || '',
            control: lewdParticipantControl(actor),
            role: actor?.profile?.role || 'switch',
            stance: actor?.stance?.label || actor?.stance?.id || null,
            stamina: actor?.stamina ?? 0,
            maxStamina: actor?.maxStamina ?? 0,
            arousal: actor?.arousal ?? 0,
            maxArousal: actor?.maxArousal ?? 0,
            poise: actor?.poise ?? 0,
            maxPoise: actor?.maxPoise ?? 0,
            anatomy: capabilityList(actor, 'anatomy'),
            skills: capabilityList(actor, 'skills'),
            kinks: capabilityList(actor, 'kinks'),
            sourceTraits: capabilityList(actor, 'sourceTraits'),
            overwhelmed: state && actor ? isOverwhelmed(state, actor) : false,
        },
        participants: participants.map(participant => ({
            id: participant.id,
            name: participant.name,
            side: participant.side,
            control: lewdParticipantControl(participant),
            spectator: !!participant.spectator,
            atMercy: !!participant.atMercy,
            surrendered: !!participant.surrendered,
            acted: !!participant.acted,
            role: participant.profile?.role || 'switch',
            stamina: participant.stamina ?? 0,
            maxStamina: participant.maxStamina ?? 0,
            arousal: participant.arousal ?? 0,
            maxArousal: participant.maxArousal ?? 0,
            poise: participant.poise ?? 0,
            maxPoise: participant.maxPoise ?? 0,
            stance: participant.stance?.label || participant.stance?.id || null,
            holds: holdsOn(state, participant).map(row => row.hold?.label || row.hold?.id || 'Held'),
            engagedWith: arr(participant.engagedWith)
                .map(id => nameById.get(id))
                .filter(Boolean),
        })),
        engagements: arr(state?.engagements).map(edge => ({
            a: nameById.get(edge.a) || edge.a,
            b: nameById.get(edge.b) || edge.b,
            hold: edge.hold?.label || edge.hold?.id || null,
            stance: edge.stance?.label || edge.stance?.id || null,
            intensity: Number(edge.intensity) || 0,
        })),
        legalActions: payloadLegalActions(legalEntries),
        disabledActions: payloadDisabledActions(legalEntries),
        recentActions: compactActionLog(state),
        knownProfiles: payloadProfiles(state),
        rules: {
            variety: 'Avoid repeating the techniques and targets in recentActions when another legal option fits.',
            constraints: [
                RULE_TEXT,
                'The engine owns all Arousal, Poise, and Stamina math; never compute or state results.',
                'Use only ids, names, targets, zones, and postures from the legalActions list.',
                'Only use legalActions; a technique in disabledActions is illegal and its reasons explain why.',
                'Respect every hard limit in knownProfiles.',
                'Return only one JSON object shaped like {"actions":[...]}.',
            ],
        },
    };
}

/**
 * Build the system/user prompts for the opponent agent.
 *
 * @param {object} state
 * @param {object|string} unit
 * @param {Record<string, any>} [settings]
 * @param {{ legalActions?: object[], prompt?: string }} [options]
 * @returns {{ system: string, user: string, payload: object }}
 */
export function buildLewdAgentPrompts(state, unit, settings = {}, options = {}) {
    const actor = findParticipant(state, unit);
    const payload = buildLewdAgentPayload(state, unit, options);
    const system = text(options.prompt || settings?.lewdCombatAgentPrompt) || DEFAULT_LEWD_AGENT_PROMPT;
    const user = [
        '## LEWD COMBAT STATE',
        '```json',
        JSON.stringify(payload),
        '```',
        '',
        `Choose exactly one action for ${actor?.name || 'the AI participant'}. Use only the ids listed above.`,
        'Return only {"actions":[...]} and nothing else.',
    ].join('\n');
    return { system, user, payload };
}

function extractJsonObject(text) {
    if (text && typeof text === 'object') return text;
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const source = fenced ? fenced[1].trim() : raw;
    try {
        return JSON.parse(source);
    } catch (_) {
        const start = source.indexOf('{');
        if (start < 0) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < source.length; index += 1) {
            const char = source[index];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;
            if (char === '{') depth += 1;
            else if (char === '}') {
                depth -= 1;
                if (depth === 0) {
                    try {
                        return JSON.parse(source.slice(start, index + 1));
                    } catch (_) {
                        return null;
                    }
                }
            }
        }
        return null;
    }
}

/**
 * Tolerantly extract `{actions, novelTechnique}` from a model response.
 * Reasoning prose before/after a fenced or balanced JSON object is allowed.
 *
 * @param {string|object} text
 * @returns {{ actions: object[], novelTechnique: object|null, error: string }}
 */
export function parseLewdAgentResponse(text) {
    const value = extractJsonObject(text);
    if (!value) {
        return { actions: [], novelTechnique: null, error: 'The opponent agent did not return a JSON object.' };
    }
    let actions = [];
    if (Array.isArray(value)) actions = value.filter(entry => entry && typeof entry === 'object');
    else if (Array.isArray(value.actions)) actions = value.actions.filter(entry => entry && typeof entry === 'object');
    else if (value.type) actions = [value];
    const novelTechnique = (value && !Array.isArray(value) && value.novelTechnique && typeof value.novelTechnique === 'object')
        ? value.novelTechnique
        : actions.map(action => action?.novelTechnique).find(Boolean) || null;
    return {
        actions,
        novelTechnique,
        error: actions.length ? '' : 'The opponent agent returned no actions.',
    };
}

function techniqueReference(raw) {
    const candidate = raw?.techniqueId ?? raw?.technique ?? raw?.id ?? raw?.name ?? '';
    if (candidate && typeof candidate === 'object') return text(candidate.id || candidate.name);
    return text(candidate);
}

function rawTargetIds(raw) {
    const value = raw?.targetIds ?? raw?.targetId ?? raw?.targets ?? [];
    return arr(value)
        .map(entry => (entry && typeof entry === 'object' ? entry.id ?? entry.name : entry))
        .map(text)
        .filter(Boolean);
}

function withFlavor(action, raw) {
    const intent = sanitizeLine(raw?.intent);
    const flavor = sanitizeLine(raw?.flavor);
    if (intent) action.intent = intent;
    if (flavor) action.flavor = flavor;
    return action;
}

/**
 * Validate one proposed action against the supplied legal entries.
 *
 * @param {object} raw
 * @param {object[]} legalEntries
 * @param {object} actor
 * @returns {{ ok: boolean, action?: object, error?: string }}
 */
export function normalizeLewdAgentAction(raw, legalEntries, actor) {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: 'The action must be a JSON object.' };
    }
    const type = text(raw.type || 'technique').toLowerCase();
    if (type === 'wait' || type === 'surrender') {
        const action = { type, unitId: actor?.id || '' };
        const flavor = sanitizeLine(raw?.flavor);
        if (flavor) action.flavor = flavor;
        return { ok: true, action };
    }
    if (type !== 'technique') {
        return { ok: false, error: `Unsupported action type "${raw.type}". Only technique, wait, and surrender are allowed.` };
    }

    const reference = techniqueReference(raw);
    if (!reference) return { ok: false, error: 'A technique id or name is required.' };
    const key = reference.toLowerCase();
    const entries = arr(legalEntries).filter(Boolean);
    const entry = entries.find(candidate => text(candidate.id).toLowerCase() === key)
        || entries.find(candidate => text(candidate.name).toLowerCase() === key);
    if (!entry) return { ok: false, error: `Unknown technique "${reference}".` };
    if (entry.disabled) {
        const reasons = arr(entry.reasons).map(text).filter(Boolean).join(' ');
        return { ok: false, error: `Technique "${entry.name || entry.id}" is not legal${reasons ? `: ${reasons}` : '.'}` };
    }

    const mode = entry.technique?.targetMode || 'single';
    const entryTargets = arr(entry.targets).map(target => (
        typeof target === 'string'
            ? { id: target, name: target, disabled: false, reasons: [] }
            : target
    )).filter(Boolean);
    let targetIds = rawTargetIds(raw);
    if (mode === 'self') {
        targetIds = [];
    } else {
        if (!targetIds.length) {
            const first = entryTargets.find(target => !target.disabled);
            if (!first) return { ok: false, error: `No legal targets for "${entry.name || entry.id}".` };
            targetIds = [text(first.id)];
        }
        if ((mode === 'single' || mode === 'pair') && targetIds.length !== 1) {
            return { ok: false, error: `"${entry.name || entry.id}" requires exactly one target.` };
        }
        const resolved = [];
        for (const id of targetIds) {
            const key = text(id).toLowerCase();
            const target = entryTargets.find(candidate => text(candidate.id).toLowerCase() === key)
                || entryTargets.find(candidate => text(candidate.name).toLowerCase() === key);
            if (!target) {
                return { ok: false, error: `Target "${id}" is not legal for "${entry.name || entry.id}".` };
            }
            if (target.disabled) {
                const reasons = arr(target.reasons).map(text).filter(Boolean).join(' ');
                return { ok: false, error: `Target "${target.name || id}" is not legal${reasons ? `: ${reasons}` : '.'}` };
            }
            const canonical = text(target.id);
            if (canonical && !resolved.includes(canonical)) resolved.push(canonical);
        }
        targetIds = resolved;
    }

    const entryZones = arr(entry.zones).map(String);
    const requestedZone = text(raw.zone ?? raw.zones?.[0]);
    let zone = entryZones[0] || '';
    if (requestedZone && entryZones.length) {
        const normalized = normalizeLewdZone(requestedZone);
        if (!normalized) return { ok: false, error: `Unknown body zone "${requestedZone}".` };
        if (!entryZones.includes(normalized)) {
            return { ok: false, error: `"${entry.name || entry.id}" cannot target the ${normalized} zone.` };
        }
        zone = normalized;
    }

    const postures = arr(entry.postures).map(String);
    let posture = text(raw.posture).toLowerCase();
    if (!posture) posture = text(entry.posture) || postures[0] || 'switch';
    if (postures.length && !postures.includes(posture)) {
        return { ok: false, error: `"${entry.name || entry.id}" cannot be used from the ${posture} posture.` };
    }

    const action = {
        type: 'technique',
        unitId: actor?.id || '',
        techniqueId: entry.id,
        targetIds,
        zone,
        posture,
    };
    return { ok: true, action: withFlavor(action, raw) };
}

function normalizeParsedInput(textOrValue) {
    if (typeof textOrValue === 'string') return parseLewdAgentResponse(textOrValue);
    if (Array.isArray(textOrValue)) {
        return {
            actions: textOrValue,
            novelTechnique: textOrValue.map(action => action?.novelTechnique).find(Boolean) || null,
            error: '',
        };
    }
    if (textOrValue && typeof textOrValue === 'object') {
        if (Array.isArray(textOrValue.actions)) {
            return {
                actions: textOrValue.actions,
                novelTechnique: textOrValue.novelTechnique || null,
                error: textOrValue.error || '',
            };
        }
        if (textOrValue.type) return parseLewdAgentResponse({ actions: [textOrValue], novelTechnique: textOrValue.novelTechnique });
    }
    return parseLewdAgentResponse(textOrValue);
}

/**
 * Validate every proposed action in a parsed response.
 *
 * @param {string|object} textOrValue
 * @param {object[]} legalEntries
 * @param {object} actor
 * @returns {{ ok: boolean, actions: object[], rejected: object[], novelTechnique: object|null, error: string }}
 */
export function normalizeLewdAgentResponse(textOrValue, legalEntries, actor) {
    const parsed = normalizeParsedInput(textOrValue);
    const actions = [];
    const rejected = [];
    for (const raw of arr(parsed.actions)) {
        const normalized = normalizeLewdAgentAction(raw, legalEntries, actor);
        if (normalized.ok) actions.push(normalized.action);
        else rejected.push({ action: raw, error: normalized.error || 'Illegal action.' });
    }
    const error = actions.length
        ? ''
        : parsed.novelTechnique
            ? 'No legal action in the response.'
            : (parsed.error || 'No legal action in the response.');
    return {
        ok: actions.length > 0,
        actions,
        rejected,
        novelTechnique: parsed.novelTechnique || null,
        error,
    };
}

async function resolveNovel(state, settings, novel, options) {
    const name = text(novel?.name);
    if (!name) return { technique: null, error: 'A novel technique needs a name.' };
    const known = findCachedTechnique(settings, name) || findLewdTechnique(state?.techniques, name);
    if (known) return { technique: known, error: '' };
    try {
        const resolver = typeof options.resolveNovelTechnique === 'function'
            ? options.resolveNovelTechnique
            : (request, requestSettings) => compileLewdTechnique(request, requestSettings);
        const result = await resolver(novel, settings);
        const technique = result?.technique || (result?.id ? result : null);
        if (!technique) return { technique: null, error: result?.error || 'The novel technique could not be compiled.' };
        return { technique, error: '' };
    } catch (error) {
        return { technique: null, error: error?.message || String(error) };
    }
}

/**
 * Ask the opponent agent for one action. Connection, parse, and validation
 * failures are reported in the result and never thrown.
 *
 * @param {object} state
 * @param {object|string} unit
 * @param {Record<string, any>} [settings]
 * @param {{
 *   signal?: AbortSignal,
 *   sendStateRequest?: Function,
 *   resolveNovelTechnique?: Function,
 *   prompt?: string,
 *   legalActions?: object[],
 * }} [options]
 * @returns {Promise<object>}
 */
export async function requestLewdOpponentAction(state, unit, settings = {}, options = {}) {
    const actor = findParticipant(state, unit);
    if (!state || state.status !== 'active') {
        return { ok: false, actions: [], rejected: [], error: 'Encounter is not active.' };
    }
    if (!actor) return { ok: false, actions: [], rejected: [], error: 'Participant not found.' };
    if (!Array.isArray(state.techniques)) state.techniques = [];
    else if (!Object.isExtensible(state.techniques)) state.techniques = [...state.techniques];

    let send = options.sendStateRequest;
    if (typeof send !== 'function') {
        try {
            const module = await import('../../../llm-client.js');
            send = module.sendStateRequest;
        } catch (error) {
            return { ok: false, actions: [], rejected: [], error: `Agent connection unavailable: ${error?.message || error}` };
        }
    }
    if (typeof send !== 'function') {
        return { ok: false, actions: [], rejected: [], error: 'Agent connection is not available.' };
    }

    let legal = Array.isArray(options.legalActions) ? options.legalActions : listLegalActions(state, actor);
    let compiledTechnique = null;
    let lastRaw = '';
    let lastRejected = [];
    let lastError = '';

    for (let attempt = 0; attempt < LEWD_AGENT_MAX_ATTEMPTS; attempt += 1) {
        const prompts = buildLewdAgentPrompts(state, actor, settings, {
            legalActions: legal,
            prompt: options.prompt,
        });
        const user = attempt > 0 && lastRejected.length
            ? `${prompts.user}\n\n## CORRECTION\nThe previous proposal was rejected. Fix these problems and return only {"actions":[...]}:\n${lastRejected.map(row => `- ${row.error}`).join('\n')}`
            : prompts.user;

        let raw;
        try {
            raw = await send(
                lewdAgentRequestSettings(settings),
                prompts.system,
                user,
                options.signal || null,
                {
                    stream: false,
                    debugSource: 'Lewd Combat Agent',
                    jsonSchema: LEWD_AGENT_JSON_SCHEMA,
                },
            );
        } catch (error) {
            lastError = `Agent request failed: ${error?.message || error}`;
            continue;
        }
        lastRaw = String(raw ?? '');
        const parsed = parseLewdAgentResponse(raw);
        if (!parsed.actions.length && !parsed.novelTechnique) {
            lastError = parsed.error;
            continue;
        }

        const novel = parsed.novelTechnique
            || parsed.actions.map(action => action?.novelTechnique).find(Boolean)
            || null;
        if (novel) {
            const resolved = await resolveNovel(state, settings, novel, options);
            if (resolved.technique?.id) {
                const technique = resolved.technique;
                if (!state.techniques.some(entry => entry?.id === technique.id)) {
                    state.techniques.push(technique);
                }
                compiledTechnique = technique;
                // A freshly compiled technique is now part of the legal catalog.
                legal = listLegalActions(state, actor);
            } else if (resolved.error) {
                lastError = resolved.error;
            }
        }

        const normalized = normalizeLewdAgentResponse(
            { actions: parsed.actions, novelTechnique: parsed.novelTechnique },
            legal,
            actor,
        );
        if (normalized.ok) {
            return {
                ok: true,
                actions: normalized.actions,
                rejected: normalized.rejected,
                novelTechnique: parsed.novelTechnique,
                compiledTechnique,
                raw: lastRaw,
            };
        }
        lastRejected = normalized.rejected;
        lastError = normalized.error || lastError;
    }

    return {
        ok: false,
        actions: [],
        rejected: lastRejected,
        error: lastError || 'No legal action in the response.',
        raw: lastRaw,
        compiledTechnique,
    };
}
