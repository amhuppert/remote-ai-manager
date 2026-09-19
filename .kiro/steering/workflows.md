# Workflow Orchestration

Command Center has three orchestration shapes. Pick by shape; do not invent a fourth (see P7 in `docs/reports/2026-07-12_consolidated-architecture-design-and-plan.md`):

1. **Conversation actor** (XState v5, long-lived) — `src/lib/workflows/conversation/`. One actor per conversation; owns the prompt-turn lifecycle, queue drain, and rehydration. Conversation turns and hosted tasks enter through its semantic manager API. Fresh tasks use AgentCall without a conversation host.
2. **Job machines** (XState v5, ephemeral) — `src/lib/workflows/merge/` (Smart Merge) and `src/lib/workflows/commit/` (Smart Commit), hosted by `src/lib/jobs/queue.ts`. Machine actors are not restart-durable by decision; the `BackgroundJob` registry records phases and outcomes.
3. **Graph engine** (deterministic execution loop, NOT XState) — `src/lib/workflow-graph/`. Multi-context executions with loop-generation fencing at the persistence layer. Do not convert it to XState — the loop already has machine-grade guarantees plus fencing XState cannot provide.

The imperative **collaboration slice** (`src/lib/workflows/collaboration/`) is not a fourth engine: `runAsymmetricCollaborationSlice` is a plain async composition of the shared primitives (lanes, WorkflowEnvelope, gates), hosted by a thin manager behind its HTTP route. It is precedent for composing primitives imperatively when no engine lifecycle is needed — not for building another orchestrator.

## Layout

```
src/lib/workflows/
├── types.ts                    # BaseWorkflowContext (shared context fields for the merge/commit job machines)
├── utils.ts                    # extractErrorMessage, errorAssign, createTerminalStates
├── conversation/               # the conversation-actor spine
│   ├── machine.ts              # setup() → createMachine(); long-lived, zero final states by design
│   ├── actors.ts               # provided actor invocations and owned settlement
│   ├── actor-implementations.ts# production actor logic (AgentCall dispatch, pre/post-turn concerns)
│   ├── manager.ts              # admission, semantic commands, observation and cancellation
│   ├── actor-host.ts           # shared creation/rehydration factory and subscriptions
│   ├── production.ts           # lazy production dependency composition
│   ├── turn-attempt.ts         # admitted work, cancellation and completion receipts
│   ├── runtime-binding.ts      # backend incarnation, configuration and owned close
│   ├── persistence.ts          # debounced snapshot writes → ConversationState.machineSnapshot
│   └── runtime-state.ts        # external registry for non-serializable runtime data
├── merge/, commit/             # ephemeral job machines (types.ts, actors.ts, machine.ts)
├── collaboration/              # collab-mode manager, lane callers, WorkflowEnvelope consumer
├── primitives/                 # shared composable modules — see the adoption matrix below
├── validation-fix.ts           # agent fix turns for pre-merge validation failures
├── workflow-draft/             # planner draft registry (MCP side channel)
└── schemas.ts, route-handlers.ts, queries.ts, mutations.ts, …  # graph workflow definition/config domain code
```

There is **no root shared workflow tier**: snapshot persistence and runtime-state registries are owned per machine directory. `conversation/persistence.ts` and `conversation/runtime-state.ts` are the production patterns — when a new machine needs snapshot persistence or a runtime registry, copy the pattern into its own directory; do not import the conversation-specific modules and do not hunt for a shared module that does not exist.

## Machine anatomy

```typescript
export const fooMachine = setup({
  types: {} as { context: FooContext; events: FooEvent; input: FooInput },
  actors: { /* fromPromise stubs */ },
  guards: { /* pure boolean fns */ },
}).createMachine({
  id: "foo",
  context: ({ input }) => ({ _schemaVersion: 1, ...input, error: null }),
  initial: "firstState",
  states: { /* ... */ },
});
```

- `_schemaVersion` in context — restore discards snapshots whose version mismatches.
- The commit machine generates its final states with `createTerminalStates` (`workflows/utils.ts`); merge hand-defines its five terminal states because each carries per-state `finalStatus`/`phase`/`completedAt` assignments the helper's uniform template does not express. Reach for the helper when terminals are uniform.
- The conversation machine has **zero final states by design** — the actor is long-lived; cleanup happens through the manager, not machine output. Its `ConversationContext` (`conversation/types.ts`) is independent of `BaseWorkflowContext`: it carries its own identity/lifecycle fields (`createdAt`, `lastActivityAt`, `status`) and has no `startedAt`/`completedAt`.

## Actor pattern: stubs + `.provide()`

Actors are `fromPromise` stubs whose default impls lazy-import production logic:

```typescript
// actors.ts
export const doWork = fromPromise<WorkOutput, WorkInput>(async ({ input }) => {
  const { doWorkImpl } = await import("@/lib/some-module");
  return doWorkImpl(input);
});
```

