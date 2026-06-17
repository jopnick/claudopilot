import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  captureAgent,
  buildClaudeArgs,
  buildOpencodeArgs,
} from "./capture.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "captureAgent-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function paths(): { log: string; stream: string; transcript: string } {
  return {
    log: join(dir, "x.log"),
    stream: join(dir, "x.stream.jsonl"),
    transcript: join(dir, "x.transcript.md"),
  };
}

/**
 * Build a fake `claude` invocation that ignores its argv and emits a small
 * canned NDJSON stream. We do this by replacing the spawn function — the
 * captureAgent under test routes through the injected spawner.
 */
function fakeSpawner(events: unknown[], exitCode = 0, stderr = "") {
  const ndjson = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const script = `
    const out = ${JSON.stringify(ndjson)};
    const err = ${JSON.stringify(stderr)};
    if (err) process.stderr.write(err);
    process.stdout.write(out, () => process.exit(${exitCode}));
  `;
  return ((_cmd: string, _args: readonly string[], opts: unknown) =>
    spawn(process.execPath, ["-e", script], opts as never)) as typeof spawn;
}

describe("buildClaudeArgs", () => {
  it("fresh run passes -p only", () => {
    const args = buildClaudeArgs("hi");
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("hi");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
    expect(args).toContain("stream-json");
  });
  it("resume run prepends --resume <sid>", () => {
    const args = buildClaudeArgs("nudge", "sid-42");
    expect(args.slice(0, 4)).toEqual(["--resume", "sid-42", "-p", "nudge"]);
  });
});

describe("buildOpencodeArgs", () => {
  it("includes model when set", () => {
    expect(buildOpencodeArgs("hi", "claude-opus-4-7")).toEqual([
      "run",
      "hi",
      "-m",
      "claude-opus-4-7",
      "--format",
      "json",
      "--dangerously-skip-permissions",
    ]);
  });
  it("omits model when empty", () => {
    expect(buildOpencodeArgs("hi")).toEqual([
      "run",
      "hi",
      "--format",
      "json",
      "--dangerously-skip-permissions",
    ]);
  });
});

describe("captureAgent (claude driver)", () => {
  it("tees raw stream + rendered transcript + log, returns exit code", async () => {
    const ev = [
      {
        type: "system",
        subtype: "init",
        session_id: "sid",
        model: "m",
        tools: [],
        cwd: "/",
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      },
      { type: "result", subtype: "success", num_turns: 1 },
    ];
    const p = paths();
    const r = await captureAgent({
      driver: "claude",
      id: "phase-x",
      prompt: "hi",
      cwd: dir,
      paths: p,
      spawn: fakeSpawner(ev, 0, "[stderr-line]\n"),
    });
    expect(r.code).toBe(0);
    const stream = readFileSync(p.stream, "utf8");
    const transcript = readFileSync(p.transcript, "utf8");
    const log = readFileSync(p.log, "utf8");
    expect(stream).toContain('"session_id":"sid"');
    expect(transcript).toContain("[assistant]\nhi");
    expect(transcript).toContain("=== [phase-x] run");
    expect(log).toContain("[stderr-line]");
    expect(log).toContain("[assistant]\nhi");
  });

  it("propagates non-zero exit codes without throwing", async () => {
    const r = await captureAgent({
      driver: "claude",
      id: "phase-x",
      prompt: "hi",
      cwd: dir,
      paths: paths(),
      spawn: fakeSpawner([], 7),
    });
    expect(r.code).toBe(7);
  });

  it("appends rather than truncating on a second attempt", async () => {
    const ev = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "first" }] },
      },
    ];
    const p = paths();
    await captureAgent({
      driver: "claude",
      id: "p",
      prompt: "x",
      cwd: dir,
      paths: p,
      spawn: fakeSpawner(ev),
      attempt: 0,
    });
    const ev2 = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "second" }] },
      },
    ];
    await captureAgent({
      driver: "claude",
      id: "p",
      prompt: "x",
      cwd: dir,
      paths: p,
      spawn: fakeSpawner(ev2),
      attempt: 1,
    });
    const transcript = readFileSync(p.transcript, "utf8");
    expect(transcript).toContain("first");
    expect(transcript).toContain("second");
    expect(transcript).toContain("attempt 0");
    expect(transcript).toContain("attempt 1");
  });

  it("renders supervisor banner + resume tag", async () => {
    const p = paths();
    await captureAgent({
      driver: "claude",
      id: "p",
      prompt: "x",
      cwd: dir,
      paths: p,
      spawn: fakeSpawner([]),
      supervisorMode: true,
      resumeSid: "sid-9",
    });
    const t = readFileSync(p.transcript, "utf8");
    expect(t).toContain("supervisor run");
    expect(t).toContain("resume=sid-9");
  });

  it("rejects if the binary fails to spawn", async () => {
    await expect(
      captureAgent({
        driver: "claude",
        id: "p",
        prompt: "x",
        cwd: dir,
        paths: paths(),
        spawn: ((_c: string, _a: readonly string[], opts: unknown) =>
          spawn(
            "definitely-not-a-real-bin-xyz",
            [],
            opts as never,
          )) as typeof spawn,
      }),
    ).rejects.toBeDefined();
  });
});

describe("captureAgent (opencode driver)", () => {
  it("renders opencode events through the opencode renderer", async () => {
    const ev = [
      { type: "step_start", sessionID: "ses", part: { type: "step-start" } },
      { type: "text", part: { type: "text", text: "hello" } },
      {
        type: "step_finish",
        part: { reason: "end_turn", tokens: { input: 1, output: 1 } },
      },
    ];
    const p = paths();
    const r = await captureAgent({
      driver: "opencode",
      id: "p",
      prompt: "x",
      cwd: dir,
      paths: p,
      spawn: fakeSpawner(ev),
    });
    expect(r.code).toBe(0);
    const t = readFileSync(p.transcript, "utf8");
    expect(t).toContain("opencode session ses");
    expect(t).toContain("[assistant]\nhello");
  });
});
