/**
 * Cross-engineer phase coordination via git ref "locks".
 *
 * Multiple engineers can run claudopilot against the same shared remote. Within
 * a single run, concurrent phases are kept safe by package-disjointness + serial
 * merges; ACROSS runs there is no shared scheduler, so two engineers could
 * otherwise pick the same `[pending]` phase and duplicate or collide on it.
 *
 * This makes the driver "engineer-conscious". Before launching a phase it claims
 * a lock by creating the ref `refs/claudopilot/locks/<phase-id>` on the remote.
 * A plain (non-force) push of a freshly-minted root commit to that ref is an
 * atomic create-if-absent: git only allows creating a ref or fast-forwarding it,
 * and an unrelated root commit is never a fast-forward — so if another engineer
 * already holds the lock the push is rejected and exactly one engineer wins.
 *
 * The lock commit's message carries JSON metadata (owner, host, timestamps).
 * Held locks are heartbeated (throttled) so a live engineer's lock stays fresh;
 * a lock whose heartbeat is older than `staleSeconds` is treated as abandoned
 * (a crashed engineer) and may be stolen with a leased force-push. Locks are
 * released on merge, park, and shutdown.
 *
 * Fail-open: if the remote is unreachable, claiming a brand-new lock fails-open
 * (work proceeds, uncoordinated, with a warning) rather than blocking an engineer
 * who is briefly offline. Only an explicit *rejection* (the lock exists and is
 * held by a live engineer) blocks a launch.
 */

import type { GitResult } from "./git.js";

/** The well-known empty-tree object id (same in every git repo). */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export const LOCK_PREFIX = "refs/claudopilot/locks/";
const TRACK_PREFIX = "refs/claudopilot/remote-locks/";

export interface LockMeta {
  phase: string;
  owner: string;
  host: string;
  /** Epoch seconds when first claimed. */
  claimedAt: number;
  /** Epoch seconds of the most recent heartbeat. */
  heartbeat: number;
}

/** The slice of the Git wrapper the coordinator needs (keeps it test-seamable). */
export interface CoordGit {
  lsRemote(remote: string, pattern: string): Promise<Array<{ sha: string; ref: string }>>;
  commitTree(treeSha: string, message: string): Promise<string | null>;
  pushRef(remote: string, sha: string, ref: string, opts?: { lease?: string }): Promise<GitResult>;
  pushDeleteRef(remote: string, ref: string, opts?: { lease?: string }): Promise<GitResult>;
  fetchRef(remote: string, refspec: string, opts?: { quiet?: boolean }): Promise<GitResult>;
  revParse(ref: string): Promise<string | null>;
  commitMessage(ref: string): Promise<string | null>;
}

export interface Coordinator {
  /** Take phase `id`. Returns true iff we now hold it (or already did). */
  claim(id: string): Promise<boolean>;
  /** Refresh the heartbeat of every held lock (throttled internally). */
  heartbeat(): Promise<void>;
  /** Release phase `id` if we hold it (best-effort, leased). */
  release(id: string): Promise<void>;
  /** Release every lock we hold — call on shutdown. */
  releaseAll(): Promise<void>;
  /** Phases this engine currently holds. */
  held(): ReadonlySet<string>;
}

export interface CoordinatorOptions {
  git: CoordGit;
  owner: string;
  host: string;
  /** Lock older than this (no heartbeat) is stealable. Epoch seconds. */
  staleSeconds: number;
  /** Minimum seconds between heartbeat pushes for a held lock. */
  heartbeatSeconds: number;
  /** Epoch-seconds clock (injectable for tests). */
  now: () => number;
  remote?: string;
  log?: (m: string) => void;
}

/** Coordinator that does nothing — used when coordination is disabled. */
export function noopCoordinator(): Coordinator {
  const empty = new Set<string>();
  return {
    claim: async () => true,
    heartbeat: async () => {},
    release: async () => {},
    releaseAll: async () => {},
    held: () => empty,
  };
}

const REJECTED_RE = /\b(rejected|non-fast-forward|fetch first|already exists|stale info)\b/i;

interface HeldEntry {
  sha: string;
  claimedAt: number;
  lastHeartbeat: number;
}

