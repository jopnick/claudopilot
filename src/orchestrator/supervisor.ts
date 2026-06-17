/**
 * Supervisor + merge helpers.
 *
 * Ports the supervisor side of `run-loop.sh`:
 *   - `branch_has_done`        → branchHasDone
 *   - `merge_phase`            → mergePhase  (+ resolveDerivedConflicts)
 *   - `supervise`              → supervise
 *   - `mark_resume`            → markResume
 *   - `commit_build_log`       → commitBuildLog
 *   - `park_or_halt`           → parkOrHalt   (returned in SuperviseOutcome)
 *   - `cool_down`              → driver awaits a delay using parseCooldownSeconds
 *
 * `supervise` is the routing function called from the driver's `handle_exit`
 * when a worker stopped without renaming the phase doc to DONE_ (claude -p
 * exits 0 even on a short stop, so a missing DONE_ — not the process code —
 * is the halt signal). It rate-limit cools, transient-retries, or escalates
 * to a supervisor agent with a widening mandate, then either merges,
 * re-launches the worker, or parks/halts.
 */

import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import * as path from "node:path";
import type { Config, PhaseState } from "../types.js";
import type { Git } from "../git.js";
import {
  extractSessionId,
  isRateLimited,
  isTransientApiError,
  parseCooldownSeconds,
  tailLines,
} from "../agent/detect.js";
import type { DockerLike, WorkerExit, WorkerRecord } from "./types.js";

export type SupervisorMode = "standard" | "best-effort";

export type SuperviseOutcome =
  | { kind: "merged" }
  | { kind: "relaunch"; mode?: SupervisorMode; resumeSid?: string }
  | { kind: "rateLimitCooldown"; seconds: number }
  | { kind: "transientRetry"; attempt: number; cap: number }
  | { kind: "park"; code: number; reason: string };

export interface SupervisorContext {
  config: Config;
  git: Git;
  docker?: DockerLike;
  log?: (msg: string) => void;
  /**
   * Run the supervisor agent on a phase. The driver injects this so the
   * supervisor doesn't need to import worker.ts (or care which mode it is in).
   * It MUST run synchronously to completion and return the agent's exit.
   */
  runSupervisorAgent: (args: {
    id: string;
    prompt: string;
    record: WorkerRecord;
    mode: SupervisorMode;
  }) => Promise<WorkerExit>;
  /** Manifest state writer (driver-owned). */
  setState: (id: string, state: PhaseState) => Promise<void>;
}

const SUPERVISE_SUFFIX = (id: string, mode: SupervisorMode): string =>
  `\n\nThe phase that just halted: ${id}\n` +
  `The worker stopped without renaming the phase doc to DONE_ (claude -p exits 0 even on\n` +
  `a short stop, so a missing DONE_ rename is the halt signal — not the process code).\n` +
  `Supervisor mode: ${mode}  (best-effort = wider edit mandate; get the gate green if at all possible — it is all in git)`;

/**
 * True iff the phase's `auto/<id>` branch reached the DONE_ rename. Mirrors
 * `branch_has_done` exactly, including the isolated-mode fix that consults
 * the clone's branch tree (the host ref is stale until `mergePhase` fetches
 * it from the clone).
 */
export async function branchHasDone(
  config: Config,
  git: Git,
  id: string,
  worktree: string,
): Promise<boolean> {
  const branch = `auto/${id}`;
  const donePrefix = `${config.roadmapDir}/DONE_${id}`;

  if (config.isolated && (await dirExists(worktree))) {
    const cloneGit = git_in(git, worktree);
    const tree = await cloneGit.lsTree(branch);
    return tree.some((p) => p.startsWith(donePrefix));
  }

  const log = await git.logTouching(branch, `${donePrefix}*`);
  if (log.length > 0) return true;
  const tree = await git.lsTree(branch);
  return tree.some((p) => p.startsWith(donePrefix));
}

/**
 * Record the worker's claude session id so the next relaunch resumes the same
 * conversation instead of cold-starting. Only used for not-the-worker's-fault
 * interruptions (rate limit, watchdog, transient API). Mirrors `mark_resume`.
 *
 * Returns the session id if one was found, otherwise null. The caller writes
 * it back onto the WorkerRecord.
 */
export function markResume(record: WorkerRecord, log?: (m: string) => void): string | null {
  const sid = extractSessionId(record.paths.stream);
  if (!sid) return null;
  record.resumeSid = sid;
  log?.(`  [${record.id}] will resume session ${sid} on relaunch`);
  return sid;
}

