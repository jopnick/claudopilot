/**
 * Localhost web dashboard server — SSE channel, control writer, static files.
 *
 * Ports `web-server.mjs` to TS. Same wire protocol (the browser client and
 * the existing `web/events.mjs` vocabulary), same control-file contract,
 * same byte-offset transcript tailing. The one substantive change: we build
 * the snapshot in-process via `progress/model.ts` instead of shelling out
 * to `progress.mjs`, eliminating the per-tick child fork.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { buildSnapshot } from "../progress/model.js";
import { runDir, cloneCapturePath, mainCapturePath } from "../platform/paths.js";
import type { ProgressSnapshot } from "../types.js";

// SSE wire vocabulary — must stay byte-identical with `web/events.mjs` (the
// browser-side consumer). Re-declared here because `web/events.mjs` is a
// plain `.mjs` outside `src/` and tsconfig doesn't pick it up; the constants
// are frozen on both sides so divergence would show up immediately as a
// failing browser/server contract test, not as silent drift.
const EV = {
  SNAPSHOT: "snapshot",
  PROGRESS: "progress",
  TRANSCRIPT: "transcript",
  ERROR: "error",
} as const;
const STREAM_PATH = "/api/stream";
const HEARTBEAT_MS = 15000;

interface EncodeEventInput {
  event: string;
  id?: string | number | null;
  data: unknown;
}
function encodeEvent({ event, id, data }: EncodeEventInput): string {
  let out = `event: ${event}\n`;
  if (id !== undefined && id !== null && id !== "") {
    out += `id: ${id}\n`;
  }
  out += `data: ${JSON.stringify(data)}\n\n`;
  return out;
}
function encodeComment(text: string): string {
  return `: ${text}\n\n`;
}

export interface StartServerOptions {
  /** Repo root (where .claudopilot/ lives). */
  repoRoot: string;
  /** Absolute path to the manifest file. */
  manifestPath: string;
  /** Absolute path to the roadmap directory. */
  roadmapDir: string;
  /** Directory holding the browser assets (index.html, app.mjs, …). */
  webDir: string;
  port?: number;
  /** Bind host. Default "127.0.0.1". */
  host?: string;
  /** Polling interval for change detection on the SSE channel. Default 500ms. */
  pollMs?: number;
}

export interface RunningServer {
  server: Server;
  address(): { host: string; port: number };
  close(): Promise<void>;
}

const ID_RE = /^[A-Za-z0-9._-]+$/;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

function staticMap(webDir: string): Record<string, string> {
  return {
    "/": path.join(webDir, "index.html"),
    "/index.html": path.join(webDir, "index.html"),
    "/app.mjs": path.join(webDir, "app.mjs"),
    "/events.mjs": path.join(webDir, "events.mjs"),
    "/transcript.mjs": path.join(webDir, "transcript.mjs"),
    "/styles.css": path.join(webDir, "styles.css"),
    "/lit-html.js": path.join(webDir, "vendor", "lit-html.js"),
  };
}

function transcriptPath(repoRoot: string, id: string): string | null {
  const clone = cloneCapturePath(repoRoot, id, `${id}.transcript.md`);
  const main = mainCapturePath(repoRoot, id, `${id}.transcript.md`);
  if (existsSync(clone)) return clone;
  if (existsSync(main)) return main;
  return null;
}

