# Lewd Trigger Mode + Combat Action Previews

## Meta
- Slug: lewd-trigger-mode-and-combat-previews
- Status: approved — decisions locked 2026-11-15
- Date: 2026-11-15

## Summary
- **Goal:** Fix two framework behaviours:
  1. Lewd Combat currently opens on *any* player-initiated intimate scene. Add a setting that chooses between **competitions only** (new default) and **always** (legacy behaviour).
  2. Add an **action preview** to the Tactical and Traditional combat boards that shows a skill/item/attack description plus predicted values (hit chance, average damage/heal, AC, buff numbers, range/area), with special abilities showing their description and resolved-recipe summary instead of fake numbers.
- **Context:** Lewd Combat is a secondary opt-in module with its own tool, prompt section, board, and settings drawer. Its only trigger rule today is the static line in `<lewd_combat>`: “When the scene becomes intimate and the player initiates, call StartLewdCombat once.” There is no contest concept, no `isContest` argument, and no mechanical guard. Tactical and Traditional share the deterministic HP/AC engine, but their UIs are separate; Tactical already has an AoE hover preview, Traditional has none. A preview must reuse the engine's own attack/AC/damage math so the displayed prediction cannot drift from resolution.

## Current State (from exploration)

### Lewd Combat trigger
- `<lewd_combat>` lives in four shipped sources: `constants.js:486-493` (`RT_PROMPTS['sysprompt.txt']`), `constants.js:892-899` (embedded fallback), `sysprompt.txt:98-104`, `sysprompt_legacy.txt` (mirror). Content is static; no mode switch.
- `registerLewdCombatTool()` (`narrative-hooks.js:1075-1135`) exposes `StartLewdCombat` with schema properties `participantNames, spectatorNames, title, location, reason, openingTechnique, openingZone, tone, mode, controlMode`. No `isContest`.
- `lewdCombatToolConfigured()` (`narrative-hooks.js:1014-1021`) = `lewdCombatEnabled && isEffectiveSectionEnabled('lewd_combat')`. `syncLewdCombatToolRegistration()` (`1050-1073`) adds board/latch/pending-result/other-board/cooldown gates.
- The action handler (`narrative-hooks.js:1112-1128`) unregisters the tool, calls `startLewdCombatFromNarrator(args)`, and applies a 30 s failure cooldown when `result.ok === false`.
- `startLewdCombatFromNarrator()` (`lewd-combat-ui.js:604-654`) runs `canStartLewdEncounter()` (`lewd-combat-context.js:653-671`) — structural validation only. No detection of “competition”.
- Settings defaults: `src/state/defaults.js:282-312`; normalize/sync/bind in `lewd-combat-settings.js:98-123,149-217,231-363`; drawer markup `settings.html:2888-3011`; global-key allowlist `src/state/settings.js:1663-1692`.
- `buildSysprompt()` (`index.js:6024-6060`) routes base rows through `transformBaseSectionContent()` (`game-systems.js:447-…`); non-base/unlocked rows pass through verbatim. `transformBaseSectionContent` currently only returns `''` when `lewdCombatEnabled` is false.

