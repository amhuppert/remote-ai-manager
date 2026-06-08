# Research & Design Decisions

## Summary
- **Feature**: `conversation-message-queue`
- **Discovery Scope**: Extension (existing conversation, prompt, runtime, SSE, and UI display subsystems)
- **Key Findings**:
  - The current queue path writes JSONL transcript before delivery and then calls `queueUserInput`; deferred next-turn delivery would duplicate this with the normal `SUBMIT_PROMPT` transcript append.
  - The conversation actor manager already provides XState actions with actor `self`, so queue drain can be an actor-provided action instead of an async guard.
  - Pending queued messages need a durable UI source separate from JSONL transcript; `ConversationState.pendingQueue` plus queue SSE events fits the existing session/conversation cache model.

## Research Log

### Existing queue and transcript ownership
- **Context**: The previous validation found that enqueue transcript writes and normal prompt transcript writes could duplicate queued messages.
- **Sources Consulted**: `src/lib/prompt/queue.ts`, `src/lib/workflows/conversation/actor-implementations.ts`, `src/lib/prompt/transcript.ts`, `src/components/NotificationListener.tsx`, `src/features/session/hooks/use-display-messages.ts`.
- **Findings**:
  - `queueMessage()` appends a user transcript entry before `runtime.queueUserInput()`.
  - `executePromptForMachine()` appends a normal user transcript entry before backend dispatch.
  - `NotificationListener` already consumes `message-appended` and `message-updated` as transcript cache events.
- **Implications**: Enqueue must not write JSONL transcript. Pending display must come from queue state/events. Delivered queued turns must append exactly one JSONL user entry after backend acceptance.

### Drain integration point
- **Context**: The previous validation found the design's async guard wording was not executable.
- **Sources Consulted**: `src/lib/workflows/conversation/machine.ts`, `src/lib/workflows/conversation/manager.ts`, `src/lib/workflows/conversation/runtime-state.ts`, `.kiro/steering/workflows.md`.
- **Findings**:
  - XState guards are synchronous and should stay pure.
  - `manager.ts` already provides fire-and-forget actions and has access to actor `self`.
  - `sendConversationEvent()` rejects events that the current snapshot cannot accept.
- **Implications**: Drain should be an action stub provided by the manager. It can claim queue rows asynchronously and use `self.send()` only when the actor is still in a submit-eligible settled state.

### Delivery recovery semantics
- **Context**: The previous validation found `delivering` recovery was not defined.
- **Sources Consulted**: `src/lib/state-store`, `src/lib/workflows/conversation/manager.ts`, `.kiro/steering/logs.md`.
- **Findings**:
  - State-store writes are serialized, so cancellation and delivery claims can be resolved deterministically.
  - Non-resumable actor snapshots are not generally restored after process restart; a newly started actor is the safe recovery point for stale in-process work.
- **Implications**: Queue service needs `deliveryAttemptId` and a recovery operation that resets abandoned `delivering` rows to `pending` when an actor starts from persisted state or when a route confirms no live actor owns the conversation.

### Pending display and cancellation
- **Context**: Requirement 9 requires cancellation of undelivered queued messages and removal from pending display.
- **Sources Consulted**: `src/stores/session-detail.store.ts`, `src/hooks/use-send-prompt.ts`, `src/features/session/hooks/use-prompt-submission.ts`, `src/lib/conversations/schemas.ts`, `src/lib/api/sse-events.ts`.
- **Findings**:
  - The current client store has optimistic messages but no queue-specific accepted/cancelled/failed states.
  - `messageQueuedEventSchema` only carries text and cannot identify a durable queue row.
  - Session/conversation queries already carry `ConversationState`; adding `pendingQueue` gives reload persistence for pending display.
- **Implications**: Queue events must carry ids and statuses. Cancellation needs a DELETE API, a queue status update event, and client store/projection changes that do not clear `sending`.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Durable queue plus actor-driven drain (selected) | Persist pending rows, display from queue state, claim rows from conversation actor, confirm delivery on backend acceptance | Backend-neutral, recoverable, uses existing actor and state-store primitives | Requires queuedDelivery metadata and new queue events | Best fit for 1.2, 2.3, 4.1, 7.3, 9.2 |
| Enqueue writes transcript and drain suppresses prompt append | Keep current enqueue append, add suppression later | Smaller route change | Leaves orphaned JSONL rows when delivery never happens; hard to show failed state accurately | Rejected |
| External background retry scheduler | Independent queue worker drains all conversations | Could recover without user opening conversation | New orchestrator, conflicts with conversation actor ownership | Rejected per steering |
| Always next-turn for every backend | Remove live Claude delivery | Simpler and uniform | Fails 2.1 | Rejected |

