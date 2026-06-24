/**
 * Port of `worker-entry.sh` — the in-container entrypoint for an isolated
 * worker container (`cp-w-<id>`). Runs ONE phase's agent against the
 * per-phase clone bind-mounted at `/work`.
 *
 * The orchestrator (phase-06) wrote the composed prompt to
 * `/work/.claudopilot/<id>.prompt.txt` and forwarded the env that controls
 * the run (`CLAUDOPILOT_PHASE`, `WORKTREE_PREPARE_CMD`, `SUPERVISOR_MODE`,
 * `CLAUDOPILOT_RESUME_SID`).
 *
 * This module is split so it remains testable without invoking `claude`:
 *
 *   - `parseEnv` — pure: env → `WorkerEntryOptions`.
 *   - `capturePaths(id, base)` — pure: `id` → `{ log, stream, transcript, prompt }`.
 *   - `workerEntry(opts, runner)` — orchestration: header + prepare + agent
 *     run. The agent run is delegated to a `WorkerAgentRunner` so phase-04
 *     does not have to depend on phase-03's `agent/capture.ts` (which lands
 *     separately). Phase-06/07 wires the default runner.
 *   - `RESUME_NUDGE` — the prompt sent on resume; mirrors the same string
 *     `run-loop.sh` uses for `capture_agent --resume`.
 */

