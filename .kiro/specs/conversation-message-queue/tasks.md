# Implementation Plan

- [x] 1. Foundation: queue schemas and shared contracts
- [x] 1.1 Define durable queue domain schemas
  - Define Zod schemas for a pending queued message (id, content blocks, status, lifecycle timestamps, delivery attempt id, attempt count, error) and the client-safe queued message view
  - Define the queue status lifecycle values (pending, delivering, delivered, failed, cancelled) and the queue error code values used by the API and client
  - Derive all TypeScript types through `z.infer`; no hand-written duplicate types
  - Observable: a schema unit test parses a representative pending entry and rejects an entry with an unknown status, and typecheck passes for the derived types
  - _Requirements: 1.2, 1.3, 4.1, 7.3, 9.2_
  - _Boundary: queue schemas_

- [x] 1.2 Add pending queue and queue events to the conversation state schema
  - Add a pending-queue array field to the conversation state schema with an empty-array default so existing conversations migrate without a data backfill
  - Expand the message-queued event schema to carry the queued message view, and add the message-queue-updated event schema
  - Observable: loading a stored conversation that lacks the field yields an empty pending queue, and both queue event schemas validate sample payloads
  - _Requirements: 1.2, 1.3, 9.2_
  - _Depends: 1.1_
  - _Boundary: conversations schemas_

- [x] 1.3 (P) Add queue request and cancellation request schemas
  - Define the enqueue request schema accepting optional text and optional image payloads and rejecting a body with neither text nor images
  - Define the cancellation request/response shapes and the enqueue response carrying the queued message view and the resolved delivery timing
  - Observable: schema validation rejects an empty enqueue body and accepts text-only, image-only, and text+image bodies
  - _Requirements: 1.1, 8.1, 8.3_
  - _Depends: 1.1_
  - _Boundary: prompt schemas_

- [x] 1.4 (P) Add backend queue capability descriptor
  - Provide a static capability source returning, per backend, whether queuing is accepted while running and whether delivery timing is in-turn or next-turn
  - Map Claude to in-turn delivery and Codex to next-turn delivery, and allow a future backend to resolve as unsupported
  - Extend the backend capabilities type only if separate queue-delivery detail is needed beyond the existing while-running flag
  - Observable: a unit test asserts Claude resolves to in-turn delivery and Codex resolves to next-turn delivery
  - Note: no dependency on the queue schema tasks (separate domain); safe to run alongside 1.1–1.3
  - _Requirements: 2.1, 2.2, 5.4, 6.1, 6.2, 6.3_
  - _Boundary: capability descriptor_

- [x] 1.5 Register queue events in the SSE plumbing
  - Add the queue-created and queue-updated events to the SSE event union
  - Classify both queue events under conversation scope in the session status bus
  - Observable: the SSE event union validates a sample queue-created and queue-updated payload and the status bus routes both to the conversation scope
  - _Requirements: 1.3, 2.4, 9.2_
  - _Depends: 1.1, 1.2_
  - _Boundary: SSE event union, session status bus_

- [x] 2. Durable queue service
- [x] 2.1 Implement durable enqueue and active listing
  - Enqueue persists a new pending entry into the conversation pending queue through serialized state-store writes and publishes the message-queued event
  - List active entries returns pending and delivering rows in enqueue order
  - Add structured logging for enqueue using the project logging system
  - Observable: a service unit test shows enqueue persists a pending row that active listing then returns, and the message-queued event is emitted exactly once
  - _Requirements: 1.1, 1.2, 1.3, 4.1, 7.3_
  - _Depends: 1.1, 1.2_
  - _Boundary: queue service_

- [x] 2.2 Implement delivery claims, delivery results, and recovery
  - Claim a single live-delivery entry, and atomically claim all pending entries as one next-turn batch in enqueue order, marking them delivering under one shared delivery attempt id
  - Mark a delivery attempt delivered, return it to pending on recoverable failure, or mark it failed on terminal failure, rejecting any result whose attempt id does not match the current attempt
  - Recover abandoned delivering rows back to pending and emit the matching update events
  - Observable: unit tests show a next-turn claim moves all pending rows to delivering under one attempt id, a mismatched attempt id is rejected, and recovery resets delivering rows to pending
  - _Requirements: 2.2, 3.1, 4.1, 4.2, 4.3_
  - _Depends: 2.1_
  - _Boundary: queue service_

