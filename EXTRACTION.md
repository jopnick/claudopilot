# Extracting claudopilot into its own repo

claudopilot is built to split cleanly into a standalone **engine** repo, consumed
by target repos as a git submodule/subtree at `claudopilot/`. The coupling to any
one project is concentrated in two places that **stay in the target repo**.

## Engine vs. project

**Engine (moves to the claudopilot repo — repo-agnostic):**

Host-side (TypeScript, built into `dist/cli.js` — the `claudopilot` binary):

| Module                       | Role                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| `src/cli.ts`                 | `init` / `run` / `progress` / `web` subcommand dispatch        |
| `src/orchestrator/`          | scheduler + supervisor + control + driver loop                 |
| `src/runner/runInDocker.ts`  | image build + launch plan (`--isolated`, `--shell`)            |
| `src/progress/`              | progress model + text/json/follow renderer                     |
| `src/web/server.ts`          | localhost dashboard (SSE + static)                             |
| `src/agent/`                 | `claude` / `opencode` capture + stream renderer                |

Baked into the worker image (built from the package, not vendored into the repo):

| File                                         | Role                                                             |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `dist/cli.js`                                | the bundled CLI; the container runs `claudopilot __worker` per phase |
| `Dockerfile`, `.dockerignore`                | worker/runner image (Playwright + toolchain + the baked CLI)     |
| `web/`                                       | lit-html browser assets, served host-side by `src/web/server.ts` |

Vendored into each target repo's `claudopilot/` on `init` (the only engine files in the repo):

| File                                         | Role                                                             |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `prompts/worker.md`, `prompts/supervisor.md` | generic agent contract (read host-side by the orchestrator)      |

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
4. Run as today: `claudopilot run [--isolated]`.

## Run modes

- **Default** (`claudopilot run`): the whole loop runs in one container; workers
  are `claude -p` subprocesses in git worktrees. Simple; the host repo is bind-mounted.
- **Isolated** (`claudopilot run --isolated`): the orchestrator runs on the **host**
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
