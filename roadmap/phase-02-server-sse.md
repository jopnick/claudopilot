# Phase 02 — server SSE endpoint

## Resume notes (read first)

You own **`web-server.mjs` only**. Do **not** touch `web/app.mjs` (phase-03 owns
it concurrently) or the existing `/api/progress` / `/api/transcript` handlers —
they stay in place this phase and are removed later in phase-04 (assembly), so the
old polling client keeps working until the new client lands. Import the protocol
from `web/events.mjs` (phase-01); do not re-invent event names or the delta shape.

## Status

- [x] 02.1 — `GET /api/stream?watch=<id>` handler: headers + initial snapshot (b8d5ec8)
- [ ] 02.2 — server-side watcher pushing `progress` + `transcript` deltas
- [ ] 02.3 — heartbeat + connection teardown

## Goal

Add a single SSE endpoint, `GET /api/stream?watch=<phase-id>`, to
`web-server.mjs`. The backend does the watching once per connection and pushes
incremental updates: a one-time full `snapshot`, then `progress` events when the
run model changes and `transcript` events carrying only newly-appended bytes for
the watched agent. This is the server half of replacing the 3s client poll.

## Non-goals

- Do not remove or modify `/api/progress`, `/api/transcript`, or `/api/control`.
- Do not change the client (`web/app.mjs`) — phase-03 owns it.
- No external deps (ws, sse libraries); use `node:http` + `node:fs` only, matching
  the existing file's style.

## Architecture

Reuse what `web-server.mjs` already has — do not duplicate it:

- `getProgress()` — already shells out to `progress.mjs --json`; use it verbatim
  for the snapshot and for each `progress` push.
- `transcriptPath(id)` and `readTail(path, offset)` — already resolve the watched
  agent's transcript file and return `{ size, chunk }` from a byte offset. The
  `readTail` result maps directly onto the phase-01 delta shape
  `{ id, offset, size, chunk, reset }`.
- `ID_RE` — validate `watch` exactly as the other endpoints validate `id`.

New handler `GET /api/stream`:

1. Validate `watch` with `ID_RE` (400 on bad input). Write SSE response headers:
   `content-type: text/event-stream`, `cache-control: no-store`,
   `connection: keep-alive`, and flush headers.
2. Send `encodeEvent({ event: EV.SNAPSHOT, data: <getProgress model> })` once.
   Send an initial `transcript` delta from offset 0 if a transcript already exists.
3. **One server-side watcher per connection** (this is "the backend does the
   polling"): a single debounced loop that detects changes to (a) the roadmap dir
   / `.claudopilot/` — manifest + transcript-set changes — and (b) the watched
   transcript file. Prefer `fs.watchFile` / a single stat-based interval (robust
   cross-platform, mirrors the existing offset approach, and is **one** poller no
   matter how many browsers connect). On change, debounced:
   - re-run `getProgress()` → push `EV.PROGRESS` (skip if the serialized model is
     byte-identical to the last one sent — avoids needless re-paints);
   - `readTail(transcriptPath(watch), lastOffset)` → if `chunk` is non-empty push
     `EV.TRANSCRIPT` `{ id: watch, offset: lastOffset, size, chunk, reset }` and
     advance `lastOffset = size`; set `reset` when the file shrank.
4. Heartbeat: `setInterval` every `HEARTBEAT_MS` writing `encodeComment("hb")`.
5. Teardown: on `req.on("close")` clear the interval(s), stop the watcher, and
   `res.end()`. Guard all writes against a destroyed socket (EPIPE-safe), matching
   the tolerant style already in the file.

## Sequencing

- **02.1 — handler skeleton + initial snapshot.** Route `GET /api/stream`, validate
  `watch`, write SSE headers, send the one-time `snapshot` (and an initial
  transcript delta from offset 0 if present). Verify with
  `curl -N 'http://127.0.0.1:4317/api/stream?watch=phase-01'` showing a `snapshot`
  event. One commit.
- **02.2 — change-driven deltas.** Add the single debounced server-side watcher
  that pushes `progress` (deduped) and `transcript` (byte-delta) events on file
  changes, advancing `lastOffset`. One commit.
- **02.3 — heartbeat + teardown.** Add the `HEARTBEAT_MS` comment ping and full
  cleanup on `req`-close (no leaked intervals/watchers). One commit.
