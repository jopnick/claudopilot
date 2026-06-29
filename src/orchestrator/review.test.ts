import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Config } from "../types.js";
import type { Git } from "../git.js";
import type { WorkerRecord } from "./types.js";
import {
  decideRound,
  gatingFindings,
  isConfirmed,
  parseLenses,
  extractLastJsonObject,
  parseReviewerResult,
  parseSkepticVerdict,
  syntheticBlocker,
  buildReviewFixPrompt,
  runReviewGate,
  newReviewMemory,
  type ReviewContext,
  type ReviewFinding,
  type ReviewMemory,
  type RunReviewAgentArgs,
} from "./review.js";

// ── decideRound: pinned to the table in REVIEW-GATE.md ───────────────────

describe("decideRound matches the REVIEW-GATE.md table (cross-driver drift guard)", () => {
  const md = readFileSync(
    path.resolve(__dirname, "..", "..", "REVIEW-GATE.md"),
    "utf8",
  );
  const begin = md.indexOf("DECIDE-ROUND-TABLE:BEGIN");
  const end = md.indexOf("DECIDE-ROUND-TABLE:END");
  const block = md.slice(begin, end);
  const rows = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.slice(1, -1).split("|").map((c) => c.trim()))
    // drop the header row and the |---| separator row
    .filter((cells) => cells[0] !== "confirmed" && !cells[0]!.startsWith("---"));

  it("parses a non-trivial table", () => {
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });

  for (const cells of rows) {
    const [confirmed, oscillating, round, maxRounds, outcome, reason] = cells;
    it(`row: confirmed=${confirmed} osc=${oscillating} round=${round}/${maxRounds} -> ${outcome}`, () => {
      const got = decideRound({
        confirmed: Number(confirmed),
        oscillating: oscillating === "true",
        round: Number(round),
        maxRounds: Number(maxRounds),
      });
      expect(got.kind).toBe(outcome);
      if (outcome === "park") expect((got as { reason: string }).reason).toBe(reason);
    });
  }
});

describe("the native pilot-run SKILL reproduces the decideRound table verbatim", () => {
  // REVIEW-GATE.md says SKILL.md must reproduce the table verbatim; this guards
  // the second (native) driver against drifting from the source of truth.
  const tableRows = (file: string): string[] => {
    const md = readFileSync(path.resolve(__dirname, "..", "..", file), "utf8");
    const begin = md.indexOf("DECIDE-ROUND-TABLE:BEGIN");
    const end = md.indexOf("DECIDE-ROUND-TABLE:END");
    return md
      .slice(begin, end)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("|"));
  };

  it("matches REVIEW-GATE.md row for row", () => {
    const spec = tableRows("REVIEW-GATE.md");
    const skill = tableRows(path.join("pilot", "skills", "pilot-run", "SKILL.md"));
    expect(spec.length).toBeGreaterThanOrEqual(8);
    expect(skill).toEqual(spec);
  });
});

describe("decideRound precedence", () => {
  it("a clean round always merges, even if the oscillating flag is set", () => {
    expect(decideRound({ confirmed: 0, oscillating: true, round: 9, maxRounds: 3 })).toEqual({
      kind: "merge",
    });
  });
  it("oscillation parks before the round cap is reached", () => {
    expect(decideRound({ confirmed: 1, oscillating: true, round: 1, maxRounds: 5 })).toEqual({
      kind: "park",
      reason: "review oscillation",
    });
  });
  it("reaching the cap parks as did-not-converge", () => {
    expect(decideRound({ confirmed: 2, oscillating: false, round: 3, maxRounds: 3 })).toEqual({
      kind: "park",
      reason: "review did not converge",
    });
  });
  it("below the cap with confirmed findings fixes", () => {
    expect(decideRound({ confirmed: 1, oscillating: false, round: 1, maxRounds: 3 })).toEqual({
      kind: "fix",
    });
  });
});

// ── gating + confirmation ────────────────────────────────────────────────

