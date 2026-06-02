# Research & Design Decisions — chat-session-spawning

## Summary
- **Feature**: `chat-session-spawning`
- **Discovery Scope**: Extension / Complex Integration (composes existing session-creation, prompt-stream, single-flight, message-queue, and dual Claude+Codex collaboration primitives; adds a new agent-offloading validation pipeline, a new shared first-turn-dispatch primitive, and an inline card UI).
- **Key Findings**:
  - Session creation is already a clean, DI-friendly primitive (`createSessionService` → `provisionSession`) whose `opts.baseBranch` already exists and defaults to `"main"`, so the committed-HEAD spawn base (PLC-31) needs **no new git plumbing** — just the right base ref, and `git worktree add` inherently excludes uncommitted edits.
  - "Agent ready" (PLC-34) is **structurally observable** as "`provisionSession` resolved" (worktree + init script done) followed by `executePromptStream` awaiting the live backend before streaming — so the readiness-gated auto-dispatch needs **no readiness poller / agent bookkeeping**; setup failure (a `provisionSession` rejection) short-circuits before any dispatch, satisfying drop-on-failure.
  - The optimistic flow (`executeOptimisticWorkflow`) is only a *loose template* — a fire-and-forget one-shot bound to a follow-up merge — **not** the reusable exactly-once/drop-on-failure/mode-independent/dual-race first-turn primitive. That primitive does not exist and is built here (and optimistic-mode could later adopt it).

## Research Log

### Existing session-creation primitive
- **Context**: PLC-31 requires full New-Session parity and reuse (no fork), plus the committed-HEAD spawn base.
- **Sources Consulted**: `src/lib/sessions/service.ts` (`createSessionService`, `provisionSession`, `createSessionFast/Focus/Optimistic`), `src/lib/sessions/route-handlers.ts` (`createSession`), `src/lib/sessions/schemas.ts` (`createSessionRequestSchema`, `sessionStateSchema`, `sessionCreationModeSchema`).
- **Findings**: `provisionSession(projectPath, sessionName, { mode, objective, tddEnabled, baseBranch, targetBranch, parentSessionName, … })` does `git worktree add -b <branch> <path> <opts.baseBranch ?? "main">`, runs the init script, persists state, and **rolls back + throws on failure**. The three `create<Mode>` entries funnel through it. `baseBranch` is already a parameter.
- **Implications**: the spawn orchestrator maps each `ProposedSession` to the matching `create<Mode>` and passes `baseBranch = committedHead`. Committed-HEAD base = pass the resolved committed ref; `git worktree add` does not copy uncommitted changes, so PLC-31's "no uncommitted carryover" falls out for free. Sequential creation is required (concurrent `git worktree add` races on `.git/config.lock`, as `bulkDeleteSessions` documents).

### Exactly-once first turn + readiness
- **Context**: PLC-34 demands exactly one first turn once ready, drop-on-failure, mode-independent, riding the existing queue + single-flight.
- **Sources Consulted**: `src/lib/prompt/sdk-driver.ts` (`executePromptStream` get-or-create + actor + backend-live), `src/lib/prompt/single-flight.ts` (`acquireConversationLock`/`isConversationBusy`), `src/lib/prompt/queue.ts` (`queueMessage`), `src/lib/shared/optimistic.ts`.
- **Findings**: `executePromptStream` ensures the conversation actor and backend runtime under a per-conversation single-flight lock before streaming; `provisionSession` seeds exactly one initial conversation (`conversations[0]`). So the first turn targets a single known conversation id, and single-flight guarantees a second concurrent attempt is rejected.
- **Implications**: the new `createFirstTurnDispatcher` rides `executePromptStream` (or `queueMessage` for an already-running actor) under the existing lock — exactly-once is inherited, not re-invented. Readiness is structural (dispatcher invoked only after a successful create). Mode-independence: the dispatch path does not branch on `creationMode`.

