# Phase 01 — contracts / shared types

## Resume notes (read first)

Anything a worker re-entering mid-flight needs up front — known land mines,
supercedence relationships, gotchas. (Delete if none yet.)

## Status

<!-- The worker seeds this from §Sequencing on the first tick, then flips a
     `[ ]` to `[x]` and appends the short SHA on each slice commit. Source of
     truth for "what's left." -->

- [ ] 01.1 — shared types module
- [ ] 01.2 — public API surface

## Goal

What this phase delivers, one paragraph. This is what gets quoted in the
merge-commit subject line.

## Non-goals

Explicit "we are not doing X this phase" — keeps the worker from expanding scope.

## Architecture

Type sketches, diagrams, the design discussion that anchors the slices below.

## Sequencing

Discrete, individually-testable, one-commit-each units of work. The worker walks
this top to bottom; slice ids match the Status checklist exactly.

- **01.1 — shared types module.** …
- **01.2 — public API surface.** …
