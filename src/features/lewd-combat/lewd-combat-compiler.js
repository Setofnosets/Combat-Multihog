/**
 * lewd-combat-compiler.js — one-time compiler for novel techniques.
 *
 * When the player or the opponent AI names a technique the catalog does not
 * know, the name/description is sent to a small agent once. The response is
 * validated into the canonical schema and cached in
 * `lewdCombatTechniqueCache`; later uses read the cache and never call the model
 * again. A compiler failure is visible and never blocks the board: the action is
 * rejected and the engine's deterministic local policy runs.
 *
 * The compiler call uses the Lewd Combat agent connection when configured and
 * falls back to the tactical combat connection until the U9 settings pane lands.
 */

import {
    DEFAULT_LEWD_TECHNIQUE,
    LEWD_ACT_ROLES,
    LEWD_ACT_TYPES,
    LEWD_TECHNIQUE_CATEGORIES,
    LEWD_TARGET_MODES,
    validateLewdTechnique,
} from './lewd-combat-techniques.js';
import {
    findCachedTechnique,
    writeTechniqueCache,
} from './lewd-combat-compendium.js';

export const DEFAULT_LEWD_COMPILER_PROMPT = `You are the Lewd Combat technique compiler. Convert one named technique into the strict JSON schema below.

Rules:
- Return only a single JSON object. No prose, no markdown fence.
- Never invent a body zone outside: lips, neck, ears, chest, breasts, nipples, back, waist, hips, groin, genitals, thighs, hands, feet, throat, mouth, tail, full_body.
- Category must be one of: stance, hold, technique, counter, finisher, tease, command, recover, submit.
- targetMode must be one of: self, single, pair, group, aura.
- check.stat must be one of: str, dex, con, int, wis, cha.
- actType must be one of: penetration, oral, manual, bondage, masturbation, other, or null.
- actRole must be one of: give, receive, mutual, or null.
- arousal and poise are dice expressions such as "1d6+2" or "0".
- Keep the numbers modest and comparable to the shipped catalog.
- Do not write explicit prose; describe the mechanic in one short sentence.
- Respect the requested tone but never add limits, participants, or outcomes.
- requires may only use: hold, stance, overwhelmed, act, actType, actRole, anatomy, skill, trait, kink.
- applies may only use: status, stance, act. Use applies.act with an act id to set the pair's act; null clears it.

Schema:
{
  "id": "kebab-case-id",
  "name": "Technique Name",
  "category": "technique",
  "description": "One sentence.",
  "posture": "either",
  "zones": ["neck"],
  "targetMode": "single",
  "tags": ["teasing"],
  "actType": null,
  "actRole": null,
  "check": { "stat": "cha", "accuracy": 1 },
  "arousal": "1d6+2",
  "poise": "1d4",
  "staminaDrain": 0,
  "requires": {
    "hold": null, "stance": null, "overwhelmed": false,
    "act": null, "actType": null, "actRole": null,
    "anatomy": null, "skill": null, "trait": null, "kink": null
  },
  "applies": {},
  "hold": null,
  "uses": { "max": null, "recharge": "at-will" },
  "ai": { "priority": 2, "conditions": [] }
}`;

export const LEWD_COMPILER_JSON_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string', enum: [...LEWD_TECHNIQUE_CATEGORIES] },
        description: { type: 'string' },
        posture: {
            anyOf: [
                { type: 'string', enum: ['either', 'any', 'lead', 'follow', 'switch'] },
                { type: 'array', items: { type: 'string', enum: ['lead', 'follow', 'switch'] } },
            ],
        },
        zones: { type: 'array', items: { type: 'string' } },
        targetMode: { type: 'string', enum: [...LEWD_TARGET_MODES] },
        tags: { type: 'array', items: { type: 'string' } },
        check: {
            type: 'object',
            properties: {
                stat: { type: 'string', enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'] },
                accuracy: { type: 'number' },
            },
        },
        actType: {
            anyOf: [
                { type: 'string', enum: [...LEWD_ACT_TYPES] },
                { type: 'null' },
            ],
        },
        actRole: {
            anyOf: [
                { type: 'string', enum: [...LEWD_ACT_ROLES] },
                { type: 'null' },
            ],
        },
        arousal: { type: ['string', 'number'] },
        poise: { type: ['string', 'number'] },
        staminaDrain: { type: 'number' },
        requires: { type: 'object' },
        applies: { type: 'object' },
        hold: { type: ['object', 'string', 'null'] },
        uses: { type: 'object' },
        ai: { type: 'object' },
    },
    required: ['name', 'category', 'zones', 'targetMode'],
});

function slug(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'technique';
}

