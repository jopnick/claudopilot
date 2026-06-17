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
