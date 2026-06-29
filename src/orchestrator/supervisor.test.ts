import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Config, PhaseState } from "../types.js";
import {
  branchHasDone,
  commitBuildLog,
  lockfileRegenCmdFor,
  markResume,
  supervise,
  type SupervisorContext,
} from "./supervisor.js";
import type { WorkerRecord } from "./types.js";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    repoRoot: "/repo",
    configPath: "/repo/claudopilot.config.sh",
    roadmapDir: "roadmap",
    manifest: "/repo/roadmap/EXECUTION-MANIFEST.md",
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
    reviewEnabled: false,
    reviewLenses: "correctness,security,scope,tests",
    reviewSkeptics: 2,
    reviewMaxRounds: 3,
    reviewerPromptFile: "/repo/prompts/reviewer.md",
    reviewModel: "",
    runDir: "/repo/.claudopilot",
    worktreesDir: "/repo/.claudopilot/worktrees",
    controlDir: "/repo/.claudopilot/control",
    logFile: "/repo/.claudopilot.log",
    ...overrides,
  };
}

function makeRecord(id: string, paths?: Partial<WorkerRecord["paths"]>): WorkerRecord {
  return {
    id,
    branch: `auto/${id}`,
    worktree: "/tmp/" + id,
    paths: {
      log: paths?.log ?? "/tmp/x.log",
      stream: paths?.stream ?? "/tmp/x.stream.jsonl",
      transcript: paths?.transcript ?? "/tmp/x.transcript.md",
    },
    done: Promise.resolve({ code: 0, signal: null }),
    supervisorAttempts: 0,
    apiRetries: 0,
  };
}

interface FakeGitMem {
  branches: Set<string>;
  lsTreeResults: Map<string, string[]>;
  logTouchingResults: Map<string, string[]>;
  added: string[];
  committed: Array<{ message: string; noVerify: boolean }>;
  unresolvedQueue: string[][];
  hasStagedQueue: boolean[];
  cwd: string;
}

function makeFakeGit(cwd: string, seed: Partial<FakeGitMem> = {}): {
  mem: FakeGitMem;
  git: SupervisorContext["git"];
} {
  const mem: FakeGitMem = {
    branches: new Set(),
    lsTreeResults: new Map(),
    logTouchingResults: new Map(),
    added: [],
    committed: [],
    unresolvedQueue: [],
    hasStagedQueue: [],
    cwd,
    ...seed,
  };

  const dummy = { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
  const git = {
    lsTree: async (ref: string): Promise<string[]> => mem.lsTreeResults.get(ref) ?? [],
    logTouching: async (ref: string): Promise<string[]> =>
      mem.logTouchingResults.get(ref) ?? [],
    add: async (p: string | string[]) => {
      const ps = Array.isArray(p) ? p : [p];
      mem.added.push(...ps);
      return dummy;
    },
    hasStagedChanges: async () => mem.hasStagedQueue.shift() ?? true,
    commit: async (opts: { message: string; noVerify?: boolean }) => {
      mem.committed.push({ message: opts.message, noVerify: opts.noVerify ?? false });
      return dummy;
    },
    unresolvedConflicts: async () => mem.unresolvedQueue.shift() ?? [],
    checkout: async () => dummy,
    fetchRef: async () => dummy,
    pullFfOnly: async () => dummy,
    merge: async () => dummy,
    mergeAbort: async () => dummy,
    push: async () => dummy,
    pushDelete: async () => dummy,
    checkoutOurs: async () => dummy,
    run: async () => dummy,
    cwd,
    constructor: function FakeGitCtor(_opts: { cwd: string }) {
      return git;
    },
  } as unknown as SupervisorContext["git"];
  (git as unknown as { constructor: unknown }).constructor = function FakeGitCtor(_opts: { cwd: string }) {
    return git;
  };
  return { mem, git };
}

describe("branchHasDone", () => {
  it("default mode: returns true if logTouching matches", async () => {
    const { git } = makeFakeGit("/r", {
      logTouchingResults: new Map([
        ["auto/phase-04", ["abc Done it"]],
      ]),
    });
    const cfg = baseConfig();
    expect(await branchHasDone(cfg, git, "phase-04", "/anything")).toBe(true);
  });

  it("default mode: falls back to lsTree", async () => {
    const { git } = makeFakeGit("/r", {
      logTouchingResults: new Map(),
      lsTreeResults: new Map([
        ["auto/phase-04", ["roadmap/DONE_phase-04-foo.md"]],
      ]),
    });
    expect(await branchHasDone(baseConfig(), git, "phase-04", "/anything")).toBe(true);
  });

  it("default mode: false when neither matches", async () => {
    const { git } = makeFakeGit("/r", {
      lsTreeResults: new Map([
        ["auto/phase-04", ["roadmap/phase-04-foo.md"]],
      ]),
    });
    expect(await branchHasDone(baseConfig(), git, "phase-04", "/anything")).toBe(false);
  });
});

describe("markResume", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cp-mr-"));
  });

  it("returns null when stream missing", () => {
    const rec = makeRecord("p", { stream: path.join(tmp, "nope") });
    expect(markResume(rec)).toBeNull();
  });

  it("extracts the first session_id and sets it on the record", async () => {
    const sp = path.join(tmp, "p.stream.jsonl");
    await writeFile(
      sp,
      `{"session_id":"abc-123","other":1}\n{"session_id":"later-id"}\n`,
    );
    const rec = makeRecord("p", { stream: sp });
    expect(markResume(rec)).toBe("abc-123");
    expect(rec.resumeSid).toBe("abc-123");
  });
});

