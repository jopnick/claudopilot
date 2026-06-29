# REVIEW-GATE — the convergence review contract

This is the **single normative spec** for claudopilot's convergence review gate.
Both drivers implement it **identically**:

- the TypeScript engine — `src/orchestrator/review.ts` (pure `decideRound` +
  injected reviewer/skeptic closures), and
- the native `pilot-run` skill — `pilot/skills/pilot-run/SKILL.md` (the same
  loop, run by the main Claude session).

The cross-driver contract is **behavioral**, not a shared executable. To keep
the two drivers from drifting, the `decideRound` decision table at the bottom of
this file is the source of truth: `src/orchestrator/review.test.ts` parses it
and asserts the TS implementation matches every row, and `SKILL.md` reproduces
it verbatim. **If you change the table, change it here first.**

## What it is

Today a phase merges when its **gate command** (`typecheck && lint && test`) is
green and the worker renamed its doc to `DONE_`. That is a binary, mechanical
check — it cannot catch a phase that is green but *wrong* (a bug the tests miss,
edits outside the phase's declared scope, unmet Done criteria).

The convergence review adds a **semantic gate** before the merge: fan out
independent reviewers over the phase diff, adversarially verify their findings,
feed confirmed problems back into the existing fix loop, and **merge only once a
review round comes back clean**. It is modeled on the ultracode workflow
(find → adversarially verify → converge).

It is **opt-in** (`reviewEnabled: false` by default, `--review` absent in the
native driver). A vanilla run behaves exactly as it does today.

## Vocabulary

- **Round** — one full pass: review → verify → decide.
- **Lens** — a review perspective. Default lenses: `correctness`, `security`,
  `scope`, `tests`. One **reviewer** runs per lens (so N reviewers = N lenses).
- **Reviewer** — an agent that reads `git diff <base>..auto/<id>` plus the phase
  doc's Done criteria through one lens and emits **findings**.
- **Skeptic** — an agent that tries to **refute** a single finding. M skeptics
  vote per gating finding (default M = 2).
- **Finding** — `{ id, severity, lens, file, title, detail }`. `id` is a
  **stable slug assigned by the reviewer** (e.g. `scope-touches-unowned-pkg`),
  used to detect a finding recurring across rounds. `severity` is one of
  `blocker | major | minor`.

## The loop (per phase, in place of the direct merge)

`runReviewGate` is invoked at the single merge funnel — for both a
worker-reported `done` and a supervisor-recovered phase. One invocation runs
**one round** and returns an outcome; `fix` relaunches the worker and the
relaunch re-enters the gate (no inline blocking loop).

1. **Re-verify `branchHasDone`.** A previous fix pass can leave the branch
   non-`DONE_`. If the `DONE_` rename is not present, do **not** review — route
   straight to the fix loop (relaunch the worker). Never review or merge a
   half-done branch.
2. **Review.** Spawn one reviewer per lens over the phase diff + Done criteria.
   Collect all findings.
   - A reviewer whose output is missing/unparseable/crashed contributes a
     **synthetic `blocker`** finding (`id: review-error-<lens>`). A broken
     reviewer can never result in a silent clean round.
3. **Select gating findings.** Only `blocker` and `major` findings gate. `minor`
   findings are recorded but never block a merge (this is what stops endless
   cosmetic polishing).
4. **Adversarially verify.** For each gating finding, spawn M skeptics, each
   **refuting by default** (assume the finding is wrong unless the diff proves
   it real). A finding is **confirmed** only on a **strict majority** of "real"
   votes (at M = 2, that is 2 of 2). A skeptic whose output is
   missing/unparseable/crashed counts as **refuted** — a dead skeptic can never
   manufacture a confirmation.
5. **Decide.** Compute `confirmed` = the gating findings that survived
   verification, and `oscillating` = (`confirmed` is non-empty AND its id-set is
   identical to the previous round's confirmed id-set, i.e. a fix was issued and
   the very same findings came back). Apply **`decideRound`** (table below).
6. **Apply the outcome.**
   - **`merge`** — call the real merge (`mergePhase`). The phase is done.
   - **`fix`** — record the confirmed findings where the worker will read them
     (the relaunch prompt / a `roadmap/<id>.review.md` note), remember the
     confirmed id-set as `prevConfirmed`, increment the round counter, and
     relaunch the worker on the same worktree. The relaunch re-enters the gate.
   - **`park`** — `parkOrHalt` the phase as `[blocked]` with the reason. The
     branch is preserved for a human; dependents are skipped (or the run halts,
     per `keepGoing`).

## Invariants (non-negotiable)

- **NEVER-MERGE-RED.** `runReviewGate` resolves to `merge` **only** via
  `decideRound` returning `{kind: "merge"}` on a clean round. Every error,
  timeout, crash, or unparseable verdict maps to `fix` or `park` — never to a
  merge. Doubt never merges.
- **Review lives inside `[running]`.** No new manifest state. The phase stays
  `[running]` across review/fix rounds; only a successful merge flips it to
  `[merged]` and only a park flips it to `[blocked]`/`[failed]`. The manifest
  state sequence is therefore unchanged from a no-review run that converges on
  round 1.
- **The round counter is independent of supervisor attempts.** A long-but-
  converging review must not be capped by the supervisor's max-attempts.
- **Both drivers default OFF and must default OFF identically.** Enabling review
  is always an explicit per-repo choice.

## `decideRound` decision table (source of truth)

`decideRound({ confirmed, oscillating, round, maxRounds })` where `confirmed` is
the count of confirmed gating findings this round, `oscillating` is the boolean
from step 5, `round` is the 1-based current round number, and `maxRounds` is the
configured cap. Precedence is top-to-bottom: a clean round always merges; else a
recurring (oscillating) finding set parks immediately; else exhausting the round
cap parks; otherwise fix and go again.

<!-- DECIDE-ROUND-TABLE:BEGIN -->
| confirmed | oscillating | round | maxRounds | outcome | reason |
| --- | --- | --- | --- | --- | --- |
| 0 | false | 1 | 3 | merge |  |
| 0 | true | 2 | 3 | merge |  |
| 0 | false | 3 | 3 | merge |  |
| 2 | false | 1 | 3 | fix |  |
| 1 | false | 2 | 3 | fix |  |
| 2 | true | 2 | 3 | park | review oscillation |
| 1 | true | 3 | 3 | park | review oscillation |
| 1 | false | 3 | 3 | park | review did not converge |
| 3 | false | 4 | 3 | park | review did not converge |
<!-- DECIDE-ROUND-TABLE:END -->

Reading the rows: a clean round (`confirmed = 0`) merges regardless of any other
column. With confirmed findings, an identical recurring set (`oscillating`)
parks as `review oscillation` even before the cap; otherwise reaching the cap
(`round >= maxRounds`) parks as `review did not converge`; below the cap, `fix`.
