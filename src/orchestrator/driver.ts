/**
 * Driver — the scheduler loop that ties worker + supervisor + control + the
 * manifest together. Ports the body of `run-loop.sh` (~698–782) along with
 * the inline `handle_exit` and bootstrap blocks.
 *
 * Exit codes match the bash contract:
 *   0  every phase merged (and the manifest's `**Status:**` flipped to complete)
 *   2  checkpoint reached (manifest marker or worker exit 2)
 *   3  dependency deadlock / malformed manifest
 *   4  worker reported a dependency error
 *   5  supervisor attempts exhausted in WIP state
 *   6  worker stopped without DONE_, supervisor could not recover (also: the
 *      convergence review gate parked a phase — oscillating / non-converging)
 *   7  hit MAX_ITER scheduling passes without completion
 *   8  KEEP_GOING run finished with one or more phases [blocked]
 *
 * `runDriver` returns the exit code (it does NOT call `process.exit`), so the
 * CLI (phase-07) decides on the process termination. The driver is otherwise
 * self-sufficient — it owns manifest writes, merges, signal-driven shutdown,
 * and the launch/reap loop.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { Config, ManifestModel, PhaseState, CapturePaths } from "../types.js";
import type { Git } from "../git.js";
import {
  parseManifest,
  setState as manifestSetState,
  setStatusComplete,
  allMerged,
  eligiblePhases,
} from "../manifest.js";
import {
  isRateLimited,
  isTransientApiError,
  parseCooldownSeconds,
  tailLines,
} from "../agent/detect.js";
import { captureAgent } from "../agent/capture.js";
import { onShutdown, installShutdownHandlers } from "../platform/signals.js";
import { runDir } from "../platform/paths.js";
import type { DockerLike, WorkerExit, WorkerRecord } from "./types.js";
import {
  prepareWorktree,
  setCapturePaths,
  launch,
  killWorker,
  cleanup,
  workerPromptSuffixIsolated,
  type WorkerDeps,
} from "./worker.js";
import {
  branchHasDone,
  markResume,
  mergePhase,
  supervise,
  type SupervisorContext,
  type SupervisorMode,
} from "./supervisor.js";
import {
  processControl,
  checkStuck,
} from "./control.js";
import {
  runReviewGate,
  newReviewMemory,
  buildReviewFixPrompt,
  renderReviewNote,
  type ReviewContext,
  type ReviewMemory,
  type RunReviewAgentArgs,
} from "./review.js";

// ── Exit-routing decision (pure) ─────────────────────────────────────────

export type ExitDecision =
  | { kind: "merge" }
  | { kind: "supervise"; carryCode: number }
  | { kind: "checkpoint" }
  | { kind: "depError" }
  | { kind: "rateLimitCooldown"; seconds: number }
  | { kind: "transientRetry" }
  | { kind: "park"; code: number; reason: string };

/**
 * Decide what the driver should do with a freshly-reaped worker. Pure — no
 * I/O. Used directly by `handleExit` and exposed for unit testing.
 *
 *   exit 0/5/6 with DONE_ on the branch → merge
 *   exit 0/5/6 without DONE_           → supervise (carry 6 for non-zero halt)
 *   exit 2                              → park (CHECKPOINT)
 *   exit 4                              → park (dependency error)
 *   anything else                       → rate-limit cooldown / transient
 *                                         retry / park, in that order.
 */
export function routeExit(args: {
  code: number;
  hasDone: boolean;
  logTail: string;
  config: Config;
  apiRetries: number;
}): ExitDecision {
  const { code, hasDone, logTail, config, apiRetries } = args;
  switch (code) {
    case 0:
    case 5:
    case 6:
      return hasDone ? { kind: "merge" } : { kind: "supervise", carryCode: 6 };
    case 2:
      return { kind: "checkpoint" };
    case 4:
      return { kind: "depError" };
    default: {
      if (isRateLimited(logTail)) {
        const secs = parseCooldownSeconds(logTail, config.defaultRateLimitSleep);
        return { kind: "rateLimitCooldown", seconds: secs };
      }
      if (
        config.retryTransientApi &&
        isTransientApiError(logTail) &&
        apiRetries < config.transientApiMaxRetries
      ) {
        return { kind: "transientRetry" };
      }
      return { kind: "park", code, reason: `worker exited ${code}` };
    }
  }
}

