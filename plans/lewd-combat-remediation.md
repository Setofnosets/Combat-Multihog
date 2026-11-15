# Lewd Combat — Remediation and Action-System Expansion

## Meta
- **Slug:** lewd-combat-remediation
- **Status:** in progress — Phase 1 (B1-B5) implemented and green; next: Phase 2 (A1)
- **Date:** 2026-11-15
- **Predecessor:** `plans/lewd-combat-style.md` (implemented)

## Summary
- **Goal:** Fix the seven reported post-implementation issues in the Lewd Combat module, then expand its action model so it is anatomy-aware and no longer limited to foreplay. Bugfix units land first; additions follow.
- **Core problems found in the current implementation:**
  1. **Cleanup/retrigger:** an ended board is never removed, `finalization.finalizing` is never set by the lewd path, and `StartLewdCombat` re-arms as soon as the queued narration is cleared. No latch/cooldown exists.
  2. **Action gap:** the shipped catalog has 28 techniques, roughly 70% foreplay; there is no penetration, oral, manual/masturbation, or distinct bondage act.
  3. **No anatomy-aware inference:** profiles have no `anatomy`, `skills`, `kinks`, or appendage fields; `inferProfile` is anatomy-blind; `buildParticipant` drops `unit.skills`; the agent payload omits body/species/gender.
  4. **No pair-level act state:** `edge.stance` is dead data, `applies.stance` always hits the actor, and `requires` only supports `hold`/`stance`/`overwhelmed`. There is no “during penetration, thrust harder” or “while tied, tighten bindings” state.
  5. **Side/control collapse:** there is no `[ENEMY]` parser; sides come only from `[COMBAT]`; unknown names default to `player`, and `ai` is derived from side. With no `[COMBAT]`, everyone is player-controlled.
  6. **Prose overwrite:** `narrateAfterExchange` narrates only `state.log[last]` (usually the AI beat); `state.prose` is a single overwritten slot with no history, so the player's action prose disappears.
  7. **Weak aftermath:** the outcome has no persistent “at mercy” state, no memo status writeback, and no strong “do not retrigger / do not resume” directive for the narrator.

## Current State (from exploration)

### End-of-combat lifecycle (issues 1, 5, 7)
- `checkLewdEncounterEnd` (`lewd-combat-engine.js:552`) → `endEncounter` (`:519`) sets `status='ended'`, `outcome`, `winnerIds`, `summary`. It does **not** touch `[COMBAT]` or persist a resolution.
- `finishEncounterIfEnded` (`lewd-combat-ui.js:353`) queues the outcome via `queueLewdOutcome` (`lewd-combat-outcome.js:205`) and fire-and-forgets `continueToNarration` (`:376`). It guards on `status==='active'` and `finalization.narrationQueued`, but never writes `finalization.finalizing` or a timestamp.
- The ended board stays in `lewdCombatByChat[chatId]` with `status:'ended'`; only `resetLewdCombatEncounter` (`:939`) or `combat-board-reset.js:71` removes it.
- `canStartLewdEncounter` (`lewd-combat-context.js:315`) rejects only `status==='active'` (plus active tactical/traditional), so an ended board is startable again.
- `lewdCombatToolAvailable` (`narrative-hooks.js:989`) and `syncLewdCombatToolRegistration` (`:1010`) block only active/finalizing/pending. The lewd path never sets `finalizing`, so after `onGenerationEnded` clears pending narration the tool re-registers.
- No lewd path writes `[COMBAT]END_COMBAT`, strips the block, or marks lewd participants resolved. If participants came from `[COMBAT]`, the hostile roster survives the encounter.

### Prose (issue 6)
- `narrateAfterExchange` (`lewd-combat-ui.js:305`) selects only `state.log[state.log.length - 1]` (`:311`). By then `runAiTurns` (`:189`) has appended the AI beats, so the player's beat is never narrated.
- `state.prose` / `ui.view.prose` are single slots (`ui.js:78, 265`); each successful prose call overwrites the previous. There is no prose history.
- `renderLog` (`lewd-combat-markup.js:415`) renders a beat log plus a single prose `<p>` (`:421` fallback uses `describeLewdBeat`).
- Async prose writes are not guarded by board identity/render token; a late `GENERATION_ENDED` flush can repaint a closed/reset board.

