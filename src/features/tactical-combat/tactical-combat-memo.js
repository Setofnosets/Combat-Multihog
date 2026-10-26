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
import {
    buildResourceLedger,
    describeResource,
    ensureSpellSlots,
    formatResourceLedger,
    patchAbilityLine,
    patchAbilityUsageText,
    patchInventoryLine,
    patchSpellLevelLines,
    patchStandaloneAbilities,
} from './tactical-combat-resources.js';

const COMBAT_BLOCK_RX = /\[COMBAT\][\s\S]*?\[\/COMBAT\]/i;
const COMBAT_BLOCK_RX_GLOBAL = /\[COMBAT\][\s\S]*?\[\/COMBAT\]/gi;
const HP_LINE_RX = /^(\s*(?:[-*+•]\s*)?)(.{1,160}?):\s*([+-]?[\d,]+|\?+)(?:\s*\/\s*([\d,]+|\?+))?\s*HP\b(.*)$/i;
const WP_LINE_RX = /^(\s*(?:[-*+•]\s*)?)(Willpower|Will)\s*:\s*([+-]?[\d,]+|\?+)(?:\s*\/\s*([\d,]+|\?+))?(.*)$/i;

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
    if (unit?.defeated) {
        if (unit.defeatCause === 'willpower') {
            if (unit.surrendered) return 'Defeated (Willpower broken — surrendered)';
            if (unit.incapacitated) return 'Defeated (Willpower broken — incapacitated)';
            return 'Defeated (Willpower broken)';
        }
        return 'Defeated';
    }
    if (unit?.fled) return unit.willpowerBroken ? 'Fled (Willpower broken)' : 'Fled';
    if (unit?.willpowerBroken) return 'Willpower broken';
    const statuses = Array.isArray(unit?.statuses) ? unit.statuses : [];
    if (!statuses.length) return 'Healthy';
    return statuses
        .map(status => {
            const label = cleanText(status?.label || status?.name || 'Afflicted');
            const rounds = Number(status?.rounds) || 0;
            const stacks = Number(status?.stacks) || 1;
            const stackLabel = stacks > 1 ? ` x${stacks}` : '';
            return rounds > 0 ? `${label}${stackLabel} (${rounds} round${rounds === 1 ? '' : 's'})` : `${label}${stackLabel}`;
        })
        .join(', ');
}

function abilityLine(unit) {
    const skills = (Array.isArray(unit?.skills) ? unit.skills : [])
        .filter(skill => !skill?.slotKey && !skill?.spell)
        .slice(0, 6);
    if (!skills.length) return '';
    return skills.map(skill => {
        const resource = describeResource(skill, unit);
        let description = cleanText(skill?.description || skill?.name || '');
        if (skill?.resource === 'willpower' || skill?.resource === 'both') {
            if (!/\bwillpower\b/i.test(description)) {
                const wp = skill?.resource === 'both'
                    ? `Willpower ${skill?.willpowerDamage || skill?.damage || '1d6'}`
                    : `Willpower ${skill?.damage || skill?.willpowerDamage || '1d6'}`;
                description = `${wp}${description ? `; ${description}` : ''}`;
            }
            if (skill?.willpowerOutcome && skill.willpowerOutcome !== 'defeat' && !/willpower break/i.test(description)) {
                description = `${description}${description ? '; ' : ''}on Willpower break: ${skill.willpowerOutcome}`;
            }
        }
        if (skill?.area && !/\barea\s*:/i.test(description)) {
            const shape = skill.area.origin === 'self' ? 'aura' : 'burst';
            description = `${description}${description ? '; ' : ''}Area: ${shape} ${Number(skill.area.radius) || 1}${skill.area.friendlyFire ? ' friendly fire' : ''}`;
        }
        if (!resource.unlimited && resource.max > 0) {
            description = patchAbilityUsageText(description, resource.current, resource.max);
        }
        return `${cleanText(skill?.name || 'Ability')} (${description})`;
    }).join(', ');
}

