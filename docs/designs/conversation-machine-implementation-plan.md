# Conversation lifecycle and composition: implementation plan

Date: 2026-09-06. Reviewed baseline: `8489cd68f0bdea9506cdbfa585a86b808b7f5511`.

The [technical design](conversation-machine-technical-design.md) defines the selected interfaces, lifecycle, ownership, and feature semantics. This plan supplies execution order, file ownership, acceptance outcomes, and validation. No application code has been changed and no application tests have been run for this planning task.

## 1. Delivery contract

Implement the ten changes below in order. Each change should leave the tree type-correct and its affected behavior covered. Use separate reviewable commits/PRs at the stated boundaries; do not merge partially migrated public interfaces or leave temporary compatibility aliases. The sequence is deliberately serial because several changes touch the same actor implementation and fixtures.

The first four changes repair reconstruction, admission/cancellation, and durable acknowledgement. Shared input definitions land early to reduce the work carried through the lifecycle changes. Later extractions build on those contracts. The last change verifies the composed system and closes the remaining integration imports.

Scope includes conversation hosting and its prompt, project-conversation, graph runner, debug, MCP, memory, and alignment adapters. Preserve graph policy ownership. Exclude graph scheduler/landing/editor/repository refactors, new orchestration frameworks, provider replacement, new databases, SQL migrations, snapshot version changes, and legacy-decoder retirement.

The native feature requirements to preserve are profile admission and stored replay (`agent-profile-library` R6/R8/R9), accepted-input memory delivery (`memory`), accepted-input notepad tracking/notices (`notepad` R21/D17), structured-output capture/provenance (`context-structured-output`), and the existing query-semaphore capacity contract (`workflow-validator-cohorts`). No native approval or execution gate is claimed by these file documents.

## 2. Preparation and evidence

Before the first implementation edit:

1. Read this design and plan, the root `AGENTS.md`, `.kiro/steering/engineering-principles.md`, `.kiro/steering/workflows.md`, and `.kiro/steering/logs.md` in the assigned worktree.
2. Check `git status --short` and `git rev-parse HEAD`. Preserve unrelated edits. If the branch has moved, compare the affected source against `8489cd68` and adjust paths/contracts for actual changes; do not treat installed cctl or the running server as evidence of branch behavior.
3. Read `CommandCenter.json`, `cctl validate run --help`, and the relevant `cctl` skill before validation. The inspected registration is `format`, `lint`, `typecheck`, `seams`, and `test`; the current runner waits for its result without a `--wait` flag.
4. Create a work record at `memory-bank/conversation-machine-implementation-progress.md`. Record completed change IDs, commit, actual validation run IDs/verdicts/matched scope, behavior changes, and unresolved failures. Do not use a numeric architecture score.
5. For each behavior fix, first obtain a failing behavior-level reproduction in the existing fixture/actor path, then fix it. Mechanical type extraction and moves do not need artificial tests. Acceptance judges the resulting observable behavior, not proof of a particular test-writing sequence.

No external service, provider account, schema migration, or new package is a prerequisite for starting changes 1–9. Live verification is a final integration check, using an isolated conversation/worktree and the actual branch build.

## 3. Change 1 — restore complete durable state and close the missing write gate

Depends on preparation. Addresses C2 and the immediate C5 defect.

**Own these production files:**

- `src/lib/workflows/conversation/actor-input-loader.ts`
- `src/lib/workflows/conversation/types.ts`, `machine.ts`, `manager.ts`, `rehydration.ts`
- `src/lib/workflows/conversation/persistence-adapter.ts`, `actor-implementations.ts`
- `src/lib/project-conversations/prompt-entry.ts`

**Implementation:**

1. Introduce the paired `ConversationDurableSeed` projection in `actor-input-loader.ts`, derived from stored schemas. Add all five accumulated/metric fields and `lastActivityAt`; keep current null semantics and existing role/fork/debug/profile data.
2. Feed that seed through the ordinary loader and durable project entry point. Update machine initialization to use it. Update synthetic/test constructors explicitly until their fabricated durable input is removed in change 3.
3. Overlay durable row aggregates and prompt count when restoring a usable snapshot so stale sidecar totals cannot overwrite the row. Preserve existing pending-question, debug, and continuation restoration behavior.
4. Add `resetMemoryIndexDelivery` to the gated write contract and the ephemeral implementation. Keep the durable reset behavior unchanged. This is an interim complete gate until the explicit effect facet lands in change 5.
5. Add a paired-field assertion/test covering the initialization and synchronization directions; do not build a generic persistence framework.