### Sides and control (issue 5)
- No `[ENEMY]` tag exists anywhere in `src/`; sides come from `[COMBAT]` `Enemies:`/`Non-Party Allies:` headers (`combat-persistence.js:113-153`) and everything else defaults to `'player'`.
- `buildLewdParticipantSeeds` (`lewd-combat-context.js:280`) keeps `candidate.side || unit?.side || 'player'`; unknown names are hardcoded `'player'` (`:261`).
- `buildParticipant` (`lewd-combat-engine.js:214`) sets `side: raw.side || 'player'` and `ai: raw.ai === true || side === 'opponent' || side === 'enemy'` (`:225,233`). There is no `control` field.
- `runAiTurns` (`ui.js:189`) drives every `participant.ai` actor; `nextOpponentActor` (`engine.js:1136`) uses `ai || side in {opponent, enemy}`. A `side:'player'` + `ai:true` combination is possible but not exposed.

### Action catalog and profile (issues 2, 3, 4)
- `LEWD_TECHNIQUES` (`lewd-combat-techniques.js:348-612`) has 28 flat, single-effect entries. Explicit acts are only generic zone touches (`hip-grind`, `final-thrust`, `shared-climax`, `finish-hold`).
- `DEFAULT_LEWD_TECHNIQUE`/`validateLewdTechnique` (`:53-330`) supports `requires.hold`, `requires.stance`, `requires.overwhelmed`; `applies` supports `status` and `stance`. `applies.stance` always applies to the actor (`engine.js:916-922`).
- `edge.stance` exists in `lewd-combat-pairing.js:112` but no engine path writes it; `buildPairingMatrix` still renders it.
- `LEWD_ZONES` (`lewd-combat-profile.js:41-44`) excludes `tail`, genitals, and other anatomy-specific targets; `normalizeLewdZone('tail')` returns `''` and a test asserts that.
- `normalizeLewdProfile` has no `anatomy`, `skills`, or `kinks`; `FIELD_ALIASES.skill → experience` coerces a `skill=` value to an integer.
- `inferProfile` (`:452`) ignores `settings` and only reads stats/level; `buildParticipant` copies `stats`, `proficiency`, `initiativeBonus` but drops `unit.skills` and `unit.notes`.
- The agent payload (`lewd-combat-agent.js:196-268`) exposes role/orientation/sensitivity/likes/dislikes/endurance/experience/limits, but no body/species/gender/anatomy/skills.
- `createLewdEncounterFromContext` (`context.js:341`) never calls `buildLewdTechniqueCatalog`; the board starts with the shipped catalog only, so compendium/cache entries are invisible.
- `listLegalActions` has no actor-anatomy gate and does not check posture legality; `chooseOpponentAction` scores only priority/role/sensitivity.

### Key files
- `src/features/lewd-combat/lewd-combat-engine.js` — end checks, participant build, action resolution, local policy, hydrate/serialize.
- `src/features/lewd-combat/lewd-combat-ui.js` — start, action handlers, AI turns, prose queue, finish, reset.
- `src/features/lewd-combat/lewd-combat-outcome.js` — payload, queue, `[LEWD_COMBAT_CONTEXT]`.
- `src/features/lewd-combat/lewd-combat-context.js` — roster candidates, sides, seeds, start gate.
- `src/features/lewd-combat/lewd-combat-profile.js` — `[LEWD]` parser, zones, traits, inference.
- `src/features/lewd-combat/lewd-combat-techniques.js` — schema, catalog, `listLegalActions`.
- `src/features/lewd-combat/lewd-combat-pairing.js` — engagement edges/pairing matrix.
- `src/features/lewd-combat/lewd-combat-prose.js` — beat sheet/prose call.
- `narrative-hooks.js` — `StartLewdCombat` registration/availability, result injection.
- `src/features/tactical-combat/tactical-combat-store.js` — shared pending-narration slot.

## Phase 1 — Bugfixes (land first)

### B1. End-of-encounter lifecycle and idempotent finish
- **Files:** `src/features/lewd-combat/lewd-combat-engine.js`, `lewd-combat-ui.js`, `lewd-combat-outcome.js`, `lewd-combat-store.js`; tests `tests/lewd-combat-outcome.test.js`, `tests/lewd-combat-integration.test.js`.
- **Depends on:** none
- **Parallelizable:** no (lifecycle spine)
- **Expected behavior:**
  - Add a persisted `state.resolution` object written exactly once by `finishEncounterIfEnded`: `{ stateId, endedAt, consumedAt: 0, consumedFor: '', outcome, winnerIds, atMercyIds, surrenderedIds, source: 'lewd' }`.
  - `finishEncounterIfEnded` re-reads the latest persisted state, guards on `status==='ended'`, `resolution`, and `finalization.narrationQueued`, and never runs the auto-narration path twice.
  - `queueLewdOutcome` sets `state.finalization.finalizing = true` and `finalizingStartedAt` (not only `narrationQueued`), so existing stale-finalization guards work for lewd.
  - `resetLewdCombatEncounter` clears the board, `resolution`, prose queue, and the lewd pending narration atomically.
  - No repeated outcome payloads for the same `stateId`.
