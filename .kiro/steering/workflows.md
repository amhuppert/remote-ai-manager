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

Resolution at seed time (`src/lib/workflow-graph/resolve-config.ts`); resolved context snapshotted into execution's `workingDefinition` — later edits don't mutate running executions.

```jsonc
// config.json — global tier
{
  "workflowDefaults": {
    "implementer":      { "backend": "claude", "model": "opus",   "reasoningEffort": "medium" },
    "contextValidator": { "type": "claude", "enabled": true, "agent": { "backend": "claude", "model": "sonnet", "reasoningEffort": "medium" }, "continuity": { "enabled": true } },
    "scriptValidator":  { "enabled": false },
    "iterationPolicy":  { "maxIterations": 20, "continuity": { "enabled": true } },
    "circuitBreaker":   { "consecutiveFailureThreshold": 3 },
    "mutability":       { "allowAgentTaskAdd": false }
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

Six blocks, all individually overridable per tier:

| Block | Purpose |
|---|---|
| `implementer` | Implementer agent config (backend, model, reasoning) |
| `contextValidator` | Agent (LLM) validator on intent of acceptance criteria. Discriminated `type: "claude" \| "codex"` |
| `scriptValidator` | Deterministic validator that runs project's `preMergeCommand`. `{ enabled: boolean }`. Requires `preMergeCommand` in `CommandCenter.json` |
| `iterationPolicy` | `maxIterations`, `continuity.enabled`, optional `contextLimitTokens` |
| `circuitBreaker` | `consecutiveFailureThreshold` |
| `mutability` | E.g. `allowAgentTaskAdd` |

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
