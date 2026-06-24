/**
 * Canonical on-disk layout for a claudopilot project.
 *
 * Everything claudopilot owns lives under a single `.claudopilot/` folder in
 * the target repo:
 *
 *   .claudopilot/
 *     config.json          — project config (committed)
 *     prompts/             — worker/supervisor guidelines + project overlay (committed)
 *     roadmap/             — EXECUTION-MANIFEST.md + per-phase docs (committed)
 *     .run/                — run-state: worktrees, captures, control, log (gitignored)
 *
 * The committed config seam is resolved in `config.ts` (with back-compat for
 * the pre-1.0 layout: claudopilot.config.sh, ./roadmap, ./claudopilot/prompts).
 * This module is the single source of truth for the *run-state* paths — the
 * `.run/` subtree — so the orchestrator (writer), the in-container worker
 * entry, and the host-side progress/web readers never drift apart.
 */

import * as path from "node:path";

/** Committed engine dir holding config.json, prompts/, roadmap/. */
export const ENGINE_DIR = ".claudopilot";

/** Gitignored run-state dir under {@link ENGINE_DIR}. */
export const RUN_DIR_NAME = ".run";

/**
 * Run-state dir for a base — the repo root (host mode) or a worker's worktree
 * (isolated mode). Host path style.
 */
export function runDir(base: string): string {
  return path.join(base, ENGINE_DIR, RUN_DIR_NAME);
}

/**
 * POSIX variant for container paths. The worker writes captures from inside
 * the Linux worker image where the repo is bind-mounted at `/work`; those
 * paths must always join POSIX-style regardless of the host OS.
 */
export function runDirPosix(base: string): string {
  return path.posix.join(base, ENGINE_DIR, RUN_DIR_NAME);
}

/** A worker's worktree dir, under the repo's run-state. */
export function worktreeDir(repoRoot: string, id: string): string {
  return path.join(runDir(repoRoot), "worktrees", id);
}

/**
 * Capture file (`<id>.transcript.md`, `<id>.stream.jsonl`, …) as written by an
 * *isolated* worker into its worktree's run-state, read back from the host.
 */
export function cloneCapturePath(
  repoRoot: string,
  id: string,
  file: string,
): string {
  return path.join(runDir(worktreeDir(repoRoot, id)), file);
}

/** Capture file for a *host-mode* (non-isolated) run, in the repo run-state. */
export function mainCapturePath(
  repoRoot: string,
  id: string,
  file: string,
): string {
  return path.join(runDir(repoRoot), file);
}

/** The driver's log file, in the repo run-state. */
export function logFilePath(repoRoot: string): string {
  return path.join(runDir(repoRoot), "claudopilot.log");
}
