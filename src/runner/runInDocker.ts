/**
 * Port of `run-in-docker.sh` — the host-side launcher that builds the runner
 * image, resolves auth + mounts, and starts the loop in one of three modes:
 *
 *   - **default** — bind-mount the repo at `/work`, publish the dashboard port
 *     (loopback), forward Claude/git/ssh/gh config, run the loop inside the
 *     container.
 *   - **--isolated** — orchestrator runs on the HOST (phase-06's driver); we
 *     just ensure the image exists, start the host-side dashboard, and hand
 *     the prepared env back to the caller. Per-phase containers are spawned
 *     later via `Docker.runContainer` with the spec built here for the worker.
 *   - **--shell** — drop into a shell inside the container.
 *
 * The module is split into pure spec builders (the test surface) and a thin
 * imperative layer that calls `Docker`. Tests assert that the assembled argv
 * matches the bash invocation byte-for-byte (modulo path normalization).
 */

import * as path from "node:path";
import * as net from "node:net";
import { statSync } from "node:fs";
import {
  type Docker,
  type DockerResult,
  type Mount,
  type BuildSpec,
  type RunSpec,
} from "../docker.js";

// ── env probes (injected so tests can stub) ──────────────────────────────

export interface FsProbe {
  dirExists(p: string): boolean;
  fileExists(p: string): boolean;
}

export interface NetProbe {
  portInUse(port: number, host?: string): Promise<boolean>;
}

