/**
 * Progress snapshot model — read-only view over a run-loop's artifacts.
 *
 * Ports `progress.mjs`'s `buildModel()` to typed TS:
 *   1. roadmap level  — manifest Order states (via `manifest.ts`)
 *   2. phase level     — `auto/<id>` branch + worktree + last commit
 *   3. checklist level — the `## Status` slice list the worker maintains
 *
 * Also derives the live "current step" for running phases by tailing the
 * structured `<id>.stream.jsonl` event log, and sums cumulative
 * `output_tokens` across the whole run.
 *
 * Repo root + roadmapDir + manifest path are all caller-supplied so the
 * model never has to do the `resolve(import.meta.url, "..")` self-host
 * trick that the original `.mjs` used.
 */

import {
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  closeSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { parseManifest } from "../manifest.js";
import {
  worktreeDir,
  cloneCapturePath,
  mainCapturePath,
  logFilePath,
} from "../platform/paths.js";
import type {
  ProgressPhase,
  ProgressSliceEntry,
  ProgressSnapshot,
  ProgressStep,
} from "../types.js";

export interface BuildSnapshotOptions {
  repoRoot: string;
  /** Path to the manifest file (absolute). */
  manifestPath: string;
  /** Path to the roadmap directory holding phase docs (absolute). */
  roadmapDir: string;
  /**
   * Override for "now" — used by tests to keep the snapshot deterministic.
   * Defaults to `Date.now()`.
   */
  now?: () => number;
}

const STREAM_TAIL_BYTES = 64 * 1024;
const TOKEN_SCAN_MAX_BYTES = 64 * 1024 * 1024;

/** Build the full progress snapshot. Never throws — errors land in `error`. */
export function buildSnapshot(opts: BuildSnapshotOptions): ProgressSnapshot {
  const { repoRoot, manifestPath, roadmapDir } = opts;
  const text = readMaybe(manifestPath);
  if (text == null) {
    return emptySnapshot(manifestPath, repoRoot, `Manifest not found: ${manifestPath}`);
  }

  const parsed = parseManifest(text);
  const phases: ProgressPhase[] = parsed.phases.map((p) =>
    enrichPhase(p, repoRoot, roadmapDir),
  );

  const count = (st: string): number =>
    phases.filter((p) => p.state === st).length;
  const slicesTotal = phases.reduce((a, p) => a + p.slicesTotal, 0);
  const slicesDone = phases.reduce((a, p) => a + p.slicesDone, 0);

  return {
    manifest: relIfUnder(manifestPath, repoRoot),
    manifestStatus: parsed.status || "unknown",
    container: containerStatus(),
    lastDriverEvent: driverLogTail(repoRoot),
    summary: {
      total: phases.length,
      merged: count("merged"),
      running: count("running"),
      pending: count("pending"),
      blocked: count("blocked"),
      failed: count("failed"),
      slicesDone,
      slicesTotal,
      pctPhases: phases.length
        ? Math.round((100 * count("merged")) / phases.length)
        : 0,
      pctSlices: slicesTotal ? Math.round((100 * slicesDone) / slicesTotal) : 0,
    },
    phases,
  };
}

function enrichPhase(
  p: { id: string; state: string; title: string; deps: string[] },
  repoRoot: string,
  roadmapDir: string,
): ProgressPhase {
  const id = p.id;
  const branch = `auto/${id}`;
  const hasBranch = git(repoRoot, "rev-parse", "--verify", "--quiet", branch) !== null;
  const hasWorktree = existsSync(worktreeDir(repoRoot, id));
  const loc = locatePhaseDoc(repoRoot, roadmapDir, id);
  const docText = loc ? readMaybe(loc.path) ?? "" : "";
  const { seeded, slices } = parseSlices(docText);
  const slicesDone = slices.filter((s) => s.checked).length;
  const lastCommit = hasBranch
    ? git(repoRoot, "log", "-1", "--format=%h %s", branch)
    : null;

  const out: ProgressPhase = {
    id,
    state: p.state as ProgressPhase["state"],
    title: p.title,
    deps: p.deps,
    branch,
    hasBranch,
    hasWorktree,
    docSource: loc ? loc.source : null,
    doneDoc: loc ? loc.done : false,
    checklistSeeded: seeded,
    slices,
    slicesDone,
    slicesTotal: slices.length,
    lastCommit,
    step: null,
    activity: null,
  };

  if (p.state === "running") {
    let step: ProgressStep | null = null;
    try {
      step = deriveStep(repoRoot, id);
    } catch {
      step = null;
    }
    if (step) {
      out.step = step;
      out.activity = step.detail ? `${step.label}: ${step.detail}` : step.label;
    } else {
      const txt =
        readMaybe(cloneCapturePath(repoRoot, id, `${id}.transcript.md`)) ??
        readMaybe(mainCapturePath(repoRoot, id, `${id}.transcript.md`));
      if (txt) {
        const lines = txt
          .split("\n")
          .map((l) => l.trimEnd())
          .filter((l) => l.trim() && !l.startsWith("==="));
        const last = lines[lines.length - 1];
        if (last) out.activity = last.trim().slice(0, 160);
      }
    }
  }

  return out;
}

// ── doc location + checklist parsing ──────────────────────────────────────

interface DocLoc {
  path: string;
  source: "worktree" | "main";
  done: boolean;
}

function locatePhaseDoc(
  repoRoot: string,
  roadmapDir: string,
  id: string,
): DocLoc | null {
  // The worktree is a checkout of the repo, so its roadmap sits at the same
  // path relative to root as the main one (.claudopilot/roadmap or ./roadmap).
  const relRoadmap = path.relative(repoRoot, roadmapDir);
  const candidates: Array<{ dir: string; source: "worktree" | "main" }> = [
    {
      dir: path.join(worktreeDir(repoRoot, id), relRoadmap),
      source: "worktree",
    },
    { dir: roadmapDir, source: "main" },
  ];
  for (const { dir, source } of candidates) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const doneRe = new RegExp(`^DONE_${escapeRe(id)}(\\b|[-.]).*\\.md$`);
    const liveRe = new RegExp(`^${escapeRe(id)}(\\b|[-.]).*\\.md$`);
    const done = names.find((n) => doneRe.test(n));
    const live = names.find((n) => liveRe.test(n));
    const name = done ?? live;
    if (name) return { path: path.join(dir, name), source, done: Boolean(done) };
  }
  return null;
}

