# Lewd Combat — A Secondary Multi-Partner Pleasure-Contest Combat Style

## Meta
- **Slug:** lewd-combat-style
- **Status:** in progress — U8 complete; next: U9 (U1/Step 1 `1d4767e`, U2/Step 2 `010d4c9`, U3/Step 3 `7a83799`, U4/Step 4 `f064405`, U5/Step 5 `88c539e`, U6/Steps 6+7 `30463df`, U7/Steps 8+9 `ff1a7f1`, U8/Step 10 `8a3d05f` + Step 11 `051a8a7`)
- **Date:** 2026-11-14

## Summary
- **Goal:** Add an optional, deterministic, consent-aware combat style in which participants compete through sexual technique. Each character has a **Stamina** pool that is drained by **climaxes**; at 0 Stamina the character loses and is left at the mercy of their partner(s). The engine decides rolls, Arousal, Stamina loss, body-zone sensitivity, holds, stances, pairings, and the winner. The model writes the prose. Player options must balance **taking the lead**, **submitting**, and **outright surrender**, and must respect every character's preferences, sensitivities, and hard limits.
- **Revised scope from user answers:** explicit prose is the default (with less-explicit/darker-theme options); multiple partners are supported and the board resolves who is involved and who is paired with whom; sexual stats live in a new `[LEWD]` memo block for players, NPCs, enemies, and party members; opponents are controlled by an AI under a contract with bounded freedom; unknown techniques are compiled once and cached; prose uses the Main connection; a future `Seduce` bridge into regular combat is explored but not built in this phase.
- **Context:** The framework currently has `combatStyle = narrative | tactical | traditional`. Tactical and traditional share one deterministic HP/AC engine (`src/features/traditional-combat/traditional-combat-engine.js:1-10`). There is no arousal, pleasure, body-part, preference, or sexual-skill concept anywhere. A new deterministic model is required, but the surrounding board storage, pending-narrator handoff, settings drawers, markup shell, and agent connection plumbing can be reused.

## Current State (from exploration)
- **Combat styles are a hardcoded union.** `COMBAT_STYLES = ['narrative','tactical','traditional']`, labels, board maps, pane map, router table, reset keys, and change events are five independent hardcoded lists (`src/features/combat/combat-mode.js:10-33`, `combat-mode-settings.js:39-49`, `combat-ui-router.js:13-17`, `combat-board-reset.js:26-34`). Any new style not added everywhere is silently downgraded.
- **The engine is HP/AC/D&D-shaped.** `normalizeUnitSeed` clamps HP, `applyDamageToUnit` sets `defeated` at HP ≤ 0, `checkEncounterEnd` keys victory on `defeated`/`fled`, and effect primitives are typed `hp|willpower|both` (`tactical-combat-engine.js:871-909, 1720-1727, 2109-2123`; `tactical-combat-effect-template.js:12-23`). There is no resource adapter.
- **Board persistence is per-chat.** `tacticalCombatByChat` / `traditionalCombatByChat` via `tactical-combat-store.js`; `getEncounterForChat` rejects states with no `grid` unless `mode === 'traditional'` (`store.js:61-69`).
- **Outcome handoff is HP-shaped.** `buildOutcomePayload` hard-codes `kind: 'tactical'|'traditional'`; `buildNarrationBlock` only renders tactical/traditional templates and `[TACTICAL_/TRADITIONAL_COMBAT_CONTEXT]` (`tactical-combat-outcome.js:60-76, 167-231`).
- **Prose is only generated at the end.** The board log is deterministic templated text (`addLog`, 40-entry cap); the main narrator writes the aftermath from the queued outcome. There is no per-action prose pass.
- **Skill authoring is prose-driven and lossy.** `[ABILITIES]` entries are parsed by regex and classified by keywords (`tactical-combat-context.js:324-399`; `tactical-combat-classifiers.js`). Words like “hold”, “stance”, “soothe”, and “whenever” can be misclassified as passive/utility, and `normalizeSkill`/`normalizeMechanics` then erase damage (`engine.js:758-764`; `skill-registry.js:154-157`). This path must not be used for sexual techniques.
- **Character fields are unstructured.** Gender/orientation/body/traits live only in generated memo prose; `parseStatSheet` reads `Attr:`, `Saves:`, `Combat:`, `Gear:`, `Traits:`, `Status:`, `Abilities:`, `Spells:` but has no preference model (`context.js:585-695`).
- **Memo blocks are ordered by a hardcoded list.** `BLOCK_ORDER = ['COMBAT','CHARACTER','PARTY','INVENTORY','ABILITIES','SPELLS','XP','TIME','QUESTS']` (`constants.js:1669`); `defaults.js:675` mirrors it. A new `[LEWD]` block must be added there, plus the tracker prompt instructions.
- **Key files:** `combat-mode*.js`, `combat-ui-router.js`, `combat-board-reset.js`, `tactical-combat-engine.js`, `tactical-combat-store.js`, `tactical-combat-outcome.js`, `tactical-combat-context.js`, `tactical-combat-markup.js`, `tactical-combat-ui.js`, `narrative-hooks.js`, `constants.js`, `src/state/defaults.js`, `src/state/settings.js`, `settings.html`.
- **Landmines:** `setCombatStyle` rewrites unknown values to `narrative`; `tacticalCombatEnabled` mirrors only `tactical`; `getEncounterForChat` hydrates through the tactical normalizer; `syncPanes` looks up missing panes silently; `buildOutcomePayload` silently maps unknown `kind` to tactical; `[ABILITIES]` is player-only and limited to 5/8 entries; registry `normalizeSkillRegistryEntry` whitelists fields, so custom keys such as `bodyPart` are dropped; `BLOCK_ORDER` drives render/tab ordering, so a new block appears in the UI and prompt.

## Recommended Design

### 1. Integration shape: what the secondary module looks like
Lewd Combat is an **independent, opt-in module** (`lewdCombatEnabled`, default `false`) with its own board, tool, memo block, and outcome `kind: 'lewd'`. It is **not** added to `COMBAT_STYLES`, so the primary style selector is unchanged and ordinary hostile `[COMBAT]` fights keep using tactical/traditional.

What the user sees when the module is enabled:
- **Combat settings:** a new “Lewd Combat (secondary)” drawer at the bottom of the Combat tab. It contains the enable toggle, theme/explicitness, difficulty, prose frequency, limits/consent defaults, round cap, technique compendium, prompts, and agent connection. It does not replace the style selector or panes.
- **Header/router:** the existing combat button opens the active lewd board if one is running in the current chat; otherwise it opens the primary style board. While a lewd board is active, its icon switches to a heart/flame badge.
- **Board panel:** a dedicated no-grid panel, visually in the same family as the traditional board but with `rt-lc-*` classes:
  - **Participant rail:** cards for every participant (active or spectator) with Stamina pips (`●●○○`), Arousal meter, Poise bar, stance chips, hold chips, role, and a “limits respected” badge.
  - **Pairing matrix:** a compact grid showing who is engaged with whom, the active hold/stance between each pair, and who is currently “with” whom. This is the answer to “who is involved and who is with whom”.
  - **Action composer:** posture selector (Lead / Follow / Switch / Surrender), technique list grouped by category, body-zone picker, target picker (multi-select for group/pair techniques), and a live preview of the exact accuracy/arousal/poise tradeoff.
  - **Log and prose:** a structured beat log on one side and the latest prose narration on the other, with a debug drawer for the raw beat sheet.
  - **Controls:** Start, Join/Leave (for multi-partner scenes), Surrender, Safe Word / Stop, Reset.
- **Start dialog:** choose participants from names detected in the scene/`[LEWD]`/`[PARTY]`/`[COMBAT]`, mark each as active or spectator, choose the encounter shape (`duel`, `group`, `free-for-all`), and set the scene tone.
- **Persistence:** the board lives in `lewdCombatByChat[chatId]`; it never touches `[COMBAT]`, HP, or Willpower. The `[LEWD]` block is the source of profiles; the board writes only its own state and optional outcome deltas.
- **Narrator:** `StartLewdCombat` tool and a `<lewd_combat>` sysprompt section; while the board is active, a `[LEWD_COMBAT_OVERRIDE]` prevents the narrator from resolving the scene itself. At the end, a `[LEWD_COMBAT_CONTEXT]` block hands the authoritative outcome back to the main narrator.

