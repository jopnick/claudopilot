import { describe, it, expect } from "vitest";
import { renderSnapshot, fmtDur, fmtTokens, runOnce } from "./render.js";
import type { ProgressSnapshot } from "../types.js";
import { Writable } from "node:stream";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function snap(over: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    manifest: "roadmap/EXECUTION-MANIFEST.md",
    manifestStatus: "in-progress",
    container: "Up 5m",
    lastDriverEvent: null,
    summary: {
      total: 2,
      merged: 1,
      running: 1,
      pending: 0,
      blocked: 0,
      failed: 0,
      slicesDone: 2,
      slicesTotal: 3,
      pctPhases: 50,
      pctSlices: 67,
    },
    phases: [
      {
        id: "phase-A",
        state: "merged",
        title: "first",
        deps: [],
        branch: "auto/phase-A",
        hasBranch: true,
        hasWorktree: false,
        docSource: "main",
        doneDoc: true,
        checklistSeeded: true,
        slices: [{ id: "A.1", title: "go", checked: true, sha: "abc1234" }],
        slicesDone: 1,
        slicesTotal: 1,
        lastCommit: "abc1234 add it",
        step: null,
        activity: null,
      },
      {
        id: "phase-B",
        state: "running",
        title: "second",
        deps: ["phase-A"],
        branch: "auto/phase-B",
        hasBranch: true,
        hasWorktree: true,
        docSource: "worktree",
        doneDoc: false,
        checklistSeeded: true,
        slices: [
          { id: "B.1", title: "start", checked: true, sha: "def5678" },
          { id: "B.2", title: "finish", checked: false, sha: null },
        ],
        slicesDone: 1,
        slicesTotal: 2,
        lastCommit: "def5678 partial",
        step: {
          label: "Running Bash",
          detail: "pnpm -s test",
          since: 0,
          // tokens is an extra runtime field — see model.ts deriveStep.
          ...({ tokens: 12345 } as object),
        },
        activity: "Running Bash: pnpm -s test",
      },
    ],
    ...over,
  };
}

describe("fmtDur", () => {
  it("formats seconds, minutes, hours", () => {
    expect(fmtDur(0)).toBe("0s");
    expect(fmtDur(9000)).toBe("9s");
    expect(fmtDur(252_000)).toBe("4m12s");
    expect(fmtDur(3_780_000)).toBe("1h03m");
  });
  it("clamps negatives to 0s", () => {
    expect(fmtDur(-50)).toBe("0s");
  });
});

describe("fmtTokens", () => {
  it("formats raw, k, M", () => {
    expect(fmtTokens(null)).toBe("");
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(920)).toBe("920");
    expect(fmtTokens(12_345)).toBe("12k");
    expect(fmtTokens(1_234_000)).toBe("1.2M");
  });
});

describe("renderSnapshot", () => {
  it("emits per-phase rows with slices and a live step for running phases", () => {
    // noColor + fixed now → deterministic compare
    const out = renderSnapshot(snap(), { noColor: true, now: () => 9000 });
    expect(out).toContain("roadmap/EXECUTION-MANIFEST.md");
    expect(out).toContain("phases 1/2 merged");
    expect(out).toContain("container: Up 5m");
    expect(out).toMatch(/1\. \[merged\] phase-A/);
    expect(out).toMatch(/2\. \[running\] phase-B/);
    // running phase shows the derived step + elapsed + tokens
    expect(out).toContain("now Running Bash: pnpm -s test (9s · 12k tok)");
    // slice lines for the running phase
    expect(out).toContain("[x] B.1  start");
    expect(out).toContain("[ ] B.2  finish");
    // merged phase doesn't print slice detail
    expect(out).not.toContain("[x] A.1");
  });

  it("returns the error string when the snapshot carries an error", () => {
    expect(renderSnapshot(snap({ error: "boom" }))).toBe("boom");
  });
});

describe("runOnce(--json)", () => {
  it("writes the snapshot as JSON when json:true", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-render-"));
    try {
      const roadmap = path.join(root, "roadmap");
      await fs.mkdir(roadmap, { recursive: true });
      const manifest = path.join(roadmap, "EXECUTION-MANIFEST.md");
      await fs.writeFile(
        manifest,
        "**Status:** in-progress\n\n## Order\n\n1. [pending] **phase-X** — only (deps: none)\n",
      );
      const chunks: string[] = [];
      const sink = new Writable({
        write(c, _e, cb) {
          chunks.push(String(c));
          cb();
        },
      });
      const snapshot = runOnce({
        repoRoot: root,
        manifestPath: manifest,
        roadmapDir: roadmap,
        json: true,
        out: sink,
      });
      sink.end();
      const text = chunks.join("");
      const parsed = JSON.parse(text);
      expect(parsed.manifestStatus).toBe("in-progress");
      expect(parsed.phases).toHaveLength(1);
      expect(snapshot.phases[0]?.id).toBe("phase-X");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
