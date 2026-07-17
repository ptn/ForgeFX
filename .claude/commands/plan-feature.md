---
description: Plan a feature or fix for this repo — layer placement, affected files, test plan, and the mandatory task-tracking step — without editing anything.
---

Plan the following work, then stop and wait for approval. Do NOT edit any files
during planning.

Request: $ARGUMENTS

Produce a plan with these sections:

1. Goal and acceptance criteria. State the outcome in one or two sentences and
   list concrete, checkable acceptance criteria.

2. Layer placement. ForgeFX is the middle layer: Axis (UI) -> ForgeFX (this
   Fastify server + device interaction) -> forgefx-midi (pure protocol codec).
   - Protocol facts (SysEx encode/decode, opcodes, enums, param tables, address
     models) belong upstream in forgefx-midi. If this change is protocol facts,
     say the plan STARTS with an upstream forgefx-midi change and this repo only
     consumes it.
   - Device interaction, HTTP endpoints, and orchestration belong here.
   - Rendering and UX belong in Axis.

3. Affected areas. Name the relevant directories: `drivers/`, `registry/`,
   `runtime/`, `transport/`, routes in `app.ts`, and `services/`.

4. Exact files. List the specific files you expect to add or change.

5. Test plan. Which mocked suites under `test/` cover the change (or must be
   added). If the change can only be fully validated on hardware, flag a hardware
   verification step explicitly for the maintainer — agents cannot run hardware
   tests (`probe:*` and `sweep-routes.ts` are hardware-exclusive).

6. Task tracking (mandatory — see CLAUDE.md, Task tracking section). Search the
   repo's Plane project for an existing work item; if none exists, note that one
   must be created with goal, why, and acceptance criteria. Move it to In Progress
   when implementation starts. If a hardware verification step is required, note
   "hardware-verify-pending" in the item.

Present the plan and wait for approval. Make no edits.
