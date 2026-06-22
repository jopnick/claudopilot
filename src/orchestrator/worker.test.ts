import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Config } from "../types.js";
import {
  prepareWorktree,
  setCapturePaths,
  workerPromptSuffix,
  workerPromptSuffixIsolated,
  launch,
  killWorker,
  cleanup,
  type WorkerDeps,
} from "./worker.js";
import type { DockerLike, DockerRunOpts } from "./types.js";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    repoRoot: "/repo",
    configPath: "/repo/claudopilot.config.sh",
    roadmapDir: "roadmap",
    manifest: "/repo/roadmap/EXECUTION-MANIFEST.md",
    renderStream: "",
    renderStreamOpencode: "",
    agentDriver: "claude",
    agentModel: "",
    promptFile: "/repo/prompts/worker.md",
    supervisorPromptFile: "/repo/prompts/supervisor.md",
    workerProjectPrompt: "",
    supervisorProjectPrompt: "",
    isolated: false,
    workerImage: "claudopilot-runner",
    maxParallel: 3,
    pollSeconds: 5,
    maxIter: 2000,
    maxSupervisorAttemptsPerPhase: 2,
    keepGoing: false,
    gateCmd: "true",
    worktreePrepareCmd: "",
    bootstrapCmd: "",
    buildCmd: "",
    usageWindowSeconds: 18000,
    maxTicksPerWindow: 40,
    usageThresholdPct: 95,
    defaultRateLimitSleep: 3600,
    ignoreLoopCheckpoints: false,
    retryTransientApi: true,
    transientApiMaxRetries: 10,
    stuckTimeout: 0,
    runDir: "/repo/.claudopilot",
    worktreesDir: "/repo/.claudopilot/worktrees",
    controlDir: "/repo/.claudopilot/control",
    logFile: "/repo/.claudopilot.log",
    ...overrides,
  };
}

interface GitCall {
  args: string[];
}

interface FakeGit {
  calls: GitCall[];
  branches: Set<string>;
  worktrees: Set<string>;
  configValues: Map<string, string>;
}

function makeFakeGit(seed: Partial<FakeGit> = {}): {
  fake: FakeGit;
  git: WorkerDeps["git"];
} {
  const fake: FakeGit = {
    calls: [],
    branches: new Set(seed.branches ?? []),
    worktrees: new Set(seed.worktrees ?? []),
    configValues: seed.configValues ?? new Map(),
  };

  const record = (args: readonly string[]): { code: 0; signal: null; stdout: string; stderr: string; timedOut: false } => {
    fake.calls.push({ args: [...args] });
    return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
  };

  const git = {
    async branchExists(branch: string): Promise<boolean> {
      fake.calls.push({ args: ["show-ref", "--quiet", `refs/heads/${branch}`] });
      return fake.branches.has(branch);
    },
    async createBranch(branch: string, startPoint: string): Promise<unknown> {
      fake.branches.add(branch);
      return record(["branch", branch, startPoint]);
    },
    async clone(source: string, dest: string, opts: { branch?: string } = {}): Promise<unknown> {
      // Actually create the dest dir so subsequent dirExists() reflects state.
      await mkdir(dest, { recursive: true });
      return record(["clone", "--quiet", ...(opts.branch ? ["--branch", opts.branch] : []), source, dest]);
    },
    async worktreeAdd(p: string, branch: string): Promise<unknown> {
      fake.worktrees.add(p);
      await mkdir(p, { recursive: true });
      return record(["worktree", "add", p, branch]);
    },
    async worktreeRemove(p: string): Promise<unknown> {
      fake.worktrees.delete(p);
      await rm(p, { recursive: true, force: true });
      return record(["worktree", "remove", p, "--force"]);
    },
    async deleteBranch(branch: string): Promise<unknown> {
      fake.branches.delete(branch);
      return record(["branch", "-D", branch]);
    },
    async configGet(key: string): Promise<string | null> {
      fake.calls.push({ args: ["config", key] });
      return fake.configValues.get(key) ?? null;
    },
    async configSet(key: string, value: string): Promise<unknown> {
      fake.configValues.set(key, value);
      return record(["config", key, value]);
    },
    constructor: function FakeGitCtor(_opts: { cwd: string }) {
      // For makeClonedGit — just return a thin clone with the same configSet impl.
      return {
        configGet: git.configGet.bind(git),
        configSet: git.configSet.bind(git),
      };
    },
  } as unknown as WorkerWithCtor;

  // Wire constructor for the makeClonedGit dynamic instantiation.
  (git as unknown as { constructor: unknown }).constructor = function FakeGitCtor(_opts: {
    cwd: string;
  }) {
    return git;
  };

  return { fake, git: git as unknown as WorkerDeps["git"] };
}

