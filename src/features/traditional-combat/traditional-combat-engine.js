/**
 * traditional-combat-engine.js — a theater adapter over the tactical rules.
 *
 * There is deliberately no second combat engine. Traditional combat uses the
 * same unit normalization, dice, attacks, skills, items, statuses, Willpower,
 * turn flow, special effects, memo sync, and outcome code as the tactical
 * board. The only difference is the battlefield: all units share the abstract
 * position (0,0), the catalogue has no `move` action, and the agent/UI payloads
 * omit every grid concept.
 */

import {
    addLog,
    applyAction,
    applySpecialEffects,
    buildOutcomeSummary,
    checkEncounterEnd,
    createStateRng,
    getActiveUnit,
    getEffectiveAc,
    getEffectiveAttackBonus,
    getPendingAgentUnitIds,
    getUnitById,
    isFriendlySide,
    isHostileSide,
    hydrateEncounterState,
    livingUnits,
    makeRng,
    normalizeSeed,
    normalizeUnitSeed,
    prepareSpecialAction,
    resolveEffectTemplate,
    restoreCombatScopedState,
    retreatEncounter,
    rollInitiative,
    beginRound,
} from '../tactical-combat/tactical-combat-engine.js';
import { describeActionCatalog, getEnabledActions, parseActionCatalog } from '../tactical-combat/tactical-combat-actions.js';
import { selectEncounterEnemies } from '../tactical-combat/tactical-combat-context.js';
import { describeResource, hasUses } from '../tactical-combat/tactical-combat-resources.js';
import {
    DEFAULT_TRADITIONAL_ACTION_CATALOG,
    TRADITIONAL_ACTION_TYPES,
    TRADITIONAL_DEFAULT_TURN_STYLE,
    TRADITIONAL_STATE_FORMAT,
    TRADITIONAL_VERSION,
} from './traditional-combat-constants.js';

function cloneCatalog(catalog) {
    return (Array.isArray(catalog) ? catalog : DEFAULT_TRADITIONAL_ACTION_CATALOG)
        .filter(entry => entry && TRADITIONAL_ACTION_TYPES.includes(String(entry.type || '').toLowerCase()))
        .map(entry => ({ ...entry, type: String(entry.type).toLowerCase() }));
}

/**
 * @param {Record<string, any>} settings
 * @returns {{ catalog: object[], error: string, usingDefault: boolean }}
 */
export function getTraditionalActionCatalog(settings) {
    const raw = settings?.traditionalCombatActionCatalogJson;
    if (raw == null || String(raw).trim() === '') {
        return { catalog: cloneCatalog(DEFAULT_TRADITIONAL_ACTION_CATALOG), error: '', usingDefault: true };
    }
    const parsed = parseActionCatalog(raw);
    if (parsed.ok) {
        const catalog = cloneCatalog(parsed.catalog);
        if (catalog.length) return { catalog, error: '', usingDefault: false };
    }
    return {
        catalog: cloneCatalog(DEFAULT_TRADITIONAL_ACTION_CATALOG),
        error: parsed.ok ? 'The catalogue must contain at least one non-move action.' : parsed.error,
        usingDefault: true,
    };
}

/**
 * Build the legal target lists for one unit without any range/LOS checks.
 * @param {object} state
 * @param {object} unit
 * @returns {{ attackTargets: string[], skillTargets: Record<string,string[]>, itemTargets: Record<string,string[]> }}
 */
export function describeTraditionalUnitOptions(state, unit) {
    const living = livingUnits(state);
    const attackTargets = living
        .filter(target => target.id !== unit.id && isHostileSide(unit.side, target.side))
        .map(target => target.id);
    const skillTargets = {};
    for (const skill of unit.skills || []) {
        if (!hasUses(skill, unit)) continue;
        let ids = [];
        if (String(skill.target || '').toLowerCase() === 'self') {
            ids = [unit.id];
        } else if (skill.kind === 'attack') {
            ids = attackTargets;
        } else if (skill.kind === 'special') {
            ids = living.map(target => target.id);
        } else {
            ids = living
                .filter(target => isFriendlySide(unit.side, target.side))
                .map(target => target.id);
        }
        skillTargets[skill.id] = ids;
    }
    const itemTargets = {};
    for (const item of unit.items || []) {
        if (!hasUses(item, unit)) continue;
        const targetMode = String(item.target || 'ally').toLowerCase();
        let ids = [];
        if (targetMode === 'enemy') {
            ids = attackTargets;
        } else if (targetMode === 'any') {
            ids = living.map(target => target.id);
        } else {
            ids = living
                .filter(target => isFriendlySide(unit.side, target.side))
                .map(target => target.id);
        }
        itemTargets[item.id] = ids;
    }
    return { attackTargets, skillTargets, itemTargets };
}

