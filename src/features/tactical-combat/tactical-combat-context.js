/**
 * tactical-combat-context.js — turn the tracker's state memo into combatants.
 *
 * Reads [CHARACTER], [PARTY], [COMBAT], [INVENTORY], and the recent chat footer
 * (Location). This is deliberately tolerant of tracker formatting drift: missing
 * stats fall back to sensible tabletop defaults instead of failing the encounter.
 */

import { parseCombatants, isResolvedCombatantStatusLine } from '../../state/combat-persistence.js';
import { createEncounterState } from './tactical-combat-engine.js';
import {
    TC_DYNAMIC_MAX,
    TC_DYNAMIC_MIN,
    TC_TERRAIN_THEME_CONFIG,
    clampInt,
    clampIntOr,
    resolveGridDimensions,
} from './tactical-combat-constants.js';

const HP_HEADER_RX = /^(.{2,140}?):\s*([+-]?[\d,]+|\?+)(?:\s*\/\s*([\d,]+|\?+))?\s*HP\b(.*)$/i;
const ABILITY_RX = /([^,|;()]{2,70}?)\s*\(([^)]*)\)/g;

function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseNumber(value, fallback = 0) {
    const raw = String(value ?? '').replace(/,/g, '').trim();
    if (!raw || /^\?+$/.test(raw)) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function findLine(lines, regex) {
    return (lines || []).find(line => regex.test(String(line || ''))) || '';
}

function stripBullet(value) {
    return String(value || '').replace(/^\s*[-*+•]\s*/, '');
}

export function parseMemoBlock(memo, tag) {
    const source = String(memo || '');
    const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`\\[${escaped}\\]\\s*([\\s\\S]*?)\\s*\\[\\/${escaped}\\]`, 'i'));
    return match ? match[1].trim() : '';
}

function parseNameClass(header) {
    const cleaned = stripBullet(header).replace(/\s*:\s*[\d?/]+\s*HP.*$/i, '').trim();
    const match = cleaned.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (match) return { name: cleanText(match[1]), classLabel: cleanText(match[2]) };
    return { name: cleanText(cleaned), classLabel: '' };
}

function parseAttributes(lines) {
    const attrLine = findLine(lines, /^Attr:/i);
    const stats = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
    const mods = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
    if (attrLine) {
        const source = attrLine.replace(/^Attr:\s*/i, '');
        const regex = /\b(STR|DEX|CON|INT|WIS|CHA)\s+(\d{1,2})(?:\s*\(([+-]?\d+)\))?/gi;
        let match;
        while ((match = regex.exec(source))) {
            const key = match[1].toLowerCase();
            const score = clampInt(match[2], 1, 30) || 10;
            const mod = match[3] != null
                ? clampInt(match[3], -10, 20)
                : Math.floor((score - 10) / 2);
            stats[key] = score;
            mods[key] = mod;
        }
    }
    return {
        ...stats,
        strMod: mods.str,
        dexMod: mods.dex,
        conMod: mods.con,
        intMod: mods.int,
        wisMod: mods.wis,
        chaMod: mods.cha,
    };
}

function classifySkillKind(name, description) {
    const text = `${name} ${description}`.toLowerCase();
    if (/\b(heal|cure|restore|mend|regenerat|reviv|recover|second wind|potion)\b/.test(text)) return 'heal';
    if (/\b(bless|shield|ward|guard|haste|inspire|rage|protect|sanctuary|invisib|mirror image|resist|aura)\b/.test(text)) return 'buff';
    return 'attack';
}

function parseUses(text, fallback = 1) {
    const source = String(text || '');
    const slash = source.match(/\((\d+)\s*\/\s*(\d+)\)/);
    if (slash) return clampInt(slash[2], 1, 99);
    const uses = source.match(/(\d+)\s*uses?\b/i);
    if (uses) return clampInt(uses[1], 1, 99);
    return clampInt(fallback, 1, 99);
}

function parseDice(text) {
    const match = String(text || '').match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)/i);
    return match ? match[1].replace(/\s+/g, '') : '';
}

