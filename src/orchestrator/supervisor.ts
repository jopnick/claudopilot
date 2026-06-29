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

// Every common JS lockfile, not just pnpm's. Each package-adding phase rewrites
// its lockfile, so parallel phases collide there regardless of package manager.
const DERIVED_CONFLICT_FILES_DEFAULT =
  "^(pnpm-lock\\.yaml|package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|bun\\.lockb?)$";

/**
 * Map a conflicted lockfile to the command that regenerates it from the
 * (already merged) package.json set alone — no full install, no network where
 * the manager supports it. Mirrors `lockfile_regen_cmd_for` in run-loop.sh.
 */
export function lockfileRegenCmdFor(file: string): string | undefined {
  const base = file.split("/").pop() ?? file;
  switch (base) {
    case "pnpm-lock.yaml":
      return "pnpm install --lockfile-only";
    case "package-lock.json":
    case "npm-shrinkwrap.json":
      return "npm install --package-lock-only";
    case "yarn.lock":
      return "yarn install --mode=update-lockfile";
    case "bun.lock":
    case "bun.lockb":
      return "bun install";
    default:
      return undefined;
  }
}

/**
 * Auto-resolve merge conflicts that touch ONLY derived files (the package
 * manager lockfile). Regenerate them from the merged manifests and re-stage
 * them. Package-manager-agnostic out of the box: pnpm, npm, yarn, and bun
 * lockfiles are all recognized and regenerated with the matching command,
 * inferred from which lockfile is in conflict.
 *
 * Tunable via DERIVED_CONFLICT_FILES (ERE) — a conflict is only auto-resolved if
 * every conflicted path matches it — and LOCKFILE_REGEN_CMD, which when set
 * overrides the inferred regen command. Returns true when every conflict was
 * resolved (the resolved changes are left STAGED for the caller to commit as
 * part of its single squash commit — this function does not commit). Mirrors
 * `resolve_derived_conflicts`.
 */
export async function resolveDerivedConflicts(
  git: Git,
  log?: (m: string) => void,
  derivedRe = process.env["DERIVED_CONFLICT_FILES"] ?? DERIVED_CONFLICT_FILES_DEFAULT,
  regenCmdOverride = process.env["LOCKFILE_REGEN_CMD"],
): Promise<boolean> {
  const unresolved = await git.unresolvedConflicts();
  if (unresolved.length === 0) return false;
  const re = new RegExp(derivedRe);
  if (unresolved.some((f) => !re.test(f))) return false;

  // An explicit override wins; otherwise infer the regen command from the
  // lockfile(s) in conflict so npm/yarn/bun/pnpm all work without config.
  let regenCmd = regenCmdOverride;
  if (!regenCmd) {
    for (const f of unresolved) {
      const cmd = lockfileRegenCmdFor(f);
      if (cmd) {
        regenCmd = cmd;
        break;
      }
    }
  }
  if (!regenCmd) {
    // Matched DERIVED_CONFLICT_FILES but unknown manager — set LOCKFILE_REGEN_CMD.
    log?.(
      `  derived-only merge conflict but no lockfile regen command for: ${unresolved.join(" ")}`,
    );
    return false;
  }

  log?.(`  derived-only merge conflict; regenerating (${regenCmd}): ${unresolved.join(" ")}`);
  for (const f of unresolved) await git.checkoutOurs(f);
  const r = await runShell(regenCmd, { cwd: (git as unknown as { cwd?: string }).cwd ?? process.cwd() });
  if (r.code !== 0) return false;
  for (const f of unresolved) await git.add(f);
  // Leave the resolved index staged; mergePhase lands it as the squash commit.
  return (await git.unresolvedConflicts()).length === 0;
}

/**
 * Push a phase's `auto/<id>` work branch to origin so every engineer running
 * claudopilot can pull the latest state of in-flight work. Called when a worker
 * is reaped (whether the phase ends up merged, parked, or blocked).
 *
 * Best-effort and never throws: a missing `origin`, a branch with no commits
 * yet, or a transient failure is logged and swallowed. A non-fast-forward push
 * (a re-run recreated the branch from a fresher base, so the remote tip is no
 * longer an ancestor) is retried once with `--force-with-lease`. In isolated
 * mode the real branch tip lives in the per-phase clone, so the host ref is
 * fast-forwarded from it first.
 */
