/**
 * combat-mode.js — the single source of truth for the three combat styles.
 *
 * `combatStyle` is the new explicit setting. The legacy `tacticalCombatEnabled`
 * boolean is kept as a mirror so older chats and integrations keep working.
 * An empty `combatStyle` means "not migrated yet": resolve it from the legacy
 * flag instead of treating the default as narrative.
 */

export const COMBAT_STYLES = ['narrative', 'tactical', 'traditional'];

export const COMBAT_STYLE_LABELS = {
    narrative: 'Narration',
    tactical: 'Tactical grid',
    traditional: 'Traditional turn-based',
};

/**
 * @param {unknown} value
 * @returns {'narrative'|'tactical'|'traditional'|null}
 */
export function normalizeCombatStyle(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    return COMBAT_STYLES.includes(raw) ? raw : null;
}

/**
 * Resolve the active style. Explicit values always win. If no style has been
 * persisted yet (old settings), tactical users retain their old behavior.
 * @param {Record<string, any>|null|undefined} settings
 * @returns {'narrative'|'tactical'|'traditional'}
 */
export function resolveCombatStyle(settings) {
    const explicit = normalizeCombatStyle(settings?.combatStyle);
    if (explicit) return explicit;
    return settings?.tacticalCombatEnabled ? 'tactical' : 'narrative';
}

/**
 * Persist a style and keep the legacy tactical flag aligned.
 * @param {Record<string, any>} settings
 * @param {string} style
 * @returns {'narrative'|'tactical'|'traditional'}
 */
export function setCombatStyle(settings, style) {
    const resolved = normalizeCombatStyle(style) || 'narrative';
    if (!settings) return resolved;
    settings.combatStyle = resolved;
    settings.tacticalCombatEnabled = resolved === 'tactical';
    return resolved;
}

export function isNarrativeCombatMode(settings) {
    return resolveCombatStyle(settings) === 'narrative';
}

export function isTacticalCombatMode(settings) {
    return resolveCombatStyle(settings) === 'tactical';
}

export function isTraditionalCombatMode(settings) {
    return resolveCombatStyle(settings) === 'traditional';
}
