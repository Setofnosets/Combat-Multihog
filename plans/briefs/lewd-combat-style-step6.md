# Brief — lewd-combat-style U6 (plan Steps 6 + 7: context builder, participant resolution, start flow, board UI/markup)

## Goal

Make Lewd Combat playable end-to-end against the deterministic local policy: build participants from memo/context, start a `duel`/`group`/`free-for-all` board, render the no-grid board (participant rail, pairing matrix, action composer, beat log + deterministic prose pane, debug drawer), handle Start/Join/Leave/Surrender/Stop/Reset, and persist per chat under `lewdCombatByChat`. No AI contract, no prose model call, no narrator outcome payload — those are U7/U8.

This unit covers plan Steps 6 and 7 together.

## Frozen interfaces you may import (already implemented)

`src/features/lewd-combat/lewd-combat-profile.js`
- `parseLewdProfiles(memo, settings, { units }) -> Record<normalizedName, canonicalProfile>`
- `findLewdProfile(profiles, name)`, `resolveLewdProfile(profiles, unit, settings)`, `inferProfile(unit, settings)`
- `LEWD_ZONES`, `LEWD_ROLES`, `normalizeLewdName`, `isBlockedByLimits`, `zoneMultiplier`

`src/features/lewd-combat/lewd-combat-engine.js`
- `createLewdEncounterState({ participants, seed, settings, mode, id, techniques })`
  - participant seeds: `{ id?, name, side, spectator, stats, proficiency, initiativeBonus, profile }`
  - reads `settings.lewdCombatRoundCap`, `settings.lewdCombatMaxPartners`, `settings.lewdCombatDarkerThemes`, `settings.lewdCombatExplicitness`
- `applyLewdAction(state, action, options) -> { ok, reason?, beat?, outcome?, excluded? }`
  - action shape: `{ type:'technique'|'wait'|'escape'|'surrender'|'stop', unitId, techniqueId, targetIds, zone|zones, posture }`
- `resolveLewdOpponentTurn(state, actions = [], options)`
- `chooseOpponentAction`, `listLegalActions` (re-exported)
- `stopLewdEncounter(state)`, `joinParticipant(state, raw)`, `setSpectator(state, unit, spectator)`, `surrenderParticipant`
- `hydrateLewdState(raw)`, `serializeLewdState(state)`
- `LEWD_POSTURES` (`lead|follow|switch` with `accuracy`, `arousal`, `poiseDefense`, `poiseRegen`)

`src/features/lewd-combat/lewd-combat-pairing.js`
- `buildPairingMatrix(state) -> { participants, cells }`, `holdsOn(state, participant)`, `engagementsFor`, `findEngagement`, `holdBetween`

`src/features/lewd-combat/lewd-combat-techniques.js`
- `listLegalActions(state, unit, options) -> [{ id, name, category, technique, disabled, reasons, posture, postures, zones, targets, usesRemaining }]`
  - target entries: `{ id, name, disabled, reasons, zones }`
- `LEWD_TECHNIQUE_CATEGORIES`

`src/features/lewd-combat/lewd-combat-store.js`
- `getLewdEncounterForChat(chatId, settings)`, `setLewdEncounterForChat(chatId, state, settings)`, `removeLewdEncounterForChat(chatId, settings)`, `hasActiveLewdEncounter(settings, chatId)`

`src/features/lewd-combat/lewd-combat-constants.js`
- `LEWD_CHANGED_EVENT = 'rt_lewd_combat_changed'`, `LEWD_OPEN_EVENT = 'rt_lewd_combat_open'`, `LEWD_COMBAT_LABEL`

`src/features/tactical-combat/tactical-combat-context.js`
- `collectEncounterContext(settings, ctx, options)` → `{ memo, playerUnits, enemies, allies, sceneExcerpt, location, chatId, ... }`
- `parsePlayerUnits`, `parseCombatUnits`, `parseMemoBlock`
- Use in try/catch: it throws when every PC is defeated; that must not crash the lewd start.

`../tactical-combat/tactical-combat-markup.js` exports `escapeHtml`.
`../tactical-combat/tactical-combat-constants.js` exports `TC_SIDE_COLORS`, `TC_SIDE_LABELS`.

State-manager: `import { getActiveChatId, getSettings } from '../../../state-manager.js';`

## Files to create

1. `src/features/lewd-combat/lewd-combat-context.js`
2. `src/features/lewd-combat/lewd-combat-markup.js`
3. `src/features/lewd-combat/lewd-combat-ui.js`
4. `tests/lewd-combat-context.test.js`
5. `tests/lewd-combat-markup.test.js`

