# Brief — lewd-combat-style U8 (plan Steps 10 + 11: outcome handoff + narrator tool/sysprompt/override)

## Goal

Close the loop between the lewd board and the main narrator:

1. **Step 10 — outcome payload:** `buildLewdOutcomePayload(state)` / `queueLewdOutcome(state, settings)` produce one `kind:'lewd'` payload per chat through the existing pending-narration store; `buildNarrationBlock` dispatches it to a lewd template labelled `[LEWD_COMBAT_CONTEXT]`; `narrative-hooks.js` injects `[LEWD_COMBAT_RESULT_NOTICE]`.
2. **Step 11 — narrator tool + sysprompt:** register `StartLewdCombat` only while the module + its sysprompt section are enabled; add the `<lewd_combat>` section to both stock sysprompts and `RT_PROMPTS`; inject `[LEWD_COMBAT_OVERRIDE]` while a lewd board is active. No auto-start on `[COMBAT]`, no `[DORMANT_ENCOUNTER]` rule.

This is U8. U9 owns the full settings pane, consent rails, docs, and integration tests.

## Frozen interfaces you may import (already implemented)

`src/features/lewd-combat/lewd-combat-engine.js`
- state: `{ id, title, location, reason, tone, mode:'duel'|'group'|'free-for-all', status:'active'|'ended', round, roundCap, endedRound, outcome, endReason, summary, winnerIds, winnerSide, stopped, seed, participants[], engagements[], log[], actionLog[], settings:{lewdCombatDarkerThemes, lewdCombatExplicitness}, prose?:{text,round}, finalization? }`
- participant: `{ id, name, side, ai, spectator, atMercy, surrendered, stance, stamina/maxStamina, arousal/maxArousal, poise/maxPoise, profile:{ role, notes, limits[], source } }`
- outcomes: `'atMercy' | 'surrendered' | 'stopped' | 'draw' | 'mutual' | 'sideVictory'`
- beat: `{ type, round, actor:{id,name}, posture, technique:{id,name,category}, targets:[{id,name,zone,hit,arousalDelta,poiseDelta,staminaDelta,status[],climaxed}], stateChanges[], outcome? }`
- `serializeLewdState` / `hydrateLewdState` (arbitrary fields such as `finalization` and `prose` survive).

`src/features/lewd-combat/lewd-combat-pairing.js` — `state.engagements` entries: `{ a, b, hold, stance, sinceRound, refreshedRound, intensity }` (participant ids).

`src/features/lewd-combat/lewd-combat-store.js` — `getLewdEncounterForChat`, `setLewdEncounterForChat`, `removeLewdEncounterForChat`, `getActiveLewdChatId`, `LEWD_BY_CHAT_KEY`.

`src/features/tactical-combat/tactical-combat-store.js` — `setPendingNarration(settings, payload, {persist:false})`, `getPendingNarration`, `hasPendingNarration`, `clearPendingNarration`.

`src/features/tactical-combat/tactical-combat-prompts.js` — `renderTacticalTemplate(template, values)` (generic `{{key}}` replacement).

`src/features/lewd-combat/lewd-combat-prose.js` — `buildLewdBeatSheet`, `isNarratorBusy`.

`src/features/lewd-combat/lewd-combat-ui.js`
- `readState()/persist()` internal; `openLewdCombatBoard(options)`, `startLewdCombatFlow(options)`, `resetLewdCombatEncounter()`, `stopLewdCombatEncounter()`, `notifyChanged()` internal.
- `createLewdEncounterFromContext(settings, ctx, options)` already accepts `participantNames`, `spectatorNames`, `title`, `location`, `reason`, `openingTechnique`, `openingZone`, `tone`, `mode`, `seed`.
- `canStartLewdEncounter(settings, chatId)` → `{ok, reason}`.

## Files to create

1. `src/features/lewd-combat/lewd-combat-outcome.js`
2. `tests/lewd-combat-outcome.test.js`
3. `tests/lewd-combat-tool.test.js`

## Files you may modify (minimal, surgical patches)

