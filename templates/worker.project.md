# Project cornerstones (this repo) — binding on every slice

> This is the **project prompt overlay**: repo-specific rules the claudopilot
> engine appends to its generic `worker.md`. It stays in your repo; the vendored
> engine under `claudopilot/` does not depend on it. Replace the placeholders
> below with the handful of rules that are non-negotiable in your codebase.

## Cornerstones

These are enforced, not optional. Keep the list short — only what a worker would
otherwise get wrong:

- **<Cornerstone 1>.** e.g. architectural boundary that must not be crossed.
- **<Cornerstone 2>.** e.g. how new behavior is added (extend, don't edit).
- **<Cornerstone 3>.** e.g. a privacy/security invariant that must hold.
- **<Cornerstone 4>.** e.g. a house style rule (naming, no emoji, etc.).

(See `CLAUDE.md` / your contributing guide for the full text if you keep one.)

## This project's quality gate

The exact `GATE_CMD` is injected at the end of your prompt by the engine (from
`claudopilot.config.sh`). For this repo it is:

```
<your gate command, e.g. npm run typecheck && npm run lint && npm test>
```

It must stay green after every slice and must match any pre-commit hook.