- [x] 2.3 Implement cancellation and order-preserving coalescing
  - Cancel succeeds only for a pending entry and returns a non-cancellable result for delivering, delivered, failed, or cancelled entries
  - Coalesce a set of claimed entries into a single content payload that preserves enqueue order, and emit the message-queue-updated event on cancellation
  - Observable: unit tests show cancellation succeeds on a pending entry and is refused on a delivering or delivered entry, and coalescing concatenates two entries in their original order
  - Caveat: shares the queue service module with 2.2, so it runs after 2.2 as a sequential sibling (not parallel) even though it only depends on 2.1 for data
  - _Requirements: 3.1, 3.2, 9.1, 9.2, 9.3_
  - _Depends: 2.1_
  - _Boundary: queue service_

- [x] 3. Backend runtime delivery acceptance
- [x] 3.1 Add the input-accepted backend event
  - Extend the conversation backend event contract with an input-accepted event emitted before any assistant content for a delivered turn
  - Observable: the backend event union validates an input-accepted event and typecheck passes for its consumers
  - _Requirements: 2.4, 4.1_
  - _Boundary: backend conversation event contract_

- [x] 3.2 (P) Source Claude runtime capability and confirm live input acceptance
  - Source Claude capabilities from the descriptor and guard live queue-user-input so it only runs when the live session can accept input
  - Resolve live queue-user-input only after the input is accepted, emitting/resolving the input-accepted signal before any queue row is marked delivered
  - Observable: a runtime test shows live queue-user-input resolves only after acceptance is signaled
  - _Requirements: 2.1, 4.1_
  - _Depends: 1.4, 3.1_
  - _Boundary: Claude conversation runtime_

- [x] 3.3 (P) Source Codex runtime capability and emit acceptance on dispatch
  - Source Codex capabilities from the descriptor with no live queue-user-input path
  - Emit the input-accepted signal when a normal turn is dispatched so queued next-turn delivery can confirm acceptance
  - Observable: a runtime test shows Codex emits input-accepted on turn dispatch and exposes no in-turn queue path
  - _Requirements: 2.2, 2.4_
  - _Depends: 1.4, 3.1_
  - _Boundary: Codex conversation runtime_

- [x] 4. Conversation machine drain and queued delivery
- [x] 4.1 Add queued delivery metadata to conversation turn types
  - Add optional queued delivery metadata (message ids and delivery attempt id) to the submit-prompt event, the active-turn context, and the execute-prompt input
  - Observable: typecheck passes and a submit-prompt event can carry queued delivery metadata end to end
  - _Requirements: 3.2, 8.2_
  - _Depends: 1.1_
  - _Boundary: conversation machine types_

- [x] 4.2 Add the drain action stub and verify live-continuation handling at settled points
  - Declare a drain-pending-queue action stub invoked at the settled user-submit points where the conversation can start a new turn
  - Verify that a live-delivery continuation signal arriving as a turn settles is accepted and routed to external execution so a Claude in-turn delivery is not dropped
  - Caveat: the settled idle handling already accepts the external-turn-started event; confirm the live-continuation path is preserved at the turn-settled boundary rather than adding a handler on a transient finalizing state that cannot receive events — reconcile the design's finalizingTurn note against the existing idle handler before implementing
  - Observable: a machine test shows a settled state invokes the drain action, and an external-turn-started event delivered at the settled boundary routes to external execution without being dropped
  - _Requirements: 2.3, 4.3_
  - _Depends: 4.1_
  - _Boundary: conversation machine_

- [x] 4.3 (P) Implement queued-delivery execution and transcript policy
  - For queued turns, build the user transcript blocks (including image refs) but append exactly one coalesced user transcript entry only after backend acceptance is confirmed
  - Mark the claimed queue ids delivered only after the transcript append succeeds; on acceptance failure return rows to pending for recoverable errors or failed for terminal errors without appending a transcript entry
  - Keep the normal (non-queued) prompt transcript behavior unchanged
  - Append through the existing transcript module (the sole JSONL writer); do not introduce a second transcript writer
  - Observable: an actor-implementation test shows a queued delivery appends exactly one user transcript entry after acceptance and marks rows delivered, while an acceptance failure appends nothing and returns rows to pending
  - _Requirements: 2.4, 4.1, 4.2, 7.2, 7.3, 8.2_
  - _Depends: 4.1, 2.2, 3.1_
  - _Boundary: actor implementations_

