/**
 * Process primitives for the engine. POSIX-only at the host level — Windows
 * support is via WSL2, so the orchestrator still runs against POSIX semantics
 * (own process group, negative-pid kill, SIGTERM/SIGKILL).
 *
 * Replaces the bash `kill_tree`/`pgrep`/`trap` machinery.
 */

import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
  type StdioOptions,
} from "node:child_process";
import type { WorkerHandle } from "../types.js";

export interface SpawnCaptureOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Bytes — combined stdout+stderr cap. 0 = unlimited. Default 0. */
  maxBuffer?: number;
  /** Optional input piped to stdin. */
  input?: string | Buffer;
  /** Optional milliseconds; on expiry the child is killed with SIGTERM. */
  timeoutMs?: number;
}

export interface SpawnCaptureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True if the child was killed because timeoutMs elapsed. */
  timedOut: boolean;
}

/**
 * Run a child to completion, capturing stdout+stderr. Never throws on a
 * non-zero exit — callers inspect `code`. The promise rejects only when the
 * child cannot be spawned at all (ENOENT, etc).
 */
export function spawnCapture(
  cmd: string,
  args: readonly string[] = [],
  opts: SpawnCaptureOptions = {},
): Promise<SpawnCaptureResult> {
  return new Promise((resolve, reject) => {
    const stdio: StdioOptions =
      opts.input != null ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio,
      shell: false,
    });

    let out = "";
    let err = "";
    let truncated = false;
    let timedOut = false;
    const cap = opts.maxBuffer ?? 0;

    const append = (slot: "out" | "err", chunk: string): void => {
      if (truncated) return;
      const cur = slot === "out" ? out : err;
      const next = cur + chunk;
      if (cap > 0 && next.length > cap) {
        truncated = true;
        if (slot === "out") out = next.slice(0, cap);
        else err = next.slice(0, cap);
        return;
      }
      if (slot === "out") out = next;
      else err = next;
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => append("out", d));
    child.stderr?.on("data", (d: string) => append("err", d));

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }, opts.timeoutMs);
    }

    child.once("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout: out, stderr: err, timedOut });
    });

    if (opts.input != null && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

export interface SpawnDetachedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: SpawnOptions["stdio"];
}

/**
 * Spawn a long-running child in its own process group (`detached: true`,
 * `setsid`-equivalent). Used for worker agents we may later need to nuke
 * along with every grandchild via `killTree`.
 */
export function spawnDetached(
  cmd: string,
  args: readonly string[] = [],
  opts: SpawnDetachedOptions = {},
): ChildProcess {
  return spawn(cmd, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? "ignore",
    shell: false,
    detached: true,
  });
}

/**
 * Kill an entire process group on POSIX/WSL: `process.kill(-pid, sig)` sends
 * the signal to every process in the group whose leader is `pid`. The child
 * MUST have been started detached (`spawnDetached`) for this to address more
 * than the leader itself.
 *
 * Returns true if a signal was attempted; false if the handle has no live pid.
 */
export function killTree(
  target: WorkerHandle | ChildProcess | { pid?: number | null },
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  const pid = "pid" in target ? (target as { pid?: number | null }).pid : undefined;
  if (!pid || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // group already gone, or pid never became a leader — fall back to the
    // single-pid kill so we at least try.
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Wait for a spawned child to exit and return its exit summary. Never rejects
 * for a non-zero exit; only for a spawn-level error already emitted.
 */
export function reapExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