describe("commitBuildLog", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cp-bl-"));
  });

  it("copies transcript + gzips stream + commits", async () => {
    const transcript = path.join(tmp, "p.transcript.md");
    const stream = path.join(tmp, "p.stream.jsonl");
    await writeFile(transcript, "## transcript");
    await writeFile(stream, '{"event":"hi"}\n');

    const cfg = baseConfig({ repoRoot: tmp, runDir: path.join(tmp, "rd") });
    const { mem, git } = makeFakeGit(tmp, { hasStagedQueue: [true] });

    const rec = makeRecord("phase-bl", { transcript, stream });
    const ok = await commitBuildLog(cfg, git, rec);
    expect(ok).toBe(true);
    expect(mem.committed).toHaveLength(1);
    expect(mem.committed[0]!.message).toContain("docs(build-log): phase-bl");
    expect(mem.committed[0]!.noVerify).toBe(true);
    expect(mem.added).toContain("build-logs/phase-bl");

    const copied = await readFile(path.join(tmp, "build-logs/phase-bl/transcript.md"), "utf8");
    expect(copied).toBe("## transcript");

    // gzip readback
    const gzPath = path.join(tmp, "build-logs/phase-bl/stream.jsonl.gz");
    expect((await stat(gzPath)).size).toBeGreaterThan(0);
    const decoded = await new Promise<string>((resolve, reject) => {
      let buf = "";
      createReadStream(gzPath)
        .pipe(createGunzip())
        .on("data", (c: Buffer) => {
          buf += c.toString("utf8");
        })
        .on("end", () => resolve(buf))
        .on("error", reject);
    });
    expect(decoded).toBe('{"event":"hi"}\n');
  });

  it("returns false (no-op) when both files are empty/missing", async () => {
    const cfg = baseConfig({ repoRoot: tmp, runDir: path.join(tmp, "rd") });
    const { mem, git } = makeFakeGit(tmp);
    const rec = makeRecord("phase-empty", {
      transcript: path.join(tmp, "nope.md"),
      stream: path.join(tmp, "nope.jsonl"),
    });
    expect(await commitBuildLog(cfg, git, rec)).toBe(false);
    expect(mem.committed).toHaveLength(0);
  });
});

