#!/usr/bin/env node
//
// claudopilot/web-server.mjs — tiny localhost web dashboard for a run-loop.sh run.
//
// Read-only. Serves a lit-html single-page app and two JSON/text endpoints backed
// by the same artifacts the CLI uses:
//   GET /api/progress            -> `node progress.mjs --json` (the snapshot model)
//   GET /api/transcript?id=<id>  -> that agent's rendered transcript (thought stream)
//                                   optional &offset=<bytes> for a cheap incremental tail
//
// Binds to 127.0.0.1 only. Usage:
//   node claudopilot/web-server.mjs [--port 4317] [--manifest <path>]
//   PORT=4317 node claudopilot/web-server.mjs

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, statSync, openSync, readSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { EV, STREAM_PATH, encodeEvent } from "./web/events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, ".."); // mirrors progress.mjs: engine sits at <repo>/claudopilot/
const WEB_DIR = join(HERE, "web");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const PORT = Number(valOf("--port") || process.env.PORT || 4317);
// Bind address. Defaults to loopback. The Docker default-mode launcher sets
// 0.0.0.0 so docker's published port can reach it (still loopback-only on the host
// via -p 127.0.0.1:PORT:PORT).
const HOST = valOf("--host") || process.env.CLAUDOPILOT_WEB_HOST || "127.0.0.1";
const MANIFEST = valOf("--manifest") || process.env.MANIFEST; // else progress.mjs's default

// ── /api/progress ─ shell out to progress.mjs so the web view matches the CLI ─
function getProgress() {
  return new Promise((res) => {
    const args = [join(HERE, "progress.mjs"), "--json"];
    if (MANIFEST) args.push("--manifest", MANIFEST);
    execFile(
      process.execPath,
      args,
      { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        if (err && !stdout) {
          res({ ok: false, body: JSON.stringify({ error: String(err.message || err) }) });
        } else {
          res({ ok: true, body: stdout });
        }
      },
    );
  });
}

// ── /api/transcript ─ the rendered "thought stream" for one agent ─────────────
const ID_RE = /^[A-Za-z0-9._-]+$/;
function transcriptPath(id) {
  const clone = join(REPO_ROOT, ".claudopilot", "worktrees", id, ".claudopilot", `${id}.transcript.md`);
  const main = join(REPO_ROOT, ".claudopilot", `${id}.transcript.md`);
  if (existsSync(clone)) return clone;
  if (existsSync(main)) return main;
  return null;
}

function readTail(path, offset) {
  const size = statSync(path).size;
  if (offset >= size) return { size, chunk: "" }; // nothing new (or file shrank → caller resets)
  const fd = openSync(path, "r");
  try {
    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, offset);
    return { size, chunk: buf.toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

// ── static files (whitelisted; no traversal) ──────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};
// public path -> file on disk
const STATIC = {
  "/": join(WEB_DIR, "index.html"),
  "/index.html": join(WEB_DIR, "index.html"),
  "/app.mjs": join(WEB_DIR, "app.mjs"),
  "/transcript.mjs": join(WEB_DIR, "transcript.mjs"),
  "/styles.css": join(WEB_DIR, "styles.css"),
  "/lit-html.js": join(WEB_DIR, "vendor", "lit-html.js"),
};

function sendJson(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  const path = url.pathname;

  // ── /api/control ─ request a driver action (POST). The driver owns workers and
  // the manifest, so we only DROP a control file; run-loop.sh applies it next pass.
  //   POST /api/control?id=<phase>&action=poke   — kill+relaunch a hung running worker
  //   POST /api/control?id=<phase>&action=retry  — re-pend a [blocked] phase
  if (req.method === "POST" && path === "/api/control") {
    const id = url.searchParams.get("id") || "";
    const action = url.searchParams.get("action") || "";
    if (!ID_RE.test(id) || !["poke", "retry"].includes(action)) {
      sendJson(res, 400, JSON.stringify({ error: "invalid id or action" }));
      return;
    }
    try {
      const dir = join(REPO_ROOT, ".claudopilot", "control");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.${action}`), "");
      sendJson(res, 200, JSON.stringify({ ok: true, id, action }));
    } catch (e) {
      sendJson(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  if (path === "/api/progress") {
    const { body } = await getProgress();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return;
  }

  if (path === STREAM_PATH) {
    const watch = url.searchParams.get("watch") || "";
    if (!ID_RE.test(watch)) {
      sendJson(res, 400, JSON.stringify({ error: "invalid watch id" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const safeWrite = (s) => {
      if (res.writableEnded || res.destroyed) return false;
      try {
        return res.write(s);
      } catch {
        return false;
      }
    };

    const { body: snapBody } = await getProgress();
    let snapModel;
    try {
      snapModel = JSON.parse(snapBody);
    } catch {
      snapModel = { error: "progress parse failed" };
    }
    safeWrite(encodeEvent({ event: EV.SNAPSHOT, data: snapModel }));

    const tp0 = transcriptPath(watch);
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
      } catch {
        // tolerate transient read errors; the watcher will retry
      }
    }

    req.on("close", () => {
      if (!res.writableEnded) res.end();
    });
    return;
  }

  if (path === "/api/transcript") {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) {
      sendJson(res, 400, JSON.stringify({ error: "invalid id" }));
      return;
    }
    const tp = transcriptPath(id);
    if (!tp) {
      sendJson(res, 200, JSON.stringify({ exists: false, size: 0, chunk: "" }));
      return;
    }
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) | 0);
    try {
      const { size, chunk } = readTail(tp, offset);
      sendJson(res, 200, JSON.stringify({ exists: true, size, chunk, reset: offset > size }));
    } catch (e) {
      sendJson(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  // static
  const file = STATIC[path];
  if (file && existsSync(file)) {
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  const where = MANIFEST ? ` (manifest: ${MANIFEST})` : "";
  process.stdout.write(`claudopilot dashboard → http://${shown}:${PORT}${where}\n`);
  process.stdout.write(`  serving run artifacts under ${REPO_ROOT}\n  Ctrl-C to stop.\n`);
});
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    process.stderr.write(`web-server: port ${PORT} is in use — pass --port <n> to choose another.\n`);
    process.exit(1);
  }
  throw e;
});
