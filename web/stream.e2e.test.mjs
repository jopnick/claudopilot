// End-to-end smoke test for the SSE channel.
//
// Spawns the real web-server.mjs against a temp fixture (a parallel
// {claudopilot/, roadmap/, .claudopilot/} tree), opens /api/stream with a raw
// http.get, and asserts:
//   1. an initial `snapshot` arrives,
//   2. an initial `transcript` carries the existing file bytes from offset 0,
//   3. appending bytes to the transcript fixture produces a `transcript` event
//      whose `offset` equals the previous `size` and whose `chunk` is *only*
//      the appended bytes,
//   4. editing the manifest fixture produces a `progress` event whose payload
//      reflects the change,
//   5. dropping and reopening the connection yields a fresh `snapshot`.
//
// The fixture layout mirrors how claudopilot is installed in a host repo:
// web-server.mjs at <fixture>/claudopilot/web-server.mjs makes REPO_ROOT
// resolve to <fixture>, which is where the manifest and .claudopilot/ live.
// We copy the three source files we actually need (not symlink) so Node's
// import.meta.url points at the fixture path rather than back to /work.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { get as httpGet } from "node:http";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE); // /work — the source web-server.mjs lives here

// Minimal SSE record parser — same shape used by web/events.test.mjs.
function parseSseRecord(text) {
  const out = { event: null, id: null, data: null };
  for (const line of text.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") out.event = value;
    else if (field === "id") out.id = value;
    else if (field === "data") out.data = value;
  }
  return out;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "cp-sse-"));
  const cp = join(root, "claudopilot");
  mkdirSync(join(cp, "web"), { recursive: true });
  mkdirSync(join(root, "roadmap"), { recursive: true });
  mkdirSync(join(root, ".claudopilot"), { recursive: true });
  copyFileSync(join(REPO, "web-server.mjs"), join(cp, "web-server.mjs"));
  copyFileSync(join(REPO, "progress.mjs"), join(cp, "progress.mjs"));
  copyFileSync(join(REPO, "web", "events.mjs"), join(cp, "web", "events.mjs"));
  return { root, cp };
}

function manifestBody(status) {
  return `# Test manifest
**Status:** ${status}

## Order

1. [pending] **phase-test** — fixture phase (deps: none)
`;
}

async function startServer({ cp, manifest, port }) {
  const child = spawn(
    process.execPath,
    [join(cp, "web-server.mjs"), "--port", String(port), "--manifest", manifest],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server start timeout")), 5000);
    const onData = (buf) => {
      if (String(buf).includes("dashboard")) {
        clearTimeout(t);
        child.stdout.removeListener("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`server exited early (code ${code})`));
    });
  });
  return child;
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000);
  });
}

// A live SSE connection — accumulates parsed events on `events`, lets the test
// `waitFor(predicate)` against the running buffer. We hold one of these open
// across multiple assertions so that successive transcript events are real
// deltas relative to each other (a fresh connect would just replay the whole
// file as the initial transcript and we'd never see the delta-on-append path).
function openStream(port, watchId) {
  const conn = {
    events: [],
    req: null,
    res: null,
    _waiters: [],
    waitFor(predicate, timeoutMs = 4000, label = "predicate") {
      return new Promise((resolve, reject) => {
        if (predicate(this.events)) return resolve(this.events);
        const t = setTimeout(() => {
          this._waiters = this._waiters.filter((w) => w !== entry);
          reject(
            new Error(
              `waitFor(${label}) timeout — saw ${this.events.length} events: ` +
                this.events.map((e) => e.event).join(","),
            ),
          );
        }, timeoutMs);
        const entry = { predicate, resolve, reject, timer: t };
        this._waiters.push(entry);
      });
    },
    close() {
      if (this.req && !this.req.destroyed) this.req.destroy();
    },
  };
  return new Promise((resolve, reject) => {
    const path = watchId
      ? `/api/stream?watch=${encodeURIComponent(watchId)}`
      : "/api/stream";
    const req = httpGet(
      { host: "127.0.0.1", port, path, headers: { accept: "text/event-stream" } },
      (res) => {
        conn.req = req;
        conn.res = res;
        let buf = "";
        res.on("data", (chunk) => {
          buf += String(chunk);
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const record = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (!record || record.startsWith(":")) continue;
            const ev = parseSseRecord(record);
            if (!ev.event) continue;
            try {
              ev.parsed = JSON.parse(ev.data);
            } catch {
              ev.parsed = null;
            }
            conn.events.push(ev);
            for (const w of [...conn._waiters]) {
              if (w.predicate(conn.events)) {
                clearTimeout(w.timer);
                conn._waiters = conn._waiters.filter((x) => x !== w);
                w.resolve(conn.events);
              }
            }
          }
        });
        res.on("error", () => {});
        resolve(conn);
      },
    );
    req.on("error", reject);
  });
}

