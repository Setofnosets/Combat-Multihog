# Lewd Combat

Lewd Combat is an optional, consent-aware secondary combat style for intimate
contests. It is **not** part of the primary combat-style selector: the selected
style keeps handling ordinary hostile fights, while the Lewd board is opened
separately from the header button or **Settings → Combat → Lewd Combat
(secondary)**.

The module is off by default (`lewdCombatEnabled: false`). While it is enabled it
sends `[LEWD]` profile blocks to the model and registers the `StartLewdCombat`
narrator tool when the `<lewd_combat>` narrator section is also enabled.

## Resources and loss

- **Stamina** (`0..maxStamina`) is the losing pool. Each climax drains 1
  (finishers may drain 2). At 0 the participant is **at mercy**: out of the turn
  order, unable to act, and the partner/table decides the aftermath.
- **Arousal** fills toward `maxArousal`. At full it triggers a climax: Stamina
  drops, Arousal resets to 0, and `overstimulated` applies for one round.
- **Poise** guards pleasure checks. At 0 the participant is **overwhelmed**
  (Arousal gains ×1.5 and finishers unlock) until the end of the next turn.
- **Submit** is a posture (Follow) with its own techniques. **Surrender** is a
  separate hard yield: the participant leaves the encounter and cannot re-enter
  it. **Safe word / Stop** ends immediately with `outcome: 'stopped'`, no winner,
  and a neutral aftermath.

All rolls use a persisted seeded RNG. The engine owns every number; the model
never rolls, invents targets, or changes state.

## The `[LEWD]` memo block

One line per named character. Players, NPCs, enemies, and party members are all
allowed. Missing entries fall back to an inferred neutral profile, visibly
marked as inferred; an absent block is valid.

```
[LEWD]
- Aria: role=switch | stamina=4/4 | sensitivity=neck:high, groin:medium, ears:low | anatomy=penis | skills=bondage | kinks=bondage | likes=praise, teasing | dislikes=pain | limits=breath play, marking | endurance=+1 | experience=2 | traits=stamina+1, drain-1 | body=Lean and tall. | species=Incubus
- Bran: role=dominant | stamina=3/3 | sensitivity=neck:medium, chest:low | anatomy=vagina | likes=being guided | dislikes=humiliation | limits=none declared | endurance=+0 | experience=1 | traits=poise+1
[/LEWD]
```

Fields: `role`, `orientation`, `stamina`, `sensitivity`, `anatomy`, `skills`,
`kinks`, `likes`, `dislikes`, `limits`, `endurance`, `experience`, `traits`,
`body`, `species`, plus an optional `notes` value.
Inline `Lewd:`/`Desires:`/`Sensitive:`/`Limits:` lines are accepted as a fallback.

- `anatomy` is a capability list (`penis`, `testes`, `vagina`, `vulva`, `anus`,
  `breasts`, `tail`, `wings`, `tentacles`, `knot`, `bondage-gear`). Only write a
  tag the story or card establishes. **Genitals are never inferred from gender.**
- `skills` and `kinks` are optional capability/preference tags (`bondage`,
  `ropework`, `praise`). They gate techniques; they are not prose.
- `body` (≤300 characters) and `species` (≤80 characters) are short neutral
  descriptors used by the opponent agent and the inference pass.

Profiles are inferred once at encounter start from every available source, in
priority order: explicit `[LEWD]` fields → SillyTavern character card text →
State Tracker sections (`[CHARACTER]`, `[PARTY]`, `[COMBAT]`: Species, Body,
Appearance, Personality, Traits, Abilities, Status) → NPC lorebook entries →
`unit.notes`/`unit.skills`/`unit.traits`. Explicit fields always win. Inferred
values are marked (`inferred: true`) and record per-field provenance; no source
is allowed to guess anatomy from gender alone.

Supported traits are deterministic modifiers applied after the base formulas and
before clamping: `stamina+1`, `drain-1` (never below 1 Stamina per climax),
`maxArousal+2`, `poise+1`, `sensitivity:neck+1`, `endurance+1`. Unknown zones,
tags, and traits are ignored with a warning.

