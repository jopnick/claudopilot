/**
 * Worker lifecycle — `prepareWorktree`, `launch`, `killWorker`, `cleanup`.
 *
 * Ports `prepare_worktree`, `set_capture_paths`, `launch`, `cleanup_worktree`,
 * `kill_tree` from run-loop.sh (~235–429). Mode = "default" runs the agent as
 * a detached subprocess in a git worktree; mode = "isolated" runs a per-phase
 * disposable container against a per-phase clone (the agent's only writable
 * surface; no push creds inside).
 *
 * The orchestrator does not depend on phase-04's `src/docker.ts` directly —
 * it consumes a `DockerLike` injected by the CLI (phase-07). Non-isolated
 * mode never touches docker.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { CapturePaths, Config } from "../types.js";
import type { Git } from "../git.js";
import { captureAgent, RESUME_NUDGE } from "../agent/capture.js";
import { killTree as defaultKillTree, reapExit } from "../platform/process.js";
import { runDir } from "../platform/paths.js";
import type {
  DockerLike,
  DockerMount,
  WorkerExit,
  WorkerRecord,
} from "./types.js";

export interface WorkerDeps {
  /** Git instance bound to the repo root. */
  git: Git;
  /** Docker wrapper — required iff `config.isolated`. */
  docker?: DockerLike;
  /** Spawner for the detached subprocess wrapper around captureAgent. Test seam. */
  spawnFn?: typeof spawn;
  /** killTree seam. */
  killTreeFn?: typeof defaultKillTree;
  /** captureAgent seam (in-process default). */
  captureAgentFn?: typeof captureAgent;
  /** Async logger (driver's `log()`). */
  log?: (msg: string) => void;
}

export interface LaunchOptions {
  /** Phase id (kebab-case). */
  id: string;
  /** Engine config — already resolved. */
  config: Config;
  /** Composed worker prompt body (without the `The phase to execute is:` tail). */
  workerPrompt: string;
  /**
   * Full prompt to use verbatim INSTEAD of `workerPrompt + suffix` — set on a
   * review-fix relaunch so the worker reads the confirmed findings. Ignored when
   * resuming (the resume nudge always wins).
   */
  promptOverride?: string;
  /** Pre-existing capture paths from `setCapturePaths`. */
  paths: CapturePaths;
  /** Pre-existing worktree/clone path from `prepareWorktree`. */
  worktree: string;
  /** Optional resume session id. */
  resumeSid?: string;
  /** Supervisor mode flag (sets SUPERVISOR_MODE env). */
  supervisorMode?: "standard" | "best-effort";
  /** Supervisor attempt counter (used for the transcript banner). */
  attempt?: number;
  /** Base branch name (for `auto/<id>` creation). */
  baseBranch: string;
}

export interface PrepareWorktreeOptions {
  id: string;
  config: Config;
  baseBranch: string;
}

export interface PrepareWorktreeResult {
  branch: string;
  worktree: string;
}

/** Suffix appended to the worker prompt, per the bash contract. */
export function workerPromptSuffix(id: string): string {
  return (
    `\n\nThe phase to execute is: ${id}` +
    `\nYour working directory is this phase's git worktree on branch auto/${id}.` +
    `\nBuild, gate, and rename the phase doc to DONE_, then exit 0. Do NOT merge` +
    `\nor edit the manifest — the driver owns those.`
  );
}

/** Same as above but for isolated mode (workdir is /work inside the container). */
export function workerPromptSuffixIsolated(id: string): string {
  return (
    `\n\nThe phase to execute is: ${id}` +
    `\nYour working directory (/work) is this phase's clone on branch auto/${id}.` +
    `\nBuild, gate, and rename the phase doc to DONE_, then stop. Do NOT merge, push, or` +
    `\nedit the manifest — the orchestrator owns those.`
  );
}

/**
 * Ensure the phase branch + working surface exists. Mirrors `prepare_worktree`:
 *  - branch: `auto/<id>` cut from BASE_BRANCH if missing
 *  - default mode: `git worktree add <worktreesDir>/<id> auto/<id>`
 *  - isolated mode: `git clone --branch auto/<id> <repoRoot> <worktreesDir>/<id>`
 *
 * On isolated mode the clone is given the host's git user/email so the worker's
 * commits don't fall back to "root@<host>".
 */
