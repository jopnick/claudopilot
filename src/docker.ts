/**
 * Typed wrapper over `docker` covering exactly what the engine uses.
 *
 * Ports the docker invocations in run-in-docker.sh + run-loop.sh's
 * run_phase_container/cleanup_worktree through a single surface over
 * `spawnCapture`. Like `Git`, it never throws on a non-zero exit — callers
 * inspect `code` (matches the bash error-handling shape).
 *
 * Each public method has a paired `buildArgs*` pure function used by tests
 * to assert the exact argv that would be passed to docker, without actually
 * invoking it. Mounts go through `platform/dockerPath` so host paths
 * resolve correctly inside the container on Linux/macOS/WSL2/Win32.
 */

import { spawnCapture, type SpawnCaptureResult } from "./platform/process.js";
import { toContainerPath } from "./platform/dockerPath.js";

export type DockerResult = SpawnCaptureResult;

export interface DockerOptions {
  /** Override the `docker` binary path. Default: "docker" (PATH-resolved). */
  bin?: string;
  /** Host platform override (test seam). Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Optional env forwarded to every docker invocation. */
  env?: NodeJS.ProcessEnv;
}

export interface Mount {
  /** Host path (will be normalized through `dockerPath`). */
  source: string;
  /** Container path (POSIX). */
  target: string;
  readonly?: boolean;
}

export interface PortPublish {
  /** Host interface bind, e.g. "127.0.0.1". Optional → docker default. */
  hostIp?: string;
  hostPort: number;
  containerPort: number;
}

export interface BuildSpec {
  tag: string;
  dockerfile: string;
  /** Build context directory. Default: ".". */
  context?: string;
  buildArgs?: Record<string, string>;
}

export interface RunSpec {
  image: string;
  name?: string;
  /** --rm. Default true. */
  rm?: boolean;
  /** --init. Default false. */
  init?: boolean;
  /** -i, -t, or both. Default neither. */
  interactive?: boolean;
  tty?: boolean;
  /** -d (background). Default false. */
  detach?: boolean;
  /** --ipc=<mode>. Typical: "host". */
  ipc?: string;
  /** --shm-size=<size>, e.g. "2g". */
  shmSize?: string;
  mounts?: Mount[];
  publish?: PortPublish[];
  /**
   * Environment forwarding. A string is `-e KEY` (forward from host); a
   * `{key,value}` pair is `-e KEY=VAL`. Mixed order preserved.
   */
  env?: Array<string | { key: string; value: string }>;
  /** Argv passed to the container after the image. */
  cmd?: string[];
}

export interface ExecSpec {
  name: string;
  /** -i, -t, or both. */
  interactive?: boolean;
  tty?: boolean;
  cmd: string[];
}

export interface PsFilter {
  /** Repeatable docker --filter pairs, e.g. {name: "cp-w-"}. */
  [key: string]: string;
}

export class Docker {
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly platform: NodeJS.Platform;

  constructor(opts: DockerOptions = {}) {
    this.bin = opts.bin ?? "docker";
    this.env = opts.env;
    this.platform = opts.platform ?? process.platform;
  }

  /** Run an arbitrary docker subcommand; raw spawn result. */
  async run(args: readonly string[]): Promise<DockerResult> {
    return spawnCapture(this.bin, args, { env: this.env });
  }

  // ── build ────────────────────────────────────────────────────────────

  async build(spec: BuildSpec): Promise<DockerResult> {
    return this.run(buildArgs(spec));
  }

  // ── run ──────────────────────────────────────────────────────────────

  /**
   * `docker run ...`. By default this returns when the child exits, so for
   * interactive/long-lived containers prefer constructing the argv via
   * `runArgs` and feeding it to `spawnDetached`/`spawn` directly.
   */
  async runContainer(spec: RunSpec): Promise<DockerResult> {
    return this.run(runArgs(spec, { platform: this.platform }));
  }

  // ── rm -f ────────────────────────────────────────────────────────────

  async rmForce(name: string): Promise<DockerResult> {
    return this.run(rmForceArgs(name));
  }

  // ── ps ───────────────────────────────────────────────────────────────

  /** `docker ps -a --format '{{.Names}}' [--filter k=v ...]`. */
  async ps(filter: PsFilter = {}): Promise<string[]> {
    const r = await this.run(psArgs(filter));
    if (r.code !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // ── exec ─────────────────────────────────────────────────────────────

  async exec(spec: ExecSpec): Promise<DockerResult> {
    return this.run(execArgs(spec));
  }
}

/** Convenience constructor. */
export function docker(opts: DockerOptions = {}): Docker {
  return new Docker(opts);
}

// ─── pure argv builders (the test surface) ──────────────────────────────

export function buildArgs(spec: BuildSpec): string[] {
  const args = ["build", "-t", spec.tag, "-f", spec.dockerfile];
  for (const [k, v] of Object.entries(spec.buildArgs ?? {})) {
    args.push("--build-arg", `${k}=${v}`);
  }
  args.push(spec.context ?? ".");
  return args;
}

export interface RunArgsOptions {
  platform?: NodeJS.Platform;
}

export function runArgs(spec: RunSpec, opts: RunArgsOptions = {}): string[] {
  const args = ["run"];
  if (spec.rm ?? true) args.push("--rm");
  if (spec.detach) args.push("-d");
  if (spec.interactive) args.push("-i");
  if (spec.tty) args.push("-t");
  if (spec.init) args.push("--init");
  if (spec.name) args.push("--name", spec.name);
  if (spec.ipc) args.push(`--ipc=${spec.ipc}`);
  if (spec.shmSize) args.push(`--shm-size=${spec.shmSize}`);

  for (const m of spec.mounts ?? []) {
    args.push("-v", mountSpec(m, opts.platform));
  }
  for (const p of spec.publish ?? []) {
    args.push("-p", publishSpec(p));
  }
  for (const e of spec.env ?? []) {
    if (typeof e === "string") args.push("-e", e);
    else args.push("-e", `${e.key}=${e.value}`);
  }

  args.push(spec.image);
  for (const c of spec.cmd ?? []) args.push(c);
  return args;
}

export function rmForceArgs(name: string): string[] {
  return ["rm", "-f", name];
}

export function psArgs(filter: PsFilter = {}): string[] {
  const args = ["ps", "-a", "--format", "{{.Names}}"];
  for (const [k, v] of Object.entries(filter)) {
    args.push("--filter", `${k}=${v}`);
  }
  return args;
}

export function execArgs(spec: ExecSpec): string[] {
  const args = ["exec"];
  if (spec.interactive) args.push("-i");
  if (spec.tty) args.push("-t");
  args.push(spec.name);
  for (const c of spec.cmd) args.push(c);
  return args;
}

// ─── helpers ────────────────────────────────────────────────────────────

function mountSpec(m: Mount, platform?: NodeJS.Platform): string {
  const src = toContainerPath(m.source, platform ? { platform } : {});
  const base = `${src}:${m.target}`;
  return m.readonly ? `${base}:ro` : base;
}

function publishSpec(p: PortPublish): string {
  if (p.hostIp) return `${p.hostIp}:${p.hostPort}:${p.containerPort}`;
  return `${p.hostPort}:${p.containerPort}`;
}
