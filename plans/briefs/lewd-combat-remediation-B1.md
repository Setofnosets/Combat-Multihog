# Brief — lewd-combat-remediation B1 (end-of-encounter lifecycle and idempotent finish)

## Goal

Make the lewd encounter finish exactly once and persist a durable `resolution`
record so the rest of the system can latch on it. No retrigger logic yet (B2),
no prose transcript yet (B3).

## Files

- `src/features/lewd-combat/lewd-combat-engine.js`
- `src/features/lewd-combat/lewd-combat-ui.js`
- `src/features/lewd-combat/lewd-combat-outcome.js`
- `src/features/lewd-combat/lewd-combat-store.js`
- `tests/lewd-combat-outcome.test.js`
- `tests/lewd-combat-integration.test.js`

## Required behavior

1. `endEncounter` stamps `state.endedAt = Date.now()` when it first ends.
2. `finishEncounterIfEnded(state)` (exported for tests) re-reads the persisted
   board and:
   - guards on `status === 'ended'`,
   - writes `state.resolution` exactly once:
     `{ stateId, endedAt, consumedAt: 0, consumedFor: '', outcome, winnerIds,
        atMercyIds, surrenderedIds, source: 'lewd' }`,
   - is a no-op when the resolution already exists and `finalization.narrationQueued`
     is already true,
   - never starts the auto-narration path twice (`finalization.autoNarrateStarted`).
   - accepts `options.autoNarrate === false` so tests can call it without the host.
3. `queueLewdOutcome` sets `state.finalization.finalizing = true` and
   `finalizingStartedAt` on first queue (in addition to `narrationQueued`).
4. Same `stateId` never produces a second queued payload even if the board is
   re-read/hydrated.
5. Reset removes the board (including `resolution`) and the lewd pending
   narration; the prose queue reset remains.
6. `hydrateLewdState`/`serializeLewdState` preserve `endedAt` and `resolution`.

## Tests

- Ending a board queues exactly one payload; calling `finishEncounterIfEnded`
  again returns without a second queue.
- `resolution` exists with the expected shape and `finalization.finalizing` is
  true after queueing.
- A reset removes the board and pending narration.
- Existing outcome/integration suites stay green.

## Constraints

- No new dependencies. Preserve public interfaces. No `Math.random`.
- Do not add retrigger/cooldown/prose features here.
- Do not commit.
