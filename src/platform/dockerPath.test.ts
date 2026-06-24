import { describe, it, expect } from "vitest";
import { toContainerPath, isMountablePath } from "./dockerPath.js";

describe("toContainerPath", () => {
  it("is identity on linux", () => {
    expect(toContainerPath("/work", { platform: "linux" })).toBe("/work");
    expect(toContainerPath("/Users/x/repo", { platform: "linux" })).toBe("/Users/x/repo");
  });

  it("is identity on darwin", () => {
    expect(toContainerPath("/Users/x/repo", { platform: "darwin" })).toBe("/Users/x/repo");
  });

  it("is identity for WSL2-mounted paths (host platform is linux)", () => {
    expect(toContainerPath("/mnt/c/Users/x/repo", { platform: "linux" })).toBe(
      "/mnt/c/Users/x/repo",
    );
  });

  it("rewrites win32 drive paths to Docker Desktop format", () => {
    expect(toContainerPath("C:\\Users\\x\\repo", { platform: "win32" })).toBe(
      "/c/Users/x/repo",
    );
    expect(toContainerPath("D:\\src\\proj", { platform: "win32" })).toBe("/d/src/proj");
  });

  it("handles a bare win32 drive root", () => {
    expect(toContainerPath("C:\\", { platform: "win32" })).toBe("/c");
  });

  it("returns falsy for empty input", () => {
    expect(toContainerPath("", { platform: "linux" })).toBe("");
  });
});

describe("isMountablePath", () => {
  it("accepts POSIX absolute paths on linux", () => {
    expect(isMountablePath("/work", { platform: "linux" })).toBe(true);
    expect(isMountablePath("./rel", { platform: "linux" })).toBe(false);
    expect(isMountablePath("", { platform: "linux" })).toBe(false);
  });

  it("accepts win32 drive-rooted paths on win32", () => {
    expect(isMountablePath("C:\\Users\\x", { platform: "win32" })).toBe(true);
    expect(isMountablePath("C:/Users/x", { platform: "win32" })).toBe(true);
    expect(isMountablePath("Users\\x", { platform: "win32" })).toBe(false);
  });
});
