const COMBATANT_HP_RX = /^(.+?):\s*([+-]?[\d,]+|\?+)(?:\/([\d,]+|\?+))?\s*HP\b(.*)$/i;
const RESOLVED_STATUS_RX = /(?:^|\|)\s*Status\s*:\s*(?:(?:\(\([^)]*\)\)|\([^)]*\))\s*)*(?:defeated|dead|fled|retreated|routed|surrendered|incapacitated)\b/i;
const FLED_STATUS_RX = /(?:^|\|)\s*Status\s*:\s*(?:(?:\(\([^)]*\)\)|\([^)]*\))\s*)*(?:fled|retreated|routed)\b/i;
const COMBAT_SIDE_HEADER_RX = /^(ENEMIES|(?:NON[-\s]+PARTY\s+)?ALLIES)\s*:?\s*$/i;
const COMBAT_STATE_RX = /^\s*COMBAT[ _-]?STATE\s*:\s*([A-Za-z_-]+)\s*$/im;
const COMBAT_ROUND_RX = /^\s*COMBAT ROUND\s+(\d+)\s*$/im;

const DORMANT_COMBAT_STATES = new Set([
    'dormant', 'parley', 'parle', 'negotiation', 'negotiating', 'standoff',
    'social', 'noncombat', 'non-combat', 'precombat', 'pre-combat', 'peaceful',
    'inactive', 'idle', 'staged',
]);

const ENGAGED_COMBAT_STATES = new Set([
    'hostile', 'active', 'engaged', 'combat', 'fighting', 'battle',
]);

const ENDED_COMBAT_STATES = new Set([
    'ended', 'resolved', 'over', 'complete', 'completed', 'closed', 'cleared',
    'none', 'no-combat', 'no_combat', 'victory', 'defeat', 'retreat', 'routed',
]);

/**
 * @param {string} body
 * @returns {boolean}
 */
function hasActiveEnemyCombatant(body) {
    return parseCombatants(body).some(entity =>
        entity.side === 'enemies' && !entity.lines.some(line => isResolvedCombatantStatusLine(line)));
}

/**
 * Read the explicit engagement state of the memo's [COMBAT] block.
 * @param {string} memo
 * @returns {'absent'|'ended'|'dormant'|'engaged'}
 */
export function getCombatMemoState(memo) {
    const match = String(memo || '').match(/\[COMBAT\]([\s\S]*?)\[\/COMBAT\]/i);
    if (!match) return 'absent';
    const body = String(match[1] || '').trim();
    if (!body || /^END_COMBAT$/i.test(body)) return 'ended';

    const explicit = body.match(COMBAT_STATE_RX)?.[1]?.toLowerCase();
    if (explicit) {
        if (DORMANT_COMBAT_STATES.has(explicit)) {
            return hasActiveEnemyCombatant(body) ? 'dormant' : 'ended';
        }
        if (ENDED_COMBAT_STATES.has(explicit)) return 'ended';
        if (ENGAGED_COMBAT_STATES.has(explicit)) {
            return hasActiveEnemyCombatant(body) ? 'engaged' : 'ended';
        }
    }

    // Hand-edited / backward-compatible shorthand: round 0 means a staged
    // roster, not a fight. Legacy blocks without any state header remain
    // engaged while they still contain an active enemy, so existing chats keep
    // their current behavior without letting stale rosters keep combat mode on.
    const round = Number(body.match(COMBAT_ROUND_RX)?.[1]);
    if (Number.isFinite(round) && round <= 0) return 'dormant';
    return hasActiveEnemyCombatant(body) ? 'engaged' : 'ended';
}

/**
 * @param {string} line
 * @returns {'enemies'|'allies'|null}
 */
export function parseCombatSideHeader(line) {
    const match = String(line || '').trim().match(COMBAT_SIDE_HEADER_RX);
    if (!match) return null;
    return /\bALLIES\b/i.test(match[1]) ? 'allies' : 'enemies';
}

/**
 * @param {string} line
 * @returns {boolean}
 */
export function isResolvedCombatantStatusLine(line) {
    return RESOLVED_STATUS_RX.test(String(line || '').trim());
}

/**
 * @param {string} line
 * @returns {boolean}
 */
export function isFledCombatantStatusLine(line) {
    return FLED_STATUS_RX.test(String(line || '').trim());
}

/**
 * @param {string} content
 * @returns {{
 *   tokens: ({ type: 'line', line: string }|{ type: 'header', line: string, side: 'enemies'|'allies' }|{ type: 'entity', entity: { name: string, side: 'enemies'|'allies', lines: string[] } })[],
 *   entities: { name: string, side: 'enemies'|'allies', lines: string[] }[]
 * }}
 */
