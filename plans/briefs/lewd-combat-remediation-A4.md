# Brief — lewd-combat-remediation A4 (pair-level act/stance state + pairing actions)

## Depends on

A3 landed (capability helpers, `requires.targetAnatomy`, actor/target gating in
`listLegalActions` + `applyLewdAction`, agent `disabledActions`). Keep all A3
gates and A2 metadata intact.

## Files (scope)

- `src/features/lewd-combat/lewd-combat-pairing.js`
- `src/features/lewd-combat/lewd-combat-states.js`
- `src/features/lewd-combat/lewd-combat-techniques.js`
- `src/features/lewd-combat/lewd-combat-engine.js`
- `src/features/lewd-combat/lewd-combat-markup.js`
- `src/features/lewd-combat/lewd-combat-ui.js` — only if the composer needs a new
  view field; do not change lifecycle/prose/outcome.
- `tests/lewd-combat-pairing.test.js`
- `tests/lewd-combat-markup.test.js`
- `tests/lewd-combat-techniques.test.js`
- `tests/lewd-combat-engine.test.js`
- `style.css` — only small classes for the pair header/act meta if needed.

## 1. Edge data model (pairing.js)

Every engagement edge gains:

```
act: string|null            // active act id, e.g. 'penetration'
actType: string|null        // LEWD_ACT_TYPES family
actRole: string|null        // give|receive|mutual
actIntensity: number        // 0..5, 0 when no act
actStartedRound: number     // round the current act started (0 when none)
bindings: number            // 0..5 restraint level
bindingsStartedRound: number
pairStance: object|null     // same shape as participant.stance
```

- `upsertEngagement(state, a, b, patch)` writes/updates these keys when present
  in `patch`; `patch.act = null` clears `act/actType/actRole/actIntensity/
  actStartedRound` but leaves `bindings` untouched. Keep existing `hold`,
  `stance`, `sinceRound`, `refreshedRound`, `intensity` behavior and the
  partner-cap semantics unchanged.
- Defaults on creation: `act:null, actType:null, actRole:null, actIntensity:0,
  actStartedRound:0, bindings:0, bindingsStartedRound:0, pairStance:null`.
- `expireEngagements(state, round, ttl)`: edges that survive but were **not
  refreshed in the current round** (`refreshedRound < round`) decay:
  `bindings = max(0, bindings - 1)`, `actIntensity = max(0, actIntensity - 1)`.
  If `bindings` drops to 0, clear `bindingsStartedRound`. Do not clear the act
  automatically; only `withdraw`/`release` or edge removal does.
- `buildPairingMatrix` cells add `act`, `actType`, `actRole`, `actIntensity`,
  `actStartedRound`, `bindings`, `bindingsStartedRound`, `pairStance`.
- Keep `refreshEngagedWith`, `canEngageWith`, holds, and escape behavior intact.

`lewd-combat-states.js`:
- Export `normalizePairStance(value, fallbackRounds = 3)` (reuse
  `normalizeStance`) and `clearPairStance(edge)` if useful. Do not change
  `normalizeStance` semantics.

## 2. Technique schema additions (techniques.js)

Extend `requires` (unknown keys still error):
- `minIntensity`: integer 0–5
- `bindings`: integer 0–5
- `pairStance`: string id/label

Extend `applies` (unknown keys still error):
- `intensityDelta`: number -5..5
- `bindingsDelta`: number -5..5
- `bindings`: number 0–5 (absolute set)
- `pairStance`: string/object, normalized with `normalizePairStance`
- `stance`: now accepts an optional `target: 'actor'|'target'|'pair'`
  (default `'actor'`; invalid values are validation errors). Preserve the
  existing normalized shape otherwise.

`listLegalActions` / target gating: extend the existing act requirement check so
each target is disabled with:
- `Requires act intensity N.` when `requires.minIntensity` is not met
- `Requires bindings N.` when `requires.bindings` is not met
- `Requires pair stance: <x>.` when `requires.pairStance` is not met
Keep the existing `Requires active act: …` / `Requires act role: …` reasons.

## 3. Catalog metadata updates

Update the explicit acts to use the pair state (keep ids/names/zones/effects):

| id | requires | applies |
| --- | --- | --- |
| `penetration-start` | existing anatomy | `act: {id:'penetration', intensity:1}` |
| `thrust` | `act:'penetration'` | `act:{id:'penetration'}`, `intensityDelta:0` |
| `thrust-harder` | `act:'penetration', minIntensity:1` | `intensityDelta:+1` |
| `slow-down` | `act:'penetration', minIntensity:1` | `intensityDelta:-1` |
| `deepen` | `act:'penetration', minIntensity:2` | `intensityDelta:+1` |
| `withdraw` | `act:'penetration'` | `act:null` |
| `change-position` | `act:'penetration'` | `stance:{id:'entwined',target:'pair'}` |
| `oral-give` | existing | `act:{id:'oral', intensity:1}` |
| `oral-deepen` | `actType:'oral', minIntensity:1` | `intensityDelta:+1` |
| `sixty-nine` | existing | `act:{id:'oral', role:'mutual', intensity:2}` |
| `manual-stroke` | existing | `act:{id:'manual', intensity:1}` |
| `manual-tease` | `actType:'manual', minIntensity:1` | `intensityDelta:0` |
| `mutual-masturbation` | existing | `act:{id:'masturbation', role:'mutual', intensity:1}` |
| `paizuri` | existing | `act:{id:'paizuri', type:'manual', intensity:1}` |
| `intercrural` | existing | `act:{id:'intercrural', type:'manual', intensity:1}` |
| `tie-bindings` | existing | `act:{id:'bondage', intensity:1}`, `bindingsDelta:+1` |
| `tighten-bindings` | `act:'bondage', bindings:1`, existing skill | `bindingsDelta:+1` |
| `loosen-bindings` | `bindings:1` | `bindingsDelta:-1` |
| `tease-bound` | `bindings:1` | no pair mutation |
| `release-bindings` | `bindings:1` | `act:null`, `bindingsDelta:-5` |
| `tail-wrap` | existing anatomy | `act:{id:'tail-wrap', type:'other', intensity:1}` |
| `tail-penetration` | existing anatomy + `act:'penetration', minIntensity:1` | `act:{id:'tail-penetration', type:'penetration', intensity:2}` |

