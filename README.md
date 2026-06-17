# Claudopilot

[![npm version](https://img.shields.io/npm/v/claudopilot.svg)](https://www.npmjs.com/package/claudopilot)
[![license](https://img.shields.io/npm/l/claudopilot.svg)](./LICENSE)

Autonomous execution loop for [Claude Code](https://claude.com/claude-code).
Feed it a roadmap of phases. The driver runs **every currently-eligible phase
concurrently** — bounded by `MAX_PARALLEL` — each in its own git worktree on
its own `auto/<phase-id>` branch. A phase is eligible when its state is
`[pending]` and every phase in its `(deps: …)` annotation is `[merged]`. Each
worker (`bypassPermissions`) implements its phase end-to-end and renames its
phase doc to `DONE_`; **the driver owns the merge and the manifest** (it merges
serially into the base branch and is the sole writer of the manifest), which is
what makes concurrent phases safe. See [Parallel execution](#parallel-execution).

If a phase's tests refuse to go green, a **supervisor** agent is invoked
with a narrow mandate (read the log, apply the smallest possible fix,
exit) before the worker re-attempts. If the supervisor also fails, the
loop halts with a non-zero exit so a human can step in.

The contract is project-agnostic. The prompts assume a `pnpm` /
Turborepo monorepo by default but are designed to be retargeted — the
gate command, commit-message vocabulary, and project rules all live in
[prompts/worker.md](prompts/worker.md) as text you edit, not in the
loop driver.

## Parallel execution

The driver schedules by **dependency graph**, not by queue position. Each pass it:

1. reaps finished workers; for each exit-0 worker it **merges** `auto/<phase-id>`
   into the base branch (serially — the driver is single-threaded for merges, so
   package-disjoint phases never race) and flips that manifest entry to `[merged]`;
2. launches every `[pending]` phase whose `(deps: …)` are all `[merged]`, up to
   `MAX_PARALLEL`, each in a fresh `git worktree` under `.claudopilot/worktrees/`
   (prepared with `pnpm install` so the isolated checkout can build);
3. exits 0 when all phases are `[merged]`.

This gives the `/plan-build` shape for free: the contracts phase has no deps so
it runs first; the fan-out streams all depend only on contracts so they run
**concurrently**; assembly depends on the streams; verify depends on assembly.

**The contract that keeps it safe:** concurrent phases must own **disjoint
package sets** (the worker refuses to edit outside its declared packages), and
**workers never merge or touch the manifest** — both are driver-owned. Manifest
states are `[pending] | [running] | [merged] | [failed] | [blocked]`, all written by the driver.

On a phase failure: the supervisor gets up to `MAX_SUPERVISOR_ATTEMPTS_PER_PHASE`
tries in that worktree. By default, if it still can't recover, the phase is marked
`[failed]`, no new phases launch, in-flight workers drain, and the loop exits
non-zero. A rate-limit-shaped exit triggers a cooldown and a relaunch.

**Keep-going mode (`KEEP_GOING=1`)** turns this into a fully-autonomous run: the
final supervisor attempt runs in **best-effort** mode (wider edit mandate), and a
phase that still can't go green is **parked** — its `auto/<id>` branch is committed
but **not merged**, marked `[blocked]` — while the run **continues with every
other independent phase**. Red work is never merged (that would break the shared
gate for all phases); parked branches stay in git for review/rollback. Dependents
of a blocked phase are skipped. The run ends with a summary (N merged, M blocked)
and exit code `8` if anything was parked. It's all in git — flip a `[blocked]`
entry back to `[pending]` and re-run to retry.

Key knobs (full list under [Configuration](#configuration-environment-variables)):
`MAX_PARALLEL` (default 3), `GATE_CMD` (the per-phase quality gate; must match
`worker.md` and the pre-commit hook), `WORKTREE_PREPARE_CMD`, `POLL_SECONDS`.

> Generate a compatible roadmap with the repo's `/plan-build` skill — it emits
> `roadmap/EXECUTION-MANIFEST.md` (with `(deps: …)`) + per-phase docs whose
> package-disjoint streams map straight onto this scheduler.

## Contents

```
claudopilot/
├── README.md                # this file
├── src/                     # TypeScript engine (CLI, orchestrator, progress, web)
├── dist/                    # built CLI (bin: dist/cli.js)
├── run-loop.sh              # in-container loop driver (default-mode worker image)
├── worker-entry.sh          # in-container per-phase entrypoint (--isolated)
├── render-stream.mjs        # stream-json → transcript renderer (used in-container)
├── web-server.mjs           # in-container dashboard server when --web is published
├── web/                     # lit-html dashboard (agents + live thought streams)
├── Dockerfile               # Playwright + pnpm + git + gh + Claude Code
├── prompts/
│   ├── worker.md            # spawned every tick to do the actual work
│   └── supervisor.md        # spawned only when the worker halts on test failure
├── .claude-plugin/
│   └── marketplace.json     # makes this repo a Claude Code plugin marketplace
└── pilot/                   # the same loop as a NATIVE Claude Code plugin (no Docker)
    ├── skills/pilot-run/    # the driver skill (main session drives the loop)
    └── agents/              # phase-worker + phase-supervisor agent definitions
```

> **Two ways to run.** The headline above is the **bash/Docker engine** (primary;
> built for unattended/CI runs, hard container isolation, and local-model runs).
> If you'd rather drive it hands-on from inside a Claude Code session with zero
> setup, there's a native plugin — see [Native Claude Code plugin](#native-claude-code-plugin-no-docker).

## Install

```bash
npm install -g claudopilot      # or: npx claudopilot <command>
```

Then, from the root of the repo you want to drive:

```bash
claudopilot init                # vendors the engine into ./claudopilot/ and
                                # scaffolds claudopilot.config.sh + roadmap/
# …edit claudopilot.config.sh (GATE_CMD), the roadmap, and the prompt overlay…
claudopilot run                 # build the image + run the loop (--isolated for
                                # per-phase containers; --shell to drop into bash)
claudopilot progress            # read-only view of an in-flight run
claudopilot web                 # browser dashboard at http://127.0.0.1:4317
```

### Web dashboard

`claudopilot web` starts a tiny **localhost-only**, read-only server (default port
`4317`, override with `--port`) and serves a [lit-html](https://lit.dev/docs/libraries/standalone-templates/)
single-page app. The browser opens a single Server-Sent Events channel
(`GET /api/stream?watch=<agent>`); the server tails the progress model and the
selected agent's transcript and pushes deltas — one initial `snapshot`, then
`progress` events whenever the model changes and `transcript` events carrying
only newly-appended bytes (never the full document again). The page lists every
phase/agent with live state, slice progress, and current activity, and — when you
click an agent — streams that worker's **thought stream** (assistant text,
thinking, tool calls and results), auto-scrolling as new output lands. On
disconnect, EventSource auto-reconnects and the server resends a fresh
`snapshot` so the view resyncs without a manual refresh. No build step and no
network: lit-html is vendored.

**It starts automatically with every `claudopilot run`** — the launcher brings the
dashboard online alongside the loop and prints `Dashboard: http://127.0.0.1:4317`. In
default mode it runs inside the container with the port published to the host
loopback; in `--isolated` mode it runs on the host. Knobs:

- `CLAUDOPILOT_WEB=0` — disable auto-start (run `claudopilot web` manually instead).
- `CLAUDOPILOT_WEB_PORT=<n>` — change the port (default `4317`).

You can also run it standalone any time from the repo root: `claudopilot web`.

`init` writes the engine scripts under `./claudopilot/` (so the Docker layout
below resolves) and leaves `claudopilot.config.sh`, the roadmap, and
`claudopilot/prompts/worker.project.md` for you to fill in. Re-run with `--force`
to re-vendor the engine after upgrading the package. The sections below describe
what those scripts do and the manifest/phase-doc format `init` stubs out.

## Quick start

Prerequisites:

- A repo with `roadmap/EXECUTION-MANIFEST.md` (format below) and per-phase
  docs alongside it.
- Claude authentication, either:
  - **API token (recommended for headless):** export `ANTHROPIC_API_KEY`
    before launching — it is forwarded into the container and the workers
    use it; no interactive login needed:
    `ANTHROPIC_API_KEY=sk-ant-... claudopilot run`. If
    `~/.claude/` also exists it is still mounted (for memory + MCP config),
    but the token takes precedence for auth.
  - **Interactive login:** run `claude` once on the host so `~/.claude/` and
    `~/.claude.json` exist; used when `ANTHROPIC_API_KEY` is unset.
- A passphrase-less SSH key for `git push` if you want the loop to push
  merged work to a remote.
- Docker installed.
- A non-trunk base branch checked out (the loop refuses to land work
  directly on `main`). Convention: `autonomous-runner`, cut from `main`.

Then:

```bash
git checkout autonomous-runner
git merge main              # pull in any new main commits

claudopilot run             # add --isolated for per-phase containers
```

Watch progress from another terminal:

```bash
tail -f .claudopilot.log
# or
docker exec -it claudopilot-runner tail -f /work/.claudopilot.log
```

The loop exits `0` when every entry in the manifest is `merged`.
See [Exit codes](#exit-codes) for what other exits mean.

## How it works

### Tick lifecycle

```
                 ┌──────────────────────────────────────────────────┐
                 │  run-loop.sh                                      │
                 │                                                   │
   manifest ────►│  1. Roll usage window, pause if at threshold      │
   .md          │  2. Check `Status: complete` → exit 0              │
                 │  3. Find next `[pending]` entry OR CHECKPOINT     │
                 │     - CHECKPOINT → exit 2                          │
                 │  4. Parse phase id from manifest line              │
                 │  5. Spawn worker:                                  │
                 │       claude -p "$(cat worker.md) ... <phase-id>" │
                 │     --permission-mode bypassPermissions --verbose │
                 │  6. Inspect exit code:                             │
                 │     - 0 → success, fall through                    │
                 │     - 2 → checkpoint, halt                         │
                 │     - 4 → dependency error, halt                   │
                 │     - 5/6 → invoke supervisor, then retry           │
                 │     - rate-limit shaped → backoff + same tick      │
                 │     - other → halt                                 │
                 │  7. Verify manifest entry flipped from pending     │
                 │  8. Sleep INTER_TICK_SLEEP, loop                   │
                 └──────────────────────────────────────────────────┘
```

Every tick is a **fresh `claude -p` process**. No conversation continuity
between phases — the worker re-orients each time by re-reading the
manifest and the active phase doc. This is intentional: it keeps each
phase's context window small and forces the worker to commit-often so
state lives in git, not in a chat history.

### Worker contract (claudopilot/prompts/worker.md)

The worker is given one phase id per tick. Its contract:

1. Re-orient — read the manifest and the active phase doc.
2. Dependency-check — if the phase doc declares `Depends on phase X` and X
   is not yet merged, exit `4`.
3. Branch — cut `auto/<phase-id>` from `$BASE_BRANCH` (defaults to the
   branch the loop was launched from, never the trunk). Resume the same
   branch if it already exists.
4. Seed a `## Status` checklist in the phase doc from its sequencing
   slices, commit it.
5. For each slice in order:
   - Implement it. May spawn sub-agents (`Agent` tool) for parallel
     independent work.
   - Run `pnpm typecheck && pnpm lint && pnpm test`. Fix on the branch
     until green. Up to 5 attempts; on the 5th failure, write a WIP
     commit and exit `5` so the supervisor can take over.
   - **Commit immediately** when green. One slice → one commit, message
     `<type>(phase-<id>): <slice-id> — <one-line>`.
   - Flip the slice's `[ ]` → `[x]` in the Status checklist and append
     the short SHA.
6. Rename the phase doc `phase-<id>-*.md` → `DONE_phase-<id>-*.md`.
   That rename is the unambiguous "I'm done" signal.
7. Merge `auto/<phase-id>` → `$BASE_BRANCH` with `--no-ff`. Push
   (best-effort). Delete the feature branch.
8. Update the manifest entry: `[pending]` → `[merged]`, fill in Branch,
   Commits, Merged at, Merge SHA. Commit on `$BASE_BRANCH`.
9. Exit `0`.

The full text lives in [prompts/worker.md](prompts/worker.md). Edit it
if your project doesn't use `pnpm`, doesn't use Turborepo, has a
different gate command, or doesn't use the slice/Status convention.

### Supervisor contract (claudopilot/prompts/supervisor.md)

Triggered only when the worker exits 5 (gave up on a slice's tests) or 6
(silent halt). Hard-bounded mandate:

- Read `.claudopilot.log`, `git status`, `git diff` — diagnose from
  evidence, not guessing.
- Apply the **smallest possible fix** — a type annotation, a missing
  import, a single lint correction. If the fix surface is more than
  ~1–2 files or ~30 lines, that's worker territory — supervisor exits
  with a halt code instead.
- Run the same `pnpm typecheck && pnpm lint && pnpm test` gate.
- Commit (if needed) with `chore(supervisor): <one-line>` — the
  `chore(supervisor):` prefix is reserved so slice-counting stays clean.
- Exit 0 → worker re-runs the same phase. Exit 1 or 2 → halt for human.

`MAX_SUPERVISOR_ATTEMPTS_PER_PHASE` (default 2) caps how many times the
supervisor can intervene on the same phase before the loop hands off to
a human. Two is enough for typical typecheck/lint slips; more usually
means a structural issue.

Full text in [prompts/supervisor.md](prompts/supervisor.md).

## Setting up tasks and roadmaps

Claudopilot expects two things in your repo:

### 1. The manifest — `roadmap/EXECUTION-MANIFEST.md`

The single source of truth for what's pending and what's done. Template:

```markdown
# Project — Autonomous Execution Manifest

> Single source of truth for the autonomous loop in
> [claudopilot/run-loop.sh](../claudopilot/run-loop.sh).

**Status:** in-progress

<!-- The shell loop watches for "**Status:** complete" to exit. The
     agent flips this to `complete` after the last phase is merged. -->

---

## Execution rules (read-only contract for the agent)

(Project-specific rules — usually a copy of the worker.md contract
rephrased for the manifest. The worker.md text already contains the
real contract; this section is for human readers re-orienting.)

---

## Order

1. [pending] **phase-01** — short phase title
2. [pending] **phase-02** — short phase title
3. [pending] **phase-03** — short phase title
```

Rules the loop enforces:

- The **first** entry whose status is `[pending]` is what the next tick
  picks up. Earlier `[merged]` entries are skipped.
- Phase ids are parsed from the first `**bold**` segment on the order
  line. `**phase-42**` — anything after that — `**bold marker**` is fine
  (the parser anchors at start of line).
- The literal sentinel `**Status:** complete` at the top of the file
  causes the loop to exit 0.
- An HTML comment line `<!-- LOOP-CHECKPOINT: ... -->` placed between
  entries causes the loop to exit 2. Edit the manifest to remove the
  block and re-launch the loop to continue.
- Set `IGNORE_LOOP_CHECKPOINTS=1` in env to make the loop barrel past
  any checkpoint comments (rate-limit / supervisor halts still fire).

After a phase merges, the worker fills in §Phase details for that entry
(typically a separate section further down the manifest):

```markdown
### phase-01

- **Branch:** `auto/phase-01` (deleted post-merge)
- **Commits:** 7
- **Merged at:** 2026-05-01T14:32:18Z
- **Merge SHA:** abc1234
```

### 2. Per-phase docs — `roadmap/phase-<id>-<slug>.md`

One per entry in the manifest. The worker reads the doc to figure out
what to build. Recommended sections:

```markdown
# Phase 42 — local-models store

## Resume notes (read first)

(Anything a worker re-entering mid-flight needs to know up front —
known land mines, supercedence relationships, gotchas.)

## Status

(The worker seeds this from §Sequencing on the first tick. On every
slice commit it flips a `[ ]` to `[x]` and appends the short SHA.
It's the source of truth for "what's left.")

- [ ] 42.1 — manifest type + helpers
- [ ] 42.2 — content-addressed write path
- [ ] ...

## 42.1 Goal

(What this phase delivers, one paragraph. Optional but recommended
because it's what gets quoted in the merge-commit subject line.)

## 42.2 Non-goals

(Explicit "we are not doing X this phase" — keeps the worker from
expanding scope.)

## 42.3 Architecture

(Diagrams, type sketches, the design discussion that anchors the
slices below.)

## 42.4 Sequencing

(The slice list — discrete, individually-testable, one-commit-each
units of work. The worker walks this top to bottom. Slice ids match
the Status checklist exactly.)

- **42.1** — manifest type + helpers
- **42.2** — content-addressed write path
- ...

## 42.5 Done criteria

(A checklist of "this phase is shipped when..." — the worker reads
this before renaming the doc to DONE_. Use it to encode invariants
the slice list doesn't capture, e.g. "manual smoke run on Chrome
Linux + Mac" or "no `transformers.js`-cache substring scans in any
worker.")
```

If a phase depends on another, write `Depends on phase X` somewhere in
the doc — the worker greps for it and exits 4 if X isn't merged yet.

When the phase finishes, the worker renames the doc:

```
roadmap/phase-04-user-entity.md → roadmap/DONE_phase-04-user-entity.md
```

That rename is part of the merge commit. After merge, `ls roadmap/`
shows shipped phases at a glance.

## Authoring phase docs — the process

The loop is only as good as the phase docs it consumes. A phase doc
that's vague, oversized, or missing slices will produce vague,
oversized, or stuck runs. The process below is the one that drove
two-dozen consecutive phases to completion in the project this tool
was extracted from — adopt it as-is, or adapt to taste.

### Step 1 — Capture the goal in one paragraph

Before any slices, write the §Goal section as a single paragraph
answering: **what does this phase deliver, and why now?** If you
can't compress it to a paragraph, the phase is too big — split it.

> **Example.** _"Replace the implicit transformers.js `CacheStorage`
> cache with an atomic, content-addressed, dtype-isolated OPFS store
> that every model-loading worker (LLM, STT, TTS) consumes through a
> shared package. Required now because Phase 31's TTS slice landed a
> third copy of the lifecycle code, and Phase 43's runtime-engine
> swap needs a single seam to swap weight sources behind."_

Good goals name the deliverable and the forcing function. Bad goals
read like task lists ("add OPFS, add manifest, add fetch interceptor").

### Step 2 — Name what's NOT in scope

§Non-goals is the under-rated section. Write 3–6 bullets of "this
phase will not do X" — things a reasonable reader might expect to
be included but aren't. This is the worker's primary defense against
scope creep mid-run.

> **Example.**
> - **Not** replacing the existing worker-protocol contracts. Workers
>   still load through the same `prepareModel()` seam; only the bytes
>   beneath it change source.
> - **Not** introducing on-device weight quantization. Out of scope;
>   tracked as a follow-up phase.
> - **Not** wiring the OPFS quota UI surface. The store exposes a
>   typed `quota-exceeded` failure mode; the UI consuming it is its
>   own phase.

### Step 3 — Sketch the architecture before slicing

§Architecture is the design discussion: type sketches, sequence
diagrams in ASCII, decision rationale. Two failure modes to avoid:
**handwaving** (the worker will fill the gap with a guess that may
not match your intent) and **over-specifying** (the worker reads
1500 lines of prose and burns its context on understanding the doc
instead of writing code).

Aim for: enough to disambiguate the design choices, no more. Three
to five named types or interfaces, a handful of decision rationales
("we picked X over Y because Z"), and one diagram if the shape isn't
obvious from prose.

### Step 4 — Decompose into slices

This is the load-bearing step. Each slice must satisfy:

- **One commit's worth of change.** If a slice spans more than 200–300
  lines of net diff across more than ~5 files, split it.
- **Individually green-testable.** Every slice ends with the project's
  quality gate passing — `pnpm typecheck && pnpm lint && pnpm test`
  by default. A slice that introduces a stub call site without the
  type it'll eventually need is a bad slice; either bundle the type
  with the call site, or land the type alone first as its own slice.
- **Ordered so each new slice only forward-references slices below
  it.** A slice that depends on a later slice's work is a sign the
  order is wrong, or the two slices should merge.
- **Named with a stable id.** `<phase>.<n>` or `<phase>.<n><letter>`
  works well. The id appears in the Status checklist, in commit
  subject lines, and in cross-references — it is load-bearing for
  navigation, so don't renumber.

Concrete slice-list example:

```markdown
## 04.4 Sequencing

- **04.1** — `User` document type + zod schema in `packages/dal`
- **04.2** — `UserRepository` (PouchDB-backed, read-only)
- **04.3** — `UserCreateService` (writes the founding `user:CREATE`
  delta, owns sig generation)
- **04.4a** — bus command `identity:create-user` + validator
  (`admin-or-genesis-only`)
- **04.4b** — bus fact `identity:user-created` + sync-bus adapter wiring
- **04.5** — `<user-form>` Lit component (property-driven, no service refs)
- **04.6** — `<users-page>` shell at `/admin/users`, wires bus + reader
```

The slice ids match what shows up in the Status checklist and in
commit subjects (`feat(phase-04): 04.4a — bus command...`). The first
slice ships a foundational type; each subsequent slice can be tested
in isolation against what's already on the branch.

### Step 5 — Write the Done criteria

Some invariants don't fit cleanly into a single slice. Capture them
in §Done criteria:

```markdown
## 04.7 Done criteria

- [ ] Every `User`-touching writer threads through `UserCreateService`;
      no direct repo writes outside the service.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green on every commit.
- [ ] Manual smoke: genesis → create user → log out → log in as new
      user → verify capabilities match the assigned role. Recorded
      pass / fail in this section.
- [ ] No emoji introduced anywhere in the diff (`git diff $BASE_BRANCH...
      HEAD | rg "[^\x00-\x7F]"` returns nothing surprising).
```

The worker reads this list before renaming the doc to `DONE_`. Items
the worker can verify automatically (typecheck green, no emoji bytes)
get verified each tick. Items that require hardware or human eyes
(manual smoke) get the row left unchecked and the merge is gated
on the human ticking it off post-run — phrase those rows so it's
obvious which is which.

### Step 6 — Add a Resume notes block at the top

The worker spawns fresh every tick. The first thing it does is
re-orient. A short §Resume notes section at the top of the phase
doc — before anything else — saves it from rediscovering known
pitfalls every time:

```markdown
## Resume notes (read first)

- Supersedes phase 03 (auth-token-based identity). Do not pull from
  03's slice list; it's archived.
- Depends on phase 02 (cryptographic identity). Halt with exit 4 if
  phase 02 is not yet merged.
- The PouchDB upsert convention applies: `create()` doubles as the
  post-merge persist path, so it MUST read existing `_rev` through.
  See `packages/storage/src/repos/instances.ts` for the pattern.
- Known land mine: registering a new bus command without a paired
  validator will pass typecheck and fail at runtime. Always land
  the validator in the same slice as the command.
```

Resume notes are most valuable on re-entry — when the worker had
to halt mid-phase, the supervisor ran, and the worker is now coming
back to a half-built branch.

### Step 7 — Add the manifest entry

Append to §Order in the manifest. Don't reorder the queue without
intent; later entries may depend on earlier ones implicitly through
shared assumptions.

```markdown
21. [pending] **phase-04** — user entity + admin surface
```

That's it. Launch the loop; this phase becomes the next tick's target.

### Patterns that consistently work

- **Land the type first.** A new type / interface / schema gets its
  own slice before any consumer touches it. Lets every downstream
  slice typecheck independently.
- **Codemod slices ship the migration in their own commit.** Don't
  bundle "add new field" with "migrate all callers" — split them.
  The migration slice is grep-and-replace mechanical; failures in
  it are easy to bisect because the diff is uniform.
- **UI slices come after the data + bus slices.** UI components
  consume already-shipped types and facts. Reversed order means
  re-doing the UI when the data shape lands.
- **Smoke tests in the phase doc, not in code.** The §Done criteria
  manual-smoke rows describe what to click; they're documentation,
  not executable. Trying to encode them as Playwright suites every
  phase is over-engineering — most phases don't need it.

### Anti-patterns to avoid

- **Slices that span "all packages."** A slice that says "update every
  package to use the new helper" is really N slices. Sub-agents can
  parallelize the work, but the slice boundary should still be one
  package, not all of them.
- **"Cleanup" slices at the end.** If the phase introduces tech debt
  worth cleaning, either bundle the cleanup into the slice that
  introduced it, or write a follow-up phase. A trailing "tidy up"
  slice usually grows to dwarf the rest of the phase.
- **Goals that read like changelogs.** "We added X, Y, Z" is a
  description of the diff, not a goal. Goals answer "why."

## Configuration (environment variables)

All overridable in env at launch time.

| Variable | Default | What it does |
| --- | --- | --- |
| `REPO_ROOT` | `/work` | Where the repo is mounted inside the container. |
| `MANIFEST` | `$REPO_ROOT/roadmap/EXECUTION-MANIFEST.md` | The manifest path. |
| `PROMPT_FILE` | `$REPO_ROOT/claudopilot/prompts/worker.md` | Worker prompt source. |
| `SUPERVISOR_PROMPT_FILE` | `$REPO_ROOT/claudopilot/prompts/supervisor.md` | Supervisor prompt source. |
| `LOG_FILE` | `$REPO_ROOT/.claudopilot.log` | Activity log (overwritten on loop start; tail -f to watch). |
| `BASE_BRANCH` | current `git branch` | Branch the loop cuts phase branches from and merges back to. Refuses the trunk (`main`/`master`) unless `BASE_BRANCH_EXPLICIT=1`. |
| `MAX_PARALLEL` | `3` | Max phases running concurrently (each a `claude -p` worker in its own git worktree). Tune to cores and rate-limit headroom. |
| `GATE_CMD` | `pnpm typecheck && lint && test && check-circular && i18n:check` | Per-phase quality gate; must match `worker.md` and the pre-commit hook. |
| `WORKTREE_PREPARE_CMD` | `pnpm install --frozen-lockfile` | Run in each new worktree so the isolated checkout can build (cheap via pnpm's store). |
| `POLL_SECONDS` | `5` | Scheduler poll interval between reap/launch passes. |
| `MAX_ITER` | `2000` | Hard ceiling on scheduling passes (not phases). |
| `MAX_SUPERVISOR_ATTEMPTS_PER_PHASE` | `2` | How many times the supervisor can step in on one phase before it is parked/failed. |
| `KEEP_GOING` | `0` | When `1`, never halt for a human: a phase the supervisor can't green is parked (`[blocked]`, branch kept, not merged) and the run continues with other phases; final supervisor attempt is best-effort. Exit `8` if anything was parked. |
| `RUNNER_FORCE_BOOTSTRAP` | `0` | Force `pnpm install` at loop start even if `node_modules` exists. |
| **Usage governance** | | |
| `USAGE_WINDOW_SECONDS` | `18000` (5h) | Rolling window for the proactive rate-limit heuristic. |
| `MAX_TICKS_PER_WINDOW` | `40` | Approximate cap on ticks within a window. Tune to your Claude plan. |
| `USAGE_THRESHOLD_PCT` | `95` | Sleep until window reset when ticks-in-window crosses this %. |
| `DEFAULT_RATE_LIMIT_SLEEP` | `3600` (1h) | Fallback sleep duration when a rate-limit-shaped error doesn't carry a parseable retry hint. |
| `IGNORE_LOOP_CHECKPOINTS` | `0` | When `1`, ignore `<!-- LOOP-CHECKPOINT: ... -->` blocks and proceed to the next pending phase. Real halts (dep errors, supervisor exhaustion, rate limits) still fire. |
| **Resilience & recovery** | | |
| `RETRY_TRANSIENT_API` | `1` | Relaunch (don't park) a worker that died on a transient server-side API error — HTTP 500/502/503, 529 overloaded, dropped socket — distinct from a rate limit. Set `0` to park them instead. |
| `TRANSIENT_API_MAX_RETRIES` | `10` | Per-phase cap on transient-API relaunches before the phase is parked/halted, so a sustained outage can't loop forever. |
| `STUCK_TIMEOUT` | `0` (off) | Seconds with no transcript growth before a running worker is treated as hung, killed, and relaunched. `0` disables (a long gate can be legitimately quiet — set above your gate's worst-case runtime). |
| **Agent driver** | | |
| `AGENT_DRIVER` | `claude` | Which agent CLI runs each worker: `claude` (Claude Code) or `opencode` (OpenCode; model-agnostic). See [Agent drivers](#agent-drivers-claude-code-or-opencode--ollama). |
| `AGENT_MODEL` | (driver default) | For `opencode`: the `provider/model`, e.g. `ollama/qwen2.5-coder` (local/free) or a hosted model. |
| **Docker** | | |
| `CLAUDOPILOT_IMAGE_TAG` | `claudopilot-runner` | Image tag + container name. Useful if you run multiple loops on one host. |
| **Web dashboard** | | |
| `CLAUDOPILOT_WEB` | `1` | Auto-start the dashboard with each `claudopilot run`. Set `0` to disable. |
| `CLAUDOPILOT_WEB_PORT` | `4317` | Host port for the dashboard (`http://127.0.0.1:<port>`). |
| `CLAUDOPILOT_WEB_HOST` | `127.0.0.1` | Bind address for `web-server.mjs` (the Docker launcher sets `0.0.0.0` inside the container; the published port stays host-loopback). |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Manifest reports complete; all phases merged. |
| `2` | LOOP-CHECKPOINT reached. Edit the manifest to remove the marker and re-launch. |
| `3` | Manifest malformed — no pending entries and no completion sentinel, or unparseable phase id. |
| `4` | Agent reported dependency error — phase doc requires an earlier phase that isn't yet merged. |
| `5` | Worker halted in WIP state — typically test failures it couldn't fix in 5 attempts, supervisor also failed. Inspect `.claudopilot.log` + `git status`. |
| `6` | Phase still pending after the agent ran — likely a crash or silent halt. Inspect the manifest + agent stdout. |
| `7` | Hit `MAX_ITER` without completion. Bump the ceiling or investigate. |
| `8` | `KEEP_GOING` run finished with one or more phases `[blocked]` (parked branches left for review). Not a crash — flip a `[blocked]` entry back to `[pending]` and re-run to retry. |

## Recovering stuck or parked phases

Three layers keep a long unattended run moving without a human babysitting it:

- **Transient API errors auto-retry.** When a worker dies on a server-side API
  failure (HTTP 500/502/503, 529 overloaded, a dropped socket) rather than a gate
  failure, the driver re-pends and relaunches it — up to `TRANSIENT_API_MAX_RETRIES`
  per phase — instead of parking it. This is separate from the rate-limit path
  (429s still take the parsed cooldown). Disable with `RETRY_TRANSIENT_API=0`.
- **Stuck-worker watchdog.** Set `STUCK_TIMEOUT` (seconds) and any running worker
  whose transcript stops growing for that long is killed and relaunched — for a
  wedged API stream or a hung gate command. Off by default so a legitimately-quiet
  long gate isn't killed; set it above your gate's worst-case runtime.
- **Dashboard controls / control seam.** The dashboard shows a **poke** button on
  a running phase (kill + relaunch a hung worker) and a **retry** button on a
  `[blocked]` phase (re-queue a parked one). These post to `POST /api/control`,
  which only drops a file in `.claudopilot/control/` — the driver applies it on its
  next pass, so it stays the sole actor on workers and the manifest. The same seam
  works from a script or another container:

  ```bash
  # poke a hung running worker, or retry a parked [blocked] phase
  echo > .claudopilot/control/<phase-id>.poke
  echo > .claudopilot/control/<phase-id>.retry
  ```

## Rate-limit handling

`claude -p` doesn't expose "% of current rate-limit window," so the loop
hedges with two strategies:

**Proactive heuristic** — counts ticks in a rolling `USAGE_WINDOW_SECONDS`
window and pauses before crossing `USAGE_THRESHOLD_PCT` of
`MAX_TICKS_PER_WINDOW`. Tune to your plan. Pro is roughly 40–50
messages per 5h window; Max is much higher. Default settings are
conservative for Pro.

**Reactive backoff** — if the worker exits non-zero AND the recent log
tail matches `rate.?limit|usage limit|429|too many requests|please
(retry|wait)|exceeded.*(quota|limit)`, the loop tries to parse a numeric
retry hint ("retry after 120 seconds", "wait 5 minutes") and sleeps that
long. Falls back to `DEFAULT_RATE_LIMIT_SLEEP` if no hint is parseable.
The failed tick doesn't burn against `MAX_ITER` or the window counter —
the same phase is retried after the backoff.

## Running outside Docker

Possible but not recommended. `bypassPermissions` means the agent can run
arbitrary commands without prompting; Docker gives you a clean blast
radius. If you do:

```bash
# Same prereqs (~/.claude, ~/.claude.json, SSH key)
cd /path/to/your/repo
git checkout autonomous-runner
REPO_ROOT="$(pwd)" bash claudopilot/run-loop.sh
```

`REPO_ROOT` is the one variable you usually need to set — it defaults
to `/work` (the Docker mount point).

## Agent drivers (Claude Code or OpenCode + Ollama)

The engine is **driver-agnostic** — scheduling, worktrees, serial merges, the
`DONE_` done-signal, and the dashboard don't care which agent CLI runs each
worker. Two are built in, selected with `AGENT_DRIVER`:

| `AGENT_DRIVER` | Runs each worker as | Notes |
| --- | --- | --- |
| `claude` (default) | `claude -p … --output-format stream-json` | Claude Code headless. |
| `opencode` | `opencode run … --format json --dangerously-skip-permissions` | [OpenCode](https://opencode.ai) headless; **model-agnostic** via `AGENT_MODEL`. |

With `opencode`, point `AGENT_MODEL` at any provider/model — including a **local
Ollama model**, for a $0 / offline run:

```bash
# fully local & free: OpenCode + an Ollama model
AGENT_DRIVER=opencode AGENT_MODEL=ollama/qwen2.5-coder \
  REPO_ROOT="$(pwd)" MAX_PARALLEL=1 bash claudopilot/run-loop.sh

# or a cheap/capable hosted model through OpenCode (configure it in OpenCode first)
AGENT_DRIVER=opencode AGENT_MODEL=openrouter/deepseek/deepseek-chat \
  REPO_ROOT="$(pwd)" bash claudopilot/run-loop.sh
```

OpenCode's JSON events are mapped to the same transcript markers by
`render-stream-opencode.mjs`, so the dashboard and `claudopilot progress` work unchanged.

> **Honest caveat — capability, not plumbing.** The worker contract (branch,
> implement slices, keep a real test gate green, fix failures, commit, rename
> `DONE_`) is demanding. Frontier Claude does it reliably; **small local models
> that fit on modest hardware (4B–9B) struggle** — frequent gate failures, loops,
> and parked phases — and are slow. For local/Ollama runs: prefer the simplest
> roadmaps, keep slices tiny, set `MAX_PARALLEL=1`, and lean on the supervisor +
> `KEEP_GOING`. A cheap *hosted* model via OpenCode is the reliable middle ground.

## Native Claude Code plugin (no Docker)

The engine above shells out to `claude -p` subprocesses and wraps them in Docker,
a stream renderer, and a dashboard — all of which exist only because `claude -p`
is a dumb subprocess. If you're driving the loop **hands-on from inside a Claude
Code session**, none of that scaffolding is needed: the session itself can be the
driver, and phases can run as **background agents in git worktrees**. That's what
the bundled `pilot` plugin does.

This repo doubles as a Claude Code **plugin marketplace**. From any session:

```
/plugin marketplace add jopnick/claudopilot      # or a local path to this repo
/plugin install pilot@claudopilot
```

Then, from the root of the repo you want to drive:

```
/pilot-run                                # schedule the manifest; defaults to --max-parallel 3
/pilot-run --max-parallel 4 --keep-going  # fully autonomous: park red phases, keep going
/pilot-run --only phase-04 --push         # one initiative from a shared manifest; push after merge
```

The main session becomes the driver: it reads `roadmap/EXECUTION-MANIFEST.md`,
launches each eligible phase as a background **`pilot:phase-worker`** agent in its
own worktree, merges finished `auto/<id>` branches serially, owns the manifest,
and sends in a **`pilot:phase-supervisor`** when a gate stays red. If there's no
manifest yet, it offers to author one from your goal first.

It is **contract-compatible** with the bash engine — same manifest grammar, same
`auto/<id>` branches, same `DONE_`-rename done-signal, same driver-owns-merges
invariant — so either driver can resume what the other left off (just never run
both against one manifest at once).

| | Native plugin | Bash/Docker engine (primary) |
| --- | --- | --- |
| Runs in | an interactive Claude Code session | a container / host shell, unattended |
| Setup | `/plugin install`, nothing else | Node + Docker + `claudopilot init` |
| Worker isolation | git worktree per phase | worktree, or a container per phase (`--isolated`) |
| Progress UI | background-task view + `/workflows` | `claudopilot web` + `claudopilot progress` |
| Rate limits | handled by the harness | proactive window + reactive backoff |
| Local / $0 models | uses your Claude Code session | yes, via `AGENT_DRIVER=opencode` + Ollama |
| Best for | day-to-day, hands-on runs | CI, fully-unattended runs, hard isolation |

Full contract and flags are in [`pilot/README.md`](pilot/README.md) and
[`pilot/skills/pilot-run/SKILL.md`](pilot/skills/pilot-run/SKILL.md).

## Encoding project rules in worker.md

[prompts/worker.md](prompts/worker.md) has a `## Rules` section split
into two parts:

- **Loop-level rules** (generic): one slice = one commit, no
  `--no-verify`, no skipped tests, no edits to project-wide convention
  docs unless the phase requires them, no interactive prompts. These
  ship as-is.
- **Project-rule extensions**: the conventions specific to your
  codebase that the worker should enforce on every slice. The
  template ships with four common examples — replace them with what
  matters in your project.

The patterns below are battle-tested in the project this tool was
extracted from. Drop them into worker.md verbatim if they fit; trim
or extend per your stack.

### SOLID adherence

The worker is happy to grow a 600-line class with a `mode` flag. The
prompt is your only lever to push back on that. A working SOLID rule
looks like:

```markdown
- **SOLID adherence.** When extending or modifying the codebase, name
  the principle a change touches and check it against the existing
  patterns:
  - **Single Responsibility** — a class with a `mode: "X" | "Y"` flag
    or a boolean to flip behavior is two classes wearing one hat.
    Split them. A "utility" or "helper" file with three unrelated
    methods is three classes pretending to be one.
  - **Open/Closed** — features extend the system by **registering**
    on the bus / plugin registry / module loader (new commands,
    new validators, new owners), not by editing existing files.
    Adding a feature should mean adding a package + a
    `register<Feature>(...)` call, not modifying app-shell.ts or
    another feature.
  - **Liskov** — implementations honor the contract without hidden
    preconditions ("this only works if you also call `_init` first").
    Encode preconditions in types, or factor them into a separate
    method whose call site makes them visible.
  - **Interface Segregation** — feature `*-api` packages are
    type-only and narrow. Other features depend on `*-api`, never
    on the implementation package. If you reach for an implementation
    type, the api is missing something; widen the api, don't bypass.
  - **Dependency Inversion** — concrete services wire in via lazy
    getters at register time so they can be constructed post-login
    without blocking the feature's boot. Don't reach for global
    singletons directly from feature code; depend on the seam.
```

The trick is naming **specific anti-patterns**, not the principle
in the abstract. "Don't violate SRP" is invisible; "a class with a
`mode` flag is a missing SRP split" gets caught.

### Internationalization (no hardcoded user-facing strings)

If your project ships in more than one locale, every user-facing
string is a translation lookup. The worker will happily write
`<h1>Settings</h1>` unless told otherwise:

```markdown
- **Every user-facing string is a translation lookup** via
  `t("namespace.key")`. Hardcoded English in a template is a bug,
  the same way a hex literal in a CSS rule is a bug. The single
  source dictionary is `locales/en.json`; siblings (`fr.json`,
  `es.json`, ...) must stay at parity. Pre-commit gate
  (`pnpm i18n:check`) fails the commit on missing keys or orphan
  keys.
  - **Category A — programmatic identifiers** (bus fact names,
    schema field IDs, enum discriminator values, route paths,
    payload keys): NEVER translated. These are wire format.
    Localizing them breaks deltas / API contracts.
  - **Category B — framework chrome** (button labels, headings,
    descriptions, validation messages, error messages, empty states,
    aria-labels, tooltips): localized via `t()`.
  - **Category C — user-authored content** (calendar event titles,
    thread message bodies, schema labels typed by the admin): never
    translated; render verbatim in the user's locale.
  - When an authored string travels through a message bus (e.g. a
    rule rejection reason that will be displayed later), the
    **producer emits a translation key**, not a translated string —
    `reasonKey: "rules.outcome.role-too-low"` is Category A on the
    wire. Translation happens at the rendering edge, never on the
    wire.
- **CSS logical properties.** `margin-inline-start` not
  `margin-left`; `text-align: start` not `text-align: left`. Costs
  nothing in LTR; makes RTL languages free when they land.
```

The Category A / B / C split is load-bearing — without it the worker
will start translating things that should stay in English (like enum
discriminators) and the resulting bugs are invisible until runtime.

### WCAG accessibility

WCAG 2.2 Level AA is the floor for any product that doesn't actively
exclude assistive-tech users. Encoding it as a worker rule:

```markdown
- **Every interactive element has an accessible name.** Icon-only
  buttons get `aria-label=${t("...")}`; form fields get associated
  `<label>` elements; landmarks (`<nav>`, `<main>`, `<aside>`) wrap
  their respective regions. No bare `<div onclick>`; use `<button>`.
- **Focus rings come from the design-token `--focus-ring`** and
  appear on every focusable element. Never `outline: none` without
  a replacement.
- **Color is never the only signifier.** Status pills carry an icon
  or word in addition to color; validation errors have text in
  addition to red borders.
- **Contrast meets WCAG 2.2 AA**: 4.5:1 for body text, 3:1 for large
  text and UI components against their adjacent surface. Verify
  with a contrast checker, not by eye — dark-mode regressions
  routinely sneak past visual inspection.
- **Touch targets are at least 24×24 px on coarse pointers**
  (`@media (pointer: coarse)`). Hit-area can extend beyond visible
  bounds via `padding` or a `::before` overlay.
- **Keyboard traversal**: Tab moves forward, Shift+Tab moves back,
  Esc dismisses modals, Enter / Space activate buttons, arrow keys
  navigate within composite widgets (menus, listboxes, grids). No
  traps; no required mouse gestures.
- **Reduce-motion respect.** Animations that aren't essential gate
  behind `@media (prefers-reduced-motion: no-preference)`. Essential
  motion (e.g. a brief flash to confirm a destructive action) stays.
- **Screen-reader-only text** for context that's visually obvious
  but invisible to AT: `.sr-only { position: absolute; width: 1px;
  height: 1px; padding: 0; margin: -1px; overflow: hidden; clip:
  rect(0,0,0,0); white-space: nowrap; border: 0; }`.
```

Accessibility rules are particularly worth encoding because the
worker won't proactively notice an `aria-label` is missing — it'll
write idiomatic-looking code that's invisible to screen readers.
The rules above turn that from a quiet regression into a slice that
fails review.

### Common monorepo hygiene

A few extra rules worth dropping in if they fit:

```markdown
- **No emoji anywhere in the codebase** — not in UI strings, comments,
  log lines, error text, or commit messages. Use SVG icons; write
  words for prose status. Unicode dingbats (`✓`, `⚠`) count.
- **No hardcoded colors in component styles.** Every color goes
  through design tokens (`var(--accent)`, `var(--text-muted)`).
  Inline `style="color:#fff"` counts; hex literals in CSS-in-JS count.
- **No backwards-compat shims** unless explicitly required by the
  phase. Fix the callers; don't preserve removed code as a
  re-export with a deprecation comment.
- **No comments explaining WHAT** the code does — names already
  do that. Comments explain WHY the non-obvious choice was made.
```

### How the worker uses these rules

On every slice, before committing, the worker re-reads its own
prompt's §Rules section and audits the diff against each rule. The
loop-level rules are non-negotiable (`--no-verify` is rejected at
the commit step). The project-rule extensions are enforced by the
worker's own judgement — which means they're only as effective as
the prompt's specificity. "Be accessible" produces nothing; the
detailed list above produces measurable behavior changes.

When in doubt, add an example of what NOT to do alongside the rule.
"Don't hardcode user-facing strings" is weaker than "Don't hardcode
user-facing strings — `<h1>Settings</h1>` is a bug; write
`<h1>${t("settings.page-title")}</h1>`."

## Customizing for your project

The contract is generic; the prompts hardcode a few project-specific
assumptions. Likely things to edit:

- **Gate command.** [prompts/worker.md](prompts/worker.md) hardcodes
  `pnpm typecheck && pnpm lint && pnpm test`. Swap for `make ci`, `cargo
  test`, `npm test`, etc.
- **Commit-message vocabulary.** Worker uses `feat | fix | refactor |
  docs | chore | test` (Conventional Commits). If your repo uses
  different prefixes, edit the "Commit immediately" step.
- **Project rules.** Worker.md ends with `## Rules` enumerating things
  like "no emoji," "no hardcoded colors," "no `--no-verify`." Some are
  generic (no `--no-verify`); some are project-specific. Trim freely.
- **Sub-agent guidance.** The "Per-package sweeps" / "Research before
  edit" examples in worker.md are generic patterns; rewrite the
  example sentences if your project's terminology differs.
- **Dockerfile base image.** [Dockerfile](Dockerfile) inherits from
  Playwright Noble for Vitest browser-mode test support. If your project
  doesn't need browsers, swap to `node:22-bookworm-slim` (or similar)
  for a smaller image.

The TypeScript engine ([src/](src/)) and the in-container loop driver
([run-loop.sh](run-loop.sh)) are project-agnostic — you should
not need to edit them for a new project.

## Operational notes

- **Activity log is overwritten on each loop start.** If you need it,
  copy `.claudopilot.log` before re-launching.
- **The loop refuses to launch with `BASE_BRANCH` on the trunk (`main`/`master`)**
  unless `BASE_BRANCH_EXPLICIT=1` is also set. This is the single biggest
  guardrail against the agent landing experimental work directly on the
  trunk. Use a runner-only branch (`autonomous-runner`); cherry-pick
  to `main` at your leisure once a phase is reviewed.
- **SSH key must be passphrase-less** — the Docker wrapper sets
  `BatchMode=yes` so push attempts that prompt for a passphrase fail
  fast instead of hanging the run.
- **Pre-commit hooks must pass.** The worker is forbidden from using
  `--no-verify`. If a slice fails because of a hook, the supervisor
  expects the worker (or itself) to fix the root cause, not bypass it.
- **The worker can spawn sub-agents** via Claude Code's `Agent` tool
  for parallelizing independent work (per-package sweeps, codemods,
  research). Sub-agents inherit `bypassPermissions` and the same tools,
  but cannot push or merge — those stay on the parent worker.

## Releasing (maintainers)

This package is published to npm by CI via **trusted publishing (OIDC)** — no
tokens or secrets. The workflow [`.github/workflows/publish.yml`](.github/workflows/publish.yml)
triggers on a **published GitHub Release** (not on a plain tag push), upgrades npm,
smoke-tests the CLI, skips any version already on the registry, and runs
`npm publish --provenance`.

To cut a release:

```bash
# 1. land your work
git commit -am "…"

# 2. bump the version (commits + tags vX.Y.Z for you)
npm version patch        # or: minor / major

# 3. push the commit and the tag
git push --follow-tags

# 4. publish a GitHub Release for that tag — THIS is the deploy trigger
gh release create vX.Y.Z --generate-notes
```

Notes:

- **Pushing commits or a bare tag does not publish.** Only a *published Release*
  does. Creating the Release in the GitHub UI ("Publish release") works too.
- **Bump the version first.** A Release whose `package.json` version is already on
  npm runs green but publishes nothing (the workflow's skip guard).
- The first publish (`0.1.0`) was done manually; everything after goes through CI.
- One-time trusted-publisher registration (already done) lives in npm →
  *claudopilot → Settings → Trusted Publisher* and must match the workflow filename.

## Why this shape

Three design pressures shaped the loop:

1. **Fresh context per phase.** Long-running conversations drift. Each
   tick spawning a new `claude -p` keeps the context window small and
   forces the worker to commit-often so state lives in git, not in a
   chat history. "What's left" is always a function of `git log` + the
   Status checklist, never of conversational memory.

2. **One slice = one commit = one supervisable unit.** A human watching
   the runner sees progress through `git log`, not through a single
   massive drop at the end. If something goes wrong, the go-back lever
   is per-slice, not per-phase.

3. **Tight supervisor mandate.** The supervisor is not a backup worker.
   It can only apply minimal fixes (≤30 lines, ≤2 files) and exits
   cleanly so the worker can resume. This keeps the loop's recovery
   behaviour predictable — escalations that exceed the supervisor's
   scope halt for human review instead of mutating into runaway edits.

The combination is what makes "leave it running overnight, wake up to N
phases shipped" reliable enough to actually do.
