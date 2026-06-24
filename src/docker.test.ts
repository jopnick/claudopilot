import { describe, it, expect } from "vitest";
import {
  buildArgs,
  runArgs,
  rmForceArgs,
  psArgs,
  execArgs,
} from "./docker.js";

describe("docker buildArgs", () => {
  it("assembles tag, dockerfile, context, build-args", () => {
    expect(
      buildArgs({
        tag: "claudopilot-runner",
        dockerfile: "claudopilot/Dockerfile",
        context: ".",
        buildArgs: { HOST_UID: "1000", HOST_GID: "1000" },
      }),
    ).toEqual([
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

  it("defaults context to '.'", () => {
    const a = buildArgs({ tag: "t", dockerfile: "Dockerfile" });
    expect(a[a.length - 1]).toBe(".");
  });
});

describe("docker runArgs — default mode (matches run-in-docker.sh)", () => {
  it("matches the bash invocation for the loop launch", () => {
    const a = runArgs(
      {
        image: "claudopilot-runner",
        name: "claudopilot-runner",
        rm: true,
        init: true,
        interactive: true,
        tty: true,
        ipc: "host",
        shmSize: "2g",
        mounts: [
          { source: "/home/eric/repo", target: "/work" },
          { source: "/home/eric/.claude", target: "/home/runner/.claude" },
          {
            source: "/home/eric/.gitconfig",
            target: "/home/runner/.gitconfig",
            readonly: true,
          },
        ],
        publish: [
          { hostIp: "127.0.0.1", hostPort: 4317, containerPort: 4317 },
        ],
        env: [
          "ANTHROPIC_API_KEY",
          "IGNORE_LOOP_CHECKPOINTS",
          {
            key: "GIT_SSH_COMMAND",
            value: "ssh -o StrictHostKeyChecking=no",
          },
        ],
        cmd: ["bash", "-c", "cd /work && bash claudopilot/run-loop.sh"],
      },
      { platform: "linux" },
    );
    expect(a).toEqual([
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
      "/home/eric/.gitconfig:/home/runner/.gitconfig:ro",
      "-p",
      "127.0.0.1:4317:4317",
      "-e",
      "ANTHROPIC_API_KEY",
      "-e",
      "IGNORE_LOOP_CHECKPOINTS",
      "-e",
      "GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=no",
      "claudopilot-runner",
      "bash",
      "-c",
      "cd /work && bash claudopilot/run-loop.sh",
    ]);
  });

  it("matches the bash invocation for run_phase_container (isolated)", () => {
    const a = runArgs(
      {
        image: "claudopilot-runner",
        name: "cp-w-phase-04",
        rm: true,
        init: true,
        ipc: "host",
        shmSize: "2g",
        mounts: [
          { source: "/srv/clones/phase-04", target: "/work" },
          { source: "/home/eric/.claude", target: "/home/runner/.claude" },
        ],
        env: [
          "ANTHROPIC_API_KEY",
          { key: "CLAUDOPILOT_PHASE", value: "phase-04" },
          "GATE_CMD",
        ],
        cmd: ["bash", "/work/claudopilot/worker-entry.sh"],
      },
      { platform: "linux" },
    );
    expect(a).toEqual([
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
      "-e",
      "ANTHROPIC_API_KEY",
      "-e",
      "CLAUDOPILOT_PHASE=phase-04",
      "-e",
      "GATE_CMD",
      "claudopilot-runner",
      "bash",
      "/work/claudopilot/worker-entry.sh",
    ]);
  });

  it("rewrites win32 mount sources through dockerPath", () => {
    const a = runArgs(
      {
        image: "img",
        mounts: [{ source: "C:\\Users\\x\\repo", target: "/work" }],
      },
      { platform: "win32" },
    );
    expect(a).toContain("/c/Users/x/repo:/work");
  });

  it("omits hostIp from publish when unset", () => {
    const a = runArgs({
      image: "img",
      publish: [{ hostPort: 8080, containerPort: 80 }],
    });
    expect(a).toContain("8080:80");
  });

  it("defaults rm true (can be opted out)", () => {
    expect(runArgs({ image: "img" })).toContain("--rm");
    expect(runArgs({ image: "img", rm: false })).not.toContain("--rm");
  });

  it("adds -d when detach is set", () => {
    expect(runArgs({ image: "img", detach: true, rm: false })).toEqual([
      "run",
      "-d",
      "img",
    ]);
  });
});

describe("docker rmForceArgs", () => {
  it("matches `docker rm -f <name>`", () => {
    expect(rmForceArgs("cp-w-phase-04")).toEqual(["rm", "-f", "cp-w-phase-04"]);
  });
});

describe("docker psArgs", () => {
  it("emits filters in stable order", () => {
    expect(psArgs({ name: "cp-w-", status: "running" })).toEqual([
      "ps",
      "-a",
      "--format",
      "{{.Names}}",
      "--filter",
      "name=cp-w-",
      "--filter",
      "status=running",
    ]);
  });

  it("with no filter emits a bare ps", () => {
    expect(psArgs()).toEqual(["ps", "-a", "--format", "{{.Names}}"]);
  });
});

describe("docker execArgs", () => {
  it("with -it", () => {
    expect(
      execArgs({
        name: "cp-w-x",
        interactive: true,
        tty: true,
        cmd: ["bash", "-lc", "ls"],
      }),
    ).toEqual(["exec", "-i", "-t", "cp-w-x", "bash", "-lc", "ls"]);
  });

  it("non-interactive", () => {
    expect(execArgs({ name: "n", cmd: ["echo", "hi"] })).toEqual([
      "exec",
      "n",
      "echo",
      "hi",
    ]);
  });
});
