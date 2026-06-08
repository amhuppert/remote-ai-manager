# Brief: conversation-message-queue

## Problem
When a user sends a follow-up message while an agent is already working, Command Center should queue it and deliver it reliably — within the current turn if the backend supports it, otherwise as the next turn when the agent finishes. Today this only works for Claude's live path, and even that has reliability gaps. For Codex it does not work at all: the UI still offers "Queue message," but the request is rejected server-side and the message is dropped. Several failure paths can also orphan transcript entries, corrupt client state, drop image attachments, and return 500s on benign timing races.

## Current State
Established by an end-to-end review of the queuing path (client `use-prompt-submission.ts`/`use-send-prompt.ts` → `prompt/queue.ts` + `queue-route-handlers.ts` → runtime contract `agent-backends/conversation.ts` → Claude/Codex runtimes):

- **Claude (live path works):** `queueUserInput` forwards content into the long-lived SDK query via `streamInput()` (`queueWhileRunning: true`). Buffering is delegated entirely to the SDK; CC has no buffer of its own. The eventual response is captured via the external/virtual-turn machinery.
- **Codex (no queue path):** `capabilities.queueWhileRunning = false`, no `queueUserInput`; each turn runs a fresh `thread.runStreamed(...)`. `queueMessage()` throws `"Backend does not support message queueing"`.
- **No durable, server-owned queue** for either backend — any delivery failure or timing miss is unrecoverable.

Identified issues to fix (from the review):
- **G1** — Codex queuing unimplemented; the composer is capability-blind ("Queue message" shown for Codex; submit → server throw → dropped message).
- **G2** — No CC-owned durable queue / replay path.
- **I1** — Orphaned transcript entry: `queueMessage()` appends to the transcript before delivery; if `streamInput` throws, a durable user message exists with no response. `queueUserInput` doesn't guard on session liveness.
- **I2** — Client state corruption on queue failure: `failPrompt` clears the global `sending` flag and leaves the optimistic queued bubble in place during a still-running turn.
- **I3** — Queued submissions are text-only; image attachments are dropped at the client/endpoint (the runtime layer already supports image blocks).
- **I4** — TOCTOU: the route's `status === "running"` gate isn't atomic with runtime liveness; a stale "running" with no live runtime → 500 instead of a recoverable response.
- **I5** — `ConversationQueuedUserInput.signal` is ignored, so a queued-but-undelivered message can't be cancelled.
- **R1 (verify)** — Claude "deliver when the turn ends" race: `EXTERNAL_TURN_STARTED` is only handled in the machine's `idle` state; a queued auto-continuation turn that starts before `idle` can be dropped by XState.
- **R2 (verify)** — Transcript ordering/interleaving of the immediately-appended queued user entry vs. in-flight assistant content.
- **R3 (verify)** — Possible duplicate rendering (optimistic store entry + `message-appended` + `message-queued`).

## Desired Outcome
- A follow-up message sent during a running turn is **never silently lost** on either backend.
- **Claude:** continues to deliver within the current turn when possible (live `streamInput` optimization), with a durable fallback if delivery fails.
- **Codex:** the queued message is held and **automatically sent as the next turn when the current turn ends**.
- Multiple messages queued during one turn are **coalesced into a single next turn**.
- Failure paths are clean: no orphaned transcript entries, no corrupted client `sending` state, correct HTTP status codes, and capability-aware UI.
- Image attachments queue successfully.

## Approach
**Approach 1 — Server-owned durable, backend-neutral pending queue (selected).**

