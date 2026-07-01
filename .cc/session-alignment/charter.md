## Mission

Establish and enforce a project-wide UI/UX responsiveness contract in CC. Two parts: (1) codify the contract into steering — every mutable action gives immediate visual feedback (optimistic update preferred; visible pending indicator as the floor); background `invalidateQueries` alone is never feedback. (2) Audit **every mutation in the codebase** against that contract and implement the fixes so each mutable action lands on the decision ladder.

## Decisions

- **Home for the policy:** the existing `.kiro/steering/data-fetching-and-sse.md` gets the substantive content (new **Perceived Responsiveness** section), rather than a new steering file.
- **Three-rung decision ladder** (pick the highest that applies):
  1. Optimistic update (default) — client can predict post-mutation state; `onMutate` snapshot + rollback.
  2. Optimistic placeholder — represents the attempt; temp id (`optimistic-<uuid>`) + `pending` status, reconciled by id. Reference: `src/lib/document-comments/mutations.ts`.
  3. Pending indicator (the floor) — genuinely unpredictable/expensive ops; `mutation.isPending` + *visible* in-progress state. Disabling alone does not count.
- **No rung 4:** "mutate → `invalidateQueries` → wait for refetch/SSE repaint" is cache hygiene, not perceived responsiveness.
- **SSE interplay:** optimistic layer is presentation-only; server stays authoritative via `onSettled`/SSE; SSE `setQueryData` handlers must be idempotent (delta-by-id) so mutation-response vs SSE-event ordering doesn't matter.
- **Propagation:** one-line **Responsiveness contract** Key Decision in auto-loaded `tech.md`; `data-fetching-and-sse.md` registered in `CLAUDE.md`'s read-on-demand index.
- **Remediation scope: the full codebase.** Sweep every `src/lib/*/mutations.ts` (and any other mutation site), classify each against the ladder, and fix every one that gives no immediate feedback — plus the call-site indicators they depend on.
- **Missing primitive is in-scope:** `src/components/ui/Button.tsx` has no loading state and there's no shared spinner; add the affordance the ladder's rung 3 requires.

## Constraints

- Steering-principles granularity: capture patterns/rationale, not exhaustive catalogs; additive edits, preserve existing content.
- Red-green TDD for code fixes; optimistic-rollback and pending-state behavior must be covered by tests.
- Stay within the session worktree.
- Follow the project's phased workflow where it applies (see Known ambiguities).

## Non-goals

- No new steering file.
- No backend/API contract changes beyond what a mutation's feedback layer requires.

## Known ambiguities

- **Process:** authoring steering *and* implementing broad code fixes in one session cuts against the phased steering → spec → implementation workflow. Open question whether the full-codebase remediation should be routed through `/kiro-spec-*` (spec'd, then implemented) or done as a direct audit-and-fix pass. Leaning toward at least a lightweight spec given the breadth ("every mutation").

## Relevant sources

- `.kiro/steering/data-fetching-and-sse.md` — Perceived Responsiveness section + existing optimistic-update/cache/SSE guidance.
- `.kiro/steering/tech.md` — Responsiveness contract Key Decision.
- `CLAUDE.md` — read-on-demand steering index entry.
- `.claude/skills/kiro-steering/rules/steering-principles.md` — granularity/preservation rules.
- Mutation sites surveyed so far: `src/lib/document-comments/mutations.ts`, `src/lib/prompt/mutations.ts`, `src/lib/sessions/mutations.ts`, `src/lib/debug-log/mutations.ts`, `src/lib/projects/mutations.ts`; `src/components/NotificationListener.tsx`; `src/components/ui/Button.tsx`. (Full sweep of `src/lib/*/mutations.ts` still to be enumerated.)
