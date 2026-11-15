# Brief — lewd-combat-remediation B2 (retrigger latch, cooldown, explicit new encounter)

## Depends on

B1 (`resolution`, `finalizing`, `endedAt`).

## Files

- `src/features/lewd-combat/lewd-combat-context.js`
- `src/features/lewd-combat/lewd-combat-ui.js`
- `src/features/lewd-combat/lewd-combat-store.js`
- `narrative-hooks.js`
- `src/features/combat/combat-board-reset.js`
- `src/state/defaults.js`
- `src/state/settings.js`
- `settings.html`
- `tests/lewd-combat-tool.test.js`
- `tests/lewd-combat-context.test.js`

## New settings

- `lewdCombatPostEncounterLatch` (boolean, default `true`): turn-based latch.
- `lewdCombatPostEncounterCooldownMs` (number, default `60000`, clamp 0..600000):
  mechanical safety net. Both configurable in the Lewd Combat drawer.

## Required behavior

1. Helpers in `lewd-combat-context.js`:
   - `isLewdStartLatched(settings, chatId, { now } = {}) -> { latched, reason }`
     blocks on an ended board with an **unconsumed** resolution, on
     `finalization.finalizing`, and on an ended board younger than the cooldown
     (unless the resolution was consumed by `manual`/`reset`). Legacy ended
     boards with no `endedAt`/`resolution` stay startable.
   - `markLewdResolutionDelivered(settings, chatId, stateId)` stamps
     `resolution.deliveredAt` when the narrator actually injected the outcome.
   - `consumeLewdResolution(settings, chatId, { reason, now })` stamps
     `consumedAt` + `consumedFor` (`manual`, `reset`, `user-turn`).
   - `consumeDeliveredLewdResolution(settings, chatId)` consumes when
     `deliveredAt > 0` and the latch is enabled. Called from the user-turn path.
2. `canStartLewdEncounter` rejects with a clear reason when latched/cooldown.
3. `narrative-hooks.js`:
   - `lewdCombatToolAvailable` and `syncLewdCombatToolRegistration` reject while
     the latch/cooldown is active; call `consumeDeliveredLewdResolution` at the
     start of the sync so the next user turn re-arms the tool.
   - Stamp delivery where `markNarrationInjected` runs for a `kind: 'lewd'`
     pending payload.
   - `buildLewdCombatRuntimeOverride` returns a quiet-period override for an
     ended board with an unconsumed resolution: the scene is over, do not resume
     or restart it, do not call `StartLewdCombat`.
4. UI:
   - Ended state gets a visible **New encounter** action; it consumes/clears the
     latch (and board) and opens the start screen. It does not auto-start a scene.
   - Reset also consumes/clears; closing is unchanged.
   - Starting never creates `[COMBAT]`/`[ENEMY]` tags.
5. `combat-board-reset` keeps clearing the resolution with the board.
6. Store may expose a small read helper if useful, but `lewdCombatByChat` stays
   the single source of truth.

## Tests

- Ended board with unconsumed resolution blocks a start; manual New encounter
  clears the latch and allows a start.
- Delivered + consumed (`user-turn`) allows once the cooldown has expired;
  cooldown still blocks before expiry.
- Tool `shouldRegister()` is false through the pending clear, and true again
  after manual consumption / cooldown expiry.
- Runtime override contains the no-resume/no-restart directive.
- Update the legacy "finished board allows a start" expectation to an ended
  board with no resolution/endedAt.

## Constraints

- No new dependencies. Keep `lewdCombatEnabled: false` inert.
- Do not implement aftermath mercy/memo cleanup (B5) or control modes (B4).
- Do not commit.
