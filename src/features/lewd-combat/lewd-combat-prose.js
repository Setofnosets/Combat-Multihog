/**
 * lewd-combat-prose.js — the non-authoritative prose pass.
 *
 * The engine has already resolved every number before this module runs. The
 * prose pass only turns the latest beat(s) into 2–4 sentences on the **Main**
 * connection. It never imports the engine resolver, never mutates state, and
 * defers entirely while a narrator/state-model generation is running.
 */

import {
    describeLewdBeat,
} from './lewd-combat-markup.js';
import {
    DEFAULT_LEWD_PROSE_PROMPT,
} from './lewd-combat-prompts.js';

const PROSE_LIMIT = 1200;
const DEFAULT_TIMEOUT_MS = 45000;

function text(value) {
    return String(value ?? '').trim();
}

function arr(value) {
    if (Array.isArray(value)) return value;
    if (value == null || value === '') return [];
    return [value];
}

function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const item = text(value);
        if (!item || seen.has(item)) continue;
        seen.add(item);
        result.push(item);
    }
    return result;
}

function beatsList(beats) {
    return arr(beats).filter(beat => beat && typeof beat === 'object');
}

/**
 * True while the host is generating or the state model is running. Never
 * throws, and treats a missing host as idle.
 * @param {object} [globalRef]
 * @returns {boolean}
 */
export function isNarratorBusy(globalRef = globalThis) {
    try {
        if (typeof globalRef?._rpgStateModelRunning === 'function' && globalRef._rpgStateModelRunning()) {
            return true;
        }
        if (globalRef?._rpgGenerationBusy === true) return true;
        const context = globalRef?.SillyTavern?.getContext?.();
        if (context?.isGenerating === true) return true;
    } catch (_) {
        // A broken host bridge is treated as not busy; the caller still has the
        // templated fallback if the request itself fails.
    }
    return false;
}

function beatTargets(beat) {
    return arr(beat?.targets).map(target => ({
        name: text(target?.name),
        zone: text(target?.zone),
        check: Number(target?.check) || 0,
        defense: Number(target?.defense) || 0,
        hit: target?.hit === true,
        arousalDelta: Number(target?.arousalDelta) || 0,
        poiseDelta: Number(target?.poiseDelta) || 0,
        staminaDelta: Number(target?.staminaDelta) || 0,
        status: arr(target?.status).map(String),
        climaxed: target?.climaxed === true,
    }));
}

/**
 * Convert one or more engine beats into a plain beat sheet. Pure: the supplied
 * state and beats are only read.
 *
 * @param {object} state
 * @param {object|object[]} beats
 * @param {object} [options]
 * @returns {object}
 */
export function buildLewdBeatSheet(state, beats, options = {}) {
    void options;
    const list = beatsList(beats);
    const last = list.length ? list[list.length - 1] : null;
    const participants = arr(state?.participants);
    const limits = [];
    const voices = {};
    for (const participant of participants) {
        if (!participant || participant.spectator) continue;
        const profile = participant.profile || {};
        limits.push(...arr(profile.limits).map(String));
        const name = text(participant.name);
        if (name) voices[name] = text(profile.notes) || text(profile.role) || 'switch';
    }

    const exchanges = list.map(beat => ({
        actor: text(beat.actor?.name),
        posture: text(beat.posture),
        technique: text(beat.technique?.name),
        flavor: text(beat.flavor),
        targets: beatTargets(beat),
        stateChanges: arr(beat.stateChanges).map(String),
    }));
    const lastExchange = exchanges.length ? exchanges[exchanges.length - 1] : null;

    return {
        round: Number(last?.round) || Number(state?.round) || 1,
        tone: state?.settings?.lewdCombatExplicitness || 'explicit',
        darkerThemes: !!state?.settings?.lewdCombatDarkerThemes,
        limits: uniqueStrings(limits),
        voices,
        exchanges,
        // Flat convenience fields copied from the last exchange.
        actor: lastExchange?.actor || '',
        posture: lastExchange?.posture || '',
        technique: lastExchange?.technique || '',
        targets: lastExchange?.targets || [],
        stateChanges: lastExchange?.stateChanges || [],
    };
}

function encounterEnded(state) {
    return !!state && (state.status !== 'active' || state.stopped === true);
}

