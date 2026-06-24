# Project — Autonomous Execution Manifest

> Single source of truth for the autonomous loop. The driver reads phase states
> and dependencies from the **Order** section below.

**Status:** in-progress

<!-- The loop watches for "**Status:** complete" to exit 0. The agent flips this
     to `complete` after the last phase is merged. -->

---

## Execution rules (read-only contract for the agent)

The real contract lives in `.claudopilot/prompts/worker.md` (+ your
`worker.project.md` overlay). This section is for human readers re-orienting.

- A phase is eligible when its state is `[pending]` and every phase in its
  `(deps: …)` annotation is `[merged]`.
- The driver owns merges and this manifest; workers only build + gate + rename
  their phase doc to `DONE_`. States: `[pending] | [running] | [merged] | [failed] | [blocked]`.
- Concurrent phases must own disjoint package/file sets.

---

## Order

<!-- List your phases here, one per line. The phase id is parsed from the first
     **bold** segment on each line; deps must reference earlier phase ids. A
     phase with no dependencies may write `(deps: none)` or omit the annotation.

     Example line:
       1. [pending] **phase-NN** — shared contracts / types (deps: none)

     Run `claudopilot init --with-examples` for a worked sample roadmap, or see
     the "Setting up tasks and roadmaps" section of the README. -->


---

## Phase details

<!-- Workers fill these in after each merge: Branch, Commits, Merged at, Merge SHA. -->
