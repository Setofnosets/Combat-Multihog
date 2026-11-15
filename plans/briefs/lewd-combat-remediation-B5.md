# Brief — lewd-combat-remediation B5 (aftermath, mercy state, narrator context)

## Depends on

B1 (resolution/queue), B2 (latch), B4 (control) — all landed. Keep their behavior intact.

## Files (scope)

- `src/features/lewd-combat/lewd-combat-outcome.js`
- `src/features/lewd-combat/lewd-combat-ui.js`
- `src/features/lewd-combat/lewd-combat-prompts.js`
- `src/features/lewd-combat/lewd-combat-settings.js` — **only** to normalize/sync/bind the two new settings; this file is not in the plan list but settings.html controls are inert without it.
- `src/features/lewd-combat/lewd-combat-markup.js` — **only** the `Return to story` button in `renderEnded`.
- `narrative-hooks.js`
- `src/state/defaults.js`
- `src/state/settings.js`
- `settings.html`
- `tests/lewd-combat-outcome.test.js`
- `tests/lewd-combat-integration.test.js`
- `tests/lewd-combat-settings.test.js` (only for the two new control ids / normalization)

Do **not** touch the engine's combat math, the B3 prose pipeline, or `[COMBAT]` parsing modules other than by importing from `src/state/combat-persistence.js` (read-only helpers).

## 1. Payload and resolution

- Add to `buildLewdOutcomePayload`: `atMercyIds`, `surrenderedIds`, `mercy`, `finalProse` (already there), `highlights` (already there).
- Add to `buildLewdResolution`: `atMercyIds`, `surrenderedIds` (already there), `winnerIds` (already there), `mercy`, `finalProse`, `highlights`.
- Export `buildLewdMercy(state)` returning an array of per-target entries:
  `{ holderIds: string[], holderNames: string[], targetIds: [id], targetNames: [name], status: 'at-mercy'|'surrendered' }`.
  Holders = `state.winnerIds` (fallback: active non-spectator participant ids); targets = non-spectator participants with `atMercy` or `surrendered`. Pure, never mutates.
- `ensureLewdResolution` must backfill any missing extended fields on an existing resolution object **without replacing the object reference** (B1 idempotency test relies on reference equality). Do not reset `consumedAt`/`deliveredAt`.
- "Combat-sourced" means `participant.side` is `ally`, `enemy`, or `opponent` and `!spectator`. Never treat `side: 'player'` as combat-sourced.

## 2. Narrator directive (no retrigger, mercy, At Mercy)

Update `LEWD_COMBAT_RESULT_NOTICE`, the `[LEWD_COMBAT_CONTEXT]` bridge in `buildLewdNarrationBlock`, and `DEFAULT_LEWD_OUTCOME_PROMPT` so all three explicitly say:

- the encounter is over; **do not resume or restart it**, do not replay exchanges, do not call `StartLewdCombat`;
- defeated/surrendered participants are **at the winner's mercy** and remain in the scene with status **At Mercy** — they are not new hostiles and must not be attacked/treated as a new encounter;
- do **not** narrate a new sexual encounter unless the player explicitly starts one after a new scene turn;
- a Lewd Combat loss is never death or lasting injury (keep existing wording);
- never rewrite `[COMBAT]`, HP, or Willpower from a lewd-only scene.

Add a `Mercy:` line + `{{mercy}}` template variable to `DEFAULT_LEWD_OUTCOME_PROMPT`, fed by a human-readable `buildMercyText(state/payload)` (e.g. `Bran is at the mercy of Aria.` / `None recorded.`). Keep the existing template variables working; `renderTacticalTemplate` leaves unknown placeholders alone.

Also extend `buildLewdCombatRuntimeOverride` in `narrative-hooks.js` (handoff-pending branch) with the same no-resume / At Mercy / no-new-encounter sentences. Do not change tool availability logic.

## 3. Settings and `[COMBAT]` cleanup

Add two settings:

- `lewdCombatCombatCleanup`: `'off' | 'mark' | 'close'`, default `'mark'`.
- `lewdCombatMercyStatusWriteback`: boolean, default `true`.

Add defaults in `src/state/defaults.js`, persistence allow-list entries in `src/state/settings.js`, normalize/sync/bind in `lewd-combat-settings.js`, and controls in `settings.html`:
- `<select id="rpg_lewd_combat_combat_cleanup">` with `off` / `mark` / `close` (mark default), helper note.
- `<input type="checkbox" id="rpg_lewd_combat_mercy_status_writeback" checked>` labelled around “Write At Mercy / Sated status back”.

Implement in `lewd-combat-outcome.js`:

