# Workflow Orchestration with XState

Multi-step background workflows use XState v5. Existing machines: `optimistic/`, `merge/` (Smart Merge), `commit/`, `conversation/`. Graph workflows (`graph-workflow/`) use a custom execution loop, not XState. New XState workflows follow the patterns below.

## Layout

```
src/lib/workflows/
├── types.ts                    # BaseWorkflowContext, shared types
├── runtime-state.ts            # External registry for non-serializable data
├── persistence.ts              # Debounced snapshot writes
├── actions.ts                  # Reusable SSE/notification actions
├── <workflow-name>/
│   ├── types.ts                # Context, events, input, output
│   ├── actors.ts               # fromPromise stubs (default impls)
│   ├── machine.ts              # setup() → createMachine()
│   ├── machine.test.ts         # Tests using .provide() overrides
│   ├── actor-implementations.ts # Production logic (complex actors)
│   └── workflow-manager.ts     # Actor lifecycle (long-running)
```

## Machine anatomy

```typescript
export const fooMachine = setup({
  types: {} as { context: FooContext; events: FooEvent; input: FooInput; output: FooOutput; },
  actors: { /* fromPromise stubs */ },
  guards: { /* pure boolean fns */ },
  actions: { onTerminal: () => {} }, // stub, overridden via .provide()
}).createMachine({
  id: "foo",
  context: ({ input }) => ({ _schemaVersion: 1, ...input, error: null }),
  initial: "firstState",
  states: { /* ... */ },
  output: ({ context }) => ({ status: context.finalStatus, /* ... */ }),
});
```

Conventions:
- `_schemaVersion` in context — enables snapshot migration on restore
- `finalStatus` set in terminal-state entry, used by `output`
- `onTerminal` action — overridden in production for cleanup

## Actor pattern: stubs + `.provide()`

Actors are `fromPromise` stubs with default impls that lazy-import production logic:

```typescript
// actors.ts
export const doWork = fromPromise<WorkOutput, WorkInput>(async ({ input }) => {
  const { doWorkImpl } = await import("@/lib/some-module");
  return doWorkImpl(input);
});
```

Production injects via `.provide()` at the call site:
```typescript
const machine = fooMachine.provide({
  actors: { doWork: fromPromise(async ({ input }) => realImpl(input)) },
  actions: { onTerminal: () => { /* cleanup */ } },
});
```

Tests inject mocks via `.provide()` — **no `vi.mock()` for actors**:
```typescript
const testMachine = fooMachine.provide({
  actors: { doWork: fromPromise(async () => ({ result: "mock" })) },
});
```

## Non-serializable state

Context must be JSON-serializable. AbortControllers, lock release fns, stream handles live in `runtime-state.ts`:

```typescript
registerRuntime(key, { abortController: new AbortController() });
const { abortController } = getRuntime(key);
cleanupRuntime(key); // on terminal
```

Key format: `${projectPath}::${sessionName}`. Registry is `globalThis` singleton (HMR-safe).

## Terminal states

```typescript
completed: { type: "final", entry: [assign({ finalStatus: "completed" }), "onTerminal"] },
failed:    { type: "final", entry: [assign({ finalStatus: "failed" }),    "onTerminal"] },
```

Output computed from context:
```typescript
output: ({ context }) => ({ status: context.finalStatus ?? "completed", error: context.error })
```

## Error handling

Every actor invocation has `onError`:

```typescript
onError: {
  target: "failed",
  actions: assign({
    error: ({ event }) => {
      const err = event.error;
      if (err instanceof Error) {
        const parts = [err.message];
        if ((err as Error & { gitOutput?: string }).gitOutput) parts.push((err as Error & { gitOutput?: string }).gitOutput!);
        return parts.join("\n");
      }
      return String(err);
    },
    completedAt: () => new Date().toISOString(),
  }),
}
```

Handle `Error` and unknowns. Include `gitOutput` when present.

## Guards

- **Context guards**: `({ context }) => context.autoResolve`
- **Event guards**: `({ event }) => (event as { output: T }).output.hasChanges`
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

## SSE broadcasting

Shared factories in `actions.ts` use DI:

```typescript
// machine setup — stub
actions: { broadcastStatus: () => {} }

// .provide() — real
actions: {
  broadcastStatus: ({ context }) => {
    broadcast({ type: "workflow-status", projectName: context.projectName, ... });
  },
}
```

Available: `broadcastWorkflowEvent`, `persistSnapshot`, `createNotificationAction`.

## Persistence

Long-running workflows debounce snapshots:

```typescript
persistWorkflowSnapshot(projectPath, sessionName, actor.getPersistedSnapshot());
// 500ms debounce; immediate: true for terminal states
```

Schema version checked on restore — mismatched versions discarded.

## Testing

