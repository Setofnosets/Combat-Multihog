/**
 * skill-registry-discovery.js — populate the Campaign Skill Registry outside
 * encounter creation.
 *
 * The encounter builders register every parsed unit once. Existing encounters,
 * resumed boards, and chats that were played before this feature also need a
 * backfill path so the JSON ledger and its lorebook mirror are never empty just
 * because the fight was created earlier.
 */

import { getActiveChatId } from '../../../state-manager.js';
import { collectEncounterContext } from '../tactical-combat/tactical-combat-context.js';
import { registerSkillsFromUnits } from './skill-registry.js';
import { persistSkillRegistry } from './skill-registry-store.js';

// Fallback loadouts are synthetic and must not pollute the ledger. Older saved
// boards do not carry a `source` marker, so recognize the shipped names.
const FALLBACK_SKILL_NAMES = new Set(['cleave', 'second wind', 'aimed shot', 'power attack']);

function chatContext(ctx) {
    if (ctx && typeof ctx === 'object') return ctx;
    try { return SillyTavern.getContext(); } catch (_) { return {}; }
}

function sanitizeStateUnit(unit) {
    if (!unit || typeof unit !== 'object') return unit;
    const skills = (Array.isArray(unit.skills) ? unit.skills : []).filter(skill => {
        if (!skill || typeof skill !== 'object') return false;
        if (skill.source === 'fallback' || skill.synthetic === true) return false;
        const name = String(skill.name || '').trim().toLowerCase();
        // Legacy normalized boards dropped `source`; only suppress the exact
        // shipped fallback names, never a real ability with the same name that
        // still carries its authored metadata.
        return !(!skill.source && FALLBACK_SKILL_NAMES.has(name));
    });
    return { ...unit, skills };
}

function unitsFromContext(context) {
    return {
        playerUnits: Array.isArray(context?.playerUnits) ? context.playerUnits : [],
        allies: Array.isArray(context?.allies) ? context.allies : [],
        enemies: Array.isArray(context?.enemies) ? context.enemies : [],
    };
}

function unitsFromState(state) {
    const units = Array.isArray(state?.units) ? state.units : [];
    const split = side => units
        .filter(unit => unit?.side === side)
        .map(unit => sanitizeStateUnit(unit));
    return {
        playerUnits: split('player'),
        allies: split('ally'),
        enemies: split('enemy'),
    };
}

function registryHasEntries(settings) {
    return !!settings?.skillRegistry?.skills && Object.keys(settings.skillRegistry.skills).length > 0;
}

function finishDiscovery(settings, changed, options = {}) {
    if (options.persist === false) return changed;
    const chatId = String(options.chatId || getActiveChatId() || '');
    if (!chatId) return changed;
    if (changed || (options.forceMirror !== false && registryHasEntries(settings))) {
        persistSkillRegistry(settings, chatId, { force: true });
    }
    return changed;
}

/**
 * Parse the current memo and register its player, party, enemy-special, item,
 * and class entries. Safe to call outside combat.
 * @param {Record<string, any>} settings
 * @param {object} [ctx]
 * @param {{ chatId?: string, persist?: boolean, forceMirror?: boolean }} [options]
 * @returns {number}
 */
export function registerSkillsFromMemo(settings, ctx = null, options = {}) {
    if (!settings) return 0;
    let context;
    try {
        context = collectEncounterContext(settings, chatContext(ctx), {});
    } catch (_) {
        return 0;
    }
    const changed = registerSkillsFromUnits(settings, unitsFromContext(context), { source: 'memo' });
    return finishDiscovery(settings, changed, options);
}

/**
 * Register skills from an already-built encounter state. This covers resumed
 * boards, boards started before the registry feature, and agent-authored
 * enemies that never appeared in the memo.
 * @param {Record<string, any>} settings
 * @param {object} state
 * @param {{ chatId?: string, persist?: boolean, forceMirror?: boolean }} [options]
 * @returns {number}
 */
export function registerSkillsFromEncounterState(settings, state, options = {}) {
    if (!settings || !state?.units) return 0;
    const changed = registerSkillsFromUnits(settings, unitsFromState(state), { source: 'memo' });
    return finishDiscovery(settings, changed, options);
}

/**
 * Full chat backfill: memo first, then any saved tactical/traditional board.
 * @param {Record<string, any>} settings
 * @param {{ chatId?: string, ctx?: object, persist?: boolean, forceMirror?: boolean }} [options]
 * @returns {number}
 */
export function backfillSkillRegistry(settings, options = {}) {
    if (!settings) return 0;
    const chatId = String(options.chatId || getActiveChatId() || '');
    const shared = {
        chatId,
        persist: false,
        forceMirror: false,
    };
    let changed = 0;
    changed += registerSkillsFromMemo(settings, options.ctx, shared);
    const boards = [
        settings.tacticalCombatByChat?.[chatId],
        settings.traditionalCombatByChat?.[chatId],
    ];
    for (const state of boards) {
        if (!state?.units?.length) continue;
        changed += registerSkillsFromEncounterState(settings, state, shared);
    }
    return finishDiscovery(settings, changed, {
        chatId,
        persist: options.persist,
        forceMirror: options.forceMirror,
    });
}