// ── Eligibility (thin wrapper for testability) ──────────────────────────

export function selectEligible(
  model: ManifestModel,
  running: ReadonlySet<string>,
  maxParallel: number,
): string[] {
  const eligible = eligiblePhases(model).filter((p) => !running.has(p.id));
  const slots = Math.max(0, maxParallel - running.size);
  return eligible.slice(0, slots).map((p) => p.id);
}

// ── Terminal-state decision ─────────────────────────────────────────────

export type TerminalDecision =
  | { kind: "continue" }
  | { kind: "complete" }
  | { kind: "halt"; code: number }
  | { kind: "deadlock" }
  | { kind: "finishKeepGoing"; blocked: number }
  | { kind: "launchPaused" };

export function selectTerminal(args: {
  model: ManifestModel;
  runningCount: number;
  failed: boolean;
  haltCode: number | undefined;
  launchPaused: boolean;
  keepGoing: boolean;
}): TerminalDecision {
  const { model, runningCount, failed, haltCode, launchPaused, keepGoing } = args;
  if (runningCount > 0) return { kind: "continue" };
  if (allMerged(model)) return { kind: "complete" };
  if (failed) return { kind: "halt", code: haltCode ?? 5 };
  if (launchPaused) return { kind: "launchPaused" };
  const blocked = model.phases.filter((p) => p.state === "blocked").length;
  if (keepGoing) return { kind: "finishKeepGoing", blocked };
  return { kind: "deadlock" };
}

// ── Manifest store (typed wrapper around the file + git commit) ──────────

export interface ManifestStore {
  /** Read + parse the current manifest. */
  read(): Promise<ManifestModel>;
  /** Update one phase's state, persist the file, commit. */
  setState(id: string, state: PhaseState): Promise<void>;
  /** Flip `**Status:**` to `complete` and commit. */
  markComplete(): Promise<void>;
  /** Read the raw file text (for marker/checkpoint scans). */
  readText(): Promise<string>;
}

export function manifestStore(config: Config, git: Git, log?: (m: string) => void): ManifestStore {
  const readText = async (): Promise<string> => fs.readFile(config.manifest, "utf8");
  return {
    async read(): Promise<ManifestModel> {
      return parseManifest(await readText());
    },
    async readText(): Promise<string> {
      return readText();
    },
    async setState(id: string, state: PhaseState): Promise<void> {
      const txt = await readText();
      const next = manifestSetState(txt, id, state);
      if (next === txt) return;
      await fs.writeFile(config.manifest, next, "utf8");
      await git.add(config.manifest);
      const r = await git.commit({ message: `chore(loop): ${id} -> ${state}` });
      if (r.code !== 0) log?.(`  [${id}] WARNING: state commit failed (code ${r.code}).`);
    },
    async markComplete(): Promise<void> {
      const txt = await readText();
      if (/^\*\*Status:\*\*\s+complete/m.test(txt)) return;
      const next = setStatusComplete(txt);
      await fs.writeFile(config.manifest, next, "utf8");
      await git.add(config.manifest);
      await git.commit({ message: `chore(loop): all phases merged — complete` });
    },
  };
}

// ── Driver inputs ───────────────────────────────────────────────────────

export interface DriverDeps {
  git: Git;
  docker?: DockerLike;
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Spawn for bootstrap commands; test seam. */
  shellRunFn?: (cmd: string, opts: { cwd: string }) => Promise<{ code: number | null }>;
  /** Optional manifest store override; default constructs one from git+config. */
  manifest?: ManifestStore;
}

export interface DriverInput {
  config: Config;
  baseBranch: string;
  workerPrompt: string;
  supervisorPrompt: string;
  /** Reviewer/skeptic prompt body — required only when `config.reviewEnabled`. */
  reviewerPrompt?: string;
  /** Override the default trunk-guard; matches BASE_BRANCH_EXPLICIT=1 in bash. */
  baseBranchExplicit?: boolean;
}

