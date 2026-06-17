# Phase 03 — agent capture + render

## Resume notes (read first)

You own **`src/agent/*`** (`render.ts`, `renderOpencode.ts`, `capture.ts`,
`detect.ts`) + tests. Import types from `src/types.ts` (phase-01). Runs concurrently
with phase-02 — do not touch `src/manifest.ts`/`src/git.ts`. Source of truth:
`render-stream.mjs` (139 lines), `render-stream-opencode.mjs` (154), the
`capture_agent` function in `run-loop.sh` (~280–304), the resume/detection helpers
(`mark_resume`, `is_rate_limited`, `is_transient_api_error` ~368–405), and
`web/transcript.mjs` (a working block parser to mirror).

## Status

- [x] 03.1 — `src/agent/render.ts` (port render-stream.mjs) + `renderOpencode.ts` (094297c)
- [x] 03.2 — `src/agent/capture.ts` in-process capture pipeline (a36a75e)
- [ ] 03.3 — `src/agent/detect.ts` (session-id / rate-limit / transient-API)

## Goal

Port the agent I/O layer: turn `claude`/`opencode` stream-json into the rendered
transcript **in-process** (no `node render-stream.mjs` subprocess, no `tee`
binaries), and provide the resume-session-id + rate-limit + transient-API detection
the driver relies on.

## Non-goals

- No scheduling / supervisor / merge logic (phase-06). `capture.ts` exposes a
  function the driver calls; it does not decide what to do with the result.
- Do not edit `render-stream*.mjs` (they stay for the bash stack until cutover).

## Architecture

- **`src/agent/render.ts`** — pure port of `render-stream.mjs`: `renderEvent(ev):
  string[]` and a streaming `RenderStream` (a `Transform`/incremental function) that
  consumes NDJSON events and emits the same transcript markers (`=== … ===`
  dividers, `[thinking]`/`[assistant]`/`[user]`, `-> tool:`, `<- result:`), with the
  same truncation caps. `renderOpencode.ts` mirrors it for the opencode `--format
  json` events. Keep tolerant: unknown/malformed lines skipped, never throw.
- **`src/agent/capture.ts`** — `captureAgent({ driver, prompt, resumeSid, cwd, env,
  paths, model })`: spawn `claude -p … --output-format stream-json` (or `opencode
  run … --format json`) via the platform spawner; pipe stdout line-by-line through
  the in-process renderer; **tee** raw NDJSON to `paths.stream`, rendered text to
  `paths.transcript`, and stderr+rendered to `paths.log` using Node `WriteStream`s
  (replacing the `tee | node render | tee` shell pipeline). Resolve with the agent's
  exit code. Handles the `--resume <sid>` fresh-vs-resume branch (mirrors
  `capture_agent` + `worker-entry.sh`).
- **`src/agent/detect.ts`** — tail-of-log/stream scanners ported verbatim from the
  bash regexes: `extractSessionId(streamPath)` (the `"session_id":"…"` grab in
  `mark_resume`), `isRateLimited(logText)`, `isTransientApiError(logText)`,
  `parseCooldownSeconds(logText)` (the `cool_down` retry-hint parser).
- **Tests:** feed recorded NDJSON fixtures through `render.ts` and assert the
  transcript matches the bash renderer's output for the same input (golden test);
  unit-test each `detect.ts` matcher with representative log lines.

## Sequencing

- **03.1 — renderers.** Port `render.ts` + `renderOpencode.ts`; golden-test against
  fixture NDJSON. One commit.
- **03.2 — capture.** `captureAgent` spawn + in-process render + tee-to-files +
  resume branch. One commit.
- **03.3 — detect.** session-id / rate-limit / transient-API / cooldown matchers +
  tests. One commit.
