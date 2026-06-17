# Phase 06 — orchestrator / driver

## Resume notes (read first)

You own **`src/orchestrator/*`** (`driver.ts`, `worker.ts`, `supervisor.ts`,
`control.ts`) + tests. Import everything from merged deps: types (01),
`manifest.ts`/`git.ts`/`config.ts` (02), `agent/capture.ts`+`detect.ts` (03). Do not
touch `src/runner/*` (phase-04) or `src/progress|web` (phase-05) — the CLI (phase-07)
wires them together. **This is the keystone and the bulk of the parity risk**: it
ports `run-loop.sh`'s entire scheduling/lifecycle core (~134–782). Re-read that file
end-to-end before starting; preserve exit-code semantics exactly (0/2/3/4/5/6/7/8).

## Status

- [x] 06.1 — `src/orchestrator/worker.ts` (prepare worktree/clone, launch, kill) (e4a0cdc)
- [x] 06.2 — `src/orchestrator/supervisor.ts` + `control.ts` (ff84ad9)
- [x] 06.3 — `src/orchestrator/driver.ts` scheduler loop + terminal/exit semantics (a5bdf3e)

## Goal

Port the driver: schedule eligible phases up to `MAX_PARALLEL`, run each worker
(local subprocess or isolated container), reap exits and route them
(merge / supervise / park / halt), run the stuck-watchdog and control seam, detect
completion/deadlock, and shut down cleanly on signals — all with the same exit codes
and manifest transitions as the bash loop.

## Non-goals

- No image build / launch-mode logic (phase-04 owns `runner/`). The driver uses
  `docker.ts` for per-phase worker containers in isolated mode.
- No CLI arg parsing (phase-07). The driver is invoked with a resolved `Config`.
- Do not edit `run-loop.sh` (it stays for differential testing in phase-08).

## Architecture

- **`worker.ts`** — `prepareWorktree(id)` (branch + `git worktree add` or, isolated,
  `git clone` the per-phase disposable copy), `launch(id)` (compose the worker
  prompt = base + project overlay + GATE_CMD; non-isolated → `captureAgent` in the
  worktree as a detached process group; isolated → `docker.run` the worker container
  against the clone, writing the prompt file first), `setCapturePaths`, `killWorker`
  (`platform/killTree` or `docker rmForce`), `cleanup`. Tracks the live `WorkerHandle`
  map (the `PID/WT/STREAM/...` assoc arrays).
- **`supervisor.ts`** — `branchHasDone(id)` (isolated → read the **clone's** branch
  directly, matching the fixed bash `branch_has_done`; else host ref),
  `merge_phase` (fetch clone→host in isolated, `git merge --no-ff`, `setState
  merged`, commit build-log, push, cleanup), `supervise(id, code)` (rate-limit
  cooldown / transient-retry / supervisor attempts with widening mandate / park),
  `markResume`, `commitBuildLog` (gzip stream + copy transcript to `build-logs/`).
- **`control.ts`** — drain `$CONTROL_DIR` poke/retry files (`process_control`) and
  the stuck-watchdog (`check_stuck` over stream byte-growth).
- **`driver.ts`** — the scheduler loop: base-branch guard (refuse trunk),
  bootstrap, then each pass: completion check (all merged → `**Status:** complete`,
  exit 0) → reap finished workers (`handle_exit`: 0/5/6→done-or-supervise,
  2→checkpoint, 4→dep-error, else→rate-limit/transient/park) → control + watchdog →
  checkpoint marker → usage-window gating → launch eligible up to `MAX_PARALLEL` →
  terminal detection (FAILED halt / keep-going park → exit 8 / deadlock → exit 3) →
  sleep. Install `platform/signals` shutdown to TERM in-flight workers + clean up.
- **Tests:** unit-test the pure decision functions — `handle_exit` routing per exit
  code + done-state, eligibility/launch gating, terminal-state/exit-code selection —
  with a mocked worker/git/docker layer. Full end-to-end is exercised in phase-08.

## Sequencing

- **06.1 — worker lifecycle.** `worker.ts` (prepare/launch/kill/cleanup, both modes)
  + unit tests with mocked git/docker/capture. One commit.
- **06.2 — supervisor + control.** `supervisor.ts` (branchHasDone/merge/supervise/
  buildlog) + `control.ts` (poke/retry/watchdog) + tests. One commit.
- **06.3 — driver loop.** `driver.ts` scheduler + reap routing + terminal/exit
  semantics + signal shutdown; unit-test the decision functions. One commit.