/**
 * @param {object} state
 * @param {object} unit
 * @param {{ compact?: boolean }} [options]
 * @returns {object}
 */
function buildTraditionalUnitPayload(state, unit, options = {}) {
    return {
        id: unit.id,
        name: unit.name,
        side: unit.side,
        originalSide: unit.originalSide || unit.side,
        sideChanged: !!unit.sideChanged,
        classLabel: unit.classLabel,
        hp: unit.hp,
        maxHp: unit.maxHp,
        willpower: unit.willpower,
        maxWillpower: unit.maxWillpower,
        willpowerSave: unit.willpowerSave,
        willpowerBroken: !!unit.willpowerBroken,
        willpowerOutcome: unit.willpowerOutcome || '',
        defeatedBy: unit.defeatCause || '',
        ac: getEffectiveAc(state, unit),
        attackBonus: getEffectiveAttackBonus(state, unit),
        spellAttackBonus: unit.spellAttackBonus ?? null,
        spellSaveDC: unit.spellSaveDC ?? null,
        damage: unit.damage,
        attackResource: unit.attackResource || 'hp',
        willpowerDamage: unit.willpowerDamage || '',
        attackWillpowerOutcome: unit.attackWillpowerOutcome || 'defeat',
        initiative: unit.initiative,
        initiativeBonus: unit.initiativeBonus,
        actionUsed: unit.actionUsed,
        bonusUsed: unit.bonusUsed,
        doneForRound: unit.doneForRound,
        defeated: unit.defeated,
        fled: unit.fled,
        defending: !!unit.defending || (unit.statuses || []).some(status => status.id === 'defending'),
        statuses: (unit.statuses || []).map(status => ({
            label: status.label,
            rounds: status.rounds,
            acBonus: status.acBonus,
            attackBonus: status.attackBonus,
            behavior: status.behavior || '',
            stacks: status.stacks || 1,
        })),
        stats: unit.stats,
        spellSlots: Object.fromEntries(
            Object.entries(unit.spellSlots || {}).map(([key, pool]) => [key, {
                current: Math.max(0, Number(pool?.current) || 0),
                max: Math.max(0, Number(pool?.max) || 0),
            }]),
        ),
        skills: (unit.skills || []).map(skill => {
            const resource = describeResource(skill, unit);
            return {
                id: skill.id,
                name: skill.name,
                kind: skill.kind,
                resource: skill.resource || 'hp',
                target: skill.target || '',
                damage: skill.damage,
                willpowerDamage: skill.willpowerDamage || '',
                willpowerOutcome: skill.willpowerOutcome || 'defeat',
                heal: skill.heal,
                slotLevel: skill.slotLevel,
                slotKey: skill.slotKey || '',
                spell: skill.spell === true,
                save: skill.save || '',
                uses: resource.current,
                maxUses: resource.max,
                unlimited: resource.unlimited,
                usesLabel: resource.label,
                bonusAction: !!skill.bonusAction,
                description: skill.description,
                usable: hasUses(skill, unit),
                resolvable: skill.kind === 'special',
            };
        }),
        items: (unit.items || []).map(item => {
            const resource = describeResource(item, unit);
            return {
                id: item.id,
                name: item.name,
                kind: item.kind,
                resource: item.resource || 'hp',
                target: item.target || 'ally',
                uses: resource.current,
                maxUses: resource.max,
                unlimited: resource.unlimited,
                usesLabel: resource.label,
                amount: item.amount,
                description: item.description,
                usable: hasUses(item, unit),
                resolvable: item.kind === 'special',
            };
        }),
        inventory: options.compact ? undefined : (unit.inventory || []).slice(0, 24).map(entry => ({
            name: entry.name,
            description: entry.description,
            equipped: !!entry.equipped,
            section: entry.section,
            rarity: entry.rarity,
            quantity: entry.quantity,
        })),
        notes: unit.notes,
    };
}

/**
 * JSON payload sent to the traditional agent and downloadable from the board.
 * @param {object} state
 * @param {string[]} unitIds
 * @param {object[]} [catalog]
 * @param {{ compact?: boolean }} [options]
 * @returns {object}
 */