Why not a fourth `combatStyle`: selecting `lewd` would remove the tactical/traditional board for ordinary fights, and the legacy `tacticalCombatEnabled` mirror plus the style guard would need invasive changes. The secondary module gives the same feature while remaining compatible. If selector integration is later desired, it can be added as a separate step without changing the engine.

### 2. Core loop and resources
Each participant has:
- **Stamina** `0..maxStamina` — the losing pool. Each **climax** drains 1 (some finishers may drain 2). At 0 the character is **at mercy**: out of the action queue, unable to act, and the partner(s) decide the aftermath. This is the primary loss condition.
- **Arousal** `0..maxArousal` — the per-climax threshold. When full, the character **climaxes**: Stamina −1 (or −2 for a finisher), Arousal resets to 0, and `overstimulated` is applied for one round (−2 Poise, +1 sensitivity).
- **Poise** `0..maxPoise` — current self-control/defense. Pleasure checks compare against Poise. At 0 the character is **overwhelmed** (Arousal gains ×1.5, finishers unlock) until the end of the next turn; Poise then refreshes to half. Poise is not a loss condition; it is the guard that makes a climax harder to reach.
- **Profile** — role (`dominant`/`submissive`/`switch`), orientation, body-zone sensitivities, likes/dislikes, hard limits, endurance, experience.
- **Stance** — self state (`commanding`, `yielding`, `entwined`, `guarded`, `teasing`, `devoted`).
- **Holds/engagements** — per-pair edges (`grappled`, `pinned`, `straddled`, `embraced`, `restrained`, `carried`) and `engagedWith[]` links.

Default derivation:
- `maxStamina = 2 + enduranceBonus + traitStaminaBonus` (clamped 1–6); Stamina starts full.
- `maxArousal = 10 + level/2 + CON modifier + traitArousalBonus` (clamped 8–30).
- `maxPoise = 6 + WIS modifier + CHA modifier + traitPoiseBonus` (clamped 4–16); Poise starts full.
- `accuracy = CHA modifier + proficiency + technique.accuracy`.
- `poiseDefense = poise + stance.poiseBonus + hold.poiseBonus`.
- **Traits can modify the model.** A profile may carry traits such as `stamina+1`, `drain-1` (reduces the Stamina cost of a climax, minimum 1), `maxArousal+2`, `poise+1`, `sensitivity:neck+1`, or `endurance+1`. Traits are applied after base derivation and before clamping, are deterministic, and are shown in the participant tooltip. Unknown traits are ignored with a debug warning.

Exchange loop:
1. Initiative once (`1d20 + poiseBonus`); ties broken by seeded RNG. Player side acts first unless surprised.
2. The active participant chooses **posture** (Lead / Follow / Switch), **technique**, **target(s)**, and **body zone(s)** where the technique allows a choice.
3. The engine validates legality (stance/hold requirements, zone, uses, hard limits), rolls the check, applies Arousal/Poise/Stamina/state changes, logs a structured **beat**, and checks end conditions.
4. The opponent AI chooses its action from the legal contract; the engine resolves it with the same deterministic math and records the chosen action for replay.
5. Repeat until one side is out of Stamina, surrenders, stops, or the round cap is reached.

End conditions:
- A participant at `stamina === 0` → `atMercy` (out).
- `Surrender` action → `surrendered` (out; no further actions; partner decides the aftermath; a surrendered character cannot re-enter this encounter).
- Safe word / Stop → `stopped` (no winner, immediate).
- Round cap (default 12) → `draw`.
- In a duel, the first participant out loses; in a group, the last active participant/side with Stamina > 0 wins. A `mutual` double-climax that drains both to 0 is a draw or a shared outcome (configurable).

### 3. Lead, submit, surrender, and submissive options
Postures:

| Posture | Accuracy | Arousal dealt | Poise defense | Poise regen | Unlocks |
|---|---|---|---|---|---|
| **Lead** | +2 | +1 | −2 | 0 | holds, commands, finishers |
| **Follow** | −1 | −1 | +2 | +2 | counters, escapes, invitations, submissive techniques |
| **Switch** | 0 | 0 | 0 | +1 | stance change, adapt |

- **Submit is not the same as Surrender.** “Submit” is a *posture* (Follow) with its own techniques and comeback resources. “Surrender” is a hard action that removes the character from the contest and hands the outcome to the partner(s).
- **Submissive techniques** are real options, not a forfeit: `Offer` (invite a technique; gain Poise/Devotion), `Bare` (expose a zone; next incoming Arousal is halved but the partner gains accuracy), `Beg` (boost partner’s Arousal dealt, restore own Poise), `Endure` (convert incoming Arousal into Poise once), `Devote` (sacrifice own next action to grant a partner a bonus). They let a submissive character win by baiting, enduring, and countering a lead.
- **Surrender** is always available from the action composer; it sets `surrendered: true`, removes the character from the queue, and lets the partner(s) choose `finish`, `spare`, `aftercare`, or `claim`. The narrator receives a neutral authoritative outcome.
- The UI shows the exact numeric tradeoff of each posture before the player commits, so “lead vs submit” is an informed choice rather than a flavor toggle.

### 4. Body zones and preferences
Shipped zone set (configurable): `lips`, `neck`, `ears`, `chest`, `breasts`, `nipples`, `back`, `waist`, `hips`, `groin`, `thighs`, `hands`, `feet`, `full_body`.

Default sensitivity multipliers (examples): lips 1.0, neck 1.3, ears 1.2, chest 0.9, breasts 1.3, nipples 1.6, back 0.8, waist 1.0, hips 1.2, groin 1.8, thighs 1.2, hands 0.9, feet 0.7, full_body 1.0.

Profile modifiers (deterministic):
- `like` → ×1.25; `neutral` → ×1.0; `dislike` → ×0.5; `hard_limit` → technique is illegal and the UI shows “blocked by limit”.
- `role` match: acting within role gives +1 accuracy; acting against role gives −1 (configurable).
- `experience` gives a flat accuracy/Poise bonus; `endurance` raises `maxStamina`; `sensitivity` raises/lowers zone multipliers.
- Unknown profile → neutral defaults derived from stats, with a visible “profile inferred” badge. Never silently invent a hard limit.

### 5. Stances, holds, and techniques
Technique categories:
- **stance** — applies a self stance; no direct Arousal.
- **hold** — applies/refreshes a hold on a target; check vs Poise; hold grants accuracy/zone access and an escape DC.
- **technique** — direct pleasure to one or more zones; the bread and butter.
- **counter** — only while Following, pinned, or guarded; converts incoming pleasure into Poise or reverses a hold.
- **finisher** — requires `overwhelmed`, a specific hold, or high Arousal; high Arousal/Stamina drain, high risk, may cost Poise.
- **tease** — low direct Arousal, applies statuses (`flushed`, `sensitive`, `frustrated`) that modify later exchanges.
- **command** — Lead-only; boosts the next technique or forces a target reaction.
- **recover** — restores Poise or reduces own Arousal; only when not held or when the opponent allows it.
- **submit** — the submissive family above (`offer`, `bare`, `beg`, `endure`, `devote`).

Holds gate techniques and zones. Escape is a deterministic check (`d20 + poiseBonus + escapeBonus` vs hold DC) or a counter with `escape: true`. Stances expire on posture change, after 3 rounds, or when overwhelmed.

