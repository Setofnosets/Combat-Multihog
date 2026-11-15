/**
 * lewd-combat-markup.js — pure HTML builders for the Lewd Combat board.
 *
 * No DOM access at import or call time: the UI controller sets `innerHTML` and
 * uses event delegation. Every name, title, reason, and prose sentence is
 * escaped before it reaches the markup. The board has no grid — it is a
 * participant rail, a pairing matrix, an action composer, and a beat log.
 */

import { escapeHtml } from '../tactical-combat/tactical-combat-markup.js';
import { TC_SIDE_COLORS, TC_SIDE_LABELS } from '../tactical-combat/tactical-combat-constants.js';
import { LEWD_POSTURES, lewdParticipantControl } from './lewd-combat-engine.js';
import { LEWD_ZONES } from './lewd-combat-profile.js';
import { buildPairingMatrix, holdsOn } from './lewd-combat-pairing.js';
import { LEWD_TECHNIQUE_CATEGORIES, listLegalActions } from './lewd-combat-techniques.js';
import { resolveLewdControlMode } from './lewd-combat-context.js';

const POSTURE_KEYS = ['lead', 'follow', 'switch'];
const POSTURE_LABELS = { lead: 'Lead', follow: 'Follow', switch: 'Switch' };
const MODE_LABELS = { duel: 'Duel', group: 'Group', 'free-for-all': 'Free-for-all' };
const MULTI_TARGET_MODES = new Set(['pair', 'group', 'aura']);

function arr(value) {
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return [...value];
    if (value == null || value === '') return [];
    return [value];
}

function text(value) {
    return String(value ?? '');
}

function isOut(participant) {
    return !!participant?.atMercy || !!participant?.surrendered;
}

function isActive(participant) {
    return !!participant && !participant.spectator && !isOut(participant);
}

function candidateControl(candidate, controlMode) {
    if (resolveLewdControlMode(controlMode) === 'player-all') return 'player';
    if (candidate?.control === 'player' || candidate?.control === 'ai') return candidate.control;
    if (candidate?.ai === true || candidate?.side === 'enemy' || candidate?.side === 'opponent') return 'ai';
    return 'player';
}

function controlLabel(control) {
    return control === 'ai' ? 'AI' : 'Player';
}

function pct(value, max) {
    const current = Number(value) || 0;
    const ceiling = Number(max) || 1;
    return Math.max(0, Math.min(100, Math.round((current / ceiling) * 100)));
}

function zoneLabel(zone) {
    return text(zone).replace(/_/g, ' ');
}

