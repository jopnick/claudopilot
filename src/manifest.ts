/**
 * Manifest model — typed parse/serialize + state transitions.
 *
 * Ports the bash helpers `order_lines`, `set_state`, `all_merged`, and
 * `phase_doc` from run-loop.sh. The grammar for an Order line is:
 *
 *     N. [state] **phase-id** — title (deps: a, b)
 *
 * The `(deps: ...)` annotation is optional. A bare `none` token inside it
 * means "no dependencies" and is normalized away (so it can never be
 * mistaken for an unsatisfiable phase id).
 *
 * The manifest also carries a `**Status:** <value>` line that the autonomous
 * loop watches for `complete`.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ManifestModel, PhaseEntry, PhaseState } from "./types.js";

const PHASE_STATES = new Set<PhaseState>([
  "pending",
  "running",
  "merged",
  "failed",
  "blocked",
]);

const ORDER_LINE_RE =
  /^([0-9]+)\.\s+\[([a-z]+)\]\s+\*\*([^*]+)\*\*(?:\s*[—-]\s*([^()]*?))?\s*(?:\(deps:\s*([^)]*)\))?\s*$/;

const STATUS_LINE_RE = /^\*\*Status:\*\*\s+(.+?)\s*$/;

/**
 * Parse the full manifest text into a typed model. Lines that don't match
 * the Order grammar are ignored (matches the bash `grep -E` prefilter). The
 * Status line, if present, is captured; otherwise `status` is the empty
 * string.
 */
export function parseManifest(text: string): ManifestModel {
  const phases: PhaseEntry[] = [];
  let status = "";

  for (const raw of text.split(/\r?\n/)) {
    const sm = STATUS_LINE_RE.exec(raw);
    if (sm && sm[1] !== undefined) {
      status = sm[1];
      continue;
    }
    const m = ORDER_LINE_RE.exec(raw);
    if (!m) continue;
    const stateRaw = m[2];
    const id = m[3];
    const title = (m[4] ?? "").trim();
    const depsRaw = m[5];
    if (!stateRaw || !id) continue;
    if (!PHASE_STATES.has(stateRaw as PhaseState)) continue;
    const deps = parseDeps(depsRaw);
    phases.push({
      id: id.trim(),
      state: stateRaw as PhaseState,
      title,
      deps,
    });
  }

  return { status, phases };
}

function parseDeps(depsRaw: string | undefined): string[] {
  if (!depsRaw) return [];
  return depsRaw
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && d !== "none");
}

/**
 * Update one Order line in place — pure string transform mirroring the `sed`
 * in `set_state`. Returns the new file text. The caller is responsible for
 * committing.
 *
 * If the id is not found, the text is returned unchanged.
 */
export function setState(text: string, id: string, state: PhaseState): string {
  const idEsc = escapeRegExp(id);
  const lineRe = new RegExp(
    `^([0-9]+\\.\\s+)\\[[a-z]+\\](\\s+\\*\\*${idEsc}\\*\\*)`,
    "gm",
  );
  return text.replace(lineRe, `$1[${state}]$2`);
}

/**
 * Set the `**Status:** complete` marker (the autonomous loop's exit signal).
 * If the Status line exists it is updated in place; otherwise it is appended.
 */
export function setStatusComplete(text: string): string {
  const re = /^\*\*Status:\*\*\s+.*$/m;
  if (re.test(text)) {
    return text.replace(re, "**Status:** complete");
  }
  const sep = text.endsWith("\n") ? "" : "\n";
  return `${text}${sep}**Status:** complete\n`;
}

/**
 * True iff every Order entry is `merged` (and there is at least one entry).
 * Mirrors `all_merged` in run-loop.sh.
 */
export function allMerged(model: ManifestModel): boolean {
  if (model.phases.length === 0) return false;
  return model.phases.every((p) => p.state === "merged");
}

/**
 * Phases that are `pending` AND have every declared dep already `merged`.
 * Mirrors the eligibility check in the driver's scheduler loop.
 */
export function eligiblePhases(model: ManifestModel): PhaseEntry[] {
  const merged = new Set(
    model.phases.filter((p) => p.state === "merged").map((p) => p.id),
  );
  return model.phases.filter(
    (p) => p.state === "pending" && p.deps.every((d) => merged.has(d)),
  );
}

/**
 * Find the phase doc file for an id. Matches `phase_doc()` in the bash:
 * looks for `<roadmap>/<id>*.md` or `<roadmap>/<id>-*.md`, returning the
 * first match (sorted) or null. Also matches DONE_-renamed docs.
 */
export async function findPhaseDoc(
  roadmapDir: string,
  id: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(roadmapDir);
  } catch {
    return null;
  }
  const matches = entries
    .filter(
      (name) =>
        name.endsWith(".md") &&
        (name === `${id}.md` ||
          name.startsWith(`${id}-`) ||
          name.startsWith(`${id}.`) ||
          name === `DONE_${id}.md` ||
          name.startsWith(`DONE_${id}-`) ||
          name.startsWith(`DONE_${id}.`)),
    )
    .sort();
  const first = matches[0];
  return first ? path.join(roadmapDir, first) : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