- **Acceptance criteria:** ending an encounter queues exactly one payload; calling `finishEncounterIfEnded` again is a no-op; a second auto-narration is impossible; `resolution` is present on the stored board; `finalization.finalizing` is visible to the tool guards.
- **Risk:** medium
- **Model / Effort:** implementer model #medium
- **Commit:** `fix(lewd-combat): make encounter finish idempotent and persist a resolution record`
- **Status:** ✅ Done — 7aa243c

### B2. Retrigger guards, cooldown, and explicit new encounter
- **Files:** `src/features/lewd-combat/lewd-combat-context.js`, `lewd-combat-ui.js`, `lewd-combat-store.js`; `narrative-hooks.js`; `src/features/combat/combat-board-reset.js`; `src/state/defaults.js`, `src/state/settings.js`, `settings.html`; tests `tests/lewd-combat-tool.test.js`, `tests/lewd-combat-context.test.js`.
- **Depends on:** B1
- **Parallelizable:** no
- **Expected behavior:**
  - `canStartLewdEncounter` rejects when the current chat has an unconsumed `resolution`, an ended board younger than a configurable `lewdCombatPostEncounterCooldownMs` (default **60 seconds**), or a `finalization.finalizing` marker.
  - The primary guard is **turn-based**: the resolution is consumed only after the narrator delivers it and the next user turn begins. The 60-second cooldown is a mechanical safety net against tool loops, not the main gate; both are configurable from settings.
  - `lewdCombatToolAvailable` and `syncLewdCombatToolRegistration` reject while the resolution/cooldown is active; the tool must not re-register immediately after `onGenerationEnded` clears the pending payload.
  - A resolution is consumed only when (a) the narrator actually injected the outcome and (b) the next user turn has begun, or when the user clicks **New encounter** / **Reset**. Consuming does not auto-open a new encounter.
  - Add a **handoff/quiet period**: `StartLewdCombat` cannot be called in the same assistant turn that delivered the aftermath, and a `LEWD_COMBAT_OVERRIDE`-style guard says “do not resume or restart the encounter”.
  - The start dialog/`StartLewdCombat` must not silently create `[COMBAT]`/`[ENEMY]` tags.
  - `combat-board-reset` clears the resolution latch with the board.
- **Acceptance criteria:** after an end, the tool is unavailable through the pending-narration clear and the 60-second default cooldown; a manual **New encounter** clears the latch and allows a start; no start can occur in the same generation that delivered the outcome; tests cover ended board, consumed latch, and cooldown expiry.
- **Risk:** medium-high
- **Model / Effort:** implementer model #high
- **Commit:** `fix(lewd-combat): latch ended encounters and stop immediate retriggers`
- **Status:** ✅ Done — 7aa243c

### B3. Prose transcript, per-actor prose, and stale-render guard
- **Files:** `src/features/lewd-combat/lewd-combat-ui.js`, `lewd-combat-prose.js`, `lewd-combat-markup.js`, `lewd-combat-engine.js`, `style.css`; tests `tests/lewd-combat-prose.test.js`, `tests/lewd-combat-markup.test.js`.
- **Depends on:** B1 (state persistence) — soft dependency; can land independently
- **Parallelizable:** yes (with B4)
- **Expected behavior:**
  - Add `state.proseLog` (capped, e.g. 50 entries) and `state.lastNarratedLogIndex`/`narratedBeatIds`; each entry stores `{ id, stateId, chatId, round, exchangeId, actorIds, beatIds, text, source, createdAt }`.
  - `narrateAfterExchange` selects **all beats since the last narrated index**, not only the last log entry, so the player's action and the AI response are both included.
  - Store the result in `proseLog` and set `state.prose` to the latest entry for backwards compatibility. Render `proseLog` as a chronological transcript with a scroll/auto-bottom behavior; keep the structured beat log separate.
  - On prose failure, append deterministic `describeLewdBeat` entries for the un-narrated beats instead of silently dropping them.
  - Tag every async prose result with `{stateId, chatId, renderToken}`; discard if the board was reset, closed, or the chat changed.
  - Do not overwrite `ui.view.prose` at the start of a new exchange; append to the log.