/**
 * Deterministic, non-explicit text used when the explicitness setting is
 * `fade-to-black`. No model call is made in that mode, so the prose pass cannot
 * disobey the setting or the hard limits.
 *
 * @param {object} state
 * @param {object|object[]} [beats]
 * @returns {string}
 */
export function buildLewdFadeToBlackProse(state, beats) {
    void state;
    const list = beatsList(beats);
    const last = list.length ? list[list.length - 1] : null;
    const actor = text(last?.actor?.name);
    const targets = arr(last?.targets).map(target => text(target?.name)).filter(Boolean);
    const pair = actor && targets.length
        ? `${actor} and ${targets.join(', ')}`
        : actor || targets.join(', ') || 'The participants';
    return `The scene fades to black around ${pair}. What follows is left to the imagination, and the board keeps its own count of the moment.`;
}

/**
 * Decide whether this beat or batch warrants a prose call.
 *
 * @param {object} state
 * @param {object|object[]} beats
 * @param {Record<string, any>} [settings]
 * @param {{ roundEnded?: boolean }} [options]
 * @returns {boolean}
 */
export function shouldGenerateLewdProse(state, beats, settings = {}, options = {}) {
    if (!state) return false;
    if (state.format && state.format !== 'lewd-combat') return false;
    const list = beatsList(beats);
    if (!list.length) return false;
    const frequency = text(settings?.lewdCombatProseFrequency) || 'per-exchange';
    if (frequency === 'off') return false;

    const last = list[list.length - 1];
    const ended = encounterEnded(state);
    if (text(last?.type) === 'wait' && !ended) return false;

    if (frequency === 'per-round') {
        return options.roundEnded === true || ended;
    }
    if (frequency === 'climax-only') {
        const climaxed = list.some(beat => arr(beat?.targets).some(target => target?.climaxed === true));
        return climaxed || ended || state.outcome === 'surrendered';
    }
    return true;
}

/**
 * Build the Main-connection prose prompt.
 *
 * @param {object} state
 * @param {object|object[]} beats
 * @param {Record<string, any>} [settings]
 * @param {object} [options]
 * @returns {{ system: string, user: string, sheet: object }}
 */
export function buildLewdProsePrompt(state, beats, settings = {}, options = {}) {
    const sheet = buildLewdBeatSheet(state, beats, options);
    const system = text(settings?.lewdCombatProsePrompt) || DEFAULT_LEWD_PROSE_PROMPT;
    if (settings?.lewdCombatExplicitness) sheet.tone = text(settings.lewdCombatExplicitness);
    if (settings && settings.lewdCombatDarkerThemes != null) {
        sheet.darkerThemes = !!settings.lewdCombatDarkerThemes;
    }
    const explicitness = sheet.tone || 'explicit';
    const darker = sheet.darkerThemes ? 'on' : 'off';
    const limits = sheet.limits.length ? sheet.limits.join(', ') : 'none declared';
    const user = [
        '## LEWD BEAT SHEET',
        '```json',
        JSON.stringify(sheet),
        '```',
        '',
        '## DIRECTIVE',
        `- Explicitness: ${explicitness}`,
        `- Darker themes: ${darker}`,
        `- Hard limits: ${limits}`,
        '- Never change state or invent numbers, participants, or outcomes.',
        `- Write 2 to 4 sentences for the exchange above. If explicitness is ${explicitness}, follow it exactly.`,
        '- Return prose only: no JSON, no headings, no quotes around the whole reply.',
    ].join('\n');
    return { system, user, sheet };
}

/**
 * The prose pass always uses the Main connection. No lewd/tactical agent
 * fallback is allowed here.
 * @param {Record<string, any>} [settings]
 * @returns {object}
 */
export function lewdProseRequestSettings(settings = {}) {
    return {
        connectionSource: 'default',
        connectionProfileId: '',
        completionPresetId: '',
        ollamaUrl: 'http://localhost:11434',
        ollamaModel: '',
        openaiUrl: '',
        openaiKey: '',
        openaiModel: '',
        maxTokens: Math.max(400, Number(settings?.lewdCombatProseMaxTokens) || 2000),
        debugMode: !!settings?.debugMode,
    };
}

