// SSE event vocabulary for the dashboard live channel.
//
// Shared by the server endpoint (phase-02) and the browser consumer (phase-03);
// pure module — no node:http, no DOM, no I/O — so it imports cleanly into both
// environments and is unit-testable in Node.
//
// Transcript-delta payload shape (data: of an EV.TRANSCRIPT record):
//   {
//     id:     <string>  agent id the chunk belongs to,
//     offset: <number>  byte position the chunk starts at in the transcript file,
//     size:   <number>  new total file size after this chunk,
//     chunk:  <string>  the appended bytes (utf-8 text),
//     reset:  <boolean> true when the file shrank/rotated and the client must
//                       clear its buffer before appending `chunk`.
//   }
// Mirrors the response shape of the legacy GET /api/transcript so existing
// readTail() output drops in unchanged.

export const EV = Object.freeze({
  SNAPSHOT: "snapshot",
  PROGRESS: "progress",
  TRANSCRIPT: "transcript",
  ERROR: "error",
});

export const STREAM_PATH = "/api/stream";

export const HEARTBEAT_MS = 15000;

export function streamUrl(id) {
  if (id === undefined || id === null || id === "") return STREAM_PATH;
  return `${STREAM_PATH}?watch=${encodeURIComponent(id)}`;
}

export function encodeEvent({ event, id, data }) {
  let out = `event: ${event}\n`;
  if (id !== undefined && id !== null && id !== "") {
    out += `id: ${id}\n`;
  }
  out += `data: ${JSON.stringify(data)}\n\n`;
  return out;
}

export function encodeComment(text) {
  return `: ${text}\n\n`;
}