### 6. Multiple partners: who is involved and who is with whom
- **Participants:** the encounter stores `participants[]` with `id`, `name`, `side`, `active`/`spectator`, `stamina`, `maxStamina`, `arousal`, `maxArousal`, `poise`, `maxPoise`, `profile`, `stance`, `status`, and `engagedWith[]`.
- **Pairings:** an `engagement` edge is created when a participant targets another with a hold, a stance pair, or a “with” action. Each edge records `{a, b, hold, stance, sinceRound, intensity}`. Edges expire after one round without refresh. The board’s pairing matrix renders these edges directly.
- **Targeting:** techniques declare `targetMode: 'single' | 'pair' | 'group' | 'aura'`. `pair` affects the actor and one target; `group` affects all active participants in a chosen group (e.g. everyone engaged with the actor); `aura` affects all engaged participants. Multi-target resolution loops over targets with each target’s own sensitivity/preference/limits; a single hard limit can exclude that target without cancelling the whole action.
- **Who is involved:** the start dialog and `StartLewdCombat` accept `participantNames` and mark each as `active` or `spectator`. The context builder also auto-detects named characters from the scene/`[LEWD]`/`[PARTY]`/`[COMBAT]`. A participant can **Join** mid-encounter if the group allows it (`maxPartners`, default 2; configurable to 1 for strict duels).
- **Turn order:** every active participant gets one action per round. A spectator can Join at the start of a round. `atMercy` and `surrendered` participants are skipped; a surrendered participant cannot re-enter this encounter (a new encounter is required).
- **Group end:** in a `group` scene, a side is out when all its active participants are `atMercy`/`surrendered`; in a `free-for-all`, the last participant with Stamina > 0 wins.
- **Pairing UI:** the matrix has one row/column per participant; cells show the active hold/stance and the current Arousal/Poise pressure. Clicking a cell focuses that pair for the action composer.

### 7. Opponent AI contract and bounded freedom
The opponent is AI-controlled like tactical/traditional, but under a strict contract:
- **Input:** the legal action list from `listLegalActions(state, unit)` (technique id, target ids, zones, posture, expected check/effect ranges), the unit’s visible state, known profiles (only what that character could reasonably know), recent action history, and the encounter tone.
- **Output:** `{"actions":[{"type":"technique","unitId":"...","techniqueId":"...","targetIds":["..."],"zone":"neck","posture":"lead","intent":"short flavor reason"}]}`. It may also choose `{"type":"surrender"}`, `{"type":"join"}`, or `{"type":"wait"}` when legal.
- **Hard rules:** it may only use ids and techniques from the legal list; it may never invent numbers, targets, body zones, or outcomes. The engine rejects illegal actions and falls back to the deterministic local policy (`chooseOpponentAction`).
- **Bounded freedom:**
  - The prompt includes a `variety` instruction and recent actions; the policy applies a small repetition penalty so the AI does not spam the same technique.
  - The AI may attach a non-mechanical `flavor` string (a taunt, a provocation, a line of dialogue) that the prose pass can use. It cannot change the beat.
  - Optional `improvisation`: the AI may propose a **novel technique** by name/description; the engine sends it to the one-time compiler (Step 5), caches the canonical result, and only then uses it. If compilation fails or the technique is illegal, the action is rejected and the local policy runs.
  - A per-character `style`/`personality` weight table biases the AI toward certain categories (e.g. teasing vs. dominant), so different opponents feel different without changing the math.
- **Determinism:** resolution is deterministic given the chosen action and seed. The AI’s *choice* is recorded in `state.actionLog` for replay/audit; tests inject a fixed action list. The local fallback is fully deterministic.

### 8. Prose generation: how and when (with example)
Prose is a **non-authoritative pass** that uses the **Main connection** (not the combat agent connection). It never changes state.

After an exchange, the engine emits a compact beat sheet:
```json
{
  "round": 2,
  "actor": "Aria",
  "posture": "lead",
  "technique": "Neck Kiss",
  "targets": [
    { "name": "Bran", "zone": "neck", "check": 18, "defense": 15, "hit": true,
      "arousalDelta": 6, "poiseDelta": 2, "status": ["Flushed (2 rounds)"] }
  ],
  "stateChanges": ["Bran: Poise 4/8", "Aria: engaged with Bran (lead)"],
  "tone": "explicit",
  "limits": ["no breath play", "no marking"],
  "voices": { "Aria": "teasing but attentive", "Bran": "guarded, easily flustered" }
}
```
The prose prompt receives the beat sheet plus a short scene excerpt and returns 2–4 sentences, for example:
> Aria cups Bran’s jaw and draws a slow line of kisses down the side of his neck. He tilts into it before he can stop himself, breath catching; the flush climbing his throat makes the next round harder to hide.

Timing and failure:
- **Default `per-exchange`:** run immediately after the action resolves, from the UI action handler. If `narratorPipelineBusy()` is true, queue the beat and run it after `GENERATION_ENDED`; until then show the deterministic templated beat text.
- **`per-round`:** batch every exchange in the round into one prose call at the end of the round.
- **`climax-only`:** call only when a participant climaxes or the encounter ends.
- **`off`:** use the templated beat text only.
- **Failure/timeout:** fall back to the templated text with a non-blocking warning; never block the board.
- **Never inside a narrator generation.** The prose pass is separate from the main generation; it uses the same deferred/background discipline as the existing combat agent.
- **End handoff:** the final prose plus the authoritative outcome is injected into the main narrator as `[LEWD_COMBAT_CONTEXT]`, so the story continues without replaying the scene.

### 9. The `[LEWD]` memo block
Add a new optional memo block for players, NPCs, enemies, and party members:

```
[LEWD]
- Aria: role=switch | stamina=4/4 | sensitivity=neck:high, groin:medium, ears:low | likes=praise, teasing | dislikes=pain | limits=breath play, marking | endurance=+1 | experience=2 | traits=stamina+1, drain-1
- Bran: role=dominant | stamina=3/3 | sensitivity=neck:medium, chest:low | likes=being guided | dislikes=humiliation | limits=none declared | endurance=+0 | experience=1 | traits=poise+1
[/LEWD]
```

- **One entry per named character**, keyed by name. It can include players, NPCs, enemies, and party members.
- **Only injected when `lewdCombatEnabled` is true** to avoid token bloat and to keep ordinary play unchanged.
- **Parsed by** `lewd-combat-profile.js`; missing entries fall back to inferred neutral profiles with an `inferred` badge.
- **Traits:** optional `traits=` entries modify derived stats (`stamina+1`, `drain-1`, `maxArousal+2`, `poise+1`, `sensitivity:neck+1`, `endurance+1`) and are applied deterministically after the base formulas.
- **Written by** the State Tracker/module prompt: add a `LEWD` module instruction (“maintain a `[LEWD]` entry for every named participant when Lewd Combat is enabled; update only when a profile genuinely changes”).
- **Block order:** add `LEWD` to `BLOCK_ORDER` (`constants.js:1669`) and `defaults.js:675`, and to `NO_PAGINATE` if the block should not paginate. The block is optional; an absent block is valid.
- **Privacy:** the block is sent to the model while the module is enabled. The settings pane should say so explicitly. A “profiles only during lewd encounters” option can be added later.

### 10. How sexual skills should be made
Do **not** route sexual skills through `[ABILITIES]` prose classification. The existing classifier is keyword-driven, lossy, and has hard caps; sexual phrasing (“hold”, “stance”, “upon entry”, “each thrust”, “soothe”) will be misclassified or have its mechanics stripped.

Recommended two-tier authoring:

**Tier A — shipped catalog (code data).** A curated `LEWD_TECHNIQUES` array in `lewd-combat-techniques.js`, covering every category. Stable definitions with explicit numbers. Users can disable individual entries but not edit the shipped baseline.

**Tier B — user compendium (JSON).** `lewdCombatTechniqueCompendiumJson`, same precedent as `tacticalCombatSpellCompendiumJson`. Users can add homebrew techniques and override shipped entries by `id`. Invalid JSON falls back to the shipped catalog with a visible status.

Canonical technique shape:
```json
{
  "id": "neck-kiss",
  "name": "Neck Kiss",
  "category": "technique",
  "description": "Soft, deliberate attention to the neck.",
  "posture": "either",
  "zones": ["neck"],
  "targetMode": "single",
  "tags": ["teasing", "praise"],
  "check": { "stat": "cha", "accuracy": 2 },
  "arousal": "1d6+2",
  "poise": "1d4",
  "requires": { "hold": null, "stance": null, "overwhelmed": false },
  "applies": { "status": { "label": "Flushed", "rounds": 2, "arousalBonus": 1 } },
  "uses": { "max": null, "recharge": "at-will" },
  "ai": { "priority": 2, "conditions": ["targetSensitive:neck"] }
}
```

