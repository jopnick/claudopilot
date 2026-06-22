/**
 * TS engine end-to-end tests.
 *
 * Each scenario runs a fixture roadmap through the real `runDriver()` in a
 * tmp git repo — host-process mode, no Docker — with a stub `claude` CLI on
 * PATH. We assert the engine's observable contract:
 *
 *   - process / driver exit code
 *   - the final `**Status:**` value
 *   - the per-phase final states on the manifest Order list
 *   - dependency ordering in the state-change commit log
 *
 * The bash engine is gone, so this is no longer a differential harness — it
 * exercises the TS orchestrator directly, proving phases reach DONE and merge
 * with zero bash on the engine side (only the stub `claude` test double is a
 * shell script, hence the win32 skip).
 *
 * Scenarios:
 *   - clean merge of a single `(deps: none)` phase
 *   - a dependency chain (b depends on a; a must merge first)
 *   - forced supervisor path (worker exits without DONE_; supervisor recovers)
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  initRepo,
  runTsEngine,
  writeFixture,
  writeStubClaude,
  type FixtureSpec,
  type EngineResult,
  type RepoSetup,
} from "./harness.js";

async function commitFixture(setup: RepoSetup): Promise<void> {
  // Stage every fixture file (manifest, phase docs, prompts, config) onto the
  // base branch so worker worktrees, cut from it, see them. `git commit -a`
  // skips untracked files; we need `git add -A` first.
  for (const args of [
    ["add", "-A"],
    ["commit", "-m", "fixture"],
    ["push", "origin", setup.baseBranch],
  ]) {
    await new Promise<void>((resolve, reject) => {
      const c = spawn("git", args, { cwd: setup.repoDir, stdio: "ignore" });
      c.once("error", reject);
      c.once("close", () => resolve());
    });
  }
}

async function runScenario(spec: FixtureSpec): Promise<EngineResult> {
  const root = await mkdtemp(path.join(tmpdir(), "cp-e2e-"));
  const binDir = path.join(root, "bin");
  try {
    await writeStubClaude(binDir, { forceSupervisor: spec.forceSupervisor === true });
    const setup = await initRepo(path.join(root, "ts"));
    await writeFixture(setup.repoDir, spec);
    await commitFixture(setup);
    return await runTsEngine(setup, binDir);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

// The stub `claude` test double is a bash script; Windows CI runners lack
// bash natively. The engine itself is pure TS — Linux + macOS jobs cover it.
describe.skipIf(process.platform === "win32")("e2e: TS engine (host mode, no docker)", () => {
  it("clean merge of a single (deps: none) phase", async () => {
    const ts = await runScenario({ phases: [{ id: "phase-a", title: "trivial alpha" }] });
    expect(ts.code).toBe(0);
    expect(ts.status).toBe("complete");
    expect(ts.finalStates).toEqual([{ id: "phase-a", state: "merged" }]);
  }, 60_000);

  it("dependency chain: phase-b waits for phase-a", async () => {
    const ts = await runScenario({
      phases: [
        { id: "phase-a", title: "first" },
        { id: "phase-b", title: "second", deps: ["phase-a"] },
      ],
    });
    expect(ts.code).toBe(0);
    expect(ts.status).toBe("complete");
    expect(ts.finalStates).toEqual([
      { id: "phase-a", state: "merged" },
      { id: "phase-b", state: "merged" },
    ]);
    // phase-a must reach `merged` before phase-b reaches `running`
    // (MAX_PARALLEL=1 makes this observable in the state-change commit log).
    const aMerged = ts.stateCommitLog.indexOf("phase-a -> merged");
    const bRunning = ts.stateCommitLog.indexOf("phase-b -> running");
    expect(aMerged).toBeGreaterThanOrEqual(0);
    expect(bRunning).toBeGreaterThan(aMerged);
  }, 90_000);

  it("forced supervisor path: worker skips DONE_, supervisor recovers", async () => {
    const ts = await runScenario({
      phases: [{ id: "phase-a", title: "needs supervisor" }],
      forceSupervisor: true,
    });
    expect(ts.code).toBe(0);
    expect(ts.status).toBe("complete");
    expect(ts.finalStates).toEqual([{ id: "phase-a", state: "merged" }]);
  }, 90_000);
});
