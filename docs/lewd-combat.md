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
- Aria: role=switch | stamina=4/4 | sensitivity=neck:high, groin:medium, ears:low | likes=praise, teasing | dislikes=pain | limits=breath play, marking | endurance=+1 | experience=2 | traits=stamina+1, drain-1
- Bran: role=dominant | stamina=3/3 | sensitivity=neck:medium, chest:low | likes=being guided | dislikes=humiliation | limits=none declared | endurance=+0 | experience=1 | traits=poise+1
[/LEWD]
```

Fields: `role`, `orientation`, `stamina`, `sensitivity`, `likes`, `dislikes`,
`limits`, `endurance`, `experience`, `traits`, plus an optional `notes` value.
Inline `Lewd:`/`Desires:`/`Sensitive:`/`Limits:` lines are accepted as a fallback.

Supported traits are deterministic modifiers applied after the base formulas and
before clamping: `stamina+1`, `drain-1` (never below 1 Stamina per climax),
`maxArousal+2`, `poise+1`, `sensitivity:neck+1`, `endurance+1`. Unknown zones,
tags, and traits are ignored with a warning.

The State Tracker maintains the block only while the module is enabled, and only
when a profile genuinely changes.

## Techniques

Sexual techniques never go through `[ABILITIES]`. Two layers are merged:

1. the shipped catalog in `lewd-combat-techniques.js`;
2. the user compendium JSON (`lewdCombatTechniqueCompendiumJson`), overrides by
   `id`;
3. optional `[LEWD_TECHNIQUES]` scene lines.

Canonical shape:

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

Categories: `stance`, `hold`, `technique`, `counter`, `finisher`, `tease`,
`command`, `recover`, `submit`. `targetMode` is `single`, `pair`, `group`,
`aura`, or `self`.

Compact scene authoring:

```
[LEWD_TECHNIQUES]
- Neck Kiss | technique | either | zones: neck | tags: teasing, praise | arousal: 1d6+2 | poise: 1d4 | at-will
- Firm Grip | hold | lead | zones: waist, hips | tags: dominance | check: str | hold: grappled | dc: 12
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

## Prose timing

Prose is a **non-authoritative** pass on the **Main API** connection (never the
opponent-agent connection). It receives the engine's beat sheet and returns 2–4
sentences; it cannot change state.

`lewdCombatProseFrequency`:

- `per-exchange` (default) — after each resolved exchange;
- `per-round` — one batched call per round;
- `climax-only` — only on a climax or encounter end;
- `off` — templated beat text only.

While the narrator is generating, beats are queued and flushed after
`GENERATION_ENDED`. On failure, timeout, or a missing connection the board keeps
the templated beat text and continues.

## Start, save, and outcome

- `StartLewdCombat` accepts `participantNames`, `spectatorNames`, `title`,
  `location`, `reason`, `openingTechnique`, `openingZone`, `tone`, and `mode`
  (`duel`, `group`, `free-for-all`).
- Boards live in `lewdCombatByChat[chatId]`. The module never writes `[COMBAT]`,
  HP, Willpower, or spell slots.
- While a board is active, `[LEWD_COMBAT_OVERRIDE]` stops the narrator from
  resolving the scene itself.
- At the end, one `kind: 'lewd'` payload is queued and rendered as
  `[LEWD_COMBAT_CONTEXT]` for the next narrator generation.

## Settings and connections

Settings → Combat → **Lewd Combat (secondary)** contains:

- enable, explicitness (`explicit` default / `suggestive` / `fade-to-black`),
  darker themes, prose frequency, round cap, max concurrent partners;
- the technique compendium JSON with status and reset;
- compiler, opponent-agent, prose, and outcome prompts with reset;
- opponent-agent and prose output-token limits;
- Open, Start scene, Safe word / Stop, Reset board, and Discard board controls.

The **Lewd Combat Agent** connection (Connections & Models) drives the opponent
agent and the compile-once technique compiler. The prose pass is fixed to Main
API.

## Out of scope

No positional grid, multiplayer networking, animated scenes, automatic
relationship-tier rewrites, non-consensual content, or game-system-specific kink
rulesets. A `Seduce` bridge from regular combat to a Lewd sub-encounter remains a
separate design spike.
