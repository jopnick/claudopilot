# Extracting claudopilot into its own repo

claudopilot is built to split cleanly into a standalone **engine** repo, consumed
by target repos as a git submodule/subtree at `claudopilot/`. The coupling to any
one project is concentrated in two places that **stay in the target repo**.

## Engine vs. project

**Engine (moves to the claudopilot repo — repo-agnostic):**

| File                                         | Role                                                             |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `run-loop.sh`                                | scheduler, dependency graph, merges, build-logs, isolation modes |
| `run-in-docker.sh`                           | image build + launch (`--isolated`, `--shell`)                   |
| `worker-entry.sh`                            | in-container worker/supervisor entrypoint (isolated mode)        |
| `render-stream.mjs`                          | `stream-json` -> readable transcript                             |
| `progress.mjs`, `progress.sh`                | monitor (json / watch / follow), container-aware                 |
| `Dockerfile`                                 | default worker/runner image                                      |
| `prompts/worker.md`, `prompts/supervisor.md` | generic agent contract                                           |

These carry **no** `@app`/`i18n`/`pnpm` references; project specifics arrive via config.

**Project (stays in the target repo):**

| File                                    | Role                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `claudopilot.config.sh` (repo root)     | gate, bootstrap/build/prepare cmds, `ROADMAP_DIR`/`MANIFEST`, prompt overlay, Dockerfile, parallelism |
| `claudopilot/prompts/worker.project.md` | this repo's cornerstones (appended to the generic worker prompt)                                      |
| `roadmap/`                              | the manifest + per-phase docs the run executes                                                        |
| `build-logs/`                           | committed agent transcripts (produced by runs)                                                        |

## Extraction steps

1. Create the `claudopilot` repo; move the **engine** files into it.
2. In each target repo, add the engine as a submodule at `claudopilot/`
   (`git submodule add <url> claudopilot`), pinned to a tag.
3. Keep `claudopilot.config.sh` + `prompts/worker.project.md` in the target repo.
   (If the submodule occupies `claudopilot/`, point `WORKER_PROJECT_PROMPT` and the
   prompt paths at a target-owned dir, e.g. `.claudopilot/prompts/`.)
4. Run as today: `bash claudopilot/run-in-docker.sh [--isolated]`.

## Run modes

- **Default** (`run-in-docker.sh`): the whole loop runs in one container; workers
  are `claude -p` subprocesses in git worktrees. Simple; the host repo is bind-mounted.
- **Isolated** (`run-in-docker.sh --isolated`): the orchestrator runs on the **host**
  (trusted: scheduling, merges, the SSH key, the only pushes); each phase runs in its
  **own** disposable container (`cp-w-<id>`) against a per-phase clone — the agent's
  only writable surface, with Claude auth but **no git push credentials**. The host
  pushes the runner branch + `auto/*` (never `main`).

## Config knobs (env overrides win over `claudopilot.config.sh`)

`GATE_CMD` · `BOOTSTRAP_CMD` · `BUILD_CMD` · `WORKTREE_PREPARE_CMD` · `ROADMAP_DIR` ·
`MANIFEST` · `WORKER_PROJECT_PROMPT` · `SUPERVISOR_PROJECT_PROMPT` · `DOCKERFILE` ·
`MAX_PARALLEL` · `KEEP_GOING` · `CLAUDOPILOT_ISOLATED` · `WORKER_IMAGE`.

Note: in isolated mode the orchestrator runs on the host, so `MANIFEST` must be a
**host** path (not `/work/...`).
