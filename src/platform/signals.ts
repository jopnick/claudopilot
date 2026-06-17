/**
 * Shutdown signal registry — the bash `trap` equivalent. Modules anywhere
 * in the engine register a callback that drains/cleans-up; on SIGINT/SIGTERM
 * we run them all (best-effort, in reverse order) and then exit with the
 * conventional 128+signal code.
 *
 * Idempotent: installing the handlers more than once is a no-op.
 */

export type ShutdownReason = NodeJS.Signals | "manual";
export type ShutdownCallback = (reason: ShutdownReason) => void | Promise<void>;

const callbacks: ShutdownCallback[] = [];
let installed = false;
let draining = false;

/** Register a callback to run on SIGINT/SIGTERM (or `triggerShutdown`). */
export function onShutdown(cb: ShutdownCallback): () => void {
  callbacks.push(cb);
  return () => {
    const i = callbacks.indexOf(cb);
    if (i >= 0) callbacks.splice(i, 1);
  };
}

/**
 * Install SIGINT/SIGTERM handlers. Safe to call repeatedly. Returns the
 * underlying drain function for tests / programmatic shutdown.
 */
export function installShutdownHandlers(): (reason: ShutdownReason) => Promise<void> {
  if (!installed) {
    installed = true;
    const onSig = (sig: NodeJS.Signals): void => {
      void drain(sig).then(() => {
        const n = signalToNumber(sig);
        process.exit(128 + n);
      });
    };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
  }
  return drain;
}

export async function triggerShutdown(reason: ShutdownReason = "manual"): Promise<void> {
  await drain(reason);
}

/** Test-only: clear registered callbacks (does not uninstall signal handlers). */
export function _resetShutdownForTests(): void {
  callbacks.length = 0;
  draining = false;
}

async function drain(reason: ShutdownReason): Promise<void> {
  if (draining) return;
  draining = true;
  // Reverse order: last-registered cleans up first (LIFO, like defer).
  for (let i = callbacks.length - 1; i >= 0; i--) {
    const cb = callbacks[i];
    if (!cb) continue;
    try {
      await cb(reason);
    } catch {
      // Never let a cleanup failure block the rest.
    }
  }
}

function signalToNumber(sig: NodeJS.Signals): number {
  switch (sig) {
    case "SIGINT":
      return 2;
    case "SIGTERM":
      return 15;
    case "SIGHUP":
      return 1;
    case "SIGQUIT":
      return 3;
    default:
      return 0;
  }
}
