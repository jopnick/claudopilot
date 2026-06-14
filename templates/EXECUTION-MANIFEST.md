# Project — Autonomous Execution Manifest

> Single source of truth for the autonomous loop in
> [claudopilot/run-loop.sh](../claudopilot/run-loop.sh).

**Status:** in-progress

<!-- The loop watches for "**Status:** complete" to exit 0. The agent flips this
     to `complete` after the last phase is merged. -->

---

## Execution rules (read-only contract for the agent)

The real contract lives in `claudopilot/prompts/worker.md` (+ your
`worker.project.md` overlay). This section is for human readers re-orienting.

- A phase is eligible when its state is `[pending]` and every phase in its
  `(deps: …)` annotation is `[merged]`.
- The driver owns merges and this manifest; workers only build + gate + rename
  their phase doc to `DONE_`. States: `[pending] | [running] | [merged] | [failed] | [blocked]`.
- Concurrent phases must own disjoint package/file sets.

---

## Order

<!-- Phase id is parsed from the first **bold** segment on each line.
     deps must reference earlier phase ids. -->

1. [pending] **phase-01** — contracts / shared types (deps: none)
2. [pending] **phase-02** — feature A (deps: phase-01)
3. [pending] **phase-03** — feature B (deps: phase-01)
4. [pending] **phase-04** — assembly (deps: phase-02, phase-03)

---

## Phase details

<!-- Workers fill these in after each merge: Branch, Commits, Merged at, Merge SHA. -->
