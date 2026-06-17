#!/usr/bin/env bash
#
# Docker e2e smoke for the TypeScript engine — phase-08.2.
#
# Runs `claudopilot run --engine ts --isolated` against a one-phase
# fixture roadmap in a fresh tmp repo, with a stub `claude` baked into
# a derived worker image. Asserts:
#   - process exit 0
#   - the manifest's `**Status:**` line ends as `complete`
#   - the phase doc was renamed to `DONE_*`
#
# The engine's own docker.build is short-circuited by
# CLAUDOPILOT_SKIP_BUILD=1; otherwise it would overwrite the stub image
# we just built from the canonical Dockerfile.

set -euo pipefail

REPO=$(pwd)
TMP=$(mktemp -d -t cp-e2e-XXXX)
trap 'rm -rf "$TMP"' EXIT

echo "==> Build base runner image"
docker build --build-arg HOST_UID="$(id -u)" --build-arg HOST_GID="$(id -g)" \
  -t claudopilot-runner -f "$REPO/Dockerfile" "$REPO"

echo "==> Derive stub-claude test image"
mkdir -p "$TMP/img"
cat > "$TMP/img/claude" <<'STUB'
#!/usr/bin/env bash
# Stub `claude` for the Docker e2e smoke. Performs the worker contract:
# rename the phase doc to DONE_, commit, exit 0. Emits minimal stream-json
# so the renderer is exercised end-to-end.
set -uo pipefail

PROMPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) PROMPT="$2"; shift 2;;
    --resume) shift 2;;
    --permission-mode|--output-format|-m) shift 2;;
    --verbose|--dangerously-skip-permissions) shift;;
    *) shift;;
  esac
done

ID=$(printf '%s' "$PROMPT" | grep -oE 'phase to execute is: [a-z0-9_-]+' | sed 's/.*: //' | head -n1)
[[ -n "$ID" ]] || { echo "stub-claude: no phase id" >&2; exit 1; }

printf '%s\n' '{"type":"system","subtype":"init","session_id":"sid-'"$$"'","model":"stub","tools":[]}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"stub processing '"$ID"'"}]}}'

ROADMAP="${ROADMAP_DIR:-roadmap}"
DOC=$(ls "$ROADMAP"/"$ID"-*.md 2>/dev/null | head -n1)
DONE=$(ls "$ROADMAP"/DONE_"$ID"-*.md 2>/dev/null | head -n1)
if [[ -n "$DOC" && -z "$DONE" ]]; then
  git mv "$DOC" "$ROADMAP/DONE_$(basename "$DOC")"
fi
echo "stub-marker $$" >> .stub-marker
git add -A
git -c user.email=stub@example.com -c user.name=stub commit -q -m "stub: $ID" || true

printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"duration_ms":50,"total_cost_usd":0.0}'
exit 0
STUB
chmod +x "$TMP/img/claude"
UID_HOST=$(id -u)
GID_HOST=$(id -g)
cat > "$TMP/img/Dockerfile" <<DOCKER
FROM claudopilot-runner
USER root
COPY claude /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude
USER ${UID_HOST}:${GID_HOST}
DOCKER
docker build -t claudopilot-runner-ci "$TMP/img"

echo "==> Set up one-phase fixture repo"
FIX="$TMP/repo"
ORIGIN="$TMP/origin.git"
mkdir -p "$FIX" "$ORIGIN"
git -C "$ORIGIN" init --initial-branch=main --bare -q
git -C "$FIX" init --initial-branch=main -q
git -C "$FIX" config user.email "ci@example.com"
git -C "$FIX" config user.name "CI"
git -C "$FIX" config commit.gpgsign false

mkdir -p "$FIX/roadmap" "$FIX/claudopilot/prompts"
cat > "$FIX/roadmap/EXECUTION-MANIFEST.md" <<EOF
# e2e fixture

**Status:** in-progress

## Order

1. [pending] **phase-a** — alpha (deps: none)
EOF
cat > "$FIX/roadmap/phase-a-alpha.md" <<EOF
# phase-a — alpha
trivial.
EOF
cp "$REPO/render-stream.mjs" "$FIX/claudopilot/render-stream.mjs"
cp "$REPO/render-stream-opencode.mjs" "$FIX/claudopilot/render-stream-opencode.mjs"
cp "$REPO/worker-entry.sh" "$FIX/claudopilot/worker-entry.sh"
echo "# e2e worker prompt" > "$FIX/claudopilot/prompts/worker.md"
echo "# e2e supervisor prompt" > "$FIX/claudopilot/prompts/supervisor.md"
cat > "$FIX/claudopilot.config.sh" <<EOF
export GATE_CMD=true
export POLL_SECONDS=1
export MAX_PARALLEL=1
export MAX_ITER=200
EOF
echo ".claudopilot/" > "$FIX/.gitignore"
git -C "$FIX" add -A
git -C "$FIX" commit -q -m "init"
git -C "$FIX" remote add origin "$ORIGIN"
git -C "$FIX" push -q -u origin main
git -C "$FIX" checkout -q -b runner
git -C "$FIX" push -q -u origin runner

echo "==> Run TS engine in isolated mode"
cd "$FIX"
set +e
ANTHROPIC_API_KEY="dummy" \
CLAUDOPILOT_IMAGE_TAG=claudopilot-runner-ci \
CLAUDOPILOT_SKIP_BUILD=1 \
CLAUDOPILOT_WEB=0 \
BASE_BRANCH_EXPLICIT=1 \
node "$REPO/dist/cli.js" run --isolated
CODE=$?
set -e
cd "$REPO"

echo "==> Engine exit code: $CODE"
[[ "$CODE" == "0" ]] || { echo "FAIL: engine exited $CODE (want 0)"; exit 1; }

STATUS=$(grep -E '^\*\*Status:\*\*' "$FIX/roadmap/EXECUTION-MANIFEST.md" | head -n1 | sed -E 's/^\*\*Status:\*\*[[:space:]]+(.*)$/\1/' | tr -d '\r')
[[ "$STATUS" == "complete" ]] || { echo "FAIL: status='$STATUS' (want 'complete')"; exit 1; }

ls "$FIX/roadmap/DONE_phase-a"-*.md >/dev/null 2>&1 || { echo "FAIL: phase doc not renamed to DONE_"; exit 1; }

echo "OK: docker e2e smoke green (exit=$CODE, status=$STATUS, DONE_ renamed)"
