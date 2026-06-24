import { describe, it, expect } from "vitest";
import {
  parseEnv,
  capturePaths,
  transcriptHeader,
  workerEntry,
  WorkerEntryError,
  RESUME_NUDGE,
  type WorkerFs,
  type WorkerAgentRunner,
  type PrepareRunner,
} from "./workerEntry.js";

// ── parseEnv ──────────────────────────────────────────────────────────

describe("parseEnv", () => {
  it("throws when CLAUDOPILOT_PHASE is missing", () => {
    expect(() => parseEnv({})).toThrow(WorkerEntryError);
  });

  it("defaults workdir to /work and supervisor=false", () => {
    const o = parseEnv({ CLAUDOPILOT_PHASE: "phase-04" });
    expect(o.workdir).toBe("/work");
    expect(o.phaseId).toBe("phase-04");
    expect(o.supervisor).toBe(false);
    expect(o.worktreePrepareCmd).toBeUndefined();
    expect(o.resumeSessionId).toBeUndefined();
  });

  it("treats any non-empty SUPERVISOR_MODE as truthy", () => {
    expect(
      parseEnv({ CLAUDOPILOT_PHASE: "x", SUPERVISOR_MODE: "1" }).supervisor,
    ).toBe(true);
    expect(
      parseEnv({ CLAUDOPILOT_PHASE: "x", SUPERVISOR_MODE: "" }).supervisor,
    ).toBe(false);
  });

  it("carries WORKTREE_PREPARE_CMD and CLAUDOPILOT_RESUME_SID through", () => {
    const o = parseEnv({
      CLAUDOPILOT_PHASE: "x",
      WORKTREE_PREPARE_CMD: "pnpm install --frozen-lockfile",
      CLAUDOPILOT_RESUME_SID: "abc",
    });
    expect(o.worktreePrepareCmd).toBe("pnpm install --frozen-lockfile");
    expect(o.resumeSessionId).toBe("abc");
  });
});

// ── capturePaths ──────────────────────────────────────────────────────

describe("capturePaths", () => {
  it("matches the layout under <workdir>/.claudopilot/.run/", () => {
    expect(capturePaths("/work", "phase-04")).toEqual({
      log: "/work/.claudopilot/.run/phase-04.log",
      stream: "/work/.claudopilot/.run/phase-04.stream.jsonl",
      transcript: "/work/.claudopilot/.run/phase-04.transcript.md",
      prompt: "/work/.claudopilot/.run/phase-04.prompt.txt",
    });
  });
});

// ── transcriptHeader ──────────────────────────────────────────────────

describe("transcriptHeader", () => {
  it("default (worker) header", () => {
    expect(transcriptHeader("phase-04", false)).toBe(
      "\n=== [phase-04] container run ===\n",
    );
  });
  it("supervisor header includes the 'supervisor' prefix", () => {
    expect(transcriptHeader("phase-04", true)).toBe(
      "\n=== [phase-04] supervisor container run ===\n",
    );
  });
});

// ── workerEntry orchestration ─────────────────────────────────────────

function fakeFs(): {
  fs: WorkerFs;
  files: Map<string, string>;
  appends: string[];
  dirs: Set<string>;
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const appends: string[] = [];
  return {
    files,
    dirs,
    appends,
    fs: {
      ensureDir: async (p) => {
        dirs.add(p);
      },
      exists: async (p) => files.has(p) || dirs.has(p),
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
      },
      appendFile: async (p, data) => {
        appends.push(`${p}::${data}`);
        files.set(p, (files.get(p) ?? "") + data);
      },
    },
  };
}

function recordingRunner(): WorkerAgentRunner & {
  freshCalls: unknown[];
  resumeCalls: unknown[];
  exit: number;
} {
  const r = {
    freshCalls: [] as unknown[],
    resumeCalls: [] as unknown[],
    exit: 0,
    async runFresh(input: unknown) {
      r.freshCalls.push(input);
      return r.exit;
    },
    async runResume(input: unknown) {
      r.resumeCalls.push(input);
      return r.exit;
    },
  };
  return r;
}

function recordingPrepare(): PrepareRunner & { calls: unknown[] } {
  const p = {
    calls: [] as unknown[],
    async run(cmd: string, opts: { cwd: string; logPath: string }) {
      p.calls.push({ cmd, ...opts });
      return 0;
    },
  };
  return p;
}