**Tests:** extend `actor-input-loader.test.ts`, `persistence-adapter.test.ts`, `rehydration.test.ts`, `manager.test.ts`, and `ephemeral-persistence.integration.test.ts`. Reuse `createPersistenceFixture` and the production machine with infrastructure substitution.

**Acceptance:** a stored conversation with nonzero cost, duration, turns, prompt count, and context metrics preserves them through construction and the next synchronization; another completed turn adds only that turn's accounting. A usable snapshot with older totals cannot reset newer row totals. Both session and project ephemeral streaming compaction paths make zero database changes; durable fixtures demonstrate the reset really executes. Existing resume-token and pending-question tests still pass.

**Review boundary:** initializer/projection and missing gate only. No totals-delta redesign and no snapshot format change.

## 4. Change 2 — define turn payloads and bindings once

Depends on change 1. Addresses C3 and supplies the types used by change 3.

**Own:** new `src/lib/workflows/conversation/turn-spec.ts` and the result contracts/basic projection helpers in new `turn-result.ts`; existing conversation `types.ts`, `manager.ts`, `machine.ts`, `actors.ts`, `actor-implementations.ts`, `execute-workflow-task-run.ts`; `src/lib/prompt/sdk-driver.ts`; their dependent type fixtures.

**Implementation:**

1. Define conversation and task Zod specs using current domain schemas. Export inferred normalized and request types. Define `ConversationAddress`, durable/ephemeral binding variants, transient execution context, admission refusal variants, and admitted-handle contracts from design §4. Define `TurnExecutionOutcome` and `SettledConversationTurn` in `turn-result.ts` now, together with the basic projection helpers needed by the next change; change 7 completes their adoption across task/fresh/graph consumers.
2. Derive the SDK options subset, service request, event fields, and flat active-turn fields from the same definitions. Keep request, normalized turn, machine bookkeeping, and executor context as distinct meaningful boundaries.
3. Have claim functions spread the normalized spec once. Embed it in executor inputs; remove option-by-option relay copying at those internal hops.
4. Keep current serialized field names and images handling. Use intersection/shape composition, not a nested persisted payload. Keep current provider validation and native model-selection acknowledgement semantics.
5. Delete the unused `skipConversationLock` option and its setter/reader across production and fixtures. Every turn must take the existing conversation lock.

**Tests:** extend `types.queue.test.ts`, `persisted-snapshot-codec.test.ts`, and existing permission-carriage tests. Add `turn-spec.test.ts` only for meaningful normalization/refusal behavior, not a test for each object spread.

**Acceptance:** filesystem policy, queued identity, model selection, output schema, feedback, question enablement, and execution intent reach execution without relay definitions. Canonical snapshot fixtures round-trip without token loss or added nesting. Task-only fields cannot be used as conversation options. No production reference to `skipConversationLock` remains.

**Review boundary:** type ownership and mechanical forwarding. The final lifecycle protocol lands in change 3; no compatibility aliases are introduced.

## 5. Change 3 — own the complete admitted attempt

Depends on change 2. Addresses C1 and the active input/binding portion of C3.

**Own core:** new `src/lib/workflows/conversation/turn-attempt.ts`; existing conversation `manager.ts`, `machine.ts`, `actors.ts`, `actor-implementations.ts`, `runtime-state.ts`, `execute-workflow-task-run.ts`, `external-turn-handler.ts`, and `pre-turn/abort-wiring.ts`; `src/lib/shared/query-semaphore.ts`; `src/lib/conversations/abort-registry.ts`, `abort-route-handlers.ts`, `message-queue-drain.ts`.

**Own necessary caller migration:** `src/lib/prompt/sdk-driver.ts`, `prompt/route-handlers.ts`, `project-conversations/prompt-entry.ts`, `conversations/service.ts`, `workflow-graph/execution-route-handlers.ts`, `workflow-graph/workflow-manager.ts`, `workflow-graph/validator-runner.ts`, `workflow-graph/context-output-capture-runner.ts`, `workflow-graph/plan-repair/agent-runner.ts`, and `context-artifacts/service.ts`. Update their dependency interfaces and fixtures in the same change where a signature changes.

**Implementation:**

