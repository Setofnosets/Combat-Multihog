# Tactical Combat

Tactical Combat is a grid-based battle layer for the Multihog D&D Framework. It turns the tracker's existing state memo into a playable encounter: party members, enemies, non-party allies, stats, skills, and consumables are all read from `[CHARACTER]`, `[PARTY]`, `[COMBAT]`, and `[INVENTORY]`.

Open it from **Settings → Combat → Tactical Combat** or the combat button in the tracker header while the **Tactical** style is selected.

---

## Quick start

1. Open **Settings → Combat**, set **Combat style** to **Tactical**, and use the Tactical pane.
2. Choose a grid size, turn style, terrain theme, and (optionally) a dedicated combat-agent connection.
3. Talk to the narrator until a fight begins. The narrator calls `StartTacticalCombat` immediately; it can reuse an existing `[COMBAT]` roster or build opposition from the current scene when none exists.
4. The board opens with the party on the left and enemies on the right. When deployment is enabled, reposition player units inside the highlighted left lane and press **Start battle**. When the fight started from a declared action, that opening action is resolved before Round 1.
5. Select a player unit, move to a blue-highlighted cell, then attack (red targets), use a skill or item, defend, wait, or flee.
6. Press **End player phase** (phased mode) or **End turn** (initiative mode). The combat agent controls every enemy and non-party ally, then the next player phase begins.
7. When one side is gone — or the party retreats — final HP is written into the memo, `[COMBAT]` is closed, and the authoritative aftermath is queued for the main narrator.

---

## Settings

| Setting | Purpose |
|---|---|
| **Combat style** | **Narration**, **Tactical grid**, or **Traditional turn-based**. The selected style owns the board, narrator tool, and system-prompt override. Switching is blocked while a saved board is still running (active, preparing, or finalizing). The pane lists every open encounter with its chat name so a board in another — or deleted — chat is visible; **Clear open encounters** removes those boards and applies the style you tried to pick. Markers left by a previous page session are ignored, and a stuck finalization expires after 90 seconds. |
| **Grid dimensions** | 10×10, 15×15, 20×20, **Dynamic** (8×8 to 24×24 based on roster size), or **Custom** (5–40 rows/columns). |
| **Turn style** | **Phased** — every player unit acts in any order, then every agent unit; or **Initiative** — 1d20 + modifier, one unit at a time. |
| **Terrain theme** | Auto (matches location keywords) or Dungeon / Forest / Cave / City / Interior / Plain. |
| **Terrain density** | 0–100. Higher values add more cover, rubble, hazards, walls, water, and high ground. Deployment lanes stay clear. |
| **Movement per turn** | Default speed in cells for units without an explicit speed. Diagonals cost 1; difficult terrain costs 2. |
| **Auto-start on hostile actions** | When enabled, the narrator opens the board only after a real attack, hostile spell, charge, ambush, or `COMBAT STATE: HOSTILE/ACTIVE`. Disable to require the Start encounter button. |
| **Derived Willpower %** | Percentage of max HP used by the deterministic max Willpower fallback. Default 30%. Explicit `Willpower:`/`maxWillpower` values always win. |
| **Recover Willpower after combat** | Restores current Willpower to max for units that ended the fight intact. Defeated, fled, and Willpower-broken units keep their final Willpower and terminal Status. Disable to keep persistent Willpower loss for everyone. |
| **Maximum special resolutions** | Maximum unique enemy special abilities sent through the resolver per activation batch. Deterministic Willpower attacks and pre-authored effect templates do not count. |
| **Encounter source** | Auto (reuse active `[COMBAT]`, otherwise ask the agent), Existing only, or Always ask the agent. |
| **Show grid coordinates** | Adds `x,y` labels to cells. |
| **Show area-of-effect hover previews** | Previews the burst covered by a hovered cell. Selected abilities always show their range; turn this off only for the hover overlay. |
| **Automatically return to narration** | When combat ends, close the board and trigger the main generation after a short delay. The outcome is queued either way. |
| **Resolve declared opening actions** | Applies the player's declared spell, ambush, charge, or attack before Round 1. Ambushes cost the enemy their first activation. |
| **Deploy player units before battle** | Opens a deployment step where player units can be repositioned inside the left deployment lane. Press **Start battle** to begin Round 1. |
| **Update State Tracker before narration** | Writes final HP and the closed combat block into the memo before the aftermath prompt is sent. Disable to let the next normal tracker pass handle it. |
| **Combat agent connection** | Main API, saved connection profile, Ollama, or OpenAI-compatible endpoint + completion preset + max output tokens. |
| **Prompt Templates** | Editable tactical agent, encounter architect, outcome-to-narration, and special-ability resolver prompts. Reset restores the shipped template. |
| **Special ability resolver prompt** | Used only when a non-standard ability/spell/item is cast. Converts freeform effects (summoning, terrain, control) into engine primitives. |
| **Action Catalogue & Game State** | JSON editor for the legal action vocabulary. Labels/descriptions can be changed; `"enabled": false` removes an action from the board and the agent contract. Unknown action types are rejected at runtime. |
| **Loadout Classifiers** | Shared JSON editor for ability/spell classification rules, attack keywords, buff AC/attack/duration defaults, ranged/bonus-action keywords, inventory consumable/healing/special keywords, and Willpower damage/outcome keywords. |
| **Spell Compendium** | Shared JSON editor for spell mechanics. Shipped definitions cover common tabletop spells; this JSON can override or extend them. Spell names found in the current memo without a definition are inferred from their name and spell level. |
| **Terrain Key** | Static reference for every terrain type, colour, glyph, and effect. |