The State Tracker maintains the block only while the module is enabled, and only
when a profile genuinely changes.

## Techniques

Sexual techniques never go through `[ABILITIES]`. Four layers are merged
deterministically, later layers overriding by `id`:

1. the shipped catalog in `lewd-combat-techniques.js`;
2. the compile-once cache (`lewdCombatTechniqueCache`) for validated novel acts;
3. the user compendium JSON (`lewdCombatTechniqueCompendiumJson`);
4. optional `[LEWD_TECHNIQUES]` scene lines.

The shipped catalog contains an explicit act layer (penetration, oral,
manual/masturbation, bondage, tail, paizuri, intercrural, sixty-nine) plus the
original foreplay/tease, stance, hold, counter, finisher, command, recover, and
submit entries. Each entry declares `actType` (`penetration`, `oral`, `manual`,
`bondage`, `masturbation`, `other`) and `actRole` (`give`, `receive`, `mutual`).

Canonical shape:

```json
{
  "id": "penetration-start",
  "name": "Penetration",
  "category": "technique",
  "description": "Commit to the first deep contact and set the pace.",
  "posture": "lead",
  "zones": ["genitals"],
  "targetMode": "single",
  "tags": ["penetration", "intimacy"],
  "actType": "penetration",
  "actRole": "give",
  "check": { "stat": "cha", "accuracy": 1 },
  "arousal": "2d6+2",
  "poise": "1d6",
  "staminaDrain": 2,
  "requires": {
    "hold": null, "stance": null, "overwhelmed": false,
    "act": null, "actType": null, "actRole": null,
    "minIntensity": null, "bindings": null, "pairStance": null,
    "anatomy": { "any": ["penis", "vagina", "tail"] },
    "targetAnatomy": { "any": ["vagina", "anus", "tail"] },
    "skill": null, "trait": null, "kink": null
  },
  "applies": { "act": { "id": "penetration", "intensity": 1 } },
  "uses": { "max": null, "recharge": "at-will" },
  "ai": { "priority": 3, "conditions": [] }
}
```

Categories: `stance`, `hold`, `technique`, `counter`, `finisher`, `tease`,
`command`, `recover`, `submit`. `targetMode` is `single`, `pair`, `group`,
`aura`, or `self`.

### Act and pair state

- Starting a penetration/oral/manual/bondage act writes it to the engagement
  edge: `act`, `actType`, `actRole`, `actIntensity`, `actStartedRound`,
  `bindings`, `bindingsStartedRound`, and `pairStance`.
- While the act is active, the pair gets follow-ups: `thrust`, `thrust-harder`,
  `slow-down`, `deepen`, `withdraw`, `change-position`; while bound:
  `tighten-bindings`, `loosen-bindings`, `tease-bound`, `release-bindings`.
  They are only actionable for that pair and disappear/clear when the act or
  bindings end.
- `applies.act` sets or clears the pair's act; `applies.intensityDelta`,
  `applies.bindingsDelta`, and `applies.pairStance` adjust it.
- `applies.stance` may target `actor`, `target`, or `pair`; pair stances are
  live and render in the pairing matrix.

### Gating rules

`listLegalActions` and `applyLewdAction` enforce the same gates; the UI clause
is only a display of the engine's reason:

- `requires.anatomy` / `requires.targetAnatomy`: a participant without the
  required organ cannot use the act; a receptive target without the required
  anatomy is excluded **per target**, not by cancelling the whole action.
  Unknown anatomy blocks genital-specific acts with `Set anatomy in [LEWD].`
  and still allows neutral techniques.
- `requires.skill` / `requires.trait` / `requires.kink`: capability tags.
- `requires.act` / `actType` / `actRole` / `minIntensity` / `bindings` /
  `pairStance`: transient pair requirements; invalid pair actions are reported
  and dropped.
- Disabled reasons are human-readable (`Requires penis or vagina or tail.`,
  `Requires bondage skill.`, `Requires active act: penetration.`) and are
  carried to the opponent agent so it cannot select an illegal act. The engine
  remains the final validator.

