# Fix: Tactical/Traditional passives stuck as "recipe pending"

## Meta
- Slug: fix-tactical-passive-stuck-pending
- Status: in progress (Step 3 of 6 done)
- Date: 2026-11-12

## Summary
- **Goal:** Stop passives from remaining stuck as "· recipe pending" forever. A passive must end every compile attempt in one of two stable states — **resolved** (has a trigger recipe, even a flavour-only one) or **failed** (visible error + click-to-retry) — and a retry must exist from the running board.
- **Context:** Tactical/traditional combat compile `passive: true` abilities once into a deterministic `trigger` + `effectTemplate` recipe (`resolvePassiveRecipeWithAgent` → `rememberPassiveResolution` → Campaign Skill Registry) and execute them deterministically (`applyPassiveTriggers`). Triage confirmed this is a **framework bug**, not an API bug: the API layer (`sendStateRequest`) is shared with working flows; the orchestration lifecycle around the passive resolver never retries, silently drops failures, and skips compilation entirely on several paths.

## Current State (from exploration)

### The "recipe pending" lifecycle today
- A passive shows "· recipe pending" iff `skill.passive === true && !effectTemplate.length` (`tactical-combat-markup.js:307-312`, `traditional-combat-markup.js:218-226`).
- Compilation runs **only at encounter start**, in three places, all keyed off the *context* (never the built state):
  1. Manual start: awaited before the board exists (`tactical-combat-ui.js:1844-1862`, traditional `1117-1135`). Failure → warning; only `warnings[0]` ever reaches a toast.
  2. Narrator + deferred architect: `runDeferredEncounterArchitect` compiles on its own `collectStartContext` context and passes the same object through to `finalizePreparedEncounter` → `buildEncounterFromContext` (tactical `1666-1703`; recipes reach the final board via `normalizeSkill` copy).
  3. Narrator + background compile (no architect): board is built **first**, then a 1s `setTimeout` compiles and copies recipes via `applyPassiveRecipesToState` (tactical `1940-1957`, traditional `1199-1216`).
- Nothing ever re-attempts compilation while a board is running.

### Stuck-forever mechanisms (triage findings)
- **A. Empty-effects contract hole (root cause):** the shipped prompt *instructs* the model to return `{"trigger":{…},"effects":[]}` for non-mechanical passives (`tactical-combat-prompts.js:165`), but the resolver treats `effects: []` as **failure** (`agent.js:1528-29`) → warning → stays pending → next encounter re-attempts → fails identically → permanently pending. Same for `targetId` effects: filtered out at `agent.js:1521` before the emptiness check, so a `targetId`-only response fails.
- **B. Background path fails silently:** the setTimeout calls `resolvePendingPassives` **with no signal/timeout** (tactical `1944-1947`, traditional `1203-1205`); `!result.changed` → early return, failure surfaces only as `console.warn` (`1955`, `1214`). One hung request blocks the serial per-name loop.
- **C. Deferred-architect give-up skips compile:** when the narrator stays busy >90s, `finalizePreparedEncounter` is invoked **without** `context`/warnings (`tactical-combat-ui.js:1744-46`) — passives are never compiled once.
- **D. Agent-authored enemy passives are invisible:** the architect prompt invites `"passive":true` (`tactical-combat-prompts.js:94`) and `normalizeEncounterPayload` copies them (`agent.js:525-530`) with no recipe; `hasPendingPassiveRecipes` inspects only context units, and agent enemies *replace* context enemies (`context.js:1398-1401`) → they land in the state `passive:true, effectTemplate:null` with no compile attempt ever.
- **E. Prompt/payload mismatch:** payload advertises `supportedEvents: ['hit','attacked','round-start','kill']` (`agent.js:1500`) while the prompt documents 9 events and the engine implements 9.
- **F. Name-only recipe application:** `applyPassiveRecipesToState` matches by lowercase name only (`agent.js:1679-1691`); suffixed/renamed agent enemies never receive a recipe. `attachRegistryPassives` requires non-empty owners + fuzzy name match (`context.js:1141-42, 1118-36`).