### Dual Claude+Codex race
- **Context**: PLC-35 — a dual race seeds both agents with the same `initialPrompt`.
- **Sources Consulted**: `src/lib/workflows/collaboration/manager.ts` (`createCollaborationManager().start`), `src/lib/prompt/sdk-driver.ts` (`hasCollabPrefix`/`stripCollabPrefix`, `/collab` handling), `src/lib/prompt/route-handlers.ts` (collab dispatch), `src/lib/shared/schemas.ts` (`agentBackendSchema` = `claude | codex`).
- **Findings**: the "dual" experience is the asymmetric Claude+Codex collaboration started from a single brief, reachable via the collaboration manager's `start` or the `/collab <brief>` convention `executePromptStream` already understands. Backends are `claude | codex`; "dual" is a UI/creation selector that maps to the race, not a third backend value.
- **Implications**: the spawn-proposal `agent` enum is `claude | codex | dual`; for `dual`, the dispatcher seeds the race with `initialPrompt` as the brief (same exactly-once/drop guarantees). Creation makes a normal session shell; the dual-ness is a first-turn concern.

### Origin tagging + back-link
- **Context**: PLC-32 — tag `from chat`, link back to the spawning PLC; PLC-3 — the PLC persists "links to sessions it spawned".
- **Sources Consulted**: `src/lib/sessions/schemas.ts` (`sessionStateSchema`, `sessionListItemSchema`, `source`, `parentSessionName`), `PERFORMANCE.md` (Patterns 1–3), foundation `design.md` (project-conversation record / write path).
- **Findings**: no existing "spawned from chat / which conversation" concept. Writes happen once at creation (cold path). The foundation already intends a PLC→sessions link (PLC-3).
- **Implications**: additive `spawnedFrom` on the session (surfaced on the slim list item for the status read) + additive `spawnedSessionIds` on the PLC record. One-time focused setters at creation (no `mutate*` churn); passive status read via a focused accessor (no `readState()` on the hot path). The PLC field is the single additive change to a foundation-owned schema and is flagged as a foundation revalidation touchpoint.

### UI mount contract
- **Context**: PLC-29 — inline card in the transcript; the cockpit owns the transcript host.
- **Sources Consulted**: `.kiro/specs/project-conversation-cockpit/brief.md` (transcript host renders spawning's cards; mount contract agreed early), `.kiro/steering/structure.md` (`src/features/_root/` for cross-feature transcript chrome), `.claude/skills/cc-design-system/SKILL.md` rules referenced by steering.
- **Findings**: the cockpit transcript is the mount point; the spawn card is transcript chrome shared into that host. Structure rules place cross-feature chrome under `src/features/_root/`. `/ui-design` + Storybook-first is mandatory.
- **Implications**: the card lives in `src/features/_root/spawn-card/`, mounts via a props/events contract owned by the cockpit, ships a Storybook story, and uses DS tokens only.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Agent-offloading pipeline (chosen) | Agent emits proposal → Zod gate → card review → deterministic orchestrator → existing creation/dispatch primitives | Honors agent-offloading + composable-primitives steering; small surface; testable pure functions; no fork | Requires a clean validator/orchestrator seam | Matches the foundation's own "validate-then-act" posture |
| Agent-driven creation (rejected) | Agent calls a creation tool directly | Fewer hops | Violates agent-offloading (PLC-30); non-deterministic; unsafe | Explicitly forbidden by PLC-30 |
| Fork optimistic-mode for first-turn (rejected) | Copy `executeOptimisticWorkflow` for the spawn dispatch | Quick | Duplicates logic; not exactly-once/drop/dual-aware; violates "reuse, don't fork" | Build the shared primitive instead; optimistic-mode can adopt it later |

## Design Decisions

### Decision: New shared `createFirstTurnDispatcher` primitive on `src/lib/prompt/`
- **Context**: PLC-34/35 need a reusable, readiness-gated, exactly-once, drop-on-failure, mode-independent, dual-race-aware first-turn send; no such primitive exists.
- **Alternatives Considered**: 1) Inline the dispatch in the spawn service — couples spawn to prompt mechanics and blocks reuse. 2) Extend `executeOptimisticWorkflow` — wrong shape (merge-bound one-shot).
- **Selected Approach**: a `createPrompt`-style factory in `src/lib/prompt/first-turn-dispatch.ts` that rides `executePromptStream`/`queueMessage`/single-flight (single agent) or seeds the collaboration race (dual). Invoked only after a successful create.
- **Rationale**: keeps the new concern reusable (optimistic-mode is a flagged future consumer), exactly-once via the existing lock, readiness structural.
- **Trade-offs**: one more module, but a clean seam and no fork.
- **Follow-up**: assert exactly-once with a concurrent double-dispatch test; assert dual seeding via injected `startDualRace`.