- `src/features/lewd-combat/lewd-combat-prompts.js`: add `DEFAULT_LEWD_OUTCOME_PROMPT` (see below). Do not change the existing agent/prose prompts or `LEWD_AGENT_JSON_SCHEMA`.
- `src/features/tactical-combat/tactical-combat-outcome.js`: in `buildNarrationBlock`, early-dispatch `pending.kind === 'lewd'` to `buildLewdNarrationBlock(settings, chatId)` and return it. Nothing else changes; tactical/traditional rendering must stay byte-identical.
- `narrative-hooks.js`: imports, `[LEWD_COMBAT_RESULT_NOTICE]` selection, `[LEWD_COMBAT_OVERRIDE]` injection, `StartLewdCombat` tool + sync function, and the injection gate extension. See exact sections below.
- `src/features/lewd-combat/lewd-combat-ui.js`: `startLewdCombatFromNarrator(args)`, `maybeFinalizeLewdEncounter` wiring after actions, pending-narration cleanup in reset. No markup change.
- `src/features/lewd-combat/lewd-combat-context.js`: extend `canStartLewdEncounter` to refuse when a tactical/traditional board is active in the same chat (read `settings.tacticalCombatByChat?.[chatId]?.status` / `settings.traditionalCombatByChat?.[chatId]?.status`; do NOT import combat-mode.js).
- `constants.js`: two stock sysprompt copies in `RT_PROMPTS` (`sysprompt.txt`, `sysprompt_legacy.txt`).
- `sysprompt.txt`, `sysprompt_legacy.txt`: the same `<lewd_combat>` block in both.
- `index.js`: import + init sync + `MESSAGE_SENT` sync + `_syspromptModDefs` entry + toggle handler branch.
- `game-systems.js`: `KNOWN_TOGGLE_DEFAULTS.lewd_combat = true`, `NARRATOR_TOGGLE_IDS.lewd_combat = 'rpg_sysprompt_mod_lewd_combat'`, `transformBaseSectionContent` gating, row description.
- `src/state/defaults.js`: `syspromptModules.lewd_combat: true` (inert while `lewdCombatEnabled` is false).
- `settings.html`: one Narrator Configuration checkbox `rpg_sysprompt_mod_lewd_combat` next to the tactical/traditional toggles (line ~804).

Do NOT edit: `src/features/lewd-combat/lewd-combat-engine.js`, `-agent.js`, `-prose.js`, `-markup.js`, `-store.js`, `-compendium.js`, `-compiler.js`, `-profile.js`, `-techniques.js`, `-pairing.js`, `src/state/connection-setups.js`, `src/state/settings.js`, the tactical/traditional engines or UIs. U9 owns those.

## Required API — `lewd-combat-outcome.js`

Export exactly:

```js
export const LEWD_COMBAT_CONTEXT_LABEL = 'LEWD_COMBAT_CONTEXT';
export const LEWD_COMBAT_RESULT_NOTICE; // string constant, see below

export function describeLewdOutcome(state) // -> { key, label, mercy?, winners:[names], losers:[names] }
export function buildLewdOutcomePayload(state, options = {})
export function queueLewdOutcome(state, settings, options = {})
export function buildLewdNarrationBlock(settings, chatId = getActiveChatId())
```

`buildLewdOutcomePayload(state, options = {})` → plain object (no mutation of `state`):
```js
{
  chatId: String(state.chatId || getActiveChatId() || ''),
  stateId: state.id,
  kind: 'lewd',
  title: state.title || 'Lewd Combat',
  location: state.location || '',
  mode: state.mode,
  tone: state.tone || state.settings?.lewdCombatExplicitness || 'explicit',
  darkerThemes: !!state.settings?.lewdCombatDarkerThemes,
  outcome: state.outcome,                 // raw key
  outcomeLabel: describeLewdOutcome(state).label,
  rounds: Number(state.endedRound || state.round) || 1,
  summary: state.summary || '',
  participants: [{ id, name, side, spectator, role, stance,
                   stamina, maxStamina, arousal, maxArousal, poise, maxPoise,
                   atMercy, surrendered, limits: profile.limits }],
  pairings: [{ a: nameA, b: nameB, hold, stance, intensity }],
  highlights: [ 'Aria used Neck Kiss on Bran (hit; +6 Arousal)', ... ], // last ≤6 beats
  limits: [ ...union of non-spectator declared limits ],
  limitsRespected: true,
  finalProse: String(state.prose?.text || ''),
  createdAt: Date.now(),
  injectedAt: 0,
  injectedFor: '',
}
```
- Participants include Stamina/Arousal/Poise; never HP/Willpower fields.
- `highlights` from `state.log` beats (`type:'technique'`): actor, technique name, target names, hit/miss, arousal and climax flags. Skip `wait` beats.
- No `[COMBAT]`, HP, or memo writes at all.

