# pilot — claudopilot as a native Claude Code plugin

The [claudopilot](https://github.com/jopnick/claudopilot) execution loop,
reimplemented natively for Claude Code. **No Docker, no `claude -p`
subprocesses, no separate CLI** — the Claude Code session you're already in
*becomes* the driver, and phase work fans out to background agents.

It ships three pieces:

| Piece | Type | Role |
| --- | --- | --- |
| `pilot-run` | skill | The **driver**. Reads `roadmap/EXECUTION-MANIFEST.md`, schedules eligible phases by dependency graph, launches workers, merges green branches serially, owns the manifest, escalates red gates. Also scaffolds a roadmap if none exists. |
| `phase-worker` | agent | Executes **one phase** end-to-end in a driver-prepared git worktree on its `auto/<id>` branch: implements slices, runs the project's gate, commits per slice, renames the phase doc `DONE_`. Never merges. |
| `phase-supervisor` | agent | Unsticks a halted worker with the smallest possible fix, then steps back. Never merges, never authors features. |

## Install

This repo *is* the marketplace. From any Claude Code session:

```
/plugin marketplace add jopnick/claudopilot     # or a local path to this repo
/plugin install pilot@claudopilot
```

New sessions then have the `/pilot-run` skill and the `pilot:phase-worker` /
`pilot:phase-supervisor` agent types available in **any** repo. Run it from the
root of the repo you want to drive:

```
/pilot-run
/pilot-run --max-parallel 4 --keep-going
/pilot-run --only phase-04 --push
```

It's project-agnostic: the gate command, prepare command, and code conventions
are resolved from the target repo at run time (see the skill's *Resolve repo
parameters* section).

## How it relates to the bash engine

This plugin is **contract-compatible** with the [bash/Docker
engine](../README.md): same `roadmap/EXECUTION-MANIFEST.md` grammar, same
`auto/<id>` branches, same `DONE_`-rename done-signal, same driver-owns-merges
invariant. Either driver can resume a manifest the other left off — but never
run both against the same manifest at once.

| | Native plugin (this) | Bash/Docker engine |
| --- | --- | --- |
| Runs in | an interactive Claude Code session | a container / host shell, unattended |
| Worker isolation | git worktree per phase | git worktree, or a disposable container per phase (`--isolated`) |
| Setup | `/plugin install`, nothing else | Node, Docker, `claudopilot init` |
| Progress UI | the session's background-task view + `/workflows` | `claudopilot web` dashboard + `claudopilot progress` |
| Rate limits | handled by the harness | proactive window + reactive backoff in `run-loop.sh` |
| Local / $0 models | — (uses your Claude Code session) | yes, via `AGENT_DRIVER=opencode` + Ollama |
| Best for | day-to-day, hands-on runs | CI, fully-unattended runs, hard container isolation |

The driver's full contract — manifest grammar, the scheduling loop, supervisor
escalation, keep-going semantics, and authoring mode — lives in
[`skills/pilot-run/SKILL.md`](skills/pilot-run/SKILL.md).

## Precedence

A project-local `.claude/skills/pilot-run` (a repo that vendors a specialized
copy) shadows this plugin's skill in that repo, and a `phase-worker` /
`phase-supervisor` in a project's or user's `.claude/agents/` takes priority
over the plugin's copies. That's intentional — repos can ship variants baked
with their own cornerstones.
