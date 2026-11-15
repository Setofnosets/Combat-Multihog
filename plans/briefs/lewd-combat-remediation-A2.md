# Brief — lewd-combat-remediation A2 (explicit act catalog)

## Depends on

A1 landed. The profile contract is now:
`anatomy[]`, `skills[]`, `kinks[]`, `body`, `species`, `sourceSkills[]`,
`sourceTraits[]`, `provenance`, `inferredFields`. A2 must not change it.

## Files (scope)

- `src/features/lewd-combat/lewd-combat-techniques.js`
- `src/features/lewd-combat/lewd-combat-compendium.js`
- `src/features/lewd-combat/lewd-combat-compiler.js`
- `tests/lewd-combat-techniques.test.js`
- `tests/lewd-combat-compendium.test.js`
- `tests/lewd-combat-engine.test.js` — **only** assertions broken by the larger
  shipped catalog (no behavior changes).

Do **not** touch the engine's `applyLewdAction`, pairing state, markup/composer
UI, or the outcome/lifecycle. A2 is the *definition + validation + legality*
layer; A3 enforces anatomy gating and A4 writes live edge act/bindings state.
The `withdraw` → clear-act transition is therefore defined here (metadata) and
wired by A4; do not add engine mutation in A2.

## 1. Schema extensions

In `lewd-combat-techniques.js` export and use:

- `LEWD_ACT_TYPES = ['penetration','oral','manual','bondage','masturbation','other']`
- `LEWD_ACT_ROLES = ['give','receive','mutual']`

Canonical technique additions (all optional, default `null`):

- `actType`, `actRole` — validated against the enums; unknown values are a
  validation error.
- `requires` may now contain: existing `hold`, `stance`, `overwhelmed`, plus
  `act` (string id/type), `actType`, `actRole`, `anatomy`, `skill`, `trait`,
  `kink`. Unknown requirement keys remain an error. (A4 will add
  `minIntensity`, `bindings`, `pairStance`; do not add those yet.)
  - `anatomy` accepts `string`, `string[]` (all-of), or
    `{ all: string[], any: string[] }`; every tag is normalized with
    `normalizeLewdAnatomy` from the profile module. Unknown tags are an error.
  - `skill`/`trait`/`kink` accept a string or string array; normalize to
    lowercase trimmed tokens.
- `applies` may now contain `act` (in addition to `status`, `stance`).
  - `applies.act` accepts a string id or `{ id, type?, role? }`; normalize to
    `{ id, type, role }` with `type`/`role` defaulting to the technique's
    `actType`/`actRole`. `applies.act: null` is preserved as `null` and means
    **clear the pair's act** (used by withdraw/release). Unknown applies keys
    remain an error.
- Add `DEFAULT_LEWD_TECHNIQUE` defaults for the new fields
  (`actType: null`, `actRole: null`; requires/applies defaults stay empty).
- Keep `schemaVersion` at 1 unless you need a bump; if you bump it, update
  every canonical-shape doc comment and the compiler example.
- Update the module header doc comment to show the new shape.

## 2. Legal-action surface (declarative only)

Extend `listLegalActions` (this file) with per-target reasons:

- `requires.act` / `requires.actType` / `requires.actRole`: the target is legal
  only when an engagement edge exists between actor and target whose
  `act`/`actType`/`actRole` match. Accept `edge.act` as a string or
  `{ id, type }`. `actRole: 'mutual'` matches either side; `give`/`receive`
  must match exactly. When absent, reason:
  `Requires active act: <act|actType>.<` and `Requires act role: <role>.`
- `requires.bindings` is not added in A2 (A4).
- `requires.anatomy` / `skill` / `trait` / `kink` are validated/stored but the
  gating itself is A3 — do not implement actor-anatomy gating here.
- Do not change any existing reason strings or the `disabled` contract.

Add `actType`, `actRole` to the entry returned by `listLegalActions` so the
composer/agent can group them later.

## 3. Shipped catalog additions

Keep all 28 existing foreplay entries unchanged as the lead-in/tease layer.
Add the explicit acts below (ids are the contract; keep them stable). Every
entry needs explicit `zones`, `targetMode`, `posture`, `arousal`, `poise`,
`staminaDrain` where meaningful, `tags`, `requires`, `applies` where relevant,
and `ai` priority/conditions.

Penetration (`actType: 'penetration'`):

| id | name | role | zones | requires | applies |
| --- | --- | --- | --- | --- | --- |
| `penetration-start` | Penetration | give | genitals | anatomy any (penis OR vagina/tail) | act `{id:'penetration'}` |
| `penetration-receive` | Take It | receive | genitals | anatomy any receptive | act same, role receive |
| `thrust` | Thrust | give | genitals, hips | act penetration | act intensity `1` |
| `thrust-harder` | Thrust Harder | give | genitals | act penetration | intensity `2` |
| `slow-down` | Slow Down | give | genitals | act penetration | intensity `1` |
| `deepen` | Deeper | give | genitals | act penetration | intensity `3` |
| `withdraw` | Withdraw | give | genitals | act penetration | `act: null` |
| `change-position` | Change Position | mutual | genitals, full_body | act penetration | `stance` (Entwined) |

Oral (`actType: 'oral'`): `oral-give`, `oral-receive`, `oral-deepen`,
`sixty-nine` (mutual). At least one requires `anatomy` and one requires
`requires.actType: 'oral'` for the follow-up.