const isTranscript = (e) => e.event === "transcript";
const isProgress = (e) => e.event === "progress";
const isSnapshot = (e) => e.event === "snapshot";

test("SSE stream: snapshot, transcript delta, progress delta, and reconnect resync", async (t) => {
  const { root, cp } = buildFixture();
  const port = await findFreePort();
  const manifest = join(root, "roadmap", "EXECUTION-MANIFEST.md");
  const transcriptPath = join(root, ".claudopilot", "phase-test.transcript.md");

  writeFileSync(manifest, manifestBody("in-progress"));
  const seed = "first line\nsecond line\n";
  writeFileSync(transcriptPath, seed);

  const child = await startServer({ cp, manifest, port });
  let conn1, conn2;
  t.after(async () => {
    if (conn1) conn1.close();
    if (conn2) conn2.close();
    await stopServer(child);
    rmSync(root, { recursive: true, force: true });
  });

  // Single long-lived connection — successive transcript events must be deltas
  // relative to each other, which only works if we don't re-handshake.
  conn1 = await openStream(port, "phase-test");

  // ── 1. initial snapshot + initial transcript (from offset 0) ────────────
  await conn1.waitFor(
    (evs) => evs.some(isSnapshot) && evs.some(isTranscript),
    4000,
    "snapshot+transcript",
  );
  const snap = conn1.events.find(isSnapshot);
  assert.equal(snap.event, "snapshot", "first record is a snapshot");
  assert.ok(snap.parsed && typeof snap.parsed === "object", "snapshot is JSON");
  assert.equal(
    snap.parsed.manifestStatus,
    "in-progress",
    "snapshot reflects fixture manifest status",
  );
  const t0 = conn1.events.find(isTranscript);
  assert.equal(t0.parsed.id, "phase-test");
  assert.equal(t0.parsed.offset, 0, "initial transcript starts at offset 0");
  assert.equal(t0.parsed.chunk, seed, "initial transcript carries existing bytes");
  assert.equal(t0.parsed.size, Buffer.byteLength(seed));
  assert.equal(t0.parsed.reset, false);

  // ── 2. append → transcript delta with offset == previous size ──────────
  const appended = "third line — appended after connect\n";
  appendFileSync(transcriptPath, appended);
  await conn1.waitFor(
    (evs) => evs.filter(isTranscript).length >= 2,
    4000,
    "second transcript",
  );
  const t1 = conn1.events.filter(isTranscript)[1];
  assert.equal(
    t1.parsed.offset,
    t0.parsed.size,
    "delta offset picks up where the previous size left off",
  );
  assert.equal(t1.parsed.chunk, appended, "delta carries only the appended bytes");
  assert.equal(
    t1.parsed.size,
    Buffer.byteLength(seed + appended),
    "delta size reflects new total file size",
  );
  assert.equal(t1.parsed.reset, false);

  // ── 3. manifest edit → progress event ───────────────────────────────────
  writeFileSync(manifest, manifestBody("complete"));
  await conn1.waitFor((evs) => evs.some(isProgress), 6000, "progress");
  const prog = conn1.events.find(isProgress);
  assert.equal(prog.parsed.manifestStatus, "complete", "progress shows new status");

  // ── 4. reconnect → fresh snapshot replays the current state ────────────
  conn1.close();
  conn2 = await openStream(port, "phase-test");
  await conn2.waitFor((evs) => evs.some(isSnapshot), 4000, "reconnect snapshot");
  const snap2 = conn2.events.find(isSnapshot);
  assert.equal(snap2.event, "snapshot", "reconnect emits a fresh snapshot");
  assert.equal(
    snap2.parsed.manifestStatus,
    "complete",
    "fresh snapshot carries post-edit state",
  );
});