export interface SlicesParsed {
  seeded: boolean;
  slices: ProgressSliceEntry[];
}

/** Exported for tests — same shape as progress.mjs's parseSlices. */
export function parseSlices(text: string): SlicesParsed {
  // Line-walk the doc and slice out a section body bounded by the next
  // `## ` heading or end-of-text. (progress.mjs used a regex with `\Z`,
  // which JS treats as literal Z and only worked when another section
  // followed; this is the deterministic equivalent.)
  const section = (heading: string): string | null => {
    const lines = text.split("\n");
    const startRe = new RegExp(`^##\\s+${escapeRe(heading)}\\b`);
    let i = 0;
    while (i < lines.length && !startRe.test(lines[i] ?? "")) i++;
    if (i >= lines.length) return null;
    let j = i + 1;
    while (j < lines.length && !/^##\s/.test(lines[j] ?? "")) j++;
    return lines.slice(i + 1, j).join("\n");
  };

  const statusBody = section("Status");
  if (statusBody !== null) {
    const slices: ProgressSliceEntry[] = [];
    for (const line of statusBody.split("\n")) {
      const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/);
      if (!m || m[1] === undefined || m[2] === undefined) continue;
      const checked = m[1].toLowerCase() === "x";
      let rest = m[2];
      let sha: string | null = null;
      const shaM = rest.match(/\(([0-9a-f]{6,40})\)\s*$/i);
      if (shaM && typeof shaM.index === "number" && shaM[1]) {
        sha = shaM[1];
        rest = rest.slice(0, shaM.index).trim();
      }
      const idM = rest.match(/^(\S+)\s+[—-]\s+(.*)$/);
      const id = idM && idM[1] ? idM[1] : (rest.split(/\s+/)[0] ?? rest);
      const title = idM && idM[2] !== undefined ? idM[2] : rest;
      slices.push({ id, title, checked, sha });
    }
    return { seeded: true, slices };
  }

  const seqBody = section("Sequencing");
  if (seqBody !== null) {
    const slices: ProgressSliceEntry[] = [];
    for (const line of seqBody.split("\n")) {
      const m = line.match(/^\s*-\s*(\S+)\s+[—-]\s+(.*?)\s*$/);
      if (!m || m[1] === undefined || m[2] === undefined) continue;
      const title = m[2].replace(/\s+[—-]\s+hand-authored\s*$/i, "").trim();
      slices.push({ id: m[1], title, checked: false, sha: null });
    }
    return { seeded: false, slices };
  }
  return { seeded: false, slices: [] };
}

// ── live "current step" derivation from <id>.stream.jsonl ─────────────────

function streamPath(repoRoot: string, id: string): string | null {
  const cands = [
    cloneCapturePath(repoRoot, id, `${id}.stream.jsonl`),
    mainCapturePath(repoRoot, id, `${id}.stream.jsonl`),
  ];
  return cands.find((c) => existsSync(c)) ?? null;
}

function readTailUtf8(
  p: string,
  maxBytes: number,
): { text: string; partialHead: boolean } {
  const size = statSync(p).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(p, "r");
  try {
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    return { text: buf.toString("utf8"), partialHead: start > 0 };
  } finally {
    closeSync(fd);
  }
}

interface ToolUseLike {
  input?: unknown;
  name?: string;
}

