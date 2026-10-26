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
 * Board lifecycle markers (`preparing`, `finalization`) are written by the
 * tactical/traditional UI and normally cleared by the job that wrote them. A
 * marker that predates this page session can no longer be in flight: the job
 * died with the reload, so treating it as busy would block style switching
 * forever. The same applies once a marker outlives the longest plausible job
 * (a hung request that never cleaned up after itself).
 */
const SESSION_STARTED_AT = Date.now();
const PREPARING_STALE_MS = 15 * 60 * 1000;
const FINALIZING_STALE_MS = 90 * 1000;

const COMBAT_BOARD_MAPS = [
    { style: 'tactical', key: 'tacticalCombatByChat' },
    { style: 'traditional', key: 'traditionalCombatByChat' },
];

/**
 * @param {number} startedAt
 * @param {number} maxAgeMs
 * @param {number} now
 * @param {number} sessionStartedAt
 * @returns {boolean}
 */
function markerIsLive(startedAt, maxAgeMs, now, sessionStartedAt) {
    const since = Number(startedAt) || 0;
    // Legacy markers carry no clock. Stay conservative and keep blocking; the
    // settings pane offers a one-click clear for exactly this case.
    if (!since) return true;
    if (since < sessionStartedAt) return false;
    return now - since <= maxAgeMs;
}

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

/**
 * Classify a saved board. `idle` means nothing is running, so that board cannot
 * conflict with a newly selected style.
 * @param {Record<string, any>|null|undefined} state
 * @param {{ now?: number, sessionStartedAt?: number }} [options]
 * @returns {'idle'|'preparing'|'finalizing'|'active'}
 */
export function combatBoardPhase(state, options = {}) {
    if (!state || typeof state !== 'object') return 'idle';
    const now = Number.isFinite(options?.now) ? options.now : Date.now();
    const sessionStartedAt = Number.isFinite(options?.sessionStartedAt)
        ? options.sessionStartedAt
        : SESSION_STARTED_AT;
    if (state.preparing?.active
        && markerIsLive(state.preparing.startedAt, PREPARING_STALE_MS, now, sessionStartedAt)) {
        return 'preparing';
    }
    if (state.finalization?.finalizing
        && markerIsLive(state.finalization.finalizingStartedAt, FINALIZING_STALE_MS, now, sessionStartedAt)) {
        return 'finalizing';
    }
    if (state.status === 'active') return 'active';
    return 'idle';
}

/**
 * Every saved board that would still conflict with a style switch, newest
 * first. Chat ids are included so the settings pane can name the offending
 * chat instead of telling the user to hunt through them.
 * @param {Record<string, any>|null|undefined} settings
 * @param {{ now?: number, sessionStartedAt?: number }} [options]
 * @returns {{ chatId: string, style: 'tactical'|'traditional', phase: 'preparing'|'finalizing'|'active', status: string, title: string, round: number, updatedAt: number }[]}
 */
export function listActiveCombatBoards(settings, options = {}) {
    const boards = [];
    for (const { style, key } of COMBAT_BOARD_MAPS) {
        const map = settings?.[key];
        if (!map || typeof map !== 'object') continue;
        for (const [chatId, state] of Object.entries(map)) {
            const phase = combatBoardPhase(state, options);
            if (phase === 'idle') continue;
            boards.push({
                chatId: String(chatId),
                style,
                phase,
                status: String(state?.status || ''),
                title: String(state?.title || '').trim(),
                round: Number(state?.round) || 0,
                updatedAt: Number(state?.updatedAt) || 0,
            });
        }
    }
    return boards.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * True when any saved board for any chat is still active or preparing. Style
 * switching is blocked while this is true so a hidden board cannot keep
 * [COMBAT] ACTIVE while the newly selected mode starts a second encounter.
 * @param {Record<string, any>|null|undefined} settings
 * @param {{ now?: number, sessionStartedAt?: number }} [options]
 * @returns {boolean}
 */
export function hasActiveCombatBoard(settings, options = {}) {
    return listActiveCombatBoards(settings, options).length > 0;
}
