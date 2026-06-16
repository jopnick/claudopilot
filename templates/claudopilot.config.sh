#!/usr/bin/env bash
#
# claudopilot.config.sh — project-owned configuration.
#
# This file STAYS in your repo (the engine under ./claudopilot/ is vendored and
# repo-agnostic). run-loop.sh sources it and these values override the engine
# defaults. Environment variables passed at launch override this file in turn.
#
# Uncomment and edit what your project needs; sensible defaults apply otherwise.

# ── Quality gate ────────────────────────────────────────────────────────────
# The command every slice must keep green. Keep it identical here, in
# claudopilot/prompts/worker.project.md, and in any pre-commit hook.
# export GATE_CMD="npm run typecheck && npm run lint && npm test"

# ── Lifecycle commands ──────────────────────────────────────────────────────
# Run once when a container/clone is first prepared (install deps, etc.).
# export BOOTSTRAP_CMD="npm install"
# A full build, if your gate doesn't already cover it.
# export BUILD_CMD="npm run build"
# Run inside each fresh git worktree so it can build in isolation.
# export WORKTREE_PREPARE_CMD="npm install"

# ── Roadmap location ────────────────────────────────────────────────────────
# export ROADMAP_DIR="roadmap"
# export MANIFEST="$REPO_ROOT/roadmap/EXECUTION-MANIFEST.md"

# ── Prompt overlay ──────────────────────────────────────────────────────────
# Project cornerstones appended to the generic worker prompt.
export WORKER_PROJECT_PROMPT="$REPO_ROOT/claudopilot/prompts/worker.project.md"
# export SUPERVISOR_PROJECT_PROMPT=""

# ── Scheduling ──────────────────────────────────────────────────────────────
# Max phases to run concurrently.
# export MAX_PARALLEL=3
# Set to 1 for a fully-autonomous run: park (don't merge) phases that can't go
# green and keep going with independent work instead of halting.
# export KEEP_GOING=0

# ── Resilience & recovery ───────────────────────────────────────────────────
# Relaunch (don't park) a worker that died on a transient server-side API error
# (HTTP 500/502/503, 529 overloaded, dropped socket), bounded per phase.
# export RETRY_TRANSIENT_API=1
# export TRANSIENT_API_MAX_RETRIES=10
# Kill + relaunch a running worker whose transcript hasn't grown for this many
# seconds (a hung API stream or gate command). 0 = off. Set ABOVE your gate's
# worst-case runtime so a slow-but-healthy test run is never killed.
# export STUCK_TIMEOUT=0
