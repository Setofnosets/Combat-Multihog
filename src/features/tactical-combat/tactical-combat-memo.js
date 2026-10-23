/**
 * tactical-combat-memo.js — deterministic board ↔ State Memo synchronization.
 *
 * The tactical board is authoritative while an encounter is active. Waiting for
 * the State Tracker to infer the roster from prose leaves the memo one turn
 * behind, so this module writes the board roster into [COMBAT] at the moment an
 * encounter starts and patches the party's final HP when it ends.
 *
 * Deliberately dependency-free: the UI, outcome handoff, and tests can all use
 * these helpers without pulling in SillyTavern runtime state.
 */

import { parseCombatants } from '../../state/combat-persistence.js';

const COMBAT_BLOCK_RX = /\[COMBAT\][\s\S]*?\[\/COMBAT\]/i;
const HP_LINE_RX = /^(\s*(?:[-*+•]\s*)?)(.{1,160}?):\s*([+-]?[\d,]+|\?+)(?:\s*\/\s*([\d,]+|\?+))?\s*HP\b(.*)$/i;

function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeName(value) {
    return cleanText(value)
        .replace(/\{\{user\}\}/gi, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/^[-*+•]\s*/, '')
        .trim()
        .toLowerCase();
}

function sameName(a, b) {
    const left = normalizeName(a);
    const right = normalizeName(b);
    if (!left || !right) return false;
    return left === right || left.includes(right) || right.includes(left);
}