export async function pushWorkBranch(
  config: Config,
  git: Git,
  record: WorkerRecord,
  log?: (m: string) => void,
): Promise<void> {
  if (!(await git.hasRemote("origin"))) return;

  if (config.isolated && (await dirExists(record.worktree))) {
    await git.fetchRef(record.worktree, `+${record.branch}:${record.branch}`, { quiet: true });
  }
  if (!(await git.revParse(record.branch))) return; // nothing committed yet

  const r = await git.push("origin", record.branch);
  if (r.code === 0) {
    log?.(`  [${record.id}] pushed ${record.branch} -> origin`);
    return;
  }
  const f = await git.pushForceWithLease("origin", record.branch);
  if (f.code === 0) {
    log?.(`  [${record.id}] pushed ${record.branch} -> origin (force-with-lease)`);
  } else {
    log?.(`  [${record.id}] WARNING: could not push ${record.branch} to origin (code ${f.code}).`);
  }
}

export interface MergeResult {
  ok: boolean;
  /** Set on failure: the reason to bubble up to parkOrHalt. */
  reason?: string;
}

/**
 * Build the message for the single squash commit. The subject names the phase;
 * the body lists the worker's individual commit subjects (oldest first) so the
 * squashed-away history stays traceable from `git log`.
 */
export function squashCommitMessage(record: WorkerRecord, subjects: readonly string[]): string {
  const subject = `${record.id} (autonomous, squashed)`;
  if (subjects.length === 0) return subject;
  const body = subjects.slice().reverse().map((s) => `- ${s}`).join("\n");
  return `${subject}\n\nSquashed commits from ${record.branch}:\n${body}`;
}

/**
 * The driver-owned merge: checkout base, optionally fetch clone→host in
 * isolated mode, pull-ff origin, `git merge --squash` (so the whole phase lands
 * as ONE commit on the base branch), auto-resolve derived conflicts, commit,
 * set state, commit build log, push base, cleanup, and delete the now-merged
 * remote work branch. Mirrors `merge_phase` but squashes instead of `--no-ff`.
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
  log?.(`  MERGE [${record.id}] -> ${baseBranch} (squash)`);
  await git.checkout(baseBranch);

  if (config.isolated && (await dirExists(record.worktree))) {
    await git.fetchRef(record.worktree, `+${record.branch}:${record.branch}`, { quiet: true });
  }
  await git.pullFfOnly("origin", baseBranch);

  // Capture the worker's commit subjects before squashing them away.
  const subjects = await git.logSubjects(`${baseBranch}..${record.branch}`);

  const m = await git.mergeSquash(record.branch);
  if (m.code !== 0) {
    if (await resolveDerivedConflicts(git, log)) {
      log?.(`  [${record.id}] squash merge resolved after regenerating derived files`);
    } else {
      // A squash merge records no MERGE_HEAD, so abort with a hard reset.
      await git.resetHard();
      return {
        ok: false,
        reason: "MERGE CONFLICT (non-derived files; concurrent streams must be package-disjoint)",
      };
    }
  }

  // `git merge --squash` never commits — land the staged tree as one commit.
  if (await git.hasStagedChanges()) {
    const cr = await git.commit({ message: squashCommitMessage(record, subjects) });
    if (cr.code !== 0) {
      await git.resetHard();
      return { ok: false, reason: `squash commit failed (code ${cr.code})` };
    }
  } else {
    log?.(`  [${record.id}] nothing to merge (already in ${baseBranch}).`);
  }

  await setState(record.id, "merged");
  await commitBuildLog(config, git, record, log);

  if (await git.hasRemote("origin")) {
    const p = await git.push("origin", baseBranch);
    if (p.code !== 0) log?.(`  [${record.id}] WARNING: push ${baseBranch} -> origin failed (code ${p.code}).`);
  }
  await cleanup(record.id);
  // The squashed work is now in the base branch; drop the merged work branch
  // from the remote (it was pushed while in flight). Best-effort.
  if (await git.hasRemote("origin")) {
    const d = await git.pushDelete("origin", record.branch);
    if (d.code === 0) log?.(`  [${record.id}] deleted merged remote branch ${record.branch}`);
  }
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