/**
 * Copy the transcript and gzip the raw stream into `build-logs/<id>/`, then
 * `git add` + commit (`--no-verify`). Pure side-effects: returns true iff a
 * commit was created, false if there was nothing to record or commit. Mirrors
 * `commit_build_log` (must run from the BASE_BRANCH checkout).
 */
export async function commitBuildLog(
  config: Config,
  git: Git,
  record: WorkerRecord,
  log?: (m: string) => void,
): Promise<boolean> {
  const dir = path.join(config.repoRoot, "build-logs", record.id);
  const transcript = record.paths.transcript;
  const stream = record.paths.stream;

  const tHas = await isNonEmpty(transcript);
  const sHas = await isNonEmpty(stream);
  if (!tHas && !sHas) return false;

  await fs.mkdir(dir, { recursive: true });
  if (tHas) await fs.copyFile(transcript, path.join(dir, "transcript.md"));
  if (sHas) await gzipFile(stream, path.join(dir, "stream.jsonl.gz"));

  // Mirror the bash fallback: also persist a copy of the transcript into runDir
  // so post-run readers find it after an isolated clone is removed.
  if (tHas) {
    const dst = path.join(config.runDir, `${record.id}.transcript.md`);
    if (transcript !== dst) {
      try {
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(transcript, dst);
      } catch {
        /* best-effort */
      }
    }
  }

  await git.add(`build-logs/${record.id}`);
  if (await git.hasStagedChanges(`build-logs/${record.id}`)) {
    const r = await git.commit({
      message: `docs(build-log): ${record.id} agent transcript + raw stream`,
      noVerify: true,
    });
    if (r.code === 0) {
      log?.(`  [${record.id}] build-log committed -> build-logs/${record.id}/`);
      return true;
    }
  }
  return false;
}

/**
 * Auto-resolve merge conflicts that touch ONLY derived files (the pnpm lockfile
 * by default). Regenerate them from the merged manifests and complete the merge.
 * Returns true on a clean auto-resolve. Mirrors `resolve_derived_conflicts`.
 */
export async function resolveDerivedConflicts(
  git: Git,
  log?: (m: string) => void,
  derivedRe = process.env["DERIVED_CONFLICT_FILES"] ?? "^pnpm-lock\\.yaml$",
  regenCmd = process.env["LOCKFILE_REGEN_CMD"] ?? "pnpm install --lockfile-only",
): Promise<boolean> {
  const unresolved = await git.unresolvedConflicts();
  if (unresolved.length === 0) return false;
  const re = new RegExp(derivedRe);
  if (unresolved.some((f) => !re.test(f))) return false;

  log?.(`  derived-only merge conflict; regenerating: ${unresolved.join(" ")}`);
  for (const f of unresolved) await git.checkoutOurs(f);
  const r = await runShell(regenCmd, { cwd: (git as unknown as { cwd?: string }).cwd ?? process.cwd() });
  if (r.code !== 0) return false;
  for (const f of unresolved) await git.add(f);
  if ((await git.unresolvedConflicts()).length > 0) return false;
  const c = await git.run(["commit", "--no-edit"]);
  return c.code === 0;
}

export interface MergeResult {
  ok: boolean;
  /** Set on failure: the reason to bubble up to parkOrHalt. */
  reason?: string;
}

/**
 * The driver-owned merge: checkout base, optionally fetch clone→host in
 * isolated mode, pull-ff origin, `git merge --no-ff`, auto-resolve derived
 * conflicts, set state, commit build log, push, cleanup. Mirrors `merge_phase`.
 */
export async function mergePhase(
  config: Config,
  git: Git,
  record: WorkerRecord,
  setState: (id: string, state: PhaseState) => Promise<void>,
  cleanup: (id: string) => Promise<void>,
  baseBranch: string,
  log?: (m: string) => void,
): Promise<MergeResult> {
  log?.(`  MERGE [${record.id}] -> ${baseBranch}`);
  await git.checkout(baseBranch);

  if (config.isolated && (await dirExists(record.worktree))) {
    await git.fetchRef(record.worktree, `+${record.branch}:${record.branch}`, { quiet: true });
  }
  await git.pullFfOnly("origin", baseBranch);

  const m = await git.merge(record.branch, {
    noFf: true,
    message: `Merge ${record.id} (autonomous)`,
  });
  if (m.code !== 0) {
    if (await resolveDerivedConflicts(git, log)) {
      log?.(`  [${record.id}] merge completed after regenerating derived files`);
    } else {
      await git.mergeAbort();
      return {
        ok: false,
        reason: "MERGE CONFLICT (non-derived files; concurrent streams must be package-disjoint)",
      };
    }
  }
  await setState(record.id, "merged");
  await commitBuildLog(config, git, record, log);
  await git.push("origin", baseBranch);
  await cleanup(record.id);
  await git.pushDelete("origin", record.branch);
  return { ok: true };
}