### Combat previews
- Tactical: `buildTacticalView()` (`tactical-combat-ui.js:248-394`) computes `reachableCells`, `targetCells`, `rangeCells`, `anchorCells`, and an `aoePreview`. `renderUnitCard()` (`tactical-combat-markup.js:229-408`) renders action/skill/item buttons; skill buttons already carry `title` with description. `renderGrid()` (`:189-212`) renders `#rt-tc-target-hint`. `previewAoeAtCell()` (`ui:433-472`) and `buildAreaPreviewView()` (`ui:203-240`) mutate cell classes and the hint text without re-rendering.
- Traditional: separate controller (`traditional-combat-ui.js`) and markup (`traditional-combat-markup.js`). `targetInfo()` (`ui:151-164`) builds target labels; `renderSelectedPanel()` (`markup:169-287`) renders actions, skills/items, hint, and `targetList()` (`:46-57`). Clicking a target resolves immediately (`ui:466-493`). Traditional state has `grid: null`; range/LOS are ignored by `applyTraditionalAction()` (`traditional-combat-engine.js:450-460`).
- Engine seams: `getEffectiveAc()` (exported, `engine:1384`), `getEffectiveAttackBonus()` (exported, `:1389`), `getSourceAttackBonus()` (**private**, `:1404`), `scaledSourceExpression()` (**private**, `:3831`), `getStatusDamageBonus()`/`getStatusDamageReduction()` (exported, `:1352/:1365`), `getAreaTargets()` (exported, `:426`), `describeUnitOptions()` (exported, `:3995`), `rollDice()` (exported, `:121`, RNG-driven only). No average-expression or hit-chance helper exists.
- Resolution math to mirror: natural 20 always crits and hits; natural 1 always misses; otherwise `d20 + attackBonus >= AC`. Basic attack uses `getEffectiveAttackBonus(...)` and `unit.damage`; skill attack uses `getSourceAttackBonus(...)` and `damage: skill.damage || unit.damage || '1d6'`; heal uses `scaledSourceExpression({heal: skill.heal || '1d8+2'}, ..., 'heal')`; items heal with `item.amount || '2d4+2'` (`engine:3372-3382, 3434-3466, 3519-3530`). Outgoing `getStatusDamageBonus` and incoming `getStatusDamageReduction` are applied to both HP and Willpower damage, clamped at 0 (`:3885-3903`).
- Specials carry `effectTemplate` (normalized in `normalizeSkill`, `engine:799-801`); `summarizeEffectTemplate()` (`tactical-combat-effect-template.js:246-298`) already renders a human-readable one-liner.
- Existing UI toggle `tacticalCombatShowTargetingPreviews` (default true) gates only the AoE hover overlay; it is read in `tactical-combat-ui.js:296,438`.
- Relevant tests: `tests/tactical-combat-markup.test.js`, `tests/tactical-combat-ui-import.test.js`, `tests/traditional-combat-markup.test.js`, `tests/traditional-combat-ui-import.test.js`, `tests/tactical-combat-settings.test.js`, `tests/lewd-combat-settings.test.js`, `tests/lewd-combat-tool.test.js`.

### Key files
- `narrative-hooks.js` — lewd tool registration, schema, handler, runtime override.
- `src/features/lewd-combat/lewd-combat-ui.js` — narrator/manual start paths.
- `src/features/lewd-combat/lewd-combat-context.js` — start validation, encounter creation.
- `src/features/lewd-combat/lewd-combat-settings.js` — drawer binding/normalization.
- `constants.js`, `sysprompt.txt`, `sysprompt_legacy.txt` — shipped narrator sections.
- `game-systems.js`, `index.js` — prompt assembly rows.
- `src/state/defaults.js`, `src/state/settings.js`, `settings.html` — persisted settings.
- `src/features/tactical-combat/tactical-combat-engine.js`, `tactical-combat-ui.js`, `tactical-combat-markup.js` — shared engine + tactical board.
- `src/features/traditional-combat/traditional-combat-ui.js`, `traditional-combat-markup.js` — traditional board.
- `src/features/tactical-combat/tactical-combat-effect-template.js` — special summary helper.

### Landmines
- **Prompt text exists in four sources.** Updating only `constants.js` does not change users whose `sysprompt.txt` is fetched from disk; update all four and note that unlocked base overrides are not touched.
- **`buildSysprompt` bypasses transforms for unlocked/custom rows.** Trigger text must therefore be injected at assembly time (not only inside the base transform) or unlocked users keep the old broad rule.
- **The handler’s failure cooldown is unconditional.** A competitions-mode rejection must not set the 30 s cooldown or re-registering a valid competition becomes impossible for 30 s.
- **`render()` rebuilds the whole board DOM.** Hover text must be applied directly to the existing hint node (like `previewAoeAtCell`) or it will thrash render/hover.
- **Special skills are not deterministically resolvable**; showing invented damage would be a lie. Use description + `summarizeEffectTemplate` + a resolver notice.
- **Traditional has no grid**; `getAreaTargets` bails without `state.grid`. Traditional previews must ignore area cells and compute only per-target numbers from the target list.
- **Traditional card chips show raw `unit.ac`/`unit.attackBonus`** while the engine uses effective values (`getEffectiveAc`/`getEffectiveAttackBonus`). A preview using effective values will visibly disagree with the current chips.
- **Skill expressions may contain `@` scale tokens**; the average parser must return `null` rather than a wrong number.
- **Items use `amount`, not `heal`/`damage`**, for their heal value.

