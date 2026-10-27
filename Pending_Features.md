# Pending Combat Features

> **Status: investigation backlog.** These features are deliberately **not implemented**.
> Each item must be investigated and designed before code is written. The
> multiattack / attacks-per-round system is listed first and must be investigated
> before any implementation work begins.

The current build now has a dynamic spell compendium (shipped definitions plus
per-setting JSON overrides plus per-memo inference), shared per-level spell-slot
pools, at-will abilities without usage notation, deterministic post-combat
resource writeback, and burst/sphere area templates. The items below go beyond
that foundation or need a larger rules decision.

## 1. Multiattack and attacks per round (investigate first)

The parser now reads the **first** attack bonus from a line such as
`+9/+4 / 1d10+4` instead of the last one, but the engine still makes exactly one
attack. Before implementing this, investigate:

- whether `+9/+4` means two weapon attacks, an iterative attack penalty, or two
  different weapons;
- how attacks-per-round interact with action economy, bonus actions, and
  movement;
- whether each attack gets its own target, range check, line-of-sight check, and
  damage roll;
- how the agent action schema should represent an ordered multiattack without
  allowing one action to exceed the unit's legal attack count;
- how UI target selection should work when each attack can choose a different
  target;
- how critical hits, on-hit statuses, and Willpower damage apply per attack;
- how to display partial multiattacks in the log and memo without inflating the
  action budget.

Do not ship APR until the action schema, engine, agent prompt, UI, and memo
round-trip are designed together.

## 2. Spell save DC and saving throws

`Spell Atk` is now parsed and used for spell attack rolls, and `Spell DC` is
preserved in unit payloads and memo output, but the engine does not yet resolve
saving throws. Investigate:

- which abilities use an attack roll versus a save;
- save proficiency and ability modifiers from the memo;
- half damage on a successful save;
- save-based conditions versus attack-based conditions;
- how the agent declares a save and how the engine validates the DC;
- whether the main narrator or the deterministic engine rolls the save.

## 3. Additional area-of-effect templates

Only `burst`/`sphere` templates with a cell radius are implemented. Investigate:

- cones, lines, cubes, cylinders, and walls;
- rotated templates and diagonal coverage;
- template previews that match the final affected cells;
- terrain and line-of-sight interaction for each shape;
- whether templates should be authored in the compendium, the agent payload, or
  both.

## 4. Resource ledger UI and import/export

The ledger is authoritative inside the combat result payload and tracker report.
Still pending:

- a board panel that shows every shared slot pool, ability use, and item charge;
- import/export of a ledger for debugging;
- a reconciliation view when the memo and ledger disagree;
- per-chat ledger history.

## 5. Per-character and per-system compendium management

Implemented in this build: the per-chat **Campaign Skill Registry** discovers player,
party, class, item, and named enemy-special skills; resolved specials become canonical
effect templates; transformation forms are reusable; and the `_Skills` lorebook is a
readable mirror. Still pending:

- importing a compendium from a game-system module;
- explicit per-character prepared-spell management;
- per-chat rule-set overrides;
- compendium versioning and migration beyond registry v1;
- level-scaled and per-owner variants of the same skill/form.

## 6. Upcasting and explicit slot-level selection

The engine spends from the shared pool for the spell's listed level. Investigate:

- casting a lower-level spell with a higher-level slot;
- upcast damage/healing formulas;
- choosing a slot level in the UI and agent schema;
- whether cantrips can ever consume slots;
- how the memo records the chosen slot level.

## 7. Item charges, multi-effect consumables, and reusable items

Items currently use a simple remaining-quantity pool. Investigate:

- charges with recharge rules;
- multiple effect primitives from one item;
- consumables that are not healing or special;
- items that are reusable without being at-will abilities;
- inventory stacks that split or merge.

## 8. Reactions, counterspell, and interrupt windows

The engine has a `reactionUsed` flag but no reaction economy. Investigate:

- opportunity attacks;
- counterspell and interrupt timing;
- reactions that trigger before damage is applied;
- how asynchronous agent turns pause for a player reaction;
- how to prevent reaction loops.

## 9. Conditions, cover, and environmental rules

The board supports basic statuses and terrain modifiers. Still pending:

- prone, grappled, restrained, blinded, and similar conditions;
- cover granularity beyond a flat AC bonus;
- forced movement, fall damage, and hazards;
- persistent zones and recurring damage;
- condition expiry at the correct phase boundary.

## 10. Encounter balance and telemetry

Not yet implemented:

- challenge-rating or level-budget validation for generated encounters;
- detecting a generated roster that is mathematically unwinnable;
- per-encounter telemetry (rounds, resources spent, damage by source);
- suggestions for the narrator when the party is likely to lose.