Optional convenience block for narrative-authored techniques (strict, one line each; no freeform prose):
```
[LEWD_TECHNIQUES]
- Neck Kiss | technique | either | zones: neck | tags: teasing, praise | arousal: 1d6+2 | poise: 1d4 | at-will
- Firm Grip | hold | lead | zones: waist, hips | tags: dominance | check: str | hold: grappled | dc: 12
[/LEWD_TECHNIQUES]
```
The block parses into the same canonical shape. Unknown names are **compiled once and cached** (user answer 7): a one-time compiler agent turns the name/description into the canonical schema, validates it, and stores it in the compendium/registry. Later uses never re-resolve. If compilation fails or the technique is illegal, the action is rejected with a visible reason.

Do **not** extend `effectTemplate` with `bodyPart`, `arousal`, or `pleasure` fields. `normalizeEffectPrimitive` drops unknown fields and `normalizeSkillRegistryEntry` whitelists entry keys (`tactical-combat-effect-template.js:95-203`; `skill-registry.js`). A separate technique schema avoids silent data loss.

### 11. Consent, explicitness, and safety rails
- **Opt-in only.** `lewdCombatEnabled: false` by default; a warning in the settings pane.
- **Explicit by default once enabled**, with settings for:
  - **Explicitness:** `explicit` (default), `suggestive`, `fade-to-black`.
  - **Themes:** a light/dark tone toggle; darker themes are opt-in and still bounded by hard limits.
  - **Prose instructions:** the prose prompt receives the explicitness/theme and must obey it.
- **Per-character hard limits.** Techniques are blocked if their tags intersect a participant's hard limits. The UI explains which limit blocked the action.
- **Safe word / Stop.** Ends the encounter with `outcome: 'stopped'` and no winner; the narrator receives a neutral aftermath.
- **Surrender.** A separate hard yield; the partner decides the aftermath, still bounded by limits.
- **No model-driven escalation.** The prose prompt is subordinate to the beat sheet and the limits; it may not add acts, participants, or outcomes the engine did not produce.

### 12. Optional integration with regular combat (exploration only)
The user asked how a `Seduce` action could make sex occur during regular combat. This is a **design exploration**, not part of the core build:
- Add an optional `seduce` action to the tactical/traditional action catalog. It is only legal against a target whose `[LEWD]` profile exists and who is not a hard-limit mismatch.
- On use, the primary board pauses the target’s turn (or applies `distracted`/`flushed`), and opens a **sub-encounter** with just the actor and target (or the engaged group). The lewd engine resolves; the result returns to the primary board as statuses/outcome, not as HP damage.
- The primary board remains authoritative for the fight; the lewd sub-encounter cannot kill or remove a combatant unless the table opts in. This keeps the two systems composable without making regular combat unplayable.
- Risks: turn-order interruption, two active boards, consent gating, and outcome writeback. This is why it is a later spike, not Step 1.

## Constraints & Requirements
- **Tech stack:** plain ES modules, Vitest (`npx vitest run --pool=threads`; threads pool required on this fork), SillyTavern extension globals, no typecheck/lint scripts in `package.json`.
- **No nested provider requests inside narrator generations.** All agent calls (opponent AI, prose pass, technique compiler) must follow the existing deferred/background pattern and the `narratorPipelineBusy()` guard.
- **Determinism:** seeded RNG; no `Math.random` in the lewd engine; persisted `seed`/`rollCount`; the AI action list is recorded so a replay with the same actions produces the same results.
- **Isolation:** the module must not mutate `[COMBAT]`, HP, Willpower, spell slots, or the tactical/traditional boards. It may read memo entities and write only `[LEWD]` profiles (on request), its own board, and optional relationship/affinity deltas.
- **Existing behavior:** tactical and traditional boards, prompts, outcomes, and tests must remain unchanged when `lewdCombatEnabled` is false.
- **Out of scope for this phase:** 3D/positional lewd grid, multiplayer networking, animated scenes, automatic relationship-tier rewrites, non-consensual content, full game-system-specific kink rulesets.

## Assumptions & Decisions (all questions resolved)
Approved by the user in this session:
- Lewd Combat is a **secondary opt-in module**, not a fourth `combatStyle`.
- Explicit prose is the default once enabled; less-explicit and darker-theme options exist.
- Multiple partners are supported; the board resolves who is involved and who is paired with whom.
- A new `[LEWD]` block holds per-character sexual stats for players, NPCs, enemies, and party members.
- Stamina is drained by climaxes; at 0 the character loses and is at the mercy of their partner(s). Submit is a posture; Surrender is a hard yield; submissive techniques exist.
- Prose uses the Main connection.
- Unknown techniques are compiled once and cached.
- Opponents are AI-controlled under a contract with bounded freedom, with a deterministic local fallback.
- Regular-combat integration (`Seduce`) is a later exploration, not core.
- The system uses d20 and the label “Lewd Combat”.

Final decisions (confirmed this session):
1. **Submit vs Surrender:** Follow posture + submissive techniques are confirmed; `Surrender` is the separate hard yield.
2. **Multi-partner:** max 2 concurrent partners by default; `duel`, `group`, and `free-for-all` are all in scope.
3. **Stamina:** `2 + endurance` (clamped 1–6); finishers may drain 2; profile traits can modify max Stamina, drain, Arousal, Poise, and sensitivity.
4. **Climax reset:** Arousal resets to 0 and applies `overstimulated` for one round.
5. **Surrender aftermath:** a surrendered character cannot re-enter the same encounter; the partner/table decides the aftermath.
6. **Explicitness:** `explicit` is the default; `suggestive`, `fade-to-black`, and a darker-themes toggle are confirmed.
7. **`[LEWD]` injection:** always injected while the module is enabled.
8. **AI freedom:** novel-technique proposals are allowed, compiled once and cached; the engine still owns all math.
9. **Prose:** `per-exchange` is the default, using the Main connection.

Remaining assumptions:
- The first release targets 1–4 active participants; the pairing model is extensible but the UI is optimized for small groups.
- The `[LEWD]` block is optional at the memo level; absent profiles are inferred and visibly marked.
- `Seduce` remains a later design spike, not part of the core build.

**Approval requested:** confirm the plan can move from `draft` to `approved` and begin with Step 1.

## Step-by-Step Implementation Plan

> Builder-agent packaging: the 13 review-sized steps below are grouped into nine build units (U1–U9) in the “Builder Handoff” section at the end of this plan. Steps 6+7, 8+9, 10+11, and 12+13 are grouped because they share a demoable checkpoint or a single integration owner.

### 1. Module scaffold, settings, and secondary-board routing
- **Status:** ✅ Done — `1d4767e` (feat(lewd-combat): scaffold secondary board, settings toggle, and per-chat store)
- **Files:** new `src/features/lewd-combat/lewd-combat-constants.js`, `src/features/lewd-combat/lewd-combat-store.js`; modify `src/features/combat/combat-mode.js`, `src/features/combat/combat-ui-router.js`, `src/features/combat/combat-board-reset.js`, `src/features/combat/combat-mode-settings.js`, `src/state/defaults.js`, `src/state/settings.js`, `index.js`, `settings.html`, `style.css`, `tests/combat-board-reset.test.js`.
- **Depends on:** none
- **Parallelizable:** no (integration spine)
- **Expected behavior:**
  - Add `lewdCombatEnabled: false`, `lewdCombatByChat: {}`, and module settings keys to defaults; add them to `CHAT_STATE_GLOBAL_UI_KEYS`.
  - Add a `lewd` entry to `COMBAT_BOARD_MAPS` (key `lewdCombatByChat`) and `COMBAT_STYLE_LABELS.lewd = 'Lewd'` so the open-encounter list can name it. Do not add `lewd` to `COMBAT_STYLES`.
  - Add the “Lewd Combat (secondary)” settings drawer with enable/open controls; it is never shown by `syncPanes` and never replaces the primary style pane.
  - Header router: open the active lewd board if present; otherwise the primary style board. Show a heart/flame icon while a lewd board is active.
  - `combat-board-reset` clears `lewdCombatByChat` and dispatches `rt_lewd_combat_changed`; update the “cleared == 2” test to 3.
  - `lewd-combat-store.js` provides its own `getLewdEncounterForChat`/`set...`/`remove...`; do not route through `getEncounterForChat`.
- **Acceptance criteria:** module off = byte-for-byte existing behavior; on = board opens from header/settings; primary style selector unchanged; a lewd board in another chat blocks a style switch and appears in the open-encounter list; clearing removes a running board and keeps finished boards.
- **Risk:** medium
- **Model / Effort:** implementer model #medium
- **Commit:** `feat(lewd-combat): scaffold secondary board, settings toggle, and per-chat store`

