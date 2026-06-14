#!/usr/bin/env bash
#
# Build the autonomous-runner image (idempotent) and launch the
# execution loop inside it, mounting the repo + the host's Claude /
# git / SSH credentials so the container can act as you.
#
# Usage: bash claudopilot/run-in-docker.sh [--shell]
#
#   --shell   Drop into bash inside the container instead of starting
#             the loop. Useful for inspecting state / re-running the
#             loop manually after a CHECKPOINT halt.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

IMAGE_TAG="${CLAUDOPILOT_IMAGE_TAG:-claudopilot-runner}"
DOCKERFILE="claudopilot/Dockerfile"

HOST_UID=$(id -u)
HOST_GID=$(id -g)

echo "[run-in-docker] Building $IMAGE_TAG from $DOCKERFILE (uid=$HOST_UID gid=$HOST_GID)..."
docker build \
  -t "$IMAGE_TAG" \
  -f "$DOCKERFILE" \
  --build-arg "HOST_UID=$HOST_UID" \
  --build-arg "HOST_GID=$HOST_GID" \
  .

# ── Isolated mode ───────────────────────────────────────────────────────────
# The orchestrator (run-loop.sh: scheduling, merges, the SSH key, the only pushes)
# runs HERE on the host — trusted bash, never the agent. Each phase runs in its
# OWN disposable container (cp-w-<id>) against a per-phase clone, with Claude auth
# but NO git push credentials. The host needs git + docker; the just-built image is
# used for the worker containers. Auth (ANTHROPIC_API_KEY or ~/.claude) is forwarded
# to each worker container by the orchestrator.
if [[ "${1:-}" == "--isolated" ]]; then
  if [[ -z "${ANTHROPIC_API_KEY:-}" && ! -d "$HOME/.claude" ]]; then
    echo "[run-in-docker] ERROR: isolated mode needs Claude auth for the worker containers." >&2
    echo "[run-in-docker]   export ANTHROPIC_API_KEY=sk-ant-... or run \`claude\` once to create ~/.claude." >&2
    exit 1
  fi
  echo "[run-in-docker] Isolated mode: orchestrator on the host; agents in per-phase containers."
  echo "[run-in-docker]   Each agent gets a disposable clone + Claude auth, NO git push creds; the host pushes."
  exec env CLAUDOPILOT_ISOLATED=1 WORKER_IMAGE="$IMAGE_TAG" REPO_ROOT="$REPO_ROOT" \
       bash "$REPO_ROOT/claudopilot/run-loop.sh"
fi

# Container runs as the `runner` user with HOME=/home/runner. All host
# config mounts go there so Claude / git / gh / ssh find their state.

# Optional gh-config mount (only present on hosts that have used `gh`).
GH_MOUNT=()
if [[ -d "$HOME/.config/gh" ]]; then
  GH_MOUNT=(-v "$HOME/.config/gh:/home/runner/.config/gh")
fi

# Optional ssh-config mount (most users have ~/.ssh).
SSH_MOUNT=()
if [[ -d "$HOME/.ssh" ]]; then
  SSH_MOUNT=(-v "$HOME/.ssh:/home/runner/.ssh:ro")
fi

# git config (user.name / user.email). Without this, commits inside the
# container would be authored by uid:gid only (no name / email).
GIT_MOUNT=()
if [[ -f "$HOME/.gitconfig" ]]; then
  GIT_MOUNT=(-v "$HOME/.gitconfig:/home/runner/.gitconfig:ro")
fi

# Claude authentication — two supported modes:
#
#   1. API token (recommended for headless/CI): export ANTHROPIC_API_KEY
#      before launching. It is forwarded into the container (see the
#      `-e ANTHROPIC_API_KEY` below) and the headless `claude -p` workers
#      authenticate with it — no interactive login required.
#          ANTHROPIC_API_KEY=sk-ant-... bash claudopilot/run-in-docker.sh
#
#   2. Interactive login: a prior `claude` login on the host, mounted from
#      ~/.claude + ~/.claude.json. Used when ANTHROPIC_API_KEY is unset.
#
# If ~/.claude exists it is mounted in EITHER mode (so your memory + MCP
# config come along); it is only REQUIRED when no token is provided. With a
# token, the key takes precedence for auth.
CLAUDE_MOUNT=()
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "[run-in-docker] Auth: ANTHROPIC_API_KEY (forwarded into the container)."
  [[ -d "$HOME/.claude" ]]      && CLAUDE_MOUNT+=(-v "$HOME/.claude:/home/runner/.claude")
  [[ -f "$HOME/.claude.json" ]] && CLAUDE_MOUNT+=(-v "$HOME/.claude.json:/home/runner/.claude.json")
else
  if [[ ! -d "$HOME/.claude" || ! -f "$HOME/.claude.json" ]]; then
    echo "[run-in-docker] ERROR: no ANTHROPIC_API_KEY set and no interactive login found." >&2
    echo "[run-in-docker] Either: export ANTHROPIC_API_KEY=sk-ant-... and re-run," >&2
    echo "[run-in-docker]   or run \`claude\` once on the host to create ~/.claude + ~/.claude.json." >&2
    exit 1
  fi
  echo "[run-in-docker] Auth: mounted interactive login (~/.claude)."
  CLAUDE_MOUNT=(
    -v "$HOME/.claude:/home/runner/.claude"
    -v "$HOME/.claude.json:/home/runner/.claude.json"
  )
fi

CMD=(bash -c "cd /work && bash claudopilot/run-loop.sh")
if [[ "${1:-}" == "--shell" ]]; then
  CMD=(bash)
fi

echo "[run-in-docker] Launching $IMAGE_TAG (Ctrl-C to stop)..."
# --ipc=host  : Chromium needs host IPC to avoid /dev/shm OOM crashes
#               during Vitest browser-mode tests. Same requirement as
#               the sibling Dockerfile's CMD-line note.
# --shm-size  : Belt-and-braces for browsers if --ipc=host is unavailable.
docker run --rm -it --init \
  --name "$IMAGE_TAG" \
  --ipc=host \
  --shm-size=2g \
  -v "$REPO_ROOT:/work" \
  "${CLAUDE_MOUNT[@]}" \
  "${GIT_MOUNT[@]}" \
  "${SSH_MOUNT[@]}" \
  "${GH_MOUNT[@]}" \
  -e ANTHROPIC_API_KEY \
  -e IGNORE_LOOP_CHECKPOINTS \
  -e MAX_TICKS_PER_WINDOW \
  -e USAGE_THRESHOLD_PCT \
  -e GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes" \
  "$IMAGE_TAG" \
  "${CMD[@]}"
# GIT_SSH_COMMAND notes:
#   No -p flag — any non-default port (and ProxyCommand failover, LAN
#   vs VPN alternates, etc.) should live in the host's ~/.ssh/config,
#   which is mounted read-only into the container. Setting -p here
#   would override that alias's port and bypass the failover logic.
#   StrictHostKeyChecking=no + UserKnownHostsFile=/dev/null
#       — bypass known_hosts entirely. Trade-off: no MITM detection.
#         Acceptable here because the runner typically connects to a
#         small set of known hosts whose SSH key is already mounted
#         from the host. Belt-and-braces for the read-only ~/.ssh
#         mount that breaks `accept-new` (which tries to write to
#         known_hosts).
#   LogLevel=ERROR
#       — suppress the "Warning: Permanently added..." noise that the
#         disabled host-checking would otherwise generate.
#   BatchMode=yes
#       — never prompt for passphrases. Required for autonomous runs.
#         The mounted private key must be passphrase-less (or use
#         ssh-agent forwarding, which this wrapper does not set up).