function numberOr(value, fallback = 0) {
    const n = Number(String(value ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : fallback;
}

function statusLine(unit) {
    if (unit?.defeated) return 'Defeated';
    if (unit?.fled) return 'Fled';
    const statuses = Array.isArray(unit?.statuses) ? unit.statuses : [];
    if (!statuses.length) return 'Healthy';
    return statuses
        .map(status => {
            const label = cleanText(status?.label || status?.name || 'Afflicted');
            const rounds = Number(status?.rounds) || 0;
            return rounds > 0 ? `${label} (${rounds} round${rounds === 1 ? '' : 's'})` : label;
        })
        .join(', ');
}

function abilityLine(unit) {
    const skills = (Array.isArray(unit?.skills) ? unit.skills : []).slice(0, 6);
    if (!skills.length) return '';
    return skills.map(skill => {
        const uses = Number(skill?.uses);
        const maxUses = Number(skill?.maxUses);
        const usage = Number.isFinite(uses) && Number.isFinite(maxUses) && maxUses > 0
            ? `; ${Math.max(0, uses)}/${maxUses}`
            : '';
        const description = cleanText(skill?.description || skill?.name || '');
        return `${cleanText(skill?.name || 'Ability')} (${description}${usage})`;
    }).join(', ');
}

function buildUnitBlock(unit) {
    const name = cleanText(unit?.name || 'Combatant').slice(0, 80);
    const hp = Math.max(0, numberOr(unit?.hp, 0));
    const maxHp = Math.max(1, numberOr(unit?.maxHp, hp || 1));
    const ac = Math.max(1, numberOr(unit?.ac, 12));
    const attackBonus = numberOr(unit?.attackBonus, 0);
    const damage = cleanText(unit?.damage || '1d6');
    const damageType = cleanText(unit?.damageType || '');
    const lines = [
        `${name}: ${hp}/${maxHp} HP`,
        `Att/def: Attack (1 attack, ${attackBonus >= 0 ? '+' : ''}${attackBonus} / ${damage}${damageType ? ` ${damageType}` : ''}) | Armor (AC: ${ac})`,
    ];
    const abilities = abilityLine(unit);
    if (abilities) lines.push(`Abilities: ${abilities}`);
    if (unit?.notes) lines.push(`Other: ${cleanText(unit.notes).slice(0, 300)}`);
    lines.push(`Status: ${statusLine(unit)}`);
    return lines.join('\n');
}

/**
 * Serialize a board encounter into the memo's [COMBAT] format.
 * @param {object} state
 * @returns {string}
 */
export function buildCombatMemoBlock(state) {
    if (!state || !Array.isArray(state.units)) return '[COMBAT]\nEND_COMBAT\n[/COMBAT]';
    const enemies = state.units.filter(unit => unit?.side === 'enemy');
    const allies = state.units.filter(unit => unit?.side === 'ally');
    const lines = ['[COMBAT]', `COMBAT ROUND ${Number(state.round) || 1}`, 'ENEMIES:'];
    if (enemies.length) {
        for (const unit of enemies) lines.push(buildUnitBlock(unit));
    }
    if (allies.length) {
        lines.push('NON-PARTY ALLIES:');
        for (const unit of allies) lines.push(buildUnitBlock(unit));
    }
    lines.push('[/COMBAT]');
    return lines.join('\n');
}

/**
 * Replace the active [COMBAT] block, or append one when absent.
 * @param {string} memo
 * @param {string} block
 * @returns {string}
 */
export function replaceCombatBlock(memo, block) {
    const source = String(memo || '');
    const next = String(block || '').trim();
    if (!next) return source;
    if (COMBAT_BLOCK_RX.test(source)) {
        return source.replace(COMBAT_BLOCK_RX, () => next).replace(/\n{3,}/g, '\n\n').trim();
    }
    return `${source.trimEnd()}${source.trim() ? '\n\n' : ''}${next}`.trim();
}

/**
 * Write the board roster into the State Memo as soon as an encounter starts.
 * @param {object} state
 * @param {Record<string, any>} settings
 * @returns {string} the updated memo
 */
export function seedCombatMemo(state, settings) {
    if (!state || !settings) return String(settings?.currentMemo || '');
    settings.combatDefeatedUi = [];
    settings.currentMemo = replaceCombatBlock(settings.currentMemo, buildCombatMemoBlock(state));
    return settings.currentMemo;
}

/**
 * Close the memo's combat block. The block intentionally remains visible for
 * one tracker pass so stale enemies cannot be re-created from the final prose.
 * @param {object} state
 * @param {Record<string, any>} settings
 * @returns {string} the updated memo
 */
export function endCombatMemo(state, settings) {
    if (!settings) return '';
    const wasActive = COMBAT_BLOCK_RX.test(String(settings.currentMemo || ''));
    if (wasActive) {
        settings.currentMemo = replaceCombatBlock(settings.currentMemo, '[COMBAT]END_COMBAT[/COMBAT]');
    }
    settings.combatDefeatedUi = [];
    void state;
    return settings.currentMemo;
}

function matchUnitForHeader(units, headerName, used) {
    const name = normalizeName(headerName);
    return (units || []).find(unit => {
        if (!unit || used?.has(unit.id)) return false;
        return sameName(name, unit.name);
    }) || null;
}

function patchHpLine(line, unit) {
    const match = String(line || '').match(HP_LINE_RX);
    if (!match || !unit) return line;
    const hp = Math.max(0, numberOr(unit.hp, numberOr(match[3], 0)));
    const maxHp = Math.max(1, numberOr(unit.maxHp, numberOr(match[4], hp || 1)));
    return `${match[1]}${match[2]}: ${Math.min(hp, maxHp)}/${maxHp} HP${match[5] || ''}`;
}

function patchBlockHp(content, units, options = {}) {
    const lines = String(content || '').split(/\r?\n/);
    const used = new Set();
    let matched = false;
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(HP_LINE_RX);
        if (!match) continue;
        const unit = matchUnitForHeader(units, match[2], used);
        if (unit) {
            lines[index] = patchHpLine(lines[index], unit);
            used.add(unit.id);
            matched = true;
        }
    }
    if (!matched && options.fallbackUnit) {
        const index = lines.findIndex(line => HP_LINE_RX.test(line));
        if (index >= 0) lines[index] = patchHpLine(lines[index], options.fallbackUnit);
    }
    return lines.join('\n');
}

function patchNamedBlock(memo, tag, units, options = {}) {
    const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`(\\[${escaped}\\])([\\s\\S]*?)(\\[\\/${escaped}\\])`, 'i');
    return String(memo || '').replace(rx, (full, open, content, close) => {
        return `${open}${patchBlockHp(content, units, options)}${close}`;
    });
}

/**
 * Remove a previous encounter's COMBAT block when it is provably stale.
 * A new [COMBAT] block with different enemies is preserved for the next fight.
 *
 * @param {object|null} previousState
 * @param {Record<string, any>} settings
 * @returns {{ removed: boolean, memo: string }}
 */
export function clearStaleCombatMemo(previousState, settings) {
    if (!settings) return { removed: false, memo: '' };
    const memo = String(settings.currentMemo || '');
    const match = memo.match(COMBAT_BLOCK_RX);
    if (!match) return { removed: false, memo };
    const body = match[0].replace(/^\[COMBAT\]/i, '').replace(/\[\/COMBAT\]$/i, '').trim();
    if (!body) return { removed: false, memo };

    const oldEnemies = (previousState?.units || []).filter(unit => unit?.side === 'enemy');
    let stale = /^END_COMBAT$/i.test(body);
    if (!stale && oldEnemies.length) {
        const entities = parseCombatants(body).filter(entity => entity.side === 'enemies');
        stale = entities.length > 0 && entities.every(entity => oldEnemies.some(old => sameName(entity.name, old.name)));
    }
    if (!stale) return { removed: false, memo };

    settings.currentMemo = memo.replace(COMBAT_BLOCK_RX, '').replace(/\n{3,}/g, '\n\n').trim();
    return { removed: true, memo: settings.currentMemo };
}

