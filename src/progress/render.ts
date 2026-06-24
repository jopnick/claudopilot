/**
 * CLI renderers for the progress snapshot. Three views, all reading the
 * same model from `progress/model.ts`:
 *
 *   • `renderSnapshot(model)`  — the default one-shot table (ANSI when
 *     stdout is a TTY, plain when piped). Mirrors `progress.mjs`.
 *   • `runWatch({ ... })`       — periodic refresh (clear + reprint).
 *   • `runFollow({ ... })`      — tail `tail -F` over one phase's
 *     rendered transcript, like watching the chat window.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildSnapshot } from "./model.js";
import { cloneCapturePath, mainCapturePath } from "../platform/paths.js";
import type { ProgressSnapshot, ProgressStep } from "../types.js";

export interface RenderOptions {
  /** Force-disable colour codes (else: stdout.isTTY decides). */
  noColor?: boolean;
}

interface Palette {
  dim: string;
  b: string;
  grn: string;
  ylw: string;
  red: string;
  cyn: string;
  r: string;
}

const PLAIN: Palette = { dim: "", b: "", grn: "", ylw: "", red: "", cyn: "", r: "" };
const ANSI: Palette = {
  dim: "\x1b[2m",
  b: "\x1b[1m",
  grn: "\x1b[32m",
  ylw: "\x1b[33m",
  red: "\x1b[31m",
  cyn: "\x1b[36m",
  r: "\x1b[0m",
};

function palette(opts: RenderOptions = {}): Palette {
  if (opts.noColor) return PLAIN;
  return process.stdout.isTTY ? ANSI : PLAIN;
}

const STATE_COLOR: Record<string, keyof Palette> = {
  merged: "grn",
  running: "cyn",
  blocked: "ylw",
  failed: "red",
  pending: "dim",
};

// Compact elapsed: 9s · 4m12s · 1h03m — shared shape with the web client.
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

// Compact token count: 920 · 12.3k · 1.2M — mirrors fmtTokens in web/app.mjs.
export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface RenderSnapshotOptions extends RenderOptions {
  /** Override Date.now() for deterministic elapsed timers in tests. */
  now?: () => number;
}

/** Pretty-print the snapshot — the body of `progress.mjs`'s `render()`. */
export function renderSnapshot(
  model: ProgressSnapshot,
  opts: RenderSnapshotOptions = {},
): string {
  if (model.error) return model.error;
  const C = palette(opts);
  const now = opts.now ?? Date.now;
  const s = model.summary;
  const out: string[] = [];
  out.push(`${C.b}${model.manifest}${C.r}  ${C.dim}(${model.manifestStatus})${C.r}`);
  out.push(
    `phases ${C.b}${s.merged}/${s.total}${C.r} merged` +
      `  ·  slices ${C.b}${s.slicesDone}/${s.slicesTotal}${C.r}` +
      `  ·  ${s.pctPhases}% phases / ${s.pctSlices}% slices` +
      (s.running ? `  ·  ${C.cyn}${s.running} running${C.r}` : "") +
      (s.blocked ? `  ·  ${C.ylw}${s.blocked} blocked${C.r}` : "") +
      (s.failed ? `  ·  ${C.red}${s.failed} failed${C.r}` : ""),
  );
  out.push(`container: ${model.container ?? "unknown"}`);
  if (model.lastDriverEvent) out.push(`${C.dim}${model.lastDriverEvent}${C.r}`);
  out.push("");

  model.phases.forEach((p, i) => {
    const colKey = STATE_COLOR[p.state];
    const col = colKey ? C[colKey] : "";
    const counts = p.slicesTotal ? ` (${p.slicesDone}/${p.slicesTotal} slices)` : "";
    const deps = p.deps.length ? ` ${C.dim}deps: ${p.deps.join(", ")}${C.r}` : "";
    out.push(
      `${col}${String(i + 1).padStart(2)}. [${p.state}] ${C.b}${p.id}${C.r}${col}${counts}${C.r}${deps}`,
    );
    const interesting =
      p.state === "running" ||
      p.state === "blocked" ||
      p.state === "failed" ||
      (p.slicesDone > 0 && p.state !== "merged");
    if (!interesting) return;
    const step = p.step as (ProgressStep & { tokens?: number | null }) | null;
    if (step) {
      const el = fmtDur(now() - step.since);
      const detail = step.detail ? `: ${step.detail}` : "";
      const tok =
        step.tokens != null ? ` · ${fmtTokens(step.tokens)} tok` : "";
      out.push(
        `      ${C.cyn}now${C.r} ${step.label}${detail} ${C.dim}(${el}${tok})${C.r}`,
      );
    } else if (p.activity) {
      out.push(`      ${C.cyn}now${C.r} ${p.activity}`);
    }
    for (const sl of p.slices) {
      const mark = sl.checked ? "[x]" : "[ ]";
      const sha = sl.sha ? ` ${C.dim}(${sl.sha})${C.r}` : "";
      out.push(
        `      ${sl.checked ? C.grn : C.dim}${mark}${C.r} ${sl.id}  ${sl.title}${sha}`,
      );
    }
    if (!p.checklistSeeded && p.slices.length) {
      out.push(
        `      ${C.dim}(planned slices — worker has not seeded its Status checklist yet)${C.r}`,
      );
    }
    if (p.lastCommit) out.push(`      ${C.dim}tip: ${p.lastCommit}${C.r}`);
  });
  return out.join("\n");
}

