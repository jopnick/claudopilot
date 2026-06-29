/**
 * Convergence review gate — the ultracode-style review that runs before a
 * phase merges. See `REVIEW-GATE.md` for the normative contract; this module
 * is the TypeScript engine's implementation of it.
 *
 * Shape mirrors the rest of the orchestrator: pure decision functions
 * (`decideRound`, `gatingFindings`, `isConfirmed`) that are directly unit
 * testable, plus an orchestrator (`runReviewGate`) that drives injected
 * reviewer/skeptic agents through a closure — exactly like `supervise()` calls
 * the driver-injected `runSupervisorAgent`.
 *
 * Invariants (enforced here, asserted in review.test.ts):
 *  - NEVER-MERGE-RED: the only path to `{kind:"merge"}` is a round whose
 *    confirmed-gating-findings count is zero. Every crash / timeout /
 *    unparseable verdict maps to a non-clean outcome (synthetic blocker on a
 *    dead reviewer; refuted on a dead skeptic).
 *  - The round counter lives in driver-side `ReviewMemory` (a Map keyed by
 *    phase id), NOT on the WorkerRecord — `launchPhase` builds a fresh record
 *    every relaunch, so a record-local counter would never bind `maxRounds`.
 */

import type { Config } from "../types.js";
import type { Git } from "../git.js";
import { branchHasDone } from "./supervisor.js";
import type { WorkerRecord } from "./types.js";

// ── Finding + agent-result vocabulary ────────────────────────────────────

export type FindingSeverity = "blocker" | "major" | "minor";

export interface ReviewFinding {
  /** Stable slug assigned by the reviewer (recurrence ⇒ oscillation). */
  id: string;
  severity: FindingSeverity;
  lens: string;
  file?: string;
  title: string;
  detail?: string;
  /** True when the engine synthesized this finding (e.g. a dead reviewer). */
  synthetic?: boolean;
}

export type SkepticVerdict = "real" | "refuted";

/** The lenses string ("a,b,c") → a clean, de-duped, non-empty lens list. */
export function parseLenses(csv: string): string[] {
  const out: string[] = [];
  for (const raw of csv.split(",")) {
    const lens = raw.trim().toLowerCase();
    if (lens && !out.includes(lens)) out.push(lens);
  }
  return out.length > 0 ? out : ["correctness", "security", "scope", "tests"];
}

// ── Pure decision functions ──────────────────────────────────────────────

/** The findings that can gate a merge — blocker/major only; minor never gates. */
export function gatingFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.filter((f) => f.severity === "blocker" || f.severity === "major");
}

/**
 * Is a gating finding *confirmed*? A synthetic finding (dead reviewer) is always
 * confirmed — a broken reviewer can never produce a silent clean round. A real
 * finding is confirmed only on a strict majority of "real" skeptic votes out of
 * the configured M; missing votes (dead/unparseable skeptic) count as refuted.
 */
export function isConfirmed(
  realVotes: number,
  skepticCount: number,
  synthetic: boolean,
): boolean {
  if (synthetic) return true;
  return realVotes * 2 > skepticCount;
}

export interface DecideRoundInput {
  /** Count of confirmed gating findings this round. */
  confirmed: number;
  /** Confirmed id-set identical to the previous fix round's (a recurrence). */
  oscillating: boolean;
  /** 1-based current round number. */
  round: number;
  /** Configured round cap. */
  maxRounds: number;
}

export type RoundDecision =
  | { kind: "merge" }
  | { kind: "fix" }
  | { kind: "park"; reason: string };

/**
 * The single source of truth for the converge/fix/park decision, pinned to the
 * table in REVIEW-GATE.md (review.test.ts parses that table and checks every
 * row against this function). Precedence top-to-bottom:
 *   clean round → merge; recurring set → park (oscillation); cap reached → park;
 *   otherwise → fix.
 */
