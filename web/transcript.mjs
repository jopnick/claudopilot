// Parse a render-stream.mjs transcript into typed blocks for display.
// Pure (no DOM) so it can be unit-tested in Node. Markers produced by
// render-stream.mjs: "=== … ===" dividers, "[thinking]" / "[assistant]" /
// "[user]" labels, "-> tool: <name>", and "<- result:" / "<- result (error):".

export function dedent(lines) {
  const nonEmpty = lines.filter((l) => l.trim());
  const min = nonEmpty.reduce((m, l) => Math.min(m, l.match(/^ */)[0].length), Infinity);
  const n = Number.isFinite(min) ? min : 0;
  return lines.map((l) => l.slice(n)).join("\n").replace(/\s+$/, "");
}

export function parseTranscript(raw) {
  const lines = String(raw).split("\n");
  const blocks = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    cur.body = dedent(cur.bodyLines);
    delete cur.bodyLines;
    blocks.push(cur);
    cur = null;
  };
  for (const line of lines) {
    const divider = /^=== .* ===\s*$/.test(line);
    const tool = line.match(/^-> tool:\s*(.+)$/);
    const result = line.match(/^<- result(\s*\(error\))?:\s*$/);
    if (divider) {
      flush();
      blocks.push({ kind: "divider", body: line.replace(/^=== | ===$/g, "").trim() });
    } else if (line === "[thinking]") {
      flush();
      cur = { kind: "thinking", bodyLines: [] };
    } else if (line === "[assistant]") {
      flush();
      cur = { kind: "assistant", bodyLines: [] };
    } else if (line === "[user]") {
      flush();
      cur = { kind: "user", bodyLines: [] };
    } else if (tool) {
      flush();
      cur = { kind: "tool", name: tool[1].trim(), bodyLines: [] };
    } else if (result) {
      flush();
      cur = { kind: "result", error: Boolean(result[1]), bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  flush();
  return blocks;
}
