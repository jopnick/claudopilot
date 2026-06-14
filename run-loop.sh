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

RUNDIR="$REPO_ROOT/.claudopilot"
WORKTREES="$RUNDIR/worktrees"
LOG_FILE="${LOG_FILE:-$REPO_ROOT/.claudopilot.log}"

cd "$REPO_ROOT"
mkdir -p "$WORKTREES"
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
      printf '%s\t%s\t%s\n' "$st" "$id" "$(echo $deps)"
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
declare -A PID WT PLOG SUPATT STREAM TRANSCRIPT
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
capture_agent() {  # id, prompt
  local id="$1" prompt="$2"
  local plog="$RUNDIR/$id.log" stream="$RUNDIR/$id.stream.jsonl" transcript="$RUNDIR/$id.transcript.md"
  { echo; echo "=== [$id] ${SUPERVISOR_MODE:+supervisor }run (attempt ${SUPATT[$id]:-0}) ==="; } >>"$transcript"
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
    claude -p "$prompt" \
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
    -e WORKTREE_PREPARE_CMD -e SUPERVISOR_MODE \
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
    log "  LAUNCH [$id] (isolated container cp-w-$id; running=$(running_count)/$MAX_PARALLEL) -> ${TRANSCRIPT[$id]}"
    ( run_phase_container "$id" ) >>"$wt/.claudopilot/$id.docker.log" 2>&1 &
    PID[$id]=$!
    return
  fi

  log "  LAUNCH [$id] (running=$(running_count)/$MAX_PARALLEL) -> ${TRANSCRIPT[$id]}"
  (
    cd "$wt"
    capture_agent "$id" "$(worker_prompt)

The phase to execute is: $id
Your working directory is this phase's git worktree on branch auto/$id.
Build, gate, and rename the phase doc to DONE_, then exit 0. Do NOT merge
or edit the manifest — the driver owns those."
  ) &
  PID[$id]=$!
}

running_count() { echo "${#PID[@]}"; }

is_rate_limited() {  # check a per-phase log tail
  tail -120 "$1" 2>/dev/null \
    | grep -qiE "rate.?limit|usage limit|429|too many requests|please (retry|wait)|exceeded.*(quota|limit)"
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
    git merge --abort >>"$LOG_FILE" 2>&1 || true
    park_or_halt "$id" 1 "MERGE CONFLICT (concurrent streams must be package-disjoint)"
    return 1
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
    cool_down "$plog"; set_state "$id" pending; forget "$id"; return
  fi
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
        cool_down "$plog"; set_state "$id" pending; forget "$id"; return
      fi
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
