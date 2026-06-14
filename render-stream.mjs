#!/usr/bin/env node
//
// claudopilot/render-stream.mjs — turn a `claude -p --output-format stream-json`
// NDJSON event stream (on stdin) into a human-readable transcript (on stdout),
// like what you'd see in the chat window: assistant text, thinking, the tool
// calls it made and their (truncated) results, and the final result summary.
//
// Used in run-loop.sh as:
//   claude ... --output-format stream-json | tee raw.jsonl | node render-stream.mjs | tee transcript.md
//
// The raw .jsonl is the full-fidelity artifact; this is the readable view of it.
// It is intentionally tolerant: malformed/unknown lines are skipped, never fatal,
// and it always exits 0 so it can't break the worker pipeline (pipefail-safe).

import { createInterface } from "node:readline";

const MAX_TEXT = 12000; // cap a single text/thinking block
const MAX_TOOL_INPUT = 1200; // cap a tool-call input dump
const MAX_TOOL_RESULT = 1600; // cap a tool-result dump

const trunc = (s, n) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + `\n  ... [truncated ${s.length - n} chars]` : s;
};
const out = (s = "") => {
  try {
    process.stdout.write(s + "\n");
  } catch {
    /* EPIPE — downstream closed; ignore */
  }
};
const indent = (s, pad = "  ") => String(s).split("\n").map((l) => pad + l).join("\n");

function renderToolInput(input) {
  let s;
  try {
    s = JSON.stringify(input, null, 2);
  } catch {
    s = String(input);
  }
  // collapse very long single-field dumps (file bodies etc.) but keep shape
  return trunc(s, MAX_TOOL_INPUT);
}

function renderToolResult(content) {
  if (content == null) return "";
  if (typeof content === "string") return trunc(content, MAX_TOOL_RESULT);
  if (Array.isArray(content)) {
    return trunc(
      content
        .map((c) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c)))
        .join("\n"),
      MAX_TOOL_RESULT,
    );
  }
  return trunc(content?.text ?? JSON.stringify(content), MAX_TOOL_RESULT);
}

function handle(ev) {
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") {
        const tools = Array.isArray(ev.tools) ? ev.tools.length : "?";
        out(`=== session ${ev.session_id ?? ""} | model ${ev.model ?? "?"} | tools ${tools} | cwd ${ev.cwd ?? ""} ===`);
        out();
      }
      break;
    case "assistant":
    case "user": {
      const msg = ev.message ?? {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        switch (b.type) {
          case "text":
            if (b.text?.trim()) {
              out(`[${ev.type}]`);
              out(trunc(b.text.trimEnd(), MAX_TEXT));
              out();
            }
            break;
          case "thinking":
            if (b.thinking?.trim()) {
              out(`[thinking]`);
              out(indent(trunc(b.thinking.trimEnd(), MAX_TEXT)));
              out();
            }
            break;
          case "tool_use":
            out(`-> tool: ${b.name}`);
            out(indent(renderToolInput(b.input), "     "));
            out();
            break;
          case "tool_result": {
            const r = renderToolResult(b.content);
            out(`<- result${b.is_error ? " (error)" : ""}:`);
            if (r.trim()) out(indent(r, "     "));
            out();
            break;
          }
          default:
            break; // unknown block type — skip
        }
      }
      break;
    }
    case "result": {
      const bits = [
        ev.subtype && `subtype=${ev.subtype}`,
        ev.is_error != null && `is_error=${ev.is_error}`,
        ev.num_turns != null && `turns=${ev.num_turns}`,
        ev.duration_ms != null && `duration=${Math.round(ev.duration_ms / 1000)}s`,
        ev.total_cost_usd != null && `cost=$${Number(ev.total_cost_usd).toFixed(4)}`,
      ].filter(Boolean);
      out(`=== result: ${bits.join(" | ")} ===`);
      break;
    }
    default:
      break; // stream_event partials and anything else — skip for the transcript
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let ev;
  try {
    ev = JSON.parse(t);
  } catch {
    return; // not a JSON event line — skip
  }
  try {
    handle(ev);
  } catch {
    /* never let a render error break the pipeline */
  }
});
rl.on("close", () => process.exit(0));
process.stdout.on("error", () => process.exit(0)); // EPIPE