## Design Decisions

### Decision: Pending queue owns pre-delivery display; transcript owns delivered history
- **Context**: Transcript integrity requires pending messages to be visible but not duplicated or orphaned.
- **Alternatives Considered**:
  1. Append transcript at enqueue and suppress later prompt append.
  2. Do not append transcript until delivery confirmation.
- **Selected Approach**: `ConversationState.pendingQueue` is rendered as pending display before delivery. JSONL user transcript is appended exactly once after backend acceptance.
- **Rationale**: Separates pending state from delivered history and avoids duplicate rows.
- **Trade-offs**: UI display now merges two sources: transcript messages and pending queue entries.
- **Follow-up**: Verify message ordering in `use-display-messages.ts` and NotificationListener cache updates.

### Decision: Delivery claim uses `deliveryAttemptId`
- **Context**: Delivery failures and process restarts must not silently lose rows.
- **Alternatives Considered**:
  1. Status-only transitions.
  2. Attempt-scoped transitions.
- **Selected Approach**: `claimNextTurnBatch` marks rows `delivering` and assigns a `deliveryAttemptId`; delivery result transitions require that id.
- **Rationale**: Prevents stale failure handlers from mutating a later retry and enables abandoned delivery recovery.
- **Trade-offs**: Slightly more queue metadata.
- **Follow-up**: Add tests for stale attempt mismatch and recovery.

### Decision: Drain is an XState action, not a guard
- **Context**: The prior design mentioned an async guard, which does not fit the machine conventions.
- **Alternatives Considered**:
  1. Store pending queue count in machine context and guard on it.
  2. Provide a fire-and-forget drain action from `manager.ts`.
- **Selected Approach**: Add `drainPendingQueue` action stub to the machine and provide async logic in `manager.ts` using actor `self`.
- **Rationale**: Keeps guards pure, follows existing `.provide()` action style, and avoids adding queue state to serializable machine context.
- **Trade-offs**: The action must return claimed rows to `pending` if the actor can no longer accept `SUBMIT_PROMPT`.

### Decision: Cancellation is API-visible but minimal
- **Context**: A full edit/cancel UI is out of scope, but 9.1 and 9.2 require cancel support and pending display removal.
- **Alternatives Considered**:
  1. Service-only cancellation.
  2. DELETE endpoint plus queue events and a small UI affordance.
- **Selected Approach**: Add DELETE queue item endpoint, queue status event, and pending-row removal in display projection.
- **Rationale**: Meets the requirement without broad queue management UI.
- **Trade-offs**: Once delivery claim wins, cancellation returns conflict because the system can no longer promise retraction.

### Decision: Build with existing primitives
- **Context**: The feature is reliability and lifecycle integration, not a new queueing platform.
- **Alternatives Considered**:
  1. Add an external queue library or worker.
  2. Use state-store, XState actor, and SSE primitives already present.
- **Selected Approach**: Use existing SQLite state-store persistence, XState actor lifecycle, and SSE cache updates.
- **Rationale**: Aligns with steering and avoids a new orchestrator.
- **Trade-offs**: Delivery happens when the conversation actor is active; no independent background scheduler is introduced.

## Risks & Mitigations
- **Queued image payload size in SQLite** - keep existing image count limits, prune terminal rows, and reuse existing image delivery path.
- **Drain re-entrancy** - state-store claim marks rows `delivering`; concurrent drain attempts find no `pending` rows.
- **Cancellation race** - serialized writes make either cancellation or delivery claim the winner with explicit user-visible result.
- **Transcript order drift** - queued turns append the coalesced user transcript entry before assistant content is processed after backend acceptance.
- **Stale tasks** - regenerate implementation tasks after this revised design because ownership and interfaces changed.

## References
- `.kiro/steering/tech.md` - SQLite source of truth, strict TypeScript, Zod-first schemas.
- `.kiro/steering/structure.md` - domain-owned schemas/services and thin App Router shells.
- `.kiro/steering/workflows.md` - XState `.provide()` action/actor conventions and runtime-state boundaries.
- `.kiro/steering/logs.md` - structured logging module/event conventions and transcript/SSE model.
- `src/lib/prompt/queue.ts` - current transcript-first queue behavior.
- `src/lib/workflows/conversation/manager.ts` - existing actor `self` action provider surface.
- `src/components/NotificationListener.tsx` - existing SSE cache update pattern.