function spellLines(unit) {
    const spells = (Array.isArray(unit?.skills) ? unit.skills : []).filter(skill => skill?.slotKey || skill?.spell);
    if (!spells.length) return [];
    ensureSpellSlots(unit);
    const groups = new Map();
    for (const spell of spells) {
        const level = Number(spell.slotLevel) || 0;
        if (!groups.has(level)) groups.set(level, []);
        groups.get(level).push(spell);
    }
    const lines = [];
    const levels = [...groups.keys()].sort((a, b) => a - b);
    for (const level of levels) {
        const names = groups.get(level).map(spell => cleanText(spell.name)).join(', ');
        if (level <= 0) {
            lines.push(`Spells: Cantrips: ${names}`);
            continue;
        }
        const pool = unit.spellSlots?.[`spell-${level}`] || { current: 0, max: 0 };
        lines.push(`Spells: Level ${level} (${Math.max(0, Number(pool.current) || 0)}/${Math.max(0, Number(pool.max) || 0)}): ${names}`);
    }
    return lines;
}

function formatSpellModifier(value) {
    const n = numberOr(value, 0);
    return `${n >= 0 ? '+' : ''}${n}`;
}

function buildUnitBlock(unit) {
    const name = cleanText(unit?.name || 'Combatant').slice(0, 80);
    const hp = Math.max(0, numberOr(unit?.hp, 0));
    const maxHp = Math.max(1, numberOr(unit?.maxHp, hp || 1));
    const willpower = Math.max(0, numberOr(unit?.willpower, 0));
    const maxWillpower = Math.max(0, numberOr(unit?.maxWillpower, willpower || 0));
    const ac = Math.max(1, numberOr(unit?.ac, 12));
    const attackBonus = numberOr(unit?.attackBonus, 0);
    const damage = cleanText(unit?.damage || '1d6');
    const damageType = cleanText(unit?.damageType || '');
    const attackSuffix = unit?.attackResource === 'willpower'
        ? ' [Willpower]'
        : unit?.attackResource === 'both' ? ' [HP+Willpower]' : '';
    const spellAtk = Number(unit?.spellAttackBonus);
    const spellDc = Number(unit?.spellSaveDC);
    const spellParts = [];
    if (Number.isFinite(spellAtk) && unit?.spellAttackBonus != null) {
        spellParts.push(`Spell Atk ${formatSpellModifier(spellAtk)}`);
    }
    if (Number.isFinite(spellDc) && unit?.spellSaveDC != null) {
        spellParts.push(`Spell DC ${Math.max(0, spellDc)}`);
    }
    const spellPrefix = spellParts.length ? `${spellParts.join(' | ')} | ` : '';
    const lines = [
        `${name}: ${hp}/${maxHp} HP`,
        `Willpower: ${willpower}/${maxWillpower}`,
        `Att/def: ${spellPrefix}Attack (1 attack, ${attackBonus >= 0 ? '+' : ''}${attackBonus} / ${damage}${damageType ? ` ${damageType}` : ''}${attackSuffix}) | Armor (AC: ${ac})`,
    ];
    const abilities = abilityLine(unit);
    if (abilities) lines.push(`Abilities: ${abilities}`);
    for (const spellLine of spellLines(unit)) lines.push(spellLine);
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
    if (state.status && state.status !== 'active') return '[COMBAT]END_COMBAT[/COMBAT]';
    const enemies = state.units.filter(unit => unit?.side === 'enemy');
    const allies = state.units.filter(unit => unit?.side === 'ally');
    const lines = ['[COMBAT]', 'COMBAT STATE: ACTIVE', `COMBAT ROUND ${Number(state.round) || 1}`, 'ENEMIES:'];
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
        return source.replace(COMBAT_BLOCK_RX_GLOBAL, () => next).replace(/\n{3,}/g, '\n\n').trim();
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
    const candidates = (units || []).filter(unit => unit && !used?.has(unit.id));
    const exact = candidates.find(unit => normalizeName(unit.name) === name);
    if (exact) return exact;
    return candidates.find(unit => sameName(name, unit.name)) || null;
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

function patchWillpowerLine(line, unit, recover = true) {
    const match = String(line || '').match(WP_LINE_RX);
    if (!match || !unit) return line;
    const max = Math.max(0, numberOr(unit.maxWillpower, numberOr(match[4], numberOr(match[3], 0))));
    const current = recover ? max : Math.min(max, Math.max(0, numberOr(unit.willpower, numberOr(match[3], 0))));
    return `${match[1]}${match[2]}: ${current}/${max}${match[5] || ''}`;
}

function patchBlockWillpower(content, units, options = {}) {
    const lines = String(content || '').split(/\r?\n/);
    const used = new Set();
    let matched = false;
    const recover = options.recoverWillpower !== false;
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(WP_LINE_RX);
        if (!match) continue;
        // Associate the Willpower line with the most recent HP header, not with
        // the line's own label (all characters use "Willpower:").
        let entityName = '';
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            const hp = lines[cursor].match(HP_LINE_RX);
            if (hp) { entityName = hp[2]; break; }
        }
        const unit = matchUnitForHeader(units, entityName, used);
        if (unit) {
            const shouldRecover = recover && !unit.defeated && !unit.fled && !unit.willpowerBroken;
            lines[index] = patchWillpowerLine(lines[index], unit, shouldRecover);
            used.add(unit.id);
            matched = true;
        }
    }
    if (!matched && options.fallbackUnit) {
        const index = lines.findIndex(line => WP_LINE_RX.test(line));
        if (index >= 0) {
            const unit = options.fallbackUnit;
            const shouldRecover = recover && !unit.defeated && !unit.fled && !unit.willpowerBroken;
            lines[index] = patchWillpowerLine(lines[index], unit, shouldRecover);
        }
    }
    return lines.join('\n');
}

