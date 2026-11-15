# Brief — lewd-combat-remediation B3 (prose transcript, every exchange beat, stale guard)

## Depends on

B1 for persistence semantics (soft).

## Files

- `src/features/lewd-combat/lewd-combat-ui.js`
- `src/features/lewd-combat/lewd-combat-prose.js`
- `src/features/lewd-combat/lewd-combat-markup.js`
- `src/features/lewd-combat/lewd-combat-engine.js`
- `style.css`
- `tests/lewd-combat-prose.test.js`
- `tests/lewd-combat-markup.test.js`

## Required state

- `state.proseLog` capped at 50 entries. Entry:
  `{ id, stateId, chatId, round, exchangeId, actorIds, beatIds, text, source, createdAt }`.
- `state.lastNarratedLogIndex` (default `-1`) and `state.narratedBeatIds` (array).
- `state.proseSeq` for stable entry ids. `state.prose` stays the latest entry
  text for backwards compatibility.

## Required behavior

1. Engine exports helpers:
   - `lewdBeatId(state, beat, index)` stable id.
   - `appendLewdProseEntry(state, entry)` appends, caps at 50, sets `state.prose`.
   - `markLewdBeatsNarrated(state, upToIndex, beatIds)`.
   - hydrate/serialize preserve the prose log and counters; create state seeds
     empty defaults.
2. `lewd-combat-prose.js` exports `selectUnnarratedBeats(state)` returning
   `[{ beat, index }]` for every log entry after `lastNarratedLogIndex`, and
   `buildLewdFallbackProseEntries(state, items)` returning deterministic
   `describeLewdBeat` entries (`source: 'fallback'`, one per beat).
3. `narrateAfterExchange`:
   - uses every beat since the last narrated index (player action + AI reply),
   - appends to `proseLog`; never overwrites a previous entry,
   - on model failure or missing connection appends the deterministic fallback
     entries instead of dropping the beats,
   - on `deferred` keeps the items for the `GENERATION_ENDED` flush,
   - on `skipped` (frequency gate) advances nothing and appends nothing,
   - tags the async result with `{ stateId, chatId, renderToken }` and discards
     it if the board was reset, closed, or the chat changed.
4. Markup renders `proseLog` as a chronological transcript inside `.rt-lc-prose`
   (newest last) with a scroll container, data attributes per entry
   (`data-lc-prose-entry`), and keeps the legacy `view.prose` / `state.prose.text`
   / `describeLewdBeat` fallback path. Beat log stays separate.
5. UI auto-scrolls the prose transcript to the bottom after render. Add the
   `rt-lc-prose-scroll` styles to `style.css`.

## Tests

- A player beat followed by an AI beat selects two entries, and the rendered
  transcript keeps both in order after the AI entry is appended.
- Failure/fallback path appends deterministic entries for every un-narrated beat.
- `proseLog` caps at 50 and keeps the newest entries.
- Hydration restores the prose log.
- Importing the UI still has no DOM side effects; existing markup/beat-log
  expectations stay green.

## Constraints

- No new dependencies. Prose remains non-authoritative and on the Main connection.
- Do not change engine math or outcome/tool behavior.
- Do not commit.