### 2. `[LEWD]` block schema and profile parser
- **Status:** ✅ Done — `010d4c9` (feat(lewd-combat): add LEWD block schema and profile parser)
- **Files:** new `src/features/lewd-combat/lewd-combat-profile.js`; modify `constants.js` (`BLOCK_ORDER`, `NO_PAGINATE`), `src/state/defaults.js` (`blockOrder`, stock prompt/module text), `src/state/module-instructions.js` (LEWD module instruction), `src/state/schema-sections.js` (optional `sec_desires`); tests `tests/lewd-combat-profile.test.js`.
- **Depends on:** Step 1
- **Parallelizable:** yes (with Step 3 once the schema is frozen)
- **Expected behavior:**
  - Define the `[LEWD]` block format (`Name: role=... | stamina=... | sensitivity=... | likes=... | dislikes=... | limits=... | endurance=... | experience=...`).
  - Parse one entry per named character from `[LEWD]`; also accept inline `Lewd:`/`Desires:`/`Sensitive:`/`Limits:` lines as a fallback.
  - Normalize to a canonical profile: `role`, `orientation`, `stamina/maxStamina`, `sensitivity` map, `preference` map, `limits[]`, `endurance`, `experience`, `traits`, `notes`, `source`, `inferred`.
  - Parse `traits=` into a typed modifier map (`stamina`, `drain`, `maxArousal`, `poise`, `sensitivity:<zone>`, `endurance`) with numeric deltas; apply them after base derivation and before clamping.
  - `inferProfile(unit, settings)` when absent: neutral defaults from CHA/WIS/CON and level; mark `inferred: true`.
  - Pure helpers: `zoneMultiplier`, `preferenceMultiplier`, `isBlockedByLimits`, `maxStaminaFromProfile`, `applyProfileTraits`.
  - Add the tracker prompt instruction: “When Lewd Combat is enabled, maintain a `[LEWD]` entry for every named participant; update only on genuine change.”
- **Acceptance criteria:** parses all fields and synonyms; missing entry → inferred neutral; limits block; likes/dislikes/sensitivity apply; `traits=stamina+1, drain-1, sensitivity:neck+1` modifies derived stats exactly once; unknown zones/tags/traits ignored with a warning; block order and prompt tests updated.
- **Risk:** medium (touches the memo block order and tracker prompt)
- **Model / Effort:** implementer model #medium
- **Commit:** `feat(lewd-combat): add LEWD block schema and profile parser`

### 3. Deterministic engine core (Stamina, Arousal, Poise, climax)
- **Status:** ✅ Done — `7a83799` (feat(lewd-combat): deterministic stamina/arousal/poise engine)
- **Files:** new `src/features/lewd-combat/lewd-combat-engine.js`; tests `tests/lewd-combat-engine.test.js`.
- **Depends on:** Step 2
- **Parallelizable:** no
- **Expected behavior:**
  - `createLewdEncounterState({participants, seed, settings, mode})` normalizes participants, applies profile traits to derived Stamina/Arousal/Poise, rolls initiative, sets `round=1`, `status='active'`, `log=[]`, and initializes pools.
  - `applyLewdAction(state, action, options)` resolves one exchange: posture, technique, target(s), zone(s); validates requirements/limits/uses; rolls `d20 + accuracy + posture + role` vs `poise + stance/hold defense`; applies Arousal/Poise/Stamina/state changes; consumes uses; logs a structured beat; calls `checkLewdEncounterEnd`.
  - `resolveLewdOpponentTurn(state)` applies the provided AI action list or the deterministic local policy.
  - `climaxParticipant(state, unit, options)`: Stamina −(1 + finisher extra), reduced by the profile’s `drain` trait but never below 1; Arousal reset to 0; `overstimulated` for one round; if Stamina 0 → `atMercy`.
  - `surrenderParticipant(state, unit)`: marks `surrendered`, removes the unit from the queue, and **blocks re-entry** into this encounter; `joinParticipant`/`setSpectator` must reject a surrendered unit.
  - `checkLewdEncounterEnd` sets `outcome` (`atMercy`/`surrendered`/`stopped`/`draw`/`mutual`/`sideVictory`), `status='ended'`, and a summary.
  - `hydrateLewdState`/`serializeLewdState` preserve seed, rollCount, profiles, stances, holds, engagements, and the action log.
  - All random rolls use the injected seeded RNG.
- **Acceptance criteria:** same state + action + seed = identical results; Stamina drops only on climax; a finisher can drain 2; a `drain-1` trait reduces the cost but never below 1; 0 Stamina = atMercy; Arousal clamps and resets to 0 on climax; Poise clamps; Lead/Follow/Switch modifiers apply; zone/preference/trait multipliers apply; surrendered characters are skipped and cannot re-enter; no model call during resolution.
- **Risk:** high (new core math)
- **Model / Effort:** implementer model #high
- **Commit:** `feat(lewd-combat): deterministic stamina/arousal/poise engine`

### 4. Multi-partner pairings, stances, holds, and technique catalog
- **Status:** ✅ Done — `f064405` (feat(lewd-combat): multi-partner pairings, stances, holds, and technique catalog)
- **Files:** new `src/features/lewd-combat/lewd-combat-techniques.js`, `src/features/lewd-combat/lewd-combat-states.js`, `src/features/lewd-combat/lewd-combat-pairing.js`; tests `tests/lewd-combat-techniques.test.js`, `tests/lewd-combat-pairing.test.js`.
- **Depends on:** Step 3
- **Parallelizable:** yes (with Step 5 once the schema is frozen)
- **Expected behavior:**
  - Ship 25–35 techniques covering stance/hold/technique/counter/finisher/tease/command/recover/submit, with `zones`, `targetMode`, `tags`, `check`, `arousal`, `poise`, `staminaDrain`, `requires`, `applies`, `uses`, `ai`.
  - Pairing model: create/refresh/expire engagement edges; per-pair holds; `maxPartners` (default 2); `targetMode` resolution; `engagedWith`; spectator/join/leave.
  - State machine: apply/replace/expire stances; apply hold with `escapeDC`; escape checks; hold-gated zones/techniques; `overwhelmed` duration.
  - `listLegalActions(state, unit)` returns techniques with disabled reasons (requirement, zone, uses, limit, target count).
  - `chooseOpponentAction(state, unit)` implements the local deterministic policy with seeded tie-break and repetition penalty.
- **Acceptance criteria:** holds gate the correct techniques and unlock the correct follow-ups; escape works; stances expire; pairing matrix data matches engine edges; `listLegalActions` never returns an illegal action; opponent fallback never picks a blocked-by-limit or out-of-requirement action; multi-target techniques apply per-target preferences and exclude a target whose limits block it.
- **Risk:** medium-high
- **Model / Effort:** implementer model #high
- **Commit:** `feat(lewd-combat): multi-partner pairings, stances, holds, and technique catalog`

### 5. User technique compendium and compile-once cache
- **Status:** ✅ Done — `88c539e` (feat(lewd-combat): user technique compendium and compile-once cache)
- **Files:** new `src/features/lewd-combat/lewd-combat-compendium.js`, `src/features/lewd-combat/lewd-combat-compiler.js`; modify `src/state/defaults.js`, `src/state/settings.js`, `settings.html`; tests `tests/lewd-combat-compendium.test.js`.
- **Depends on:** Step 4
- **Parallelizable:** yes (with Step 6 if the schema is frozen)
- **Expected behavior:**
  - Add `lewdCombatTechniqueCompendiumJson` (default empty) and a settings textarea with validation status/reset.
  - Merge order: shipped catalog → user JSON overrides by `id` → `[LEWD_TECHNIQUES]` block entries.
  - Strict validation: unknown category/zone/check/requirement/targetMode → drop the entry with a visible diagnostic; invalid JSON → shipped catalog + status.
  - Unknown techniques named by the user or the opponent AI are sent to a **one-time compiler agent** (`lewdCombatCompilerPrompt`), validated into the canonical schema, and cached in the compendium/registry. Later uses never re-resolve.
  - Compiler failures are visible and do not block the board; the action is rejected and the local policy runs.
