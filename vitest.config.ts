import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
    exclude: ["node_modules", "dist", "claudopilot/**"],
    environment: "node",
    passWithNoTests: true,
    // Windows CI runs the fs/HTTP-heavy suites (web SSE, git) many times slower
    // than POSIX; the default 5s is too tight there. Long e2e tests set their
    // own per-test timeouts above this.
    testTimeout: 20000,
  },
});
