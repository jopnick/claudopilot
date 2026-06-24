/**
 * Control seam + stuck-worker watchdog.
 *
 * Ports `process_control` and `check_stuck` from run-loop.sh. The dashboard
 * (or a human) drops a one-line file in `$CONTROL_DIR` to request an action;
 * the driver applies it on its next pass — the web server NEVER touches
 * process or manifest state itself (the driver owns both).
 *
 * Filenames are `<id>.<action>`:
 *   - `<id>.poke`  — kill a running worker and re-launch it (a hung phase)
 *   - `<id>.retry` — re-pend a `[blocked]` phase so it relaunches
 *
 * The phase id is kebab-case (no dots), so the trailing `.action` parses
 * unambiguously. Unknown actions are logged and ignored.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ManifestModel, PhaseState } from "../types.js";
import type { WorkerRecord } from "./types.js";

export type ControlAction = "poke" | "retry";

export interface ControlRequest {
  id: string;
  action: ControlAction | string;
  /** Absolute path of the source file, for diagnostics + deletion. */
  source: string;
}

/**
 * List all pending control files. Returns each parsed `(id, action)` pair plus
 * its source path. The driver consumes these and removes the files; this
 * function does NOT delete on its own so it can be tested deterministically.
 */
export async function listControlRequests(controlDir: string): Promise<ControlRequest[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(controlDir);
  } catch {
    return [];
  }
  const out: ControlRequest[] = [];
  for (const name of entries) {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) continue;
    const id = name.slice(0, dot);
    const action = name.slice(dot + 1);
    if (!id || !action) continue;
    out.push({ id, action, source: path.join(controlDir, name) });
  }
  return out;
}

/** Best-effort unlink of a control file. */
export async function consumeControlFile(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* already gone */
  }
}

export interface ControlContext {
  controlDir: string;
  /** Read the current manifest model (for retry's state check). */
  readManifest: () => Promise<ManifestModel>;
  /** Live worker map keyed by phase id. */
  running: Map<string, WorkerRecord>;
  /** Kill a running worker (the bash `poke_worker`'s kill + reap). */
  killWorker: (id: string, record: WorkerRecord) => Promise<void>;
  /** Manifest mutator. */
  setState: (id: string, state: PhaseState) => Promise<void>;
  /** Mark for resume + clear retry counter (poke / blocked-retry). */
  markResume: (id: string, record: WorkerRecord) => void;
  resetApiRetries: (id: string) => void;
  log?: (m: string) => void;
}

/**
 * Drain `controlDir` and apply each request. Mirrors `process_control` in the
 * bash driver. Unknown actions are logged + the file deleted (lossy on
 * purpose — mirrors bash).
 */
export async function processControl(ctx: ControlContext): Promise<void> {
  const reqs = await listControlRequests(ctx.controlDir);
  for (const r of reqs) {
    await consumeControlFile(r.source);
    switch (r.action) {
      case "poke": {
        const rec = ctx.running.get(r.id);
        if (!rec) {
          ctx.log?.(`  [${r.id}] CONTROL poke ignored — not running.`);
          break;
        }
        ctx.log?.(`  [${r.id}] CONTROL poke — killing + relaunching worker.`);
        await ctx.killWorker(r.id, rec);
        ctx.markResume(r.id, rec);
        await ctx.setState(r.id, "pending");
        break;
      }
      case "retry": {
        const model = await ctx.readManifest();
        const phase = model.phases.find((p) => p.id === r.id);
        const st = phase?.state ?? "unknown";
        if (st === "blocked") {
          ctx.log?.(`  [${r.id}] CONTROL retry — [blocked] -> [pending].`);
          ctx.resetApiRetries(r.id);
          await ctx.setState(r.id, "pending");
        } else {
          ctx.log?.(`  [${r.id}] CONTROL retry ignored — state is '${st}', not blocked.`);
        }
        break;
      }
      default: {
        ctx.log?.(
          `  CONTROL: unknown action '${r.action}' (file '${path.basename(r.source)}') — ignored.`,
        );
      }
    }
  }
}

export interface StuckContext {
  /** Seconds without stream growth that constitutes "stuck"; 0 disables. */
  stuckTimeout: number;
  /** Live worker map. */
  running: Map<string, WorkerRecord>;
  /** Clock (test seam, default Date.now / 1000). */
  now?: () => number;
  /** stat() seam — must return { size }. Defaults to fs.stat. */
  statSize?: (path: string) => Promise<number>;
  /** poke action — same code path as a CONTROL poke. */
  poke: (id: string, record: WorkerRecord, reason: string) => Promise<void>;
  log?: (m: string) => void;
}

/**
 * Walk the live worker map; for each one whose raw event STREAM has not grown
 * for `stuckTimeout` seconds, fire `poke`. Progress = stream-json byte growth
 * (which counts streaming "thinking" tokens), so a worker mid-thought isn't
 * falsely killed.
 */
export async function checkStuck(ctx: StuckContext): Promise<void> {
  if (ctx.stuckTimeout <= 0) return;
  const now = (ctx.now ?? (() => Math.floor(Date.now() / 1000)))();
  const statSize = ctx.statSize ?? defaultStatSize;
  for (const [id, rec] of ctx.running) {
    let sz = 0;
    try {
      sz = await statSize(rec.paths.stream);
    } catch {
      continue;
    }
    if (rec.stuckSize !== sz) {
      rec.stuckSize = sz;
      rec.stuckSince = now;
      continue;
    }
    if (rec.stuckSince === undefined) {
      rec.stuckSince = now;
      continue;
    }
    if (now - rec.stuckSince >= ctx.stuckTimeout) {
      await ctx.poke(
        id,
        rec,
        `STUCK: no stream output for ${ctx.stuckTimeout}s`,
      );
      // Reset trackers; the relaunch will start fresh accounting.
      delete rec.stuckSize;
      delete rec.stuckSince;
    }
  }
}

async function defaultStatSize(p: string): Promise<number> {
  try {
    const s = await fs.stat(p);
    return s.size;
  } catch {
    return 0;
  }
}
