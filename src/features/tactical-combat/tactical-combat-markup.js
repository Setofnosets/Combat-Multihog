/**
 * tactical-combat-markup.js — pure HTML builders for the tactical board.
 *
 * No DOM access: the UI controller sets `innerHTML` and uses event delegation.
 * Keeping markup pure makes it testable in Node and easy to preview offline.
 */

import {
    TC_ACTION_TYPES,
    TC_SIDE_COLORS,
    TC_SIDE_LABELS,
    TC_TERRAIN,
    TC_TERRAIN_KEYS,
    TC_TURN_STYLES,
} from './tactical-combat-constants.js';

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function pct(value, max) {
    const n = Number(value) || 0;
    const m = Number(max) || 1;
    return Math.max(0, Math.min(100, Math.round((n / m) * 100)));
}

function phaseLabel(state) {
    if (state.status !== 'active') return state.outcome?.label || 'Combat ended';
    if (state.turnStyle === 'phase') return state.phase === 'enemy' ? 'Enemy Phase' : 'Player Phase';
    const active = state.units.find(unit => unit.id === state.initiativeOrder?.[state.turnIndex]);
    if (!active) return 'Initiative';
    return `${active.name}'s Turn`;
}

function turnStyleLabel(state) {
    return state.turnStyle === 'initiative' ? 'Initiative' : 'Phased';
}

function unitClass(unit) {
    return [unit.classLabel, unit.level ? `Lv ${unit.level}` : ''].filter(Boolean).join(' · ');
}

function statusChips(unit) {
    const chips = (unit.statuses || []).map(status => {
        const label = status.rounds ? `${status.label} (${status.rounds})` : status.label;
        return `<span class="rt-tc-chip rt-tc-chip-status">${escapeHtml(label)}</span>`;
    });
    if (unit.defending) chips.push('<span class="rt-tc-chip rt-tc-chip-status">Defending (+4 AC)</span>');
    return chips.join('');
}