## 4. Engine application (engine.js)

In the hit block of `applyLewdAction`, for each non-actor target apply the pair
effects once per edge:

- Resolve/create the edge (`engage(state, actor, target)`).
- `applies.act` (only when the key is present):
  - `null` → clear act/type/role/intensity/startedRound.
  - object → set id/type/role; `actIntensity = applies.act.intensity ??
    (existing ? existing : 1)` clamped 0–5; `actStartedRound = state.round` when
    the act id changed or there was no act.
- `applies.intensityDelta` → only when an act is active; add and clamp 0–5.
- `applies.bindings` (absolute) / `applies.bindingsDelta` → clamp 0–5; set
  `bindingsStartedRound = state.round` when it rises above 0.
- `applies.pairStance` → set `edge.pairStance` and mirror `edge.stance` to the
  same stance object (backwards compatibility), with `appliedRound`.
- `applies.stance.target`:
  - `actor` (default): current behavior (`actor.stance`, entry.stance).
  - `target`: apply to each hit target (not the actor); store in entry.
  - `pair`: apply to both actor and target and mirror onto the edge
    (`edge.stance = edge.pairStance = normalized`).
- Add a readable `entry.pair` object `{ act, actType, actIntensity, bindings,
  pairStance }` and a `stateChanges` line such as
  `Aria ↔ Bran: penetration intensity 2, bindings 1.` only when pair state
  changed. Keep beat/log shape additive.
- Never mutate pair state on a miss. Group/pair actions apply per hit target and
  must not leak state to unpaired participants.

## 5. Markup/UI

- Pairing matrix cells (`renderMatrix` in `lewd-combat-markup.js`) include the
  act label/type, intensity, bindings, and pair stance in the cell title and
  visible bits, e.g. `penetration 2 · bindings 1 · entwined`.
- Action composer: add a `rt-lc-pair-state` block above the technique buttons
  listing each engaged pair for the selected actor:
  `Pair: Aria ↔ Bran · act: penetration · intensity 2 · bindings 1 · stance: entwined`
  (omit absent fields; show `not paired` when none).
- Group follow-up techniques under a visible header: entries whose technique has
  `requires.act` or `requires.actType` go into a `Follow-ups · <Act>` group
  before/after the normal category groups. Keep disabled buttons/reasons intact.
- `lewd-combat-ui.js`: only if needed to pass a view/target selection; action
  resolve already sends `techniqueId`, `targetIds`, `zone`, `posture`.
- Keep markup escaping and accessibility (`aria-label`, `title`) consistent.

## 6. Tests

`tests/lewd-combat-pairing.test.js`:
1. `upsertEngagement` writes act/type/role/intensity/startedRound/bindings/
   pairStance and clears act on `act:null` without touching bindings.
2. `buildPairingMatrix` cells expose the new fields.
3. `expireEngagements` decays bindings/intensity for a stale surviving edge and
   leaves a refreshed edge unchanged.

`tests/lewd-combat-techniques.test.js`:
4. `thrust-harder` is disabled without an active penetration/intensity 1 and
   legal after `edge.act='penetration', actIntensity=1`.
5. `tighten-bindings` requires `bindings >= 1`; `requires.bindings`/`minIntensity`/
   `pairStance` validate and reject bad values.
6. `applies.intensityDelta`/`bindingsDelta`/`pairStance`/`stance.target`
   normalize; unknown target values error.

`tests/lewd-combat-engine.test.js`:
7. `penetration-start` creates `edge.act='penetration'`, type, intensity and
   `actStartedRound`; `thrust-harder` raises intensity (clamped); `slow-down`
   lowers it; `withdraw` clears the act.
8. `tie-bindings` raises bindings; `tighten-bindings` requires bindings and
   raises it; `release-bindings` clears act and bindings; `tease-bound` is
   disabled at bindings 0.
9. `change-position` writes a pair stance on the edge and both participants;
   `applies.stance.target='target'` affects only the target; no other pair's
   edge changes; a miss does not mutate pair state.

`tests/lewd-combat-markup.test.js`:
10. Matrix renders act/intensity/bindings; composer renders the pair header and
    the Follow-ups group with the act label.

## Gate

- `npx vitest run tests/lewd-combat-pairing.test.js tests/lewd-combat-markup.test.js tests/lewd-combat-techniques.test.js tests/lewd-combat-engine.test.js tests/lewd-combat-agent.test.js tests/lewd-combat-context.test.js --pool=threads`
- `npx vitest run --pool=threads` must be green. Do not commit.

## Constraints

- No new dependencies. Pair mutations happen only on a successful hit.
- Keep existing exported signatures backwards compatible; new fields are
  additive and hydrated legacy edges get safe defaults.
- Never use `Math.random`; no lifecycle/prose/outcome changes.
- Do not remove the existing generic `edge.intensity` counter; `actIntensity` is
  the act ladder and `intensity` stays the pairing refresh counter for
  compatibility.
