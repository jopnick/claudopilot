# Phase 05 — verify

## Resume notes (read first)

Final phase; runs after assembly. Adds the tests that lock in the SSE behavior and
proves the bandwidth win (no full-document re-sends). Touches **test files only**
plus, if needed, a `package.json` `scripts.test` entry pointing at the gate — do
not modify `web-server.mjs`, `web/app.mjs`, or `web/events.mjs` behavior here. If a
test surfaces a real bug, fix the smallest thing and note it in §Resume notes.

## Status

- [ ] 05.1 — unit coverage for the delta/encoder contract
- [ ] 05.2 — end-to-end SSE smoke test
- [ ] 05.3 — bandwidth assertion + manual run notes

## Goal

Verify the migration end-to-end: the SSE channel emits the right events on real
file changes, transcript bytes are sent incrementally (never the whole document
again), and reconnect resyncs cleanly.

## Non-goals

- No production-behavior changes; tests + minimal scaffolding only.
- No new SSE features or protocol changes.

## Architecture

- **Unit (`web/events.test.mjs`, extend phase-01's):** round-trip the
  `{ id, offset, size, chunk, reset }` delta through `encodeEvent` and a small
  parse helper; assert event framing and `streamUrl` encoding. `node:test`.
- **End-to-end smoke (`web/stream.e2e.test.mjs`):** spin up `web-server.mjs` on an
  ephemeral port against a temp `roadmap/` + `.claudopilot/` fixture; open the
  stream with `curl -N` (or a raw `http.get` reading `text/event-stream`) for
  `watch=<fixture phase>`; assert an initial `snapshot` arrives; append bytes to
  the fixture transcript and assert a `transcript` event carrying **only** the
  appended bytes (its `offset` equals the previous `size`); edit the fixture
  manifest and assert a `progress` event; then drop and reopen the connection and
  assert a fresh `snapshot`.
- **Bandwidth assertion:** in the smoke test, after several transcript appends,
  assert the sum of `chunk` bytes received ≈ the bytes appended (i.e. the full
  transcript is not retransmitted each tick) — this is the core regression guard
  for "we aren't sending full jsonl docs."
- **Manual run notes:** document `node web-server.mjs` + open the dashboard, watch
  an agent, observe live updates with the Network tab showing one long-lived
  `text/event-stream` instead of repeated `/api/progress` requests.

## Sequencing

- **05.1 — unit coverage.** Delta/encoder round-trip tests. One commit.
- **05.2 — e2e smoke test.** Boot server against a fixture; assert
  `snapshot`/`progress`/`transcript` + reconnect. One commit.
- **05.3 — bandwidth assertion + notes.** Incremental-bytes assertion and the
  manual-run section; flip the manifest `**Status:**` to `complete` is the
  driver's job, not the worker's. One commit.
