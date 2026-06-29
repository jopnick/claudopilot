/**
 * Typed config loader for the engine.
 *
 * Resolution order (lowest precedence first):
 *
 *   defaults  <  project config file  <  launch env
 *
 * The project config file is `.claudopilot/config.json` (the 1.0 layout),
 * authored in camelCase. For back-compat the loader also reads the pre-1.0
 * `.claudopilot/config.sh` and root `claudopilot.config.sh` (shell) files —
 * extracted by running them under bash and dumping the resulting environment
 * as JSON, bulletproof across any shell-safe value. Whichever file is found
 * first (json, then sh) is normalised onto a single SHOUTY env-key space so
 * the precedence logic stays single-track.
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { spawnCapture } from "./platform/process.js";
import { runDir as engineRunDir, logFilePath } from "./platform/paths.js";
import type { Config } from "./types.js";

// camelCase JSON config keys → the SHOUTY env keys the merge logic speaks.
const JSON_TO_ENV: Record<string, string> = {
  roadmapDir: "ROADMAP_DIR",
  manifest: "MANIFEST",
  agentDriver: "AGENT_DRIVER",
  agentModel: "AGENT_MODEL",
  promptFile: "PROMPT_FILE",
  supervisorPromptFile: "SUPERVISOR_PROMPT_FILE",
  workerProjectPrompt: "WORKER_PROJECT_PROMPT",
  supervisorProjectPrompt: "SUPERVISOR_PROJECT_PROMPT",
  isolated: "CLAUDOPILOT_ISOLATED",
  workerImage: "WORKER_IMAGE",
  maxParallel: "MAX_PARALLEL",
  pollSeconds: "POLL_SECONDS",
  maxIter: "MAX_ITER",
  maxSupervisorAttemptsPerPhase: "MAX_SUPERVISOR_ATTEMPTS_PER_PHASE",
  keepGoing: "KEEP_GOING",
  gateCmd: "GATE_CMD",
  worktreePrepareCmd: "WORKTREE_PREPARE_CMD",
  bootstrapCmd: "BOOTSTRAP_CMD",
  buildCmd: "BUILD_CMD",
  usageWindowSeconds: "USAGE_WINDOW_SECONDS",
  maxTicksPerWindow: "MAX_TICKS_PER_WINDOW",
  usageThresholdPct: "USAGE_THRESHOLD_PCT",
  defaultRateLimitSleep: "DEFAULT_RATE_LIMIT_SLEEP",
  ignoreLoopCheckpoints: "IGNORE_LOOP_CHECKPOINTS",
  retryTransientApi: "RETRY_TRANSIENT_API",
  transientApiMaxRetries: "TRANSIENT_API_MAX_RETRIES",
  stuckTimeout: "STUCK_TIMEOUT",
  openPr: "OPEN_PR",
  prBase: "PR_BASE",
  prTitle: "PR_TITLE",
  prDraft: "PR_DRAFT",
  logFile: "LOG_FILE",
};
const KNOWN_ENV = new Set(Object.values(JSON_TO_ENV));

/** Inverse of {@link JSON_TO_ENV}: SHOUTY env key → camelCase config key. */
export const ENV_TO_JSON: Record<string, string> = Object.fromEntries(
  Object.entries(JSON_TO_ENV).map(([json, env]) => [env, json]),
);

/** Config env keys whose values are booleans ("0"/"1" in shell). */
export const BOOL_ENV_KEYS = new Set([
  "CLAUDOPILOT_ISOLATED",
  "KEEP_GOING",
  "IGNORE_LOOP_CHECKPOINTS",
  "RETRY_TRANSIENT_API",
  "OPEN_PR",
  "PR_DRAFT",
]);

/** Config env keys whose values are integers. */
export const INT_ENV_KEYS = new Set([
  "MAX_PARALLEL",
  "POLL_SECONDS",
  "MAX_ITER",
  "MAX_SUPERVISOR_ATTEMPTS_PER_PHASE",
  "USAGE_WINDOW_SECONDS",
  "MAX_TICKS_PER_WINDOW",
  "USAGE_THRESHOLD_PCT",
  "DEFAULT_RATE_LIMIT_SLEEP",
  "TRANSIENT_API_MAX_RETRIES",
  "STUCK_TIMEOUT",
]);

/**
 * Convert a SHOUTY env map (as produced by {@link extractShellConfig}) into the
 * camelCase JSON config object — the `claudopilot migrate` conversion. Only
 * recognised keys are carried over; values are coerced to boolean/number per
 * {@link BOOL_ENV_KEYS} / {@link INT_ENV_KEYS}, everything else stays a string.
 */
export function shellEnvToJsonConfig(
  env: Record<string, string>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [envKey, raw] of Object.entries(env)) {
    const jsonKey = ENV_TO_JSON[envKey];
    if (!jsonKey) continue;
    if (BOOL_ENV_KEYS.has(envKey)) out[jsonKey] = raw === "1";
    else if (INT_ENV_KEYS.has(envKey)) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) out[jsonKey] = n;
    } else out[jsonKey] = raw;
  }
  return out;
}

