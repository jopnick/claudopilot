/**
 * Differential bash-vs-TS parity tests.
 *
 * Each scenario is run twice in identical tmp git repos — once against
 * `run-loop.sh`, once against the TS `runDriver` — with a stub `claude`
 * CLI on PATH. We compare the four things named in the phase doc:
 *
 *   - process exit code
 *   - the final `**Status:**` value
 *   - the manifest state-change commit sequence (per-id ordering)
 *   - the capture / build-log file layout
 *
 * Branches covered:
 *   - clean merge of a single `(deps: none)` phase
 *   - a dependency chain (b depends on a; a must merge first)
 *   - forced supervisor path (worker exits without DONE_; supervisor
 *     recovers it on its first attempt)
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  captureShape,
  initRepo,
  runBashEngine,
  runTsEngine,
  writeFixture,
  writeStubClaude,
  type FixtureSpec,
  type EngineResult,
  type RepoSetup,
} from "./harness.js";

async function commitFixture(setup: RepoSetup): Promise<void> {
  // Stage every fixture file (manifest, phase docs, prompts, render-stream,
  // config) onto the base branch so worker worktrees, cut from it, see them.
  // `git commit -a` skips untracked files; we need `git add -A` first.
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

async function runParity(
  spec: FixtureSpec,
): Promise<{ bash: EngineResult; ts: EngineResult }> {
  const root = await mkdtemp(path.join(tmpdir(), "cp-parity-"));
  const bashRoot = path.join(root, "bash");
  const tsRoot = path.join(root, "ts");
  const binDir = path.join(root, "bin");

  try {
    await writeStubClaude(binDir, {
      forceSupervisor: spec.forceSupervisor === true,
    });

    const bashSetup = await initRepo(bashRoot);
    await writeFixture(bashSetup.repoDir, spec);
    await commitFixture(bashSetup);

    const tsSetup = await initRepo(tsRoot);
    await writeFixture(tsSetup.repoDir, spec);
    await commitFixture(tsSetup);

    const bash = await runBashEngine(bashSetup, binDir);
    const ts = await runTsEngine(tsSetup, binDir);
    return { bash, ts };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * For the dependency-chain test, both engines may interleave the per-id
 * state-change commits when MAX_PARALLEL > 1; with MAX_PARALLEL=1 they
 * fully serialize. Compare per-id projection: same set of transitions,
 * in the same order within each id.
 */
function perIdProjection(log: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of log) {
    const m = /^(.+?)\s+->\s+(.+)$/.exec(line);
    if (!m || !m[1] || !m[2]) continue;
    (out[m[1]] ??= []).push(m[2]);
  }
  return out;
}

describe("parity: bash vs TS engine", () => {
  it("clean merge of a single (deps: none) phase", async () => {
    const { bash, ts } = await runParity({
      phases: [{ id: "phase-a", title: "trivial alpha" }],
    });

    expect(bash.code).toBe(0);
    expect(ts.code).toBe(0);
    expect(bash.status).toBe("complete");
    expect(ts.status).toBe("complete");
    expect(bash.finalStates).toEqual([{ id: "phase-a", state: "merged" }]);
    expect(ts.finalStates).toEqual(bash.finalStates);
    expect(perIdProjection(ts.stateCommitLog)).toEqual(
      perIdProjection(bash.stateCommitLog),
    );
    expect(captureShape(ts.artifacts)).toEqual(captureShape(bash.artifacts));
  }, 60_000);

  it("dependency chain: phase-b waits for phase-a", async () => {
    const { bash, ts } = await runParity({
      phases: [
        { id: "phase-a", title: "first" },
        { id: "phase-b", title: "second", deps: ["phase-a"] },
      ],
    });

    expect(bash.code).toBe(0);
    expect(ts.code).toBe(0);
    expect(bash.status).toBe("complete");
    expect(ts.status).toBe("complete");
    const expectedFinal = [
      { id: "phase-a", state: "merged" },
      { id: "phase-b", state: "merged" },
    ];
    expect(bash.finalStates).toEqual(expectedFinal);
    expect(ts.finalStates).toEqual(expectedFinal);

    // Dependency ordering: phase-a must hit `merged` before phase-b hits
    // `running` (both engines run with MAX_PARALLEL=1 so this is
    // observable in the state-change commit log).
    for (const log of [bash.stateCommitLog, ts.stateCommitLog]) {
      const aMerged = log.indexOf("phase-a -> merged");
      const bRunning = log.indexOf("phase-b -> running");
      expect(aMerged).toBeGreaterThanOrEqual(0);
      expect(bRunning).toBeGreaterThan(aMerged);
    }

    expect(perIdProjection(ts.stateCommitLog)).toEqual(
      perIdProjection(bash.stateCommitLog),
    );
    expect(captureShape(ts.artifacts)).toEqual(captureShape(bash.artifacts));
  }, 90_000);

  it("forced supervisor path: worker skips DONE_, supervisor recovers", async () => {
    const { bash, ts } = await runParity({
      phases: [{ id: "phase-a", title: "needs supervisor" }],
      forceSupervisor: true,
    });

    expect(bash.code).toBe(0);
    expect(ts.code).toBe(0);
    expect(bash.status).toBe("complete");
    expect(ts.status).toBe("complete");
    expect(bash.finalStates).toEqual([{ id: "phase-a", state: "merged" }]);
    expect(ts.finalStates).toEqual(bash.finalStates);
    expect(perIdProjection(ts.stateCommitLog)).toEqual(
      perIdProjection(bash.stateCommitLog),
    );
    expect(captureShape(ts.artifacts)).toEqual(captureShape(bash.artifacts));
  }, 90_000);
});