/**
 * Patch the player's and party's current HP from the board's final units.
 * Name matching is tolerant of `{{user}}`, class suffixes, and bullet prefixes.
 * @param {string} memo
 * @param {object} state
 * @returns {string}
 */
export function patchPartyMemoFromBoard(memo, state) {
    const playerUnits = (state?.units || []).filter(unit => unit?.side === 'player' && !unit.summoned);
    if (!playerUnits.length) return String(memo || '');
    let result = String(memo || '');
    const characterUnit = playerUnits[0];
    result = patchNamedBlock(result, 'CHARACTER', playerUnits, { fallbackUnit: characterUnit });
    result = patchNamedBlock(result, 'PARTY', playerUnits);
    return result;
}

/**
 * Apply the final board state to the memo without an LLM pass.
 * @param {object} state
 * @param {Record<string, any>} settings
 * @returns {{ changed: boolean, memo: string }}
 */
export function syncCombatResultToMemo(state, settings) {
    if (!state || !settings) return { changed: false, memo: String(settings?.currentMemo || '') };
    const before = String(settings.currentMemo || '');
    let next = patchPartyMemoFromBoard(before, state);
    if (COMBAT_BLOCK_RX.test(next)) {
        next = replaceCombatBlock(next, '[COMBAT]END_COMBAT[/COMBAT]');
    }
    next = next.replace(/\n{3,}/g, '\n\n').trim();
    settings.combatDefeatedUi = [];
    settings.currentMemo = next;
    if (state.finalization && typeof state.finalization === 'object') {
        state.finalization.memoSynced = true;
        state.finalization.memoSyncedAt = Date.now();
    } else {
        state.finalization = { memoSynced: true, memoSyncedAt: Date.now() };
    }
    return { changed: next !== before, memo: next };
}

/**
 * Compact, authoritative final-state report for the State Tracker finalization
 * pass. Kept as text so it can be appended to the tracker's user prompt without
 * requiring a second JSON parser.
 * @param {object} state
 * @returns {string}
 */
export function buildCombatTrackerReport(state) {
    if (!state) return '';
    const outcome = state.outcome || {};
    const lines = [
        '## TACTICAL COMBAT FINAL STATE (AUTHORITATIVE)',
        `Encounter: ${cleanText(state.title || 'Tactical encounter')}`,
        `Location: ${cleanText(state.location || 'the battlefield')}`,
        `Outcome: ${cleanText(outcome.label || state.status || 'Ended')} after ${Number(state.round) || 0} round(s).`,
    ];
    if (state.opening?.text) {
        lines.push(`Opening action: ${cleanText(state.opening.text).slice(0, 500)}`);
        lines.push(`Opening action resolved: ${state.opening.resolved ? 'yes' : 'no'}`);
    }
    lines.push('', 'Combatants:');
    for (const unit of state.units || []) {
        const side = unit.side === 'player' ? 'Player' : unit.side === 'ally' ? 'Ally' : 'Enemy';
        const flags = [
            unit.defeated ? 'defeated' : '',
            unit.fled ? 'fled' : '',
        ].filter(Boolean).join(', ');
        const status = statusLine(unit);
        lines.push(`- [${side}] ${cleanText(unit.name)}: ${Math.max(0, numberOr(unit.hp))}/${Math.max(1, numberOr(unit.maxHp, 1))} HP; Status: ${status}${flags ? `; ${flags}` : ''}`);
    }
    const spent = [];
    for (const unit of state.units || []) {
        for (const item of unit.items || []) {
            const maxUses = Number(item.maxUses) || 0;
            const uses = Number(item.uses);
            if (maxUses > 0 && Number.isFinite(uses) && uses < maxUses) {
                spent.push(`${unit.name}: ${item.name} (${uses}/${maxUses} left)`);
            }
        }
        for (const skill of unit.skills || []) {
            const maxUses = Number(skill.maxUses) || 0;
            const uses = Number(skill.uses);
            if (skill.kind !== 'special' && maxUses > 0 && Number.isFinite(uses) && uses < maxUses) {
                spent.push(`${unit.name}: ${skill.name} (${uses}/${maxUses} left)`);
            }
        }
    }
    if (spent.length) {
        lines.push('', 'Consumed resources:');
        for (const entry of spent.slice(0, 24)) lines.push(`- ${entry}`);
    }
    if (outcome.highlights?.length) {
        lines.push('', 'Highlights:');
        for (const entry of outcome.highlights.slice(0, 10)) lines.push(`- ${entry}`);
    }
    lines.push('', 'Apply this report to [CHARACTER]/[PARTY], close [COMBAT], and record only the macro-level result. Do not re-adjudicate the fight.');
    return lines.join('\n');
}