- Persist a **per-conversation pending-message queue** in conversation state in `command-center.db` (the project's source of truth), with `pending | delivered | failed` status metadata. Accessed through the serialized write queue / focused accessors per `PERFORMANCE.md`.
- The queue route **enqueues a `pending` row** (carrying text + image content blocks) as the durable source of truth.
- A **drain step** dispatches pending messages at a **race-safe point**: when the conversation XState machine reaches `idle`, or by broadening the machine to accept `EXTERNAL_TURN_STARTED` in `finalizingTurn`. **Multiple pending messages are coalesced into one next turn.**
- **Claude:** still attempt immediate `streamInput` delivery as an optimization and mark the row `delivered`; the durable row stays authoritative until delivery is confirmed (recovery path if `streamInput` fails).
- **Codex:** no live delivery; the drain dispatches the coalesced pending message(s) as the next `runStreamed` turn on completion.
- **Client:** drive the composer from a **client-visible capability surface** (conversation `agentBackend` / a route response), not the server-side `runtime.capabilities` object; forward image attachments; on queue failure, roll back the optimistic bubble and **leave `sending` untouched** (the turn is still running).
- **Errors:** typed errors distinguishing "no live runtime" / "runtime dead" / "unsupported/deferred" mapped to appropriate status codes instead of 500.

Rejected: Approach 2 (Codex-only buffer + scattered fixes) leaves two divergent paths and no Claude recovery; Approach 3 (defer everything) regresses Claude's valued in-turn delivery.

## Scope
- **In**:
  - Durable per-conversation pending queue (schema + persistence in `command-center.db`) with status model.
  - Race-safe drain/dispatch integrated with the conversation XState machine.
  - Coalescing of multiple pending messages into one next turn.
  - Codex post-turn dispatch; Claude immediate-delivery optimization with durable fallback.
  - Client capability gating via a client-visible surface; queue-failure rollback that preserves `sending`.
  - Image-capable queue payload (client + endpoint + queue.ts).
  - Typed queue errors + correct HTTP status codes; deliver-then-persist (or pending-marker) ordering.
  - Tests: Codex replay-as-next-turn, Claude live + deferred delivery, `streamInput` failure (no orphan), queue-failure rollback, queued images, and the R1 drain-timing case.
- **Out**:
  - Rewriting the background-task auto-continuation / external-turn machinery beyond the minimal change needed for a race-safe drain.
  - Queuing semantics for managed/iteration (non-interactive) workflow conversations.
  - A general transcript-rendering overhaul — R2/R3 are fixed only if reproduced.
  - Queued-message editing UI (the `signal` cancellation hook is wired but a full edit/cancel UX is downstream).

## Boundary Candidates
- Durable pending-queue store + status model (server, `command-center.db`, Zod schema).
- Drain/dispatch integration with the conversation XState machine (race-safe trigger + coalescing).
- Backend delivery adapters (Claude immediate `streamInput` optimization; Codex post-turn `runStreamed`).
- Client surface (capability gating, failure rollback, image forwarding).

## Out of Boundary
- The background-task lifecycle/auto-continuation engine itself (owned by `background-task-handling`).
- Collaboration / graph-workflow turn orchestration.
- Notifications and SSE transport internals (reuse existing broadcaster events).

## Upstream / Downstream
- **Upstream**: `background-task-handling` (external-turn/virtual-turn machinery + conversation machine states, including the `EXTERNAL_TURN_STARTED`/`finalizingTurn` drain point); the backend-neutral runtime contract (`agent-backends/conversation.ts`, `types.ts`); the state-store / `command-center.db` write queue; `image-attachments` (image payload plumbing).
- **Downstream**: any future agent backend inherits backend-neutral queuing for free; a possible queued-message edit/cancel UX building on the `signal` hook; capability surface reusable by other capability-gated UI.

## Existing Spec Touchpoints
- **Extends**: `background-task-handling` (machine drain point / `EXTERNAL_TURN_STARTED` handling); `image-attachments` (queue payload carries image content blocks).
- **Adjacent**: `unified-conversations-panel` (composer + queue affordance), `persistent-mcp-sessions` (runtime lifecycle/registry), `optimistic-mode` (optimistic client state).

## Constraints
- TypeScript `strict` / `noUncheckedIndexedAccess`; no `any`, no assertion-to-silence. Zod schemas are the source of truth (`z.infer`); `z.record(z.string(), value)` form.
- `command-center.db` is the single durable store, accessed via the serialized write queue; follow `PERFORMANCE.md` (focused accessors over `readState`, focused setters over `mutate*`).
- Compose existing primitives — extend the conversation XState machine (`actions.ts`, `runtime-state.ts`, `persistence.ts`), do **not** fork a parallel orchestrator (per engineering-principles.md).
- Testing via dependency injection (factory/`.provide()`/setter); never `vi.mock()` internal modules; extract pure functions (coalescing, status transitions) for direct unit tests.
- Structured logging via `createLogger` (see `.kiro/steering/logs.md`).
- Red-Green-Refactor TDD; failing repro test first for each bug fix.
- All work stays within the session worktree.