1. Implement the design's admission reservation in `manager.ts`. Await profile admission before submit. Waiting requests can cancel without installing their inputs. Recheck eligibility after every admission await, then attach the emitter and accepted transient context with the actual attempt in one synchronous section.
2. Implement the accepted handle's `completed` and `cancel` operations. Generate one attempt ID before the submit event. Bind callbacks to that ID and the host incarnation. Implement compare-and-delete detachment; stop using mutable unqualified stream attachment.
3. Make every production submission use the normalized spec and explicit binding. Remove `actorInput` construction of fictitious stored rows from validator, repair, artifact, and compaction callers. Real project conversations still use the durable loader.
4. Make task and streaming actors register their actual execution promise before starting asynchronous work. Capture their original AgentCall result on the attempt before projecting it into the existing machine result, so the public handle can return the outcome defined in change 2 without reconstructing lost information. Preparation records releases as soon as they are acquired. Thread cancellation through the invoke signal and attempt controller; remove the task actor's late independent controller.
5. Extend `acquireQuerySlot(label, { signal }?)` with cancellation, preserving callers that do not supply a signal. Handle cancellation during config refresh, FIFO wait, grant, and timeout without a leaked or double-released permit. Retain the current queue timeout for uncancelled work.
6. Accept attempt-specific `ABORT_TURN` during acquisition and execution. Route timeout, stall, UI Stop, workflow stop, and indexed abort through this owner. Remove registry-owned runtime close and all caller code performing both registry abort and machine transition.
7. Generalize `settlingQueuedDelivery` to invoke `settleTurn` for every turn. Preserve its stored state key. Await execution and owned close, finish receipts, finalize queued delivery, release resources, then apply the result. Retain the queue backstop until the existing early-failure test passes after removing the inner finalizer.
8. Replace `execute-workflow-task-run.ts`'s mutex and `waitForTaskRunCompletion`/`stopTurn` protocol with the admitted handle. Remove manager boundary watchers used to guess this attempt's result. A rejected request never returns the preceding turn's result.
9. Expose `requestConversationStop` with a settlement promise. Await it in deletion/rebinding paths; graph pause/halt may issue it as a notification while resume admission waits for actual settlement. Do not block inside a graph/state-store reducer awaiting cleanup.
10. Extend external-turn handling with a drainable event chain and backend-incarnation matching. Preserve transcript ordering and current capacity policy. Stop waits for closure/drain even if a background completion event never arrives.
11. Preserve question-state behavior and debug retry. A retry obtains a new attempt; same-attempt readiness retries do not. Disposal also waits for matching debug verification; its full feature extraction occurs in change 8.

**Tests:** add `turn-admission.integration.test.ts` and `turn-cancellation.integration.test.ts`; extend `shared/query-semaphore.test.ts`, `execute-workflow-task-run.test.ts`, `external-turn-handler.test.ts`, `queued-finalization.test.ts`, `manager.test.ts`, and `machine.test.ts`. Use controlled promises around real actor/preparation code and the existing fake provider.

**Required race cases:**

- Two submitters cross the async profile-admission boundary; only the accepted one installs its emitter/settings.
- A waiting caller cancels; the incumbent emitter, workflow identity, and result remain its own.
- Cancellation while the semaphore is full removes the waiter; releasing capacity later never dispatches that cancelled turn.
- Cancellation during preparation after the conversation lock is taken releases it only after preparation unwinds.
- A task timeout followed by a second request cannot run concurrently or return the first result to the second caller.
- Late detach, model-selection acknowledgement, backend-init, completion, or abort from attempt A cannot affect B.
- Preparation failure and failure before backend acceptance leave a queued claim uncertain/reviewable, including the existing `queued-finalization.test.ts` scenarios.
- Backend close is delayed; Stop/rebind remains pending until execution and cleanup actually finish.
- An external turn with no completion event can still be stopped and drained; stale frames cannot update a replacement runtime.

**Acceptance:** there is one production turn-stop protocol and one completion handle. No in-process caller can overwrite a live emitter through rejected admission. Every real task execution honors cancellation from acquisition through cleanup. Profile lock and transcript/queue ownership remain intact.

**Review boundary:** lifecycle behavior and all required caller migration. Do not combine contributor extraction or graph policy changes into this already substantive change.

## 6. Change 4 — make lifecycle acknowledgement durable

Depends on change 3. Addresses C2 and completes the durable part of C1 settlement.

**Own:** conversation `persistence-adapter.ts`, `persistence.ts`, `manager.ts`, `machine.ts`, `turn-attempt.ts`, `debug-adapter.ts`, `rehydration.ts`; `src/lib/conversations/debug-mode-route-handlers.ts`; mutation notification wiring in these owners.

**Implementation:**