export function buildTraditionalAgentGameState(state, unitIds, catalog = state.actionCatalog, options = {}) {
    const ids = Array.isArray(unitIds) ? unitIds : [];
    const compact = options.compact === true;
    const units = state.units.map(unit => buildTraditionalUnitPayload(state, unit, { compact }));
    const unitsToAct = ids.map(id => {
        const unit = getUnitById(state, id);
        if (!unit) return null;
        const targets = describeTraditionalUnitOptions(state, unit);
        return {
            unitId: unit.id,
            name: unit.name,
            side: unit.side,
            attackTargets: targets.attackTargets,
            skillTargets: targets.skillTargets,
            itemTargets: targets.itemTargets,
        };
    }).filter(Boolean);
    return {
        format: TRADITIONAL_STATE_FORMAT,
        version: TRADITIONAL_VERSION,
        mode: 'traditional',
        encounter: {
            title: state.title,
            location: state.location,
            description: state.description,
            round: state.round,
            phase: state.phase,
            turnStyle: state.turnStyle,
        },
        rules: {
            grid: 'none',
            terrain: 'none',
            movement: 'none',
            allowFlee: state.rules?.allowFlee !== false,
            victory: 'Defeat every enemy unit.',
            defeat: 'All player units are defeated.',
            targeting: 'Any living unit on the opposing side is a legal attack target. Range, cover, and line of sight are ignored.',
            willpower: 'Willpower is a morale pool. Ordinary attacks target HP only. Skills/items with resource "willpower" or "both" damage it. At 0 Willpower the unit breaks according to willpowerOutcome. Willpower recovers after combat.',
            actions: describeActionCatalog(catalog),
            actionTypes: getEnabledActions(catalog).map(entry => entry.type),
        },
        units,
        unitsToAct,
        activationOrder: ids,
        recentLog: (state.log || []).slice(compact ? -8 : -12).map(entry => `R${entry.round} ${entry.type}: ${entry.text}`),
    };
}

export function serializeTraditionalAgentGameState(state, unitIds = []) {
    const ids = unitIds.length ? unitIds : state.units.filter(unit => unit.side !== 'player' && !unit.defeated && !unit.fled).map(unit => unit.id);
    return JSON.stringify(buildTraditionalAgentGameState(state, ids), null, 2);
}

/**
 * @param {{
 *   chatId?: string,
 *   title?: string,
 *   description?: string,
 *   location?: string,
 *   units?: object[],
 *   turnStyle?: string,
 *   seed?: number,
 *   actionCatalog?: object[],
 *   encounterSource?: string,
 *   allowFlee?: boolean,
 *   willpowerMaxPercent?: number,
 * }} options
 * @returns {object}
 */
export function createTraditionalEncounterState(options = {}) {
    const turnStyle = options.turnStyle === 'phase' ? 'phase' : 'initiative';
    const seed = normalizeSeed(options.seed);
    const rng = makeRng(seed);
    const units = (Array.isArray(options.units) ? options.units : [])
        .map((seedUnit, index) => normalizeUnitSeed(seedUnit, {
            index,
            side: seedUnit?.side || 'enemy',
            defaultSpeed: 1,
            willpowerMaxPercent: options.willpowerMaxPercent,
        }))
        .filter(Boolean);

    const seenIds = new Set();
    for (const unit of units) {
        let id = unit.id;
        let suffix = 2;
        while (seenIds.has(id)) {
            id = `${unit.id}-${suffix}`;
            suffix += 1;
        }
        unit.id = id;
        seenIds.add(id);
        unit.x = 0;
        unit.y = 0;
        unit.movementUsed = 0;
    }

    const catalog = cloneCatalog(options.actionCatalog && options.actionCatalog.length
        ? options.actionCatalog
        : DEFAULT_TRADITIONAL_ACTION_CATALOG);

    const state = {
        version: TRADITIONAL_VERSION,
        format: TRADITIONAL_STATE_FORMAT,
        mode: 'traditional',
        theater: true,
        id: `trad-${Date.now().toString(36)}-${Math.floor(rng() * 1e6).toString(36)}`,
        chatId: String(options.chatId || ''),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'active',
        title: String(options.title || 'Turn-based encounter').slice(0, 140),
        description: String(options.description || '').slice(0, 4000),
        location: String(options.location || '').slice(0, 200),
        turnStyle,
        grid: null,
        terrain: null,
        units,
        initiativeOrder: [],
        turnIndex: 0,
        round: 1,
        phase: 'player',
        pendingAgentUnitIds: [],
        surprise: null,
        opening: null,
        deployment: null,
        preparing: null,
        log: [],
        outcome: null,
        seed,
        rollCount: 0,
        rules: {
            allowFlee: options.allowFlee !== false,
            willpowerMaxPercent: Math.max(10, Math.min(60, Number(options.willpowerMaxPercent) || 30)),
            victory: 'Defeat every enemy unit.',
            defeat: 'All player units are defeated.',
        },
        actionCatalog: catalog,
        encounterSource: String(options.encounterSource || 'local'),
        finalization: null,
    };

    rollInitiative(state, rng);
    beginRound(state, rng, { initial: true });
    addLog(state, 'start', `${state.title} begins${state.location ? ` at ${state.location}` : ''}. ${state.units.length} combatants enter the fight.`, null);
    if (state.turnStyle === 'initiative') {
        const order = state.initiativeOrder
            .map(id => getUnitById(state, id))
            .filter(Boolean)
            .map(unit => `${unit.name} (${unit.initiative})`)
            .join(' → ');
        addLog(state, 'initiative', `Initiative: ${order}.`, null);
        const active = getActiveUnit(state);
        if (active && active.side !== 'player') {
            state.phase = 'enemy';
            state.pendingAgentUnitIds = getPendingAgentUnitIds(state);
        }
    }
    return state;
}

