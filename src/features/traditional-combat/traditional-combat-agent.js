/**
 * traditional-combat-agent.js — thin mode adapter over the shared combat-agent
 * request/validation/fallback loop. Keeping this file small is intentional: the
 * retry, parsing, chat guard, special-resolution, and local-fallback behavior
 * live in tactical-combat-agent.js and must not be duplicated.
 */

import {
    buildTraditionalAgentGameState,
    getTraditionalActionCatalog,
} from './traditional-combat-engine.js';
import {
    DEFAULT_TRADITIONAL_COMBAT_AGENT_PROMPT,
    DEFAULT_TRADITIONAL_ENCOUNTER_SYSTEM_PROMPT,
} from './traditional-combat-prompts.js';
import {
    buildAgentPrompts,
    generateEncounterWithAgent,
    requestAgentActions,
    resolveSpecialEffectWithAgent,
    runAgentTurn,
} from '../tactical-combat/tactical-combat-agent.js';

/**
 * @param {object} state
 * @param {string[]} unitIds
 * @param {Record<string, any>} settings
 * @param {object[]} [catalog]
 * @returns {{ system: string, user: string, payload: object }}
 */
export function buildTraditionalAgentPrompts(state, unitIds, settings, catalog = getTraditionalActionCatalog(settings).catalog) {
    const payload = buildTraditionalAgentGameState(state, unitIds, catalog, { compact: true });
    const system = String(settings?.traditionalCombatAgentPrompt || DEFAULT_TRADITIONAL_COMBAT_AGENT_PROMPT);
    const user = `## GAME STATE\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n\nAct for these units in this order: ${unitIds.join(', ')}.\nReturn exactly one JSON object of the form {"actions":[...]} and nothing else.`;
    return { system, user, payload };
}

/**
 * @param {object} state
 * @param {string[]} unitIds
 * @param {Record<string, any>} settings
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export function requestTraditionalAgentActions(state, unitIds, settings, options = {}) {
    const catalog = options.catalog || getTraditionalActionCatalog(settings).catalog;
    return requestAgentActions(state, unitIds, settings, {
        ...options,
        mode: 'traditional',
        catalog,
        prompts: options.prompts || buildTraditionalAgentPrompts(state, unitIds, settings, catalog),
    });
}

/**
 * @param {object} state
 * @param {string[]} unitIds
 * @param {Record<string, any>} settings
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export function runTraditionalAgentTurn(state, unitIds, settings, options = {}) {
    const catalog = options.catalog || getTraditionalActionCatalog(settings).catalog;
    return runAgentTurn(state, unitIds, settings, {
        ...options,
        mode: 'traditional',
        catalog,
        theater: true,
        allowMove: false,
        prompts: options.prompts || buildTraditionalAgentPrompts(state, unitIds, settings, catalog),
    });
}

/**
 * @param {object} context
 * @param {Record<string, any>} settings
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export function generateTraditionalEncounterWithAgent(context, settings, options = {}) {
    return generateEncounterWithAgent(context, settings, { ...options, mode: 'traditional' });
}

/**
 * @param {object} state
 * @param {object} caster
 * @param {object} source
 * @param {object|null} target
 * @param {Record<string, any>} settings
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export function resolveTraditionalSpecialEffectWithAgent(state, caster, source, target, settings, options = {}) {
    return resolveSpecialEffectWithAgent(state, caster, source, target, settings, { ...options, mode: 'traditional' });
}

export { buildAgentPrompts, DEFAULT_TRADITIONAL_ENCOUNTER_SYSTEM_PROMPT };
