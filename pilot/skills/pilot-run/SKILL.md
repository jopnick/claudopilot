---
name: pilot-run
description: Run a claudopilot-style roadmap natively in any repo - the main Claude session becomes the driver. Reads roadmap/EXECUTION-MANIFEST.md, launches every eligible phase as a background phase-worker agent in its own git worktree, merges finished branches serially, flips the manifest, and escalates red gates to the phase-supervisor agent. Project-agnostic - the gate command and conventions are resolved from the target repo. Can also scaffold a new roadmap if none exists. Use to execute or author a dependency-graph roadmap of phases.
---

# pilot-run — the native roadmap driver (global)

You (the main session) are now the **driver** of an autonomous,
dependency-graph-scheduled build loop. The contract is the claudopilot
roadmap format: `roadmap/EXECUTION-MANIFEST.md` with `(deps: ...)`
annotations plus per-phase slice docs. This skill is project-agnostic: all
project specifics (gate command, install command, code conventions) are
resolved from the target repo at run time.

**The invariants that make concurrency safe:**

1. **The driver owns every merge and every manifest write.** Workers build,
   gate, rename their phase doc to `DONE_`, and report. You merge serially
   and you are the sole writer of `roadmap/EXECUTION-MANIFEST.md`.
2. **Concurrent phases own disjoint file/package scopes.** The worker prompt
   enforces "stay inside your declared scope"; you enforce it again at merge
   time (a content conflict between scope-disjoint phases means the
   decomposition was wrong — stop and surface it).
3. **Red work is never merged.** A phase that can't go green is parked, its
   branch preserved, never landed on the base branch.

## Arguments

Parse from the skill args (all optional):

- `--max-parallel N` — concurrent phases (default `3`).
- `--keep-going` — never halt for a human: final supervisor attempt runs
  best-effort; a phase that still can't go green is parked `[blocked]` and
  the run continues with every other independent phase. Without it, a failed
  phase drains in-flight work and stops for the user.
- `--base-branch <name>` — defaults to the current branch.
- `--only <prefix>` — restrict scheduling to phases whose id starts with the
  prefix (one initiative out of a shared manifest).
- `--push` — push the base branch after each merge (default: no pushes).
- `--gate "<cmd>"` / `--prepare "<cmd>"` — override the resolved gate /
  worktree-prepare commands.

## Resolve repo parameters (first run in a repo)

Resolve each of these and echo what you resolved before launching anything:

- **Gate command** (the per-slice quality gate), in precedence order:
  1. `--gate` argument;
  2. a `**Gate:**` line in the manifest header;
  3. the repo's convention docs (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`)
     if they state a check/CI command;
  4. auto-detect from the project: package.json scripts (compose the obvious
     chain, e.g. `typecheck && lint && test`, using the repo's package
     manager), `Makefile` (`make check`/`make ci`/`make test`), `Cargo.toml`
     (`cargo clippy --all-targets && cargo test`), `pyproject.toml`
     (`ruff check . && pytest`), `go.mod` (`go vet ./... && go test ./...`);
  5. if still ambiguous, ask the user once — then offer to record the answer
     as a `**Gate:**` line in the manifest so the repo remembers.
- **Prepare command** (run in each fresh worktree so it can build):
  `--prepare`, else a `**Prepare:**` manifest line, else by lockfile —
  `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `package-lock.json` →
  `npm ci`, `yarn.lock` → `yarn install --frozen-lockfile`, `bun.lock*` →
  `bun install`; compiled-language repos (cargo/go) usually need none.
- **Conventions:** you don't need to internalize them — the worker/supervisor
  agents read the repo's convention docs themselves. Just confirm the docs
  exist; if the repo has none, the workers fall back to matching surrounding
  code.

## Preflight (refuse early, refuse loudly)

1. `roadmap/EXECUTION-MANIFEST.md` exists and parses (see Grammar below).
   If it doesn't exist, switch to **Authoring mode** (bottom of this doc).
   If `**Status:** complete`, report "nothing to do" and stop.
2. The base branch is **not** `main`/`master`. Convention: a runner-only
   branch (e.g. `autonomous-runner`) cut from the trunk. If the user is on
   the trunk, ask before proceeding — this is the single biggest guardrail
   against landing experimental work on the trunk.
3. The working tree is clean (`git status --porcelain` empty). Uncommitted
   changes on the base branch would leak into every worktree's diff baseline.
4. Dependencies are installed at the repo root (run the prepare command if
   not), so worktree installs are cheap.
5. Stale state from a previous run: check `.claudopilot/worktrees/` (and
   `git worktree list` / `git branch --list 'auto/*'`; `git worktree prune`
   dead records). A leftover branch for a `[pending]` phase is a resume
   candidate (reuse it); for a `[merged]` phase it is garbage (remove
   worktree, delete branch).
6. Ensure `.claudopilot/` is ignored: if the repo's `.gitignore` doesn't
   cover it, add it (committed on the base branch with the first manifest
   commit).

## Manifest grammar (driver-owned)

```markdown
**Status:** in-progress            <- flip to `complete` when all merged
**Gate:** <command>                <- optional; resolved gate lives here
**Prepare:** <command>             <- optional

