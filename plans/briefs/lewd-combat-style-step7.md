# Brief — lewd-combat-style U7 (plan Steps 8 + 9: opponent AI contract + non-authoritative prose)

## Goal

Add the two model-facing, non-authoritative layers on top of the finished board:

1. **Opponent AI contract (Step 8):** a compiled payload of legal actions + visible state + declared profiles + recent actions; a strict validator that accepts only catalog ids/targets/zones/postures; a bounded-freedom flavour string; optional novel-technique compilation through the existing compile-once cache; and a guaranteed deterministic `chooseOpponentAction` fallback.
2. **Prose pass (Step 9):** convert the latest engine beat(s) into a beat sheet and call the **Main connection** for 2–4 sentences; frequency gates (`off` / `per-exchange` / `per-round` / `climax-only`); narrator-busy guard + queue; templated fallback on failure; never mutate mechanics.

This unit covers plan Steps 8 and 9 together. It ends at "AI opponent under contract + non-authoritative prose" (U7 checkpoint). Outcome payload / narrator handoff is U8.

## Frozen interfaces you may import (already implemented)

`src/features/lewd-combat/lewd-combat-engine.js`
- `applyLewdAction(state, action, options)`, `resolveLewdOpponentTurn(state, actions, options)`, `chooseOpponentAction(state, unit, options)`, `listLegalActions` (re-export)
- state: `{ mode, round, roundCap, status, settings:{lewdCombatDarkerThemes, lewdCombatExplicitness}, participants[], engagements[], log[], actionLog[], techniques[], outcome, summary }`
- participant: `{ id, name, side, ai, spectator, atMercy, surrendered, acted, stance, engagedWith[], stamina/maxStamina, arousal/maxArousal, poise/maxPoise, overwhelmedUntilRound, profile }`
- beat shape (technique): `{ type, round, actor:{id,name}, posture, technique:{id,name,category}, targets:[{id,name,zone,natural,check,accuracy,defense,hit,arousalDelta,poiseDelta,staminaDelta,status[],climaxed}], excluded[], stateChanges[], seed }`
- actionLog entries: `{ round, unitId, type, techniqueId?, targetIds?, zones?, posture?, source }`

`src/features/lewd-combat/lewd-combat-techniques.js`
- `listLegalActions(state, unit, options) -> [{ id, name, category, technique, disabled, reasons, posture, postures, zones, targets:[{id,name,disabled,reasons,zones}], usesRemaining }]`
- `LEWD_TECHNIQUE_CATEGORIES`, `LEWD_TARGET_MODES`, `validateLewdTechnique`, `findLewdTechnique`

`src/features/lewd-combat/lewd-combat-profile.js`
- profile: `{ name, role, orientation, stamina, maxStamina, maxArousal, maxPoise, sensitivity, preference, limits[], endurance, experience, traits, drain, notes, source:'lewd'|'inline'|'inferred', inferred, warnings[] }`
- `isBlockedByLimits`, `normalizeLewdZone`

`src/features/lewd-combat/lewd-combat-pairing.js`
- `findEngagement(state, a, b)`, `holdBetween(state, a, b)`, `holdsOn(state, participant)`, `engagementsFor(state, participant)`

`src/features/lewd-combat/lewd-combat-compendium.js`
- `findCachedTechnique(settings, idOrName)`, `writeTechniqueCache(settings, technique)`

`src/features/lewd-combat/lewd-combat-compiler.js`
- `compileLewdTechnique({name, description?, tone?, zones?}, settings, deps) -> Promise<{ok, technique?, cached?, error?}>`
- `lewCompilerRequestSettings(settings)` (already reads `lewdCombatConnection*` with tactical fallback)

`src/features/lewd-combat/lewd-combat-markup.js`
- `describeLewdBeat(beat, state)` → templated fallback sentence(s)

`llm-client.js`
- `sendStateRequest(requestSettings, system, user, signal, { stream:false, debugSource, jsonSchema })` → Promise<string>

State manager: `import { getActiveChatId, getSettings } from '../../../state-manager.js';` (UI only)

## Files to create

1. `src/features/lewd-combat/lewd-combat-prompts.js`
2. `src/features/lewd-combat/lewd-combat-agent.js`
3. `src/features/lewd-combat/lewd-combat-prose.js`
4. `tests/lewd-combat-agent.test.js`
5. `tests/lewd-combat-prose.test.js`

## Files you may modify (minimal patches only)

