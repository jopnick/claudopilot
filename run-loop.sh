#!/usr/bin/env bash
#
# Claudopilot autonomous execution loop — PARALLEL driver.
#
# Reads $MANIFEST (default: $REPO_ROOT/roadmap/EXECUTION-MANIFEST.md) and
# runs every currently-eligible phase concurrently, bounded by
# $MAX_PARALLEL. A phase is eligible when its state is [pending] and every
# phase listed in its `(deps: ...)` annotation is [merged]. This yields the
# /plan-build shape for free: contracts first (everything deps on them) →
# fan-out streams concurrently → assembly → verify.
#
# Concurrency model (see claudopilot/README.md "Parallel execution"):
#   - Each worker runs in its OWN git worktree on its OWN auto/<id> branch,
#     so concurrent workers never share a working directory.
#   - The DRIVER is the sole owner of merges and of the manifest. Workers
#     build + gate + rename DONE_ + exit 0; they do NOT merge or edit the
#     manifest. That removes the only two things that break under
#     concurrency: manifest write-races and merge races.
#
# Exit codes:
#   0 — manifest reports complete; all phases merged
#   2 — CHECKPOINT reached (manifest marker or worker exit 2); human review
#   3 — manifest malformed, or a dependency deadlock (eligible set empty
#       while pending phases remain and nothing is running)
#   4 — a worker reported a dependency error (deps annotation disagrees
#       with the phase doc); halt for human
#   5 — a phase exhausted supervisor attempts in WIP state; halt
#   6 — a phase stopped without a DONE_ rename AND the supervisor could not
#       recover it within MAX_SUPERVISOR_ATTEMPTS_PER_PHASE; halt. (A worker
#       that stops short no longer halts immediately — claude -p always exits
#       0, so a missing DONE_ rename routes to the supervisor first.)
#   7 — hit MAX_ITER scheduling passes without completion
#   8 — KEEP_GOING run finished with one or more phases [blocked] (parked
#       branches left for review); not a crash — review and re-run if desired

set -o pipefail
# Not -e (background-job exits are handled explicitly) and NOT -u: this driver
# manages dynamic associative arrays (PID/WT/...), and on some bash versions
# expanding an EMPTY assoc array under `set -u` raises "unbound variable" — which
# previously crashed running_count() and faked completion. We guard with :- where
# it matters instead.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0   # never block on corepack's interactive download prompt

REPO_ROOT="${REPO_ROOT:-/work}"

# ── Project config seam (keeps the engine repo-agnostic) ───────────────────
# The target repo supplies its specifics (gate, bootstrap, roadmap location,
# prompt overlay, Dockerfile) in claudopilot.config.sh at its root. The engine
# ships generic defaults; this config overrides. It is what STAYS in the target
# repo when the engine is extracted to its own repo (consumed as submodule/subtree).
CLAUDOPILOT_CONFIG="${CLAUDOPILOT_CONFIG:-$REPO_ROOT/claudopilot.config.sh}"
# shellcheck disable=SC1090
[[ -f "$CLAUDOPILOT_CONFIG" ]] && source "$CLAUDOPILOT_CONFIG"

ROADMAP_DIR="${ROADMAP_DIR:-roadmap}"
MANIFEST="${MANIFEST:-$REPO_ROOT/$ROADMAP_DIR/EXECUTION-MANIFEST.md}"
RENDER_STREAM="${RENDER_STREAM:-$REPO_ROOT/claudopilot/render-stream.mjs}"
RENDER_STREAM_OPENCODE="${RENDER_STREAM_OPENCODE:-$REPO_ROOT/claudopilot/render-stream-opencode.mjs}"

# ── Agent driver seam ───────────────────────────────────────────────────────
# Which agent CLI runs each worker:
#   claude   (default) — Claude Code headless (`claude -p … --output-format stream-json`).
#   opencode           — OpenCode headless (`opencode run … --format json`); model-agnostic,
#                        so AGENT_MODEL can point at a local Ollama model (e.g.
#                        ollama/qwen2.5-coder) for a $0/offline run, or any provider/model.
# Everything else in the engine (scheduling, worktrees, serial merges, the DONE_ rename
# done-signal, the dashboard) is driver-agnostic. Note: small local models are far weaker
# at the worker contract than frontier Claude — prefer the simpler roadmaps and MAX_PARALLEL=1.
AGENT_DRIVER="${AGENT_DRIVER:-claude}"
AGENT_MODEL="${AGENT_MODEL:-}"   # e.g. ollama/qwen2.5-coder ; empty = the driver's default

# Prompts = generic engine contract (base, ships with the engine) + optional
# project overlay (cornerstones, paths supplied by the target repo via config).
PROMPT_FILE="${PROMPT_FILE:-$REPO_ROOT/claudopilot/prompts/worker.md}"
SUPERVISOR_PROMPT_FILE="${SUPERVISOR_PROMPT_FILE:-$REPO_ROOT/claudopilot/prompts/supervisor.md}"
WORKER_PROJECT_PROMPT="${WORKER_PROJECT_PROMPT:-}"
SUPERVISOR_PROJECT_PROMPT="${SUPERVISOR_PROJECT_PROMPT:-}"

# ── Isolation mode ──────────────────────────────────────────────────────────
# 0 (default): workers are claude -p subprocesses in git worktrees, all inside
#   one container (today's model; run via run-in-docker.sh).
# 1: this orchestrator runs on the HOST (trusted: scheduling, merges, the SSH key,
#   the only pushes) and each phase runs as its OWN disposable container against a
#   per-phase CLONE — the agent's only writable surface, with Claude auth but NO
#   git push creds. Launched via run-in-docker.sh --isolated.
CLAUDOPILOT_ISOLATED="${CLAUDOPILOT_ISOLATED:-0}"
WORKER_IMAGE="${WORKER_IMAGE:-claudopilot-runner}"

# Concurrency. MAX_PARALLEL caps simultaneously-running workers. Tune to
# cores AND to your Claude rate-limit headroom — each worker is a full
# `claude -p`. 3 is a safe default for a Pro/Max plan on a multi-core host.
MAX_PARALLEL="${MAX_PARALLEL:-3}"
POLL_SECONDS="${POLL_SECONDS:-5}"
MAX_ITER="${MAX_ITER:-2000}"        # scheduling passes, not phases
MAX_SUPERVISOR_ATTEMPTS_PER_PHASE="${MAX_SUPERVISOR_ATTEMPTS_PER_PHASE:-2}"

