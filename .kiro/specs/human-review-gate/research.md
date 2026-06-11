# Research & Design Decisions — human-review-gate

## Summary
- **Feature**: `human-review-gate`
- **Discovery Scope**: Extension (integration-focused light discovery; no new external dependencies)
- **Key Findings**:
  - The execution loop is promise-per-context with `Promise.race` scheduling; the collaboration-wait mechanism (`pendingCollaborations` + `waitForPendingCollaborationProgress`, `execution-loop.ts:242-269`) is a proven precedent for parking a context on an external signal and is directly reusable as the gate-wait pattern.
  - Workflow control endpoints already exist at `/api/projects/[name]/sessions/[session]/graph-workflow/{pause,resume,abort,reset-context}` with a shared `GraphWorkflowExecutionRouteDeps` DI surface (`execution-route-handlers.ts:312-359`) — the approval endpoint slots in unchanged.
  - `reopenTasksAfterContextValidationFailure()` (`iteration-orchestrator.ts:669-749`) increments `consecutiveFailureCount` internally, so human rejections cannot blindly reuse it; the script validator's inline-remediation-task pattern is the better-fitting precedent for free-form human feedback.
  - Workflow iteration conversations are read-only today (`IterationReadonlyBanner` in `PromptInputSlot.tsx`); allowing chat while gated requires a deliberate exception in both the prompt slot and any server-side prompt guard.
  - Conversation `status` is contended between the SDK driver and any engine writer; deriving the gate's Needs-Input standing from `session.graphWorkflowExecution` in the active-conversations route handler avoids the contention entirely.

## Research Log

### Collaboration wait as parking precedent
- **Context**: A gated context must idle without blocking independent parallel contexts, survive restarts, and wake on an external signal.
- **Sources Consulted**: `src/lib/workflow-graph/execution-loop.ts:182-269, 695-707, 1222-1344`; `src/lib/workflows/schemas.ts:592-602`.
- **Findings**: `pendingCollaborations` is an execution-level record keyed by contextId; the context runner returns early when a pending entry exists; the outer loop awaits `waitForPendingCollaborationProgress()` (injected, default ~1s poll) then refreshes execution state via `workflowManager.getActive()`.
- **Implications**: The gate adopts the same shape: a persisted pending-approval record, a poll-based wait helper with injected deps, and state refresh via the execution repository. No event bus needed.

### Validation orchestration and failure accounting
- **Context**: Rejection must consume an iteration but not trip the circuit breaker (requirements 5.4, 5.5).
- **Sources Consulted**: `iteration-orchestrator.ts:669-749 (reopen), 735-736+831 (consecutiveFailureCount), 1170-1264 (finalizeIterationResult), 1457 (iterationCount)`; `execution-loop.ts:732-755 (circuit breaker gate)`.
- **Findings**: `iterationCount` increments when an iteration is seeded; `consecutiveFailureCount` increments inside the reopen/script-failure paths; the circuit-breaker gate reads `consecutiveFailureCount` in the loop. The script validator creates an inline remediation task on failure rather than reopening mapped tasks.
- **Implications**: A rejection that creates a remediation task and re-enters the iteration loop consumes an iteration through the existing seeding increment and never touches `consecutiveFailureCount` — both accounting requirements fall out of composition rather than new bookkeeping.

### Conversation status contention
- **Context**: The gated conversation must sit in Needs Input, but chat is allowed while gated (requirement 6), and the SDK driver writes `conversation.status` during chat turns.
- **Sources Consulted**: `src/lib/prompt` ask-user-question tool (`ask-user-question-tool.ts:54-102`), `state-store/store.ts:201-245 (mutateConversation)`, `active-conversations/route-handlers.ts:368-706`, `NotificationListener.tsx:278-365`.
- **Findings**: If the engine wrote `status: "waiting_for_input"`, the next chat turn would overwrite it (running → awaiting) and silently drop the conversation out of Needs Input. The active-conversations route handler already reads `session.graphWorkflowExecution` (line 504).
- **Implications**: Derive a `pendingApproval` field on the active-conversation payload from execution state instead of writing conversation status. Needs-Input standing then survives any number of chat turns, and notifications fire from a dedicated gate SSE event rather than the conversation-status event.

### Control API and concurrency guarantees
- **Context**: First decision wins (requirement 7.3); stale submissions must 409 (7.2).
- **Sources Consulted**: `execution-route-handlers.ts:312-554`, `execution-repository.ts:160-192 (mutateActive)`, state-store write queue.
- **Findings**: `mutateActive()` runs through the serialized write queue, so a check-and-set inside one mutation is atomic; existing routes resolve project/session via `resolveSession()` and return typed error envelopes.
- **Implications**: The resolve-approval handler performs guard checks (active execution, context awaiting approval, no prior decision) inside a single `mutateActive` mutation — concurrency safety is free.

