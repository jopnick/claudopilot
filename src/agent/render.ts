/**
 * In-process port of `render-stream.mjs`. Turns Claude Code `claude -p
 * --output-format stream-json` NDJSON events into the human-readable
 * transcript markers consumed by `web/transcript.mjs` and `progress.mjs`.
 *
 * Pure: no I/O, no process state. Bash pipeline equivalent was
 *   claude … | tee raw.jsonl | node render-stream.mjs | tee transcript.md
 * which we collapse into a `RenderStream` that buffers NDJSON bytes and
 * emits rendered transcript lines. Tolerant by design — malformed JSON
 * and unknown block/event types are silently skipped.
 */

import type {
  AgentEvent,
  AgentMessageEvent,
  AgentResultEvent,
  AgentSystemEvent,
  AgentContentBlock,
} from "../types.js";

export const MAX_TEXT = 12000;
export const MAX_TOOL_INPUT = 1200;
export const MAX_TOOL_RESULT = 1600;

export function trunc(s: unknown, n: number): string {
  const str = String(s ?? "");
  return str.length > n
    ? str.slice(0, n) + `\n  ... [truncated ${str.length - n} chars]`
    : str;
}

export function indent(s: string, pad = "  "): string {
  return String(s)
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function renderToolInput(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input, null, 2);
  } catch {
    s = String(input);
  }
  return trunc(s, MAX_TOOL_INPUT);
}

function renderToolResult(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return trunc(content, MAX_TOOL_RESULT);
  if (Array.isArray(content)) {
    return trunc(
      content
        .map((c) =>
          typeof c === "string"
            ? c
            : (c as { text?: string })?.text ?? JSON.stringify(c),
        )
        .join("\n"),
      MAX_TOOL_RESULT,
    );
  }
  const obj = content as { text?: string };
  return trunc(obj.text ?? JSON.stringify(content), MAX_TOOL_RESULT);
}

/**
 * Render one parsed stream-json event to its transcript lines. Returns
 * an array of lines (no trailing newlines); join with "\n". An empty
 * string entry represents a blank separator line.
 */
export function renderEvent(ev: AgentEvent): string[] {
  const lines: string[] = [];
  const push = (s = ""): void => {
    lines.push(s);
  };

  switch (ev.type) {
    case "system": {
      const sys = ev as AgentSystemEvent;
      if (sys.subtype === "init") {
        const tools = Array.isArray(sys.tools) ? sys.tools.length : "?";
        push(
          `=== session ${sys.session_id ?? ""} | model ${sys.model ?? "?"} | tools ${tools} | cwd ${sys.cwd ?? ""} ===`,
        );
        push();
      }
      break;
    }
    case "assistant":
    case "user": {
      const msg = (ev as AgentMessageEvent).message ?? {};
      const blocks: AgentContentBlock[] = Array.isArray(msg.content)
        ? msg.content
        : [];
      for (const b of blocks) {
        switch (b.type) {
          case "text": {
            const t = (b as { text?: string }).text;
            if (t && t.trim()) {
              push(`[${ev.type}]`);
              push(trunc(t.trimEnd(), MAX_TEXT));
              push();
            }
            break;
          }
          case "thinking": {
            const t = (b as { thinking?: string }).thinking;
            if (t && t.trim()) {
              push(`[thinking]`);
              push(indent(trunc(t.trimEnd(), MAX_TEXT)));
              push();
            }
            break;
          }
          case "tool_use": {
            const tu = b as { name?: string; input?: unknown };
            push(`-> tool: ${tu.name}`);
            push(indent(renderToolInput(tu.input), "     "));
            push();
            break;
          }
          case "tool_result": {
            const tr = b as { content?: unknown; is_error?: boolean };
            const r = renderToolResult(tr.content);
            push(`<- result${tr.is_error ? " (error)" : ""}:`);
            if (r.trim()) push(indent(r, "     "));
            push();
            break;
          }
          default:
            break;
        }
      }
      break;
    }
    case "result": {
      const r = ev as AgentResultEvent;
      const bits = [
        r.subtype && `subtype=${r.subtype}`,
        r.is_error != null && `is_error=${r.is_error}`,
        r.num_turns != null && `turns=${r.num_turns}`,
        r.duration_ms != null && `duration=${Math.round(r.duration_ms / 1000)}s`,
        r.total_cost_usd != null &&
          `cost=$${Number(r.total_cost_usd).toFixed(4)}`,
      ].filter(Boolean);
      push(`=== result: ${bits.join(" | ")} ===`);
      break;
    }
    default:
      break;
  }
  return lines;
}

/**
 * Incremental NDJSON → transcript renderer. Feed UTF-8 chunks via `push`;
 * each completed line is parsed (tolerantly) and routed through
 * `renderEvent`. The accumulated transcript text is delivered via the
 * `onText` callback in renderer-output chunks (one per source event), so
 * callers can tee to a file/stream without buffering the whole run.
 */
export class RenderStream {
  private buf = "";
  constructor(private readonly onText: (chunk: string) => void) {}

  push(chunk: string | Buffer): void {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const raw = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.handleLine(raw);
    }
  }

  /** Flush any trailing partial line (treat the leftover as a final line). */
  end(): void {
    if (this.buf.length > 0) {
      this.handleLine(this.buf);
      this.buf = "";
    }
  }

  private handleLine(raw: string): void {
    const t = raw.trim();
    if (!t) return;
    let ev: AgentEvent;
    try {
      ev = JSON.parse(t) as AgentEvent;
    } catch {
      return;
    }
    let out: string[];
    try {
      out = renderEvent(ev);
    } catch {
      return;
    }
    if (out.length === 0) return;
    this.onText(out.join("\n") + "\n");
  }
}

/** Render a full NDJSON string to its transcript. Convenience for tests. */
export function renderTranscript(ndjson: string): string {
  let result = "";
  const rs = new RenderStream((chunk) => {
    result += chunk;
  });
  rs.push(ndjson);
  rs.end();
  return result;
}
