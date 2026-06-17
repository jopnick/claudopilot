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
 *   init [--force]                 Scaffold a repo (vendor engine + project stubs).
 *   run  [--isolated|--shell]      Build the image and start the loop.
 *   progress [--json|--watch [N]|--follow <id>|--no-color|--manifest <p>]
 *   web [--port N] [--host H] [--manifest <p>]
 *   --version | --help
 */

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
  planDefault,
  planShell,
  planIsolated,
  type RunInDockerOptions,
} from "./runner/runInDocker.js";
import { runDriver } from "./orchestrator/index.js";
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
const ENGINE_FILES = [
  "run-loop.sh",
  "worker-entry.sh",
  "render-stream.mjs",
  "render-stream-opencode.mjs",
  "web-server.mjs",
  "web/index.html",
  "web/app.mjs",
  "web/transcript.mjs",
  "web/styles.css",
  "web/vendor/lit-html.js",
  "Dockerfile",
  "prompts/worker.md",
  "prompts/supervisor.md",
];

const PROJECT_FILES: Array<[string, string]> = [
  ["templates/claudopilot.config.sh", "claudopilot.config.sh"],
  ["templates/EXECUTION-MANIFEST.md", "roadmap/EXECUTION-MANIFEST.md"],
  ["templates/phase-01-example.md", "roadmap/phase-01-example.md"],
  ["templates/worker.project.md", "claudopilot/prompts/worker.project.md"],
];

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
  const cwd = process.cwd();
  writeOut(`Scaffolding claudopilot into ${cwd}`);

  writeOut("\nEngine (vendored into ./claudopilot/):");
  for (const rel of ENGINE_FILES) {
    copyFile(join(PKG_ROOT, rel), join(cwd, "claudopilot", rel), force);
  }

  writeOut("\nProject files (yours to edit):");
  for (const [tpl, dest] of PROJECT_FILES) {
    copyFile(join(PKG_ROOT, tpl), join(cwd, dest), force);
  }

  writeOut(
    [
      "\nDone. Next steps:",
      "  1. Edit claudopilot.config.sh   — set GATE_CMD and build/bootstrap commands.",
      "  2. Edit claudopilot/prompts/worker.project.md — your project's cornerstones.",
      "  3. Fill in roadmap/EXECUTION-MANIFEST.md + per-phase docs.",
      "  4. Commit, then: claudopilot run   (add --isolated for per-phase containers).",
    ].join("\n"),
  );
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
  const isolated = args.includes("--isolated");
  const shell = args.includes("--shell");
  if (isolated && shell) die("--isolated and --shell are mutually exclusive");

  const repoRoot = process.cwd();
  const home = process.env["HOME"] ?? "";
  if (!home) die("HOME is not set");

  const opts: RunInDockerOptions = {
    repoRoot,
    home,
    hostUid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostGid: typeof process.getgid === "function" ? process.getgid() : 0,
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
  // CLAUDOPILOT_SKIP_BUILD=1 lets CI / parity smokes pre-bake the worker
  // image (e.g. with a stub `claude`) and reuse it without the engine
  // overwriting that tag from the canonical Dockerfile.
  if (process.env["CLAUDOPILOT_SKIP_BUILD"] !== "1") {
    const buildR = await docker.build(buildSpec(opts));
    if (buildR.code !== 0) {
      writeErr(buildR.stderr || "docker build failed");
      return buildR.code ?? 1;
    }
  }

  if (isolated) {
    const isoPlan = planIsolated(opts);
    if ("ok" in isoPlan && isoPlan.ok === false) {
      writeErr(isoPlan.error);
      return 1;
    }
    const plan = isoPlan as Exclude<typeof isoPlan, { ok: false }>;
    for (const line of plan.diagnostics) writeOut(line);
    // Start host-side dashboard if requested.
    if (plan.startHostWeb) {
      const config = await loadConfig(repoRoot, process.env);
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
    // Forward env overlay so child sub-systems pick it up.
    for (const [k, v] of Object.entries(plan.envOverlay)) process.env[k] = v;
    const config = await loadConfig(repoRoot, process.env);
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

  const launchPlan = await (shell ? planShell(opts) : planDefault(opts));
  if ("ok" in launchPlan && launchPlan.ok === false) {
    writeErr(launchPlan.error);
    return 1;
  }
  const plan = launchPlan as Exclude<typeof launchPlan, { ok: false }>;
  for (const line of plan.diagnostics) writeOut(line);
  const r = await docker.runContainer(plan.run);
  return r.code ?? 1;
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
  claudopilot init [--force]              Scaffold this repo (vendor engine + config stubs)
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
