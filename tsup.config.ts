import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node18",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  shims: false,
  banner: { js: "#!/usr/bin/env node" },
});
