/**
 * traditional-combat-markup.js — pure HTML for the no-grid combat board.
 *
 * The layout is a roster/target picker, not a battlefield. It intentionally
 * reuses the tactical shell classes (header, sidebar, log, result dialog) and
 * adds only the roster and target-selection pieces.
 */

import { escapeHtml } from '../tactical-combat/tactical-combat-markup.js';
import { TC_SIDE_COLORS, TC_SIDE_LABELS } from '../tactical-combat/tactical-combat-constants.js';

function pct(value, max) {
    const n = Number(value) || 0;
    const m = Number(max) || 1;
    return Math.max(0, Math.min(100, Math.round((n / m) * 100)));
}

function phaseLabel(state) {
    if (state.status !== 'active') return state.outcome?.label || 'Combat ended';
    if (state.turnStyle === 'phase') return state.phase === 'enemy' ? 'Enemy Phase' : 'Player Phase';
    const active = state.units.find(unit => unit.id === state.initiativeOrder?.[state.turnIndex]);
    return active ? `${active.name}'s Turn` : 'Initiative';
}

function turnStyleLabel(state) {
    return state.turnStyle === 'initiative' ? 'Initiative' : 'Phased';
}

function unitClass(unit) {
    return [unit.classLabel, unit.level ? `Lv ${unit.level}` : ''].filter(Boolean).join(' · ');
}

function statusChips(unit) {
    const chips = (unit.statuses || []).map(status => {
        const stacks = Number(status.stacks) || 1;
        const stackLabel = stacks > 1 ? ` x${stacks}` : '';
        const label = status.rounds ? `${status.label}${stackLabel} (${status.rounds})` : `${status.label}${stackLabel}`;
        return `<span class="rt-tc-chip rt-tc-chip-status">${escapeHtml(label)}</span>`;
    });
    if (unit.defending) chips.push('<span class="rt-tc-chip rt-tc-chip-status">Defending (+4 AC)</span>');
    if (unit.actionUsed) chips.push('<span class="rt-tc-chip">Action used</span>');
    return chips.join('');
}

function targetList(view) {
    if (!Array.isArray(view.targetIds) || !view.targetIds.length) return '';
    const labels = view.targetLabels && typeof view.targetLabels === 'object' ? view.targetLabels : {};
    return `<div class="rt-trad-target-list">
        <div class="rt-tc-subtitle">Choose a target</div>
        <div class="rt-trad-target-grid">${view.targetIds.map(id => `
            <button type="button" class="rt-trad-target" data-trad-action="target" data-trad-target-id="${escapeHtml(id)}">
                ${escapeHtml(labels[id] || id)}
            </button>`).join('')}
        </div>
    </div>`;
}

function renderHeader(state, view) {
    const status = state.status !== 'active'
        ? `<span class="rt-tc-outcome-pill rt-tc-outcome-${escapeHtml(state.status)}">${escapeHtml(state.outcome?.label || 'Ended')}</span>`
        : '';
    const busy = view.busy
        ? `<span class="rt-tc-busy-pill"><i class="rt-tc-spinner" aria-hidden="true"></i> ${escapeHtml(view.busyLabel || 'Combat agent thinking…')}</span>`
        : '';
    return `<header class="rt-tc-header">
        <div class="rt-tc-title-wrap">
            <div class="rt-tc-kicker">Traditional Combat ${status}</div>
            <h2 class="rt-tc-title">${escapeHtml(state.title)}</h2>
            <div class="rt-tc-meta">
                <span>Round ${Number(state.round) || 1}</span>
                <span class="rt-tc-dot">·</span>
                <span>${escapeHtml(phaseLabel(state))}</span>
                <span class="rt-tc-dot">·</span>
                <span>${escapeHtml(turnStyleLabel(state))}</span>
                ${state.location ? `<span class="rt-tc-dot">·</span><span class="rt-tc-location">${escapeHtml(state.location)}</span>` : ''}
            </div>
            ${busy}
        </div>
        <div class="rt-tc-header-actions">
            <button type="button" class="rt-tc-icon-btn" data-trad-action="export" title="Download game state JSON" aria-label="Download game state JSON">⤓</button>
            <button type="button" class="rt-tc-icon-btn" data-trad-action="settings" title="Combat settings" aria-label="Open combat settings">⚙</button>
            <button type="button" class="rt-tc-icon-btn rt-tc-close" data-trad-action="close" title="Close board" aria-label="Close combat board">✕</button>
        </div>
    </header>`;
}