- **Acceptance criteria:** valid user entry overrides a shipped entry; invalid JSON falls back with a message; invalid entries are dropped individually; `[LEWD_TECHNIQUES]` lines parse to the same shape; a novel technique compiles once and is reused; no re-compilation on second use; no sexual technique goes through `[ABILITIES]`/`classifySkillIntent`.
- **Risk:** medium-high (new compiler call path)
- **Model / Effort:** implementer model #high
- **Commit:** `feat(lewd-combat): user technique compendium and compile-once cache`

### 6. Context builder, participant resolution, and start flow
- **Status:** ✅ Done — `30463df` (U6 combined commit: feat(lewd-combat): participant resolution and multi-partner board UI)
- **Files:** new `src/features/lewd-combat/lewd-combat-context.js`, `src/features/lewd-combat/lewd-combat-ui.js` (start/stop/reset/join portion); tests `tests/lewd-combat-context.test.js`.
- **Depends on:** Steps 2, 4
- **Parallelizable:** no
- **Expected behavior:**
  - Build participants by reusing `collectEncounterContext` / `parsePlayerUnits` / `parseCombatUnits` for names/stats, then attach `lewdProfile` from `[LEWD]`/inline lines.
  - Accept `participantNames` and `spectatorNames`; auto-detect named characters from the scene/`[LEWD]`/`[PARTY]`/`[COMBAT]`; mark active vs spectator.
  - Support `duel`, `group`, and `free-for-all`; resolve who starts engaged with whom from the selected participants and the opening action.
  - Optional one-time profile compiler for a named partner with no profile (agent call outside narrator generation; cache in the board).
  - Seed an optional opening exchange from `openingTechnique`/`openingZone`.
  - Persist to `lewdCombatByChat`; do not touch `[COMBAT]`, HP, or Willpower.
- **Acceptance criteria:** start with two or more named participants from `[PARTY]`/`[COMBAT]`/`[LEWD]`; spectators are excluded from turn order; missing profile → inferred badge; no participants → clear error and no board; reload restores participants/pairings; starting a second board in the same chat is blocked with a reason.
- **Risk:** medium
- **Model / Effort:** implementer model #medium
- **Commit:** `feat(lewd-combat): participant resolution and multi-partner start flow`

### 7. Board UI and markup
- **Status:** ✅ Done — `30463df` (U6 combined commit: feat(lewd-combat): participant resolution and multi-partner board UI)
- **Files:** new `src/features/lewd-combat/lewd-combat-markup.js`, `src/features/lewd-combat/lewd-combat-ui.js`, `style.css`; tests `tests/lewd-combat-markup.test.js`.
- **Depends on:** Step 6
- **Parallelizable:** no
- **Expected behavior:**
  - Render participant cards with Stamina pips, Arousal/Poise meters, stance/hold chips, role, limits badge, and `atMercy`/`surrendered` states.
  - Render the pairing matrix (who is involved, who is with whom, active hold/stance per pair).
  - Action composer: posture selector (Lead/Follow/Switch/Surrender), technique list grouped by category, body-zone picker, target picker (single/pair/group), live tradeoff preview, disabled reasons.
  - Prose pane + structured beat log + debug beat-sheet drawer.
  - Controls: Start, Join/Leave (spectator), Surrender, Safe Word/Stop, Reset.
  - Reuse `escapeHtml`, `TC_SIDE_COLORS`, and status formatting where possible; use `rt-lc-*` CSS.
- **Acceptance criteria:** complete an encounter without chat input; illegal actions disabled with reasons; hard-limit actions show “blocked by limit”; posture preview matches engine table; pairing matrix updates after each action; keyboard/ARIA and mobile layout work; no grid dependencies.
- **Risk:** medium-high
- **Model / Effort:** implementer model #high
- **Commit:** `feat(lewd-combat): board UI with stamina, pairing matrix, and action composer`

### 8. Opponent AI contract, local fallback, and bounded freedom
- **Status:** ✅ Done — `ff1a7f1` (U7 combined commit: feat(lewd-combat): AI opponent contract and main-connection prose pass)
- **Files:** new `src/features/lewd-combat/lewd-combat-agent.js`, `src/features/lewd-combat/lewd-combat-prompts.js`; modify `src/features/lewd-combat/lewd-combat-engine.js` (action validation), `src/state/connection-setups.js` (lewd agent connection); tests `tests/lewd-combat-agent.test.js`.
- **Depends on:** Steps 4, 6
- **Parallelizable:** yes (with Step 9)
- **Expected behavior:**
  - Build the opponent payload: legal actions, visible state, known profiles, recent actions, tone, variety instruction.
  - Contract: only legal technique/target/zone/posture ids; optional non-mechanical `intent`/`flavor`; optional `novelTechnique` (compiled once, Step 5); `surrender`/`join`/`wait` only when legal.
  - Validate every AI action; reject illegal actions and run `chooseOpponentAction` as fallback; log the chosen action in `state.actionLog`.
  - Repetition penalty and personality weights for variety.
  - The AI never computes damage/Arousal; the engine does.
- **Acceptance criteria:** AI returning an illegal technique/target falls back deterministically; valid AI action resolves identically to a player action with the same inputs; a novel technique compiles once and is reused; recent-action repetition is penalized; prompt contains the “never invent numbers/targets/outcomes” rule.
- **Risk:** medium-high
- **Model / Effort:** implementer model #high
- **Commit:** `feat(lewd-combat): AI opponent contract with bounded freedom and local fallback`

### 9. Prose narration pass (Main connection)
- **Status:** ✅ Done — `ff1a7f1` (U7 combined commit: feat(lewd-combat): AI opponent contract and main-connection prose pass)
- **Files:** new `src/features/lewd-combat/lewd-combat-prose.js`, `src/features/lewd-combat/lewd-combat-prompts.js`; tests `tests/lewd-combat-prose.test.js`.
- **Depends on:** Step 7
- **Parallelizable:** yes (with Step 8)
- **Expected behavior:**
  - Build the beat sheet (actor, targets, posture, technique, zones, hit/miss, Arousal/Poise/Stamina deltas, state changes, tone, limits, voices) from the engine log.
  - Call the **Main connection** with the prose prompt; return 2–4 sentences; never mutate state.
  - Frequency: `off` / `per-exchange` (default) / `per-round` / `climax-only`.
  - Guard with `narratorPipelineBusy()`; queue and run after `GENERATION_ENDED`, or fall back to templated beat text. Never call inside a narrator generation.
  - On failure/timeout, show the templated text and a non-blocking warning.
  - Respect explicitness (`explicit`/`suggestive`/`fade-to-black`) and darker-theme setting; obey limits.
- **Acceptance criteria:** mocked main-connection prose appears in the pane; state is byte-identical before/after; failure falls back; no call while the narrator is generating or the board is inactive; prompt includes the explicit/limits constraints; per-round batching works.
- **Risk:** medium
- **Model / Effort:** implementer model #medium
- **Commit:** `feat(lewd-combat): main-connection prose pass with beat sheets`

### 10. Outcome payload and narrator handoff
- **Status:** ✅ Done — `8a3d05f` (feat(lewd-combat): lewd outcome payload and narrator context handoff)
- **Files:** new `src/features/lewd-combat/lewd-combat-outcome.js`; modify `src/features/tactical-combat/tactical-combat-outcome.js` (add `kind:'lewd'` branch), `narrative-hooks.js` (result notice + `[LEWD_COMBAT_CONTEXT]`), `src/features/lewd-combat/lewd-combat-prompts.js`; tests `tests/lewd-combat-outcome.test.js`.
- **Depends on:** Steps 8, 9
- **Parallelizable:** no
- **Expected behavior:**
  - `buildLewdOutcomePayload(state)` includes `kind:'lewd'`, `outcome` (`atMercy`/`surrendered`/`stopped`/`draw`/`mutual`/`sideVictory`), participant summaries (Stamina/Arousal, not HP), pairings, highlights, limits respected, and the final prose.
  - Queue through `setPendingNarration`; one payload per chat.
  - `buildNarrationBlock` dispatches `kind:'lewd'` to a lewd template and labels `[LEWD_COMBAT_CONTEXT]`; `narrative-hooks.js` injects a matching `[LEWD_COMBAT_RESULT_NOTICE]`.
  - Do not close or rewrite `[COMBAT]`; optionally write affinity/relationship deltas if enabled.
  - Auto-continue follows the existing setting pattern.
