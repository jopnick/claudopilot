import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Config, ManifestModel, PhaseState } from "../types.js";
import {
  routeExit,
  selectEligible,
  selectTerminal,
  manifestStore,
  runDriver,
  type DriverDeps,
} from "./driver.js";

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    repoRoot: "/repo",
    configPath: "",
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

describe("routeExit", () => {
  const base = { logTail: "", config: cfg(), apiRetries: 0 };

  it("0 with DONE_ → merge", () => {
    expect(routeExit({ ...base, code: 0, hasDone: true })).toEqual({ kind: "merge" });
  });
  it("5 with DONE_ → merge", () => {
    expect(routeExit({ ...base, code: 5, hasDone: true })).toEqual({ kind: "merge" });
  });
  it("0 without DONE_ → supervise carry 6", () => {
    expect(routeExit({ ...base, code: 0, hasDone: false })).toEqual({ kind: "supervise", carryCode: 6 });
  });
  it("2 → checkpoint", () => {
    expect(routeExit({ ...base, code: 2, hasDone: false })).toEqual({ kind: "checkpoint" });
  });
  it("4 → depError", () => {
    expect(routeExit({ ...base, code: 4, hasDone: false })).toEqual({ kind: "depError" });
  });
  it("non-zero with rate-limited tail → rateLimitCooldown", () => {
    const r = routeExit({
      ...base,
      code: 1,
      hasDone: false,
      logTail: "rate limit exceeded, retry in 60 seconds",
    });
    expect(r.kind).toBe("rateLimitCooldown");
    if (r.kind === "rateLimitCooldown") expect(r.seconds).toBe(60);
  });
  it("non-zero with transient API error and retries available → transientRetry", () => {
    const r = routeExit({
      ...base,
      code: 1,
      hasDone: false,
      logTail: "API Error: 500 Internal server error",
    });
    expect(r).toEqual({ kind: "transientRetry" });
  });
  it("non-zero with transient API error but cap reached → park", () => {
    const r = routeExit({
      ...base,
      code: 1,
      hasDone: false,
      logTail: "API Error: 500 Internal server error",
      apiRetries: 10,
    });
    expect(r.kind).toBe("park");
  });
  it("non-zero unknown → park", () => {
    const r = routeExit({ ...base, code: 1, hasDone: false, logTail: "boom" });
    expect(r.kind).toBe("park");
  });
});

describe("selectEligible", () => {
  const model = (phases: Array<{ id: string; state: PhaseState; deps?: string[] }>): ManifestModel => ({
    status: "",
    phases: phases.map((p) => ({ id: p.id, state: p.state, title: "", deps: p.deps ?? [] })),
  });

  it("respects maxParallel and excludes already-running", () => {
    const m = model([
      { id: "a", state: "pending" },
      { id: "b", state: "pending" },
      { id: "c", state: "pending" },
    ]);
    const eligible = selectEligible(m, new Set(["b"]), 2);
    expect(eligible).toEqual(["a"]);
  });
  it("skips pending phases whose deps are unmet", () => {
    const m = model([
      { id: "a", state: "merged" },
      { id: "b", state: "pending", deps: ["a"] },
      { id: "c", state: "pending", deps: ["x"] },
    ]);
    expect(selectEligible(m, new Set(), 5)).toEqual(["b"]);
  });
  it("returns [] when nothing is eligible", () => {
    const m = model([{ id: "a", state: "merged" }]);
    expect(selectEligible(m, new Set(), 5)).toEqual([]);
  });
});

describe("selectTerminal", () => {
  const mk = (phases: Array<{ id: string; state: PhaseState }>): ManifestModel => ({
    status: "",
    phases: phases.map((p) => ({ id: p.id, state: p.state, title: "", deps: [] })),
  });

  it("continue when workers are running", () => {
    expect(
      selectTerminal({
        model: mk([{ id: "a", state: "running" }]),
        runningCount: 1,
        failed: false,
        haltCode: undefined,
        launchPaused: false,
        keepGoing: false,
      }),
    ).toEqual({ kind: "continue" });
  });
  it("complete when nothing running and all merged", () => {
    expect(
      selectTerminal({
        model: mk([{ id: "a", state: "merged" }]),
        runningCount: 0,
        failed: false,
        haltCode: undefined,
        launchPaused: false,
        keepGoing: false,
      }),
    ).toEqual({ kind: "complete" });
  });
  it("halt when failed", () => {
    expect(
      selectTerminal({
        model: mk([{ id: "a", state: "failed" }]),
        runningCount: 0,
        failed: true,
        haltCode: 6,
        launchPaused: false,
        keepGoing: false,
      }),
    ).toEqual({ kind: "halt", code: 6 });
  });
  it("launchPaused when nothing running and usage gate engaged", () => {
    expect(
      selectTerminal({
        model: mk([{ id: "a", state: "pending" }]),
        runningCount: 0,
        failed: false,
        haltCode: undefined,
        launchPaused: true,
        keepGoing: false,
      }),
    ).toEqual({ kind: "launchPaused" });
  });
  it("finishKeepGoing under KEEP_GOING with no eligible work", () => {
    expect(
      selectTerminal({
        model: mk([
          { id: "a", state: "blocked" },
          { id: "b", state: "pending" },
        ]),
        runningCount: 0,
        failed: false,
        haltCode: undefined,
        launchPaused: false,
        keepGoing: true,
      }),
    ).toEqual({ kind: "finishKeepGoing", blocked: 1 });
  });
  it("deadlock when no work eligible and not keep-going", () => {
    expect(
      selectTerminal({
        model: mk([
          { id: "a", state: "blocked" },
          { id: "b", state: "pending" },
        ]),
        runningCount: 0,
        failed: false,
        haltCode: undefined,
        launchPaused: false,
        keepGoing: false,
      }),
    ).toEqual({ kind: "deadlock" });
  });
});