- `src/features/lewd-combat/lewd-combat-engine.js`: record the AI's non-mechanical `flavor`/`intent` on the technique beat and `actionLog` entry (sanitized string, ≤240 chars, no numeric effect). No other math changes.
- `src/state/connection-setups.js`: add a `lewd_combat` entry to `AGENT_CONNECTION_SETUPS` using keys `lewdCombatConnectionSource|ConnectionProfileId|CompletionPresetId|OllamaUrl|OllamaModel|OpenaiUrl|OpenaiKey|OpenaiModel` and UI ids `#rpg_lewd_combat_*` matching the existing tactical entry's UI field names. Additive only.
- `src/features/lewd-combat/lewd-combat-ui.js`: async AI turns (agent when configured, local fallback otherwise) + prose call after each exchange + pending-prose flush on `GENERATION_ENDED`.
- `src/features/lewd-combat/lewd-combat-markup.js`: render `view.prose` / `state.prose.text` in `.rt-lc-prose` when present, otherwise `describeLewdBeat`.

Do NOT edit `settings.html`, `src/state/defaults.js`, `src/state/settings.js`, `narrative-hooks.js`, `index.js`, profile/techniques/pairing/compendium/compiler modules, or the primary combat boards. U8/U9 own those.

## Required API — `lewd-combat-prompts.js`

Export exactly:

```js
export const DEFAULT_LEWD_AGENT_PROMPT   // system prompt for the opponent AI
export const DEFAULT_LEWD_PROSE_PROMPT   // system prompt for the prose pass
export const LEWD_AGENT_JSON_SCHEMA      // strict:false json schema for {"actions":[...]}
```

`DEFAULT_LEWD_AGENT_PROMPT` must state, in plain text:
- You act for the AI-controlled participant only, choosing exactly one action.
- Use only ids/techniques/targets/zones/postures from the supplied `legalActions`; never invent numbers, targets, body zones, dice, or outcomes.
- The engine owns all math; never compute or state Arousal/Poise/Stamina results.
- Optional non-mechanical `intent`/`flavor` (a taunt or line of dialogue) is allowed; it cannot change the beat.
- Optional `novelTechnique: {name, description, zones?}` is allowed when nothing legal fits; it is compiled once and may be rejected.
- `surrender`/`wait` only when listed legal; keep variety and avoid repeating the last actions.
- Return only one JSON object `{"actions":[...]}` and nothing else.

`DEFAULT_LEWD_PROSE_PROMPT` must state:
- Write 2–4 sentences of prose for the supplied beat sheet only.
- Never invent participants, acts, numbers, outcomes, or state changes; never resolve the encounter or add a climax.
- Obey `explicitness` (`explicit` default, `suggestive`, `fade-to-black`), the darker-theme flag, and every listed hard limit. If a limit forbids a detail, omit it.
- Use the supplied voices/tones; keep it continuous with the previous prose.
- Return prose text only, no JSON, no headings, no quotes around the whole reply.

## Required API — `lewd-combat-agent.js`

Export exactly:

```js
export const LEWD_AGENT_MAX_ATTEMPTS = 2;

export function lewdAgentConfigured(settings)
// true only when the dedicated lewd agent connection is explicitly set:
// lewdCombatConnectionSource !== 'default' && truthy, or a lewd profile id /
// ollama model / openai model is set. Never true just because tactical is set.

export function lewdAgentRequestSettings(settings)
// { connectionSource, connectionProfileId, completionPresetId, ollamaUrl,
//   ollamaModel, openaiUrl, openaiKey, openaiModel, maxTokens, debugMode }
// lewd keys first, tactical keys as fallback (same pattern as the compiler),
// maxTokens = max(600, settings.lewdCombatAgentMaxTokens || 2000), stream handled by caller.

export function buildLewdAgentPayload(state, unit, options = {})
// options: { legalActions? }
// -> {
//   encounter: { round, roundCap, mode, tone, darkerThemes },
//   actor: { id, name, side, role, stance, stamina, maxStamina, arousal, maxArousal, poise, maxPoise, overwhelmed },
//   participants: [ { id, name, side, spectator, atMercy, surrendered, acted, role,
//                     stamina, maxStamina, arousal, maxArousal, poise, maxPoise,
//                     stance: label|null, holds: [labels], engagedWith: [names] } ],
//   engagements: [ { a: name, b: name, hold, stance, intensity } ],
//   legalActions: [ { id, name, category, posture, postures, zones, targetMode,
//                     targets: [names], usesRemaining,
//                     effects: { arousal, poise, staminaDrain, requires } } ],  // disabled entries omitted
//   recentActions: [ last ≤8 actionLog entries, compacted ],
//   knownProfiles: { [id]: { role, orientation, sensitivity, likes, dislikes,
//                            limits (only when profile.source !== 'inferred'), endurance,
//                            experience, inferred } },
//   rules: { variety: '...', constraints: ['Never invent numbers, targets, body zones, or outcomes.', ...] },
// }

export function buildLewdAgentPrompts(state, unit, settings, options = {})
// -> { system, user, payload }
// system = settings.lewdCombatAgentPrompt || DEFAULT_LEWD_AGENT_PROMPT
// user = "## LEWD COMBAT STATE\n```json\n<compact payload>\n```\n\nChoose exactly one action for <name> ... Return only {\"actions\":[...]}."

export function parseLewdAgentResponse(text)
// Tolerant JSON extraction (fenced block or first balanced object; reasoning prose allowed).
// -> { actions: object[], novelTechnique: object|null, error: string }

export function normalizeLewdAgentAction(raw, legalEntries, actor)
// -> { ok: boolean, action?: object, error?: string }
// Accepts type 'technique' | 'wait' | 'surrender'. Rejects 'join' and anything else with a reason.
// - technique: look up by id or name among legalEntries; reject unknown or `disabled` (include reasons).
// - targetIds: every id must exist in that entry's `targets` and be `!disabled`; default to the first
//   legal target when omitted for non-self modes. self mode forces []. 'single'/'pair' => exactly 1.
// - zone: normalize and require membership in the entry's zones; default to the first zone.
// - posture: require membership in entry.postures; default to entry.posture.
// - output action: { type:'technique', unitId: actor.id, techniqueId, targetIds, zone, posture,
//                    intent?, flavor? } (flavor/intent are trimmed strings, max 240 chars)
// - wait/surrender: { type, unitId: actor.id, flavor? }

export function normalizeLewdAgentResponse(textOrValue, legalEntries, actor)
// -> { ok, actions: object[], rejected: [{ action, error }], novelTechnique, error }
// If the parsed object has no actions but has a novelTechnique, return ok:false with error
// 'No legal action in the response.'

export async function requestLewdOpponentAction(state, unit, settings, options = {})
// options: { signal, sendStateRequest, resolveNovelTechnique, prompt, legalActions }
// - lazy-import sendStateRequest if not injected; no import at module top.
// - build prompts from the actor's real legal list.
// - up to LEWD_AGENT_MAX_ATTEMPTS sends; on rejected actions append a CORRECTION section.
// - novelTechnique (top-level or on the action):
//     * resolve from findCachedTechnique(settings,name) or state.techniques first;
//     * else call options.resolveNovelTechnique || compileLewdTechnique once;
//     * on success push the technique into state.techniques (dedupe by id) so the second
//       request never re-compiles; on failure keep going / return a visible error.
// - Re-list legal actions after adding a compiled technique, then normalize.
// - -> { ok, actions, rejected, error?, raw?, compiledTechnique? }
// - Never throws for model/parse/connection errors.
```

Contract notes:
- The AI never computes damage; the engine does.
- Prompt must include the literal rule text “Never invent numbers, targets, body zones, or outcomes.” (tests assert it).
- Recent-action repetition is already penalised by `chooseOpponentAction`; expose recent actions in the payload so an agent can avoid repeats too.
- Do not call the network during `build*`/`normalize*`. Only `requestLewdOpponentAction` sends.

## Required API — `lewd-combat-prose.js`

Export exactly:

