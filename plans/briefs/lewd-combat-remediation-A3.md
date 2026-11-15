# Brief — lewd-combat-remediation A3 (deterministic anatomy/skill/trait gating)

## Depends on

A1 (profile `anatomy/skills/kinks/sourceSkills/sourceTraits/provenance/inferredFields`)
and A2 (`actType/actRole`, `requires.act/actType/actRole/anatomy/skill/trait/kink`,
`listLegalActions` edge gating, 52-entry catalog). Both landed and green.

## Files (scope)

- `src/features/lewd-combat/lewd-combat-profile.js` — add small pure capability helpers only.
- `src/features/lewd-combat/lewd-combat-techniques.js` — gating helpers, `requires.targetAnatomy`, `listLegalActions`, catalog target-anatomy metadata.
- `src/features/lewd-combat/lewd-combat-engine.js` — enforce the same gates in `applyLewdAction`.
- `src/features/lewd-combat/lewd-combat-agent.js` — expose disabled actions/reasons to the agent.
- `tests/lewd-combat-techniques.test.js`
- `tests/lewd-combat-engine.test.js`
- `tests/lewd-combat-agent.test.js`

Do **not** add A4 pair state/UI here. The engine must remain the final validator,
but do not change the roll math, lifecycle, prose, or outcome paths.

## 1. Capability helpers (profile.js)

Export pure helpers (do not mutate):

- `participantCapabilityTokens(participant)` → normalized lowercase Set/list from
  `participant.skills`, `participant.profile.skills`, `participant.sourceSkills`,
  `participant.kinks`, `participant.profile.kinks`, `participant.sourceTraits`,
  `participant.profile.sourceTraits`, and `participant.anatomy`.
  Keep separate exported helpers if clearer: `hasCapability(participant, kind, token)`.
- `hasKnownAnatomy(participant)` → true when `participant.anatomy` (or
  `participant.profile.anatomy`) is a non-empty array **or** provenance has
  anatomy keys. Explicitly-empty/inferred-empty anatomy is unknown.
- Normalize tokens with `normalizeToken` / `normalizeLewdAnatomy` semantics;
  case-insensitive, hyphen/space tolerant.

## 2. Technique schema additions (techniques.js)

- Add `requires.targetAnatomy` accepting the same shapes as `requires.anatomy`
  (string, string[] all-of, `{all, any}`) and unknown tags are validation errors.
  Keep it in the canonical `requires` object (null when absent). Update the
  header doc.
- Keep `requires.anatomy` as the **actor** capability and `targetAnatomy` as the
  **receptive target** capability.

Add the catalog target requirements where the act is receptive:
- `penetration-start`: `targetAnatomy: { any: ['vagina','anus','tail'] }`
- `penetration-receive`: `targetAnatomy: { any: ['penis','vagina','tail'] }`
- `oral-give`: `targetAnatomy: { any: ['penis','vagina','vulva'] }`
- `manual-stroke`: `targetAnatomy: { any: ['penis','vagina','vulva'] }`
- `paizuri`: `targetAnatomy: 'penis'`
- `mutual-masturbation`: `targetAnatomy: { any: ['penis','vagina','vulva'] }`
- `sixty-nine`: `targetAnatomy: { any: ['penis','vagina','vulva','anus'] }`
- `tail-penetration`: `targetAnatomy: { any: ['vagina','anus','tail'] }`
Keep all existing ids/numbers and other metadata unchanged.

## 3. Gating helpers + `listLegalActions`

In `lewd-combat-techniques.js` export:

- `techniqueActorRequirementReason(state, actor, technique)` → `''` or a
  human-readable reason. Checks, in this order:
  1. `requires.anatomy`:
     - requirement shape `{all,any}`. `all` must all be present; `any` needs at
       least one.
     - missing anatomy for the actor: `Requires penis. Set anatomy in [LEWD].`
       (join multiple tags with ` or ` for `any` / ` and ` for `all`).
     - known anatomy but missing tag: `Requires penis.`
  2. `requires.skill` → `Requires bondage skill.` (each token; first miss wins)
  3. `requires.trait` → `Requires tail trait.`
  4. `requires.kink` → `Requires bondage kink.`
