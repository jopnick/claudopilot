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

  it("merge --squash stages changes as a single-parent commit", async () => {
    await g.createBranch("topic", "main");
    await g.checkout("topic");
    await fs.writeFile(path.join(repo, "t.txt"), "topic\n");
    await g.add("t.txt");
    await g.commit({ message: "topic work" });
    await g.checkout("main");
    const m = await g.mergeSquash("topic");
    expect(m.code).toBe(0);
    // Squash stages changes but does NOT commit (and records no second parent).
    expect(await g.hasStagedChanges()).toBe(true);
    await g.commit({ message: "squashed topic" });
    const parents = await g.run(["rev-list", "--no-walk", "HEAD^@"]);
    expect(parents.stdout.trim().split(/\s+/).length).toBe(1);
  });

  it("resetHard discards a half-applied squash merge", async () => {
    await g.createBranch("topic", "main");
    await g.checkout("topic");
    await fs.writeFile(path.join(repo, "t.txt"), "topic\n");
    await g.add("t.txt");
    await g.commit({ message: "topic work" });
    await g.checkout("main");
    await g.mergeSquash("topic");
    expect(await g.hasStagedChanges()).toBe(true);
    expect((await g.resetHard()).code).toBe(0);
    expect(await g.hasStagedChanges()).toBe(false);
  });

  it("logSubjects lists commit subjects in a range, newest-first", async () => {
    await g.createBranch("topic", "main");
    await g.checkout("topic");
    await fs.writeFile(path.join(repo, "a.txt"), "a\n");
    await g.add("a.txt");
    await g.commit({ message: "feat: a" });
    await fs.writeFile(path.join(repo, "b.txt"), "b\n");
    await g.add("b.txt");
    await g.commit({ message: "fix: b" });
    expect(await g.logSubjects("main..topic")).toEqual(["fix: b", "feat: a"]);
  });

  it("hasRemote reflects configured remotes", async () => {
    expect(await g.hasRemote("origin")).toBe(false);
    await g.run(["remote", "add", "origin", "https://example.invalid/x.git"]);
    expect(await g.hasRemote("origin")).toBe(true);
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
