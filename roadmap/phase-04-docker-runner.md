# Phase 04 — docker + runner

## Resume notes (read first)

You own **`src/docker.ts`, `src/runner/*`** (`runInDocker.ts`, `workerEntry.ts`) +
tests. Import types from phase-01 and `git.ts`/`config.ts` from phase-02 (merged
dep). Do not touch `src/orchestrator/*` (phase-06) or `src/agent/*` (phase-03).
Source of truth: `run-in-docker.sh` (202 lines), `worker-entry.sh` (51),
`run_phase_container` + `cleanup_worktree` in `run-loop.sh` (~315–329, 419–429).

## Status

- [ ] 04.1 — `src/docker.ts` typed docker wrapper
- [ ] 04.2 — `src/runner/runInDocker.ts` (build + isolated/default/shell launch)
- [ ] 04.3 — `src/runner/workerEntry.ts` (in-container agent entrypoint)

## Goal

Port image build and the three launch modes plus the in-container worker
entrypoint, so a run can be started with the same auth/mount/port behavior as the
bash launcher — cross-platform on the host (mount-path normalization via
`platform/dockerPath`).

## Non-goals

- No scheduling/merge logic (phase-06). The runner builds + launches; the driver
  (phase-06) owns per-phase worker containers via `docker.ts` when it lands.
- Do not edit the bash scripts (`run-in-docker.sh`/`worker-entry.sh` stay for the
  bash stack).

## Architecture

- **`src/docker.ts`** — typed wrapper over the platform spawner for exactly what the
  engine uses: `build({ tag, dockerfile, buildArgs })`, `run({ name, rm, init, ipc,
  shmSize, mounts, env, image, cmd })`, `rmForce(name)`, `ps(filter)`,
  `exec({ name, tty, cmd })`. Mounts go through `platform/dockerPath` so host paths
  resolve inside the container on macOS/WSL.
- **`src/runner/runInDocker.ts`** — ports `run-in-docker.sh`:
  - `buildImage()` (idempotent `docker build` with `HOST_UID/HOST_GID` build args).
  - **default mode**: bind-mount repo at `/work`, publish the dashboard port
    (loopback), mount host `~/.claude`/`~/.gitconfig`/`~/.ssh`/gh config + forward
    `ANTHROPIC_API_KEY`, run the loop inside the container.
  - **`--isolated`**: orchestrator on the host (calls the phase-06 driver in
    isolated mode); start the host-side dashboard.
  - **`--shell`**: drop into a container shell.
  - Auth resolution + the "port in use → skip dashboard" guard, ported faithfully.
- **`src/runner/workerEntry.ts`** — ports `worker-entry.sh`: runs inside the worker
  container (Linux), reads the composed prompt at `.claudopilot/<id>.prompt.txt`,
  runs `WORKTREE_PREPARE_CMD`, then drives the agent via `agent/capture.ts`
  (fresh or `--resume`), writing stream/transcript/log into the bind-mounted clone.
  Exposed both as a function and a `dist/` entry the container invokes (`node
  dist/worker-entry.js`).
- **Tests:** unit-test argv/mount/env assembly (assert the `docker run` argv matches
  the bash invocation for default/isolated/shell) without actually invoking docker;
  `dockerPath` mapping covered in phase-01.

## Sequencing

- **04.1 — docker.ts.** Typed wrapper + argv-assembly tests. One commit.
- **04.2 — runInDocker.ts.** build + default/isolated/shell launch + auth/mounts/
  dashboard guard. One commit.
- **04.3 — workerEntry.ts.** In-container entrypoint using `agent/capture.ts`;
  fresh + resume paths. One commit.
