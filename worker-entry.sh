#!/usr/bin/env bash
#
# claudopilot/worker-entry.sh — in-container entrypoint for --isolated runs.
#
# Runs ONE phase's agent (worker or supervisor) inside its own disposable
# container, against the per-phase clone bind-mounted at /work. The orchestrator
# (on the host) wrote the composed prompt to /work/.claudopilot/<phase>.prompt.txt.
# This script installs the clone's deps, then runs `claude -p` with the same
# stream capture as the non-isolated path (raw .jsonl + rendered transcript + log),
# writing into the clone's .claudopilot/ (host-visible via the bind-mount).
#
# The agent commits auto/<phase> locally; it has Claude auth but NO git push
# credentials — the host orchestrator owns all merges and pushes.
set -o pipefail
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

cd /work || { echo "[worker-entry] /work not mounted" >&2; exit 1; }
id="${CLAUDOPILOT_PHASE:?CLAUDOPILOT_PHASE not set}"
d=".claudopilot"
mkdir -p "$d"
plog="$d/$id.log" stream="$d/$id.stream.jsonl" transcript="$d/$id.transcript.md"
prompt_file="$d/$id.prompt.txt"
render="/work/claudopilot/render-stream.mjs"

{ echo; echo "=== [$id] ${SUPERVISOR_MODE:+supervisor }container run ==="; } >>"$transcript"

# Install this clone's dependencies (project-specific; empty = skip).
if [[ -n "${WORKTREE_PREPARE_CMD:-}" ]]; then
  echo "[worker-entry] prepare: $WORKTREE_PREPARE_CMD" >>"$plog"
  eval "$WORKTREE_PREPARE_CMD" >>"$plog" 2>&1 || echo "[worker-entry] WARNING: prepare failed; the agent may need to install." >>"$plog"
fi

# Resume (continue the prior conversation) when the orchestrator passes a session
# id — set after a transient interruption (network/API error, watchdog, poke) so a
# blip costs a pause, not a cold restart that loses in-flight work. Else run fresh.
RESUME_SID="${CLAUDOPILOT_RESUME_SID:-}"
if [[ -n "$RESUME_SID" ]]; then
  echo "[worker-entry] resuming session $RESUME_SID" >>"$plog"
  claude --resume "$RESUME_SID" -p "A transient interruption (network/API error, watchdog, or poke) stopped you mid-run and your session has now been resumed — your prior context is intact. Re-read the ## Status checklist in your phase doc, then continue from the first unchecked slice. Same contract: build each remaining slice, keep the gate green, rename the phase doc to DONE_ when all slices are done, then stop. Do NOT re-seed the checklist, merge, or edit the manifest." \
      --permission-mode bypassPermissions --verbose --output-format stream-json 2>>"$plog" \
    | tee -a "$stream" \
    | node "$render" \
    | tee -a "$transcript" >>"$plog"
else
  [[ -f "$prompt_file" ]] || { echo "[worker-entry] missing $prompt_file" >&2; exit 1; }
  claude -p "$(cat "$prompt_file")" \
      --permission-mode bypassPermissions --verbose --output-format stream-json 2>>"$plog" \
    | tee -a "$stream" \
    | node "$render" \
    | tee -a "$transcript" >>"$plog"
fi
