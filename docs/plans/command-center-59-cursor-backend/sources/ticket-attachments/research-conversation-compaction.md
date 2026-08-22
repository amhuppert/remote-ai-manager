# Compaction — command-center / Cursor Spike / 793c19ff-3805-4e8c-b861-4021f4fc4cd4
fresh · covered seq 0..162 · 10 messages · updated 2026-08-12T18:10:59.808Z

## Agent brief
Cursor third-backend research concluded it is feasible and recommended, beginning with a 2–4 day authenticated transport decision spike (@cursor/sdk isolated Node worker vs ACP child). Interactive conversations estimated ~3 weeks cumulative; production-scoped backend 4–6 weeks cumulative, ±30%; privileged-instruction and exact filesystem-confinement parity remain vendor/security gates. Backend seam is strong: Cursor logic should live under src/lib/agent-backends/cursor/, while bounded registration work, two-backend leak fixes, and two capability extensions are needed. Ticket cc#59 (“Add Cursor as a third agent backend”) was created with collaboration research summary; assistant then started an attachment command, but transcript ends before its outcome.

## Current state — Ticket created; attachment step was initiated but its outcome is not shown.
Goal: Create a Command Center ticket for adding Cursor support and attach the collaboration result and helpful forward-looking notes.

Next best actions:
1. Confirm whether the attachment command completed and attach any missing collaboration artifacts/research snapshot to cc#59.
2. Use cc#59 as the ongoing context hub; begin the authenticated 2–4 day transport decision spike when implementation is approved.

## Decisions
- Proceed with Cursor support only after a 2–4 day authenticated decision spike comparing an isolated @cursor/sdk worker with an ACP child. (proposed) — The biggest unknowns are vendor mechanisms and operational shape, rather than Command Center's backend architecture. [refs: #1 s1]
- Keep Cursor-specific logic contained in src/lib/agent-backends/cursor/ and generalize only bounded registration surfaces, existing two-backend leaks, and declared seam capabilities. — CI-enforced consumer locality and seam ratchets support containment; identified neutral changes address binary assumptions or genuinely missing capabilities. [refs: #7 s84, #7 s84, #7 s84]
- Keep Collaboration Mode out of Cursor support scope; it remains an intentional Claude×Codex pair unless a separate product decision changes it. — Collaboration Mode's backend pair is explicitly a two-backend decision (D19). [refs: #7 s84]
- Create Command Center ticket cc#59, “Add Cursor as a third agent backend,” to retain research context and future updates. — The user requested a durable ticket for collaboration results and relevant ongoing context. [refs: #8 s87, #9 s159]

## Files
- discussed `src/lib/agent-backends/cursor/` — Proposed containment location for Cursor-specific transport, event mapping, continuity, failure classification, and skills-bridge logic. [refs: #7 s84]
- discussed `src/lib/commands/route-handlers.ts` — Contains a pre-existing fallback that maps non-Codex backends to Claude; must be changed to schema validation before introducing Cursor. [refs: #7 s84]
- created `.worktrees/cursor-spike-7ee15b/.cc/temp/cursor-ticket-desc.md` — Temporary ticket-description file created before ticket creation. [refs: #9 s156–157]
- discussed `memory-bank/collaboration/304f213f-a523-4189-ba31-8e86caf32dce/round-1/agent_…` — Collaboration artifact path was targeted for attachment to ticket 59; the transcript truncates the exact path and does not show the command result. [refs: #9 s162]

## Commands
- `cctl ticket create --title "Add Cursor as a third agent backend" --type feature --description "$(cat .cc/…` — succeeded: Created Command Center feature ticket cc#59 (ID ee1f3a9d-c16f-4043-a93b-f300334c11be), status not_started. [refs: #9 s158–159]
- `cctl ticket attach file 59 memory-bank/collaboration/304f213f-a523-4189-ba31-8…` — unknown [refs: #9 s162]

## Open questions
- Which transport should Cursor use: an isolated @cursor/sdk worker or a per-conversation ACP child? [refs: #1 s1]
- Whether Cursor can meet parity requirements for a privileged instruction channel and adversarially verified exact filesystem confinement. [refs: #1 s1, #1 s1]
- Whether the collaboration artifacts and research conversation snapshot were successfully attached to cc#59. [refs: #9 s161–162]

## Omissions
reasoning omitted: yes · large tool outputs elided: 1