1. Add synchronously enrolled write receipts and per-command/per-attempt durability barriers to the adapter. Use the existing state-store queue; register writes before lazy dependency loading. Preserve progress after a failed write while rejecting the operation that owns it.
2. Register snapshot capture before deferral. Retain debouncing for intermediate activity and expose a flush for durable commands, completed turns, and safe disposal.
3. Extend the accepted handle's completion to include required row/snapshot and delivery writes. Keep cleanup independent of write success. Block automatic reuse/drain while required finalization remains unreconciled.
4. Make semantic debug commands asynchronous with typed applied/unchanged/refused outcomes. Remove the recording route's second direct mutation and return only after the command barrier completes. Migrate all debug command consumers and their dependency contracts.
5. Move relevant status/debug mutation publication after successful commit. Preserve live transcript/token streaming, optional auto-naming, and observational logging.
6. Implement bounded reconciliation through `ensureConversationLifecycle`: retry retained required finalization writes once without replaying the backend or applying totals twice, then either clear the gate or return the typed failure. Queue ambiguity continues to require the existing review operation. Disposal/rebinding cannot bypass a failed backend close.

**Tests:** add `turn-durability.integration.test.ts` with a real isolated database and `src/lib/conversations/debug-mode-route-handlers.test.ts`; extend persistence adapter/snapshot tests and `src/lib/conversations/project-abort-durability.integration.test.ts`.

**Acceptance:** delayed dependency loading cannot make a barrier resolve early. A recording command returns the persisted value immediately readable from the repository; no second writer exists. An unchanged recording command performs no write or publication. A required mutation/snapshot failure rejects the command or produces a turn's explicit `settlement_failed` outcome, and publishes no success event for that failed mutation. A later successful reconciliation does not run the backend or increment aggregates again. Commit failures never skip resource cleanup. Stored snapshots retain usable pending-question/debug state.

**Review boundary:** acknowledgement and failure handling over current storage. Do not introduce a generic transaction/outbox system or change the graph repository.

## 7. Change 5 — establish one composition root and close registry access

Depends on change 4. Addresses C3 and C5.

**Own:** new conversation `actor-host.ts`, `production.ts`, `effects.ts`, `runtime-binding.ts`; existing `manager.ts`, `runtime-state.ts`, `actors.ts`, `actor-implementations.ts`, `types.ts`, `machine.ts`, `actor-input-loader.ts`, `persistence-adapter.ts`, `persisted-snapshot-codec.ts`, `rehydration.ts`, `testing/actor-deps-fixture.ts`; `src/lib/mcp/default-deps.ts`, `src/lib/session-alignment/agent-route-handlers.ts` and memory-preview dependency wiring.

**Implementation:**

1. Extract actor `.provide()` construction and registry access into `actor-host.ts`. Keep admission and command sequencing in `createConversationManager(deps)` in `manager.ts`.
2. Build production dependencies in `production.ts`, retaining lazy initialization without a runtime import back into the default manager instance. Pass the same host factory to normal creation and rehydration. Tests construct the same core with explicit infrastructure dependencies.
3. Replace the broad mixed dependency intersections and mutable setter setup with required narrow groups: turn execution, transcript files, durable effects, context contributors, capability/MCP policy, and debug verification. Required no-op behavior is explicit at construction; optional observers remain optional.
4. Define `ConversationDurableEffects` and both implementations using `satisfies` coverage. Route every owned database effect through it, including writes hidden inside apply services. Keep policy enforcement active for ephemeral execution.
5. Put the backend handle and its close promise under `ManagedConversationRuntime`. Make the existing backend registry an index. Eliminate competing ownership in `ConversationRuntimeState` and the general abort registry.
6. Migrate MCP to the narrow tooling read operation and alignment to `describeActiveTurn`, preserving queued origin message identity and autonomy checks. Remove all external reads of `runtime-state.ts`; the SDK setters removed in change 3 must not reappear.
7. Use `ConversationTarget` in the resulting internal interfaces. Keep store-session conversion in adapters and preserve explicit session-only participation for ticket/alignment/workflow features. Map internal target identity onto the unchanged flat snapshot identity fields and reconstruct it on restore; update the disposition guard and codec round-trip tests in this change.

**Tests:** extend `runtime-state.test.ts`, add `runtime-binding.test.ts`, and extend `ephemeral-persistence.integration.test.ts`, `launch-capability-declaration.integration.test.ts`, `profile-runtime-replay.integration.test.ts`, and applicable alignment/MCP behavior tests.

