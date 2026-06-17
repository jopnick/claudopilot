/**
 * Typed config loader for the engine.
 *
 * Mirrors `run-loop.sh` resolution order:
 *
 *   defaults  <  claudopilot.config.sh  <  launch env
 *
 * The .sh seam stays so the bash driver and the TS driver read the same
 * project config file. The .sh is extracted by running it under bash and
 * dumping the resulting environment as JSON via Node — bulletproof across
 * any shell-safe values (paths with spaces, quoted commands, newlines).
 *
 * A future `claudopilot.config.{ts,json}` seam will plug in here: prefer
 * the typed file when present, fall back to the .sh, then defaults.
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { spawnCapture } from "./platform/process.js";
import type { Config } from "./types.js";

export interface LoadConfigOptions {
  /** Path to claudopilot.config.sh. Default `<repoRoot>/claudopilot.config.sh`. */
  configPath?: string;
}

/**
 * Build the typed Config for a repo. Tolerates a missing .sh (defaults
 * win). `env` is the launch-time environment overlay (usually
 * `process.env`).
 */
export async function loadConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): Promise<Config> {
  const configPath =
    opts.configPath ??
    env["CLAUDOPILOT_CONFIG"] ??
    path.join(repoRoot, "claudopilot.config.sh");

  const fileEnv = await extractShellConfig(configPath);

  // Merge order: defaults < file < launch env. `pick` consults file first,
  // then env, then falls back to the default.
  const pick = (key: string, fallback: string): string => {
    const fromEnv = env[key];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    const fromFile = fileEnv[key];
    if (fromFile !== undefined && fromFile !== "") return fromFile;
    return fallback;
  };
  const pickRaw = (key: string, fallback: string): string => {
    // Same as pick, but preserves empty strings (used for optional commands
    // where "unset = skip" must remain distinguishable from a deliberate "").
    const fromEnv = env[key];
    if (fromEnv !== undefined) return fromEnv;
    const fromFile = fileEnv[key];
    if (fromFile !== undefined) return fromFile;
    return fallback;
  };
  const pickInt = (key: string, fallback: number): number => {
    const raw = pick(key, String(fallback));
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const pickBoolNumeric = (key: string, fallback: boolean): boolean => {
    // run-loop.sh uses "0"/"1" strings for flags.
    const raw = pick(key, fallback ? "1" : "0");
    return raw === "1";
  };

  const roadmapDir = pick("ROADMAP_DIR", "roadmap");
  const runDir = path.join(repoRoot, ".claudopilot");

  return {
    repoRoot,
    configPath,

    roadmapDir,
    manifest: pick(
      "MANIFEST",
      path.join(repoRoot, roadmapDir, "EXECUTION-MANIFEST.md"),
    ),

    renderStream: pick(
      "RENDER_STREAM",
      path.join(repoRoot, "claudopilot", "render-stream.mjs"),
    ),
    renderStreamOpencode: pick(
      "RENDER_STREAM_OPENCODE",
      path.join(repoRoot, "claudopilot", "render-stream-opencode.mjs"),
    ),

    agentDriver: pick("AGENT_DRIVER", "claude"),
    agentModel: pickRaw("AGENT_MODEL", ""),

    promptFile: pick(
      "PROMPT_FILE",
      path.join(repoRoot, "claudopilot", "prompts", "worker.md"),
    ),
    supervisorPromptFile: pick(
      "SUPERVISOR_PROMPT_FILE",
      path.join(repoRoot, "claudopilot", "prompts", "supervisor.md"),
    ),
    workerProjectPrompt: pickRaw("WORKER_PROJECT_PROMPT", ""),
    supervisorProjectPrompt: pickRaw("SUPERVISOR_PROJECT_PROMPT", ""),

    isolated: pickBoolNumeric("CLAUDOPILOT_ISOLATED", false),
    workerImage: pick("WORKER_IMAGE", "claudopilot-runner"),

    maxParallel: pickInt("MAX_PARALLEL", 3),
    pollSeconds: pickInt("POLL_SECONDS", 5),
    maxIter: pickInt("MAX_ITER", 2000),
    maxSupervisorAttemptsPerPhase: pickInt(
      "MAX_SUPERVISOR_ATTEMPTS_PER_PHASE",
      2,
    ),

    keepGoing: pickBoolNumeric("KEEP_GOING", false),
    gateCmd: pick("GATE_CMD", "true"),
    worktreePrepareCmd: pickRaw("WORKTREE_PREPARE_CMD", ""),
    bootstrapCmd: pickRaw("BOOTSTRAP_CMD", ""),
    buildCmd: pickRaw("BUILD_CMD", ""),

    usageWindowSeconds: pickInt("USAGE_WINDOW_SECONDS", 18000),
    maxTicksPerWindow: pickInt("MAX_TICKS_PER_WINDOW", 40),
    usageThresholdPct: pickInt("USAGE_THRESHOLD_PCT", 95),
    defaultRateLimitSleep: pickInt("DEFAULT_RATE_LIMIT_SLEEP", 3600),

    ignoreLoopCheckpoints: pickBoolNumeric("IGNORE_LOOP_CHECKPOINTS", false),

    retryTransientApi: pickBoolNumeric("RETRY_TRANSIENT_API", true),
    transientApiMaxRetries: pickInt("TRANSIENT_API_MAX_RETRIES", 10),
    stuckTimeout: pickInt("STUCK_TIMEOUT", 0),

    runDir,
    worktreesDir: path.join(runDir, "worktrees"),
    controlDir: path.join(runDir, "control"),
    logFile: pick("LOG_FILE", path.join(repoRoot, ".claudopilot.log")),
  };
}

/**
 * Run the .sh file under bash and capture the post-source environment as
 * JSON via the current Node binary. Returns {} if the file doesn't exist
 * or bash fails — defaults still cover everything.
 */
export async function extractShellConfig(
  configPath: string,
): Promise<Record<string, string>> {
  try {
    const st = await fs.stat(configPath);
    if (!st.isFile()) return {};
  } catch {
    return {};
  }

  // Start bash from a near-empty env so the captured output reflects what
  // the file CONTRIBUTED, not the orchestrator's whole environment.
  // PATH/HOME/NODE are the bare minimum bash + Node need to function.
  const baselineEnv: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/tmp",
    NODE: process.execPath,
  };

  // `set -a` so every assignment in the file is exported and visible to the
  // forked Node process. The Node child prints `process.env` as JSON — a
  // bulletproof carrier for any value (newlines, quotes, spaces).
  const script = `set -a
. "$1"
"$NODE" -e 'process.stdout.write(JSON.stringify(process.env))'`;

  let res;
  try {
    res = await spawnCapture("bash", ["-c", script, "_", configPath], {
      env: baselineEnv,
      timeoutMs: 10_000,
    });
  } catch {
    return {};
  }
  if (res.code !== 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  // Drop the baseline vars so callers can tell "set by file" from "leaked
  // in to make bash work". NODE is our injection, not the file's.
  delete out["NODE"];
  if (out["PATH"] === baselineEnv["PATH"]) delete out["PATH"];
  if (out["HOME"] === baselineEnv["HOME"]) delete out["HOME"];
  return out;
}