## Constraints & Requirements
- **Tech stack:** vanilla ESM browser modules for SillyTavern; Vitest, no TypeScript/ESLint scripts in this fork (`package.json` has only `test`). Keep modules DOM-free at import time.
- **Determinism:** the preview is read-only. It must call no RNG, mutate no state, write no log, and consume no uses.
- **Source of truth:** predicted numbers must be derived from the same engine functions that resolve actions. Never duplicate attack/AC logic in markup.
- **Backward compatibility:** the new lewd setting defaults to `competitions`, so existing users stop seeing the board on casual intimate scenes unless they switch to `always`. This is the requested behaviour change. The new preview setting defaults to `true`; the existing AoE toggle is untouched.
- **Consent rails:** nothing in this work weakens limits, safe word, or the competitions guard. Manual start from Settings/board remains an explicit player action.
- **Out of scope:** redesigning the lewd board, adding a fourth combat style, previewing special effects exactly, implementing save-based resolution, changing the combat agent contract, or adding previews to the dungeon map/other boards.

## Assumptions & Decisions
- **Assumption:** “competition” means an intimate contest with stakes and a winner (struggle for dominance, wager, challenge, duel of technique), not routine affection/flirtation/single act.
- **Assumption:** the narrator can identify a competition well enough to set an explicit `isContest` flag; the guard is a safety net, not a semantic classifier.
- **Assumption:** previews should appear for basic attacks, skills, and items, and be available via click-selection plus target hover/selection.
- **Decision 1 — trigger default:** `lewdCombatTriggerMode` defaults to `competitions`. Users who want the old broad behaviour select `always`.
- **Decision 2 — enforcement:** `competitions` is a hard rejection at the narrator tool. A call without `isContest: true` returns a “narrate this normally” message and creates no board.
- **Decision 3 — manual start:** Settings → Combat and the board’s “Start scene” / “Open board” explicitly bypass the competitions guard; only the narrator tool is gated.
- **Decision 4 — preview toggle:** one shared `combatShowActionPreviews` setting (default `true`) for both Tactical and Traditional.
- **Decision 5 — Traditional chips:** align the Traditional AC/ATK chips to `getEffectiveAc` / `getEffectiveAttackBonus` so they agree with the preview.
- **Decision 6 — predicted damage:** show the **average** as the primary number and include the parsed **min–max** range in the full preview panel where the expression is parseable; target labels/hints use the average only.
- **Residual risk (accepted):** the host’s fetched `sysprompt.txt` path is outside this repo; the plan updates all four known copies and injects the trigger rule at assembly time, which also covers unlocked overrides.

## Step-by-Step Implementation Plan

### A1. [x] Add the `lewdCombatTriggerMode` setting
- **Status:** done — commit `8af0241`
- **Files:** `src/state/defaults.js` (add `lewdCombatTriggerMode: "competitions"` beside the other `lewdCombat*` keys), `src/features/lewd-combat/lewd-combat-constants.js` (`LEWD_COMBAT_TRIGGER_MODES`, `triggerMode: 'competitions'` in `LEWD_COMBAT_DEFAULTS`), `src/features/lewd-combat/lewd-combat-settings.js` (normalize/sync/bind), `src/state/settings.js` (global-key allowlist), `settings.html` (select in the Lewd Combat drawer after the enable checkbox, “Competitions only” selected by default), `tests/lewd-combat-settings.test.js`.
- **Depends on:** none.
- **Parallelizable:** yes (with B1/B2).
- **Expected behavior:** A new `Trigger` select shows **Competitions only (default)** and **Always**. The value persists, normalizes unknown values to `competitions`, and is exposed through `normalizeLewdCombatSettings()`. No runtime behaviour changes yet.
- **Acceptance criteria:**
  - `buildDefaultSettings().lewdCombatTriggerMode === 'competitions'`.
  - `normalizeLewdCombatSettings({ lewdCombatTriggerMode: 'nope' }).lewdCombatTriggerMode === 'competitions'`; `'always'` survives.
  - The drawer ships `rpg_lewd_combat_trigger_mode`; sync/change handlers update the setting and persist.
  - The key is in the global allowlist and is not projected into chat state.