export interface RunOnceOptions extends RenderSnapshotOptions {
  repoRoot: string;
  manifestPath: string;
  roadmapDir: string;
  /** Emit raw JSON instead of the ANSI table. */
  json?: boolean;
  /** Stream sink — defaults to process.stdout. */
  out?: NodeJS.WritableStream;
}

/** One-shot render — returns the snapshot it printed. */
export function runOnce(opts: RunOnceOptions): ProgressSnapshot {
  const out = opts.out ?? process.stdout;
  const snap = buildSnapshot({
    repoRoot: opts.repoRoot,
    manifestPath: opts.manifestPath,
    roadmapDir: opts.roadmapDir,
  });
  if (opts.json) {
    out.write(JSON.stringify(snap, null, 2) + "\n");
  } else {
    out.write(renderSnapshot(snap, opts) + "\n");
  }
  return snap;
}

export interface RunWatchOptions extends RunOnceOptions {
  /** Refresh interval in seconds. Default 5. */
  watchSecs?: number;
  /** Override setInterval for tests. */
  setIntervalFn?: typeof setInterval;
  /** Optional Abort signal to stop the watcher. */
  signal?: AbortSignal;
}

/**
 * Live refresh loop. Clears the screen on each tick and reprints. Returns
 * a function that stops the loop (also auto-stops when `signal` aborts).
 */
export function runWatch(opts: RunWatchOptions): () => void {
  const out = opts.out ?? process.stdout;
  const secs = opts.watchSecs ?? 5;
  const setIv = opts.setIntervalFn ?? setInterval;
  const C = palette(opts);

  const tick = (): void => {
    out.write("\x1b[2J\x1b[H");
    const snap = buildSnapshot({
      repoRoot: opts.repoRoot,
      manifestPath: opts.manifestPath,
      roadmapDir: opts.roadmapDir,
    });
    out.write(renderSnapshot(snap, opts) + "\n");
    out.write(
      `${C.dim}\n(refreshing every ${secs}s — Ctrl-C to stop · follow an agent: --follow <phase>)${C.r}\n`,
    );
  };
  tick();
  const handle = setIv(tick, secs * 1000);
  const stop = (): void => {
    clearInterval(handle as unknown as NodeJS.Timeout);
  };
  if (opts.signal) {
    if (opts.signal.aborted) stop();
    else opts.signal.addEventListener("abort", stop, { once: true });
  }
  return stop;
}

export interface RunFollowOptions extends RenderOptions {
  repoRoot: string;
  /** Phase id whose transcript to tail. */
  id: string;
  out?: NodeJS.WritableStream;
}

/**
 * Spawn `tail -F` over a phase's rendered transcript and wire it to stdout.
 * Returns the child process so callers can await/exit on its close.
 */
export function runFollow(opts: RunFollowOptions): ReturnType<typeof spawn> {
  const C = palette(opts);
  const out = opts.out ?? process.stdout;
  const clone = cloneCapturePath(opts.repoRoot, opts.id, `${opts.id}.transcript.md`);
  const main = mainCapturePath(opts.repoRoot, opts.id, `${opts.id}.transcript.md`);
  const tpath = existsSync(clone) ? clone : main;
  out.write(`${C.dim}following ${tpath} (Ctrl-C to stop)${C.r}\n`);
  return spawn("tail", ["-n", "+1", "-F", tpath], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}
