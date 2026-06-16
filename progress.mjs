#!/usr/bin/env node
//
// claudopilot/progress.mjs — read-only progress view for a run-loop.sh run.
//
// Derives a three-level progress model from the artifacts the loop already
// writes — no changes to the loop, safe to run against a live run:
//   1. roadmap level  — the manifest `## Order` states (pending/running/merged/blocked/failed)
//   2. phase level     — each phase's `auto/<id>` branch + worktree + last commit
//   3. checklist level — the `## Status` slice checklist the worker maintains
//                        in its phase doc ([ ] -> [x] with the commit SHA)
//
// Usage:
//   node claudopilot/progress.mjs                 # render once
//   node claudopilot/progress.mjs --watch [secs]  # live refresh (default 5s)
//   node claudopilot/progress.mjs --follow <phase># stream that agent's transcript (chat-window view)
//   node claudopilot/progress.mjs --json          # machine-readable snapshot
//   node claudopilot/progress.mjs --manifest <path>
//
// Manifest defaults to roadmap/EXECUTION-MANIFEST.browser-slice.md if present,
// else roadmap/EXECUTION-MANIFEST.md. Override with --manifest or $MANIFEST.

import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROADMAP_DIR = process.env.ROADMAP_DIR || "roadmap";

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const asJson = has("--json");
const watch = has("--watch");
const watchSecs = Number(valOf("--watch") || argv[argv.indexOf("--watch") + 1]) || 5;
const follow = valOf("--follow"); // phase id whose transcript to tail

function defaultManifest() {
  if (process.env.MANIFEST) return process.env.MANIFEST;
  const slice = join(REPO_ROOT, ROADMAP_DIR, "EXECUTION-MANIFEST.browser-slice.md");
  const full = join(REPO_ROOT, ROADMAP_DIR, "EXECUTION-MANIFEST.md");
  return existsSync(slice) ? slice : full;
}
const MANIFEST = valOf("--manifest") || defaultManifest();

// ── helpers ─────────────────────────────────────────────────────────────────
const git = (...a) => {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...a], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

function readMaybe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Locate a phase doc, preferring the live worktree copy, then the main tree.
function locatePhaseDoc(id) {
  const candidates = [
    { dir: join(REPO_ROOT, ".claudopilot/worktrees", id, "roadmap"), source: "worktree" },
    { dir: join(REPO_ROOT, ROADMAP_DIR), source: "main" },
  ];
  for (const { dir, source } of candidates) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    // DONE_ takes precedence (terminal state), then the live doc.
    const done = names.find((n) => new RegExp(`^DONE_${id}(\\b|[-.]).*\\.md$`).test(n));
    const live = names.find((n) => new RegExp(`^${id}(\\b|[-.]).*\\.md$`).test(n));
    const name = done || live;
    if (name) return { path: join(dir, name), source, done: Boolean(done) };
  }
  return null;
}

