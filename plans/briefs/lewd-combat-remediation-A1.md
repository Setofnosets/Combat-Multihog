# Brief — lewd-combat-remediation A1 (profile anatomy, skills, kinks, trait foundation)

## Depends on

Phase 1 (B1–B5) is landed and green; keep its behavior intact. A2 depends on this
step, so the profile/catalog data contract you define here must be stable:
`anatomy[]`, `skills[]`, `kinks[]`, `body`, `species`, `sourceSkills[]`,
`sourceTraits[]`, `provenance`, `inferredFields` on every canonical profile.

## Files (scope)

- `src/features/lewd-combat/lewd-combat-profile.js`
- `src/features/lewd-combat/lewd-combat-constants.js`
- `src/features/lewd-combat/lewd-combat-context.js`
- `src/features/lewd-combat/lewd-combat-engine.js` — only `buildParticipant`,
  `hydrateLewdState`, and `normalizeProfile` (copy/normalize the new profile
  arrays; do not touch combat math).
- `src/features/lewd-combat/lewd-combat-agent.js`
- `constants.js` (stock `[LEWD]` prompt only)
- `src/state/schema-sections.js` (`LEWD_DESIRES_SECTION` description only)
- `tests/lewd-combat-profile.test.js`
- `tests/lewd-combat-context.test.js`
- `tests/lewd-combat-techniques.test.js` — **only** the zone-validity
  assertions broken by making `tail` a valid zone.
- `tests/lewd-combat-compendium.test.js` — **only** the zone-validity
  assertions broken by making `tail` a valid zone.
- `tests/lewd-combat-agent.test.js` — only the new payload fields.

Do **not** touch `lewd-combat-techniques.js` catalog entries, engine math,
outcome/lifecycle, prose, UI, settings defaults, or `narrative-hooks.js`.

## 1. Anatomy tags and zones

In `lewd-combat-constants.js` add frozen exported lists:

- `LEWD_ANATOMY_TAGS = ['penis','testes','vagina','vulva','anus','breasts','tail','wings','tentacles','knot','bondage-gear']`
- `LEWD_ANATOMY_ALIASES` (object): cock/dick→penis, balls/testicles→testes,
  pussy/cunt→vagina, anus/ass→anus, boobs/breast→breasts, tails→tail,
  wing→wings, tentacle→tentacles, restrained/restraints→bondage-gear.
  Only these literal words map; never derive any anatomy from gender.

In `lewd-combat-profile.js`:

- Add `'tail'`, `'genitals'`, `'throat'`, `'mouth'` to `LEWD_ZONES` and
  `DEFAULT_ZONE_SENSITIVITY` (reasonable values: tail 1.3, genitals 1.9,
  throat 1.4, mouth 1.3). Add aliases: tail, genital/genitals/groin? **No**:
  keep `groin` as its own zone; add genital/genitals→genitals,
  throat→throat, mouth/lips? keep lips separate; mouth→mouth.
- Export `normalizeLewdAnatomy(value)` → canonical anatomy tag or `''`.
- Update the existing test that asserts `normalizeLewdZone('tail') === ''` and
  the sensitivity test that expects `tail` to be an unknown zone. These are
  contract updates, not regressions.

## 2. `[LEWD]` grammar and canonical profile

Extend `FIELD_ALIASES` and `parseKeyValueFields` with: `anatomy`, `skills`,
`kinks`, `body`, `species`. Keep `skill` → `experience` for backwards
compatibility; `skills` (plural) is the new list field.

`traits=` keeps its existing numeric-modifier meaning but non-numeric tokens
are no longer errors: a token with no `+/-` (e.g. `tail`, `bondage`) is stored
as a capability tag in `sourceTraits`; a token that looks numeric but does not
match `TRAIT_RX` (e.g. `luck+1`) still warns and is dropped. `traits=tail`
must therefore produce `sourceTraits: ['tail']` and also add `tail` to
`anatomy` (a trait token that normalizes as anatomy is anatomy).

`normalizeLewdProfile(fields, options)` must return these additional fields
(always present, never undefined):

- `anatomy: string[]` — canonical, de-duplicated, from `fields.anatomy`.
- `skills: string[]` — normalized lowercase tokens from `fields.skills`.
- `kinks: string[]` — normalized lowercase tokens from `fields.kinks`.
- `sourceSkills: string[]` — names of `unit.skills` (`{name}` or string), plus
  `options.sourceSkills`; de-duplicated, never treated as engine skills.