- **Acceptance criteria:** ending queues exactly one lewd payload; the narrator sees `[LEWD_COMBAT_CONTEXT]`, not tactical/traditional; the payload is one-shot and cleared after a real generation; tactical/traditional outcomes unchanged; `stopped` is neutral; `atMercy`/`surrendered` describe who is at whose mercy without declaring a false death.
- **Risk:** medium-high (shared outcome code)
- **Model / Effort:** implementer model #high
- **Commit:** `feat(lewd-combat): lewd outcome payload and narrator context handoff`

### 11. Narrator tool, sysprompt section, and runtime override
- **Status:** ✅ Done — `051a8a7` (feat(lewd-combat): narrator tool, sysprompt section, and runtime override)
- **Files:** `narrative-hooks.js`, `constants.js` (`RT_PROMPTS` + stock sysprompt), `index.js` (buildSysprompt gating), `game-systems.js` (toggle registry), `src/state/defaults.js` (`syspromptModules.lewd_combat`), `settings.html` (Narrator Configuration checkbox), `src/state/section-enabled.js` if needed; tests `tests/lewd-combat-tool.test.js`.
- **Depends on:** Steps 1, 6, 10
- **Parallelizable:** no
- **Expected behavior:**
  - Register `StartLewdCombat` only when `lewdCombatEnabled` and the section is enabled. Arguments: `participantNames`, `spectatorNames`, `title`, `location`, `reason`, `openingTechnique`, `openingZone`, `tone`, `mode` (`duel`/`group`/`free-for-all`).
  - Add a `<lewd_combat>` sysprompt section: “When the scene becomes intimate and the player initiates, call StartLewdCombat; do not narrate the sexual contest yourself. Ordinary hostile combat still uses the selected primary style.”
  - Do **not** auto-start on `[COMBAT]` hostility and do not use the `[DORMANT_ENCOUNTER]` two-beat rule for lewd.
  - While a lewd board is active, inject `[LEWD_COMBAT_OVERRIDE]` so the narrator does not resolve the scene itself.
  - Add the section to `KNOWN_TOGGLE_DEFAULTS`, `NARRATOR_TOGGLE_IDS`, `buildSysprompt` gating, and the `RT_PROMPTS` copies.
- **Acceptance criteria:** module off = no tool/section/override; module on = tool available, calling it opens the board, narrator does not replay the scene; tactical/traditional board and lewd board cannot both be active in one chat; notices name “Lewd Combat”.
- **Risk:** medium-high
- **Model / Effort:** implementer model #high
- **Commit:** `feat(lewd-combat): narrator tool, sysprompt section, and runtime override`

### 12. Settings pane, prompts, and connections
- **Files:** `settings.html`, new `src/features/lewd-combat/lewd-combat-settings.js`, `src/state/connection-setups.js`, `index.js`, `src/features/lewd-combat/lewd-combat-prompts.js`; tests `tests/lewd-combat-settings.test.js`.
- **Depends on:** Steps 5, 9, 11
- **Parallelizable:** no
- **Expected behavior:**
  - Settings controls: enable, explicitness (`explicit` default/`suggestive`/`fade-to-black`), darker themes, prose frequency, round cap, max partners, open/start/stop/reset, technique compendium JSON + status, compiler prompt, prose prompt, outcome prompt, agent connection, main connection for prose (fixed to Main or configurable).
  - Add `lewd_combat` to `AGENT_CONNECTION_SETUPS` (opponent AI) and document that prose uses Main.
  - Validation errors visible; defaults reset-able.
- **Acceptance criteria:** every control binds/persists; reload restores; connection drives the right call; settings tests assert unique ids and pane binding; primary style untouched.
- **Risk:** low-medium
- **Model / Effort:** implementer model #medium
- **Commit:** `feat(lewd-combat): settings pane, prompts, and connections`

### 13. Consent rails, docs, and integration tests
- **Files:** `src/features/lewd-combat/lewd-combat-profile.js`, `lewd-combat-engine.js`, `lewd-combat-ui.js`, `lewd-combat-prose.js`, `docs/lewd-combat.md`, `CHANGELOG.md`, `Pending_Features.md`; tests `tests/lewd-combat-consent.test.js`, `tests/lewd-combat-integration.test.js`.
- **Depends on:** Steps 3, 4, 7, 9, 12
- **Parallelizable:** yes (per suite)
- **Expected behavior:**
  - Hard limits block techniques in engine + UI; safe word/Stop ends with `stopped`; Surrender yields; fade-to-black suppresses explicit prose; darker themes remain bounded by limits.
  - Document `[LEWD]` lines, technique JSON, `[LEWD_TECHNIQUES]`, sample encounter, and the prose timing.
  - Integration test: enable → start with 2+ partners → several deterministic exchanges (fixed AI action list) → climax/Stamina loss (including a trait-modified drain) → surrender/atMercy → verify a surrendered partner cannot re-enter → queued outcome → narrator block → board reset; assert no HP/Willpower/`[COMBAT]` mutation.
  - Update `Pending_Features.md` with follow-ups (multi-partner expansion, AI director, relationship writeback, `Seduce` bridge).
- **Acceptance criteria:** hard-limit technique impossible via UI/engine even if AI suggests it; Stop ends immediately; full suite green under `npx vitest run --pool=threads`; module inert when disabled.
- **Risk:** low-medium
- **Model / Effort:** implementer model #medium
- **Commit:** `test(lewd-combat): consent rails, docs, and end-to-end coverage`

## Verification & Testing
- **Automated checks (after every step):**
  - `npx vitest run --pool=threads` (full suite; threads pool required on this fork)
  - Targeted: `npx vitest run tests/lewd-combat-profile.test.js tests/lewd-combat-engine.test.js tests/lewd-combat-techniques.test.js tests/lewd-combat-pairing.test.js tests/lewd-combat-compendium.test.js tests/lewd-combat-agent.test.js tests/lewd-combat-prose.test.js tests/lewd-combat-outcome.test.js tests/lewd-combat-settings.test.js --pool=threads`
  - Regression: `npx vitest run tests/combat-mode.test.js tests/combat-board-reset.test.js tests/traditional-combat-outcome.test.js tests/tactical-combat-settings.test.js --pool=threads`
  - No `npm run typecheck`/`lint` scripts exist; Vitest is the only gate.
- **Manual checks:**
  1. Enable the module; open the board from header/settings; start with two or three named participants, one spectator.
  2. Play Lead/Follow/Switch/Surrender; verify preview numbers match results and the pairing matrix updates.
  3. Apply a hold, escape it, apply a stance, let it expire; verify multi-target technique hits only legal targets and excludes a hard-limit target.
  4. Force a climax; verify Stamina −1, Arousal reset, `overstimulated`; force two climaxes to reach 0 and `atMercy`.
  5. Verify the prose pane shows explicit prose by default; switch to `suggestive`/`fade-to-black` and confirm the prose changes without changing mechanics.
  6. End via surrender and via safe word; verify `[LEWD_COMBAT_CONTEXT]` and no `[COMBAT]`/HP changes.
  7. Reload mid-encounter; verify seed, participants, pairings, stances, holds, Stamina/Arousal restore.
  8. Disconnect the Main connection during prose; verify template fallback and no state change; disconnect the opponent agent; verify local policy runs.
- **Edge cases:** missing/partial `[LEWD]` entries; duplicate names; spectator/join mid-round; partner absent from memo; hard limit on a shipped technique; simultaneous climax; Stamina `0` before action; zero/negative modifiers; no legal techniques (must offer Recover/Wait); chat switch mid-exchange; narrator busy; stale finalization; invalid compendium JSON; compile failure for a novel technique; `[COMBAT]` active at the same time; reload during pending prose.
- **Rollback:** each step is an independent commit; the feature is gated by `lewdCombatEnabled` (default `false`). Revert the failing step's commit only. If Step 3 regresses, keep Steps 1–2 and re-plan the math behind the same interface. The `Seduce` bridge remains a separate later spike.

