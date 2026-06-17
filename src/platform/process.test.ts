import { describe, it, expect } from "vitest";
import { spawnCapture, spawnDetached, killTree, reapExit } from "./process.js";

const POSIX = process.platform !== "win32";

describe("spawnCapture", () => {
  it("captures stdout from a successful command", async () => {
    const r = await spawnCapture("node", ["-e", "process.stdout.write('hello')"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hello");
    expect(r.stderr).toBe("");
    expect(r.timedOut).toBe(false);
  });

  it("captures stderr and a non-zero exit without throwing", async () => {
    const r = await spawnCapture("node", [
      "-e",
      "process.stderr.write('bad'); process.exit(2)",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("bad");
  });

  it("rejects when the binary doesn't exist", async () => {
    await expect(
      spawnCapture("definitely-not-a-real-binary-xyz", []),
    ).rejects.toBeDefined();
  });

  it("respects maxBuffer (truncates rather than OOMing)", async () => {
    const r = await spawnCapture(
      "node",
      ["-e", "process.stdout.write('x'.repeat(10000))"],
      { maxBuffer: 100 },
    );
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(100);
  });

  it("kills the child when timeoutMs elapses", async () => {
    const r = await spawnCapture(
      "node",
      ["-e", "setInterval(()=>{}, 1000)"],
      { timeoutMs: 150 },
    );
    expect(r.timedOut).toBe(true);
    expect(r.code === null || r.code !== 0).toBe(true);
  });

  it("pipes input on stdin", async () => {
    const r = await spawnCapture(
      "node",
      ["-e", "process.stdin.pipe(process.stdout)"],
      { input: "abc\n" },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("abc\n");
  });
});

describe("spawnDetached / killTree", () => {
  it.skipIf(!POSIX)("kills the whole process group", async () => {
    // Parent node spawns a grandchild sleeper (also node, also a process). The
    // parent then loops idle so we know it's still up. killTree(-pid) should
    // take down both. We grep `ps` for the grandchild PID to confirm.
    const script = `
      const { spawn } = require('node:child_process');
      const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 100000)'], { stdio: 'ignore' });
      process.stdout.write(String(gc.pid) + '\\n');
      setInterval(() => {}, 100000);
    `;
    const child = spawnDetached(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(child.pid).toBeTypeOf("number");

    const gcPid = await new Promise<number>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("no gc pid")), 2000);
      child.stdout?.setEncoding("utf8");
      child.stdout?.once("data", (d: string) => {
        clearTimeout(to);
        const n = parseInt(d.trim(), 10);
        if (!Number.isFinite(n)) reject(new Error("bad gc pid: " + d));
        else resolve(n);
      });
    });

    const ok = killTree(child, "SIGTERM");
    expect(ok).toBe(true);

    await reapExit(child);

    // Give the kernel a moment to reap the grandchild.
    await new Promise((r) => setTimeout(r, 100));

    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(gcPid)).toBe(false);
  });

  it.skipIf(!POSIX)("returns false for a handle with no pid", () => {
    expect(killTree({ id: "x" })).toBe(false);
    expect(killTree({ pid: null })).toBe(false);
    expect(killTree({ pid: 0 })).toBe(false);
  });
});

describe("reapExit", () => {
  it("resolves with code 0 for an already-exited child", async () => {
    const child = spawnDetached(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const r = await reapExit(child);
    expect(r.code).toBe(0);
  });
});
