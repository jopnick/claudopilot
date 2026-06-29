import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git, Git } from "./git.js";

async function mkRepo(): Promise<{ repo: string; g: Git }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "git-test-"));
  const g = git(repo);
  // init + a baseline commit so HEAD is valid.
  let r = await g.run(["init", "-q", "-b", "main"]);
  expect(r.code).toBe(0);
  await g.configSet("user.email", "test@example.com");
  await g.configSet("user.name", "Test");
  // commit.gpgsign defaults to false in temp repos, but be defensive.
  await g.configSet("commit.gpgsign", "false");
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  r = await g.add("README.md");
  expect(r.code).toBe(0);
  r = await g.commit({ message: "init" });
  expect(r.code).toBe(0);
  return { repo, g };
}

describe("Git wrapper — read-only ops", () => {
  let repo: string;
  let g: Git;
  beforeEach(async () => {
    ({ repo, g } = await mkRepo());
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("currentBranch returns the checked-out branch", async () => {
    expect(await g.currentBranch()).toBe("main");
  });

  it("branchExists is true for an existing branch, false otherwise", async () => {
    expect(await g.branchExists("main")).toBe(true);
    expect(await g.branchExists("does-not-exist")).toBe(false);
  });

  it("revParse resolves a branch to a SHA", async () => {
    const sha = await g.revParse("HEAD");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("revParse returns null for a missing ref", async () => {
    expect(await g.revParse("no-such-ref")).toBeNull();
  });

  it("lsTree lists tracked files", async () => {
    const files = await g.lsTree("HEAD");
    expect(files).toContain("README.md");
  });

  it("logTouching returns commits that touched a path", async () => {
    const commits = await g.logTouching("HEAD", "README.md");
    expect(commits.length).toBe(1);
    expect(commits[0]).toMatch(/init$/);
  });

  it("logTouching returns [] when nothing touched the path", async () => {
    const commits = await g.logTouching("HEAD", "nonexistent.md");
    expect(commits).toEqual([]);
  });
});

describe("Git wrapper — branch + commit ops", () => {
  let repo: string;
  let g: Git;
  beforeEach(async () => {
    ({ repo, g } = await mkRepo());
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("createBranch + checkout + deleteBranch round-trip", async () => {
    expect((await g.createBranch("feature", "main")).code).toBe(0);
    expect(await g.branchExists("feature")).toBe(true);
    expect((await g.checkout("feature")).code).toBe(0);
    expect(await g.currentBranch()).toBe("feature");
    expect((await g.checkout("main")).code).toBe(0);
    expect((await g.deleteBranch("feature")).code).toBe(0);
    expect(await g.branchExists("feature")).toBe(false);
  });

  it("hasStagedChanges flips with the index state", async () => {
    expect(await g.hasStagedChanges()).toBe(false);
    await fs.writeFile(path.join(repo, "new.txt"), "x\n");
    await g.add("new.txt");
    expect(await g.hasStagedChanges()).toBe(true);
    await g.commit({ message: "add new.txt" });
    expect(await g.hasStagedChanges()).toBe(false);
  });

  it("merge --no-ff produces a merge commit", async () => {
    await g.createBranch("topic", "main");
    await g.checkout("topic");
    await fs.writeFile(path.join(repo, "t.txt"), "topic\n");
    await g.add("t.txt");
    await g.commit({ message: "topic work" });
    await g.checkout("main");
    const m = await g.merge("topic", { noFf: true, message: "Merge topic" });
    expect(m.code).toBe(0);
    // A --no-ff merge has two parents; rev-list HEAD^@ lists them.
    const parents = await g.run(["rev-list", "--no-walk", "HEAD^@"]);
    expect(parents.code).toBe(0);
    expect(parents.stdout.trim().split(/\s+/).length).toBe(2);
  });
});

describe("Git wrapper — config + clone + worktree", () => {
  let repo: string;
  let g: Git;
  beforeEach(async () => {
    ({ repo, g } = await mkRepo());
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("configGet / configSet round-trip", async () => {
    expect((await g.configSet("custom.key", "hello")).code).toBe(0);
    expect(await g.configGet("custom.key")).toBe("hello");
  });

  it("configGet returns null for a missing key", async () => {
    expect(await g.configGet("custom.missing")).toBeNull();
  });

  it("clone copies the repo to a fresh directory", async () => {
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), "git-clone-"));
    await fs.rm(dest, { recursive: true, force: true });
    try {
      const r = await g.clone(repo, dest);
      expect(r.code).toBe(0);
      const cloned = git(dest);
      expect(await cloned.currentBranch()).toBe("main");
      const files = await cloned.lsTree("HEAD");
      expect(files).toContain("README.md");
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it("worktreeAdd + worktreeRemove round-trip", async () => {
    const wt = path.join(repo, "..", path.basename(repo) + "-wt");
    await g.createBranch("wtb", "main");
    const add = await g.worktreeAdd(wt, "wtb");
    expect(add.code).toBe(0);
    expect(await git(wt).currentBranch()).toBe("wtb");
    const rm = await g.worktreeRemove(wt);
    expect(rm.code).toBe(0);
    await fs.rm(wt, { recursive: true, force: true });
  });
});

describe("Git wrapper — ref locks / coordination plumbing", () => {
  let repo: string;
  let remote: string;
  let g: Git;
  beforeEach(async () => {
    ({ repo, g } = await mkRepo());
    // A bare repo to act as 'origin' for ref-push tests.
    remote = await fs.mkdtemp(path.join(os.tmpdir(), "git-remote-"));
    await g.run(["init", "-q", "--bare", remote]);
    await g.run(["remote", "add", "origin", remote]);
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(remote, { recursive: true, force: true });
  });

  it("commitTree mints a commit object carrying the message", async () => {
    const sha = await g.commitTree("4b825dc642cb6eb9a060e54bf8d69288fbee4904", "lock-meta-here");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await g.commitMessage(sha!)).toBe("lock-meta-here");
  });

  it("pushRef creates a ref if absent and rejects a second unrelated push", async () => {
    const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const ref = "refs/claudopilot/locks/phase-01";
    const a = await g.commitTree(tree, "alice");
    const first = await g.pushRef("origin", a!, ref);
    expect(first.code).toBe(0);
    // ls-remote now sees the lock.
    const refs = await g.lsRemote("origin", "refs/claudopilot/locks/*");
    expect(refs.map((r) => r.ref)).toContain(ref);
    // A different (unrelated) commit cannot create the same ref — atomic claim.
    const b = await g.commitTree(tree, "bob");
    const second = await g.pushRef("origin", b!, ref);
    expect(second.code).not.toBe(0);
  });

  it("pushRef with a matching lease can update; a stale lease is rejected", async () => {
    const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const ref = "refs/claudopilot/locks/phase-02";
    const a = await g.commitTree(tree, "v1");
    await g.pushRef("origin", a!, ref);
    const b = await g.commitTree(tree, "v2");
    // Correct lease (expects current value a) → succeeds.
    expect((await g.pushRef("origin", b!, ref, { lease: `${ref}:${a}` })).code).toBe(0);
    // Stale lease (still expects a, but it's now b) → rejected.
    const cc = await g.commitTree(tree, "v3");
    expect((await g.pushRef("origin", cc!, ref, { lease: `${ref}:${a}` })).code).not.toBe(0);
  });

  it("pushDeleteRef removes a remote ref", async () => {
    const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const ref = "refs/claudopilot/locks/phase-03";
    const a = await g.commitTree(tree, "x");
    await g.pushRef("origin", a!, ref);
    expect((await g.pushDeleteRef("origin", ref)).code).toBe(0);
    expect(await g.lsRemote("origin", "refs/claudopilot/locks/*")).toEqual([]);
  });

  it("lsRemote returns [] for a pattern that matches nothing", async () => {
    expect(await g.lsRemote("origin", "refs/claudopilot/locks/*")).toEqual([]);
  });
});

describe("Git wrapper — never throws on non-zero", () => {
  it("returns a result (not throw) for unknown subcommands", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "git-test-"));
    try {
      const g = git(repo);
      // `git status` in a non-repo dir exits non-zero; we just want "no throw".
      const r = await g.run(["status"]);
      expect(typeof r.code).toBe("number");
      expect(r.code).not.toBe(0);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
