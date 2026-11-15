/**
 * lewd-combat-inference.js — one-time, per-encounter action inference.
 *
 * The deterministic availability set is the source of truth: it is computed
 * from each participant's visible anatomy, skills, traits, and kinks (the same
 * capability gates the engine uses). An optional agent call may add novel
 * techniques or extra existing ids, but every entry is re-validated against
 * the catalog and the capability gates before it is stored.
 *
 * Availability is deliberately scoped to the encounter (`state.inferredActions`)
 * and recomputed at each new encounter. Compiled novel *definitions* stay in
 * `settings.lewdCombatTechniqueCache` so a technique is compiled once and then
 * reused; its availability is never reused across encounters.
 *
 * Nothing here throws into the board: an offline, broken, or malformed agent
 * response falls back to the deterministic set and records a diagnostic.
 */

import {
    findCachedTechnique,
    writeTechniqueCache,
} from './lewd-combat-compendium.js';
import {
    compileLewdTechnique,
} from './lewd-combat-compiler.js';
import {
    lewdAgentConfigured,
    lewdAgentRequestSettings,
} from './lewd-combat-agent.js';
import {
    DEFAULT_LEWD_INFERENCE_PROMPT,
    LEWD_INFERENCE_JSON_SCHEMA,
} from './lewd-combat-prompts.js';
import {
    findLewdTechnique,
    techniqueActorRequirementReason,
    techniqueTargetRequirementReason,
    validateLewdTechnique,
} from './lewd-combat-techniques.js';

export const LEWD_INFERENCE_SOURCES = Object.freeze(['deterministic', 'agent', 'deterministic-fallback']);

function text(value) {
    return String(value ?? '').trim();
}

function arr(value) {
    if (Array.isArray(value)) return value;
    if (value == null || value === '') return [];
    return [value];
}

function uniqueStrings(value) {
    const out = [];
    for (const item of arr(value)) {
        const token = text(item);
        if (token && !out.includes(token)) out.push(token);
    }
    return out;
}

function participantsOf(state) {
    return arr(state?.participants).filter(participant => participant && !participant.spectator);
}

/**
 * Capability-only availability for one participant.
 *
 * Transient pair requirements (`requires.act`, `minIntensity`, `bindings`,
 * `pairStance`, hold/stance/uses) are intentionally ignored here: a follow-up
 * must stay in the availability set so it can become legal once its act is
 * started. Anatomical and skill gates are permanent capability gates.
 *
 * The union is "visible", not "legal right now": a technique that passes the
 * actor's permanent gates but has no currently matching target anatomy stays in
 * the per-participant list only when at least one target matches; everything
 * else is re-checked per target by `listLegalActions` and by the engine.
 *
 * @param {object} state
 * @param {object} participant
 * @param {object} technique
 * @returns {{ available: boolean, reason: string }}
 */
export function techniqueAvailableForParticipant(state, participant, technique) {
    if (!participant || !technique) return { available: false, reason: 'Missing participant or technique.' };
    const actorReason = techniqueActorRequirementReason(state, participant, technique);
    if (actorReason) return { available: false, reason: actorReason };

    const mode = technique.targetMode || 'single';
    if (mode === 'self') {
        const selfReason = techniqueTargetRequirementReason(state, participant, participant, technique);
        return selfReason ? { available: false, reason: selfReason } : { available: true, reason: '' };
    }
    if (technique.requires?.targetAnatomy) {
        const candidates = participantsOf(state).filter(other => other.id !== participant.id);
        const matching = candidates.some(other =>
            !techniqueTargetRequirementReason(state, participant, other, technique));
        if (!matching) {
            return { available: false, reason: 'No target with the required anatomy.' };
        }
    }
    return { available: true, reason: '' };
}

/**
 * Deterministic availability for the whole board. The union is what arms the
 * catalog; the per-participant maps explain why a participant cannot use an act.
 *
 * @param {object} state
 * @param {{ catalog?: object[] }} [options]
 * @returns {object}
 */