- **Risk:** low.
- **Model / Effort:** deepseek-v4.1-flash #low.
- **Commit:** `feat(lewd): add always/competitions trigger-mode setting`

### A2. [x] Inject a mode-aware narrator trigger rule
- **Status:** done — commit `95310bc`
- **Files:** new `src/features/lewd-combat/lewd-combat-trigger.js`; `constants.js` (both `<lewd_combat>` copies), `sysprompt.txt`, `sysprompt_legacy.txt`; `index.js` (`buildSysprompt` row handling); new `tests/lewd-combat-trigger.test.js`.
- **Depends on:** A1.
- **Parallelizable:** no (touches prompt assembly).
- **Expected behavior:** The `<lewd_combat>` section no longer hard-codes “any intimate scene”. `buildSysprompt` inserts a fresh `<lewd_combat_trigger>…</lewd_combat_trigger>` block immediately after `<lewd_combat>` for **both base and unlocked rows**, stripping any previous block first.
  - `always`: call `StartLewdCombat` once whenever the scene becomes intimate and the player initiates.
  - `competitions`: call it **only** when the player initiates an intimate competition with stakes and a winner; routine intimacy/flirting/kissing/casual acts must be narrated normally; pass `isContest=true`; if unsure, do not call.
  - The injected block explicitly says it overrides broader trigger wording in the section, so old unlocked copies are overridden semantically.
  - Pseudocode for the pure helper:
    ```
    applyTrigger(content):
      content = content.replace(/<lewd_combat_trigger>[\s\S]*?<\/lewd_combat_trigger>/gi, '')
      block = `<lewd_combat_trigger>\n${instruction}\n</lewd_combat_trigger>`
      if content contains '<lewd_combat>': insert block after first open tag
      else: prepend block
    ```
- **Acceptance criteria:**
  - In `competitions` mode the assembled section contains the words “ONLY”, “competition”, and `isContest=true`.
  - In `always` mode it contains the original broad trigger.
  - Re-running the helper does not duplicate blocks.
  - Unlocked/verbatim rows also receive the block.
  - Existing shipped-section tests still pass after the static wording change.
- **Risk:** medium (prompt behaviour across four shipped sources and user overrides).
- **Model / Effort:** deepseek-v4.1-flash #medium.
- **Commit:** `feat(lewd): inject always/competitions narrator trigger rule`

### A3. [x] Enforce competitions-only at the narrator tool
- **Status:** done — commit `99db0ad`
- **Files:** `narrative-hooks.js` (schema, description, action-handler cooldown logic), `src/features/lewd-combat/lewd-combat-ui.js` (`startLewdCombatFromNarrator` guard), `tests/lewd-combat-tool.test.js`, `tests/lewd-combat-integration.test.js` (if it exercises the start path).
- **Depends on:** A1, A2.
- **Parallelizable:** no.
- **Expected behavior:**
  - Schema adds optional boolean `isContest`; description tells the narrator to set it only for genuine competitions and notes the configured mode.
  - `startLewdCombatFromNarrator` reads `resolveLewdCombatTriggerMode(settings.lewdCombatTriggerMode)`. In `competitions` mode, if `args.isContest !== true`, it returns `{ ok: false, rejected: true, message: 'Not started: … narrate this intimate moment normally …' }` **before** creating state.
  - The tool action handler only applies the 30 s failure cooldown when `!result.ok && !result.rejected`; on rejection it calls `syncLewdCombatToolRegistration()` so a later legitimate competition can start immediately.
  - Manual `startFromOverlay()` (Settings/board) is unchanged and bypasses the guard.
- **Acceptance criteria:**
  - With `lewdCombatTriggerMode: 'competitions'`, a tool call without `isContest` creates no board and returns a clear “narrate normally” message.
  - With `isContest: true`, the board starts (all structural gates permitting).
  - With `lewdCombatTriggerMode: 'always'`, omitting `isContest` still starts.
  - A rejection does not set the cooldown and re-registers the tool.
  - Schema test key list includes `isContest`.