/**
 * Hydrate a saved traditional encounter and enforce the theater invariants.
 * @param {object} state
 * @returns {object}
 */
export function hydrateTraditionalEncounterState(state) {
    if (!state || !Array.isArray(state.units)) return state;
    hydrateEncounterState(state);
    state.format = TRADITIONAL_STATE_FORMAT;
    state.version = TRADITIONAL_VERSION;
    state.mode = 'traditional';
    state.theater = true;
    state.grid = null;
    state.terrain = null;
    state.actionCatalog = cloneCatalog(state.actionCatalog || DEFAULT_TRADITIONAL_ACTION_CATALOG);
    for (const unit of state.units) {
        unit.x = 0;
        unit.y = 0;
        unit.movementUsed = 0;
    }
    return state;
}

/**
 * Interpret one player/agent action against the shared engine. Movement is
 * impossible in this mode and range/LOS are intentionally ignored.
 * @param {object} state
 * @param {object} action
 * @param {{ rng?: () => number, actorSide?: 'player'|'agent', source?: string, ignoreTurn?: boolean }} [options]
 * @returns {{ ok: boolean, error?: string, log?: string, ended?: boolean }}
 */
export function applyTraditionalAction(state, action, options = {}) {
    if (!state || state.status !== 'active') return { ok: false, error: 'The encounter is over.' };
    if (String(action?.type || '').toLowerCase() === 'move') {
        return { ok: false, error: 'Movement is not available in traditional combat.' };
    }
    return applyAction(state, action, {
        ...options,
        ignoreRange: true,
        ignoreLineOfSight: true,
    });
}

/**
 * Build a traditional encounter from the shared memo context.
 * @param {object} context
 * @param {Record<string, any>} settings
 * @param {{ agentEncounter?: object|null, source?: string, seed?: number, actionCatalog?: object[] }} [options]
 * @returns {{ state: object, warnings: string[] }}
 */
export function buildTraditionalEncounterFromContext(context, settings, options = {}) {
    const source = String(options.source || settings?.traditionalCombatEncounterSource || 'auto');
    const selection = selectEncounterEnemies(context, settings, { ...options, source });
    const { enemies, warnings, agentEncounter } = selection;
    const playerUnits = (context.playerUnits || []).map(unit => ({ ...unit, side: 'player', source: unit.source || 'memo' }));
    if (!playerUnits.length) throw new Error('No living player characters are available for combat.');
    const allies = (context.allies || []).map(unit => ({ ...unit, side: 'ally', source: unit.source || 'memo' }));
    const allUnits = [...playerUnits, ...allies, ...enemies];
    const seed = Number(options.seed) || (Date.now() & 0x7fffffff);
    const title = String(agentEncounter?.title || (context.location ? `Battle at ${context.location}` : 'Turn-based Encounter')).slice(0, 140);
    const description = String(
        agentEncounter?.description
        || (context.location
            ? `The party comes to blows at ${context.location}. Steel rings out and there is no room left for words.`
            : 'The party is drawn into a fight for their lives.'),
    ).slice(0, 4000);

    const state = createTraditionalEncounterState({
        chatId: context.chatId,
        title,
        description,
        location: context.location,
        units: allUnits,
        turnStyle: settings?.traditionalCombatTurnStyle || TRADITIONAL_DEFAULT_TURN_STYLE,
        willpowerMaxPercent: context.willpowerMaxPercent ?? settings?.tacticalCombatWillpowerMaxPercent,
        seed,
        actionCatalog: options.actionCatalog || getTraditionalActionCatalog(settings).catalog,
        encounterSource: agentEncounter?.enemies?.length
            ? 'agent'
            : (context.existingCombat && source !== 'agent' ? 'existing' : 'local'),
        allowFlee: true,
    });

    return { state, warnings };
}

export {
    applySpecialEffects,
    buildOutcomeSummary,
    checkEncounterEnd,
    createStateRng,
    getActiveUnit,
    getPendingAgentUnitIds,
    getUnitById,
    livingUnits,
    prepareSpecialAction,
    resolveEffectTemplate,
    restoreCombatScopedState,
    retreatEncounter,
    addLog,
    beginRound,
};