export function computeDeterministicInference(state, options = {}) {
    const catalog = Array.isArray(options.catalog)
        ? options.catalog
        : Array.isArray(state?.techniques)
            ? state.techniques
            : [];
    const participants = participantsOf(state);
    const available = [];
    const perParticipant = {};
    const diagnostics = [];

    for (const participant of participants) {
        const availableTechniqueIds = [];
        const reasons = {};
        for (const technique of catalog) {
            if (!technique?.id) continue;
            const result = techniqueAvailableForParticipant(state, participant, technique);
            if (result.available) {
                availableTechniqueIds.push(technique.id);
                if (!available.includes(technique.id)) available.push(technique.id);
            } else if (result.reason) {
                reasons[technique.id] = result.reason;
            }
        }
        perParticipant[participant.id] = { availableTechniqueIds, reasons };
    }

    if (!participants.length) diagnostics.push('No active participant to infer actions for.');

    return {
        stateId: text(state?.id),
        completedAt: Date.now(),
        source: 'deterministic',
        availableTechniqueIds: available,
        perParticipant,
        novelTechniqueIds: [],
        diagnostics,
        catalogSize: catalog.length,
    };
}

/**
 * Store an inference result on the board. Availability is serialized as a plain
 * array so it survives `JSON.stringify`/hydrate unchanged.
 *
 * @param {object} state
 * @param {object} inference
 * @returns {object|null}
 */
export function applyInferenceToState(state, inference) {
    if (!state || !inference || typeof inference !== 'object') return null;
    const perParticipant = {};
    for (const [id, entry] of Object.entries(inference.perParticipant || {})) {
        if (!entry || typeof entry !== 'object') continue;
        perParticipant[id] = {
            availableTechniqueIds: uniqueStrings(entry.availableTechniqueIds),
            reasons: entry.reasons && typeof entry.reasons === 'object' ? { ...entry.reasons } : {},
        };
    }
    state.inferredActions = {
        stateId: text(inference.stateId ?? state.id),
        completedAt: Number(inference.completedAt) || Date.now(),
        source: LEWD_INFERENCE_SOURCES.includes(inference.source) ? inference.source : 'deterministic',
        availableTechniqueIds: uniqueStrings(inference.availableTechniqueIds),
        perParticipant,
        novelTechniqueIds: uniqueStrings(inference.novelTechniqueIds),
        diagnostics: uniqueStrings(inference.diagnostics),
        catalogSize: Number(inference.catalogSize) || arr(state.techniques).length,
        ...(text(inference.agentError) ? { agentError: text(inference.agentError) } : {}),
    };
    return state.inferredActions;
}

/**
 * Union a fresh deterministic pass into the stored inference set. Cheap enough
 * to run whenever the roster changes (a spectator joins, a participant is
 * added) so a newcomer's capability-legal acts are visible without a manual
 * refresh. Existing entries are preserved; nothing is removed.
 *
 * @param {object} state
 * @returns {object|null}
 */
export function reconcileInferenceWithRoster(state) {
    const current = state?.inferredActions;
    if (!current || typeof current !== 'object' || !Array.isArray(current.availableTechniqueIds)) return null;
    const fresh = computeDeterministicInference(state);
    for (const id of fresh.availableTechniqueIds) {
        if (!current.availableTechniqueIds.includes(id)) current.availableTechniqueIds.push(id);
    }
    for (const [id, entry] of Object.entries(fresh.perParticipant)) {
        if (!current.perParticipant || typeof current.perParticipant !== 'object') current.perParticipant = {};
        if (!current.perParticipant[id]) {
            current.perParticipant[id] = {
                availableTechniqueIds: [...entry.availableTechniqueIds],
                reasons: { ...entry.reasons },
            };
        }
    }
    return current;
}

function extractJsonObject(raw) {
    if (raw && typeof raw === 'object') return raw;
    const source = String(raw ?? '').trim();
    if (!source) return null;
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1].trim() : source;
    try {
        return JSON.parse(body);
    } catch (_) {
        const start = body.indexOf('{');
        const end = body.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try {
            return JSON.parse(body.slice(start, end + 1));
        } catch (_) {
            return null;
        }
    }
}