- `techniqueTargetRequirementReason(state, actor, target, technique)` → `''` or
  reason. Checks `requires.targetAnatomy` the same way but against the target;
  if the target has **no known anatomy**, treat genital-specific requirements as
  unavailable (`Requires vagina. Set anatomy in [LEWD].`). Non-anatomy
  requirements return `''` here (act gating stays in the existing
  `actRequirementReason`).
- Keep `actRequirementReason` private but reuse it for both surfaces.
- `listLegalActions`:
  - add `techniqueActorRequirementReason` to the technique-level `reasons`;
  - add `techniqueTargetRequirementReason` to each target's `reasons`;
  - reason strings must be stable and lowercase-the-body style used above.
- `listLegalActions` remains pure.

## 4. Engine enforcement

In `applyLewdAction`, after the technique/stance/uses checks and before target
resolution:
- return `{ ok:false, reason }` when `techniqueActorRequirementReason` fails.
- in the target loop (before `requiresHoldCheck`), exclude each target whose
  `techniqueTargetRequirementReason` fails, using the same excluded shape as the
  hold/limit checks. Single/pair actions stay all-or-nothing via the existing
  `excluded.length` guard.
- Do not let an AI-selected action bypass the gate: `applyLewdAction` must reject
  with the reason even if the caller passes `action.technique` directly.
- `chooseOpponentAction` already consumes `listLegalActions`; do not duplicate
  scoring logic.

## 5. Agent payload

`payloadLegalActions` currently drops disabled entries. Keep `legalActions`
filtered to legal entries, and add a sibling `disabledActions` array to
`buildLewdAgentPayload` entries shaped:
`{ id, name, reasons: string[] }` for every entry disabled by a requirement
(actor or target). Add `requires` metadata to legal actions (already present via
`effects.requires`). The rules text should say: only use `legalActions`; a
technique in `disabledActions` is illegal and its reasons explain why.
Do not expose `provenance`.

## 6. Tests

`tests/lewd-combat-techniques.test.js`:
1. A custom penis-specific technique is `disabled` for a participant with no
   anatomy, with a reason containing `Set anatomy in [LEWD]`; the same technique
   is legal for `anatomy: ['penis']` and disabled for `['vagina']`.
2. Unknown anatomy blocks genital acts but **not** a neutral technique.
3. Tail technique requires `tail`; bondage technique requires the `bondage`
   skill; trait/kink requirements produce their specific reasons.
4. Receptive target anatomy filters only that target in a group action (other
   valid targets remain legal).
5. `requires.targetAnatomy` normalizes string/array/`{all,any}` and rejects an
   unknown tag.
6. Existing act-gating and foreplay tests stay green.

`tests/lewd-combat-engine.test.js`:
7. `applyLewdAction` rejects an anatomy-gated technique for an actor without the
   anatomy, and rejects a receptive action whose only target lacks it; state is
   unchanged on rejection.
8. `applyLewdAction` succeeds when the actor/target anatomy is present; an
   AI-provided illegal action falls back deterministically (existing
   `resolveLewdOpponentTurn` behavior stays green).
9. A neutral technique still resolves for an actor with no anatomy.

`tests/lewd-combat-agent.test.js`:
10. Payload `disabledActions` lists a gated technique with its reasons while
    `legalActions` excludes it; the prompt rules mention `disabledActions`.

## Gate

- `npx vitest run tests/lewd-combat-techniques.test.js tests/lewd-combat-engine.test.js tests/lewd-combat-agent.test.js tests/lewd-combat-context.test.js tests/lewd-combat-profile.test.js --pool=threads`
- `npx vitest run --pool=threads` must be green. Do not commit.

## Constraints

- No new dependencies. Pure helpers never mutate state.
- Never infer anatomy from gender; “unknown anatomy” is the safe default.
- Do not change existing catalog ids/names/numbers, reason strings unrelated to
  the new gates, or the `disabled`/`targets` contract.
- Keep A4 out of scope: no edge act intensity/bindings state, no composer UI.