function titleCase(value) {
    const label = String(value ?? '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[-_]+/g, ' ');
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
}

function sideLabel(side) {
    return TC_SIDE_LABELS[side] || titleCase(side) || 'Player';
}

function sideColor(side) {
    return TC_SIDE_COLORS[side] || '#8b8fa3';
}

function includesName(list, name) {
    const needle = text(name).toLowerCase();
    if (!needle) return false;
    return arr(list).some(value => text(value).toLowerCase() === needle);
}

/**
 * Stamina as filled/empty pips plus the numeric value.
 * @param {number} current
 * @param {number} max
 * @returns {string}
 */
export function staminaPips(current, max) {
    const ceiling = Math.max(0, Math.min(12, Math.floor(Number(max) || 0)));
    const filled = Math.max(0, Math.min(ceiling, Math.floor(Number(current) || 0)));
    return `${'●'.repeat(filled)}${'○'.repeat(Math.max(0, ceiling - filled))}`;
}

/**
 * Posture numbers exactly as the engine resolves them.
 * @param {string} posture
 * @returns {{ key: string, label: string, accuracy: number, arousal: number, poiseDefense: number, poiseRegen: number }}
 */
export function describePostureTradeoff(posture) {
    const requested = text(posture).toLowerCase();
    const key = POSTURE_KEYS.includes(requested) ? requested : 'switch';
    const values = LEWD_POSTURES[key] || LEWD_POSTURES.switch;
    return {
        key,
        label: POSTURE_LABELS[key],
        accuracy: values.accuracy,
        arousal: values.arousal,
        poiseDefense: values.poiseDefense,
        poiseRegen: values.poiseRegen,
    };
}

function signed(value) {
    const number = Number(value) || 0;
    return number > 0 ? `+${number}` : `${number}`;
}

function targetSentence(target) {
    const name = text(target?.name) || 'someone';
    const bits = [];
    bits.push(target?.hit ? 'hit' : 'missed');
    if (Number.isFinite(Number(target?.check)) && Number.isFinite(Number(target?.defense))) {
        bits.push(`(${Number(target.check)} vs ${Number(target.defense)})`);
    }
    if (target?.zone) bits.push(`on the ${zoneLabel(target.zone)}`);
    const deltas = [];
    if (Number(target?.arousalDelta)) deltas.push(`Arousal ${signed(target.arousalDelta)}`);
    if (Number(target?.poiseDelta)) deltas.push(`Poise ${signed(target.poiseDelta)}`);
    if (Number(target?.staminaDelta)) deltas.push(`Stamina ${signed(target.staminaDelta)}`);
    if (deltas.length) bits.push(deltas.join(', '));
    if (target?.climaxed) bits.push('climax');
    return `${name} ${bits.join(' ')}`;
}

/**
 * Human-readable prose for one beat. The caller escapes it before insertion.
 * @param {object|null} beat
 * @param {object|null} [state]
 * @returns {string}
 */
export function describeLewdBeat(beat, state = null) {
    if (!beat) return 'No exchange yet. Choose a posture, a technique, and a target.';
    const actor = text(beat.actor?.name) || 'Someone';
    const type = text(beat.type) || 'technique';

    if (type === 'wait') return `${actor} holds back and waits, watching for an opening.`;
    if (type === 'stop') return `${actor} calls the safe word. The encounter stops without a winner.`;
    if (type === 'surrender') return `${actor} yields and steps out of the encounter.`;
    if (type === 'escape') {
        const holder = text(beat.target?.name) || 'their partner';
        const hold = text(beat.hold?.label) || 'hold';
        return beat.success
            ? `${actor} slips out of ${holder}'s ${hold}.`
            : `${actor} strains against ${holder}'s ${hold} but cannot break free.`;
    }

    const technique = text(beat.technique?.name) || 'a technique';
    const posture = text(beat.posture) ? ` from a ${beat.posture} posture` : '';
    const targets = arr(beat.targets);
    if (!targets.length) {
        return `${actor} uses ${technique}${posture}, but no target is affected.`;
    }
    const lines = targets.map(targetSentence);
    const excluded = arr(beat.excluded)
        .map(entry => `${text(entry?.name) || 'A target'} was skipped (${text(entry?.reason) || 'not legal'}).`)
        .join(' ');
    const round = state?.round ? `Round ${Number(beat.round) || state.round}. ` : '';
    return `${round}${actor} uses ${technique}${posture}. ${lines.join(' ')}${excluded ? ` ${excluded}` : ''}`;
}

function renderStartScreen(view = {}, context = null) {
    const candidates = arr(view.startCandidates || context?.candidates);
    const selected = arr(view.startSelected);
    const spectators = arr(view.spectatorSelected);
    const mode = text(view.startMode) || 'duel';
    const controlMode = text(view.startControlMode) || 'auto';
    const error = text(view.error)
        ? `<p class="rt-lc-error" role="alert">${escapeHtml(view.error)}</p>`
        : '';
    const tone = text(view.tone) || 'explicit';
    const darker = view.darkerThemes;

    const rows = candidates.map((candidate, index) => {
        const name = text(candidate?.name);
        const key = text(candidate?.normalizedName) || name.toLowerCase();
        const isParticipant = includesName(selected, name);
        const isSpectator = includesName(spectators, name);
        const source = arr(candidate?.sources).join(', ');
        const profileNote = candidate?.inferred
            ? '<span class="rt-lc-badge rt-lc-badge-inferred" title="No [LEWD] profile; pools inferred from stats">Inferred</span>'
            : '<span class="rt-lc-badge rt-lc-badge-profile" title="Explicit [LEWD] profile">Profile</span>';
        const side = text(candidate?.side) || 'player';
        const control = candidateControl(candidate, controlMode);
        const controlBadge = `<span class="rt-lc-badge rt-lc-badge-control" data-lc-control="${escapeHtml(control)}" title="${control === 'ai' ? 'Controlled by the local policy' : 'Controlled by the player'}">${controlLabel(control)}</span>`;
        return `<li class="rt-lc-start-row" data-lc-candidate="${escapeHtml(key)}">
            <span class="rt-lc-start-name" style="--rt-lc-side:${escapeHtml(sideColor(side))}">
                ${escapeHtml(name)} <span class="rt-lc-start-side">${escapeHtml(sideLabel(side))}</span>
            </span>
            <span class="rt-lc-start-badges">${controlBadge}${profileNote}${source ? `<span class="rt-lc-badge">${escapeHtml(source)}</span>` : ''}</span>
            <span class="rt-lc-start-picks">
                <label class="rt-lc-check" title="Active participant">
                    <input type="checkbox" data-lc-start-participant value="${escapeHtml(name)}"${isParticipant ? ' checked' : ''} aria-label="Add ${escapeHtml(name)} as an active participant">
                    <span>Participant</span>
                </label>
                <label class="rt-lc-check" title="Spectator">
                    <input type="checkbox" data-lc-start-spectator value="${escapeHtml(name)}"${isSpectator ? ' checked' : ''} aria-label="Add ${escapeHtml(name)} as a spectator">
                    <span>Spectator</span>
                </label>
            </span>
        </li>`;
    }).join('');

    const roster = candidates.length
        ? `<ul class="rt-lc-start-list" aria-label="Detected candidates">${rows}</ul>`
        : `<p class="rt-lc-empty">No [LEWD], [PARTY], or [COMBAT] names were found in the memo yet. Add a [LEWD] profile or start from the narrator with participant names.</p>`;

    return `<div class="rt-lc-start">
        <header class="rt-tc-header rt-lc-header">
            <div class="rt-tc-title-wrap">
                <div class="rt-tc-kicker">Lewd Combat</div>
                <h2 class="rt-tc-title">Start a Lewd Combat encounter</h2>
                <div class="rt-tc-meta"><span>Pick at least two active participants.</span></div>
            </div>
            <div class="rt-tc-header-actions">
                <button type="button" class="rt-lc-btn" data-lc-action="settings" aria-label="Open Combat settings" title="Open Combat settings">Settings</button>
                <button type="button" class="rt-lc-btn" data-lc-action="close" aria-label="Close Lewd Combat" title="Close">Close</button>
            </div>
        </header>
        ${error}
        <p class="rt-lc-lede">Participants come from [LEWD] profiles, the party, the current combat, and the scene. Select two or more active participants; spectators watch without taking turns.</p>
        ${roster}
        <div class="rt-lc-start-options">
            <label class="rt-lc-field">Mode
                <select data-lc-start-mode aria-label="Encounter mode">
                    ${['duel', 'group', 'free-for-all'].map(key =>
                        `<option value="${key}"${mode === key ? ' selected' : ''}>${escapeHtml(MODE_LABELS[key])}</option>`).join('')}
                </select>
            </label>
            <label class="rt-lc-field">Control
                <select data-lc-start-control-mode aria-label="Who controls the participants">
                    <option value="auto"${controlMode === 'auto' ? ' selected' : ''}>Auto (you and your party vs. AI for everyone else)</option>
                    <option value="player-all"${controlMode === 'player-all' ? ' selected' : ''}>Player controls all participants</option>
                    <option value="ai-others"${controlMode === 'ai-others' ? ' selected' : ''}>AI controls every non-party participant</option>
                </select>
            </label>
            <p class="rt-lc-tone">Tone: ${escapeHtml(tone)}${darker === undefined ? '' : ` · Darker themes ${darker ? 'on' : 'off'}`}. Change these in Settings → Combat.</p>
        </div>
        <div class="rt-lc-start-actions">
            <button type="button" class="rt-lc-btn rt-lc-btn-primary" data-lc-action="start" aria-label="Start Lewd Combat encounter" title="Start encounter">Start encounter</button>
            <button type="button" class="rt-lc-btn" data-lc-action="close" aria-label="Close Lewd Combat" title="Close">Close</button>
        </div>
    </div>`;
}

function renderCard(state, participant) {
    const profile = participant?.profile || {};
    const side = text(participant?.side) || 'player';
    const stateChips = [];
    if (participant?.spectator) stateChips.push('<span class="rt-lc-chip rt-lc-chip-spectator">Spectator</span>');
    if (participant?.atMercy) stateChips.push('<span class="rt-lc-chip rt-lc-chip-mercy">At mercy</span>');
    if (participant?.surrendered) stateChips.push('<span class="rt-lc-chip rt-lc-chip-surrender">Surrendered</span>');
    if (participant?.acted && isActive(participant) && state?.status === 'active') {
        stateChips.push('<span class="rt-lc-chip rt-lc-chip-acted">Acted</span>');
    }

    const stance = participant?.stance
        ? `<span class="rt-lc-chip rt-lc-chip-stance" title="Stance">${escapeHtml(participant.stance.label || participant.stance.id)}</span>`
        : '';
    const holds = holdsOn(state, participant)
        .map(row => `<span class="rt-lc-chip rt-lc-chip-hold" title="Hold from ${escapeHtml(row.holderName)}">${escapeHtml(row.hold?.label || row.hold?.id || 'Held')} · ${escapeHtml(row.holderName)}</span>`)
        .join('');
    const role = profile.role
        ? `<span class="rt-lc-chip rt-lc-chip-role" title="Role">${escapeHtml(profile.role)}</span>`
        : '';
    const limits = arr(profile.limits).length
        ? `<span class="rt-lc-badge rt-lc-badge-limits" title="Hard limits: ${escapeHtml(arr(profile.limits).join(', '))}">Limits · ${arr(profile.limits).length}</span>`
        : '';
    const inferred = profile.inferred
        ? '<span class="rt-lc-badge rt-lc-badge-inferred" title="No [LEWD] profile; pools inferred from stats">Inferred</span>'
        : '';
    const control = lewdParticipantControl(participant);
    const controlChip = control === 'ai'
        ? '<span class="rt-lc-chip rt-lc-chip-ai" title="Controlled by the local policy">AI</span>'
        : '<span class="rt-lc-chip rt-lc-chip-player" title="Controlled by the player">Player</span>';

    const stamina = Number(participant?.stamina) || 0;
    const maxStamina = Number(participant?.maxStamina) || 0;
    const arousal = Number(participant?.arousal) || 0;
    const maxArousal = Number(participant?.maxArousal) || 1;
    const poise = Number(participant?.poise) || 0;
    const maxPoise = Number(participant?.maxPoise) || 1;

    return `<article class="rt-lc-card${participant?.spectator ? ' is-spectator' : ''}${isOut(participant) ? ' is-out' : ''}" data-lc-unit-id="${escapeHtml(participant?.id)}" style="--rt-lc-side:${escapeHtml(sideColor(side))}" aria-label="${escapeHtml(text(participant?.name))}, ${escapeHtml(sideLabel(side))}">
        <div class="rt-lc-card-head">
            <span class="rt-lc-name">${escapeHtml(participant?.name)}</span>
            <span class="rt-lc-card-side">${escapeHtml(sideLabel(side))}</span>
            ${controlChip}${role}${inferred}${limits}
        </div>
        <div class="rt-lc-pools">
            <span class="rt-lc-stamina" title="Stamina ${stamina}/${maxStamina}">
                <span class="rt-lc-pips" aria-hidden="true">${escapeHtml(staminaPips(stamina, maxStamina))}</span>
                <span class="rt-lc-stamina-value">S ${stamina}/${maxStamina}</span>
            </span>
            <span class="rt-lc-meter rt-lc-arousal" title="Arousal ${arousal}/${maxArousal}">
                <span class="rt-lc-meter-label">Arousal</span>
                <span class="rt-lc-meter-track"><span class="rt-lc-meter-fill" style="width:${pct(arousal, maxArousal)}%"></span></span>
                <span class="rt-lc-meter-value">${arousal}/${maxArousal}</span>
            </span>
            <span class="rt-lc-meter rt-lc-poise" title="Poise ${poise}/${maxPoise}">
                <span class="rt-lc-meter-label">Poise</span>
                <span class="rt-lc-meter-track"><span class="rt-lc-meter-fill" style="width:${pct(poise, maxPoise)}%"></span></span>
                <span class="rt-lc-meter-value">${poise}/${maxPoise}</span>
            </span>
        </div>
        <div class="rt-lc-chips">${stance}${holds}${stateChips.join('')}</div>
    </article>`;
}

function renderRail(state, participants) {
    return `<section class="rt-lc-rail" aria-label="Participants">
        ${participants.length
            ? participants.map(participant => renderCard(state, participant)).join('')
            : '<p class="rt-lc-empty">No active participants.</p>'}
    </section>`;
}

function renderSpectatorRail(state, participants, view) {
    const spectators = participants.filter(participant => participant.spectator);
    const activePlayers = participants.filter(participant =>
        lewdParticipantControl(participant) === 'player' && !participant.spectator && !isOut(participant));
    const rows = spectators.map(participant => `<li class="rt-lc-spectator-row">
        <span class="rt-lc-spectator-name">${escapeHtml(participant.name)}</span>
        <button type="button" class="rt-lc-btn rt-lc-join" data-lc-action="join" data-lc-unit-id="${escapeHtml(participant.id)}"
            aria-label="Join ${escapeHtml(participant.name)} to the encounter" title="Join the encounter"
            ${view?.busy || state?.status !== 'active' ? 'disabled' : ''}>Join</button>
    </li>`).join('');
    const leaveRows = activePlayers.map(participant => `<li class="rt-lc-spectator-row">
        <span class="rt-lc-spectator-name">${escapeHtml(participant.name)}</span>
        <button type="button" class="rt-lc-btn rt-lc-leave" data-lc-action="leave" data-lc-unit-id="${escapeHtml(participant.id)}"
            aria-label="Move ${escapeHtml(participant.name)} to the spectator rail" title="Sit out"
            ${view?.busy || state?.status !== 'active' ? 'disabled' : ''}>Leave</button>
    </li>`).join('');
    return `<section class="rt-lc-spectators" aria-label="Spectators">
        <h3 class="rt-lc-section-title">Spectators</h3>
        ${spectators.length || activePlayers.length
            ? `<ul class="rt-lc-spectator-list">${rows}${leaveRows}</ul>`
            : '<p class="rt-lc-empty">No spectators. Participants can sit out here.</p>'}
    </section>`;
}

function renderMatrix(state) {
    const matrix = buildPairingMatrix(state);
    const participants = matrix.participants || [];
    if (!participants.length) return '';
    const head = participants.map(participant =>
        `<th scope="col">${escapeHtml(participant.name)}</th>`).join('');
    const rows = participants.map(row => {
        const cells = participants.map(column => {
            if (row.id === column.id) {
                return `<td class="rt-lc-matrix-cell is-diagonal" data-lc-pair-a="${escapeHtml(row.id)}" data-lc-pair-b="${escapeHtml(column.id)}">—</td>`;
            }
            const cell = (matrix.cells || []).find(entry =>
                (entry.a === row.id && entry.b === column.id)
                || (entry.a === column.id && entry.b === row.id)) || null;
            const bits = [];
            if (cell?.engaged) {
                bits.push(cell.hold?.label || cell.hold?.id || 'Engaged');
                if (cell.stance?.label || cell.stance?.id) bits.push(cell.stance.label || cell.stance.id);
                bits.push(`Int ${Number(cell.intensity) || 0}`);
            }
            return `<td class="rt-lc-matrix-cell${cell?.engaged ? ' is-engaged' : ''}" data-lc-pair-a="${escapeHtml(row.id)}" data-lc-pair-b="${escapeHtml(column.id)}" title="${escapeHtml(`${row.name} × ${column.name}: ${bits.length ? bits.join(' · ') : 'not paired'}`)}">${bits.length ? escapeHtml(bits.join(' · ')) : '—'}</td>`;
        }).join('');
        return `<tr><th scope="row">${escapeHtml(row.name)}</th>${cells}</tr>`;
    }).join('');
    return `<section class="rt-lc-matrix-wrap" aria-label="Pairing matrix">
        <h3 class="rt-lc-section-title">Pairing matrix</h3>
        <div class="rt-lc-matrix-scroll">
            <table class="rt-lc-matrix">
                <caption class="rt-lc-sr-only">Current holds and pairings between participants</caption>
                <thead><tr><th scope="col">Participant</th>${head}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    </section>`;
}

function actorCandidates(state) {
    return (state?.participants || []).filter(participant =>
        lewdParticipantControl(participant) === 'player' && !participant.spectator && !isOut(participant));
}

function pickActor(state, view) {
    const participants = state?.participants || [];
    const explicit = text(view?.actorId);
    const chosen = participants.find(participant => participant.id === explicit);
    const chosenEligible = chosen && lewdParticipantControl(chosen) === 'player' && isActive(chosen);
    if (chosenEligible && !chosen.acted) return chosen;
    const eligible = actorCandidates(state);
    return eligible.find(participant => !participant.acted)
        || (chosenEligible ? chosen : null)
        || eligible[0]
        || null;
}

function renderBeats(beat) {
    const round = `<span class="rt-lc-log-round">R${escapeHtml(beat?.round)}</span>`;
    const type = text(beat?.type);
    if (type === 'technique') {
        const targetBits = arr(beat.targets).map(target => {
            const deltas = [];
            if (Number(target?.arousalDelta)) deltas.push(`A ${signed(target.arousalDelta)}`);
            if (Number(target?.poiseDelta)) deltas.push(`P ${signed(target.poiseDelta)}`);
            if (Number(target?.staminaDelta)) deltas.push(`S ${signed(target.staminaDelta)}`);
            const flags = [
                target?.hit ? 'hit' : 'miss',
                target?.zone ? zoneLabel(target.zone) : '',
                target?.climaxed ? 'climax' : '',
                arr(target?.status).join(', '),
            ].filter(Boolean).join(' · ');
            return `<span class="rt-lc-log-target">${escapeHtml(target?.name)}: ${escapeHtml(flags)}${deltas.length ? ` <span class="rt-lc-log-deltas">${escapeHtml(deltas.join(' '))}</span>` : ''}</span>`;
        }).join(' ');
        return `${round}
            <span class="rt-lc-log-actor">${escapeHtml(beat?.actor?.name)}</span>
            <span class="rt-lc-log-tech">${escapeHtml(beat?.technique?.name)}</span>
            ${beat?.posture ? `<span class="rt-lc-log-posture">${escapeHtml(beat.posture)}</span>` : ''}
            <span class="rt-lc-log-targets">${targetBits || 'no target'}</span>`;
    }
    if (type === 'escape') {
        return `${round} <span class="rt-lc-log-actor">${escapeHtml(beat?.actor?.name)}</span> escape ${beat?.success ? 'succeeds' : 'fails'} against <span class="rt-lc-log-tech">${escapeHtml(beat?.target?.name)}</span>`;
    }
    if (type === 'stop') return `${round} <span class="rt-lc-log-status">Safe word</span> — encounter stopped`;
    if (type === 'surrender') return `${round} <span class="rt-lc-log-actor">${escapeHtml(beat?.actor?.name)}</span> surrenders`;
    if (type === 'wait') return `${round} <span class="rt-lc-log-actor">${escapeHtml(beat?.actor?.name)}</span> waits`;
    return `${round} ${escapeHtml(type || 'beat')}`;
}

function renderProse(state, view) {
    const proseLog = arr(state?.proseLog).filter(entry => text(entry?.text));
    if (proseLog.length) {
        const entries = proseLog.map(entry =>
            `<p class="rt-lc-prose-entry rt-lc-prose-text" data-lc-prose-entry data-lc-prose-id="${escapeHtml(entry.id)}" data-lc-prose-source="${escapeHtml(entry.source || 'model')}" data-lc-prose-round="${escapeHtml(entry.round)}">${escapeHtml(entry.text)}</p>`).join('');
        return `<section class="rt-lc-prose" aria-live="polite" aria-label="Scene prose">
        <h3 class="rt-lc-section-title">Scene</h3>
        <div class="rt-lc-prose-scroll" data-lc-prose-scroll>${entries}</div>
    </section>`;
    }
    const log = arr(state?.log);
    const latest = log.length ? log[log.length - 1] : null;
    const prose = text(view?.prose) || text(state?.prose?.text) || describeLewdBeat(latest, state);
    return `<section class="rt-lc-prose" aria-live="polite" aria-label="Scene prose">
        <h3 class="rt-lc-section-title">Scene</h3>
        <p class="rt-lc-prose-text">${escapeHtml(prose)}</p>
    </section>`;
}

function renderLog(state, view) {
    const log = arr(state?.log);
    const latest = log.length ? log[log.length - 1] : null;
    const entries = log.map((beat, index) =>
        `<li class="rt-lc-log-entry" data-lc-log-entry data-lc-log-index="${index}">${renderBeats(beat)}</li>`).join('');
    const debugValue = latest || log.slice(-20);
    return `<section class="rt-lc-log-wrap" aria-label="Beat log">
        <h3 class="rt-lc-section-title">Beat log</h3>
        <ol class="rt-lc-log">${entries || '<li class="rt-lc-empty">No exchanges yet.</li>'}</ol>
    </section>
    ${renderProse(state, view)}
    <section class="rt-lc-debug${view?.showDebug ? ' is-open' : ''}" aria-label="Debug">
        <button type="button" class="rt-lc-btn rt-lc-debug-toggle" data-lc-action="toggle-debug" aria-expanded="${view?.showDebug ? 'true' : 'false'}" aria-label="Toggle debug details" title="Toggle debug JSON">Debug</button>
        ${view?.showDebug ? `<pre class="rt-lc-debug-json">${escapeHtml(JSON.stringify(debugValue, null, 2))}</pre>` : ''}
    </section>`;
}

function renderPostureButtons(view, entry) {
    const requested = text(view?.posture);
    const allowed = arr(entry?.postures);
    const selected = allowed.length && !allowed.includes(requested)
        ? (text(entry?.posture) || allowed[0] || 'switch')
        : (requested || text(entry?.posture) || 'switch');
    return POSTURE_KEYS.map(key => {
        const tradeoff = describePostureTradeoff(key);
        const disallowed = allowed.length > 0 && !allowed.includes(key);
        const tooltip = disallowed
            ? `${tradeoff.label}: not available for this technique`
            : `${tradeoff.label}: accuracy ${signed(tradeoff.accuracy)}, arousal ${signed(tradeoff.arousal)}, poise defense ${signed(tradeoff.poiseDefense)}, poise regen ${signed(tradeoff.poiseRegen)}`;
        return `<button type="button" class="rt-lc-btn rt-lc-posture${selected === key ? ' is-selected' : ''}" data-lc-posture="${key}" aria-pressed="${selected === key ? 'true' : 'false'}" aria-label="${escapeHtml(tooltip)}" title="${escapeHtml(tooltip)}"${disallowed ? ' disabled' : ''}>${tradeoff.label}</button>`;
    }).join('');
}

function renderTechniques(legal, view) {
    const selectedId = text(view?.techniqueId);
    if (!legal.length) {
        return '<p class="rt-lc-empty">No legal technique right now. You can still wait or surrender.</p>';
    }
    const groups = new Map();
    for (const category of LEWD_TECHNIQUE_CATEGORIES) groups.set(category, []);
    for (const entry of legal) {
        const category = LEWD_TECHNIQUE_CATEGORIES.includes(entry.category) ? entry.category : 'technique';
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(entry);
    }
    return [...groups.entries()].map(([category, entries]) => {
        if (!entries.length) return '';
        const buttons = entries.map(entry => {
            const reasons = arr(entry.reasons);
            const selected = selectedId === entry.id || selectedId === entry.name;
            const title = reasons.length ? reasons.join(' · ') : `${entry.name} (${entry.category})`;
            const uses = entry.usesRemaining === Infinity ? 'at will' : `${entry.usesRemaining} left`;
            return `<button type="button" class="rt-lc-btn rt-lc-technique${selected ? ' is-selected' : ''}" data-lc-technique="${escapeHtml(entry.id)}" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${escapeHtml(`${entry.name}: ${title}`)}" title="${escapeHtml(title)}"${entry.disabled ? ' disabled' : ''}>
                <span class="rt-lc-technique-name">${escapeHtml(entry.name)}</span>
                <span class="rt-lc-technique-meta">${escapeHtml(entry.posture)} · ${escapeHtml(uses)}</span>
                ${reasons.length ? `<span class="rt-lc-technique-reasons">${escapeHtml(reasons.join(' '))}</span>` : ''}
            </button>`;
        }).join('');
        return `<div class="rt-lc-technique-group"><h4 class="rt-lc-technique-category">${escapeHtml(titleCase(category))}</h4>${buttons}</div>`;
    }).join('');
}

function defaultTargets(state, actor) {
    return (state?.participants || [])
        .filter(participant => participant.id !== actor?.id)
        .map(participant => ({
            id: participant.id,
            name: participant.name,
            disabled: !isActive(participant),
            reasons: !isActive(participant) ? ['Target is out of the encounter.'] : [],
            zones: [],
        }));
}

function renderZones(entry, view) {
    const zones = arr(entry?.zones).length ? arr(entry.zones) : LEWD_ZONES;
    const selected = text(view?.zone) || text(zones[0]);
    return `<label class="rt-lc-field rt-lc-zone-field">Zone
        <select data-lc-zone aria-label="Target zone">
            ${zones.map(zone => `<option value="${escapeHtml(zone)}"${selected === zone ? ' selected' : ''}>${escapeHtml(zoneLabel(zone))}</option>`).join('')}
        </select>
    </label>`;
}

function renderTargets(state, actor, entry, view) {
    const mode = text(entry?.technique?.targetMode) || '';
    if (mode === 'self') {
        return `<p class="rt-lc-target-self">Self-targeted${entry?.name ? `: ${escapeHtml(entry.name)}` : ''}.</p>`;
    }
    const targets = entry ? arr(entry.targets) : defaultTargets(state, actor);
    if (!targets.length) return '<p class="rt-lc-empty">No targets available.</p>';
    const multi = MULTI_TARGET_MODES.has(mode);
    const selectedIds = arr(view?.targetIds);
    const inputs = targets.map(target => {
        const checked = selectedIds.some(id => text(id) === text(target.id));
        const reasons = arr(target.reasons);
        return `<label class="rt-lc-target${target.disabled ? ' is-disabled' : ''}" title="${escapeHtml(reasons.length ? reasons.join(' · ') : `Target ${target.name}`)}">
            <input type="${multi ? 'checkbox' : 'radio'}" data-lc-target="${escapeHtml(target.id)}" name="rt-lc-target" value="${escapeHtml(target.id)}"${checked ? ' checked' : ''}${target.disabled ? ' disabled' : ''} aria-label="Target ${escapeHtml(target.name)}">
            <span class="rt-lc-target-name">${escapeHtml(target.name)}</span>
            ${reasons.length ? `<span class="rt-lc-target-reason">${escapeHtml(reasons.join(' '))}</span>` : ''}
        </label>`;
    }).join('');
    return `<div class="rt-lc-targets" role="group" aria-label="Targets${multi ? ' (multiple)' : ''}">${inputs}</div>`;
}

function renderPreview(entry, view) {
    if (!entry) {
        return '<p class="rt-lc-preview-text">Choose a technique to preview the posture trade-off, check, and dice.</p>';
    }
    const tradeoff = describePostureTradeoff(text(view?.posture) || entry.posture);
    const technique = entry.technique || {};
    const check = technique.check || {};
    const bits = [
        `${tradeoff.label} posture: accuracy ${signed(tradeoff.accuracy)}, arousal ${signed(tradeoff.arousal)}, poise defense ${signed(tradeoff.poiseDefense)}, poise regen ${signed(tradeoff.poiseRegen)}`,
        `Check: ${text(check.stat || 'cha').toUpperCase()} d20 ${signed(check.accuracy ?? technique.accuracy)}`,
        `Arousal: ${text(technique.arousal || '0')}`,
        `Poise: ${text(technique.poise || '0')}`,
        `Zones: ${(arr(entry.zones).map(zoneLabel).join(', ') || 'full body')}`,
    ];
    return `<p class="rt-lc-preview-text">${escapeHtml(bits.join(' · '))}</p>`;
}

function renderComposer(state, view) {
    const actor = pickActor(state, view);
    const eligible = actorCandidates(state);
    const actorButtons = eligible.map(participant =>
        `<button type="button" class="rt-lc-btn rt-lc-actor${actor?.id === participant.id ? ' is-selected' : ''}" data-lc-action="select-actor" data-lc-unit-id="${escapeHtml(participant.id)}" aria-pressed="${actor?.id === participant.id ? 'true' : 'false'}" aria-label="Act as ${escapeHtml(participant.name)}" title="Act as ${escapeHtml(participant.name)}">${escapeHtml(participant.name)}</button>`).join('');

    if (!actor) {
        return `<section class="rt-lc-composer" aria-label="Action composer">
            <h3 class="rt-lc-section-title">Action</h3>
            <p class="rt-lc-empty">No player participant can act right now. Join a spectator or reset the board.</p>
            <div class="rt-lc-composer-actions">
                <button type="button" class="rt-lc-btn" data-lc-action="stop" aria-label="Call the safe word" title="Safe word"${state?.status !== 'active' || view?.busy ? ' disabled' : ''}>Safe word</button>
                <button type="button" class="rt-lc-btn" data-lc-action="reset" aria-label="Reset the encounter" title="Reset">Reset</button>
            </div>
        </section>`;
    }

    let legal = [];
    try {
        legal = listLegalActions(state, actor);
    } catch (_) {
        legal = [];
    }
    const selectedId = text(view?.techniqueId);
    const entry = legal.find(candidate => candidate.id === selectedId || candidate.name === selectedId) || null;

    return `<section class="rt-lc-composer" aria-label="Action composer">
        <h3 class="rt-lc-section-title">Action</h3>
        <div class="rt-lc-actor-picker" role="group" aria-label="Actor">${actorButtons}</div>
        <div class="rt-lc-postures" role="group" aria-label="Posture">${renderPostureButtons(view, entry)}</div>
        <div class="rt-lc-techniques">${renderTechniques(legal, view)}</div>
        <div class="rt-lc-pickers">
            ${renderZones(entry, view)}
            <div class="rt-lc-target-picker"><span class="rt-lc-field-label">Targets</span>${renderTargets(state, actor, entry, view)}</div>
        </div>
        <div class="rt-lc-preview" aria-live="polite">${renderPreview(entry, view)}</div>
        <div class="rt-lc-composer-actions">
            <button type="button" class="rt-lc-btn rt-lc-btn-primary" data-lc-action="resolve" aria-label="Resolve the selected action" title="Resolve"${view?.busy || !entry || entry.disabled ? ' disabled' : ''}>Resolve</button>
            <button type="button" class="rt-lc-btn" data-lc-action="wait" aria-label="Wait this turn" title="Wait"${view?.busy ? ' disabled' : ''}>Wait</button>
            <button type="button" class="rt-lc-btn rt-lc-surrender" data-lc-action="surrender" aria-label="Surrender the encounter" title="Surrender"${view?.busy ? ' disabled' : ''}>Surrender</button>
            <button type="button" class="rt-lc-btn" data-lc-action="stop" aria-label="Call the safe word" title="Safe word"${view?.busy || state?.status !== 'active' ? ' disabled' : ''}>Safe word</button>
        </div>
    </section>`;
}

function renderEnded(state) {
    const outcome = text(state?.outcome) || 'ended';
    return `<section class="rt-lc-summary" role="status" aria-label="Encounter result">
        <h3 class="rt-lc-section-title">Outcome: ${escapeHtml(titleCase(outcome))}</h3>
        <p class="rt-lc-summary-text">${escapeHtml(text(state?.summary) || 'The encounter has ended.')}</p>
        <div class="rt-lc-composer-actions">
            <button type="button" class="rt-lc-btn rt-lc-btn-primary" data-lc-action="new-encounter" aria-label="Start a new Lewd Combat encounter" title="New encounter">New encounter</button>
            <button type="button" class="rt-lc-btn" data-lc-action="reset" aria-label="Reset the encounter" title="Reset">Reset</button>
            <button type="button" class="rt-lc-btn" data-lc-action="close" aria-label="Close Lewd Combat" title="Close">Close</button>
        </div>
    </section>`;
}

/**
 * Build the full board or start screen.
 *
 * @param {object|null} state
 * @param {object} [view]
 * @param {object|null} [context]
 * @returns {string}
 */
export function buildLewdCombatMarkup(state, view = {}, context = null) {
    if (!state) return renderStartScreen(view, context);

    const participants = arr(state.participants);
    const meta = [];
    meta.push(`Round ${Number(state.round) || 1} / ${Number(state.roundCap) || 1}`);
    meta.push(MODE_LABELS[state.mode] || titleCase(state.mode) || 'Duel');
    if (state.location) meta.push(state.location);
    const status = state.status === 'active'
        ? '<span class="rt-lc-status is-active">In progress</span>'
        : `<span class="rt-lc-status is-ended">Ended${state.outcome ? `: ${escapeHtml(titleCase(state.outcome))}` : ''}</span>`;
    const busy = view?.busy
        ? '<span class="rt-lc-busy" role="status"><span class="rt-lc-spinner" aria-hidden="true"></span> Resolving…</span>'
        : '';
    const error = text(view?.error)
        ? `<p class="rt-lc-error" role="alert">${escapeHtml(view.error)}</p>`
        : '';

    return `<div class="rt-lc-board">
        <header class="rt-tc-header rt-lc-header">
            <div class="rt-tc-title-wrap">
                <div class="rt-tc-kicker">Lewd Combat ${status}${busy}</div>
                <h2 class="rt-tc-title">${escapeHtml(text(state.title) || 'Lewd Combat')}</h2>
                <div class="rt-tc-meta">${meta.map(item => `<span>${escapeHtml(item)}</span>`).join('<span class="rt-tc-dot">·</span>')}</div>
            </div>
            <div class="rt-tc-header-actions">
                <button type="button" class="rt-lc-btn" data-lc-action="settings" aria-label="Open Combat settings" title="Open Combat settings">Settings</button>
                <button type="button" class="rt-lc-btn" data-lc-action="close" aria-label="Close Lewd Combat board" title="Close">Close</button>
            </div>
        </header>
        ${error}
        ${renderRail(state, participants)}
        ${renderMatrix(state)}
        ${state.status === 'active' ? renderComposer(state, view) : renderEnded(state)}
        ${renderSpectatorRail(state, participants, view)}
        ${renderLog(state, view)}
        <footer class="rt-lc-footer">
            <button type="button" class="rt-lc-btn" data-lc-action="stop" aria-label="Call the safe word" title="Safe word"${view?.busy || state.status !== 'active' ? ' disabled' : ''}>Safe word</button>
            <button type="button" class="rt-lc-btn" data-lc-action="reset" aria-label="Reset the encounter" title="Reset">Reset</button>
            <button type="button" class="rt-lc-btn" data-lc-action="close" aria-label="Close Lewd Combat board" title="Close">Close</button>
        </footer>
    </div>`;
}