### Decision: Committed-HEAD base via the existing `baseBranch` option
- **Context**: PLC-31 — spawned branch from main's committed HEAD, no uncommitted carryover.
- **Alternatives Considered**: 1) New git logic to snapshot/exclude uncommitted edits — unnecessary. 2) Branch from working tree — violates the requirement.
- **Selected Approach**: `resolveCommittedHeadBase(projectPath)` returns the committed HEAD ref; pass it as `provisionSession`'s `baseBranch`. `git worktree add` branches from a commit-ish and never copies uncommitted edits.
- **Rationale**: minimal, correct, reuses the existing parameter.
- **Trade-offs**: none material.
- **Follow-up**: test that the base is a committed ref, never a working-tree ref.

### Decision: Best-effort batch in the orchestrator, not the primitives
- **Context**: PLC-34 — successes kept, failures drop their own prompt, no rollback.
- **Selected Approach**: per-session try/catch in `createChatSpawnService`; failures land in `SpawnResult.failed`; the dispatcher is simply not called for a failed session (prompt dropped); sequential creation to avoid `.git/config.lock` races.
- **Rationale**: keeps the creation/dispatch primitives simple and single-purpose; batch policy lives in one orchestrator.
- **Trade-offs**: sequential creation is slower for large batches but correct.
- **Follow-up**: integration test with A-succeeds/B-fails.

### Decision: Additive `spawnedFrom` (session) + `spawnedSessionIds` (PLC); status read via focused accessor
- **Context**: PLC-32/36 — origin tag + back-link + passive status.
- **Selected Approach**: additive nullable/defaulted fields; one-time focused setters at creation; `getSpawnedSessionStatuses` focused accessor intersecting the PLC's id list with the slim session list (which carries `derivedStatus`); status freshness rides existing session-status SSE.
- **Rationale**: cold-path writes, hot-path-safe reads (PERFORMANCE.md Patterns 1–2); no new status pipeline (PLC-36 = track, don't drive).
- **Trade-offs**: `spawnedSessionIds` is one additive field on a foundation-owned schema (flagged revalidation touchpoint).
- **Follow-up**: extend the focused-read regression test; confirm with the foundation whether it prefers to own the PLC field.

## Risks & Mitigations
- **Proposal emission shape is the foundation's concern** — mitigate by making `extractProposal` accept a candidate object and `safeParse` it; only `extractProposal` changes if the marker changes.
- **Cockpit mount drift** — mitigate by a small, explicit props/events contract owned by the cockpit and flagged as a revalidation trigger; Storybook covers the card independently.
- **`.git/config.lock` contention on batch create** — mitigate by sequential creation (mirrors `bulkDeleteSessions`).
- **Dual seeding coupling to collaboration internals** — mitigate by adapting `initialPrompt`→brief behind an injected `startDualRace`; never touch negotiation logic.

## References
- `memory-bank/project-level-conversations/REQUIREMENTS.md` — PLC-29…36 (source of truth, all questions resolved).
- `.kiro/specs/project-level-conversations/design.md` + `requirements.md` — foundation contracts (conversation/turn, SSE, project-conversation record/write path, sentinel).
- `.kiro/specs/project-conversation-cockpit/brief.md` — transcript mount point (soft UI dependency).
- `src/lib/sessions/service.ts`, `src/lib/sessions/schemas.ts`, `src/lib/sessions/route-handlers.ts` — session-creation primitives reused.
- `src/lib/prompt/sdk-driver.ts`, `src/lib/prompt/single-flight.ts`, `src/lib/prompt/queue.ts`, `src/lib/shared/optimistic.ts` — prompt-stream / lock / queue (first-turn dispatch foundation).
- `src/lib/workflows/collaboration/manager.ts` — dual Claude+Codex race (seeding entry).
- `PERFORMANCE.md` — Patterns 1–3 (focused accessors/setters, parsed-row cache).