# Keep-going (autonomous best-effort) mode. When 1, a phase the supervisor
# cannot get green is PARKED — its auto/<id> branch is committed but NOT
# merged, marked [blocked] — and the run CONTINUES with every other
# independent phase instead of halting for a human. Red work is never merged
# (that would break the shared gate for all phases); parked branches stay in
# git for review/rollback. The final supervisor attempt runs in best-effort
# mode (wider edit mandate). Dependents of a blocked phase are skipped.
KEEP_GOING="${KEEP_GOING:-0}"

# Per-phase quality gate — PROJECT-SPECIFIC (from claudopilot.config.sh; must
# match the target repo's pre-commit hook). Engine default is a no-op so the
# engine stays repo-agnostic; the worker runs whatever $GATE_CMD resolves to.
GATE_CMD="${GATE_CMD:-true}"
export GATE_CMD

# Dependency install for a fresh per-phase worktree/clone — PROJECT-SPECIFIC
# (config). Empty = skip. One-time run-start bootstrap install + best-effort
# build are also project-specific (empty = skip the step).
WORKTREE_PREPARE_CMD="${WORKTREE_PREPARE_CMD:-}"
BOOTSTRAP_CMD="${BOOTSTRAP_CMD:-}"
BUILD_CMD="${BUILD_CMD:-}"

# Usage governance: pause LAUNCHING new workers (running ones finish) when a
# rolling window of launches approaches the plan's ceiling. Reactive
# rate-limit backoff is handled per-worker below.
USAGE_WINDOW_SECONDS="${USAGE_WINDOW_SECONDS:-18000}"
MAX_TICKS_PER_WINDOW="${MAX_TICKS_PER_WINDOW:-40}"
USAGE_THRESHOLD_PCT="${USAGE_THRESHOLD_PCT:-95}"
DEFAULT_RATE_LIMIT_SLEEP="${DEFAULT_RATE_LIMIT_SLEEP:-3600}"

IGNORE_LOOP_CHECKPOINTS="${IGNORE_LOOP_CHECKPOINTS:-0}"

# Reactive retry for TRANSIENT, server-side API failures (HTTP 500/502/503, 529
# overloaded, dropped sockets) — distinct from rate limits (handled separately
# with a parsed cooldown). A worker that died on one of these is not at fault and
# the condition clears on its own, so the driver re-pends and relaunches it, up to
# a per-phase cap, instead of parking it. Set RETRY_TRANSIENT_API=0 to disable.
RETRY_TRANSIENT_API="${RETRY_TRANSIENT_API:-1}"
TRANSIENT_API_MAX_RETRIES="${TRANSIENT_API_MAX_RETRIES:-10}"

# Stuck-worker watchdog: if a RUNNING worker's transcript shows no new bytes for
# STUCK_TIMEOUT seconds, treat it as hung (a wedged API stream, or a gate command
# that never returns), kill it, and relaunch. 0 disables (default — a long gate
# can legitimately be quiet; opt in per-project once you know your gate's ceiling).
STUCK_TIMEOUT="${STUCK_TIMEOUT:-0}"

RUNDIR="$REPO_ROOT/.claudopilot"
WORKTREES="$RUNDIR/worktrees"
CONTROL_DIR="$RUNDIR/control"   # UI/CLI drops action files here; the driver applies them
LOG_FILE="${LOG_FILE:-$REPO_ROOT/.claudopilot.log}"

cd "$REPO_ROOT"
mkdir -p "$WORKTREES" "$CONTROL_DIR"
: > "$LOG_FILE"

log() { echo "[loop] $*" | tee -a "$LOG_FILE"; }

log "Parallel driver. Activity log: $LOG_FILE  (MAX_PARALLEL=$MAX_PARALLEL)"
log "Per-phase logs under: $RUNDIR/<phase-id>.log"

# ── Base branch detection (never land work on the trunk; our trunk is main) ──
if [[ -z "${BASE_BRANCH:-}" ]]; then
  if ! BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD); then
    log "FATAL: could not detect current branch (set safe.directory in Docker)."; exit 1
  fi
fi
export BASE_BRANCH
log "Base branch: $BASE_BRANCH"
if [[ "$BASE_BRANCH" =~ ^(main|master)$ && "${BASE_BRANCH_EXPLICIT:-}" != "1" ]]; then
  log "FATAL: refusing to land phase work on trunk '$BASE_BRANCH'. Launch from a runner branch"
  log "       (e.g. 'autonomous-runner' cut from main), or set BASE_BRANCH_EXPLICIT=1 to override."; exit 1
fi

# ── Bootstrap: project install + best-effort build once (config-driven) ────
# A mounted host node_modules may be stale or built for another OS/arch (native
# binaries), so the configured install runs every time. Both steps are project
# specifics from claudopilot.config.sh; empty = skip.
if [[ "$CLAUDOPILOT_ISOLATED" == "1" ]]; then
  log "Isolated mode: the orchestrator runs on the host; each phase installs its own clone inside its worker container — skipping host bootstrap."
elif [[ -n "$BOOTSTRAP_CMD" ]]; then
  log "Bootstrap: $BOOTSTRAP_CMD"
  eval "$BOOTSTRAP_CMD" 2>&1 | tee -a "$LOG_FILE" || log "WARNING: bootstrap install failed; build/gate may fail until resolved."
  if [[ -n "$BUILD_CMD" ]]; then
    log "Bootstrap: $BUILD_CMD (best-effort)"
    eval "$BUILD_CMD" 2>&1 | tee -a "$LOG_FILE" || log "WARNING: bootstrap build failed; workers/supervisor will address it."
  fi
else
  log "Bootstrap: no BOOTSTRAP_CMD configured — skipping install."
fi

[[ -f "$MANIFEST" ]]    || { log "Manifest not found at $MANIFEST"; exit 3; }
[[ -f "$PROMPT_FILE" ]] || { log "Prompt file not found at $PROMPT_FILE"; exit 3; }

