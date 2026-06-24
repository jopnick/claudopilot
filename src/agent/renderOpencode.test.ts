import { describe, it, expect } from "vitest";
import {
  renderOpencodeEvent,
  renderOpencodeTranscript,
  OpencodeRenderStream,
} from "./renderOpencode.js";

function ndjson(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("renderOpencodeEvent", () => {
  it("emits header on the first step_start only", () => {
    const state = { sawHeader: false };
    const out1 = renderOpencodeEvent(
      { type: "step_start", sessionID: "sid", part: { type: "step-start" } },
      state,
    );
    expect(out1[0]).toBe("=== opencode session sid | driver opencode ===");
    const out2 = renderOpencodeEvent(
      { type: "step_start", sessionID: "sid", part: { type: "step-start" } },
      state,
    );
    expect(out2).toEqual([]);
  });

  it("renders text as [assistant]", () => {
    const out = renderOpencodeEvent(
      { type: "text", part: { type: "text", text: "hi" } },
      { sawHeader: true },
    );
    expect(out).toEqual(["[assistant]", "hi", ""]);
  });

  it("renders reasoning as [thinking]", () => {
    const out = renderOpencodeEvent(
      { type: "reasoning", part: { text: "ponder" } },
      { sawHeader: true },
    );
    expect(out).toEqual(["[thinking]", "  ponder", ""]);
  });

  it("renders tool_use with input and output", () => {
    const out = renderOpencodeEvent(
      {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "a\nb",
            metadata: { exit: 0 },
          },
        },
      },
      { sawHeader: true },
    );
    expect(out[0]).toBe("-> tool: bash");
    expect(out[1]).toContain('"command"');
    expect(out.join("\n")).toContain("<- result:");
    expect(out.join("\n")).toContain("a\nb".replace(/\n/g, "\n     "));
  });

  it("marks tool errors", () => {
    const out = renderOpencodeEvent(
      {
        type: "tool_use",
        part: {
          tool: "bash",
          state: { status: "error", input: { cmd: "x" }, output: "boom" },
        },
      },
      { sawHeader: true },
    );
    expect(out.join("\n")).toContain("<- result (error):");
  });

  it("marks exit-nonzero tools as errors", () => {
    const out = renderOpencodeEvent(
      {
        type: "tool_use",
        part: {
          tool: "bash",
          state: {
            status: "completed",
            input: { cmd: "x" },
            output: "boom",
            metadata: { exit: 2 },
          },
        },
      },
      { sawHeader: true },
    );
    expect(out.join("\n")).toContain("<- result (error):");
  });

  it("renders step_finish summary", () => {
    const out = renderOpencodeEvent(
      {
        type: "step_finish",
        part: {
          reason: "end_turn",
          cost: 0.0123,
          tokens: { input: 100, output: 50 },
        },
      },
      { sawHeader: true },
    );
    expect(out[0]).toBe(
      "=== result: reason=end_turn | cost=$0.0123 | tokens=100/50 ===",
    );
  });

  it("renders error events", () => {
    const out = renderOpencodeEvent(
      { type: "error", error: { name: "APIError", data: { message: "boom" } } },
      { sawHeader: true },
    );
    expect(out[0]).toBe("<- result (error):");
    expect(out[1]).toContain("APIError: boom");
  });

  it("skips unknown event types", () => {
    expect(renderOpencodeEvent({ type: "weird" }, { sawHeader: true })).toEqual(
      [],
    );
  });
});

describe("OpencodeRenderStream", () => {
  it("parses across chunk boundaries", () => {
    let out = "";
    const rs = new OpencodeRenderStream((s) => {
      out += s;
    });
    const ev =
      JSON.stringify({ type: "text", part: { text: "hello" } }) + "\n";
    rs.push(ev.slice(0, 5));
    rs.push(ev.slice(5));
    rs.end();
    expect(out).toContain("[assistant]\nhello\n");
  });

  it("skips malformed JSON silently", () => {
    let out = "";
    const rs = new OpencodeRenderStream((s) => {
      out += s;
    });
    rs.push("garbage\n");
    rs.push(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\n");
    rs.end();
    expect(out).toContain("ok");
  });
});

describe("golden: representative session", () => {
  it("renders a full session deterministically", () => {
    const events = [
      {
        type: "step_start",
        sessionID: "ses-1",
        part: { type: "step-start" },
      },
      { type: "reasoning", part: { text: "thinking\nmore" } },
      { type: "text", part: { type: "text", text: "Hello." } },
      {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "a.txt\nb.txt",
            metadata: { exit: 0 },
          },
        },
      },
      {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "bash",
          state: {
            status: "error",
            input: { command: "false" },
            output: "exit 1",
            metadata: { exit: 1 },
          },
        },
      },
      {
        type: "step_finish",
        part: {
          reason: "end_turn",
          cost: 0.005,
          tokens: { input: 10, output: 5 },
        },
      },
      {
        type: "error",
        error: { name: "APIError", data: { message: "overloaded" } },
      },
      { type: "unknown_event" },
    ];
    const input = ndjson(events) + "not-json\n";
    const ts = renderOpencodeTranscript(input);
    expect(ts).toMatchInlineSnapshot(`
      "=== opencode session ses-1 | driver opencode ===

      [thinking]
        thinking
        more

      [assistant]
      Hello.

      -> tool: bash
           {
             "command": "ls"
           }

      <- result:
           a.txt
           b.txt

      -> tool: bash
           {
             "command": "false"
           }

      <- result (error):
           exit 1

      === result: reason=end_turn | cost=$0.0050 | tokens=10/5 ===
      <- result (error):
           APIError: overloaded

      "
    `);
  });
});