- [x] 4.4 Provide the drain action and startup recovery in the manager
  - Provide the drain action using actor self: claim the next-turn batch, dispatch one submit-prompt carrying the queued delivery metadata, and return the claimed rows to pending if the actor can no longer accept the prompt; no-op for workflow roles and empty queues
  - Run abandoned-delivery recovery before starting an actor from persisted state, and expose an actor-presence check the route can use for recovery
  - Observable: a manager test shows a settled drain dispatches exactly one submit-prompt carrying the claimed delivery attempt id, and startup recovery resets abandoned delivering rows before the first drain
  - _Requirements: 2.2, 2.3, 3.2, 4.3_
  - _Depends: 4.2, 4.3, 2.2, 2.3_
  - _Boundary: conversation manager_

- [x] 5. Prompt queue service and routes
- [x] 5.1 Implement durable prompt enqueue with optional live delivery
  - Replace the transcript-first queuing behavior with durable enqueue through the queue service, never writing a JSONL transcript entry at enqueue time
  - For in-turn backends attempt live delivery and confirm it via backend acceptance; on live-delivery failure leave the row pending for next-turn drain
  - Live-delivery transcript writes go through the existing transcript module (the sole JSONL writer) using the same append-after-acceptance policy as the next-turn path; do not reimplement a separate transcript writer
  - Emit queue events and add structured logging
  - Observable: a unit/integration test shows enqueue writes no transcript entry, an in-turn backend path confirms delivery, and a failed live delivery leaves the row pending
  - _Requirements: 1.1, 2.1, 4.1, 4.2, 5.1, 8.1_
  - _Depends: 2.1, 2.2, 1.4, 3.2_
  - _Boundary: prompt queue service_

- [x] 5.2 Implement the enqueue route with boundary gating
  - Validate the enqueue request, accept text-only/image-only/text+image, and reject an empty payload with the typed empty-message error
  - Gate to running, user-interactive conversations: not-running, non-interactive workflow, and unsupported-backend each return their specific typed error and status code
  - Return the queued message view and the delivery timing on success
  - Observable: a route test shows POST accepts the three valid payload shapes, rejects an empty payload with the empty-message error, and returns the specific typed errors for not-running, non-interactive, and unsupported-backend
  - _Requirements: 1.1, 1.4, 5.1, 5.4, 6.2, 8.1, 8.3, 10.1, 10.2_
  - _Depends: 5.1, 1.3, 1.4_
  - _Boundary: queue route handlers_

- [x] 5.3 Implement the cancellation route and recovery fallback
  - Add the cancellation endpoint and its thin route shell; before evaluating queue state, check for a live actor and run abandoned-delivery recovery when none exists
  - Return cancelled for a pending entry, not-found for a missing entry, and conflict for an already-delivering or delivered entry
  - Observable: a route test shows the exported DELETE shell cancels a pending entry, returns conflict for a delivered entry, and makes a post-restart stale delivering row cancellable after recovery
  - _Requirements: 9.1, 9.2, 9.3_
  - _Depends: 5.1, 2.3, 4.4_
  - _Boundary: queue route handlers_

- [x] 6. Client state, hooks, and display
- [x] 6.1 Add queue actions to the session store
  - Add optimistic, accepted, failed, cancelled, and rollback queue actions that update only queue state and never mutate the running/sending flag
  - Observable: a store test shows a failed queue action rolls back only the queued optimistic entry while leaving the sending flag unchanged
  - _Requirements: 5.2, 5.3_
  - _Depends: 1.1, 1.2_
  - _Boundary: session store_

- [x] 6.2 Forward images and track the accepted queue id in the send hook
  - Forward serialized images to the enqueue request and track the accepted queue id
  - On failure, roll back only the failed queued item while preserving the sending flag
  - Observable: a hook test shows a queue failure removes only the failed item and leaves the running indicator running
  - _Requirements: 5.1, 5.2, 5.3, 8.1, 8.3_
  - _Depends: 6.1, 5.2_
  - _Boundary: send prompt hook_

- [x] 6.3 Decide queue behavior from backend capability in submission
  - Use the active conversation backend capability to choose unavailable vs in-turn vs next-turn handling, route non-running sends to the normal prompt path, and serialize images for queued sends
  - Observable: a hook test shows an in-turn backend and a next-turn backend each take their respective path and an idle conversation uses the normal prompt path
  - _Requirements: 1.4, 2.1, 2.2, 6.3, 10.2_
  - _Depends: 6.2, 1.4_
  - _Boundary: prompt submission hook_