function patchNamedBlock(memo, tag, units, options = {}) {
    const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`(\\[${escaped}\\])([\\s\\S]*?)(\\[\\/${escaped}\\])`, 'i');
    return String(memo || '').replace(rx, (full, open, content, close) => {
        const patched = options.patch === 'willpower'
            ? patchBlockWillpower(content, units, options)
            : patchBlockHp(content, units, options);
        return `${open}${patched}${close}`;
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

    settings.currentMemo = memo.replace(COMBAT_BLOCK_RX_GLOBAL, '').replace(/\n{3,}/g, '\n\n').trim();
    return { removed: true, memo: settings.currentMemo };
}

/**
 * Canonical terminal status for a combatant. Only terminal/fled/broken states
 * are written back; ordinary conditions remain whatever the tracker last wrote.
 * @param {object} unit
 * @returns {string}
 */
function terminalStatusFor(unit) {
    if (!unit) return '';
    if (unit.defeated) {
        if (unit.defeatCause === 'willpower') {
            if (unit.surrendered) return 'Defeated (Willpower broken — surrendered)';
            if (unit.incapacitated) return 'Defeated (Willpower broken — incapacitated)';
            return 'Defeated (Willpower broken)';
        }
        return 'Defeated';
    }
    if (unit.fled) {
        return unit.willpowerBroken ? 'Fled (Willpower broken)' : 'Fled';
    }
    if (unit.willpowerBroken) return 'Willpower broken';
    return '';
}

function patchStatusLine(line, unit) {
    if (!unit) return line;
    const status = terminalStatusFor(unit);
    if (!status) return line;
    const text = String(line || '');
    const standalone = text.match(/^(\s*Status\s*:\s*).*$/i);
    if (standalone) return `${standalone[1]}${status}`;
    const inline = text.match(/^(.*\|\s*Status\s*:\s*).*$/i);
    if (inline) return `${inline[1]}${status}`;
    return line;
}

function patchResourceLine(line, unit) {
    if (!unit) return line;
    if (/(?:^|\|)\s*Status\s*:/i.test(line)) return patchStatusLine(line, unit);
    if (/^\s*Abilities\s*:/i.test(line)) return patchAbilityLine(line, unit.skills || []);
    if (/^\s*(?:[-*+•]\s*)?(?:Spells\s*:\s*)?(?:Cantrips\s*:|Level\s+\d+)/i.test(line)) {
        ensureSpellSlots(unit);
        return patchSpellLevelLines(line, unit.spellSlots || {});
    }
    return line;
}

/**
 * Patch spell/ability/status lines inside a [CHARACTER] or [PARTY] block.
 * Entries are delimited by HP headers, which is how the tracker writes stat
 * blocks. Lines before the first header are preserved verbatim. A missing
 * Status line is added when the unit ended the fight defeated, fled, or with
 * broken Willpower.
 * @param {string} content
 * @param {object[]} units
 * @returns {string}
 */
function patchResourceEntries(content, units) {
    const lines = String(content || '').split(/\r?\n/);
    const used = new Set();
    const output = [];
    let current = null;
    let block = [];
    const flush = () => {
        if (!current) {
            output.push(...block);
            block = [];
            return;
        }
        const patched = block.map(line => patchResourceLine(line, current));
        if (!patched.some(line => /(?:^|\|)\s*Status\s*:/i.test(line))) {
            const status = terminalStatusFor(current);
            if (status) {
                let index = patched.length;
                while (index > 0 && !patched[index - 1].trim()) index -= 1;
                patched.splice(index, 0, `Status: ${status}`);
            }
        }
        output.push(...patched);
        block = [];
        current = null;
    };
    for (const rawLine of lines) {
        const line = String(rawLine || '');
        const hp = line.match(HP_LINE_RX);
        if (hp) {
            flush();
            current = matchUnitForHeader(units, hp[2], used);
            if (current) used.add(current.id);
            block.push(line);
            continue;
        }
        if (!current) output.push(line);
        else block.push(line);
    }
    flush();
    return output.join('\n');
}

/**
 * Replace resources/statuses in a named memo block.
 * @param {string} memo
 * @param {string} tag
 * @param {object[]} units
 * @returns {string}
 */
function patchNamedResources(memo, tag, units) {
    const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`(\\[${escaped}\\])([\\s\\S]*?)(\\[\\/${escaped}\\])`, 'i');
    return String(memo || '').replace(rx, (full, open, content, close) => {
        return `${open}${patchResourceEntries(content, units)}${close}`;
    });
}

