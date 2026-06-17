# Phase 01 — contracts / SSE event vocabulary

## Resume notes (read first)

This phase is the **shared interface** that phase-02 (server) and phase-03
(client) both build against without seeing each other's code. Get the names and
shapes right; downstream phases will not redefine them. Pure module only — no
`node:http`, no DOM, no I/O — so it imports cleanly into both the server process
and the browser bundle and is unit-testable in Node.

## Status

<!-- Seed from §Sequencing on the first tick; flip `[ ]`→`[x]` + append the short
     SHA on each slice commit. Source of truth for "what's left." -->

- [ ] 01.1 — `web/events.mjs` event vocabulary + wire-format encoder
- [ ] 01.2 — unit test for `web/events.mjs`

## Goal

Introduce `web/events.mjs`: the single definition of the SSE channel the
dashboard migration is built on — event names, the SSE wire-format encoder, the
transcript-delta payload shape, the `/api/stream` URL/`watch` param contract, and
the heartbeat interval. Both the server endpoint (phase-02) and the browser
consumer (phase-03) import from here, so they agree on the protocol while being
developed in parallel worktrees.

## Non-goals

- No `node:http` server wiring (that is phase-02).
- No DOM / EventSource consumption (that is phase-03).
- No changes to `web-server.mjs`, `web/app.mjs`, or the existing
  `/api/progress` / `/api/transcript` endpoints — those stay untouched this phase.

## Architecture

`web/events.mjs` (ES module, no imports, browser- and Node-safe):

- **Event-name constants** — exported so neither side hardcodes strings:
  - `EV.SNAPSHOT = "snapshot"` — full `progress.mjs` model (initial paint + every
    reconnect resync).
  - `EV.PROGRESS = "progress"` — updated full progress model after a manifest /
    transcript-set change.
  - `EV.TRANSCRIPT = "transcript"` — incremental transcript append for the watched
    agent.
  - `EV.ERROR = "error"` — server-side error surfaced to the client.
- **`STREAM_PATH = "/api/stream"`** and a helper `streamUrl(id)` →
  `"/api/stream?watch=<encoded id>"`, so the client builds the URL the same way
  the server parses it.
- **`HEARTBEAT_MS = 15000`** — comment-ping cadence to keep proxies from closing
  an idle stream.
- **Transcript-delta shape**, identical semantics to today's `/api/transcript`
  response so the existing `readTail()` output drops straight in:
  `{ id, offset, size, chunk, reset }` — `offset` = byte position the chunk starts
  at, `size` = new total file size, `chunk` = the appended bytes, `reset` = true
  when the file shrank/rotated and the client must clear its buffer.
- **`encodeEvent({ event, id, data })`** → a single SSE record string:
  `event: <event>\n`, optional `id: <id>\n`, then `data: <JSON.stringify(data)>\n`
  (one `data:` line; JSON is newline-free so multi-line splitting is unnecessary),
  terminated by a blank line. Provide a matching `encodeComment(text)` →
  `: <text>\n\n` for heartbeats.

Keep it tiny and dependency-free; this is a vocabulary module, not a framework.

## Sequencing

- **01.1 — `web/events.mjs` event vocabulary + wire-format encoder.** Create the
  module with the constants, `streamUrl`, `encodeEvent`, and `encodeComment`
  above. Document the transcript-delta shape in a comment block. One commit.
- **01.2 — unit test for `web/events.mjs`.** A `node:test` file
  (`web/events.test.mjs`) asserting: `encodeEvent` emits well-formed
  `event:`/`data:` records ending in a blank line; `id:` is included only when
  passed; `encodeComment` emits a `:`-prefixed line; `streamUrl` round-trips an id
  with special characters through `encodeURIComponent`. Must pass under the
  project gate (`node --test`). One commit.