function extractJsonObject(text) {
    if (text && typeof text === 'object' && !Array.isArray(text)) return text;
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const source = fenced ? fenced[1].trim() : raw;
    try {
        return JSON.parse(source);
    } catch (_) {
        // Reasoning models sometimes wrap the object in prose; scan for the
        // first balanced object rather than failing on the whole response.
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

/** User prompt for the compiler agent. */
export function buildLewdCompilerUserPrompt(request = {}) {
    const name = String(request.name ?? '').trim();
    const description = String(request.description ?? '').trim();
    const tone = String(request.tone ?? 'explicit').trim();
    const zones = Array.isArray(request.zones) ? request.zones.join(', ') : String(request.zones ?? '').trim();
    return [
        `Technique name: ${name}`,
        description ? `Player/AI description: ${description}` : '',
        `Tone: ${tone}`,
        zones ? `Preferred zones: ${zones}` : '',
        `Return the canonical JSON object. Use the name "${name}" and id "${slug(name)}".`,
    ].filter(Boolean).join('\n');
}

/**
 * Parse and validate a compiler response.
 * @param {string|object} raw
 * @param {{ name?: string }} [request]
 * @returns {{ ok: boolean, technique: object|null, error: string }}
 */
export function parseLewdCompilerResponse(raw, request = {}) {
    const value = extractJsonObject(raw);
    if (!value) return { ok: false, technique: null, error: 'The compiler did not return a JSON object.' };
    const requestedName = String(request.name ?? '').trim();
    const withName = requestedName ? { ...value, name: requestedName, id: slug(requestedName) } : value;
    const result = validateLewdTechnique(withName);
    if (!result.ok) {
        return { ok: false, technique: null, error: result.errors.join(' ') };
    }
    return { ok: true, technique: result.technique, error: '' };
}

/**
 * Connection settings for the compiler. The dedicated lewd keys are used when
 * present; otherwise the tactical combat connection is a safe fallback.
 */
export function lewdCompilerRequestSettings(settings = {}) {
    return {
        connectionSource: settings.lewdCombatConnectionSource
            || settings.tacticalCombatConnectionSource
            || 'default',
        connectionProfileId: settings.lewdCombatConnectionProfileId
            || settings.tacticalCombatConnectionProfileId
            || '',
        completionPresetId: settings.lewdCombatCompletionPresetId
            || settings.tacticalCombatCompletionPresetId
            || '',
        ollamaUrl: settings.lewdCombatOllamaUrl || settings.tacticalCombatOllamaUrl || 'http://localhost:11434',
        ollamaModel: settings.lewdCombatOllamaModel || settings.tacticalCombatOllamaModel || '',
        openaiUrl: settings.lewdCombatOpenaiUrl || settings.tacticalCombatOpenaiUrl || '',
        openaiKey: settings.lewdCombatOpenaiKey || settings.tacticalCombatOpenaiKey || '',
        openaiModel: settings.lewdCombatOpenaiModel || settings.tacticalCombatOpenaiModel || '',
        maxTokens: Math.max(600, Number(settings.lewdCombatCompilerMaxTokens) || 2000),
        debugMode: !!settings.debugMode,
    };
}

/**
 * Compile one novel technique and cache the validated result.
 *
 * @param {{ name: string, description?: string, tone?: string, zones?: string[] }} request
 * @param {Record<string, any>} [settings]
 * @param {{
 *   sendStateRequest?: Function,
 *   signal?: AbortSignal,
 *   prompt?: string,
 * }} [deps]
 * @returns {Promise<{ ok: boolean, technique?: object, cached?: boolean, error?: string, raw?: string }>}
 */
export async function compileLewdTechnique(request = {}, settings = {}, deps = {}) {
    const name = String(request.name ?? '').trim().slice(0, 80);
    if (!name) return { ok: false, error: 'A technique name is required.' };

    const cached = findCachedTechnique(settings, name);
    if (cached) return { ok: true, technique: cached, cached: true };

    const systemPrompt = String(deps.prompt || settings?.lewdCombatCompilerPrompt || DEFAULT_LEWD_COMPILER_PROMPT);
    const userPrompt = buildLewdCompilerUserPrompt({ ...request, name });

    let send = deps.sendStateRequest;
    if (typeof send !== 'function') {
        try {
            const module = await import('../../../llm-client.js');
            send = module.sendStateRequest;
        } catch (error) {
            return { ok: false, error: `Compiler connection unavailable: ${error?.message || error}` };
        }
    }
    if (typeof send !== 'function') {
        return { ok: false, error: 'Compiler connection is not available.' };
    }

    let raw;
    try {
        raw = await send(
            lewdCompilerRequestSettings(settings),
            systemPrompt,
            userPrompt,
            deps.signal || null,
            {
                stream: false,
                debugSource: 'Lewd Combat Compiler',
                jsonSchema: LEWD_COMPILER_JSON_SCHEMA,
            },
        );
    } catch (error) {
        return { ok: false, error: `Compiler request failed: ${error?.message || error}` };
    }

    const parsed = parseLewdCompilerResponse(raw, { name });
    if (!parsed.ok) return { ok: false, error: parsed.error, raw: String(raw ?? '') };

    writeTechniqueCache(settings, parsed.technique);
    return { ok: true, technique: parsed.technique, cached: false, raw: String(raw ?? '') };
}

/** Convenience alias used by the board/agent when an id is unknown. */
export const resolveNovelLewdTechnique = compileLewdTechnique;

/** The canonical shape is exported so settings/tests can show an example. */
export const LEWD_COMPILER_EXAMPLE = Object.freeze({ ...DEFAULT_LEWD_TECHNIQUE });