## Files you may modify (minimal wiring only)

- `index.js`: import `installLewdCombatUi` and call it once next to `installTraditionalCombatUi()`; import `onLewdCombatChatChanged` and call it next to `onTraditionalCombatChatChanged(resolvedId)` inside the existing try/catch pattern.
- `style.css`: append `rt-lc-*` styles only. Follow existing board-overlay classes (`rt-tc-overlay`, `rt-tc-host`, `rt-tc-header`, chips/meters). Mobile + keyboard/ARIA basics; no grid.

Do NOT edit `settings.html`, `src/state/defaults.js`, `src/state/settings.js`, `combat-mode*.js`, the engine, techniques, profile, compendium, or `narrative-hooks.js`. U7/U8/U9 own those.

## Required context API (export exactly these names)

```js
// lewd-combat-context.js
export function collectLewdContext(settings, ctx = {}, options = {})
// -> { chatId, memo, location, sceneExcerpt, profiles, units, candidates, warnings }
// candidates: [{ name, normalizedName, unit|null, side: 'player'|'enemy'|'ally',
//               roleSuggestion, profile, inferred, sources: ['lewd'|'party'|'combat'|'scene'|'session'] }]

export function buildLewdParticipantSeeds(context, options = {})
// options: { participantNames, spectatorNames, mode, settings }
// - resolve case-insensitively against candidates; unknown names become inferred participants
//   (unit null, side 'player', inferProfile({name}, settings)).
// - spectators excluded from turn order (engine does this), active participants get stats/proficiency.
// - throws Error with a clear message when fewer than 2 non-spectator participants are selected.

export function canStartLewdEncounter(settings, chatId)
// -> { ok: boolean, reason?: string }
// blocks when (!settings.lewdCombatEnabled), no chatId, or an existing board is status 'active'.

export function resolveLewdStartMode(value)
// 'duel' | 'group' | 'free-for-all' (default 'duel')

export function createLewdEncounterFromContext(settings, ctx = {}, options = {})
// -> { state, context, warnings }
// - options: { participantNames, spectatorNames, mode, title, location, reason,
//              openingTechnique, openingZone, seed, id, tone }
// - seed defaults to `${chatId}:${Date.now()}` but must accept an explicit deterministic seed.
// - persists nothing; caller persists.

export function applyLewdOpeningExchange(state, options = {})
// -> { ok, beat?, reason? }
// - no openingTechnique -> { ok: true, beat: null }
// - picks the first active non-ai participant as actor and first legal target from listLegalActions,
//   then applyLewdAction({ type:'technique', unitId, techniqueId, targetIds:[...], zone });
// - never throws on an illegal opening: return { ok:false, reason }.
```

Participant detection requirements:
- `[LEWD]` profile names are candidates even when absent from `[PARTY]`/`[COMBAT]`.
- `[PARTY]` + `[COMBAT]` units come from `collectEncounterContext` when it succeeds (`playerUnits`, `allies`, `enemies`); merge and dedupe by `normalizeLewdName`.
- Add `ctx.name1` / `ctx.name2` and any `[CHARACTER]` detected units as candidates.
- Explicit profile wins over `inferProfile`; missing profile → `inferred: true` (visible badge later).
- `side`: unit.side, else candidate's `[LEWD]` source default `'player'`.
- A participant can carry `unit.stats` so engine accuracy/stamina derivation works.

## Required markup API (pure; no DOM at import)

```js
// lewd-combat-markup.js
export function buildLewdCombatMarkup(state, view = {}, context = null)
export function describeLewdBeat(beat, state = null) // templated prose sentence(s) for the log/prose pane
export function describePostureTradeoff(posture) // { key, label, accuracy, arousal, poiseDefense, poiseRegen }
export function staminaPips(current, max) // '●●○○'
```

`view` fields the UI supplies and tests may pass:
`{ startOpen, startCandidates, startSelected, spectatorSelected, startMode, tone, actorId, techniqueId, posture, zone, targetIds, busy, error, showDebug, outcomeDismissed }`