Tactical, Traditional, and shared settings are global. Each chat gets its own board, stored in `extension_settings.rpg_tracker.tacticalCombatByChat[chatId]` (and `traditionalCombatByChat[chatId]` for the no-grid mode).

### Spell slots, ability uses, and at-will abilities

The memo format distinguishes three resource shapes:

- `Spells: Level 1 (2/2): Magic Missile, Shield` is **one shared pool** for that level. Casting either spell spends one of the two slots; every spell in the line reads the same pool.
- `Abilities: Action Surge (extra action; 1/1 per rest)` is a **per-ability** pool. The current value is the first number, not the maximum.
- `Abilities: Silver Tongue (a quick lie)` has no usage notation and is **at-will**.

Cantrips are unlimited. Item lines use their quantity as the remaining uses. At combat end the board writes final HP, terminal Status, spell-slot lines, ability usage, and inventory quantities back into `[CHARACTER]`/`[PARTY]`, `[SPELLS]`/`[ABILITIES]`, and `[INVENTORY]`. Defeated, fled, and Willpower-broken units keep their final Willpower and do not recover it.

---

## Terrain

| Glyph | Terrain | Effect |
|---|---|---|
| `·` | Open floor | Normal movement. |
| `"` | Grass / scrub | Normal movement. |
| `▲` | Rubble | Difficult terrain; each cell costs 2 movement. |
| `≈` | Water | Impassable. |
| `■` | Wall / rock | Impassable; blocks line of sight. |
| `◈` | Cover | +2 AC while standing here. |
| `↑` | High ground | Costs 2 movement; +1 to attack rolls made from here. |
| `✶` | Hazard | 1d4 damage at the start of a round while standing here. |
| `◆` | Objective | Tactical marker / narrative flavour. |

The grid is 8-directional. Line of sight uses a Bresenham line and is blocked by walls. Cover and high ground are evaluated from the combatant's current cell.

---

## Combat rules

