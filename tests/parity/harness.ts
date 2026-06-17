/**
 * Shared scaffolding for the bash-vs-TS parity harness.
 *
 * Each test runs the SAME fixture roadmap through both engines in two
 * sibling tmp git repos, against a stub `claude` CLI on PATH. The
 * snapshot returned by `runEngine()` covers everything the phase doc's
 * parity contract names: process exit code, the manifest state-change
 * sequence, the final `**Status:**` line, and the capture/build-log
 * file layout.
 */

import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { loadConfig } from "../../src/config.js";
import { Git } from "../../src/git.js";
import { runDriver } from "../../src/orchestrator/driver.js";

// Repo root of the claudopilot checkout running these tests.
export const PKG_ROOT = path.resolve(__dirname, "..", "..");

// ── Fixture writers ────────────────────────────────────────────────────

export interface PhaseSpec {
  /** Phase id, e.g. "phase-01". */
  id: string;
  /** Title shown on the manifest Order line + phase doc heading. */
  title: string;
  /** Dependency ids (omit / [] = none). */
  deps?: string[];
}

export interface FixtureSpec {
  /** Phases the manifest will list, in Order. */
  phases: PhaseSpec[];
  /**
   * If set, the stub `claude` will NOT rename DONE_ on the worker call
   * (no SUPERVISOR_MODE env). The driver routes to supervise, which
   * re-invokes the stub with SUPERVISOR_MODE set, and that DOES rename.
   */
  forceSupervisor?: boolean;
}

/**
 * Write the manifest, per-phase docs, prompt files, render-stream, and
 * project config under `repoDir`. The caller has already `git init`-ed
 * and created an initial commit on the base branch.
 */
export async function writeFixture(
  repoDir: string,
  spec: FixtureSpec,
): Promise<void> {
  const roadmap = path.join(repoDir, "roadmap");
  const claudopilot = path.join(repoDir, "claudopilot");
  const prompts = path.join(claudopilot, "prompts");
  await fs.mkdir(roadmap, { recursive: true });
  await fs.mkdir(prompts, { recursive: true });

  const orderLines = spec.phases.map((p, i) => {
    const deps = !p.deps || p.deps.length === 0 ? "none" : p.deps.join(", ");
    return `${i + 1}. [pending] **${p.id}** — ${p.title} (deps: ${deps})`;
  });
  const manifest =
    "# Parity fixture manifest\n\n" +
    "**Status:** in-progress\n\n" +
    "## Order\n\n" +
    orderLines.join("\n") +
    "\n";
  await fs.writeFile(path.join(roadmap, "EXECUTION-MANIFEST.md"), manifest);

  for (const p of spec.phases) {
    const doc = `# ${p.id} — ${p.title}\n\nTrivial parity fixture phase.\n`;
    await fs.writeFile(path.join(roadmap, `${p.id}-${slug(p.title)}.md`), doc);
  }

  await fs.writeFile(
    path.join(prompts, "worker.md"),
    "# parity worker prompt\nDo the trivial work and rename DONE_.\n",
  );
  await fs.writeFile(
    path.join(prompts, "supervisor.md"),
    "# parity supervisor prompt\nRecover the phase by renaming DONE_.\n",
  );

  // Bash engine consumes the renderer as a subprocess; copy it in so the
  // bash run is self-contained. The TS engine renders in-process and
  // doesn't need this file.
  await fs.copyFile(
    path.join(PKG_ROOT, "render-stream.mjs"),
    path.join(claudopilot, "render-stream.mjs"),
  );
  await fs.copyFile(
    path.join(PKG_ROOT, "render-stream-opencode.mjs"),
    path.join(claudopilot, "render-stream-opencode.mjs"),
  );

  const config = [
    "#!/usr/bin/env bash",
    `export GATE_CMD="true"`,
    `export POLL_SECONDS=1`,
    `export MAX_PARALLEL=1`,
    `export MAX_ITER=200`,
    `export DEFAULT_RATE_LIMIT_SLEEP=1`,
    `export STUCK_TIMEOUT=0`,
    `export RETRY_TRANSIENT_API=0`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(repoDir, "claudopilot.config.sh"), config);
}

