/**
 * lewd-combat-prompts.js — model-facing text for the Lewd Combat opponent AI
 * and the non-authoritative prose pass.
 *
 * Both prompts are deliberately explicit about the division of labour: the
 * engine owns every number, the agent only chooses among legal actions, and the
 * prose pass only writes sentences for an already-resolved beat. Nothing here
 * reads state, calls the network, or touches the DOM at import time.
 */

export const DEFAULT_LEWD_AGENT_PROMPT = `You are the Lewd Combat opponent agent. You act for one AI-controlled participant only and choose exactly one action for them.

Rules:
- Use only the ids, techniques, targets, body zones, and postures listed in the supplied legalActions. Never invent numbers, targets, body zones, or outcomes.
- The engine owns all math. Never compute or state Arousal, Poise, or Stamina results, dice totals, accuracy, or hit/miss outcomes.
- You may include an optional non-mechanical intent or flavor: a short taunt or line of dialogue. It cannot change the beat in any way.
- You may include an optional novelTechnique: {name, description, zones?} when nothing legal fits. It is compiled once and may be rejected. Then choose a legal action if one exists.
- Choose surrender or wait only when that type is legal for your participant.
- Keep variety: avoid repeating the last actions listed in recentActions, and vary targets, zones, and postures when it makes sense.
- Respect every hard limit in knownProfiles. Never select a target or body zone a limit forbids.
- Return only one JSON object shaped like {"actions":[...]} and nothing else. No prose, no markdown fence.`;

export const DEFAULT_LEWD_PROSE_PROMPT = `You are the Lewd Combat scene narrator. Convert the supplied beat sheet into prose.

Rules:
- Write 2 to 4 sentences of prose for the supplied beat sheet only.
- Never invent participants, acts, numbers, outcomes, or state changes. Never resolve the encounter or add a climax.
- Obey the supplied explicitness value (explicit by default, suggestive, or fade-to-black), the darker-theme flag, and every listed hard limit. If a limit forbids a detail, omit it.
- Use the supplied voices and tones, and keep the prose continuous with the previous scene prose.
- Return prose text only. No JSON, no headings, and no quotes around the whole reply.`;

/**
 * Tolerant schema for `{"actions":[...]}`. `strict: false` keeps providers from
 * rejecting the optional flavour and novel-technique fields.
 */
export const LEWD_AGENT_JSON_SCHEMA = Object.freeze({
    type: 'object',
    strict: false,
    additionalProperties: true,
    properties: {
        actions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    type: { type: 'string', enum: ['technique', 'wait', 'surrender'] },
                    techniqueId: { type: 'string' },
                    technique: { type: 'string' },
                    targetIds: { type: 'array', items: { type: 'string' } },
                    zone: { type: 'string' },
                    posture: { type: 'string', enum: ['lead', 'follow', 'switch'] },
                    intent: { type: 'string' },
                    flavor: { type: 'string' },
                    novelTechnique: { type: 'object' },
                },
            },
        },
        novelTechnique: {
            type: 'object',
            additionalProperties: true,
            properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                zones: { type: 'array', items: { type: 'string' } },
            },
        },
    },
    required: ['actions'],
});