- **HP / Willpower / AC / attacks** come from memo stat blocks when available. Missing stats fall back to level-appropriate tabletop defaults instead of failing.
- **Willpower** is a morale pool separate from HP and from the `Saves: ... Will +X` saving throw. Ordinary attacks never touch it. Willpower-targeting skills/items declare `resource: "willpower"` (or `"both"`). At 0 Willpower the unit breaks according to `willpowerOutcome`: `defeat`, `flee`, `switch_side`, `incapacitate`, or `surrender`. Willpower recovers to max when combat ends unless recovery is disabled in settings.
- **Max Willpower** is deterministic: `2 + configured % of max HP (default 30%) + positive WIS modifier + positive Will save`, capped below HP and at 60. An explicit `Willpower: current/max` line or architect `maxWillpower` overrides it. `maxWillpower: 0` means mindless/immune.
- **Damage** accepts `XdY+Z` expressions. Natural 20 is a critical (damage dice are doubled, modifier once); natural 1 always misses.
- **Actions**: Move, Attack, Skill, Item, Defend, Wait, Flee. A unit can move before or after its main action. Bonus-action skills consume the bonus slot instead.
- **Resources**: movement per turn, one main action, one bonus action, one reaction slot (reserved for future extensions).
- **Skills** are parsed from `Abilities:` and `Spells:` lines. The parser infers attack/heal/buff, range, damage, uses, bonus-action usage, and optional burst/aura area templates. A class-appropriate fallback skill is granted if nothing parses.
- **Items** are parsed from `[INVENTORY]` lines containing potions/elixirs/tonics. The player character gets two healing potions if nothing parses.
- **Inventory ownership**: every combatant now exposes gear parsed from their own `Gear:`/`Att/def:` line in the board's Inventory panel. The player character's dedicated `[INVENTORY]` block is merged on top of their sheet gear, and only its consumables become clickable items.
- **Separate loadout blocks**: `[ABILITIES]`, `[SPELLS]`, and `[INVENTORY]` describe the player character only and are parsed independently of `[CHARACTER]`. Companion abilities and spells belong inside each companion's `[PARTY]` entry. The board filters companion-owned duplicates out of the player character's standalone loadout, so a stray party spell cannot become a PC spell. Both the encounter architect and the combat agent still receive every unit's own abilities, spells, consumables, and inventory context. Gear and other inventory entries are shown in the board's Inventory panel; consumables/scrolls/vials become usable board items. Items such as a Restoration Vial use the special resolver with `cure` effects.
- **Defeat**: a unit at 0 HP is defeated and remains on the board as a faded corpse. Corpse markers are non-interactive scenery: they do not block movement, deployment, or targeting, and a live unit standing on a corpse tile remains the clickable occupant. Victory = every enemy defeated. Defeat = every player unit defeated. Retreat = every player unit fled or the player presses Retreat.
- **Hazards** damage all units standing on them at the start of each round.
- **Statuses** tick at the start of each round; damage-over-time effects are applied then. Defend grants +4 AC for the current round.

### Turn styles

**Phased** works like a tactics game:

1. Player phase — every player unit may act in any order.
2. End player phase → agent phase for all enemies and non-party allies.
3. Agent actions are validated and applied; the next round starts with all resources reset.

**Initiative** rolls `1d20 + initiative bonus` for every combatant at encounter start. Units act one at a time. Consecutive agent units are sent to the agent as one batch; after the batch resolves, play returns to the next player unit (or a new round).

### Special / non-standard effects

Ordinary attacks, heals, and buffs are resolved by the pure engine with no extra model call. If an ability, spell, or item cannot be expressed as a simple effect (summoning, terrain reshaping, unusual control, complex multi-effect magic), it is marked `kind: "special"`:

- Click the skill/item, then a target on the board (self is valid for summons/terrain).
- One compact resolver call sends only the ability, caster, target, and local battlefield state.
- The resolver returns a small JSON effect list: `damage`, `heal`, `status`, `terrain`, `summon`, `defeat`, `transform`, `cure`, or `log`.
- `damage`/`heal` accept `resource: "hp" | "willpower" | "both"`. `damage` with `resource: "willpower"` accepts `willpowerOutcome`.
- `defeat` is only legal after Willpower reaches 0. Use it for a non-default terminal outcome when another effect has already broken the target.
- `transform` swaps the target's stats, skills, items, and inventory for the encounter. It is temporary by default and reverts when combat ends; enemy-authored permanent transformations are rejected.
- `status` accepts `behavior` (`stunned`, `confused`, `frightened`, `charmed`, `berserk`), `stacks`/`maxStacks`, `damageResource`, and `willpowerOutcome` for progressive morale effects.
- The engine validates and applies those primitives, consumes the action/uses, and writes the combat log.

Enemy special abilities use the same separation: the tactical agent may only **declare** a special skill and target. The framework resolves it separately, validates every effect, and applies it inline in action order. The enemy agent never emits effects or invents outcomes.

This keeps token usage limited to the rare ability that actually needs adjudication; ordinary rounds never call the resolver.

### Willpower abilities

Authoring examples:

```text
Willpower: 8/8
Abilities: Dread Wail (Will damage 2d6, 6 cells, 1/1; on Willpower break: flee)
Abilities: Psychic Lance (2d6 HP + 1d6 Willpower, 8 cells, 1/1)
Abilities: Mind Ward (Will heal 1d6, self, 1/1)
```