describe("manifestStore", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cp-ms-"));
  });

  it("setState rewrites the file and commits", async () => {
    const mf = path.join(tmp, "M.md");
    await writeFile(
      mf,
      "**Status:** running\n\n## Order\n\n1. [pending] **phase-04** — docker (deps: none)\n",
    );
    let added = "";
    let committed = "";
    const git = {
      add: async (p: string | string[]) => {
        added = Array.isArray(p) ? p.join(",") : p;
        return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
      },
      commit: async (opts: { message: string }) => {
        committed = opts.message;
        return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
      },
    };

    const store = manifestStore(
      cfg({ manifest: mf }),
      git as unknown as Parameters<typeof manifestStore>[1],
    );
    await store.setState("phase-04", "running");
    const txt = await readFile(mf, "utf8");
    expect(txt).toContain("[running] **phase-04**");
    expect(added).toBe(mf);
    expect(committed).toBe("chore(loop): phase-04 -> running");
  });

  it("markComplete is idempotent and writes when needed", async () => {
    const mf = path.join(tmp, "M.md");
    await writeFile(mf, "**Status:** running\n\n");
    let commits = 0;
    const git = {
      add: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
      commit: async () => {
        commits++;
        return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
      },
    };
    const store = manifestStore(
      cfg({ manifest: mf }),
      git as unknown as Parameters<typeof manifestStore>[1],
    );
    await store.markComplete();
    expect(commits).toBe(1);
    expect(await readFile(mf, "utf8")).toContain("**Status:** complete");
    await store.markComplete();
    expect(commits).toBe(1); // no-op the second time
  });
});

