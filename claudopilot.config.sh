#!/usr/bin/env bash
#
# claudopilot.config.sh — project-owned configuration for claudopilot building
# *itself* (the dashboard SSE migration roadmap under roadmap/).
#
# run-loop.sh sources it; these values override engine defaults. Env vars passed
# at launch override this file in turn.

# ── Quality gate ────────────────────────────────────────────────────────────
# This repo has no compiler/linter pipeline — the artifacts are plain ES modules.
# The gate syntax-checks the JS the roadmap touches and runs the node:test suite
# (phase-01 and phase-05 add the tests; `node --test` exits 0 when none match).
export GATE_CMD="node --check web-server.mjs && node --check progress.mjs && node --test"

# ── Roadmap location ────────────────────────────────────────────────────────
export ROADMAP_DIR="roadmap"
export MANIFEST="$REPO_ROOT/roadmap/EXECUTION-MANIFEST.md"

# ── Scheduling ──────────────────────────────────────────────────────────────
# phase-02 (server) and phase-03 (client) fan out concurrently after contracts.
export MAX_PARALLEL=2