Mechanical fields:

```json
{
  "name": "Dread Wail",
  "kind": "attack",
  "resource": "willpower",
  "damage": "2d6",
  "willpowerOutcome": "flee",
  "range": 6,
  "maxUses": 1
}
```

`resource: "both"` uses `damage` for HP and `willpowerDamage` for Willpower. The engine uses one attack roll; a critical doubles each damage pool. Basic attacks use `attackResource` / `willpowerDamage` / `attackWillpowerOutcome`. The agent cannot choose to redirect an ordinary attack into Willpower.

### Area abilities

Skills and heal/buff items can include an optional `area` template. Only burst templates are supported in this version. Hostile areas exclude allies unless `friendlyFire` is true; the caster is only a legal area effect target for support auras. Terrain effects returned by the special resolver are confined to the resolved area and cannot entomb a living unit:

```json
{
  "name": "Fireball",
  "kind": "attack",
  "range": 8,
  "damage": "6d6",
  "area": {
    "shape": "burst",
    "radius": 2,
    "origin": "target",
    "friendlyFire": false
  }
}
```

- `radius` is measured in cells with Chebyshev distance (diagonals count as one). Radius 1 covers a 3×3 area; the maximum is 6.
- `origin: "target"` centers the burst on the chosen cell or primary target. `origin: "self"` is a self-centered aura.
- Hostile areas affect only units hostile to the caster unless `friendlyFire` is true. Heals and buffs affect friendly units and include the caster when inside the radius.
- Attacks roll separately against every affected target's AC; crits, cover, Willpower damage, and defeat work per target. A heal rolls once and applies the same amount to every affected ally.
- Hostile attack areas require line of sight from the caster to each affected cell. Cells behind walls are previewed as blocked and excluded. Heals, buffs, and special/resolver effects follow their own targeting rules.
- One cast consumes one skill use and one action/bonus action. An empty area is rejected without consuming either.
- Basic weapon attacks remain single-target. Multi-target attacks are authored as `kind: "attack"` skills with an `area`.

Authoring examples:

```text
Abilities: Fireball (6d6 fire, 8 cells, 1/1; Area: burst 2)
Abilities: Rallying Aura (allies within 2 cells gain +1 AC, 2/2; Area: aura 2)
Abilities: Whirlwind (1d8 slashing, self, 1/1; Area: aura 1, friendly fire)
```

Explicit `Area: burst N` / `Area: aura N` syntax wins. Common keywords such as `fireball`, `nova`, `shockwave`, `radius`, and `all enemies within N cells` are also recognized conservatively; a plain `N cells` phrase is treated as range, not radius. Use `Area: aura N` when the ability is centered on the caster; `Area: burst N` always centers on a chosen cell/target. Add `friendly fire` or `indiscriminate` to let a hostile area include allies.

When a skill is selected, the board highlights its range. Hovering a cell previews the center and every affected tile, including valid targets in red, support targets in green, blocked cells with a hatch pattern, and allied units that would be caught by `friendlyFire` in the warning colour. The **Show area-of-effect hover previews** setting disables only the hover overlay.

### Combat engagement state

`[COMBAT]` distinguishes an encounter roster from active combat:

```text
[COMBAT]
COMBAT STATE: DORMANT
ENEMIES:
Goblin: 12/12 HP
Willpower: 6/6
...
[/COMBAT]
```

- `DORMANT` — enemies are present and the encounter is still unresolved, but no hostile action has occurred. Negotiation, intimidation, surrender, parley, and withdrawal stay here while the standoff continues. The board does not open and initiative is not rolled. If the encounter ends without combat, the tracker emits `END_COMBAT` and the block is removed.
- `HOSTILE` — an attack, hostile spell, charge, or ambush was declared, or an enemy attacked. The board starts.
- `ACTIVE` — the board owns the encounter. Board-generated memo blocks write this automatically.
- Legacy blocks without a state header are treated as engaged for backward compatibility. `COMBAT ROUND 0` is treated as dormant.
- A block with no unresolved enemy is treated as ended even if its state line is stale. The tracker also auto-closes a block when a re-output accounts for every previously active enemy and all are resolved. Bare or trailing `END_COMBAT` output is accepted, and duplicate `[COMBAT]` blocks are replaced together.

