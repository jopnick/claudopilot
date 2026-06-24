/**
 * Typed wrapper over `git` covering exactly what the engine uses.
 *
 * Ports the ~50 `git` invocations in run-loop.sh through a single surface
 * over `spawnCapture`. Each method returns the raw `{ code, stdout, stderr }`
 * result by default and **never throws on a non-zero exit** — callers branch
 * on `code` (the same shape run-loop.sh relies on). A few read helpers
 * return a typed value derived from a 0-exit (e.g. `currentBranch()`).
 *
 * The `git` binary is resolved through PATH (set GIT_BIN to override). The
 * worker always runs in a Linux container, so this stays POSIX-style.
 */

import { spawnCapture, type SpawnCaptureResult } from "./platform/process.js";

export type GitResult = SpawnCaptureResult;

export interface GitOptions {
  /** Working directory for `git -C <cwd>`. Required. */
  cwd: string;
  /** Override the `git` binary path. Default: "git" (PATH-resolved). */
  bin?: string;
  /** Optional env passed through to every git invocation. */
  env?: NodeJS.ProcessEnv;
}

export interface MergeOptions {
  noFf?: boolean;
  message?: string;
}

export interface CommitOptions {
  message: string;
  noVerify?: boolean;
  allowEmpty?: boolean;
}

export interface FetchOptions {
  quiet?: boolean;
}

export class Git {
  private readonly cwd: string;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(opts: GitOptions) {
    this.cwd = opts.cwd;
    this.bin = opts.bin ?? "git";
    this.env = opts.env;
  }

  /**
   * Run an arbitrary `git` subcommand. Returns the raw spawn result; never
   * throws on non-zero. Use this for one-offs that don't have a dedicated
   * method yet (keeps the API small).
   */
  async run(args: readonly string[]): Promise<GitResult> {
    return spawnCapture(this.bin, args, {
      cwd: this.cwd,
      env: this.env,
    });
  }

  // ── Refs / branches ───────────────────────────────────────────────────

  /** `git rev-parse --abbrev-ref HEAD`. Returns null on non-zero. */
  async currentBranch(): Promise<string | null> {
    const r = await this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (r.code !== 0) return null;
    return r.stdout.trim();
  }

  /** `git rev-parse <ref>` — useful for SHA lookups; null on non-zero. */
  async revParse(ref: string): Promise<string | null> {
    const r = await this.run(["rev-parse", ref]);
    if (r.code !== 0) return null;
    return r.stdout.trim();
  }

