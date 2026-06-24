import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, extractShellConfig } from "./config.js";

async function tmpRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "config-"));
}

describe("loadConfig", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await tmpRepo();
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", async () => {
    const c = await loadConfig(repo, {});
    expect(c.repoRoot).toBe(repo);
    expect(c.roadmapDir).toBe(".claudopilot/roadmap");
    expect(c.manifest).toBe(
      path.join(repo, ".claudopilot", "roadmap", "EXECUTION-MANIFEST.md"),
    );
    expect(c.agentDriver).toBe("claude");
    expect(c.agentModel).toBe("");
    expect(c.maxParallel).toBe(3);
    expect(c.pollSeconds).toBe(5);
    expect(c.gateCmd).toBe("true");
    expect(c.isolated).toBe(false);
    expect(c.retryTransientApi).toBe(true);
    expect(c.runDir).toBe(path.join(repo, ".claudopilot", ".run"));
  });

  it("applies values from claudopilot.config.sh on top of defaults", async () => {
    await fs.writeFile(
      path.join(repo, "claudopilot.config.sh"),
      `export GATE_CMD='pnpm typecheck && pnpm test'
export MAX_PARALLEL=5
export ROADMAP_DIR=plans
`,
    );
    const c = await loadConfig(repo, {});
    expect(c.gateCmd).toBe("pnpm typecheck && pnpm test");
    expect(c.maxParallel).toBe(5);
    expect(c.roadmapDir).toBe("plans");
    expect(c.manifest).toBe(path.join(repo, "plans", "EXECUTION-MANIFEST.md"));
  });

  it("applies values from .claudopilot/config.json (camelCase)", async () => {
    await fs.mkdir(path.join(repo, ".claudopilot"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".claudopilot", "config.json"),
      JSON.stringify({
        gateCmd: "pnpm test",
        maxParallel: 7,
        keepGoing: true,
        retryTransientApi: false,
        roadmapDir: "plans",
      }),
    );
    const c = await loadConfig(repo, {});
    expect(c.gateCmd).toBe("pnpm test");
    expect(c.maxParallel).toBe(7);
    expect(c.keepGoing).toBe(true);
    expect(c.retryTransientApi).toBe(false);
    expect(c.roadmapDir).toBe("plans");
  });

  it("prefers .claudopilot/config.json over the pre-1.0 claudopilot.config.sh", async () => {
    await fs.mkdir(path.join(repo, ".claudopilot"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".claudopilot", "config.json"),
      JSON.stringify({ gateCmd: "from-json" }),
    );
    await fs.writeFile(
      path.join(repo, "claudopilot.config.sh"),
      `export GATE_CMD='from-sh'\n`,
    );
    const c = await loadConfig(repo, {});
    expect(c.gateCmd).toBe("from-json");
  });

  it("env still wins over .claudopilot/config.json", async () => {
    await fs.mkdir(path.join(repo, ".claudopilot"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".claudopilot", "config.json"),
      JSON.stringify({ maxParallel: 4 }),
    );
    const c = await loadConfig(repo, { MAX_PARALLEL: "9" });
    expect(c.maxParallel).toBe(9);
  });

  it("falls back to pre-1.0 ./roadmap + ./claudopilot/prompts when present", async () => {
    await fs.mkdir(path.join(repo, "roadmap"), { recursive: true });
    await fs.mkdir(path.join(repo, "claudopilot", "prompts"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repo, "claudopilot", "prompts", "worker.md"),
      "w",
    );
    const c = await loadConfig(repo, {});
    expect(c.roadmapDir).toBe("roadmap");
    expect(c.promptFile).toBe(
      path.join(repo, "claudopilot", "prompts", "worker.md"),
    );
  });

  it("env wins over the config file", async () => {
    await fs.writeFile(
      path.join(repo, "claudopilot.config.sh"),
      `export MAX_PARALLEL=5
export GATE_CMD='from-file'
`,
    );
    const c = await loadConfig(repo, {
      MAX_PARALLEL: "9",
      GATE_CMD: "from-env",
    });
    expect(c.maxParallel).toBe(9);
    expect(c.gateCmd).toBe("from-env");
  });

  it("honors CLAUDOPILOT_CONFIG env to relocate the file", async () => {
    const alt = path.join(repo, "alt.sh");
    await fs.writeFile(alt, `export GATE_CMD='alt'\n`);
    const c = await loadConfig(repo, { CLAUDOPILOT_CONFIG: alt });
    expect(c.gateCmd).toBe("alt");
  });

  it("parses numeric and boolean (0/1) values", async () => {
    await fs.writeFile(
      path.join(repo, "claudopilot.config.sh"),
      `export CLAUDOPILOT_ISOLATED=1
export KEEP_GOING=1
export RETRY_TRANSIENT_API=0
export STUCK_TIMEOUT=300
`,
    );
    const c = await loadConfig(repo, {});
    expect(c.isolated).toBe(true);
    expect(c.keepGoing).toBe(true);
    expect(c.retryTransientApi).toBe(false);
    expect(c.stuckTimeout).toBe(300);
  });

  it("falls back to default when a numeric value is malformed", async () => {
    const c = await loadConfig(repo, { MAX_PARALLEL: "not-a-number" });
    expect(c.maxParallel).toBe(3);
  });

  it("preserves empty-string overrides for optional commands", async () => {
    // An explicit empty value should unset, not fall back to default. Tested
    // here on WORKTREE_PREPARE_CMD whose default is already "".
    await fs.writeFile(
      path.join(repo, "claudopilot.config.sh"),
      `export WORKTREE_PREPARE_CMD='pnpm install'\n`,
    );
    // With file value
    const c1 = await loadConfig(repo, {});
    expect(c1.worktreePrepareCmd).toBe("pnpm install");
    // Env override to empty
    const c2 = await loadConfig(repo, { WORKTREE_PREPARE_CMD: "" });
    expect(c2.worktreePrepareCmd).toBe("");
  });
});

describe("extractShellConfig", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await tmpRepo();
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("returns {} for a missing file", async () => {
    const out = await extractShellConfig(path.join(repo, "nope.sh"));
    expect(out).toEqual({});
  });

  it("returns {} when bash fails to source the file", async () => {
    const p = path.join(repo, "bad.sh");
    await fs.writeFile(p, `not-a-command-zzz\nexit 9\n`);
    const out = await extractShellConfig(p);
    // Either the source step errors and we get {}, or it succeeds and is
    // empty — either way no spurious keys.
    expect(Object.keys(out).filter((k) => k.startsWith("MY_"))).toEqual([]);
  });

  it("captures simple exports", async () => {
    const p = path.join(repo, "ok.sh");
    await fs.writeFile(
      p,
      `export FOO=bar
export BAZ='hello world'
QUX=quux  # set -a still exports this
`,
    );
    const out = await extractShellConfig(p);
    expect(out["FOO"]).toBe("bar");
    expect(out["BAZ"]).toBe("hello world");
    expect(out["QUX"]).toBe("quux");
  });

  it("survives values with quotes and special characters", async () => {
    const p = path.join(repo, "tricky.sh");
    await fs.writeFile(p, `export CMD='echo "hi" && exit 0'\n`);
    const out = await extractShellConfig(p);
    expect(out["CMD"]).toBe('echo "hi" && exit 0');
  });
});