`StartTacticalCombat` is only called for a real engagement, never for mere enemy presence, threats, standoffs, or a dormant roster. Automatic startup can be disabled in settings; the board can still be opened with **Start encounter**.

### Combat override

While Tactical Combat is enabled, ordinary narrative combat is disabled:

- The normal `<combat>` system-prompt section is replaced by a **TACTICAL COMBAT OVERRIDE** that forbids narrating attacks, damage, initiative, saves, enemy turns, or combat outcomes.
- When a fight actually begins — a hostile action is declared or `[COMBAT]` says `HOSTILE`/`ACTIVE` — the narrator calls `StartTacticalCombat` immediately. If no roster exists, the encounter architect builds one from the current scene and the board seeds the memo. Mere presence, standoffs, negotiation, and `DORMANT` rosters do not start the board.
- The player's immediately preceding action can be passed through `openingAction` (and `surprise` for an ambush), so the declared spell or attack resolves before normal turns instead of being lost.
- A runtime `[TACTICAL_COMBAT_OVERRIDE]` block is injected while a board encounter is active or `[COMBAT]` is engaged. A `[DORMANT_ENCOUNTER]` block is injected while the roster is dormant, telling the narrator to continue the non-combat scene without rolling initiative.

### Loadout classifiers

**Settings → Combat → Loadout Classifiers** exposes the JSON used by the memo parser:

```json
{
  "skillRules": [
    { "kind": "heal", "keywords": ["heal", "cure", "restore"] },
    { "kind": "special", "keywords": ["summon", "terrain", "transform"] },
    { "kind": "buff", "keywords": ["bless", "shield", "haste"] }
  ],
  "buff": {
    "acBonus": 2,
    "attackBonus": 1,
    "rounds": 2,
    "acKeywords": ["shield", "ward", "armor"],
    "attackKeywords": ["bless", "inspire", "haste"]
  },
  "rangedKeywords": ["ranged", "bolt", "arrow", "ray"],
  "bonusActionKeyword": "bonus action",
  "area": {
    "burstKeywords": ["fireball", "explosion", "nova", "shockwave", "radius", "all enemies within"],
    "selfKeywords": ["aura", "emanation", "around you", "centered on you"],
    "friendlyFireKeywords": ["friendly fire", "indiscriminate", "all creatures"],
    "singleTargetKeywords": ["single target", "one target", "one creature"],
    "defaultRadius": 1,
    "maxRadius": 6
  },
  "items": {
    "usableKeywords": ["potion", "scroll", "bomb"],
    "healingKeywords": ["potion", "heal", "cure"],
    "willpowerHealingKeywords": ["willpower", "morale", "resolve"],
    "specialItemKeywords": ["scroll", "bomb", "poison"]
  },
  "willpower": {
    "damageKeywords": ["willpower", "morale", "resolve"],
    "outcomeRules": [
      { "outcome": "flee", "keywords": ["fear", "terror", "panic"] },
      { "outcome": "switch_side", "keywords": ["dominate", "charm", "seduce"] },
      { "outcome": "incapacitate", "keywords": ["sleep", "stun", "paralyze"] },
      { "outcome": "surrender", "keywords": ["surrender", "yield", "cower"] }
    ],
    "complexKeywords": ["summon", "terrain", "transform", "polymorph"]
  }
}
```

`skillRules` are evaluated in order; the first keyword match decides `heal`, `buff`, or `special`, and unmatched abilities become `attack`. The `buff` block sets the actual AC bonus, attack bonus, and duration applied by parsed buffs. The `area` block controls conservative burst/aura inference: explicit `Area: burst N` / `Area: aura N` syntax always wins, `radius`/`within`/shape keywords are recognized, and `singleTargetKeywords` suppress accidental inference. Inventory keywords decide which lines become usable healing items versus special items. `willpower` maps mental/morale keywords to break outcomes. Invalid JSON falls back to the shipped rules and shows an error in the settings tab. Changes apply to the next encounter.

### Narrator tool

The narrator tool is enabled by default with the **Game Systems → Components → Tactical Combat (StartTacticalCombat tool)** component. Disable that component (or the `<tactical_combat>` section in the System Prompt Control Room) if your model/provider does not support function calling. The component adds the predefined `<tactical_combat>` instruction to the system prompt and exposes the function tool whenever tactical combat is enabled and no encounter/result is already in progress.

