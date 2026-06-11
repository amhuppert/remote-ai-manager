# Brief: human-review-gate

## Problem

Graph workflows run autonomously: when an execution context's validators (script + agent) pass, the context completes and downstream contexts start immediately. For high-stakes or judgment-heavy contexts, Alex wants to personally review the work before the workflow proceeds. Today there is no way to insert a human checkpoint — the only options are watching the workflow live or pausing the entire execution manually, both of which defeat unattended operation.

## Current State

- **Dual-validator model**: each context runs a script validator (deterministic, `preMergeCommand`) then an agent validator (Claude/Codex) after the implementer finishes. Config cascades global → workflow → per-context (`src/lib/workflow-graph/resolve-config.ts`).
- **Failure loop**: validator failure reopens tasks, appends to `failureHistory`, and feeds the failure into the next iteration prompt (`iteration-orchestrator.ts`, `iteration-prompt.ts`). Circuit breaker halts after N consecutive failures (default 3); max iterations default 20.
- **Context lifecycle**: `pending → ready → running → completed | halted` (`src/lib/workflows/schemas.ts` ~line 399). No human-input state exists at the context level; workflow-level `paused` exists but stops everything.
- **Execution loop**: promise-per-context with `Promise.race` scheduling (`execution-loop.ts:1222-1344`); contexts park/wake via repository mutations (`execution-repository.ts mutateActive`). Collaboration waits (`pendingCollaborations` + `waitForPendingCollaborationProgress`) are an existing precedent for waiting on an external signal mid-execution.
- **Needs You UI**: sidebar pins conversations with `status === "waiting_for_input"` to the top "Needs you" section (`src/features/session/sidebar/ConversationSidebar.helpers.ts`); `AskQuestionPanel` renders pending questions in the prompt slot and peek popover.

Gap: no validator type or context state that blocks on a human decision, no approval API, no UI affordance for approve/reject.

## Desired Outcome

- A context can be configured (per-context, with workflow-level override; default disabled) to require human approval after all other validators pass.
- The gated context parks in a persisted waiting state; its dependents stay blocked while independent parallel contexts keep executing.
- The context's conversation appears in the sidebar's Needs Input ("Needs you") section, sorted to the top, with a dedicated approval panel.
- **Approve** → context completes normally (including merge for parallel-isolation contexts) and dependents unblock.
- **Reject (with message)** → tasks reopen and the message feeds the next iteration prompt exactly like an agent-validator failure; after the implementer responds, script + agent validators re-run before the gate triggers again.
- Pending gates survive server restart.

## Approach

**Sibling gate config + dedicated context waiting state** (chosen over (a) adding `type: "human"` to the agent-validator discriminated union — structurally wrong because the gate runs *in addition to* the agent validator, not instead of it, and would force a union→array refactor; and (b) reusing workflow-level `paused` — stops independent parallel contexts, contradicting requirements).

- Add `humanApprovalGate` (`{ enabled }`) as a third sibling alongside `contextValidator` / `scriptValidator` in the config cascade.
- Add `awaiting_approval` to the context status enum. The iteration orchestrator routes the context to `awaiting_approval` instead of `completed` when the gate is enabled and all validators pass (`iteration-orchestrator.ts` ~line 1227), before the merge/commit phase (`execution-loop.ts:793-815`).
- New approval endpoint resolves the gate via `mutateActive()`: approve → status `completed` + merge proceeds; reject → reuse `reopenTasksAfterContextValidationFailure()` with the human's message.
- Set the gated context's conversation to `status: "waiting_for_input"`; clear on resolution. New dedicated approval panel (Approve button; Reject expands message textarea) in the prompt slot and peek popover, posting to the approval endpoint — deliberately NOT routed through AskUserQuestion answer plumbing.
- SSE events for gate-pending/gate-resolved keep the sidebar and workflow views live.

### Resolved design decisions (from discovery Q&A)