- [x] 6.4 (P) Merge transcript and queue entries into one display projection
  - Merge delivered transcript messages, active pending queue entries, and optimistic queue state into one ordered projection in enqueue order
  - Show pending entries after the in-flight assistant message, remove entries on delivered or cancelled, and never duplicate a queued entry that already has a delivered transcript message
  - Observable: a projection test shows two pending entries appear once each in order and a delivered entry is shown by its transcript row only, with no duplicate
  - _Requirements: 1.3, 4.4, 7.1, 7.2, 7.3, 9.2_
  - _Depends: 6.1, 1.2_
  - _Boundary: display messages hook_

- [x] 6.5 Add the capability-aware composer label and cancellation affordance
  - Show a composer action label reflecting in-turn vs next-turn delivery, and do not present queuing as available for an unsupported backend without an explanation
  - Provide a cancellation affordance for pending queued entries that calls the cancellation endpoint
  - Observable: the composer shows the correct timing label per backend, hides or explains queuing for an unsupported backend, and a pending entry can be cancelled from the UI
  - _Requirements: 5.4, 6.1, 6.2, 6.3, 9.1_
  - _Depends: 6.3, 6.4, 5.3_
  - _Boundary: prompt composer_

- [x] 6.6 (P) Apply queue events in the notification listener
  - Handle the message-queued and message-queue-updated events by updating/invalidating the session-detail and active-conversation caches, and only touch the message caches when delivery produces a message-appended event
  - Observable: a listener test shows a queue event refreshes the pending-queue cache without fabricating a transcript message row
  - _Requirements: 1.3, 2.4, 5.3, 9.2_
  - _Depends: 1.2, 1.5_
  - _Boundary: notification listener_

- [x] 7. End-to-end validation
- [x] 7.1 Verify the Codex next-turn coalescing flow
  - With a Codex turn running, queue two messages, confirm both display as pending in order, the current turn finishes, exactly one next turn starts with one coalesced user transcript entry, and the pending entries disappear
  - Observable: the scenario passes end to end with one coalesced transcript entry and no leftover pending entries
  - _Requirements: 1.3, 2.2, 2.3, 3.1, 3.2, 7.3_
  - _Depends: 4.4, 5.3, 6.5, 6.6_

- [x] 7.2 Verify the Claude in-turn delivery flow
  - With a Claude turn running, queue a message, confirm live delivery is accepted, the pending entry transitions to delivered, and the agent response appears in the current turn
  - Observable: the scenario passes end to end with the pending entry reaching delivered and the agent response persisted and displayed
  - _Requirements: 2.1, 2.4, 4.1_
  - _Depends: 4.4, 5.3, 6.5, 6.6_

- [x] 7.3 Verify the queue failure and cancellation flow
  - Force a queue failure and confirm the optimistic item is removed, the error is surfaced, and the running indicator stays running; separately cancel a pending entry and confirm it disappears and is excluded from the next drained turn
  - Observable: both scenarios pass — failure rolls back only the failed item with running preserved, and a cancelled entry never appears in the next turn
  - _Requirements: 5.1, 5.2, 5.3, 9.1, 9.2, 9.3_
  - _Depends: 4.4, 5.3, 6.5, 6.6_

- [x] 7.4 Verify the queued image delivery flow
  - Queue a message that includes images, confirm pending display, confirm delivery sends the images through the existing image handling, and confirm an image-queue failure surfaces instead of silently dropping the images
  - Observable: the queued image is delivered with its text in one turn, and a forced image-queue failure surfaces an error rather than dropping the images
  - _Requirements: 8.1, 8.2, 8.3_
  - _Depends: 4.4, 5.3, 6.5, 6.6_

## Implementation Notes

- VALIDATION FIX (caught by /kiro-validate-impl, not per-task review): the machine did NOT thread `queuedDelivery` from the `SUBMIT_PROMPT` event → `activeTurn` → `ExecutePromptInput`. Task 4.1 added the optional type fields, 4.4 dispatched with it, 4.3 read it — but the machine's event→activeTurn→executePrompt mapping (the middle link) was never wired, so `input.queuedDelivery` was always `undefined` for drained turns → Codex next-turn rows stranded in `delivering`. No per-task test covered this seam (7.1 hand-called markDelivered; the actor test hand-built the input). Fixed by threading the metadata at all three machine sites (idle + debug SUBMIT_PROMPT handlers + the executePrompt invoke input) with a machine-driven pinning test asserting the executePrompt actor receives `input.queuedDelivery`. Lesson: optional fields that must be threaded across an XState event→context→actor-input boundary need an explicit end-to-end-through-the-machine test, not just producer/consumer unit tests.
- Non-blocking (flagged at validation): `UNSUPPORTED_BACKEND` (req 5.4/6.2) is currently unreachable — `queueCapabilityForBackend` returns `acceptsWhileRunning: true` for both real backends (claude/codex); the typed error + composer "explain unavailable" branch are dead code until a future backend resolves unsupported. Acceptable per design ("a future backend may resolve as unsupported"); the route/composer/descriptor are structurally ready.