type WorkerWithCtor = WorkerDeps["git"] & { constructor: unknown };

describe("prompt suffixes", () => {
  it("default suffix has the correct shape and id", () => {
    const s = workerPromptSuffix("phase-99");
    expect(s).toContain("The phase to execute is: phase-99");
    expect(s).toContain("auto/phase-99");
    expect(s).toContain("Do NOT merge");
  });

  it("isolated suffix names /work as the cwd", () => {
    const s = workerPromptSuffixIsolated("phase-99");
    expect(s).toContain("Your working directory (/work)");
    expect(s).toContain("Do NOT merge, push, or");
  });
});

describe("setCapturePaths", () => {
  it("uses runDir in default mode", () => {
    const cfg = baseConfig();
    const p = setCapturePaths("phase-04", cfg, "/anywhere");
    expect(p.log).toBe("/repo/.claudopilot/phase-04.log");
    expect(p.stream).toBe("/repo/.claudopilot/phase-04.stream.jsonl");
    expect(p.transcript).toBe("/repo/.claudopilot/phase-04.transcript.md");
  });

  it("uses the worktree's .claudopilot dir in isolated mode", () => {
    const cfg = baseConfig({ isolated: true });
    const p = setCapturePaths("phase-04", cfg, "/clones/phase-04");
    expect(p.log).toBe("/clones/phase-04/.claudopilot/phase-04.log");
  });
});

describe("prepareWorktree", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cp-worker-"));
  });

  it("default mode: creates branch and worktree", async () => {
    const cfg = baseConfig({
      repoRoot: tmp,
      worktreesDir: path.join(tmp, "wt"),
    });
    const { fake, git } = makeFakeGit();
    const res = await prepareWorktree({ git }, {
      id: "phase-x",
      config: cfg,
      baseBranch: "main",
    });
    expect(res.branch).toBe("auto/phase-x");
    expect(res.worktree).toBe(path.join(tmp, "wt", "phase-x"));
    // Branch created via createBranch
    expect(fake.calls.some((c) => c.args[0] === "branch" && c.args[1] === "auto/phase-x")).toBe(true);
    // Worktree add called
    expect(fake.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(true);
  });

  it("default mode: skips branch creation when branch exists", async () => {
    const cfg = baseConfig({ repoRoot: tmp, worktreesDir: path.join(tmp, "wt") });
    const { fake, git } = makeFakeGit({ branches: new Set(["auto/phase-x"]) });
    await prepareWorktree({ git }, { id: "phase-x", config: cfg, baseBranch: "main" });
    expect(fake.calls.some((c) => c.args[0] === "branch" && c.args[1] === "auto/phase-x" && c.args.length === 3)).toBe(false);
  });

  it("default mode: skips worktree add when dir already exists", async () => {
    const wtDir = path.join(tmp, "wt", "phase-x");
    await mkdir(wtDir, { recursive: true });
    const cfg = baseConfig({ repoRoot: tmp, worktreesDir: path.join(tmp, "wt") });
    const { fake, git } = makeFakeGit({ branches: new Set(["auto/phase-x"]) });
    await prepareWorktree({ git }, { id: "phase-x", config: cfg, baseBranch: "main" });
    expect(fake.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(false);
  });

  it("isolated mode: clones repo and copies git user info", async () => {
    const cfg = baseConfig({
      repoRoot: tmp,
      worktreesDir: path.join(tmp, "wt"),
      isolated: true,
    });
    const { fake, git } = makeFakeGit({
      configValues: new Map([
        ["user.name", "Alice"],
        ["user.email", "alice@example.com"],
      ]),
    });
    await prepareWorktree({ git }, { id: "phase-y", config: cfg, baseBranch: "main" });
    expect(fake.calls.some((c) => c.args[0] === "clone")).toBe(true);
    // configSet was called for both keys after clone
    const sets = fake.calls.filter((c) => c.args[0] === "config" && c.args.length === 3);
    expect(sets.some((c) => c.args[1] === "user.name" && c.args[2] === "Alice")).toBe(true);
    expect(sets.some((c) => c.args[1] === "user.email" && c.args[2] === "alice@example.com")).toBe(true);
  });
});