The main narrator calls the registered `StartTacticalCombat` function tool as soon as a real fight begins. Optional arguments: `title`, `location`, `description`, `reason`, `openingAction`, `openingTarget`, `openingSkill`, `surprise`, `enemyNames`. The tool:

1. Clears any concluded board and its stale memo roster before preparing a fresh encounter.
2. When a new roster must be designed, opens a **preparing** screen and defers the encounter architect until the main narrator generation ends. This keeps the architect out of the provider request that is already streaming and gives it the current scene and player declaration.
3. Replaces the provisional roster with the architect's encounter, seeds `[COMBAT]`, and starts deployment. If the architect fails or the narrator generation never finishes, **Use local roster** remains available and named enemy types are preferred over generic terrain rosters.
4. Resolves the declared opening action deterministically where possible; freeform/special effects are resolved after the narrator generation completes.
5. Returns a short status string to the model.

If an encounter is already active, it simply reopens the board. If Tactical Combat is disabled, it returns a message asking the player to enable it. The narrator is told not to resolve the fight itself.

The encounter architect receives the player's current declaration, optional named enemies, a `freshStart` flag, and a scene excerpt that excludes prior tactical result messages, tool rows, and system notices. Named enemy types in the player declaration take precedence over the terrain theme.

---

## The combat agent contract

The agent never mutates the board. It receives a JSON game state and returns a declarative action list. The local rules engine validates every action (turn ownership, action/movement budget, range, line of sight, terrain, skill/item uses) and rejects illegal entries with a log line.

### Game state (sent to the agent / downloadable from the board)

```json
{
  "format": "multihog-tactical-combat",
  "version": 1,
  "encounter": {
    "title": "Skirmish at the Sunken Keep",
    "location": "The Sunken Keep, Gatehouse",
    "description": "...",
    "round": 2,
    "phase": "enemy",
    "turnStyle": "phase"
  },
  "grid": {
    "rows": 15,
    "cols": 15,
    "coordinates": "x = column, y = row, both 0-indexed",
    "legend": { ".": "Open floor", "#": "Wall / rock", "o": "Cover (+2 AC)" },
    "terrain": ["...............", "....##..oo....."]
  },
  "rules": {
    "movement": 6,
    "allowFlee": true,
    "victory": "Defeat every enemy unit.",
    "defeat": "All player units are defeated.",
    "willpower": "Willpower is a morale pool ...",
    "area": "Area skills include an 'area' object. Choose a primary targetId; the engine centers the burst and hits every eligible unit in aoeTargets.",
    "actions": "- move: Move — ...",
    "actionTypes": ["move", "attack", "skill", "item", "defend", "wait", "flee"]
  },
  "units": [
    {
      "id": "enemy-3",
      "name": "Goblin Archer",
      "side": "enemy",
      "x": 12, "y": 7,
      "hp": 12, "maxHp": 12, "ac": 13,
      "willpower": 6, "maxWillpower": 6, "willpowerSave": 1,
      "attackBonus": 5, "attackRange": 6, "damage": "1d6+2",
      "speed": 6, "movementUsed": 0, "movementLeft": 6,
      "actionUsed": false, "bonusUsed": false,
      "statuses": [], "stats": { "str": 10, "dex": 14 },
      "skills": [
        { "id": "aimed-shot", "name": "Aimed Shot", "kind": "attack", "resource": "hp", "range": 6, "damage": "1d8", "uses": 2, "maxUses": 2, "area": null },
        { "id": "fireball", "name": "Fireball", "kind": "attack", "resource": "hp", "range": 8, "damage": "4d6", "uses": 1, "maxUses": 1, "area": { "shape": "burst", "radius": 2, "origin": "target", "friendlyFire": false } }
      ],
      "items": []
    }
  ],
  "unitsToMove": [
    {
      "unitId": "enemy-3",
      "reachableCells": [[11, 7], [12, 8]],
      "attackTargets": ["pc-1"],
      "skillTargets": { "aimed-shot": ["pc-1"] },
      "aoeTargets": { "fireball": { "pc-1": ["pc-1", "pc-2"] } }
    }
  ],
  "activationOrder": ["enemy-3"],
  "recentLog": ["R2 attack: ..."]
}
```

`reachableCells` already excludes walls, water, occupied cells, difficult-terrain overspend, and movement already spent. `attackTargets` and `skillTargets` already account for range and line of sight.