`describeLewdOutcome(state)`:
- `atMercy` → label like `"Bran is at the mercy of Aria"` using `state.winnerIds` (or remaining active participants) and the `atMercy` participants. Must NOT use words “dead”, “killed”, “defeated by damage”.
- `surrendered` → `"Bran surrendered to Aria; the partner decides the aftermath"` (no false death).
- `stopped` → `"Stopped by safe word — no winner, no aftermath imposed"`.
- `draw` → `"Draw — round cap reached"`; `mutual` → `"Mutual climax — shared outcome"`.
- `sideVictory` → `"Side victory: <winner names>"`.
- Unknown/missing outcome → `"Encounter ended"` (never throw).

`queueLewdOutcome(state, settings, options = {})`:
- Return `null` when `!state || !state.status || state.status === 'active'`.
- Idempotent: if `state.finalization?.narrationQueued`, return the existing `state.finalization.payload || buildLewdOutcomePayload(state)` and do NOT call `setPendingNarration` again.
- Build payload, `setPendingNarration(settings, payload, { persist: false })`, set
  `state.finalization = { ...(state.finalization||{}), narrationQueued: true, queuedAt: Date.now(), payload, outcome: payload.outcome }`.
- Persist settings once when `options.persist !== false` (call `options.save` when provided, else `saveSettings()` wrapped in try/catch with the existing `[RPG Tracker] ...` warn style).
- Never mutate the memo, `[COMBAT]`, HP, or Willpower.
- Return the payload.

`buildLewdNarrationBlock(settings, chatId = getActiveChatId())`:
- `''` when no settings; `''` when the pending payload's `kind !== 'lewd'`; `''` on a chat mismatch.
- Render `settings.lewdCombatOutcomePrompt || DEFAULT_LEWD_OUTCOME_PROMPT` through `renderTacticalTemplate` with values:
  `title, location, mode, outcome (outcomeLabel), rounds, tone, participants (multi-line), pairings, limitsRespected ('Yes'), limits, highlights, finalProse, summary, darkerThemes ('Yes'/'No')`.
- `participants` lines: `- Name [side/role]: 3/4 Stamina, 4/10 Arousal, 5/8 Poise — at mercy | surrendered | active`.
- `pairings` lines: `- Aria ↔ Bran: hold grappled, stance entwined (intensity 2)`; `'None recorded.'` when empty.
- Prefix with the authoritative bridge:
  `[LEWD_COMBAT_CONTEXT]\nAn intimate Lewd Combat scene just resolved on the board. It is OVER; this is the aftermath. The previous message is not a new action and must not be replayed. Treat the result below as authoritative over stale memo/history. Do not resolve another exchange, do not add a climax, and do not declare a death or lasting injury from a Lewd Combat loss. Never rewrite [COMBAT], HP, or Willpower; this module never touched them. The scene stays stopped unless the result explicitly says otherwise.\n[/LEWD_COMBAT_CONTEXT]\n\n`
  followed by the rendered template and a trailing `\n\n`.

`LEWD_COMBAT_RESULT_NOTICE` (exported string, used by `narrative-hooks.js`):
`[LEWD_COMBAT_RESULT_NOTICE]\nAn intimate Lewd Combat scene triggered by the previous player action has just resolved. It is OVER; this turn is the aftermath. The full authoritative result is attached as a system note after this message. It is not a new player action; continue from its aftermath. Do not replay the scene, do not roll new exchanges, and do not declare a death or lasting injury from a Lewd Combat loss. Do not rewrite [COMBAT], HP, or Willpower, and do not re-open [COMBAT] for this scene.\n[/LEWD_COMBAT_RESULT_NOTICE]\n\n`

## Required API — `lewd-combat-prompts.js` addition

`DEFAULT_LEWD_OUTCOME_PROMPT` (template keys above). It must:
- Present the result as authoritative and already resolved.
- Forbid replaying the scene, adding exchanges/climaxes, inventing participant numbers, or declaring death/injury from Stamina loss.
- State at-mercy/surrender wording: the loser is at the winner's mercy or yielded; the partner/table decides the aftermath, bounded by limits.
- State `stopped` is neutral (safe word, no winner).
- Forbid rewriting `[COMBAT]`, HP, or Willpower.
- Instruct 2–5 sentences of aftermath prose continuing the story toward the player's next choice.

## Exact wiring

### `tactical-combat-outcome.js`