### Key files
- `src/features/tactical-combat/tactical-combat-agent.js` — `resolvePassiveRecipeWithAgent` (1479), `resolvePendingPassives` (1546), `hasPendingPassiveRecipes` (1650), `applyPassiveRecipesToState` (1669), `applyRegistryDefinitionToSkill` (338), encounter normalization (428-578).
- `src/features/tactical-combat/tactical-combat-passives.js` — `normalizePassiveTrigger`, `passiveMatchesEvent`, `PASSIVE_EVENTS`.
- `src/features/tactical-combat/tactical-combat-ui.js` — `startEncounterFlow` (1754), `runDeferredEncounterArchitect` (1652), `scheduleDeferredEncounterArchitect` (1719), `finalizePreparedEncounter` (1603), background compile (1940).
- `src/features/traditional-combat/traditional-combat-ui.js` — same flow mirrored (955-1001, 1115-1135, 1199-1216).
- `src/features/tactical-combat/tactical-combat-context.js` — `collectEncounterContext` (1168), `attachRegistryPassives` (1139), `selectEncounterEnemies` (1387), `buildEncounterFromContext` (1422).
- `src/features/skill-registry/skill-registry.js` — `rememberPassiveResolution` (1162), `registryEntryToDefinition` (751), `findSkillRegistryEntry` (524), `normalizeMechanics` (126), `mergeEntryMechanics` (563).
- `src/features/tactical-combat/tactical-combat-prompts.js` — `DEFAULT_COMBAT_PASSIVE_RESOLUTION_PROMPT` (132-168).
- `src/features/tactical-combat/tactical-combat-markup.js` / `src/features/traditional-combat/traditional-combat-markup.js` — "recipe pending" badge.
- `src/features/tactical-combat/tactical-combat-engine.js` — `applyPassiveTriggers` (3125), `applyPassiveSkill` (3104), `consumePassiveLimit` (3032), `normalizeSkill` (721).
- `src/features/tactical-combat/tactical-combat-effect-template.js` — `sanitizeEffectTemplate` (210), `normalizeEffectPrimitive` (95).

### Landmines discovered
- `compiled.changed` is discarded everywhere; a half-success looks like a no-op.
- `rememberPassiveResolution` on a **locked** entry returns `effects: []` (`skill-registry.js:1167-69`), so locked passives get a recipe in-context but not persisted — inconsistent across encounters.
- `upsertSkillRegistryEntry(force:false)` from discovery can mark entries `status:'conflict'`, freezing `effectTemplate` merges.
- `applyPassiveTriggers` for `damaged`/`low-hp` requires `options.rng`; callers that omit it silently skip those passives.
- Only `warnings[0]` is ever shown in toasts; multi-passive failures are invisible.
- Traditional combat inherits the tactical engine (`traditional-combat-engine.js` → `applyAction`), so fixes must stay engine-agnostic.
- No tests currently cover `resolvePendingPassives`, `applyPassiveRecipesToState`, the deferred narrator path, or `startEncounterFlow` (`skill-registry.test.js:56-86` covers single compile+remember; `combat-variable-scaling.test.js:376` covers only the predicate).

## Constraints & Requirements
- **Tech stack:** plain ES modules, Vitest (`npx vitest run --pool=threads` — threads pool required on this fork/Termux), SillyTavern extension globals (`SillyTavern.getContext()`); no typecheck/lint scripts exist in `package.json`.
- **No AI calls from inside narrator generations** — the existing constraint that created the deferred/background paths must be preserved (no nested provider requests; 503 source).
- **Registry semantics:** resolved recipes stay authoritative until explicit re-resolve; conflicts are recorded, never silently overwritten.
- **Out of scope:** save-based special checks, reactions/opportunity attacks, area line/cone templates, per-owner variant scaling, bulk-migrating legacy registry entries, prompt localization.

## Assumptions & Open Questions
- **Approved by user (this session):** retry is triggered by **clicking the passive** card — no automatic mid-fight retries (Q3). Plan file location: `/home/locua/.opencode/plan` (Q4).
- Assumption: `effects: []` returned per prompt rule 6 is a *legitimate resolved no-op* (flavour passive), not a failure — it must be persisted so it isn't re-attempted each encounter.
- Assumption: clicking a *resolved* passive does nothing (or shows its trigger); only unresolved/failed ones trigger retry.
- Open: should a failed passive retry automatically at every encounter start (current behaviour) or should a failed attempt be remembered per-encounter to avoid repeated calls? Plan keeps: pending state persists, auto-attempt once at encounter start, click-gated during combat.
- Open: locked-registry passives (`rememberPassiveResolution` early-return) — out of scope unless trivially included in Step 1's status work.

## Step-by-Step Implementation Plan

### 1. Close the empty-effects contract hole (root cause A)
- **Status:** [x] done
- **Files:** `src/features/tactical-combat/tactical-combat-agent.js`, `src/features/tactical-combat/tactical-combat-passives.js`, `src/features/tactical-combat/tactical-combat-markup.js`, `src/features/traditional-combat/traditional-combat-markup.js`.
- **Depends on:** none
- **Parallelizable:** yes (with Step 2)
- **Expected behavior:**
  - `resolvePassiveRecipeWithAgent` accepts `effects: []` as a **resolved no-op**: store the trigger, mark `ok: true`, persist as resolved via `rememberPassiveResolution`. The passive keeps its trigger (fires nothing) but is marked resolved so it is never re-compiled.
  - Effects carrying `targetId` are **remapped to `$target`/`$caster` role selectors** instead of dropped (before the emptiness check), so a `targetId`-only response still yields a usable recipe.
  - Introduce an explicit resolution-state predicate (e.g. `skill.registryStatus === 'resolved'`) so "pending" no longer infers solely from `effectTemplate.length`; both markups use the same predicate. Flavour passives get a distinct badge ("flavour/no mechanical effect") instead of "recipe pending".
