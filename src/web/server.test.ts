/**
 * SSE smoke test for src/web/server.ts. Mirrors web/stream.e2e.test.mjs in
 * spirit but exercises the in-process server directly (no spawn) so it stays
 * fast and deterministic.
 *
 * Coverage:
 *   1. initial `snapshot` arrives,
 *   2. initial `transcript` carries existing bytes from offset 0,
 *   3. appending bytes produces a delta whose `offset` == previous `size`,
 *   4. manifest edit produces a `progress` event with new status,
 *   5. POST /api/control writes the expected control file,
 *   6. validation: bad id/action -> 400, unknown route -> 404.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs, appendFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { get as httpGet, request as httpRequest } from "node:http";
import { startDashboardServer, type RunningServer } from "./server.js";

interface SseEvent {
  event: string;
  id: string | null;
  data: string;
  parsed: unknown;
}

function parseSseRecord(text: string): SseEvent {
  const out: SseEvent = { event: "", id: null, data: "", parsed: null };
  for (const line of text.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") out.event = value;
    else if (field === "id") out.id = value;
    else if (field === "data") out.data = value;
  }
  try {
    out.parsed = JSON.parse(out.data);
  } catch {
    out.parsed = null;
  }
  return out;
}

interface StreamConn {
  events: SseEvent[];
  waitFor(
    predicate: (e: SseEvent[]) => boolean,
    timeoutMs?: number,
    label?: string,
  ): Promise<SseEvent[]>;
  close(): void;
}

function openStream(port: number, watchId?: string): Promise<StreamConn> {
  const events: SseEvent[] = [];
  type Waiter = {
    predicate: (e: SseEvent[]) => boolean;
    resolve: (v: SseEvent[]) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  };
  const waiters: Waiter[] = [];
  let req: ReturnType<typeof httpGet> | null = null;
  return new Promise((resolve, reject) => {
    const p = watchId
      ? `/api/stream?watch=${encodeURIComponent(watchId)}`
      : "/api/stream";
    // Connect-phase guard: if the SSE response headers never arrive (an
    // intermittent localhost stall seen on Windows CI), fail fast so the test's
    // retry can re-attempt rather than hanging until the test timeout. Cleared
    // once the response arrives — the long-lived stream is never timed out.
    const connectTimer = setTimeout(() => {
      if (req && !req.destroyed) req.destroy(new Error("openStream: no SSE response within 8s"));
    }, 8000);
    req = httpGet(
      { host: "127.0.0.1", port, path: p, headers: { accept: "text/event-stream" } },
      (res) => {
        clearTimeout(connectTimer);
        let buf = "";
        res.on("data", (chunk) => {
          buf += String(chunk);
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const record = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (!record || record.startsWith(":")) continue;
            const ev = parseSseRecord(record);
            if (!ev.event) continue;
            events.push(ev);
            for (const w of [...waiters]) {
              if (w.predicate(events)) {
                clearTimeout(w.timer);
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(events);
              }
            }
          }
        });
        res.on("error", () => {});
        resolve({
          events,
          waitFor(predicate, timeoutMs = 4000, label = "predicate") {
            return new Promise((resolveW, rejectW) => {
              if (predicate(events)) return resolveW(events);
              const timer = setTimeout(() => {
                const idx = waiters.indexOf(entry);
                if (idx >= 0) waiters.splice(idx, 1);
                rejectW(
                  new Error(
                    `waitFor(${label}) timeout — saw ${events.length} events: ${events.map((e) => e.event).join(",")}`,
                  ),
                );
              }, timeoutMs);
              const entry: Waiter = { predicate, resolve: resolveW, reject: rejectW, timer };
              waiters.push(entry);
            });
          },
          close() {
            if (req && !req.destroyed) req.destroy();
          },
        });
      },
    );
    req.on("error", (e) => {
      clearTimeout(connectTimer);
      reject(e);
    });
  });
}

function postControl(
  port: number,
  id: string,
  action: string,
): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/api/control?id=${encodeURIComponent(id)}&action=${encodeURIComponent(action)}`,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({ code: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function getRaw(port: number, p: string): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port, path: p }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () =>
        resolve({ code: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
  });
}

const isSnapshot = (e: SseEvent): boolean => e.event === "snapshot";
const isProgress = (e: SseEvent): boolean => e.event === "progress";
const isTranscript = (e: SseEvent): boolean => e.event === "transcript";

describe("web server SSE + control + validation", () => {
  let root: string;
  let manifest: string;
  let roadmap: string;
  let webDir: string;
  let server: RunningServer;
  let port: number;
  const seedTranscript = "first line\nsecond line\n";
  const transcriptFile = (): string =>
    path.join(root, ".claudopilot", ".run", "phase-test.transcript.md");

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-web-"));
    roadmap = path.join(root, "roadmap");
    webDir = path.join(root, "web");
    await fs.mkdir(roadmap, { recursive: true });
    await fs.mkdir(webDir, { recursive: true });
    await fs.mkdir(path.join(root, ".claudopilot", ".run"), { recursive: true });

    manifest = path.join(roadmap, "EXECUTION-MANIFEST.md");
    await fs.writeFile(
      manifest,
      [
        "# Test",
        "",
        "**Status:** in-progress",
        "",
        "## Order",
        "",
        "1. [pending] **phase-test** — fixture phase (deps: none)",
        "",
      ].join("\n"),
    );
    await fs.writeFile(transcriptFile(), seedTranscript);
    // Minimal static asset so the static-serving branch is reachable.
    await fs.writeFile(path.join(webDir, "index.html"), "<!doctype html><title>x</title>");

    server = await startDashboardServer({
      repoRoot: root,
      manifestPath: manifest,
      roadmapDir: roadmap,
      webDir,
      port: 0,
      pollMs: 80,
    });
    port = server.address().port;
  });

  afterAll(async () => {
    if (server) await server.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // Opening a long-lived SSE connection to localhost intermittently stalls on
  // Windows CI runners (the response callback occasionally never fires) — a
  // known Node-on-Windows HTTP timing flake, not a server bug (the same code
  // passes on POSIX and in the Docker e2e). Retry to absorb the transient.
  it("emits snapshot + transcript on connect, then a delta on append", { retry: 3 }, async () => {
    const conn = await openStream(port, "phase-test");
    try {
      await conn.waitFor(
        (evs) => evs.some(isSnapshot) && evs.some(isTranscript),
        15000,
        "snapshot+transcript",
      );
      const snap = conn.events.find(isSnapshot)!;
      expect(snap.event).toBe("snapshot");
      const snapData = snap.parsed as { manifestStatus: string };
      expect(snapData.manifestStatus).toBe("in-progress");

      const t0 = conn.events.find(isTranscript)!;
      const t0d = t0.parsed as {
        id: string;
        offset: number;
        chunk: string;
        size: number;
        reset: boolean;
      };
      expect(t0d.id).toBe("phase-test");
      expect(t0d.offset).toBe(0);
      expect(t0d.chunk).toBe(seedTranscript);
      expect(t0d.size).toBe(Buffer.byteLength(seedTranscript));
      expect(t0d.reset).toBe(false);

      const appended = "third line — appended after connect\n";
      appendFileSync(transcriptFile(), appended);
      await conn.waitFor(
        (evs) => evs.filter(isTranscript).length >= 2,
        15000,
        "second transcript",
      );
      const t1 = conn.events.filter(isTranscript)[1]!;
      const t1d = t1.parsed as { offset: number; chunk: string; size: number };
      expect(t1d.offset).toBe(t0d.size);
      expect(t1d.chunk).toBe(appended);
      expect(t1d.size).toBe(Buffer.byteLength(seedTranscript + appended));
    } finally {
      conn.close();
    }
  });

  it("emits a progress event when the manifest changes", async () => {
    // Wait for snapshot, then mutate manifest and assert progress.
    const conn = await openStream(port, "phase-test");
    try {
      await conn.waitFor((evs) => evs.some(isSnapshot), 4000, "snapshot");
      writeFileSync(
        manifest,
        [
          "# Test",
          "",
          "**Status:** complete",
          "",
          "## Order",
          "",
          "1. [merged] **phase-test** — fixture phase (deps: none)",
          "",
        ].join("\n"),
      );
      await conn.waitFor((evs) => evs.some(isProgress), 6000, "progress");
      const prog = conn.events.find(isProgress)!;
      const data = prog.parsed as { manifestStatus: string };
      expect(data.manifestStatus).toBe("complete");
    } finally {
      conn.close();
    }
  });

  it("POST /api/control writes a control file the driver can pick up", async () => {
    const { code, body } = await postControl(port, "phase-test", "poke");
    expect(code).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ ok: true, id: "phase-test", action: "poke" });
    const f = path.join(root, ".claudopilot", ".run", "control", "phase-test.poke");
    const st = await fs.stat(f);
    expect(st.isFile()).toBe(true);
  });

  it("rejects bad control id/action with 400", async () => {
    const bad = await postControl(port, "../etc", "poke");
    expect(bad.code).toBe(400);
    const bad2 = await postControl(port, "phase-test", "delete");
    expect(bad2.code).toBe(400);
  });

  it("serves a static asset and 404s unknown paths", async () => {
    const ok = await getRaw(port, "/");
    expect(ok.code).toBe(200);
    expect(ok.body).toContain("<title>x</title>");

    const miss = await getRaw(port, "/does-not-exist");
    expect(miss.code).toBe(404);
  });
});