## Appendix: Optional `Seduce` bridge into regular combat (design exploration)
- **Goal:** let a `Seduce` action in tactical/traditional trigger a lewd sub-encounter with one target (or an engaged group), then return to the primary fight.
- **Flow:** the primary board validates the action against the target’s `[LEWD]` profile and consent limits; it pauses the target’s activation, opens `lewdCombatByChat` for the pair/group, and records a `linkedEncounter` back-reference. On lewd resolution, it returns a status package (`flushed`, `distracted`, `charmed`, `sated`) and optional Stamina/Arousal effects to the primary board; the primary board remains authoritative and the target cannot be removed unless the table opts in.
- **Risks:** two active boards in one chat, turn-order interruption, outcome writeback, consent gating, and narrator prompt conflicts. This is why it is a later spike, not core.
- **Recommended guardrails:** one lewd sub-encounter per primary encounter; a hard `lewdDuringCombat: false` default; no HP damage from the sub-encounter; the target can always Surrender/Safe-word out; the primary board cannot be resumed until the sub-encounter ends or is stopped.

## Builder Handoff (agent packaging)

The 13 steps above are the review-sized PRs. For a builder agent, group them into **nine build units** around freezable contracts and demoable checkpoints. The rule is: **parallelize new-file work; serialize shared-file wiring.** Every unit must leave the repo green, and `lewdCombatEnabled` stays `false` until U9 so an incomplete feature never reaches users.

### Unit map

| Unit | Plan steps | Demoable checkpoint | Depends on | May run in parallel with |
|---|---|---|---|---|
| **U1 — Foundation scaffold** | 1 | Feature-gated empty board: toggle, store, router, reset, settings shell | — | — |
| **U2 — Profile contract** | 2 | `[LEWD]` block parses; inferred profiles; trait math | U1 | U3 only after the schema is frozen |
| **U3 — Engine core** | 3 | Deterministic Stamina/Arousal/Poise, climax, surrender, end states | U2 | U4 only after the API is frozen |
| **U4 — Technique system** | 4 | Catalog, pairings, stances/holds, legal actions, local policy | U3 | U5 after the technique schema is frozen |
| **U5 — Compendium/compiler** | 5 | User JSON + `[LEWD_TECHNIQUES]` + compile-once cache | U4 | U6 if the settings-file owner is serialized |
| **U6 — Board experience** | 6 + 7 | Playable multi-partner board with local policy | U4 | U5 if the settings-file owner is serialized |
| **U7 — AI + prose** | 8 + 9 | AI opponent under contract + non-authoritative prose | U6 | U5/U6 cleanup; U7a and U7b are independent |
| **U8 — Narrator handoff** | 10 + 11 | Outcome payload, `StartLewdCombat`, sysprompt, override | U7 | — |
| **U9 — Settings/consent/docs** | 12 + 13 | Full settings, consent rails, docs, integration tests | U8 | — |

**U7 splits naturally:** U7a is the opponent AI contract + local fallback (Step 8); U7b is the prose beat-sheet pass (Step 9). They share prompt/config files, so give one of them the prompt-file owner or split prompts by domain first.

### Optional finer split (only if review/context budget demands it)

Each split adds an integration seam; do not go below this without a reason.

| Split | First half | Second half |
|---|---|---|
| U1 | **U1a** new files only (`lewd-combat-constants.js`, `lewd-combat-store.js`, unit tests) | **U1b** shared wiring (`combat-mode.js`, router, reset, defaults/settings, `index.js`, `settings.html`, `style.css`) |
| U3 | **U3a** state normalization + seeded RNG + log + hydrate/serialize | **U3b** action resolution + climax/surrender/end checks |
| U4 | **U4a** technique catalog data + schema validation | **U4b** pairing/states + `listLegalActions` + `chooseOpponentAction` |
| U6 | **U6a** context builder + start/stop/join flow | **U6b** markup + event wiring + action composer |
| U7 | **U7a** opponent AI contract + fallback | **U7b** prose beat sheet + Main-connection pass |
| U8 | **U8a** outcome payload + `[LEWD_COMBAT_CONTEXT]` | **U8b** tool + `<lewd_combat>` sysprompt + runtime override |
| U9 | **U9a** settings pane + prompts + connection | **U9b** consent rails + docs + integration tests |

### Shared-file hotspots and ownership

These files must not be edited by two builder agents at once.

| File | Units that touch it | Rule |
|---|---|---|
| `settings.html` | U1, U5, U8, U9 | One settings owner; other units deliver IDs/behavior notes |
| `src/state/defaults.js`, `src/state/settings.js` | U1, U2, U5, U8, U9 | Serialize; these are global-state seams |
| `index.js` | U1, U8, U9 | Serialize |
| `narrative-hooks.js` | U8 only | Single owner |
| `constants.js` | U2, U8 | Serialize |
| `style.css` | U1, U6 | U6 owns board styles after the U1 shell |
| `lewd-combat-prompts.js` | U5, U7, U8, U9 | Split by domain into `lewd-combat-agent-prompts.js`, `lewd-combat-prose-prompts.js`, `lewd-combat-outcome-prompts.js`, `lewd-combat-compiler-prompts.js` |
| `lewd-combat-engine.js` | U3, U4, U7, U9 | U3/U4 owner; later units submit small patches only |
| `lewd-combat-ui.js` | U6, U7, U9 | U6 owner; later units patch only |

Practical multi-agent lanes:
- **Lane A (serial):** U1 → U2 → U3 → U4 → U5.
- **Lane B (after U4):** U6 → U7.
- **Lane C (after U7):** U8 → U9.
- The integration owner lands all shared-file wiring and resolves `settings.html` / `defaults` / `index.js` conflicts.

### Contract freezes before parallel work

Do not start parallel units until these are written down in the plan or a short handoff note:

1. **After U1:** `lewdCombatEnabled`, `lewdCombatByChat`, `LEWD_BY_CHAT_KEY`, `rt_lewd_combat_changed`, store API, settings key names.
2. **After U2:** `[LEWD]` grammar, canonical `LewdProfile` object, trait names (`stamina+1`, `drain-1`, `maxArousal+2`, `poise+1`, `sensitivity:neck+1`, `endurance+1`), `applyProfileTraits`.
3. **After U3:** state shape and exported engine API (`createLewdEncounterState`, `applyLewdAction`, `climaxParticipant`, `surrenderParticipant`, `checkLewdEncounterEnd`, `hydrateLewdState`).
4. **After U4:** technique JSON schema, `targetMode`, `listLegalActions`, `chooseOpponentAction`, `staminaDrain`.
5. **After U6:** UI action payload (`{posture, techniqueId, targetIds, zones}`), event hooks, board render props.
6. **After U7:** opponent agent request/response contract, prose beat-sheet shape.
7. **After U8:** outcome payload shape (`kind:'lewd'`, outcomes, participant summaries), narration label.

### Fixtures to create early

- Deterministic 2-person `duel` encounter (fixed seed).
- 3-person `group` encounter with one spectator.
- Fixed AI action list for replay tests.
- Mock `[LEWD]` memo with traits, likes/dislikes, and a hard limit.
- Mock Main connection and mock opponent-agent connection.

### Execution order

**Single builder agent:** U1 → U2 → U3 → U4 → U5 → U6 → U7 → U8 → U9. Run the unit's targeted suite plus `npx vitest run --pool=threads` after each unit.

**Walking-skeleton alternative:** U1 + minimal U2/U3/U4 (two participants, one technique, no traits/multi-partner) + U6 + U7, then backfill full profiles, catalog, pairing, and compendium. It demos the board sooner but creates rework in U3/U4; the layered order is cleaner for a single builder agent.

### Keep together (do not split)

- `[LEWD]` grammar and trait semantics.
- Technique schema and engine validation.
- Outcome payload and narrator block.
- Consent rails and their engine/UI enforcement.
- Prompt files, unless they are first split by domain as described above.

### Per-packet handoff template

For each unit, give the builder:
- **Goal:** one sentence.
- **Steps/files:** the plan step(s) and exact paths.
- **Frozen interfaces:** what it may import/export and what it must not change.
- **Out of scope:** what a later unit owns.
- **Tests:** targeted command + full-suite command.
- **Demo:** the observable behavior at the checkpoint.
- **Commit:** the sketch from the step.