### UI integration surfaces
- **Context**: Approval panel must render in the conversation prompt area and peek popover, alongside (not replacing) the composer; approvals sort to the top of Needs Input.
- **Sources Consulted**: `PromptInputSlot.tsx`, `PeekPopover.tsx:223-480`, `ConversationSidebar.helpers.ts:127-425`, `conversations/mutations.ts:313-366`, `conversations/query-keys.ts`, `NotificationListener.tsx:653-751`, `session-workflow/components/ExecutionStatusBar.tsx`, `ExecutionInspectorPanel.tsx`, `ConversationBanners.tsx`.
- **Findings**: `splitNeedsYou()` buckets rows into questions/finished/others; `pinnedSections()` renders Needs-you sections first. `AskQuestionPanel` (in `src/components/`, shared by prompt slot and peek) is the placement precedent for a shared panel. `useAnswerQuestionMutation` shows the mutation + `conversationKeys.active()` invalidation pattern. `PromptInputSlot` currently renders `IterationReadonlyBanner` for workflow-managed conversations — the gate must except this. Workflow status badges use status-string CSS classes (`wb-exec-badge.<status>`).
- **Implications**: Add an `approvals` bucket sorted first in `splitNeedsYou`; share one `ApprovalGatePanel` component from `src/components/`; follow the existing mutation/invalidation pattern; extend status badge maps with `awaiting_approval`.

### Persistence durability
- **Context**: Pending gates must survive restart (requirement 7.1); project steering mandates round-trip durability contracts for new persisted fields.
- **Sources Consulted**: `state-store/sessions-repo.contract.test.ts:96-187`, `shared/testing/round-trip-durability.ts`, memory note "shared state DB across branches".
- **Findings**: `graphWorkflowExecution` persists wholesale on the session row; `makeFullSession()` is the maximal fixture. New fields with `.nullable().default(null)` parse old rows cleanly. Rows written with the new `awaiting_approval` enum value will be quarantined (not crash) when read by main during parallel-branch development.
- **Implications**: Extend the maximal fixture with an `awaiting_approval` context and pending-approval record; no data migration needed; cross-branch quarantine behavior is acceptable and already handled.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Sibling gate config + dedicated `awaiting_approval` context state (chosen) | `humanApprovalGate` joins `scriptValidator`/`contextValidator` in the config cascade; context parks in a persisted waiting state; endpoint records a decision the loop applies | Composes existing primitives (cascade, collaboration-wait, remediation task, write queue); restart-safe; parallel contexts unaffected | New status value ripples through ~6-8 guard sites; loop gains one wait stage | Mirrors how scriptValidator already sits beside the agent validator |
| `type: "human"` variant in the agent-validator union | Gate configured as "the" context validator | Zero new config slots | Structurally wrong: the union selects ONE validator, but the gate runs in addition to the agent validator → forces union→array refactor of resolve-config, orchestrator, and existing definitions | Rejected in discovery |
| Workflow-level `paused` + collaboration machinery | Pause whole execution at gate | Smallest engine delta | Stalls independent parallel contexts (violates requirement 2.4); conflates user pause with gating | Rejected in discovery |

## Design Decisions

### Decision: Derive Needs-Input standing instead of writing conversation status
- **Context**: Requirement 6 allows chat while gated; the SDK driver owns `conversation.status` during chat turns.
- **Alternatives Considered**:
  1. Engine writes `status: "waiting_for_input"` + synthetic pendingQuestions — simplest reuse of existing sidebar logic.
  2. Derive a `pendingApproval` field on active-conversation payloads from `session.graphWorkflowExecution`.
- **Selected Approach**: Option 2. The active-conversations route handler maps `contextState.status === "awaiting_approval"` + `pendingApproval.conversationId` to a `pendingApproval` field; the sidebar treats that field as a Needs-you bucket sorted first.
- **Rationale**: Option 1 loses the gate standing on the first chat turn (driver overwrites status) and risks colliding with real AskUserQuestion state. Derivation has a single source of truth — the persisted execution state.
- **Trade-offs**: Sidebar/peek/notification code must consult a new field rather than getting behavior for free from `status`; notifications need a dedicated SSE event.
- **Follow-up**: Verify no other consumer assumes Needs-you membership implies `status === "waiting_for_input"`.

### Decision: Rejection creates an inline remediation task
- **Context**: Requirement 5 routes the rejection message into the next iteration; `reopenTasksAfterContextValidationFailure` increments `consecutiveFailureCount` (forbidden for rejections by 5.5) and needs per-task failure mapping that free-form human feedback doesn't have.
- **Alternatives Considered**:
  1. Reopen all context tasks with the rejection message as failure history on each.
  2. Parameterize the reopen function with `countTowardCircuitBreaker: false`.
  3. Create one inline remediation task carrying the message (script-validator precedent).