1. **Reject path**: full validation loop — rejection behaves like an agent-validator failure (reopen tasks, message in next iteration prompt, script + agent validators re-run before the gate re-triggers).
2. **Iteration accounting**: rejections consume an iteration (max-iterations bounds total work) but do NOT count toward the consecutive-failure circuit breaker — human direction is steering, not failure.
3. **Pause scope**: only the gated context (and its dependents) block; independent parallel contexts keep executing.
4. **UI**: dedicated approval panel + dedicated endpoint; reuse `waiting_for_input` status only for Needs Input placement/notifications.

### Known design considerations (from viability check)

- **Scheduler wake-up**: the outer loop wakes on `Promise.race` settling; a parked context with nothing else in flight needs a wake path — mirror the `pendingCollaborations` wait mechanism (`waitForPendingCollaborationProgress`).
- **Status enum ripple**: ~6–8 consumers of the context status enum need auditing (eligibility in `validation.ts:265`, edit-locking, landed/merge checks). Mostly guard clauses, not exhaustive switches.
- **Conversation status conflict**: the SDK's AskUserQuestion tool also writes `waiting_for_input`/`pendingQuestions` on the same conversation; the gate's pending state must not collide (guard tool writes while `awaiting_approval`, or scope fields distinctly).

## Scope

- **In**: gate config schema + cascade resolution; `awaiting_approval` context state + orchestrator routing; approval/reject API endpoint; rejection → iteration-loop feedback wiring; conversation status integration + top-sort in Needs Input; dedicated approval panel (prompt slot + peek popover); SSE events; persistence/restart survival; planner-tool (`create_graph_workflow`) schema exposure.
- **Out**: approval delegation/multi-approver/roles; approval timeouts or auto-approve deadlines; gates at task level (context level only); review-artifact generation (diff summaries, report rendering) beyond what the conversation already shows; mobile push-notification changes beyond what `waiting_for_input` already triggers; changes to collaboration-execution machinery.

## Boundary Candidates

- Engine: gate config schema + resolve-config cascade + orchestrator state routing + reject-feedback reuse.
- API: approval endpoint (approve/reject with message) + validation that the context is actually awaiting approval.
- UI: approval panel component + Needs Input sorting + SSE/query invalidation wiring.

## Out of Boundary

- Redesigning the validator union or generalizing validators into arrays/pipelines.
- Generic "human input" steps at arbitrary workflow points (only the post-validation context gate).
- Audit log / approval history UI beyond what execution events already record.

## Upstream / Downstream

- **Upstream**: workflow-graph-builder (execution engine, schemas, planner tools), composable-workflow-primitives (agent execution facade), workflow-continuity (conversation continuity), unified-conversations-panel (Needs You sidebar mechanics), active-conversations API.
- **Downstream**: future approval-gate extensions (timeouts, delegation); any workflow templates that want human checkpoints; potentially the project-conversation-cockpit surfacing pending gates.

## Existing Spec Touchpoints

- **Extends**: none directly (workflow-graph-builder is implementation-complete; this is an additive new boundary).
- **Adjacent**: workflow-graph-builder (context lifecycle, validators — must not fork its primitives), agent-invoked-collaboration (external-wait precedent), unified-conversations-panel (Needs You section semantics — reuse, don't duplicate).

## Constraints

- Compose with existing primitives (config cascade, iteration loop, `mutateActive`, SSE events) — no parallel orchestrator (engineering-principles: composable primitives).
- Zod-first schemas in `src/lib/workflows/schemas.ts` / domain schema files; types via `z.infer`.
- Persisted state must round-trip SQLite — extend the relevant `*.contract.test.ts` durability contract for any new persisted fields.
- DI for testability (no `vi.mock` of internal modules); structured logging via `createLogger` per `.kiro/steering/logs.md`.
- TDD: failing tests first for orchestrator routing, reject-feedback, eligibility exclusion, and endpoint behavior.
