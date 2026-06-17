import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseManifest,
  setState,
  setStatusComplete,
  allMerged,
  eligiblePhases,
  findPhaseDoc,
} from "./manifest.js";

const SAMPLE = `# Title

**Status:** in-progress

## Order

1. [merged] **phase-01** — scaffold + types (deps: none)
2. [pending] **phase-02** — manifest + config + git (deps: phase-01)
3. [pending] **phase-03** — agent capture + render (deps: phase-01)
4. [pending] **phase-04** — docker + runner (deps: phase-01, phase-02)
5. [running] **phase-05** — progress + web (deps: phase-01, phase-02, phase-03)
6. [failed] **phase-06** — driver (deps: phase-01)
7. [blocked] **phase-07** — cli (deps: phase-04)

some prose
`;

describe("parseManifest", () => {
  it("parses each Order line into a typed entry", () => {
    const m = parseManifest(SAMPLE);
    expect(m.status).toBe("in-progress");
    expect(m.phases).toHaveLength(7);
    expect(m.phases[0]).toEqual({
      id: "phase-01",
      state: "merged",
      title: "scaffold + types",
      deps: [],
    });
    expect(m.phases[1]).toEqual({
      id: "phase-02",
      state: "pending",
      title: "manifest + config + git",
      deps: ["phase-01"],
    });
    expect(m.phases[3]).toEqual({
      id: "phase-04",
      state: "pending",
      title: "docker + runner",
      deps: ["phase-01", "phase-02"],
    });
  });

  it("normalizes `(deps: none)` to no dependencies", () => {
    const m = parseManifest("1. [pending] **phase-x** — t (deps: none)\n");
    expect(m.phases[0]?.deps).toEqual([]);
  });

  it("treats a missing deps annotation as no dependencies", () => {
    const m = parseManifest("1. [pending] **phase-x** — title\n");
    expect(m.phases[0]?.deps).toEqual([]);
  });

  it("ignores malformed lines", () => {
    const m = parseManifest(
      [
        "1. [pending] **good** — t",
        "not an order line at all",
        "2. [garbage-state] **also-bad** — t",
        "3. nostate **also-bad** — t",
        "4. [pending] **second** — t",
      ].join("\n") + "\n",
    );
    expect(m.phases.map((p) => p.id)).toEqual(["good", "second"]);
  });

  it("captures the **Status:** line when present", () => {
    const m = parseManifest("**Status:** complete\n");
    expect(m.status).toBe("complete");
  });

  it("returns empty status if absent", () => {
    const m = parseManifest("1. [pending] **x** — t\n");
    expect(m.status).toBe("");
  });
});

describe("setState", () => {
  it("flips one line's state and leaves everything else untouched", () => {
    const next = setState(SAMPLE, "phase-02", "running");
    expect(next).toContain("2. [running] **phase-02**");
    // others unchanged
    expect(next).toContain("1. [merged] **phase-01**");
    expect(next).toContain("3. [pending] **phase-03**");
    expect(next).toContain("4. [pending] **phase-04**");
  });

  it("is a no-op when the id is not present", () => {
    const next = setState(SAMPLE, "phase-99", "merged");
    expect(next).toBe(SAMPLE);
  });

  it("escapes regex metacharacters in the id", () => {
    const text = "1. [pending] **phase.a+b** — t\n";
    const next = setState(text, "phase.a+b", "merged");
    expect(next).toBe("1. [merged] **phase.a+b** — t\n");
  });
});

describe("setStatusComplete", () => {
  it("rewrites an existing **Status:** line", () => {
    const next = setStatusComplete(SAMPLE);
    expect(next).toContain("**Status:** complete");
    expect(next).not.toContain("**Status:** in-progress");
  });

  it("appends if no Status line exists", () => {
    const next = setStatusComplete("just prose\n");
    expect(next.endsWith("**Status:** complete\n")).toBe(true);
  });
});

describe("allMerged", () => {
  it("is false if any entry is not merged", () => {
    expect(allMerged(parseManifest(SAMPLE))).toBe(false);
  });

  it("is true only when every entry is merged", () => {
    const allM = parseManifest(
      [
        "1. [merged] **a** — t",
        "2. [merged] **b** — t (deps: a)",
        "3. [merged] **c** — t (deps: b)",
      ].join("\n") + "\n",
    );
    expect(allMerged(allM)).toBe(true);
  });

  it("is false for the empty manifest", () => {
    expect(allMerged({ status: "", phases: [] })).toBe(false);
  });
});

describe("eligiblePhases", () => {
  it("returns pending phases whose deps are all merged", () => {
    const m = parseManifest(SAMPLE);
    const elig = eligiblePhases(m).map((p) => p.id);
    expect(elig).toEqual(["phase-02", "phase-03"]);
  });

  it("does not return a phase whose dep is failed/running/blocked", () => {
    const text =
      [
        "1. [failed] **a** — t",
        "2. [pending] **b** — t (deps: a)",
        "3. [running] **c** — t",
        "4. [pending] **d** — t (deps: c)",
      ].join("\n") + "\n";
    const elig = eligiblePhases(parseManifest(text)).map((p) => p.id);
    expect(elig).toEqual([]);
  });
});

describe("findPhaseDoc", () => {
  it("finds <id>-<slug>.md", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-"));
    try {
      await fs.writeFile(path.join(dir, "phase-02-something.md"), "x");
      await fs.writeFile(path.join(dir, "unrelated.md"), "x");
      const p = await findPhaseDoc(dir, "phase-02");
      expect(p).toBe(path.join(dir, "phase-02-something.md"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("matches DONE_-renamed docs too", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-"));
    try {
      await fs.writeFile(path.join(dir, "DONE_phase-02-x.md"), "x");
      const p = await findPhaseDoc(dir, "phase-02");
      expect(p).toBe(path.join(dir, "DONE_phase-02-x.md"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the directory does not exist", async () => {
    const p = await findPhaseDoc("/nonexistent/path/xyz", "phase-02");
    expect(p).toBeNull();
  });

  it("returns null when no doc matches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-"));
    try {
      await fs.writeFile(path.join(dir, "phase-99.md"), "x");
      const p = await findPhaseDoc(dir, "phase-02");
      expect(p).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
