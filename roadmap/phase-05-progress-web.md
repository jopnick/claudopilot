# Phase 05 — progress + web server

## Resume notes (read first)

You own **`src/progress/*`** (`model.ts`, `render.ts`) and **`src/web/server.ts`** +
tests. Import types from phase-01, `manifest.ts` from phase-02, and the render/event
types from phase-03 (all merged deps). Do not touch the browser assets under
`web/*.mjs` (they stay; the SSE server just serves them) or `src/orchestrator/*`.
Source of truth: `progress.mjs` (514 lines — snapshot model, `--watch`, `--follow`)
and `web-server.mjs` (311 lines — the SSE `/api/stream` server, already migrated).

## Status

- [x] 05.1 — `src/progress/model.ts` snapshot model (fb10caf)
- [x] 05.2 — `src/progress/render.ts` snapshot / watch / follow CLI views (c3a3a3d)
- [ ] 05.3 — `src/web/server.ts` SSE server

## Goal

Port the read-only progress view and the web dashboard server to TS, reusing
`manifest.ts` for parsing so the CLI, the driver, and the dashboard share one model.

## Non-goals

- No driver/scheduler logic (phase-06). Progress is read-only over run artifacts.
- Do not change the SSE wire protocol or the browser client (`web/app.mjs`,
  `web/events.mjs`) — serve them as-is.
- Do not edit `progress.mjs`/`web-server.mjs` (bash stack keeps using them).

## Architecture

- **`src/progress/model.ts`** — port `progress.mjs`'s snapshot builder: read the
  manifest (via `manifest.ts`), compute per-phase slice counts, live "step"/token
  telemetry from the stream/transcript, summary totals, container status, and the
  driver-log tail. Returns the typed snapshot model from `src/types.ts`. Honors
  `ROADMAP_DIR`/`MANIFEST`; resolve `REPO_ROOT` explicitly (don't repeat the
  `resolve(HERE,"..")` self-host quirk — take repo root from config/cwd).
- **`src/progress/render.ts`** — the CLI renderers: `--json` (the model), the
  default snapshot table, `--watch` (live multi-agent view), `--follow <id>`
  (stream one transcript). Mirrors `progress.mjs`'s ANSI output.
- **`src/web/server.ts`** — port `web-server.mjs`: the SSE `GET /api/stream?watch=<id>`
  endpoint (snapshot + debounced progress + transcript byte-deltas + heartbeat,
  `watch` optional), `POST /api/control` (drops poke/retry files), and static
  serving of `web/*`. Reuse `progress/model.ts` for the snapshot instead of shelling
  to `progress.mjs`. Keep the byte-offset transcript tailing.
- **Tests:** snapshot model over a fixture run dir (assert phases/slices/summary);
  an SSE smoke test booting the server against a fixture (snapshot + a transcript
  append delta), mirroring `web/stream.e2e.test.mjs`.

## Sequencing

- **05.1 — model.** `progress/model.ts` snapshot builder + fixture test. One commit.
- **05.2 — render.** `--json`/snapshot/`--watch`/`--follow` renderers. One commit.
- **05.3 — web server.** `src/web/server.ts` SSE + control + static; SSE smoke test.
  One commit.