### Action response

```json
{
  "actions": [
    { "type": "move", "unitId": "enemy-3", "to": { "x": 11, "y": 7 } },
    { "type": "attack", "unitId": "enemy-3", "targetId": "pc-1" },
    { "type": "skill", "unitId": "enemy-4", "skillId": "aimed-shot", "targetId": "pc-2" },
    { "type": "skill", "unitId": "enemy-4", "skillId": "fireball", "targetCell": { "x": 12, "y": 7 } },
    { "type": "item", "unitId": "enemy-5", "itemId": "potion", "targetId": "enemy-5" },
    { "type": "defend", "unitId": "enemy-6" },
    { "type": "wait", "unitId": "enemy-7" },
    { "type": "flee", "unitId": "enemy-8" }
  ]
}
```

- Only units listed in `unitsToMove` may be controlled.
- For an area skill, `targetId` selects the primary target and the engine centers the burst on it. `targetCell` is accepted as an alternative center for precise placement. The affected ids are precomputed in `aoeTargets`; the agent never declares the full list.
- `move` accepts an optional `path`; otherwise the engine finds the shortest legal path to `to`.
- The parser tolerates markdown fences, leading/trailing prose, bare arrays, and one correction retry with the validation error appended.
- If the connection fails or returns no usable actions, a deterministic local tactics AI takes over for the remaining units. Combat never stalls because a model is offline.
- The board's export button downloads the game state as a `.json` file, matching what the agent receives.

### "Main connection interprets the actions"

The Combat Agent is only the decision layer. The extension's action interpreter is the authority: it maps each declarative action to the pure engine, rolls dice, applies damage, and writes the combat log. The main narrator then receives the final outcome, not the raw action list.

---

## Prompt customization

Four prompts are editable:

1. **Tactical agent system prompt** — the action JSON contract, ownership rules, tactics guidance, and output size limit.
2. **Encounter architect system prompt** — how to build a fair encounter from party, existing `[COMBAT]`, location, and scene. It can also return a terrain map using the legend characters. The party payload includes the full ability/spell/item/inventory loadout.
3. **Outcome-to-narration template** — the authoritative aftermath block injected into the next narrator generation. Supported placeholders:

   `{{title}}`, `{{location}}`, `{{outcome}}`, `{{rounds}}`, `{{trigger}}`, `{{survivors}}`, `{{fallen}}`, `{{fled}}`, `{{defeated}}`, `{{enemiesRemaining}}`, `{{allyState}}`, `{{partyState}}`, `{{highlights}}`, `{{finalState}}`, `{{details}}`, `{{summary}}`.

4. **Special ability resolver prompt** — used only for `kind: "special"` abilities/items. It converts summoning, terrain reshaping, and other complex effects into the engine's primitive effect list.

Each has a reset button. Prompts are sent verbatim with the JSON state appended.

### Action catalogue

The catalogue is JSON:

```json
[
  {
    "type": "attack",
    "label": "Attack",
    "enabled": true,
    "description": "Make one weapon or cantrip attack against a target in range."
  }
]
```

Valid `type` values are `move`, `attack`, `skill`, `item`, `defend`, `wait`, and `flee`. Reordering changes the order presented to the agent; the board keeps its fixed action layout. Invalid JSON never breaks combat: the shipped catalogue is used and the settings tab shows the parse error. Changes apply to the next encounter.

---

## Outcome and narration

When combat ends:

1. Final party HP is patched directly from the board into `[CHARACTER]`/`[PARTY]`, and `[COMBAT]` is closed with `[COMBAT]END_COMBAT[/COMBAT]`. This happens before the narrator sees the result.
2. If the State Tracker is enabled and **Update State Tracker before narration** is on, a finalization pass applies the authoritative final-state report before the result is queued.
3. A payload is queued in `settings.tacticalCombatReturnByChat[chatId]` with the title, location, outcome, rounds, player/ally/enemy survivors, fallen, fled, defeated enemies, opening action, highlights, compact final unit state, and the resource ledger. `settings.tacticalCombatReturn` remains a legacy mirror of the most recently queued payload.
4. The board shows a result dialog. **Return to narration** closes the board and calls the main `generate('normal')`. If automatic return is enabled, this happens after the tracker sync and a short delay.
5. On the next real narrator generation, `rpgTrackerInterceptor` appends the rendered outcome as a dedicated system/narrator message at the end of the prompt. A short notice in the user message states that the previous player action was already resolved. The payload is cleared only after a real assistant message consumes it; stopped, quiet/impersonate, or failed generations keep it queued.
6. If automatic return is disabled or generation is busy, the payload stays queued for the user's next message.