function buildSkillFromName(name, description, options = {}) {
    const cleanedName = cleanText(name).slice(0, 80);
    if (!cleanedName || cleanedName.length < 2) return null;
    if (/^(level|cantrips?|spells?|abilities)$/i.test(cleanedName)) return null;
    const kind = options.kind || classifySkillKind(cleanedName, description);
    const combined = `${cleanedName} ${description}`;
    const ranged = /(ranged|range|ranged attack|at range|bolt|arrow|missile|blast|ray|cone|line|ft\.?)/i.test(combined)
        || options.ranged === true;
    const damage = kind === 'attack' ? (parseDice(description) || options.defaultDamage || '1d8') : '';
    const heal = kind === 'heal' ? (parseDice(description) || '1d8+2') : '';
    const acBonus = kind === 'buff' && /(shield|ward|guard|protect|armor|barrier|sanctuary)/i.test(combined) ? 2 : 0;
    const attackBonus = kind === 'buff' && /(bless|inspire|haste|rage)/i.test(combined) ? 1 : 0;
    return {
        id: `skill-${cleanedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}`,
        name: cleanedName,
        description: cleanText(description).slice(0, 400),
        kind,
        target: kind === 'attack' ? 'enemy' : 'ally',
        range: kind === 'attack' ? (ranged ? 6 : 1) : (ranged ? 6 : 0),
        damage,
        heal,
        acBonus,
        attackBonus,
        bonusAction: /bonus action/i.test(description),
        rounds: 2,
        maxUses: parseUses(description, options.defaultUses || 1),
        uses: parseUses(description, options.defaultUses || 1),
    };
}

function parseAbilities(lines, existingNames = new Set()) {
    const line = findLine(lines, /^Abilities:/i);
    if (!line) return [];
    const source = line.replace(/^Abilities:\s*/i, '');
    const skills = [];
    let match;
    ABILITY_RX.lastIndex = 0;
    while ((match = ABILITY_RX.exec(source))) {
        const skill = buildSkillFromName(match[1], match[2], { defaultUses: 1 });
        if (skill && !existingNames.has(skill.name.toLowerCase())) {
            skills.push(skill);
            existingNames.add(skill.name.toLowerCase());
        }
        if (skills.length >= 5) break;
    }
    if (!skills.length) {
        // Fallback for comma-separated abilities without parenthetical descriptions.
        for (const part of source.split(/[|;]/).map(cleanText).filter(Boolean).slice(0, 4)) {
            const skill = buildSkillFromName(part, '', { defaultUses: 1 });
            if (skill && !existingNames.has(skill.name.toLowerCase())) {
                skills.push(skill);
                existingNames.add(skill.name.toLowerCase());
            }
        }
    }
    return skills;
}

function parseSpells(lines, existingNames = new Set()) {
    const spellLines = (lines || []).filter(line => /^(Spells|Cantrips):/i.test(String(line || '').trim()));
    const skills = [];
    for (const line of spellLines) {
        const isCantrip = /^Cantrips:/i.test(line) || /\bCantrips:\s*/i.test(line);
        const source = line.replace(/^(Spells|Cantrips):\s*/i, '');
        const usageMatch = source.match(/\(([^)]*)\)/);
        const usage = usageMatch ? usageMatch[1] : '';
        const namesPart = source.replace(/^[^:]*:\s*/, '').replace(/\([^)]*\)/g, '');
        const names = namesPart.split(/[,;]/).map(cleanText).filter(Boolean);
        for (const name of names) {
            if (/^(level|cantrips?|spells?)$/i.test(name)) continue;
            const description = usage ? `${isCantrip ? 'Cantrip' : 'Spell'} (${usage})` : (isCantrip ? 'Cantrip' : 'Spell');
            const skill = buildSkillFromName(name, description, {
                ranged: true,
                defaultUses: isCantrip ? 9 : parseUses(usage, 2),
                defaultDamage: isCantrip ? '1d10' : '2d6',
            });
            if (skill && !existingNames.has(skill.name.toLowerCase())) {
                skills.push(skill);
                existingNames.add(skill.name.toLowerCase());
            }
            if (skills.length >= 6) break;
        }
        if (skills.length >= 6) break;
    }
    return skills;
}