export async function prepareWorktree(
  deps: WorkerDeps,
  opts: PrepareWorktreeOptions,
): Promise<PrepareWorktreeResult> {
  const { id, config, baseBranch } = opts;
  const branch = `auto/${id}`;
  const worktree = path.join(config.worktreesDir, id);

  if (!(await deps.git.branchExists(branch))) {
    await deps.git.createBranch(branch, baseBranch);
  }

  if (config.isolated) {
    const exists = await dirExists(worktree);
    if (!exists) {
      deps.log?.(`  [${id}] cloning ${config.repoRoot} -> ${worktree} (isolated, branch ${branch})`);
      await deps.git.clone(config.repoRoot, worktree, { branch });
      const name = await deps.git.configGet("user.name");
      const email = await deps.git.configGet("user.email");
      const cloneGit = makeClonedGit(deps.git, worktree);
      if (name) await cloneGit.configSet("user.name", name);
      if (email) await cloneGit.configSet("user.email", email);
    }
    return { branch, worktree };
  }

  if (!(await dirExists(worktree))) {
    await deps.git.worktreeAdd(worktree, branch);
    if (config.worktreePrepareCmd) {
      deps.log?.(
        `  [${id}] worktree ${worktree}; preparing deps (${config.worktreePrepareCmd})`,
      );
      const r = await runShell(config.worktreePrepareCmd, { cwd: worktree });
      if (r.code !== 0) {
        deps.log?.(`  [${id}] WARNING: worktree prepare failed; worker may need to install.`);
      }
    }
  }
  return { branch, worktree };
}

/** Mirrors `set_capture_paths`. Isolated → inside the clone's run-state dir. */
export function setCapturePaths(
  id: string,
  config: Config,
  worktree: string,
): CapturePaths {
  const base = config.isolated ? runDir(worktree) : config.runDir;
  return {
    log: path.join(base, `${id}.log`),
    stream: path.join(base, `${id}.stream.jsonl`),
    transcript: path.join(base, `${id}.transcript.md`),
  };
}

/**
 * Launch a worker. Returns a `WorkerRecord` holding a `done` promise that
 * resolves with the worker's exit code/signal once it has finished. The caller
 * (driver) keeps the record in its live map and reaps `done` via Promise.race.
 *
 * Non-isolated: spawn a thin detached Node child that drives `captureAgent` in
 * the worktree. Detaching gives the child its own process group so killTree
 * can take down the agent + its stream renderer together (the bash `kill_tree`
 * equivalent). The wrapper is launched via the current `process.execPath` and
 * a tiny loader script written next to the worktree.
 *
 * Isolated: write the composed prompt to `<clone>/.claudopilot/<id>.prompt.txt`,
 * remove any stale container, then `docker.run` the worker image.
 */
export async function launch(
  deps: WorkerDeps,
  opts: LaunchOptions,
): Promise<WorkerRecord> {
  const { id, config, paths } = opts;
  const branch = `auto/${id}`;

  await mkdir(path.dirname(paths.log), { recursive: true });

  if (config.isolated) {
    return launchIsolated(deps, opts, branch);
  }
  return launchDefault(deps, opts, branch);
}

async function launchDefault(
  deps: WorkerDeps,
  opts: LaunchOptions,
  branch: string,
): Promise<WorkerRecord> {
  const { id, config, workerPrompt, paths, worktree, resumeSid, supervisorMode, attempt } = opts;
  const captureFn = deps.captureAgentFn ?? captureAgent;
  const baseSpawn = deps.spawnFn ?? spawn;
  const prompt = resumeSid
    ? RESUME_NUDGE
    : (opts.promptOverride ?? workerPrompt + workerPromptSuffix(id));

  // captureAgent runs the agent CLI in-process; we intercept its spawn via the
  // documented test seam to capture the ChildProcess so the orchestrator can
  // killTree it on poke/watchdog. Spawning detached gives the child its own
  // process group (matching the bash `kill_tree` semantics).
  let child: ChildProcess | undefined;
  const trackingSpawn = ((cmd: string, args: readonly string[], spawnOpts: Record<string, unknown> = {}) => {
    const c = (baseSpawn as unknown as (
      ...a: unknown[]
    ) => ChildProcess)(cmd, args, { ...spawnOpts, detached: true });
    child = c;
    return c;
  }) as unknown as typeof spawn;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };
  if (supervisorMode) env["SUPERVISOR_MODE"] = supervisorMode;

  const done = (async (): Promise<WorkerExit> => {
    const res = await captureFn({
      driver: config.agentDriver === "opencode" ? "opencode" : "claude",
      id,
      prompt,
      ...(resumeSid !== undefined ? { resumeSid } : {}),
      cwd: worktree,
      env,
      paths,
      ...(config.agentModel ? { model: config.agentModel } : {}),
      supervisorMode: Boolean(supervisorMode),
      attempt,
      spawn: trackingSpawn,
    });
    return { code: res.code, signal: res.signal };
  })();

  const kill = async (): Promise<void> => {
    if (!child) return;
    const killer = deps.killTreeFn ?? defaultKillTree;
    killer(child, "SIGTERM");
    try {
      await reapExit(child);
    } catch {
      /* ignore */
    }
  };

  const rec: WorkerRecord = {
    id,
    branch,
    worktree,
    paths,
    done,
    supervisorAttempts: attempt ?? 0,
    apiRetries: 0,
    kill,
    ...(resumeSid !== undefined ? { resumeSid } : {}),
  };
  // Track the child on the record once captureAgent spawns it (asynchronously),
  // so killWorker can fall back to it if it fires before our kill closure.
  void (async () => {
    // Yield once so captureAgent's first spawn call has a chance to run.
    await Promise.resolve();
    if (child) rec.child = child;
  })();
  return rec;
}