interface ResolvedConfigFile {
  path: string;
  format: "json" | "sh";
}

export interface LoadConfigOptions {
  /**
   * Explicit path to a config file. Format is inferred from the extension
   * (`.json` → JSON, else shell). Default: discover `.claudopilot/config.json`,
   * then the pre-1.0 `.claudopilot/config.sh` / `claudopilot.config.sh`.
   */
  configPath?: string;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover the project config file. An explicit path (option or
 * `CLAUDOPILOT_CONFIG`) wins; otherwise prefer the 1.0 `.claudopilot/config.json`,
 * then fall back to the pre-1.0 shell files.
 */
async function resolveConfigFile(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  opts: LoadConfigOptions,
): Promise<ResolvedConfigFile | null> {
  const explicit = opts.configPath ?? env["CLAUDOPILOT_CONFIG"];
  if (explicit) {
    return { path: explicit, format: explicit.endsWith(".json") ? "json" : "sh" };
  }
  const candidates: ResolvedConfigFile[] = [
    { path: path.join(repoRoot, ".claudopilot", "config.json"), format: "json" },
    { path: path.join(repoRoot, ".claudopilot", "config.sh"), format: "sh" },
    { path: path.join(repoRoot, "claudopilot.config.sh"), format: "sh" }, // pre-1.0
  ];
  for (const c of candidates) {
    if (await isFile(c.path)) return c;
  }
  return null;
}

/** Parse `.claudopilot/config.json` into the SHOUTY env-key space. */
async function loadJsonConfig(p: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    // Accept camelCase (canonical) or a raw SHOUTY env key (lenient).
    const envKey = JSON_TO_ENV[k] ?? (KNOWN_ENV.has(k) ? k : undefined);
    if (!envKey) continue;
    if (typeof v === "boolean") out[envKey] = v ? "1" : "0";
    else if (typeof v === "number") out[envKey] = String(v);
    else if (typeof v === "string") out[envKey] = v;
  }
  return out;
}

/** First of `rels` (relative to repoRoot) that exists on disk, or null. */
async function firstExistingRel(
  repoRoot: string,
  rels: string[],
): Promise<string | null> {
  for (const rel of rels) {
    if (await pathExists(path.join(repoRoot, rel))) return rel;
  }
  return null;
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
  const resolved = await resolveConfigFile(repoRoot, env, opts);
  const configPath =
    resolved?.path ?? path.join(repoRoot, ".claudopilot", "config.json");

  const fileEnv = resolved
    ? resolved.format === "json"
      ? await loadJsonConfig(resolved.path)
      : await extractShellConfig(resolved.path)
    : {};

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

  // Default locations follow the 1.0 layout (.claudopilot/…) but fall back to
  // the pre-1.0 paths when those already exist, so an un-migrated repo keeps
  // working. An explicit config value (env/file) still overrides either.
  const defaultRoadmapDir =
    (await firstExistingRel(repoRoot, [".claudopilot/roadmap", "roadmap"])) ??
    ".claudopilot/roadmap";
  const defaultWorkerPrompt =
    (await firstExistingRel(repoRoot, [
      ".claudopilot/prompts/worker.md",
      "claudopilot/prompts/worker.md",
    ])) ?? ".claudopilot/prompts/worker.md";
  const defaultSupervisorPrompt =
    (await firstExistingRel(repoRoot, [
      ".claudopilot/prompts/supervisor.md",
      "claudopilot/prompts/supervisor.md",
    ])) ?? ".claudopilot/prompts/supervisor.md";

  const roadmapDir = pick("ROADMAP_DIR", defaultRoadmapDir);
  const runDir = engineRunDir(repoRoot);

  return {
    repoRoot,
    configPath,

    roadmapDir,
    manifest: pick(
      "MANIFEST",
      path.join(repoRoot, roadmapDir, "EXECUTION-MANIFEST.md"),
    ),

    agentDriver: pick("AGENT_DRIVER", "claude"),
    agentModel: pickRaw("AGENT_MODEL", ""),

    promptFile: pick("PROMPT_FILE", path.join(repoRoot, defaultWorkerPrompt)),
    supervisorPromptFile: pick(
      "SUPERVISOR_PROMPT_FILE",
      path.join(repoRoot, defaultSupervisorPrompt),
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

    openPr: pickBoolNumeric("OPEN_PR", false),
    prBase: pick("PR_BASE", "main"),
    prTitle: pickRaw("PR_TITLE", ""),
    prDraft: pickBoolNumeric("PR_DRAFT", false),

    runDir,
    worktreesDir: path.join(runDir, "worktrees"),
    controlDir: path.join(runDir, "control"),
    logFile: pick("LOG_FILE", logFilePath(repoRoot)),
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