function readTail(p: string, offset: number): { size: number; chunk: string } {
  const size = statSync(p).size;
  if (offset >= size) return { size, chunk: "" };
  const fd = openSync(p, "r");
  try {
    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, offset);
    return { size, chunk: buf.toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

function sendJson(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function snapshotBody(opts: StartServerOptions): {
  body: string;
  model: ProgressSnapshot;
} {
  const model = buildSnapshot({
    repoRoot: opts.repoRoot,
    manifestPath: opts.manifestPath,
    roadmapDir: opts.roadmapDir,
  });
  return { body: JSON.stringify(model), model };
}

export function createDashboardServer(opts: StartServerOptions): Server {
  const STATIC = staticMap(opts.webDir);
  const POLL_MS = opts.pollMs ?? 500;

  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    const reqPath = url.pathname;

    // POST /api/control — drop a control file the driver picks up next pass.
    if (req.method === "POST" && reqPath === "/api/control") {
      const id = url.searchParams.get("id") ?? "";
      const action = url.searchParams.get("action") ?? "";
      if (!ID_RE.test(id) || !["poke", "retry"].includes(action)) {
        sendJson(res, 400, JSON.stringify({ error: "invalid id or action" }));
        return;
      }
      try {
        const dir = path.join(runDir(opts.repoRoot), "control");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, `${id}.${action}`), "");
        sendJson(res, 200, JSON.stringify({ ok: true, id, action }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, JSON.stringify({ error: msg }));
      }
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405).end("method not allowed");
      return;
    }

    if (reqPath === STREAM_PATH) {
      const watch = url.searchParams.get("watch") ?? "";
      if (watch && !ID_RE.test(watch)) {
        sendJson(res, 400, JSON.stringify({ error: "invalid watch id" }));
        return;
      }
      handleStream(req, res, opts, watch, POLL_MS);
      return;
    }

    const file = STATIC[reqPath];
    if (file && existsSync(file)) {
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      createReadStream(file).pipe(res);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });

  return server;
}

function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StartServerOptions,
  watch: string,
  pollMs: number,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const safeWrite = (s: string): boolean => {
    if (res.writableEnded || res.destroyed) return false;
    try {
      return res.write(s);
    } catch {
      return false;
    }
  };

  let { body: lastProgressBody, model: snapModel } = snapshotBody(opts);
  safeWrite(encodeEvent({ event: EV.SNAPSHOT, data: snapModel }));

  let lastOffset = 0;
  if (watch) {
    const tp0 = transcriptPath(opts.repoRoot, watch);
    if (tp0) {
      try {
        const { size, chunk } = readTail(tp0, 0);
        if (chunk) {
          safeWrite(
            encodeEvent({
              event: EV.TRANSCRIPT,
              data: { id: watch, offset: 0, size, chunk, reset: false },
            }),
          );
        }
        lastOffset = size;
      } catch {
        // transient — watcher retries
      }
    }
  }

  // One debounced server-side watcher per connection (mirrors web-server.mjs).
  let pending = false;
  let inflight = false;
  const tickProgress = (): void => {
    if (inflight) {
      pending = true;
      return;
    }
    inflight = true;
    try {
      do {
        pending = false;
        const { body, model } = snapshotBody(opts);
        if (body !== lastProgressBody) {
          lastProgressBody = body;
          safeWrite(encodeEvent({ event: EV.PROGRESS, data: model }));
        }
      } while (pending);
    } finally {
      inflight = false;
    }
  };

  const tickTranscript = (): void => {
    if (!watch) return;
    const tp = transcriptPath(opts.repoRoot, watch);
    if (!tp) return;
    try {
      const cur = statSync(tp).size;
      let reset = false;
      if (cur < lastOffset) {
        lastOffset = 0;
        reset = true;
      }
      if (cur > lastOffset || reset) {
        const { size, chunk } = readTail(tp, lastOffset);
        if (chunk || reset) {
          safeWrite(
            encodeEvent({
              event: EV.TRANSCRIPT,
              data: { id: watch, offset: lastOffset, size, chunk, reset },
            }),
          );
        }
        lastOffset = size;
      }
    } catch {
      // file may briefly disappear during rotation; retry next tick
    }
  };

  const poller = setInterval(() => {
    tickProgress();
    tickTranscript();
  }, pollMs);

  const heartbeat = setInterval(() => {
    safeWrite(encodeComment("hb"));
  }, HEARTBEAT_MS);

  const teardown = (): void => {
    clearInterval(poller);
    clearInterval(heartbeat);
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // already torn down
      }
    }
  };
  req.on("close", teardown);
  res.on("close", teardown);
  res.on("error", teardown);
}

export async function startDashboardServer(
  opts: StartServerOptions,
): Promise<RunningServer> {
  const server = createDashboardServer(opts);
  const port = opts.port ?? 4317;
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const addr = server.address();
  const bound =
    typeof addr === "object" && addr
      ? { host: addr.address, port: addr.port }
      : { host, port };
  return {
    server,
    address(): { host: string; port: number } {
      return bound;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