async function launchIsolated(
  deps: WorkerDeps,
  opts: LaunchOptions,
  branch: string,
): Promise<WorkerRecord> {
  const { id, config, workerPrompt, paths, worktree, resumeSid, supervisorMode } = opts;
  if (!deps.docker) {
    throw new Error(`isolated mode requires a DockerLike (id=${id})`);
  }

  const promptDir = runDir(worktree);
  await mkdir(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, `${id}.prompt.txt`);
  await writeFile(
    promptPath,
    opts.promptOverride ?? workerPrompt + workerPromptSuffixIsolated(id),
    "utf8",
  );

  const containerName = `cp-w-${id}`;
  await deps.docker.rmForce(containerName);

  const mounts: DockerMount[] = [{ host: worktree, container: "/work" }];
  const home = process.env["HOME"];
  if (home) {
    if (await dirExists(path.join(home, ".claude"))) {
      mounts.push({ host: path.join(home, ".claude"), container: "/home/runner/.claude" });
    }
    if (await fileExists(path.join(home, ".claude.json"))) {
      mounts.push({
        host: path.join(home, ".claude.json"),
        container: "/home/runner/.claude.json",
      });
    }
  }

  const env: NodeJS.ProcessEnv = {
    ...(process.env["ANTHROPIC_API_KEY"]
      ? { ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] }
      : {}),
    CLAUDOPILOT_PHASE: id,
    GATE_CMD: config.gateCmd,
    WORKTREE_PREPARE_CMD: config.worktreePrepareCmd,
    AGENT_DRIVER: config.agentDriver,
  };
  if (config.agentModel) env["AGENT_MODEL"] = config.agentModel;
  if (supervisorMode) env["SUPERVISOR_MODE"] = supervisorMode;
  if (resumeSid) env["CLAUDOPILOT_RESUME_SID"] = resumeSid;

  deps.log?.(
    `  LAUNCH [${id}] (isolated container ${containerName})${resumeSid ? " [resume]" : ""} -> ${paths.transcript}`,
  );

  const done = (async (): Promise<WorkerExit> => {
    const r = await deps.docker!.run({
      name: containerName,
      image: config.workerImage,
      rm: true,
      init: true,
      ipc: "host",
      shmSize: "2g",
      mounts,
      env,
      // The engine is baked into the worker image (see Dockerfile), so the
      // per-phase entrypoint is the bundled CLI's hidden __worker subcommand —
      // no vendored bash. Inputs arrive via the forwarded env above.
      cmd: ["claudopilot", "__worker"],
    });
    return { code: r.code, signal: r.signal };
  })();

  return {
    id,
    branch,
    worktree,
    paths,
    containerName,
    done,
    supervisorAttempts: opts.attempt ?? 0,
    apiRetries: 0,
    ...(resumeSid !== undefined ? { resumeSid } : {}),
  };
}

/**
 * Kill a running worker. Non-isolated → killTree(child); isolated → docker
 * rm-f. Safe to call on a record with no live child / container.
 */
export async function killWorker(
  deps: WorkerDeps,
  record: WorkerRecord,
): Promise<void> {
  if (record.containerName && deps.docker) {
    await deps.docker.rmForce(record.containerName);
    return;
  }
  if (record.kill) {
    await record.kill();
    return;
  }
  if (record.child) {
    const killer = deps.killTreeFn ?? defaultKillTree;
    killer(record.child, "SIGTERM");
    try {
      await reapExit(record.child);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Remove the worktree/clone and delete the phase branch. Mirrors
 * `cleanup_worktree`. Non-fatal: failures are swallowed (matches bash).
 */
export async function cleanup(
  deps: WorkerDeps,
  id: string,
  config: Config,
): Promise<void> {
  const worktree = path.join(config.worktreesDir, id);
  const branch = `auto/${id}`;

  if (config.isolated) {
    if (deps.docker) {
      try {
        await deps.docker.rmForce(`cp-w-${id}`);
      } catch {
        /* ignore */
      }
    }
    if (await dirExists(worktree)) {
      try {
        await rm(worktree, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    await deps.git.deleteBranch(branch);
    return;
  }

  if (await dirExists(worktree)) {
    await deps.git.worktreeRemove(worktree);
  }
  await deps.git.deleteBranch(branch);
}

// ── helpers ──────────────────────────────────────────────────────────────

async function dirExists(p: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function runShell(
  cmd: string,
  opts: { cwd: string },
): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn("bash", ["-c", cmd], {
      cwd: opts.cwd,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", () => resolve({ code: 1 }));
    child.once("close", (code) => resolve({ code }));
  });
}

function makeClonedGit(git: Git, cwd: string): Git {
  // Re-use the Git class via its public constructor — the only state it holds
  // is the cwd and binary, both available on the original.
  const ctor = git.constructor as new (opts: { cwd: string; bin?: string }) => Git;
  return new ctor({ cwd });
}
