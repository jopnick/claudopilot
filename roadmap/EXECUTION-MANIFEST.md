# Bash → TypeScript engine port — Autonomous Execution Manifest

> Single source of truth for the autonomous loop in
> [run-loop.sh](../run-loop.sh). Ports the claudopilot bash engine to a
> cross-platform (Linux/macOS/Windows-via-WSL2) TypeScript application with
> functional parity, dual-stacked alongside bash until parity is proven.

**Status:** in-progress

<!-- The loop watches for "**Status:** complete" to exit 0. The agent flips this
     to `complete` after the last phase is merged. -->

---

## Goal

Reimplement everything the bash scripts do — `run-loop.sh` (driver), `run-in-docker.sh`
(image build + launch), `worker-entry.sh` (in-container agent), `progress.sh` — in a
typed, tested, built TypeScript app under `src/`, and migrate the already-Node
`.mjs` (progress, render-stream, web-server, bin/cli) to TS too. External tools
(`git`, `docker`, `claude`/`opencode`) stay as spawned CLIs behind typed wrappers.
The worker always runs inside a Linux container, so cross-platform work is confined
to the host orchestrator/CLI; under the WSL2 decision the POSIX process/signal model
holds everywhere. Bash stays working (dual-stack) so we can differential-test
TS-vs-bash, then we cut over.

---

## Execution rules (read-only contract for the agent)

The real contract lives in `prompts/worker.md` (+ the `worker.project.md` overlay).

- A phase is eligible when its state is `[pending]` and every phase in its
  `(deps: …)` annotation is `[merged]`.
- The driver owns merges and this manifest; workers only build + gate + rename
  their phase doc to `DONE_`. States: `[pending] | [running] | [merged] | [failed] | [blocked]`.
- Concurrent phases must own **disjoint file sets**. Every phase builds against the
  shared types + build config established in phase-01 and never edits another
  phase's `src/` subtree.

---

## Order

<!-- Phase id is parsed from the first **bold** segment on each line.
     deps must reference earlier phase ids. `(deps: none)` and omitting the
     annotation both mean "no dependencies". -->

1. [merged] **phase-01** — scaffold + shared types + platform primitives (deps: none)
2. [merged] **phase-02** — manifest + config + git wrapper (deps: phase-01)
3. [merged] **phase-03** — agent capture + render (deps: phase-01)
4. [running] **phase-04** — docker + runner (deps: phase-01, phase-02)
5. [running] **phase-05** — progress + web server (deps: phase-01, phase-02, phase-03)
6. [pending] **phase-06** — orchestrator / driver (deps: phase-01, phase-02, phase-03)
7. [pending] **phase-07** — CLI integration + dual-stack switch (deps: phase-04, phase-05, phase-06)
8. [pending] **phase-08** — parity verification + cross-platform CI + cutover (deps: phase-07)

Dependency graph (the `/plan-build` shape): `phase-01 → {phase-02, phase-03} →
{phase-04, phase-05, phase-06} → phase-07 → phase-08`. phase-02/03 fan out after
contracts; phase-04/05/06 fan out after their data-layer deps.

---

## Phase details

<!-- Workers fill these in after each merge: Branch, Commits, Merged at, Merge SHA. -->

### phase-01 — scaffold + types + platform
### phase-02 — manifest + config + git
### phase-03 — agent capture + render
### phase-04 — docker + runner
### phase-05 — progress + web
### phase-06 — orchestrator / driver
### phase-07 — CLI integration + dual-stack
### phase-08 — parity + CI + cutover
