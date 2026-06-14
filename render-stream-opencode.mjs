#!/usr/bin/env node
//
// claudopilot/render-stream-opencode.mjs — turn an `opencode run --format json`
// NDJSON event stream (on stdin) into the SAME human-readable transcript that
// render-stream.mjs produces for Claude Code. Emitting identical markers
// ([assistant] / [thinking] / -> tool / <- result / === … ===) means the
// dashboard transcript parser (web/transcript.mjs) and progress.mjs work
// unchanged regardless of which agent driver ran.
//
// Used by run-loop.sh when AGENT_DRIVER=opencode:
//   opencode run "$prompt" -m "$AGENT_MODEL" --format json --dangerously-skip-permissions \
//     | tee raw.jsonl | node render-stream-opencode.mjs | tee transcript.md
//
// OpenCode event shapes (one JSON object per line):
//   { type:"step_start",  part:{ type:"step-start", … } }
//   { type:"text",        part:{ type:"text", text:"…" } }
//   { type:"reasoning",   part:{ text:"…" } }                      (model-dependent)
//   { type:"tool_use",    part:{ type:"tool", tool:"bash",
//                                 state:{ status, input:{…}, output:"…",
//                                         metadata:{ exit }, … } } }
//   { type:"step_finish", part:{ reason, cost, tokens:{…} } }
//   { type:"error",       error:{ name, data:{ message } } }
//
// Tolerant by design: unknown/malformed lines are skipped, never fatal; always
// exits 0 so it can't break the worker pipeline (pipefail-safe).

import { createInterface } from "node:readline";

const MAX_TEXT = 12000;
const MAX_TOOL_INPUT = 1200;
const MAX_TOOL_RESULT = 1600;

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
    s = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  } catch {
    s = String(input);
  }
  return trunc(s, MAX_TOOL_INPUT);
}

function renderToolOutput(output) {
  if (output == null) return "";
  if (typeof output === "string") return trunc(output, MAX_TOOL_RESULT);
  try {
    return trunc(JSON.stringify(output), MAX_TOOL_RESULT);
  } catch {
    return trunc(String(output), MAX_TOOL_RESULT);
  }
}

let sawHeader = false;
function handle(ev) {
  const part = ev.part ?? {};
  switch (ev.type) {
    case "step_start":
      if (!sawHeader) {
        sawHeader = true;
        out(`=== opencode session ${ev.sessionID ?? ""} | driver opencode ===`);
        out();
      }
      break;

    case "reasoning": {
      const t = part.text ?? ev.text;
      if (t && String(t).trim()) {
        out(`[thinking]`);
        out(indent(trunc(String(t).trimEnd(), MAX_TEXT)));
        out();
      }
      break;
    }

    case "text": {
      const t = part.text ?? ev.text;
      if (t && String(t).trim()) {
        out(`[assistant]`);
        out(trunc(String(t).trimEnd(), MAX_TEXT));
        out();
      }
      break;
    }

    case "tool_use": {
      const name = part.tool ?? "tool";
      const state = part.state ?? {};
      out(`-> tool: ${name}`);
      if (state.input != null) out(indent(renderToolInput(state.input), "     "));
      out();
      const isErr = state.status === "error" || (state.metadata && state.metadata.exit && state.metadata.exit !== 0);
      const result = renderToolOutput(state.output ?? state.error ?? "");
      out(`<- result${isErr ? " (error)" : ""}:`);
      if (result.trim()) out(indent(result, "     "));
      out();
      break;
    }

    case "step_finish": {
      const tok = part.tokens ?? {};
      const bits = [
        part.reason && `reason=${part.reason}`,
        part.cost != null && `cost=$${Number(part.cost).toFixed(4)}`,
        (tok.input != null || tok.output != null) && `tokens=${tok.input ?? "?"}/${tok.output ?? "?"}`,
      ].filter(Boolean);
      out(`=== result: ${bits.join(" | ")} ===`);
      break;
    }

    case "error": {
      const e = ev.error ?? {};
      const msg = e.data?.message ?? e.message ?? "";
      out(`<- result (error):`);
      out(indent(trunc(`${e.name ?? "error"}: ${msg}`, MAX_TOOL_RESULT), "     "));
      out();
      break;
    }

    default:
      break; // unknown event — skip
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