# ── Manifest helpers (the DRIVER is the sole writer) ──────────────────────
# Order line grammar:
#   N. [state] **phase-id** — title (deps: a, b)      (deps optional)
# states: pending | running | merged | failed
order_lines() {  # emits: state<TAB>id<TAB>space-separated-deps
  grep -E '^[0-9]+\.[[:space:]]+\[[a-z]+\][[:space:]]+\*\*[^*]+\*\*' "$MANIFEST" \
  | while IFS= read -r line; do
      local st id deps
      st=$(sed -E 's/^[0-9]+\.[[:space:]]+\[([a-z]+)\].*/\1/' <<<"$line")
      id=$(sed -E 's/^[0-9]+\.[[:space:]]+\[[a-z]+\][[:space:]]+\*\*([^*]+)\*\*.*/\1/' <<<"$line")
      if [[ "$line" == *"(deps:"* ]]; then
        deps=$(sed -E 's/.*\(deps:([^)]*)\).*/\1/' <<<"$line" | tr ',' ' ')
      else deps=""; fi
      # `(deps: none)` is the human way of writing "no dependencies"; drop a bare
      # `none` token so it is never mistaken for an (unsatisfiable) phase id.
      local clean=""
      for d in $deps; do [[ "$d" == "none" ]] || clean+="$d "; done
      printf '%s\t%s\t%s\n' "$st" "$id" "${clean% }"
    done
}

set_state() {  # set_state <id> <new-state>; commits the manifest on base
  local id="$1" new="$2" id_re; id_re=${id//./\\.}
  sed -i -E "s/^([0-9]+\.[[:space:]]+)\[[a-z]+\]([[:space:]]+\*\*${id_re}\*\*)/\1[${new}]\2/" "$MANIFEST"
  git add "$MANIFEST" >/dev/null 2>&1
  git commit -q -m "chore(loop): ${id} -> ${new}" >/dev/null 2>&1 || true
}

phase_doc() {  # echo the phase doc path for an id, or empty
  local id="$1"
  ls "$REPO_ROOT/$ROADMAP_DIR/${id}"*.md "$REPO_ROOT/$ROADMAP_DIR/${id}-"*.md 2>/dev/null | head -n1
}

all_merged() {  # true ONLY if there is >=1 order entry and every one is merged
  local total merged
  total=$(order_lines | grep -c .)
  merged=$(order_lines | awk -F'\t' '$1=="merged"{c++} END{print c+0}')
  [[ "$total" -gt 0 && "$total" -eq "$merged" ]]
}

# ── Worker lifecycle (background) ─────────────────────────────────────────
declare -A PID WT PLOG SUPATT STREAM TRANSCRIPT RESUME_SID
declare -A APIRETRY STUCK_SIZE STUCK_SINCE   # transient-retry counts + watchdog progress tracking
FAILED=0; BLOCKED=0; HALT_CODE=""

prepare_worktree() {  # id -> branch + (worktree | isolated clone)
  local id="$1" branch="auto/$1" wt="$WORKTREES/$1"
  git show-ref --quiet "refs/heads/$branch" || git branch "$branch" "$BASE_BRANCH"
  if [[ "$CLAUDOPILOT_ISOLATED" == "1" ]]; then
    # Disposable per-phase clone (the agent's only writable surface). Deps are
    # installed inside the worker container, not here.
    if [[ ! -d "$wt" ]]; then
      log "  [$id] cloning $REPO_ROOT -> $wt (isolated, branch $branch)"
      git clone --quiet --branch "$branch" "$REPO_ROOT" "$wt" >>"$LOG_FILE" 2>&1
      git -C "$wt" config user.name  "$(git -C "$REPO_ROOT" config user.name  2>/dev/null)" 2>/dev/null || true
      git -C "$wt" config user.email "$(git -C "$REPO_ROOT" config user.email 2>/dev/null)" 2>/dev/null || true
    fi
    WT[$id]="$wt"; return
  fi
  if [[ ! -d "$wt" ]]; then
    git worktree add "$wt" "$branch" >>"$LOG_FILE" 2>&1
    if [[ -n "$WORKTREE_PREPARE_CMD" ]]; then
      log "  [$id] worktree $wt; preparing deps ($WORKTREE_PREPARE_CMD)"
      ( cd "$wt" && eval "$WORKTREE_PREPARE_CMD" ) >>"$LOG_FILE" 2>&1 \
        || log "  [$id] WARNING: worktree prepare failed; worker may need to install."
    fi
  fi
  WT[$id]="$wt"
}

# Effective prompt = generic engine base + optional project overlay (cornerstones).
# For the worker, the resolved GATE_CMD is injected too, so the project's gate flows
# from claudopilot.config.sh into the prompt without being hardcoded in either file.
_overlay() {  # path (repo-relative or absolute) -> cat if present
  local p="${1:-}"; [[ -z "$p" ]] && return 0
  [[ "${p:0:1}" != "/" ]] && p="$REPO_ROOT/$p"
  [[ -f "$p" ]] && { printf '\n\n'; cat "$p"; }
}
worker_prompt() {
  cat "$PROMPT_FILE"; _overlay "$WORKER_PROJECT_PROMPT"
  printf '\n\n## GATE_CMD (this project'\''s quality gate — must stay green after every slice)\n\n    %s\n' "$GATE_CMD"
}
supervisor_prompt() { cat "$SUPERVISOR_PROMPT_FILE"; _overlay "$SUPERVISOR_PROJECT_PROMPT"; }

# Run `claude -p "$2"` in the CURRENT dir with the full I/O stream captured:
#   - raw NDJSON events   -> $RUNDIR/<id>.stream.jsonl   (full-fidelity artifact)
#   - readable transcript -> $RUNDIR/<id>.transcript.md  (rendered; chat-window view)
#   - rendered + stderr   -> $RUNDIR/<id>.log            (so is_rate_limited still works)
# Returns claude's exit code (pipefail carries it through; tee/renderer exit 0).
# Caller sets cwd and any extra env (e.g. SUPERVISOR_MODE).
capture_agent() {  # id, prompt, [resume_sid]
  local id="$1" prompt="$2" sid="${3:-}"
  local plog="$RUNDIR/$id.log" stream="$RUNDIR/$id.stream.jsonl" transcript="$RUNDIR/$id.transcript.md"
  { echo; echo "=== [$id] ${SUPERVISOR_MODE:+supervisor }run (attempt ${SUPATT[$id]:-0})${sid:+ resume=$sid} ==="; } >>"$transcript"
  if [[ "$AGENT_DRIVER" == "opencode" ]]; then
    # OpenCode headless. --dangerously-skip-permissions is the bypassPermissions
    # equivalent (auto-approve). Its --format json events are mapped to the same
    # transcript markers by render-stream-opencode.mjs.
    local model_args=(); [[ -n "$AGENT_MODEL" ]] && model_args=(-m "$AGENT_MODEL")
    opencode run "$prompt" "${model_args[@]}" --format json --dangerously-skip-permissions 2>>"$plog" \
      | tee -a "$stream" \
      | node "$RENDER_STREAM_OPENCODE" \
      | tee -a "$transcript" >>"$plog"
  else
    # On resume (claude driver only), --resume continues the prior conversation and
    # the prompt is the next turn; otherwise run fresh with the full prompt.
    local pre=(-p "$prompt")
    [[ -n "$sid" ]] && pre=(--resume "$sid" -p "$prompt")
    claude "${pre[@]}" \
        --permission-mode bypassPermissions --verbose --output-format stream-json 2>>"$plog" \
      | tee -a "$stream" \
      | node "$RENDER_STREAM" \
      | tee -a "$transcript" >>"$plog"
  fi
}