Production injects via `.provide()` at the hosting site (`conversation/actor-host.ts` with required dependencies from `conversation/production.ts` for the conversation actor; the job machines' `fromPromise` defaults already lazy-import production logic, so `jobs/queue.ts` starts them unprovided). Tests inject fakes via `.provide()` — **never `vi.mock()` for actors**:

```typescript
const testMachine = fooMachine.provide({
  actors: { doWork: fromPromise(async () => ({ result: "fake" })) },
});
```

## Non-serializable state (`conversation/runtime-state.ts` pattern)

Machine context must be JSON-serializable. The host's runtime registry stores non-serializable ownership: `TurnAttempt` owns admitted execution, cancellation, receipts and completion; `ManagedConversationRuntime` owns backend incarnation, configuration and close. The backend registry is an index for capability/live-input adapters. It does not own close. Stop, rebind and disposal await execution, close and required durable settlement before releasing the host. Failed settlement stays owned for explicit reconciliation.

Consumers submit through `submitConversationTurn` or `executeConversationTurn`, cancel through the admitted handle or `requestConversationStop`, and observe semantic manager reads. Questions use `registerConversationQuestion` and batch-matched `clearConversationQuestion`; debug commands share the serialized durable command boundary. Consumers do not send machine events or coordinate controllers. The exact boundaries are enforced by `conversation/boundaries.arch.test.ts`.

## Snapshot persistence (`conversation/persistence.ts` pattern)

- Intermediate snapshot writes debounce 500 ms. Command acknowledgement, turn completion and disposal flush their required row and snapshot receipts before reporting success.
- `persistSnapshotAfterTransition` synchronously enrolls a receipt, then defers capture until the XState macrostep commits. A durability barrier includes those deferred captures.
- Restore validates `_schemaVersion` and returns `null` on mismatch (actor starts fresh). A usable snapshot receives the durable row's authoritative totals and prompt count before hosting.
- Deps are injected via a setter (`setPersistenceDeps`) + `_resetForTesting` — the setter DI pattern from engineering-principles.

## Job-machine hosting (`jobs/queue.ts` + `jobs/machine-host.ts`)

`machine-host.ts` owns the generic projection loop once — `dispatchMachineJob` (guard → register → actor → start under a `job:<type>` trace) and `createJobActorSubscription` (deduped phase diffs → status broadcasts, terminal output → job record). `queue.ts` supplies the host side (registry, session lock, broadcast, persistence) plus a per-job-type `JobSubscriptionConfig` (`phaseOf`/`mapOutput`); `graph-merge-runner.ts` reuses the phase-diff observer (`observePhaseTransitions`) for join breadcrumbs. Merge and commit jobs are **ephemeral by decision (plan D12)**: actors exist only in-process, no machine snapshot is persisted, a server restart does not rehydrate them; the durable record is the `BackgroundJob` row, and stale-job recovery closes out orphans rather than resuming them.

## Error handling

Every actor invocation has `onError`. Use `errorAssign()` / `extractErrorMessage` from `workflows/utils.ts` (handles `Error`, `gitOutput`-carrying errors, and unknowns) rather than hand-rolling extraction.

## Guards

- **Context guards**: `({ context }) => context.autoResolve`
- **Priority via sequential `always`** (first true wins):

```typescript
evaluatingExit: {
  always: [
    { guard: "isPlanComplete",       target: "#completed" },
    { guard: "isCapReached",         target: "#halted" },
    { guard: "isCircuitBreakerOpen", target: "#halted" },
    { target: "executingIteration" },
  ],
}
```

## Adoption matrix — shared concepts

One row per shared concept: where the canonical implementation lives, who actually consumes it in production, its status (`supported` = use it for new work; `experimental` = exists, unproven, do not build on without surfacing; `migration-only` = exists only to serve a planned migration), any competing path still alive, and the condition under which the competing path is deleted. Deletion conditions reference `docs/reports/2026-07-12_consolidated-architecture-design-and-plan.md` (“the plan”).

| Concept | Canonical module | Production consumers | Status | Competing path | Deletion condition |
|---|---|---|---|---|---|
| AgentCall (normalized agent execution) | `primitives/agent-call-facade.ts` + `agent-call-vocabulary.ts` (conversation + task-run adapters) | conversation actor (`conversation/actors.ts`, `actor-implementations.ts`, `execute-workflow-task-run.ts`); collaboration (`collaboration/agent-caller-production.ts`); graph (`workflow-graph/implementer-runner.ts`, `workflow-collaborator-caller.ts`); `shared/optimistic.ts` | supported | — | — |
| Lane (agent continuity + scheduling) | `primitives/{lane-vocabulary,lane-service,lane-scheduler,lane-store}.ts`, composed by `primitives/workflow-agent-caller.ts` | Collaboration lanes; graph implementer/validator lanes via `LaneService` over the durable `workflow-graph/graph-lane-store.ts`, composed in `workflow-graph/lane-continuity.ts` | supported | — | — |
| Graph lane identity (who a lane belongs to) | `workflow-graph/lane-identity.ts` — `laneStateKey` (the `laneStates[contextId]` inner key: `implementer` \| `context_validator:<assignmentId>`), `graphLaneId`/`parseGraphLaneId` (primitive lane id, NUL-joined `lane`/`contextId`/`assignment`), `assignmentFingerprint` (the frozen started assignment) | `graph-lane-store.ts`, `lane-continuity.ts`, `validator-runner.ts`; per-assignment artifacts in `execution-logger.ts` | supported | — | — |
| Context placement (authored lane + file ownership) | `workflow-graph/definition-schemas.ts` (`contextPlacementSchema`, `ownedPathSchema`) for shape; `workflow-graph/placement-validation.ts` for accept-time semantics — lane grammar, the session lane's read-only restriction, the read-only output contract, same-lane ownership disjointness | every authoring surface through `validateAuthoredDefinition` (`cctl workflow validate`/`create`/`replace`, the saved- and live-edit appliers, the builder); lane provisioning, scheduler admission, the implementer write envelope, ownership-scoped landing | supported | placement-less STORED definitions and archived executions, inflated by the legacy transformer at the stored-load boundary | Delete the inflate-boundary transformer when no persisted definition, saved template, or archived execution predates placement. Never re-add a runtime default — an optional `placement` silently resurrects deterministic seed-time assignment |
| Typed SSE publication + lifecycle projection | `events/publication.ts` (`publishEvent`, `PublishFn`, `publishEventBestEffort`, `publishScopedStatus`) + private `events/{status-bus,lifecycle-projection}.ts` implementation | all server event publishers, including dev-server, graph, collaboration, conversation, jobs, notifications, prompts, and route modules | publication is supported; `subscribeLifecycle` remains **experimental** with zero production subscribers | raw `events/broadcaster` is restricted to `publication.ts` and the SSE transport | Keep the direct-import ratchet at zero. Land a production lifecycle subscriber or delete the dormant subscription/projection interface under the adopt-or-delete rule. |
| ArtifactRegistry | `primitives/artifact-registry.ts` (+ `default-session-artifact-registry.ts`) | graph `shared-documents.ts`, `script-validator-runner.ts`, `charter/service.ts`; `agent-runs/` service + routes; conversation actor (focus memory) | supported | — | — |
| WorkflowEnvelope (durable workflow lifecycle) | `primitives/workflow-envelope-{vocabulary,store,repository}.ts` + `recover-workflow-envelopes.ts` | Collaboration runs (restart discovery + recovery) | supported | `BackgroundJob`, `AgentRunRecord`, and `GraphWorkflowExecution` remain separate lifecycle vocabularies by decision | None now — four-way convergence explicitly deferred (plan D15) |
| Gate result vocabulary | `primitives/gate-vocabulary.ts` (pass / fail / pause envelope) | Via the gates below | supported | — | — |
| Human approval gate | `primitives/human-approval-gate.ts` | Collaboration envelopes (`collaboration/envelope.ts`, `workflow-envelope.ts`) | supported | `workflow-graph/approval-gate.ts` is graph-owned and deep by design — a sibling, not a competitor | — |
| Circuit breaker | `primitives/circuit-breaker-gate.ts` (pure policy fn) | graph `execution-loop.ts`, `iteration-orchestrator.ts` | supported | — | — |
| Structured-output gate | `primitives/structured-output-gate.ts` (schema validation) + `agent-backends/structured-output.ts` (shared candidate extraction) | `agent-call-facade.ts` (every dispatch with an `outputSchema`); `workflow-graph/validator-runner.ts`; `sessions/conflict-resolution.ts`; `agent-runs/service.ts` | supported | — | — |
| Script-validation gate | `primitives/script-validation-gate.ts` (single `ScriptValidationOutcome` union) | graph script-validator remediation (`workflow-graph/context-validation-coordinator.ts`, `script-validator-runner.ts`); merge validation (`workflows/validation-fix/actors.ts`) | supported | — | — |
| User-input gate (parked questions) | `workflow-graph/user-input-gate.ts` | graph loop, `validator-runner.ts`, conversations ask/answer routes | supported | — | — |
| Config cascade | `workflow-graph/resolve-config.ts` | Every graph execution (see the cascade section below) | supported | — | — |
| Live-edit apply core | `workflow-graph/live-edit-apply.ts` (`applyLiveEditsToActiveExecution`: gates → atomic mutation → one `liveRevision` bump → mandatory events) | runtime-edits HTTP route; plan-repair supervisor | supported | — | Never add a second mutation path for a launched execution's working definition |
| Plan-repair supervisor (D1) | `workflow-graph/plan-repair/{trigger,schemas,prompt,agent-runner,supervisor}.ts`, composed at the `kickOffExecutionLoop` seam | every loop settlement (`engine-composition.ts` `runExecutionLoopWithPlanRepair`) | supported | — | — |
| Agent profile (prompt identity for an agent role) | `agent-profiles/library-service.ts` (resolution + listing) and `agent-profiles/composer.ts` (the rendered block + snapshot) | conversation creation/admission (`conversations/profile-resolution.ts`), the library API, `cctl agent list\|get`, and workflow assignment references (`workflow-graph/assignment-references.ts`, `seed-assignment-snapshots.ts`) | supported | — | — |
| Agent-profile deletion references | PORT: `AgentProfileReferenceReporter` declared by `agent-profiles/library-service.ts`, implemented by `workflow-graph/profile-reference-reporter.ts` | `library-service.previewDeletion` / `delete`, wired only at `agent-profiles/route-handlers.ts` | supported | — | Domain code in `agent-profiles` never imports `workflow-graph` — the reporter reaches it through the route composition, and an unwired library REFUSES rather than reporting "no holders". The delete dialog holds its confirm button until the preview is on screen (advisory content, mandatory step) |
| Validator authority (blocking vs advisory) | `workflow-graph/config-schemas.ts` (`validatorAuthoritySchema`, per-assignment, default `advisory`) — read by `role-instructions.ts` (which contract and where the mandate renders), `validator-runner.ts` (which verdict schema is dispatched), `validation-cohort.ts` (`concludeCohort`'s partition), `lane-identity.ts` (fingerprint input) | every graph validation round; `resolve-config.ts` seeds the single blocking acceptance-criteria seat; the shared `workflow-config` assignment editors author it | supported | — | Authority is never inherited or keyed on an assignment id — the ONE blocking seat is an explicit write in `SEEDED_WORKFLOW_DEFAULTS`, so a specialist arrives non-blocking and gains blocking power only by an author's deliberate act. Read the authority section before adding a consumer: an advisory seat's verdict schema has no `issues` field, so "handle both authorities" is a schema selection, never a runtime branch on a shared shape |
| Dangling-reference fail-closed check | `workflow-graph/assignment-references.ts` (`checkDefinition` + `checkWorkflowDefaults`) | `storage.ts` accept, `validate-route-handlers.ts`, execution start in `execution-repository.ts`, config PUT | supported | — | Validate and execution start must run BOTH checks: a definition inherits staffing from `workflowDefaults` it never mentions, and checking only the definition turns a dangling default into an unlocated resolve failure inside snapshot seeding |
| Control-flow route projection (D4) | `workflow-graph/route-projection.ts` (`projectRoutes`: edge resolution, context verdicts, `else`, cardinality, must-run, publish settlement), adapted for a live execution by `execution-routes.ts` | scheduler eligibility + land gate, lane readiness, joins, upstream-input resolution, completion/publish quiescence, criterion must-run locks, CLI/UI read surfaces | supported | — | Never add a second guard evaluator or a second route computation — guard documents are evaluated only through `workflows/primitives/output-schema-subset.ts` |
| Mutation staging seam (D4) | `workflow-graph/runtime-edits.ts` (`prepareLiveExecutionEdits` / `finalizePreparedEdits`) over the repository-owned `executionStateRevision` + `structuralRevision` fences | runtime expansion, loop-pass materialization | supported | `applyLiveExecutionEdits` remains the single-shot path for in-queue writers (CLI/UI/plan-repair) | None — the two are one core; the staged pair exists for writers that must validate outside the write lock |
| Runtime graph expansion (D4) | `workflow-graph/expansion-service.ts` + `generated-child-config.ts` + `expansion-receipts.ts` + `expansion-caps.ts`, with the server-resolved lane identity (`agent-gateway/lane-identity.ts`) | `cctl workflow graph expand` lane route only | supported | — | Never mint a second structural exemption: expansion and loop unrolling share `LiveEditOptions.structuralSource`, which no client-reachable entry point can set |
| Loop settlement (D4) | `workflow-graph/loop-settlement.ts` (activation, definition-ordered slot admission, the ordered decision) + `loop-resolver.ts` (accept-time) + `loop-budgets.ts` + `loop-history.ts` / `loop-ledger.ts` (reads) | every execution loop settlement, after `settleRoutesForPass` | supported | — | One unroll path only — a pass slot is granted exclusively by `settleLoops`'s definition-ordered walk |

### Graph ownership and supported tolerances

Graph construction lives in `workflow-graph/engine-composition.ts`; `production.ts` binds infrastructure and receives the concrete interfaces assembled by `workflows/production.ts`. Lifecycle adapters use `lifecycle-service.ts`, certification uses `context-validation-coordinator.ts`, reservation/provision/finalization uses `context-scheduler.ts`, and context landing settlement uses `context-landing.ts`. Task completion is bound by `execution-tool-context.ts`. Saved, live and template editors share `document-edit-mechanics.ts`; outline producers and CLI readers share `live-outline-schemas.ts`. The architecture seam rules enforce import direction and keep command adapters from writing the live working definition.

These rows distinguish persisted decoding from valid current absence. The named module owns the tolerance; the evidence column names regression coverage, not a claim that all retained data has been migrated. Retirement requires inspecting the supported stored population or changing the stated product contract.

| Tolerance owner | Supported meaning | Evidence | Deletion condition |
| --- | --- | --- | --- |
| `schemas.ts` and `lane-continuity.ts` | Normalize provider-specific session references and lane metrics; an absent assignment fingerprint is unknown, not proof of drift | `graph-lane-store.contract.test.ts`, `workflows/schemas-graph.test.ts` | All supported rows use neutral references/metrics and every resumable lane has acquired a fingerprint |
| `schema-cutover-guard.ts`, `edge-identity.ts`, `placement-migration.ts` | Give stored definitions deterministic edge IDs and authored placement; current authoring still requires placement | `placement-migration.test.ts`, migration `0016-graph-workflow-context-placement.test.ts` | No retained definition, template or execution predates these fields |
| `execution-origin.ts` and execution codec | Derive absent origin from real template seeds; one-off executions carry null seed fields | `graph-workflow-execution-codec.test.ts` | Retire the origin floor when no pre-origin rows remain |
| `workflows/charter-schemas.ts` and graph charter renderer | Preserve frozen prose scope and retired access-policy fields verbatim; render prose scope globally and omit retired permission text; refuse new authored use | `legacy-frozen-charter-tolerance.test.ts` | Every retained saved/frozen charter is readable without these fields or has another lossless historical reader |
| `lane-collaboration-resolver.ts`, `validation-prompt-section.ts`, validation singleton | Pre-snapshot executions resolve collaboration from saved/global config and validation selectors from the registry; frozen snapshots take precedence | `lane-collaboration-resolver.test.ts`, `validation-prompt-section.test.ts` | No resumable execution lacks the respective snapshot; retire each fallback separately |
| `memory/delivery-policy.ts` | Pre-snapshot graph lanes use the global role policy; ordinary conversations without graph context also use global policy | `memory/delivery-policy.test.ts` | Remove only the graph fallback once all resumable graph contexts carry frozen policy; ordinary conversation fallback remains supported |
| `live-outline-schemas.ts` | Empty routes/loops/expansion ledgers, zero counters, optional or null snapshot data and additive fields remain accepted; assignment provenance is required | `workflow-live.test.ts`, `live-outline.test.ts`, `compat/parse-floor.test.ts` | Change decoding only after all supported producers supply the fields and wire tests change deliberately; empty current state remains valid |
| Conversation task dispatch and `agent-call-facade.ts` | Only a durable session validator receives its own CC identity through trusted task execution dependencies; ordinary and ephemeral task runs stay unscoped, and formatting repairs stay hermetic | `question-commands.integration.test.ts`, `agent-call-facade.test.ts`, both backend `task-runner.test.ts` suites | Supported ownership distinction; change only with an explicit task identity contract and retained isolation evidence |


## Testing

Use `.provide()` to inject actors and test production transitions. The conversation tests under `src/lib/workflows/conversation/` demonstrate the host and persistence boundaries.

- Use XState's `waitFor(actor, predicate, { timeout })` for intermediate states, and `toPromise(actor)` only for actors with terminal output. Stop test actors during cleanup.
- Keep deferred actor completions under test control when verifying pause, cancellation, and settlement ordering.
- Follow AGENTS.md for registered validation and test boundaries.

## Adding a new XState workflow

1. Create `src/lib/workflows/<name>/` with `types.ts`, `actors.ts`, `machine.ts`, `machine.test.ts`.
2. An ephemeral job-style context extends `BaseWorkflowContext` (adds the `startedAt`/`completedAt` lifecycle stamps) and includes `_schemaVersion` and `error`. A long-lived actor defines its own independent context instead — see `ConversationContext`.
3. `fromPromise` stubs in `actors.ts`; production `.provide()` at the hosting site.
4. Publish a domain SSE event through `publishEvent`/an injected `PublishFn`, or use `publishScopedStatus` when the workflow itself owns a primitive lifecycle scope. Use `publishEventBestEffort` after an already-committed mutation; never import the raw broadcaster.
5. Non-serializable runtime data goes in a per-machine registry following the `conversation/runtime-state.ts` pattern; snapshot persistence follows `conversation/persistence.ts`.
6. Before building anything new, check the adoption matrix — if the concept exists, compose it; if a competing path tempts you, that is a migration to finish, not a precedent to follow.

---

# Graph Workflows — Configuration Cascade

Graph workflow config resolves through a **three-tier cascade**:

1. **Global** — `workflowDefaults` in `config.json`
2. **Workflow** — `workflowConfig` on definition (overrides global)
3. **Per-context** — `executionContext` blocks (overrides both)

Resolution at seed time (`src/lib/workflow-graph/resolve-config.ts`); the resolved context is snapshotted into the execution's `workingDefinition`, so saved-definition or global-config edits never retroactively mutate a running execution. Live edits (`cctl workflow live`, doc 06) do mutate that `workingDefinition` in place — they target the execution's working copy, never the saved definition.

`SEEDED_WORKFLOW_DEFAULTS` in `resolve-config.ts` is the ONE canonical
"no config anywhere" defaults object. UI surfaces that need a pre-load fallback
(config form-state, `useGlobalDefaults`, the builder inspector) import it —
never re-write the literal, or that surface silently substitutes stale defaults
for real cascade values (`form-state.test.ts` pins the identity).

Read `SEEDED_WORKFLOW_DEFAULTS` for current shipped values and `config-schemas.ts` for override shapes. Copying a model tuple or a partial definition from prose can bypass the catalog or omit required placement.

Workflow definitions normally inherit defaults. Author overrides when the request or acceptance contract calls for them; preserve an explicitly chosen backend, model, or validator policy. The `graph-workflow-planning` skill owns authoring examples.

## `workflowDefaults` blocks

Operational context blocks are individually overridable per tier;
`laneMergeValidation` resolves only from the global and workflow tiers because
it protects their shared fan-in target. The list is closed by
`workflowDefaultsSchema` (`src/lib/config/schemas.ts`) and seeded by
`SEEDED_WORKFLOW_DEFAULTS` — adding a block means touching both, plus this table:

| Block | Purpose |
|---|---|
| `implementer` | The implementer ASSIGNMENT: `{ id, profile, focus?, agent }` — a library profile plus the backend and complete model selection that run it |
| `contextValidator` | The validator COHORT: `{ enabled, assignments: [{ id, profile, focus?, strategy, authority, agent }] }`. `strategy` (`conversation \| task`) replaced the provider-named `type` discriminator; `authority` (`blocking \| advisory`) decides whether the seat can reopen tasks — the built-in acceptance-criteria validator defaults blocking and every other profile defaults advisory; a disabled cohort keeps its assignments dormant |
| `scriptValidator` | Deterministic validator that runs its ordered registered command selection. `{ commands: string[] }`; an empty list disables it |
| `humanApprovalGate` | Whether a context pauses for operator approval before it lands. `{ enabled: boolean }`, default disabled |
| `iterationPolicy` | `maxIterations` |
| `circuitBreaker` | `consecutiveFailureThreshold` |
| `mutability` | `allowAgentTaskAdd` (agent may append tasks to its own context) and `allowAgentContextAdd` (D4 runtime graph expansion — the agent may append new contexts, tasks, and edges via `cctl workflow graph expand`). Seeded as `"allowAgentTaskAdd": false` and `"allowAgentContextAdd": false`; both cascade identically |
| `askUserQuestions` | Whether lane agents may ask the operator questions mid-task via `cctl ask`. `{ enabled: boolean }`, default disabled; one value covers both the implementer and context-validator roles |
| `planRepair` | Plan-repair agent on retry-exhaustion halts (docs/design/cc-cli/08). `{ enabled, maxAttemptsPerContext, agent? }`; **default enabled**, 2 attempts per context, repair agent defaults to claude/opus/high |
| `collaboration` | Whether implementer agents may request a second opinion, plus the collaborator agent and negotiation policy. `enabled` defaults to `false`; when disabled, collaboration instructions and continuation results are omitted from agent prompts and the collaboration command is unavailable |
| `agentValidation` | Registered-command access for implementers and context validators. Each role selector cascades independently, and the nearest supplied selector replaces only that role |
| `laneMergeValidation` | Validation policy for the shared fan-in target. `{ strategy, commands }`; resolves global → workflow only, never per context |
| `memory` | Memory delivery policy per role (spec `memory` R10, D7): `{ implementer: { read, contribute }, validator: { read, contribute } }` where `read` is `off \| linked-only \| ambient` and `contribute` is `on \| off`. Each role and each half cascades independently (per-node → workflow → global) with provenance snapshotted onto the resolved context; an override states only the halves it changes, and `null` on the edit ops is the reset. Shipped: implementers ambient+on, validators off+off. Ordinary conversations read `memory.conversations` in global settings instead; the index budget has no override tier at all (`memory.indexBudget`, global only) |

**An assignment pairs prompt identity with runtime.** `profile` references the
agent-profile library (`src/lib/agent-profiles/`, see the adoption matrix row)
and supplies who the role IS — name, description, instructions; `agent` supplies
which backend and complete model selection run it; the optional `focus` is a use-site steer
that narrows the profile, never durable behaviour (that belongs in the profile).
`id` is the stable use-site identity findings are grouped by, so renaming it
re-keys the use site.

Migration `0011-workflow-agent-assignments` rewrites the earlier assignment
container shapes; migration `0035-generalized-model-selection` converts their
provider tuples into complete catalog variants. The latter uses frozen mapping
tables and the frozen effective backend profile for omitted legacy values. It
refuses an unknown model, ambiguous alias, mixed representation, or combination
that cannot map to exactly one variant. Live schemas accept only
`modelSelection`. Migration `0051-retire-stored-shape-readers` converts the
remaining pre-assignment archives once using frozen historical defaults;
archive reads use the current schema directly.

### Declarations that do NOT cascade

D4's control-flow declarations are semantic identity, not operational config: no
global or workflow tier contributes one, and each is Zod-optional with **no
materialized default** — the pre-D4 floor is the field's absence, not a
materialized "always" value (R14.1). Authoring rules live in the
`graph-workflow-planning` skill; the runtime contracts are:

| Declaration | Where | Meaning |
|---|---|---|
| `outputSchema` | execution context | The supported-subset JSON Schema the context's final agent output is captured against. Guards, loop predicates, and upstream injection all read the capture |
| `routing.cardinality` | execution context (the guard SOURCE) | `independent` (absent) \| `atLeastOne` \| `exactlyOne` over that source's outgoing conditional edges; a violation raises the resumable `routing_cardinality` halt |
| `edges[].when` | edge | `{ schema }` (a subset document the source's capture must match) or `{ else: true }` (at most one per source). Absent = unconditional |
| `loopGroups` | definition | Authored tier carries `bodyContextIds` / `entryContextId` / `exitContextId` / `until` / `maxPasses`; `resolveLoopGroups` rewrites it at seed into the resolved tier's frozen body `template` + `templateVersion` + seed-resolved `planRepair`, materializing pass 1 in the body's place |

`mutability.allowAgentContextAdd` is the one D4 flag that DOES cascade — it is
operational authority, not graph shape. It resolves `false` on every
expansion-generated child regardless of inheritance source, so authority cannot
propagate down a generated subgraph.

## Plan repair (retry-exhaustion and plan-defect halts)

After any execution-loop settlement, the plan-repair supervisor
(`workflow-graph/plan-repair/`) re-reads the ACTIVE execution and, when it is
halted on `circuit_breaker`, `max_iterations`, `plan_defect`, or
`candidate_unstable` with `planRepair`
enabled for the tripped context and attempts remaining, runs one bounded repair
round: a
one-shot repair agent (validator-style ephemeral conversation in the session
worktree) diagnoses the failure and either declines (diagnosis persisted in
`haltReason.summary`, run stays halted) or emits repair operations that are
re-validated fail-closed against the **plan/controls split** — `amend-charter`,
`update-context` prose/AC/`iterationPolicy`/`circuitBreaker`, and task ops
only; never structural graph ops, validators, gates, `mutability`,
`collaboration`, or `planRepair` itself. Accepted repairs apply through the
shared live-edit core with server-derived `source: "plan-repair"` and resume
through the normalize → resume → kick trio. Attempt accounting is the
append-only `execution.planRepairRounds` log (appended before the agent runs;
never reset by resume) with a hard per-execution backstop of 5 rounds. A round
emits a `graph-workflow-plan-repair` event twice — once as it OPENS
(`outcome: "started"`, no push) and once at its conclusion (+ outcome push via
the `planRepair` trigger). The opening event is what makes the repair visible:
the append changes no status, no active context and no halt reason, so without
it nothing leaves the server for the length of a minutes-long agent turn and
every UI reports an inert halt.

An unsettled round IS the turn, and three surfaces read it rather than
re-deciding what `halted` means: the live outline header
(`openPlanRepairRound`, which `cctl workflow live get` prints in place of the
round count), the CLI halt block (`repair: round N in flight`), and
`components/workflow-graph/derive-plan-repair-activity.ts`, the UI's single
owner of "is an agent working this halt?". The round is filed WITH its
conversation id (`__plan_repair__:<executionId>:<contextId>:<seq>`) rather than
learning it at settle time, so the transcript can be opened mid-turn — that
handle is the only way to check the claim, and `isWorkflowConversationLive`
calls it live for exactly as long as the round is open.

`plan_defect` is the one entry here that is not retry exhaustion: nothing was
retried, because the reviewed context has no task that could remedy what was
found (see "The third blocking response" below). It is admitted under the SAME
gates as the rest and accounted per CONTEXT — a defect the plan cannot answer
would otherwise re-trip on every resume, and the caps are what stop a
repair→resume→trip cycle.

## Structural mutation and the prepare/finalize staging seam

Every structural mutation of a launched execution — operator live edits,
plan repair, agent expansion, and engine loop unrolling alike — rides
`applyLiveExecutionEdits` (`workflow-graph/runtime-edits.ts`) inside
`executionRepository.mutateActive`, under the loop-generation fence. There is no
second mutation path and no bare repository write. The core re-runs the Kahn
acyclicity check, the live-edit frontier, and the criterion must-run coverage
lock on every accepted batch, and bumps `routeControlRevisions` exactly once —
so a new writer riding the seam gets all four for free and must never bump or
re-implement them by hand.

Writers that must validate expensively **outside** the write lock use the staged
pair instead of holding it: `prepareLiveExecutionEdits` (snapshot + full
validation, no commit) then `finalizePreparedEdits` (install). Two fences make
that safe, and both are repository-OWNED and repository-DERIVED — `liveRevision`
can serve as neither, because it is bumped only by accepted live edits:

- **`executionStateRevision`** — bumped by EVERY `mutateActive` commit, scheduler
  and runtime writes included. It answers "did anything commit while I was
  preparing?". Unchanged ⇒ `finalizePreparedEdits` splices the prepared whole
  state. Changed ⇒ it re-applies the prepared OPS payload-locally onto the
  CURRENT execution with a cheap envelope recheck, carrying the prepare's
  validation evidence over; a frontier-relevant conflict reports a conflict and
  the caller re-prepares outside the lock. A concurrent scheduler write can
  therefore never be erased by an install.
- **`structuralRevision`** — bumped only when the graph itself moved. It is what
  forces a re-prepare (rather than a merge) when the topology a batch validated
  against no longer exists.

Structural edits stay **pause-only for operators**. The one exception is
`LiveEditOptions.structuralSource` (`"lane-agent-expansion" | "loop-unrolling"`),
which is server-derived — the runtime-edits HTTP route builds its options from a
parsed body with no such field, so `cctl workflow live edit` (`source: "cli"`)
and the inspector (`source: "ui"`) cannot claim it. It covers exactly the two
APPEND ops, `add-context` and `add-edge`; `remove-context`, `remove-edge`, and
`update-edge` stay quiescence-gated for every caller including the two exempt
paths. Never mint a third exemption: expansion and loop unrolling share this one.

Mutation **authority** is a separate axis from editability. It is owned by
`workflow-graph/request-principal.ts` and applied through the one
`guardExecutionMutation`, which every mutation route passes. Every verb that
STEERS a run — live edit, pause, resume, abort, abandon, and the two resets —
declares `any_session_conversation`: the human UI, any conversation the session
verified, and the lane currently driving its own context may all act. Acting on
a run in flight is work on the run rather than a decision about its launch, and
a UI-launched run records no origin conversation for an agent to be. Launch
itself (`run`/`start`) never had an origin rule — it admits any verified
conversation and refuses a lane as nesting.

Resolving a context's approval gate is the one guarded verb that keeps
`origin_conversation`: only the run's recorded origin (or the lane whose gate it
is) may answer a question the run posed to whoever launched it, and a deleted
origin admits no agent at all. Omitting `authority` on a new guarded verb
inherits that narrow rule. Lane currency is never relaxed by either value, and
neither value admits an agent that cannot prove which conversation it is.

## Ask-user-questions gate (`awaiting_user_input`)

When `askUserQuestions` resolves enabled for a context, its implementer and
context-validator agents may invoke `cctl ask`; the batch registers under the
same rules as ordinary conversations and notifies the user. The lifecycle
mirrors the human approval gate:

- **Park** — a turn that ends with a question pending parks the context:
  status `awaiting_user_input`, the batch snapshotted into the context state's
  `pendingUserInputs` map. Parking consumes no iteration and no failure
  count; sibling contexts keep scheduling; the completion guard refuses to
  finish the execution while any context is parked. Park detection runs after
  **every** agent turn (including between follow-up turns — a follow-up
  dispatched onto an asking conversation would wipe the question) in
  `iteration-orchestrator.ts`; a validator question maps to an `asked_user`
  outcome, never a validation failure.
- **Answer** — from the graph page (inline panel on the parked node) or the
  lane conversation view. Lane answers record on the execution record via the
  user-input gate (`user-input-gate.ts`) — never queued to the conversation,
  no auto-drain — and exactly one answer set is accepted per batch.
- **Resume** — the loop (`execution-loop.ts`) polls the record, consumes the
  answers, and re-runs the lane in its existing conversation. The resumed
  turn carries the standard `<cc-question-answers>` block
  and runs under normal iteration accounting.
- **Durability** — the parked state survives pause/halt/restart (re-entry
  restores the wait; answers recorded meanwhile apply immediately); abort
  withdraws all parked questions.

Planner and collaboration conversations stay denied regardless of the toggle. A validator may ask only when its strategy is `conversation`, the context enables `askUserQuestions`, and the backend declares `nativeMidTurnAskUser`. Task-strategy validators remain ask-disabled even when they have a durable CC conversation identity (`validator-runner.ts`).

## Planning source of truth

Use the `command-center:graph-workflow-planning` managed skill before creating, replacing, or
diagnosing graph workflow plans. That skill owns the rules for decomposition,
acceptance criteria, validator alignment, script validator eligibility, context
sharing, defaults, lane-placement judgment (which grade, which lane, which owned
paths), and parallelization. Its source is
`plugins/command-center/command-center/skills/graph-workflow-planning/`;
the managed bundle delivers it to agents across projects. Edit that source,
and keep project-specific rationale in repository design and report documents.

This steering section is runtime/config reference only.

## Planner reserved session

Every workflow-generation turn (`POST /api/projects/:name/workflows/generate`)
runs through a project-level reserved session named `__planner__`, provisioned
lazily on first use by `ensurePlannerSession` in `src/lib/sessions/service.ts`.
The worktree lives at `<projectPath>/.worktrees/__planner__` on branch
`csm/__planner__` and is dedicated to the planner's transcript.

Conventions:
- Session names beginning with `_` are reserved (see `isReservedSessionName` in
  `src/lib/sessions/derived.ts`). The session list route filters them out so
  the planner session does not appear in the Sessions UI.
- The planner runs via `executeWorkflowTaskRun` with `kind: "task_run"` and NO
  `outputFormat`. The agent's free-form response text is not the contract —
  the canonical `WorkflowSemanticDefinition` is registered out-of-band via the
  `planner-draft-registry` MCP side channel and consumed by the runner after
  the call settles.
- Because the planner is bound to a stable session/conversation, every
  generation turn appends to the same audit-able transcript and the
  conversation actor's per-conversation single-flight lock applies normally.

## Validation runtime reference

`acceptanceCriteria` is required on every execution context and is consumed by
the implementer and, when enabled, the agent context validator.

Its shape is ordered `{ id, statement }` records (`criteria/criterion-records.ts`,
ticket #69 change 4 stage 1), ids kebab-case and unique within the context. Legacy
prose stays a valid PARSE on every read surface — stored definitions, working
definitions, execution state — and is canonicalized to records ONLY on authored
write paths (`validateWorkflowPlan` for validate/create/replace, and the edit
vocabularies), wrapping as one `ac-1` record. Never wrap on read: a stored prose
value must re-serialize byte-identical or `workingDefinitionHash` moves. Consumers
normalize through `criterionRecordsOf`; prompts render the numbered list through
`acceptanceCriteriaRecordListText`, while shape-preserving surfaces (previews,
outlines) use `acceptanceCriteriaText`. Every edit tier replaces the WHOLE value —
there is no per-criterion operation, including in plan repair (stage 2, deferred).

Blocking validator issues carry an optional `criterionId` bound to the context's
record ids; the requirement is per seat (`issueCriterionCitationFor`): the default
blocking acceptance-criteria seat must cite one on every issue, every other seat
cites its own assigned mandate and may name a criterion only incidentally.

Charter rendering is per context, not broadcast: `renderCharterDigest` filters
sources by their structured `appliesTo.contextIds` exactly as it filters invariants
(unscoped = global), and refuses unknown scope contexts at accept time with
`unknown-source-scope-context`. The digest carries no precedence, deferral, or
access-policy instruction — conflicts among sources are resolved at plan time, the
authored schema refuses the retired `accessPolicy` field
(`retired-source-access-policy`) and a prose `appliesTo` (`legacy-source-applies-to`),
and the amendment log renders only into `charter.md` and the durable record. The
persisted parses stay tolerant of both retired shapes and preserve them verbatim.

`contextValidator` is an LLM validator. `scriptValidator` runs the context's
ordered `commands` selection through `ValidationService` before agent
validation and writes failures to
`.cc/workflow/<executionId>/<command>-<timestamp>-<runId>.log`. An unknown
registered command halts with `script_validator_unknown_command`.

For an enveloped context the script gate does not run: the automatic whole-repo
gate for that context is its lane's join barrier (see "Lane placement and file
ownership"). Definition validation refuses such a context's `scriptValidator`
selection unless it is empty or a subset of the barrier set, so commands are
never silently discarded. Placement does not narrow the AGENT tier — the two
cascade separately, so an enveloped implementer still runs whatever its
`agentValidation` snapshot grants and can verify its own work before the
barrier ever runs.

A round that concludes `candidate_mismatch` charges NOTHING — not an iteration,
not a consecutive failure — and returns the context to `ready`, so the engine
re-opens a round at once. That is right for drift that settles and an unbounded
loop when it cannot, so the conclusion also charges
`contextStates[id].consecutiveCandidateMismatchCount`; any other conclusion
clears it, and so does resume. The budget is keyed on the round OUTCOME, so a
result rejected for a stale round token charges it alongside a moved tree — the
same no-verdict loop, reached without anything moving. At
`CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET` (`constants.ts`, 5) the context halts
with the typed `candidate_unstable` reason carrying the last round's stage,
moved components, and `lastIncident` — which keeps those two causes apart, so
only the moved-tree shape is ever presented as worktree churn. Resumable, and
accepted by the plan-repair trigger, whose verdict lands in the halt's
`summary`, because the usual repairable cause is a placement or scope that keeps
the tree moving rather than anything in the reviewed work.

Per-context validator overrides:

A cohort replaces the nearest tier's cohort WHOLE — assignments are never
field-merged across tiers, so a context naming one reviewer replaces the
workflow's three rather than adding a fourth.

Read `config-schemas.ts` for the assignment shape and the backend's effective catalog for a complete model selection. An assignment must contain one exact catalog variant; prose examples are not runtime defaults.

## Validator authority and advisories

Every validator assignment carries `authority` (`validatorAuthoritySchema` in
`workflow-graph/config-schemas.ts`): `blocking` findings reopen tasks, `advisory`
findings never can. When authority is omitted, the built-in `general-reviewer`
profile used for standard acceptance-criteria validation defaults to `blocking`;
every other profile defaults to `advisory`. A specialist added to a cohort
therefore arrives non-blocking; making it able to fail a context is a deliberate
authoring act, and the author who performs it owns convergence for that standard
(the circuit breaker and plan repair are the backstops, not a substitute).
Authority is an `assignmentFingerprint` input and freezes once the assignment
has a conversation. Backend, model, profile instructions, strategy, and focus
freeze at the same boundary. These fields remain editable before first use and
in templates for future executions.

Authority selects three things:

- **Where the assignment's instructions render.** A blocking seat's instructions
  are its MANDATE — the standard the context is judged against — so they render
  inside the role contract above the profile fence (`role-instructions.ts`). An
  advisory seat's instructions stay the subordinate use-site focus inside the
  profile block. One authored field, two placements, decided in one place
  (`assignmentProfileBlockOptions`) so a seat's text lands by what the seat IS,
  not by which code path composed it. The cohort's shared turn prompt stays
  byte-identical either way; per-assignment divergence lives entirely in
  `systemInstructions`, which already differs per assignment through profiles.
- **The verdict schema it is dispatched with** (`validator-runner.ts`). Blocking:
  `{summary, issues, advisories, planDefects?}`. Advisory: `{summary, advisories}`
  — neither `issues` nor `planDefects` exists on it, so an advisory seat cannot
  emit a blocking finding at
  all; an attempt fails the structured-output gate and takes the normal retry.
  The parse-side twins in `definition-schemas.ts` split identically, so a backend
  without native structured output has no laxer path either.
- **Whether the round waits on it.** `concludeCohort` (`validation-cohort.ts`)
  partitions the frozen roster: pass/fail derives from blocking lanes only, with
  findings concatenated and never merged. Advisory lanes contribute verdict,
  summary, and advisories; an advisory lane's exhaustion is recorded on the lane
  and never holds the round open — a lane that could not gate the round cannot
  gate it by dying either. Candidate mismatch and `asked_user` parking still
  count every lane: those are facts about the candidate and about a human being
  waited on, not about blocking power.

An advisory is `{ kind, title, description }`, `kind` one of `implementation`
(the code under review), `plan` (the task or criteria that shaped it), or
`out_of_scope` (anything beyond this context). It carries no `taskId` and never
reaches `validateIssueTaskIds`, so an observation about code no task owns cannot
become an `infra_error` or consume a lane attempt — the trap that used to punish
a specialist for noticing a real cross-context defect. Identity is engine-stamped
(`roundSeq`, `assignmentId`, ordinal) like every other assignment attribution: a
reviewer writes about the work, never about itself.

**An advisory-only cohort is legal.** The empty-roster refusal is unchanged, but
an enabled cohort with zero blocking seats is a valid authoring choice: a context
may already run with no validator at all, so advisory-only oversight is strictly
more than an allowed baseline.

### The third blocking response: `planDefects`

A blocking seat has a third response beside pass and fail: `planDefects`
(`workflowValidatorPlanDefectSchema` in `definition-schemas.ts`), for a contract
the reviewed context cannot satisfy at all — contradictory, requiring work owned
by a downstream context, or omitting ownership its criteria require. It carries
no `taskId` by construction, and each entry must state why the defect is not
locally remediable and name the criterion clause, boundary, dependency, or
governance rule in conflict. Those two fields are what make the classification
falsifiable, since plan repair's existing authority to reject it
(`planningDefect: false`) judges against them.

The bound is the seat's mandate: a concern the mandate does not clearly cover is
an advisory, never a plan defect (`role-instructions.ts`). This response is for a
mandate the context cannot satisfy, not a route around a mandate the seat would
rather not judge. A seat that reports both keeps its issues as evidence; the plan
defect decides the outcome.

The engine's reaction is the halt, and nothing else. `concludeCohort` still
concludes the round with every seat's verdict and the frozen candidate intact,
then the context halts with the typed `plan_defect` reason
(`schemas.ts`) carrying every defecting seat's defects in cohort order, each
stamped with its `assignmentId`. **No task is reopened, no failure is charged,
and no aggregate verdict is published** — the reopen loop is exactly what this
outcome exists to escape, which also makes it the only announcement the outcome
makes, so the halt emits `graph-workflow-plan-defect-halted`
(`event-schemas.ts`) for the surfaces that would otherwise learn about a stopped
context from a reopen or a rejection. The halt is resumable by construction: the
remedy is a repair of the contract the defect names.

Routing is immediate rather than post-exhaustion — plan repair runs at first
detection with the typed finding and the preserved candidate. Repaired resumes
automatically; a decline or a failure leaves the run halted with the
supervisor's diagnosis in `haltReason.summary`. With `planRepair` disabled the
trigger refuses before any round is appended, so no agent runs and `summary`
stays null — the halt stands for the operator (see "Plan repair" above).

### The advisory loop

Every advisory reaches the implementer lane, which may act on it or decline it
without obligation, and every one gets a durable disposition:

- **Failing round** — the round's fresh advisories ride the existing task-failure
  messages, so the implementer sees them beside the fixes it must make.
- **Passing round with fresh advisories** — the context enters the
  `advisory_response` phase instead of completing. The implementer lane gets one
  structured turn carrying the batch with explicit non-binding framing, and
  returns one disposition per delivered advisory: `addressed`, `declined`
  (which owes a reason), or `deferred`. Dispositions come back through the
  existing structured-output gate, keyed by the engine-stamped identity. The
  dispatched schema states the shape and the batch size — everything a schema a
  provider-native backend accepts can say, so no `oneOf` and no optional
  property. The two rules it cannot carry are checked when the payload is parsed:
  a decline without a reason, and a set that does not cover exactly the delivered
  batch. Both are reported as the same retryable failure as a schema rejection.
- **Re-certification** — once the dispositions land, the engine recomputes the
  candidate identity (`headSha` + `trackedDiffHash` + `taskStateHash`).
  Identical: the context completes on the certification it already earned — no
  script run, no validator dispatch of any kind. Different: a blocking-only
  re-certification round runs in the normal order (script gate first, then
  blocking lanes) against the same frozen snapshots, and a failure there
  re-enters the ordinary iteration loop. The hash is ground truth and the
  dispositions are testimony, so an implementer that declines everything and
  edits anyway is still re-certified.

The loop is bounded by construction: a round's batch is delivered exactly once,
and the re-certification round runs no advisory lanes, so it cannot raise a fresh
batch and trigger a second response turn.

**Advisory-only cohorts ship uncertified.** Because re-certification is
blocking-only, a cohort with no blocking seat and no script gate has nothing to
re-certify a changed candidate with: if the implementer edits files during the
advisory-response turn, the context completes on a candidate no gate ever
reviewed — **uncertified**, at the same trust level as a validator-less context.
That is the honest consequence of the authority the author chose, not a gap to
patch. An author who wants a floor under post-advisory edits configures a script
gate or keeps one blocking seat.

The built-in specialist reviewer profiles (`security-reviewer`,
`type-api-contract-reviewer`, `test-reliability-reviewer` in
`agent-profiles/builtins.ts`) model the channel: a finding the mandate covers
goes through the channel the verdict gives it, and everything else becomes an
advisory of the matching kind. Their prose names no blocking field, because one
profile is legal on either seat.

## Lane placement and file ownership

Where an execution context runs, and what it may write there, is AUTHORED on the context as `placement` — `contextPlacementSchema` in `src/lib/workflow-graph/definition-schemas.ts`, required with no runtime default. Deterministic seed-time lane assignment does not exist: a stored definition carrying no placement is a legacy shape migrated at its inflate boundary, never a shape defaulted at accept time. An optional `placement` would silently resurrect the replaced mechanism, so it stays required.

Three grades, discriminated on `mode`:

- `readOnly` — no repository write surface. On the reserved authored lane name `session` it runs on the session worktree itself: no worktree provisioned, no landing commit, no join. Its captured `outputSchema` payload is its only delivery channel, which is why an absent one is refused.
- `owned` — a non-empty `ownedPaths` set of normalized repo-relative POSIX prefixes, each covering itself and everything beneath it at segment boundaries (`src/lib` does not swallow `src/libraries`). Entries are literal, never globs. The set does double duty: write envelope during the turn, commit scope at landing.
- `full` — the whole tree, and therefore exclusive occupancy of its lane while it runs.

Accept-time semantics live in `src/lib/workflow-graph/placement-validation.ts`, reached by every authoring surface through `validateAuthoredDefinition`: the lane-name grammar (`lane-identity.ts`, since a lane name becomes a branch and a worktree path segment), the session lane's read-only restriction, the read-only output contract, and pairwise ownership disjointness for same-lane members that no dependency path orders. Those checks are LEXICAL over declared strings; the symlink-resolved canonical re-check before two members are admitted concurrently belongs to the scheduler, because two prefixes that look distinct here can still resolve into one another on disk.

Consequences to hold when touching lane code:

- A lane hosts N members for one worktree and one fan-in join. Nothing may assume `laneId === contextId`, and no surface may infer a lane from a context id.
- The write envelope is mechanical and fail-closed, not prompt discipline. `<worktree>/.git` is denied, so an agent cannot commit, branch, or reset; landing is the engine's, scoped to the member's frozen prefixes. Any hop that cannot carry or natively establish a present policy fails the turn — it never dispatches unrestricted.
- `.cc` is reserved from authored ownership. The writable set is the member's per-context scratch root, its owned prefixes, its payload directory under the worktree's `.cc` namespace, and tmp; a session reader gets scratch and tmp only.
- Whole-repo *gating* is a per-lane barrier at the join (`laneMergeValidation`), not a per-context gate. For an enveloped context automatic script validation is skipped, and definition validation refuses a `scriptValidator` command selection that is neither empty nor a subset of the barrier set rather than discarding it. Barrier coverage is recorded against the lane's member set frozen at join intent, so evidence names exactly which members one run covered. The agent allowlist is a separate tier: placement never revokes it, so a lane member still runs the commands its `agentValidation` snapshot grants.
- A post-landing TRACKED change in a shared worktree that no member's ownership or reserved namespace covers raises `ownership_violation` — resumable, and accepted by the plan-repair trigger. `lane-drift.ts` judges `git status` only: gitignored content is out of scope, because toolchain churn there (installs, incremental build info) is indistinguishable from the foreign write such a check would hunt for, while an unattributed tracked change is a merge-integrity problem the next landing would sweep up or lose.

## Land-gate invariant

Scheduler eligibility requires an upstream's work to be VISIBLE from the lane the downstream will run on, not merely completed. A completed-but-unpublished upstream does not satisfy a downstream dependency, because the downstream may fan out from a base that does not yet include the upstream's work.

Visibility is lane-relative, and that is precisely what makes a shared lane cheap:

- Same lane — a landed upstream is visible to its lane-mates immediately, with no join at all. A same-lane downstream is schedulable as soon as its upstream's owned prefixes are committed.
- Cross lane — the upstream's lane must have published through a join before its dependents run.
- Read-only upstreams commit nothing; their contribution is the captured output payload, so completion alone satisfies a dependent.

`isUpstreamVisibleToDownstream` and `isContextOutputCommittedToLane` (`src/lib/workflow-graph/lane-readiness.ts`) are the lane-aware predicates `getEligibleContextIds` composes.

Join merges (context_merge / final_publish) run the Smart Merge machine with `autoResolve: true`, so conflicts get LLM resolution + pre-merge validation per pairwise lane merge. The join runner aborts any unconcluded merge in the source lane worktree before merging (self-healing preflight) and retries a conflicted merge once from a clean tree before failing. A `join_failure` halt is recoverable: `resume()` resets concluded-failed joins to `pending` (per-lane `mergedSourceLaneIds` progress survives), optionally attaching per-file `conflictGuidance` (resume body → join state → merge machine `decisions`), and the join's persisted `conflicts.analysis` powers the retry-with-guidance UI (`JoinConflictRecoveryCard`). An operator who resolves manually must **commit** the merge in the lane worktree — an uncommitted mid-merge state is aborted by the preflight on retry.

Context-join scheduling distinguishes dependency eligibility from lane schedulability: a context whose dependencies have landed may still need a `context_merge` before it can be assigned a lane. Terminal fan-in contexts are no exception — a terminal context with multiple source lanes converges them through a `context_merge` and runs on the merged worktree lane BEFORE the final publish (this superseded the original "final verification runs after publish" decision once the delivery gate made `final_publish` the delivery point). The execution loop eagerly converges eligible context joins before dispatching another context batch when query capacity remains and every source lane is free of incomplete contexts. A context join may overlap in-flight work on disjoint lanes, but it must never run while an incomplete context occupies any source lane. This source-lane occupancy guard applies equally to newly planned joins and recovered persisted joins. `final_publish` joins are not eligible for eager scheduling; publication remains quiescent and runs only after context work and other pending orchestration have settled. A `final_publish` is never planned — and a persisted one is never claimed on resume, it is superseded as failed instead — while any context still has unfinished tasks (`findContextsWithUnfinishedTasks`, the same task-based predicate as the loop's completion invariant); a stuck context halts the run via `completion_blocked_incomplete` without publishing partial work first.

## Lane publication and the delivery boundary

Every write-capable context is a member of exactly one authored lane — terminal contexts included — and several members may share one. A member's work reaches its lane through an ownership-scoped landing commit; the lane's work reaches the session branch exclusively through join merges (`context_merge`, and the quiescence-synthesized `final_publish`). Read-only contexts publish no commit: a session reader is assigned no lane at all and resolves through an explicit sentinel ahead of any lane-row lookup, while a group-lane reader is accounted for at its lane's join by a no-commit inclusion marker rather than a commit snapshot. Worktree contexts require an assigned lane before dispatch. A current solo session context can start with `laneId: null`; landing its commit materializes the session lane. That session path is supported, not a retired worktree fan-in fallback.

`final_publish` joins target the session lane and stamp `executionId` with `finalPublish: false`: the delivery gate enforces the per-criterion proof floor at the session boundary (a refusal halts the workflow), but delivery itself — `finalPublish: true` and a linked spec execution transitioning to Delivered — belongs solely to the gated merge that lands on the project's delivery target. Fresh user merges resolve their spec-execution association once, at dispatch, through the injected merge-association interface (`src/lib/workflows/merge/association-port.ts`; resolver policy in `src/lib/specs/merge-association.ts`); conflict retries copy provenance from the prior job, and merges of sessions hosting no active spec execution remain pass-through.

## Loop-generation fence invariant

Every graph-workflow execution loop instance is pinned to the `(executionId, loopEpoch)` generation it was started for (`src/lib/workflow-graph/loop-fence.ts`). `loopEpoch` lives on the execution (runtime tier) and is bumped ONLY by `resume()` — abort/halt/pause never bump it (abort replaces the execution id instead). The fence rides a dedicated AsyncLocalStorage from `executionLoop.run()` into everything the loop awaits, and `executionRepository.mutateActive` rejects any write whose ambient fence no longer matches the session's persisted generation (`StaleLoopFenceError`). The loop treats that error — and any refresh that returns a different generation — as "I have been superseded": it exits silently (`graph-workflow.loop.fenced_out`), never recording a halt or draining, because those are session-keyed and would mutate the successor's state.

Consequences when touching engine code:

- Never adopt a `getActive` result inside loop-owned code without a generation check (`adoptExecution`/`refreshExecution` in `execution-loop.ts` are the only sanctioned adoption paths).
- User/agent-route mutations carry no fence and are unaffected; the fence is scoped to its own session, so fenced code touching ANOTHER session (e.g. collaboration dispatch) is also unaffected.
- `activeLoops` is instance-tokened: an exiting stale loop cannot unregister the live loop; do not revert it to a bare per-session Set.
- `StaleLoopFenceError` must stay excluded from halt conversion (`runContextTask`'s catch and the loop's outer catch) — converting it to a halt re-creates the incident-622782a0 failure mode (a zombie loop halting the successor execution).

Active cancellation complements the fence: user-initiated pause/abort/halt and `resume()` abort every cancellable conversation via `collectCancellableConversationIds` (running-task conversations ∪ `laneStates` lane conversations, so validator task-runs stop spending too). It iterates `laneStates` values, never a fixed set of lane keys — a context reviewed by a validator cohort holds one lane per assignment (`context_validator:<assignmentId>`), and keying the sweep by lane KIND would leave every specialist but one burning to completion. Task-run turns register an `AbortController` in the conversations abort-registry (`runTaskRunTurnForMachine`) and the signal threads facade → `dispatchTaskRun` → runner (both codex and claude runners fold it into their teardown path). The loop's own drain-and-halt intentionally does NOT cancel — engine halts drain so completed sibling work lands. Fence = correctness (a superseded loop cannot write); cancellation = economy (a cancelled turn stops burning tokens); keep both.

## Conversation lifetime

Each implementer and validator assignment keeps one continuous conversation
within its execution context. Usage, native compaction, retries, pause/resume,
and context rescheduling do not replace it. If its conversation or native
continuation can no longer be resumed, execution halts. Context limits and
configurable continuity are not part of workflow configuration.

## Turn liveness (stall watchdog)

Every agent turn carries a per-turn inactivity bound in addition to the whole-turn safety net: `src/lib/agent-backends/stall-watchdog.ts`, armed at dispatch and reset by every backend event, aborts the turn (and closes the runtime) after dead air. The bound resolves from `defaultStallTimeoutMs` in backend descriptor metadata (codex 20 min, `CODEX_DEFAULT_STALL_TIMEOUT_MS`; claude 35 min, `CLAUDE_DEFAULT_STALL_TIMEOUT_MS`), overridable per backend via `agentBackends.<backend>.stallTimeoutMs` in config.json (`null` disables). Claude's bound is deliberately the looser one: a turn that opted into `waitForBackgroundTasks` — every graph-workflow implementer turn does — is held open by the settlement barrier for up to `DEFAULT_BACKGROUND_TASK_WAIT_TIMEOUT_MS` (30 min) during which background-task notifications reach the SSE activity channel but never the watchdog, so a bound at or below that ceiling would abort healthy work mid-barrier, and silently: the turn already carries its result, so it reads as completed with no abort reason while its background work is abandoned. Keep `CLAUDE_DEFAULT_STALL_TIMEOUT_MS` above that ceiling (pinned in `claude/conversation-runtime.test.ts`) or make the barrier feed the watchdog first. The conversation actor owns the watchdog for streaming turns (`wireTurnAbort` + the onEvent funnel); each task runner owns it for task-runs (`AgentTaskRequest.stallTimeoutMs`). A stalled implementer turn surfaces as `abortReason: "stalled"` → `AgentTurnFailedError cause: "stall"`; the execution loop grants ONE automatic recovery (context → ready, retry in the same conversation — `recoveryKind: "stall"` in `decisions.jsonl`), then halts with `agent_turn_failed/stall`. Do not weaken this into a whole-turn timeout: healthy long turns emit events steadily; only dead air should trip it. Origin: the 9h37m silent codex turn in execution `1b8d9120` (docs/reports/workflow-audits/2026-07-19-native-sdd-execution-audit.md, RCA addendum), and the 55-minute unwatched claude turn in execution `2560164c` (docs/reports/workflow-audits/2026-08-11-spec-import-delivery.md).

An `AgentTurnFailedError` with cause `sdk_error` takes the same single automatic recovery (`recoveryKind: "sdk_error"`), because the diagnostics the SDK terminates a turn with are its strings, not ours, and no message pattern can classify them reliably. Its strikes are counted in their own per-context counter that ONLY a successful iteration clears — the transport counter is cleared by partial iteration progress, and the post-implementer sites that raise `sdk_error` (advisory response, output capture) always run after a turn completed, so sharing it would refund the budget on every strike and retry without bound past the max-iteration and circuit-breaker guards. The second consecutive strike halts. Both counters are in-memory per loop invocation, so a resume grants a fresh budget.

## Templates (storage, tiers, parameters, prerequisites)

A saved workflow definition is a reusable **template**, launched via `cctl workflow start <id>`. Templates are **not in the repo** — they live in the OS config dir (the dir from `tech.md` "OS-aware config dir") at `<configDir>/workflows/<scopeKey>/<id>.json`. `src/lib/workflow-graph/storage.ts` (`createWorkflowStorageService`) is the read/write choke point: it runs full accept-time validation and mints `id`/`revision`/timestamps.

- **Tiers / `WorkflowScope`** — `project` (scopeKey = `base64url(projectPath)`) and `global` (the cross-project library; reserved scopeKey `global.shared`, whose `.` can never collide with a base64url path). `cctl workflow templates` returns both, tier-tagged.
- **Authoring** — the `/templates` UI, the HTTP handlers (`POST /api/workflow-templates` for global), `createWorkflowStorageService().create(scope, draft)` directly, or the agent-facing `cctl workflow create --file plan.json` / `cctl workflow replace <id> --file plan.json` flow (author the plan as a `plan.json` file — see the `graph-workflow-planning` skill). The CLI create/replace flow is project-tier; author/edit a **global** template (parameterize it with `{{inputs.<name>}}` so it isn't bound to one project) through the Templates UI. All paths resolve tier→scope through `scopeForTier` and reuse the shared inflate + accept-time validation + storage path. Browse the project tier with `cctl workflow list` / `cctl workflow get <id>` / `cctl workflow delete <id>`; browse the global tier with `cctl workflow templates --tier global`.
- **Parameters** — declared `string` | `text` | `enum`; referenced as `{{inputs.<name>}}`. Substitution runs at launch over the closed `SUBSTITUTION_FIELD_SET` ONLY: task **instructions**, context `title`/`description`/`acceptanceCriteria` (prose as one occurrence, records as one per `acceptanceCriteria[].statement` — a criterion `id` is structural and never substituted), and charter fields (mission, conventions, …, `invariants[]` `statement` — not `id` — and `sourcesOfTruth[]` `label`/`locator`/`description`/`appliesTo`, where only the legacy prose `appliesTo` is substitutable, a structured scope holding context ids being graph structure rather than template prose). It does **NOT** touch task **titles**, ids, order, edges, config, or prerequisites — a token placed there renders literally (a silent bug, not a validation error). Launch with `cctl workflow start <id> --file inputs.json` (the inputs file supplies the `parameters`).
- **Prerequisites** — declarative `path` | `skill` requirements, probed deterministically before any tokens are spent (the `skill` kind also covers slash-commands; scope a skill to a `backend` when only one backend uses it). Worktree-relative paths only. Use them to fail-fast a global template on an unsuitable project.
- **Dynamic tasks (mutability)** — a context with `mutability.allowAgentTaskAdd: true` lets the agent add tasks at runtime via `cctl workflow task add`: e.g. a bootstrap task that fans `tasks.md` out to one task per subtask, or a validate-loop that adds one remediation task per finding plus a re-validate task, looping until clean. Plan these with the `graph-workflow-planning` skill.