- `sourceTraits: string[]` — non-numeric `traits=` tokens plus
  `options.sourceTraits`.
- `body: string` (≤ 300 chars), `species: string` (≤ 80 chars).
- `provenance: Record<string, string|object>` — per-field source map. Use
  `{ anatomy: { penis: 'lewd' }, skills: { bondage: 'tracker' }, body: 'card' }`
  style. Every value that came from inference records its source bucket.
- `inferredFields: string[]` — field names filled by inference (e.g.
  `['anatomy','species']`).
- `inferred` stays `true` when the canonical profile came from inference.

`normalizeLewdProfile` must accept already-normalized arrays (idempotent).

## 3. Deterministic inference pass

Add exported pure functions (no SillyTavern imports, no network):

- `extractProfileSourceText(memo, name)` — return the tracker text that belongs
  to one character: scan `[CHARACTER]`, `[PARTY]`, `[COMBAT]` blocks with the
  existing header rules and return that character's contiguous lines (Species,
  Body, Appearance, Personality, Traits, Strengths, Status, prose notes), or
  `''`. Never return another combatant's lines.
- `collectProfileSignals(sources)` where `sources = { unit, card, trackerText,
  lorebookText, notes }`; returns
  `{ anatomy, skills, kinks, body, species, provenance }`.
  - `card` accepts a SillyTavern character object and reads `description`,
    `personality`, `scenario`, `mes_example`/`example_dialogue`; also accept a
    plain string.
  - Scan **literal** anatomy words via `LEWD_ANATOMY_ALIASES`. Never infer
    genitals/breasts from gender words (`female`, `male`, `woman`, `man`).
  - Skills need a literal skill word (bondage, ropework, shibari, restraint,
    seduction, teasing, massage, oral, penetration) or a tracker `Skills:` /
    `Abilities:` line.
  - Kinks need a literal preference word (bondage, praise, teasing, tail,
    tentacles, submission, dominance); never invent a hard limit.
  - `species` from a `Species:` line or card text pattern only.
  - `body` from a `Body:` / `Appearance:` line only (fallback: first 200 chars
    of card description when no Body line exists — mark provenance `card`).
  - `provenance` keys follow section 2; per-tag source is one of
    `lewd|inline|card|tracker|lorebook|unit|session|inferred`.
- `inferProfileFromSources(unit, sources = {})` — build a profile via
  `normalizeLewdProfile({ name }, { unit, source: 'inferred', sourceSkills,
  sourceTraits })` then merge `collectProfileSignals`, set
  `inferredFields`, and keep `inferred: true`.
- `mergeProfileInference(profile, inferred)` — pure merge used for explicit
  profiles: explicit `[LEWD]`/inline values win for `body`/`species` and for
  duplicate tokens; inference only fills missing anatomy/skills/kinks and
  records lower-priority provenance. Returns a new object.

Extend `inferProfile(unit, settings = {}, sources = {})` so it scans
`unit.notes`, `unit.skills`, `unit.traits` and any supplied
`card`/`trackerText`/`lorebookText` through the same signal collector.
Backwards compatible: two-argument callers keep working.

## 4. Encounter-start inference

In `collectLewdContext`:

- Build `lorebookText` best-effort from `options.lorebookText` or
  `ctx.lorebookText`/`ctx.worldInfoText` when present; otherwise `''`. Do not
  add new lorebook I/O.
- Resolve the character card for a candidate: `ctx.characters?.[ctx.characterId]`
  for the active narrator character, `options.card` / `options.cards[name]`,
  or a case-insensitive `ctx.characters` name match. Pass it + `trackerText =
  extractProfileSourceText(sourceMemo, name)` into `inferProfile`.
- For characters that only have an explicit `[LEWD]`/inline profile, run
  `inferProfileFromSources` and `mergeProfileInference` so card/tracker signals
  enrich it. `[LEWD]` fields keep provenance `lewd`.
- `parseLewdProfiles` accepts the same `cards`/`lorebookText` options and uses
  the same merge, so profiles returned from `collectLewdContext().profiles`
  already carry the full shape.
- Record `state.profileInference` once in `createLewdEncounterFromContext`:
  `{ completedAt: Date.now(), sources: ['lewd','inline','card','tracker','lorebook','unit'] }`
  (only the buckets actually consulted). This is diagnostic, not a cache.

## 5. Engine and agent payload

