/**
 * claudopilot CLI — the host-side entrypoint after the phase-08 cutover.
 *
 * Built by tsup into `dist/cli.js` (shebang in tsup banner) and shipped as
 * the package's `bin`. The bash run-in-docker.sh / progress.sh shims were
 * retired here; the in-container scripts (run-loop.sh, worker-entry.sh,
 * render-stream*.mjs, web-server.mjs) remain because the worker image
 * still executes them inside the container.
 *
 * Subcommands:
 *   init [--with-examples] [--force]  Scaffold a repo (vendor engine + project stubs).
 *   run  [--isolated|--shell]      Build the image and start the loop.
 *   progress [--json|--watch [N]|--follow <id>|--no-color|--manifest <p>]
 *   web [--port N] [--host H] [--manifest <p>]
 *   --version | --help
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { Git } from "./git.js";
import { Docker, type Mount, type RunSpec } from "./docker.js";
import type { DockerLike, DockerRunOpts, DockerRunResult } from "./orchestrator/types.js";
import { runOnce, runWatch, runFollow } from "./progress/render.js";
import { startDashboardServer } from "./web/server.js";
import {
  buildSpec,
  planShell,
  planIsolated,
  type RunInDockerOptions,
} from "./runner/runInDocker.js";
import { runDriver } from "./orchestrator/index.js";
import { mainEntry } from "./runner/workerEntry.js";
import { makeCaptureRunner } from "./runner/captureRunner.js";
import { promises as fsp } from "node:fs";

// ── PKG_ROOT resolution ────────────────────────────────────────────────────
//
// Built layout: <pkg>/dist/cli.js  → resolve("..") == <pkg>.
// Source layout: <pkg>/src/cli.ts  → resolve("..") == <pkg> (same shape).
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PackageJson {
  version: string;
  homepage?: string;
}
function pkg(): PackageJson {
  return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as PackageJson;
}

// Engine files vendored into the target repo's ./claudopilot/ on `init`.
// Post-cutover this includes only what the worker container still needs at
// runtime: the in-container loop + worker-entry, render-stream renderers,
// the in-container web server, browser assets, the runner Dockerfile, and
// the prompt templates.
// Engine files vendored into the target repo's ./claudopilot/ on `init`.
// The runtime engine is now baked into the worker image (the bundled CLI) and
// the host CLI — nothing executable is vendored. We still vendor the base
// prompt contract so `config.promptFile` resolves and users can read/tune it;
// the project overlay (worker.project.md) lands as a core project file.
// Vendored under the target repo's `.claudopilot/prompts/`. The base prompt
// contract is tool-managed (safe to re-vendor with --force); the executable
// engine is baked into the worker image + host CLI, nothing executable here.
const ENGINE_FILES: Array<[string, string]> = [
  ["prompts/worker.md", ".claudopilot/prompts/worker.md"],
  ["prompts/supervisor.md", ".claudopilot/prompts/supervisor.md"],
];

// Project files you own and edit. These are NEVER overwritten by `init` (not
// even with --force, which only re-vendors the engine) — a second `init` on a
// configured repo is a safe no-op for everything here.
const CORE_PROJECT_FILES: Array<[string, string]> = [
  ["templates/config.json", ".claudopilot/config.json"],
  ["templates/worker.project.md", ".claudopilot/prompts/worker.project.md"],
];

// The manifest is core, but its starting content depends on whether examples
// were requested: a skeleton (empty Order) by default, or a worked sample.
const MANIFEST_DEST = ".claudopilot/roadmap/EXECUTION-MANIFEST.md";
const MANIFEST_SKELETON_TPL = "templates/EXECUTION-MANIFEST.md";
const MANIFEST_EXAMPLE_TPL = "templates/EXECUTION-MANIFEST.example.md";

// Example scaffolding — only laid down with `--with-examples`, and only into a
// roadmap that has no content of its own yet.
const EXAMPLE_FILES: Array<[string, string]> = [
  ["templates/phase-01-example.md", ".claudopilot/roadmap/phase-01-example.md"],
];

// Run-state dir (gitignored). `init` makes sure the repo's .gitignore excludes
// it so worker worktrees never commit transcripts/control files.
const RUN_STATE_IGNORE = ".claudopilot/.run/";

// ── helpers ────────────────────────────────────────────────────────────────

function writeOut(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}
function writeErr(s: string): void {
  process.stderr.write(s.endsWith("\n") ? s : s + "\n");
}
function die(msg: string, code = 1): never {
  writeErr(`claudopilot: ${msg}`);
  process.exit(code);
}

function copyFile(src: string, dest: string, force: boolean): boolean {
  if (existsSync(dest) && !force) {
    writeOut(`  skip   ${dest} (exists; --force to overwrite)`);
    return false;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  writeOut(`  write  ${dest}`);
  return true;
}

/**
 * Write a project file the user owns. Unlike {@link copyFile}, this NEVER
 * overwrites an existing file — `init` must be safe to re-run on a configured
 * repo. Returns true iff a new file was written.
 */