- 1.2: Content-block schemas (`messageContentBlockSchema`, `toolResultMetricsSchema`) were extracted to a new leaf module `src/lib/conversations/message-content-schemas.ts` to break a module-init cycle between `schemas.ts` and `message-queue-schemas.ts`; `schemas.ts` re-exports them so the ~33 existing importers are unaffected. Any later schema task that imports both files should import shared content-block schemas from the leaf, not create a new cycle.
- 1.2: `messageQueuedEventSchema.message` (the `QueuedMessageView`) is `.optional()` and the legacy `text` field is retained, because the sole producer `src/lib/prompt/queue.ts` is rewritten in task 5.1. When 5.1 lands, the producer should populate `message`; consider tightening to required and dropping `text` only after all producers/consumers are migrated.
- Pre-existing flaky test (NOT introduced by this feature): `src/lib/conversations/service.test.ts` "ordered by most recently active first" can fail when two conversations share a `lastActivityAt` millisecond. Ignore unless it blocks; do not attribute to queue tasks.
- 4.2: `finalizingTurn` is a TRANSIENT state (its `always` block ends with an unguarded default → `idle`; it has NO `on:` block), so the design's literal note to "accept EXTERNAL_TURN_STARTED in finalizingTurn" is obsolete — adding a handler there is dead code. The live-continuation race is handled by the existing `idle` `EXTERNAL_TURN_STARTED` handler; the transient settle resolves to `idle` before any queued event is dequeued. The `drainPendingQueue` action is invoked via `idle` `entry` (the canonical settled user-submit point) — NOT in finalizingTurn or debug substates.
- 4.2 → affects 4.4: XState `.provide()` SILENTLY IGNORES an unknown action name (no throw). The manager (4.4) MUST provide the action under the exact name `drainPendingQueue` or the drain becomes a silent no-op. Verify the manager's provided action is actually invoked (spy/integration test), since a typo would not fail typecheck or runtime.
- 5.1 ↔ 5.2 coupling: the new `queueMessage` signature (`{projectPath, sessionName, conversationId, text?, images?, backend} → {entry, deliveryTiming}`) atomically breaks the route's type + `queue-route.test.ts` + the `section-4-production-paths.test.ts` queueMessage assertion. 5.1 and 5.2 were therefore implemented + reviewed + committed together (one green commit) rather than committing a RED intermediate. Queue content format = `[text block?] + [image blocks]` (shared contract with the 4.4 drain's `queuedBatchToSubmitPrompt`).
- 4.4 known limitation (NOT fixed; out of scope): a queued message whose acceptance fails on every drain (markPending → re-drain at next idle settle) can retry-loop. `PendingQueuedMessage.attemptCount` exists to bound this; a future enhancement should markFailed after N attempts. Flag for Group 7 validation.
- 4.4: the manager's drain runs only when the actor reaches `idle` ENTRY (fresh start + post-turn settle). A rehydrated actor restored DIRECTLY into `idle` does NOT re-run entry actions (XState snapshot restore), so its pending queue won't auto-drain until the next settle. Recovery (delivering→pending) still runs before start. Minor edge; flag for Group 7.
- 4.3 gap (FIXED post-4.3, pre-4.4): task 4.3's queued-delivery acceptance is keyed on the `input_accepted` backend event. Task 3.3 made Codex emit it on `sendTurn` dispatch, but task 3.2 only added it to Claude's live `queueUserInput` path — Claude's NORMAL `sendTurn` did NOT emit it. So a Claude queued message that drains as a next turn (the durable fallback after a failed live delivery) would never confirm acceptance → perpetual pending = silent loss (violates req 4.2 + the brief's "never lost on either backend"). Fix: Claude's `sendTurn` now emits `input_accepted` on dispatch, symmetric with Codex (harmless no-op for normal non-queued turns since the actor only acts on it when `queuedDelivery` is set).