function parseGear(lines) {
    const gearLine = findLine(lines, /^(Gear|Att\/def):/i);
    const source = gearLine.replace(/^(Gear|Att\/def):\s*/i, '');
    const entries = [];
    const regex = /([^|]+?)\s*\(([^)]*)\)/g;
    let match;
    while ((match = regex.exec(source))) {
        const rawName = cleanText(match[1]).replace(/^Att\/def:\s*/i, '');
        const name = rawName;
        const description = cleanText(match[2]);
        if (!name) continue;
        const armorBonus = description.match(/([+-]\d+)\s*AC\b/i);
        const damage = parseDice(description);
        entries.push({
            name,
            description,
            damage,
            armorBonus: armorBonus ? clampInt(armorBonus[1], 0, 20) : 0,
            ranged: /(bow|crossbow|sling|dart|javelin|thrown|firearm|pistol|rifle|gun|wand|staff)/i.test(`${name} ${description}`),
        });
    }
    const weapons = entries.filter(entry => entry.damage);
    const armor = entries.filter(entry => entry.armorBonus > 0);
    return {
        weapons,
        armorBonus: armor.reduce((sum, entry) => sum + entry.armorBonus, 0),
        armorName: armor[0]?.name || '',
    };
}

function parseCombatLine(lines) {
    const combatLine = findLine(lines, /^Combat:/i) || findLine(lines, /^Att\/def:/i);
    if (!combatLine) return {};
    const babMatch = combatLine.match(/BAB:\s*([+-]?\d+)/i);
    const meleeMatch = combatLine.match(/Melee\b[^:|]*:\s*([+-]?\d+)/i);
    const rangedMatch = combatLine.match(/Ranged\b[^:|]*:\s*([+-]?\d+)/i);
    const totalAcMatch = combatLine.match(/Total AC:\s*(\d+)/i);
    const baseAcMatch = combatLine.match(/Base AC:\s*(\d+)/i);
    const acMatch = combatLine.match(/\bAC:\s*(\d+)/i);
    const attackMatch = combatLine.match(/(?:Att\/def|Att|Attack)[^|]*?([+-]\d+)\s*\/\s*(\d+d\d+(?:\s*[+-]\s*\d+)?)/i);
    const damageMatch = combatLine.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)/i);
    return {
        bab: babMatch ? clampInt(babMatch[1], -10, 30) : null,
        melee: meleeMatch ? clampInt(meleeMatch[1], -10, 30) : null,
        ranged: rangedMatch ? clampInt(rangedMatch[1], -10, 30) : null,
        totalAc: totalAcMatch ? clampInt(totalAcMatch[1], 1, 40) : null,
        baseAc: baseAcMatch ? clampInt(baseAcMatch[1], 1, 40) : null,
        ac: acMatch ? clampInt(acMatch[1], 1, 40) : null,
        attack: attackMatch ? clampInt(attackMatch[1], -10, 30) : null,
        damage: attackMatch ? cleanText(attackMatch[2]) : (damageMatch ? cleanText(damageMatch[1]) : ''),
    };
}

function inferLevel(lines, maxHp) {
    const levelLine = findLine(lines, /^(Level|HD):/i);
    if (levelLine) {
        const level = levelLine.match(/Level\s*(\d{1,2})/i);
        if (level) return clampInt(level[1], 1, 30);
        const hd = levelLine.match(/d\d+\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/i);
        if (hd) return clampInt(hd[2], 1, 30);
    }
    return Math.max(1, Math.min(20, Math.ceil(maxHp / 12)));
}

/**
 * Parse one stat sheet (character, party member, enemy, or ally).
 * @param {string} name
 * @param {string} classLabel
 * @param {string[]} lines
 * @param {'player'|'enemy'|'ally'} side
 * @param {{ fallbackName?: string, defaultSpeed?: number }} [options]
 * @returns {object|null}
 */
