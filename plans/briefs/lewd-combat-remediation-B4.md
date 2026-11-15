# Brief — lewd-combat-remediation B4 (control modes and side resolution without `[COMBAT]`)

## Depends on

None (B2 benefits but is already landed). B3 is landed; keep its prose work intact.

## Files (scope — touch only these)

- `src/features/lewd-combat/lewd-combat-context.js`
- `src/features/lewd-combat/lewd-combat-engine.js`
- `src/features/lewd-combat/lewd-combat-ui.js`
- `src/features/lewd-combat/lewd-combat-markup.js`
- `src/features/lewd-combat/lewd-combat-agent.js`
- `narrative-hooks.js`
- `src/state/defaults.js`
- `src/state/settings.js`
- `tests/lewd-combat-context.test.js`
- `tests/lewd-combat-tool.test.js`
- `tests/lewd-combat-markup.test.js`
- `tests/lewd-combat-engine.test.js`

Do **not** edit `lewd-combat-settings.js`, `constantes`, settings.html, or other modules.

## Problem

`buildParticipant` derives `ai` from `side`, `runAiTurns`/`nextOpponentActor` consult `ai`/side, and `seedForName` hardcodes unknown names to `side:'player'`. A scene with no `[COMBAT]` therefore makes everyone player-controlled. `[ENEMY]` does not exist; `[COMBAT]` is the only hostile roster source.

## Required state

- `participant.control: 'player' | 'ai'`, independent of `side`.
- `participant.ai` is a legacy mirror: `ai === (control === 'ai')`.
- Persisted board carries `state.controlMode` (`'auto' | 'player-all' | 'ai-others'`, default `'auto'`).
- Setting `lewdCombatControlMode` default `'auto'` in `src/state/defaults.js` and in the persisted allow list in `src/state/settings.js`.

## Required behavior

### Context (`lewd-combat-context.js`)

1. Export `resolveLewdControlMode(value)` → `'auto' | 'player-all' | 'ai-others'`; unknown/missing → `auto`.
2. Export a small control resolver (or equivalent exported helper) used by seeds:
   - `player-all` → every non-spectator participant is `player`.
   - `auto` → `[CHARACTER]`/`[PARTY]`-sourced candidates (`sources` contains `party`, or `unit.side === 'player'`) and the player persona name (`ctx.name1`) are `player`; `[COMBAT]` enemies/allies (`sources` contains `combat`, `unit.side` in `ally|enemy|opponent`) and `[LEWD]`-only / session / scene-only named NPCs are `ai`.
   - `ai-others` → same player set as `auto`; every other named participant is `ai`.
   - Never infer control from `gender` or from names alone.
3. `collectLewdContext` computes `candidate.control` for every candidate using `options.controlMode ?? settings.lewdCombatControlMode`. Existing dedupe logic must preserve a resolved explicit control and re-resolve merged candidates.
4. `seedForName` returns `control` (from `candidate.control`, or, for unknown names, `player` only under an explicit player name/mode; otherwise `ai`). Do not hardcode unknown names to player-controlled under `auto`/`ai-others`.
5. `buildLewdParticipantSeeds` accepts `controlMode` and `playerNames` options and passes them through; `createLewdEncounterFromContext` reads `options.controlMode` (falling back to settings), passes it to `collectLewdContext`, seeds, and `createLewdEncounterState`, and stores it as `state.controlMode`.
6. `openingActor` must select a `control === 'player'` participant (with `ai` fallback), not `!ai` only if that breaks legacy; the helper should treat missing control by `ai`/side.
7. `[COMBAT]` remains the only hostile roster source. Do not invent an `[ENEMY]` tag or write `[COMBAT]`/`[ENEMY]` anywhere.

### Engine (`lewd-combat-engine.js`)

1. `buildParticipant(raw, state, index, controlMode?)`:
   - explicit `raw.control` (`player`/`ai`) wins;
   - otherwise derive by `controlMode`: `player-all` → `player`; `auto`/`ai-others` → `ai` when `raw.side` is `opponent`/`enemy`, else `player`;
   - set `ai: control === 'ai'`.
2. `createLewdEncounterState` accepts `options.controlMode` (normalized; default `auto`), stores `state.controlMode`, and passes the mode into `buildParticipant`.
3. `joinParticipant` accepts `raw.control` (and honors `state.controlMode` when absent).
4. `nextOpponentActor` selects only active `control === 'ai'` participants (with a legacy `ai`/side fallback for boards without control).
5. `hydrateLewdState` preserves `control`; a legacy participant with no `control` is backfilled from `ai` (true → `ai`, false → `player`) and `ai` is re-mirrored. Hydrate `state.controlMode` with `resolve`-equivalent default `auto`.
6. `serializeLewdState` keeps the field automatically. No engine math, roll, or end-condition changes.

