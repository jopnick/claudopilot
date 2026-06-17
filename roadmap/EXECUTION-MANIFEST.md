# Dashboard SSE migration — Autonomous Execution Manifest

> Single source of truth for the autonomous loop in
> [run-loop.sh](../run-loop.sh). Migrates the claudopilot web dashboard from
> client-side polling to a server-pushed Server-Sent Events stream.

**Status:** in-progress

<!-- The loop watches for "**Status:** complete" to exit 0. The agent flips this
     to `complete` after the last phase is merged. -->

---

## Goal

Replace the dashboard's pull model — every browser polls `GET /api/progress`
(a full snapshot) and `GET /api/transcript?id&offset` every 3s — with a single
server-pushed SSE channel. The **backend** does the watching/polling once and
streams incremental `progress` and `transcript` deltas; the browser becomes a
thin EventSource consumer. We stop re-sending full transcript documents: the
server tails each transcript once from a byte offset and fans out only new bytes.

---

## Execution rules (read-only contract for the agent)

The real contract lives in `prompts/worker.md` (+ the `worker.project.md`
overlay). This section is for human readers re-orienting.

- A phase is eligible when its state is `[pending]` and every phase in its
  `(deps: …)` annotation is `[merged]`.
- The driver owns merges and this manifest; workers only build + gate + rename
  their phase doc to `DONE_`. States: `[pending] | [running] | [merged] | [failed] | [blocked]`.
- Concurrent phases must own **disjoint file sets**. The two fan-out streams
  below build against the shared contract in phase-01 (`web/events.mjs`) and never
  read each other's files — that is what lets them run at the same time.

---

## Order

<!-- Phase id is parsed from the first **bold** segment on each line.
     deps must reference earlier phase ids. `(deps: none)` and omitting the
     annotation both mean "no dependencies". -->

1. [merged] **phase-01** — contracts / SSE event vocabulary (deps: none)
2. [merged] **phase-02** — server SSE endpoint (deps: phase-01)
3. [merged] **phase-03** — client SSE consumer (deps: phase-01)
4. [merged] **phase-04** — assembly / remove polling (deps: phase-02, phase-03)
5. [pending] **phase-05** — verify (deps: phase-04)

Dependency graph (the `/plan-build` shape): `phase-01 → {phase-02, phase-03} →
phase-04 → phase-05`. phase-02 and phase-03 fan out concurrently in their own
worktrees.

---

## Phase details

<!-- Workers fill these in after each merge: Branch, Commits, Merged at, Merge SHA. -->

### phase-01 — contracts

### phase-02 — server SSE endpoint

### phase-03 — client SSE consumer

### phase-04 — assembly

### phase-05 — verify