Add `import { buildLewdNarrationBlock } from '../lewd-combat/lewd-combat-outcome.js';`
At the top of `buildNarrationBlock`, after the existing `pending` guard:
```js
if (pending.kind === 'lewd') return buildLewdNarrationBlock(settings, chatId);
```
Everything else unchanged.

### `narrative-hooks.js`

1. Imports:
```js
import { LEWD_CHANGED_EVENT } from './src/features/lewd-combat/lewd-combat-constants.js';
import { LEWD_COMBAT_RESULT_NOTICE } from './src/features/lewd-combat/lewd-combat-outcome.js';
```
2. Next to the tactical/traditional tool blocks (~line 626–960) add a parallel lewd block:
```js
const LEWD_COMBAT_FAILURE_COOLDOWN_MS = 30 * 1000;
const _lewdCombatToolFailureUntil = new Map();
let _lewdCombatToolSyncBound = false;
let _lewdCombatToolRegistered = false;

function bindLewdCombatToolSync() { /* document.addEventListener(LEWD_CHANGED_EVENT, ...) */ }
export function lewdCombatToolConfigured() { /* getSettings().lewdCombatEnabled && isEffectiveSectionEnabled('lewd_combat', s) */ }
export function syncLewdCombatToolRegistration()
export function registerLewdCombatTool()
export function unregisterLewdCombatTool()
export function buildLewdCombatRuntimeOverride(settings)
```
   - `lewdCombatToolAvailable()`: configured, active chat id, no active/finalizing lewd board in this chat, no `hasPendingNarration`, not cooling down, and NOT when `tacticalCombatByChat[chatId].status === 'active'` or `traditionalCombatByChat[chatId].status === 'active'`.
   - `syncLewdCombatToolRegistration()` computes the same condition and registers/unregisters. No `combatStyle`/`[COMBAT]` dependency and no auto-start setting.
   - `registerLewdCombatTool()` mirrors the tactical registration exactly (unregister first, `shouldRegister`, `stealth:false`, `formatMessage`), with:
     - `name: 'StartLewdCombat'`, `displayName: 'Lewd Combat'`.
     - Description: player-initiated intimacy only; “call this once when the scene becomes intimate and the player initiates”; do NOT call for ordinary hostile combat (that stays on the selected primary style/tool); do NOT use the Two-Beat Encounter Rule or a dormant prelude; pass participant/spectator names, title, location, reason, opening technique/zone, tone, and mode; after calling, do not narrate or resolve the scene yourself.
     - `parameters` (draft-04, `required: []`): `participantNames` (array of strings), `spectatorNames` (array of strings), `title` (string), `location` (string), `reason` (string), `openingTechnique` (string), `openingZone` (string), `tone` (string), `mode` (string enum `['duel','group','free-for-all']`).
     - `action: async args => { ... await import('./src/features/lewd-combat/lewd-combat-ui.js'); startLewdCombatFromNarrator(args) ... }` with the same try/catch + failure-cooldown behaviour as tactical; returns `result.message`.
   - `buildLewdCombatRuntimeOverride(settings)`:
     ```js
     try {
       if (!settings?.lewdCombatEnabled) return '';
       const chatId = getActiveChatId();
       const board = settings.lewdCombatByChat?.[chatId];
       if (board?.status !== 'active') return '';
       if (hasPendingNarration(settings, chatId)) return '';
       return `[LEWD_COMBAT_OVERRIDE]\nLewd Combat is currently being resolved on the board. Do not narrate the intimate contest, exchanges, Arousal, Stamina, Poise, climaxes, or the outcome yourself. Do not call StartLewdCombat again. If the player writes in chat, acknowledge that the scene is paused on the Lewd Combat board and wait for its result. Ordinary hostile combat still uses the selected primary combat style.\n[/LEWD_COMBAT_OVERRIDE]\n\n`;
     } catch (_) { return ''; }
     ```
3. Injection block (~line 1768–1800):
   - Extend the gate: `const hasLewdWork = !!settings.lewdCombatEnabled && (settings.lewdCombatByChat?.[activeCombatChatId]?.status === 'active' || getPendingNarration(settings, activeCombatChatId)?.kind === 'lewd');` and add it to the existing `if (!skipInjection && (...))` OR-chain.
   - `const lewdOverride = buildLewdCombatRuntimeOverride(settings); if (lewdOverride) injections += lewdOverride;`
   - Result notice: compute `const pendingKind = getPendingNarration(settings, getActiveChatId())?.kind;` and append `LEWD_COMBAT_RESULT_NOTICE` when `pendingKind === 'lewd'`, else the existing traditional/tactical branches (unchanged strings).
