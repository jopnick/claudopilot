import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openPullRequest } from "./pr.js";

/**
 * These tests shim a fake `gh` onto PATH so `openPullRequest` exercises the real
 * spawn/parse path without needing GitHub. The fake echoes its behavior based on
 * env knobs the test sets.
 */
let binDir: string;
let savedPath: string | undefined;

async function writeFakeGh(body: string): Promise<void> {
  const p = path.join(binDir, "gh");
  await fs.writeFile(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

beforeEach(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-gh-"));
  savedPath = process.env["PATH"];
  process.env["PATH"] = `${binDir}:${savedPath ?? ""}`;
});

afterEach(async () => {
  process.env["PATH"] = savedPath;
  await fs.rm(binDir, { recursive: true, force: true });
});

describe("openPullRequest", () => {
  it("returns ok + url on success and forwards base/head/title/draft", async () => {
    // Record args, print a PR URL.
    await writeFakeGh(
      `echo "$@" > "${binDir}/args.txt"\n` +
        `echo "https://github.com/acme/repo/pull/42"\n` +
        `exit 0`,
    );
    const r = await openPullRequest({
      cwd: binDir,
      head: "autonomous-runner",
      base: "main",
      title: "Batch",
      draft: true,
    });
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://github.com/acme/repo/pull/42");
    const args = await fs.readFile(path.join(binDir, "args.txt"), "utf8");
    expect(args).toContain("pr create");
    expect(args).toContain("--base main");
    expect(args).toContain("--head autonomous-runner");
    expect(args).toContain("--fill");
    expect(args).toContain("--title Batch");
    expect(args).toContain("--draft");
  });

  it("treats an already-existing PR as success", async () => {
    await writeFakeGh(
      `echo "a pull request for branch already exists: https://github.com/acme/repo/pull/7" 1>&2\n` +
        `exit 1`,
    );
    const r = await openPullRequest({ cwd: binDir, head: "runner", base: "main" });
    expect(r.ok).toBe(true);
    expect(r.alreadyExists).toBe(true);
    expect(r.url).toBe("https://github.com/acme/repo/pull/7");
  });

  it("returns a failure reason on a real gh error", async () => {
    await writeFakeGh(`echo "could not determine base repo" 1>&2\nexit 1`);
    const r = await openPullRequest({ cwd: binDir, head: "runner", base: "main" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("could not determine base repo");
  });

  it("never throws when gh is missing", async () => {
    process.env["PATH"] = "/nonexistent";
    const r = await openPullRequest({ cwd: binDir, head: "runner", base: "main" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/gh not available/);
  });
});