describe("workerEntry — fresh", () => {
  it("appends transcript header, runs prepare cmd, then calls runFresh with the prompt", async () => {
    const f = fakeFs();
    f.dirs.add("/work");
    f.files.set("/work/.claudopilot/.run/phase-04.prompt.txt", "do the thing");
    const runner = recordingRunner();
    const prepare = recordingPrepare();

    const res = await workerEntry(
      {
        workdir: "/work",
        phaseId: "phase-04",
        supervisor: false,
        worktreePrepareCmd: "pnpm install",
      },
      { runner, prepareRunner: prepare, fs: f.fs },
    );

    expect(res.code).toBe(0);
    expect(prepare.calls).toEqual([
      {
        cmd: "pnpm install",
        cwd: "/work",
        logPath: "/work/.claudopilot/.run/phase-04.log",
      },
    ]);
    expect(runner.freshCalls.length).toBe(1);
    expect((runner.freshCalls[0] as { prompt: string }).prompt).toBe(
      "do the thing",
    );
    expect(runner.resumeCalls).toEqual([]);
    expect(
      f.appends.some((a) =>
        a.startsWith("/work/.claudopilot/.run/phase-04.transcript.md::"),
      ),
    ).toBe(true);
    expect(f.dirs.has("/work/.claudopilot/.run")).toBe(true);
  });

  it("skips the prepare step when no cmd is set", async () => {
    const f = fakeFs();
    f.dirs.add("/work");
    f.files.set("/work/.claudopilot/.run/phase-04.prompt.txt", "go");
    const runner = recordingRunner();
    const prepare = recordingPrepare();
    await workerEntry(
      { workdir: "/work", phaseId: "phase-04", supervisor: false },
      { runner, prepareRunner: prepare, fs: f.fs },
    );
    expect(prepare.calls).toEqual([]);
  });

  it("errors when the prompt file is missing", async () => {
    const f = fakeFs();
    f.dirs.add("/work");
    const runner = recordingRunner();
    await expect(
      workerEntry(
        { workdir: "/work", phaseId: "phase-04", supervisor: false },
        { runner, fs: f.fs },
      ),
    ).rejects.toBeInstanceOf(WorkerEntryError);
  });

  it("errors when /work is not mounted", async () => {
    const f = fakeFs();
    const runner = recordingRunner();
    await expect(
      workerEntry(
        { workdir: "/work", phaseId: "phase-04", supervisor: false },
        { runner, fs: f.fs },
      ),
    ).rejects.toBeInstanceOf(WorkerEntryError);
  });
});

describe("workerEntry — resume", () => {
  it("calls runResume with the SID + RESUME_NUDGE, and does NOT read the prompt file", async () => {
    const f = fakeFs();
    f.dirs.add("/work");
    // intentionally no prompt file
    const runner = recordingRunner();
    const res = await workerEntry(
      {
        workdir: "/work",
        phaseId: "phase-04",
        supervisor: false,
        resumeSessionId: "sess-123",
      },
      { runner, fs: f.fs },
    );
    expect(res.code).toBe(0);
    expect(runner.resumeCalls.length).toBe(1);
    expect(runner.freshCalls).toEqual([]);
    const call = runner.resumeCalls[0] as {
      sessionId: string;
      resumeMessage: string;
    };
    expect(call.sessionId).toBe("sess-123");
    expect(call.resumeMessage).toBe(RESUME_NUDGE);
  });

  it("logs the resume to the log file", async () => {
    const f = fakeFs();
    f.dirs.add("/work");
    const runner = recordingRunner();
    await workerEntry(
      {
        workdir: "/work",
        phaseId: "phase-04",
        supervisor: false,
        resumeSessionId: "S",
      },
      { runner, fs: f.fs },
    );
    expect(
      f.appends.some((a) =>
        a.startsWith("/work/.claudopilot/.run/phase-04.log::") &&
        a.includes("resuming session S"),
      ),
    ).toBe(true);
  });
});

describe("workerEntry — propagates the runner exit code", () => {
  it("non-zero from runFresh is returned", async () => {
    const f = fakeFs();
    f.dirs.add("/work");
    f.files.set("/work/.claudopilot/.run/phase-04.prompt.txt", "go");
    const runner = recordingRunner();
    runner.exit = 42;
    const res = await workerEntry(
      { workdir: "/work", phaseId: "phase-04", supervisor: false },
      { runner, fs: f.fs },
    );
    expect(res.code).toBe(42);
  });
});

describe("RESUME_NUDGE — matches the bash literal", () => {
  it("opening phrase is the same as run-loop.sh's RESUME_NUDGE", () => {
    expect(RESUME_NUDGE.startsWith("A transient interruption")).toBe(true);
    expect(RESUME_NUDGE).toContain("rename the phase doc to DONE_");
    expect(RESUME_NUDGE).toContain(
      "Do NOT re-seed the checklist, merge, or edit the manifest.",
    );
  });
});