- **Selected Approach**: Option 3. Rejection appends a pending task ("Address human review feedback") whose description is the rejection message, returns the context to `running`, and lets the existing iteration seeding increment `iterationCount`.
- **Rationale**: Matches the established pattern for non-task-mapped failures; keeps every task's `failureHistory` clean; satisfies 5.4/5.5 through composition with zero new accounting code.
- **Trade-offs**: The context's task list grows by one per rejection; requirement 5.2 was reworded to be mechanism-neutral ("return the context to active implementation") since no existing tasks are literally reopened.
- **Follow-up**: Ensure completion counting (`totalTaskCount`/`completedTaskCount`) updates when the remediation task is appended, as the script-validator path already does.

### Decision: Endpoint records the decision; the execution loop applies it
- **Context**: Approve must run the existing merge/commit path; reject must re-enter the iteration loop. Both live inside the context runner.
- **Alternatives Considered**:
  1. Endpoint applies effects inline (sets `completed`, triggers merge).
  2. Endpoint writes `pendingApproval.decision`; the parked context runner polls, applies effects, and clears the record.
- **Selected Approach**: Option 2 (agent-offloading principle: the orchestrator owns transitions). The runner's gate-wait loop mirrors `waitForPendingCollaborationProgress`.
- **Rationale**: Merge machinery, lane commits, halt checks, and iteration seeding are loop-internal; duplicating them in a route handler would fork the orchestrator. A persisted decision also survives a crash between decision and application.
- **Trade-offs**: Up to one poll interval (~1s) of latency between click and visible transition; decision application is asynchronous from the HTTP response.
- **Follow-up**: Wait loop must observe execution status changes (paused/halted/aborted) and exit without resolving; resume must re-enter `awaiting_approval` contexts directly into the gate wait.

### Decision: One resolve-approval endpoint with a discriminated body
- **Context**: Approve and reject share guards (active execution, context awaiting, no prior decision) and differ only in payload.
- **Alternatives Considered**: separate `/approve` + `/reject` routes; single `/resolve-approval` with `decision` discriminator.
- **Selected Approach**: Single `POST .../graph-workflow/resolve-approval` with `z.discriminatedUnion("decision", ...)`; `message` required (min 1) on reject.
- **Rationale**: One guard path, one 409 surface, server-side enforcement of requirement 5.1 via schema.
- **Trade-offs**: Marginally less RESTful than verb-per-route; consistent with existing flat verb routes (`reset-context`).

### Decision: Gate config is `{ enabled: boolean }` in the standard cascade
- **Context**: Requirement 1 needs per-context enablement with workflow-level default, off by default.
- **Selected Approach**: `graphWorkflowHumanApprovalGateConfigSchema = z.object({ enabled: z.boolean().default(false) })`, added to `WorkflowDefaults`, `workflowConfigOverrideSchema`, context definition, planner-tools input, and `resolve-config.ts` with `context ?? workflow ?? defaults` cascade (seeded default `{ enabled: false }`).
- **Rationale**: Identical shape and cascade to `scriptValidator` — no new resolution semantics. Timeouts/delegation deliberately omitted (YAGNI; out of scope).

## Risks & Mitigations
- **Status-enum ripple** (~6-8 guard sites consume context status) — audit `validation.ts` eligibility/landed/lock checks and UI status maps; all are `===` guards, not exhaustive switches; add `awaiting_approval` deliberately at each.
- **Server-side prompt guard may block chat to workflow-managed conversations** — locate the guard in the prompt path and except conversations whose context is `awaiting_approval`; verify in integration tests.
- **Restart normalization could reset a parked context** — `normalizeExecutionAfterRestart` must leave `awaiting_approval` contexts untouched (nothing in-flight to repair); pin with a test.
- **Wait-loop starvation if runner promise is dropped** — the gate wait lives inside the still-in-flight context promise (same as collaboration wait), so `Promise.race` keeps the loop responsive; pin with an execution-loop test where one context gates while another completes.
- **Cross-branch DB quarantine** — rows with `awaiting_approval` written by this branch are unreadable (quarantined, not crashing) on main until merged; accepted, existing read-boundary behavior.

## References
- `.kiro/specs/human-review-gate/brief.md` — discovery brief and resolved Q&A decisions
- `.kiro/steering/engineering-principles.md` — composable primitives, agent-offloading, DI/testing rules
- `.kiro/steering/workflows.md` — workflow orchestration conventions
- `PERFORMANCE.md` — state-store access patterns (focused accessors, write-queue costs)