function renderInitiativeRail(state, view) {
    const order = Array.isArray(state.initiativeOrder) && state.initiativeOrder.length
        ? state.initiativeOrder
        : state.units.map(unit => unit.id);
    const items = order.map(id => {
        const unit = state.units.find(candidate => candidate.id === id);
        if (!unit) return '';
        const active = state.turnStyle === 'initiative' && state.initiativeOrder?.[state.turnIndex] === unit.id && state.status === 'active';
        const classes = [
            'rt-tc-init-item',
            `rt-tc-side-${unit.side}`,
            active ? 'is-active' : '',
            unit.defeated ? 'is-defeated' : '',
            unit.fled ? 'is-fled' : '',
            view.selectedUnitId === unit.id ? 'is-selected' : '',
        ].filter(Boolean).join(' ');
        return `<button type="button" class="${classes}" data-trad-select-unit="${escapeHtml(unit.id)}" title="${escapeHtml(`${unit.name} — initiative ${unit.initiative}`)}">
            <span class="rt-tc-init-dot" style="--tc-unit:${escapeHtml(unit.color || TC_SIDE_COLORS[unit.side])}"></span>
            <span class="rt-tc-init-name">${escapeHtml(unit.name)}</span>
            <span class="rt-tc-init-score">${Number(unit.initiative) || 0}</span>
        </button>`;
    }).join('');
    return `<div class="rt-tc-initiative" aria-label="Initiative order">${items}</div>`;
}

function renderUnitCard(state, unit, view) {
    const selected = view.selectedUnitId === unit.id;
    const active = view.activeUnitId === unit.id;
    const targetable = Array.isArray(view.targetIds) && view.targetIds.includes(unit.id);
    const hpPct = pct(unit.hp, unit.maxHp);
    const wpPct = unit.maxWillpower ? pct(unit.willpower, unit.maxWillpower) : 0;
    const sideLabel = TC_SIDE_LABELS[unit.side] || unit.side;
    const classes = [
        'rt-trad-unit',
        `rt-tc-side-${unit.side}`,
        selected ? 'is-selected' : '',
        active ? 'is-active' : '',
        targetable ? 'is-targetable' : '',
        unit.defeated ? 'is-defeated' : '',
        unit.fled ? 'is-fled' : '',
    ].filter(Boolean).join(' ');
    const dead = unit.defeated
        ? `<span class="rt-tc-chip rt-tc-chip-danger">${unit.defeatCause === 'willpower' ? 'Willpower broken' : 'Defeated'}</span>`
        : unit.fled
            ? '<span class="rt-tc-chip">Fled</span>'
            : unit.willpowerBroken ? '<span class="rt-tc-chip rt-tc-chip-danger">Willpower broken</span>' : '';
    return `<button type="button" class="${classes}" data-trad-select-unit="${escapeHtml(unit.id)}" ${targetable ? `data-trad-target="${escapeHtml(unit.id)}"` : ''} style="--trad-side:${escapeHtml(unit.color || TC_SIDE_COLORS[unit.side] || '#888')}" title="${escapeHtml(`${unit.name} — ${unit.hp}/${unit.maxHp} HP${unit.maxWillpower ? `, ${unit.willpower}/${unit.maxWillpower} WP` : ''}, AC ${unit.ac}`)}">
        <div class="rt-trad-unit-head">
            <div>
                <div class="rt-trad-unit-name">${escapeHtml(unit.name)} <span class="rt-tc-chip">${escapeHtml(sideLabel)}</span></div>
                <div class="rt-trad-unit-class">${escapeHtml(unitClass(unit) || 'Combatant')}</div>
            </div>
            <div class="rt-trad-unit-vitals">
                <strong>${Number(unit.hp)}</strong><span>/${Number(unit.maxHp)}</span>
                ${unit.maxWillpower ? `<small>${Number(unit.willpower)}/${Number(unit.maxWillpower)} WP</small>` : '<small>Mindless</small>'}
            </div>
        </div>
        <div class="rt-tc-hpbar" aria-hidden="true"><i style="width:${hpPct}%"></i></div>
        ${unit.maxWillpower ? `<div class="rt-tc-wpbar" aria-hidden="true"><i style="width:${wpPct}%"></i></div>` : ''}
        <div class="rt-tc-chip-row">
            <span class="rt-tc-chip">AC ${Number(unit.ac) || 10}</span>
            <span class="rt-tc-chip">ATK ${Number(unit.attackBonus) >= 0 ? '+' : ''}${Number(unit.attackBonus) || 0}</span>
            <span class="rt-tc-chip">INIT ${Number(unit.initiative) || 0}</span>
            ${dead}
            ${statusChips(unit)}
        </div>
        ${targetable ? '<div class="rt-trad-target-badge">Click to target</div>' : ''}
    </button>`;
}