function parseInferenceResponse(raw) {
    const value = extractJsonObject(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            availableTechniqueIds: [],
            novelTechniques: [],
            error: 'The action-inference agent did not return a JSON object.',
        };
    }
    const novelTechniques = Array.isArray(value.novelTechniques)
        ? value.novelTechniques.filter(entry => entry && typeof entry === 'object')
        : (value.novelTechnique && typeof value.novelTechnique === 'object'
            ? [value.novelTechnique]
            : []);
    return {
        availableTechniqueIds: uniqueStrings(value.availableTechniqueIds),
        novelTechniques,
        error: '',
    };
}

function buildInferenceRequest(state, deterministic) {
    const participants = participantsOf(state).map(participant => {
        const profile = participant.profile || {};
        return {
            id: participant.id,
            name: participant.name,
            role: profile.role || 'switch',
            body: text(participant.body ?? profile.body),
            species: text(participant.species ?? profile.species),
            anatomy: arr(participant.anatomy ?? profile.anatomy).map(String),
            skills: arr(participant.skills ?? profile.skills).map(String),
            kinks: arr(participant.kinks ?? profile.kinks).map(String),
            sourceSkills: arr(participant.sourceSkills).map(String),
            sourceTraits: arr(participant.sourceTraits).map(String),
            inferredFields: arr(participant.inferredFields).map(String),
            limits: profile.source === 'inferred' ? [] : arr(profile.limits).map(String),
        };
    });
    const knownIds = new Set(arr(state?.techniques).map(technique => technique?.id).filter(Boolean));
    const candidates = deterministic.availableTechniqueIds
        .map(id => findLewdTechnique(state.techniques, id))
        .filter(Boolean)
        .map(technique => ({
            id: technique.id,
            name: technique.name,
            category: technique.category,
            actType: technique.actType ?? null,
            actRole: technique.actRole ?? null,
            zones: arr(technique.zones).map(String),
        }));
    const payload = {
        tone: state?.settings?.lewdCombatExplicitness || 'explicit',
        darkerThemes: !!state?.settings?.lewdCombatDarkerThemes,
        participants,
        catalogSize: knownIds.size,
        candidates,
    };
    return {
        system: DEFAULT_LEWD_INFERENCE_PROMPT,
        user: [
            '## LEWD COMBAT ACTION INFERENCE',
            '```json',
            JSON.stringify(payload),
            '```',
            '',
            'Return only {"availableTechniqueIds":[...],"novelTechniques":[...]} and nothing else.',
        ].join('\n'),
    };
}

async function defaultSend(settings, system, user, signal) {
    const module = await import('../../../llm-client.js');
    if (typeof module.sendStateRequest !== 'function') {
        throw new Error('Agent connection is not available.');
    }
    return module.sendStateRequest(
        lewdAgentRequestSettings(settings || {}),
        system,
        user,
        signal || null,
        {
            stream: false,
            debugSource: 'Lewd Combat Action Inference',
            jsonSchema: LEWD_INFERENCE_JSON_SCHEMA,
        },
    );
}

/**
 * Re-run inference for the current encounter. Deterministic first; the agent is
 * an optional enrichment that can only add validated entries.
 *
 * @param {object} state
 * @param {Record<string, any>} [settings]
 * @param {{
 *   signal?: AbortSignal,
 *   sendStateRequest?: Function,
 *   compileTechnique?: Function,
 *   useAgent?: boolean,
 * }} [options]
 * @returns {Promise<object|null>}
 */
