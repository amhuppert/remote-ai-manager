# Conversation lifecycle and composition: technical design

Status: ready for implementation planning and execution against the reviewed baseline. Date: 2026-09-06. Baseline: `8489cd68f0bdea9506cdbfa585a86b808b7f5511`.

This design accompanies [the implementation plan](conversation-machine-implementation-plan.md). It turns the [conversation architecture review](collaboration/17b5f36f-f547-415c-8804-56a1eaf49942/round-1/agent_one/final_answer/answer.md) into selected contracts and bounded changes. Source and relevant tests were inspected; no implementation changes, test runs, builds, or live verification were performed while preparing these documents.

## 1. Objective and scope

Make a feature able to execute a conversation turn, contribute context, observe its result, or stop it through complete contracts. A caller should not coordinate actor events with controllers, install per-turn settings into a registry, interpret machine states to guess completion, or duplicate delivery bookkeeping.

The delivery covers the eight conversation-review areas: turn ownership; reconstruction and durability; shared turn inputs and explicit bindings; context contribution and delivery; persistence effects and dependency construction; shared execution normalization; debug ownership; and runtime configuration equality. Conversation-facing graph adapters and their integration tests are included. Graph scheduling, validation-round orchestration, landing, graph-document editing, graph repository mutation semantics, and graph runtime construction remain separate work.

Keep the long-lived XState conversation machine, the deterministic graph loop, the existing ephemeral job machines, the local SQLite write queue, backend descriptors, AgentCall, continuation disposition, and existing retry policies. Synthetic validator, repair, and compaction turns continue to use conversation hosting. Fresh merge tasks continue to run in their specified worktree without resuming an implementer conversation.

The native spec inventory contains existing feature specifications, including `agent-profile-library`, `memory`, `notepad`, `context-structured-output`, and `workflow-validator-cohorts`; it contains no dedicated conversation-refactoring specification. This delivery preserves their feature contracts. These are file-based engineering documents requested by Alex; they do not create or approve native SDD gates.

Use the existing installed stack and lockfile: TypeScript (`^5.7.0` declaration), XState `^5.28.0`, Zod `^4.3.6`, Vitest `^3.2.1`, and the existing SQLite repositories/write queue under Next.js `16.3.0-preview.10` and Node `>=20.9`. This delivery adds no dependency or configuration version change.

## 2. Problems addressed and success criteria

| ID | Current evidence | Required result |
| --- | --- | --- |
| C1 | `manager.ts` attaches an emitter before admission; preparation does not accept cancellation; the task actor ignores its invoke signal; completion is inferred in several callers. | One admitted attempt owns its emitter, controller, resources, and completion. Rejection cannot modify an incumbent. Cancellation cannot leave an old dispatch running behind a reported settlement. |
| C2 | `actor-input-loader.ts` omits the totals that `applySyncDerivedFields` later writes; adapter writes run in detached promises; the recording route performs a second write. | Construction preserves stored aggregates. Required lifecycle operations acknowledge committed state and report write failure. |
| C3 | Prompt options are repeated in the SDK facade, request, event, active turn, and invoke input. The runtime registry carries mutable tooling and workflow setup. | Define each turn field once; accept transient bindings with the request; expose domain facts through read methods. |
| C4 | `executePromptForMachine` owns context reads, prompt assembly, receipts, and cleanup for unrelated features. Notepad reference tracking happens before dispatch. | Each feature owns preparation plus its delivery rules. Failed delivery cannot advance its watermark. |
| C5 | `ActorDurableWriteSeams` omits `resetMemoryIndexDelivery`; production dependency assembly and test seams are scattered. | Durable effects form an explicit construction-time facet. Required collaborators are present in core factories. |
| C6 | Fresh tasks bypass AgentCall; results lose distinctions through repeated projections and error-message matching. | Share AgentCall execution and result mapping, preserving typed admission, cancellation, backend, and structured-output information. |
| C7 | Debug schemas/prompts live in conversation or prompt modules, and debug cleanup calls back into actor implementations. | Debug owns its reducer, schemas, prompt policy, and cleanup verification; conversation owns shared execution and accounting. |
| C8 | Runtime reuse compares output-format objects by identity; some configuration metadata belongs to CC rather than the provider port. | Reuse depends on semantic configuration, with one policy shared by execution and memory preview. |

The missing ephemeral memory-reset gate is a latent contract hole: current ephemeral callers use task runs, which do not take that streaming path. The emitter race principally exposes in-process callers; HTTP admission already has an additional busy check. Both are repaired without overstating current exposure.