/**
 * Route a worker that finished without renaming DONE_. Returns the outcome the
 * driver should apply. The supervisor agent is invoked synchronously via
 * `ctx.runSupervisorAgent`; the driver handles the actual state writes and
 * worker re-launch.
 */
export async function supervise(
  ctx: SupervisorContext,
  record: WorkerRecord,
  exitCode: number,
  supervisorPromptBody: string,
): Promise<SuperviseOutcome> {
  const { config, log } = ctx;
  const logText = await readSafe(record.paths.log);

  // Rate-limit shaped → cool down, mark resume, re-pend.
  if (isRateLimited(logText)) {
    const secs = parseCooldownSeconds(logText, config.defaultRateLimitSleep);
    log?.(`  [${record.id}] rate-limit-shaped; relaunch after cooldown.`);
    markResume(record, log);
    return { kind: "rateLimitCooldown", seconds: secs };
  }

  // Transient API error (and retries remain) → re-pend, no supervisor spend.
  if (
    config.retryTransientApi &&
    isTransientApiError(logText) &&
    record.apiRetries < config.transientApiMaxRetries
  ) {
    record.apiRetries += 1;
    log?.(
      `  [${record.id}] transient API error — relaunching (retry ${record.apiRetries}/${config.transientApiMaxRetries}).`,
    );
    markResume(record, log);
    return {
      kind: "transientRetry",
      attempt: record.apiRetries,
      cap: config.transientApiMaxRetries,
    };
  }

  // Supervisor attempts exhausted → park.
  if (record.supervisorAttempts >= config.maxSupervisorAttemptsPerPhase) {
    return {
      kind: "park",
      code: exitCode,
      reason: "supervisor exhausted (no DONE_ doc)",
    };
  }

  // Spend a supervisor attempt. Final attempt always widens the mandate.
  record.supervisorAttempts += 1;
  const mode: SupervisorMode =
    record.supervisorAttempts >= config.maxSupervisorAttemptsPerPhase ? "best-effort" : "standard";

  log?.(
    `  [${record.id}] no DONE_ doc on branch; SUPERVISOR attempt ${record.supervisorAttempts}/${config.maxSupervisorAttemptsPerPhase} (${mode})`,
  );

  const prompt = supervisorPromptBody + SUPERVISE_SUFFIX(record.id, mode);
  const exit = await ctx.runSupervisorAgent({ id: record.id, prompt, record, mode });

  if (exit.code === 0 && (await branchHasDone(config, ctx.git, record.id, record.worktree))) {
    log?.(`  [${record.id}] supervisor produced DONE_; merging.`);
    return { kind: "merged" };
  }
  if (exit.code === 0) {
    log?.(`  [${record.id}] supervisor OK; relaunching worker on same worktree.`);
    return { kind: "relaunch", mode };
  }
  return {
    kind: "park",
    code: exitCode,
    reason: "supervisor could not recover",
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function isNonEmpty(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function gzipFile(src: string, dst: string): Promise<void> {
  await pipeline(createReadStream(src), createGzip(), createWriteStream(dst));
}

async function readSafe(p: string): Promise<string> {
  try {
    const txt = await fs.readFile(p, "utf8");
    return tailLines(txt); // already returns last N
  } catch {
    return "";
  }
}

/** Build a Git instance pinned to `cwd` from another instance's class. */
function git_in(reference: Git, cwd: string): Git {
  const Ctor = reference.constructor as new (opts: { cwd: string }) => Git;
  return new Ctor({ cwd });
}

async function runShell(
  cmd: string,
  opts: { cwd: string },
): Promise<{ code: number | null }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], {
      cwd: opts.cwd,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", () => resolve({ code: 1 }));
    child.once("close", (code) => resolve({ code }));
  });
}