function actionEnabled(catalog, type) {
    return (catalog || []).some(entry => entry.type === type && entry.enabled !== false);
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
            <div class="rt-tc-kicker">Tactical Combat ${status}</div>
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
            <button type="button" class="rt-tc-icon-btn" data-tc-action="export" title="Download game state JSON" aria-label="Download game state JSON">⤓</button>
            <button type="button" class="rt-tc-icon-btn" data-tc-action="settings" title="Tactical Combat settings" aria-label="Open Tactical Combat settings">⚙</button>
            <button type="button" class="rt-tc-icon-btn rt-tc-close" data-tc-action="close" title="Close board" aria-label="Close combat board">✕</button>
        </div>
    </header>`;
}

function renderInitiativeRail(state) {
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
        ].filter(Boolean).join(' ');
        return `<button type="button" class="${classes}" data-tc-select-unit="${escapeHtml(unit.id)}" title="${escapeHtml(`${unit.name} — initiative ${unit.initiative}`)}">
            <span class="rt-tc-init-dot" style="--tc-unit:${escapeHtml(unit.color || TC_SIDE_COLORS[unit.side])}"></span>
            <span class="rt-tc-init-name">${escapeHtml(unit.name)}</span>
            <span class="rt-tc-init-score">${Number(unit.initiative) || 0}</span>
        </button>`;
    }).join('');
    return `<div class="rt-tc-initiative" aria-label="Initiative order">${items}</div>`;
}

export function buildCellMarkup(state, unit, x, y, view = {}) {
    const terrainId = state.terrain?.[y]?.[x] || 'floor';
    const terrain = TC_TERRAIN[terrainId] || TC_TERRAIN.floor;
    const key = `${x},${y}`;
    const reachable = view.reachableCells instanceof Set ? view.reachableCells.has(key) : Array.isArray(view.reachableCells) && view.reachableCells.includes(key);
    const target = view.targetCells instanceof Set ? view.targetCells.has(key) : Array.isArray(view.targetCells) && view.targetCells.includes(key);
    const occupied = !!unit;
    const selected = occupied && view.selectedUnitId === unit.id;
    const active = occupied && view.activeUnitId === unit.id;
    const classes = [
        'rt-tc-cell',
        `rt-tc-terrain-${terrain.id}`,
        occupied ? 'is-occupied' : '',
        reachable ? 'is-reachable' : '',
        target ? 'is-target' : '',
        selected ? 'is-selected' : '',
        active ? 'is-active' : '',
        view.showCoords ? 'has-coords' : '',
    ].filter(Boolean).join(' ');

    let content = `<span class="rt-tc-terrain-glyph" aria-hidden="true">${escapeHtml(terrain.glyph)}</span>`;
    if (occupied) {
        const tokenClasses = [
            'rt-tc-token',
            `rt-tc-side-${unit.side}`,
            unit.defeated ? 'is-defeated' : '',
            unit.fled ? 'is-fled' : '',
            selected ? 'is-selected' : '',
            active ? 'is-active' : '',
        ].filter(Boolean).join(' ');
        const hpWidth = pct(unit.hp, unit.maxHp);
        const tokenTitle = `${unit.name}${unit.classLabel ? ` (${unit.classLabel})` : ''} — ${unit.hp}/${unit.maxHp} HP, AC ${unit.ac}${unit.defeated ? ', defeated' : ''}${unit.fled ? ', fled' : ''}`;
        if (unit.defeated) {
            content += `<span class="rt-tc-corpse" title="${escapeHtml(tokenTitle)}" data-tc-select-unit="${escapeHtml(unit.id)}">✕</span>`;
        } else if (!unit.fled) {
            content += `<span class="${tokenClasses}" style="--tc-unit:${escapeHtml(unit.color || TC_SIDE_COLORS[unit.side])}" data-tc-select-unit="${escapeHtml(unit.id)}" title="${escapeHtml(tokenTitle)}">
                <span class="rt-tc-token-glyph">${escapeHtml(unit.glyph || unit.name.slice(0, 2).toUpperCase())}</span>
                <span class="rt-tc-token-hp" aria-hidden="true"><i style="width:${hpWidth}%"></i></span>
                ${(unit.statuses || []).length ? `<span class="rt-tc-token-status" aria-hidden="true">●</span>` : ''}
            </span>`;
        }
    }
    const coord = view.showCoords ? `<span class="rt-tc-coords">${x},${y}</span>` : '';
    const label = `${terrain.label} at ${x},${y}${occupied ? `; ${unit.name}` : ''}${reachable ? '; reachable' : ''}${target ? '; targetable' : ''}`;
    return `<button type="button" class="${classes}" data-tc-cell="${key}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" style="--tc-terrain:${terrain.color};--tc-terrain-fg:${terrain.textColor}">${content}${coord}</button>`;
}

function renderGrid(state, view) {
    const selected = state.units.find(unit => unit.id === view.selectedUnitId) || null;
    void selected;
    const byCell = new Map(state.units.filter(unit => !unit.fled).map(unit => [`${unit.x},${unit.y}`, unit]));
    const cells = [];
    for (let y = 0; y < state.grid.rows; y += 1) {
        for (let x = 0; x < state.grid.cols; x += 1) {
            cells.push(buildCellMarkup(state, byCell.get(`${x},${y}`) || null, x, y, view));
        }
    }
    return `<div class="rt-tc-grid-wrap">
        <div class="rt-tc-grid" role="grid" aria-label="Combat grid ${state.grid.cols} by ${state.grid.rows}" style="--tc-cols:${state.grid.cols};--tc-rows:${state.grid.rows}">
            ${cells.join('')}
        </div>
    </div>`;
}

function renderLegend(state, view = {}) {
    const theme = state.terrainTheme ? state.terrainTheme[0].toUpperCase() + state.terrainTheme.slice(1) : 'Battlefield';
    const items = TC_TERRAIN_KEYS.map(id => {
        const terrain = TC_TERRAIN[id];
        return `<span class="rt-tc-legend-item" title="${escapeHtml(terrain.description)}">
            <i style="background:${terrain.color};color:${terrain.textColor}">${escapeHtml(terrain.glyph)}</i>
            <span>${escapeHtml(terrain.label)}</span>
        </span>`;
    }).join('');
    return `<details class="rt-tc-legend" ${view.compact ? '' : 'open'}>
        <summary>Terrain key <span class="rt-tc-legend-theme">${escapeHtml(theme)}</span></summary>
        <div class="rt-tc-legend-grid">${items}</div>
    </details>`;
}

function renderUnitCard(state, view) {
    const unit = state.units.find(candidate => candidate.id === view.selectedUnitId)
        || state.units.find(candidate => candidate.id === view.activeUnitId)
        || state.units.find(candidate => candidate.side === 'player' && !candidate.defeated && !candidate.fled)
        || null;
    if (!unit) {
        return `<div class="rt-tc-unit-card is-empty"><div class="rt-tc-empty-title">No combatant selected</div><p>Start an encounter and select a unit on the board.</p></div>`;
    }
    const isPlayer = unit.side === 'player';
    const isActiveTurn = state.turnStyle !== 'initiative' || view.activeUnitId === unit.id;
    const canAct = state.status === 'active' && state.phase === 'player' && isPlayer
        && isActiveTurn && !unit.defeated && !unit.fled && !unit.doneForRound && !view.busy;
    const hpPct = pct(unit.hp, unit.maxHp);
    const movementLeft = Math.max(0, (Number(unit.speed) || 0) - (Number(unit.movementUsed) || 0));
    const skills = unit.skills || [];
    const items = unit.items || [];
    const catalogEntry = type => (state.actionCatalog || []).find(entry => entry.type === type);
    const actionLabel = (type, fallback) => escapeHtml(catalogEntry(type)?.label || fallback);
    const actionTitle = (type, fallback) => escapeHtml(catalogEntry(type)?.description || fallback);
    const actionButtons = [];
    if (actionEnabled(state.actionCatalog, 'move')) {
        actionButtons.push(`<button type="button" class="rt-tc-action ${view.mode === 'move' ? 'is-armed' : ''}" data-tc-action="mode-move" title="${actionTitle('move', 'Move up to your remaining movement.')}" ${!canAct || movementLeft <= 0 ? 'disabled' : ''}><span class="rt-tc-action-icon">➜</span>${actionLabel('move', 'Move')} <small>${movementLeft}/${unit.speed}</small></button>`);
    }
    if (actionEnabled(state.actionCatalog, 'attack')) {
        actionButtons.push(`<button type="button" class="rt-tc-action ${view.mode === 'attack' ? 'is-armed' : ''}" data-tc-action="mode-attack" title="${actionTitle('attack', 'Make one attack against a target in range.')}" ${!canAct || unit.actionUsed ? 'disabled' : ''}><span class="rt-tc-action-icon">⚔</span>${actionLabel('attack', 'Attack')}</button>`);
    }
    if (actionEnabled(state.actionCatalog, 'skill') && skills.length) {
        actionButtons.push(`<button type="button" class="rt-tc-action ${view.mode === 'skill' ? 'is-armed' : ''}" data-tc-action="mode-skill" title="${actionTitle('skill', 'Use a listed ability or spell.')}" ${!canAct ? 'disabled' : ''}><span class="rt-tc-action-icon">✦</span>${actionLabel('skill', 'Skill')}</button>`);
    }
    if (actionEnabled(state.actionCatalog, 'item') && items.length) {
        actionButtons.push(`<button type="button" class="rt-tc-action ${view.mode === 'item' ? 'is-armed' : ''}" data-tc-action="mode-item" title="${actionTitle('item', 'Use a consumable.')}" ${!canAct || unit.actionUsed ? 'disabled' : ''}><span class="rt-tc-action-icon">◉</span>${actionLabel('item', 'Item')}</button>`);
    }
    if (actionEnabled(state.actionCatalog, 'defend')) {
        actionButtons.push(`<button type="button" class="rt-tc-action" data-tc-action="defend" title="${actionTitle('defend', 'Take a defensive stance.')}" ${!canAct || unit.actionUsed ? 'disabled' : ''}><span class="rt-tc-action-icon">◈</span>${actionLabel('defend', 'Defend')}</button>`);
    }
    if (actionEnabled(state.actionCatalog, 'wait')) {
        actionButtons.push(`<button type="button" class="rt-tc-action" data-tc-action="wait" title="${actionTitle('wait', 'End this unit\'s turn.')}" ${!canAct ? 'disabled' : ''}><span class="rt-tc-action-icon">⏳</span>${actionLabel('wait', 'Wait')}</button>`);
    }
    if (actionEnabled(state.actionCatalog, 'flee')) {
        actionButtons.push(`<button type="button" class="rt-tc-action rt-tc-action-danger" data-tc-action="flee" title="${actionTitle('flee', 'Leave the battlefield.')}" ${!canAct ? 'disabled' : ''}><span class="rt-tc-action-icon">↩</span>${actionLabel('flee', 'Flee')}</button>`);
    }

    const skillList = skills.length ? `<div class="rt-tc-subpane">
        <div class="rt-tc-subtitle">Skills & spells</div>
        <div class="rt-tc-skill-list">${skills.map(skill => `
            <button type="button" class="rt-tc-skill ${view.selectedSkillId === skill.id ? 'is-selected' : ''}" data-tc-action="select-skill" data-tc-skill-id="${escapeHtml(skill.id)}" ${!canAct || skill.uses <= 0 ? 'disabled' : ''}>
                <span class="rt-tc-skill-name">${escapeHtml(skill.name)}</span>
                <span class="rt-tc-skill-meta">${escapeHtml(skill.kind === 'attack' ? `ATK ${skill.range}c${skill.damage ? ` · ${skill.damage}` : ''}` : skill.kind === 'heal' ? `HEAL ${skill.range}c${skill.heal ? ` · ${skill.heal}` : ''}` : `BUFF ${skill.range}c`)}${skill.bonusAction ? ' · bonus' : ''}</span>
                <span class="rt-tc-skill-uses">${Number(skill.uses) || 0}/${Number(skill.maxUses) || 0}</span>
            </button>`).join('')}</div>
    </div>` : '';

    const itemList = items.length ? `<div class="rt-tc-subpane">
        <div class="rt-tc-subtitle">Items</div>
        <div class="rt-tc-skill-list">${items.map(item => `
            <button type="button" class="rt-tc-skill" data-tc-action="select-item" data-tc-item-id="${escapeHtml(item.id)}" ${!canAct || item.uses <= 0 ? 'disabled' : ''}>
                <span class="rt-tc-skill-name">${escapeHtml(item.name)}</span>
                <span class="rt-tc-skill-meta">${escapeHtml(item.kind === 'heal' ? `HEAL ${item.amount || ''}` : 'ITEM')}</span>
                <span class="rt-tc-skill-uses">${Number(item.uses) || 0}/${Number(item.maxUses) || 0}</span>
            </button>`).join('')}</div>
    </div>` : '';

    const sideBadge = `<span class="rt-tc-side-badge rt-tc-side-${unit.side}">${escapeHtml(TC_SIDE_LABELS[unit.side] || unit.side)}</span>`;
    const dead = unit.defeated ? '<span class="rt-tc-chip rt-tc-chip-danger">Defeated</span>' : unit.fled ? '<span class="rt-tc-chip">Fled</span>' : '';
    const canEndUnit = state.status === 'active' && state.turnStyle === 'initiative' && state.phase === 'player' && view.activeUnitId === unit.id && isPlayer;
    const endUnit = canEndUnit
        ? `<button type="button" class="rt-tc-end-unit" data-tc-action="end-turn" ${view.busy ? 'disabled' : ''}>End ${escapeHtml(unit.name)}'s turn</button>`
        : '';

    return `<div class="rt-tc-unit-card rt-tc-side-${unit.side}">
        <div class="rt-tc-unit-head">
            <div>
                <div class="rt-tc-unit-name">${escapeHtml(unit.name)} ${sideBadge}</div>
                <div class="rt-tc-unit-class">${escapeHtml(unitClass(unit) || 'Combatant')}</div>
            </div>
            <div class="rt-tc-unit-hp">${Number(unit.hp)}<span>/${Number(unit.maxHp)}</span></div>
        </div>
        <div class="rt-tc-hpbar" aria-label="${Number(unit.hp)} of ${Number(unit.maxHp)} HP"><i style="width:${hpPct}%"></i></div>
        <div class="rt-tc-chip-row">
            <span class="rt-tc-chip">AC ${getEffectiveAcDisplay(state, unit)}</span>
            <span class="rt-tc-chip">ATK ${formatMod(getEffectiveAttackDisplay(state, unit))}</span>
            <span class="rt-tc-chip">MOV ${movementLeft}/${unit.speed}</span>
            <span class="rt-tc-chip">INIT ${Number(unit.initiative) || 0}</span>
            ${dead}
            ${statusChips(unit)}
        </div>
        <div class="rt-tc-resource-row">
            <span class="${unit.actionUsed ? 'is-used' : ''}">Action ${unit.actionUsed ? 'used' : 'ready'}</span>
            <span class="${unit.bonusUsed ? 'is-used' : ''}">Bonus ${unit.bonusUsed ? 'used' : 'ready'}</span>
            <span class="${unit.doneForRound ? 'is-used' : ''}">${unit.doneForRound ? 'Finished' : 'Acting'}</span>
        </div>
        ${isPlayer && state.status === 'active' ? `<div class="rt-tc-actions">${actionButtons.join('')}</div>` : ''}
        ${view.mode === 'skill' ? '<div class="rt-tc-hint">Choose a skill, then a highlighted target.</div>' : ''}
        ${view.mode === 'item' ? '<div class="rt-tc-hint">Choose an item, then a highlighted ally.</div>' : ''}
        ${view.mode === 'attack' ? '<div class="rt-tc-hint">Choose a highlighted enemy to attack.</div>' : ''}
        ${view.mode === 'move' ? '<div class="rt-tc-hint">Choose a highlighted cell to move.</div>' : ''}
        ${skillList}
        ${itemList}
        ${endUnit}
    </div>`;
}

