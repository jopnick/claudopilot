# Phase 05 — verify

## Resume notes (read first)

Final phase; runs after assembly. Adds the tests that lock in the SSE behavior and
proves the bandwidth win (no full-document re-sends). Touches **test files only**
plus, if needed, a `package.json` `scripts.test` entry pointing at the gate — do
not modify `web-server.mjs`, `web/app.mjs`, or `web/events.mjs` behavior here. If a
test surfaces a real bug, fix the smallest thing and note it in §Resume notes.

## Status

- [x] 05.1 — unit coverage for the delta/encoder contract (2471f6e)
- [x] 05.2 — end-to-end SSE smoke test (315d21f)
- [x] 05.3 — bandwidth assertion + manual run notes (f3e0b3a)

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

## Manual verification

The automated suite (`node --test web/*.test.mjs`) covers the protocol; this
section is the human's eye-check that the dashboard actually behaves like the
new pull-from-server model. Run against a live `run-loop.sh` (or any run that
is producing transcripts):

1. `node web-server.mjs` — starts the dashboard on `http://127.0.0.1:4317`.
2. Open the dashboard in a browser; click into a phase that's `[running]` so
   the right-hand panel is following its transcript.
3. Open DevTools → Network → filter on `stream`. You should see **one**
   `text/event-stream` request with status `200`, transfer staying open for
   the lifetime of the tab — not a recurring `/api/progress` or
   `/api/transcript` row every few seconds. (The legacy endpoints now 404; if
   you see retries hammering them, the browser cached an old `app.mjs`.)
4. Watch the EventStream tab on that request: each new file change appears as
   a single SSE record. `progress` rows are full-snapshot JSON; `transcript`
   rows carry only the bytes that just appeared on disk (you can confirm by
   `wc -c .claudopilot/<id>.transcript.md` before/after).
5. Network-tab "throttle: offline" then "online" closes the connection;
   EventSource auto-reconnects and the server replays a fresh `snapshot`. The
   UI should re-render the current state with no manual refresh.

Bandwidth check: the bytes flowing over the long-lived stream should
approximately equal the bytes being appended to the watched transcript file
over the same window — i.e., the regression guard the `stream.e2e.test.mjs`
bandwidth test asserts in code, but visible at a glance in the Network panel.