- **Acceptance criteria:** a player action followed by an AI turn produces visible prose for both; the player entry remains after the AI entry; reload restores the prose log; a late result for a reset/closed board is discarded; the log keeps the newest entries and caps correctly.
- **Risk:** medium
- **Model / Effort:** implementer model #medium
- **Commit:** `fix(lewd-combat): keep a prose transcript and narrate every exchange beat`
- **Status:** ✅ Done — 7aa243c

### B4. Control modes and side resolution without `[COMBAT]`
- **Files:** `src/features/lewd-combat/lewd-combat-context.js`, `lewd-combat-engine.js`, `lewd-combat-ui.js`, `lewd-combat-markup.js`, `lewd-combat-agent.js`; `narrative-hooks.js`; `src/state/defaults.js`, `src/state/settings.js`; tests `tests/lewd-combat-context.test.js`, `tests/lewd-combat-tool.test.js`.
- **Depends on:** none (but B2 benefits)
- **Parallelizable:** yes (with B3)
- **Expected behavior:**
  - Add `participant.control: 'player' | 'ai'` independent of `side`. `ai` remains a legacy mirror (`ai === control === 'ai'`).
  - Add `lewdCombatControlMode: 'auto' | 'player-all' | 'ai-others'` (default `auto`) and a start-dialog selector; add `controlMode` to the `StartLewdCombat` tool arguments.
  - `auto`: `[CHARACTER]`/`[PARTY]` are player-controlled; `[COMBAT]` enemies/allies are AI-controlled; `[LEWD]`-only named NPCs are AI-controlled unless they are the player name. `player-all`: every active participant is player-controlled. `ai-others`: player controls `[CHARACTER]`/`[PARTY]`, all other named participants are AI-controlled.
  - `buildParticipant` accepts an explicit `control` and derives it from `controlMode` when absent; `hydrateLewdState` preserves it. `joinParticipant` accepts `control`.
  - `runAiTurns`/`nextOpponentActor` use `control` (with `ai` fallback). `activePlayers`/`currentActor` use `control === 'player'`.
  - Unknown names in a no-`[COMBAT]` scene are no longer hardcoded player under `auto`/`ai-others`; they become AI-controlled named NPCs unless the player names them as player characters.
  - The UI shows a control chip per participant and a mode selector; the manual mode remains fully available.
  - No `[ENEMY]` tag is invented; `[COMBAT]` remains the only hostile roster source.
- **Acceptance criteria:** no-`[COMBAT]` scene with `auto` → player + named NPC; NPC is AI-controlled; `player-all` → both player-controlled; `ai-others` → NPC AI-controlled; a `[COMBAT]` enemy is AI-controlled; reload preserves control; the AI-turn loop never plays a player-controlled participant.
- **Risk:** medium-high
- **Model / Effort:** implementer model #high
- **Commit:** `fix(lewd-combat): separate player/AI control from combat side and add control modes`
- **Status:** ✅ Done — c96740f

### B5. Aftermath, mercy state, and narrator context
- **Files:** `src/features/lewd-combat/lewd-combat-outcome.js`, `lewd-combat-ui.js`, `lewd-combat-prompts.js`; `narrative-hooks.js`; `src/state/defaults.js`, `src/state/settings.js`, `settings.html`; optional `memo-processor.js`/`src/state/combat-persistence.js`; tests `tests/lewd-combat-outcome.test.js`, `tests/lewd-combat-integration.test.js`.
- **Depends on:** B1, B4
- **Parallelizable:** no
- **Expected behavior:**
  - Extend the payload/resolution with `atMercyIds`, `surrenderedIds`, `winnerIds`, `mercy` (who holds whom), `finalProse`, and `highlights`.
  - `[LEWD_COMBAT_CONTEXT]` and `[LEWD_COMBAT_RESULT_NOTICE]` explicitly say: the encounter is over; do not resume or restart it; defeated/surrendered participants are at the winner's mercy; they remain in the scene with status **At Mercy**; do not narrate a new sexual encounter unless the player explicitly starts one after a new scene turn.
  - Add two settings: `lewdCombatCombatCleanup` (`off` | `mark` | `close`, default `mark`) and `lewdCombatMercyStatusWriteback` (default `true`). `mark` writes `Status: At Mercy` / `Status: Sated` for participants sourced from `[COMBAT]`; `close` additionally sets the block resolved/closed when every `[COMBAT]` participant was in the lewd scene; `off` leaves the memo untouched. Non-combat/`[LEWD]`-only scenes never write `[COMBAT]`.
  - Add a **Return to story** action that consumes the resolution and clears the board; auto-continue remains opt-in.
  - Keep the result message out of permanent chat history as today, but ensure the prose transcript and `resolution` survive on the board until acknowledged.