**Acceptance:** production and tests construct the same behavior without hidden required defaults. A missing required collaborator fails construction/typechecking. Session/project ephemeral drives produce no database changes while enforcement and transcripts still work. Queued alignment proposals retain their original message ID. There are no external mutable runtime-state imports or independently writable backend owners.

**Review boundary:** actual responsibilities and dependency direction. Do not move directories for size targets or remove useful domain facades.

## 8. Change 6 — compose feature-owned context and delivery receipts

Depends on change 5. Addresses C4 and creation-time composition.

**Own:** new conversation `turn-context.ts`, `runtime-instructions.ts`, and focused contributor files under `pre-turn/`; existing `actor-implementations.ts`, `pre-turn/*`, `post-turn/queued-delivery-accounting.ts`; `src/lib/notepads/change-notices.ts`, `injection.ts`, and their wiring into conversation production dependencies. Reuse memory, workflow-result, capability, feedback, and transcript services.

**Implementation:**

1. Extract the pure named-input prompt assembler and ordered context composition. Preserve the design's prefix order and image-reference transport. Preserve the smaller task context policy.
2. Group feature preparation with its accepted-input and cleanup receipt in its owning contributor. Put the entire preparation/dispatch lifetime inside cleanup coverage, including claims acquired before a later read or runtime setup fails.
3. Extract explicit notepad reference tracking into prepared immutable receipts and move its durable write to `input_accepted`. Capture the revision/comment marker actually represented by the prepared injection; do not read a later marker during acknowledgement.
4. Let change-notice preparation use prepared reference receipts as a local baseline. Keep newer changes eligible. Record reference receipts before associated notice advances on acceptance. Preserve the existing repository upsert and next-turn retries after failed best-effort writes; do not claim it is a monotonic merge.
5. Keep memory/notepad best-effort receipt policies separate from required workflow-result, fork, and queue receipts. Coalesce duplicate acceptance callbacks according to each feature's contract. Preserve acceptance plus transcript-append proof before queue delivery.
6. Extract creation-time instruction assembly, focus registration, stored profile replay, and subtract-only pending-notice draining. Consume pending notices only at successful runtime creation. Preserve instruction precedence exactly.
7. Remove old orchestration flags and cleanup from the executor only after the corresponding receipt owns them. Delete the old positional prompt assembler and its unused image branch once all callers migrate.

**Tests:** add `turn-context.test.ts` for order/format and `context-delivery.integration.test.ts` for delivery; extend `notepads/change-notices.test.ts`, existing memory delivery tests, `queued-finalization.test.ts`, `post-turn/queued-delivery-accounting.test.ts`, `pre-turn/notices-drain.test.ts`, `pre-turn/fork-seed.test.ts`, and profile replay coverage.

**Acceptance matrix:**

| Scenario | Observable result |
| --- | --- |
| Runtime/MCP/preparation rejects before acceptance | No notepad or memory watermark advance; claimed workflow results are released; queued content remains reviewable. |
| Backend repeats `input_accepted` | No duplicate transcript row or contradictory queue transition; receipt writes follow each feature's declared idempotency policy. |
| Advisory watermark write fails | Turn policy remains best effort; unchanged durable watermark permits a later notice. |
| Required workflow receipt fails | Failure is retained, cleanup runs, and queue status does not claim unsupported delivery. |
| A referenced notepad is expanded and also tracked | No redundant notice for that rendered revision/comment marker; a newer edit/comment still produces a notice. |
| A comment arrives after preparation | Acceptance records only the prepared marker; the later comment remains observable next turn. |
| A notice arrives during runtime creation | Subtract-only consumption leaves it pending. Consumed notices do not force recreation next turn. |
| Profile library changes after admission | Recreated runtime still receives the exact stored profile block. |

**Review boundary:** feature receipt ownership plus the explicit notepad acceptance fix. No universal contributor degradation policy and no dynamic plugin registry.

## 9. Change 7 — share execution results and graph-facing adaptation

Depends on change 6. Addresses C6 and the graph/conversation boundary.

**Own:** conversation `turn-result.ts`, `actor-implementations.ts`, `execute-workflow-task-run.ts`, `execute-fresh-task-run.ts`, `manager.ts`, and `types.ts`; `src/lib/workflows/primitives/agent-call-vocabulary.ts`/`agent-call-facade.ts` only for necessary exported type reuse; graph `implementer-runner.ts`, `errors.ts`, `validator-runner.ts`, `context-output-capture-runner.ts`; new `src/lib/workflow-graph/conversation-turn-result.ts` for graph-local adaptation.