- **Acceptance criteria:**
  - A passive the model returns as `effects: []` never shows "recipe pending" again and is not re-compiled on the next encounter.
  - A `targetId`-only effect response yields a recipe with `$target` selector; `ok: true`.
  - Markup badge logic matches the new predicate in both tactical and traditional markups.
- **Risk:** medium (touches resolver semantics consumed by both UI flows + markup)
- **Model / Effort:** implementer model #medium
- **Commit:** `fix(passives): accept empty effects as resolved no-op; remap targetId effects to role selectors`

### 2. Prompt/payload consistency (E)
- **Status:** [x] done
- **Files:** `src/features/tactical-combat/tactical-combat-agent.js`, `src/features/tactical-combat/tactical-combat-prompts.js`.
- **Depends on:** none
- **Parallelizable:** yes (with Step 1)
- **Expected behavior:** payload `supportedEvents` lists all 9 events the prompt documents and the engine implements (`hit`, `attacked`, `round-start`, `battle-start`, `turn-start`, `damaged`, `low-hp`, `kill`, `willpower-break`).
- **Acceptance criteria:** payload and prompt enumerate identical events; no behaviour change for existing recipes.
- **Risk:** low
- **Model / Effort:** implementer model #low
- **Commit:** `fix(passives): align resolver payload event list with prompt + engine vocabulary` — done in 9a85664

### 3. Click-to-resolve retry affordance (B; user-approved UX)
- **Status:** [x] done
- **Files:** `src/features/tactical-combat/tactical-combat-ui.js`, `src/features/traditional-combat/traditional-combat-ui.js`, `src/features/tactical-combat/tactical-combat-markup.js`, `src/features/traditional-combat/traditional-combat-markup.js`, `style.css`, `src/features/tactical-combat/tactical-combat-agent.js` (helper export if needed).
- **Depends on:** Step 1 (status semantics)
- **Parallelizable:** no (consumes Step 1 predicates)
- **Expected behavior:**
  - The background-compile setTimeout path now **surfaces failures**: toast naming the failed passive(s) + combat-log line; `console.warn` retained.
  - The "recipe pending" badge becomes a **button**: clicking the passive re-runs resolution for that skill (`resolvePassiveRecipeWithAgent` → single-skill apply) against the running board, then persist + render. Guarded: only while `state.status === 'active'`, chat-id match, not busy, not mid-narrator-generation (`narratorPipelineBusy()`).
  - Passives that resolve to a no-op (Step 1) render as resolved/flavour, not clickable-retry.
  - Auto compile attempts remain **only at encounter start** (unchanged); mid-fight retries are strictly manual, per user decision.
- **Acceptance criteria:**
  - Killing the connection during background compile shows a named error; clicking the pending passive after restoring it resolves in place (badge clears, trigger appears).
  - Retry is a no-op while a narrator generation is running or the chat changed.
  - Traditional board gets identical behaviour.
- **Risk:** low-medium (delegated event wiring in two UIs)
- **Model / Effort:** implementer model #medium
- **Commit:** `feat(passives): surface background compile failures; click a pending passive to re-resolve it`