function writeProjectFile(src: string, dest: string): boolean {
  if (existsSync(dest)) {
    writeOut(`  skip   ${dest} (exists; left as-is)`);
    return false;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  writeOut(`  write  ${dest}`);
  return true;
}

/**
 * True if the roadmap directory already has content of its own — a manifest or
 * any `*.md` phase doc. Used to decide whether `--with-examples` should lay down
 * the sample roadmap: a partially-set-up repo keeps what it has.
 */
function roadmapHasContent(cwd: string): boolean {
  // Honour the pre-1.0 ./roadmap layout too, so a partially-migrated repo
  // still counts as "already has a roadmap".
  for (const rel of [".claudopilot/roadmap", "roadmap"]) {
    const dir = join(cwd, rel);
    if (!existsSync(dir)) continue;
    try {
      if (readdirSync(dir).some((f) => f.endsWith(".md"))) return true;
    } catch {
      /* unreadable — treat as empty */
    }
  }
  return false;
}

/**
 * Make sure the repo's `.gitignore` excludes the run-state dir, so worker
 * worktrees (cut from the base branch) never commit transcripts/control files.
 * Appends the entry if absent; creates `.gitignore` if missing. Idempotent.
 */
function ensureGitignore(cwd: string): void {
  const gitignore = join(cwd, ".gitignore");
  let body = "";
  try {
    body = readFileSync(gitignore, "utf8");
  } catch {
    /* no .gitignore yet — we'll create one */
  }
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(RUN_STATE_IGNORE) || lines.includes(".claudopilot/.run")) {
    writeOut(`  ok     .gitignore already excludes ${RUN_STATE_IGNORE}`);
    return;
  }
  const sep = body === "" || body.endsWith("\n") ? "" : "\n";
  writeFileSync(
    gitignore,
    `${body}${sep}\n# claudopilot run-state (worktrees, captures, control, log)\n${RUN_STATE_IGNORE}\n`,
  );
  writeOut(`  write  .gitignore (added ${RUN_STATE_IGNORE})`);
}

interface FlagSpec {
  bool: ReadonlySet<string>;
}
interface ParsedFlags {
  flags: Record<string, string | true>;
  positional: string[];
}

/**
 * Minimal argv parser. `bool` lists flags that never consume a value
 * (e.g. `--json`); everything else is `--key value` or `--key=value`.
 */
function parseFlags(argv: readonly string[], spec: FlagSpec): ParsedFlags {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const key = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      if (spec.bool.has(key)) {
        flags[key] = true;
        continue;
      }
      if (eq >= 0) {
        flags[key] = tok.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(tok);
    }
  }
  return { flags, positional };
}

// ── init ───────────────────────────────────────────────────────────────────