export function parseStatSheet(name, classLabel, lines, side, options = {}) {
    const sourceLines = (lines || []).map(line => String(line || '').trim()).filter(Boolean);
    if (!sourceLines.length) return null;
    const joined = sourceLines.join('\n');
    const hpLine = sourceLines.find(line => /HP\b/i.test(line) && HP_HEADER_RX.test(stripBullet(line))) || '';
    const hpMatch = hpLine.match(HP_HEADER_RX);
    const currentHp = hpMatch ? parseNumber(hpMatch[2], 10) : 10;
    const maxHp = hpMatch ? parseNumber(hpMatch[3], currentHp || 10) : Math.max(10, currentHp);
    const statusLine = findLine(sourceLines, /^Status:/i);
    const defeated = isResolvedCombatantStatusLine(statusLine) || /\b(dead|defeated|unconscious|dying)\b/i.test(statusLine) && currentHp <= 0;
    if (defeated && side !== 'player') return null;

    const stats = parseAttributes(sourceLines);
    const combat = parseCombatLine(sourceLines);
    const gear = parseGear(sourceLines);
    const rangedWeapon = gear.weapons.find(weapon => weapon.ranged);
    const anyWeapon = rangedWeapon || gear.weapons[0] || null;
    const preferRanged = !!rangedWeapon && (combat.ranged == null || combat.melee == null || (combat.ranged || -99) >= (combat.melee || -99));
    const attackRange = preferRanged ? 6 : 1;
    const listedAttack = preferRanged ? combat.ranged : combat.melee;
    const abilityMod = preferRanged ? stats.dexMod : stats.strMod;
    const attackBonus = listedAttack != null
        ? listedAttack
        : combat.attack != null
            ? combat.attack
            : (combat.bab != null ? combat.bab + abilityMod + 2 : 3 + abilityMod);
    const ac = combat.totalAc
        ?? combat.ac
        ?? (combat.baseAc != null ? combat.baseAc + gear.armorBonus : 10 + stats.dexMod + gear.armorBonus);
    const damage = anyWeapon?.damage || combat.damage || `1d6${abilityMod >= 0 ? `+${abilityMod}` : abilityMod}`;
    const level = inferLevel(sourceLines, maxHp || currentHp);
    const maxHpSafe = Math.max(1, maxHp || currentHp || 10);

    const skillNames = new Set();
    const skills = [
        ...parseAbilities(sourceLines, skillNames),
        ...parseSpells(sourceLines, skillNames),
    ].slice(0, 8);

    const traits = findLine(sourceLines, /^Traits:/i);
    const notes = [traits, statusLine].filter(Boolean).join(' ').slice(0, 400);

    return {
        name: cleanText(name || options.fallbackName || classLabel || 'Combatant').slice(0, 80),
        classLabel: cleanText(classLabel).slice(0, 80),
        side,
        maxHp: maxHpSafe,
        hp: Math.max(0, Math.min(maxHpSafe, currentHp)),
        ac: clampInt(ac, 1, 40) || 12,
        attackBonus: clampInt(attackBonus, -10, 30),
        attackRange,
        damage,
        damageType: anyWeapon?.description?.match(/\b(slashing|piercing|bludgeoning|fire|cold|acid|lightning|necrotic|radiant|force|psychic|poison)\b/i)?.[1] || '',
        initiativeBonus: stats.dexMod,
        speed: options.defaultSpeed,
        stats,
        skills,
        items: [],
        level,
        notes,
        source: 'memo',
        _defeated: defeated,
        _joined: joined,
    };
}

