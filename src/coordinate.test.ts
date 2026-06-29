import { describe, it, expect } from "vitest";
import {
  makeCoordinator,
  noopCoordinator,
  parseMeta,
  LOCK_PREFIX,
  type CoordGit,
  type LockMeta,
} from "./coordinate.js";

type R = { code: number; signal: null; stdout: string; stderr: string; timedOut: false };
const ok = (stdout = ""): R => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
const rejected = (): R => ({
  code: 1,
  signal: null,
  stdout: "",
  stderr: "! [remote rejected] (fetch first)",
  timedOut: false,
});
const remoteErr = (): R => ({
  code: 128,
  signal: null,
  stdout: "",
  stderr: "fatal: unable to access — Could not read from remote repository",
  timedOut: false,
});

/** A fake remote ref store implementing the slice of git the coordinator uses. */
function makeFakeRemote(seed: { down?: boolean } = {}) {
  const remoteRefs = new Map<string, string>(); // ref -> sha
  const objects = new Map<string, string>(); // sha -> commit message
  const tracking = new Map<string, string>(); // local tracking ref -> sha
  let counter = 0;
  let down = seed.down ?? false;

  const git: CoordGit = {
    lsRemote: async (_remote, pattern) => {
      if (down) return [];
      const prefix = pattern.replace(/\*$/, "");
      return [...remoteRefs.entries()]
        .filter(([ref]) => ref.startsWith(prefix))
        .map(([ref, sha]) => ({ sha, ref }));
    },
    commitTree: async (_tree, message) => {
      const sha = `sha${++counter}`;
      objects.set(sha, message);
      return sha;
    },
    pushRef: async (_remote, sha, ref, opts) => {
      if (down) return remoteErr();
      const cur = remoteRefs.get(ref);
      if (opts?.lease !== undefined) {
        const expected = opts.lease.split(":")[1] ?? "";
        if ((cur ?? "") !== expected) return rejected();
        remoteRefs.set(ref, sha);
        return ok();
      }
      if (cur !== undefined) return rejected(); // create-if-absent
      remoteRefs.set(ref, sha);
      return ok();
    },
    pushDeleteRef: async (_remote, ref, opts) => {
      if (down) return remoteErr();
      const cur = remoteRefs.get(ref);
      if (opts?.lease !== undefined) {
        const expected = opts.lease.split(":")[1] ?? "";
        if ((cur ?? "") !== expected) return rejected();
      }
      remoteRefs.delete(ref);
      return ok();
    },
    fetchRef: async (_remote, refspec) => {
      if (down) return remoteErr();
      const [src, dst] = refspec.replace(/^\+/, "").split(":");
      const sha = src ? remoteRefs.get(src) : undefined;
      if (sha === undefined || !dst) return rejected();
      tracking.set(dst, sha);
      return ok();
    },
    revParse: async (ref) => tracking.get(ref) ?? remoteRefs.get(ref) ?? null,
    commitMessage: async (ref) => {
      const sha = tracking.get(ref) ?? remoteRefs.get(ref);
      return sha ? objects.get(sha) ?? null : null;
    },
  };

  const seedLock = (id: string, meta: LockMeta): void => {
    const sha = `seed-${id}`;
    objects.set(sha, JSON.stringify(meta));
    remoteRefs.set(`${LOCK_PREFIX}${id}`, sha);
  };
  const setDown = (v: boolean): void => {
    down = v;
  };

  return { git, remoteRefs, objects, seedLock, setDown };
}

const meta = (over: Partial<LockMeta> = {}): LockMeta => ({
  phase: "p",
  owner: "bob",
  host: "h2",
  claimedAt: 500,
  heartbeat: 500,
  ...over,
});