Acceptance measures change locality and behavior: a new turn option has one owned definition; a new context contributor owns its own receipt; a graph caller needs no actor-state or controller protocol; and successful durable commands can be immediately read back. Function length and file counts are diagnostics, not acceptance budgets.

## 3. Owners and dependencies

| Owner | Location | Responsibility |
| --- | --- | --- |
| Conversation application service | Existing `src/lib/workflows/conversation/manager.ts` | Admission, semantic commands, attempt handles, result observation, stop/drain, and safe rebinding. Preserve `ensureConversationLifecycle` as a useful public operation. |
| Actor host | New `src/lib/workflows/conversation/actor-host.ts` | `.provide()` construction, actor registry, start/restore, and eviction after the lifecycle has drained. No feature admission or HTTP policy. |
| Attempt lifetime | New `src/lib/workflows/conversation/turn-attempt.ts` | Private nonserializable attempt resources, execution completion, cancellation and cleanup promises, emitter ownership, and receipt collection. |
| Turn definitions | New `src/lib/workflows/conversation/turn-spec.ts` | Zod field definitions, inferred request/normalized types, and one normalization operation. |
| Durable projection and effects | `actor-input-loader.ts`, `persistence-adapter.ts`, `persistence.ts`; new `effects.ts` | Paired initialization/projection, tracked writes and snapshot flush, and the durable/ephemeral effect implementations. |
| Production composition | New `src/lib/workflows/conversation/production.ts` | Assemble real dependencies once, lazily where necessary; expose the same construction to tests with explicit infrastructure dependencies. |
| Turn context | New `src/lib/workflows/conversation/turn-context.ts`, existing `pre-turn/`, feature modules | Fixed composition order and invocation of feature-owned receipts. |
| Runtime construction and reuse | New `runtime-binding.ts` and `runtime-instructions.ts`; existing `pre-turn/runtime-recreate.ts` | Backend handle lifetime, creation inputs, semantic reuse, and creation-time instruction receipts. |
| Execution result mapping | New `turn-result.ts`, existing AgentCall primitive | Preserve normalized outcomes and project them once into machine storage or caller-specific presentation. |
| Debug feature | Existing `src/lib/workflows/debug/` | Commands, phase decisions, schemas, prompt policy, verification, and feature-specific settlement. |

`manager.ts` remains the public lifecycle owner. Extract its actor construction into `actor-host.ts`; do not add another public facade in front of it. A `createConversationManager(deps)` factory holds the implementation. Default exports resolve a lazily constructed production instance; `production.ts` imports manager contracts as types and assembles dependencies without importing those default exports. This keeps the production import direction acyclic.

Retain HMR-safe process-local registries. They index actors, attempts, and managed backend handles; they do not provide an alternative setup API. Only conversation hosting mutates conversation registry entries. Other features receive a read projection or an operation.

## 4. Turn input and binding contracts

### 4.1 Shared serializable definitions

Define `conversationTurnSpecSchema` and `taskTurnSpecSchema` using the existing image, feedback, model-selection, execution-intent, output-schema, and filesystem-policy schemas. Export inferred types and derive caller subsets from their shapes. Normalize defaults once at admission: images become an empty array, optional model selection becomes the existing nullable representation, and backend/autonomy defaults use the current resolution policy.

The conversation spec owns `promptText`, images, backend, model selection, autonomy, output format, background waiting, queue metadata, document/notepad feedback, ask-user enablement, and filesystem policy. The task spec owns the shared execution fields plus task execution class/profile, privileged-instruction requirement, system instructions, portable tooling, timeout, structured-output presentation field, and transcript origin. Keep their discriminated variants; task-only inputs must not become meaningless prompt options.

Derive the event payload, request, and active-turn types from these definitions. The active turn intersects the normalized spec with machine-owned fields: `startedAt`, `executionAttemptId`, and the existing stream identity. Executor input embeds the normalized spec alongside resolved execution context instead of re-listing its options. Transport functions take named objects.

The persisted active-turn shape stays flat. `types.ts` keeps machine context/events and references the shared definitions. `persisted-snapshot-codec.ts` retains its image projection, top-level disposition guard, schema version, and serialized field names. Runtime-only callbacks, signals, promises, and handles never enter context or snapshots.

### 4.2 Explicit identity and execution inputs

Use the existing `ConversationTarget` internally. Define a server-side `ConversationAddress` as `{ projectPath, target: ConversationTarget }`. The resolver validates that the target belongs to that project. Convert to the storage session sentinel only at state-store, legacy transport, and snapshot adapters; logs use the existing scope helpers.