Manual / masturbation (`actType: 'manual'` or `'masturbation'`):
`manual-stroke`, `manual-tease`, `mutual-masturbation`, `paizuri` (requires
anatomy `breasts`), `intercrural` (thighs).

Bondage (`actType: 'bondage'`): `tie-bindings`, `tighten-bindings`,
`loosen-bindings`, `tease-bound`, `release-bindings`. Tie/tighten require the
`bondage` skill or `bondage-gear` anatomy; `tighten-bindings` requires an
active act `bondage`; `release-bindings` uses `applies.act: null`. These are
the acts A4 will map onto `edge.bindings`; in A2 they are legal-shaped
definitions with explicit zones (`hands`, `full_body`).

Tail (`actType: 'penetration'` or `'other'`): `tail-wrap` (requires anatomy
`tail`, zone `tail`), `tail-penetration` (requires anatomy `tail` +
penetration act).

All new entries must be valid through `validateLewdTechnique` and must not
invent hard limits. Categories use the existing enum; use `technique` for
acts, `tease` for follow-up teasing, `hold` only where a `hold` object is
genuinely defined (bondage tie may set a `restrained` hold), `finisher` for
the penetration climax variants if you add one.

Update the shipped-catalog test range to the new real count (assert a range
that reflects the catalog, e.g. 45–70) and keep asserting every category
exists and every entry validates.

## 4. `[LEWD_TECHNIQUES]` DSL (compendium)

Extend `parseTechniqueLine` to accept the new fields as `key: value` parts:

- `acttype`, `actrole` → `actType` / `actRole`
- `requiresact`, `requiresacttype`, `requiresactrole`, `requiresanatomy`,
  `requiresskill`, `requirestrait`, `requireskink` → the matching
  `requires.*` keys (`requiresanatomy` splits on commas into an array).
- `appliesact`, `appliesintensity` (optional; ignore if unsupported) →
  `applies.act`. `appliesact: none` or an empty value → `applies.act = null`.
- Keep `requireshold`, `requiresstance`, `overwhelmed`, `status`, `stance`
  working exactly as today.
- Unknown fields must still fail validation; do not silently coerce.

## 5. Compiler

In `lewd-combat-compiler.js`:

- `DEFAULT_LEWD_COMPILER_PROMPT`: add act/role rules, the new zone list
  (`lips, neck, ears, chest, breasts, nipples, back, waist, hips, groin,
  genitals, thighs, hands, feet, throat, mouth, tail, full_body`), and the new
  schema keys (`actType`, `actRole`, `requires.act`,
  `requires.actType`, `requires.actRole`, `requires.anatomy`,
  `requires.skill`, `requires.trait`, `requires.kink`, `applies.act`).
- `LEWD_COMPILER_JSON_SCHEMA`: add `actType` enum, `actRole` enum, and type
  entries for `requires`/`applies` (objects; keep them permissive like today,
  but list the new properties in the prompt and example).
- `LEWD_COMPILER_EXAMPLE` inherits the new defaults automatically.
- `parseLewdCompilerResponse` must keep rejecting unknown categories/zones and
  must accept a valid explicit act (add a test).

## 6. Tests

`tests/lewd-combat-techniques.test.js`:

1. Shipped catalog count/range is updated; every entry still validates and
   every category still exists.
2. `actType`/`actRole` accepted, unknown act type/role rejected.
3. `requires.act` follow-up (`thrust-harder`) is disabled without an active
   penetration edge; with `upsertEngagement` + `edge.act = 'penetration'` (or
   `{id:'penetration', type:'penetration'}`) it becomes legal.
4. `requires.actType: 'bondage'` / `requires.act` entry is disabled without the
   act; `requires.anatomy: 'tail'` and `requires.skill: 'bondage'` normalize
   correctly and unknown anatomy tags error.
5. `withdraw` carries `applies.act === null`; `penetration-start` carries a
   normalized `applies.act`.
6. `bondage` entries are present and `tighten-bindings` requires an act.
7. Existing foreplay tests and the full `listLegalActions` contract stay green.

`tests/lewd-combat-compendium.test.js`:

8. A `[LEWD_TECHNIQUES]` line with `acttype:`/`actrole:`/`requiresact:`/
   `appliesact:` parses into the canonical fields; an invalid `acttype`
   produces a diagnostic and drops that line only.
9. Compiler accepts a valid explicit act payload; still rejects an invalid
   zone (update a stale `tail`-invalid fixture to another invalid zone if A1
   did not already).

`tests/lewd-combat-engine.test.js`: only adjust assertions that assumed the
old catalog size/last technique; no engine behavior changes.

## Gate

- `npx vitest run tests/lewd-combat-techniques.test.js tests/lewd-combat-compendium.test.js tests/lewd-combat-engine.test.js tests/lewd-combat-agent.test.js tests/lewd-combat-pairing.test.js tests/lewd-combat-context.test.js --pool=threads`
- `npx vitest run --pool=threads` must be green before handoff. Do not commit.

## Constraints

- No new dependencies. The catalog is plain data; keep entries mechanical and
  terse (no explicit prose).
- Do not change existing ids, names, or numerical behavior of the 28 shipped
  entries.
- Unknown schema fields/categories/zones/act enums stay validation errors.
- `listLegalActions` remains pure and never mutates `state`.
- All new entries must survive `buildLewdTechniqueCatalog` and the
  compile-once cache round-trip.