function getEffectiveAcDisplay(state, unit) {
    const terrain = TC_TERRAIN[state.terrain?.[unit.y]?.[unit.x]] || TC_TERRAIN.floor;
    const statusBonus = (unit.statuses || []).reduce((sum, status) => sum + (Number(status.acBonus) || 0), 0);
    return (Number(unit.ac) || 10) + (Number(terrain.cover) || 0) + statusBonus;
}

function getEffectiveAttackDisplay(state, unit) {
    const terrain = TC_TERRAIN[state.terrain?.[unit.y]?.[unit.x]] || TC_TERRAIN.floor;
    const statusBonus = (unit.statuses || []).reduce((sum, status) => sum + (Number(status.attackBonus) || 0), 0);
    return (Number(unit.attackBonus) || 0) + (Number(terrain.attackBonus) || 0) + statusBonus;
}

function formatMod(value) {
    const n = Number(value) || 0;
    return `${n >= 0 ? '+' : ''}${n}`;
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
    if (state.status !== 'active') {
        return `<div class="rt-tc-turnbar">
            <div class="rt-tc-turn-info"><span class="rt-tc-side-dot"></span>${escapeHtml(state.outcome?.label || 'Combat ended')} <small>Round ${Number(state.round) || 1}</small></div>
            <button type="button" class="rt-tc-primary" data-tc-action="new-encounter">New encounter</button>
        </div>`;
    }
    const busy = view.busy ? 'disabled' : '';
    if (state.turnStyle === 'phase') {
        return `<div class="rt-tc-turnbar">
            <div class="rt-tc-turn-info"><span class="rt-tc-side-dot rt-tc-side-${state.phase}"></span>${escapeHtml(state.phase === 'enemy' ? 'Enemy phase' : 'Player phase')} <small>Round ${state.round}</small></div>
            <button type="button" class="rt-tc-primary" data-tc-action="end-turn" ${busy}>${state.phase === 'enemy' ? 'Resolve enemy phase' : 'End player phase'}</button>
            <button type="button" class="rt-tc-ghost" data-tc-action="retreat" ${busy}>Retreat</button>
        </div>`;
    }
    const active = state.units.find(unit => unit.id === view.activeUnitId);
    return `<div class="rt-tc-turnbar">
        <div class="rt-tc-turn-info"><span class="rt-tc-side-dot rt-tc-side-${active?.side || 'player'}"></span>${escapeHtml(active ? `${active.name}'s turn` : 'Initiative')} <small>Round ${state.round}</small></div>
        <button type="button" class="rt-tc-primary" data-tc-action="end-turn" ${busy}>End turn</button>
        <button type="button" class="rt-tc-ghost" data-tc-action="retreat" ${busy}>Retreat</button>
    </div>`;
}

function renderBusy(state, view) {
    if (!view.busy) return '';
    return `<div class="rt-tc-busy" role="status" aria-live="polite">
        <i class="rt-tc-spinner" aria-hidden="true"></i>
        <div><strong>${escapeHtml(view.busyLabel || 'The combat agent is planning…')}</strong><span>Actions are validated against the board before they resolve.</span></div>
        ${view.abortable ? '<button type="button" class="rt-tc-ghost" data-tc-action="abort-agent">Stop</button>' : ''}
    </div>`;
}

function renderPending(state, view) {
    if (state.status !== 'active' || view.busy) return '';
    const pending = Array.isArray(state.pendingAgentUnitIds) ? state.pendingAgentUnitIds : [];
    if (!pending.length || state.phase !== 'enemy') return '';
    return `<div class="rt-tc-pending">
        <div><strong>Enemy turn pending.</strong><span>${pending.length} unit${pending.length === 1 ? '' : 's'} still to activate.</span></div>
        <button type="button" class="rt-tc-primary" data-tc-action="resume-agent">Resolve enemy turn</button>
    </div>`;
}

function renderOutcome(state) {
    if (state.status === 'active' || !state.outcome) return '';
    const outcome = state.outcome;
    const details = (outcome.details || []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
    return `<div class="rt-tc-result-wrap" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(outcome.label)}">
        <div class="rt-tc-result rt-tc-outcome-${escapeHtml(state.status)}">
            <div class="rt-tc-result-kicker">Encounter complete</div>
            <h3>${escapeHtml(outcome.label)}</h3>
            <p class="rt-tc-result-summary">${escapeHtml(outcome.summary)}</p>
            <ul class="rt-tc-result-details">${details}</ul>
            <div class="rt-tc-result-actions">
                <button type="button" class="rt-tc-primary" data-tc-action="continue-narration">Return to narration</button>
                <button type="button" class="rt-tc-ghost" data-tc-action="new-encounter">New encounter</button>
                <button type="button" class="rt-tc-ghost" data-tc-action="dismiss-result">Review board</button>
            </div>
            <div class="rt-tc-result-note">The result is queued for the main narrator. It will not be repeated after the next scene.</div>
        </div>
    </div>`;
}

function renderEmptyState(view) {
    const error = view.error ? `<div class="rt-tc-error">${escapeHtml(view.error)}</div>` : '';
    const loading = view.busy ? `<div class="rt-tc-loading"><i class="rt-tc-spinner" aria-hidden="true"></i><span>${escapeHtml(view.busyLabel || 'Building the battlefield…')}</span><button type="button" class="rt-tc-ghost" data-tc-action="abort-agent">Stop</button></div>` : '';
    return `<div class="rt-tc-empty">
        <div class="rt-tc-empty-art" aria-hidden="true">
            <span>⚔</span><span>◈</span><span>♜</span>
        </div>
        <div class="rt-tc-kicker">Tactical Combat</div>
        <h2>No encounter on the board</h2>
        <p>Build a grid encounter from your party and the active <code>[COMBAT]</code> block. The combat agent can also design opposition from the current scene.</p>
        ${error}
        ${loading}
        <div class="rt-tc-empty-actions">
            <button type="button" class="rt-tc-primary" data-tc-action="start" ${view.busy ? 'disabled' : ''}>Start encounter</button>
            <button type="button" class="rt-tc-ghost" data-tc-action="settings">Combat settings</button>
            <button type="button" class="rt-tc-ghost" data-tc-action="close">Close</button>
        </div>
        <div class="rt-tc-empty-foot">Uses your State Tracker memo for party, enemies, stats, skills, and items. Configure the connection and prompts in Settings → Tactical Combat.</div>
    </div>`;
}

/**
 * Full board markup. The UI controller wraps this in `#rt-tactical-combat-overlay`.
 *
 * @param {object|null} state
 * @param {{ selectedUnitId?: string, activeUnitId?: string, mode?: string, selectedSkillId?: string, selectedItemId?: string, reachableCells?: Set<string>|string[], targetCells?: Set<string>|string[], showCoords?: boolean, busy?: boolean, busyLabel?: string, abortable?: boolean, error?: string, dismissResult?: boolean, actionCatalog?: object[] }} view
 * @returns {string}
 */