When the target replaces internal identity fields, the snapshot codec still writes the existing flat `projectName`, `sessionName`, `conversationScope`, and `conversationId` representation. Restore derives the internal target from those fields. Classify it as reconstructed in the disposition guard and test both directions. This is a projection between internal and stored shapes, with one unchanged stored format.

Use a discriminated `ConversationBinding`:

- `durable`: address plus an optional explicit execution worktree. Load the real conversation and session/project execution data through `actor-input-loader.ts`.
- `ephemeral`: address, execution worktree, backend, role, and optional transcript path. The host creates its initial timestamps, empty aggregates, and null continuation. Callers supply execution facts, not a fabricated `ConversationState` or durable actor-input record.

The submission carries an explicit transient execution context with `workflowContext` and `ConversationToolingOverrides` where applicable. It is captured with the accepted request and passed to the executor. Omission means absence on that attempt; an earlier turn's values cannot leak into a later one. Preserve portable MCP configuration and descriptor-specific apply timing. Remove `skipConversationLock`; it has no production caller.

Binding/request validation rejects queued-delivery metadata on an ephemeral binding before admission. The host owns no durable queue claim for such a request. Profile admission applies only to a real durable conversation; ephemeral construction does not invent a profile record.

Scope and persistence are independent: a project conversation can be durable, and a project-scoped synthetic compaction can be ephemeral. A hosted actor cannot change persistence mode or execution worktree while an attempt, external turn, or debug verification still owns resources.

### 4.3 Public lifecycle operations

Keep operation names at the existing domain facade; adopt these contracts beneath route-specific response adapters:

```ts
interface AdmittedConversationTurn {
  readonly attemptId: string;
  readonly completed: Promise<SettledConversationTurn>;
  cancel(reason: "user" | "timeout" | "stalled" | "shutdown"):
    Promise<SettledConversationTurn>;
}

type TurnAdmission =
  | { kind: "accepted"; turn: AdmittedConversationTurn }
  | { kind: "refused"; code: TurnAdmissionRefusalCode; message: string };
```

`TurnAdmissionRefusalCode` is the union `busy | cancelled | binding_mismatch | not_found | queue_review_required | profile_refused`. Preserve the existing detailed profile refusal in its variant. Unexpected load/storage failures remain typed exceptions, not a successful refusal. Transport mappers retain the existing HTTP status and body contracts.

`submitConversationTurn` owns admission and returns `TurnAdmission`. `executeConversationTurn` composes admission with the accepted handle's completion. `executeWorkflowTaskRun` uses that same lifecycle and the shared task result mapper; its private dispatch mutex, cancellation protocol, and state subscription disappear. Fresh tasks retain their separate entry point.

Both submit/execute take a single `ConversationTurnSubmission` object: `binding`, `turn` (the request union), optional `executionContext`, optional `transport: { streamId, emit }`, optional caller `signal`, and `waitUntilReady` (default false). `submitConversationTurn` returns `Promise<TurnAdmission>`. `executeConversationTurn` returns a refused admission or `{ kind: "settled", turn: SettledConversationTurn }`. Stream identity and emitter must occur together; task calls need neither. The underlying normalized prompt spec still supplies the existing persisted nullable stream identity.

`requestConversationStop(address, reason)` synchronously requests cancellation and returns `{ requested, settled: Promise<void> }`. Notification-only consumers may request it without blocking their own state transition, attaching the existing structured error reporting. Operations that delete, rebind, reuse a worktree, or report that stopping finished must await `settled`. `stopConversationActor` becomes the asynchronous drain-and-evict operation used by those consumers.

Expose `describeActiveTurn(address)` with attempt ID, kind, autonomy, workflow identity, stream ID, queued message IDs, and canonical origin message ID. The origin remains the first queued message ID when present, otherwise the live stream ID. Expose a narrow read-only tooling operation for MCP composition. Expose a managed-runtime configuration projection for memory preview. None returns mutable runtime state.

## 5. Admission, cancellation, and settlement

### 5.1 Admission sequence

1. Resolve/ensure the binding and check the current machine's readiness and queue-review policy.
2. Reserve admission in the lifecycle's private per-conversation state. `waitUntilReady: false` refuses a busy target; `true` waits for readiness and repeats the checks. Waiting requests own no emitter, backend settings, or query permit and can be cancelled independently.
3. For durable conversations, await `admitConversationProfileForTurn` before sending a prompt event. Carry the returned stored profile snapshot into runtime construction. This preserves `agent-profile-library` R8, including byte-for-byte replay. An already committed profile lock is not undone by subsequent cancellation.
4. Recheck reservation ownership, caller cancellation, binding, machine readiness, and queue eligibility after the awaited admission work.
5. In one synchronous section, install the private attempt and its emitter, send the attempt-identified submit event, and verify acceptance. Only then return the handle and invoke acceptance callbacks. Any refusal releases its reservation without touching an incumbent.