- **Acceptance criteria:** the narrator receives an explicit no-retrigger/mercy directive; a defeated opponent is described as at mercy, not as a new hostile; `lewdCombatCombatCleanup` and `lewdCombatMercyStatusWriteback` are honored; `[COMBAT]` is only written when the source was combat and the setting opts in; no second lewd encounter starts from the aftermath; tests cover combat-sourced vs lewd-only outcomes and all cleanup modes.
- **Risk:** medium-high
- **Model / Effort:** implementer model #high
- **Commit:** `fix(lewd-combat): carry mercy state into the narrator handoff and close out combat sources`
- **Status:** ✅ Done — cddec86

## Phase 2 — Additions (after Phase 1 is green)

### A1. Profile anatomy, skills, kinks, and trait foundation
- **Files:** `src/features/lewd-combat/lewd-combat-profile.js`, `lewd-combat-constants.js`, `lewd-combat-context.js`, `lewd-combat-engine.js`, `lewd-combat-agent.js`; `constants.js` (stock `[LEWD]` prompt); `src/state/schema-sections.js`; tests `tests/lewd-combat-profile.test.js`, `tests/lewd-combat-context.test.js`.
- **Depends on:** Phase 1
- **Parallelizable:** yes (with A2 once the schema is frozen)
- **Expected behavior:**
  - Extend `[LEWD]` grammar with `anatomy=`, `skills=`, `kinks=`, `traits=`, `body=`, and `species=` (all optional). Extend the canonical profile with `anatomy[]`, `skills[]`, `kinks[]`, `body`, `species`, `sourceSkills`, `sourceTraits`.
  - Add anatomy tags such as `penis`, `testes`, `vagina`, `vulva`, `anus`, `breasts`, `tail`, `wings`, `tentacles`, `knot`, `bondage-gear`. Add `tail`, `genitals`, `throat`, and `mouth` to the zone set where appropriate (or separate anatomy tags from zones; recommend both: zones are targets, anatomy is capability).
  - Add a one-time **profile inference pass** at encounter start that reads every available source: explicit `[LEWD]` fields (highest priority), the SillyTavern character card (description, personality, scenario, example dialogue), the State Tracker sections (`[CHARACTER]`, `[PARTY]`, `[COMBAT]`, including `Species`, `Body`, `Appearance`, `Personality`, `Traits`, `Abilities`, `Status`), NPC lorebook entries, and `unit.notes`/`unit.skills`/`unit.traits`. It never guesses genitals from gender alone; it marks `inferred: true`, records per-field provenance, and may use one agent call to reconcile ambiguous text into anatomy/skills/kinks.
  - `buildParticipant` carries `sourceSkills`, `sourceTraits`, `notes`, `anatomy`, `skills`, `kinks` into the engine.
  - The agent payload includes anatomy, skills, kinks, and traits (the opponent can see what is visibly relevant).
- **Acceptance criteria:** parses `anatomy=penis,testes`, `skills=bondage`, `kinks=bondage`, `traits=tail`; `tail` is a valid zone; a unit with `Traits: tail` gets `tail` in anatomy; explicit `[LEWD]` fields override card/state-tracker inference; card text and tracker sections contribute signals; no anatomical inference from `gender=female` alone; every inferred field carries provenance; `buildParticipant` retains source skills/traits.
- **Risk:** medium
- **Model / Effort:** implementer model #medium
- **Commit:** `feat(lewd-combat): add anatomy, skills, kinks, and trait profile foundation`
- **Status:** ✅ Done — a706306

