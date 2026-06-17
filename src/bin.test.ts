/**
 * Engine-switch routing test for `bin/claudopilot.mjs`.
 *
 * The .mjs is the published `bin` shim — when `CLAUDOPILOT_ENGINE=ts` (or
 * `--engine ts`) is set it execs `dist/cli.js`; otherwise it shells out to
 * the bash stack. Phase-07 adds the switch so the two stacks coexist.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PKG_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(PKG_ROOT, "bin", "claudopilot.mjs");
const DIST = path.join(PKG_ROOT, "dist", "cli.js");

beforeAll(() => {
  // Ensure the TS engine is built; the routing test execs dist/cli.js.
  if (!existsSync(DIST)) {
    execFileSync("pnpm", ["-s", "build"], { cwd: PKG_ROOT, stdio: "inherit" });
  }
}, 60_000);

function runBin(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
  cwd: string = PKG_ROOT,
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("bin engine switch", () => {
  it("defaults to bash (no env, no flag) — bash --help works without dist", () => {
    // `--help` is handled by the .mjs directly in bash mode, so it works
    // regardless of dist presence.
    const r = runBin(["--help"], { CLAUDOPILOT_ENGINE: "" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("claudopilot v");
  });

  it("CLAUDOPILOT_ENGINE=ts delegates to dist/cli.js --version", () => {
    const r = runBin(["--version"], { CLAUDOPILOT_ENGINE: "ts" });
    expect(r.code).toBe(0);
    // dist/cli.js writes the same version string.
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--engine ts is stripped from argv and routes to dist/cli.js", () => {
    const r = runBin(["--engine", "ts", "--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--engine=ts (equals form) also routes to dist/cli.js", () => {
    const r = runBin(["--engine=ts", "--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("CLAUDOPILOT_ENGINE=ts progress --json produces a snapshot with the model shape", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cp-bin-"));
    try {
      const roadmap = path.join(tmp, "roadmap");
      await fs.mkdir(roadmap);
      await fs.writeFile(
        path.join(roadmap, "EXECUTION-MANIFEST.md"),
        "**Status:** in-progress\n\n## Order\n\n1. [pending] **phase-X** — only (deps: none)\n",
      );
      const r = runBin(
        ["progress", "--json"],
        { CLAUDOPILOT_ENGINE: "ts" },
        tmp,
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        manifestStatus: string;
        phases: { id: string; state: string }[];
        summary: { total: number };
      };
      // Shape parity with the snapshot model exposed by progress/model.ts —
      // also the shape the bash `progress.mjs` JSON output produces.
      expect(parsed.manifestStatus).toBe("in-progress");
      expect(parsed.phases).toHaveLength(1);
      expect(parsed.phases[0]?.id).toBe("phase-X");
      expect(parsed.phases[0]?.state).toBe("pending");
      expect(parsed.summary.total).toBe(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