4. Narration message push (~line 2144): use `const resultKind = pending.kind;` and
   `name: resultKind === 'lewd' ? 'Lewd Combat' : resultKind === 'traditional' ? 'Traditional Combat' : 'Tactical Combat'`.
5. Call `syncLewdCombatToolRegistration()` alongside the existing sync calls in `onGenerationStarted()`, `onGenerationEnded()` (where `syncTacticalCombatToolRegistration()` is called).

### `lewd-combat-ui.js`

- Add `export async function startLewdCombatFromNarrator(args = {})`:
  - `const gate = canStartLewdEncounter(settings, chatId); if (!gate.ok) return { ok:false, message: gate.reason };`
  - Build via `createLewdEncounterFromContext(settings, safeContext(), { participantNames: args.participantNames, spectatorNames: args.spectatorNames, title: args.title, location: args.location, reason: args.reason, openingTechnique: args.openingTechnique, openingZone: args.openingZone, tone: args.tone || settings.lewdCombatExplicitness, mode: args.mode })`.
  - `persist(result.state)`, reset the start-dialog view fields, `openLewdCombatBoard()` so the player sees the board (do NOT auto-run AI turns on narrator start), `notifyChanged()`.
  - Return `{ ok:true, message: 'Lewd Combat: the board is open for <names>. Resolve the scene on the board; the result returns to the narrator when it ends.' }`. Catch everything and return `{ ok:false, message: 'Lewd Combat could not start: ...' }`; never throw.
- Add `async function finishEncounterIfEnded(state)`:
  - if `!state || state.status === 'active' || state.finalization?.narrationQueued` return;
  - lazily `import('./lewd-combat-outcome.js')`, call `queueLewdOutcome(state, settings, { persist: false })`, then `persist(state)` so `finalization` is saved with the board;
  - if the host is idle (`isNarratorBusy()` from the prose module returns false) and `state.finalization?.autoNarrateStarted` is not set, set it, `persist(state)`, and `void continueToNarration(settings)` (import `continueToNarration` from `../tactical-combat/tactical-combat-outcome.js`); swallow errors.
  - Call it after `runAiTurns()` in `startFromOverlay`, `resolveAction`, and `simpleAction`, and unconditionally in `stopEncounter` after `persist`. Guard against double-queue.
- In `resetLewdCombatEncounter()`: after removing the board, also `clearPendingNarration(settings, { chatId })` (import from the tactical store) so a stale result cannot inject after a discard.
- Do not add a DOM listener for GENERATION_ENDED here (U7 already installed the prose flush).

### `canStartLewdEncounter` (context.js)

After the existing checks, add:
```js
const tactical = settings?.tacticalCombatByChat?.[id]?.status;
const traditional = settings?.traditionalCombatByChat?.[id]?.status;
if (tactical === 'active' || traditional === 'active') {
    return { ok: false, reason: 'A tactical/traditional combat board is active in this chat. Finish or reset it before starting Lewd Combat.' };
}
```

### Sysprompt section (all four sources)

Insert immediately after `</traditional_combat>` in `sysprompt.txt`, `sysprompt_legacy.txt`, and both `RT_PROMPTS` strings in `constants.js`:
```
<lewd_combat>
LEWD COMBAT (SECONDARY)
When the scene becomes intimate and the player initiates, call StartLewdCombat once. Do not narrate the sexual contest yourself; the board resolves it and returns the authoritative aftermath.
Do not call StartLewdCombat for ordinary hostile combat — that still uses the selected primary combat style and its own tool. Do not use the Two-Beat Encounter Rule or a dormant prelude for Lewd Combat; the player's initiation is the trigger.
Pass the participant names, any spectators, a short title, the location, a reason, and the scene tone. Pass openingTechnique/openingZone only when the player's message already declared a concrete opening act, and set mode to duel, group, or free-for-all according to the scene.
After calling, wait for the board's result and do not resolve or replay the scene.
</lewd_combat>
```
Keep the four copies identical (modulo line endings). Preserve existing CRLF/LF.

### `defaults.js` / `game-systems.js` / `index.js` / `settings.html`