export function decideRound(input: DecideRoundInput): RoundDecision {
  const { confirmed, oscillating, round, maxRounds } = input;
  if (confirmed === 0) return { kind: "merge" };
  if (oscillating) return { kind: "park", reason: "review oscillation" };
  if (round >= maxRounds) return { kind: "park", reason: "review did not converge" };
  return { kind: "fix" };
}

// ── Parsing agent output (never trust the exit code — read the JSON) ──────

/**
 * Find the last top-level balanced JSON object in arbitrary agent text. The
 * reviewer/skeptic contract is "the final message is a single JSON object", but
 * the transcript also contains rendered prose, so we scan for the last
 * brace-balanced substring that `JSON.parse`s. Returns null if none.
 */
export function extractLastJsonObject(text: string): unknown | null {
  let last: string | null = null;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i++;
      continue;
    }
    // Walk from this `{` to its matching `}`, respecting string literals.
    let depth = 0;
    let inStr = false;
    let esc = false;
    let matched = false;
    let j = i;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          matched = true;
          break;
        }
      }
    }
    if (matched) {
      const sub = text.slice(i, j + 1);
      try {
        JSON.parse(sub);
        last = sub; // keep the LAST top-level object
      } catch {
        /* balanced but not valid JSON — ignore */
      }
      i = j + 1; // skip past this object so nested `{`s aren't new starts
    } else {
      i++; // never balanced from here
    }
  }
  if (last === null) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

function normalizeSeverity(v: unknown): FindingSeverity {
  // Unknown/garbled severities are treated as `major` so they still gate —
  // doubt must not slip a finding below the gating threshold.
  return v === "blocker" || v === "minor" ? v : "major";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

/** A synthetic blocker standing in for a reviewer that produced no usable result. */
export function syntheticBlocker(lens: string): ReviewFinding {
  return {
    id: `review-error-${slugify(lens) || "lens"}`,
    severity: "blocker",
    lens,
    title: `reviewer (${lens}) did not return a valid result`,
    synthetic: true,
  };
}

/**
 * Parse a reviewer agent's captured output into findings for `lens`. An
 * unparseable / shapeless result yields a single synthetic blocker (never a
 * silent clean lens).
 */
export function parseReviewerResult(text: string, lens: string): ReviewFinding[] {
  const obj = extractLastJsonObject(text) as { findings?: unknown } | null;
  if (!obj || !Array.isArray(obj.findings)) return [syntheticBlocker(lens)];
  const out: ReviewFinding[] = [];
  for (const raw of obj.findings) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const title = typeof f["title"] === "string" && f["title"] ? f["title"] : "(untitled finding)";
    const id =
      typeof f["id"] === "string" && f["id"].trim()
        ? f["id"].trim()
        : `${slugify(lens)}-${slugify(title)}` || slugify(title) || "finding";
    const finding: ReviewFinding = {
      id,
      severity: normalizeSeverity(f["severity"]),
      lens: typeof f["lens"] === "string" && f["lens"] ? f["lens"] : lens,
      title,
    };
    if (typeof f["file"] === "string") finding.file = f["file"];
    if (typeof f["detail"] === "string") finding.detail = f["detail"];
    out.push(finding);
  }
  return out;
}

/** Parse a skeptic verdict; default to `refuted` (a dead skeptic can't confirm). */
export function parseSkepticVerdict(text: string): SkepticVerdict {
  const obj = extractLastJsonObject(text) as { verdict?: unknown } | null;
  return obj && obj.verdict === "real" ? "real" : "refuted";
}

// ── Prompt construction (the reviewer.md body + a per-task suffix) ────────

export function buildReviewerPrompt(
  body: string,
  args: { id: string; lens: string; baseBranch: string },
): string {
  return (
    `${body}\n\n--- REVIEW TASK ---\n` +
    `Role: reviewer\n` +
    `Phase id: ${args.id}\n` +
    `Lens: ${args.lens}\n` +
    `Base branch: ${args.baseBranch}\n` +
    `Review the change set \`git diff ${args.baseBranch}...auto/${args.id}\` (plus the` +
    ` DONE_ phase doc + repo conventions) through the ${args.lens} lens only.\n` +
    `Return the single reviewer JSON object and nothing else.`
  );
}

