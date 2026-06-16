// claudopilot dashboard — lit-html SPA.
// Polls /api/progress for the run model and /api/transcript?id=… for the selected
// agent's thought stream (incrementally, with auto-scroll).

import { html, render, nothing } from "/lit-html.js";
import { parseTranscript } from "/transcript.mjs";

const POLL_MS = 3000;
const STALE_MS = 10000;
const TICK_MS = 1000; // refresh the "time on step" timers between polls

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

// ── state ─────────────────────────────────────────────────────────────────
const state = {
  model: null, // last /api/progress payload
  error: null,
  selectedId: null,
  lastOk: 0, // ts of last successful progress fetch
  // transcript accumulator for the selected agent
  t: { id: null, raw: "", offset: 0, exists: false },
  autoFollow: true,
};

const $header = document.getElementById("header");
const $agents = document.getElementById("agents");
const $detail = document.getElementById("detail");

// ── data fetching ───────────────────────────────────────────────────────────
async function fetchProgress() {
  try {
    const r = await fetch("/api/progress", { cache: "no-store" });
    const j = await r.json();
    if (j.error) {
      state.error = j.error;
    } else {
      state.model = j;
      state.error = null;
      state.lastOk = Date.now();
    }
  } catch (e) {
    state.error = String(e);
  }
}

async function fetchTranscript() {
  const id = state.selectedId;
  if (!id) return;
  if (state.t.id !== id) state.t = { id, raw: "", offset: 0, exists: false };
  try {
    const r = await fetch(`/api/transcript?id=${encodeURIComponent(id)}&offset=${state.t.offset}`, {
      cache: "no-store",
    });
    const j = await r.json();
    if (state.selectedId !== id) return; // selection changed mid-flight
    if (j.reset) {
      state.t = { id, raw: "", offset: 0, exists: false };
    }
    state.t.exists = j.exists;
    if (j.chunk) {
      state.t.raw += j.chunk;
      state.t.offset = j.size;
    } else if (typeof j.size === "number") {
      state.t.offset = j.size;
    }
  } catch {
    /* leave existing transcript in place */
  }
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
  const stale = Date.now() - state.lastOk > STALE_MS;
  return html`<span class="conn ${stale ? "stale" : ""}">${
    state.error ? `⚠ ${state.error}` : stale ? "reconnecting…" : "live"
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
  e.target.disabled = true; // debounce until the next poll re-renders
  postControl(id, action);
}

function selectAgent(id) {
  state.selectedId = id;
  state.t = { id, raw: "", offset: 0, exists: false };
  state.autoFollow = true;
  renderAgents();
  renderDetail();
  fetchTranscript().then(renderDetail);
}

function renderAll() {
  renderHeader();
  renderAgents();
  renderDetail();
}

// ── poll loop ───────────────────────────────────────────────────────────────
let inFlight = false;
async function tick() {
  if (document.hidden || inFlight) return;
  inFlight = true;
  try {
    await Promise.all([fetchProgress(), fetchTranscript()]);
    renderAll();
  } finally {
    inFlight = false;
  }
}

renderAll();
tick();
setInterval(tick, POLL_MS);
// Advance the "time on step" timers each second between polls — re-renders the
// agent cards from the cached model only (no network, no transcript re-parse).
setInterval(() => {
  if (document.hidden) return;
  if (state.model && state.model.summary && state.model.summary.running) renderAgents();
}, TICK_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick();
});
