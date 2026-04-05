# Workflow Continuity Service API

**File**: `src/lib/workflows/graph-workflow/workflow-continuity-service.ts`

## Factory

```typescript
createWorkflowContinuityService(deps: WorkflowContinuityServiceDeps)
```

### Deps interface

```typescript
interface WorkflowContinuityServiceDeps {
  createConversation(
    projectPath: string,
    sessionName: string,
    opts: { role: "iteration" | "validator" },
  ): Promise<{ id: string }>;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<{ id: string } | null>; // null triggers stale session recovery
  startCodexThread(): Promise<{ threadId: string }>;
  resumeCodexThread(threadId: string): Promise<{ threadId: string }>;
  now?(): string;
}
```

## Methods

### resolveImplementerCall(input)
Decides whether to reuse or create a new Claude conversation for the implementer lane.

```typescript
input: {
  execution: GraphWorkflowExecution;
  projectPath: string;
  sessionName: string;
  contextId: string;
}
returns: Promise<{
  execution: GraphWorkflowExecution; // updated with new lane state
  conversationId: string;
  sessionAction: "reuse" | "create";
  promptMode: "iteration_seed" | "follow_up";
}>
```

Decision flow:
1. No lane state → fresh session (`iteration_seed`)
2. Different contextId → fresh (stale reference recovery + log)
3. Continuity disabled (`iterationPolicy.continuity.enabled === false`) → fresh per call
4. `rotateBeforeNextTurn === true` → fresh (mid-context rotation)
5. `getConversation()` returns null → fresh (stale session recovery, logs `workflow-continuity.stale_session.recovery`)
6. Otherwise → reuse existing conversation

### resolveValidatorCall(input)
Decides reuse or fresh for `task_validator` or `context_validator` lanes. Reads continuity policy from the execution context definition (not hardcoded).

```typescript
input: {
  execution: GraphWorkflowExecution;
  projectPath: string;
  sessionName: string;
  contextId: string;
  lane: "task_validator" | "context_validator";
  engine: "claude" | "codex";
}
returns: Promise<
  | { execution; sessionAction; engine: "claude"; conversationId: string }
  | { execution; sessionAction; engine: "codex"; threadId: string | undefined }
>
```

Policy source:
- `task_validator` → `ctx.taskValidation?.continuity.enabled` (defaults to `true`)
- `context_validator` → `ctx.contextValidation?.agentValidator?.continuity.enabled` (defaults to `true`)

Claude stale recovery: if `getConversation()` returns null for a stored conversation ID, falls back to fresh.
Codex resume failures fall back to `startCodexThread` (logs warn + recovers).

### recordClaudeTurnOutcome(input)
Updates claude lane state after a completed turn.

```typescript
input: {
  execution: GraphWorkflowExecution;
  lane: GraphWorkflowLaneKind;
  contextTokens: number | null;
  contextWindowMax: number | null;
  contextLimitTokens: number | undefined;
}
returns: GraphWorkflowExecution
```

- If `contextLimitTokens` defined and `contextTokens > contextLimitTokens`: sets `rotateBeforeNextTurn = true`, `limitEvaluation = "supported"`
- If no `contextLimitTokens`: `rotateBeforeNextTurn = false`, `limitEvaluation = "disabled"` (no heuristics)

### recordCodexTurnOutcome(input)
Updates codex lane state after a completed turn. Captures the real Codex thread ID post-run.

```typescript
input: {
  execution: GraphWorkflowExecution;
  lane: GraphWorkflowLaneKind;
  usage: GraphWorkflowLaneTurnUsage | null;
  contextLimitTokens: number | undefined;
  newThreadId?: string | null; // real thread ID available after thread.run() completes
}
returns: GraphWorkflowExecution
```

- `rotateBeforeNextTurn` always `false`
- `limitEvaluation`: `"unsupported"` when limit configured, `"disabled"` when not
- `sessionRef.threadId` updated with `newThreadId` when provided (enables thread reuse on next call)

### clearForNewContext(execution, nextContextId)
Wipes all lane states when execution advances to a new context.

```typescript
clearForNewContext(
  execution: GraphWorkflowExecution,
  nextContextId: string,
): GraphWorkflowExecution
```

## Lane State Schema

Stored in `execution.laneStates` as `Record<string, GraphWorkflowLaneState>`.
Keys are `GraphWorkflowLaneKind` values: `"implementer"`, `"task_validator"`, `"context_validator"`.

Each value is a `GraphWorkflowLaneState` discriminated by `engine: "claude" | "codex"`.

## Integration Points (execution-route-handlers.ts)

```typescript
const continuityService = createWorkflowContinuityService({
  createConversation,
  getConversation,
  startCodexThread: async () => ({ threadId: crypto.randomUUID() }),
  resumeCodexThread: async (threadId) => ({ threadId }),
});

// Both runners receive the service:
createValidatorRunner({ ..., continuityService, executionRepository });
createGraphWorkflowIterationOrchestrator({ ..., continuityService });
```

## Codex Thread ID Lifecycle

Codex thread IDs are only available after `thread.run()` completes:
1. `startCodexThread()` returns a placeholder UUID (not a real Codex thread ID)
2. Actual Codex `thread.run()` happens inside `executeValidatorCodex`
3. `recordCodexTurnOutcome({ newThreadId: thread.id })` stores the real ID
4. On next call, `resolveValidatorCall` returns the real thread ID
5. `executeValidatorCodex` calls `codex.resumeThread(storedThreadId)` for reuse