export function buildSkepticPrompt(
  body: string,
  args: { id: string; finding: ReviewFinding; baseBranch: string },
): string {
  return (
    `${body}\n\n--- REVIEW TASK ---\n` +
    `Role: skeptic\n` +
    `Phase id: ${args.id}\n` +
    `Base branch: ${args.baseBranch}\n` +
    `Try to REFUTE this finding (default to refuted unless the diff proves it real):\n` +
    `${JSON.stringify(args.finding)}\n` +
    `Return the single skeptic JSON object and nothing else.`
  );
}

/** Markdown note dropped in the worktree so a relaunched worker reads the findings. */
export function renderReviewNote(id: string, findings: readonly ReviewFinding[]): string {
  const lines = findings.map(
    (f) =>
      `- **[${f.severity}] ${f.title}** (${f.lens}${f.file ? `, ${f.file}` : ""}) — id \`${f.id}\`` +
      (f.detail ? `\n  ${f.detail.replace(/\n/g, "\n  ")}` : ""),
  );
  return (
    `# Review findings for ${id}\n\n` +
    `A convergence review of your branch found the issues below. Fix **every** one,` +
    ` keep the gate green, then re-rename the phase doc to DONE_.\n\n` +
    `${lines.join("\n")}\n`
  );
}

/**
 * The relaunch prompt for a worker that must fix confirmed review findings on a
 * `fix` outcome. Review only ever runs on a branch that already has the DONE_
 * rename, so the worker is told *explicitly* not to treat the phase as finished:
 * it must address every finding, keep the gate green, and leave the doc DONE_.
 * The findings are embedded inline (the same set is also written to a worktree
 * note) so the relaunch is self-contained even on a cold session.
 */
export function buildReviewFixPrompt(
  workerPrompt: string,
  id: string,
  findings: readonly ReviewFinding[],
): string {
  return (
    `${workerPrompt}\n\n--- REVIEW FIX REQUIRED ---\n` +
    `You are in this phase's git worktree on branch auto/${id}. Your work was reviewed before\n` +
    `merge and the findings below MUST be fixed before it can merge. The phase doc is already\n` +
    `renamed DONE_ — that is expected; do NOT treat the phase as finished and do NOT stop without\n` +
    `addressing them. Fix EVERY finding, keep the gate green, leave the phase doc renamed DONE_,\n` +
    `then stop. Do NOT merge or edit the manifest — the driver owns those.\n\n` +
    renderReviewNote(id, findings)
  );
}

// ── The gate ──────────────────────────────────────────────────────────────

export interface ReviewMemory {
  /** Completed fix rounds so far (number of times a fix was issued). */
  rounds: number;
  /** Sorted confirmed finding ids from the last round that issued a fix. */
  prevConfirmed: string[];
}

export function newReviewMemory(): ReviewMemory {
  return { rounds: 0, prevConfirmed: [] };
}

export interface RunReviewAgentArgs {
  id: string;
  prompt: string;
  role: "reviewer" | "skeptic";
  /** Capture-path suffix component, e.g. "r1-correctness" or "r1-f-<id>-s2". */
  slot: string;
  /** The lens (reviewer) or the finding's lens (skeptic) — for REVIEW_LENS env. */
  lens: string;
  record: WorkerRecord;
}

export interface ReviewContext {
  config: Config;
  git: Git;
  log?: (m: string) => void;
  /** The reviewer.md body (+ optional project overlay), injected by the driver. */
  reviewerPromptBody: string;
  /**
   * Run one reviewer/skeptic agent to completion and return its captured
   * transcript text (the engine never trusts the exit code — it parses the
   * JSON out of `text`). Injected by the driver, mirroring runSupervisorAgent.
   */
  runReviewAgent: (args: RunReviewAgentArgs) => Promise<{ code: number | null; text: string }>;
}

export type ReviewOutcome =
  | { kind: "merge" }
  | { kind: "fix"; findings: ReviewFinding[] }
  | { kind: "park"; reason: string };