describe("makeCoordinator — claim", () => {
  it("creates the lock ref and tracks it as held", async () => {
    const { git, remoteRefs } = makeFakeRemote();
    const c = makeCoordinator({ git, owner: "alice", host: "h1", staleSeconds: 100, heartbeatSeconds: 10, now: () => 1000 });
    expect(await c.claim("phase-01")).toBe(true);
    expect(remoteRefs.has(`${LOCK_PREFIX}phase-01`)).toBe(true);
    expect(c.held().has("phase-01")).toBe(true);
  });

  it("is idempotent for a lock we already hold (no second push)", async () => {
    const { git, remoteRefs } = makeFakeRemote();
    const c = makeCoordinator({ git, owner: "alice", host: "h1", staleSeconds: 100, heartbeatSeconds: 10, now: () => 1000 });
    await c.claim("phase-01");
    const sha = remoteRefs.get(`${LOCK_PREFIX}phase-01`);
    expect(await c.claim("phase-01")).toBe(true);
    expect(remoteRefs.get(`${LOCK_PREFIX}phase-01`)).toBe(sha); // unchanged
  });

  it("skips a phase held by a live engineer", async () => {
    const { git, seedLock } = makeFakeRemote();
    seedLock("phase-02", meta({ heartbeat: 1000 })); // fresh
    const c = makeCoordinator({ git, owner: "alice", host: "h1", staleSeconds: 100, heartbeatSeconds: 10, now: () => 1000 });
    expect(await c.claim("phase-02")).toBe(false);
    expect(c.held().has("phase-02")).toBe(false);
  });

  it("steals a stale lock from a crashed engineer", async () => {
    const { git, seedLock, remoteRefs } = makeFakeRemote();
    seedLock("phase-03", meta({ heartbeat: 800 })); // idle 200s > stale 100s
    const c = makeCoordinator({ git, owner: "alice", host: "h1", staleSeconds: 100, heartbeatSeconds: 10, now: () => 1000 });
    expect(await c.claim("phase-03")).toBe(true);
    expect(c.held().has("phase-03")).toBe(true);
    // ref now points at our freshly-minted commit, not the seed.
    expect(remoteRefs.get(`${LOCK_PREFIX}phase-03`)).not.toBe("seed-phase-03");
  });

  it("does NOT steal a lock that is contested but still fresh", async () => {
    const { git, seedLock } = makeFakeRemote();
    seedLock("phase-04", meta({ heartbeat: 950 })); // idle 50s < stale 100s
    const c = makeCoordinator({ git, owner: "alice", host: "h1", staleSeconds: 100, heartbeatSeconds: 10, now: () => 1000 });
    expect(await c.claim("phase-04")).toBe(false);
  });

  it("fails open (grants, untracked) when the remote is unreachable", async () => {
    const { git } = makeFakeRemote({ down: true });
    const c = makeCoordinator({ git, owner: "alice", host: "h1", staleSeconds: 100, heartbeatSeconds: 10, now: () => 1000 });
    expect(await c.claim("phase-05")).toBe(true);
    expect(c.held().has("phase-05")).toBe(false); // not tracked — nothing to release
  });
});

describe("makeCoordinator — heartbeat / release", () => {
  it("refreshes a held lock only after heartbeatSeconds elapse", async () => {
    const { git, remoteRefs } = makeFakeRemote();
    let t = 1000;
    const c = makeCoordinator({ git, owner: "alice", host: "h1", staleSeconds: 100, heartbeatSeconds: 10, now: () => t });
    await c.claim("phase-01");
    const sha0 = remoteRefs.get(`${LOCK_PREFIX}phase-01`);

    t = 1005; // < heartbeatSeconds since claim → no refresh
    await c.heartbeat();
    expect(remoteRefs.get(`${LOCK_PREFIX}phase-01`)).toBe(sha0);

    t = 1015; // ≥ heartbeatSeconds → refresh to a new commit
    await c.heartbeat();
    expect(remoteRefs.get(`${LOCK_PREFIX}phase-01`)).not.toBe(sha0);
  });

  it("release deletes the ref and forgets the lock", async () => {
    const { git, remoteRefs } = makeFakeRemote();
    const c = makeCoordinator({ git, owner: "alice", host: "h1", staleSeconds: 100, heartbeatSeconds: 10, now: () => 1000 });
    await c.claim("phase-01");
    await c.release("phase-01");
    expect(remoteRefs.has(`${LOCK_PREFIX}phase-01`)).toBe(false);
    expect(c.held().has("phase-01")).toBe(false);
  });

  it("release is a no-op for a lock we do not hold", async () => {
    const { git, seedLock, remoteRefs } = makeFakeRemote();
    seedLock("phase-09", meta({ heartbeat: 1000 }));
    const c = makeCoordinator({ git, owner: "alice", host: "h1", staleSeconds: 100, heartbeatSeconds: 10, now: () => 1000 });
    await c.release("phase-09");
    expect(remoteRefs.has(`${LOCK_PREFIX}phase-09`)).toBe(true); // untouched
  });

  it("releaseAll drops every held lock", async () => {
    const { git, remoteRefs } = makeFakeRemote();
    const c = makeCoordinator({ git, owner: "alice", host: "h1", staleSeconds: 100, heartbeatSeconds: 10, now: () => 1000 });
    await c.claim("phase-01");
    await c.claim("phase-02");
    await c.releaseAll();
    expect(remoteRefs.size).toBe(0);
    expect(c.held().size).toBe(0);
  });
});

describe("noopCoordinator", () => {
  it("grants every claim and holds nothing", async () => {
    const c = noopCoordinator();
    expect(await c.claim("anything")).toBe(true);
    expect(c.held().size).toBe(0);
    await c.heartbeat();
    await c.release("anything");
    await c.releaseAll();
  });
});

describe("parseMeta", () => {
  it("parses a well-formed lock message", () => {
    const m = parseMeta(JSON.stringify(meta({ phase: "phase-01", owner: "x" })));
    expect(m?.phase).toBe("phase-01");
    expect(m?.owner).toBe("x");
  });

  it("returns null for non-lock / malformed messages", () => {
    expect(parseMeta(null)).toBeNull();
    expect(parseMeta("just a normal commit")).toBeNull();
    expect(parseMeta(JSON.stringify({ phase: "p" }))).toBeNull(); // missing fields
  });
});
