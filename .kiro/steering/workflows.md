# Workflow Orchestration with XState

All multi-step background workflows use XState v5 state machines. Two machines exist today: **Optimistic** (prompt + merge) and **Smart Merge** (git pipeline). New workflows follow the same patterns.

## Directory Convention

```
src/lib/workflows/
├── types.ts                    # BaseWorkflowContext, shared types
├── runtime-state.ts            # External registry for non-serializable data
├── persistence.ts              # Debounced snapshot writes
├── actions.ts                  # Reusable SSE broadcast + notification actions
├── <workflow-name>/
│   ├── types.ts                # Context, events, input, output types
│   ├── actors.ts               # fromPromise stubs (default implementations)
│   ├── machine.ts              # setup() → createMachine()
│   ├── machine.test.ts         # Tests using .provide() overrides
│   ├── actor-implementations.ts # Production logic (optional, for complex actors)
│   └── workflow-manager.ts     # Actor lifecycle (optional, for long-running workflows)
```

## Machine Anatomy

Every machine follows the same three-phase pattern:

```typescript
export const fooMachine = setup({
  types: {} as {
    context: FooContext;
    events: FooEvent;
    input: FooInput;
    output: FooOutput;
  },
  actors: { /* fromPromise stubs */ },
  guards: { /* pure boolean functions */ },
  actions: { onTerminal: () => {} }, // stub, overridden via .provide()
}).createMachine({
  id: "foo",
  context: ({ input }) => ({ _schemaVersion: 1, ...input, error: null }),
  initial: "firstState",
  states: { /* ... */ },
  output: ({ context }) => ({ status: context.finalStatus, /* ... */ }),
});
```

### Key conventions

- **`_schemaVersion`** in context — enables snapshot migration on restore
- **`finalStatus`** field — set in terminal state entry, used by `output`
- **Stub actions** in `setup()` — real implementations injected via `.provide()` at runtime
- **`onTerminal`** action — called on entry to every terminal state; overridden in production for cleanup

## Actor Pattern: Stubs + `.provide()`

Actors are defined as `fromPromise` stubs with default implementations that lazy-import production logic:

```typescript
// actors.ts — stub with default implementation
export const doWork = fromPromise<WorkOutput, WorkInput>(async ({ input }) => {
  const { doWorkImpl } = await import("@/lib/some-module");
  return doWorkImpl(input);
});
```

**Production** injects via `.provide()` in the workflow manager:
```typescript
const machine = fooMachine.provide({
  actors: { doWork: fromPromise(async ({ input }) => realImpl(input)) },
  actions: { onTerminal: () => { /* cleanup */ } },
});
```

**Tests** inject mocks via `.provide()` — no `vi.mock()` needed for actors:
```typescript
const testMachine = fooMachine.provide({
  actors: { doWork: fromPromise(async () => ({ result: "mock" })) },
});
```

## Non-Serializable State

XState context must be JSON-serializable. AbortControllers, lock release functions, and stream handles live in `runtime-state.ts`:

```typescript
registerRuntime(key, { abortController: new AbortController() });
// Inside actor: const { abortController } = getRuntime(key);
// On terminal:  cleanupRuntime(key);
```

Key format: `${projectPath}::${sessionName}`. Registry uses `globalThis` singleton (HMR-safe).

## Terminal States

All machines end in explicit `type: "final"` states:

```typescript
completed: { type: "final", entry: [assign({ finalStatus: "completed" }), "onTerminal"] },
failed:    { type: "final", entry: [assign({ finalStatus: "failed" }), "onTerminal"] },
```

Output is computed from context on completion:
```typescript
output: ({ context }) => ({
  status: context.finalStatus ?? "completed",
  error: context.error,
})
```

## Error Handling

Every actor invocation has an `onError` transition:

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

Handle both `Error` objects and thrown strings/unknowns. Include `gitOutput` when present.

## Guard Conventions

- **Context-only guards** for state checks: `({ context }) => context.autoResolve`
- **Event-based guards** for actor output: `({ event }) => (event as { output: T }).output.hasChanges`
- **Priority ordering** via sequential `always` transitions (first true guard wins):

```typescript
evaluatingExit: {
  always: [
    { guard: "isPlanComplete", target: "#completed" },
    { guard: "isCapReached", target: "#halted" },
    { guard: "isCircuitBreakerOpen", target: "#halted" },
    { target: "executingIteration" }, // default: continue
  ],
}
```

## SSE Broadcasting

Shared action factories in `actions.ts` provide SSE broadcasting via dependency injection:

```typescript
// In machine setup — stub
actions: { broadcastStatus: () => {} }

// In .provide() — real implementation
actions: {
  broadcastStatus: ({ context }) => {
    broadcast({ type: "workflow-status", projectName: context.projectName, ... });
  },
}
```

Available actions: `broadcastWorkflowEvent`, `persistSnapshot`, `createNotificationAction`.

## Persistence

For long-running workflows, context snapshots can be debounced to the state file:

```typescript
persistWorkflowSnapshot(projectPath, sessionName, actor.getPersistedSnapshot());
// Debounced 500ms by default; immediate: true for terminal states
```

Schema version checked on restore — mismatched versions are discarded.

## Testing Patterns

### Machine factory helper
```typescript
function createTestMachine(overrides: Partial<ActorOverrides> = {}) {
  return fooMachine.provide({
    actors: {
      doWork: overrides.doWork ?? fromPromise(async () => defaultOutput),
    },
    actions: { onTerminal: vi.fn() },
  });
}
```

### Terminal state assertion
```typescript
const actor = createActor(testMachine, { input });
actor.start();
const output = await toPromise(actor);
expect(output.status).toBe("completed");
```

### Guard testing — verify transition blocked/allowed
```typescript
actor.send({ type: "CONFIRM" });
expect(actor.getSnapshot().value).toBe("planning"); // guard blocked
```

### Intermediate state waiting
```typescript
function waitForState(actor: AnyActorRef, state: string, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${state}`)), timeoutMs);
    if (actor.getSnapshot().value === state) { clearTimeout(timer); resolve(); return; }
    const sub = actor.subscribe((s) => {
      if (s.value === state) { clearTimeout(timer); sub.unsubscribe(); resolve(); }
    });
  });
}
```

### Deferred promises for pause/resume
```typescript
const resolvers: Array<{ resolve: (v: Output) => void }> = [];
const actor = startMachine({
  doWork: fromPromise(() => new Promise(resolve => resolvers.push({ resolve }))),
});
// Later: resolvers[0]!.resolve(output);
```

### Actor cleanup in afterEach
```typescript
const activeActors: AnyActorRef[] = [];
afterEach(() => {
  for (const a of activeActors) { try { a.stop(); } catch {} }
  activeActors.length = 0;
});
```

## Adding a New Workflow

1. Create `src/lib/workflows/<name>/` with `types.ts`, `actors.ts`, `machine.ts`, `machine.test.ts`
2. Context extends `BaseWorkflowContext` and includes `_schemaVersion`, `finalStatus`, `error`
3. Define `fromPromise` actor stubs in `actors.ts` with default implementations
4. Wire production `.provide()` at the call site (or in a `workflow-manager.ts` for long-running workflows)
5. Use shared `actions.ts` factories for SSE broadcasting
6. If the workflow needs abort/pause, use `runtime-state.ts` for AbortControllers
7. If the workflow needs persistence, use `persistence.ts` for snapshot writes

---

## Graph Workflows — Configuration Cascade

Graph workflow configuration is resolved through a **three-tier cascade**. Each tier overrides the one above it:

1. **Global** — `workflowDefaults` in `config.json` (the base values for every workflow).
2. **Workflow** — `workflowConfig` on the workflow definition (overrides any global block for this workflow).
3. **Per-context** — individual blocks on an `executionContext` (overrides both global and workflow for that context only).

Resolution happens at seed time (in `src/lib/workflow-graph/resolve-config.ts`) — the resolved context is snapshotted into the execution's `workingDefinition`, so later edits to global or workflow configs do not mutate a running execution.

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

```jsonc
// workflow definition — workflow tier overrides global, per-context overrides both
{
  "workflowConfig": {
    "implementer": { "model": "sonnet" }      // every context uses sonnet implementer unless it overrides
  },
  "executionContexts": [
    {
      "id": "plan",
      "title": "Plan",
      "acceptanceCriteria": "A plan.md file exists describing the approach at a level of detail sufficient for an implementer to follow.",
      "contextValidator": { "kind": "disabled" }   // opt out of agent validation for this context
    },
    {
      "id": "impl",
      "title": "Implement",
      "acceptanceCriteria": "The feature behaves as described in the plan when exercised end-to-end.",
      "implementer": { "model": "opus", "reasoningEffort": "high" },   // per-context override
      "scriptValidator": { "enabled": true }   // run the project's preMergeCommand as a deterministic gate
    }
  ]
}
```

### `workflowDefaults` block shape

`workflowDefaults` in `config.json` has exactly **six blocks**, all independent and individually overridable at each tier:

| Block | Purpose |
|-------|---------|
| `implementer`       | Agent config for the implementer (backend, model, reasoning effort). |
| `contextValidator`  | Agent (LLM) validator that judges the *intent* of the acceptance criteria against the completed work. Discriminated on `type: "claude" \| "codex"`. |
| `scriptValidator`   | Deterministic validator — runs the project's `preMergeCommand` as a pre-merge gate. Shape: `{ enabled: boolean }`. Requires the project to have `preMergeCommand` configured in `CommandCenter.json`. |
| `iterationPolicy`   | Iteration caps and continuity policy (`maxIterations`, `continuity.enabled`, optional `contextLimitTokens`). |
| `circuitBreaker`    | Failure-threshold policy (`consecutiveFailureThreshold`). |
| `mutability`        | What the implementer is allowed to change (e.g. `allowAgentTaskAdd`). |

### Acceptance criteria is context-level

`acceptanceCriteria` is a **required field on every execution context** (`executionContext.acceptanceCriteria`). It is:
- Passed to the **implementer** as the success condition the context is working toward.
- Passed to the **agent (context) validator** (when enabled) as the rubric to evaluate against.

AC lives on the context — never on the validator. A single statement of "done" is the source of truth for both roles.

**Authoring rules:**
- Write **intent-based outcomes**, not deterministic gates. The agent validator judges the intent of the criteria and makes allowance for imprecise wording. "The feature behaves correctly when exercised end-to-end" is good; "all tests pass and there are no type errors" is wrong (see below).
- Keep criteria **inside this context's scope**. If another context is responsible for finishing related work — downstream type cleanups, integrations, migrations — do not include it here. The agent validator explicitly respects context scope boundaries and will not fail a context for incomplete work that is explicitly downstream.
- **Do NOT encode deterministic checks** (`tests pass`, `no type errors`, `lint clean`, `build succeeds`) in acceptance criteria. The agent validator is instructed to ignore those. Enable `scriptValidator` on the context instead if those gates must pass before the context advances.

### Dual-validator model: agent + script

Every execution context can enable **two independent validators**, in any combination:

| Validator | Nature | What it judges | Failure artifact |
|-----------|--------|----------------|------------------|
| `contextValidator` | LLM agent (Claude or Codex) | Whether the completed tasks satisfy the **intent** of the acceptance criteria, in scope of this context. | Issues list; affected tasks are reopened. |
| `scriptValidator`  | Deterministic script | Whether the project's `preMergeCommand` exits successfully against the current worktree. | Full command output saved to `.cc/workflow/<executionId>/pre-merge-<timestamp>.log`; a new remediation task is added to the context pointing at the log. |

**Ordering.** When both are enabled, the script validator runs **first**. If the script fails, the agent validator is skipped for that iteration — no point spending LLM turns on a tree that doesn't even compile. Both script and agent failures count as failed iterations (consume iteration budget, feed the circuit breaker).

**Why two.** Agent validators should focus on judgment-based checks only an LLM can make (did the implementation match user intent? does the API contract make sense?). Deterministic checks are cheaper and more reliable as a script; reusing `preMergeCommand` keeps one source of truth across smart merge and graph workflows.

**Missing `preMergeCommand` is an infra error.** If a context enables `scriptValidator` but the project has no `preMergeCommand` in `CommandCenter.json`, the workflow halts with a `script_validator_missing_command` halt reason. Silent skipping would make the workflow appear to pass gates that were never run.

### Opting out of the agent validator

To skip the agent validator for a specific context, set:

```jsonc
{ "contextValidator": { "kind": "disabled" } }
```

This is the `contextValidatorOverride` discriminated union. The two shapes are:
- `{ "kind": "use", "value": <validator config> }` — use this validator config instead of the inherited one.
- `{ "kind": "disabled" }` — explicitly skip the agent validator; the context completes on the implementer's claim (plus the script validator, if enabled).

Omitting `contextValidator` entirely means "inherit from workflow / global" — which is the usual case.

To enable or disable the script validator per context, set `scriptValidator: { enabled: true }` or `{ enabled: false }`. Omit to inherit. A context with both validators disabled completes as soon as the implementer reports the context done.

### Agent validator engines

Agent validators (global default or per-context override's `value`) are discriminated on `type`:

| Type | Engine | Runs where | Notes |
|------|--------|-----------|-------|
| `claude` | Claude agent (via SDK) | Cloud | Default choice for intent-based reviews. |
| `codex` | OpenAI Codex | Local | Useful when the judgment benefits from local file inspection without a round-trip. |

Both engines receive the same intent-based prompt — they are asked to judge whether the completed tasks satisfy the intent of the acceptance criteria closely enough for the overall objective, and explicitly not to enforce tests/types/lint/build (which belong to the script validator). Set the validator type directly — do **NOT** configure a Claude validator and instruct it to call Codex via MCP tools.

```jsonc
// Codex validator
{ "type": "codex", "enabled": true, "codex": { "reasoningEffort": "high" }, "continuity": { "enabled": true } }

// Claude validator
{ "type": "claude", "enabled": true, "agent": { "backend": "claude", "model": "sonnet", "reasoningEffort": "high" }, "continuity": { "enabled": true } }
```

Codex reasoning levels are model-aware — `getCodexReasoningLevelsForModel()` returns the allowed levels for a given model.

### Clearing existing workflow state

The cascade refactor removed legacy fields (`agent`, `contextValidation`, `taskValidation`, `contextSoftLimitTokens`, `contextHardLimitTokens`). The schema-cutover guard rejects legacy shapes at read time. Existing workflow state must be cleared before the app will start:

```bash
bun scripts/clean-graph-workflow-state.ts
```

The script clears `graphWorkflowExecution` / `graphWorkflowExecutionHistory` from every session in `state.json` and deletes the `workflows/` directory alongside the state file. It is idempotent and safe to rerun. Recreate workflows afterward via the UI or MCP tools.

---

_Document patterns, not every state transition. New workflows following these patterns shouldn't require updates._
