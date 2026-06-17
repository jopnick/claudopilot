# Phase 02 — manifest + config + git wrapper

## Resume notes (read first)

You own **`src/manifest.ts`, `src/config.ts`, `src/git.ts`** (+ their tests) and
nothing else. Import types from `src/types.ts` (phase-01). This is the data layer
phases 04/05/06 build on. Runs concurrently with phase-03 — do not touch
`src/agent/*`. The source of truth for behavior is `run-loop.sh` (`order_lines`,
`set_state`, `all_merged`, `phase_doc`, the config block lines ~44–141, and the
~50 `git` invocations) and `progress.mjs` (manifest parsing).

## Status

- [x] 02.1 — `src/manifest.ts` parse + serialize + state transitions (86be63d)
- [ ] 02.2 — `src/config.ts` typed config loader
- [ ] 02.3 — `src/git.ts` typed git wrapper

## Goal

Port the manifest grammar, project config loading, and git operations to typed,
tested modules — replacing the `grep/sed/awk` manifest parsing and the inline `git`
shell-outs with a single reusable surface.

## Non-goals

- No driver/scheduler logic (phase-06), no docker (phase-04), no agent capture
  (phase-03).
- Do not edit the bash scripts.

## Architecture

- **`src/manifest.ts`** — ports `order_lines`/`set_state`/`all_merged`/`phase_doc`:
  - `parseManifest(text): ManifestModel` — the Order grammar
    `N. [state] **id** — title (deps: a, b)`, including the **`(deps: none)` →
    no-deps** normalization (drop the bare `none` token) and `**Status:**` capture.
  - `setState(text, id, state): string` — pure string transform of one Order line
    (mirrors the `sed` in `set_state`), returning new file text; the caller commits.
  - `setStatusComplete(text): string`, `allMerged(model): boolean`,
    `eligiblePhases(model): PhaseEntry[]` (pending + all deps merged),
    `findPhaseDoc(roadmapDir, id): string | null`.
  - Heavily unit-tested against fixture manifests (deps:none, multi-dep, mixed
    states, malformed lines ignored) — this grammar is parity-critical.
- **`src/config.ts`** — `loadConfig(repoRoot, env): Config`. Resolution order
  matching `run-loop.sh`: defaults → `claudopilot.config.sh` → env override. Extract
  the sh file by running `bash -lc 'set -a; source <file>; env'` and diffing the
  environment (WSL has bash), parsed into the typed `Config`. Tolerate a missing
  config (all defaults). Document the future `claudopilot.config.{ts,json}` seam.
- **`src/git.ts`** — a thin typed wrapper over `spawnCapture` (phase-01) covering
  exactly what the engine uses: `currentBranch`, `branchExists`, `createBranch`,
  `worktreeAdd/Remove`, `clone`, `checkout`, `merge({noFf})`, `fetchRef`,
  `lsTree`/`logTouching` (for `branch_has_done`), `add`, `commit`, `push`,
  `deleteBranch`, `revParse`, `config get/set`. Each returns `{ code, stdout, stderr }`
  or a typed result; never throws on expected non-zero (callers branch on `code`).

## Sequencing

- **02.1 — manifest.** `parseManifest`/`setState`/`allMerged`/`eligiblePhases`/
  `findPhaseDoc` + fixture tests. One commit.
- **02.2 — config.** `loadConfig` with sh-extraction + env override + defaults; tests
  with a fixture config. One commit.
- **02.3 — git.** Typed `git.ts` wrapper over the platform spawn; tests stub/spawn
  against a temp repo for the read-only ops. One commit.