### Start-of-encounter inference

Each new encounter builds the merged catalog and runs a one-time availability
pass:

1. a deterministic prefilter over the catalog using each participant's
   anatomy, skills, traits, kinks, and target anatomy (transient pair
   requirements are ignored so follow-ups stay visible); then
2. an optional agent call on the Lewd Combat Agent connection that may add
   existing ids or propose novel techniques from the visible profiles.

Everything returned is validated; unknown ids and illegal acts are dropped with
diagnostics. Availability is stored per encounter in `state.inferredActions`
and **never reused across encounters**; the composer and the AI opponent payload
are scoped to it. The **Refresh actions** button re-runs the pass. If the agent
is offline, broken, or slow, the deterministic prefilter is used and the board
never blocks. Compiled novel definitions stay in `lewdCombatTechniqueCache`
(compile once), so only availability is recomputed.

Compact scene authoring:

```
[LEWD_TECHNIQUES]
- Neck Kiss | technique | either | zones: neck | tags: teasing, praise | arousal: 1d6+2 | poise: 1d4 | at-will
- Firm Grip | hold | lead | zones: waist, hips | tags: dominance | check: str | hold: grappled | dc: 12
- Rope Play | technique | lead | zones: hands | acttype: bondage | actrole: give | requiresanatomy: bondage-gear | requiresskill: bondage | appliesact: bondage
[/LEWD_TECHNIQUES]
```

Unknown techniques named by the player or the opponent agent are compiled once
through the compiler prompt, validated, and cached in `lewdCombatTechniqueCache`.
Later uses never call the model again. Compilation failures are visible and do
not block the board; the action is rejected and the local policy runs.

## Consent rails

- Hard limits block a technique in both the engine and the board. The UI shows
  `Blocked by limit: <limit>` and the engine rejects the same action if an agent
  or script submits it.
- A multi-target action excludes only the blocked target; a single-target action
  is rejected entirely.
- Safe word / Stop ends the encounter immediately with no winner.
- Surrender yields the scene; the partner decides the aftermath within the same
  limits.
- `fade-to-black` suppresses the prose pass entirely: no model call is made and
  a deterministic non-explicit sentence is shown instead.
- Darker themes remain subordinate to every declared hard limit.
- A Lewd Combat loss is never death or lasting injury.

## Prose timing and transcript

Prose is a **non-authoritative** pass on the **Main API** connection (never the
opponent-agent connection). It receives the engine's beat sheet and returns 2–4
sentences; it cannot change state.

`lewdCombatProseFrequency`:

- `per-exchange` (default) — after each resolved exchange;
- `per-round` — one batched call per round;
- `climax-only` — only on a climax or encounter end;
- `off` — templated beat text only.

Each exchange produces **one transcript entry covering every beat since the last
narrated index**, so the player's action and the AI response are both preserved
(the previous single-slot `state.prose` overwrote the player beat). The
transcript lives in `state.proseLog` (newest last, capped at 50 entries); each
entry stores `{ id, stateId, chatId, round, exchangeId, actorIds, beatIds, text,
source, createdAt }`. `state.prose` mirrors the latest entry for backwards
compatibility. The structured beat log stays separate.

- On failure, timeout, or a missing connection, deterministic
  `describeLewdBeat` entries are appended for the un-narrated beats instead of
  dropping them (`source: 'fallback'`).
- Async results are tagged with `stateId`/`chatId`/render token; a result for a
  reset, closed, or chat-switched board is discarded and never repaints it.
- While the narrator is generating, beats are queued and flushed after
  `GENERATION_ENDED`.
- `fade-to-black` still suppresses the model entirely and writes neutral text.

## Start, save, and outcome

- `StartLewdCombat` accepts `participantNames`, `spectatorNames`, `title`,
  `location`, `reason`, `openingTechnique`, `openingZone`, `tone`, `mode`
  (`duel`, `group`, `free-for-all`), and `controlMode`.
