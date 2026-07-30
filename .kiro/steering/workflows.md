# Workflow Orchestration

Command Center has three orchestration shapes. Pick by shape; do not invent a fourth (see P7 in `docs/reports/2026-07-12_consolidated-architecture-design-and-plan.md`):

1. **Conversation actor** (XState v5, long-lived) — `src/lib/workflows/conversation/`. One actor per conversation; owns the prompt-turn lifecycle, queue drain, and rehydration. Every agent turn flows through it — this is the spine.
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
│   ├── actors.ts               # fromPromise stubs (default impls lazy-import production logic)
│   ├── actor-implementations.ts# production actor logic (AgentCall dispatch, pre/post-turn concerns)
│   ├── manager.ts              # actor lifecycle: .provide() wiring, globalThis registry, event dispatch
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

Production injects via `.provide()` at the hosting site (`conversation/manager.ts` for the conversation actor; the job machines' `fromPromise` defaults already lazy-import production logic, so `jobs/queue.ts` starts them unprovided). Tests inject fakes via `.provide()` — **never `vi.mock()` for actors**:

```typescript
const testMachine = fooMachine.provide({
  actors: { doWork: fromPromise(async () => ({ result: "fake" })) },
});
```

## Non-serializable state (`conversation/runtime-state.ts` pattern)

Machine context must be JSON-serializable. AbortControllers, lock release fns, backend runtime handles, and stream emitters live in an external registry keyed by `${projectPath}::${sessionName}::${conversationId}`; the registry is a `globalThis` singleton (HMR-safe). Registered when the actor is created (handles attach per turn); conversation actors are long-lived with zero final states, so cleanup is explicit — `cleanupConversationRuntime` aborts in-flight work and releases locks when the actor is stopped (`stopConversationActor`, rebind, failed rehydrate).

## Snapshot persistence (`conversation/persistence.ts` pattern)

- Long-lived actors, no terminal state, so there is no terminal flush: the machine's `persistSnapshot` action fires on every durable transition and writes debounce 500 ms.
- `persistSnapshotAfterTransition` defers the snapshot capture to a microtask — XState runs transition actions before the macrostep commits, so a synchronous `getPersistedSnapshot()` would persist the PREVIOUS state.
- Restore validates `_schemaVersion` and returns `null` on mismatch (actor starts fresh).
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
| Typed SSE publication + lifecycle projection | `events/publication.ts` (`publishEvent`, `PublishFn`, `publishEventBestEffort`, `publishScopedStatus`) + private `events/{status-bus,lifecycle-projection}.ts` implementation | all server event publishers, including dev-server, graph, collaboration, conversation, jobs, notifications, prompts, and route modules | publication is supported; `subscribeLifecycle` remains **experimental** with zero production subscribers | raw `events/broadcaster` is restricted to `publication.ts` and the SSE transport | Keep the direct-import ratchet at zero. Land a production lifecycle subscriber or delete the dormant subscription/projection interface under the adopt-or-delete rule. |
| ArtifactRegistry | `primitives/artifact-registry.ts` (+ `default-session-artifact-registry.ts`) | graph `shared-documents.ts`, `script-validator-runner.ts`, `charter/service.ts`; `agent-runs/` service + routes; conversation actor (focus memory) | supported | — | — |
| WorkflowEnvelope (durable workflow lifecycle) | `primitives/workflow-envelope-{vocabulary,store,repository}.ts` + `recover-workflow-envelopes.ts` | Collaboration runs (restart discovery + recovery) | supported | `BackgroundJob`, `AgentRunRecord`, and `GraphWorkflowExecution` remain separate lifecycle vocabularies by decision | None now — four-way convergence explicitly deferred (plan D15) |
| Gate result vocabulary | `primitives/gate-vocabulary.ts` (pass / fail / pause envelope) | Via the gates below | supported | — | — |
| Human approval gate | `primitives/human-approval-gate.ts` | Collaboration envelopes (`collaboration/envelope.ts`, `workflow-envelope.ts`) | supported | `workflow-graph/approval-gate.ts` is graph-owned and deep by design — a sibling, not a competitor | — |
| Circuit breaker | `primitives/circuit-breaker-gate.ts` (pure policy fn) | graph `execution-loop.ts`, `iteration-orchestrator.ts` | supported | — | — |
| Context-limit gate | `primitives/context-limit-gate.ts` | `primitives/lane-service.ts`, graph `execution-tool-context.ts` + `lane-continuity.ts` | supported | — | — |
| Structured-output gate | `primitives/structured-output-gate.ts` (schema validation) + `agent-backends/structured-output.ts` (shared candidate extraction) | `agent-call-facade.ts` (every dispatch with an `outputSchema`); `workflow-graph/validator-runner.ts`; `sessions/conflict-resolution.ts`; `agent-runs/service.ts` | supported | — | — |
| Script-validation gate | `primitives/script-validation-gate.ts` (single `ScriptValidationOutcome` union) | graph script-validator remediation (`workflow-graph/iteration-orchestrator.ts`, `script-validator-runner.ts`); merge validation (`workflows/validation-fix/actors.ts`) | supported | — | — |
| User-input gate (parked questions) | `workflow-graph/user-input-gate.ts` | graph loop, `validator-runner.ts`, conversations ask/answer routes | supported | — | — |
| Config cascade | `workflow-graph/resolve-config.ts` | Every graph execution (see the cascade section below) | supported | — | — |
| Live-edit apply core | `workflow-graph/live-edit-apply.ts` (`applyLiveEditsToActiveExecution`: gates → atomic mutation → one `liveRevision` bump → mandatory events) | runtime-edits HTTP route; plan-repair supervisor | supported | — | Never add a second mutation path for a launched execution's working definition |
| Plan-repair supervisor (D1) | `workflow-graph/plan-repair/{trigger,schemas,prompt,agent-runner,supervisor}.ts`, composed at the `kickOffExecutionLoop` seam | every loop settlement (`execution-route-handlers.ts` `runExecutionLoopWithPlanRepair`) | supported | — | — |

## Testing

```typescript
// Factory helper
function createTestMachine(overrides: Partial<ActorOverrides> = {}) {
  return fooMachine.provide({
    actors: { doWork: overrides.doWork ?? fromPromise(async () => defaultOutput) },
  });
}

// Terminal assertion (job machines)
const actor = createActor(testMachine, { input });
actor.start();
const output = await toPromise(actor);

// Guard testing
actor.send({ type: "CONFIRM" });
expect(actor.getSnapshot().value).toBe("planning"); // blocked

// Wait for intermediate state
function waitForState(actor: AnyActorRef, state: string, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${state}`)), timeoutMs);
    if (actor.getSnapshot().value === state) { clearTimeout(timer); resolve(); return; }
    const sub = actor.subscribe((s) => {
      if (s.value === state) { clearTimeout(timer); sub.unsubscribe(); resolve(); }
    });
  });
}

