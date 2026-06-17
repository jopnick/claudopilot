#!/usr/bin/env bash
#
# claudopilot.config.sh — project-owned configuration for claudopilot building
# *itself* (the bash → TypeScript engine port under roadmap/).
#
# run-loop.sh sources it; these values override engine defaults. Env vars passed
# at launch override this file in turn.

# ── Quality gate ────────────────────────────────────────────────────────────
# The TypeScript engine's gate: typecheck + tests. `--passWithNoTests` keeps it
# green before the first test file exists (phase-01 defines these pnpm scripts;
# lint runs in CI, not the per-slice gate, so early slices aren't blocked by it).
# The leading `pnpm -s typecheck` fails loudly only once a tsconfig exists.
export GATE_CMD='pnpm -s typecheck && pnpm -s test'

# Install deps inside each fresh per-phase clone so typecheck/tests can run.
export WORKTREE_PREPARE_CMD='pnpm install --prefer-offline'

# ── Roadmap location ────────────────────────────────────────────────────────
export ROADMAP_DIR="roadmap"
export MANIFEST="$REPO_ROOT/roadmap/EXECUTION-MANIFEST.md"

# ── Scheduling ──────────────────────────────────────────────────────────────
# Up to 3 phases at once: phase-02/03 fan out after contracts, then
# phase-04/05/06 can run three-at-a-time.
export MAX_PARALLEL=3
