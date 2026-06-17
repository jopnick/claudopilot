import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderEvent, renderTranscript, RenderStream, trunc } from "./render.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

function ndjson(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** Pipe NDJSON through the legacy mjs renderer for byte-for-byte parity. */
function bashRender(input: string, script: string): string {
  const r = spawnSync(process.execPath, [resolve(REPO_ROOT, script)], {
    input,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`renderer exit ${r.status}: ${r.stderr}`);
  return r.stdout;
}

describe("renderEvent", () => {
  it("renders a system init header", () => {
    const out = renderEvent({
      type: "system",
      subtype: "init",
      session_id: "sid-1",
      model: "claude-opus-4-7",
      tools: ["a", "b"],
      cwd: "/work",
    });
    expect(out[0]).toBe(
      "=== session sid-1 | model claude-opus-4-7 | tools 2 | cwd /work ===",
    );
    expect(out[1]).toBe("");
  });

  it("renders assistant text", () => {
    const out = renderEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello world" }] },
    });
    expect(out).toEqual(["[assistant]", "hello world", ""]);
  });

  it("renders thinking indented", () => {
    const out = renderEvent({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "line1\nline2" }],
      },
    });
    expect(out).toEqual(["[thinking]", "  line1\n  line2", ""]);
  });

  it("renders tool_use with JSON-formatted input", () => {
    const out = renderEvent({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "bash", input: { cmd: "ls" } },
        ],
      },
    });
    expect(out[0]).toBe("-> tool: bash");
    expect(out[1]).toContain('"cmd"');
    expect(out[1]!.split("\n").every((l) => l.startsWith("     "))).toBe(true);
  });

  it("renders tool_result with error flag", () => {
    const out = renderEvent({
      type: "user",
      message: {
        content: [
          { type: "tool_result", is_error: true, content: "oops" },
        ],
      },
    });
    expect(out[0]).toBe("<- result (error):");
    expect(out[1]).toBe("     oops");
  });

  it("renders result tail", () => {
    const out = renderEvent({
      type: "result",
      subtype: "success",
      num_turns: 3,
      duration_ms: 12500,
      total_cost_usd: 0.1234,
    });
    expect(out[0]).toBe(
      "=== result: subtype=success | turns=3 | duration=13s | cost=$0.1234 ===",
    );
  });

  it("skips unknown event types", () => {
    expect(renderEvent({ type: "stream_event" } as never)).toEqual([]);
  });

  it("skips empty text blocks", () => {
    const out = renderEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "   " }] },
    });
    expect(out).toEqual([]);
  });

  it("truncates long text", () => {
    const big = "x".repeat(20000);
    const out = renderEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: big }] },
    });
    expect(out[1]?.includes("[truncated")).toBe(true);
  });
});

describe("trunc", () => {
  it("passes short strings through", () => {
    expect(trunc("hi", 100)).toBe("hi");
  });
  it("appends a truncation tag", () => {
    expect(trunc("abcdef", 3)).toBe("abc\n  ... [truncated 3 chars]");
  });
  it("stringifies non-strings", () => {
    expect(trunc(null, 10)).toBe("");
    expect(trunc(42, 10)).toBe("42");
  });
});

describe("RenderStream incremental parsing", () => {
  it("handles chunk boundaries mid-line", () => {
    let out = "";
    const rs = new RenderStream((s) => {
      out += s;
    });
    const ev = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    rs.push(ev.slice(0, 10));
    rs.push(ev.slice(10) + "\n");
    rs.end();
    expect(out).toContain("[assistant]\nhi\n");
  });

  it("skips malformed JSON lines silently", () => {
    let out = "";
    const rs = new RenderStream((s) => {
      out += s;
    });
    rs.push("not-json\n");
    rs.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }) + "\n",
    );
    rs.end();
    expect(out).toContain("ok");
    expect(out).not.toContain("not-json");
  });

  it("flushes a trailing line without newline on end()", () => {
    let out = "";
    const rs = new RenderStream((s) => {
      out += s;
    });
    rs.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "tail" }] },
      }),
    );
    rs.end();
    expect(out).toContain("tail");
  });
});

describe("parity with render-stream.mjs (golden)", () => {
  it("matches byte-for-byte on a representative session", () => {
    const events = [
      {
        type: "system",
        subtype: "init",
        session_id: "abc",
        model: "claude-opus-4-7",
        tools: ["Bash", "Read"],
        cwd: "/work",
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "let me think\nand reason" },
            { type: "text", text: "Hello." },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "ls", description: "list" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              is_error: false,
              content: [{ type: "text", text: "a.txt\nb.txt" }],
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "false" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              is_error: true,
              content: "exit 1",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        duration_ms: 4321,
        total_cost_usd: 0.0567,
      },
      // Unknown event types and a malformed line are tolerated.
      { type: "stream_event", whatever: 1 },
    ];
    const input = ndjson(events) + "not-json\n";
    const ts = renderTranscript(input);
    const bash = bashRender(input, "render-stream.mjs");
    expect(ts).toBe(bash);
  });
});