The in-memory reservation covers this local asynchronous gap. It uses the existing actor identity and requires no database lease or new scheduling service. It also prevents two calls from both clearing the readiness check before the profile write resolves.

Each accepted execution has one generated attempt ID. Do not replace it on entry to `acquiringResources`. A deliberate debug retry is a new admitted attempt, receives a new ID, and reuses the preserved serializable turn spec with the current explicit host binding. It does not reuse the old emitter or a completed attempt's mutable setup. A provider readiness/replacement retry within a call retains the attempt ID and the existing retry bound.

### 5.2 Runtime ownership

`TurnAttempt` owns its controller, emitter, acquisition/execution promises, resource releases, timeout/watchdog handles, context receipts, and final completion. Bind asynchronous callbacks to both the actor incarnation and attempt ID. A stale detach, backend-init callback, model-selection acknowledgement, completion, or cancellation cannot affect a successor.

Keep the current conversation lock synchronous. Check cancellation immediately before and after acquiring it. Add `signal?: AbortSignal` to `acquireQuerySlot` and its dependency contract. A signal aborted during configuration refresh or a queued wait must reject without consuming a permit; a grant/cancellation race releases a granted permit exactly once. Remove its waiter, listener, and timeout together. Preserve FIFO order and the existing admission-timeout error/code for uncancelled waiters.

Both `prepareTurn` and `runTaskRun` honor the XState invoke signal and the attempt controller. Preparation installs every acquired release immediately into the attempt and checks cancellation after each await. Streaming and task execution register their real promise before beginning work. Task execution uses the attempt's controller instead of creating a separate one after preparation.

The abort registry becomes an index over this controller. Remove backend close ownership from `abort-registry.ts`. Its indexed abort signals the owner, whose listener sends the attempt-identified machine event. The machine handles that event, aborts the controller idempotently, and enters settlement; repeated registry/controller notifications cannot start another cleanup. Timeout and stall detection request the same transition. Runtime closure is registered once with the attempt and awaited by settlement.

### 5.3 Machine transitions

| State or activity | Stop behavior | Next safe boundary |
| --- | --- | --- |
| Waiting for admission/profile lock | Cancel reservation; check it after any outstanding write; submit nothing. | Reservation released. |
| `acquiringResources` | Handle `ABORT_TURN`; signal preparation and queued semaphore acquisition. | Full turn settlement after preparation unwinds. |
| Streaming or task execution | Signal the invoked operation and request owned backend teardown. | Full turn settlement after actual execution and event handling unwind. |
| Settlement | Repeated stop joins the existing settlement promise. | Result application and required persistence complete. |
| Resting/parked | Reconcile the current durable status where the existing Stop behavior does so; cancel relevant outstanding verification for shutdown. | Reconciliation committed; no active resource owner. |

Generalize the existing `settlingQueuedDelivery` state so **every** admitted turn passes through its settlement actor before `applyingTurnResult`. Retain that serialized state key in this delivery to avoid an incidental snapshot migration. Change its implementation responsibility and use `settleTurn` for the actor/function name.

Settlement has this order:

1. Await the underlying preparation/execution promise, including accepted-input handlers and any backend close requested by cancellation. XState invoke cancellation alone does not establish that completion.
2. Finish feature-owned receipts and release unconsumed workflow-result claims. Run cleanup for receipts created before later preparation failed.
3. Finalize queued delivery around the full attempt, retaining the current uncertain/review behavior if acceptance or transcript commitment was not proved.
4. Release the query permit, conversation lock, timers, and listeners exactly once, continuing through cleanup failures so one failure does not strand unrelated resources.
5. Apply the actual result, accounting, continuation disposition, question/debug decision, and derived-field writes. Preserve observed partial usage when cancellation follows backend work.
6. Await the attempt's required durability barrier, then resolve its public completion and detach only its emitter. Permit another admission or queue drain only after the attempt's completion gate clears.

The outer queue finalizer remains until it owns all preparation and early-execution failure coverage and `queued-finalization.test.ts` still establishes that behavior. Only then remove the inner duplicate `settleAfterTurn` call. Queue uncertainty is an explicit outcome; it is never converted to delivered merely to unblock the queue.

`TurnAttempt` separates the underlying execution promise from the public completion promise. The settling actor awaits the former, preventing a cycle in which completion waits on itself. If a backend does not finish after cancellation, the target remains owned and unavailable for rebinding; a deadline is not evidence that it is safe to release its worktree. Existing provider teardown and timeout behavior must be tested to make that boundary practical.