# Set PLOG/STREAM/TRANSCRIPT for a phase. Isolated: inside the clone's .claudopilot
# (host-visible via the bind-mount, so the worker writes there live). Else: $RUNDIR.
set_capture_paths() {  # id
  local id="$1" base
  if [[ "$CLAUDOPILOT_ISOLATED" == "1" ]]; then base="${WT[$id]}/.claudopilot"; mkdir -p "$base"
  else base="$RUNDIR"; fi
  PLOG[$id]="$base/$id.log"; STREAM[$id]="$base/$id.stream.jsonl"; TRANSCRIPT[$id]="$base/$id.transcript.md"
}

# Isolated: one-shot worker/supervisor container against the phase clone. The
# prompt was written to <clone>/.claudopilot/<id>.prompt.txt; worker-entry.sh
# installs deps and runs claude with stream capture into the mounted clone. The
# agent commits auto/<id> locally — NO git push creds enter the container.
run_phase_container() {  # id
  local id="$1" wt="${WT[$id]}" cm=()
  [[ -d "$HOME/.claude" ]]      && cm+=(-v "$HOME/.claude:/home/runner/.claude")
  [[ -f "$HOME/.claude.json" ]] && cm+=(-v "$HOME/.claude.json:/home/runner/.claude.json")
  docker rm -f "cp-w-$id" >/dev/null 2>&1 || true
  docker run --rm --name "cp-w-$id" --init --ipc=host --shm-size=2g \
    -v "$wt:/work" "${cm[@]}" \
    -e ANTHROPIC_API_KEY -e CLAUDOPILOT_PHASE="$id" -e GATE_CMD \
    -e WORKTREE_PREPARE_CMD -e SUPERVISOR_MODE -e CLAUDOPILOT_RESUME_SID \
    "$WORKER_IMAGE" bash /work/claudopilot/worker-entry.sh
}

