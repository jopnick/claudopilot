import { describe, it, expect } from "vitest";
import {
  buildSpec,
  resolveAuth,
  resolveHostMounts,
  defaultRunEnv,
  planShell,
  planIsolated,
  shellCmd,
  GIT_SSH_COMMAND,
  type FsProbe,
  type NetProbe,
  type RunInDockerOptions,
} from "./runInDocker.js";
import { buildArgs } from "../docker.js";

// ── helpers ─────────────────────────────────────────────────────────────

function mkFs(present: Set<string>, dirs: Set<string>): FsProbe {
  return {
    dirExists: (p) => dirs.has(p),
    fileExists: (p) => present.has(p),
  };
}

function freePort(): NetProbe {
  return { portInUse: async () => false };
}

const baseOpts: Omit<RunInDockerOptions, "fs" | "net"> = {
  repoRoot: "/home/eric/repo",
  home: "/home/eric",
  hostUid: 1000,
  hostGid: 1000,
  imageTag: "claudopilot-runner",
  dockerfile: "claudopilot/Dockerfile",
  platform: "linux",
};

// ── buildSpec ──────────────────────────────────────────────────────────

describe("buildSpec", () => {
  it("matches `docker build -t … -f … --build-arg HOST_UID=… HOST_GID=… .`", () => {
    const spec = buildSpec({
      ...baseOpts,
      fs: mkFs(new Set(), new Set()),
      net: freePort(),
    });
    expect(buildArgs(spec)).toEqual([
      "build",
      "-t",
      "claudopilot-runner",
      "-f",
      "claudopilot/Dockerfile",
      "--build-arg",
      "HOST_UID=1000",
      "--build-arg",
      "HOST_GID=1000",
      ".",
    ]);
  });

  it("honours an explicit build context (the engine passes the package root)", () => {
    const spec = buildSpec({
      ...baseOpts,
      dockerfile: "/pkg/Dockerfile",
      context: "/pkg",
      fs: mkFs(new Set(), new Set()),
      net: freePort(),
    });
    expect(buildArgs(spec)).toEqual([
      "build",
      "-t",
      "claudopilot-runner",
      "-f",
      "/pkg/Dockerfile",
      "--build-arg",
      "HOST_UID=1000",
      "--build-arg",
      "HOST_GID=1000",
      "/pkg",
    ]);
  });
});

// ── resolveAuth ────────────────────────────────────────────────────────