  /** True iff `refs/heads/<branch>` exists locally. */
  async branchExists(branch: string): Promise<boolean> {
    const r = await this.run([
      "show-ref",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return r.code === 0;
  }

  /** `git branch <branch> <startPoint>`. */
  async createBranch(branch: string, startPoint: string): Promise<GitResult> {
    return this.run(["branch", branch, startPoint]);
  }

  /** `git branch -D <branch>`. */
  async deleteBranch(branch: string): Promise<GitResult> {
    return this.run(["branch", "-D", branch]);
  }

  /** `git checkout -q <ref>`. */
  async checkout(ref: string): Promise<GitResult> {
    return this.run(["checkout", "-q", ref]);
  }

  // ── Worktrees / clone ─────────────────────────────────────────────────

  /** `git worktree add <path> <branch>`. */
  async worktreeAdd(worktreePath: string, branch: string): Promise<GitResult> {
    return this.run(["worktree", "add", worktreePath, branch]);
  }

  /** `git worktree remove <path> --force`. */
  async worktreeRemove(worktreePath: string): Promise<GitResult> {
    return this.run(["worktree", "remove", worktreePath, "--force"]);
  }

  /**
   * `git clone --quiet [--branch <b>] <source> <dest>`. Note: this runs in
   * THIS Git instance's cwd, but clone targets `<dest>` (absolute path
   * recommended).
   */
  async clone(
    source: string,
    dest: string,
    opts: { branch?: string } = {},
  ): Promise<GitResult> {
    const args = ["clone", "--quiet"];
    if (opts.branch) args.push("--branch", opts.branch);
    args.push(source, dest);
    return this.run(args);
  }

  // ── Merge / fetch / pull / push ───────────────────────────────────────

  /** `git merge [--no-ff] <branch> [-m <msg>]`. */
  async merge(branch: string, opts: MergeOptions = {}): Promise<GitResult> {
    const args = ["merge"];
    if (opts.noFf) args.push("--no-ff");
    args.push(branch);
    if (opts.message) args.push("-m", opts.message);
    return this.run(args);
  }

  /** `git merge --abort`. */
  async mergeAbort(): Promise<GitResult> {
    return this.run(["merge", "--abort"]);
  }

  /** `git fetch [--quiet] <remote> <refspec>`. */
  async fetchRef(
    remote: string,
    refspec: string,
    opts: FetchOptions = {},
  ): Promise<GitResult> {
    const args = ["fetch"];
    if (opts.quiet) args.push("--quiet");
    args.push(remote, refspec);
    return this.run(args);
  }

  /** `git pull --ff-only <remote> <branch>`. */
  async pullFfOnly(remote: string, branch: string): Promise<GitResult> {
    return this.run(["pull", "--ff-only", remote, branch]);
  }

  /** `git push <remote> <branch>`. */
  async push(remote: string, branch: string): Promise<GitResult> {
    return this.run(["push", remote, branch]);
  }

  /** `git push <remote> --delete <branch>`. */
  async pushDelete(remote: string, branch: string): Promise<GitResult> {
    return this.run(["push", remote, "--delete", branch]);
  }

  // ── Index / commits ───────────────────────────────────────────────────

  /** `git add <pathspec...>`. */
  async add(pathspec: string | string[]): Promise<GitResult> {
    const paths = Array.isArray(pathspec) ? pathspec : [pathspec];
    return this.run(["add", ...paths]);
  }

  /** `git commit -q [-m <msg>] [--no-verify] [--allow-empty]`. */
  async commit(opts: CommitOptions): Promise<GitResult> {
    const args = ["commit", "-q", "-m", opts.message];
    if (opts.noVerify) args.push("--no-verify");
    if (opts.allowEmpty) args.push("--allow-empty");
    return this.run(args);
  }

  /** True iff the index has staged changes for the given pathspec. */
  async hasStagedChanges(pathspec?: string): Promise<boolean> {
    const args = ["diff", "--cached", "--quiet"];
    if (pathspec) args.push("--", pathspec);
    const r = await this.run(args);
    // `--quiet` exits 1 when there ARE differences, 0 when clean.
    return r.code === 1;
  }

  /** Files with unresolved merge conflicts. Empty list iff clean. */
  async unresolvedConflicts(): Promise<string[]> {
    const r = await this.run([
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    if (r.code !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /** `git checkout --ours -- <path>` (used during conflict auto-resolution). */
  async checkoutOurs(pathspec: string): Promise<GitResult> {
    return this.run(["checkout", "--ours", "--", pathspec]);
  }

  // ── Read-only inspection (lsTree, log) ────────────────────────────────

  /**
   * `git ls-tree -r --name-only <ref>` — used by the driver's
   * `branch_has_done` to look for `DONE_<id>*` files on a branch tip.
   */
  async lsTree(ref: string): Promise<string[]> {
    const r = await this.run(["ls-tree", "-r", "--name-only", ref]);
    if (r.code !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * `git log <ref> --oneline -- <pathspec>` — the other half of
   * `branch_has_done` (a commit ever touched this path).
   */
  async logTouching(ref: string, pathspec: string): Promise<string[]> {
    const r = await this.run(["log", ref, "--oneline", "--", pathspec]);
    if (r.code !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // ── Config ────────────────────────────────────────────────────────────

  /** `git config <key>` — returns the value or null. */
  async configGet(key: string): Promise<string | null> {
    const r = await this.run(["config", key]);
    if (r.code !== 0) return null;
    return r.stdout.replace(/\r?\n$/, "");
  }

  /** `git config <key> <value>`. */
  async configSet(key: string, value: string): Promise<GitResult> {
    return this.run(["config", key, value]);
  }
}

/** Convenience constructor matching the typical call site. */
export function git(cwd: string, opts: Partial<GitOptions> = {}): Git {
  return new Git({ cwd, ...opts });
}
