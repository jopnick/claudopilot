import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { main, isMainEntry } from "./cli.js";

const PKG_VERSION = (JSON.parse(
  readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
) as { version: string }).version;

type Captured = { stdout: string; stderr: string };
function captureStdio<T>(fn: () => Promise<T> | T): Promise<{ result: T; io: Captured }> {
  const io: Captured = { stdout: "", stderr: "" };
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((c: unknown) => {
      io.stdout += String(c);
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((c: unknown) => {
      io.stderr += String(c);
      return true;
    });
  return Promise.resolve(fn())
    .then((result) => ({ result, io }))
    .finally(() => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    });
}

describe("cli main()", () => {
  it("--version prints the package version", async () => {
    const { result, io } = await captureStdio(() => main(["--version"]));
    expect(result).toBe(0);
    expect(io.stdout.trim()).toBe(PKG_VERSION);
  });

  it("-v is an alias for --version", async () => {
    const { result, io } = await captureStdio(() => main(["-v"]));
    expect(result).toBe(0);
    expect(io.stdout.trim()).toBe(PKG_VERSION);
  });

  it("--help prints usage", async () => {
    const { result, io } = await captureStdio(() => main(["--help"]));
    expect(result).toBe(0);
    expect(io.stdout).toContain("claudopilot v");
    expect(io.stdout).toContain("Usage:");
    expect(io.stdout).toContain("init");
    expect(io.stdout).toContain("run");
    expect(io.stdout).toContain("progress");
    expect(io.stdout).toContain("web");
  });

  it("no args prints help (exit 0)", async () => {
    const { result, io } = await captureStdio(() => main([]));
    expect(result).toBe(0);
    expect(io.stdout).toContain("Usage:");
  });

  it("unknown command returns 1 with help text on stderr", async () => {
    const { result, io } = await captureStdio(() => main(["nope"]));
    expect(result).toBe(1);
    expect(io.stderr).toContain("unknown command: nope");
    expect(io.stderr).toContain("Usage:");
  });
});

describe("cli init", () => {
  let tmp: string;
  let cwdSpy: { mockRestore: () => void };
  const read = (rel: string): string => readFileSync(path.join(tmp, rel), "utf8");
  const exists = async (rel: string): Promise<boolean> =>
    fs
      .stat(path.join(tmp, rel))
      .then(() => true)
      .catch(() => false);

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cp-init-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
  });
  afterEach(async () => {
    cwdSpy.mockRestore();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("fresh init writes core files and a skeleton manifest, no examples", async () => {
    const { result } = await captureStdio(() => main(["init"]));
    expect(result).toBe(0);
    expect(await exists(".claudopilot/config.json")).toBe(true);
    expect(await exists(".claudopilot/prompts/worker.md")).toBe(true);
    expect(await exists(".claudopilot/prompts/worker.project.md")).toBe(true);
    expect(await exists(".claudopilot/roadmap/EXECUTION-MANIFEST.md")).toBe(true);
    // No example phase doc by default.
    expect(await exists(".claudopilot/roadmap/phase-01-example.md")).toBe(false);
    // Skeleton manifest has an empty Order (no sample phase lines).
    expect(read(".claudopilot/roadmap/EXECUTION-MANIFEST.md")).not.toContain("**phase-01**");
    // config.json is valid JSON.
    expect(() => JSON.parse(read(".claudopilot/config.json"))).not.toThrow();
    // .gitignore excludes the run-state dir.
    expect(read(".gitignore")).toContain(".claudopilot/.run/");
  });

  it("--with-examples adds the sample roadmap", async () => {
    const { result } = await captureStdio(() => main(["init", "--with-examples"]));
    expect(result).toBe(0);
    expect(await exists(".claudopilot/roadmap/phase-01-example.md")).toBe(true);
    expect(read(".claudopilot/roadmap/EXECUTION-MANIFEST.md")).toContain("**phase-01**");
  });

  it("never overwrites existing project files (even with --force)", async () => {
    await fs.mkdir(path.join(tmp, ".claudopilot", "prompts"), { recursive: true });
    await fs.writeFile(path.join(tmp, ".claudopilot", "config.json"), "# MINE\n");
    await fs.writeFile(
      path.join(tmp, ".claudopilot", "prompts", "worker.project.md"),
      "# MINE\n",
    );
    const { result } = await captureStdio(() => main(["init", "--force"]));
    expect(result).toBe(0);
    expect(read(".claudopilot/config.json")).toBe("# MINE\n");
    expect(read(".claudopilot/prompts/worker.project.md")).toBe("# MINE\n");
  });

  it("skips examples when the roadmap already has content", async () => {
    await fs.mkdir(path.join(tmp, ".claudopilot", "roadmap"), { recursive: true });
    await fs.writeFile(path.join(tmp, ".claudopilot", "roadmap", "phase-99-mine.md"), "# mine\n");
    const { result, io } = await captureStdio(() => main(["init", "--with-examples"]));
    expect(result).toBe(0);
    expect(await exists(".claudopilot/roadmap/phase-01-example.md")).toBe(false);
    expect(io.stdout).toContain("skipping examples");
  });

  it("is idempotent on .gitignore (no duplicate run-state entry)", async () => {
    await captureStdio(() => main(["init"]));
    await captureStdio(() => main(["init"]));
    const ignore = read(".gitignore");
    const count = ignore.split("\n").filter((l) => l.trim() === ".claudopilot/.run/").length;
    expect(count).toBe(1);
  });
});

describe("cli progress --json", () => {
  let tmp: string;
  let cwdSpy: { mockRestore: () => void };
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cp-cli-"));
    await fs.mkdir(path.join(tmp, "roadmap"));
    await fs.writeFile(
      path.join(tmp, "roadmap", "EXECUTION-MANIFEST.md"),
      "**Status:** in-progress\n\n## Order\n\n1. [pending] **phase-X** — only (deps: none)\n",
    );
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
  });
  afterEach(async () => {
    cwdSpy.mockRestore();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("writes JSON snapshot to stdout with the same shape progress/model produces", async () => {
    const { result, io } = await captureStdio(() => main(["progress", "--json"]));
    expect(result).toBe(0);
    const parsed = JSON.parse(io.stdout) as { manifestStatus: string; phases: unknown[] };
    expect(parsed.manifestStatus).toBe("in-progress");
    expect(parsed.phases).toHaveLength(1);
  });

  it("honours --manifest override", async () => {
    const alt = path.join(tmp, "roadmap", "alt.md");
    await fs.writeFile(
      alt,
      "**Status:** complete\n\n## Order\n\n1. [merged] **phase-Y** — only (deps: none)\n",
    );
    const { result, io } = await captureStdio(() =>
      main(["progress", "--json", "--manifest", alt]),
    );
    expect(result).toBe(0);
    const parsed = JSON.parse(io.stdout) as { manifestStatus: string; phases: { id: string }[] };
    expect(parsed.manifestStatus).toBe("complete");
    expect(parsed.phases[0]?.id).toBe("phase-Y");
  });
});

describe("cli migrate", () => {
  let tmp: string;
  let cwdSpy: { mockRestore: () => void };
  const read = (rel: string): string => readFileSync(path.join(tmp, rel), "utf8");
  const exists = async (rel: string): Promise<boolean> =>
    fs
      .stat(path.join(tmp, rel))
      .then(() => true)
      .catch(() => false);

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cp-migrate-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
  });
  afterEach(async () => {
    cwdSpy.mockRestore();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("reports nothing to migrate on a clean dir", async () => {
    const { result, io } = await captureStdio(() => main(["migrate"]));
    expect(result).toBe(0);
    expect(io.stdout).toContain("No pre-1.0 layout found");
  });

  it("moves ./roadmap + ./claudopilot/prompts under .claudopilot/ and removes the old dirs", async () => {
    await fs.mkdir(path.join(tmp, "roadmap"), { recursive: true });
    await fs.mkdir(path.join(tmp, "claudopilot", "prompts"), { recursive: true });
    await fs.writeFile(path.join(tmp, "roadmap", "EXECUTION-MANIFEST.md"), "# m\n");
    await fs.writeFile(path.join(tmp, "roadmap", "phase-01-a.md"), "# a\n");
    await fs.writeFile(path.join(tmp, "claudopilot", "prompts", "worker.md"), "# w\n");

    const { result } = await captureStdio(() => main(["migrate"]));
    expect(result).toBe(0);
    expect(await exists(".claudopilot/roadmap/EXECUTION-MANIFEST.md")).toBe(true);
    expect(await exists(".claudopilot/roadmap/phase-01-a.md")).toBe(true);
    expect(await exists(".claudopilot/prompts/worker.md")).toBe(true);
    // Old dirs are gone (emptied + removed).
    expect(await exists("roadmap")).toBe(false);
    expect(await exists("claudopilot")).toBe(false);
  });

  it("rewrites .gitignore: drops a bare .claudopilot/ + .claudopilot.log, adds .run/", async () => {
    await fs.mkdir(path.join(tmp, "roadmap"), { recursive: true });
    await fs.writeFile(path.join(tmp, "roadmap", "x.md"), "# x\n");
    await fs.writeFile(
      path.join(tmp, ".gitignore"),
      "node_modules/\n.claudopilot/\n.claudopilot.log\n",
    );
    const { result } = await captureStdio(() => main(["migrate"]));
    expect(result).toBe(0);
    const ig = read(".gitignore");
    expect(ig).toContain("node_modules/");
    expect(ig).toContain(".claudopilot/.run/");
    expect(ig.split("\n").map((l) => l.trim())).not.toContain(".claudopilot/");
    expect(ig.split("\n").map((l) => l.trim())).not.toContain(".claudopilot.log");
  });

  it("--dry-run writes nothing", async () => {
    await fs.mkdir(path.join(tmp, "roadmap"), { recursive: true });
    await fs.writeFile(path.join(tmp, "roadmap", "x.md"), "# x\n");
    const { result, io } = await captureStdio(() => main(["migrate", "--dry-run"]));
    expect(result).toBe(0);
    expect(io.stdout).toContain("dry run");
    expect(await exists(".claudopilot/roadmap/x.md")).toBe(false);
    expect(await exists("roadmap/x.md")).toBe(true);
  });

  it("is idempotent (second run is a no-op)", async () => {
    await fs.mkdir(path.join(tmp, "roadmap"), { recursive: true });
    await fs.writeFile(path.join(tmp, "roadmap", "x.md"), "# x\n");
    await captureStdio(() => main(["migrate"]));
    const { result, io } = await captureStdio(() => main(["migrate"]));
    expect(result).toBe(0);
    expect(io.stdout).toContain("Already on the .claudopilot/ layout");
  });

  // Shell-config conversion forks bash; Windows CI runners lack it.
  it.skipIf(process.platform === "win32")(
    "converts claudopilot.config.sh → .claudopilot/config.json with typed values",
    async () => {
      await fs.writeFile(
        path.join(tmp, "claudopilot.config.sh"),
        `export GATE_CMD='pnpm test'\nexport MAX_PARALLEL=5\nexport KEEP_GOING=1\nexport RETRY_TRANSIENT_API=0\n`,
      );
      const { result } = await captureStdio(() => main(["migrate"]));
      expect(result).toBe(0);
      expect(await exists("claudopilot.config.sh")).toBe(false);
      const cfg = JSON.parse(read(".claudopilot/config.json")) as Record<string, unknown>;
      expect(cfg["gateCmd"]).toBe("pnpm test");
      expect(cfg["maxParallel"]).toBe(5);
      expect(cfg["keepGoing"]).toBe(true);
      expect(cfg["retryTransientApi"]).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "drops layout-pointer keys (roadmapDir/manifest) so the new defaults apply",
    async () => {
      await fs.writeFile(
        path.join(tmp, "claudopilot.config.sh"),
        `export GATE_CMD='x'\nexport ROADMAP_DIR='roadmap'\nexport MANIFEST="$REPO_ROOT/roadmap/EXECUTION-MANIFEST.md"\n`,
      );
      const { result } = await captureStdio(() => main(["migrate"]));
      expect(result).toBe(0);
      const cfg = JSON.parse(read(".claudopilot/config.json")) as Record<string, unknown>;
      expect(cfg["gateCmd"]).toBe("x");
      expect(cfg).not.toHaveProperty("roadmapDir");
      expect(cfg).not.toHaveProperty("manifest");
    },
  );
});

describe("isMainEntry (symlinked-install entry detection)", () => {
  let tmp = "";
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cp-entry-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns false when there is no entry (argv[1] undefined)", () => {
    expect(isMainEntry(undefined, pathToFileURL(path.join(tmp, "cli.js")).href)).toBe(false);
  });

  it("matches when the entry path equals the module file (node dist/cli.js)", async () => {
    const real = path.join(tmp, "cli.js");
    await fs.writeFile(real, "// cli\n");
    expect(isMainEntry(real, pathToFileURL(real).href)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "matches when the entry is a symlink to the module file (pnpm / global install)",
    async () => {
      // import.meta.url resolves symlinks, so the module URL is the real file
      // while argv[1] is the symlink path — the case a raw string compare missed.
      const real = path.join(tmp, "store", "cli.js");
      await fs.mkdir(path.dirname(real), { recursive: true });
      await fs.writeFile(real, "// cli\n");
      const link = path.join(tmp, "bin-cli.js");
      await fs.symlink(real, link);
      expect(isMainEntry(link, pathToFileURL(real).href)).toBe(true);
    },
  );

  it("does not match an unrelated entry path", async () => {
    const real = path.join(tmp, "cli.js");
    await fs.writeFile(real, "// cli\n");
    const other = path.join(tmp, "not-cli.js");
    await fs.writeFile(other, "// other\n");
    expect(isMainEntry(other, pathToFileURL(real).href)).toBe(false);
  });
});