- **Control modes** are independent of combat side:
  - `auto` (default) — `[CHARACTER]`/`[PARTY]` are player-controlled; `[COMBAT]`
    enemies/allies and `[LEWD]`-only named NPCs are AI-controlled.
  - `player-all` — every active participant is player-controlled.
  - `ai-others` — the player controls `[CHARACTER]`/`[PARTY]`; every other named
    participant is AI-controlled.
  A `side: 'player'` participant can still be AI-controlled (and vice versa); the
  board shows a control chip per participant. The start dialog exposes the mode.
  Unknown names in a scene without `[COMBAT]` become AI-controlled named NPCs
  under `auto`/`ai-others`; no `[ENEMY]` tag is invented and `[COMBAT]` remains
  the only hostile roster source.
- Boards live in `lewdCombatByChat[chatId]`. The module never writes `[COMBAT]`,
  HP, Willpower, or spell slots while a scene is active.
- While a board is active, `[LEWD_COMBAT_OVERRIDE]` stops the narrator from
  resolving the scene itself.
- At the end, one `kind: 'lewd'` payload is queued and rendered as
  `[LEWD_COMBAT_CONTEXT]` for the next narrator generation. The board stores a
  durable `state.resolution` record (`stateId`, `endedAt`, `consumedAt`,
  `consumedFor`, `outcome`, `winnerIds`, `atMercyIds`, `surrenderedIds`,
  `source: 'lewd'`, `cleanup`).

### End-of-encounter latch and mercy

- Finishing is **idempotent**: `finishEncounterIfEnded` writes the resolution
  once, sets `finalization.finalizing`, and queues exactly one payload. Calling
  it again is a no-op.
- Starting a new encounter is latched while the resolution is unconsumed or the
  board is finalizing. The latch is **turn-based**: the resolution is consumed
  only after the narrator delivers the aftermath *and* the next user turn
  begins. A configurable `lewdCombatPostEncounterCooldownMs` (default 60 s) is a
  mechanical safety net for tool loops, not the main gate.
- The aftermath is delivered with a no-retrigger directive: the scene is over,
  do not resume or restart it, and do not call `StartLewdCombat` in the same
  turn. Defeated/surrendered participants remain in the scene with status
  **At Mercy** and are not new hostiles; a new intimate scene only begins when
  the player explicitly initiates one after a later scene turn.
- **New encounter** clears the latch and board immediately; **Return to story**
  acknowledges the result, removes the board, and clears only the lewd handoff.
  Neither opens a new encounter as a side effect.
- `lewdCombatCombatCleanup` controls memo writeback for participants sourced
  from `[COMBAT]`: `off` (leave untouched), `mark` (default; write
  `Status: At Mercy` / `Status: Sated`), `close` (also resolve/close the block
  when every `[COMBAT]` participant was in the scene).
  `lewdCombatMercyStatusWriteback` (default `true`) gates the status write
  itself. `[COMBAT]` is never written for a `[LEWD]`-only scene, and unrelated
  combatants are left alone.

## Settings and connections

Settings → Combat → **Lewd Combat (secondary)** contains:

- enable, explicitness (`explicit` default / `suggestive` / `fade-to-black`),
  darker themes, prose frequency, round cap, max concurrent partners;
- control mode (`auto` / `player-all` / `ai-others`);
- post-encounter latch and cooldown (seconds), `[COMBAT]` cleanup
  (`off` / `mark` / `close`), and mercy status writeback;
- the technique compendium JSON with status and reset;
- compiler, opponent-agent, prose, and outcome prompts with reset;
- opponent-agent and prose output-token limits;
- Open, Start scene, Safe word / Stop, Reset board, and Discard board controls.
  The board also exposes **Refresh actions** to re-run action inference.

The **Lewd Combat Agent** connection (Connections & Models) drives the opponent
agent and the compile-once technique compiler. The prose pass is fixed to Main
API.

## Out of scope

No positional grid, multiplayer networking, animated scenes, automatic
relationship-tier rewrites, non-consensual content, or game-system-specific kink
rulesets. A `Seduce` bridge from regular combat to a Lewd sub-encounter remains a
separate design spike.