### A2. Explicit act catalog (penetration, oral, manual, bondage, masturbation)
- **Files:** `src/features/lewd-combat/lewd-combat-techniques.js`, `lewd-combat-compendium.js`, `lewd-combat-compiler.js`; tests `tests/lewd-combat-techniques.test.js`, `tests/lewd-combat-compendium.test.js`.
- **Depends on:** A1
- **Parallelizable:** yes (with A3 if the schema is frozen)
- **Expected behavior:**
  - Extend the schema with `actType` (`penetration`, `oral`, `manual`, `bondage`, `masturbation`, `other`), `actRole` (`give`, `receive`, `mutual`), `requires.act`, `requires.actType`, `requires.actRole`, `requires.anatomy`, `requires.skill`, `requires.trait`, `requires.kink`, and `applies.act`/`applies.intensity`/`applies.bindings`.
  - Add shipped techniques covering: penetration start/thrust/deepen/withdraw; oral give/receive/deepen; manual stroke/tease; mutual masturbation; bondage tie/tighten/loosen/tease; tail wrap/tail penetration; breast/paizuri; intercrural; sixty-nine; and follow-ups such as thrust-harder, slow-down, tighten-bindings, and change-position.
  - Keep the existing foreplay entries as the lead-in/tease layer. Each new entry has explicit zones, target mode, posture, arousal/poise/stamina effects, requirements, and AI metadata.
  - Update the `[LEWD_TECHNIQUES]` DSL and compiler enums to accept the new fields; unknown fields remain a validation error.
  - The action composer groups by category/act and shows the act’s follow-ups.
- **Acceptance criteria:** the shipped catalog contains explicit acts; `requires.act` entries are disabled without the act; `bondage` entries require a restraint; `withdraw` clears the act; the validator/compiler accept the new fields and still reject unknown categories/zones.
- **Risk:** medium-high (content + schema)
- **Model / Effort:** implementer model #high
- **Commit:** `feat(lewd-combat): add explicit act catalog with penetration, oral, manual, and bondage techniques`

### A3. Deterministic anatomy/skill/trait gating
- **Files:** `src/features/lewd-combat/lewd-combat-profile.js`, `lewd-combat-techniques.js`, `lewd-combat-engine.js`, `lewd-combat-agent.js`; tests `tests/lewd-combat-techniques.test.js`, `tests/lewd-combat-engine.test.js`.
- **Depends on:** A1, A2
- **Parallelizable:** yes (with A4)
- **Expected behavior:**
  - `listLegalActions` and `applyLewdAction` enforce `requires.anatomy` (all/any), `requires.skill`, `requires.trait`, `requires.kink`, and `requires.act`/`actType`/`actRole`.
  - A participant with known anatomy that lacks the required organ cannot use that technique. `unknown` anatomy allows only neutral techniques; genital-specific techniques show “set anatomy in [LEWD]” as the disabled reason.
  - Receptive acts check the target’s anatomy too; a target without the required anatomy is excluded per-target, not by cancelling the whole action.
  - Add human-readable disabled reasons: “requires penis”, “requires vagina”, “requires bondage skill”, “requires tail”, “requires active penetration”.
  - The agent payload/legal actions carry the disabled reasons so the AI cannot select an illegal anatomy-specific act; the engine remains the final validator.
- **Acceptance criteria:** a penis-specific technique is unavailable to a character without a penis; a tail technique requires a tail; a bondage technique requires the `bondage` skill; a receptive technique filters targets by anatomy; unknown anatomy blocks genital acts but not neutral ones; no AI action can bypass the gate.
- **Risk:** medium-high
- **Model / Effort:** implementer model #high
- **Commit:** `feat(lewd-combat): gate actions by anatomy, skills, traits, and kinks`

### A4. Pair-level act/stance state machine and pairing-matrix actions
- **Files:** `src/features/lewd-combat/lewd-combat-pairing.js`, `lewd-combat-states.js`, `lewd-combat-techniques.js`, `lewd-combat-engine.js`, `lewd-combat-markup.js`, `lewd-combat-ui.js`; tests `tests/lewd-combat-pairing.test.js`, `tests/lewd-combat-markup.test.js`.
- **Depends on:** A2, A3
- **Parallelizable:** no (touches engine + UI)
- **Expected behavior:**
  - Extend each engagement edge with `act`, `actType`, `actRole`, `actIntensity`, `actStartedRound`, `bindings`, and `pairStance`. `upsertEngagement` writes them; `expireEngagements` decays/clears them.
  - Add `requires.act`/`requires.minIntensity`/`requires.bindings`/`requires.pairStance` checks; add `applies.act`/`applies.intensityDelta`/`applies.bindingsDelta`/`applies.pairStance`.
  - During penetration, the pair gets follow-ups `thrust-harder`, `slow-down`, `deeper`, `withdraw`; while bound, `tighten-bindings`, `loosen-bindings`, `tease-bound`, `release`. These are visible in the pairing matrix and only actionable for that pair.
  - `applies.stance` can target `actor`, `target`, or `pair`; `edge.stance` becomes live and renders in the matrix.
  - The action composer shows a “Pair: X ↔ Y · act: penetration · intensity 2 · bindings 1” header and groups the follow-ups under it.