/**
 * Replace the standalone [SPELLS]/[ABILITIES] block for the player character.
 * @param {string} memo
 * @param {string} tag
 * @param {object} pc
 * @returns {string}
 */
function patchStandaloneResourceBlock(memo, tag, pc) {
    if (!pc) return String(memo || '');
    const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`(\\[${escaped}\\])([\\s\\S]*?)(\\[\\/${escaped}\\])`, 'i');
    return String(memo || '').replace(rx, (full, open, content, close) => {
        if (tag === 'SPELLS') {
            ensureSpellSlots(pc);
            return `${open}${patchSpellLevelLines(content, pc.spellSlots || {})}${close}`;
        }
        return `${open}${patchStandaloneAbilities(content, pc.skills || [])}${close}`;
    });
}

/**
 * Patch [INVENTORY] quantities from remaining board item uses.
 * @param {string} memo
 * @param {object} pc
 * @returns {string}
 */
function patchInventoryBlock(memo, pc) {
    if (!pc) return String(memo || '');
    const rx = /(\[INVENTORY\])([\s\S]*?)(\[\/INVENTORY\])/i;
    return String(memo || '').replace(rx, (full, open, content, close) => {
        const lines = String(content || '').split(/\r?\n/);
        const next = [];
        for (const rawLine of lines) {
            const line = String(rawLine || '');
            if (!/^\s*[-*+•]/.test(line)) {
                next.push(line);
                continue;
            }
            if (/^\s*[-*+•]\s*(?:💰|💵|🪙)/.test(line)) {
                next.push(line);
                continue;
            }
            const patched = patchInventoryLine(line, pc.items || []);
            if (patched) next.push(patched);
        }
        return `${open}${next.join('\n')}${close}`;
    });
}

/**
 * Deterministically write spell slots, ability uses, inventory quantities, and
 * terminal statuses from the board into the memo.
 * @param {string} memo
 * @param {object} state
 * @returns {string}
 */
export function patchCombatResourcesInMemo(memo, state) {
    const playerUnits = (state?.units || []).filter(unit =>
        (unit?.originalSide || unit?.side) === 'player' && !unit.summoned,
    );
    if (!playerUnits.length) return String(memo || '');
    const pc = playerUnits.find(unit => unit.isPlayerCharacter) || null;
    let result = String(memo || '');
    result = patchNamedResources(result, 'CHARACTER', playerUnits);
    result = patchNamedResources(result, 'PARTY', playerUnits);
    // Standalone [SPELLS]/[ABILITIES]/[INVENTORY] blocks belong to the player
    // character only. Without a parsed [CHARACTER] sheet, do not attach them to
    // an arbitrary party companion.
    if (pc) {
        result = patchStandaloneResourceBlock(result, 'SPELLS', pc);
        result = patchStandaloneResourceBlock(result, 'ABILITIES', pc);
        result = patchInventoryBlock(result, pc);
    }
    return result;
}