function toolHint(tu: ToolUseLike): string | null {
  const i = tu.input;
  if (!i || typeof i !== "object") return null;
  const rec = i as Record<string, unknown>;
  const pick = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t) return null;
    const first = t.split("\n")[0] ?? t;
    return first.slice(0, 120);
  };
  return (
    pick(rec["description"]) ||
    pick(rec["command"]) ||
    pick(rec["file_path"]) ||
    pick(rec["path"]) ||
    pick(rec["pattern"]) ||
    pick(rec["query"]) ||
    pick(rec["url"]) ||
    pick(rec["prompt"]) ||
    null
  );
}

function sumOutputTokens(p: string): number | null {
  let text: string;
  try {
    if (statSync(p).size > TOKEN_SCAN_MAX_BYTES) return null;
    text = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  let total = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    if (!line.includes('"output_tokens"')) continue;
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        message?: { usage?: { output_tokens?: number } };
      };
      const u = ev.type === "assistant" ? ev.message?.usage : undefined;
      if (u && typeof u.output_tokens === "number") {
        total += u.output_tokens;
        seen = true;
      }
    } catch {
      /* skip partial / non-JSON lines */
    }
  }
  return seen ? total : null;
}

function deriveStep(repoRoot: string, id: string): ProgressStep | null {
  const p = streamPath(repoRoot, id);
  if (!p) return null;
  let since: number;
  let text: string;
  let partialHead: boolean;
  try {
    since = statSync(p).mtimeMs;
    ({ text, partialHead } = readTailUtf8(p, STREAM_TAIL_BYTES));
  } catch {
    return null;
  }

  const events: Array<Record<string, unknown>> = [];
  text.split("\n").forEach((line, idx) => {
    const t = line.trim();
    if (!t) return;
    if (idx === 0 && partialHead) return;
    try {
      events.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* skip partial */
    }
  });

  const tokens = sumOutputTokens(p);
  const base = (label: string, detail: string | null): ProgressStep => ({
    label,
    detail,
    since,
    ...(tokens != null ? ({ tokens } as { tokens: number }) : {}),
  });

  const last = events[events.length - 1];
  if (!last) return base("Working", null);

  if (last["type"] === "result") return base("Finishing", null);
  if (last["type"] === "rate_limit_event") return base("Rate limited", null);
  if (last["type"] === "system") {
    if (last["subtype"] === "api_retry") return base("Retrying API", null);
    if (last["subtype"] === "init") return base("Starting", null);
    if (last["subtype"] === "thinking_tokens") return base("Thinking", null);
  }

  let msg: Record<string, unknown> | null = null;
  for (let k = events.length - 1; k >= 0; k--) {
    const e = events[k];
    if (e && (e["type"] === "assistant" || e["type"] === "user")) {
      msg = e;
      break;
    }
  }
  if (!msg) return base("Working", null);

  const message = msg["message"] as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content)
    ? (message!.content as Array<Record<string, unknown>>)
    : [];
  if (msg["type"] === "assistant") {
    const tools = blocks.filter((b) => b && b["type"] === "tool_use");
    if (tools.length) {
      const tu = tools[tools.length - 1] as ToolUseLike & { name?: string };
      const extra = tools.length > 1 ? ` (+${tools.length - 1})` : "";
      const name = typeof tu.name === "string" ? tu.name : "tool";
      return base(`Running ${name}${extra}`, toolHint(tu));
    }
    const hasText = blocks.some(
      (b) =>
        b &&
        b["type"] === "text" &&
        typeof b["text"] === "string" &&
        (b["text"] as string).trim(),
    );
    return base(hasText ? "Responding" : "Thinking", null);
  }
  return base("Thinking", null);
}

// ── git + container + driver-log helpers ──────────────────────────────────

function git(repoRoot: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function containerStatus(): string | null {
  try {
    const out = execFileSync(
      "docker",
      [
        "ps",
        "--filter",
        "name=claudopilot-runner",
        "--format",
        "{{.Status}}",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out || "stopped";
  } catch {
    return "unknown (docker not reachable)";
  }
}

function driverLogTail(repoRoot: string): string | null {
  const text = readMaybe(logFilePath(repoRoot));
  if (!text) return null;
  const lines = text
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("[loop]"));
  return lines[lines.length - 1] ?? null;
}

// ── misc helpers ──────────────────────────────────────────────────────────

function readMaybe(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function relIfUnder(p: string, root: string): string {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emptySnapshot(
  manifestPath: string,
  repoRoot: string,
  errMsg: string,
): ProgressSnapshot {
  return {
    manifest: relIfUnder(manifestPath, repoRoot),
    manifestStatus: "unknown",
    container: null,
    lastDriverEvent: null,
    summary: {
      total: 0,
      merged: 0,
      running: 0,
      pending: 0,
      blocked: 0,
      failed: 0,
      slicesDone: 0,
      slicesTotal: 0,
      pctPhases: 0,
      pctSlices: 0,
    },
    phases: [],
    error: errMsg,
  };
}