function cmdInit(args: readonly string[]): number {
  const force = args.includes("--force");
  const withExamples = args.includes("--with-examples");
  const cwd = process.cwd();
  writeOut(`Scaffolding claudopilot into ${cwd}`);

  // Prompt contract: tool-managed, vendored under .claudopilot/prompts/. Safe
  // to re-vendor with --force; this is the only thing --force touches. (The
  // executable engine is baked into the worker image + host CLI, not vendored.)
  writeOut("\nPrompt contract (vendored into .claudopilot/prompts/):");
  for (const [tpl, dest] of ENGINE_FILES) {
    copyFile(join(PKG_ROOT, tpl), join(cwd, dest), force);
  }

  // Core project files: yours to edit, never overwritten.
  writeOut("\nProject files (yours to edit; never overwritten):");
  for (const [tpl, dest] of CORE_PROJECT_FILES) {
    writeProjectFile(join(PKG_ROOT, tpl), join(cwd, dest));
  }

  // Examples are skipped when the roadmap already has content of its own, so a
  // partially-set-up repo keeps what it has even if --with-examples is passed.
  const roadmapSetUp = roadmapHasContent(cwd);
  const emitExamples = withExamples && !roadmapSetUp;
  if (withExamples && roadmapSetUp) {
    writeOut(
      "\nroadmap already has content — skipping examples (your roadmap is left as-is).",
    );
  }

  // Manifest is core (never overwritten); its starting content is the worked
  // sample only when we're emitting examples into an empty roadmap.
  const manifestTpl = emitExamples ? MANIFEST_EXAMPLE_TPL : MANIFEST_SKELETON_TPL;
  writeProjectFile(join(PKG_ROOT, manifestTpl), join(cwd, MANIFEST_DEST));

  if (emitExamples) {
    writeOut("\nExamples (--with-examples):");
    for (const [tpl, dest] of EXAMPLE_FILES) {
      writeProjectFile(join(PKG_ROOT, tpl), join(cwd, dest));
    }
  }

  // Keep run-state out of version control.
  writeOut("\nVersion control:");
  ensureGitignore(cwd);

  const nextSteps = [
    "\nDone. Next steps:",
    "  1. Edit .claudopilot/config.json — set gateCmd and build/bootstrap commands.",
    "  2. Edit .claudopilot/prompts/worker.project.md — your project's cornerstones.",
    "  3. Fill in .claudopilot/roadmap/EXECUTION-MANIFEST.md + per-phase docs.",
  ];
  if (!withExamples) {
    nextSteps.push(
      "     (Run `claudopilot init --with-examples` for a worked sample roadmap.)",
    );
  }
  nextSteps.push(
    "  4. Commit, then: claudopilot run   (--shell drops into the worker image to debug).",
  );
  writeOut(nextSteps.join("\n"));
  return 0;
}

// ── progress ───────────────────────────────────────────────────────────────