export function patchPartyMemoFromBoard(memo, state, options = {}) {
    const playerUnits = (state?.units || []).filter(unit => (unit?.originalSide || unit?.side) === 'player' && !unit.summoned);
    if (!playerUnits.length) return String(memo || '');
    let result = String(memo || '');
    const characterUnit = playerUnits[0];
    result = patchNamedBlock(result, 'CHARACTER', playerUnits, { fallbackUnit: characterUnit });
    result = patchNamedBlock(result, 'CHARACTER', playerUnits, { fallbackUnit: characterUnit, patch: 'willpower', recoverWillpower: options.recoverWillpower !== false });
    result = patchNamedBlock(result, 'PARTY', playerUnits);
    result = patchNamedBlock(result, 'PARTY', playerUnits, { patch: 'willpower', recoverWillpower: options.recoverWillpower !== false });
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
    let next = patchPartyMemoFromBoard(before, state, {
        recoverWillpower: settings.tacticalCombatWillpowerRecoverAfterCombat !== false,
    });
    next = patchCombatResourcesInMemo(next, state);
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
export function buildCombatTrackerReport(state, options = {}) {
    if (!state) return '';
    const outcome = state.outcome || {};
    const lines = [
        `## ${state.mode === 'traditional' ? 'TRADITIONAL' : 'TACTICAL'} COMBAT FINAL STATE (AUTHORITATIVE)`,
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
        lines.push(`- [${side}] ${cleanText(unit.name)}: ${Math.max(0, numberOr(unit.hp))}/${Math.max(1, numberOr(unit.maxHp, 1))} HP; ${Math.max(0, numberOr(unit.willpower))}/${Math.max(0, numberOr(unit.maxWillpower))} WP; Status: ${status}${flags ? `; ${flags}` : ''}`);
    }
    const spent = [];
    for (const unit of state.units || []) {
        ensureSpellSlots(unit);
        for (const item of unit.items || []) {
            const resource = describeResource(item, unit);
            if (!resource.unlimited && resource.max > 0 && resource.current < resource.max) {
                spent.push(`${unit.name}: ${item.name} (${resource.current}/${resource.max} left)`);
            }
        }
        for (const [slotKey, pool] of Object.entries(unit.spellSlots || {})) {
            const current = Math.max(0, Number(pool.current) || 0);
            const max = Math.max(0, Number(pool.max) || 0);
            if (current >= max) continue;
            const level = String(slotKey).replace(/^spell-/, '');
            spent.push(`${unit.name}: level ${level} slots (${current}/${max} left)`);
        }
        for (const skill of unit.skills || []) {
            if (skill.slotKey) continue;
            const resource = describeResource(skill, unit);
            if (!resource.unlimited && resource.max > 0 && resource.current < resource.max) {
                spent.push(`${unit.name}: ${skill.name} (${resource.current}/${resource.max} left)`);
            }
        }
    }
    if (spent.length) {
        lines.push('', 'Consumed resources:');
        for (const entry of spent.slice(0, 32)) lines.push(`- ${entry}`);
    }
    const ledger = buildResourceLedger(state);
    const ledgerText = formatResourceLedger(ledger, { includeEnemies: false });
    if (ledgerText && ledgerText !== 'None tracked.') {
        lines.push('', 'Resource ledger:');
        lines.push(`- ${ledgerText}`);
    }
    if (outcome.willpowerBreaks?.length) {
        lines.push('', 'Willpower breaks:');
        for (const entry of outcome.willpowerBreaks.slice(0, 12)) {
            lines.push(`- ${entry.name}: ${entry.outcome}${entry.source ? ` (${entry.source})` : ''}`);
        }
    }
    if (outcome.sideChanges?.length) {
        lines.push('', 'Side changes (encounter-scoped, reverted after combat):');
        for (const entry of outcome.sideChanges.slice(0, 12)) {
            lines.push(`- ${entry.name}: ${entry.originalSide} → ${entry.side}`);
        }
    }
    if (outcome.transformations?.length) {
        lines.push('', 'Transformations:');
        for (const entry of outcome.transformations.slice(0, 12)) {
            lines.push(`- ${entry.originalName || entry.name}${entry.permanent ? ' (permanent)' : ' (temporary)'}`);
        }
    }
    if (outcome.highlights?.length) {
        lines.push('', 'Highlights:');
        for (const entry of outcome.highlights.slice(0, 10)) lines.push(`- ${entry}`);
    }
    if (options.recoverWillpower === false) {
        lines.push('', 'Willpower is persistent for this campaign. Patch current Willpower, do not restore it to max.');
    } else {
        lines.push('', 'Willpower is restored to max for all survivors after combat. Do not persist current Willpower loss.');
    }
    lines.push('Apply this report to [CHARACTER]/[PARTY], close [COMBAT], and record only the macro-level result. Do not re-adjudicate the fight.');
    return lines.join('\n');
}