- **Acceptance criteria:** starting penetration creates the act on the edge; `thrust-harder` is available only in that pair and only while the act is active; `tighten-bindings` requires an active restraint; withdrawing clears the act; the matrix reflects act/intensity/bindings and updates after each exchange; no pair-level state leaks to other pairs.
- **Risk:** high (engine + UI)
- **Model / Effort:** implementer model #high
- **Commit:** `feat(lewd-combat): add pair-level act state and follow-up actions to the pairing matrix`

### A5. Start-of-combat AI action inference and surfacing
- **Files:** new `src/features/lewd-combat/lewd-combat-inference.js`; modify `lewd-combat-context.js`, `lewd-combat-compendium.js`, `lewd-combat-agent.js`, `lewd-combat-prompts.js`, `lewd-combat-ui.js`; tests `tests/lewd-combat-agent.test.js`, `tests/lewd-combat-context.test.js`.
- **Depends on:** A1, A2, A3, A4
- **Parallelizable:** no (integration)
- **Expected behavior:**
  - `createLewdEncounterFromContext` builds the full catalog via `buildLewdTechniqueCatalog` (shipped + compendium + cache + `[LEWD_TECHNIQUES]`), then runs a one-time **action-inference pass** at start:
    - deterministic prefilter by anatomy/skills/traits/act requirements;
    - optional agent call using the combat agent connection with the profiles, source skills/traits, and candidate list;
    - returns `availableTechniqueIds`, optional `novelTechniques` (compiled once and cached), and per-participant reasons;
    - the engine validates everything; invalid entries are dropped with diagnostics.
  - Cache the inferred **availability set** on `state.inferredActions` for the current encounter only; recompute it at each new encounter. Compiled novel technique **definitions** remain in `settings.lewdCombatTechniqueCache` (compile-once), but availability is never reused across encounters. Provide a **Refresh actions** button for manual re-inference.
  - The AI opponent payload uses the inferred set; the player composer shows the inferred/unlocked acts grouped by category.
  - If the agent call fails/offline, fall back to the deterministic prefilter over the full catalog; never block the board.
- **Acceptance criteria:** a no-`[COMBAT]` scene with a named NPC infers acts from that NPC’s profile/anatomy/skills; a character without a penis never receives penis-only acts; a bondage-skilled character receives bondage acts; a tailed character receives tail acts; a novel act’s definition compiles once and is reused, while availability is recomputed per encounter; offline inference falls back deterministically; the action composer shows the inferred acts.
- **Risk:** high (AI + catalog + cache)
- **Model / Effort:** implementer model #high
- **Commit:** `feat(lewd-combat): infer anatomy-aware actions at encounter start and cache them`

### A6. Documentation, prompt polish, and integration coverage
- **Files:** `docs/lewd-combat.md`, `constants.js` stock prompts, `CHANGELOG.md`, `Pending_Features.md`; tests `tests/lewd-combat-integration.test.js`, `tests/lewd-combat-consent.test.js`.
- **Depends on:** all Phase 1 + Phase 2 units
- **Parallelizable:** yes (per suite)
- **Expected behavior:**
  - Document the new `[LEWD]` fields (`anatomy`, `skills`, `kinks`, `traits`), the act catalog, the gating rules, control modes, the prose transcript, and the end-of-encounter latch/mercy behavior.
  - Add a full integration test for the seven reported issues: end → no retrigger; prose history preserves the player entry; no-`[COMBAT]` control modes; anatomy-gated acts; pair-level follow-ups; mercy handoff; memo only written when combat-sourced.
  - Update the stock prompts to mention anatomy/skills and the “do not retrigger” rule.
  - Keep `lewdCombatEnabled: false` inert; update `Pending_Features.md` with remaining follow-ups (multi-partner beyond 4, `Seduce` bridge, AI director).
- **Acceptance criteria:** docs match the implemented schema; the full suite is green; the seven issues each have a regression test; the module remains inert when disabled.
- **Risk:** low-medium
- **Model / Effort:** implementer model #medium
- **Commit:** `docs/test(lewd-combat): document action model and cover remediation regressions`

