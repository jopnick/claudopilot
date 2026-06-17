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
# node --test is scoped to web/*.test.mjs (not a tree walk) so it never recurses
# through the self-referential `claudopilot -> .` symlink; it no-ops until the
# first test file exists.
export GATE_CMD='node --check web-server.mjs && node --check progress.mjs && { ls web/*.test.mjs >/dev/null 2>&1 && node --test web/*.test.mjs || echo "(no tests yet)"; }'

# ── Roadmap location ────────────────────────────────────────────────────────
export ROADMAP_DIR="roadmap"
export MANIFEST="$REPO_ROOT/roadmap/EXECUTION-MANIFEST.md"

# ── Scheduling ──────────────────────────────────────────────────────────────
# Serial execution — one phase at a time (phase-02 then phase-03, etc.).
export MAX_PARALLEL=1