Rendering requirements:
- No board (`state == null`): a start screen with candidate checkboxes (`data-lc-start-participant`), spectator checkboxes (`data-lc-start-spectator`), mode radio/select (`data-lc-start-mode`), tone/explicitness note, and `data-lc-action="start"`. If `startOpen`/candidates absent, show a concise empty state plus a Start/Open control. Escape all names with `escapeHtml`.
- Header: "Lewd Combat", round X / cap, mode, status/outcome, controls: settings, close.
- Participant rail (`.rt-lc-rail`): one card per participant with `rt-lc-card`, `data-lc-unit-id`.
  - Stamina pips `staminaPips(stamina, maxStamina)` + `S x/y`.
  - Arousal meter `.rt-lc-arousal` (current/max) and Poise meter `.rt-lc-poise`.
  - stance chip (`.rt-lc-chip-stance`), holds from `holdsOn(state, participant)` (`.rt-lc-chip-hold`), role, limits badge when `profile.limits.length`, `inferred` badge when `profile.inferred`, `atMercy`/`surrendered`/`spectator` states.
  - Mark AI-controlled participants with an "AI" chip.
- Pairing matrix (`.rt-lc-matrix`): rows/columns per participant; each cell `data-lc-pair-a`, `data-lc-pair-b`, showing engaged/hold/stance/intensity or "—". Build from `buildPairingMatrix(state)`.
- Action composer (`.rt-lc-composer`):
  - actor selector among active, non-AI, non-out, non-spectator participants (`data-lc-action="select-actor"`).
  - posture buttons Lead/Follow/Switch (`data-lc-posture`) using `describePostureTradeoff`; not the Surrender action (separate control).
  - techniques grouped by `LEWD_TECHNIQUE_CATEGORIES` from `listLegalActions(state, actor)`; each button `data-lc-technique="<id>"`, `disabled` when `entry.disabled`, title lists reasons. Hard-limit reasons must render literally "Blocked by limit: …".
  - zone picker (`data-lc-zone`) from the selected entry's zones / `technique.zones`.
  - target picker (`data-lc-target`) from the selected entry's `targets`; multi-select for pair/group/aura; disabled targets show reasons; hard-limit targets show blocked text.
  - live preview `.rt-lc-preview` using `describePostureTradeoff` + technique check/dice values; friendly text when nothing selected.
  - Resolve button `data-lc-action="resolve"` disabled when busy/no actor/no technique; Wait `data-lc-action="wait"`; Surrender `data-lc-action="surrender"`.
  - When no legal technique exists, composer must still offer Wait/Recover-style message (never dead-end).
- Log + prose: `.rt-lc-log` structured beats (round, actor, technique, targets, hit/miss, deltas, status) with newest last and `data-lc-log-entry`; `.rt-lc-prose` shows `describeLewdBeat` for the latest beat; `.rt-lc-debug` toggled by `data-lc-action="toggle-debug"` shows `<pre>` JSON of the last beat (or whole log capped).
- Spectator rail with Join (`data-lc-action="join"`, `data-lc-unit-id`) / Leave (`data-lc-action="leave"`).
- Controls: `data-lc-action="stop"` (Safe Word), `data-lc-action="reset"`, `data-lc-action="close"`, `data-lc-action="settings"`.
- Ended state: outcome + summary, hide action composer, offer Reset/Close. No narrator handoff.
- Accessibility: buttons have `aria-label`/`title`; selected posture/actor uses `aria-pressed`; matrix headers are text, not color-only.

## Required UI API (no DOM at import time)

```js
export function installLewdCombatUi()
export function openLewdCombatBoard(options = {})
export function startLewdCombatFlow(options = {}) // opens start dialog (U8 will call this with participantNames)
export function stopLewdCombatEncounter()
export function resetLewdCombatEncounter()
export function refreshLewdCombatUi()
export function onLewdCombatChatChanged(chatId = getActiveChatId())
export function isLewdCombatBusy()
```