describe("supervise (routing)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cp-sup-"));
  });

  function makeCtx(overrides: Partial<SupervisorContext> = {}): {
    ctx: SupervisorContext;
    sets: Array<[string, PhaseState]>;
    supervisorCalls: number;
    lastMode: string;
  } {
    const cfg = overrides.config ?? baseConfig();
    const sets: Array<[string, PhaseState]> = [];
    let supervisorCalls = 0;
    let lastMode = "";
    const { git } = makeFakeGit("/r");
    return {
      sets,
      get supervisorCalls(): number {
        return supervisorCalls;
      },
      get lastMode(): string {
        return lastMode;
      },
      ctx: {
        config: cfg,
        git,
        setState: async (id, s) => {
          sets.push([id, s]);
        },
        runSupervisorAgent: async ({ mode }) => {
          supervisorCalls++;
          lastMode = mode;
          return { code: 0, signal: null };
        },
        ...overrides,
      },
    };
  }

  it("rate-limited tail returns rateLimitCooldown + markResume", async () => {
    const logP = path.join(tmp, "p.log");
    const sp = path.join(tmp, "p.stream.jsonl");
    await writeFile(logP, "...\nrate limit reached, retry in 30 seconds\n");
    await writeFile(sp, `{"session_id":"sid-1"}\n`);
    const cfg = baseConfig({ defaultRateLimitSleep: 7 });
    const { ctx } = makeCtx({ config: cfg });
    const rec = makeRecord("phase-x", { log: logP, stream: sp });
    const out = await supervise(ctx, rec, 1, "SUPER");
    expect(out.kind).toBe("rateLimitCooldown");
    if (out.kind === "rateLimitCooldown") expect(out.seconds).toBe(30);
    expect(rec.resumeSid).toBe("sid-1");
  });

  it("transient api error returns transientRetry and bumps counter", async () => {
    const logP = path.join(tmp, "p.log");
    await writeFile(logP, "API Error: 500 Internal server error\n");
    const cfg = baseConfig({ transientApiMaxRetries: 3 });
    const { ctx } = makeCtx({ config: cfg });
    const rec = makeRecord("phase-x", { log: logP });
    const out = await supervise(ctx, rec, 1, "SUPER");
    expect(out.kind).toBe("transientRetry");
    if (out.kind === "transientRetry") {
      expect(out.attempt).toBe(1);
      expect(out.cap).toBe(3);
    }
    expect(rec.apiRetries).toBe(1);
  });

  it("transient retries past cap fall through to supervisor", async () => {
    const logP = path.join(tmp, "p.log");
    await writeFile(logP, "API Error: 500 Internal server error\n");
    const cfg = baseConfig({ transientApiMaxRetries: 1, maxSupervisorAttemptsPerPhase: 2 });
    const obj = makeCtx({ config: cfg });
    const rec = makeRecord("phase-x", { log: logP });
    rec.apiRetries = 1;
    // No DONE_ → relaunch outcome.
    const out = await supervise(obj.ctx, rec, 1, "SUPER");
    expect(out.kind).toBe("relaunch");
    expect(obj.supervisorCalls).toBe(1);
    expect(obj.lastMode).toBe("standard");
    expect(rec.supervisorAttempts).toBe(1);
  });

  it("park when supervisor attempts exhausted", async () => {
    const logP = path.join(tmp, "p.log");
    await writeFile(logP, "gate failed\n");
    const cfg = baseConfig({ maxSupervisorAttemptsPerPhase: 1 });
    const { ctx } = makeCtx({ config: cfg });
    const rec = makeRecord("phase-x", { log: logP });
    rec.supervisorAttempts = 1;
    const out = await supervise(ctx, rec, 6, "SUPER");
    expect(out.kind).toBe("park");
  });

  it("widening mandate on the LAST supervisor attempt", async () => {
    const logP = path.join(tmp, "p.log");
    await writeFile(logP, "gate failed\n");
    const cfg = baseConfig({ maxSupervisorAttemptsPerPhase: 2 });
    const obj = makeCtx({ config: cfg });
    const rec = makeRecord("phase-x", { log: logP });
    rec.supervisorAttempts = 1; // bumping to 2 == cap → best-effort
    const out = await supervise(obj.ctx, rec, 6, "SUPER");
    expect(out.kind).toBe("relaunch");
    expect(obj.lastMode).toBe("best-effort");
    expect(rec.supervisorAttempts).toBe(2);
  });
});

describe("lockfileRegenCmdFor", () => {
  it("infers the regen command for each package manager's lockfile", () => {
    expect(lockfileRegenCmdFor("pnpm-lock.yaml")).toBe("pnpm install --lockfile-only");
    expect(lockfileRegenCmdFor("package-lock.json")).toBe("npm install --package-lock-only");
    expect(lockfileRegenCmdFor("npm-shrinkwrap.json")).toBe("npm install --package-lock-only");
    expect(lockfileRegenCmdFor("yarn.lock")).toBe("yarn install --mode=update-lockfile");
    expect(lockfileRegenCmdFor("bun.lock")).toBe("bun install");
    expect(lockfileRegenCmdFor("bun.lockb")).toBe("bun install");
  });

  it("matches lockfiles in subdirectories (basename only)", () => {
    expect(lockfileRegenCmdFor("packages/app/pnpm-lock.yaml")).toBe(
      "pnpm install --lockfile-only",
    );
  });

  it("returns undefined for non-lockfile paths", () => {
    expect(lockfileRegenCmdFor("src/index.ts")).toBeUndefined();
    expect(lockfileRegenCmdFor("Gemfile.lock")).toBeUndefined();
  });
});
