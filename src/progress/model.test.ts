import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { buildSnapshot, parseSlices } from "./model.js";

// Build a self-contained git repo with manifest + roadmap + a run artifact so
// the snapshot exercises every enrichment path (branch, doc, checklist, step).
async function buildFixture(): Promise<{ root: string; manifest: string; roadmap: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-progress-"));

  // Real git repo so `git rev-parse auto/<id>` succeeds for one phase.
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@x"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "seed"), "x");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", root, "branch", "auto/phase-A"]);

  const roadmap = path.join(root, "roadmap");
  await fs.mkdir(roadmap, { recursive: true });

  const manifest = path.join(roadmap, "EXECUTION-MANIFEST.md");
  await fs.writeFile(
    manifest,
    [
      "# Plan",
      "",
      "**Status:** in-progress",
      "",
      "## Order",
      "",
      "1. [merged] **phase-A** — first slice (deps: none)",
      "2. [running] **phase-B** — second slice (deps: phase-A)",
      "3. [pending] **phase-C** — third slice (deps: phase-A)",
      "",
    ].join("\n"),
  );

  // phase-A: has Status checklist, 2/2 done.
  await fs.writeFile(
    path.join(roadmap, "DONE_phase-A-first.md"),
    [
      "# phase-A",
      "",
      "## Status",
      "",
      "- [x] A.1 — bootstrap (abc1234)",
      "- [x] A.2 — finish (def5678)",
      "",
    ].join("\n"),
  );

  // phase-B: Status seeded, 1/2 done.
  await fs.writeFile(
    path.join(roadmap, "phase-B-second.md"),
    [
      "# phase-B",
      "",
      "## Status",
      "",
      "- [x] B.1 — start (cafebabe)",
      "- [ ] B.2 — finish",
      "",
    ].join("\n"),
  );

  // phase-C: only Sequencing → unseeded, 0/1.
  await fs.writeFile(
    path.join(roadmap, "phase-C-third.md"),
    [
      "# phase-C",
      "",
      "## Sequencing",
      "",
      "- C.1 — plan it",
      "",
    ].join("\n"),
  );

  // A stream artifact for phase-B so deriveStep produces a real step.
  const cpDir = path.join(root, ".claudopilot");
  await fs.mkdir(cpDir, { recursive: true });
  const streamLines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }],
        usage: { output_tokens: 42 },
      },
    }),
  ].join("\n");
  await fs.writeFile(
    path.join(cpDir, "phase-B.stream.jsonl"),
    streamLines + "\n",
  );

  return { root, manifest, roadmap };
}

describe("buildSnapshot", () => {
  let fx: { root: string; manifest: string; roadmap: string };
  beforeAll(async () => {
    fx = await buildFixture();
  });
  afterAll(async () => {
    if (fx) await fs.rm(fx.root, { recursive: true, force: true });
  });

  it("derives summary + per-phase counts from manifest + checklists", () => {
    const snap = buildSnapshot({
      repoRoot: fx.root,
      manifestPath: fx.manifest,
      roadmapDir: fx.roadmap,
    });
    expect(snap.error).toBeUndefined();
    expect(snap.manifestStatus).toBe("in-progress");
    expect(snap.phases).toHaveLength(3);
    expect(snap.summary).toMatchObject({
      total: 3,
      merged: 1,
      running: 1,
      pending: 1,
      slicesDone: 3, // 2 (A) + 1 (B)
      slicesTotal: 5, // 2 + 2 + 1
      pctPhases: 33,
    });

    const A = snap.phases.find((p) => p.id === "phase-A");
    expect(A?.state).toBe("merged");
    expect(A?.hasBranch).toBe(true);
    expect(A?.doneDoc).toBe(true);
    expect(A?.checklistSeeded).toBe(true);
    expect(A?.slicesDone).toBe(2);
    expect(A?.slices[0]?.sha).toBe("abc1234");

    const B = snap.phases.find((p) => p.id === "phase-B");
    expect(B?.state).toBe("running");
    expect(B?.hasBranch).toBe(false);
    expect(B?.doneDoc).toBe(false);
    expect(B?.checklistSeeded).toBe(true);
    expect(B?.slicesDone).toBe(1);
    expect(B?.slicesTotal).toBe(2);
    // deriveStep should produce a "Running Bash" step from the fixture stream.
    expect(B?.step?.label).toContain("Running Bash");
    expect(B?.activity).toContain("ls -la");

    const C = snap.phases.find((p) => p.id === "phase-C");
    expect(C?.checklistSeeded).toBe(false);
    expect(C?.slices).toHaveLength(1);
    expect(C?.slicesDone).toBe(0);
    expect(C?.slices[0]?.id).toBe("C.1");
  });

  it("returns an error snapshot when the manifest is missing", () => {
    const snap = buildSnapshot({
      repoRoot: fx.root,
      manifestPath: path.join(fx.root, "does-not-exist.md"),
      roadmapDir: fx.roadmap,
    });
    expect(snap.error).toMatch(/Manifest not found/);
    expect(snap.phases).toHaveLength(0);
  });
});

describe("parseSlices", () => {
  it("prefers Status over Sequencing, captures SHA suffix", () => {
    const { seeded, slices } = parseSlices(
      [
        "## Status",
        "",
        "- [x] 04.2a — add credential entity (3dadcab3)",
        "- [ ] 04.2b — wire it up",
        "",
        "## Sequencing",
        "- 04.2a — should be ignored",
      ].join("\n"),
    );
    expect(seeded).toBe(true);
    expect(slices).toEqual([
      { id: "04.2a", title: "add credential entity", checked: true, sha: "3dadcab3" },
      { id: "04.2b", title: "wire it up", checked: false, sha: null },
    ]);
  });

  it("falls back to Sequencing as an unseeded plan when no Status", () => {
    const { seeded, slices } = parseSlices(
      [
        "## Sequencing",
        "",
        "- 99.1 — do thing",
        "- 99.2 — do other — hand-authored",
        "",
      ].join("\n"),
    );
    expect(seeded).toBe(false);
    expect(slices).toEqual([
      { id: "99.1", title: "do thing", checked: false, sha: null },
      { id: "99.2", title: "do other", checked: false, sha: null },
    ]);
  });
});
