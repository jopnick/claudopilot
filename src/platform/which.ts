/**
 * Cross-platform `command -v`. Returns an absolute path to the executable,
 * or null if not found on PATH. Windows-via-WSL2 is the host model, so PATH
 * uses POSIX semantics — but we still consider PATHEXT on win32 in case the
 * engine is ever invoked there directly.
 */

import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export interface WhichOptions {
  /** PATH override. Defaults to `process.env.PATH`. */
  path?: string;
  /** Working dir for relative-path resolution. Defaults to process.cwd(). */
  cwd?: string;
}

function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    // owner/group/other any-x bit
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function which(cmd: string, opts: WhichOptions = {}): string | null {
  if (!cmd) return null;

  // Absolute or explicitly relative path — resolve directly, no PATH walk.
  if (isAbsolute(cmd) || cmd.includes("/") || (process.platform === "win32" && cmd.includes("\\"))) {
    const abs = resolve(opts.cwd ?? process.cwd(), cmd);
    return isExecutableFile(abs) ? abs : null;
  }

  const pathStr = opts.path ?? process.env.PATH ?? "";
  if (!pathStr) return null;

  const extsRaw = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const exts = extsRaw.map((e) => e.toLowerCase());

  for (const dir of pathStr.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate) && isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