function slug(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Repo setup ─────────────────────────────────────────────────────────

export interface RepoSetup {
  repoDir: string;
  baseBranch: string;
  /** Bare repo serving as `origin`. */
  originDir: string;
}

/**
 * Init a non-bare repo with an initial commit, set up a bare origin
 * remote, and check out a non-trunk branch (avoids the trunk guard in
 * both engines). Returns the repo paths.
 */
export async function initRepo(root: string): Promise<RepoSetup> {
  const repoDir = path.join(root, "repo");
  const originDir = path.join(root, "origin.git");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(originDir, { recursive: true });

  await run("git", ["init", "--initial-branch=main", "--bare"], originDir);
  await run("git", ["init", "--initial-branch=main"], repoDir);
  await run("git", ["config", "user.email", "test@example.com"], repoDir);
  await run("git", ["config", "user.name", "Parity Test"], repoDir);
  await run("git", ["config", "commit.gpgsign", "false"], repoDir);

  await fs.writeFile(path.join(repoDir, ".gitignore"), ".claudopilot/\n");
  await run("git", ["add", "-A"], repoDir);
  await run("git", ["commit", "-m", "init"], repoDir);

  await run("git", ["remote", "add", "origin", originDir], repoDir);
  await run("git", ["push", "-u", "origin", "main"], repoDir);

  const baseBranch = "runner";
  await run("git", ["checkout", "-b", baseBranch], repoDir);
  await run("git", ["push", "-u", "origin", baseBranch], repoDir);

  return { repoDir, baseBranch, originDir };
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// ── Stub `claude` CLI ──────────────────────────────────────────────────

/**
 * Write a `claude` script into `binDir` that:
 *   - Parses `-p <prompt>` (and ignores the other args the engines pass)
 *   - Extracts the phase id from the prompt suffix
 *   - Outputs minimal stream-json (so the renderer is exercised)
 *   - Renames roadmap/<id>-*.md → roadmap/DONE_<id>-*.md, commits
 *   - Exits 0 (matching the real `claude -p`'s "always exits 0" contract)
 *
 * If `forceSupervisor` is on, the stub skips the rename when
 * `SUPERVISOR_MODE` is unset (the worker call) and only renames when
 * the driver re-invokes it with SUPERVISOR_MODE set.
 */
export async function writeStubClaude(
  binDir: string,
  opts: { forceSupervisor: boolean } = { forceSupervisor: false },
): Promise<string> {
  await fs.mkdir(binDir, { recursive: true });
  const stubPath = path.join(binDir, "claude");
  const skipBlock = opts.forceSupervisor
    ? `if [[ -z "\${SUPERVISOR_MODE:-}" && -z "$DONE" ]]; then SKIP=1; fi`
    : "";
  const script = `#!/usr/bin/env bash
set -uo pipefail

PROMPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) PROMPT="$2"; shift 2;;
    --resume) shift 2;;
    --permission-mode|--output-format|-m) shift 2;;
    --verbose|--dangerously-skip-permissions) shift;;
    *) shift;;
  esac
done

ID=$(printf '%s' "$PROMPT" | grep -oE 'phase to execute is: [a-z0-9_-]+' | sed 's/.*: //' | head -n1)
if [[ -z "$ID" ]]; then
  ID=$(printf '%s' "$PROMPT" | grep -oE 'phase that just halted: [a-z0-9_-]+' | sed 's/.*: //' | head -n1)
fi
if [[ -z "$ID" ]]; then
  echo "stub-claude: could not parse phase id" >&2
  exit 1
fi

printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sid-'"$$"'","model":"stub","tools":[],"cwd":"'"$PWD"'"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"stub processing '"$ID"'"}]}}'

ROADMAP="\${ROADMAP_DIR:-roadmap}"
DOC=$(ls "$ROADMAP"/"$ID"-*.md 2>/dev/null | head -n1)
DONE=$(ls "$ROADMAP"/DONE_"$ID"-*.md 2>/dev/null | head -n1)
SKIP=0
${skipBlock}

if [[ "$SKIP" == "0" && -n "$DOC" && -z "$DONE" ]]; then
  git mv "$DOC" "$ROADMAP/DONE_$(basename "$DOC")" >/dev/null 2>&1
fi

echo "stub-marker $$" >> .stub-marker
git add -A >/dev/null 2>&1
MSG="stub: $ID"
[[ -n "\${SUPERVISOR_MODE:-}" ]] && MSG="$MSG supervisor"
git -c user.email=stub@example.com -c user.name=stub commit -q -m "$MSG" >/dev/null 2>&1 || true

printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"duration_ms":50,"total_cost_usd":0.0}'
exit 0
`;
  await fs.writeFile(stubPath, script, { mode: 0o755 });
  return stubPath;
}

// ── Engine runners ─────────────────────────────────────────────────────

export interface EngineResult {
  /** Process / driver exit code. */
  code: number;
  /** Final `**Status:**` value parsed from the manifest. */
  status: string;
  /** Final state of every phase on the Order list, in order. */
  finalStates: Array<{ id: string; state: string }>;
  /** Manifest state-change commit sequence, e.g. `phase-a -> running`. */
  stateCommitLog: string[];
  /** Capture / build-log file layout, sorted relative paths. */
  artifacts: string[];
}

/** Run `bash run-loop.sh` against the fixture and return a comparable snapshot. */
export async function runBashEngine(
  setup: RepoSetup,
  binDir: string,
): Promise<EngineResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
    REPO_ROOT: setup.repoDir,
    BASE_BRANCH: setup.baseBranch,
    BASE_BRANCH_EXPLICIT: "1",
    HOME: process.env["HOME"] ?? "/tmp",
    // Prevent stray env from the host engine bleeding in.
    CLAUDOPILOT_ISOLATED: "0",
    AGENT_DRIVER: "claude",
    POLL_SECONDS: "1",
    MAX_PARALLEL: "1",
    MAX_ITER: "200",
    MAX_SUPERVISOR_ATTEMPTS_PER_PHASE: "2",
  };
  const runLoop = path.join(PKG_ROOT, "run-loop.sh");
  const r = await run("bash", [runLoop], setup.repoDir, env);
  return await snapshot(setup, r.code ?? 1);
}