function stripQuotes(value) {
    const raw = text(value);
    if (raw.length < 2) return raw;
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"')
        || (first === "'" && last === "'")
        || (first === '“' && last === '”')) {
        return raw.slice(1, -1).trim();
    }
    return raw;
}

/**
 * Accept plain prose, fenced prose, or `{"prose":"..."}`. Whitespace is
 * collapsed and the result is capped at 1200 characters.
 * @param {string|object} raw
 * @returns {string}
 */
export function parseLewdProseResponse(raw) {
    let value = raw;
    if (value && typeof value === 'object') {
        value = value.prose ?? value.text ?? '';
    }
    let source = text(value);
    if (!source) return '';

    const fenced = source.match(/```(?:[a-z-]+)?\s*([\s\S]*?)```/i);
    if (fenced) source = fenced[1].trim();

    if (source.startsWith('{')) {
        try {
            const parsed = JSON.parse(source);
            if (parsed && typeof parsed === 'object' && typeof parsed.prose === 'string') {
                source = parsed.prose;
            }
        } catch (_) {
            // Not JSON: keep the text as prose.
        }
    }
    const cleaned = stripQuotes(source).replace(/\s+/g, ' ').trim();
    return cleaned.slice(0, PROSE_LIMIT);
}

function abortableSignal(options) {
    const controller = new AbortController();
    const external = options.signal;
    let listener = null;
    if (external) {
        if (external.aborted) controller.abort();
        else if (typeof external.addEventListener === 'function') {
            listener = () => controller.abort();
            external.addEventListener('abort', listener);
        }
    }
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
        signal: controller.signal,
        cleanup() {
            clearTimeout(timer);
            if (external && listener) {
                try { external.removeEventListener('abort', listener); } catch (_) { /* no-op */ }
            }
        },
    };
}

/**
 * Generate prose for the latest beat(s). Never mutates state and never throws.
 *
 * @param {object} state
 * @param {object|object[]} beats
 * @param {Record<string, any>} [settings]
 * @param {{
 *   signal?: AbortSignal,
 *   sendStateRequest?: Function,
 *   timeoutMs?: number,
 *   roundEnded?: boolean,
 *   prompt?: string,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   prose?: string,
 *   fallback: string,
 *   error?: string,
 *   deferred?: boolean,
 *   skipped?: boolean,
 *   raw?: string,
 * }>}
 */
export async function generateLewdProse(state, beats, settings = {}, options = {}) {
    const list = beatsList(beats);
    const lastBeat = list.length ? list[list.length - 1] : null;
    const fallback = describeLewdBeat(lastBeat, state);

    if (!shouldGenerateLewdProse(state, list, settings, options)) {
        return { ok: false, skipped: true, fallback };
    }
    const tone = text(settings?.lewdCombatExplicitness) || text(state?.settings?.lewdCombatExplicitness) || 'explicit';
    if (tone === 'fade-to-black') {
        return { ok: true, prose: buildLewdFadeToBlackProse(state, list), fallback, suppressed: true };
    }
    if (isNarratorBusy()) {
        return { ok: false, deferred: true, fallback };
    }

    const prompts = buildLewdProsePrompt(state, list, settings, options);
    const system = text(options.prompt || settings?.lewdCombatProsePrompt) || prompts.system;

    let send = options.sendStateRequest;
    if (typeof send !== 'function') {
        try {
            const module = await import('../../../llm-client.js');
            send = module.sendStateRequest;
        } catch (error) {
            return { ok: false, error: `Prose connection unavailable: ${error?.message || error}`, fallback };
        }
    }
    if (typeof send !== 'function') {
        return { ok: false, error: 'The Main connection is not available.', fallback };
    }

    const { signal, cleanup } = abortableSignal(options);
    let raw;
    try {
        raw = await send(
            lewdProseRequestSettings(settings),
            system,
            prompts.user,
            signal,
            { stream: false, debugSource: 'Lewd Combat Prose' },
        );
    } catch (error) {
        return { ok: false, error: `Prose request failed: ${error?.message || error}`, fallback };
    } finally {
        cleanup();
    }

    const prose = parseLewdProseResponse(raw);
    if (!prose) {
        return { ok: false, error: 'The prose pass returned no usable text.', fallback, raw: String(raw ?? '') };
    }
    return { ok: true, prose, fallback, raw: String(raw ?? '') };
}