// Pull the slice checklist out of a phase doc. Prefer `## Status` (the worker's
// live checklist); fall back to `## Sequencing` (planned slices, all unchecked).
function parseSlices(text) {
  const section = (heading) => {
    const re = new RegExp(`^##\\s+${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, "m");
    const m = text.match(re);
    return m ? m[1] : null;
  };

  const statusBody = section("Status");
  if (statusBody) {
    const slices = [];
    for (const line of statusBody.split("\n")) {
      const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/);
      if (!m) continue;
      const checked = m[1].toLowerCase() === "x";
      let rest = m[2];
      let sha = null;
      const shaM = rest.match(/\(([0-9a-f]{6,40})\)\s*$/i);
      if (shaM) {
        sha = shaM[1];
        rest = rest.slice(0, shaM.index).trim();
      }
      const idM = rest.match(/^(\S+)\s+[—-]\s+(.*)$/);
      slices.push({
        id: idM ? idM[1] : rest.split(/\s+/)[0],
        title: idM ? idM[2] : rest,
        checked,
        sha,
      });
    }
    return { seeded: true, slices };
  }

  const seqBody = section("Sequencing");
  if (seqBody) {
    const slices = [];
    for (const line of seqBody.split("\n")) {
      const m = line.match(/^\s*-\s*(\S+)\s+[—-]\s+(.*?)\s*$/);
      if (!m) continue;
      let title = m[2].replace(/\s+[—-]\s+hand-authored\s*$/i, "").trim();
      slices.push({ id: m[1], title, checked: false, sha: null });
    }
    return { seeded: false, slices };
  }
  return { seeded: false, slices: [] };
}

// ── live "current step" — what Claude is doing right now, from the stream-json ─
// The raw `<id>.stream.jsonl` is the structured event log (more reliable than the
// rendered transcript). We tail it, look at the last meaningful event, and derive
// a human-readable label + an optional detail. `since` is the stream file's mtime:
// each event marks a state transition, so (now - since) is "time on this step".
// Long, important cases (a tool running for minutes, a hang) write nothing while
// they wait, so the mtime freezes and the elapsed timer grows — exactly the signal
// you want when a phase looks stuck.
const STREAM_TAIL_BYTES = 64 * 1024;

function streamPath(id) {
  const cands = [
    join(REPO_ROOT, ".claudopilot", "worktrees", id, ".claudopilot", `${id}.stream.jsonl`),
    join(REPO_ROOT, ".claudopilot", `${id}.stream.jsonl`),
  ];
  return cands.find((c) => existsSync(c)) || null;
}

function readTailUtf8(path, maxBytes) {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    return { text: buf.toString("utf8"), partialHead: start > 0 };
  } finally {
    closeSync(fd);
  }
}

// Pull a short, human-useful hint out of a tool_use input (the command, the file,
// the search, the subagent task…). First non-empty line, capped.
function toolHint(tu) {
  const i = tu && tu.input;
  if (!i || typeof i !== "object") return null;
  const pick = (v) =>
    typeof v === "string" && v.trim() ? v.trim().split("\n")[0].slice(0, 120) : null;
  return (
    pick(i.description) || pick(i.command) || pick(i.file_path) || pick(i.path) ||
    pick(i.pattern) || pick(i.query) || pick(i.url) || pick(i.prompt) || null
  );
}

function deriveStep(id) {
  const path = streamPath(id);
  if (!path) return null;
  let since, text, partialHead;
  try {
    since = statSync(path).mtimeMs;
    ({ text, partialHead } = readTailUtf8(path, STREAM_TAIL_BYTES));
  } catch {
    return null;
  }

  const events = [];
  text.split("\n").forEach((line, idx) => {
    const t = line.trim();
    if (!t) return;
    if (idx === 0 && partialHead) return; // first line may be a truncated fragment
    try {
      events.push(JSON.parse(t));
    } catch {
      /* skip non-JSON / partial lines */
    }
  });

  const last = events[events.length - 1];
  if (!last) return { label: "Working", detail: null, since };

  if (last.type === "result") return { label: "Finishing", detail: null, since };
  if (last.type === "rate_limit_event") return { label: "Rate limited", detail: null, since };
  if (last.type === "system") {
    if (last.subtype === "api_retry") return { label: "Retrying API", detail: null, since };
    if (last.subtype === "init") return { label: "Starting", detail: null, since };
    if (last.subtype === "thinking_tokens") return { label: "Thinking", detail: null, since };
    // other system telemetry — characterize from the last real message below
  }

  // The last assistant/user message tells us whether a tool is running (assistant
  // emitted tool_use, now executing) or the model is thinking (a tool result just
  // came back, or it is mid-turn).
  let msg = null;
  for (let k = events.length - 1; k >= 0; k--) {
    if (events[k].type === "assistant" || events[k].type === "user") {
      msg = events[k];
      break;
    }
  }
  if (!msg) return { label: "Working", detail: null, since };

  const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
  if (msg.type === "assistant") {
    const tools = blocks.filter((b) => b && b.type === "tool_use");
    if (tools.length) {
      const tu = tools[tools.length - 1];
      const extra = tools.length > 1 ? ` (+${tools.length - 1})` : "";
      return { label: `Running ${tu.name || "tool"}${extra}`, detail: toolHint(tu), since };
    }
    const hasText = blocks.some((b) => b && b.type === "text" && b.text && b.text.trim());
    return { label: hasText ? "Responding" : "Thinking", detail: null, since };
  }
  // a user message in the stream is a tool result → the model is processing it
  return { label: "Thinking", detail: null, since };
}

// ── parse the manifest Order list (same grammar as run-loop.sh) ─────────────
function buildModel() {
  const text = readMaybe(MANIFEST);
  if (text == null) {
    return { error: `Manifest not found: ${MANIFEST}` };
  }
  const statusM = text.match(/^\*\*Status:\*\*\s+(.+)\s*$/m);
  const manifestStatus = statusM ? statusM[1].trim() : "unknown";

  const phases = [];
  const orderRe =
    /^[0-9]+\.\s+\[([a-z]+)\]\s+\*\*([^*]+)\*\*\s*(?:—|-)?\s*([^\n]*)$/gm;
  let m;
  while ((m = orderRe.exec(text))) {
    const state = m[1];
    const id = m[2].trim();
    let titleAndDeps = m[3].trim();
    let deps = [];
    const depsM = titleAndDeps.match(/\(deps:\s*([^)]*)\)/);
    if (depsM) {
      deps = depsM[1].split(",").map((s) => s.trim()).filter(Boolean);
      titleAndDeps = titleAndDeps.replace(/\(deps:[^)]*\)/, "").trim();
    }
    phases.push({ id, state, title: titleAndDeps, deps });
  }

  // enrich each phase with checklist + git detail
  for (const p of phases) {
    const branch = `auto/${p.id}`;
    const hasBranch = git("rev-parse", "--verify", "--quiet", branch) !== null;
    const hasWorktree = existsSync(join(REPO_ROOT, ".claudopilot/worktrees", p.id));
    const loc = locatePhaseDoc(p.id);
    const { seeded, slices } = loc ? parseSlices(readMaybe(loc.path) || "") : { seeded: false, slices: [] };
    const slicesDone = slices.filter((s) => s.checked).length;
    const lastCommit = hasBranch ? git("log", "-1", "--format=%h %s", branch) : null;

    p.branch = branch;
    p.hasBranch = hasBranch;
    p.hasWorktree = hasWorktree;
    p.docSource = loc ? loc.source : null;
    p.doneDoc = loc ? loc.done : false;
    p.checklistSeeded = seeded;
    p.slices = slices;
    p.slicesDone = slicesDone;
    p.slicesTotal = slices.length;
    p.lastCommit = lastCommit;

    // live "current step" — what Claude is doing now + when it started (file mtime),
    // derived from the structured stream-json. `activity` stays a flat string for
    // back-compat (CLI + older clients); `step` carries the structured shape the web
    // dashboard renders with a live elapsed timer.
    p.step = null;
    p.activity = null;
    if (p.state === "running") {
      let step = null;
      try {
        step = deriveStep(p.id);
      } catch {
        step = null;
      }
      if (step) {
        p.step = step;
        p.activity = step.detail ? `${step.label}: ${step.detail}` : step.label;
      } else {
        // fallback: last meaningful line of the rendered transcript (isolated mode
        // writes it inside the phase clone; else in $RUNDIR).
        const txt =
          readMaybe(join(REPO_ROOT, ".claudopilot", "worktrees", p.id, ".claudopilot", `${p.id}.transcript.md`)) ??
          readMaybe(join(REPO_ROOT, ".claudopilot", `${p.id}.transcript.md`));
        if (txt) {
          const lines = txt
            .split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => l.trim() && !l.startsWith("==="));
          if (lines.length) p.activity = lines[lines.length - 1].trim().slice(0, 160);
        }
      }
    }
  }

  const count = (st) => phases.filter((p) => p.state === st).length;
  const slicesTotal = phases.reduce((a, p) => a + p.slicesTotal, 0);
  const slicesDone = phases.reduce((a, p) => a + p.slicesDone, 0);

  // driver log + container
  const logTail = (readMaybe(join(REPO_ROOT, ".claudopilot.log")) || "")
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("[loop]"))
    .slice(-1)[0] || null;
  let container = null;
  try {
    container =
      execFileSync("docker", ["ps", "--filter", "name=claudopilot-runner", "--format", "{{.Status}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "stopped";
  } catch {
    container = "unknown (docker not reachable)";
  }

  return {
    manifest: MANIFEST.replace(REPO_ROOT + "/", ""),
    manifestStatus,
    container,
    lastDriverEvent: logTail,
    summary: {
      total: phases.length,
      merged: count("merged"),
      running: count("running"),
      pending: count("pending"),
      blocked: count("blocked"),
      failed: count("failed"),
      slicesDone,
      slicesTotal,
      pctPhases: phases.length ? Math.round((100 * count("merged")) / phases.length) : 0,
      pctSlices: slicesTotal ? Math.round((100 * slicesDone) / slicesTotal) : 0,
    },
    phases,
  };
}

// ── render ──────────────────────────────────────────────────────────────────
const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", b: "\x1b[1m", grn: "\x1b[32m", ylw: "\x1b[33m", red: "\x1b[31m", cyn: "\x1b[36m", r: "\x1b[0m" }
  : { dim: "", b: "", grn: "", ylw: "", red: "", cyn: "", r: "" };

const stateColor = { merged: C.grn, running: C.cyn, blocked: C.ylw, failed: C.red, pending: C.dim };

// Compact elapsed: 9s · 4m12s · 1h03m. Shared shape with the web client.
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function render(model) {
  if (model.error) return model.error;
  const s = model.summary;
  const out = [];
  out.push(
    `${C.b}${model.manifest}${C.r}  ${C.dim}(${model.manifestStatus})${C.r}`
  );
  out.push(
    `phases ${C.b}${s.merged}/${s.total}${C.r} merged` +
      `  ·  slices ${C.b}${s.slicesDone}/${s.slicesTotal}${C.r}` +
      `  ·  ${s.pctPhases}% phases / ${s.pctSlices}% slices` +
      (s.running ? `  ·  ${C.cyn}${s.running} running${C.r}` : "") +
      (s.blocked ? `  ·  ${C.ylw}${s.blocked} blocked${C.r}` : "") +
      (s.failed ? `  ·  ${C.red}${s.failed} failed${C.r}` : "")
  );
  out.push(`container: ${model.container}`);
  if (model.lastDriverEvent) out.push(`${C.dim}${model.lastDriverEvent}${C.r}`);
  out.push("");

  model.phases.forEach((p, i) => {
    const col = stateColor[p.state] || "";
    const counts = p.slicesTotal ? ` (${p.slicesDone}/${p.slicesTotal} slices)` : "";
    const deps = p.deps.length ? ` ${C.dim}deps: ${p.deps.join(", ")}${C.r}` : "";
    out.push(`${col}${String(i + 1).padStart(2)}. [${p.state}] ${C.b}${p.id}${C.r}${col}${counts}${C.r}${deps}`);
    if (p.state === "running" || p.state === "blocked" || p.state === "failed" || (p.slicesDone > 0 && p.state !== "merged")) {
      if (p.step) {
        const el = fmtDur(Date.now() - p.step.since);
        const detail = p.step.detail ? `: ${p.step.detail}` : "";
        out.push(`      ${C.cyn}now${C.r} ${p.step.label}${detail} ${C.dim}(${el})${C.r}`);
      } else if (p.activity) {
        out.push(`      ${C.cyn}now${C.r} ${p.activity}`);
      }
      for (const sl of p.slices) {
        const mark = sl.checked ? "[x]" : "[ ]";
        const sha = sl.sha ? ` ${C.dim}(${sl.sha})${C.r}` : "";
        out.push(`      ${sl.checked ? C.grn : C.dim}${mark}${C.r} ${sl.id}  ${sl.title}${sha}`);
      }
      if (!p.checklistSeeded && p.slices.length)
        out.push(`      ${C.dim}(planned slices — worker has not seeded its Status checklist yet)${C.r}`);
      if (p.lastCommit) out.push(`      ${C.dim}tip: ${p.lastCommit}${C.r}`);
    }
  });
  return out.join("\n");
}

// ── main ──────────────────────────────────────────────────────────────────
function once() {
  const model = buildModel();
  if (asJson) {
    process.stdout.write(JSON.stringify(model, null, 2) + "\n");
  } else {
    process.stdout.write(render(model) + "\n");
  }
  return model;
}

if (follow) {
  // Stream a phase's rendered transcript, like watching it in the chat window.
  // Prefer the isolated clone's live transcript; fall back to $RUNDIR.
  const cloneT = join(REPO_ROOT, ".claudopilot", "worktrees", follow, ".claudopilot", `${follow}.transcript.md`);
  const tpath = existsSync(cloneT) ? cloneT : join(REPO_ROOT, ".claudopilot", `${follow}.transcript.md`);
  process.stdout.write(`${C.dim}following ${tpath} (Ctrl-C to stop)${C.r}\n`);
  const tail = spawn("tail", ["-n", "+1", "-F", tpath], { stdio: ["ignore", "inherit", "inherit"] });
  process.on("SIGINT", () => {
    tail.kill();
    process.exit(0);
  });
  tail.on("close", (code) => process.exit(code ?? 0));
} else if (watch && !asJson) {
  const loop = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(render(buildModel()) + "\n");
    process.stdout.write(`${C.dim}\n(refreshing every ${watchSecs}s — Ctrl-C to stop · follow an agent: --follow <phase>)${C.r}\n`);
  };
  loop();
  setInterval(loop, watchSecs * 1000);
} else {
  once();
}