import * as path from "node:path";
import {
  promises as fs,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import type { CapturePaths } from "../types.js";
import { spawnCapture } from "../platform/process.js";

// ── parse + paths ───────────────────────────────────────────────────────

export interface WorkerEntryOptions {
  /** Container's view of the bind-mounted clone. Almost always "/work". */
  workdir: string;
  phaseId: string;
  /** Bash command to install the clone's deps; empty/undefined = skip. */
  worktreePrepareCmd?: string;
  /** True iff this is a supervisor attempt (changes the transcript header). */
  supervisor: boolean;
  /** Set after a transient interruption — resume the same Claude session. */
  resumeSessionId?: string;
}

export class WorkerEntryError extends Error {
  constructor(message: string, readonly code: number = 1) {
    super(message);
    this.name = "WorkerEntryError";
  }
}

export function parseEnv(env: NodeJS.ProcessEnv): WorkerEntryOptions {
  const phaseId = env["CLAUDOPILOT_PHASE"];
  if (!phaseId) {
    throw new WorkerEntryError(
      "CLAUDOPILOT_PHASE not set",
      1,
    );
  }
  const workdir = env["CLAUDOPILOT_WORKDIR"] ?? "/work";
  const worktreePrepareCmd = env["WORKTREE_PREPARE_CMD"];
  const supervisor = !!env["SUPERVISOR_MODE"] && env["SUPERVISOR_MODE"] !== "";
  const resumeSessionId = env["CLAUDOPILOT_RESUME_SID"];
  return {
    workdir,
    phaseId,
    ...(worktreePrepareCmd ? { worktreePrepareCmd } : {}),
    supervisor,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}

export interface WorkerCapturePaths extends CapturePaths {
  prompt: string;
}

/**
 * Paths under `<workdir>/.claudopilot/`. Matches the layout `worker-entry.sh`
 * writes (host-visible via the bind-mount, so the orchestrator can stream
 * them live).
 */
export function capturePaths(
  workdir: string,
  phaseId: string,
): WorkerCapturePaths {
  // These are CONTAINER paths (workdir is /work inside the Linux worker), so
  // always join POSIX-style — never the host's `path.sep`. At runtime this code
  // runs in the container (posix anyway); using path.posix keeps it correct when
  // exercised from a Windows host (tests).
  const dir = path.posix.join(workdir, ".claudopilot");
  return {
    log: path.posix.join(dir, `${phaseId}.log`),
    stream: path.posix.join(dir, `${phaseId}.stream.jsonl`),
    transcript: path.posix.join(dir, `${phaseId}.transcript.md`),
    prompt: path.posix.join(dir, `${phaseId}.prompt.txt`),
  };
}

// ── resume nudge (matches RESUME_NUDGE in run-loop.sh) ──────────────────

export const RESUME_NUDGE =
  "A transient interruption (network/API error, watchdog, or poke) stopped you mid-run and your session has now been resumed — your prior context is intact. Re-read the ## Status checklist in your phase doc, then continue from the first unchecked slice. Same contract: build each remaining slice, keep the gate green, rename the phase doc to DONE_ when all slices are done, then stop. Do NOT re-seed the checklist, merge, or edit the manifest.";

// ── agent runner (DI seam — phase-03's agent/capture.ts plugs in here) ──

export interface AgentRunFreshInput {
  phaseId: string;
  prompt: string;
  paths: WorkerCapturePaths;
  workdir: string;
}

export interface AgentRunResumeInput {
  phaseId: string;
  sessionId: string;
  resumeMessage: string;
  paths: WorkerCapturePaths;
  workdir: string;
}

export interface WorkerAgentRunner {
  runFresh(input: AgentRunFreshInput): Promise<number>;
  runResume(input: AgentRunResumeInput): Promise<number>;
}

// ── transcript header (matches the bash `{ echo; echo ===; } >>transcript`) ──

export function transcriptHeader(phaseId: string, supervisor: boolean): string {
  const tag = supervisor ? "supervisor " : "";
  return `\n=== [${phaseId}] ${tag}container run ===\n`;
}

// ── shell-out for WORKTREE_PREPARE_CMD ──────────────────────────────────

export interface PrepareRunner {
  run(cmd: string, opts: { cwd: string; logPath: string }): Promise<number>;
}

export const defaultPrepareRunner: PrepareRunner = {
  async run(cmd, opts) {
    // worker-entry.sh:
    //   echo "[worker-entry] prepare: $CMD" >> plog
    //   eval $CMD >> plog 2>&1 || echo warning
    appendFileSync(opts.logPath, `[worker-entry] prepare: ${cmd}\n`);
    const r = await spawnCapture("bash", ["-c", cmd], { cwd: opts.cwd });
    if (r.stdout) appendFileSync(opts.logPath, r.stdout);
    if (r.stderr) appendFileSync(opts.logPath, r.stderr);
    if (r.code !== 0) {
      appendFileSync(
        opts.logPath,
        "[worker-entry] WARNING: prepare failed; the agent may need to install.\n",
      );
    }
    return r.code ?? 0;
  },
};

// ── filesystem ops (DI for tests) ───────────────────────────────────────

export interface WorkerFs {
  ensureDir(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  readFile(p: string): Promise<string>;
  appendFile(p: string, data: string): Promise<void>;
}

export const defaultWorkerFs: WorkerFs = {
  async ensureDir(p) {
    mkdirSync(p, { recursive: true });
  },
  async exists(p) {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  },
  async readFile(p) {
    return fs.readFile(p, "utf8");
  },
  async appendFile(p, data) {
    await fs.appendFile(p, data);
  },
};

// ── workerEntry — top-level orchestration ───────────────────────────────

export interface WorkerEntryDeps {
  runner: WorkerAgentRunner;
  prepareRunner?: PrepareRunner;
  fs?: WorkerFs;
}

export interface WorkerEntryResult {
  code: number;
  paths: WorkerCapturePaths;
}

/**
 * Run the in-container entrypoint:
 *
 *   1. Verify the workdir is mounted.
 *   2. Create `.claudopilot/` and append the transcript header.
 *   3. Run `WORKTREE_PREPARE_CMD` (if set) into the log.
 *   4. Resume → call `runner.runResume({sid, RESUME_NUDGE, …})`.
 *      Fresh  → read the prompt file → call `runner.runFresh({prompt, …})`.
 */
export async function workerEntry(
  opts: WorkerEntryOptions,
  deps: WorkerEntryDeps,
): Promise<WorkerEntryResult> {
  const fsx = deps.fs ?? defaultWorkerFs;
  const prep = deps.prepareRunner ?? defaultPrepareRunner;

  if (!(await fsx.exists(opts.workdir))) {
    throw new WorkerEntryError(
      `${opts.workdir} not mounted`,
      1,
    );
  }

  const paths = capturePaths(opts.workdir, opts.phaseId);
  await fsx.ensureDir(path.posix.dirname(paths.log));
  await fsx.appendFile(
    paths.transcript,
    transcriptHeader(opts.phaseId, opts.supervisor),
  );

  if (opts.worktreePrepareCmd && opts.worktreePrepareCmd.length > 0) {
    await prep.run(opts.worktreePrepareCmd, {
      cwd: opts.workdir,
      logPath: paths.log,
    });
  }

  if (opts.resumeSessionId && opts.resumeSessionId.length > 0) {
    await fsx.appendFile(
      paths.log,
      `[worker-entry] resuming session ${opts.resumeSessionId}\n`,
    );
    const code = await deps.runner.runResume({
      phaseId: opts.phaseId,
      sessionId: opts.resumeSessionId,
      resumeMessage: RESUME_NUDGE,
      paths,
      workdir: opts.workdir,
    });
    return { code, paths };
  }

  if (!(await fsx.exists(paths.prompt))) {
    throw new WorkerEntryError(`missing ${paths.prompt}`, 1);
  }
  const prompt = await fsx.readFile(paths.prompt);
  const code = await deps.runner.runFresh({
    phaseId: opts.phaseId,
    prompt,
    paths,
    workdir: opts.workdir,
  });
  return { code, paths };
}

/**
 * CLI-style adapter: parse env, run, exit with the agent's code. Phase-06/07
 * wires the actual `runner` (which calls phase-03's `agent/capture.ts`); this
 * function is the shape `dist/worker-entry.js` will eventually export.
 */
export async function mainEntry(
  runner: WorkerAgentRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const opts = parseEnv(env);
    const { code } = await workerEntry(opts, { runner });
    return code;
  } catch (e) {
    if (e instanceof WorkerEntryError) {
      process.stderr.write(`[worker-entry] ${e.message}\n`);
      return e.code;
    }
    throw e;
  }
}
