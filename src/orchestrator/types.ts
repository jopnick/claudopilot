/**
 * Orchestrator-local types.
 *
 * Phase-06 keeps a minimal `DockerLike` interface here so the scheduler does
 * not import from `src/runner/*` (phase-04). The CLI (phase-07) is the seam
 * that adapts the real `docker.ts` to this interface when isolated mode is in
 * use; in non-isolated mode `docker` is unused (the worker is an in-process
 * agent capture).
 */

import type { ChildProcess } from "node:child_process";
import type { CapturePaths, PhaseEntry } from "../types.js";

/** Mount spec used by `DockerLike.run` — same shape as bash `-v host:container`. */
export interface DockerMount {
  host: string;
  container: string;
  readOnly?: boolean;
}

/** Per-phase `docker run` opts. Lossless subset of `docker run`'s argv. */
export interface DockerRunOpts {
  name: string;
  image: string;
  mounts: readonly DockerMount[];
  env: NodeJS.ProcessEnv;
  /** The container command (after image). */
  cmd: readonly string[];
  rm?: boolean;
  init?: boolean;
  ipc?: string;
  shmSize?: string;
}

/** Result of a `docker run`. `code` is the container's exit code. */
export interface DockerRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** The slice of the phase-04 docker wrapper the orchestrator depends on. */
export interface DockerLike {
  run(opts: DockerRunOpts): Promise<DockerRunResult>;
  rmForce(name: string): Promise<void>;
}

/**
 * Live record for one worker. The driver keeps these in a map keyed by phase
 * id (matches the bash `PID`/`WT`/`PLOG`/`STREAM`/`TRANSCRIPT`/... assoc
 * arrays).
 */
export interface WorkerRecord {
  id: string;
  branch: string;
  worktree: string;
  paths: CapturePaths;
  /** Non-isolated: the child process group leader; isolated: undefined. */
  child?: ChildProcess;
  /** Isolated: container name (so the supervisor can rm-f it on poke/kill). */
  containerName?: string;
  /** Promise that resolves with the worker's exit code/signal. */
  done: Promise<WorkerExit>;
  /** Supervisor retries spent on this phase. */
  supervisorAttempts: number;
  /** Transient-API-error retries spent on this phase. */
  apiRetries: number;
  /** Optional resume session id for the NEXT relaunch. */
  resumeSid?: string;
  /** Last observed stream-file size + timestamp (watchdog). */
  stuckSize?: number;
  stuckSince?: number;
  /**
   * Best-effort kill closure — non-isolated only. The driver calls this when
   * a poke / watchdog needs to terminate a running agent (the bash
   * `kill_tree`); isolated mode uses `docker.rmForce(containerName)` instead.
   */
  kill?: () => Promise<void>;
}

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Eligibility check input (small wrapper so tests don't need a ManifestModel). */
export interface EligibilityState {
  phases: readonly PhaseEntry[];
  /** Ids currently launched and not yet reaped. */
  running: ReadonlySet<string>;
  maxParallel: number;
}
