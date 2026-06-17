import { describe, it, expect } from "vitest";
import {
  buildSpec,
  resolveAuth,
  resolveHostMounts,
  composeLoopCmd,
  defaultRunEnv,
  planDefault,
  planShell,
  planIsolated,
  workerRunSpec,
  shellCmd,
  GIT_SSH_COMMAND,
  type FsProbe,
  type NetProbe,
  type RunInDockerOptions,
} from "./runInDocker.js";
import { buildArgs, runArgs } from "../docker.js";

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

function busyPort(): NetProbe {
  return { portInUse: async () => true };
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

// ── composeLoopCmd / shellCmd ──────────────────────────────────────────

describe("composeLoopCmd", () => {
  it("includes the web-server background bg-launch when published", () => {
    expect(composeLoopCmd({ webPublished: true, webPort: 4317 })).toEqual([
      "bash",
      "-c",
      "cd /work && (CLAUDOPILOT_WEB_HOST=0.0.0.0 node claudopilot/web-server.mjs --port 4317 >/tmp/claudopilot-web.log 2>&1 &) ; bash claudopilot/run-loop.sh",
    ]);
  });
  it("omits the web-server launch when not published", () => {
    expect(composeLoopCmd({ webPublished: false, webPort: 4317 })).toEqual([
      "bash",
      "-c",
      "cd /work && bash claudopilot/run-loop.sh",
    ]);
  });
});

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

// ── planDefault — full argv equivalence with the bash invocation ───────

describe("planDefault", () => {
  it("assembles the docker run argv to match run-in-docker.sh (default + web published)", async () => {
    const plan = await planDefault({
      ...baseOpts,
      anthropicApiKey: "sk-ant-x",
      fs: mkFs(
        new Set(["/home/eric/.claude.json", "/home/eric/.gitconfig"]),
        new Set([
          "/home/eric/.claude",
          "/home/eric/.ssh",
          "/home/eric/.config/gh",
        ]),
      ),
      net: freePort(),
    });
    expect("error" in plan).toBe(false);
    if ("error" in plan) return;
    expect(plan.webPublished).toBe(true);
    expect(runArgs(plan.run, { platform: "linux" })).toEqual([
      "run",
      "--rm",
      "-i",
      "-t",
      "--init",
      "--name",
      "claudopilot-runner",
      "--ipc=host",
      "--shm-size=2g",
      "-v",
      "/home/eric/repo:/work",
      "-v",
      "/home/eric/.claude:/home/runner/.claude",
      "-v",
      "/home/eric/.claude.json:/home/runner/.claude.json",
      "-v",
      "/home/eric/.gitconfig:/home/runner/.gitconfig:ro",
      "-v",
      "/home/eric/.ssh:/home/runner/.ssh:ro",
      "-v",
      "/home/eric/.config/gh:/home/runner/.config/gh",
      "-p",
      "127.0.0.1:4317:4317",
      "-e",
      "ANTHROPIC_API_KEY",
      "-e",
      "IGNORE_LOOP_CHECKPOINTS",
      "-e",
      "MAX_TICKS_PER_WINDOW",
      "-e",
      "USAGE_THRESHOLD_PCT",
      "-e",
      `GIT_SSH_COMMAND=${GIT_SSH_COMMAND}`,
      "claudopilot-runner",
      "bash",
      "-c",
      "cd /work && (CLAUDOPILOT_WEB_HOST=0.0.0.0 node claudopilot/web-server.mjs --port 4317 >/tmp/claudopilot-web.log 2>&1 &) ; bash claudopilot/run-loop.sh",
    ]);
  });

  it("skips publish when the host port is in use; loop cmd has no web bg-launch", async () => {
    const plan = await planDefault({
      ...baseOpts,
      anthropicApiKey: "sk-ant-x",
      fs: mkFs(new Set(), new Set()),
      net: busyPort(),
    });
    if ("error" in plan) throw new Error("unexpected");
    expect(plan.webPublished).toBe(false);
    expect(plan.webSkipReason).toMatch(/in use/);
    expect(plan.run.publish).toBeUndefined();
    expect(plan.run.cmd?.[2]).toBe(
      "cd /work && bash claudopilot/run-loop.sh",
    );
    expect(plan.diagnostics.some((d) => d.includes("skipped"))).toBe(true);
  });

  it("propagates an auth error", async () => {
    const plan = await planDefault({
      ...baseOpts,
      fs: mkFs(new Set(), new Set()),
      net: freePort(),
    });
    expect("error" in plan).toBe(true);
  });

  it("respects CLAUDOPILOT_WEB=false by not publishing", async () => {
    const plan = await planDefault({
      ...baseOpts,
      anthropicApiKey: "sk-ant-x",
      web: false,
      fs: mkFs(new Set(), new Set()),
      net: freePort(),
    });
    if ("error" in plan) throw new Error("unexpected");
    expect(plan.webPublished).toBe(false);
    expect(plan.webSkipReason).toMatch(/disabled/);
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

// ── workerRunSpec (matches run_phase_container in run-loop.sh) ─────────

describe("workerRunSpec", () => {
  it("argv matches `docker run --rm --name cp-w-<id> --init --ipc=host --shm-size=2g -v <wt>:/work [-v claude…] -e ANTHROPIC_API_KEY -e CLAUDOPILOT_PHASE=<id> -e GATE_CMD -e WORKTREE_PREPARE_CMD -e SUPERVISOR_MODE -e CLAUDOPILOT_RESUME_SID <image> bash /work/claudopilot/worker-entry.sh`", () => {
    const spec = workerRunSpec({
      phaseId: "phase-04",
      worktree: "/srv/clones/phase-04",
      home: "/home/eric",
      fs: mkFs(
        new Set(["/home/eric/.claude.json"]),
        new Set(["/home/eric/.claude"]),
      ),
    });
    expect(runArgs(spec, { platform: "linux" })).toEqual([
      "run",
      "--rm",
      "--init",
      "--name",
      "cp-w-phase-04",
      "--ipc=host",
      "--shm-size=2g",
      "-v",
      "/srv/clones/phase-04:/work",
      "-v",
      "/home/eric/.claude:/home/runner/.claude",
      "-v",
      "/home/eric/.claude.json:/home/runner/.claude.json",
      "-e",
      "ANTHROPIC_API_KEY",
      "-e",
      "CLAUDOPILOT_PHASE=phase-04",
      "-e",
      "GATE_CMD",
      "-e",
      "WORKTREE_PREPARE_CMD",
      "-e",
      "SUPERVISOR_MODE",
      "-e",
      "CLAUDOPILOT_RESUME_SID",
      "claudopilot-runner",
      "bash",
      "/work/claudopilot/worker-entry.sh",
    ]);
  });

  it("respects explicit authMounts override", () => {
    const spec = workerRunSpec({
      phaseId: "x",
      worktree: "/w",
      home: "/h",
      authMounts: [
        { source: "/host/claude", target: "/home/runner/.claude" },
      ],
      fs: mkFs(new Set(), new Set()),
    });
    expect(spec.mounts).toEqual([
      { source: "/w", target: "/work" },
      { source: "/host/claude", target: "/home/runner/.claude" },
    ]);
  });
});
