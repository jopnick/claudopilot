import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EV,
  STREAM_PATH,
  HEARTBEAT_MS,
  streamUrl,
  encodeEvent,
  encodeComment,
} from "./events.mjs";

test("EV constants cover the four event names", () => {
  assert.equal(EV.SNAPSHOT, "snapshot");
  assert.equal(EV.PROGRESS, "progress");
  assert.equal(EV.TRANSCRIPT, "transcript");
  assert.equal(EV.ERROR, "error");
});

test("STREAM_PATH and HEARTBEAT_MS have expected values", () => {
  assert.equal(STREAM_PATH, "/api/stream");
  assert.equal(HEARTBEAT_MS, 15000);
});

test("encodeEvent emits a well-formed SSE record ending in a blank line", () => {
  const out = encodeEvent({ event: EV.PROGRESS, data: { a: 1 } });
  assert.equal(out, 'event: progress\ndata: {"a":1}\n\n');
});

test("encodeEvent includes id line only when id is passed", () => {
  const withoutId = encodeEvent({ event: EV.SNAPSHOT, data: {} });
  assert.ok(!withoutId.includes("id:"), "no id line when id omitted");

  const empty = encodeEvent({ event: EV.SNAPSHOT, id: "", data: {} });
  assert.ok(!empty.includes("id:"), "no id line when id is empty string");

  const withId = encodeEvent({ event: EV.PROGRESS, id: "42", data: { x: true } });
  assert.equal(withId, 'event: progress\nid: 42\ndata: {"x":true}\n\n');
});

test("encodeEvent serializes the transcript-delta payload shape", () => {
  const delta = {
    id: "agent-7",
    offset: 1024,
    size: 1048,
    chunk: "hello",
    reset: false,
  };
  const out = encodeEvent({ event: EV.TRANSCRIPT, data: delta });
  const dataLine = out.split("\n").find((l) => l.startsWith("data: "));
  assert.ok(dataLine, "has data line");
  const parsed = JSON.parse(dataLine.slice("data: ".length));
  assert.deepEqual(parsed, delta);
  assert.ok(out.endsWith("\n\n"), "terminated by blank line");
});

test("encodeComment emits a colon-prefixed line terminated by a blank line", () => {
  assert.equal(encodeComment("ping"), ": ping\n\n");
});

test("streamUrl round-trips ids with special characters via encodeURIComponent", () => {
  assert.equal(streamUrl("simple"), "/api/stream?watch=simple");

  const tricky = "phase 01/my-id?&=#";
  const url = streamUrl(tricky);
  assert.equal(url, `/api/stream?watch=${encodeURIComponent(tricky)}`);

  const params = new URLSearchParams(url.split("?")[1]);
  assert.equal(params.get("watch"), tricky);
});

test("streamUrl returns the bare path when id is missing or empty", () => {
  assert.equal(streamUrl(), "/api/stream");
  assert.equal(streamUrl(""), "/api/stream");
  assert.equal(streamUrl(null), "/api/stream");
  assert.equal(streamUrl(undefined), "/api/stream");
});

// Minimal SSE parser — mirrors what a browser EventSource does for one record.
// Splits on blank-line boundaries and pulls out event/id/data fields. Used by
// the round-trip tests below and by the e2e smoke test.
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

test("encodeEvent → parser round-trips the transcript delta payload", () => {
  const delta = {
    id: "phase-02",
    offset: 4096,
    size: 4196,
    chunk: "appended bytes\nwith a newline\n",
    reset: false,
  };
  const wire = encodeEvent({ event: EV.TRANSCRIPT, id: "42", data: delta });
  const rec = parseSseRecord(wire);
  assert.equal(rec.event, "transcript");
  assert.equal(rec.id, "42");
  assert.deepEqual(JSON.parse(rec.data), delta);
});

test("encodeEvent → parser round-trips a reset (file-rotated) delta", () => {
  const delta = { id: "phase-03", offset: 0, size: 12, chunk: "fresh start\n", reset: true };
  const rec = parseSseRecord(encodeEvent({ event: EV.TRANSCRIPT, data: delta }));
  assert.equal(rec.event, "transcript");
  assert.equal(rec.id, null);
  assert.deepEqual(JSON.parse(rec.data), delta);
});

test("encodeEvent frames each record with a single blank-line separator", () => {
  // Three records concatenated as the server would stream them; splitting on the
  // double-newline boundary must yield exactly three non-empty chunks.
  const wire =
    encodeEvent({ event: EV.SNAPSHOT, data: { ok: 1 } }) +
    encodeEvent({ event: EV.PROGRESS, data: { ok: 2 } }) +
    encodeEvent({ event: EV.TRANSCRIPT, data: { ok: 3 } });
  const records = wire.split("\n\n").filter((s) => s.length);
  assert.equal(records.length, 3);
  assert.equal(parseSseRecord(records[0]).event, "snapshot");
  assert.equal(parseSseRecord(records[1]).event, "progress");
  assert.equal(parseSseRecord(records[2]).event, "transcript");
});

test("streamUrl output is decoded by URLSearchParams without loss", () => {
  // Exercises the contract from the consumer's side: the server only sees the
  // post-decode `watch` value, so anything we put in here must come back equal.
  for (const id of ["plain", "with space", "slash/and?amp&hash#x", "unicode-✓"]) {
    const url = streamUrl(id);
    const params = new URLSearchParams(url.split("?")[1]);
    assert.equal(params.get("watch"), id);
  }
});