### 4. Compile agent-authored enemy passives (D, F)
- **Files:** `src/features/tactical-combat/tactical-combat-agent.js`, `src/features/tactical-combat/tactical-combat-context.js`, `src/features/tactical-combat/tactical-combat-ui.js`, `src/features/traditional-combat/traditional-combat-ui.js`.
- **Depends on:** Step 1
- **Parallelizable:** no
- **Expected behavior:**
  - After `generateEncounterWithAgent` succeeds (and inside `finalizePreparedEncounter`'s built-from-encounter branch), merge agent-authored enemies' pending passives into the compile set **before** `buildEncounterFromContext` — treat agent encounter enemies' skills as part of the context for `hasPendingPassiveRecipes`/`resolvePendingPassives`.
  - `applyPassiveRecipesToState` matches by `registryId` first, then lowercase name (F), so suffixed/renamed agent enemies ("Goblin Archer") still receive their recipe.
  - On the background path (agent enemies arriving post-build), route them through the same setTimeout compile + `applyPassiveRecipesToState` flow, with the Step 3 toast on failure.
- **Acceptance criteria:**
  - An architect-authored enemy with `"passive":true` and no registry entry gets a compiled recipe (or a visible failure toast) **before Round 1**.
  - Renamed/suffixed agent enemies with matching registry entries resolve (registryId/name matching).
  - The `combat-variable-scaling.test.js:376` predicate scenario now resolves end-to-end.
- **Risk:** medium (touches the shared enemy-selection seam used by both modes)
- **Model / Effort:** implementer model #high (glm-5.3)
- **Commit:** `fix(passives): compile agent-authored enemy passives; match recipes by registryId then name`

### 5. Fix the deferred-architect give-up path (C)
- **Files:** `src/features/tactical-combat/tactical-combat-ui.js`, `src/features/traditional-combat/traditional-combat-ui.js`.
- **Depends on:** Step 3 (toast plumbing) — soft dependency; can precede it if needed
- **Parallelizable:** yes (after Step 4 lands the context merge helper)
- **Expected behavior:** when `scheduleDeferredEncounterArchitect` gives up after 90s of narration, `finalizePreparedEncounter`'s no-context branch now **collects a fresh context and runs the passive/intent passes itself** before finalizing, instead of finalizing blind; failures use the Step 3 toast.
- **Acceptance criteria:** narrator busy >90s still yields compiled passives (or a visible named error) on the finalized board — never a silent skip.
- **Risk:** low
- **Model / Effort:** implementer model #medium
- **Commit:** `fix(passives): compile passives on the deferred-architect fallback path`

### 6. Tests
- **Files:** new `tests/combat-passive-resolution.test.js`; extensions to `tests/combat-passives-and-status.test.js`, `tests/combat-variable-scaling.test.js`.
- **Depends on:** Steps 1, 2 (minimum for resolver tests); Steps 4-5 for their suites
- **Parallelizable:** yes (per suite)
- **Expected behavior / coverage:**
  - `effects: []` → `ok: true`, resolved-no-op, no re-compile (predicate returns false).
  - `targetId`-only effects → remapped to `$target`, `ok: true`.
  - Payload event list equals prompt/engine vocabulary.
  - Agent-authored enemy passive gets a recipe before Round 1 (mock resolver).
  - `applyPassiveRecipesToState` registryId-first matching (rename cases).
  - `hasPendingPassiveRecipes` sees agent-enemy passives after the Step 4 merge.
  - Give-up path (Step 5) compiles or surfaces error (unit-testable helper level).
  - Retry helper (Step 3): unit-level — guard tests for status/chat/busy conditions where feasible without DOM; UI wiring asserted via markup strings (`data-tc-action` present, disabled state).
- **Acceptance criteria:** all suites green under `npx vitest run --pool=threads`; no snapshot regressions in existing tactical suites.
- **Risk:** low
- **Model / Effort:** implementer model #medium
- **Commit:** `test(passives): cover empty-effects acceptance, targetId remap, agent-enemy compile, retry guards`

## Verification & Testing
- **Automated checks (run after every step):**
  - `npx vitest run --pool=threads` (full suite; threads pool required by this fork)
  - targeted: `npx vitest run tests/combat-passives-and-status.test.js tests/combat-variable-scaling.test.js tests/skill-registry.test.js --pool=threads`
  - No `npm run typecheck`/`lint` scripts exist in this repo; Vitest is the only gate.
- **Manual checks:**
  1. Set a passive-flavoured ability (`Passive: something purely narrative`) in `[ABILITIES]`, start an encounter with the model returning `effects: []` → badge must read resolved/flavour, not "recipe pending", and stay that way on a second encounter.
  2. Take the combat-agent connection offline mid background compile → expect a **named toast** + log line; restore, click the pending passive → resolves in place, badge clears.
  3. Architect authors an enemy with `"passive":true` → recipe (or visible failure) before Round 1; enemy passive actually fires when its trigger occurs.
  4. Keep the narrator generating >90s with a pending passive → board still ends up compiled, not silently skipped.
  5. Traditional mode: repeat 1-2 on the no-grid board.
- **Edge cases:** model returns fenced prose + JSON; passive name with different casing/accents (normalizeSkillKey); two units sharing a passive name across sides (recipes must not cross-apply — verify `applyPassiveRecipesToState` matching scope); locked registry entries; `effects: []` persistence round-trip through `rememberPassiveResolution`; chat switch mid-retry (must be a no-op); reload during pending compile (no zombie timers).
- **Rollback:** each step is an independent commit; revert the failing step's commit only. Step 1 is the root fix — if it regresses, revert and re-plan around keeping empty-effects as failure + explicit "flavour" marker instead.