describe("launch — isolated mode", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cp-launch-"));
  });

  it("writes the prompt file and invokes docker.run with expected args", async () => {
    const cfg = baseConfig({ isolated: true, gateCmd: "pnpm test" });
    const wt = path.join(tmp, "wt");
    await mkdir(wt, { recursive: true });
    const paths = setCapturePaths("phase-z", cfg, wt);

    const runCalls: DockerRunOpts[] = [];
    const rmCalls: string[] = [];
    const docker: DockerLike = {
      async run(opts) {
        runCalls.push(opts);
        return { code: 0, signal: null };
      },
      async rmForce(name) {
        rmCalls.push(name);
      },
    };
    const { git } = makeFakeGit();

    const record = await launch(
      { git, docker },
      {
        id: "phase-z",
        config: cfg,
        workerPrompt: "WORKER PROMPT BODY",
        paths,
        worktree: wt,
        baseBranch: "main",
      },
    );
    await record.done;

    expect(rmCalls).toEqual(["cp-w-phase-z"]);
    expect(runCalls).toHaveLength(1);
    const r = runCalls[0]!;
    expect(r.name).toBe("cp-w-phase-z");
    expect(r.image).toBe("claudopilot-runner");
    expect(r.cmd).toEqual(["claudopilot", "__worker"]);
    expect(r.mounts.some((m) => m.container === "/work" && m.host === wt)).toBe(true);
    expect(r.env["CLAUDOPILOT_PHASE"]).toBe("phase-z");
    expect(r.env["GATE_CMD"]).toBe("pnpm test");
    expect(r.env["AGENT_DRIVER"]).toBe("claude");

    const written = await readFile(path.join(wt, ".claudopilot", "phase-z.prompt.txt"), "utf8");
    expect(written).toContain("WORKER PROMPT BODY");
    expect(written).toContain("phase to execute is: phase-z");
  });

  it("isolated mode rejects when docker is missing", async () => {
    const cfg = baseConfig({ isolated: true });
    const wt = path.join(tmp, "wt");
    await mkdir(wt, { recursive: true });
    const { git } = makeFakeGit();
    await expect(
      launch(
        { git },
        {
          id: "phase-q",
          config: cfg,
          workerPrompt: "p",
          paths: setCapturePaths("phase-q", cfg, wt),
          worktree: wt,
          baseBranch: "main",
        },
      ),
    ).rejects.toThrow(/isolated mode requires a DockerLike/);
  });

  it("passes CLAUDOPILOT_RESUME_SID + SUPERVISOR_MODE env when set", async () => {
    const cfg = baseConfig({ isolated: true });
    const wt = path.join(tmp, "wt");
    await mkdir(wt, { recursive: true });
    let captured: DockerRunOpts | undefined;
    const docker: DockerLike = {
      async run(opts) {
        captured = opts;
        return { code: 0, signal: null };
      },
      async rmForce() {},
    };
    const { git } = makeFakeGit();
    const rec = await launch(
      { git, docker },
      {
        id: "phase-r",
        config: cfg,
        workerPrompt: "p",
        paths: setCapturePaths("phase-r", cfg, wt),
        worktree: wt,
        baseBranch: "main",
        resumeSid: "sess-abc",
        supervisorMode: "best-effort",
      },
    );
    await rec.done;
    expect(captured?.env["CLAUDOPILOT_RESUME_SID"]).toBe("sess-abc");
    expect(captured?.env["SUPERVISOR_MODE"]).toBe("best-effort");
  });
});