---

## Persistence and chat switching

- The board lives in `settings.tacticalCombatByChat[chatId]`; it survives reloads and does not participate in Chat Link projections.
- A chat switch aborts any in-flight agent request, resets the selection, and redraws the arriving chat's board (or the empty state).
- Ended encounters are retained for review. Up to 16 chats are kept; inactive old boards are pruned as new ones are created.
- **Clear board** removes the current chat's encounter after confirmation. It does not clear the pending narration block.
- The `[COMBAT]` memo block is only closed on combat end; starting a tactical encounter does not rewrite the memo mid-fight.

---

## Architecture

| File | Responsibility |
|---|---|
| `tactical-combat-constants.js` | Terrain, action types, grid presets, themes, defaults. |
| `tactical-combat-willpower.js` | Willpower vocabulary, derived max values, resource/outcome normalization. |
| `tactical-combat-prompts.js` | Shipped prompt templates + placeholder renderer. |
| `tactical-combat-actions.js` | Catalogue validation, response parsing, action normalization/allow-lists. |
| `tactical-combat-engine.js` | Pure grid/dice/rules engine: terrain, placement, movement, LOS, attacks, burst/area templates, skills, items, turn flow, outcomes, agent state. |
| `tactical-combat-context.js` | Memo parsing (`[CHARACTER]`, `[PARTY]`, `[COMBAT]`, `[INVENTORY]`), location/theme inference, fallback roster/encounters. |
| `tactical-combat-agent.js` | Encounter architect + tactical agent requests, correction retries, local tactics fallback, connection probe. |
| `tactical-combat-store.js` | Per-chat board and pending-narration persistence. |
| `tactical-combat-memo.js` | Deterministic board → `[COMBAT]`/party HP synchronization and the tracker final-state report. |
| `tactical-combat-outcome.js` | Memo closure, outcome payload, narration block, automatic continuation. |
| `tactical-combat-markup.js` | Pure HTML for the board, sidebar, legend, log, and result dialog. |
| `tactical-combat-ui.js` | Overlay controller, targeting, delegated events, async agent turns, export. |
| `tactical-combat-settings.js` | Settings tab binding, catalogue validation, board launchers. |

Integration points: `index.js` (init, connection binder, chat switch), `narrative-hooks.js` (one-shot outcome injection/clear), `settings.html`, `src/ui/settings-overlay.js`, `src/state/defaults.js`, `src/state/settings.js`, `src/state/connection-setups.js`, `style.css`, `src/ui/panel/panel-markup.js`.

---

## Tests

```bash
npx vitest run --pool=threads
```

The tactical suites cover terrain/grid generation, placement, movement and difficult terrain, LOS, attacks/crits, skills/items/defend, burst/aura area resolution and previews, phased and initiative turn flow, outcomes/retreat, memo parsing, architect/action payload validation, correction retries, local AI fallback, markup escaping/legend/result dialog, outcome handoff, per-chat storage, settings/UI contracts, Willpower derivation/breaks, side switching, transformations, and enemy special resolution.

> On Android/Termux the default Vitest `forks` pool cannot spawn workers; use `--pool=threads`. The `vitest.config.js` in this fork sets `pool: 'threads'` so `npm test` works there too.

---

## Current limitations

- Areas support burst/aura templates only; line, cone, and custom-cell templates are not implemented yet.
- Reactions/opportunity attacks are tracked but not yet used by an action.
- The memo parser is tolerant but heuristic; it prioritizes listed totals (`Total AC`, melee/ranged attack values) and falls back to derived values.
- Enemy `[COMBAT]` skill text is parsed heuristically; ambiguous abilities may become a generic attack or buff.
- Automatic narration calls the main generation API; if another generation is running, the queued result waits for the next message instead.
- Willpower transformations and side changes are encounter-scoped and revert after combat by default. Permanent changes must be narrated and applied by the State Tracker.
- Enemy special resolution is capped per activation batch (default two; configurable 0–4) to keep token usage bounded.
