#!/usr/bin/env node
//
// claudopilot — CLI entrypoint.
//
// Subcommands:
//   init [--force]            Scaffold the current repo: vendor the engine into
//                             ./claudopilot/ and create project-owned config +
//                             roadmap stubs. --force overwrites existing files.
//   run  [--isolated|--shell] Run the loop via ./claudopilot/run-in-docker.sh.
//   progress [args…]          Read-only progress view (./claudopilot/progress.sh).
//   --version | --help
//
// The engine assumes it lives at <repo>/claudopilot/ (run-in-docker.sh bind-mounts
// the repo at /work and runs `bash claudopilot/run-loop.sh`). So `init` vendors the
// engine into that directory rather than running it from node_modules.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

// Engine files vendored into the target repo's ./claudopilot/ on `init`.
// Paths are relative to both PKG_ROOT (source) and ./claudopilot/ (dest).
const ENGINE_FILES = [
  "run-loop.sh",
  "run-in-docker.sh",
  "worker-entry.sh",
  "render-stream.mjs",
  "render-stream-opencode.mjs",
  "progress.mjs",
  "progress.sh",
  "web-server.mjs",
  "web/events.mjs",
  "web/index.html",
  "web/app.mjs",
  "web/transcript.mjs",
  "web/styles.css",
  "web/vendor/lit-html.js",
  "Dockerfile",
  "prompts/worker.md",
  "prompts/supervisor.md",
];

// Project-owned scaffolding: [templateRelPath, destRelPathFromCwd].
const PROJECT_FILES = [
  ["templates/claudopilot.config.sh", "claudopilot.config.sh"],
  ["templates/EXECUTION-MANIFEST.md", "roadmap/EXECUTION-MANIFEST.md"],
  ["templates/phase-01-example.md", "roadmap/phase-01-example.md"],
  ["templates/worker.project.md", "claudopilot/prompts/worker.project.md"],
];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}
function die(msg, code = 1) {
  process.stderr.write(`claudopilot: ${msg}\n`);
  process.exit(code);
}

function copyFile(src, dest, force) {
  if (existsSync(dest) && !force) {
    log(`  skip   ${dest} (exists; --force to overwrite)`);
    return false;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  log(`  write  ${dest}`);
  return true;
}

function cmdInit(args) {
  const force = args.includes("--force");
  const cwd = process.cwd();
  log(`Scaffolding claudopilot into ${cwd}`);

  log("\nEngine (vendored into ./claudopilot/):");
  for (const rel of ENGINE_FILES) {
    copyFile(join(PKG_ROOT, rel), join(cwd, "claudopilot", rel), force);
  }

  log("\nProject files (yours to edit):");
  for (const [tpl, dest] of PROJECT_FILES) {
    copyFile(join(PKG_ROOT, tpl), join(cwd, dest), force);
  }

  log(
    [
      "\nDone. Next steps:",
      "  1. Edit claudopilot.config.sh   — set GATE_CMD and build/bootstrap commands.",
      "  2. Edit claudopilot/prompts/worker.project.md — your project's cornerstones.",
      "  3. Fill in roadmap/EXECUTION-MANIFEST.md + per-phase docs.",
      "  4. Commit, then: claudopilot run   (add --isolated for per-phase containers).",
    ].join("\n"),
  );
}

// Locate a vendored engine script in ./claudopilot/, or exit with guidance.
function requireVendored(relScript) {
  const p = join(process.cwd(), "claudopilot", relScript);
  if (!existsSync(p)) {
    die(
      `./claudopilot/${relScript} not found. Run \`claudopilot init\` first ` +
        `(from your repo root).`,
    );
  }
  return p;
}

function execInherit(command, commandArgs) {
  const r = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (r.error) die(r.error.message);
  process.exit(r.status ?? 1);
}

function cmdRun(args) {
  execInherit("bash", [requireVendored("run-in-docker.sh"), ...args]);
}

function cmdProgress(args) {
  execInherit("bash", [requireVendored("progress.sh"), ...args]);
}

function cmdWeb(args) {
  execInherit(process.execPath, [requireVendored("web-server.mjs"), ...args]);
}

const HELP = `claudopilot v${pkg.version} — autonomous execution loop for Claude Code

Usage:
  claudopilot init [--force]          Scaffold this repo (vendor engine + config stubs)
  claudopilot run [--isolated|--shell]  Build the image and run the loop
  claudopilot progress [args…]        Read-only progress view of a run
  claudopilot web [--port N]          Local web dashboard (agents + thought streams)
  claudopilot --version | --help

Docs: ${pkg.homepage}`;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      return cmdInit(rest);
    case "run":
      return cmdRun(rest);
    case "progress":
      return cmdProgress(rest);
    case "web":
      return cmdWeb(rest);
    case "-v":
    case "--version":
      return log(pkg.version);
    case undefined:
    case "-h":
    case "--help":
      return log(HELP);
    default:
      die(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main();