- `defaults.js` `syspromptModules`: add `lewd_combat: true,` (near `traditional_combat`).
- `game-systems.js`:
  - `KNOWN_TOGGLE_DEFAULTS.lewd_combat = true`.
  - `NARRATOR_TOGGLE_IDS.lewd_combat = 'rpg_sysprompt_mod_lewd_combat'`.
  - `transformBaseSectionContent`: `if (tag === 'lewd_combat' && !settings.lewdCombatEnabled) return '';`
  - Section-row description: `'Narrator instruction: call the StartLewdCombat function tool once when an intimate scene begins. Does not run the encounter by itself.'`
- `index.js`:
  - import `syncLewdCombatToolRegistration` from `narrative-hooks.js`.
  - in `buildSysprompt`'s `order.map`, add `if (row.tag === 'lewd_combat' && !s.lewdCombatEnabled) return '';` next to the tactical/traditional lines.
  - `_syspromptModDefs`: `{ key: 'lewd_combat', id: 'rpg_sysprompt_mod_lewd_combat' }`.
  - toggle handler: `if (key === 'lewd_combat') syncLewdCombatToolRegistration();`
  - init block after `syncTraditionalCombatToolRegistration();`: `syncLewdCombatToolRegistration();` (keep it inside the same “Dice System” block so the existing tool test regex still matches).
  - `MESSAGE_SENT` listener: `if (event_types.MESSAGE_SENT) eventSource.on(event_types.MESSAGE_SENT, () => syncLewdCombatToolRegistration());`
- `settings.html`: after the traditional checkbox (line ~805):
  `<label class="checkbox_label" title="Adds a predefined Lewd Combat section to the system prompt. It tells the narrator to call StartLewdCombat once when the player initiates an intimate scene. Requires the opt-in Lewd Combat module and a model/API with function calling."><input type="checkbox" id="rpg_sysprompt_mod_lewd_combat" /><span>💗 Lewd Combat (StartLewdCombat tool)</span></label>`

## Tests

`tests/lewd-combat-outcome.test.js` (pure; no network/DOM):
1. Build a real ended duel via `createLewdEncounterState` + `surrenderParticipant`/`climaxParticipant` (or a hand-built ended state) and assert `buildLewdOutcomePayload`: `kind:'lewd'`, raw outcome + label, participant Stamina/Arousal and absence of `hp`/`maxHp`/`willpower`, pairings, limits union, highlights, `finalProse`, and no mutation of `state` (deep snapshot).
2. `queueLewdOutcome` queues exactly one payload through `setPendingNarration`; second call does not overwrite (same `createdAt`/payload identity); `state.finalization.narrationQueued === true`; a memo containing `[COMBAT]` is untouched.
3. `buildNarrationBlock` with a lewd pending payload returns a block starting `[LEWD_COMBAT_CONTEXT]`, containing the participant Stamina line and the lewd bridge text, and NOT `[TACTICAL_COMBAT_CONTEXT]` / `[TRADITIONAL_COMBAT_CONTEXT]`. With a tactical pending payload it still returns `[TACTICAL_COMBAT_CONTEXT]` (regression).
4. Outcomes: `atMercy` label names winner and loser without "dead/killed"; `surrendered` mentions partner-decided aftermath; `stopped` is neutral and has no winner; unknown outcome falls back.
5. One-shot: after `markNarrationInjected` + `clearNarrationAfterGeneration`, `getPendingNarration` is null; without injection the payload survives.
6. `LEWD_COMBAT_RESULT_NOTICE` and `DEFAULT_LEWD_OUTCOME_PROMPT` contain the no-replay / no-death / no-`[COMBAT]` rules.