export const defaultFsProbe: FsProbe = {
  dirExists(p) {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  fileExists(p) {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
};

export const defaultNetProbe: NetProbe = {
  portInUse(port, host = "127.0.0.1") {
    return new Promise((resolve) => {
      const s = new net.Socket();
      let done = false;
      const finish = (val: boolean) => {
        if (done) return;
        done = true;
        try {
          s.destroy();
        } catch {
          /* noop */
        }
        resolve(val);
      };
      s.setTimeout(150);
      s.once("connect", () => finish(true));
      s.once("timeout", () => finish(false));
      s.once("error", () => finish(false));
      s.connect(port, host);
    });
  },
};

// ── options ─────────────────────────────────────────────────────────────

export interface RunInDockerOptions {
  /** Repo root (host path). Mounted at /work in default mode. */
  repoRoot: string;
  /** Host $HOME — used to locate ~/.claude, ~/.gitconfig, ~/.ssh, ~/.config/gh. */
  home: string;
  /** Image tag. Default "claudopilot-runner" (CLAUDOPILOT_IMAGE_TAG). */
  imageTag?: string;
  /** Dockerfile path. Default "Dockerfile" (resolved against `context`). */
  dockerfile?: string;
  /** Docker build context. Default ".". The engine passes the package root. */
  context?: string;
  hostUid: number;
  hostGid: number;
  /** ANTHROPIC_API_KEY. Empty/undefined → interactive-login mode required. */
  anthropicApiKey?: string;
  /** CLAUDOPILOT_WEB. Default true. */
  web?: boolean;
  /** CLAUDOPILOT_WEB_PORT. Default 4317. */
  webPort?: number;
  /** Host platform (test seam). */
  platform?: NodeJS.Platform;
  /** Filesystem probe — `dirExists`/`fileExists`. */
  fs?: FsProbe;
  /** Network probe — `portInUse`. */
  net?: NetProbe;
}

// ── resolved values ─────────────────────────────────────────────────────

export type Mode = "default" | "isolated" | "shell";

export interface AuthDecision {
  /** token = ANTHROPIC_API_KEY is the source of truth. interactive = ~/.claude. */
  kind: "token" | "interactive";
  mounts: Mount[];
  /** Diagnostic line (matches the bash "[run-in-docker] Auth: ..." log). */
  message: string;
}

export type AuthResult =
  | { ok: true; decision: AuthDecision }
  | { ok: false; error: string };

export interface LaunchPlan {
  build: BuildSpec;
  run: RunSpec;
  /** True iff the dashboard port was published into the run. */
  webPublished: boolean;
  /** Set when the dashboard was requested but disabled (port busy, --shell, etc.). */
  webSkipReason?: string;
  /** Diagnostic lines (auth, dashboard, …) for the caller to surface. */
  diagnostics: string[];
}

export interface IsolatedPlan {
  build: BuildSpec;
  /** Env overlay the host-side driver should be launched with. */
  envOverlay: Record<string, string>;
  /** True iff the host dashboard should be started by the caller. */
  startHostWeb: boolean;
  diagnostics: string[];
}

// ── build spec ──────────────────────────────────────────────────────────

export function buildSpec(opts: RunInDockerOptions): BuildSpec {
  return {
    tag: opts.imageTag ?? "claudopilot-runner",
    // Both default to the engine package: the image bakes the bundled CLI in
    // (see Dockerfile `COPY dist/`), so the build context is the package root,
    // not the target repo. The repo arrives at runtime via the /work mount.
    dockerfile: opts.dockerfile ?? "Dockerfile",
    context: opts.context ?? ".",
    buildArgs: {
      HOST_UID: String(opts.hostUid),
      HOST_GID: String(opts.hostGid),
    },
  };
}

// ── auth resolution (matches CLAUDE_MOUNT block in run-in-docker.sh) ────

export function resolveAuth(opts: RunInDockerOptions): AuthResult {
  const fs = opts.fs ?? defaultFsProbe;
  const claudeDir = path.join(opts.home, ".claude");
  const claudeJson = path.join(opts.home, ".claude.json");

  if (opts.anthropicApiKey && opts.anthropicApiKey.length > 0) {
    const mounts: Mount[] = [];
    if (fs.dirExists(claudeDir)) {
      mounts.push({ source: claudeDir, target: "/home/runner/.claude" });
    }
    if (fs.fileExists(claudeJson)) {
      mounts.push({
        source: claudeJson,
        target: "/home/runner/.claude.json",
      });
    }
    return {
      ok: true,
      decision: {
        kind: "token",
        mounts,
        message:
          "[run-in-docker] Auth: ANTHROPIC_API_KEY (forwarded into the container).",
      },
    };
  }

  if (!fs.dirExists(claudeDir) || !fs.fileExists(claudeJson)) {
    return {
      ok: false,
      error:
        "[run-in-docker] ERROR: no ANTHROPIC_API_KEY set and no interactive login found.\n" +
        "[run-in-docker] Either: export ANTHROPIC_API_KEY=sk-ant-... and re-run,\n" +
        "[run-in-docker]   or run `claude` once on the host to create ~/.claude + ~/.claude.json.",
    };
  }
  return {
    ok: true,
    decision: {
      kind: "interactive",
      mounts: [
        { source: claudeDir, target: "/home/runner/.claude" },
        { source: claudeJson, target: "/home/runner/.claude.json" },
      ],
      message: "[run-in-docker] Auth: mounted interactive login (~/.claude).",
    },
  };
}

// ── host-config mounts (gh, ssh, gitconfig) ─────────────────────────────

export function resolveHostMounts(opts: RunInDockerOptions): Mount[] {
  const fs = opts.fs ?? defaultFsProbe;
  const mounts: Mount[] = [];

  const gitconfig = path.join(opts.home, ".gitconfig");
  if (fs.fileExists(gitconfig)) {
    mounts.push({
      source: gitconfig,
      target: "/home/runner/.gitconfig",
      readonly: true,
    });
  }

  const ssh = path.join(opts.home, ".ssh");
  if (fs.dirExists(ssh)) {
    mounts.push({
      source: ssh,
      target: "/home/runner/.ssh",
      readonly: true,
    });
  }

  const gh = path.join(opts.home, ".config", "gh");
  if (fs.dirExists(gh)) {
    mounts.push({ source: gh, target: "/home/runner/.config/gh" });
  }
  return mounts;
}

// ── env forwarding for the default-mode run ─────────────────────────────

/** GIT_SSH_COMMAND value forwarded by run-in-docker.sh into the container. */
export const GIT_SSH_COMMAND =
  "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes";

export function defaultRunEnv(): RunSpec["env"] {
  return [
    "ANTHROPIC_API_KEY",
    "IGNORE_LOOP_CHECKPOINTS",
    "MAX_TICKS_PER_WINDOW",
    "USAGE_THRESHOLD_PCT",
    { key: "GIT_SSH_COMMAND", value: GIT_SSH_COMMAND },
  ];
}

export function shellCmd(): string[] {
  return ["bash"];
}

// ── plan shell / isolated ───────────────────────────────────────────────

/**
 * `--shell`: drop into an interactive bash shell inside the runner image with
 * the repo bind-mounted at /work — for poking at the toolchain/environment.
 * The autonomous loop itself runs via {@link planIsolated} + the host driver;
 * shell mode never publishes the dashboard.
 */
export async function planShell(
  opts: RunInDockerOptions,
): Promise<LaunchPlan | { ok: false; error: string }> {
  const auth = resolveAuth(opts);
  if (!auth.ok) return { ok: false, error: auth.error };

  const diagnostics: string[] = [auth.decision.message];
  const tag = opts.imageTag ?? "claudopilot-runner";

  const mounts: Mount[] = [
    { source: opts.repoRoot, target: "/work" },
    ...auth.decision.mounts,
    ...resolveHostMounts(opts),
  ];

  const run: RunSpec = {
    image: tag,
    name: tag,
    rm: true,
    init: true,
    interactive: true,
    tty: true,
    ipc: "host",
    shmSize: "2g",
    mounts,
    env: defaultRunEnv(),
    cmd: shellCmd(),
  };

  return {
    build: buildSpec(opts),
    run,
    webPublished: false,
    webSkipReason: "shell mode",
    diagnostics,
  };
}

export function planIsolated(
  opts: RunInDockerOptions,
): IsolatedPlan | { ok: false; error: string } {
  const fs = opts.fs ?? defaultFsProbe;
  const hasKey = !!(opts.anthropicApiKey && opts.anthropicApiKey.length > 0);
  const hasClaudeDir = fs.dirExists(path.join(opts.home, ".claude"));
  if (!hasKey && !hasClaudeDir) {
    return {
      ok: false,
      error:
        "[run-in-docker] ERROR: isolated mode needs Claude auth for the worker containers.\n" +
        "[run-in-docker]   export ANTHROPIC_API_KEY=sk-ant-... or run `claude` once to create ~/.claude.",
    };
  }
  const tag = opts.imageTag ?? "claudopilot-runner";
  const webEnabled = opts.web ?? true;
  return {
    build: buildSpec(opts),
    envOverlay: {
      CLAUDOPILOT_ISOLATED: "1",
      WORKER_IMAGE: tag,
      REPO_ROOT: opts.repoRoot,
    },
    startHostWeb: webEnabled,
    diagnostics: [
      "[run-in-docker] Isolated mode: orchestrator on the host; agents in per-phase containers.",
      "[run-in-docker]   Each agent gets a disposable clone + Claude auth, NO git push creds; the host pushes.",
    ],
  };
}

// ── imperative layer ────────────────────────────────────────────────────

export async function buildImage(
  docker: Docker,
  opts: RunInDockerOptions,
): Promise<DockerResult> {
  return docker.build(buildSpec(opts));
}

export async function rmWorker(
  docker: Docker,
  phaseId: string,
): Promise<DockerResult> {
  return docker.rmForce(`cp-w-${phaseId}`);
}
