# 0003 — Claude Code agent tooling and guardrails

Status: Accepted
Date: 2026-07-07
Owners: maintainer

## Context

Agent-assisted development in this repo has hazards that generic tooling does not
account for:

- Hardware access is exclusive. The dev server owns the serial port while running;
  hardware-touching commands (`probe:*`, `sweep-routes.ts`) cannot run
  concurrently and must never be launched by an agent unattended.
- Sensitive files live on disk. Local `.env` files and runtime logs can contain
  configuration that must not be read into responses or committed.
- The codec is a sibling dependency. forgefx-midi is linked via `file:` and holds
  all protocol logic; duplicating that logic here (SysEx, opcodes, enums, param
  tables, address models) is a recurring mistake.
- Task tracking is centralized. The family of repos uses a shared task tracker
  (Plane), and work items must be kept in sync.

We needed guardrails that encode these repo-specific facts so agents behave safely
and consistently.

## Decision

Adopt the family-wide Claude Code baseline for this repo:

- A shared `.claude/settings.json` with conservative permissions: ask-gates on
  hardware-touching and deploy commands, and a deny-list covering secret/log reads
  and writes into `dist/`.
- A `PreToolUse` guard hook that inspects Bash commands before they run.
- Two subagents: `reviewer` (reviews the current diff for layer-boundary,
  browser-safety, route/API, test-coverage, and secret issues) and `test-runner`
  (runs the mocked, hardware-free suite and diagnoses failures).
- A `/plan-feature` command that produces a plan — including layer placement and
  the mandatory task-tracking step — without editing.
- This `docs/decisions/` ADR log. ADR 0001 and 0002 remain in their original files
  (`docs/api-design.md`, `docs/frontend-stack.md`); new ADRs start here at 0003.
- Task tracking is mandatory in Plane. Project identifiers are kept in the
  local-only CLAUDE.md, not in committed files.

## Alternatives

- No agent tooling. Rejected: leaves the repo-specific footguns (exclusive
  hardware, secret files, codec duplication) to recur on every session.
- README-only conventions. Rejected: conventions that are documented but not
  enforced by permissions and hooks get skipped under time pressure.

## Consequences

- Guardrails are enforced by the permission model and the guard hook, not just
  documented.
- Conventions (layer boundaries, test discipline, task tracking) are captured in
  reusable agent and command definitions.
- Local-only files — CLAUDE.md and `.mcp.json` — are gitignored and must be
  recreated per clone from the private family-wide setup guide. A fresh clone has
  the committed tooling here but not the local task-tracker identifiers or MCP
  configuration until those are restored.