describe("resolveAuth — token mode", () => {
  it("with both ~/.claude and ~/.claude.json present, mounts both", () => {
    const r = resolveAuth({
      ...baseOpts,
      anthropicApiKey: "sk-ant-x",
      fs: mkFs(
        new Set(["/home/eric/.claude.json"]),
        new Set(["/home/eric/.claude"]),
      ),
      net: freePort(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.decision.kind).toBe("token");
    expect(r.decision.mounts).toEqual([
      { source: "/home/eric/.claude", target: "/home/runner/.claude" },
      { source: "/home/eric/.claude.json", target: "/home/runner/.claude.json" },
    ]);
  });

  it("with no ~/.claude artifacts, succeeds with zero mounts", () => {
    const r = resolveAuth({
      ...baseOpts,
      anthropicApiKey: "sk-ant-x",
      fs: mkFs(new Set(), new Set()),
      net: freePort(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.decision.mounts).toEqual([]);
  });
});

describe("resolveAuth — interactive mode", () => {
  it("requires both ~/.claude and ~/.claude.json", () => {
    const r = resolveAuth({
      ...baseOpts,
      fs: mkFs(
        new Set(["/home/eric/.claude.json"]),
        new Set(["/home/eric/.claude"]),
      ),
      net: freePort(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.decision.kind).toBe("interactive");
    expect(r.decision.mounts).toEqual([
      { source: "/home/eric/.claude", target: "/home/runner/.claude" },
      { source: "/home/eric/.claude.json", target: "/home/runner/.claude.json" },
    ]);
  });

  it("errors when neither token nor interactive login is available", () => {
    const r = resolveAuth({
      ...baseOpts,
      fs: mkFs(new Set(), new Set()),
      net: freePort(),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("no ANTHROPIC_API_KEY set");
  });

  it("errors when only ~/.claude is present without the JSON", () => {
    const r = resolveAuth({
      ...baseOpts,
      fs: mkFs(new Set(), new Set(["/home/eric/.claude"])),
      net: freePort(),
    });
    expect(r.ok).toBe(false);
  });
});

// ── resolveHostMounts ──────────────────────────────────────────────────

describe("resolveHostMounts", () => {
  it("emits gitconfig + ssh + gh in stable order, with :ro on the read-only ones", () => {
    const m = resolveHostMounts({
      ...baseOpts,
      fs: mkFs(
        new Set(["/home/eric/.gitconfig"]),
        new Set(["/home/eric/.ssh", "/home/eric/.config/gh"]),
      ),
      net: freePort(),
    });
    expect(m).toEqual([
      {
        source: "/home/eric/.gitconfig",
        target: "/home/runner/.gitconfig",
        readonly: true,
      },
      {
        source: "/home/eric/.ssh",
        target: "/home/runner/.ssh",
        readonly: true,
      },
      { source: "/home/eric/.config/gh", target: "/home/runner/.config/gh" },
    ]);
  });

  it("skips entries that don't exist on the host", () => {
    const m = resolveHostMounts({
      ...baseOpts,
      fs: mkFs(new Set(), new Set()),
      net: freePort(),
    });
    expect(m).toEqual([]);
  });
});

// ── shellCmd ───────────────────────────────────────────────────────────

describe("shellCmd", () => {
  it("is just bash", () => {
    expect(shellCmd()).toEqual(["bash"]);
  });
});

// ── defaultRunEnv (matches the bash -e list verbatim) ──────────────────

describe("defaultRunEnv", () => {
  it("forwards the same env list as run-in-docker.sh", () => {
    expect(defaultRunEnv()).toEqual([
      "ANTHROPIC_API_KEY",
      "IGNORE_LOOP_CHECKPOINTS",
      "MAX_TICKS_PER_WINDOW",
      "USAGE_THRESHOLD_PCT",
      { key: "GIT_SSH_COMMAND", value: GIT_SSH_COMMAND },
    ]);
  });
});

// ── planShell ──────────────────────────────────────────────────────────

describe("planShell", () => {
  it("never publishes the dashboard and cmd is bash (no -c)", async () => {
    const plan = await planShell({
      ...baseOpts,
      anthropicApiKey: "sk-ant-x",
      fs: mkFs(new Set(), new Set()),
      net: freePort(),
    });
    if ("error" in plan) throw new Error("unexpected");
    expect(plan.webPublished).toBe(false);
    expect(plan.webSkipReason).toBe("shell mode");
    expect(plan.run.publish).toBeUndefined();
    expect(plan.run.cmd).toEqual(["bash"]);
  });

  it("propagates an auth error", async () => {
    const plan = await planShell({
      ...baseOpts,
      fs: mkFs(new Set(), new Set()),
      net: freePort(),
    });
    expect("error" in plan).toBe(true);
  });
});

// ── planIsolated ───────────────────────────────────────────────────────

describe("planIsolated", () => {
  it("errors when no auth available", () => {
    const r = planIsolated({
      ...baseOpts,
      fs: mkFs(new Set(), new Set()),
      net: freePort(),
    });
    expect("error" in r).toBe(true);
  });

  it("emits env overlay + dashboard signal when auth is present", () => {
    const r = planIsolated({
      ...baseOpts,
      anthropicApiKey: "sk-ant-x",
      fs: mkFs(new Set(), new Set()),
      net: freePort(),
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.envOverlay).toEqual({
      CLAUDOPILOT_ISOLATED: "1",
      WORKER_IMAGE: "claudopilot-runner",
      REPO_ROOT: "/home/eric/repo",
    });
    expect(r.startHostWeb).toBe(true);
  });

  it("accepts interactive-login mode (only ~/.claude present)", () => {
    const r = planIsolated({
      ...baseOpts,
      fs: mkFs(new Set(), new Set(["/home/eric/.claude"])),
      net: freePort(),
    });
    expect("error" in r).toBe(false);
  });
});