### 5.4 Background turns, questions, and debug verification

Preserve descriptor-declared external/background turns. The external-turn handler retains its serial transcript/event chain and exposes an awaited drain operation. Its start associates an observed external activity with the current managed backend incarnation; its completion can settle only that activity. Stop closes that backend and drains the handler even when no completion event arrives. Do not acquire a new query permit retroactively for a provider-initiated turn or change its capacity policy in this refactor.

Public status is a projection of state **and context**. `executing` can be running or waiting for input. Keep the current mid-turn question flow and the post-turn parked flow distinct. Admission/completion and safe host disposal are separate predicates: debug verification and external activity may keep a host non-drainable after an agent turn has returned a result.

Debug verification retains its generation check. Leaving debug mode, replacing its generation, or disposing the host aborts and awaits the matching verification before destructive work. An old verification completion cannot update a later debug session.

## 6. Durable state and acknowledgement

### 6.1 Complete reconstruction

Define a `ConversationDurableSeed` in `actor-input-loader.ts`, derived from the stored conversation schema. It includes the existing identity/role/fork/profile/debug fields and all accumulated values written by the lifecycle: `promptCount`, `totalCostUsd`, `totalDurationMs`, `totalTurns`, `contextTokens`, `contextWindowMax`, and `lastActivityAt`, alongside transcript and continuation data.

Both normal creation and the project-conversation adapter use the same loader/projection. Ephemeral construction supplies explicit empty values through its own constructor. Machine initialization uses the supplied aggregates rather than initializing them to null. Preserve null as unknown; do not reinterpret it as zero or add lineage-cumulative cost to per-turn cost.

When restoring a usable control snapshot, retain the existing pending-question and debug restoration policy. Overlay row-owned accumulated totals and current prompt count from the durable seed before the restored actor can synchronize them. These values are authoritative on the hot row, not the debounced sidecar. Test both ordinary restart without a resumable snapshot and restoration with older sidecar totals. Avoid changing unrelated continuation recovery rules during this fix.

Keep initialization and `applySyncDerivedFields` adjacent in responsibility and test their round trip against the owned field list. A new aggregate must be added to both directions through that contract.

### 6.2 Persistence adapter contract

XState actions remain synchronous. The durable adapter synchronously registers each required write before dependency loading or other awaits, then performs it through the existing state-store write queue. It exposes a `whenDurable` barrier for the writes registered by a lifecycle command or attempt. Internally, use ordinary per-conversation promises and operation receipt lists; do not add durable operation records or a second database serialization layer.

An async lifecycle command captures its write receipts, sends its event, waits for the macrostep's snapshot capture, and awaits those receipts. Register the deferred snapshot receipt synchronously so lazy imports or microtasks cannot make a barrier resolve before its write is known. A failure rejects that operation; later independent operations can still run. Catching an error for logging must not turn its barrier into success.

Required durability includes the conversation projection, semantic command state, queue acknowledgement/uncertainty, consumed workflow-result claims, and the resume-token snapshot at a completed lifecycle boundary. Ordinary intermediate snapshots retain the existing debounce; explicit durable commands and completed turns flush their latest snapshot. Feature-specific advisory watermarks remain best effort as specified below.

This is an acknowledgement contract over existing separate writes, not a claim that hot-row, transcript, and sidecar writes are one atomic transaction. A partial failure retains recovery evidence. The barrier rejects; an async mutation command propagates the typed error, while an admitted turn projects it into the explicit `settlement_failed` outcome described in §8. Its completion promise resolves only after owned work has unwound, and its outcome does not claim successful finalization. Resource cleanup still finishes. A host with an unresolved required finalization error refuses automatic draining/reuse and unrelated mutating commands until reconciliation.

`ensureConversationLifecycle` owns reconciliation: make one bounded attempt to finish retained required writes using the already applied context/projection and existing receipt identities, then await durability. Do not dispatch the backend or apply accounting again. A repeated failure remains explicit; no retry timer or durable retry log is added. Queue ambiguity uses the existing review operation. A failed backend close must be reconciled before disposal/rebinding; a fulfilled execution promise alone does not prove that background activity is closed.

Make debug-adapter mutation methods asynchronous and return `applied`, `unchanged`, or `refused` with typed refusal information. Recording an already selected boolean is unchanged and schedules no write/event. Preserve intentional resting Stop reconciliation as an applied operation when it repairs durable status. The recording route awaits this command and removes its second direct state-store mutation.

Publish domain/UI mutation notifications after the write they describe commits. Backend text streaming remains live and does not wait for database commits. Optional naming and observational telemetry remain separate best-effort work; they do not delay command acknowledgement.