- `export const LEWD_COMBAT_CLEANUP_MODES = ['off', 'mark', 'close']`.
- `export function resolveLewdCombatCleanupMode(value)` → unknown/absent = `'mark'`.
- `export function buildLewdCombatCleanup(state, settings)` — **pure**, returns
  `{ mode, writeback, combatSourced, memo, changed, closed, marked: [{ name, status }] }`.
  Rules:
  - `mode === 'off'` → return the unchanged memo, `changed:false`.
  - no combat-sourced participant → unchanged memo, `changed:false` (a `[LEWD]`-only scene must never write `[COMBAT]`).
  - `writeback === false` → do not edit status lines (but `close` may still close).
  - For each `[COMBAT]` block, for each combatant line matching the shared HP-line shape (`Name: N/N HP...`), if its normalized name matches a combat-sourced participant:
    - out (`atMercy` or `surrendered`) → `Status: At Mercy`;
    - in `winnerIds` (or all remaining active combat participants when no winners) and the outcome is not `stopped`/`draw`/`mutual` → `Status: Sated`.
    - Replace an existing `Status:` line inside that combatant's line group; otherwise insert `Status: …` immediately after the combatant's HP line. Do not reorder or normalise unrelated lines.
  - `close`: after marking, if **every** combatant parsed from the `[COMBAT]` block(s) (`parseCombatants` from `src/state/combat-persistence.js`) matches a participant in the lewd scene (any non-spectator), replace the whole block with `[COMBAT]END_COMBAT[/COMBAT]` and set `closed:true`. If even one combatant was not in the scene, leave the block open but keep the marks.
  - `stopped` / `draw` / `mutual`: no `Sated`/`At Mercy` assertion for winners (a `surrendered`/`atMercy` participant may still be marked At Mercy if announced).
- `export function applyLewdCombatCleanup(state, settings, options = {})`:
  - idempotent: if `state.resolution?.cleanupAt` return the stored summary and do nothing;
  - call `buildLewdCombatCleanup`, assign `settings.currentMemo` when `changed`;
  - record `state.resolution.cleanup = { mode, writeback, combatSourced, closed, marked }` and `state.resolution.cleanupAt = Date.now()`;
  - save once (`saveSettings`) unless `options.persist === false`; never throw to the caller.
  - Return the summary.

Call `applyLewdCombatCleanup(state, settings, { persist:false })` from `finishEncounterIfEnded` right after `ensureLewdResolution` (also when `narrationQueued` is already true, so a legacy ended board gets cleaned once), and make sure the board is persisted afterwards.

## 4. Return to story

- Add `data-lc-action="return-to-story"` **Return to story** to the ended summary in `lewd-combat-markup.js` (one additive button in `renderEnded`; no other markup edits).
- Export `returnLewdCombatToStory()` from `lewd-combat-ui.js`:
  - consume the resolution (`consumeLewdResolution(settings, chatId, { reason: 'return-to-story' })` from context);
  - remove the board (`removeLewdEncounterForChat`), clear the lewd pending narration only (`kind === 'lewd'`), reset the prose queue and view state;
  - close the overlay (return to story), `notifyChanged()`;
  - never auto-open a new encounter and never run an AI turn.
- Wire the action in `handleAction`.

## 5. Tests

Extend `tests/lewd-combat-outcome.test.js`:

1. Payload + resolution include `atMercyIds`, `surrenderedIds`, `mercy`, `finalProse`, `highlights`; mercy names/status are correct for `atMercy` and `surrendered`.
2. `ensureLewdResolution` backfills missing extended fields on a legacy resolution **without changing its object identity or consumed fields**.
3. Notice, bridge block, prompt template, and runtime override contain no-resume/no-restart, “At Mercy”, not-a-new-hostile, and “no new sexual encounter unless the player explicitly starts one”.
4. Cleanup matrix with a `[COMBAT]` memo containing two enemies (`Goblin`, `Wolf`) where only `Goblin` is in the lewd scene:
   - `off` → memo byte-identical;
   - `mark` + writeback true → `Goblin` gets `Status: At Mercy` (or `Sated` for a winner), `Wolf` untouched, block stays open because Wolf was not in the scene;
   - `mark` + writeback false → no status lines (block unchanged);
   - `close` with every combatant in the scene → `[COMBAT]END_COMBAT[/COMBAT]`;
   - `close` with an unmatched combatant → not closed but marked;
   - lewd-only memo (no `[COMBAT]`) → memo unchanged in every mode;
   - `applyLewdCombatCleanup` is idempotent (second call is a no-op, `cleanupAt` stays).
5. `finishEncounterIfEnded` applies cleanup exactly once and the persisted board carries `resolution.cleanup`.

Extend `tests/lewd-combat-integration.test.js`:

6. Combat-sourced scene: finish → memo has `At Mercy`/`Sated`, narrator block carries the mercy directive, and `[COMBAT]` is only written when the setting opts in.
7. `returnLewdCombatToStory()` removes the board and clears the lewd pending narration; no new encounter is opened.
8. Regression: existing end-to-end, latch, reset, prose, and control-mode tests stay green.

Also extend `tests/lewd-combat-settings.test.js` for the two new control ids.

## Gate

- `npx vitest run tests/lewd-combat-outcome.test.js tests/lewd-combat-tool.test.js tests/lewd-combat-context.test.js tests/lewd-combat-prose.test.js tests/lewd-combat-techniques.test.js tests/lewd-combat-pairing.test.js tests/lewd-combat-agent.test.js tests/lewd-combat-markup.test.js tests/lewd-combat-engine.test.js tests/lewd-combat-settings.test.js --pool=threads`
- `npx vitest run tests/lewd-combat-integration.test.js tests/lewd-combat-consent.test.js tests/combat-board-reset.test.js --pool=threads`
- `npx vitest run --pool=threads`

## Constraints

- No new dependencies. Pure builders must not mutate `state`; only `applyLewdCombatCleanup` / `queueLewdOutcome` / `finishEncounterIfEnded` may write settings/state.
- Never write `[COMBAT]` from a `[LEWD]`-only scene. Never write HP/Willpower. Never invent `[ENEMY]`.
- Keep the result out of permanent chat history; `proseLog` and `resolution` survive on the board until acknowledged.
- Follow existing error handling: cleanup is best-effort and must never break the finish handoff.
- Do not commit.
