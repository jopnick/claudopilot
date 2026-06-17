# Phase 08 — parity verification + cross-platform CI + cutover

## Resume notes (read first)

Final phase; runs after phase-07. Proves the TS engine matches bash, wires
cross-platform CI, then flips the default engine and retires bash. You own the test
harness under `tests/parity/`, the CI workflow under `.github/workflows/`, the
default-engine flip in `bin/claudopilot.mjs`, and the bash-script removal. If a
parity test reveals a real behavior gap, fix the smallest thing in the relevant
`src/` module and note it here.

## Status

- [x] 08.1 — differential parity harness (bash vs TS on a fixture roadmap) (9e19079)
- [ ] 08.2 — cross-platform GitHub Actions matrix
- [ ] 08.3 — flip default engine to `ts` + retire bash scripts

## Goal

Establish confidence that the TypeScript engine is behavior-identical to bash across
platforms, then cut over: make `ts` the default engine and remove the bash scripts.

## Non-goals

- No new engine features; this phase is verification + CI + cutover only.
- Don't delete bash until the parity harness is green (08.3 depends on 08.1).

## Architecture

- **`tests/parity/` (08.1)** — a tiny fixture roadmap (1–2 trivial phases with a
  no-op gate, no real agent — stub the agent driver) run through **both**
  `run-loop.sh` and the TS driver in temp git repos; assert identical: manifest
  state sequence, final `**Status:**`, process exit code, and `build-logs/` layout.
  Cover the key branches: clean merge, a `(deps: none)` phase, a dependency chain,
  and a forced supervisor path. This is the core proof of functional parity.
- **CI (08.2) — `.github/workflows/ci.yml`:** matrix `os: [ubuntu, macos, windows]`
  running `pnpm install`, `typecheck`, `lint`, `build`, and unit tests (windows runs
  under its WSL/Node as agreed; pure-Node units run natively). A separate
  Linux-only job runs the Docker e2e smoke (`claudopilot run --engine ts` on a
  one-phase fixture in isolated mode → merges, exit 0). The parity harness runs on
  ubuntu+macos.
- **Cutover (08.3):** flip `bin/claudopilot.mjs` default to the TS engine (repoint
  `bin` at `dist/cli.js`), update `package.json` `files` to ship `dist/` (drop the
  bash scripts), update `README`/`EXTRACTION.md`, and **remove** `run-loop.sh`,
  `run-in-docker.sh`, `worker-entry.sh`, `progress.sh` (and the now-superseded
  `.mjs` once their TS equivalents are the entry). Keep `web/*.mjs` browser assets.

## Sequencing

- **08.1 — parity harness.** Differential bash-vs-TS fixture tests green. One commit.
- **08.2 — CI matrix.** `.github/workflows/ci.yml` (build/typecheck/lint/unit across
  OSes + Linux Docker e2e). One commit.
- **08.3 — cutover.** Default engine → `ts`, ship `dist/`, docs, delete bash scripts.
  One commit.