// ── The driver ──────────────────────────────────────────────────────────

const TRUNK_RE = /^(main|master)$/;
const CHECKPOINT_RE = /^<!--\s*LOOP-CHECKPOINT:/m;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export async function runDriver(deps: DriverDeps, input: DriverInput): Promise<number> {
  const { config, baseBranch, workerPrompt, supervisorPrompt } = input;
  const log = deps.log ?? ((m: string): void => console.log(m));
  const sleep = deps.sleep ?? defaultSleep;
  const store = deps.manifest ?? manifestStore(config, deps.git, log);
  const shellRun = deps.shellRunFn ?? defaultShellRun;

  // ── Trunk guard ─────────────────────────────────────────────────────
  if (TRUNK_RE.test(baseBranch) && !input.baseBranchExplicit) {
    log(
      `FATAL: refusing to land phase work on trunk '${baseBranch}'. Launch from a runner branch (e.g. 'autonomous-runner' cut from main), or set BASE_BRANCH_EXPLICIT=1 to override.`,
    );
    return 1;
  }

  // ── Bootstrap ───────────────────────────────────────────────────────
  await fs.mkdir(config.worktreesDir, { recursive: true });
  await fs.mkdir(config.controlDir, { recursive: true });

  if (config.isolated) {
    log(
      "Isolated mode: the orchestrator runs on the host; each phase installs its own clone inside its worker container — skipping host bootstrap.",
    );
  } else if (config.bootstrapCmd) {
    log(`Bootstrap: ${config.bootstrapCmd}`);
    const r = await shellRun(config.bootstrapCmd, { cwd: config.repoRoot });
    if (r.code !== 0)
      log("WARNING: bootstrap install failed; build/gate may fail until resolved.");
    if (config.buildCmd) {
      log(`Bootstrap: ${config.buildCmd} (best-effort)`);
      const rb = await shellRun(config.buildCmd, { cwd: config.repoRoot });
      if (rb.code !== 0)
        log("WARNING: bootstrap build failed; workers/supervisor will address it.");
    }
  } else {
    log("Bootstrap: no BOOTSTRAP_CMD configured — skipping install.");
  }

  // Verify manifest + prompt files exist (the bash version exits 3 on either).
  if (!(await fileExists(config.manifest))) {
    log(`Manifest not found at ${config.manifest}`);
    return 3;
  }
  if (!(await fileExists(config.promptFile))) {
    log(`Prompt file not found at ${config.promptFile}`);
    return 3;
  }

  // ── Live worker state ───────────────────────────────────────────────
  const running = new Map<string, WorkerRecord>();
  // Reaped records waiting for the next pass's terminal logic to consume them
  // (they keep paths/branch for branchHasDone after the reap).
  const finished: Array<{ record: WorkerRecord; exit: WorkerExit }> = [];

  const workerDeps: WorkerDeps = {
    git: deps.git,
    ...(deps.docker ? { docker: deps.docker } : {}),
    log,
  };

  // SIGINT/SIGTERM: TERM in-flight workers + cleanup their containers.
  installShutdownHandlers();
  const offShutdown = onShutdown(async () => {
    log("Received shutdown signal — terminating in-flight workers.");
    for (const rec of running.values()) {
      try {
        await killWorker(workerDeps, rec);
      } catch {
        /* ignore */
      }
    }
  });

  // Per-phase failure/state flags (the bash globals).
  let failed = false;
  let haltCode: number | undefined;

  // Usage window state.
  const clock = (): number => Math.floor(Date.now() / 1000);
  let windowStart = clock();
  let ticksInWindow = 0;

  const setState = async (id: string, state: PhaseState): Promise<void> => store.setState(id, state);

  const runSupervisorAgent = async (args: {
    id: string;
    prompt: string;
    record: WorkerRecord;
    mode: SupervisorMode;
  }): Promise<WorkerExit> => {
    if (config.isolated && deps.docker) {
      // Write supervisor prompt to the clone, then run worker container (the
      // entrypoint reads the same prompt file — the agent body just changes).
      const promptDir = runDir(args.record.worktree);
      await fs.mkdir(promptDir, { recursive: true });
      const promptPath = path.join(promptDir, `${args.id}.prompt.txt`);
      await fs.writeFile(promptPath, args.prompt + workerPromptSuffixIsolated(args.id), "utf8");
      const r = await deps.docker.run({
        name: `cp-w-${args.id}`,
        image: config.workerImage,
        rm: true,
        init: true,
        ipc: "host",
        shmSize: "2g",
        mounts: [{ host: args.record.worktree, container: "/work" }],
        env: {
          ...(process.env["ANTHROPIC_API_KEY"]
            ? { ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] }
            : {}),
          CLAUDOPILOT_PHASE: args.id,
          GATE_CMD: config.gateCmd,
          WORKTREE_PREPARE_CMD: config.worktreePrepareCmd,
          SUPERVISOR_MODE: args.mode,
        },
        cmd: ["bash", "/work/claudopilot/worker-entry.sh"],
      });
      return { code: r.code, signal: r.signal };
    }
    const res = await captureAgent({
      driver: config.agentDriver === "opencode" ? "opencode" : "claude",
      id: args.id,
      prompt: args.prompt,
      cwd: args.record.worktree,
      env: { ...process.env, SUPERVISOR_MODE: args.mode },
      paths: args.record.paths,
      ...(config.agentModel ? { model: config.agentModel } : {}),
      supervisorMode: true,
      attempt: args.record.supervisorAttempts,
    });
    return { code: res.code, signal: res.signal };
  };

  const supervisorCtx: SupervisorContext = {
    config,
    git: deps.git,
    ...(deps.docker ? { docker: deps.docker } : {}),
    log,
    runSupervisorAgent,
    setState,
  };

  // ── Convergence review gate (opt-in; see REVIEW-GATE.md) ────────────────
  // The round counter persists across worker relaunches, so it lives here keyed
  // by phase id — `launchPhase` builds a fresh WorkerRecord every relaunch.
  const reviewMemory = new Map<string, ReviewMemory>();
  // In isolated mode the worker runs in a container against a clone whose only
  // base ref is the remote-tracking `origin/<base>` captured at clone time; in
  // default mode the worktree shares the repo's local refs.
  const reviewBaseRef = config.isolated ? `origin/${baseBranch}` : baseBranch;

  /**
   * Run one reviewer/skeptic agent and return its captured transcript text (the
   * gate parses the JSON out of the text — it never trusts the exit code).
   *
   * Review runs read-only on the HOST against the phase's worktree/clone in both
   * modes: the reviewer never writes, commits, or pushes, so it does not need the
   * worker container's isolation (it does need the agent CLI on the host). Each
   * reviewer/skeptic gets its own capture slot so transcripts never collide.
   */
  const runReviewAgent = async (
    a: RunReviewAgentArgs,
  ): Promise<{ code: number | null; text: string }> => {
    const slot = `${a.id}.review.${a.slot}`;
    const paths: CapturePaths = {
      log: path.join(config.runDir, `${slot}.log`),
      stream: path.join(config.runDir, `${slot}.stream.jsonl`),
      transcript: path.join(config.runDir, `${slot}.transcript.md`),
    };
    const model = config.reviewModel || config.agentModel;
    const res = await captureAgent({
      driver: config.agentDriver === "opencode" ? "opencode" : "claude",
      id: `${a.id}:${a.slot}`,
      prompt: a.prompt,
      cwd: a.record.worktree,
      env: { ...process.env, REVIEW_ROLE: a.role, REVIEW_LENS: a.lens },
      paths,
      ...(model ? { model } : {}),
    });
    const text = await readSafe(paths.transcript);
    return { code: res.code, text };
  };

  const reviewCtx: ReviewContext = {
    config,
    git: deps.git,
    log,
    reviewerPromptBody: input.reviewerPrompt ?? "",
    runReviewAgent,
  };

  /** park OR halt based on KEEP_GOING; mirrors `park_or_halt`. */
  const parkOrHalt = async (id: string, code: number, reason: string): Promise<void> => {
    if (config.keepGoing) {
      log(`  [${id}] ${reason} (exit ${code}) — KEEP_GOING: parking auto/${id} as [blocked], continuing.`);
      await setState(id, "blocked");
    } else {
      log(`  [${id}] ${reason} (exit ${code}) — halting.`);
      await setState(id, "failed");
      failed = true;
      haltCode = code;
    }
  };

  const launchPhase = async (
    id: string,
    opts?: {
      supervisorMode?: SupervisorMode;
      resumeSid?: string;
      attempt?: number;
      /** Skip the first-launch capture truncation (review-fix relaunch). */
      keepCapture?: boolean;
      /** Verbatim prompt for the relaunch (review-fix); see worker.ts. */
      promptOverride?: string;
    },
  ): Promise<void> => {
    const pw = await prepareWorktree(workerDeps, { id, config, baseBranch });
    const paths = setCapturePaths(id, config, pw.worktree);
    // On first attempt of this run, blank the capture files (matches the bash
    // `SUPATT==0` reset). Supervisor retries and review-fix relaunches append.
    if (!opts?.attempt && !opts?.keepCapture) {
      await truncate(paths.log);
      await truncate(paths.stream);
      await truncate(paths.transcript);
    }
    await setState(id, "running");
    log(
      `  LAUNCH [${id}] (running=${running.size + 1}/${config.maxParallel})${opts?.resumeSid ? " [resume]" : ""} -> ${paths.transcript}`,
    );
    const rec = await launch(workerDeps, {
      id,
      config,
      workerPrompt,
      paths,
      worktree: pw.worktree,
      baseBranch,
      ...(opts?.resumeSid ? { resumeSid: opts.resumeSid } : {}),
      ...(opts?.supervisorMode ? { supervisorMode: opts.supervisorMode } : {}),
      ...(opts?.attempt !== undefined ? { attempt: opts.attempt } : {}),
      ...(opts?.promptOverride ? { promptOverride: opts.promptOverride } : {}),
    });
    running.set(id, rec);
    // Hook the exit promise into the finished queue.
    void rec.done.then((exit) => {
      finished.push({ record: rec, exit });
    });
    ticksInWindow++;
  };

  /** The real merge funnel — used directly when review is off, and as the
   * `merge` outcome of the review gate when it is on. */
  const doMerge = async (record: WorkerRecord): Promise<void> => {
    const m = await mergePhase(
      config,
      deps.git,
      record,
      setState,
      async (id) => cleanup(workerDeps, id, config),
      baseBranch,
      log,
    );
    if (!m.ok) await parkOrHalt(record.id, 1, m.reason ?? "merge conflict");
  };

  /**
   * The single merge funnel for both a worker-reported `done` and a
   * supervisor-recovered phase. With review off this is a straight merge; with
   * review on it runs one review round (see REVIEW-GATE.md) and applies the
   * outcome: `merge` → real merge; `fix` → relaunch the worker with the findings
   * (the relaunch's exit re-enters this funnel); `park` → parkOrHalt [blocked].
   */
  const mergeOrReview = async (record: WorkerRecord): Promise<void> => {
    if (!config.reviewEnabled) {
      await doMerge(record);
      return;
    }
    const memory = reviewMemory.get(record.id) ?? newReviewMemory();
    reviewMemory.set(record.id, memory);
    const outcome = await runReviewGate({ ctx: reviewCtx, record, memory, baseBranch: reviewBaseRef });
    switch (outcome.kind) {
      case "merge":
        reviewMemory.delete(record.id);
        await doMerge(record);
        break;
      case "fix": {
        // Persist the findings in the worktree too, so a human (or a cold
        // session) can read them independently of the relaunch prompt.
        if (outcome.findings.length > 0) {
          const notePath = path.join(record.worktree, config.roadmapDir, `${record.id}.review.md`);
          try {
            await fs.mkdir(path.dirname(notePath), { recursive: true });
            await fs.writeFile(notePath, renderReviewNote(record.id, outcome.findings), "utf8");
          } catch {
            /* best-effort — the relaunch prompt also carries the findings */
          }
        }
        log(`  [${record.id}] review: relaunching worker to fix ${outcome.findings.length} confirmed finding(s).`);
        await launchPhase(record.id, {
          attempt: record.supervisorAttempts,
          keepCapture: true,
          ...(outcome.findings.length > 0
            ? { promptOverride: buildReviewFixPrompt(workerPrompt, record.id, outcome.findings) }
            : {}),
        });
        break;
      }
      case "park":
        reviewMemory.delete(record.id);
        await parkOrHalt(record.id, 6, outcome.reason);
        break;
    }
  };

  /** Apply the routing decision from supervise(). */
  const applySuperviseOutcome = async (record: WorkerRecord, exitCode: number, body: string): Promise<void> => {
    const outcome = await supervise(supervisorCtx, record, exitCode, body);
    switch (outcome.kind) {
      case "merged": {
        await mergeOrReview(record);
        break;
      }
      case "relaunch": {
        log(`  [${record.id}] relaunching worker on same worktree.`);
        await launchPhase(record.id, { attempt: record.supervisorAttempts });
        break;
      }
      case "rateLimitCooldown": {
        log(`  Rate-limit cooldown: ${outcome.seconds}s`);
        await sleep(outcome.seconds * 1000);
        await setState(record.id, "pending");
        break;
      }
      case "transientRetry": {
        await setState(record.id, "pending");
        break;
      }
      case "park": {
        await parkOrHalt(record.id, outcome.code, outcome.reason);
        break;
      }
    }
  };

  const handleExit = async (record: WorkerRecord, exit: WorkerExit): Promise<void> => {
    const code = exit.code ?? 1;
    log(`REAP [${record.id}] worker exit=${code}`);
    const logText = tailLines(await readSafe(record.paths.log));
    const hasDone = await branchHasDone(config, deps.git, record.id, record.worktree);
    const decision = routeExit({
      code,
      hasDone,
      logTail: logText,
      config,
      apiRetries: record.apiRetries,
    });

    switch (decision.kind) {
      case "merge": {
        await mergeOrReview(record);
        break;
      }
      case "supervise": {
        await applySuperviseOutcome(record, decision.carryCode, supervisorPrompt);
        break;
      }
      case "checkpoint": {
        await parkOrHalt(record.id, 2, "worker reported CHECKPOINT");
        break;
      }
      case "depError": {
        await parkOrHalt(record.id, 4, "worker reported dependency error");
        break;
      }
      case "rateLimitCooldown": {
        log(`  [${record.id}] rate-limit-shaped exit; relaunch after cooldown.`);
        await sleep(decision.seconds * 1000);
        markResume(record, log);
        await setState(record.id, "pending");
        break;
      }
      case "transientRetry": {
        record.apiRetries++;
        log(
          `  [${record.id}] transient API error — relaunching (retry ${record.apiRetries}/${config.transientApiMaxRetries}).`,
        );
        markResume(record, log);
        await setState(record.id, "pending");
        break;
      }
      case "park": {
        await parkOrHalt(record.id, decision.code, decision.reason);
        break;
      }
    }
  };

  // ── Main loop ──────────────────────────────────────────────────────
  let iter = 0;
  let exitCode: number | undefined;
  try {
    while (iter < config.maxIter) {
      iter++;

      // Completion check (top-of-loop, before reap/launch).
      if (running.size === 0 && finished.length === 0) {
        const model = await store.read();
        if (allMerged(model)) {
          await store.markComplete();
          await deps.git.push("origin", baseBranch);
          log(`All phases merged after ${iter} passes. Exiting 0.`);
          exitCode = 0;
          break;
        }
      }

      // Drain reaped workers (any number).
      while (finished.length > 0) {
        const { record, exit } = finished.shift()!;
        running.delete(record.id);
        await handleExit(record, exit);
      }

      // Control + watchdog.
      await processControl({
        controlDir: config.controlDir,
        readManifest: () => store.read(),
        running,
        killWorker: (_id, rec) => killWorker(workerDeps, rec),
        setState,
        markResume: (_id, rec) => {
          markResume(rec, log);
        },
        resetApiRetries: (id) => {
          const r = running.get(id);
          if (r) r.apiRetries = 0;
        },
        log,
      });
      await checkStuck({
        stuckTimeout: config.stuckTimeout,
        running,
        poke: async (id, rec, reason) => {
          log(`  [${id}] ${reason} — killing + relaunching worker.`);
          await killWorker(workerDeps, rec);
          markResume(rec, log);
          await setState(id, "pending");
          running.delete(id);
        },
        log,
      });

      // Checkpoint marker (policy pause).
      if (!config.ignoreLoopCheckpoints && !config.keepGoing) {
        const text = await store.readText();
        if (CHECKPOINT_RE.test(text) && running.size === 0) {
          log("LOOP-CHECKPOINT reached; remove the marker and re-run. Exiting 2.");
          exitCode = 2;
          break;
        }
      }

      // Usage window roll + launch gating.
      const now = clock();
      let age = now - windowStart;
      if (age >= config.usageWindowSeconds) {
        windowStart = now;
        ticksInWindow = 0;
        age = 0;
      }
      const usagePct = Math.floor((100 * ticksInWindow) / Math.max(1, config.maxTicksPerWindow));
      const launchPaused = usagePct >= config.usageThresholdPct;

      // Launch eligible up to the cap.
      if (!failed && !launchPaused) {
        const model = await store.read();
        const eligible = selectEligible(model, new Set(running.keys()), config.maxParallel);
        for (const id of eligible) {
          if (running.size >= config.maxParallel) break;
          try {
            await launchPhase(id);
          } catch (e) {
            log(`  [${id}] launch failed: ${(e as Error).message}`);
            await parkOrHalt(id, 1, "launch error");
          }
        }
      }

      // Terminal detection.
      if (running.size === 0 && finished.length === 0) {
        const model = await store.read();
        const term = selectTerminal({
          model,
          runningCount: 0,
          failed,
          haltCode,
          launchPaused,
          keepGoing: config.keepGoing,
        });
        if (term.kind === "complete") {
          continue; // top-of-loop handler will set the marker + exit 0
        }
        if (term.kind === "halt") {
          log(`Halt: a phase failed (exit ${term.code}); no workers remain.`);
          exitCode = term.code;
          break;
        }
        if (term.kind === "launchPaused") {
          const sleepSecs = config.usageWindowSeconds - age + 60;
          log(`Usage at ${usagePct}%; nothing running; sleeping ${sleepSecs}s for window reset.`);
          await sleep(sleepSecs * 1000);
          windowStart = clock();
          ticksInWindow = 0;
          continue;
        }
        if (term.kind === "finishKeepGoing") {
          await finishKeepGoing(store, setState, log);
          const m = await store.read();
          const newBlocked = m.phases.filter((p) => p.state === "blocked").length;
          exitCode = newBlocked > 0 ? 8 : 0;
          log(`KEEP_GOING finished: ${m.phases.filter((p) => p.state === "merged").length} merged, ${newBlocked} blocked.`);
          break;
        }
        if (term.kind === "deadlock") {
          log("No running workers and no eligible pending phase — dependency deadlock or malformed manifest. Exiting 3.");
          exitCode = 3;
          break;
        }
      }

      await sleep(config.pollSeconds * 1000);
    }

    if (exitCode === undefined) {
      log(`Hit MAX_ITER (${config.maxIter}) scheduling passes without completion. Exiting 7.`);
      exitCode = 7;
    }
    return exitCode;
  } finally {
    offShutdown();
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function readSafe(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

async function truncate(p: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "");
  } catch {
    /* ignore */
  }
}

async function finishKeepGoing(
  store: ManifestStore,
  setState: (id: string, s: PhaseState) => Promise<void>,
  log: (m: string) => void,
): Promise<void> {
  const model = await store.read();
  for (const p of model.phases) {
    if (p.state === "pending") {
      await setState(p.id, "blocked");
      log(`  [${p.id}] stranded behind a blocked dependency — marked [blocked].`);
    }
  }
}

async function defaultShellRun(
  cmd: string,
  opts: { cwd: string },
): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn("bash", ["-c", cmd], {
      cwd: opts.cwd,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", () => resolve({ code: 1 }));
    child.once("close", (code) => resolve({ code }));
  });
}
