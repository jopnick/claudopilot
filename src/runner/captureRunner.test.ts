import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeCaptureRunner } from "./captureRunner.js";
import type { WorkerCapturePaths } from "./workerEntry.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "captureRunner-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function paths(): WorkerCapturePaths {
  return {
    log: join(dir, "p.log"),
    stream: join(dir, "p.stream.jsonl"),
    transcript: join(dir, "p.transcript.md"),
    prompt: join(dir, "p.prompt.txt"),
  };
}

/** Fake agent: ignores argv, emits canned NDJSON, exits with `exitCode`. */
function fakeSpawner(events: unknown[], exitCode = 0): typeof spawn {
  const ndjson = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const script = `process.stdout.write(${JSON.stringify(ndjson)}, () => process.exit(${exitCode}));`;
  return ((_cmd: string, _args: readonly string[], opts: unknown) =>
    spawn(process.execPath, ["-e", script], opts as never)) as typeof spawn;
}

describe("makeCaptureRunner", () => {
  it("runFresh runs the agent and returns its exit code", async () => {
    const runner = makeCaptureRunner(
      { AGENT_DRIVER: "claude" },
      fakeSpawner([{ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }], 0),
    );
    const code = await runner.runFresh({
      phaseId: "phase-01",
      prompt: "do the thing",
      paths: paths(),
      workdir: dir,
    });
    expect(code).toBe(0);
    // The rendered assistant text reached the transcript.
    expect(readFileSync(join(dir, "p.transcript.md"), "utf8")).toContain("hi");
  });

  it("propagates a non-zero agent exit code", async () => {
    const runner = makeCaptureRunner({ AGENT_DRIVER: "claude" }, fakeSpawner([], 7));
    const code = await runner.runFresh({
      phaseId: "phase-02",
      prompt: "x",
      paths: paths(),
      workdir: dir,
    });
    expect(code).toBe(7);
  });

  it("runResume passes the resume nudge through and returns the exit code", async () => {
    const runner = makeCaptureRunner({ AGENT_DRIVER: "claude" }, fakeSpawner([], 0));
    const code = await runner.runResume({
      phaseId: "phase-03",
      sessionId: "sid-42",
      resumeMessage: "resume now",
      paths: paths(),
      workdir: dir,
    });
    expect(code).toBe(0);
    // Resume runs still write a transcript banner for the attempt.
    expect(readFileSync(join(dir, "p.transcript.md"), "utf8")).toContain("[phase-03]");
  });
});