function parseCombatLayout(content) {
    const tokens = [];
    const entities = [];
    let current = null;
    /** Headerless combat remains backward-compatible and defaults to enemies. */
    let currentSide = /** @type {'enemies'|'allies'} */ ('enemies');

    for (const rawLine of String(content || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const side = parseCombatSideHeader(line);
        if (side) {
            current = null;
            currentSide = side;
            tokens.push({
                type: 'header',
                line: side === 'allies' ? 'NON-PARTY ALLIES:' : 'ENEMIES:',
                side,
            });
            continue;
        }
        const hpMatch = line.match(COMBATANT_HP_RX);
        if (hpMatch) {
            current = { name: hpMatch[1].trim(), side: currentSide, lines: [line] };
            entities.push(current);
            tokens.push({ type: 'entity', entity: current });
        } else if (current) {
            current.lines.push(line);
        } else {
            tokens.push({ type: 'line', line });
        }
    }

    return { tokens, entities };
}

/**
 * @param {string} content
 * @returns {{ name: string, side: 'enemies'|'allies', lines: string[] }[]}
 */
export function parseCombatants(content) {
    return parseCombatLayout(content).entities;
}

/**
 * Move explicitly resolved combatants out of memo content and into a UI-only
 * archive. Zero HP alone is intentionally insufficient: dying combatants and
 * creatures with death saves remain active until their Status says Defeated or Dead.
 *
 * @param {string} content
 * @param {{ name: string, content: string }[]} [previousArchive=[]]
 * @returns {{ activeContent: string, defeatedCombatants: { name: string, content: string }[] }}
 */
export function partitionResolvedCombatants(content, previousArchive = []) {
    const { tokens, entities } = parseCombatLayout(content);
    const active = [];
    const resolved = [];

    for (const entity of entities) {
        const entityContent = entity.lines.join('\n');
        // The UI-only archive is specifically for defeated enemies. Temporary
        // allies remain in the active memo even if their status says defeated.
        if (entity.side === 'enemies' && entity.lines.some(isResolvedCombatantStatusLine)) {
            resolved.push({ name: entity.name, content: entityContent });
        } else {
            active.push(entity);
        }
    }

    const activeNames = new Set(active.map(entity => entity.name.toLocaleLowerCase()));
    const archiveByName = new Map();
    for (const entry of Array.isArray(previousArchive) ? previousArchive : []) {
        const name = String(entry?.name || '').trim();
        const archivedContent = String(entry?.content || '').trim();
        if (!name || !archivedContent || activeNames.has(name.toLocaleLowerCase())) continue;
        archiveByName.set(name.toLocaleLowerCase(), { name, content: archivedContent });
    }
    for (const entry of resolved) {
        archiveByName.set(entry.name.toLocaleLowerCase(), entry);
    }

    return {
        activeContent: tokens.flatMap(token => {
            if (token.type === 'line' || token.type === 'header') return [token.line];
            return active.includes(token.entity) ? token.entity.lines : [];
        }).join('\n').trim(),
        defeatedCombatants: [...archiveByName.values()],
    };
}

/**
 * Remove explicitly resolved combatants from every COMBAT block in a memo.
 * This is a fail-closed context filter for legacy saves and manual raw edits;
 * normal tracker merges already move these entries into the UI-only archive.
 *
 * @param {string} memo
 * @returns {string}
 */
export function stripResolvedCombatantsFromMemo(memo) {
    return String(memo || '').replace(
        /\[COMBAT\]([\s\S]*?)\[\/COMBAT\]/gi,
        (fullBlock, content) => {
            if (/^\s*END_COMBAT\s*$/i.test(content)) return fullBlock;
            const { activeContent } = partitionResolvedCombatants(content);
            return `[COMBAT]\n${activeContent}\n[/COMBAT]`;
        },
    );
}

/**
 * Append the UI-only defeated archive to an active COMBAT block for rendering.
 * The returned string is display-only; the supplied memo remains unchanged.
 *
 * @param {string} memo
 * @param {{ name: string, content: string }[]} archive
 * @returns {string}
 */
export function buildCombatDisplayMemo(memo, archive) {
    const entries = Array.isArray(archive)
        ? archive.filter(entry => String(entry?.name || '').trim() && String(entry?.content || '').trim())
        : [];
    if (!entries.length) return String(memo || '');

    return String(memo || '').replace(/\[COMBAT\]([\s\S]*?)\[\/COMBAT\]/i, (fullBlock, content) => {
        if (/^\s*END_COMBAT\s*$/i.test(content)) return fullBlock;
        const activeNames = new Set(parseCombatants(content).map(entity => entity.name.toLocaleLowerCase()));
        const uiEntries = entries
            .filter(entry => !activeNames.has(String(entry.name).trim().toLocaleLowerCase()))
            .map(entry => String(entry.content).trim());
        if (!uiEntries.length) return fullBlock;

        const lines = String(content).trim().split(/\r?\n/);
        const firstAlliesHeader = lines.findIndex(line => parseCombatSideHeader(line) === 'allies');
        const insertionIndex = firstAlliesHeader >= 0 ? firstAlliesHeader : lines.length;
        lines.splice(insertionIndex, 0, ...uiEntries.flatMap(entry => entry.split(/\r?\n/)));
        return `[COMBAT]\n${lines.filter(Boolean).join('\n')}\n[/COMBAT]`;
    });
}