describe("launch — default mode", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cp-launchd-"));
  });

  it("invokes captureAgent with the composed prompt + claude driver", async () => {
    const cfg = baseConfig({ runDir: path.join(tmp, "rd") });
    const wt = path.join(tmp, "wt");
    await mkdir(wt, { recursive: true });
    const paths = setCapturePaths("phase-d", cfg, wt);
    const fake = vi.fn().mockResolvedValue({ code: 0, signal: null });
    const { git } = makeFakeGit();
    const rec = await launch(
      { git, captureAgentFn: fake as unknown as WorkerDeps["captureAgentFn"] },
      {
        id: "phase-d",
        config: cfg,
        workerPrompt: "BODY",
        paths,
        worktree: wt,
        baseBranch: "main",
      },
    );
    await rec.done;
    expect(fake).toHaveBeenCalledTimes(1);
    const arg = fake.mock.calls[0]![0];
    expect(arg.driver).toBe("claude");
    expect(arg.cwd).toBe(wt);
    expect(arg.prompt).toContain("BODY");
    expect(arg.prompt).toContain("phase to execute is: phase-d");
  });

  it("uses RESUME_NUDGE when resumeSid is set", async () => {
    const cfg = baseConfig({ runDir: path.join(tmp, "rd") });
    const wt = path.join(tmp, "wt");
    await mkdir(wt, { recursive: true });
    const paths = setCapturePaths("phase-d", cfg, wt);
    const fake = vi.fn().mockResolvedValue({ code: 0, signal: null });
    const { git } = makeFakeGit();
    await (
      await launch(
        { git, captureAgentFn: fake as unknown as WorkerDeps["captureAgentFn"] },
        {
          id: "phase-d",
          config: cfg,
          workerPrompt: "BODY",
          paths,
          worktree: wt,
          baseBranch: "main",
          resumeSid: "sid-1",
        },
      )
    ).done;
    const arg = fake.mock.calls[0]![0];
    expect(arg.resumeSid).toBe("sid-1");
    expect(arg.prompt).toContain("transient interruption");
    expect(arg.prompt).not.toContain("phase to execute is");
  });

  it("opencode driver passes through agentModel", async () => {
    const cfg = baseConfig({
      agentDriver: "opencode",
      agentModel: "ollama/qwen2.5-coder",
      runDir: path.join(tmp, "rd"),
    });
    const wt = path.join(tmp, "wt");
    await mkdir(wt, { recursive: true });
    const paths = setCapturePaths("phase-d", cfg, wt);
    const fake = vi.fn().mockResolvedValue({ code: 0, signal: null });
    const { git } = makeFakeGit();
    await (
      await launch(
        { git, captureAgentFn: fake as unknown as WorkerDeps["captureAgentFn"] },
        {
          id: "phase-d",
          config: cfg,
          workerPrompt: "BODY",
          paths,
          worktree: wt,
          baseBranch: "main",
        },
      )
    ).done;
    const arg = fake.mock.calls[0]![0];
    expect(arg.driver).toBe("opencode");
    expect(arg.model).toBe("ollama/qwen2.5-coder");
  });
});

describe("killWorker / cleanup", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cp-cl-"));
  });

  it("killWorker calls record.kill when set (non-isolated)", async () => {
    let killed = 0;
    const { git } = makeFakeGit();
    await killWorker(
      { git },
      {
        id: "x",
        branch: "auto/x",
        worktree: "/tmp/x",
        paths: { log: "", stream: "", transcript: "" },
        supervisorAttempts: 0,
        apiRetries: 0,
        done: Promise.resolve({ code: 0, signal: null }),
        kill: async () => {
          killed++;
        },
      },
    );
    expect(killed).toBe(1);
  });

  it("killWorker calls docker.rmForce when container present", async () => {
    let removed = "";
    const docker: DockerLike = {
      async run() {
        return { code: 0, signal: null };
      },
      async rmForce(name) {
        removed = name;
      },
    };
    const { git } = makeFakeGit();
    await killWorker(
      { git, docker },
      {
        id: "x",
        branch: "auto/x",
        worktree: "/tmp/x",
        paths: { log: "", stream: "", transcript: "" },
        containerName: "cp-w-x",
        supervisorAttempts: 0,
        apiRetries: 0,
        done: Promise.resolve({ code: 0, signal: null }),
      },
    );
    expect(removed).toBe("cp-w-x");
  });

  it("cleanup default mode: removes worktree + deletes branch", async () => {
    const cfg = baseConfig({ repoRoot: tmp, worktreesDir: path.join(tmp, "wt") });
    const wt = path.join(tmp, "wt", "phase-c");
    await mkdir(wt, { recursive: true });
    const { fake, git } = makeFakeGit({ worktrees: new Set([wt]) });
    await cleanup({ git }, "phase-c", cfg);
    expect(fake.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
    expect(fake.calls.some((c) => c.args[0] === "branch" && c.args[1] === "-D")).toBe(true);
  });

  it("cleanup isolated mode: docker rmForce + rm clone dir + delete branch", async () => {
    const cfg = baseConfig({
      repoRoot: tmp,
      worktreesDir: path.join(tmp, "wt"),
      isolated: true,
    });
    const wt = path.join(tmp, "wt", "phase-c");
    await mkdir(wt, { recursive: true });
    let removed = "";
    const docker: DockerLike = {
      async run() {
        return { code: 0, signal: null };
      },
      async rmForce(name) {
        removed = name;
      },
    };
    const { fake, git } = makeFakeGit();
    await cleanup({ git, docker }, "phase-c", cfg);
    expect(removed).toBe("cp-w-phase-c");
    await expect(stat(wt)).rejects.toBeTruthy();
    expect(fake.calls.some((c) => c.args[0] === "branch" && c.args[1] === "-D")).toBe(true);
  });
});