export function makeCoordinator(opts: CoordinatorOptions): Coordinator {
  const { git, owner, host, staleSeconds, heartbeatSeconds, now } = opts;
  const remote = opts.remote ?? "origin";
  const log = opts.log;
  const held = new Map<string, HeldEntry>();

  const refFor = (id: string): string => LOCK_PREFIX + id;

  const mint = async (id: string, claimedAt: number, beat: number): Promise<string | null> => {
    const meta: LockMeta = { phase: id, owner, host, claimedAt, heartbeat: beat };
    return git.commitTree(EMPTY_TREE, JSON.stringify(meta));
  };

  /** Fetch the remote lock object and read {sha, meta}; null if absent/unreadable. */
  const readRemote = async (id: string): Promise<{ sha: string; meta: LockMeta } | null> => {
    const ref = refFor(id);
    const track = TRACK_PREFIX + id;
    const f = await git.fetchRef(remote, `+${ref}:${track}`, { quiet: true });
    if (f.code !== 0) return null;
    const sha = await git.revParse(track);
    if (!sha) return null;
    const msg = await git.commitMessage(track);
    const meta = parseMeta(msg);
    if (!meta) return null;
    return { sha, meta };
  };

  const claim = async (id: string): Promise<boolean> => {
    if (held.has(id)) return true;
    const t = now();
    const sha = await mint(id, t, t);
    if (!sha) {
      log?.(`  [${id}] coordinate: could not mint lock commit — proceeding uncoordinated.`);
      return true; // fail-open
    }
    const ref = refFor(id);
    const push = await git.pushRef(remote, sha, ref);
    if (push.code === 0) {
      held.set(id, { sha, claimedAt: t, lastHeartbeat: t });
      log?.(`  [${id}] coordinate: claimed lock (${owner}@${host}).`);
      return true;
    }

    const stderr = `${push.stdout}\n${push.stderr}`;
    if (!REJECTED_RE.test(stderr)) {
      // Remote error rather than a real contention — don't block the engineer.
      log?.(`  [${id}] coordinate: remote unavailable — proceeding uncoordinated.`);
      return true; // fail-open
    }

    // Contended: someone holds it. Steal only if their heartbeat is stale.
    const existing = await readRemote(id);
    if (existing && t - existing.meta.heartbeat > staleSeconds) {
      const steal = await git.pushRef(remote, sha, ref, { lease: `${ref}:${existing.sha}` });
      if (steal.code === 0) {
        held.set(id, { sha, claimedAt: t, lastHeartbeat: t });
        log?.(
          `  [${id}] coordinate: stole stale lock from ${existing.meta.owner}@${existing.meta.host} ` +
            `(idle ${t - existing.meta.heartbeat}s).`,
        );
        return true;
      }
    }
    const who = existing ? ` (held by ${existing.meta.owner}@${existing.meta.host})` : "";
    log?.(`  [${id}] coordinate: held by another engineer — skipping${who}.`);
    return false;
  };

  const heartbeat = async (): Promise<void> => {
    const t = now();
    for (const [id, entry] of held) {
      if (t - entry.lastHeartbeat < heartbeatSeconds) continue;
      const ref = refFor(id);
      const sha = await mint(id, entry.claimedAt, t);
      if (!sha) continue;
      const r = await git.pushRef(remote, sha, ref, { lease: `${ref}:${entry.sha}` });
      if (r.code === 0) {
        held.set(id, { sha, claimedAt: entry.claimedAt, lastHeartbeat: t });
      } else {
        log?.(`  [${id}] coordinate: heartbeat failed (lock may have been stolen).`);
      }
    }
  };

  const release = async (id: string): Promise<void> => {
    const entry = held.get(id);
    if (!entry) return;
    held.delete(id);
    const ref = refFor(id);
    await git.pushDeleteRef(remote, ref, { lease: `${ref}:${entry.sha}` });
    log?.(`  [${id}] coordinate: released lock.`);
  };

  const releaseAll = async (): Promise<void> => {
    for (const id of [...held.keys()]) await release(id);
  };

  return {
    claim,
    heartbeat,
    release,
    releaseAll,
    held: () => new Set(held.keys()),
  };
}

/** Parse a lock commit message body into LockMeta; null if it isn't one. */
export function parseMeta(message: string | null): LockMeta | null {
  if (!message) return null;
  try {
    const o = JSON.parse(message.trim()) as Partial<LockMeta>;
    if (
      typeof o.phase === "string" &&
      typeof o.owner === "string" &&
      typeof o.host === "string" &&
      typeof o.claimedAt === "number" &&
      typeof o.heartbeat === "number"
    ) {
      return o as LockMeta;
    }
  } catch {
    /* not a lock commit */
  }
  return null;
}