**Implementation:**

1. Complete adoption of the `TurnExecutionOutcome` and `SettledConversationTurn` contracts introduced in change 2. Keep normalized AgentCall results intact, including partial content, failure classification, parse provenance, repair spend, usage, continuation, and background wait.
2. Centralize projections to flat machine `PromptActorResult`, stream presentation, and `TaskRunResult`. Derive usage subsets from the existing AgentCall vocabulary. Remove result-to-result conversion chains and string recovery of typed failures.
3. Route fresh tasks through AgentCall and the shared task mapper. Preserve their configured backend, merge worktree, explicit timeout/permissions, and no-resume policy. Do not create actors for them.
4. Migrate the graph implementer from `executePromptStream` to `executeConversationTurn` with explicit binding and workflow context. Delete its no-op emitter and positional function declaration.
5. Map admission pressure, interruption, schema evidence, and actual backend failure in the graph-local adapter. Preserve existing budget decisions in graph owners. Keep provider schema validation separate from workflow domain validation.
6. Keep the facade admission check and named retry policies where they protect distinct boundaries. Remove a repeated check only when the contract tests demonstrate that the same owner and timing protect it.

**Tests:** extend `execute-workflow-task-run.test.ts`, add `execute-fresh-task-run.test.ts` and `turn-result.test.ts`, and extend AgentCall facade tests, graph `implementer-runner.test.ts`, `context-output-capture-runner.test.ts`, and the affected failure-accounting tests.

**Acceptance:** a fresh task receives the same structured-output enforcement and typed outcome normalization as a hosted task. It never resumes the source lane and runs in the requested merge worktree. Graph behavior is unchanged when an error's wording changes. Query-slot admission timeout does not become an agent failure; an actual failed turn is counted according to the existing graph policy exactly once. Structured-output parse/repair evidence and partial usage reach their consumers.

**Review boundary:** shared execution and boundary adaptation. Do not redesign graph iteration outcomes, validation coordination, or failure budgets here.

## 10. Change 8 — finish debug ownership

Depends on change 7. Addresses C7.

**Own:** `src/lib/workflows/debug/commands.ts`, `finalization.ts`, `cleanup-verification.ts`; new debug `schemas.ts` and `prompt-policy.ts`; conversation `debug-schemas.ts`, `debug-adapter.ts`, `actor-implementations.ts`, `types.ts`, `machine.ts`; `src/lib/prompt/sdk-driver.ts`; affected debug route imports.

**Implementation:**

1. Move debug schemas and their actual JSON-schema selection to debug ownership. Move debug prompt constants and phase-prefix decisions out of `sdk-driver.ts`/conversation assembly. Update imports directly and remove emptied modules rather than keeping compatibility re-exports.
2. Move low-level cleanup verification and its input/output contracts out of conversation actor implementations into debug. Inject its filesystem/Git operations and command delivery.
3. Apply shared totals, prompt count, continuation, and turn cleanup once before the debug phase decision. Preserve the pure reducer, retry spec, verification state, and generation fencing.
4. Route verification completion through the durable semantic command API. Cancel/await matching verification on exit/disposal. Preserve the existing user verification/reproduction and failure-retry behavior.
5. Remove the redundant double casts on the existing model-facing JSON schema constants and type those values directly. Preserve the sibling Zod validators and the intentionally flatter evidence-analysis transport shape; do not regenerate that transport schema from the domain union.

**Tests:** migrate `debug-schemas.test.ts` to the owner and extend `debug-adapter.test.ts`, `workflows/debug/commands.test.ts`, `finalization.test.ts`, `cleanup-verification.test.ts`, and `debug-workflow-parity.test.ts`.

**Acceptance:** debug completes, retries, pauses recording, and verifies cleanup with the same user-visible phase rules. Each execution is accounted once. A stale verification cannot mutate a new generation. The debug feature has no runtime import of conversation actor implementations or the prompt transport facade.

**Review boundary:** debug feature ownership. Preserve the existing reducer pattern; add no second debug engine.

## 11. Change 9 — compare the configuration actually baked into a runtime

Depends on change 8. Addresses C8.

**Own:** conversation `runtime-binding.ts`, `runtime-instructions.ts`, `pre-turn/runtime-recreate.ts`, `pre-turn/next-turn-context-loss.ts`, production wiring; `src/lib/agent-backends/conversation.ts`, `conformance.ts`, `claude/conversation-runtime.ts`, `codex/conversation-runtime.ts`, `cursor/conversation-runtime.ts`, and `testing/testfake-backend.ts` for CC metadata removal; memory preview's configuration read adapter.