- **Risk:** medium (tool-call lifecycle and latch/cooldown interaction).
- **Model / Effort:** deepseek-v4.1-flash #medium.
- **Commit:** `feat(lewd): enforce competitions-only starts via isContest flag`

### B1. [x] Create the pure action-preview module
- **Status:** done — commit `b5282c0` (fallback parity fix in `806391b`)
- **Files:** `src/features/tactical-combat/tactical-combat-engine.js` (export `getSourceAttackBonus` and `scaledSourceExpression`; no behaviour change), new `src/features/tactical-combat/combat-action-preview.js`, new `tests/combat-action-preview.test.js`.
- **Depends on:** none.
- **Parallelizable:** yes (with A1).
- **Expected behavior:** A DOM-free module exports:
  - `resolvePreviewExpression(source, state, unit, target, field)` — wraps the newly exported `scaledSourceExpression`, returning the raw expression.
  - `averageDiceExpression(expression)` → `{ min, avg, max } | null`. Handles `XdY`, flat `+/-Z`, and bare numbers; returns `null` when the expression contains `@` tokens or unparseable fragments. The panel line shows `avg` as the primary value and `(min–max)` when the range is wider than the average.
  - `estimateHitChance(attackBonus, ac)` → integer 0–100, counting natural 1 as a miss, natural 20 as a hit, otherwise `d20 + bonus >= ac`.
  - `buildActionPreview(state, unit, source, { target, mode })` → `{ title, description, kind, special, lines: string[], summary, prediction }`.
    - Basic attack (`source == null`): `getEffectiveAttackBonus`, `unit.damage`, `unit.attackResource`/`willpowerDamage`.
    - Skill attack: `getSourceAttackBonus`, `source.damage || unit.damage || '1d6'`, Willpower pool if `resource` is `willpower|both`.
    - Heal: `source.heal || '1d8+2'` for skills, `source.amount || '2d4+2'` for items.
    - Buff: `acBonus`, `attackBonus`, `damageBonus`, `damageReduction`, `rounds`.
    - Special: description + `summarizeEffectTemplate(source.effectTemplate)` or “resolved by the combat agent when cast”; no numeric prediction.
    - Apply outgoing/incoming bonuses when a target is supplied; clamp at 0.
    - `prediction`: `{ hitChance, critChance, averageDamage, averageHeal, ac }` where fields are present only when meaningful.
    - `summary`: one-line string for hints/target labels, e.g. `Aimed Shot → Goblin Archer: 65% hit · 1d8 (avg 4.5) · AC 13`. Hints/target labels use the average only.
  - All strings are plain text; escaping stays in markup.
- **Acceptance criteria:**
  - Unit tests cover average parsing (`1d8+3` → `{min:4, avg:7.5, max:11}`, `2d6` → `{min:2, avg:7, max:12}`, `@enemiesd6` → null), hit-chance edges (bonus 0 vs AC 21 → 5% crit-only; bonus 50 vs AC 10 → 95%; natural-1 exclusion), basic vs skill vs heal vs special previews, and target-specific AC/bonus application.
  - The full preview panel exposes min–max for parseable expressions; the one-line summary stays average-only.
  - Preview functions never mutate the state object and never call `rollDice`.
  - Engine export change causes no existing test failure.
- **Risk:** low–medium (math must mirror resolution exactly).
- **Model / Effort:** deepseek-v4.1-flash #medium.
- **Commit:** `feat(combat): add pure action-preview prediction module`

### B2. [x] Add the `combatShowActionPreviews` setting
- **Status:** done — commit `f3015cb`
- **Files:** `src/state/defaults.js`, `src/state/settings.js` (global allowlist), `src/features/tactical-combat/tactical-combat-settings.js` (sync/bind), `settings.html` (checkbox next to the existing previews toggle, note that it applies to both boards), `tests/tactical-combat-settings.test.js`.
- **Depends on:** none.
- **Parallelizable:** yes (with A1/B1).
- **Expected behavior:** A shared setting `combatShowActionPreviews` (default `true`) turns the new preview panel and per-target prediction text on/off for both Tactical and Traditional. The existing `tacticalCombatShowTargetingPreviews` keeps its current meaning (AoE hover overlay only).
- **Acceptance criteria:**
  - Default is `true`; checkbox round-trips through sync/bind.
  - Key appears in the defaults test list and global allowlist.
  - Boards read `settings.combatShowActionPreviews !== false`.
