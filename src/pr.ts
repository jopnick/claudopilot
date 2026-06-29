/**
 * Open a GitHub pull request via the `gh` CLI.
 *
 * Used at run completion when `config.openPr` is set. By then the loop has
 * squash-merged every phase into the base (runner) branch, so a single PR
 * `baseBranch → prBase` is a clean, one-commit-per-phase changeset for review —
 * the natural follow-on to the per-phase squash merges.
 *
 * Host-side and best-effort: it needs `gh` installed and authenticated on the
 * machine the driver runs on. It never throws — a missing or unauthenticated
 * `gh`, or any failure, comes back as a typed result the driver logs past.
 */

import { spawnCapture, type SpawnCaptureResult } from "./platform/process.js";

/** The spawn surface `openPullRequest` uses — injectable so tests need no real `gh`. */
export type RunFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<SpawnCaptureResult>;

export interface OpenPrOptions {
  /** Repo working directory (`gh` infers the remote/repo from here). */
  cwd: string;
  /** The branch the work landed on (PR source) — `--head`. */
  head: string;
  /** The PR target branch (e.g. "main") — `--base`. */
  base: string;
  /** Optional title override; when empty the title is derived from commits. */
  title?: string;
  /** Open as a draft PR. */
  draft?: boolean;
  /** Env overlay for the `gh` invocation (defaults to the process env). */
  env?: NodeJS.ProcessEnv;
}

export interface OpenPrResult {
  ok: boolean;
  /** The PR URL, when one could be parsed from `gh` output. */
  url?: string;
  /** Failure detail (only set when `ok` is false). */
  reason?: string;
  /** True when an open PR for head→base already existed (treated as success). */
  alreadyExists?: boolean;
}

export type OpenPrFn = (opts: OpenPrOptions) => Promise<OpenPrResult>;

/**
 * `gh pr create --base <base> --head <head> --fill [--title <t>] [--draft]`.
 *
 * `--fill` populates the title and body from the branch's commits, which also
 * keeps the call non-interactive (no body prompt on a TTY-less host). A
 * `--title` overrides just the subject. An already-open PR is reported as
 * success so a re-run of a completed loop is idempotent.
 *
 * `run` is injectable purely as a test seam (defaults to the real `gh` spawn).
 */
export async function openPullRequest(
  opts: OpenPrOptions,
  run: RunFn = spawnCapture,
): Promise<OpenPrResult> {
  const args = ["pr", "create", "--base", opts.base, "--head", opts.head, "--fill"];
  if (opts.title) args.push("--title", opts.title);
  if (opts.draft) args.push("--draft");

  let res;
  try {
    res = await run("gh", args, {
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
    });
  } catch (e) {
    return { ok: false, reason: `gh not available (${(e as Error).message})` };
  }

  const combined = `${res.stdout}\n${res.stderr}`;
  if (res.code === 0) {
    const url = extractUrl(combined);
    return { ok: true, ...(url ? { url } : {}) };
  }
  // `gh` exits non-zero when a PR for this head already exists — idempotent win.
  if (/already exists/i.test(combined)) {
    const url = extractUrl(combined);
    return { ok: true, alreadyExists: true, ...(url ? { url } : {}) };
  }
  return { ok: false, reason: (res.stderr || res.stdout || `gh exited ${res.code}`).trim() };
}

function extractUrl(s: string): string | undefined {
  const m = s.match(/https?:\/\/\S+/);
  return m ? m[0] : undefined;
}