async function cmdProgress(args: readonly string[]): Promise<number> {
  const { flags } = parseFlags(args, {
    bool: new Set(["json", "no-color"]),
  });
  const repoRoot = process.cwd();
  const config = await loadConfig(repoRoot, process.env);
  const manifestPath =
    typeof flags["manifest"] === "string" ? resolve(repoRoot, flags["manifest"]) : config.manifest;
  const roadmapDir = resolve(repoRoot, config.roadmapDir);

  const follow = typeof flags["follow"] === "string" ? flags["follow"] : undefined;
  if (follow) {
    const child = runFollow({
      repoRoot,
      id: follow,
      ...(flags["no-color"] === true ? { noColor: true } : {}),
    });
    return await new Promise<number>((resolveExit) => {
      child.on("close", (code) => resolveExit(code ?? 0));
      const stop = (): void => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  }

  const json = flags["json"] === true;
  const noColor = flags["no-color"] === true;

  if (flags["watch"] !== undefined) {
    const secs = typeof flags["watch"] === "string" ? Number(flags["watch"]) : 5;
    const ac = new AbortController();
    const stop = (): void => ac.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    runWatch({
      repoRoot,
      manifestPath,
      roadmapDir,
      ...(json ? { json: true } : {}),
      ...(noColor ? { noColor: true } : {}),
      watchSecs: Number.isFinite(secs) && secs > 0 ? secs : 5,
      signal: ac.signal,
    });
    await new Promise<void>((resolveDone) => {
      ac.signal.addEventListener("abort", () => resolveDone(), { once: true });
    });
    return 0;
  }

  runOnce({
    repoRoot,
    manifestPath,
    roadmapDir,
    ...(json ? { json: true } : {}),
    ...(noColor ? { noColor: true } : {}),
  });
  return 0;
}

// ── web ────────────────────────────────────────────────────────────────────

async function cmdWeb(args: readonly string[]): Promise<number> {
  const { flags } = parseFlags(args, { bool: new Set() });
  const repoRoot = process.cwd();
  const config = await loadConfig(repoRoot, process.env);
  const manifestPath =
    typeof flags["manifest"] === "string" ? resolve(repoRoot, flags["manifest"]) : config.manifest;
  const roadmapDir = resolve(repoRoot, config.roadmapDir);
  const port = Number(
    flags["port"] ?? process.env["CLAUDOPILOT_WEB_PORT"] ?? process.env["PORT"] ?? 4317,
  );
  const host =
    typeof flags["host"] === "string"
      ? flags["host"]
      : process.env["CLAUDOPILOT_WEB_HOST"] ?? "127.0.0.1";
  const webDir = join(PKG_ROOT, "web");

  const running = await startDashboardServer({
    repoRoot,
    manifestPath,
    roadmapDir,
    webDir,
    port,
    host,
  });
  const addr = running.address();
  writeOut(`[claudopilot web] http://${addr.host}:${addr.port}`);

  const stop = async (): Promise<void> => {
    try {
      await running.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await new Promise<void>(() => {
    /* keep-alive; signal handler exits */
  });
  return 0;
}

// ── run ────────────────────────────────────────────────────────────────────

async function cmdRun(args: readonly string[]): Promise<number> {
  const shell = args.includes("--shell");
  // `--isolated` used to select the host orchestrator over the in-container
  // bash loop. The bash loop is gone — the host orchestrator is the only
  // engine now — so the flag is accepted but a no-op.

  const repoRoot = process.cwd();
  const home = process.env["HOME"] ?? "";
  if (!home) die("HOME is not set");

  const opts: RunInDockerOptions = {
    repoRoot,
    home,
    hostUid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostGid: typeof process.getgid === "function" ? process.getgid() : 0,
    // The worker image bakes the engine in, so it's built from the package
    // root (where dist/ + Dockerfile live), not the target repo.
    context: PKG_ROOT,
    dockerfile: join(PKG_ROOT, process.env["CLAUDOPILOT_DOCKERFILE"] ?? "Dockerfile"),
    ...(process.env["ANTHROPIC_API_KEY"]
      ? { anthropicApiKey: process.env["ANTHROPIC_API_KEY"] }
      : {}),
    ...(process.env["CLAUDOPILOT_IMAGE_TAG"]
      ? { imageTag: process.env["CLAUDOPILOT_IMAGE_TAG"] }
      : {}),
    ...(process.env["CLAUDOPILOT_WEB"] === "0" ? { web: false } : {}),
    ...(process.env["CLAUDOPILOT_WEB_PORT"]
      ? { webPort: Number(process.env["CLAUDOPILOT_WEB_PORT"]) }
      : {}),
  };

  const docker = new Docker();
  // CLAUDOPILOT_SKIP_BUILD=1 lets CI / smoke tests pre-bake the worker image
  // (e.g. with a stub `claude`) and reuse it without the engine overwriting
  // that tag from the canonical Dockerfile.
  if (process.env["CLAUDOPILOT_SKIP_BUILD"] !== "1") {
    const buildR = await docker.build(buildSpec(opts));
    if (buildR.code !== 0) {
      writeErr(buildR.stderr || "docker build failed");
      return buildR.code ?? 1;
    }
  }

  // `--shell`: drop into a bash shell inside the image (debugging the toolchain).
  if (shell) {
    const launchPlan = await planShell(opts);
    if ("ok" in launchPlan && launchPlan.ok === false) {
      writeErr(launchPlan.error);
      return 1;
    }
    const plan = launchPlan as Exclude<typeof launchPlan, { ok: false }>;
    for (const line of plan.diagnostics) writeOut(line);
    const r = await docker.runContainer(plan.run);
    return r.code ?? 1;
  }

  // Default run: the host orchestrator drives the loop, launching one
  // disposable worker container per phase (each a clone + `claudopilot __worker`).
  const isoPlan = planIsolated(opts);
  if ("ok" in isoPlan && isoPlan.ok === false) {
    writeErr(isoPlan.error);
    return 1;
  }
  const plan = isoPlan as Exclude<typeof isoPlan, { ok: false }>;
  for (const line of plan.diagnostics) writeOut(line);
  // Forward env overlay so loadConfig + the orchestrator pick it up.
  for (const [k, v] of Object.entries(plan.envOverlay)) process.env[k] = v;
  const config = await loadConfig(repoRoot, process.env);
  // Start host-side dashboard if requested.
  if (plan.startHostWeb) {
    const running = await startDashboardServer({
      repoRoot,
      manifestPath: config.manifest,
      roadmapDir: resolve(repoRoot, config.roadmapDir),
      webDir: join(PKG_ROOT, "web"),
      port: opts.webPort ?? 4317,
    });
    const addr = running.address();
    writeOut(`[claudopilot web] http://${addr.host}:${addr.port}`);
  }
  const git = new Git({ cwd: repoRoot });
  const baseBranch = (await git.currentBranch()) ?? "main";
  const workerPrompt = await fsp.readFile(config.promptFile, "utf8");
  const supervisorPrompt = await fsp.readFile(config.supervisorPromptFile, "utf8");
  const code = await runDriver(
    { git, docker: dockerLike(docker), log: writeOut },
    { config, baseBranch, workerPrompt, supervisorPrompt },
  );
  return code;
}

// ── DockerLike adapter ─────────────────────────────────────────────────────
//
// Bridge the concrete `Docker` wrapper (RunSpec shape) to the orchestrator's
// minimal `DockerLike` (DockerRunOpts shape). Phase-07 is the seam — the
// orchestrator does not import `src/runner/*` directly.
function dockerLike(d: Docker): DockerLike {
  return {
    async run(opts: DockerRunOpts): Promise<DockerRunResult> {
      const mounts: Mount[] = opts.mounts.map((m) => ({
        source: m.host,
        target: m.container,
        ...(m.readOnly ? { readonly: true } : {}),
      }));
      const env: RunSpec["env"] = [];
      for (const [k, v] of Object.entries(opts.env)) {
        if (typeof v === "string") env.push({ key: k, value: v });
      }
      const spec: RunSpec = {
        image: opts.image,
        name: opts.name,
        rm: opts.rm ?? true,
        ...(opts.init ? { init: true } : {}),
        ...(opts.ipc ? { ipc: opts.ipc } : {}),
        ...(opts.shmSize ? { shmSize: opts.shmSize } : {}),
        mounts,
        env,
        cmd: [...opts.cmd],
      };
      const r = await d.runContainer(spec);
      return { code: r.code, signal: r.signal };
    },
    async rmForce(name: string): Promise<void> {
      await d.rmForce(name);
    },
  };
}

// ── help / version ─────────────────────────────────────────────────────────

function helpText(): string {
  const p = pkg();
  return `claudopilot v${p.version} — autonomous execution loop for Claude Code

Usage:
  claudopilot init [--with-examples] [--force]
                                          Scaffold this repo (vendor engine + config stubs).
                                          Never overwrites your project files; --with-examples
                                          adds a sample roadmap; --force re-vendors the engine.
  claudopilot run [--isolated|--shell]    Build the image and run the loop
  claudopilot progress [args…]            Read-only progress view of a run
  claudopilot web [--port N] [--host H]   Local web dashboard
  claudopilot --version | --help

Docs: ${p.homepage ?? ""}`;
}

// ── entrypoint ─────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init":
      return cmdInit(rest);
    case "run":
      return await cmdRun(rest);
    case "progress":
      return await cmdProgress(rest);
    case "web":
      return await cmdWeb(rest);
    case "__worker":
      // Hidden, internal: the in-container per-phase entrypoint. The
      // orchestrator launches `claudopilot __worker` inside each isolated
      // worker container; it reads its inputs from the forwarded env
      // (CLAUDOPILOT_PHASE, WORKTREE_PREPARE_CMD, SUPERVISOR_MODE,
      // CLAUDOPILOT_RESUME_SID, AGENT_DRIVER, AGENT_MODEL).
      return await mainEntry(makeCaptureRunner(process.env), process.env);
    case "-v":
    case "--version":
      writeOut(pkg().version);
      return 0;
    case undefined:
    case "-h":
    case "--help":
      writeOut(helpText());
      return 0;
    default:
      writeErr(`claudopilot: unknown command: ${cmd}\n\n${helpText()}`);
      return 1;
  }
}

// Detect "invoked directly" — handles both `node dist/cli.js` and a shebang exec.
const invokedDirectly = ((): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  const here = fileURLToPath(import.meta.url);
  return entry === here;
})();
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      writeErr(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
