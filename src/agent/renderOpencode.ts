/**
 * In-process port of `render-stream-opencode.mjs`. Maps `opencode run
 * --format json` events to the SAME transcript markers as `render.ts` so
 * downstream consumers (`web/transcript.mjs`, `progress.mjs`) work
 * unchanged regardless of which agent driver produced the stream.
 *
 * Tolerant: malformed / unknown events are skipped, never thrown.
 */

import { indent, MAX_TEXT, MAX_TOOL_INPUT, MAX_TOOL_RESULT, trunc } from "./render.js";

interface OpencodeEvent {
  type?: string;
  part?: Record<string, unknown>;
  text?: string;
  sessionID?: string;
  error?: { name?: string; message?: string; data?: { message?: string } };
}

function renderToolInput(input: unknown): string {
  let s: string;
  try {
    s = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  } catch {
    s = String(input);
  }
  return trunc(s, MAX_TOOL_INPUT);
}

function renderToolOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return trunc(output, MAX_TOOL_RESULT);
  try {
    return trunc(JSON.stringify(output), MAX_TOOL_RESULT);
  } catch {
    return trunc(String(output), MAX_TOOL_RESULT);
  }
}

/**
 * Single-shot opencode event → transcript lines. Stateless in itself, but
 * the streaming wrapper tracks whether the session header has been emitted.
 */
export function renderOpencodeEvent(
  ev: OpencodeEvent,
  state: { sawHeader: boolean },
): string[] {
  const lines: string[] = [];
  const push = (s = ""): void => {
    lines.push(s);
  };
  const part = (ev.part ?? {}) as Record<string, unknown>;

  switch (ev.type) {
    case "step_start": {
      if (!state.sawHeader) {
        state.sawHeader = true;
        push(`=== opencode session ${ev.sessionID ?? ""} | driver opencode ===`);
        push();
      }
      break;
    }
    case "reasoning": {
      const t = (part.text as string | undefined) ?? ev.text;
      if (t && String(t).trim()) {
        push(`[thinking]`);
        push(indent(trunc(String(t).trimEnd(), MAX_TEXT)));
        push();
      }
      break;
    }
    case "text": {
      const t = (part.text as string | undefined) ?? ev.text;
      if (t && String(t).trim()) {
        push(`[assistant]`);
        push(trunc(String(t).trimEnd(), MAX_TEXT));
        push();
      }
      break;
    }
    case "tool_use": {
      const name = (part.tool as string | undefined) ?? "tool";
      const stateBlock = (part.state as Record<string, unknown> | undefined) ?? {};
      push(`-> tool: ${name}`);
      if (stateBlock.input != null) {
        push(indent(renderToolInput(stateBlock.input), "     "));
      }
      push();
      const status = stateBlock.status as string | undefined;
      const metadata = stateBlock.metadata as
        | { exit?: number | undefined }
        | undefined;
      const isErr =
        status === "error" ||
        Boolean(metadata && metadata.exit && metadata.exit !== 0);
      const result = renderToolOutput(stateBlock.output ?? stateBlock.error ?? "");
      push(`<- result${isErr ? " (error)" : ""}:`);
      if (result.trim()) push(indent(result, "     "));
      push();
      break;
    }
    case "step_finish": {
      const tok = (part.tokens as { input?: number; output?: number } | undefined) ?? {};
      const cost = part.cost;
      const reason = part.reason;
      const bits = [
        reason != null && `reason=${reason}`,
        cost != null && `cost=$${Number(cost).toFixed(4)}`,
        (tok.input != null || tok.output != null) &&
          `tokens=${tok.input ?? "?"}/${tok.output ?? "?"}`,
      ].filter(Boolean);
      push(`=== result: ${bits.join(" | ")} ===`);
      break;
    }
    case "error": {
      const e = ev.error ?? {};
      const msg = e.data?.message ?? e.message ?? "";
      push(`<- result (error):`);
      push(indent(trunc(`${e.name ?? "error"}: ${msg}`, MAX_TOOL_RESULT), "     "));
      push();
      break;
    }
    default:
      break;
  }
  return lines;
}

/**
 * Incremental NDJSON stream of opencode events → transcript text. Same
 * interface as `RenderStream` in `render.ts`.
 */
export class OpencodeRenderStream {
  private buf = "";
  private state = { sawHeader: false };
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

  end(): void {
    if (this.buf.length > 0) {
      this.handleLine(this.buf);
      this.buf = "";
    }
  }

  private handleLine(raw: string): void {
    const t = raw.trim();
    if (!t) return;
    let ev: OpencodeEvent;
    try {
      ev = JSON.parse(t) as OpencodeEvent;
    } catch {
      return;
    }
    let out: string[];
    try {
      out = renderOpencodeEvent(ev, this.state);
    } catch {
      return;
    }
    if (out.length === 0) return;
    this.onText(out.join("\n") + "\n");
  }
}

export function renderOpencodeTranscript(ndjson: string): string {
  let result = "";
  const rs = new OpencodeRenderStream((chunk) => {
    result += chunk;
  });
  rs.push(ndjson);
  rs.end();
  return result;
}
