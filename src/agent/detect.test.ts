import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RATE_LIMIT_SLEEP,
  extractSessionId,
  isRateLimited,
  isRateLimitedFile,
  isTransientApiError,
  isTransientApiErrorFile,
  parseCooldownSeconds,
  parseCooldownSecondsFile,
  tailLines,
} from "./detect.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "detect-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("tailLines", () => {
  it("returns last N lines", () => {
    const text = Array.from({ length: 200 }, (_, i) => `L${i}`).join("\n");
    const tail = tailLines(text, 5);
    expect(tail).toBe("L195\nL196\nL197\nL198\nL199");
  });
  it("returns everything when fewer than N lines", () => {
    expect(tailLines("a\nb", 10)).toBe("a\nb");
  });
  it("handles empty input", () => {
    expect(tailLines("")).toBe("");
  });
});

describe("extractSessionId", () => {
  it("pulls the first session_id from a stream file", () => {
    const p = join(dir, "s.jsonl");
    writeFileSync(
      p,
      [
        '{"type":"system","subtype":"init","session_id":"sid-first","model":"m"}',
        '{"type":"system","subtype":"compact","session_id":"sid-second"}',
      ].join("\n"),
    );
    expect(extractSessionId(p)).toBe("sid-first");
  });
  it("returns null when the file has no session_id", () => {
    const p = join(dir, "s.jsonl");
    writeFileSync(p, '{"type":"result"}');
    expect(extractSessionId(p)).toBeNull();
  });
  it("returns null when the file doesn't exist", () => {
    expect(extractSessionId(join(dir, "nope.jsonl"))).toBeNull();
  });
});

describe("isRateLimited", () => {
  it("matches Anthropic-style 429 wording", () => {
    expect(isRateLimited("HTTP 429 Too Many Requests")).toBe(true);
  });
  it("matches rate-limit / rate limit / rate.limit variants", () => {
    expect(isRateLimited("hit a rate limit")).toBe(true);
    expect(isRateLimited("rate-limit reached")).toBe(true);
    expect(isRateLimited("Usage limit exceeded")).toBe(true);
  });
  it("matches please retry / please wait", () => {
    expect(isRateLimited("please retry after some time")).toBe(true);
    expect(isRateLimited("please wait before retrying")).toBe(true);
  });
  it("matches exceeded quota/limit", () => {
    expect(isRateLimited("exceeded daily quota")).toBe(true);
    expect(isRateLimited("exceeded the limit")).toBe(true);
  });
  it("returns false on a clean log", () => {
    expect(isRateLimited("everything fine\nstill fine")).toBe(false);
  });
  it("only looks at the last 120 lines", () => {
    const head = Array.from({ length: 200 }, () => "rate limit").join("\n");
    const tail = Array.from({ length: 130 }, () => "fine").join("\n");
    expect(isRateLimited(head + "\n" + tail)).toBe(false);
  });
  it("file variant reads from disk and returns false for missing files", () => {
    const p = join(dir, "log");
    writeFileSync(p, "429 Too Many Requests");
    expect(isRateLimitedFile(p)).toBe(true);
    expect(isRateLimitedFile(join(dir, "missing"))).toBe(false);
  });
});

describe("isTransientApiError", () => {
  it("matches API Error wording", () => {
    expect(isTransientApiError("API Error: 500 Internal server error")).toBe(
      true,
    );
  });
  it("matches socket-closed / overloaded / 5xx / bad gateway", () => {
    expect(isTransientApiError("socket connection was closed")).toBe(true);
    expect(isTransientApiError("model is overloaded")).toBe(true);
    expect(isTransientApiError("502 Bad Gateway")).toBe(true);
    expect(isTransientApiError("503 service unavailable")).toBe(true);
    expect(isTransientApiError("529 internal server error")).toBe(true);
  });
  it("returns false on a clean log", () => {
    expect(isTransientApiError("nothing wrong here")).toBe(false);
  });
  it("file variant returns false for a missing path", () => {
    expect(isTransientApiErrorFile(join(dir, "nope"))).toBe(false);
  });
});

describe("parseCooldownSeconds", () => {
  it("parses 'retry in N seconds'", () => {
    expect(parseCooldownSeconds("please retry in 42 seconds")).toBe(42);
  });
  it("parses minutes", () => {
    expect(parseCooldownSeconds("please wait 5 minutes")).toBe(300);
  });
  it("parses hours", () => {
    expect(parseCooldownSeconds("available in 2 hours")).toBe(7200);
  });
  it("parses 'reset in N seconds'", () => {
    expect(parseCooldownSeconds("rate limit reset in 30 seconds")).toBe(30);
  });
  it("falls back when no hint is present", () => {
    expect(parseCooldownSeconds("nothing helpful here")).toBe(
      DEFAULT_RATE_LIMIT_SLEEP,
    );
  });
  it("honours the caller-supplied fallback", () => {
    expect(parseCooldownSeconds("no hint", 60)).toBe(60);
  });
  it("file variant works end-to-end", () => {
    const p = join(dir, "log");
    writeFileSync(p, "rate-limited; retry after 15 minutes");
    expect(parseCooldownSecondsFile(p)).toBe(15 * 60);
  });
});