launch() {  # id -> spawn a worker (subprocess or container), record pid
  local id="$1"; prepare_worktree "$id"; set_capture_paths "$id"
  local wt="${WT[$id]}"
  : "${SUPATT[$id]:=0}"
  # First attempt of this run starts the capture files fresh; supervisor retries append.
  if [[ "${SUPATT[$id]}" -eq 0 ]]; then : >"${PLOG[$id]}"; : >"${STREAM[$id]}"; : >"${TRANSCRIPT[$id]}"; fi
  set_state "$id" running

  if [[ "$CLAUDOPILOT_ISOLATED" == "1" ]]; then
    { worker_prompt; printf '\n\nThe phase to execute is: %s\nYour working directory (/work) is this phase'\''s clone on branch auto/%s.\nBuild, gate, and rename the phase doc to DONE_, then stop. Do NOT merge, push, or\nedit the manifest — the orchestrator owns those.\n' "$id" "$id"; } > "$wt/.claudopilot/$id.prompt.txt"
    local sid_iso="${RESUME_SID[$id]:-}"; unset 'RESUME_SID[$id]'
    log "  LAUNCH [$id] (isolated container cp-w-$id; running=$(running_count)/$MAX_PARALLEL)${sid_iso:+ [resume]} -> ${TRANSCRIPT[$id]}"
    ( CLAUDOPILOT_RESUME_SID="$sid_iso" run_phase_container "$id" ) >>"$wt/.claudopilot/$id.docker.log" 2>&1 &
    PID[$id]=$!
    return
  fi

  local sid="${RESUME_SID[$id]:-}"; unset 'RESUME_SID[$id]'
  log "  LAUNCH [$id] (running=$(running_count)/$MAX_PARALLEL)${sid:+ [resume]} -> ${TRANSCRIPT[$id]}"
  (
    cd "$wt"
    if [[ -n "$sid" ]]; then
      capture_agent "$id" "$RESUME_NUDGE" "$sid"
    else
      capture_agent "$id" "$(worker_prompt)

The phase to execute is: $id
Your working directory is this phase's git worktree on branch auto/$id.
Build, gate, and rename the phase doc to DONE_, then exit 0. Do NOT merge
or edit the manifest — the driver owns those."
    fi
  ) &
  PID[$id]=$!
}

running_count() { echo "${#PID[@]}"; }

is_rate_limited() {  # check a per-phase log tail
  tail -120 "$1" 2>/dev/null \
    | grep -qiE "rate.?limit|usage limit|429|too many requests|please (retry|wait)|exceeded.*(quota|limit)"
}

# A transient, server-side API failure the agent surfaces verbatim (e.g.
# "API Error: 500 Internal server error", "...socket connection was closed",
# 502/503/529 overloaded). Unlike a gate failure these are not the worker's fault
# and clear on their own, so we relaunch rather than park. Checked AFTER
# is_rate_limited so a 429 still takes the rate-limit cooldown path.
is_transient_api_error() {  # check a per-phase log tail
  [[ "$RETRY_TRANSIENT_API" == "1" ]] || return 1
  tail -120 "$1" 2>/dev/null \
    | grep -qiE "api error|socket connection was closed|5[0-9][0-9] internal server error|overloaded|bad gateway|service unavailable"
}

# Re-pending a phase that hit a transient API error, bounded by a per-phase cap so
# a sustained outage eventually parks it instead of looping forever. Returns 0 if a
# retry was scheduled, 1 if the cap is exhausted (caller should park/halt).
retry_transient_api() {  # id
  local id="$1"; : "${APIRETRY[$id]:=0}"
  (( APIRETRY[$id] >= TRANSIENT_API_MAX_RETRIES )) && return 1
  APIRETRY[$id]=$(( APIRETRY[$id] + 1 ))
  log "  [$id] transient API error — relaunching (retry ${APIRETRY[$id]}/$TRANSIENT_API_MAX_RETRIES)."
  mark_resume "$id"; set_state "$id" pending; return 0
}

# Remember the worker's claude session id so the NEXT launch resumes the SAME
# conversation instead of cold-restarting (which loses all in-flight work and
# re-orients from scratch). Only used when an interruption is not the worker's
# fault — a transient API/network error, a stuck-watchdog/poke kill, or a
# rate-limit cooldown. No-op if no session was created, or under a non-claude
# driver whose stream carries no claude session_id.
mark_resume() {  # id
  local id="$1" sp="${STREAM[$id]:-}" sid=""
  [[ -f "$sp" ]] && sid=$(grep -oE '"session_id":"[^"]+"' "$sp" 2>/dev/null | head -1 | cut -d'"' -f4)
  if [[ -n "$sid" ]]; then RESUME_SID[$id]="$sid"; log "  [$id] will resume session ${sid} on relaunch"; fi
}

# The next-turn message sent when resuming an interrupted worker. Its prior
# context is intact in the resumed session, so this is a short re-orient.
RESUME_NUDGE="A transient interruption (network/API error, watchdog, or poke) stopped you mid-run and your session has now been resumed — your prior context is intact. Re-read the ## Status checklist in your phase doc, then continue from the first unchecked slice. Same contract: build each remaining slice, keep the gate green, rename the phase doc to DONE_ when all slices are done, then stop. Do NOT re-seed the checklist, merge, or edit the manifest."

# Recursively TERM a worker process and its descendants (the subshell plus the
# claude/node/tee pipeline), so a poke/watchdog kill actually stops the agent.
kill_tree() {  # pid
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill -TERM "$p" 2>/dev/null || true
}

cleanup_worktree() {
  local id="$1" branch="auto/$1" wt="${WT[$id]:-}"
  if [[ "$CLAUDOPILOT_ISOLATED" == "1" ]]; then
    docker rm -f "cp-w-$id" >>"$LOG_FILE" 2>&1 || true
    [[ -n "$wt" ]] && rm -rf "$wt"
    git branch -D "$branch" >>"$LOG_FILE" 2>&1 || true
    return
  fi
  [[ -n "$wt" ]] && git worktree remove "$wt" --force >>"$LOG_FILE" 2>&1
  git branch -D "$branch" >>"$LOG_FILE" 2>&1 || true
}

# Persist the agent's captured I/O as a build artifact on the base branch:
#   build-logs/<id>/transcript.md   — readable transcript (chat-window view)
#   build-logs/<id>/stream.jsonl.gz — gzipped raw event stream (full fidelity, replayable)
commit_build_log() {  # id  (must run from the BASE_BRANCH checkout, before cleanup)
  local id="$1" dir="$REPO_ROOT/build-logs/$id"
  # Isolated capture lives in the clone (STREAM/TRANSCRIPT point there); else $RUNDIR.
  local stream="${STREAM[$id]:-$RUNDIR/$id.stream.jsonl}" transcript="${TRANSCRIPT[$id]:-$RUNDIR/$id.transcript.md}"
  [[ -s "$transcript" || -s "$stream" ]] || return 0
  mkdir -p "$dir"
  [[ -s "$transcript" ]] && cp "$transcript" "$dir/transcript.md"
  [[ -s "$stream" ]] && gzip -c "$stream" > "$dir/stream.jsonl.gz"
  # Persist a copy into $RUNDIR so the monitor/post-run can read it after an
  # isolated clone is removed (no-op when capture already lives in $RUNDIR).
  [[ -s "$transcript" && "$transcript" != "$RUNDIR/$id.transcript.md" ]] && cp "$transcript" "$RUNDIR/$id.transcript.md" 2>/dev/null
  git add "build-logs/$id" >/dev/null 2>&1
  if ! git diff --cached --quiet -- "build-logs/$id" 2>/dev/null; then
    git commit -q --no-verify -m "docs(build-log): $id agent transcript + raw stream" >>"$LOG_FILE" 2>&1 || true
    log "  [$id] build-log committed -> build-logs/$id/"
  fi
}

# A merge whose ONLY conflicts are in generated/derived files is auto-resolvable:
# regenerate those files from the merged tree, stage them, and complete the merge.
# In practice that's the package-manager lockfile — every package-adding phase rewrites
# it, so two phases that ran in parallel ALWAYS collide there, even when their source is
# package-disjoint. The lock is fully determined by the merged package.json set, so
# regenerating is the correct resolution (not a textual merge). A conflict touching
# ANY non-derived file means the streams weren't disjoint — that still parks.
#
# This is package-manager-agnostic out of the box: pnpm, npm, yarn, and bun lockfiles
# are all recognized and regenerated with the matching command, inferred from which
# lockfile is in conflict. Tunable via DERIVED_CONFLICT_FILES (ERE) — a conflict is only
# auto-resolved if every conflicted path matches it — and LOCKFILE_REGEN_CMD, which when
# set overrides the inferred regen command.

# Every common JS lockfile, not just pnpm's. Each package-adding phase rewrites its
# lockfile, so parallel phases collide there regardless of package manager.
DERIVED_CONFLICT_FILES_DEFAULT='^(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$'

# Map a conflicted lockfile to the command that regenerates it from the (already merged)
# package.json set alone — no full install, no network where the manager supports it.
lockfile_regen_cmd_for() {
  case "${1##*/}" in
    pnpm-lock.yaml)                        echo 'pnpm install --lockfile-only' ;;
    package-lock.json|npm-shrinkwrap.json) echo 'npm install --package-lock-only' ;;
    yarn.lock)                             echo 'yarn install --mode=update-lockfile' ;;
    bun.lock|bun.lockb)                    echo 'bun install' ;;
  esac
}