```js
export function isNarratorBusy(globalRef = globalThis)
// true when globalRef._rpgStateModelRunning?.() is true, globalRef._rpgGenerationBusy === true,
// or SillyTavern.getContext().isGenerating === true. Never throws.

export function buildLewdBeatSheet(state, beats, options = {})
// beats: one beat object or an array of beats from state.log (never mutates).
// -> {
//   round, tone, darkerThemes,
//   limits: [union of declared limits of every non-spectator participant],
//   voices: { [name]: profile.notes || role label },
//   exchanges: [ {
//     actor, posture, technique, flavor,
//     targets: [ { name, zone, check, defense, hit, arousalDelta, poiseDelta,
//                  staminaDelta, status, climaxed } ],
//     stateChanges: [ strings ],
//   } ],
//   // flat convenience fields copied from the last exchange:
//   actor, posture, technique, targets, stateChanges,
// }

export function shouldGenerateLewdProse(state, beats, settings, options = {})
// frequency = settings.lewdCombatProseFrequency || 'per-exchange'
// - 'off' => false
// - 'per-exchange' => true for any non-'wait' beat
// - 'per-round' => only when options.roundEnded === true or state.status !== 'active'
// - 'climax-only' => only when any target.climaxed, or the encounter ended/stopped/surrendered
// - false when the lewd board is inactive/absent, and for type 'wait' unless the encounter ended

export function buildLewdProsePrompt(state, beats, settings, options = {})
// -> { system, user, sheet }
// system = settings.lewdCombatProsePrompt || DEFAULT_LEWD_PROSE_PROMPT
// user contains the beat-sheet JSON plus an explicit directive block with the
// explicitness value and darker-theme flag, the hard limits, and the rule text
// "Never change state or invent numbers, participants, or outcomes."

export function lewdProseRequestSettings(settings)
// Main connection only: { connectionSource: 'default', connectionProfileId: '',
//   completionPresetId: '', ollamaUrl:'http://localhost:11434', ollamaModel:'',
//   openaiUrl:'', openaiKey:'', openaiModel:'',
//   maxTokens: max(400, settings.lewdCombatProseMaxTokens || 2000), debugMode }

export function parseLewdProseResponse(raw)
// Accepts plain text, fenced text, or {"prose":"..."}; strips fences/quotes;
// collapses whitespace; trims to ≤1200 chars. -> string ('' when unusable).

export async function generateLewdProse(state, beats, settings, options = {})
// options: { signal, sendStateRequest, timeoutMs, roundEnded, prompt }
// -> { ok, prose?, fallback, error?, deferred?, skipped?, raw? }
// - fallback = describeLewdBeat(lastBeat, state) (templated text).
// - shouldGenerateLewdProse false => { ok:false, skipped:true, fallback } (no call).
// - isNarratorBusy() => { ok:false, deferred:true, fallback } (no call). Never allow override
//   from the board; the caller retries after GENERATION_ENDED.
// - lazy-import sendStateRequest if not injected; AbortController timeout (default 45000 ms,
//   options.timeoutMs) combined with options.signal; clear the timer in a finally.
// - connection failure / empty parse => { ok:false, error, fallback, raw? }.
// - NEVER mutates state.
```

## UI / markup patch requirements

`lewd-combat-ui.js`
- `runAiTurns()` becomes async. For each AI participant that owes a turn:
  - if `lewAgentConfigured(settings)` and not busy: `await requestLewdOpponentAction(state, actor, settings)` then `resolveLewdOpponentTurn(state, result.actions || [])`;
  - otherwise `resolveLewdOpponentTurn(state)` exactly as today.
  - keep the 12-iteration guard; persist once at the end; catch and fall back to the local engine path; no throw escapes.
- After a player action and after the AI batch, call a new `narrateAfterExchange(state, previousRound)` helper:
  - frequency `off` => return; `per-exchange`/`climax-only` => generate for the latest beat;
  - `per-round` => collect beats into a module-level queue keyed by round and flush when the round
    changes or the encounter ends;
  - if `isNarratorBusy()` => store the pending beat(s) and return (templated text stays visible);
  - on success set `state.prose = { text, round }`, persist, and set `ui.view.prose`;
  - on failure keep the templated text and a non-blocking warning (toast only when debugMode).
- `installLewdCombatUi` subscribes once to `event_types.GENERATION_ENDED` (guarded with optional
  chaining) to flush pending prose; no listener when the host is unavailable.
- Reset/clear `ui.view.prose` on start/reset/chat change. Do not put prose in the start view.
- The UI must still work when the agent/prose modules are unavailable: local policy + templated text.

`lewd-combat-markup.js`
- `.rt-lc-prose-text` uses `view.prose`, then `state.prose?.text`, then `describeLewdBeat(latest, state)`.
- Everything is escaped exactly as today.

## Tests

`tests/lewd-combat-agent.test.js` (pure, mocked `sendStateRequest`, no network):
1. `buildLewdAgentPayload` omits disabled legal entries, includes only legal targets, recent actions, declared profiles, and the rule text “Never invent numbers, targets, body zones, or outcomes.”
2. `buildLewdAgentPrompts` embeds the payload and actor name; system defaults to `DEFAULT_LEWD_AGENT_PROMPT`.
3. `normalizeLewdAgentAction` accepts a valid technique and rejects: unknown technique, disabled technique, illegal target, target outside the technique's zones, and disallowed posture — each with a non-empty reason.
4. `parseLewdAgentResponse` tolerates prose before a fenced JSON object and surfaces `novelTechnique`.
5. `requestLewdOpponentAction` with a mocked valid response returns a normalized action; with an illegal response returns `ok:false`/rejections and never throws.
6. A valid AI action resolves identically to the same action supplied as player input (same seed, same beat numbers, same `actionLog` techniqueId).
7. Illegal AI action still falls back deterministically through `resolveLewdOpponentTurn` and records `rejected-ai-action`.
8. A novel technique is compiled exactly once: first call invokes `resolveNovelTechnique`, pushes it into `state.techniques`, and the second call does not invoke it again.
9. `lewAgentConfigured` is false by default and false when only tactical keys are set.