export async function refreshLewdActionInference(state, settings = {}, options = {}) {
    if (!state || typeof state !== 'object') return null;
    const deterministic = computeDeterministicInference(state);
    const diagnostics = [...deterministic.diagnostics];
    const extraIds = [];
    const novelTechniqueIds = [];
    let source = 'deterministic';
    let agentError = '';

    const send = typeof options.sendStateRequest === 'function' ? options.sendStateRequest : null;
    const canUseAgent = options.useAgent !== false
        && state.status === 'active'
        && (send || lewdAgentConfigured(settings || {}));

    if (canUseAgent) {
        try {
            const request = buildInferenceRequest(state, deterministic);
            const raw = send
                ? await send(
                    lewdAgentRequestSettings(settings || {}),
                    request.system,
                    request.user,
                    options.signal || null,
                    {
                        stream: false,
                        debugSource: 'Lewd Combat Action Inference',
                        jsonSchema: LEWD_INFERENCE_JSON_SCHEMA,
                    },
                )
                : await defaultSend(settings, request.system, request.user, options.signal);
            const parsed = parseInferenceResponse(raw);
            if (parsed.error) throw new Error(parsed.error);
            source = 'agent';

            for (const id of parsed.availableTechniqueIds) {
                const technique = findLewdTechnique(state.techniques, id);
                if (!technique) {
                    diagnostics.push(`Dropped inferred technique "${id}": not in the catalog.`);
                    continue;
                }
                const usable = participantsOf(state)
                    .some(participant => techniqueAvailableForParticipant(state, participant, technique).available);
                if (!usable) {
                    diagnostics.push(`Dropped inferred technique "${id}": no participant can use it.`);
                    continue;
                }
                if (!extraIds.includes(technique.id)) extraIds.push(technique.id);
            }

            for (const novel of parsed.novelTechniques) {
                const name = text(novel?.name);
                if (!name) {
                    diagnostics.push('Dropped a novel technique without a name.');
                    continue;
                }
                // Compile-once: a cached or already-known definition is reused.
                let technique = findCachedTechnique(settings, name)
                    || findLewdTechnique(state.techniques, name);
                if (!technique) {
                    const compiler = typeof options.compileTechnique === 'function'
                        ? options.compileTechnique
                        : compileLewdTechnique;
                    let result;
                    try {
                        result = await compiler(novel, settings);
                    } catch (error) {
                        diagnostics.push(`Novel technique "${name}" failed: ${error?.message || error}`);
                        continue;
                    }
                    technique = result?.technique
                        || (result?.id && result?.name ? result : null);
                    if (!technique) {
                        diagnostics.push(`Novel technique "${name}" failed: ${result?.error || 'the compiler returned no technique.'}`);
                        continue;
                    }
                    writeTechniqueCache(settings, technique);
                }
                const validated = validateLewdTechnique(technique);
                if (!validated.ok) {
                    diagnostics.push(`Novel technique "${name}" is invalid: ${validated.errors.join(' ')}`);
                    continue;
                }
                technique = validated.technique;
                if (!arr(state.techniques).some(entry => entry?.id === technique.id)) {
                    state.techniques = [...arr(state.techniques), technique];
                }
                if (!novelTechniqueIds.includes(technique.id)) novelTechniqueIds.push(technique.id);
                const usable = participantsOf(state)
                    .some(participant => techniqueAvailableForParticipant(state, participant, technique).available);
                if (usable && !extraIds.includes(technique.id)) extraIds.push(technique.id);
            }
        } catch (error) {
            source = 'deterministic-fallback';
            agentError = error?.message || String(error);
            diagnostics.push(`Action inference fell back to the local prefilter: ${agentError}`);
        }
    }

    // Recompute after any novel definitions were appended so the per-participant
    // maps include them, then union the validated agent extras.
    const recomputed = computeDeterministicInference(state);
    const available = [...recomputed.availableTechniqueIds];
    for (const id of extraIds) {
        if (!available.includes(id)) available.push(id);
    }
    const inference = {
        stateId: text(state.id),
        completedAt: Date.now(),
        source,
        availableTechniqueIds: available,
        perParticipant: recomputed.perParticipant,
        novelTechniqueIds,
        diagnostics,
        agentError,
        catalogSize: arr(state.techniques).length,
    };
    // The caller may abort (timeout/closed board); a late result must not
    // mutate a board the UI no longer owns.
    if (typeof options.shouldApply === 'function' && !options.shouldApply()) {
        return { ...inference, applied: false };
    }
    applyInferenceToState(state, inference);
    return inference;
}
