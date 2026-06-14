#!/usr/bin/env bash
#
# claudopilot/progress.sh — container-aware progress view.
#
# If a claudopilot-runner container is up, run the progress tool INSIDE it (where
# an --isolated run's state lives — the in-container clone, not the host tree).
# Otherwise run it locally (today's bind-mount model, where the host sees the
# run state directly). Same flags either way:
#
#   bash claudopilot/progress.sh                 # snapshot
#   bash claudopilot/progress.sh --watch         # live multi-agent view
#   bash claudopilot/progress.sh --follow <id>   # stream one agent's transcript
#   bash claudopilot/progress.sh --json          # machine-readable
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${CLAUDOPILOT_IMAGE_TAG:-claudopilot-runner}"

if command -v docker >/dev/null 2>&1 \
   && docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}}' 2>/dev/null | grep -q .; then
  TTY=()
  [ -t 1 ] && TTY=(-t)
  exec docker exec -i "${TTY[@]}" "$CONTAINER" node /work/claudopilot/progress.mjs "$@"
else
  exec node "$SCRIPT_DIR/progress.mjs" "$@"
fi
