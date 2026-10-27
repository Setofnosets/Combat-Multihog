# Traditional Combat

Traditional Combat is the no-grid turn-based mode of the Multihog D&D Framework. It is designed for Pokémon/SMT-style encounters: choose an action, choose a legal target, and let the deterministic engine resolve it. The AI agent declares enemy actions; it never mutates the board or invents outcomes.

## Enabling it

1. Open **Settings → Combat**.
2. Set **Combat style** to **Traditional — turn-based, no grid**.
3. Choose a turn style:
   - **Initiative** — 1d20 + initiative modifier, one unit at a time.
   - **Phased** — every party unit acts, then every enemy unit acts.
4. Optionally configure a dedicated agent connection and prompt templates under the Traditional Combat pane.
5. Talk to the narrator until a fight begins, or press **Start encounter**.

## Rules

- The whole party participates; there is no movement, facing, cover, range, or line of sight.
- Each unit gets one main action and optionally one bonus action per turn.
- Actions are driven by the traditional action catalogue: Attack, Skill, Item, Defend, Wait, and Flee. `move` is not valid.
- Attack and harmful skills target living enemies. Heals/buffs and items target living allies or the caster. Special skills may target any living unit.
- Natural 20 is a critical; natural 1 always misses. Damage, healing, statuses, Willpower, transformations, summons, side changes, and retreat work exactly as in tactical combat.
- Terrain-altering special effects are rejected in this mode. Summons join the caster's side and act from the next round.
- Specials share the Campaign Skill Registry used by Tactical Combat: the first successful resolution becomes canonical, later uses expand the stored recipe without another AI call, and transformations reuse registered forms. Terrain primitives remain invalid here.
- An opening attack/spell declared before the fight resolves before Round 1; an ambush costs the enemy its first activation.

## AI contract

```json
{
  "actions": [
    { "type": "attack", "unitId": "enemy-1", "targetId": "pc-1" },
    { "type": "skill", "unitId": "enemy-2", "skillId": "dread-wail", "targetId": "pc-2" },
    { "type": "item", "unitId": "enemy-3", "itemId": "potion", "targetId": "enemy-1" },
    { "type": "defend", "unitId": "enemy-4" }
  ]
}
```

The agent receives `unitsToAct`, `attackTargets`, `skillTargets`, `itemTargets`, the action catalogue, and the encounter state. The engine validates turn ownership, action budgets, uses, and targets. If the agent is unavailable, a local deterministic fallback takes over.

## Outcome

When the encounter ends, final HP/Willpower, terminal Status, spell-slot lines, ability uses, and inventory quantities are written into `[CHARACTER]`/`[PARTY]`, `[SPELLS]`/`[ABILITIES]`, and `[INVENTORY]`; `[COMBAT]` is closed and an authoritative result is queued for the narrator. Pending results are stored per chat (`tacticalCombatReturnByChat`) so ending fights in two chats cannot overwrite the first narration; the payload's `kind` selects the correct narration template and bridge text.

## Sharing with tactical combat

Traditional combat uses the tactical engine's combat primitives through a theater adapter:

- `collectEncounterContext`, memo parsing, loadouts, classifiers, and fallback enemies.
- Dice/RNG, unit normalization, attacks, skills, items, Willpower, statuses, special effects, opening actions, and outcome summaries.
- Initiative/phased turn flow and agent turn orchestration.
- Memo synchronization, tracker finalization, and narration handoff.

Only the state builder, agent payload/prompt, roster UI, and settings binder are new. The tactical engine's grid remains untouched for tactical mode. Tactical `area` templates are ignored in traditional combat; traditional actions remain single-target.

## Persistence

Each chat's board is stored in `extension_settings.rpg_tracker.traditionalCombatByChat[chatId]`. The board survives reloads and switches with the chat, like the tactical board. Pending narration lives in `tacticalCombatReturnByChat[chatId]`; `tacticalCombatReturn` remains a legacy mirror of the most recently queued result. Caster sheets use `Spell Atk` for spell attack rolls; `Spell DC` is preserved for save-based rules that are still pending.