# Returns 0 if fully resolved + committed, 1 otherwise (caller aborts + parks).
resolve_derived_conflicts() {
  local id="$1" unresolved derived_re f regen
  unresolved=$(git diff --name-only --diff-filter=U)
  [[ -n "$unresolved" ]] || return 1
  derived_re="${DERIVED_CONFLICT_FILES:-$DERIVED_CONFLICT_FILES_DEFAULT}"
  # Bail if ANY conflicted path is not a derived file. NB: capture-and-test rather
  # than `grep -qv` — ugrep (a grep drop-in some hosts ship) mishandles -q+-v.
  [[ -n "$(grep -vE "$derived_re" <<<"$unresolved")" ]] && return 1
  # Regen command: an explicit override wins; otherwise infer it from the lockfile(s)
  # in conflict so npm/yarn/bun/pnpm all work without per-repo configuration.
  regen="${LOCKFILE_REGEN_CMD:-}"
  if [[ -z "$regen" ]]; then
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      regen="$(lockfile_regen_cmd_for "$f")"
      [[ -n "$regen" ]] && break
    done <<<"$unresolved"
  fi
  if [[ -z "$regen" ]]; then
    log "  [$id] derived-only merge conflict but no lockfile regen command for: $(tr '\n' ' ' <<<"$unresolved")"
    return 1   # matched DERIVED_CONFLICT_FILES but unknown manager -> set LOCKFILE_REGEN_CMD
  fi
  log "  [$id] derived-only merge conflict; regenerating ($regen): $(tr '\n' ' ' <<<"$unresolved")"
  # Clear the conflict markers (take base's copy) so the regen tool reads a valid
  # file, then regenerate from the merged manifests.
  while IFS= read -r f; do [[ -n "$f" ]] && git checkout --ours -- "$f" >>"$LOG_FILE" 2>&1; done <<<"$unresolved"
  ( eval "$regen" ) >>"$LOG_FILE" 2>&1 || return 1
  while IFS= read -r f; do [[ -n "$f" ]] && git add -- "$f" >>"$LOG_FILE" 2>&1; done <<<"$unresolved"
  [[ -n "$(git diff --name-only --diff-filter=U)" ]] && return 1   # still unresolved -> bail
  git commit --no-edit >>"$LOG_FILE" 2>&1 || return 1
  return 0
}

merge_phase() {  # driver-owned, serialized (we are single-threaded here)
  local id="$1" branch="auto/$1"
  log "  MERGE [$id] -> $BASE_BRANCH"
  git checkout -q "$BASE_BRANCH"
  # Isolated: the worker committed to auto/<id> inside its clone — pull those
  # commits back into the orchestrator's branch ref before merging (local, no network).
  if [[ "$CLAUDOPILOT_ISOLATED" == "1" && -d "${WT[$id]:-/nonexistent}" ]]; then
    git fetch --quiet "${WT[$id]}" "+$branch:$branch" >>"$LOG_FILE" 2>&1 || true
  fi
  git pull --ff-only origin "$BASE_BRANCH" >>"$LOG_FILE" 2>&1 || true
  if ! git merge --no-ff "$branch" -m "Merge ${id} (autonomous)" >>"$LOG_FILE" 2>&1; then
    # Parallel phases collide on regenerated files (the lockfile) — auto-resolve those;
    # a source-file conflict still parks (streams must be package-disjoint).
    if resolve_derived_conflicts "$id"; then
      log "  [$id] merge completed after regenerating derived files"
    else
      git merge --abort >>"$LOG_FILE" 2>&1 || true
      park_or_halt "$id" 1 "MERGE CONFLICT (non-derived files; concurrent streams must be package-disjoint)"
      return 1
    fi
  fi
  set_state "$id" merged
  commit_build_log "$id"
  git push origin "$BASE_BRANCH" >>"$LOG_FILE" 2>&1 || true
  cleanup_worktree "$id"
  git push origin --delete "$branch" >>"$LOG_FILE" 2>&1 || true
}

forget() { local id="$1"; unset 'PID[$id]'; }

# True if the phase's auto/<id> branch reached the DONE_ rename (the real success
# signal — claude -p can't return a non-zero code to signal a short stop).
branch_has_done() {
  local id="$1"
  # Isolated: the worker commits the DONE_ rename to auto/<id> INSIDE its clone; the
  # host's auto/<id> ref isn't updated until merge_phase fetches it. Checking the
  # host ref here would never see the rename, so a finished phase would be supervised
  # and relaunched forever (and never merge). Check the clone's branch directly.
  if [[ "$CLAUDOPILOT_ISOLATED" == "1" && -d "${WT[$id]:-/nonexistent}" ]]; then
    git -C "${WT[$id]}" ls-tree -r --name-only "auto/$id" 2>/dev/null | grep -q "$ROADMAP_DIR/DONE_${id}"
    return
  fi
  git log "auto/$id" --oneline -- "$ROADMAP_DIR/DONE_${id}"* 2>/dev/null | grep -q . \
    || git ls-tree -r --name-only "auto/$id" 2>/dev/null | grep -q "$ROADMAP_DIR/DONE_${id}"
}

# A worker stopped without renaming DONE_ (gate red, out-of-scope blocker, ...).
# Because claude -p always exits 0, a missing DONE_ — not the process code — is the
# halt signal. Hand to the supervisor (wider edit mandate), relaunching the worker;
# only park/halt once supervisor attempts are exhausted.
supervise() {  # id, code
  local id="$1" code="$2" plog="${PLOG[$id]}"
  if is_rate_limited "$plog"; then
    log "  [$id] rate-limit-shaped; relaunch after cooldown."
    cool_down "$plog"; mark_resume "$id"; set_state "$id" pending; forget "$id"; return
  fi
  # A transient API error (not a gate failure) left no DONE_ — relaunch the worker
  # without spending a supervisor attempt; only fall through once the cap is hit.
  if is_transient_api_error "$plog" && retry_transient_api "$id"; then forget "$id"; return; fi
  if (( ${SUPATT[$id]} >= MAX_SUPERVISOR_ATTEMPTS_PER_PHASE )); then
    park_or_halt "$id" "$code" "supervisor exhausted (no DONE_ doc)"; forget "$id"; return
  fi
  SUPATT[$id]=$(( ${SUPATT[$id]} + 1 ))
  local mode="standard"
  # Final attempt always widens the mandate (cross-package skeleton blockers are
  # common on keystone phases); no longer gated on KEEP_GOING.
  if (( ${SUPATT[$id]} >= MAX_SUPERVISOR_ATTEMPTS_PER_PHASE )); then mode="best-effort"; fi
  log "  [$id] no DONE_ doc on branch; SUPERVISOR attempt ${SUPATT[$id]}/$MAX_SUPERVISOR_ATTEMPTS_PER_PHASE ($mode)"
  local sup_suffix="

The phase that just halted: $id
The worker stopped without renaming the phase doc to DONE_ (claude -p exits 0 even on
a short stop, so a missing DONE_ rename is the halt signal — not the process code).
Supervisor mode: $mode  (best-effort = wider edit mandate; get the gate green if at all possible — it is all in git)"
  local scode
  if [[ "$CLAUDOPILOT_ISOLATED" == "1" ]]; then
    { supervisor_prompt; printf '%s\n' "$sup_suffix"; } > "${WT[$id]}/.claudopilot/$id.prompt.txt"
    SUPERVISOR_MODE="$mode" run_phase_container "$id" >>"${WT[$id]}/.claudopilot/$id.docker.log" 2>&1
    scode=$?
  else
    ( cd "${WT[$id]}"
      SUPERVISOR_MODE="$mode" capture_agent "$id" "$(supervisor_prompt)$sup_suffix"
    )
    scode=$?
  fi
  if [[ "$scode" -eq 0 ]] && branch_has_done "$id"; then
    log "  [$id] supervisor produced DONE_; merging."; merge_phase "$id"; forget "$id"
  elif [[ "$scode" -eq 0 ]]; then
    log "  [$id] supervisor OK; relaunching worker on same worktree."; forget "$id"; launch "$id"
  else
    park_or_halt "$id" "$code" "supervisor could not recover"; forget "$id"
  fi
}