function findSelectedUnit(state, view) {
    return state.units.find(unit => unit.id === view.selectedUnitId) || null;
}

function canUnitAct(state, unit, view) {
    if (!unit || state.status !== 'active' || view.busy) return false;
    if (unit.side !== 'player' || unit.defeated || unit.fled || unit.doneForRound) return false;
    if (state.phase !== 'player') return false;
    return state.turnStyle === 'phase' || view.activeUnitId === unit.id;
}

function renderSelectedPanel(state, view) {
    const unit = findSelectedUnit(state, view);
    if (!unit) {
        return `<div class="rt-tc-unit-card is-empty"><div class="rt-tc-empty-title">No combatant selected</div><p>Select a party member to declare an action.</p></div>`;
    }
    const isPlayer = unit.side === 'player';
    const canAct = canUnitAct(state, unit, view);
    const key = (type) => (state.actionCatalog || []).find(entry => entry.type === type);
    const enabled = (type) => !!key(type) && key(type).enabled !== false;
    const label = (type, fallback) => escapeHtml(key(type)?.label || fallback);
    const buttons = [];
    if (enabled('attack')) buttons.push(`<button type="button" class="rt-tc-action ${view.mode === 'attack' ? 'is-armed' : ''}" data-trad-action="mode-attack" ${!canAct || unit.actionUsed ? 'disabled' : ''}>⚔ ${label('attack', 'Attack')}</button>`);
    if (enabled('skill') && (unit.skills || []).length) buttons.push(`<button type="button" class="rt-tc-action ${view.mode === 'skill' ? 'is-armed' : ''}" data-trad-action="mode-skill" ${!canAct ? 'disabled' : ''}>✦ ${label('skill', 'Skill')}</button>`);
    if (enabled('item') && (unit.items || []).length) buttons.push(`<button type="button" class="rt-tc-action ${view.mode === 'item' ? 'is-armed' : ''}" data-trad-action="mode-item" ${!canAct || unit.actionUsed ? 'disabled' : ''}>◉ ${label('item', 'Item')}</button>`);
    if (enabled('defend')) buttons.push(`<button type="button" class="rt-tc-action" data-trad-action="defend" ${!canAct || unit.actionUsed ? 'disabled' : ''}>◈ ${label('defend', 'Defend')}</button>`);
    if (enabled('wait')) buttons.push(`<button type="button" class="rt-tc-action" data-trad-action="wait" ${!canAct ? 'disabled' : ''}>⏳ ${label('wait', 'Wait')}</button>`);
    if (enabled('flee')) buttons.push(`<button type="button" class="rt-tc-action rt-tc-action-danger" data-trad-action="flee" ${!canAct ? 'disabled' : ''}>↩ ${label('flee', 'Flee')}</button>`);

    const skills = view.mode === 'skill' && isPlayer ? `<div class="rt-tc-subpane">
        <div class="rt-tc-subtitle">Skills & spells</div>
        <div class="rt-tc-skill-list">${(unit.skills || []).map(skill => `
            <button type="button" class="rt-tc-skill ${view.selectedSkillId === skill.id ? 'is-selected' : ''}" data-trad-action="select-skill" data-trad-skill-id="${escapeHtml(skill.id)}" ${!canAct || Number(skill.uses) <= 0 || (skill.bonusAction ? unit.bonusUsed : unit.actionUsed) ? 'disabled' : ''}>
                <span class="rt-tc-skill-name">${escapeHtml(skill.name)}</span>
                <span class="rt-tc-skill-meta">${escapeHtml(skill.kind === 'attack' ? `${skill.resource === 'willpower' ? 'WILLPOWER' : skill.resource === 'both' ? 'HP+WP' : 'ATK'}${skill.damage ? ` · ${skill.damage}` : ''}` : skill.kind === 'heal' ? `HEAL${skill.heal ? ` · ${skill.heal}` : ''}${skill.resource === 'willpower' ? ' · WP' : ''}` : skill.kind === 'special' ? 'SPECIAL' : 'BUFF')}${skill.bonusAction ? ' · bonus' : ''}</span>
                <span class="rt-tc-skill-uses">${Number(skill.uses) || 0}/${Number(skill.maxUses) || 0}</span>
            </button>`).join('')}</div>
    </div>` : '';

    const items = view.mode === 'item' && isPlayer ? `<div class="rt-tc-subpane">
        <div class="rt-tc-subtitle">Items</div>
        <div class="rt-tc-skill-list">${(unit.items || []).map(item => `
            <button type="button" class="rt-tc-skill ${view.selectedItemId === item.id ? 'is-selected' : ''}" data-trad-action="select-item" data-trad-item-id="${escapeHtml(item.id)}" ${!canAct || Number(item.uses) <= 0 || unit.actionUsed ? 'disabled' : ''}>
                <span class="rt-tc-skill-name">${escapeHtml(item.name)}</span>
                <span class="rt-tc-skill-meta">${escapeHtml(item.kind === 'heal' ? `HEAL${item.amount ? ` · ${item.amount}` : ''}` : item.kind === 'special' ? 'SPECIAL' : 'ITEM')}</span>
                <span class="rt-tc-skill-uses">${Number(item.uses) || 0}/${Number(item.maxUses) || 0}</span>
            </button>`).join('')}</div>
    </div>` : '';

    const canEndUnit = state.status === 'active' && state.turnStyle === 'initiative' && state.phase === 'player' && view.activeUnitId === unit.id && isPlayer;
    const endUnit = canEndUnit ? `<button type="button" class="rt-tc-end-unit" data-trad-action="end-turn" ${view.busy ? 'disabled' : ''}>End ${escapeHtml(unit.name)}'s turn</button>` : '';
    const hint = view.mode === 'attack'
        ? 'Choose an enemy below or on their card.'
        : view.mode === 'skill' && !view.selectedSkillId ? 'Choose a skill, then a target.'
            : view.mode === 'item' && !view.selectedItemId ? 'Choose an item, then a target.'
                : view.mode ? 'Choose a highlighted target.' : 'Select an action.';

    return `<div class="rt-tc-unit-card rt-tc-side-${unit.side}">
        <div class="rt-tc-unit-head">
            <div>
                <div class="rt-tc-unit-name">${escapeHtml(unit.name)} <span class="rt-tc-chip">${escapeHtml(TC_SIDE_LABELS[unit.side] || unit.side)}</span></div>
                <div class="rt-tc-unit-class">${escapeHtml(unitClass(unit) || 'Combatant')}</div>
            </div>
            <div class="rt-tc-unit-vitals">
                <div class="rt-tc-unit-hp">${Number(unit.hp)}<span>/${Number(unit.maxHp)}</span></div>
                ${unit.maxWillpower ? `<div class="rt-tc-unit-wp">${Number(unit.willpower)}<span>/${Number(unit.maxWillpower)} WP</span></div>` : '<div class="rt-tc-unit-wp is-immune">Mindless</div>'}
            </div>
        </div>
        <div class="rt-tc-chip-row">
            <span class="rt-tc-chip">AC ${Number(unit.ac) || 10}</span>
            <span class="rt-tc-chip">ATK ${Number(unit.attackBonus) >= 0 ? '+' : ''}${Number(unit.attackBonus) || 0}</span>
            <span class="rt-tc-chip">INIT ${Number(unit.initiative) || 0}</span>
            ${statusChips(unit)}
        </div>
        ${isPlayer && state.status === 'active' ? `<div class="rt-tc-actions">${buttons.join('')}</div>` : ''}
        ${isPlayer && state.status === 'active' ? `<div class="rt-tc-hint">${escapeHtml(hint)}</div>` : ''}
        ${skills}
        ${items}
        ${targetList(view)}
        ${endUnit}
    </div>`;
}