// Deferred resolvers for pause/resume
const resolvers: Array<{ resolve: (v: Output) => void }> = [];
const actor = startMachine({
  doWork: fromPromise(() => new Promise(resolve => resolvers.push({ resolve }))),
});
// Later: resolvers[0]!.resolve(output);

// Cleanup
const activeActors: AnyActorRef[] = [];
afterEach(() => { for (const a of activeActors) { try { a.stop(); } catch {} } activeActors.length = 0; });
```

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

```jsonc
// config.json — global tier
{
  "workflowDefaults": {
    "implementer":      { "backend": "claude", "model": "opus",   "reasoningEffort": "medium" },
    "contextValidator": { "type": "claude", "enabled": true, "agent": { "backend": "claude", "model": "sonnet", "reasoningEffort": "medium" }, "continuity": { "enabled": true } },
    "scriptValidator":  { "enabled": false },
    "iterationPolicy":  { "maxIterations": 20, "continuity": { "enabled": true } },
    "circuitBreaker":   { "consecutiveFailureThreshold": 3 },
    "mutability":       { "allowAgentTaskAdd": false },
    "planRepair":       { "enabled": true, "maxAttemptsPerContext": 2 },
    "askUserQuestions": { "enabled": false },
    "collaboration":    { "enabled": false, "secondAgent": { "backend": "claude", "model": "sonnet", "reasoningEffort": "medium" }, "negotiationRounds": 3, "autonomousResolutionThreshold": "minor" }
  }
}
```

Workflow definitions should normally omit `workflowConfig` and per-context
override blocks. Defaults cascade from global config unless Alex explicitly asks
for non-default implementer or validator settings.

```jsonc
{
  "executionContexts": [
    {
      "id": "plan",
      "title": "Plan",
      "acceptanceCriteria": "A plan.md describes the approach in enough detail for an implementer to follow."
    },
    {
      "id": "impl",
      "title": "Implement",
      "acceptanceCriteria": "The feature behaves as described in the plan when exercised end-to-end."
    }
  ]
}
```

## `workflowDefaults` blocks

Nine blocks, all individually overridable per tier:

| Block | Purpose |
|---|---|
| `implementer` | Implementer agent config (backend, model, reasoning) |
| `contextValidator` | Agent (LLM) validator on intent of acceptance criteria. Discriminated `type: "claude" \| "codex"` |
| `scriptValidator` | Deterministic validator that runs project's `preMergeCommand`. `{ enabled: boolean }`. Requires `preMergeCommand` in `CommandCenter.json` |
| `iterationPolicy` | `maxIterations`, `continuity.enabled`, optional `contextLimitTokens` |
| `circuitBreaker` | `consecutiveFailureThreshold` |
| `mutability` | E.g. `allowAgentTaskAdd` |
| `askUserQuestions` | Whether lane agents may ask the operator questions mid-task via `cctl ask`. `{ enabled: boolean }`, default disabled; one value covers both the implementer and context-validator roles |
| `planRepair` | Plan-repair agent on retry-exhaustion halts (docs/design/cc-cli/08). `{ enabled, maxAttemptsPerContext, agent? }`; **default enabled**, 2 attempts per context, repair agent defaults to claude/opus/high |
| `collaboration` | Whether implementer agents may request a second opinion, plus the collaborator agent and negotiation policy. `enabled` defaults to `false`; when disabled, collaboration instructions and continuation results are omitted from agent prompts and the collaboration command is unavailable |

## Plan repair (retry-exhaustion halts)

After any execution-loop settlement, the plan-repair supervisor
(`workflow-graph/plan-repair/`) re-reads the ACTIVE execution and, when it is
halted on `circuit_breaker` or `max_iterations` with `planRepair` enabled for
the tripped context and attempts remaining, runs one bounded repair round: a
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
never reset by resume) with a hard per-execution backstop of 5 rounds. Every
round conclusion emits a `graph-workflow-plan-repair` event (+ outcome push via
the `planRepair` trigger).

## Ask-user-questions gate (`awaiting_user_input`)

When `askUserQuestions` resolves enabled for a context, its implementer and
context-validator agents may invoke `cctl ask`; the batch registers under the
same rules as ordinary conversations and notifies the user. The lifecycle
mirrors the human approval gate:

- **Park** — a turn that ends with a question pending parks the context:
  status `awaiting_user_input`, the batch snapshotted into the context state's
  `pendingUserInput` record. Parking consumes no iteration and no failure
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
  answers, and re-runs the lane with the asking conversation pinned
  (`pinnedConversationId` in `lane-continuity.ts`, resolved by `LaneService`
  over the durable `graph-lane-store.ts`; a scheduled context-window rotation
  outranks the pin and the answers ride the replacement conversation's first
  prompt). The resumed turn carries the standard `<cc-question-answers>` block
  and runs under normal iteration accounting.
- **Durability** — the parked state survives pause/halt/restart (re-entry
  restores the wait; answers recorded meanwhile apply immediately); abort
  withdraws all parked questions.

Planner and collaboration conversations stay denied regardless of the toggle;
Codex validator lanes have no real CC conversation and never see the tool.

## Planning source of truth

Use the `graph-workflow-planning` Codex skill before creating, replacing, or
diagnosing graph workflow plans. That skill owns the rules for decomposition,
acceptance criteria, validator alignment, script validator eligibility, context
sharing, defaults, and parallelization.

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

`contextValidator` is an LLM validator. `scriptValidator` runs the project's
`preMergeCommand` before agent validation and writes failures to
`.cc/workflow/<executionId>/pre-merge-<timestamp>.log`. Enabling
`scriptValidator` without a configured `preMergeCommand` halts with
`script_validator_missing_command`.

Per-context validator overrides:

```jsonc
{ "contextValidator": { "kind": "disabled" } }
{ "contextValidator": { "kind": "use", "value": { "type": "codex", "enabled": true, "codex": { "reasoningEffort": "high" }, "continuity": { "enabled": true } } } }
```

Codex reasoning levels are model-aware — `getCodexReasoningLevelsForModel()` returns allowed levels.

## Land-gate invariant

Scheduler eligibility for a worktree-isolation context's dependents requires the upstream's `mergeStatus === "merged-success"`. A completed-but-unmerged side branch does not satisfy a downstream context's dependency, because the downstream may fan out from a base that does not yet include the upstream's work.

The canonical check is `isContextLanded` in `src/lib/workflow-graph/validation.ts`:

- `status !== "completed"` → not landed.
- `isolation === "session"` → landed when completed (no fan-in merge needed — work is visible in the session branch directly).
- `isolation === "worktree"` → landed only when `mergeStatus === "merged-success"`.

`getEligibleContextIds` uses `isContextLanded` for every upstream of every candidate context. A failed fan-in halts with `merge_precondition_failed` (or `merge_failure`) and persists `mergeStatus === "merged-failed"` on the side-branch context, which `resume()` queues for retry via `pendingMergeRetry` (loop-owned, manager-persisted intent).

Join merges (context_merge / final_publish) run the Smart Merge machine with `autoResolve: true`, so conflicts get LLM resolution + pre-merge validation per pairwise lane merge. The join runner aborts any unconcluded merge in the source lane worktree before merging (self-healing preflight) and retries a conflicted merge once from a clean tree before failing. A `join_failure` halt is recoverable: `resume()` resets concluded-failed joins to `pending` (per-lane `mergedSourceLaneIds` progress survives), optionally attaching per-file `conflictGuidance` (resume body → join state → merge machine `decisions`), and the join's persisted `conflicts.analysis` powers the retry-with-guidance UI (`JoinConflictRecoveryCard`). An operator who resolves manually must **commit** the merge in the lane worktree — an uncommitted mid-merge state is aborted by the preflight on retry.

Context-join scheduling distinguishes dependency eligibility from lane schedulability: a context whose dependencies have landed may still need a `context_merge` before it can be assigned a lane. Terminal fan-in contexts are no exception — a terminal context with multiple source lanes converges them through a `context_merge` and runs on the merged worktree lane BEFORE the final publish (this superseded the original "final verification runs after publish" decision once the delivery gate made `final_publish` the delivery point). The execution loop eagerly converges eligible context joins before dispatching another context batch when query capacity remains and every source lane is free of incomplete contexts. A context join may overlap in-flight work on disjoint lanes, but it must never run while an incomplete context occupies any source lane. This source-lane occupancy guard applies equally to newly planned joins and recovered persisted joins. `final_publish` joins are not eligible for eager scheduling; publication remains quiescent and runs only after context work and other pending orchestration have settled. A `final_publish` is never planned — and a persisted one is never claimed on resume, it is superseded as failed instead — while any context still has unfinished tasks (`findContextsWithUnfinishedTasks`, the same task-based predicate as the loop's completion invariant); a stuck context halts the run via `completion_blocked_incomplete` without publishing partial work first.

## Lane publication and the delivery boundary

Every provisioned worktree context is assigned an execution lane — terminal contexts included. Lane work publishes exclusively through join merges (`context_merge`, and the quiescence-synthesized `final_publish`); the legacy `laneId: null` fan-in path is **migration-only**, retained solely so resumed executions persisted before lanes can still land their contexts. Never route new scheduling through it.

`final_publish` joins target the session lane and stamp `executionId` with `finalPublish: false`: the delivery gate enforces the per-criterion proof floor at the session boundary (a refusal halts the workflow), but delivery itself — `finalPublish: true` and a linked spec execution transitioning to Delivered — belongs solely to the gated merge that lands on the project's delivery target. Fresh user merges resolve their spec-execution association once, at dispatch, through the registered merge-association port (`src/lib/workflows/merge/association-port.ts`; resolver policy in `src/lib/specs/merge-association.ts`); conflict retries copy provenance from the prior job, and merges of sessions hosting no active spec execution remain pass-through.

## Loop-generation fence invariant

Every graph-workflow execution loop instance is pinned to the `(executionId, loopEpoch)` generation it was started for (`src/lib/workflow-graph/loop-fence.ts`). `loopEpoch` lives on the execution (runtime tier) and is bumped ONLY by `resume()` — abort/halt/pause never bump it (abort replaces the execution id instead). The fence rides a dedicated AsyncLocalStorage from `executionLoop.run()` into everything the loop awaits, and `executionRepository.mutateActive` rejects any write whose ambient fence no longer matches the session's persisted generation (`StaleLoopFenceError`). The loop treats that error — and any refresh that returns a different generation — as "I have been superseded": it exits silently (`graph-workflow.loop.fenced_out`), never recording a halt or draining, because those are session-keyed and would mutate the successor's state.

Consequences when touching engine code:

- Never adopt a `getActive` result inside loop-owned code without a generation check (`adoptExecution`/`refreshExecution` in `execution-loop.ts` are the only sanctioned adoption paths).
- User/agent-route mutations carry no fence and are unaffected; the fence is scoped to its own session, so fenced code touching ANOTHER session (e.g. collaboration dispatch) is also unaffected.
- `activeLoops` is instance-tokened: an exiting stale loop cannot unregister the live loop; do not revert it to a bare per-session Set.
- `StaleLoopFenceError` must stay excluded from halt conversion (`runContextTask`'s catch and the loop's outer catch) — converting it to a halt re-creates the incident-622782a0 failure mode (a zombie loop halting the successor execution).

Active cancellation complements the fence: user-initiated pause/abort/halt and `resume()` abort every cancellable conversation via `collectCancellableConversationIds` (running-task conversations ∪ `laneStates` lane conversations, so validator task-runs stop spending too). Task-run turns register an `AbortController` in the conversations abort-registry (`runTaskRunTurnForMachine`) and the signal threads facade → `dispatchTaskRun` → runner (both codex and claude runners fold it into their teardown path). The loop's own drain-and-halt intentionally does NOT cancel — engine halts drain so completed sibling work lands. Fence = correctness (a superseded loop cannot write); cancellation = economy (a cancelled turn stops burning tokens); keep both.

## Turn liveness (stall watchdog)

Every agent turn carries a per-turn inactivity bound in addition to the whole-turn safety net: `src/lib/agent-backends/stall-watchdog.ts`, armed at dispatch and reset by every backend event, aborts the turn (and closes the runtime) after dead air. The bound resolves from `defaultStallTimeoutMs` in backend descriptor metadata (codex 20 min; claude null — its 1h `agentBackends.claude.timeoutMs` net and legitimate background-task silences make an inactivity bound wrong there), overridable via `agentBackends.codex.stallTimeoutMs` in config.json (`null` disables). The conversation actor owns the watchdog for streaming turns (`wireTurnAbort` + the onEvent funnel); each task runner owns it for task-runs (`AgentTaskRequest.stallTimeoutMs`). A stalled implementer turn surfaces as `abortReason: "stalled"` → `AgentTurnFailedError cause: "stall"`; the execution loop grants ONE automatic recovery (context → ready, rotation scheduled, retry on a fresh conversation — `recoveryKind: "stall"` in `decisions.jsonl`), then halts with `agent_turn_failed/stall`. Do not weaken this into a whole-turn timeout: healthy long turns emit events steadily; only dead air should trip it. Origin: the 9h37m silent codex turn in execution `1b8d9120` (docs/reports/workflow-audits/2026-07-19-native-sdd-execution-audit.md, RCA addendum).

## Templates (storage, tiers, parameters, prerequisites)

A saved workflow definition is a reusable **template**, launched via `cctl workflow start <id>`. Templates are **not in the repo** — they live in the OS config dir (the dir from `tech.md` "OS-aware config dir") at `<configDir>/workflows/<scopeKey>/<id>.json`. `src/lib/workflow-graph/storage.ts` (`createWorkflowStorageService`) is the read/write choke point: it runs full accept-time validation and mints `id`/`revision`/timestamps.

- **Tiers / `WorkflowScope`** — `project` (scopeKey = `base64url(projectPath)`) and `global` (the cross-project library; reserved scopeKey `global.shared`, whose `.` can never collide with a base64url path). `cctl workflow templates` returns both, tier-tagged.
- **Authoring** — the `/templates` UI, the HTTP handlers (`POST /api/workflow-templates` for global), `createWorkflowStorageService().create(scope, draft)` directly, or the agent-facing `cctl workflow create --file plan.json` / `cctl workflow replace <id> --file plan.json` flow (author the plan as a `plan.json` file — see the `graph-workflow-planning` skill). The CLI create/replace flow is project-tier; author/edit a **global** template (parameterize it with `{{inputs.<name>}}` so it isn't bound to one project) through the Templates UI. All paths resolve tier→scope through `scopeForTier` and reuse the shared inflate + accept-time validation + storage path. Browse the project tier with `cctl workflow list` / `cctl workflow get <id>` / `cctl workflow delete <id>`; browse the global tier with `cctl workflow templates --tier global`.
- **Parameters** — declared `string` | `text` | `enum`; referenced as `{{inputs.<name>}}`. Substitution runs at launch over the closed `SUBSTITUTION_FIELD_SET` ONLY: task **instructions**, context `title`/`description`/`acceptanceCriteria`, and charter fields (mission, conventions, …, `invariants[]` `statement` — not `id` — and `sourcesOfTruth[]` `label`/`locator`/`description`/`appliesTo`). It does **NOT** touch task **titles**, ids, order, edges, config, or prerequisites — a token placed there renders literally (a silent bug, not a validation error). Launch with `cctl workflow start <id> --file inputs.json` (the inputs file supplies the `parameters`).
- **Prerequisites** — declarative `path` | `skill` requirements, probed deterministically before any tokens are spent (the `skill` kind also covers slash-commands; scope a skill to a `backend` when only one backend uses it). Worktree-relative paths only. Use them to fail-fast a global template on an unsuitable project.
- **Dynamic tasks (mutability)** — a context with `mutability.allowAgentTaskAdd: true` lets the agent add tasks at runtime via `cctl workflow task add`: e.g. a bootstrap task that fans `tasks.md` out to one task per subtask, or a validate-loop that adds one remediation task per finding plus a re-validate task, looping until clean. Plan these with the `graph-workflow-planning` skill.