export function buildTacticalCombatMarkup(state, view = {}) {
    const safeView = {
        selectedUnitId: '',
        activeUnitId: '',
        mode: 'move',
        showCoords: false,
        busy: false,
        abortable: false,
        dismissResult: false,
        ...view,
    };
    if (!state) {
        return `<div class="rt-tc-shell is-empty-shell">${renderEmptyState(safeView)}</div>`;
    }
    const activeUnitId = state.turnStyle === 'initiative'
        ? (state.units.find(unit => unit.id === state.initiativeOrder?.[state.turnIndex])?.id || '')
        : '';
    const mergedView = { ...safeView, activeUnitId, actionCatalog: state.actionCatalog || [] };
    const showResult = state.status !== 'active' && !safeView.dismissResult;
    return `<div class="rt-tc-shell">
        ${renderHeader(state, mergedView)}
        ${renderBusy(state, mergedView)}
        ${renderPending(state, mergedView)}
        ${showResult ? renderOutcome(state) : ''}
        <div class="rt-tc-body">
            <div class="rt-tc-board-area">
                ${renderInitiativeRail(state)}
                ${renderGrid(state, mergedView)}
                ${renderLegend(state, mergedView)}
            </div>
            <aside class="rt-tc-sidebar">
                ${renderUnitCard(state, mergedView)}
                ${renderTurnControls(state, mergedView)}
                <details class="rt-tc-log" open>
                    <summary>Combat log <span>${(state.log || []).length} entries</span></summary>
                    <div class="rt-tc-log-list">${renderLog(state)}</div>
                </details>
                ${state.description ? `<details class="rt-tc-brief"><summary>Encounter brief</summary><p>${escapeHtml(state.description)}</p></details>` : ''}
            </aside>
        </div>
    </div>`;
}

export const TACTICAL_ACTION_TYPES = TC_ACTION_TYPES;
export const TACTICAL_TURN_STYLES = TC_TURN_STYLES;