describe("gatingFindings", () => {
  it("keeps blocker/major and drops minor", () => {
    const f = (severity: ReviewFinding["severity"], id: string): ReviewFinding => ({
      id,
      severity,
      lens: "correctness",
      title: id,
    });
    const out = gatingFindings([f("blocker", "a"), f("major", "b"), f("minor", "c")]);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("isConfirmed (strict majority, refute-by-default)", () => {
  it("synthetic findings are always confirmed", () => {
    expect(isConfirmed(0, 2, true)).toBe(true);
  });
  it("M=2 needs 2 real votes", () => {
    expect(isConfirmed(2, 2, false)).toBe(true);
    expect(isConfirmed(1, 2, false)).toBe(false);
    expect(isConfirmed(0, 2, false)).toBe(false);
  });
  it("M=3 needs a strict majority (2)", () => {
    expect(isConfirmed(2, 3, false)).toBe(true);
    expect(isConfirmed(1, 3, false)).toBe(false);
  });
  it("M=1 needs 1 real vote", () => {
    expect(isConfirmed(1, 1, false)).toBe(true);
    expect(isConfirmed(0, 1, false)).toBe(false);
  });
});

describe("parseLenses", () => {
  it("trims, lowercases, de-dupes", () => {
    expect(parseLenses("Correctness, security ,correctness")).toEqual([
      "correctness",
      "security",
    ]);
  });
  it("falls back to the default set when empty", () => {
    expect(parseLenses("  ,, ")).toEqual(["correctness", "security", "scope", "tests"]);
  });
});

// ── JSON extraction + result parsing ──────────────────────────────────────

describe("extractLastJsonObject", () => {
  it("picks the last balanced object amid prose", () => {
    const text = 'blah {"a":1} more text\nfinal: {"verdict":"real","x":{"y":2}} trailing';
    expect(extractLastJsonObject(text)).toEqual({ verdict: "real", x: { y: 2 } });
  });
  it("ignores braces inside strings", () => {
    expect(extractLastJsonObject('{"s":"a } b","v":"real"}')).toEqual({
      s: "a } b",
      v: "real",
    });
  });
  it("returns null when there is no JSON", () => {
    expect(extractLastJsonObject("no json here")).toBeNull();
  });
});

describe("parseReviewerResult", () => {
  it("parses findings and normalizes severity/id", () => {
    const text = JSON.stringify({
      role: "reviewer",
      lens: "correctness",
      findings: [
        { id: "x-null-deref", severity: "blocker", title: "boom", file: "a.ts:3" },
        { severity: "weird", title: "No id here" },
      ],
    });
    const out = parseReviewerResult(text, "correctness");
    expect(out[0]).toMatchObject({ id: "x-null-deref", severity: "blocker", file: "a.ts:3" });
    // unknown severity -> major (still gates); missing id -> generated slug
    expect(out[1]!.severity).toBe("major");
    expect(out[1]!.id.length).toBeGreaterThan(0);
  });
  it("an empty findings array is a clean lens", () => {
    expect(parseReviewerResult('{"findings":[]}', "tests")).toEqual([]);
  });
  it("unparseable output becomes a synthetic blocker (never silent-clean)", () => {
    const out = parseReviewerResult("the model crashed", "security");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "blocker", synthetic: true, lens: "security" });
  });
});

describe("parseSkepticVerdict (refute by default)", () => {
  it("real only on an explicit real verdict", () => {
    expect(parseSkepticVerdict('{"verdict":"real"}')).toBe("real");
  });
  it("anything else refutes", () => {
    expect(parseSkepticVerdict('{"verdict":"refuted"}')).toBe("refuted");
    expect(parseSkepticVerdict("garbage")).toBe("refuted");
    expect(parseSkepticVerdict('{"nope":1}')).toBe("refuted");
  });
});

// ── runReviewGate integration (fake agent + fake git) ─────────────────────

function fakeConfig(over: Partial<Config>): Config {
  return {
    isolated: false,
    roadmapDir: "roadmap",
    reviewLenses: "correctness",
    reviewSkeptics: 2,
    reviewMaxRounds: 3,
    ...over,
  } as unknown as Config;
}

/** branchHasDone() reads only logTouching + lsTree; fake just those. */
function fakeGit(done: boolean): Git {
  return {
    logTouching: async () => [],
    lsTree: async () => (done ? ["roadmap/DONE_phase-a-x.md"] : ["roadmap/phase-a-x.md"]),
  } as unknown as Git;
}

const record = (): WorkerRecord =>
  ({
    id: "phase-a",
    branch: "auto/phase-a",
    worktree: "/tmp/wt",
    paths: { log: "", stream: "", transcript: "" },
    done: Promise.resolve({ code: 0, signal: null }),
    supervisorAttempts: 0,
    apiRetries: 0,
  }) as unknown as WorkerRecord;

interface Script {
  reviewer: (lens: string) => string;
  skeptic: (finding: ReviewFinding) => "real" | "refuted";
  done?: boolean;
  config?: Partial<Config>;
}

function ctx(script: Script): ReviewContext {
  return {
    config: fakeConfig(script.config ?? {}),
    git: fakeGit(script.done ?? true),
    reviewerPromptBody: "BODY",
    runReviewAgent: async (a: RunReviewAgentArgs) => {
      if (a.role === "reviewer") return { code: 0, text: script.reviewer(a.lens) };
      // skeptic: decode the finding out of the prompt is overkill; the gate
      // passes the finding via the prompt, but our fake keys off the slot's lens.
      const m = a.prompt.match(/"id":"([^"]+)"/);
      const finding: ReviewFinding = { id: m?.[1] ?? "?", severity: "major", lens: a.lens, title: "" };
      return { code: 0, text: JSON.stringify({ verdict: script.skeptic(finding) }) };
    },
  };
}

const reviewerClean = (): string => JSON.stringify({ findings: [] });
const reviewerWith = (findings: ReviewFinding[]) => (): string => JSON.stringify({ findings });

describe("runReviewGate", () => {
  const base = "main";

  it("clean round merges", async () => {
    const out = await runReviewGate({
      ctx: ctx({ reviewer: reviewerClean, skeptic: () => "refuted" }),
      record: record(),
      memory: newReviewMemory(),
      baseBranch: base,
    });
    expect(out).toEqual({ kind: "merge" });
  });

  it("a confirmed finding fixes and advances the round counter", async () => {
    const memory = newReviewMemory();
    const out = await runReviewGate({
      ctx: ctx({
        reviewer: reviewerWith([
          { id: "bug-x", severity: "major", lens: "correctness", title: "bug" },
        ]),
        skeptic: () => "real",
      }),
      record: record(),
      memory,
      baseBranch: base,
    });
    expect(out.kind).toBe("fix");
    expect(memory.rounds).toBe(1);
    expect(memory.prevConfirmed).toEqual(["bug-x"]);
  });

  it("a refuted finding merges (skeptics cleared it)", async () => {
    const out = await runReviewGate({
      ctx: ctx({
        reviewer: reviewerWith([
          { id: "bug-x", severity: "blocker", lens: "correctness", title: "bug" },
        ]),
        skeptic: () => "refuted",
      }),
      record: record(),
      memory: newReviewMemory(),
      baseBranch: base,
    });
    expect(out).toEqual({ kind: "merge" });
  });

  it("a minor finding never gates -> merge", async () => {
    const out = await runReviewGate({
      ctx: ctx({
        reviewer: reviewerWith([
          { id: "nit", severity: "minor", lens: "correctness", title: "nit" },
        ]),
        skeptic: () => "real",
      }),
      record: record(),
      memory: newReviewMemory(),
      baseBranch: base,
    });
    expect(out).toEqual({ kind: "merge" });
  });

  it("the same confirmed set recurring after a fix parks (oscillation)", async () => {
    const memory: ReviewMemory = { rounds: 1, prevConfirmed: ["bug-x"] };
    const out = await runReviewGate({
      ctx: ctx({
        reviewer: reviewerWith([
          { id: "bug-x", severity: "major", lens: "correctness", title: "bug" },
        ]),
        skeptic: () => "real",
      }),
      record: record(),
      memory,
      baseBranch: base,
    });
    expect(out).toEqual({ kind: "park", reason: "review oscillation" });
  });

  it("reaching maxRounds with confirmed findings parks (did not converge)", async () => {
    const out = await runReviewGate({
      ctx: ctx({
        reviewer: reviewerWith([
          { id: "bug-x", severity: "major", lens: "correctness", title: "bug" },
        ]),
        skeptic: () => "real",
        config: { reviewMaxRounds: 1 },
      }),
      record: record(),
      memory: newReviewMemory(),
      baseBranch: base,
    });
    expect(out).toEqual({ kind: "park", reason: "review did not converge" });
  });

  it("NEVER-MERGE-RED: an unparseable reviewer never merges", async () => {
    const out = await runReviewGate({
      ctx: ctx({ reviewer: () => "the reviewer crashed", skeptic: () => "refuted" }),
      record: record(),
      memory: newReviewMemory(),
      baseBranch: base,
    });
    expect(out.kind).not.toBe("merge");
    expect(out.kind).toBe("fix"); // synthetic blocker -> confirmed -> fix (round 1 < cap)
  });

  it("a branch that lost DONE_ routes to fix without a review round", async () => {
    const memory = newReviewMemory();
    const out = await runReviewGate({
      ctx: ctx({ reviewer: reviewerClean, skeptic: () => "refuted", done: false }),
      record: record(),
      memory,
      baseBranch: base,
    });
    expect(out).toEqual({ kind: "fix", findings: [] });
    expect(memory.rounds).toBe(0);
  });
});

describe("syntheticBlocker", () => {
  it("is a stable, synthetic, gating finding", () => {
    const f = syntheticBlocker("scope");
    expect(f).toMatchObject({ id: "review-error-scope", severity: "blocker", synthetic: true });
    expect(gatingFindings([f])).toHaveLength(1);
  });
});

describe("buildReviewFixPrompt", () => {
  const findings: ReviewFinding[] = [
    { id: "correctness-off-by-one", severity: "blocker", lens: "correctness", title: "off-by-one in loop" },
    { id: "scope-unowned-pkg", severity: "major", lens: "scope", file: "pkg/x.ts", title: "edits unowned pkg" },
  ];

  it("keeps the worker prompt, embeds every finding, and warns against early exit", () => {
    const p = buildReviewFixPrompt("WORKER BODY", "phase-7", findings);
    expect(p).toContain("WORKER BODY");
    expect(p).toContain("auto/phase-7");
    expect(p).toContain("off-by-one in loop");
    expect(p).toContain("edits unowned pkg");
    // The branch is already DONE_ — the worker must not treat the phase as done.
    expect(p).toContain("do NOT treat the phase as finished");
    expect(p).toMatch(/do NOT merge or edit the manifest/i);
  });
});
