import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "./which.js";

const POSIX = process.platform !== "win32";

describe("which", () => {
  it("finds node on PATH", () => {
    const p = which("node");
    expect(p).toBeTruthy();
    expect(typeof p).toBe("string");
  });

  it("returns null for a binary that does not exist", () => {
    expect(which("definitely-not-a-real-binary-xyz-1234")).toBeNull();
  });

  it("returns null for an empty command", () => {
    expect(which("")).toBeNull();
  });

  it.skipIf(!POSIX)("respects a custom PATH and finds the executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "which-"));
    const bin = join(dir, "my-tool");
    writeFileSync(bin, "#!/bin/sh\necho hi\n");
    chmodSync(bin, 0o755);
    const found = which("my-tool", { path: dir });
    expect(found).toBe(bin);
  });

  it.skipIf(!POSIX)("ignores non-executable files on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "which-"));
    const bin = join(dir, "not-exec");
    writeFileSync(bin, "hi\n", { mode: 0o644 });
    chmodSync(bin, 0o644);
    expect(which("not-exec", { path: dir })).toBeNull();
  });

  it.skipIf(!POSIX)("resolves an absolute path directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "which-"));
    const bin = join(dir, "abs-tool");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(which(bin)).toBe(bin);
  });
});
