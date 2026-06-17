# Phase 03 — client SSE consumer

## Resume notes (read first)

You own **`web/app.mjs`** (and `web/styles.css` only if the connection indicator
needs a tweak). Do **not** touch `web-server.mjs` (phase-02 owns it concurrently)
or `web/transcript.mjs` (reused as-is). Build against the protocol in
`web/events.mjs` (phase-01): import `EV`, `streamUrl`. The server endpoint is
delivered by phase-02 in parallel — you target the **contract**, not its code.

## Status

- [x] 03.1 — replace the poll loop with an EventSource subscription (b9747df)
- [x] 03.2 — apply `snapshot` / `progress` / `transcript` events to state (fed957a)
- [x] 03.3 — connection status + re-subscribe on agent selection (465c7ac)

## Goal

Turn the dashboard into a push consumer. Replace the 3s polling machinery
(`tick()`, `setInterval(POLL_MS)`, `fetchProgress`, `fetchTranscript`) with a
single `EventSource('/api/stream?watch=<id>')`. Apply server-pushed deltas to the
existing `state` model and re-render with the existing lit-html views. No more
client-side polling; no full transcript re-fetches.

## Non-goals

- Do not change the rendering views (`renderHeader`/`renderAgents`/`renderDetail`/
  `streamBlock`/`agentCard`), the scroll/auto-follow logic, the `parseTranscript`
  import, or the control-action buttons (`postControl` / `act` POST to
  `/api/control`) — those stay.
- Do not edit `web-server.mjs` or remove the old endpoints (phase-04 does cleanup).
- Keep the 1s "time on step" ticker (`TICK_MS`) — it is pure client-side and still
  needed to advance elapsed timers between server pushes.

## Architecture

Swap only the **data layer**; the view layer is untouched.

- **Subscription.** A `subscribe(id)` helper opens
  `new EventSource(streamUrl(id))` and registers listeners:
  - `EV.SNAPSHOT` and `EV.PROGRESS` → `state.model = JSON.parse(e.data)`;
    `state.error = null`; `renderAll()`. (Both set the full model — `snapshot` is
    just the first one / the post-reconnect resync.)
  - `EV.TRANSCRIPT` → `{ id, offset, size, chunk, reset }`; ignore if `id !==
    state.selectedId`; on `reset` clear `state.t`; append `chunk` to `state.t.raw`,
    set `state.t.offset = size`, `state.t.exists = true`; `renderDetail()`.
- **Connection status.** Drive `connStatus()` off EventSource lifecycle instead of
  `lastOk`/`STALE_MS`/poll errors: `es.onopen` → `state.connected = true`,
  `state.error = null`; `es.onerror` → `state.connected = false` (EventSource
  auto-reconnects; the server resends `snapshot` on reconnect so no manual resync
  is needed). Update `connStatus()` to read `state.connected`. Remove `lastOk`,
  `STALE_MS`, `inFlight`, and the `Date.now() - lastOk` staleness math.
- **Agent selection.** `selectAgent(id)` already resets `state.t`; additionally
  close the current `EventSource` and `subscribe(id)` with the new `watch` id (the
  fresh `snapshot` re-syncs the model). Open the initial subscription once the
  first model arrives or on a default/auto-selected agent.
- **Remove:** `POLL_MS`, `tick()`, the `setInterval(tick, POLL_MS)`,
  `fetchProgress`, `fetchTranscript`, and the `visibilitychange → tick()` refetch.
  Keep the `TICK_MS` interval (elapsed timers) and the `document.hidden` guard
  inside it.

## Sequencing

- **03.1 — EventSource subscription replaces the poll loop.** Add `subscribe(id)` /
  teardown; delete `POLL_MS`/`tick`/`fetch*`; wire initial subscription. One commit.
- **03.2 — apply events to state.** Implement the `snapshot`/`progress`/`transcript`
  handlers against the existing `state` shape and re-renders. One commit.
- **03.3 — connection status + re-subscribe on selection.** Move `connStatus()` to
  the EventSource lifecycle; reopen the stream with the new `watch` id from
  `selectAgent()`. One commit.
