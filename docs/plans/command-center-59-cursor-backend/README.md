# Command Center #59 — Cursor backend handoff

Prepared on 2026-08-14 against Command Center commit
`fa6bf4306f52926be195bef101e09598494dac3e` (`main`).

This bundle is a self-contained handoff for an implementation agent working
outside Command Center. It contains the ticket, the negotiated research, a
proposed design, an execution plan, a current code map, and the project rules
that govern implementation.

## Read in this order

1. `IMPLEMENTATION_BRIEF.md` — objective, settled decisions, scope, and gates.
2. `PROPOSED_DESIGN.md` — proposed runtime/process architecture and seam mapping.
3. `EXECUTION_PLAN.md` — ordered delivery sequence and acceptance evidence.
4. `CODE_MAP.md` — current repository entry points and known closed-world surfaces.
5. `PROMPT_FOR_IMPLEMENTING_AGENT.md` — a ready-to-use kickoff prompt.
6. `sources/ticket-attachments/final-research-answer.md` — authoritative research result.
7. `sources/ticket-attachments/negotiation-audit.md` — explains which early claims were corrected.

The two files named `research-draft-*` are retained as supporting evidence.
They are not authoritative: one initially preferred the SDK, the other ACP.
The negotiated result supersedes both preferences with an authenticated
transport bake-off.

## Important status

- This is a proposed design and handoff, not a record of Requirements/Design/Tasks
  approval under the repository's Kiro workflow.
- The implementation must begin with the standalone unknown-backend validation
  fix and the authenticated 2–4 day transport spike.
- Do not make Cursor user-selectable until the selected transport is stable
  enough to satisfy the Phase 1 acceptance gates.
- Do not claim task, validator, filesystem-confinement, privileged-instruction,
  or Collaboration Mode parity unless the corresponding gates pass.
- Do not add a third permanent transport abstraction after the spike. Keep one
  winning production transport; retain the losing path only as fixtures or
  research evidence if it still has value.

## Using the bundle on another machine

Unzip the bundle outside or inside a fresh Command Center clone. Run the agent
from the repository root, give it this directory, and ensure it reads the live
repository's `AGENTS.md` before changing files. The bundled code map is a
baseline, not a substitute for checking the current checkout for drift.

The authenticated spike needs a Cursor-capable host, a test account, and both
credential paths that are available for evaluation. No credentials or secrets
are included here.

## Contents

- `IMPLEMENTATION_BRIEF.md`, `PROPOSED_DESIGN.md`, `EXECUTION_PLAN.md`,
  `CODE_MAP.md`, `PROMPT_FOR_IMPLEMENTING_AGENT.md`
- `sources/ticket-59.md`
- `sources/ticket-attachments/` — all five ticket attachments, renamed for clarity
- `sources/project-context/` — repository instructions, steering, context, and
  validation registry as of the baseline commit
- `MANIFEST.sha256` — checksums for every bundled file except the manifest itself