## Verification & Testing
- **Automated checks after every unit:**
  - `npx vitest run --pool=threads`
  - Targeted: `npx vitest run tests/lewd-combat-outcome.test.js tests/lewd-combat-tool.test.js tests/lewd-combat-context.test.js tests/lewd-combat-prose.test.js tests/lewd-combat-techniques.test.js tests/lewd-combat-pairing.test.js tests/lewd-combat-agent.test.js --pool=threads`
  - Regression: `npx vitest run tests/lewd-combat-integration.test.js tests/lewd-combat-consent.test.js tests/combat-board-reset.test.js --pool=threads`
- **Manual checks:**
  1. Finish an encounter; confirm no new lewd board opens during the aftermath generation or the next turn; confirm **New encounter** clears the latch.
  2. Play a player action + AI response; confirm both prose entries are visible in the transcript and the player entry is not overwritten.
  3. Start a scene with no `[COMBAT]`; confirm `auto` gives AI control of the named NPC, `player-all` gives the player control of everyone, and `ai-others` gives the player only the PC/party.
  4. Give a character `anatomy=penis` and another without; confirm penis-specific acts are only available to the former. Repeat for `vagina`, `tail`, and `bondage` skill.
  5. Start penetration; confirm `thrust-harder`/`slow-down`/`withdraw` appear only for that pair; tie someone up; confirm `tighten-bindings` appears and increases the bindings state.
  6. Let the AI infer actions at start with the agent online and offline; confirm the fallback list is still legal.
  7. End via surrender/atMercy; confirm the narrator describes the loser as at mercy and does not start a new sexual encounter.
- **Edge cases:** ended board in another chat; stale legacy pending payload; same-generation tool call; chat switch mid-prose; reset while prose is in flight; unknown anatomy; target without receptive anatomy in a group action; pair act when one participant is removed; AI returning a gated act; compendium override of an act; `[COMBAT]` with non-lewd participants; a lewd-only scene with no memo block.

## Assumptions & Decisions (resolved)
Final decisions confirmed this session:
1. **Cooldown:** the 10-minute default was rejected. Use a **60-second** configurable safety cooldown, with the **turn-based latch** as the primary guard (resolution consumed after narrator delivery + the next user turn). Provide a visible **New encounter / End scene** action that clears the latch immediately.
2. **`[COMBAT]` cleanup:** make it a setting. `lewdCombatCombatCleanup` supports `off` / `mark` / `close`, default `mark`. `mark` writes `Status: At Mercy` / `Status: Sated` for combat-sourced participants; `close` also resolves/closes the block when every `[COMBAT]` participant was in the lewd scene; `off` leaves the memo untouched.
3. **Control default:** `auto` = PC/party player-controlled, all other named characters AI-controlled. The start dialog exposes `player-all` and `ai-others`.
4. **Anatomy sources:** use all available character information — explicit `[LEWD]` fields (highest priority), SillyTavern character card text, State Tracker sections, NPC lorebook entries, unit notes/skills/traits. Mark inferred fields and record provenance. Never infer genitals from gender alone.
5. **Explicit catalog:** the shipped catalog includes explicit penetration, oral, manual/masturbation, and bondage acts by default at the current explicitness level.
6. **Prose format:** one prose entry per exchange covering both player and AI beats, plus the structured beat log.
7. **Mercy status:** make it a setting. `lewdCombatMercyStatusWriteback` defaults to `true` and writes persistent `Status: At Mercy` / `Status: Sated` when cleanup is enabled.
8. **Inference caching:** the inferred availability set is **per encounter only** and is recomputed at each new encounter. Compiled novel technique definitions remain in the compile-once cache; availability is not reused across encounters.

Remaining assumptions:
- The user’s “[ENEMY] tag” refers to the `[COMBAT]` block’s `Enemies:` side header; there is no `[ENEMY]` token in the extension.
- The retrigger is primarily the tool re-arming after pending narration clears; the latch/cooldown is the primary fix.
- End-of-encounter cleanup should not silently close an unrelated `[COMBAT]` block; writeback is limited to participants sourced from `[COMBAT]` and controlled by the cleanup setting.
- Anatomy is a capability tag; zones are targets. `tail` and `genitals` may also be valid zones.
- The AI action-inference pass uses the existing lewd combat agent connection; prose remains on the Main connection.
- Unknown anatomy blocks genital-specific acts (safe default) until the profile is set.

**Approval requested:** confirm the plan can move from `draft` to `approved` and begin with **B1 — End-of-encounter lifecycle and idempotent finish**.