# Decide what to do with a phase that cannot be completed. KEEP_GOING parks it
# ([blocked], branch preserved, never merged) and the run continues; otherwise
# the run halts with the carried exit code.
park_or_halt() {  # id, code, reason
  local id="$1" code="$2" reason="${3:-}"
  if [[ "$KEEP_GOING" == "1" ]]; then
    log "  [$id] ${reason} (exit $code) — KEEP_GOING: parking auto/$id as [blocked], continuing."
    set_state "$id" blocked; BLOCKED=$((BLOCKED+1))
    # leave the worktree + branch intact for review/rollback; never merge red work.
  else
    log "  [$id] ${reason} (exit $code) — halting."
    set_state "$id" failed; FAILED=1; HALT_CODE="$code"
  fi
}

handle_exit() {  # id, code
  local id="$1" code="$2" plog="${PLOG[$id]}"
  case "$code" in
    0|5|6)
      # DONE_ rename present -> success -> merge. Absent -> the worker stopped short
      # (claude -p exits 0 regardless of intent) -> supervisor, not a hard halt.
      if branch_has_done "$id"; then
        merge_phase "$id"; forget "$id"
      else
        supervise "$id" 6   # carry 6 (no-DONE_) so an exhausted supervisor halts non-zero
      fi ;;
    2) park_or_halt "$id" 2 "worker reported CHECKPOINT"; forget "$id" ;;
    4) park_or_halt "$id" 4 "worker reported dependency error"; forget "$id" ;;
    *)
      if is_rate_limited "$plog"; then
        log "  [$id] rate-limit-shaped exit; relaunch after cooldown."
        cool_down "$plog"; mark_resume "$id"; set_state "$id" pending; forget "$id"; return
      fi
      if is_transient_api_error "$plog" && retry_transient_api "$id"; then forget "$id"; return; fi
      park_or_halt "$id" "$code" "worker exited $code"; forget "$id" ;;
  esac
}

cool_down() {  # parse a retry hint from a log tail and sleep
  local plog="$1" secs="$DEFAULT_RATE_LIMIT_SLEEP" hint n unit
  hint=$(tail -120 "$plog" | grep -oiE "(retry|wait|available|reset)[^0-9]*[0-9]+[[:space:]]*(second|minute|hour)" | head -1)
  if [[ -n "$hint" ]]; then
    n=$(grep -oE "[0-9]+" <<<"$hint" | head -1); unit=$(grep -oiE "second|minute|hour" <<<"$hint" | head -1)
    case "$unit" in second*) secs="$n";; minute*) secs=$((n*60));; hour*) secs=$((n*3600));; esac
  fi
  log "  Rate-limit cooldown: ${secs}s"; sleep "$secs"
}

finish_keep_going() {  # mark stranded pendings [blocked] and log a summary
  while IFS=$'\t' read -r st id _deps; do
    [[ "$st" == "pending" ]] && {
      set_state "$id" blocked; BLOCKED=$((BLOCKED+1))
      log "  [$id] stranded behind a blocked dependency — marked [blocked]."
    }
  done < <(order_lines)
  local merged blocked blist
  merged=$(order_lines | awk -F'\t' '$1=="merged"{c++} END{print c+0}')
  blocked=$(order_lines | awk -F'\t' '$1=="blocked"{c++} END{print c+0}')
  blist=$(order_lines | awk -F'\t' '$1=="blocked"{printf "%s ", $2}')
  log "KEEP_GOING finished: ${merged} merged, ${blocked} blocked."
  [[ -n "$blist" ]] && log "  Blocked (review parked auto/<id> branches where a build started): ${blist}"
}

# Kill a running worker and re-pend it for a clean relaunch (no supervisor spend).
# Reaps the subshell so it doesn't linger as a zombie.
poke_worker() {  # id, reason
  local id="$1" reason="${2:-poke}"
  [[ -n "${PID[$id]:-}" ]] || { log "  [$id] $reason ignored — not running."; return 1; }
  log "  [$id] $reason — killing + relaunching worker."
  kill_tree "${PID[$id]}"; wait "${PID[$id]}" 2>/dev/null
  unset 'STUCK_SIZE[$id]' 'STUCK_SINCE[$id]'
  mark_resume "$id"; set_state "$id" pending; forget "$id"
}

# Watchdog: relaunch any running worker whose raw event STREAM has not grown for
# STUCK_TIMEOUT seconds. Progress = stream-json byte growth, which counts extended
# "thinking" (thinking_tokens telemetry streams there even before any message or
# tool has completed) — so a worker mid-thought is NOT falsely killed (the rendered
# transcript stays flat during a long think, which used to trip this). Only a truly
# silent stream — a wedged API connection, or a tool/gate command hung past the
# window with no output at all — trips it.
check_stuck() {
  (( STUCK_TIMEOUT > 0 )) || return 0
  local now id sp sz; now=$(date +%s)
  for id in "${!PID[@]}"; do
    sp="${STREAM[$id]:-}"; [[ -f "$sp" ]] || continue
    sz=$(stat -c %s "$sp" 2>/dev/null || echo 0)
    if [[ "${STUCK_SIZE[$id]:-x}" != "$sz" ]]; then
      STUCK_SIZE[$id]="$sz"; STUCK_SINCE[$id]="$now"; continue
    fi
    if (( now - ${STUCK_SINCE[$id]:-$now} >= STUCK_TIMEOUT )); then
      poke_worker "$id" "STUCK: no stream output for ${STUCK_TIMEOUT}s"
    fi
  done
}