describe("runDriver trunk guard + completion", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cp-drv-"));
  });

  it("refuses to run on trunk (returns 1)", async () => {
    const conf = cfg({
      repoRoot: tmp,
      runDir: path.join(tmp, "rd"),
      worktreesDir: path.join(tmp, "rd/wt"),
      controlDir: path.join(tmp, "rd/c"),
    });
    const deps: DriverDeps = {
      git: {} as DriverDeps["git"],
      log: () => {},
      sleep: async () => {},
    };
    const code = await runDriver(deps, {
      config: conf,
      baseBranch: "main",
      workerPrompt: "",
      supervisorPrompt: "",
    });
    expect(code).toBe(1);
  });

  it("returns 0 + flips status complete when all phases merged", async () => {
    const mf = path.join(tmp, "M.md");
    await writeFile(
      mf,
      "**Status:** running\n\n## Order\n\n1. [merged] **phase-01** — x (deps: none)\n",
    );
    await mkdir(path.join(tmp, "prompts"), { recursive: true });
    await writeFile(path.join(tmp, "prompts", "worker.md"), "p");
    const conf = cfg({
      repoRoot: tmp,
      manifest: mf,
      promptFile: path.join(tmp, "prompts", "worker.md"),
      runDir: path.join(tmp, "rd"),
      worktreesDir: path.join(tmp, "rd/wt"),
      controlDir: path.join(tmp, "rd/c"),
    });
    const pushCalls: string[] = [];
    let committedCount = 0;
    const git = {
      add: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
      commit: async () => {
        committedCount++;
        return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
      },
      push: async (remote: string, branch: string) => {
        pushCalls.push(`${remote}/${branch}`);
        return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
      },
    };
    const deps: DriverDeps = {
      git: git as unknown as DriverDeps["git"],
      log: () => {},
      sleep: async () => {},
      shellRunFn: async () => ({ code: 0 }),
    };
    const code = await runDriver(deps, {
      config: conf,
      baseBranch: "autonomous-runner",
      workerPrompt: "WP",
      supervisorPrompt: "SP",
    });
    expect(code).toBe(0);
    expect(pushCalls).toContain("origin/autonomous-runner");
    const txt = await readFile(mf, "utf8");
    expect(txt).toContain("**Status:** complete");
    expect(committedCount).toBeGreaterThan(0);
  });

  it("returns 3 when manifest is missing", async () => {
    await writeFile(path.join(tmp, "prompt.md"), "x");
    const conf = cfg({
      repoRoot: tmp,
      manifest: path.join(tmp, "missing.md"),
      promptFile: path.join(tmp, "prompt.md"),
      runDir: path.join(tmp, "rd"),
      worktreesDir: path.join(tmp, "rd/wt"),
      controlDir: path.join(tmp, "rd/c"),
    });
    const deps: DriverDeps = {
      git: {} as DriverDeps["git"],
      log: () => {},
      sleep: async () => {},
      shellRunFn: async () => ({ code: 0 }),
    };
    expect(
      await runDriver(deps, {
        config: conf,
        baseBranch: "autonomous-runner",
        workerPrompt: "",
        supervisorPrompt: "",
      }),
    ).toBe(3);
  });

  it("returns 3 when prompt file is missing", async () => {
    const mf = path.join(tmp, "M.md");
    await writeFile(mf, "**Status:** running\n\n## Order\n\n1. [merged] **phase-01** — x (deps: none)\n");
    const conf = cfg({
      repoRoot: tmp,
      manifest: mf,
      promptFile: path.join(tmp, "missing-prompt.md"),
      runDir: path.join(tmp, "rd"),
      worktreesDir: path.join(tmp, "rd/wt"),
      controlDir: path.join(tmp, "rd/c"),
    });
    const deps: DriverDeps = {
      git: {} as DriverDeps["git"],
      log: () => {},
      sleep: async () => {},
      shellRunFn: async () => ({ code: 0 }),
    };
    expect(
      await runDriver(deps, {
        config: conf,
        baseBranch: "autonomous-runner",
        workerPrompt: "",
        supervisorPrompt: "",
      }),
    ).toBe(3);
  });

  it("deadlock → exit 3 when nothing eligible", async () => {
    const mf = path.join(tmp, "M.md");
    await writeFile(
      mf,
      "**Status:** running\n\n## Order\n\n1. [pending] **phase-x** — y (deps: nope)\n",
    );
    await writeFile(path.join(tmp, "prompt.md"), "x");
    const conf = cfg({
      repoRoot: tmp,
      manifest: mf,
      promptFile: path.join(tmp, "prompt.md"),
      runDir: path.join(tmp, "rd"),
      worktreesDir: path.join(tmp, "rd/wt"),
      controlDir: path.join(tmp, "rd/c"),
    });
    const git = {
      add: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
      commit: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
      push: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
    };
    const deps: DriverDeps = {
      git: git as unknown as DriverDeps["git"],
      log: () => {},
      sleep: async () => {},
      shellRunFn: async () => ({ code: 0 }),
    };
    expect(
      await runDriver(deps, {
        config: conf,
        baseBranch: "autonomous-runner",
        workerPrompt: "",
        supervisorPrompt: "",
      }),
    ).toBe(3);
  });

  it("KEEP_GOING → exit 8 when blocked phases remain", async () => {
    const mf = path.join(tmp, "M.md");
    await writeFile(
      mf,
      "**Status:** running\n\n## Order\n\n1. [blocked] **phase-x** — y (deps: none)\n",
    );
    await writeFile(path.join(tmp, "prompt.md"), "x");
    const conf = cfg({
      repoRoot: tmp,
      manifest: mf,
      promptFile: path.join(tmp, "prompt.md"),
      runDir: path.join(tmp, "rd"),
      worktreesDir: path.join(tmp, "rd/wt"),
      controlDir: path.join(tmp, "rd/c"),
      keepGoing: true,
    });
    const git = {
      add: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
      commit: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
      push: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
    };
    const deps: DriverDeps = {
      git: git as unknown as DriverDeps["git"],
      log: () => {},
      sleep: async () => {},
      shellRunFn: async () => ({ code: 0 }),
    };
    expect(
      await runDriver(deps, {
        config: conf,
        baseBranch: "autonomous-runner",
        workerPrompt: "",
        supervisorPrompt: "",
      }),
    ).toBe(8);
  });

  it("checkpoint marker → exit 2 (when ignore flag off)", async () => {
    const mf = path.join(tmp, "M.md");
    await writeFile(
      mf,
      "**Status:** running\n\n<!-- LOOP-CHECKPOINT: pause -->\n\n## Order\n\n1. [pending] **phase-x** — y (deps: none)\n",
    );
    await writeFile(path.join(tmp, "prompt.md"), "x");
    const conf = cfg({
      repoRoot: tmp,
      manifest: mf,
      promptFile: path.join(tmp, "prompt.md"),
      runDir: path.join(tmp, "rd"),
      worktreesDir: path.join(tmp, "rd/wt"),
      controlDir: path.join(tmp, "rd/c"),
    });
    const git = {
      add: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
      commit: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
      push: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
    };
    const deps: DriverDeps = {
      git: git as unknown as DriverDeps["git"],
      log: () => {},
      sleep: async () => {},
      shellRunFn: async () => ({ code: 0 }),
    };
    expect(
      await runDriver(deps, {
        config: conf,
        baseBranch: "autonomous-runner",
        workerPrompt: "",
        supervisorPrompt: "",
      }),
    ).toBe(2);
  });
});
