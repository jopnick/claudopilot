# Phase 07 — CLI integration + dual-stack switch

## Resume notes (read first)

Runs after phase-04, 05, and 06 are merged, so `runner/`, `progress|web/`, and
`orchestrator/` all exist. You own **`src/cli.ts`** and the edit to
**`bin/claudopilot.mjs`** (the engine switch). Wire the subcommands in-process and
make both stacks coexist. Source of truth: `bin/claudopilot.mjs` (168 lines —
`init`/`run`/`progress`/`web` dispatch).

## Status

- [x] 07.1 — `src/cli.ts` subcommand dispatch (init/run/progress/web/version/help) (166dc26)
- [x] 07.2 — `bin/claudopilot.mjs` dual-stack engine switch (dffe041)

## Goal

Provide a single TS entry that runs every subcommand in-process (no bash), and an
engine switch in the published `bin` so the TS and bash stacks coexist until cutover.

## Non-goals

- Do not remove the bash scripts or flip the default engine (phase-08 does cutover).
- Do not change command surface/flags — parity with today's CLI.

## Architecture

- **`src/cli.ts`** — parse argv and dispatch: `init` (scaffold; reuse the existing
  `ENGINE_FILES`/`PROJECT_FILES` copy logic), `run [--isolated|--shell]` → call
  `runner/runInDocker.ts`, `progress [args]` → `progress/render.ts`, `web [--port]`
  → `web/server.ts`, `--version`/`--help`. Built by tsup to `dist/cli.js` with a
  shebang.
- **`bin/claudopilot.mjs`** — add a one-line switch: when `CLAUDOPILOT_ENGINE=ts`
  (or a `--engine ts` flag), delegate to `dist/cli.js`; otherwise keep today's
  bash-shelling behavior. Default stays `bash` this phase. This is what makes the
  port runnable side-by-side for differential testing.
- **Tests:** invoke the built `dist/cli.js --version`/`--help`; assert
  `CLAUDOPILOT_ENGINE=ts claudopilot progress --json` routes to the TS path and
  produces the same model shape as the bash path on a fixture run.

## Sequencing

- **07.1 — cli.ts.** In-process dispatch for all subcommands; `dist/cli.js`
  builds and `--version`/`--help` work. One commit.
- **07.2 — engine switch.** `bin/claudopilot.mjs` honors `CLAUDOPILOT_ENGINE`/
  `--engine`; default bash; routing test. One commit.