- **Risk:** low.
- **Model / Effort:** deepseek-v4.1-flash #low.
- **Commit:** `feat(combat): add shared action-preview setting`

### B3. [x] Integrate previews into the Tactical board
- **Status:** done — commit `fee65a7` (hint reset fix in `806391b`)
- **Files:** `src/features/tactical-combat/tactical-combat-ui.js`, `src/features/tactical-combat/tactical-combat-markup.js`, `style.css`, `tests/tactical-combat-markup.test.js`, `tests/tactical-combat-ui-import.test.js`.
- **Depends on:** B1, B2.
- **Parallelizable:** yes (with B4, once B1/B2 land).
- **Expected behavior:**
  - `buildTacticalView()` computes `view.actionPreview = buildActionPreview(...)` when previews are enabled and `view.mode` is `attack`, `skill` with a selected skill, or `item` with a selected item. It uses no target so the panel shows generic values.
  - `renderUnitCard()` renders a compact `.rt-tc-action-preview` block below the mode hints: title, description, and `lines`; special abilities get a distinct “special / resolver” chip. Escape everything.
  - Hovering/clicking a legal single-target cell updates `#rt-tc-target-hint` with the target-specific `summary` without re-rendering. Extend `previewAoeAtCell`/add a sibling branch for non-area sources; restore the default hint on leave.
  - AoE hints append a prediction fragment (`~avg dmg/target`, hit-chance range when target ACs differ, or `~avg heal` for support).
  - CSS adds `.rt-tc-action-preview` styling consistent with the unit card; no layout shift when the preview is absent.
- **Acceptance criteria:**
  - Selecting a skill renders its description and predicted numbers; selecting a special skill renders the description, recipe summary (when present), and a resolver notice, with no fabricated damage.
  - Hovering a target cell appends `% hit · avg` to the hint; leaving clears it.
  - With `combatShowActionPreviews: false`, no preview block and no target prediction text appear.
  - Existing AoE hover behaviour and tests still pass.
  - Markup test asserts the block renders from `view.actionPreview` and escapes injected text.
- **Risk:** medium (DOM re-render/hover interaction).
- **Model / Effort:** deepseek-v4.1-flash #medium.
- **Commit:** `feat(tactical): show action descriptions and predicted values`

### B4. [x] Integrate previews into the Traditional board
- **Status:** done — commit `40d116c`
- **Files:** `src/features/traditional-combat/traditional-combat-markup.js`, `src/features/traditional-combat/traditional-combat-ui.js`, `style.css`, `tests/traditional-combat-markup.test.js`, `tests/traditional-combat-ui-import.test.js`.
- **Depends on:** B1, B2.
- **Parallelizable:** yes (with B3).
- **Expected behavior:**
  - `renderSelectedPanel()` renders `.rt-trad-action-preview` for the selected attack/skill/item when previews are enabled.
  - `targetInfo()` appends the per-target prediction to each target label, e.g. `Goblin (12/12 HP) — 65% hit · 1d6+2 (avg 5.5) · AC 13`. Specials append `resolved by the agent` instead.
  - Because Traditional resolves on target click, this is the confirmation surface; no extra click is added.
  - Align the Traditional card chips with the engine: use `getEffectiveAc(state, unit)` and `getEffectiveAttackBonus(state, unit)`, matching the preview and the Tactical card.
  - CSS reuses the Tactical preview styles plus a `.rt-trad-target small`/muted line for the prediction.
- **Acceptance criteria:**
  - Selecting a skill shows its description and predicted values; the target list shows per-target hit/damage before clicking.
  - Specials show description + recipe summary/resolver notice, not damage.
  - With `combatShowActionPreviews: false`, no preview block or prediction text appears.
  - Traditional markup test asserts escaped preview content and target-label prediction.
  - No grid/AoE assumptions leak into Traditional.
