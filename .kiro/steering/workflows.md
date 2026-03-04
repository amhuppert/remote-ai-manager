# Workflow Orchestration with XState

All multi-step background workflows use XState v5 state machines. Three machines exist today: **Optimistic** (prompt + merge), **Smart Merge** (git pipeline), and **Ralph Loop** (autonomous dev loop). New workflows follow the same patterns.

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

Available actions: `broadcastStatus`, `broadcastIterationComplete`, `broadcastFixPlanUpdated`, `broadcastCircuitBreaker`, `persistSnapshot`.

## Persistence

For long-running workflows (Ralph Loop), context snapshots are debounced to the state file:

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

_Document patterns, not every state transition. New workflows following these patterns shouldn't require updates._
