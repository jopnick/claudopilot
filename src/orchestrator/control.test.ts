import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  listControlRequests,
  processControl,
  checkStuck,
  type ControlContext,
} from "./control.js";
import type { PhaseState } from "../types.js";
import type { WorkerRecord } from "./types.js";

function makeRecord(id: string, stream = "/tmp/x.stream.jsonl"): WorkerRecord {
  return {
    id,
    branch: `auto/${id}`,
    worktree: "/tmp/" + id,
    paths: { log: "/tmp/x.log", stream, transcript: "/tmp/x.transcript.md" },
    done: Promise.resolve({ code: 0, signal: null }),
    supervisorAttempts: 0,
    apiRetries: 0,
  };
}

describe("listControlRequests", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cp-ctl-"));
  });

  it("returns [] when dir does not exist", async () => {
    const r = await listControlRequests(path.join(tmp, "missing"));
    expect(r).toEqual([]);
  });

  it("parses <id>.<action> filenames", async () => {
    const dir = path.join(tmp, "c");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "phase-04.poke"), "");
    await writeFile(path.join(dir, "phase-05.retry"), "");
    await writeFile(path.join(dir, "ignored"), ""); // no dot → skipped
    const r = await listControlRequests(dir);
    expect(r.map((x) => `${x.id}.${x.action}`).sort()).toEqual([
      "phase-04.poke",
      "phase-05.retry",
    ]);
  });
});

describe("processControl", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cp-pc-"));
    await mkdir(path.join(tmp, "c"), { recursive: true });
  });

  function makeCtx(overrides: Partial<ControlContext> = {}): ControlContext {
    return {
      controlDir: path.join(tmp, "c"),
      readManifest: async () => ({
        status: "",
        phases: [{ id: "phase-04", state: "blocked", title: "", deps: [] }],
      }),
      running: new Map(),
      killWorker: async () => {},
      setState: async () => {},
      markResume: () => {},
      resetApiRetries: () => {},
      ...overrides,
    };
  }

  it("poke kills + re-pends a running worker", async () => {
    await writeFile(path.join(tmp, "c", "phase-04.poke"), "");
    const rec = makeRecord("phase-04");
    let killed = 0;
    let resumed = 0;
    const states: Array<[string, PhaseState]> = [];
    const ctx = makeCtx({
      running: new Map([["phase-04", rec]]),
      killWorker: async () => {
        killed++;
      },
      setState: async (id, s) => {
        states.push([id, s]);
      },
      markResume: () => {
        resumed++;
      },
    });
    await processControl(ctx);
    expect(killed).toBe(1);
    expect(resumed).toBe(1);
    expect(states).toEqual([["phase-04", "pending"]]);
    expect(await readdir(path.join(tmp, "c"))).toEqual([]);
  });

  it("poke for an unknown id is ignored (still consumed)", async () => {
    await writeFile(path.join(tmp, "c", "phase-09.poke"), "");
    let killed = 0;
    const ctx = makeCtx({
      killWorker: async () => {
        killed++;
      },
    });
    await processControl(ctx);
    expect(killed).toBe(0);
    expect(await readdir(path.join(tmp, "c"))).toEqual([]);
  });

  it("retry only flips state when blocked", async () => {
    await writeFile(path.join(tmp, "c", "phase-04.retry"), "");
    const states: Array<[string, PhaseState]> = [];
    const ctx = makeCtx({
      readManifest: async () => ({
        status: "",
        phases: [{ id: "phase-04", state: "blocked", title: "", deps: [] }],
      }),
      setState: async (id, s) => {
        states.push([id, s]);
      },
    });
    await processControl(ctx);
    expect(states).toEqual([["phase-04", "pending"]]);
  });

  it("retry on a running phase is logged + skipped", async () => {
    await writeFile(path.join(tmp, "c", "phase-04.retry"), "");
    const states: Array<[string, PhaseState]> = [];
    const ctx = makeCtx({
      readManifest: async () => ({
        status: "",
        phases: [{ id: "phase-04", state: "running", title: "", deps: [] }],
      }),
      setState: async (id, s) => {
        states.push([id, s]);
      },
    });
    await processControl(ctx);
    expect(states).toEqual([]);
  });

  it("unknown action is consumed without effect", async () => {
    await writeFile(path.join(tmp, "c", "phase-04.bogus"), "");
    let killed = 0;
    const ctx = makeCtx({
      killWorker: async () => {
        killed++;
      },
    });
    await processControl(ctx);
    expect(killed).toBe(0);
    expect(await readdir(path.join(tmp, "c"))).toEqual([]);
  });
});

describe("checkStuck", () => {
  it("no-op when stuckTimeout=0", async () => {
    let poked = 0;
    await checkStuck({
      stuckTimeout: 0,
      running: new Map([["phase-x", makeRecord("phase-x")]]),
      now: () => 100,
      statSize: async () => 0,
      poke: async () => {
        poked++;
      },
    });
    expect(poked).toBe(0);
  });

  it("resets baseline on first observation; does not poke", async () => {
    const rec = makeRecord("phase-x");
    let poked = 0;
    await checkStuck({
      stuckTimeout: 5,
      running: new Map([["phase-x", rec]]),
      now: () => 100,
      statSize: async () => 1024,
      poke: async () => {
        poked++;
      },
    });
    expect(poked).toBe(0);
    expect(rec.stuckSize).toBe(1024);
    expect(rec.stuckSince).toBe(100);
  });

  it("does not poke while size grows", async () => {
    const rec = makeRecord("phase-x");
    rec.stuckSize = 1024;
    rec.stuckSince = 100;
    let poked = 0;
    await checkStuck({
      stuckTimeout: 5,
      running: new Map([["phase-x", rec]]),
      now: () => 110,
      statSize: async () => 2048,
      poke: async () => {
        poked++;
      },
    });
    expect(poked).toBe(0);
    expect(rec.stuckSize).toBe(2048);
    expect(rec.stuckSince).toBe(110);
  });

  it("pokes once stuckSince + timeout has passed", async () => {
    const rec = makeRecord("phase-x");
    rec.stuckSize = 1024;
    rec.stuckSince = 100;
    let poked = 0;
    let reason = "";
    await checkStuck({
      stuckTimeout: 5,
      running: new Map([["phase-x", rec]]),
      now: () => 110,
      statSize: async () => 1024,
      poke: async (_id, _rec, r) => {
        poked++;
        reason = r;
      },
    });
    expect(poked).toBe(1);
    expect(reason).toMatch(/STUCK: no stream output for 5s/);
  });
});