const sortedIds = (findings: readonly ReviewFinding[]): string[] =>
  findings.map((f) => f.id).sort();

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Run one review round for a phase and return what the driver should do. The
 * driver applies the outcome: `merge` → mergePhase; `fix` → relaunch the worker
 * (the relaunch's exit re-enters this gate); `park` → parkOrHalt `[blocked]`.
 *
 * `memory` is mutated on a `fix` (round counter + prevConfirmed) so the next
 * re-entry sees the advanced round and can detect oscillation / cap-out.
 */
export async function runReviewGate(args: {
  ctx: ReviewContext;
  record: WorkerRecord;
  memory: ReviewMemory;
  baseBranch: string;
}): Promise<ReviewOutcome> {
  const { ctx, record, memory, baseBranch } = args;
  const { config, git, log } = ctx;
  const round = memory.rounds + 1;
  const id = record.id;

  // Step 1 — never review/merge a branch that lost its DONE_ rename. Hand it
  // back to the worker/supervisor machinery to finish (not a review round).
  if (!(await branchHasDone(config, git, id, record.worktree))) {
    log?.(`  [${id}] review: branch is not DONE_ — relaunching worker to finish.`);
    return { kind: "fix", findings: [] };
  }

  // Step 2 — one reviewer per lens, in parallel.
  const lenses = parseLenses(config.reviewLenses);
  const reviewerOutputs = await Promise.all(
    lenses.map(async (lens) => {
      const prompt = buildReviewerPrompt(ctx.reviewerPromptBody, { id, lens, baseBranch });
      try {
        const res = await ctx.runReviewAgent({
          id,
          prompt,
          role: "reviewer",
          slot: `r${round}-${lens}`,
          lens,
          record,
        });
        return parseReviewerResult(res.text, lens);
      } catch {
        return [syntheticBlocker(lens)];
      }
    }),
  );
  const findings = reviewerOutputs.flat();

  // Step 3 — only blocker/major gate.
  const gating = gatingFindings(findings);
  log?.(
    `  [${id}] review round ${round}: ${findings.length} finding(s), ${gating.length} gating.`,
  );

  // Step 4 — adversarially verify each gating finding with M skeptics.
  const confirmed: ReviewFinding[] = [];
  const m = Math.max(1, config.reviewSkeptics);
  for (const f of gating) {
    if (f.synthetic) {
      confirmed.push(f);
      continue;
    }
    const votes = await Promise.all(
      Array.from({ length: m }, async (_unused, i) => {
        const prompt = buildSkepticPrompt(ctx.reviewerPromptBody, { id, finding: f, baseBranch });
        try {
          const res = await ctx.runReviewAgent({
            id,
            prompt,
            role: "skeptic",
            slot: `r${round}-f-${slugify(f.id)}-s${i + 1}`,
            lens: f.lens,
            record,
          });
          return parseSkepticVerdict(res.text);
        } catch {
          return "refuted" as SkepticVerdict;
        }
      }),
    );
    const realVotes = votes.filter((v) => v === "real").length;
    if (isConfirmed(realVotes, m, false)) confirmed.push(f);
  }

  // Step 5 — decide.
  const confirmedIds = sortedIds(confirmed);
  const oscillating =
    confirmed.length > 0 &&
    memory.prevConfirmed.length > 0 &&
    sameSet(confirmedIds, memory.prevConfirmed);
  const decision = decideRound({
    confirmed: confirmed.length,
    oscillating,
    round,
    maxRounds: config.reviewMaxRounds,
  });

  if (decision.kind === "merge") {
    log?.(`  [${id}] review round ${round}: clean — merging.`);
    return { kind: "merge" };
  }
  if (decision.kind === "park") {
    log?.(`  [${id}] review round ${round}: ${decision.reason} — parking.`);
    return { kind: "park", reason: decision.reason };
  }
  // fix
  memory.rounds = round;
  memory.prevConfirmed = confirmedIds;
  return { kind: "fix", findings: confirmed };
}
