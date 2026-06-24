/**
 * Host-path → container bind-mount path normalization.
 *
 * The engine runs on Linux / macOS / Windows-via-WSL2; the worker always runs
 * inside a Linux container. Bind mounts need POSIX paths inside the container:
 *
 *   - Linux host:      /work               → /work                (identity)
 *   - macOS host:      /Users/x/repo       → /Users/x/repo        (identity)
 *   - WSL2 host:       /mnt/c/Users/x/r    → /mnt/c/Users/x/r     (identity)
 *   - Win32 host:      C:\Users\x\repo     → /c/Users/x/repo      (Docker Desktop style)
 *
 * Only the Win32 case is non-trivial; we cover it because the engine may be
 * exercised in CI from a Windows runner before WSL2 is wired up.
 */

import { posix } from "node:path";

export interface DockerPathOptions {
  /** Override platform. Defaults to `process.platform`. Test seam. */
  platform?: NodeJS.Platform;
}

export function toContainerPath(hostPath: string, opts: DockerPathOptions = {}): string {
  if (!hostPath) return hostPath;
  const plat = opts.platform ?? process.platform;

  if (plat !== "win32") {
    // POSIX hosts (incl. WSL2): bind mounts are identity.
    return hostPath;
  }

  // Win32: C:\Users\x\repo → /c/Users/x/repo
  const win = hostPath.replace(/\\/g, "/");
  const drive = /^([a-zA-Z]):\/?(.*)$/.exec(win);
  if (drive) {
    const letter = (drive[1] ?? "").toLowerCase();
    const rest = drive[2] ?? "";
    return `/${letter}/${rest}`.replace(/\/+$/g, "") || `/${letter}`;
  }
  return win;
}

/** Predicate: is this a path the engine knows how to bind-mount? */
export function isMountablePath(p: string, opts: DockerPathOptions = {}): boolean {
  if (!p) return false;
  const plat = opts.platform ?? process.platform;
  // Decide by the *target* platform, not the host's ambient `path` flavor —
  // otherwise this misclassifies POSIX paths when the engine runs on Windows.
  if (plat === "win32") {
    return /^[a-zA-Z]:[\\/]/.test(p);
  }
  return posix.isAbsolute(p);
}