function splitPartyEntries(content) {
    const lines = String(content || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const entries = [];
    let current = null;
    for (const line of lines) {
        const cleaned = stripBullet(line);
        const header = cleaned.match(HP_HEADER_RX);
        if (header) {
            current = { name: header[1].trim(), lines: [cleaned] };
            entries.push(current);
        } else if (current) {
            current.lines.push(line);
        } else if (lines.length && entries.length === 0) {
            // Stat sheet without an HP header — keep it as one entity.
            current = { name: '', lines: [line] };
            entries.push(current);
        }
    }
    return entries;
}

/**
 * @param {string} memo
 * @param {{ name1?: string, chat?: object[] }} [ctx]
 * @returns {object[]}
 */
export function parsePlayerUnits(memo, ctx = {}) {
    const units = [];
    const characterContent = parseMemoBlock(memo, 'CHARACTER');
    if (characterContent) {
        const entries = splitPartyEntries(characterContent);
        for (const entry of entries) {
            const header = entry.lines[0] || '';
            const parsed = parseNameClass(header);
            const fallbackName = ctx.name1 || 'Player';
            const rawName = String(parsed.name || fallbackName).replace(/\{\{user\}\}/gi, fallbackName);
            const unit = parseStatSheet(rawName || fallbackName, parsed.classLabel, entry.lines, 'player');
            if (unit && unit.hp > 0 && !unit._defeated) units.push(unit);
        }
    }

    const partyContent = parseMemoBlock(memo, 'PARTY');
    if (partyContent) {
        for (const entry of splitPartyEntries(partyContent)) {
            const parsed = parseNameClass(entry.lines[0] || '');
            if (!parsed.name) continue;
            const unit = parseStatSheet(parsed.name, parsed.classLabel, entry.lines, 'player');
            if (unit && unit.hp > 0 && !unit._defeated) units.push(unit);
        }
    }

    // De-duplicate by name; CHARACTER wins.
    const seen = new Set();
    return units.filter(unit => {
        const key = unit.name.toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * @param {string} memo
 * @returns {{ enemies: object[], allies: object[] }}
 */
export function parseCombatUnits(memo) {
    const content = parseMemoBlock(memo, 'COMBAT');
    if (!content || /^END_COMBAT$/i.test(content.trim())) return { enemies: [], allies: [] };
    const entities = parseCombatants(content);
    const enemies = [];
    const allies = [];
    for (const entity of entities) {
        const side = entity.side === 'allies' ? 'ally' : 'enemy';
        const header = entity.lines[0] || '';
        const parsedHeader = header.match(HP_HEADER_RX);
        const rawName = parsedHeader ? parsedHeader[1].trim() : entity.name;
        const parsed = parseNameClass(rawName);
        const unit = parseStatSheet(parsed.name, parsed.classLabel, entity.lines, side);
        if (!unit) continue;
        if (unit.hp <= 0 || unit._defeated) continue;
        (side === 'ally' ? allies : enemies).push(unit);
    }
    return { enemies, allies };
}

/**
 * Parse healing consumables from the inventory block.
 * @param {string} memo
 * @returns {object[]}
 */
export function parseInventoryItems(memo) {
    const content = parseMemoBlock(memo, 'INVENTORY');
    if (!content) return [];
    const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const items = [];
    const seen = new Set();
    for (const line of lines) {
        if (!/\b(potion|elixir|tonic|salve|healing|remedy|antidote)\b/i.test(line)) continue;
        if (!/\b(heal|restore|recover|cure|potion|elixir|tonic|salve|remedy)\b/i.test(line)) continue;
        const afterColon = line.includes(':') ? line.split(':').slice(1).join(':') : line;
        const cleanedItem = cleanText(afterColon).replace(/\[[^\]]*\]/g, '').replace(/^[^A-Za-z]+/, '').trim();
        const nameMatch = cleanedItem.match(/^([A-Za-z][A-Za-z' -]{2,40}?)(?:\s+x\d+|\s*\(|$)/i);
        const rawName = cleanText(nameMatch?.[1] || 'Healing Potion');
        if (seen.has(rawName.toLowerCase())) continue;
        seen.add(rawName.toLowerCase());
        const qtyMatch = line.match(/\b(?:x|×)\s*(\d+)\b/i) || line.match(/\((\d+)\)/);
        const uses = qtyMatch ? clampInt(qtyMatch[1], 1, 20) : 1;
        items.push({
            id: `item-${rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`,
            name: rawName.slice(0, 80),
            description: cleanText(line).slice(0, 300),
            kind: 'heal',
            amount: /greater|superior|supreme/i.test(rawName) ? '4d4+4' : '2d4+2',
            maxUses: uses,
            uses,
            range: 0,
        });
        if (items.length >= 4) break;
    }
    return items;
}

function fallbackSkills(side, classLabel = '') {
    const caster = /\b(wizard|sorcerer|warlock|cleric|druid|bard|mage|priest|shaman|oracle)\b/i.test(classLabel);
    const skills = [
        {
            name: caster ? 'Firebolt' : 'Cleave',
            description: caster ? 'Ranged spell attack for 1d10 fire damage.' : 'Heavy melee strike for 1d8 damage.',
            kind: 'attack',
            range: caster ? 6 : 1,
            damage: caster ? '1d10' : '1d8',
            maxUses: 9,
        },
        {
            name: 'Second Wind',
            description: 'Recover 1d8+2 HP as a bonus action.',
            kind: 'heal',
            heal: '1d8+2',
            range: 0,
            target: 'self',
            maxUses: 1,
            bonusAction: true,
        },
    ];
        if (side !== 'player') {
        const ranged = /\b(archer|ranger|rogue|wizard|sorcerer|warlock|hunter|scout|skirmisher|mage)\b/i.test(classLabel);
        return [{
            name: ranged ? 'Aimed Shot' : 'Power Attack',
            description: ranged ? 'A ranged strike for 1d8 damage.' : 'A committed strike for 1d10 damage.',
            kind: 'attack',
            range: ranged ? 6 : 1,
            damage: ranged ? '1d8' : '1d10',
            maxUses: 3,
        }];
    }
    return skills;
}

function defaultPotion() {
    return {
        id: 'item-healing-potion',
        name: 'Healing Potion',
        description: 'A common red potion. Restores 2d4+2 HP.',
        kind: 'heal',
        amount: '2d4+2',
        maxUses: 2,
        uses: 2,
        range: 0,
    };
}

/**
 * Fallback player unit for chats with no [CHARACTER]/[PARTY] block yet.
 * @param {{ name1?: string }} ctx
 * @param {number} movement
 * @returns {object}
 */
export function buildFallbackPlayer(ctx = {}, movement = 6) {
    return {
        name: cleanText(ctx.name1 || 'Adventurer').slice(0, 80),
        classLabel: 'Adventurer',
        side: 'player',
        maxHp: 26,
        hp: 26,
        ac: 14,
        attackBonus: 4,
        attackRange: 1,
        damage: '1d8+2',
        initiativeBonus: 2,
        speed: movement,
        stats: { str: 12, dex: 14, con: 12, int: 10, wis: 12, cha: 10, strMod: 1, dexMod: 2, conMod: 1, intMod: 0, wisMod: 1, chaMod: 0 },
        skills: fallbackSkills('player', 'Fighter'),
        items: [defaultPotion()],
        level: 1,
        notes: 'A capable adventurer thrown into the fight.',
        source: 'fallback',
    };
}

function locationFromChat(ctx = {}, memo = '') {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    for (let i = chat.length - 1; i >= Math.max(0, chat.length - 40); i -= 1) {
        const text = String(chat[i]?.mes || chat[i]?.content || '');
        const match = text.match(/\(Location:\s*([^)]+)\)/i);
        if (match) return cleanText(match[1]).slice(0, 200);
    }
    const memoMatch = String(memo || '').match(/\(Location:\s*([^)]+)\)/i)
        || String(memo || '').match(/Location:\s*([^\n)]+)/i);
    return memoMatch ? cleanText(memoMatch[1]).slice(0, 200) : '';
}

function sceneExcerpt(ctx = {}, memo = '') {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const parts = [];
    for (let i = chat.length - 1; i >= 0 && parts.length < 8; i -= 1) {
        const raw = String(chat[i]?.mes || chat[i]?.content || '');
        const text = raw
            .replace(/<div\s+hidden[\s\S]*?<\/div>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\[[^\]]+\][\s\S]*?\[\/[^\]]+\]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (text) parts.unshift(text);
    }
    const excerpt = parts.join('\n').slice(-3500);
    return excerpt || cleanText(memo).slice(-2000);
}

export function inferTerrainTheme(location = '', scene = '') {
    const text = `${location} ${scene}`.toLowerCase();
    if (/\b(dungeon|crypt|tomb|catacomb|vault|keep|castle|ruin|temple|shrine|sewer)\b/.test(text)) return 'dungeon';
    if (/\b(cave|cavern|grotto|mine|tunnel|underground|abyss)\b/.test(text)) return 'cave';
    if (/\b(forest|wood(?:s)?|grove|jungle|wilderness|thicket|glade|garden)\b/.test(text)) return 'forest';
    if (/\b(city|street|market|plaza|alley|town|village|dock(?:s)?|harbor|bridge|courtyard|gate)\b/.test(text)) return 'city';
    if (/\b(tavern|inn|room|hall|house|manor|temple interior|shop|library|study|kitchen|chamber)\b/.test(text)) return 'interior';
    return 'plain';
}

export function resolveTerrainTheme(settings, context) {
    const configured = String(settings?.tacticalCombatTerrainTheme || 'auto');
    if (configured !== 'auto' && TC_TERRAIN_THEME_CONFIG[configured]) return configured;
    return inferTerrainTheme(context?.location, context?.sceneExcerpt);
}

/**
 * Collect everything the encounter builder/agent needs.
 * @param {Record<string, any>} settings
 * @param {object} [ctx]
 * @returns {object}
 */
export function collectEncounterContext(settings, ctx = (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : {})) {
    const memo = String(settings?.currentMemo || '');
    const movement = clampIntOr(settings?.tacticalCombatMovement, 6, 1, 24);
    const characterUnits = parsePlayerUnits(memo, ctx);
    const { enemies, allies } = parseCombatUnits(memo);
    const inventory = parseInventoryItems(memo);
    const playerUnits = characterUnits.length ? characterUnits : [buildFallbackPlayer(ctx, movement)];

    if (inventory.length && playerUnits.length) {
        const first = playerUnits[0];
        first.items = [...(first.items || []), ...inventory];
    }
    for (const unit of playerUnits) {
        if (!unit.skills?.length) unit.skills = fallbackSkills('player', unit.classLabel);
        if (!unit.items?.length && unit === playerUnits[0]) unit.items = [defaultPotion()];
        if (!unit.speed) unit.speed = movement;
    }
    for (const unit of [...enemies, ...allies]) {
        if (!unit.skills?.length) unit.skills = fallbackSkills(unit.side, unit.classLabel);
        if (!unit.speed) unit.speed = movement;
    }

    const location = locationFromChat(ctx, memo);
    const scene = sceneExcerpt(ctx, memo);
    const existingCombat = enemies.length > 0 || allies.length > 0;

    return {
        chatId: String(ctx?.chatId || ctx?.getCurrentChatId?.() || ''),
        memo,
        location,
        sceneExcerpt: scene,
        playerUnits,
        enemies,
        allies,
        existingCombat,
        partySize: playerUnits.length,
        theme: inferTerrainTheme(location, scene),
        movement,
        summary: {
            party: playerUnits.map(unit => `${unit.name} (${unit.classLabel || 'adventurer'}, ${unit.hp}/${unit.maxHp} HP)`),
            enemies: enemies.map(unit => `${unit.name} (${unit.hp}/${unit.maxHp} HP)`),
            allies: allies.map(unit => `${unit.name} (${unit.hp}/${unit.maxHp} HP)`),
            location,
        },
    };
}

/**
 * Local, deterministic opposition used when the agent is unavailable or the
 * setting is "existing only" with no active [COMBAT] block.
 * @param {object} context
 * @param {number} seed
 * @returns {object[]}
 */
export function buildFallbackEnemies(context, seed = 1) {
    const theme = context?.theme || 'plain';
    const roster = {
        dungeon: ['Skeleton', 'Cultist', 'Ghoul', 'Grave Warden'],
        forest: ['Bandit', 'Wolf', 'Poacher', 'Briar Stalker'],
        cave: ['Kobold', 'Cave Bat', 'Cave Troll', 'Myconid'],
        city: ['Cutpurse', 'Thug', 'Watchman', 'Duellist'],
        interior: ['Drunken Brawler', 'Mercenary', 'House Guard', 'Duellist'],
        plain: ['Raider', 'Scout', 'Marauder', 'Outrider'],
    }[theme] || ['Raider', 'Scout', 'Marauder', 'Outrider'];
    const partySize = Math.max(1, Number(context?.partySize) || 1);
    const count = Math.max(2, Math.min(6, partySize));
    const enemies = [];
    for (let i = 0; i < count; i += 1) {
        const name = roster[i % roster.length];
        const boss = i === 0;
        const maxHp = 10 + partySize * 3 + i * 2 + (boss ? 6 : 0);
        const attackBonus = 3 + Math.floor(partySize / 2) + (boss ? 1 : 0);
        const damageBonus = 1 + Math.floor(partySize / 2);
        const ranged = i === 1 && count >= 3;
        enemies.push({
            name,
            classLabel: boss ? 'Leader' : ranged ? 'Skirmisher' : 'Fighter',
            side: 'enemy',
            maxHp,
            hp: maxHp,
            ac: 12 + Math.floor(partySize / 2) + (boss ? 1 : 0),
            attackBonus,
            attackRange: ranged ? 6 : 1,
            damage: ranged ? `1d8+${damageBonus}` : `1d6+${damageBonus}`,
            initiativeBonus: 1 + i,
            level: Math.max(1, Math.floor(partySize / 2)),
            notes: `A ${name.toLowerCase()} drawn into the fight.`,
            skills: fallbackSkills('enemy', boss ? 'Fighter' : 'Rogue'),
            color: '#e05252',
            _seed: seed + i,
        });
    }
    return enemies;
}

/**
 * Resolve configured grid dimensions, honoring a valid agent-authored grid for
 * dynamic/custom modes only.
 * @param {Record<string, any>} settings
 * @param {number} unitCount
 * @param {object|null} agentEncounter
 * @returns {{ rows: number, cols: number, mode: string }}
 */
export function resolveEncounterGrid(settings, unitCount, agentEncounter = null) {
    const base = resolveGridDimensions(settings, unitCount);
    if (!agentEncounter || !['dynamic', 'custom'].includes(base.mode)) return base;
    const rows = Number(agentEncounter?.grid?.rows);
    const cols = Number(agentEncounter?.grid?.cols);
    if (!Number.isFinite(rows) || !Number.isFinite(cols)) return base;
    const min = base.mode === 'dynamic' ? TC_DYNAMIC_MIN : 5;
    const max = base.mode === 'dynamic' ? TC_DYNAMIC_MAX : 40;
    return {
        rows: clampInt(rows, min, max),
        cols: clampInt(cols, min, max),
        mode: base.mode,
    };
}

/**
 * Build a ready-to-play encounter state from parsed context.
 * @param {object} context
 * @param {Record<string, any>} settings
 * @param {{ agentEncounter?: object|null, source?: string, seed?: number }} [options]
 * @returns {{ state: object, warnings: string[] }}
 */
export function buildEncounterFromContext(context, settings, options = {}) {
    const sourceSetting = String(options.source || settings?.tacticalCombatEncounterSource || 'auto');
    const warnings = [];
    const agentEncounter = options.agentEncounter || null;

    let enemies = [];
    if (sourceSetting === 'existing') {
        enemies = [...(context.enemies || [])];
        if (!enemies.length) {
            throw new Error('No active [COMBAT] enemies were found. Start or import an encounter first, or switch Encounter source to Auto/Agent.');
        }
    } else if (sourceSetting === 'agent') {
        enemies = agentEncounter?.enemies?.length
            ? agentEncounter.enemies.map(enemy => ({ ...enemy, side: 'enemy', source: 'agent' }))
            : buildFallbackEnemies(context, options.seed || 1);
        if (!agentEncounter?.enemies?.length) warnings.push('The combat agent did not return enemies; a local skirmish was generated instead.');
    } else if (context.existingCombat && context.enemies.length) {
        enemies = [...context.enemies];
    } else if (agentEncounter?.enemies?.length) {
        enemies = agentEncounter.enemies.map(enemy => ({ ...enemy, side: 'enemy', source: 'agent' }));
    } else {
        enemies = buildFallbackEnemies(context, options.seed || 1);
        if (agentEncounter != null) warnings.push('The combat agent did not return enemies; a local skirmish was generated instead.');
    }

    const playerUnits = (context.playerUnits || []).map(unit => ({ ...unit, side: 'player', source: unit.source || 'memo' }));
    const allies = (context.allies || []).map(unit => ({ ...unit, side: 'ally', source: unit.source || 'memo' }));
    const allUnits = [...playerUnits, ...allies, ...enemies];
    const grid = resolveEncounterGrid(settings, allUnits.length, agentEncounter);
    const theme = agentEncounter?.terrainTheme && TC_TERRAIN_THEME_CONFIG[agentEncounter.terrainTheme]
        ? agentEncounter.terrainTheme
        : (agentEncounter?.enemies?.length ? context.theme : context.theme);
    const seed = Number(options.seed) || (Date.now() & 0x7fffffff);
    const title = String(agentEncounter?.title || (context.location ? `Skirmish at ${context.location}` : 'Tactical Skirmish')).slice(0, 140);
    const description = String(
        agentEncounter?.description
        || (context.location ? `Steel rings out at ${context.location}. The party is forced onto the back foot.` : 'The party is drawn into a fight for their lives.'),
    ).slice(0, 4000);

    const state = createEncounterState({
        chatId: context.chatId,
        title,
        description,
        location: context.location,
        terrainTheme: theme,
        grid,
        terrainRows: agentEncounter?.terrain || null,
        units: allUnits,
        turnStyle: settings?.tacticalCombatTurnStyle,
        movement: context.movement,
        density: settings?.tacticalCombatTerrainDensity,
        seed,
        actionCatalog: options.actionCatalog,
        encounterSource: agentEncounter?.enemies?.length
            ? 'agent'
            : (context.existingCombat && sourceSetting !== 'agent' ? 'existing' : 'local'),
        allowFlee: true,
    });

    return { state, warnings };
}