# Control seam: the dashboard (or a human) drops a one-line file in $CONTROL_DIR to
# request an action; the DRIVER applies it on its next pass — the web server never
# touches process or manifest state itself (the driver owns both). Filenames:
#   <id>.poke   — kill a running worker and relaunch it (a hung phase)
#   <id>.retry  — re-pend a [blocked] phase so it relaunches
# Phase ids are kebab-case (no dots), so the trailing .action parses unambiguously.
process_control() {
  local f base action id st
  shopt -s nullglob
  for f in "$CONTROL_DIR"/*; do
    base=$(basename "$f"); action="${base##*.}"; id="${base%.*}"
    rm -f "$f"
    case "$action" in
      poke) poke_worker "$id" "CONTROL poke" ;;
      retry)
        st=$(order_lines | awk -F'\t' -v p="$id" '$2==p{print $1}')
        if [[ "$st" == "blocked" ]]; then
          log "  [$id] CONTROL retry — [blocked] -> [pending]."; APIRETRY[$id]=0; set_state "$id" pending
        else
          log "  [$id] CONTROL retry ignored — state is '${st:-unknown}', not blocked."
        fi ;;
      *) log "  CONTROL: unknown action '$action' (file '$base') — ignored." ;;
    esac
  done
  shopt -u nullglob
}

# ── Scheduler ─────────────────────────────────────────────────────────────
window_start=$(date +%s); ticks_in_window=0; iter=0

while (( iter < MAX_ITER )); do
  iter=$((iter+1))

  # Completion: nothing running and every entry merged.
  if [[ "$(running_count)" -eq 0 ]] && all_merged; then
    if ! grep -qE '^\*\*Status:\*\*\s+complete' "$MANIFEST"; then
      sed -i -E 's/^\*\*Status:\*\*\s+.*/**Status:** complete/' "$MANIFEST"
      git add "$MANIFEST" >/dev/null 2>&1; git commit -q -m "chore(loop): all phases merged — complete" >/dev/null 2>&1 || true
      git push origin "$BASE_BRANCH" >>"$LOG_FILE" 2>&1 || true
    fi
    log "All phases merged after $iter passes. Exiting 0."; exit 0
  fi

  # Reap finished workers (non-blocking). handle_exit decides merge / park /
  # supervise / halt; in halt mode it sets FAILED + HALT_CODE for the terminal.
  for id in "${!PID[@]}"; do
    if ! kill -0 "${PID[$id]}" 2>/dev/null; then
      wait "${PID[$id]}"; code=$?
      log "REAP [$id] worker exit=$code"
      handle_exit "$id" "$code"
    fi
  done

  # Apply any UI/CLI control requests, then watchdog the still-running workers.
  process_control
  check_stuck

  # Manifest checkpoint marker (policy pause) — bypassed by IGNORE_LOOP_CHECKPOINTS or KEEP_GOING.
  if [[ "$IGNORE_LOOP_CHECKPOINTS" != "1" && "$KEEP_GOING" != "1" ]] && grep -qE '^<!--\s*LOOP-CHECKPOINT:' "$MANIFEST"; then
    if [[ "$(running_count)" -eq 0 ]]; then
      log "LOOP-CHECKPOINT reached; remove the marker and re-run. Exiting 2."; exit 2
    fi
  fi

  # Usage window roll + launch gating.
  now=$(date +%s); age=$((now-window_start))
  if (( age >= USAGE_WINDOW_SECONDS )); then window_start=$now; ticks_in_window=0; age=0; fi
  usage_pct=$((100 * ticks_in_window / MAX_TICKS_PER_WINDOW))
  launch_paused=0
  (( usage_pct >= USAGE_THRESHOLD_PCT )) && launch_paused=1

  # Launch eligible phases up to the cap (unless a failure froze new launches).
  if (( ! FAILED && ! launch_paused )); then
    merged_ids=" $(order_lines | awk -F'\t' '$1=="merged"{print $2}' | tr '\n' ' ') "
    while IFS=$'\t' read -r st id deps; do
      [[ "$st" == "pending" ]] || continue
      [[ -n "${PID[$id]:-}" ]] && continue
      (( $(running_count) >= MAX_PARALLEL )) && break
      # deps satisfied?
      ok=1
      for d in $deps; do [[ "$merged_ids" == *" $d "* ]] || { ok=0; break; }; done
      (( ok )) || continue
      launch "$id"; ticks_in_window=$((ticks_in_window+1))
      merged_ids="$merged_ids"   # unchanged; running != merged
    done < <(order_lines)
  fi

  # Terminal detection (nothing running this pass).
  if [[ "$(running_count)" -eq 0 ]]; then
    if all_merged; then continue; fi                 # completion handled at loop top
    if (( FAILED )); then
      log "Halt: a phase failed (exit ${HALT_CODE:-5}); no workers remain."; exit "${HALT_CODE:-5}"
    fi
    if (( launch_paused )); then
      sleep_secs=$((USAGE_WINDOW_SECONDS - age + 60))
      log "Usage at ${usage_pct}%; nothing running; sleeping ${sleep_secs}s for window reset."
      sleep "$sleep_secs"; window_start=$(date +%s); ticks_in_window=0; continue
    fi
    # Nothing running, not all merged, nothing eligible: remaining pendings are
    # stranded behind blocked/failed deps.
    if [[ "$KEEP_GOING" == "1" ]]; then
      finish_keep_going
      (( BLOCKED > 0 )) && exit 8 || exit 0
    fi
    log "No running workers and no eligible pending phase — dependency deadlock or malformed manifest. Exiting 3."
    exit 3
  fi

  sleep "$POLL_SECONDS"
done

log "Hit MAX_ITER ($MAX_ITER) scheduling passes without completion. Exiting 7."
exit 7
