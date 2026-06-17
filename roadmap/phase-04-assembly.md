# Phase 04 — assembly / remove polling

## Resume notes (read first)

Runs only after **both** phase-02 (server) and phase-03 (client) are merged, so
the SSE path is end-to-end live and the old polling endpoints are now dead code.
This phase does the cross-cutting cleanup that the two parallel streams
deliberately left undone (each was kept independently green by *not* deleting the
other side's contract). Touches `web-server.mjs`, `web/app.mjs`, and `README.md`.

## Status

- [x] 04.1 — remove dead polling endpoints from `web-server.mjs` (6457272)
- [ ] 04.2 — remove dead polling remnants from `web/app.mjs`
- [ ] 04.3 — verify reconnect/resync end-to-end + update README

## Goal

Complete the full replacement: delete the now-unused `GET /api/progress` and
`GET /api/transcript` handlers and any client-side polling remnants, confirm the
EventSource reconnect → fresh-`snapshot` resync works against the live server, and
document the SSE dashboard in the README.

## Non-goals

- Do not change the SSE event protocol (`web/events.mjs`) or the `/api/stream`
  behavior — those are settled.
- Keep `POST /api/control` and the static-file serving exactly as they are.
- No new features; this is removal + verification + docs only.

## Architecture

- **`web-server.mjs`:** delete the `if (path === "/api/progress")` and
  `if (path === "/api/transcript")` GET branches. Keep `getProgress`,
  `transcriptPath`, `readTail`, and `ID_RE` — they are now used by `/api/stream`.
  Keep `/api/control` and static serving. Confirm nothing else references the
  removed routes.
- **`web/app.mjs`:** confirm no leftover references to the removed endpoints or
  poll constants survive (they were removed in phase-03; this is a sweep for
  stragglers and dead helpers/comments).
- **Reconnect/resync check:** with a server running, kill and restore the
  connection (or restart the watcher) and confirm the browser re-receives a
  `snapshot` and repaints without a manual refresh — EventSource auto-reconnects
  and the server resends `snapshot` per connection, so there is no `Last-Event-ID`
  gap to handle.
- **`README.md`:** update the web-dashboard section to describe the SSE model
  (one `GET /api/stream?watch=<id>` channel, server-side watcher, push deltas)
  and remove any mention of the 3s polling / `/api/progress` / `/api/transcript`.

## Sequencing

- **04.1 — remove server polling endpoints.** Delete the two GET branches from
  `web-server.mjs`; confirm `/api/stream` and `/api/control` still serve. One commit.
- **04.2 — sweep client remnants.** Remove any straggler poll references/dead code
  in `web/app.mjs`. One commit.
- **04.3 — resync check + README.** Confirm reconnect→snapshot end-to-end; rewrite
  the README dashboard section for SSE. One commit.
