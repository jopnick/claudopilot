/**
 * In-process agent capture pipeline — TS replacement for the bash
 *
 *     claude -p … --output-format stream-json 2>>$log
 *       | tee -a $stream
 *       | node render-stream.mjs
 *       | tee -a $transcript >> $log
 *
 * pipeline in `run-loop.sh::capture_agent` and `worker-entry.sh`. The
 * renderer lives inside this process (no `tee` binaries, no `node
 * render-stream.mjs` subprocess), so the platform shims and renderer
 * stay portable.
 *
 * `captureAgent` resolves with the agent's exit summary. It does NOT
 * decide what to do with the result — that is the driver's job (phase-06).
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { CapturePaths } from "../types.js";
import { RenderStream } from "./render.js";
import { OpencodeRenderStream } from "./renderOpencode.js";

export type AgentDriver = "claude" | "opencode";

export interface CaptureAgentOptions {
  driver: AgentDriver;
  /** Phase id — used only for the appended header banner. */
  id: string;
  /** The composed worker prompt (when not resuming) or the resume nudge. */
  prompt: string;
  /** Existing claude session id; when set, branches to `--resume <sid>`. */
  resumeSid?: string;
  /** Working directory the agent runs in (the worktree / clone). */
  cwd: string;
  /** Environment overlay; merged with process.env. */
  env?: NodeJS.ProcessEnv;
  /** Output file paths (log, stream, transcript). */
  paths: CapturePaths;
  /** Optional model passthrough — opencode only uses it. */
  model?: string;
  /** Optional supervisor mode tag for the transcript banner. */
  supervisorMode?: boolean;
  /** Optional attempt number for the transcript banner. */
  attempt?: number;
  /**
   * Spawner override for tests. Same shape as `node:child_process.spawn`.
   * Production passes `undefined` and we use the real spawn.
   */
  spawn?: typeof spawn;
}

export interface CaptureAgentResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const RESUME_NUDGE =
  "A transient interruption (network/API error, watchdog, or poke) stopped you mid-run and your session has now been resumed — your prior context is intact. Re-read the ## Status checklist in your phase doc, then continue from the first unchecked slice. Same contract: build each remaining slice, keep the gate green, rename the phase doc to DONE_ when all slices are done, then stop. Do NOT re-seed the checklist, merge, or edit the manifest.";

export { RESUME_NUDGE };

/** Build the argv for `claude -p` / `claude --resume <sid> -p`. */
export function buildClaudeArgs(prompt: string, resumeSid?: string): string[] {
  const head = resumeSid ? ["--resume", resumeSid, "-p", prompt] : ["-p", prompt];
  return [
    ...head,
    "--permission-mode",
    "bypassPermissions",
    "--verbose",
    "--output-format",
    "stream-json",
  ];
}

/** Build the argv for `opencode run "$prompt" [-m $model] --format json …`. */
export function buildOpencodeArgs(prompt: string, model?: string): string[] {
  const m = model && model.length > 0 ? ["-m", model] : [];
  return [
    "run",
    prompt,
    ...m,
    "--format",
    "json",
    "--dangerously-skip-permissions",
  ];
}

async function appendBanner(
  transcript: WriteStream,
  id: string,
  supervisorMode: boolean,
  attempt: number,
  resumeSid: string | undefined,
): Promise<void> {
  const role = supervisorMode ? "supervisor " : "";
  const resume = resumeSid ? ` resume=${resumeSid}` : "";
  await write(
    transcript,
    `\n=== [${id}] ${role}run (attempt ${attempt})${resume} ===\n`,
  );
}

function write(s: WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (s.write(chunk)) resolve();
    else s.once("drain", () => resolve());
    s.once("error", reject);
  });
}

function finish(s: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    s.end(() => resolve());
  });
}

/**
 * Run one agent attempt, teeing raw NDJSON → `paths.stream`, rendered
 * transcript → `paths.transcript`, and stderr+rendered → `paths.log`.
 * Files are opened in append mode so retries and the bash-side header
 * stay non-destructive (the bash version uses `>>`).
 *
 * The promise resolves with the agent's exit code/signal; it never
 * throws for non-zero. It rejects only when the child cannot be spawned.
 */
export async function captureAgent(
  opts: CaptureAgentOptions,
): Promise<CaptureAgentResult> {
  const {
    driver,
    id,
    prompt,
    resumeSid,
    cwd,
    env,
    paths,
    model,
    supervisorMode = false,
    attempt = 0,
  } = opts;

  for (const p of [paths.log, paths.stream, paths.transcript]) {
    await mkdir(dirname(p), { recursive: true });
  }

  const logFh = createWriteStream(paths.log, { flags: "a" });
  const streamFh = createWriteStream(paths.stream, { flags: "a" });
  const transcriptFh = createWriteStream(paths.transcript, { flags: "a" });

  try {
    await appendBanner(transcriptFh, id, supervisorMode, attempt, resumeSid);

    const cmd = driver === "opencode" ? "opencode" : "claude";
    const args =
      driver === "opencode"
        ? buildOpencodeArgs(prompt, model)
        : buildClaudeArgs(prompt, resumeSid);

    const spawner = opts.spawn ?? spawn;
    const child: ChildProcess = spawner(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const onRender = (chunk: string): void => {
      transcriptFh.write(chunk);
      logFh.write(chunk);
    };
    const renderer: RenderStream | OpencodeRenderStream =
      driver === "opencode"
        ? new OpencodeRenderStream(onRender)
        : new RenderStream(onRender);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      streamFh.write(chunk);
      renderer.push(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      logFh.write(chunk);
    });

    const exit = await new Promise<CaptureAgentResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        renderer.end();
        resolve({ code, signal });
      });
    });

    return exit;
  } finally {
    await Promise.all([
      finish(logFh),
      finish(streamFh),
      finish(transcriptFh),
    ]);
  }
}
