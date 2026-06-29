import { describe, it, expect } from "vitest";
import { openPullRequest, type RunFn } from "./pr.js";
import type { SpawnCaptureResult } from "./platform/process.js";

/**
 * `openPullRequest` takes an injectable `run` seam, so these tests stub the
 * `gh` invocation directly — no real binary, no PATH shimming (which is what
 * broke on Windows CI). The stub records args and returns canned results.
 */
const result = (over: Partial<SpawnCaptureResult> = {}): SpawnCaptureResult => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...over,
});

/** A run stub that captures the args it was called with. */
function recordingRun(res: SpawnCaptureResult): { run: RunFn; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunFn = async (_cmd, args) => {
    calls.push([...args]);
    return res;
  };
  return { run, calls };
}

describe("openPullRequest", () => {
  it("returns ok + url on success and forwards base/head/title/draft", async () => {
    const { run, calls } = recordingRun(
      result({ stdout: "https://github.com/acme/repo/pull/42\n" }),
    );
    const r = await openPullRequest(
      { cwd: "/repo", head: "autonomous-runner", base: "main", title: "Batch", draft: true },
      run,
    );
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://github.com/acme/repo/pull/42");
    const args = calls[0]!.join(" ");
    expect(args).toContain("pr create");
    expect(args).toContain("--base main");
    expect(args).toContain("--head autonomous-runner");
    expect(args).toContain("--fill");
    expect(args).toContain("--title Batch");
    expect(args).toContain("--draft");
  });

  it("omits --title and --draft when not requested", async () => {
    const { run, calls } = recordingRun(result({ stdout: "https://x/pull/1" }));
    await openPullRequest({ cwd: "/repo", head: "runner", base: "main" }, run);
    const args = calls[0]!.join(" ");
    expect(args).not.toContain("--title");
    expect(args).not.toContain("--draft");
  });

  it("treats an already-existing PR as success", async () => {
    const { run } = recordingRun(
      result({
        code: 1,
        stderr:
          "a pull request for branch already exists: https://github.com/acme/repo/pull/7",
      }),
    );
    const r = await openPullRequest({ cwd: "/repo", head: "runner", base: "main" }, run);
    expect(r.ok).toBe(true);
    expect(r.alreadyExists).toBe(true);
    expect(r.url).toBe("https://github.com/acme/repo/pull/7");
  });

  it("returns a failure reason on a real gh error", async () => {
    const { run } = recordingRun(result({ code: 1, stderr: "could not determine base repo" }));
    const r = await openPullRequest({ cwd: "/repo", head: "runner", base: "main" }, run);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("could not determine base repo");
  });

  it("never throws when gh cannot be spawned", async () => {
    const run: RunFn = async () => {
      throw new Error("spawn gh ENOENT");
    };
    const r = await openPullRequest({ cwd: "/repo", head: "runner", base: "main" }, run);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/gh not available/);
  });
});