`buildParticipant` (engine) must persist on the participant:
`anatomy`, `skills`, `kinks`, `sourceSkills`, `sourceTraits`, `notes` (profile
notes), and `profile` unchanged. Prefer `raw.x` then `profile.x` then `[]`/`''`.
`normalizeProfile` copies the new arrays/objects; `hydrateLewdState` backfills
them as arrays (`anatomy`, `skills`, `kinks`, `sourceSkills`, `sourceTraits`)
and `provenance`/`inferredFields` as objects/arrays for legacy boards, without
dropping unknown persisted fields.

`payloadProfiles` in `lewd-combat-agent.js` adds to each entry:
`body`, `species`, `anatomy`, `skills`, `kinks`, `sourceSkills`,
`sourceTraits`, and `inferredFields` (all arrays default `[]`). Add the same
four fields (`anatomy`, `skills`, `kinks`, `sourceTraits`) to the `actor`
object. Do not expose `provenance` to the agent.

## 6. Stock prompt and schema description

- `constants.js` `DEFAULT_STOCK_PROMPTS.lewd`: add the optional fields
  `anatomy=`, `skills=`, `kinks=`, `traits=`, `body=`, `species=` to the
  example line, explain anatomy tags (penis, testes, vagina, vulva, anus,
  breasts, tail, wings, tentacles, knot, bondage-gear), that `traits=` may
  also carry capability words (e.g. `tail`), and that anatomy is never guessed
  from gender. Extend the sensitivity zone list with
  `tail, genitals, throat, mouth`.
- `schema-sections.js` `LEWD_DESIRES_SECTION.description`: mention optional
  anatomy/skills/kinks/body/species fields and the never-guess-from-gender rule.
- Keep the existing test string `NEVER invent a hard limit` and
  `maintain entries for characters` intact.

## 7. Tests

`tests/lewd-combat-profile.test.js`:

1. Parses `anatomy=penis,testes`, `skills=bondage`, `kinks=bondage`,
   `traits=tail`, `body=...`, `species=...`; canonical arrays are correct and
   `traits=tail` also yields anatomy `tail`.
2. `normalizeLewdZone('tail'|'genitals'|'throat'|'mouth')` succeeds and
   `zoneMultiplier` returns a positive number.
3. Explicit `[LEWD] anatomy=penis` beats card/tracker inference for provenance,
   while an inferred `tail` from a card/tracker text is still added and marked.
4. Card text (description/personality) and tracker sections contribute
   anatomy/skills/kinks/body/species signals; provenance records
   `card`/`tracker`.
5. `gender=female` / `Sex: Female` alone yields **no** anatomy and never
   invents a limit.
6. `inferProfile` carries `unit.skills` into `sourceSkills` and `unit.notes`
   into the scan; `inferredFields` lists what was inferred.
7. `mergeProfileInference` is pure, explicit body/species win, duplicates are
   de-duplicated.

`tests/lewd-combat-context.test.js`:

8. A no-`[LEWD]` scene with a card/tracker-tailed NPC yields a candidate whose
   profile has `anatomy: ['tail']`, provenance `card`/`tracker`,
   `inferred: true`; an explicit `[LEWD] anatomy=` profile is not overwritten.
9. `createLewdEncounterFromContext` sets `profileInference` and each
   participant carries `anatomy`, `skills`, `kinks`, `sourceSkills`,
   `sourceTraits`, `notes`; hydrate preserves them.
10. Unknown/garbage anatomy tokens are dropped without throwing.

`tests/lewd-combat-agent.test.js`:

11. Payload profiles and the actor entry expose anatomy/skills/kinks and
    source skills/traits; no `provenance` appears in the payload.

`tests/lewd-combat-techniques.test.js` / `tests/lewd-combat-compendium.test.js`:
Update only the assertions that used `tail` as an invalid zone (use e.g.
`flipper`/`soul`).

## Gate

- `npx vitest run tests/lewd-combat-profile.test.js tests/lewd-combat-context.test.js tests/lewd-combat-agent.test.js tests/lewd-combat-techniques.test.js tests/lewd-combat-compendium.test.js tests/lewd-combat-engine.test.js --pool=threads`
- `npx vitest run --pool=threads`
- `npx vitest run --pool=threads` must be green before handoff. Do not commit.

## Constraints

- No new dependencies. Pure functions never mutate `state`, profiles, or memo.
- Never infer genitals from gender or from an assumed default body.
- Never invent a hard limit; inference only adds capability/skill/kink tags.
- Keep all existing exported names/signatures working; new parameters are
  optional and additive.
- Follow the existing warning style (`warnings.push('unknown … "<x>"')`) and
  slice/clamp limits used elsewhere.
