# Phase 01 — scaffold + shared types + platform primitives

## Resume notes (read first)

This is the **keystone**: the TypeScript project setup, the shared type contracts
every other phase imports, and the cross-platform primitives. Get the type names
and signatures right — phases 02–06 build against them in parallel without seeing
each other's code. Pure setup + small, heavily-unit-tested utilities; no porting of
driver logic yet. Target: **Linux/macOS/Windows-via-WSL2**, so write OS-agnostic
Node (use `node:path`, spawn binaries directly — never `shell: true` with bash-isms).

## Status

- [x] 01.1 — TS build/test tooling (tsconfig, tsup, vitest, eslint) + package.json scripts (4f3b733)
- [x] 01.2 — `src/types.ts` shared interfaces (568aa24)
- [x] 01.3 — `src/platform/process.ts` (spawn + process-group kill) + tests (5936bf7)
- [x] 01.4 — `src/platform/{which,signals,dockerPath}.ts` + tests (7df00b0)

## Goal

Stand up the TypeScript application skeleton and the foundational modules the rest
of the port depends on: the type vocabulary (`src/types.ts`) and the platform shims
(`src/platform/*`) that isolate every OS-sensitive operation. After this phase
`pnpm typecheck`, `pnpm test`, and `pnpm build` all run green on an essentially
empty engine.

## Non-goals

- No porting of `run-loop.sh` / `run-in-docker.sh` / `progress.mjs` logic — that is
  later phases.
- Do not touch the bash scripts or existing `.mjs` (dual-stack: they keep working).
- No `git`/`docker`/`agent` wrappers yet (phases 02–04) beyond the generic
  `spawn`/`which` primitives they will build on.

## Architecture

- **Tooling (01.1):** `tsconfig.json` (ESM, `strict`, `moduleResolution: bundler`),
  `tsup.config.ts` (entry `src/cli.ts` → `dist/`, ESM, shebang), `vitest.config.ts`,
  eslint/prettier. **Scope tsconfig `include` to `["src"]` and vitest
  `test.include` to `src/**` (and ignore the repo-root `claudopilot` entry) — the
  repo has a self-referential `claudopilot -> .` symlink, so an unscoped tree walk
  would recurse forever through `claudopilot/claudopilot/…`. Add to `package.json`: `devDependencies` (typescript, tsup,
  vitest, @types/node, eslint) and scripts `build`/`typecheck` (`tsc --noEmit`)/
  `test` (**`vitest run --passWithNoTests`** so the gate is green before any test
  file exists)/`lint` (eslint — run in CI, not the per-slice gate). The project gate
  (`claudopilot.config.sh`) is `pnpm -s typecheck && pnpm -s test`, so define those
  two scripts in **01.1** before anything else. **`package.json` is owned by this
  phase only.** Keep `type: module`. Do not yet repoint `bin` (phase-07 does the
  switch).
- **Types (01.2) — `src/types.ts`:** the contracts, mirroring today's shapes:
  - `PhaseState = "pending" | "running" | "merged" | "failed" | "blocked"`.
  - `PhaseEntry { id; state; title; deps: string[] }` and `ManifestModel { status;
    phases: PhaseEntry[] }` (matches `order_lines` output + `**Status:**`).
  - `Config` — the knobs sourced from `claudopilot.config.sh` / env in `run-loop.sh`
    (GATE_CMD, MAX_PARALLEL, KEEP_GOING, ROADMAP_DIR, MANIFEST, ISOLATED,
    WORKER_IMAGE, STUCK_TIMEOUT, RETRY_TRANSIENT_API, USAGE_* …) as typed fields.
  - `AgentEvent` / `RenderBlock` — the stream-json event + rendered-transcript block
    shapes (align with `render-stream.mjs` + `web/transcript.mjs`).
  - `CapturePaths { log; stream; transcript }`, `WorkerHandle { id; pid?; child? }`.
  - The progress snapshot model type (superset used by `progress.mjs` + `web`).
- **Platform (01.3/01.4) — `src/platform/`:**
  - `process.ts`: `spawnCapture(cmd, args, opts)` and a `spawnDetached` that starts a
    child in its **own process group** (`detached: true`) so the orchestrator can
    signal the whole tree; `killTree(handle, signal)` → `process.kill(-pid, signal)`
    on POSIX/WSL (replaces `kill_tree`/`pgrep`). `reapExit` helper.
  - `which.ts`: cross-platform executable lookup (replaces `command -v`).
  - `signals.ts`: install SIGINT/SIGTERM handlers that drain + clean up (the bash
    trap equivalent), exposing an `onShutdown(cb)` registry.
  - `dockerPath.ts`: host-path → container bind-mount path normalization (WSL/macOS).
- **Tests:** vitest unit tests for `which` (found/not-found), `dockerPath` mapping,
  and `killTree` against a spawned sleeper (assert the group dies). Types are
  compile-checked by `tsc --noEmit` in the gate.

## Sequencing

- **01.1 — tooling.** Add tsconfig/tsup/vitest/eslint + package.json devDeps &
  scripts; `pnpm build` on an empty `src/cli.ts` stub succeeds. One commit.
- **01.2 — types.** `src/types.ts` with the interfaces above; `tsc --noEmit` green.
  One commit.
- **01.3 — process primitives.** `src/platform/process.ts` (`spawnCapture`,
  `spawnDetached`, `killTree`, `reapExit`) + tests. One commit.
- **01.4 — which/signals/dockerPath.** Remaining `src/platform/*` + tests. One commit.