### 6.3 Ephemeral effects

As the immediate fix, include `resetMemoryIndexDelivery` in the existing gate. Then replace the manually maintained `Pick` with an explicit `ConversationDurableEffects` interface composed from the owned effect groups. The executor receives that facet, not raw state-store mutation functions mixed into a broad read dependency object.

Provide required durable and ephemeral implementations with TypeScript `satisfies` coverage. The ephemeral implementation performs no conversation, queue, memory/notepad watermark, workflow-result settlement, reference-registration, runtime-configuration-state, snapshot, naming, unread, or notification database writes. Its construction skips delivery contributors that require a durable owner. Transcript and image/artifact files retain their existing policy; ephemeral does not mean diskless.

Capability and MCP policy enforcement still executes for ephemeral runs; only persistence of CC bookkeeping is suppressed. Do not replace policy application with a successful no-op. Test the actual ephemeral actors with a real isolated database and a fake provider, and assert no table changes, including the currently unexercised streaming compaction reset path.

## 7. Context and instruction composition

### 7.1 Fixed turn composition

`turn-context.ts` is an explicit ordered composition of functions, with a small prepared-contribution interface for the features that have delivery receipts. It is not a registration bus, configurable plugin pipeline, or generic middleware stack.

A prepared contribution contains its rendered prompt contribution and, where needed, `onInputAccepted` and `finish` operations. Dependencies are method-based narrow interfaces. The composer runs preparation inside a full-attempt cleanup scope and invokes every applicable receipt in declared order. Contributors own whether failure degrades, blocks delivery, or produces uncertain delivery; the composer does not impose a universal catch or once-guard.

Keep user transcript and agent prompt separate. Preserve feedback rewriting, image persistence/markers, native spec expansion, and canonical reference syntax. Final agent text order remains: notepad change notice, workflow results, live ticket, memory index, debug context, expanded user text. Images remain separate AgentCall image references. Replace the positional `buildEffectivePrompt` API with a named-input pure assembler and remove the unused image branch after its callers use the existing image pipeline.

Task runs continue to use their established smaller context policy, including live-ticket context for session-scoped runs. Do not enable conversational notepad, memory, debug, or workflow-result contributors for task runs merely because the composer can support them.

| Contribution / effect | Applicability and preparation | Receipt / failure contract |
| --- | --- | --- |
| Feedback and images | Conversation turns; existing feedback and image helpers. | Preserve queued transcript ownership and original reference text. Required image/assembly failures end preparation. |
| Native spec expansion | Conversation agent prompt only. | Pure expansion; no receipt. |
| Explicit notepad references | Conversation turns in either scope; read canonical injection content. | Read failure keeps the original reference. Record the prepared revision/comment marker only on `input_accepted`; recording failure logs and leaves durable tracking unchanged for retry on a later turn. |
| Notepad change notices | Durable conversation turns; compare tracked and current prepared state. | Best effort preparation and accepted-input watermark write. Coalesce repeated acceptance events within the attempt. Uncommitted advances are eligible again on the next turn. |
| Memory index | Durable conversation turns in both scopes; current memory service owns full/delta choice. | Record only on input acceptance, best effort; preserve compaction reset and context-loss policy. |
| Workflow results | Durable session conversation turns. | Existing claim/settle/release protocol. Claim-read failure can degrade as today; acceptance settlement remains required. Release an unsettled claim during full-attempt cleanup. |
| Live ticket | Session conversation and task turns. | Best effort read; no receipt. |
| Fork seed | Applicable conversation backend continuity path. | Existing acknowledgement requires acceptance and the corresponding backend reference; retain its distinct idempotency rules. |
| Queued user delivery | Claimed conversation turns. | Acceptance plus successful `appendTranscriptEntryOnce` precedes delivered status. Otherwise preserve uncertainty/review. Full-lifetime settlement owns the claim. |
| Debug prompt context | Conversation turn in active debug mode. | Pure feature-owned phase prefix and schema selection; shared execution owns delivery. |

For explicit notepads, prepare an immutable delivery receipt from the state actually rendered, including its revision and open-comment marker. Change the tracker to accept this prepared state rather than re-reading comments when acceptance arrives. A later comment or content revision must remain eligible for a notice.

To avoid repeating a notice for content expanded in the same message, let notice preparation use those prepared receipts as an **in-memory baseline**. Do not first persist them. A current revision/comment marker newer than the rendered receipt still produces a notice. On acceptance, write reference receipts before their associated change-notice advances so an earlier receipt in this attempt cannot overwrite a later one. Retain the existing repository upsert; it is not a monotonic merge. Advisory duplicates caused by an older receipt are permitted, but no receipt may advance beyond the state its message actually carried.