UI behavior:
- Overlay `#rt-lewd-combat-overlay` + host `#rt-lewd-combat-host` (mirror traditional UI's `ensureOverlay/openBoard/closeBoard`), classes `rt-tc-overlay rt-lc-overlay`, `rt-tc-host rt-lc-host`.
- `installLewdCombatUi` is idempotent. Listens for `LEWD_OPEN_EVENT` and calls `event.preventDefault()` then `openLewdCombatBoard()`; listens for keydown Escape and delegated clicks.
- Read board with `getLewdEncounterForChat(getActiveChatId(), getSettings())`; hydrate with `hydrateLewdState`.
- Persist with `serializeLewdState` + `setLewdEncounterForChat`; dispatch `LEWD_CHANGED_EVENT` after start/resolve/reset/join/leave. `saveSettings` is handled by the store.
- Start: use `collectLewdContext`/`buildLewdParticipantSeeds`/`createLewdEncounterFromContext`; block when `canStartLewdEncounter` fails with a toast/error in the dialog; persist and render. Support `participantNames`/`spectatorNames` passed into `startLewdCombatFlow`.
- Resolve: build `{ type:'technique', unitId, techniqueId, targetIds, zone, posture }`, call `applyLewdAction(state, action)`. On `ok`, persist and run AI turns.
- AI turns: while state active, find the first participant with `ai === true && !acted && !spectator && !atMercy && !surrendered`, call `resolveLewdOpponentTurn(state)`, guard at 12 iterations, persist once at the end. This is the local policy only.
- Surrender uses `applyLewdAction({ type:'surrender', unitId })`; Stop uses `{ type:'stop', unitId: <any active player or first participant> }` (or `stopLewdEncounter`). Both persist.
- Join = `setSpectator(state, unitId, false)` (or `joinParticipant` for a new name), Leave = `setSpectator(state, unitId, true)`; surfaces engine rejection reasons.
- Reset removes the board (`removeLewdEncounterForChat`) and returns to the start screen. Close only hides the overlay.
- `onLewdCombatChatChanged`: if overlay open, re-read the new chat (close or render start); never leak a different chat's board.
- Errors: non-blocking, visible in `view.error`; no `throw` escapes a click handler.
- No calls to the narrator, no outcome queue, no prose connection.

## Tests

`tests/lewd-combat-context.test.js` (pure, no DOM):
1. Builds candidates from `[LEWD]` + `[PARTY]`/`[COMBAT]` memo, attaches unit stats and explicit profiles; duplicate names dedupe.
2. Start with two named participants → state has 2 active participants, spectator gets `spectator:true` and is sorted out of the acting roster; missing profile is `inferred: true`.
3. Fewer than 2 active participants (or none) → clear error/no state.
4. `canStartLewdEncounter` blocks an existing `status:'active'` board for the chat, allows when module off/absent and when only a finished board exists.
5. `applyLewdOpeningExchange` with a legal technique creates an engagement edge and logs a beat; an illegal/unknown opening returns `{ok:false}` without mutating.
6. Hydrate round-trip via `serializeLewdState`/`hydrateLewdState` preserves participants, engagements, pools and seed/rollCount.

`tests/lewd-combat-markup.test.js`:
1. No state → start screen, candidate checkboxes and no grid (`not.toContain('data-tc-cell')`, `not.toContain('rt-tc-grid')`).
2. Board renders `rt-lc-rail`, stamina pips, `data-lc-unit-id`, `rt-lc-matrix`, `data-lc-pair-a`, composer, `data-lc-technique`, `data-lc-target`, log/prose/debug.
3. Escapes `<script>` in names and titles.
4. A hard-limit target/technique renders "Blocked by limit" and `disabled`.
5. `describePostureTradeoff` matches `LEWD_POSTURES` numbers exactly for lead/follow/switch.
6. Ended state shows outcome/summary and no Resolve control.
7. Importing `lewd-combat-ui.js` has no DOM side effects and exports the lifecycle functions (`typeof ... === 'function'`).

Run:
- Targeted: `npx vitest run tests/lewd-combat-context.test.js tests/lewd-combat-markup.test.js --pool=threads`
- U6 regression: `npx vitest run tests/lewd-combat-profile.test.js tests/lewd-combat-engine.test.js tests/lewd-combat-pairing.test.js tests/lewd-combat-techniques.test.js tests/lewd-combat-compendium.test.js tests/lewd-combat-store.test.js tests/combat-mode.test.js tests/combat-board-reset.test.js --pool=threads`
- Full gate: `npx vitest run --pool=threads` (baseline: 188 files / 1703 tests green).

## Constraints

- Plain ES modules; no new dependencies.
- Deterministic: no `Math.random` in newly added code (the local policy already handles tie-breaks).
- `lewdCombatEnabled` stays false by default; no behavior change when the module is off.
- Do not route sexual techniques through `[ABILITIES]` or `classifySkillIntent`.
- Preserve CRLF/LF as found; the repo working tree has pre-existing line-ending-only diffs — do not normalize whole files.
- Do not commit.

## Demo (manual)

Enable the module in settings → open the lewd board from the header/settings → pick two `[LEWD]`/`[PARTY]` names + one spectator → Start → choose posture/technique/target → Resolve (AI opponent acts via local policy) → verify pips/meters/matrix/log update, a hard-limit action is disabled with a reason, Stop ends neutrally, Reset returns to the start screen, and reload restores the same seed/pools/pairings.

## Commit (for the commit agent, not you)

`feat(lewd-combat): participant resolution and multi-partner board UI` (covers plan Steps 6 + 7 / U6).

## Attempts

(none yet)