- **Risk:** medium (target-label composition and effective-value alignment).
- **Model / Effort:** deepseek-v4.1-flash #medium.
- **Commit:** `feat(traditional): show action descriptions and predicted values`

### B5. [x] Update docs and changelog
- **Status:** done — commit `d9bcbc6`
- **Files:** `docs/lewd-combat.md`, `docs/tactical-combat.md`, `docs/traditional-combat.md`, `CHANGELOG.md`.
- **Depends on:** A1–A3, B1–B4.
- **Parallelizable:** no.
- **Expected behavior:** Document:
  - `lewdCombatTriggerMode` (`always`/`competitions`), what counts as a competition, the `isContest` tool argument, and that manual start bypasses the guard.
  - `combatShowActionPreviews` and exactly what the preview shows (description, hit %, avg damage/heal, AC, buff lines, special resolver notice).
  - Traditional’s effective AC/ATK alignment.
- **Acceptance criteria:** docs match shipped defaults and UI labels; CHANGELOG has one entry per issue.
- **Risk:** low.
- **Model / Effort:** deepseek-v4.1-flash #low.
- **Commit:** `docs: document lewd trigger mode and combat action previews`

## Verification & Testing
- **Automated checks (run after every step):**
  - `npx vitest run --pool=threads`
  - Targeted: `npx vitest run --pool=threads tests/lewd-combat-settings.test.js tests/lewd-combat-tool.test.js tests/lewd-combat-trigger.test.js tests/combat-action-preview.test.js tests/tactical-combat-markup.test.js tests/tactical-combat-ui-import.test.js tests/traditional-combat-markup.test.js tests/traditional-combat-ui-import.test.js tests/tactical-combat-settings.test.js`
  - There is no `typecheck`/`lint` script in this fork; do not invent one.
- **Manual checks:**
  1. Fresh defaults show `competitions`: enable the module, send a casual intimate scene → no board, narration continues.
  2. In `competitions`, declare a contest → board opens; call the tool without `isContest` → rejected with a “narrate normally” message and no 30 s lockout.
  3. Switch to `always`, send the same casual scene → board opens as in the legacy behaviour.
  4. Manual Settings/board “Start scene” still opens regardless of trigger mode.
  5. Tactical: select an attack, a damaging skill, a heal, a buff, and a special; confirm the preview block shows description, hit %, average damage/heal with min–max, and the target-hover hint shows the average; the special shows its description/recipe, not damage.
  6. Traditional: same set; confirm each target button shows the prediction before clicking, and card AC/ATK match the preview.
  7. Toggle `combatShowActionPreviews` off → previews disappear in both boards; AoE hover toggle still works independently.
- **Edge cases:**
  - Damage expressions with `@` scale tokens: show the raw expression, no average.
  - Unknown/unparseable dice: show raw expression only.
  - Special with empty description and no `effectTemplate`: name + resolver notice.
  - Buff with zero bonuses: show description + duration.
  - Item heal uses `amount`; skill heal uses `heal`; missing values fall back exactly as resolution does.
  - Target already at 0 HP/defeated: no target hint; target list excludes it via existing options.
  - Locked/unlocked base prompt override still receives the injected trigger block exactly once.
  - Hovering during `busy` or after a render does not leave a stale hint.
- **Rollback:** each step is independently revertible; A1/A2/A3 and B1/B2/B3/B4 do not share commits. Reverting A2 alone restores the broad trigger wording but leaves the setting inert; reverting A3 alone leaves prompt-only steering.

## Notes for the implementer
- Do not call `resolveAttack()` for previews — it mutates state, consumes actions, and logs. Use the exported bonus/AC/expression helpers only.
- `getSourceAttackBonus` and `scaledSourceExpression` must be exported verbatim; do not copy their logic into the preview module.
- Traditional’s `grid: null` means `getAreaTargets` is unavailable there; per-target predictions come from the legal target list only.
- Keep the preview text short enough for the existing hint bar; put the full description in the panel and only the summary in target labels/hints.