**Implementation:**

1. Replace positional reuse arguments with current/desired configuration objects. Reuse the existing pure `stableStringify` for semantic JSON comparisons. Do not add a hashing/serialization package.
2. Store configuration and `alignmentVersion` on `ManagedConversationRuntime`; remove CC alignment metadata from provider runtime interfaces/implementations and fixtures. Preserve provider-native responsibilities.
3. Compute the ordered repeatable-instruction key from the actual text selected for this turn. Include ask-user policy, TDD, references, stored profile, alignment and the static scope/platform instructions. Exclude pending-notice delivery, per-turn contributors, subscribers, and timers as specified in design §9.
4. On changed creation requirements, await closure and recreate before dispatch using existing continuation rules. Keep MCP/capability apply timing and failure contracts authoritative for live-applicable changes.
5. Feed memory preview through the same managed configuration projection/reuse policy. Preserve its inability to predict a future caller's unknown model/schema/filesystem overrides.
6. Remove reference-identity caches whose only purpose was to prevent false runtime recreation. Retain caches that avoid real schema conversion or rendering cost when their keys are semantic.

**Tests:** add `pre-turn/runtime-recreate.test.ts`, extend `runtime-binding.test.ts`, `pre-turn/next-turn-context-loss.test.ts`, debug output-format tests, capability application tests, and profile replay tests.

**Acceptance:** equivalent schemas with different object allocation/key ordering reuse a runtime. Changed schema content, model selection, write policy, alignment, ask policy, TDD, or reference instruction text triggers the defined next-turn behavior. Merely consuming notices does not recreate the runtime. Changed per-turn context does not affect creation identity. Execution and preview agree on observable configuration inputs. Profile replay remains verbatim and resumed context follows the existing disposition rule.

**Review boundary:** semantic reuse and explicit instruction-refresh behavior. No new provider mechanism or speculative cache.

## 12. Change 10 — prove composition and enforce the resulting boundaries

Depends on changes 1–9. Completes C1–C8 together.

**Own:** new conversation `boundaries.arch.test.ts`; new graph `conversation-boundary.integration.test.ts`; affected existing integration tests; `eslint-rules/architecture-seams.mjs` and its tests/allowlist, `scripts/seam-adoption.ts` and `scripts/seam-baselines.json` only where an existing ratchet needs updating; this progress record and affected steering references.

**Implementation:**

1. Protect exact import boundaries with the existing architecture infrastructure: external consumers use semantic conversation APIs, debug does not depend on actor implementations, providers do not import CC conversation lifecycle internals, and graph execution does not call the HTTP/slash-command facade. Include dynamic imports and require calls in checks. Keep legitimate transcript/backend descriptor and test-infrastructure boundaries available.
2. Ratchet any affected existing seam down to the observed value. New guards are scoped to the retired patterns; do not encode source file length, a universal number of imports, or a broad ban on all cross-domain composition.
3. Run a production composition path through a fake provider and real isolated storage for session and project conversation turns, queued turns, a hosted task, an ephemeral task/streaming contract drive, and a fresh task. Verify observable outcomes and database/transcript state.
4. Add the graph integration cases below through current manager/runner interfaces. Keep graph's graph-owned state mutations and budgets intact.
5. Remove obsolete setters, alternate stop/settle paths, direct write escapes, dead parameters, and stale imports proved unnecessary by the implemented owners. Update present-tense contract documentation. Retain useful invariant comments. Leave stored legacy coercions in place as the design specifies.
6. Record final source changes, test evidence, remaining limitations, and the deliberate instruction/notepad behavior fixes in the progress document. These are implementation deliverables, not claims already established by this plan.

**Composed acceptance cases:**

- With global query capacity occupied, start a workflow conversation turn, pause/abort it, release capacity, and resume. The old request never dispatches, the resumed request receives only its own result, and existing graph fences remain effective.
- Exercise native mid-turn ask and post-turn parked question flows. Answer and resume through existing delivery APIs; each answer has correct transcript/queue identity and no second independent execution is created.
- Drive typed admission failure, cancellation, schema refusal, and backend failure through the graph adapter. Preserve the existing accounting and retained validation evidence for each.
- Begin a debug verification, stop/rebind, and deliver the old completion. Rebinding waits for owned work, and the old generation cannot mutate its replacement.
- Delay required database writes during completion and immediately read after acknowledgement. The read returns committed state; a write failure returns a failure rather than a false success.
- Reject a queued turn at early preparation, runtime readiness, accepted-input transcript append, and required receipt settlement. Each claim remains delivered with proof or uncertain/reviewable, never silently lost.

