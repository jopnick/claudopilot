/**
 * Tail-of-log / stream scanners ported from `run-loop.sh`. The driver
 * (phase-06) calls these to decide whether a failed worker should be
 * relaunched (rate limit / transient API error) or parked.
 *
 * The bash regexes are case-insensitive and only ever inspect the last
 * 120 lines of the relevant file — we mirror that scope here for parity.
 */

import { readFileSync } from "node:fs";

/** Default number of trailing lines scanned, matching `tail -120`. */
export const TAIL_LINES = 120;

/** Default cooldown when no explicit hint is parsed; matches the bash env default. */
export const DEFAULT_RATE_LIMIT_SLEEP = 3600;

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Return the last `n` lines of `text` joined by `\n` (mirrors `tail -n`). */
export function tailLines(text: string, n: number = TAIL_LINES): string {
  if (!text) return "";
  const lines = text.split("\n");
  // text.split("\n") gives a trailing empty string for trailing-newline files;
  // `tail` includes that as an empty line, so keep parity.
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/**
 * Extract the worker's first claude `session_id` from the raw NDJSON
 * stream file. Mirrors:
 *   grep -oE '"session_id":"[^"]+"' "$sp" | head -1 | cut -d'"' -f4
 */
export function extractSessionId(streamPath: string): string | null {
  const txt = safeRead(streamPath);
  if (!txt) return null;
  const m = txt.match(/"session_id":"([^"]+)"/);
  return m ? m[1]! : null;
}

const RATE_LIMIT_PATTERN =
  /rate.?limit|usage limit|429|too many requests|please (retry|wait)|exceeded.*(quota|limit)/i;

/**
 * Heuristic: does the tail of a per-phase log look like Anthropic-side
 * rate limiting? Mirrors the bash `is_rate_limited` regex exactly.
 */
export function isRateLimited(logText: string): boolean {
  return RATE_LIMIT_PATTERN.test(tailLines(logText));
}

/** Same check, but reads the file for you. */
export function isRateLimitedFile(logPath: string): boolean {
  return isRateLimited(safeRead(logPath));
}

const TRANSIENT_API_PATTERN =
  /api error|socket connection was closed|5[0-9][0-9] internal server error|overloaded|bad gateway|service unavailable/i;

/**
 * Heuristic: does the tail of a per-phase log look like a transient
 * server-side API failure that's safe to retry? Mirrors
 * `is_transient_api_error`. The bash version is gated by
 * `$RETRY_TRANSIENT_API` — that policy decision belongs to the caller, so
 * we leave it out here; the function just answers the regex question.
 */
export function isTransientApiError(logText: string): boolean {
  return TRANSIENT_API_PATTERN.test(tailLines(logText));
}

export function isTransientApiErrorFile(logPath: string): boolean {
  return isTransientApiError(safeRead(logPath));
}

/**
 * Parse a "retry/wait/available/reset … N (seconds|minutes|hours)" hint
 * out of a log tail. Mirrors the bash `cool_down` parser. Returns the
 * cooldown seconds; falls back to `DEFAULT_RATE_LIMIT_SLEEP` (or the
 * caller-supplied default) when nothing parses.
 */
export function parseCooldownSeconds(
  logText: string,
  fallbackSeconds: number = DEFAULT_RATE_LIMIT_SLEEP,
): number {
  const tail = tailLines(logText);
  const hint = tail.match(
    /(retry|wait|available|reset)[^0-9]*([0-9]+)\s*(second|minute|hour)/i,
  );
  if (!hint) return fallbackSeconds;
  const n = Number(hint[2]);
  if (!Number.isFinite(n) || n <= 0) return fallbackSeconds;
  const unit = (hint[3] ?? "").toLowerCase();
  if (unit.startsWith("hour")) return n * 3600;
  if (unit.startsWith("minute")) return n * 60;
  if (unit.startsWith("second")) return n;
  return fallbackSeconds;
}

export function parseCooldownSecondsFile(
  logPath: string,
  fallbackSeconds?: number,
): number {
  return parseCooldownSeconds(safeRead(logPath), fallbackSeconds);
}