`tests/lewd-combat-tool.test.js` (source + registration, mocks like `tests/tactical-combat-tool.test.js`):
1. `registerLewdCombatTool()` calls `unregisterFunctionTool('StartLewdCombat')`, registers once, `displayName === 'Lewd Combat'`, draft-04 schema, properties exactly `['location','mode','openingTechnique','openingZone','participantNames','reason','spectatorNames','tone','title']`, `required: []`, `stealth:false`, and `shouldRegister()` true when `lewdCombatEnabled` + `syspromptModules.lewd_combat` are on.
2. `shouldRegister()` false when: module disabled; section disabled; a lewd board is active in the chat; a pending narration exists; a tactical or traditional board is active in the chat. It must stay true with an empty `currentMemo` and with no `[COMBAT]` (no auto-start coupling).
3. `buildLewdCombatRuntimeOverride`: active lewd board → text contains `[LEWD_COMBAT_OVERRIDE]`, `StartLewdCombat`, and “Do not narrate”; module off → `''`; no board / ended board → `''`; pending narration → `''`.
4. Source assertions: `narrative-hooks.js` contains `name: 'StartLewdCombat'`, `syncLewdCombatToolRegistration`, `[LEWD_COMBAT_OVERRIDE]`, `LEWD_COMBAT_RESULT_NOTICE`; `index.js` contains `MESSAGE_SENT, () => syncLewdCombatToolRegistration()` and a `syncLewdCombatToolRegistration()` init call next to the tactical/traditional calls; `settings.html` contains `rpg_sysprompt_mod_lewd_combat`; `defaults.js` (via imported defaults) has `syspromptModules.lewd_combat === true`; all four sysprompt sources contain `<lewd_combat>` and `StartLewdCombat`.
5. `lewd-combat-ui.js` exports `startLewdCombatFromNarrator` and does not auto-run AI turns in that path (source assertion).
6. `canStartLewdEncounter` returns `ok:false` when a tactical board is active in the chat and `ok:true` when only a finished board exists.

Run:
- Targeted: `npx vitest run tests/lewd-combat-outcome.test.js tests/lewd-combat-tool.test.js --pool=threads`
- U8 regression: `npx vitest run tests/lewd-combat-profile.test.js tests/lewd-combat-engine.test.js tests/lewd-combat-techniques.test.js tests/lewd-combat-pairing.test.js tests/lewd-combat-compendium.test.js tests/lewd-combat-context.test.js tests/lewd-combat-markup.test.js tests/lewd-combat-store.test.js tests/lewd-combat-agent.test.js tests/lewd-combat-prose.test.js tests/tactical-combat-outcome.test.js tests/traditional-combat-outcome.test.js tests/tactical-combat-tool.test.js tests/traditional-combat-tool.test.js tests/combat-prelude-aftermath.test.js tests/sysprompt-content.test.js tests/combat-mode.test.js tests/combat-board-reset.test.js --pool=threads`
- Full gate: `npx vitest run --pool=threads`

## Constraints

- Plain ES modules; no new dependencies; no top-level DOM or network access.
- `lewdCombatEnabled` stays `false` by default; when false the module adds no tool, no override, no section content, and no notice. Tactical/traditional output must remain byte-identical.
- Never close, rewrite, or create `[COMBAT]`, and never touch HP/Willpower/spell slots.
- Prose/outcome are non-authoritative: `lewd-combat-outcome.js` must not call `applyLewdAction` or mutate pools, logs, or engagements.
- No `Math.random`; no narrator/model calls from the outcome module.
- Preserve CRLF/LF as found. Do not normalize whole files. `constants.js` RT_PROMPTS contains very large template literals — insert the block identically in both copies, and keep backticks/`${` escaping intact.
- Do not commit.

## Demo (manual)

Enable the module → narrate an intimate opening → the narrator calls `StartLewdCombat` → the board opens with the named participants → while it is active, `[LEWD_COMBAT_OVERRIDE]` prevents narration of the contest → end by surrender or safe word → the next generation receives `[LEWD_COMBAT_CONTEXT]` with Stamina/Arousal, pairings, limits, and final prose → `[COMBAT]`, HP, and Willpower are unchanged. Disable the module: the tool, section, and override are all gone.

## Commit (for the commit agent, not you)

`feat(lewd-combat): lewd outcome payload and narrator context handoff` (plan Step 10) and
`feat(lewd-combat): narrator tool, sysprompt section, and runtime override` (plan Step 11) —
U8 may land as one commit with both messages’ scope, or two commits in that order.

## Attempts

1. First implementation pass (implement-hard): full suite green (194 files / 1747 tests). Reviewer approved with 0 blockers/majors.
2. Reviewer minors addressed:
   - `buildLewdOutcomePayload` now carries `winnerIds` for the narration-block reconstruction; test added.
   - `resetLewdCombatEncounter` only clears queued narration when `getPendingNarration(...).kind === 'lewd'`, so a tactical/traditional result is never discarded.
   - Added highlight-cap test (last 6 technique beats) and a `tacticalCombatReturnByChat` pending-narration blocking case.
   - `finishEncounterIfEnded` logs queue failures when `debugMode` is on.
   - Re-ran targeted (15 tests) and full suite: 194 files / 1748 tests green.