**Acceptance:** all behavior and architecture checks below pass at the implementation head. A feature can submit/cancel/observe without actor/controller coordination; add a context receipt without editing the executor's acknowledgement bookkeeping; and add a turn option without restating it at relay hops.

## 13. Validation execution

Use registered cctl validation commands from the assigned worktree. Do not run Vitest, TypeScript, ESLint, Prettier, or the full application build directly as substitutes for the project runner.

During a behavior iteration, run the **single test file** being changed, for example:

```sh
cctl validate run test --queue-if-busy --require-match --json -- src/lib/workflows/conversation/turn-cancellation.integration.test.ts
```

Use the actual existing or newly created test filename for that step. Confirm a nonzero matched scope and inspect the returned verdict/run ID. A zero-exit result without matched tests does not establish a pass. When capturing JSON, redirect to a file under `.cc/temp/conversation-validation/` and parse that file; do not pipe a potentially large cctl response.

At each completed change, run relevant affected tests plus the registered typecheck and seams checks when interfaces/imports changed. At the final checkpoint run:

```sh
cctl validate run format --scope changed --queue-if-busy --json
cctl validate run lint --scope changed --queue-if-busy --json
cctl validate run typecheck --queue-if-busy --json
cctl validate run seams --queue-if-busy --json
cctl validate run test --scope changed --queue-if-busy --require-match --json
```

Then run the composed test files explicitly, including tests whose dependencies may not be selected by a changed-file heuristic. Run the registered full test suite once at the final head because this delivery changes shared semaphore and actor infrastructure. Do not repeatedly broaden passing tests without a new change or unresolved concern.

Inspect `git status`/diff after every snapshot test: automatic snapshot rewrites are not evidence that a storage contract was preserved. Test expected contracts, including fixture control cases that demonstrate durable writes or real dispatch where needed, so an inert path cannot pass the ephemeral/cancellation assertions.

The live smoke check is: create an isolated ordinary conversation in the branch's session worktree; stream a turn, Stop it during real work, submit another turn, toggle debug recording and read it back, then exercise a queued answer and one small graph lane pause/resume. Inspect durable state/transcripts and lifecycle logs. Use `cctl dev ensure` and verify the served worktree/build identity. Installed cctl/server behavior alone cannot prove branch behavior; caller environment variables do not automatically reach the validation scheduler. Do not run a Next build against the live database merely to verify this refactor. Follow the existing scratch-datastore/live-verification guidance for any required branch build.

## 14. Cross-cutting constraints and completion checklist

Add structured logging through `createLogger` with the design's attempt, phase, reason, and scope fields. Preserve useful existing event vocabulary and do not log prompt/profile content. Core dependency interfaces use method syntax. Use real production decision logic with injected provider/filesystem/Git/clock/storage boundaries; do not mock internal project modules.

Changes to shared concurrency must preserve all other `acquireQuerySlot` callers when no signal is supplied. Rebinding and destructive operations await lifecycle cleanup outside database mutation callbacks. Question, queue, fork, capability, profile, background-turn, and debug-generation guarantees are mandatory throughout extraction.

| Completion condition | Evidence owner |
| --- | --- |
| Complete seed/projection round trip and no ephemeral write escapes | Changes 1 and 5; real persistence fixtures. |
| One spec definition; flat snapshots preserved | Change 2; typechecking and codec fixtures. |
| One admitted attempt; acquisition cancellation; safe emitter, completion and drain | Changes 3 and 4; real actor race tests. |
| Committed command acknowledgement and explicit failure/reconciliation | Change 4; delayed/rejected real persistence tests. |
| One production composition, semantic reads, one backend owner | Change 5; composition tests and import guards. |
| Feature-owned receipts with current ordering and distinct policies | Change 6; accepted-input and failure-path delivery tests. |
| Shared AgentCall normalization; graph policy preserved | Change 7; fresh/hosted parity and graph adapter tests. |
| Debug ownership, single accounting, generation-safe verification | Change 8; debug parity and cancellation tests. |
| Semantic reuse and preview parity; no repeated recreation from consumed notices | Change 9; runtime policy tests. |
| Composed integration, registered checks, and branch-accurate smoke evidence | Change 10 and final progress record. |

Implementation may begin with change 1. The design makes the architectural choices needed for these changes; remaining work is implementation and verification against their stated contracts.