function renderLog(state) {
    const entries = (state.log || []).slice(-40);
    if (!entries.length) return '<div class="rt-tc-log-empty">The battle has not begun.</div>';
    return entries.map(entry => {
        const cls = ['rt-tc-log-entry', `rt-tc-log-${entry.type || 'info'}`].join(' ');
        return `<div class="${cls}"><span class="rt-tc-log-round">R${Number(entry.round) || 1}</span><span class="rt-tc-log-text">${escapeHtml(entry.text)}</span></div>`;
    }).join('');
}

function renderTurnControls(state, view) {
    if (state.preparing?.active) return '';
    if (state.status !== 'active') {
        return `<div class="rt-tc-turnbar">
            <div class="rt-tc-turn-info"><span class="rt-tc-side-dot"></span>${escapeHtml(state.outcome?.label || 'Combat ended')} <small>Round ${Number(state.round) || 1}</small></div>
            <button type="button" class="rt-tc-primary" data-trad-action="new-encounter">New encounter</button>
        </div>`;
    }
    const busy = view.busy ? 'disabled' : '';
    if (state.turnStyle === 'phase') {
        const pending = Array.isArray(state.pendingAgentUnitIds) ? state.pendingAgentUnitIds.length : 0;
        return `<div class="rt-tc-turnbar">
            <div class="rt-tc-turn-info"><span class="rt-tc-side-dot rt-tc-side-${state.phase}"></span>${escapeHtml(state.phase === 'enemy' ? 'Enemy phase' : 'Player phase')} <small>Round ${state.round}</small></div>
            <button type="button" class="rt-tc-primary" data-trad-action="end-turn" ${busy}>${state.phase === 'enemy' ? (pending ? 'Resolve enemy phase' : 'Continue') : 'End player phase'}</button>
            <button type="button" class="rt-tc-ghost" data-trad-action="retreat" ${busy}>Retreat</button>
        </div>`;
    }
    const active = state.units.find(unit => unit.id === view.activeUnitId);
    return `<div class="rt-tc-turnbar">
        <div class="rt-tc-turn-info"><span class="rt-tc-side-dot rt-tc-side-${active?.side || 'player'}"></span>${escapeHtml(active ? `${active.name}'s turn` : 'Initiative')} <small>Round ${state.round}</small></div>
        <button type="button" class="rt-tc-primary" data-trad-action="end-turn" ${busy}>End turn</button>
        <button type="button" class="rt-tc-ghost" data-trad-action="retreat" ${busy}>Retreat</button>
    </div>`;
}

function renderBusy(state, view) {
    if (!view.busy) return '';
    return `<div class="rt-tc-busy" role="status" aria-live="polite">
        <i class="rt-tc-spinner" aria-hidden="true"></i>
        <div><strong>${escapeHtml(view.busyLabel || 'The combat agent is planning…')}</strong><span>Actions are validated by the local engine before they resolve.</span></div>
        ${view.abortable ? '<button type="button" class="rt-tc-ghost" data-trad-action="abort-agent">Stop</button>' : ''}
    </div>`;
}

function renderPending(state, view) {
    if (state.status !== 'active' || view.busy) return '';
    const pending = Array.isArray(state.pendingAgentUnitIds) ? state.pendingAgentUnitIds : [];
    if (!pending.length || state.phase !== 'enemy') return '';
    return `<div class="rt-tc-pending">
        <div><strong>Enemy turn pending.</strong><span>${pending.length} unit${pending.length === 1 ? '' : 's'} still to activate.</span></div>
        <button type="button" class="rt-tc-primary" data-trad-action="resume-agent">Resolve enemy turn</button>
    </div>`;
}

function renderOutcome(state) {
    if (state.status === 'active' || !state.outcome) return '';
    const outcome = state.outcome;
    const finalizingSince = Number(state.finalization?.finalizingStartedAt) || 0;
    const finalizing = !!state.finalization?.finalizing
        && (!finalizingSince || Date.now() - finalizingSince < 90000);
    const details = (outcome.details || []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
    return `<div class="rt-tc-result-wrap" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(outcome.label)}">
        <div class="rt-tc-result rt-tc-outcome-${escapeHtml(state.status)}">
            <div class="rt-tc-result-kicker">Encounter complete</div>
            <h3>${escapeHtml(outcome.label)}</h3>
            <p class="rt-tc-result-summary">${escapeHtml(outcome.summary)}</p>
            <ul class="rt-tc-result-details">${details}</ul>
            <div class="rt-tc-result-actions">
                <button type="button" class="rt-tc-primary" data-trad-action="continue-narration" ${finalizing ? 'disabled' : ''}>${finalizing ? 'Updating tracker…' : 'Return to narration'}</button>
                <button type="button" class="rt-tc-ghost" data-trad-action="new-encounter">New encounter</button>
                <button type="button" class="rt-tc-ghost" data-trad-action="dismiss-result">Review board</button>
            </div>
            <div class="rt-tc-result-note">${finalizing ? 'Writing final HP and closing [COMBAT] before the narrator reads the result.' : 'The result and final state are queued for the main narrator. The outcome is one-shot and will not be repeated after the next scene.'}</div>
        </div>
    </div>`;
}

function renderEmptyState(view) {
    const error = view.error ? `<div class="rt-tc-error">${escapeHtml(view.error)}</div>` : '';
    const loading = view.busy ? `<div class="rt-tc-loading"><i class="rt-tc-spinner" aria-hidden="true"></i><span>${escapeHtml(view.busyLabel || 'Building the encounter…')}</span><button type="button" class="rt-tc-ghost" data-trad-action="abort-agent">Stop</button></div>` : '';
    return `<div class="rt-tc-empty">
        <div class="rt-tc-empty-art" aria-hidden="true"><span>⚔</span><span>✦</span><span>◈</span></div>
        <div class="rt-tc-kicker">Traditional Combat</div>
        <h2>No encounter on the board</h2>
        <p>Build a turn-based encounter from your party and the active <code>[COMBAT]</code> block. There is no grid: choose a skill and a target, and the engine resolves it.</p>
        ${error}
        ${loading}
        <div class="rt-tc-empty-actions">
            <button type="button" class="rt-tc-primary" data-trad-action="start" ${view.busy ? 'disabled' : ''}>Start encounter</button>
            <button type="button" class="rt-tc-ghost" data-trad-action="settings">Combat settings</button>
            <button type="button" class="rt-tc-ghost" data-trad-action="close">Close</button>
        </div>
        <div class="rt-tc-empty-foot">Uses your State Tracker memo for party, enemies, stats, skills, and items. Configure the connection and prompts in Settings → Combat → Traditional Combat.</div>
    </div>`;
}

/**
 * @param {object|null} state
 * @param {object} view
 * @returns {string}
 */
export function buildTraditionalCombatMarkup(state, view = {}) {
    const safeView = {
        selectedUnitId: '',
        activeUnitId: '',
        mode: '',
        selectedSkillId: '',
        selectedItemId: '',
        targetIds: [],
        targetLabels: {},
        busy: false,
        busyLabel: '',
        abortable: false,
        error: '',
        dismissResult: false,
        ...view,
    };
    if (!state) {
        return `<div class="rt-tc-shell is-empty-shell">${renderEmptyState(safeView)}</div>`;
    }
    if (state.preparing?.active) {
        const error = safeView.error ? `<div class="rt-tc-error">${escapeHtml(safeView.error)}</div>` : '';
        return `<div class="rt-tc-shell is-empty-shell">
            <div class="rt-tc-empty">
                <div class="rt-tc-empty-art" aria-hidden="true"><span>⚔</span><span>✦</span><span>◈</span></div>
                <div class="rt-tc-kicker">Traditional Combat</div>
                <h2>Designing the encounter…</h2>
                <p>The encounter architect is building opposition from the current scene and the player's declaration. Combat actions are disabled until the roster is ready.</p>
                ${error}
                <div class="rt-tc-loading"><i class="rt-tc-spinner" aria-hidden="true"></i><span>Designing the encounter…</span></div>
                <div class="rt-tc-empty-actions">
                    <button type="button" class="rt-tc-ghost" data-trad-action="use-fallback">Use local roster</button>
                </div>
            </div>
        </div>`;
    }

    const players = state.units.filter(unit => unit.side === 'player');
    const enemies = state.units.filter(unit => unit.side === 'enemy');
    const allies = state.units.filter(unit => unit.side === 'ally');
    const roster = (units, empty) => units.length
        ? units.map(unit => renderUnitCard(state, unit, safeView)).join('')
        : `<div class="rt-tc-log-empty">${escapeHtml(empty)}</div>`;

    return `<div class="rt-tc-shell rt-trad-shell">
        ${renderHeader(state, safeView)}
        <div class="rt-tc-body rt-trad-body">
            <div class="rt-trad-main">
                <section class="rt-trad-team rt-trad-team-player">
                    <div class="rt-trad-team-title"><span class="rt-tc-side-dot rt-tc-side-player"></span>Party</div>
                    <div class="rt-trad-roster">${roster(players, 'No party members found.')}</div>
                </section>
                ${allies.length ? `<section class="rt-trad-team rt-trad-team-ally">
                    <div class="rt-trad-team-title"><span class="rt-tc-side-dot rt-tc-side-ally"></span>Allies</div>
                    <div class="rt-trad-roster">${roster(allies, '')}</div>
                </section>` : ''}
                <section class="rt-trad-team rt-trad-team-enemy">
                    <div class="rt-trad-team-title"><span class="rt-tc-side-dot rt-tc-side-enemy"></span>Enemies</div>
                    <div class="rt-trad-roster">${roster(enemies, 'No enemies remaining.')}</div>
                </section>
                ${renderTurnControls(state, safeView)}
                ${renderPending(state, safeView)}
                ${renderBusy(state, safeView)}
            </div>
            <aside class="rt-tc-sidebar rt-trad-sidebar">
                ${state.turnStyle === 'initiative' ? renderInitiativeRail(state, safeView) : ''}
                ${renderSelectedPanel(state, safeView)}
                <div class="rt-tc-subpane">
                    <div class="rt-tc-subtitle">Combat log</div>
                    <div class="rt-tc-log">${renderLog(state)}</div>
                </div>
            </aside>
        </div>
        ${safeView.dismissResult ? '' : renderOutcome(state)}
    </div>`;
}