Accepted-input processing first attempts independent advisory receipts, then the required workflow/fork/queue receipts in their existing order. A required receipt failure is recorded, all necessary cleanup still runs, and queue delivery is not declared successful without its own evidence. Backend retries do not blindly repeat successfully acknowledged receipts.

### 7.2 Creation-time instructions

`runtime-instructions.ts` owns the existing creation-time sequence: focus reference registration, reference-document list, alignment instruction, pending notices, stored profile replay, and session instruction composition. Preserve this instruction order: CC scope context; ask-user policy; CLI instruction; memory advisory contract; project spawn policy where applicable; alignment; TDD; provider tool hint; reference documents; pending notices; stored profile last.

Pending notices are consumed at successful runtime creation, through their existing subtract-only drain, not on turn acceptance. A notice added after the read remains pending. Do not combine that receipt with the per-turn watermark protocol. Persisted profile text is replayed verbatim and never recomposed from a changed profile library record.

Existing helpers for capability cascades, alignment, image persistence, fork seeds, and review feedback remain policy owners. Extraction moves their composition and receipt ownership; it does not reimplement their decisions.

## 8. Results and graph integration

`turn-result.ts` owns normalization from AgentCall to conversation presentation/storage and task presentation. `AgentCallResult` remains the source for backend outcome, normalized error, usage, structured-output provenance/repair, artifacts, continuation disposition, and background waiting. Derive `TaskRunUsage` from that vocabulary and perform optional-to-null presentation conversion once.

Use a transient `TurnExecutionOutcome` around that existing result:

- `call_result`: contains the complete `AgentCallResult`.
- `not_started`: contains typed reason `cancelled | query_slot_timeout | backend_admission | configuration`, display message, and applicable cancellation/admission details. It contains no fabricated usage.
- `settlement_failed`: contains code `delivery_receipt | persistence | runtime_close`, display message, and the available AgentCall result or null. It preserves evidence that the backend may already have run.

`SettledConversationTurn` contains attempt ID, this outcome, current public status, and the current pending-question projection. The existing `PromptActorResult` remains the flat machine/snapshot projection, built in one mapper. Caller-specific stream and `TaskRunResult` adapters consume the transient outcome; they do not reconstruct a result through one another. Keep current HTTP/task-facing result shapes where they are externally consumed and retain typed failure detail internally.

Fresh tasks dispatch through `executeAgentCall({ kind: "task_run", ... })` and the same result mapper. Preserve their resolved agent identity, explicit merge worktree, autonomous permissions, timeout, and **absence of a resume reference**. This gives fresh tasks the same admission, structured-output gate, and normalization as other task execution without constructing a conversation actor.

The graph implementer calls the conversation facade directly with its typed binding, turn spec, and workflow identity. It no longer imports `executePromptStream`, constructs a no-op SSE sink, or redeclares a positional function signature with `never[]` images. Validators, output capture, context artifact generation, and repair continue using the task facade with explicit bindings.

Keep a graph-owned result adapter next to `implementer-runner.ts`/`errors.ts`. It maps `query_slot_timeout` to the existing no-dispatch retry/accounting behavior, cancellation to interruption, schema refusal to validation evidence, and actual backend failure according to its typed classification. Presentation messages are never inputs to these decisions. The graph retains failure increments, reset/threshold policy, continue/park/land decisions, and execution fences. Do not modify graph failure-budget semantics as part of normalization.

Backend schema conformance and workflow domain validation remain distinct. Preserve named readiness/replacement retry policies, AgentCall structured-output repair limits, and graph retry budgets. Each owns a different retry boundary.

Graph pause/abort/halt uses the one conversation stop operation. Its state transition can request cancellation immediately; the conversation facade blocks a later resumed dispatch until the preceding attempt has actually settled. Worktree deletion/rebinding paths must await the drain result outside serialized graph mutations. Never await backend teardown while holding the SQLite mutation queue that teardown may itself need.

## 9. Debug and runtime reuse

Move conversation debug schemas to `src/lib/workflows/debug/schemas.ts`, prompt constants/schema selection to `src/lib/workflows/debug/prompt-policy.ts`, and low-level verification implementation/types from `actor-implementations.ts`/`types.ts` into the existing debug verification owner. Update all imports directly; retain no compatibility re-export cycle. The current model-facing debug schemas are already JSON-schema constants: type them as such and remove the redundant double casts. Preserve their sibling Zod validators. The evidence-analysis transport intentionally uses a flatter shape than its domain validator, so this delivery does not replace it with mechanically generated JSON schema.