### UI (`lewd-combat-ui.js`)

1. Add `ui.view.startControlMode` default `'auto'`.
2. Controls helpers: player-controlled = `control === 'player'` (legacy fallback `!ai`); AI-controlled = `control === 'ai'` (legacy fallback `ai`/side).
3. `activePlayers`, `currentActor`, and `runAiTurns` must use control, never `side`. The AI-turn loop must never play a player-controlled participant.
4. Start dialog: handle `[data-lc-start-control-mode]` change into `ui.view.startControlMode`; pass `controlMode` to `createLewdEncounterFromContext` in `startFromOverlay`.
5. `startLewdCombatFromNarrator` passes `controlMode: args.controlMode` (falling back to settings) and resets the view field on start.
6. Manual control remains fully available (the human can still select and resolve for any player-controlled participant). No [COMBAT] write.

### Markup (`lewd-combat-markup.js`)

1. Participant card: render a control chip (`Player` / `AI`) derived from `participant.control` with legacy `ai` fallback. Keep/replace the existing `rt-lc-chip-ai` chip; it must no longer claim an `ai` participant is AI when `control === 'player'`.
2. `renderStartScreen`: add a control-mode `<select data-lc-start-control-mode>` with options `auto` (default), `player-all`, `ai-others`, labelled clearly. Per-candidate row shows a control badge (`Player`/`AI`); under `player-all` all rows show Player.
3. `renderSpectatorRail` / `actorCandidates` use control, not `ai`.
4. All text escaped; no DOM access.

### Agent (`lewd-combat-agent.js`)

Add `control` to the actor and participant entries in the payload (so the AI knows which participants it may act for). Keep side. No other payload change.

### Narrator tool (`narrative-hooks.js`)

Add `controlMode: { type: 'string', enum: ['auto', 'player-all', 'ai-others'], description: ... }` to `StartLewdCombat` parameters. Mention it in the tool description only briefly. Do not change availability/latch logic.

## Tests

Add/extend (happy path, invalid input, permission/control failure, dependency failure, regression):

1. No-`[COMBAT]` memo with a `[CHARACTER]`/`[PARTY]` member and a `[LEWD]`-only NPC:
   - `auto` → PC/party `player`, NPC `ai`;
   - `player-all` → both `player`;
   - `ai-others` → PC/party `player`, NPC `ai`;
   - `[COMBAT]` enemy stays `ai`;
   - a session/unknown name in `buildLewdParticipantSeeds` is `ai` under `auto` and `ai-others`, `player` under `player-all`.
2. Engine: explicit `control` wins; side-derived default preserved; `hydrateLewdState` preserves control and backfills legacy `ai` boards; `nextOpponentActor`/`resolveLewdOpponentTurn` refuses to act for a `player` participant and reports no AI actor; `ai` mirrors `control`.
3. Tool schema test updated: exact property list includes `controlMode`, enum is correct.
4. Markup: control chip shows Player/AI correctly; start screen contains `data-lc-start-control-mode` with the three options; `player-all` preview shows Player badges.
5. Regression: all existing lewd tests stay green, including B1/B2 latch and B3 prose behavior.

## Acceptance criteria (from plan)

- No-`[COMBAT]` scene with `auto` → player + named NPC; NPC is AI-controlled.
- `player-all` → both player-controlled; `ai-others` → NPC AI-controlled.
- A `[COMBAT]` enemy is AI-controlled.
- Reload preserves control.
- The AI-turn loop never plays a player-controlled participant.
- No `[ENEMY]` tag invented; no `[COMBAT]` written.

## Gate

- `npx vitest run tests/lewd-combat-outcome.test.js tests/lewd-combat-tool.test.js tests/lewd-combat-context.test.js tests/lewd-combat-prose.test.js tests/lewd-combat-techniques.test.js tests/lewd-combat-pairing.test.js tests/lewd-combat-agent.test.js tests/lewd-combat-markup.test.js tests/lewd-combat-engine.test.js --pool=threads`
- `npx vitest run tests/lewd-combat-integration.test.js tests/lewd-combat-consent.test.js tests/combat-board-reset.test.js --pool=threads`
- `npx vitest run --pool=threads`

## Constraints

- No new dependencies. Preserve public interfaces except the additive `control`/`controlMode` fields.
- Follow existing error-handling/logging patterns; never let control resolution throw the board.
- Keep the module inert when `lewdCombatEnabled` is false.
- Do not commit.