```typescript
// Factory helper
function createTestMachine(overrides: Partial<ActorOverrides> = {}) {
  return fooMachine.provide({
    actors: { doWork: overrides.doWork ?? fromPromise(async () => defaultOutput) },
    actions: { onTerminal: vi.fn() },
  });
}

// Terminal assertion
const actor = createActor(testMachine, { input });
actor.start();
const output = await toPromise(actor);
expect(output.status).toBe("completed");

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

## Adding a new workflow

1. Create `src/lib/workflows/<name>/` with `types.ts`, `actors.ts`, `machine.ts`, `machine.test.ts`
2. Context extends `BaseWorkflowContext`, includes `_schemaVersion`, `finalStatus`, `error`
3. `fromPromise` stubs in `actors.ts` with default impls
4. Wire production `.provide()` at call site (or `workflow-manager.ts` for long-running)
5. Use shared `actions.ts` factories for SSE
6. AbortControllers/locks → `runtime-state.ts`
7. Persistence → `persistence.ts`

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
    "askUserQuestions": { "enabled": false }
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

Seven blocks, all individually overridable per tier:

| Block | Purpose |
|---|---|
| `implementer` | Implementer agent config (backend, model, reasoning) |
| `contextValidator` | Agent (LLM) validator on intent of acceptance criteria. Discriminated `type: "claude" \| "codex"` |
| `scriptValidator` | Deterministic validator that runs project's `preMergeCommand`. `{ enabled: boolean }`. Requires `preMergeCommand` in `CommandCenter.json` |
| `iterationPolicy` | `maxIterations`, `continuity.enabled`, optional `contextLimitTokens` |
| `circuitBreaker` | `consecutiveFailureThreshold` |
| `mutability` | E.g. `allowAgentTaskAdd` |
| `askUserQuestions` | Whether lane agents may ask the operator questions mid-task via `cctl ask`. `{ enabled: boolean }`, default disabled; one value covers both the implementer and context-validator roles |

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
  (`workflow-continuity-service.ts`; a scheduled context-window rotation
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

## Templates (storage, tiers, parameters, prerequisites)

A saved workflow definition is a reusable **template**, launched via `cctl workflow start <id>`. Templates are **not in the repo** — they live in the OS config dir (the dir from `tech.md` "OS-aware config dir") at `<configDir>/workflows/<scopeKey>/<id>.json`. `src/lib/workflow-graph/storage.ts` (`createWorkflowStorageService`) is the read/write choke point: it runs full accept-time validation and mints `id`/`revision`/timestamps.

- **Tiers / `WorkflowScope`** — `project` (scopeKey = `base64url(projectPath)`) and `global` (the cross-project library; reserved scopeKey `global.shared`, whose `.` can never collide with a base64url path). `cctl workflow templates` returns both, tier-tagged.
- **Authoring** — the `/templates` UI, the HTTP handlers (`POST /api/workflow-templates` for global), `createWorkflowStorageService().create(scope, draft)` directly, or the agent-facing `cctl workflow create --file plan.json` / `cctl workflow replace <id> --file plan.json` flow (author the plan as a `plan.json` file — see the `graph-workflow-planning` skill). The CLI create/replace flow is project-tier; author/edit a **global** template (parameterize it with `{{inputs.<name>}}` so it isn't bound to one project) through the Templates UI. All paths resolve tier→scope through `scopeForTier` and reuse the shared inflate + accept-time validation + storage path. Browse the project tier with `cctl workflow list` / `cctl workflow get <id>` / `cctl workflow delete <id>`; browse the global tier with `cctl workflow templates --tier global`.
- **Parameters** — declared `string` | `text` | `enum`; referenced as `{{inputs.<name>}}`. Substitution runs at launch over the closed `SUBSTITUTION_FIELD_SET` ONLY: task **instructions**, context `title`/`description`/`acceptanceCriteria`, and charter fields (mission, conventions, …, `sourcesOfTruth[]` `label`/`locator`/`description`/`appliesTo`). It does **NOT** touch task **titles**, ids, order, edges, config, or prerequisites — a token placed there renders literally (a silent bug, not a validation error). Launch with `cctl workflow start <id> --file inputs.json` (the inputs file supplies the `parameters`).
- **Prerequisites** — declarative `path` | `skill` requirements, probed deterministically before any tokens are spent (the `skill` kind also covers slash-commands; scope a skill to a `backend` when only one backend uses it). Worktree-relative paths only. Use them to fail-fast a global template on an unsuitable project.
- **Dynamic tasks (mutability)** — a context with `mutability.allowAgentTaskAdd: true` lets the agent add tasks at runtime via `cctl workflow task add`: e.g. a bootstrap task that fans `tasks.md` out to one task per subtask, or a validate-loop that adds one remediation task per finding plus a re-validate task, looping until clean. Plan these with the `graph-workflow-planning` skill.
