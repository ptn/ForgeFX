# NNNN — Short title of the decision

Status: Proposed | Accepted | Superseded | Deprecated
Date: YYYY-MM-DD
Owners: name or role

## Context

What forces are at play — technical, product, or operational? What problem or
constraint prompted a decision? State the facts neutrally; avoid arguing for the
outcome here.

## Decision

The change being made, stated plainly. Prefer "we will …" phrasing.

## Alternatives

The other options considered and why each was not chosen.

## Consequences

What becomes easier and what becomes harder as a result. Include follow-up work,
new constraints, and anything future maintainers must keep in mind.

---

## Using this template

- Copy this file to `NNNN-short-title.md` in `docs/decisions/` and fill it in.
- ADR 0001 and 0002 predate this directory and live at `../api-design.md` and
  `../frontend-stack.md`; do not move or renumber them. New ADRs start at 0003 in
  `docs/decisions/`.
- Never delete an old ADR. When a decision changes, add a new ADR and mark the old
  one `Superseded` (by the new number) or `Deprecated`, leaving its record intact.