`tests/lewd-combat-prose.test.js`:
1. `buildLewdBeatSheet` maps a real `applyLewdAction` beat to actor/posture/technique/target deltas/state changes, includes declared limits and voices, and does not mutate state.
2. `shouldGenerateLewdProse` honours all four frequency modes (per-round requires `roundEnded`; climax-only needs a climax/ended state; `wait` is skipped).
3. `buildLewdProsePrompt` includes the explicitness directive, darker flag, limits, and “Never change state or invent numbers, participants, or outcomes.”; `fade-to-black` is stated explicitly.
4. `generateLewdProse` with a mocked `sendStateRequest` returns the prose and calls it with the **Main** connection (`connectionSource: 'default'`), never `lewdCombatConnection*`; a JSON deep-snapshot of state is byte-identical before/after.
5. Busy guard: `globalThis._rpgGenerationBusy = true` returns `{ deferred:true }` and does not call send; clean the global.
6. Failure/throw returns `{ ok:false }` with the templated fallback from `describeLewdBeat`.
7. `parseLewdProseResponse` strips fences and unwraps `{"prose":"..."}`.
8. Markup: `buildLewdCombatMarkup(state, { prose: 'Aria leans close.' })` renders the prose in `.rt-lc-prose-text`, and falls back to the templated sentence when no prose is supplied.

Run:
- Targeted: `npx vitest run tests/lewd-combat-agent.test.js tests/lewd-combat-prose.test.js --pool=threads`
- U7 regression: `npx vitest run tests/lewd-combat-profile.test.js tests/lewd-combat-engine.test.js tests/lewd-combat-techniques.test.js tests/lewd-combat-pairing.test.js tests/lewd-combat-compendium.test.js tests/lewd-combat-context.test.js tests/lewd-combat-markup.test.js tests/lewd-combat-store.test.js --pool=threads`
- Full gate: `npx vitest run --pool=threads`

## Constraints

- Plain ES modules; **no new dependencies**, no top-level DOM access, no network at import time.
- Deterministic: no `Math.random` in new code. AI choice is recorded; resolution stays seeded.
- `lewdCombatEnabled` stays `false` by default; module off = no calls, no behavior change.
- Prose is non-authoritative: it must never call `applyLewdAction` or mutate pools/engagements/logs.
- Never generate prose or call the opponent agent inside a narrator generation; the busy guard and
  deferred queue are mandatory.
- Respect hard limits: the agent validator must refuse blocked targets even if the model proposes them.
- Do not route sexual techniques through `[ABILITIES]`/`classifySkillIntent`.
- Preserve CRLF/LF as found; do not normalize whole files.
- Do not commit.

## Demo (manual)

Enable the module and configure a lewd agent connection → start a duel → the opponent's turns come from
the agent and every illegal proposal falls back to the local policy → after each exchange the Scene pane
fills with 2–4 sentences from the Main connection → disconnect Main to see the templated fallback with no
state change → set frequency `off` and confirm no calls.

## Commit (for the commit agent, not you)

`feat(lewd-combat): AI opponent contract and main-connection prose pass` (covers plan Steps 8 + 9 / U7).

## Attempts

1. First implementation pass: full suite green (192 files / 1733 tests).
2. Reviewer findings addressed:
   - **Major:** validator now resolves targets by id *or* case-insensitive name and canonicalizes
     them to participant ids (the payload exposes names); regression test added.
   - **Minor:** `runAiTurns` re-checks narrator-busy per iteration; compiled novel techniques persist
     even when no action resolves; `flushPendingProse` catches so the `GENERATION_ENDED` listener
     cannot reject; `wait` beats are filtered out of prose batches so a trailing wait never drops a
     round's prose.
   - **Nit rebutted:** `wait`/`surrender` legality remains prompt-enforced but the engine validates
     and degrades gracefully; flavour on wait/surrender stays intentionally unrecorded per the brief.
