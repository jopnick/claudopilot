import { describe, it, expect, beforeEach } from "vitest";
import {
  onShutdown,
  triggerShutdown,
  _resetShutdownForTests,
} from "./signals.js";

describe("signals", () => {
  beforeEach(() => {
    _resetShutdownForTests();
  });

  it("runs registered callbacks in reverse order (LIFO)", async () => {
    const calls: string[] = [];
    onShutdown(() => {
      calls.push("a");
    });
    onShutdown(() => {
      calls.push("b");
    });
    onShutdown(() => {
      calls.push("c");
    });
    await triggerShutdown();
    expect(calls).toEqual(["c", "b", "a"]);
  });

  it("passes the reason through to callbacks", async () => {
    let seen: string | undefined;
    onShutdown((reason) => {
      seen = String(reason);
    });
    await triggerShutdown("SIGTERM");
    expect(seen).toBe("SIGTERM");
  });

  it("swallows callback errors so subsequent callbacks still run", async () => {
    const calls: string[] = [];
    onShutdown(() => {
      calls.push("after");
    });
    onShutdown(() => {
      throw new Error("boom");
    });
    await triggerShutdown();
    expect(calls).toEqual(["after"]);
  });

  it("supports unsubscribing", async () => {
    const calls: string[] = [];
    const off = onShutdown(() => {
      calls.push("x");
    });
    off();
    await triggerShutdown();
    expect(calls).toEqual([]);
  });

  it("is idempotent — second trigger is a no-op while draining", async () => {
    const calls: string[] = [];
    onShutdown(async () => {
      calls.push("once");
    });
    await Promise.all([triggerShutdown(), triggerShutdown()]);
    expect(calls).toEqual(["once"]);
  });
});