/** Run the TS `runDriver()` against the fixture and return a comparable snapshot. */
export async function runTsEngine(
  setup: RepoSetup,
  binDir: string,
): Promise<EngineResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
    REPO_ROOT: setup.repoDir,
    POLL_SECONDS: "1",
    MAX_PARALLEL: "1",
    MAX_ITER: "200",
    MAX_SUPERVISOR_ATTEMPTS_PER_PHASE: "2",
    DEFAULT_RATE_LIMIT_SLEEP: "1",
    RETRY_TRANSIENT_API: "0",
  };
  const config = await loadConfig(setup.repoDir, env);
  const git = new Git({ cwd: setup.repoDir });
  const workerPrompt = await fs.readFile(config.promptFile, "utf8");
  const supervisorPrompt = await fs.readFile(config.supervisorPromptFile, "utf8");

  // Patch process.env PATH so captureAgent's spawn inherits the stub.
  const savedPath = process.env["PATH"];
  process.env["PATH"] = `${binDir}:${savedPath ?? ""}`;
  let code: number;
  try {
    code = await runDriver(
      { git, log: () => undefined, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      {
        config,
        baseBranch: setup.baseBranch,
        workerPrompt,
        supervisorPrompt,
      },
    );
  } finally {
    process.env["PATH"] = savedPath;
  }
  return await snapshot(setup, code);
}

// ── Snapshot ───────────────────────────────────────────────────────────

async function snapshot(setup: RepoSetup, code: number): Promise<EngineResult> {
  // Make sure we read from the base branch (engines may have left it
  // checked out anyway).
  await run("git", ["checkout", setup.baseBranch], setup.repoDir);
  const mfPath = path.join(setup.repoDir, "roadmap", "EXECUTION-MANIFEST.md");
  const mf = await fs.readFile(mfPath, "utf8");

  const status = (/^\*\*Status:\*\*\s+(.+?)\s*$/m.exec(mf)?.[1] ?? "").trim();

  const finalStates: Array<{ id: string; state: string }> = [];
  for (const line of mf.split(/\r?\n/)) {
    const m = /^[0-9]+\.\s+\[([a-z]+)\]\s+\*\*([^*]+)\*\*/.exec(line);
    if (m && m[1] && m[2]) finalStates.push({ id: m[2].trim(), state: m[1] });
  }

  // State-change commit sequence (chore(loop): <id> -> <state>).
  const gitLog = await run(
    "git",
    [
      "log",
      "--pretty=format:%s",
      "--reverse",
      `main..${setup.baseBranch}`,
    ],
    setup.repoDir,
  );
  const stateCommitLog: string[] = [];
  for (const line of gitLog.stdout.split(/\r?\n/)) {
    const m = /^chore\(loop\):\s+(.+?)\s+->\s+(.+?)\s*$/.exec(line);
    if (m && m[1] && m[2]) stateCommitLog.push(`${m[1]} -> ${m[2]}`);
  }

  const artifacts: string[] = [];
  for (const sub of [".claudopilot", "build-logs"]) {
    const root = path.join(setup.repoDir, sub);
    for await (const rel of walk(root)) {
      // Drop volatile noise (worktrees, control inbox) — they're not in
      // the parity contract and can include per-engine timing artifacts.
      if (rel.startsWith("worktrees/") || rel.startsWith("control/")) continue;
      artifacts.push(`${sub}/${rel}`);
    }
  }
  artifacts.sort();

  return { code, status, finalStates, stateCommitLog, artifacts };
}

async function* walk(root: string, prefix = ""): AsyncIterable<string> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      yield* walk(path.join(root, e.name), rel);
    } else {
      yield rel;
    }
  }
}

// ── Capture artifact categorization (parity assertion helper) ─────────

/**
 * Reduce the raw artifact list to the *shape* the parity contract names:
 * one `*.log`, `*.stream.jsonl`, `*.transcript.md` per phase under
 * `.claudopilot/`, and `transcript.md` + `stream.jsonl.gz` per phase
 * under `build-logs/`. Hides timing-dependent extras (resume sidechannel,
 * empty files) that aren't part of the contract.
 */
export function captureShape(artifacts: string[]): string[] {
  const out = new Set<string>();
  for (const a of artifacts) {
    const m1 = /^\.claudopilot\/([a-z0-9_-]+)\.(log|stream\.jsonl|transcript\.md)$/.exec(a);
    if (m1 && m1[1] && m1[2]) {
      out.add(`.claudopilot/${m1[1]}.${m1[2]}`);
      continue;
    }
    const m2 = /^build-logs\/([a-z0-9_-]+)\/(transcript\.md|stream\.jsonl\.gz)$/.exec(a);
    if (m2 && m2[1] && m2[2]) {
      out.add(`build-logs/${m2[1]}/${m2[2]}`);
    }
  }
  return [...out].sort();
}