The pure debug reducer remains in the debug feature. Conversation applies common totals, prompt count, continuation, and cleanup exactly once, then asks debug finalization for its phase decision. Debug retry stores the existing serializable spec but obtains a new admitted attempt. Verification is generation-bound and its asynchronous completion uses the same durable command contract. Remove the debug dependency on the conversation actor implementation module.

`runtime-binding.ts` is the single owner of a `ManagedConversationRuntime`: backend handle, actor incarnation, execution binding, applied configuration metadata, and close promise. The backend registry indexes the handle; lookup does not transfer ownership. Move CC's `alignmentVersion` out of the provider runtime interface and into managed metadata. Preserve the provider's actual session instructions and required runtime capabilities.

`pre-turn/runtime-recreate.ts` accepts named current/desired configuration values. Reuse the existing pure `stableStringify` in `src/lib/state-store/serialization.ts` for JSON value comparison; object key ordering is irrelevant, array ordering remains meaningful, and absent optional fields are handled consistently. This adds no dependency on database initialization. Do not invent a second serializer or a new hashing library.

| Configuration input | Selected change policy |
| --- | --- |
| Execution worktree, persistence, scope/role and workflow authority binding | Host binding check; refuse conflicting active reuse, drain and reconstruct at a resting boundary. |
| Backend, complete model selection, output schema, filesystem policy | Compare semantic values; changed creation requirements recreate before dispatch using current continuation policy. Equal freshly allocated schema objects reuse the runtime. |
| Repeatable baked instructions: scope context, ask-user policy, CLI/memory framing, spawn policy, alignment, TDD, tool hint, reference list, stored profile block | Build a stable instruction key from the actual ordered text. A changed key recreates before dispatch. The profile block always comes from its admitted stored snapshot. |
| Pending creation notices | Delivery receipt only; exclude from the repeatable instruction key. Consuming notices must not itself force another recreation on the following turn. |
| Portable MCP and capability cascades | Existing backend-declared startup/between-turn/idle application policy remains authoritative; preserve rejection and persisted bookkeeping semantics. Do not force recreation for every live-applicable change. |
| Per-turn memory, notepad, ticket, workflow results, feedback, images, debug context | Recompose each applicable turn; exclude from creation identity. |
| Timeout, stall monitoring, SSE subscriber | Attempt policy; exclude from runtime creation identity. |

The stable instruction-key change intentionally makes altered repeatable baked instructions take effect on the next turn; it needs behavior tests, not just a code move. Focus registration precedes the reference-list snapshot so creation does not manufacture a different desired key on the following turn.

Memory preview calls the same reuse policy through a read-only managed configuration projection. At rest it uses the currently known model/schema/write envelope; it cannot predict a future caller's overrides. Document that limit and test parity for every configuration dimension both paths can know.

## 10. Persistence compatibility, logging, and validation

No SQL schema change, snapshot version bump, alternate write format, compatibility alias, or stored migration is needed for this delivery. Keep flat active turns, the current snapshot key for generalized settlement, supported continuation references, and existing restore coercions. Retire proven legacy coercions with an idempotent stored migration when a separate justified codec change is undertaken; that deferred cleanup is not a condition for implementing these fixes.

Use `createLogger` and the scope helpers from `.kiro/steering/logs.md`. Preserve existing useful events. Add bounded lifecycle diagnostics `conversation.turn.admitted`, `conversation.turn.cancel_requested`, `conversation.turn.settlement_failed`, `conversation.turn.settled`, and `conversation.persistence.failed`, with project/scope, conversation ID, attempt ID, phase/reason/code, elapsed time, and safe receipt/resource counts. Log a requested stop separately from a settled stop. Exclude prompt bodies, image data, profile text, tokens, and provider secrets.

Use pure-function tests for projections and policy; real XState invocation tests with controlled infrastructure promises for cancellation races; isolated SQLite fixtures for durable acknowledgement and delivery; the existing fake backend descriptor for end-to-end actor contracts; and graph integration tests for the boundary. No internal-module `vi.mock()` and no tests that prove only calls between fakes.

Validation must demonstrate: cancellation before slot acquisition never dispatches later; a timed-out task cannot supply the next caller's result; stale emitter/verification callbacks cannot affect successors; every queue claim is settled or explicitly uncertain; restored aggregates survive the next turn; debug commands return readable committed state; rejected writes return errors; ephemeral actors change no database tables; notepad/memory receipts respect acceptance; graph pause/resume preserves fencing and accounting; and equivalent runtime configuration reuses its handle.

Implementation and rollout details, concrete file ownership, registered validation commands, and per-change acceptance are specified in the accompanying plan.