## Order

1. [pending] **<phase-id>** — <title> (deps: <id>, <id>)
```

- States: `[pending] | [running] | [merged] | [failed] | [blocked]` — you
  write all of them; workers never touch this file.
- Phase id = first `**bold**` segment on the line; `(deps: ...)` lists phase
  ids that must be `[merged]` before this one is eligible; omitted = no deps.
- An HTML comment line `<!-- LOOP-CHECKPOINT: ... -->` between entries is a
  deliberate pause: when scheduling reaches it (every entry above it is
  `[merged]`), stop launching, `AskUserQuestion` with the checkpoint text,
  and on approval delete the comment line and continue.

## The scheduling loop

You are event-driven, not polling. After launching workers, end your turn;
the harness re-invokes you when a background agent finishes. Each tick
(initial invocation or worker-completion notification):

### 1. Reap

For each finished worker, parse the JSON object from its final message
(`status`, `phaseId`, `branch`, `reason`).

- **`done` / `noop`** — verify then merge (next section).
- **`halted`** — supervisor escalation (below).
- **`dependency-error`** — your scheduling was wrong or the roadmap's deps
  annotation is incomplete. Mark `[failed]`, stop launching, surface to the
  user with the reason. Do not auto-retry: a dep error is a plan bug, not a
  flake.
- Unparseable result / agent died — treat as `halted` with the raw tail as
  the reason.

### 2. Merge (serial, driver-only)

For each `done` phase, one at a time, on the base branch in the main
checkout:

1. Verify the done signal: the tip of `auto/<phase-id>` contains the rename
   to `roadmap/DONE_<phase-id>-*.md`. If the rename is missing, treat as
   `halted` (silent stall) instead of merging.
2. `git merge --no-ff auto/<phase-id> -m "merge(phase-<id>): <phase title>"`.
   On conflict: `git merge --abort`, mark the phase `[blocked]` with a note,
   keep the branch, and surface — scope-disjoint phases must not conflict,
   so a conflict means two phases edited the same file and a human should
   look.
3. Flip the manifest entry `[running]` → `[merged]` and append/refresh the
   phase-details section:

   ```markdown
   ### <phase-id>

   - **Branch:** `auto/<phase-id>` (deleted post-merge)
   - **Commits:** <count from git log>
   - **Merged at:** <ISO timestamp>
   - **Merge SHA:** <short sha>
   ```

   Commit the manifest on the base branch:
   `chore(pilot): <phase-id> merged`.
4. `git worktree remove .claudopilot/worktrees/<phase-id>` and
   `git branch -d auto/<phase-id>`.
5. If `--push`: `git push` (best-effort; a failed push never blocks the run).

### 3. Launch

Eligible = `[pending]` AND every dep `[merged]` AND not past an unresolved
LOOP-CHECKPOINT AND (if `--only`) matching the prefix. For each eligible
phase, up to `max-parallel` minus currently-running:

1. Create the worktree (or reuse a leftover from a halted run):

   ```bash
   git worktree add .claudopilot/worktrees/<phase-id> -b auto/<phase-id> <base-branch>
   cd .claudopilot/worktrees/<phase-id> && <prepare command>
   ```

   (Reuse: if branch `auto/<phase-id>` already exists, add the worktree
   without `-b` — the worker resumes from its Status checklist.)
2. Flip the manifest entry to `[running]` (working-tree edit only; the
   `[merged]` flip is what gets committed).
3. Launch the worker — `Agent` tool, `subagent_type: "pilot:phase-worker"`
   (this plugin's agent — check the available-agents list; a project- or
   user-level `phase-worker` shadows it and is equivalent, use whichever is
   listed), `run_in_background: true`, prompt:

   ```
   Phase id: <phase-id>
   Worktree path: <absolute path>
   Base branch: <base-branch>
   Gate command: <gate command>
   Execute this phase per your contract. Your final message must be the
   single JSON result object.
   ```

   If neither agent type is loaded yet (definitions register with a delay),
   fall back to `general-purpose` with an added first line: "You are a
   pilot-run phase-worker; read the phase-worker.md agent definition at
   <path to this plugin's agents/phase-worker.md> first and follow its body
   as your contract."
4. Tell the user what launched (one line per phase).

### 4. Finish or yield

- If all entries are `[merged]`: flip `**Status:** in-progress` →
  `complete`, commit, remove `.claudopilot/worktrees/` if empty, and report
  a summary (N phases, M commits, base branch tip).
- If anything is `[blocked]`/`[failed]` and nothing is running or eligible:
  report the summary with what's parked and why; remind the user that
  flipping a `[blocked]` entry back to `[pending]` and re-running resumes it.
- Otherwise: end the turn and wait for the next completion notification.

## Supervisor escalation (on `halted`)

Track supervisor attempts per phase (in the manifest details section, e.g.
`- **Supervisor attempts:** 1`). Max 2 attempts per phase.

1. Spawn the supervisor — `subagent_type: "pilot:phase-supervisor"` (or an
   unscoped `phase-supervisor` if a project/user copy is listed) — foreground,
   since it's quick and you need the verdict before deciding. Pass: phase id,
   worktree path, gate command, mode `standard` (or `best-effort` if this is
   the final attempt under `--keep-going`), and the worker's halt reason.
2. On `fixed`: relaunch `phase-worker` on the same phase (same worktree,
   background) — it resumes from the Status checklist.
3. On `too-broad` / `still-red`, attempts remaining: try once more only if
   something material changed; otherwise treat as exhausted.
4. Exhausted:
   - `--keep-going`: ensure WIP is committed on the branch, mark the phase
     `[blocked]` with the last reason, remove the worktree but **keep the
     branch**, continue scheduling every phase that doesn't depend on it
     (dependents are skipped and reported).
   - interactive (default): `AskUserQuestion` — retry with a fresh worker /
     park it and continue / stop the run.

## Authoring mode (no manifest yet)

If `roadmap/EXECUTION-MANIFEST.md` doesn't exist, offer to scaffold one from
the user's goal before running anything. Decompose the initiative into
phases that satisfy:

- **Phase = a mergeable unit** owning a declared, disjoint file/package
  scope; `(deps: ...)` only where a phase truly consumes another's output.
  Interfaces/contracts first (a no-deps Phase 0), implementations fan out in
  parallel, integration/assembly phases depend on the streams they wire.
- **Per-phase doc** (`roadmap/<phase-id>-<slug>.md`) with: `## Resume notes`
  (gotchas for a fresh worker), `## Packages owned` (the scope), `## Goal`
  (one paragraph: deliverable + why), `## Non-goals` (3-6 bullets),
  `## Sequencing` (slices — one commit's worth each, individually
  green-testable, stable ids), `## Done criteria` (invariants the slice list
  doesn't capture; mark human-only rows clearly).
- Manifest header gets `**Gate:**` and `**Prepare:**` lines from the
  resolution above.

Commit the scaffold on the base branch, show the user the dependency graph,
and ask whether to start the run.

## Notes

- A repo-local `.claude/skills/pilot-run` (e.g. a project that vendors a
  specialized copy) takes precedence over this global one in that repo —
  that is correct; defer to it.
- This skill is contract-compatible with the claudopilot Docker engine, where a
  repo vendors it: either driver can resume where the other stopped, but never
  run both on the same manifest at once.
- Workers run under the session's permission mode. For long unattended runs
  consider broadening permissions for the run, or pair
  `/pilot-run --keep-going` with a scheduled agent.
