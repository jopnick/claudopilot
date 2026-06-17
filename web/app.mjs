// claudopilot dashboard — lit-html SPA.
// Subscribes to /api/stream (SSE) for snapshot/progress/transcript deltas and
// re-renders on each push. No client-side polling.

import { html, render, nothing } from "/lit-html.js";
import { parseTranscript } from "/transcript.mjs";
import { EV, streamUrl } from "/events.mjs";

const TICK_MS = 1000; // refresh the "time on step" timers between pushes

// Compact elapsed: 9s · 4m12s · 1h03m. Mirrors fmtDur in progress.mjs.
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}
// `since` is the stream file's mtime (ms); elapsed ticks live, client-side.
const fmtElapsed = (since) => (since ? fmtDur(Date.now() - since) : "");
// Compact token count: 920 · 12.3k · 1.2M. Mirrors fmtTokens in progress.mjs.
function fmtTokens(n) {
  if (n == null) return "";
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ── state ─────────────────────────────────────────────────────────────────
const state = {
  model: null, // last server-pushed progress snapshot
  error: null,
  selectedId: null,
  connected: false, // EventSource lifecycle: true between onopen and onerror
  // transcript accumulator for the selected agent
  t: { id: null, raw: "", offset: 0, exists: false },
  autoFollow: true,
};

const $header = document.getElementById("header");
const $agents = document.getElementById("agents");
const $detail = document.getElementById("detail");

// ── live subscription ─────────────────────────────────────────────────────
// One EventSource per page; reopened when the selected agent changes (so the
// server tails the new transcript).
let es = null;
function unsubscribe() {
  if (es) {
    es.close();
    es = null;
  }
}

// `snapshot` and `progress` carry the same full model shape; `snapshot` is
// just the first push / a post-reconnect resync. Same handler for both.
function onModel(ev) {
  state.model = JSON.parse(ev.data);
  state.error = null;
  renderAll();
}

function onTranscript(ev) {
  const d = JSON.parse(ev.data);
  if (d.id !== state.selectedId) return; // chunk for a different agent
  if (state.t.id !== d.id) state.t = { id: d.id, raw: "", offset: 0, exists: false };
  if (d.reset) state.t = { id: d.id, raw: "", offset: 0, exists: false };
  state.t.exists = true;
  if (d.chunk) state.t.raw += d.chunk;
  if (typeof d.size === "number") state.t.offset = d.size;
  renderDetail();
}

function subscribe(id) {
  unsubscribe();
  es = new EventSource(streamUrl(id));
  es.onopen = () => {
    state.connected = true;
    state.error = null;
    renderHeader();
  };
  // EventSource auto-reconnects on its own; the server resends `snapshot`
  // after the new connection opens, so no manual resync is needed here.
  es.onerror = () => {
    state.connected = false;
    renderHeader();
  };
  es.addEventListener(EV.SNAPSHOT, onModel);
  es.addEventListener(EV.PROGRESS, onModel);
  es.addEventListener(EV.TRANSCRIPT, onTranscript);
}

// ── views ─────────────────────────────────────────────────────────────────
function summaryBar(m) {
  const s = m.summary;
  return html`
    <div class="summary">
      <span>phases <b>${s.merged}/${s.total}</b> merged</span>
      <span class="sep">·</span>
      <span>slices <b>${s.slicesDone}/${s.slicesTotal}</b></span>
      <span class="sep">·</span>
      <span>${s.pctPhases}% phases / ${s.pctSlices}% slices</span>
      ${s.running ? html`<span class="pill running">${s.running} running</span>` : nothing}
      ${s.blocked ? html`<span class="pill blocked">${s.blocked} blocked</span>` : nothing}
      ${s.failed ? html`<span class="pill failed">${s.failed} failed</span>` : nothing}
      <span class="sep">·</span>
      <span>container: ${m.container}</span>
      ${connStatus()}
    </div>
  `;
}

function connStatus() {
  const offline = !state.connected;
  return html`<span class="conn ${offline ? "stale" : ""}">${
    state.error ? `⚠ ${state.error}` : offline ? "reconnecting…" : "live"
  }</span>`;
}

function renderHeader() {
  const m = state.model;
  render(
    html`
      <div class="title">
        claudopilot
        ${m ? html`<span class="status">${m.manifest} (${m.manifestStatus})</span>` : nothing}
      </div>
      ${m ? summaryBar(m) : html`<div class="summary">${connStatus()}</div>`}
      ${m && m.lastDriverEvent ? html`<div class="driver">${m.lastDriverEvent}</div>` : nothing}
    `,
    $header,
  );
}

function agentCard(p, i) {
  const pct = p.slicesTotal ? Math.round((100 * p.slicesDone) / p.slicesTotal) : 0;
  return html`
    <div
      class="card ${p.id === state.selectedId ? "selected" : ""}"
      @click=${() => selectAgent(p.id)}
    >
      <div class="row1">
        <span class="dot ${p.state}"></span>
        <span class="id">${p.id}</span>
        <span class="state state-${p.state}">${p.state}</span>
      </div>
      ${p.title ? html`<div class="title">${p.title}</div>` : nothing}
      ${p.slicesTotal
        ? html`<div class="meta">${p.slicesDone}/${p.slicesTotal} slices</div>
            <div class="bar"><i style="width:${pct}%"></i></div>`
        : nothing}
      ${p.deps && p.deps.length ? html`<div class="deps">deps: ${p.deps.join(", ")}</div>` : nothing}
      ${p.state === "running" && p.step
        ? html`<div class="now">
            <span class="now-label">${p.step.label}</span>
            ${p.step.detail ? html`<span class="now-detail">${p.step.detail}</span>` : nothing}
            <span class="now-elapsed">${fmtElapsed(p.step.since)}</span>
            ${p.step.tokens != null
              ? html`<span class="now-tokens">${fmtTokens(p.step.tokens)} tok</span>`
              : nothing}
          </div>`
        : p.state === "running" && p.activity
          ? html`<div class="now"><span class="now-detail">${p.activity}</span></div>`
          : nothing}
      ${p.state === "running" || p.state === "blocked"
        ? html`<div class="actions">
            ${p.state === "running"
              ? html`<button class="act" title="Kill this worker and relaunch it (for a hung phase)"
                  @click=${(e) => act(e, p.id, "poke")}>poke</button>`
              : nothing}
            ${p.state === "blocked"
              ? html`<button class="act" title="Re-queue this parked phase so the driver retries it"
                  @click=${(e) => act(e, p.id, "retry")}>retry</button>`
              : nothing}
          </div>`
        : nothing}
    </div>
  `;
}

function renderAgents() {
  const m = state.model;
  render(
    m && m.phases
      ? html`${m.phases.map((p, i) => agentCard(p, i))}`
      : html`<div class="empty">${state.error ? "no run found" : "loading…"}</div>`,
    $agents,
  );
}

function streamBlock(b) {
  switch (b.kind) {
    case "divider":
      return html`<div class="blk divider">${b.body}</div>`;
    case "thinking":
      return html`<div class="blk thinking"><span class="lbl">thinking</span>${b.body}</div>`;
    case "assistant":
      return html`<div class="blk assistant">${b.body}</div>`;
    case "user":
      return html`<div class="blk user"><span class="lbl">user</span>${b.body}</div>`;
    case "tool":
      return html`<div class="blk tool">
        <span class="lbl">tool</span><span class="name">${b.name}</span>
        ${b.body ? html`<div class="args">${b.body}</div>` : nothing}
      </div>`;
    case "result":
      return html`<div class="blk result ${b.error ? "error" : ""}">
        <span class="lbl">result${b.error ? " (error)" : ""}</span>${b.body}
      </div>`;
    default:
      return nothing;
  }
}

function selectedPhase() {
  return state.model && state.model.phases
    ? state.model.phases.find((p) => p.id === state.selectedId)
    : null;
}

function renderDetail() {
  if (!state.selectedId) {
    render(html`<div class="empty">Select an agent to watch its thought stream.</div>`, $detail);
    return;
  }
  const p = selectedPhase();
  const blocks = parseTranscript(state.t.raw);
  const wasAtBottom = isAtBottom();

  render(
    html`
      <div class="dhead">
        <div class="id">${state.selectedId} <span class="state-${p ? p.state : ""}">${p ? p.state : ""}</span></div>
        ${p && p.state === "running" && p.step
          ? html`<div class="now dhead-now">
              <span class="now-label">${p.step.label}</span>
              ${p.step.detail ? html`<span class="now-detail">${p.step.detail}</span>` : nothing}
              <span class="now-elapsed">${fmtElapsed(p.step.since)}</span>
            ${p.step.tokens != null
              ? html`<span class="now-tokens">${fmtTokens(p.step.tokens)} tok</span>`
              : nothing}
            </div>`
          : nothing}
        ${p
          ? html`<div class="sub">
                ${p.title || ""}${p.lastCommit ? html` · tip ${p.lastCommit}` : nothing}
              </div>
              ${p.slices && p.slices.length
                ? html`<ul class="slices">
                    ${p.slices.map(
                      (sl) => html`<li class="${sl.checked ? "done" : ""}">
                        ${sl.checked ? "✓" : "○"} ${sl.id} ${sl.title}
                        ${sl.sha ? html`<span class="sha">(${sl.sha})</span>` : nothing}
                      </li>`,
                    )}
                  </ul>`
                : nothing}`
          : nothing}
      </div>
      <div class="stream">
        ${blocks.length
          ? blocks.map(streamBlock)
          : html`<div class="empty">${
              state.t.exists ? "transcript is empty so far…" : "no transcript yet for this agent"
            }</div>`}
      </div>
      ${!state.autoFollow
        ? html`<div class="scroll-pause">
            <button @click=${jumpToLatest}>↓ Jump to latest</button>
          </div>`
        : nothing}
    `,
    $detail,
  );

  if (state.autoFollow && wasAtBottom !== "no-content") {
    scrollToBottom();
  }
}

// ── scroll handling ─────────────────────────────────────────────────────────
function isAtBottom() {
  const el = $detail;
  if (el.scrollHeight <= el.clientHeight) return "no-content";
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}
function scrollToBottom() {
  $detail.scrollTop = $detail.scrollHeight;
}
function jumpToLatest() {
  state.autoFollow = true;
  scrollToBottom();
  renderDetail();
}
$detail.addEventListener("scroll", () => {
  const atBottom = isAtBottom();
  if (atBottom === true) state.autoFollow = true;
  else if (atBottom === false) state.autoFollow = false;
});

// ── actions ─────────────────────────────────────────────────────────────────
// Request a driver action (poke a hung worker / retry a blocked phase). The
// server only drops a control file; run-loop.sh applies it on its next pass.
async function postControl(id, action) {
  try {
    await fetch(`/api/control?id=${encodeURIComponent(id)}&action=${action}`, { method: "POST" });
  } catch {
    /* transient; the button can be pressed again */
  }
}
function act(e, id, action) {
  e.stopPropagation(); // don't also select the card
  e.target.disabled = true; // debounce until the next server push re-renders
  postControl(id, action);
}

function selectAgent(id) {
  state.selectedId = id;
  state.t = { id, raw: "", offset: 0, exists: false };
  state.autoFollow = true;
  renderAgents();
  renderDetail();
  // Reopen the stream with the new `watch` id so the server tails this agent's
  // transcript. The fresh `snapshot` re-syncs the model.
  subscribe(id);
}

function renderAll() {
  renderHeader();
  renderAgents();
  renderDetail();
}

// ── boot ────────────────────────────────────────────────────────────────────
renderAll();
subscribe(null);
// Advance the "time on step" timers each second between server pushes —
// re-renders the agent cards from the cached model only (no network).
setInterval(() => {
  if (document.hidden) return;
  if (state.model && state.model.summary && state.model.summary.running) renderAgents();
}, TICK_MS);
