# Graph Workflow Iteration Fix — Implementation Plan

## Problem Statement

The graph workflow execution creates new iterations endlessly because:
1. **Root cause**: The execution MCP tool server (`begin_task`, `complete_task`) is created but never wired to the agent's QuerySession. The agent literally cannot call these tools.
2. **Contributing factor**: The iteration prompt is too minimal — it doesn't explain the workflow lifecycle or MCP tools.
3. **Missing resilience**: When an iteration ends without completing tasks, the system immediately creates a new iteration instead of re-messaging the existing agent.

## Architecture Overview

```
executePromptStream()                    [src/lib/prompt.ts]
  → ensureConversationActor()            [manager.ts — creates runtime state]
  → sendConversationEvent(SUBMIT_PROMPT) [XState machine event]
    → executePromptForMachine()          [actor-implementations.ts]
      → createQuerySession({ mcpServers }) [SDK — MCP servers set here]
        → agent runs with available tools
```

The execution tool server is created in `iteration-orchestrator.ts:469` and passed to `runAgentIteration` via `input.toolServer`, but the implementation in `execution-route-handlers.ts:123-170` ignores `input.toolServer` — it calls `executePromptStream()` which has no parameter for additional MCP servers.

---

## Phase 1: Wire MCP Tool Server to Agent

**Goal**: Get the `graph-workflow` execution tool server (begin_task, complete_task, upsert_shared_document, add_task) into the agent's QuerySession.

**Approach**: Use the existing `ConversationRuntimeState` pattern. Non-serializable objects (QuerySession handles, AbortControllers) already live here. We add `additionalMcpServers` to the runtime state. The `executePromptForMachine` function merges them when creating the QuerySession.

### Step 1.1: Extend ConversationRuntimeState

**File**: `src/lib/workflows/conversation/runtime-state.ts`

Add field:
```typescript
interface ConversationRuntimeState {
  // ... existing fields ...
  /** Per-conversation MCP servers injected by callers (e.g., graph workflow execution tools). */
  additionalMcpServers?: Record<string, unknown>;
}
```

**Test**: Type-level change only. No behavioral test needed.

### Step 1.2: Extend executePromptStream to accept and set additionalMcpServers

**File**: `src/lib/prompt.ts`

Changes:
1. Add `additionalMcpServers?: Record<string, unknown>` to the `options` parameter
2. Add `setAdditionalMcpServers` to `PromptDeps` interface (optional, for DI/testability)
3. After `ensureConversationActor` returns (runtime state exists), call `setAdditionalMcpServers`
4. Default implementation sets the field on `ConversationRuntimeState`
5. Extend return type: `{ conversationId, contextTokens, contextWindowMax }` — read from actor snapshot after `waitForTurnCompletion`

**PromptDeps addition**:
```typescript
interface PromptDeps {
  // ... existing methods ...
  setAdditionalMcpServers?(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    servers: Record<string, unknown>,
  ): void;
}
```

**In executePromptStream** (after ensureConversationActor, before sendConversationEvent):
```typescript
if (options?.additionalMcpServers) {
  resolvedDeps.setAdditionalMcpServers?.(
    projectPath, session.sessionName, conversationId!, options.additionalMcpServers
  );
}
```

**Return type extension** (after waitForTurnCompletion):
```typescript
const snap = actor.getSnapshot();
return {
  conversationId,
  contextTokens: snap.context.totals.contextTokens ?? null,
  contextWindowMax: snap.context.totals.contextWindowMax ?? null,
};
```

**Test** (`prompt.test.ts`):
- RED: call `executePromptStream` with `additionalMcpServers: { "test-server": mockServer }`. Assert `deps.setAdditionalMcpServers` was called with the server.
- GREEN: implement the wiring.
- RED: call `executePromptStream`, assert return value includes `contextTokens` and `contextWindowMax` from actor snapshot.
- GREEN: implement the snapshot read.

### Step 1.3: Merge additionalMcpServers in executePromptForMachine

**File**: `src/lib/workflows/conversation/actor-implementations.ts`

In the `createQuerySession` call (lines 773-792), merge runtime's additional servers:
```typescript
mcpServers: {
  ...(initToolServer ? { "ralph-loop-init": initToolServer } : {}),
  ...(notificationToolServer ? { "agent-notification": notificationToolServer } : {}),
  ...(codexToolServer ? { "codex-tool": codexToolServer } : {}),
  "roadmap-tools": deps.createRoadmapToolServer({ projectPath: input.projectPath }),
  "graph-workflow-planner": deps.createWiredPlannerToolServer({ ... }),
  ...(runtime.additionalMcpServers ?? {}),
},
```

This only runs during QuerySession creation (not reuse). For re-messaging within the same iteration, the QuerySession is reused with its original MCP server config — which already includes the execution tools from the first prompt.

**Test** (`actor-implementations.test.ts`):
- RED: set `runtime.additionalMcpServers = { "graph-workflow": mockToolServer }` on the runtime state. Call `executePromptForMachine`. Assert `createQuerySession` was called with `mcpServers` containing `"graph-workflow": mockToolServer` alongside the standard servers.
- GREEN: add the spread to the mcpServers object.

### Step 1.4: Pass tool server through in runAgentIteration

**File**: `src/lib/workflow-graph/execution-route-handlers.ts`

In the `runAgentIteration` callback (lines 123-170), pass the tool server:
```typescript
runAgentIteration: async (input) => {
  const session = await defaultGetSession(input.projectPath, input.sessionName);
  if (!session) throw new Error("Session not found");

  let promptError: string | null = null;
  const result = await executePromptStream(
    input.projectPath,
    session,
    input.prompt,
    (event, data) => { /* ... existing event handler ... */ },
    input.conversationId,
    input.model,
    undefined, // images
    {
      autonomous: true,
      effort: input.reasoningEffort,
      additionalMcpServers: { "graph-workflow": input.toolServer },
    },
  );

  if (promptError) throw new Error(promptError);
  return {
    contextTokens: result.contextTokens ?? null,
    contextWindowMax: result.contextWindowMax ?? null,
  };
},
```

Also update `GraphWorkflowRunAgentIterationInput` and the return type:
```typescript
// Return type for runAgentIteration
interface GraphWorkflowAgentIterationResult {
  contextTokens: number | null;
  contextWindowMax: number | null;
}
```

**Test** (`execution-route-handlers.test.ts`):
- This is integration-level. The existing tests mock `executePromptStream`. Verify the mock is called with the `additionalMcpServers` option containing the tool server.

---

## Phase 2: Rewrite Agent Prompts

**Goal**: Give the agent comprehensive context about the workflow system, available MCP tools, and the expected protocol.

### Step 2.1: Rewrite buildIterationPrompt

**File**: `src/lib/workflows/graph-workflow/iteration-orchestrator.ts`

The current prompt (lines 204-241) is:
```
Execution context: {title}
Context goal: {description}
You are running one workflow iteration. Work only inside this execution context.
Begin the active task explicitly before doing work and complete it explicitly when done.
Shared documents: ...
Remaining tasks in order: ...
```

Rewrite to include:

```
## Workflow Context
You are an agent executing tasks inside a graph workflow managed by Command Center (CC).
Each workflow is a DAG of execution contexts. You are operating inside: "{contextTitle}".
{contextDescription ? "Goal: {contextDescription}" : ""}

## Protocol — REQUIRED
You have MCP tools provided by the "graph-workflow" tool server. You MUST use them:

1. Call `begin_task` with the task slug BEFORE starting work on a task.
2. Do the implementation work for that task.
3. Call `complete_task` with the task slug and a summary AFTER finishing.
   - The summary must describe: files changed, tests added/run, notable decisions.
   - This is the ONLY way to advance the workflow. If you do not call `complete_task`,
     the task remains open and the workflow cannot progress.

Work through tasks in order. Begin the first non-completed task, finish it, then move
to the next.

## Available MCP Tools (graph-workflow server)
- `begin_task({ taskSlug })` — Mark a task as actively in progress.
- `complete_task({ taskSlug, summary })` — Mark the current task as complete.
- `upsert_shared_document({ relativePath, description, readWhen })` — Register a
  document for agents in later workflow iterations to discover and read.
{allowAgentTaskAdd ? "- `add_task({ title, instructions, slug? })` — Append a new task if you discover necessary work." : ""}

## Shared Documents
{sharedDocuments.length > 0 ? documents list : "None registered."}

## Tasks
{task list with status, title, instructions, and failure feedback if present}
```

Key additions:
- Explicit MCP tool documentation with parameter schemas
- Clear protocol with numbered steps
- Consequence of not calling `complete_task` (workflow cannot progress)
- Task failure feedback surfaced in the prompt (when `failureMessage` is set)

**Input changes**: The function needs access to `failureMessage` from task states, and the `allowAgentTaskAdd` flag.

Updated signature:
```typescript
function buildIterationPrompt(input: {
  context: GraphWorkflowExecutionContextDefinition;
  tasks: GraphWorkflowTaskDefinition[];
  execution: GraphWorkflowExecution;
  sharedDocuments: GraphWorkflowSharedDocumentEntry[];
  allowAgentTaskAdd: boolean;
}): string
```

**Tests** (`iteration-orchestrator.test.ts`):
- RED: assert `buildIterationPrompt` output contains `"begin_task"` and `"complete_task"` tool documentation.
- GREEN: add tool docs.
- RED: assert output contains failure feedback when a task has `failureMessage` set.
- GREEN: add failure feedback rendering.
- RED: assert output omits `add_task` documentation when `allowAgentTaskAdd` is false.
- GREEN: conditional rendering.

Note: `buildIterationPrompt` is currently a module-private function. To test it directly, either export it or test it indirectly through `runIteration`. Prefer exporting it for unit testing clarity, since the prompt content is critical.

---

## Phase 3: Re-message on Incomplete Tasks

**Goal**: When an iteration ends without all tasks completed, send a follow-up message to the same conversation instead of immediately creating a new iteration. Only create a new iteration when context is exhausted or max follow-ups reached.

### Design

The re-messaging loop lives inside `runIteration` in the iteration orchestrator. After `runAgentIteration` completes, if tasks are still incomplete:

```
runIteration(input):
  1. Create conversation
  2. Mark task running, create tool server
  3. Run agent with initial prompt (runAgentIteration)
  4. Check remaining tasks
  5. While remainingTasks > 0 AND followUpCount < maxFollowUps AND !contextExhausted:
     a. Build follow-up reminder prompt
     b. Run agent again (same conversationId, same toolServer)
     c. Re-read execution state
     d. Check remaining tasks and context usage
     e. followUpCount++
  6. Close tool server
  7. Finalize and return
```

**Key behaviors**:
- Follow-ups happen within the same conversation — the agent retains full context
- The tool server stays alive across all follow-ups (closed in `finally` block)
- Context exhaustion threshold: `contextTokens / contextWindowMax > 0.85`
- Max follow-up attempts: configurable on the context definition, default 2
- Follow-ups don't count as separate iterations (no increment to `iterationCount`)

### Step 3.1: Extend runAgentIteration return type

**File**: `src/lib/workflows/graph-workflow/iteration-orchestrator.ts`

Change `runAgentIteration` dep from `Promise<void>` to `Promise<GraphWorkflowAgentIterationResult>`:
```typescript
interface GraphWorkflowAgentIterationResult {
  contextTokens: number | null;
  contextWindowMax: number | null;
}

interface GraphWorkflowIterationOrchestratorDeps {
  // ... existing ...
  runAgentIteration(input: GraphWorkflowRunAgentIterationInput): Promise<GraphWorkflowAgentIterationResult>;
}
```

**Test**: Update existing mock to return `{ contextTokens: null, contextWindowMax: null }`.

### Step 3.2: Build follow-up reminder prompt

**File**: `src/lib/workflows/graph-workflow/iteration-orchestrator.ts`

New function:
```typescript
function buildFollowUpPrompt(input: {
  tasks: GraphWorkflowTaskDefinition[];
  execution: GraphWorkflowExecution;
}): string
```

Content:
```
## Task Incomplete — Action Required

Your previous turn ended without completing all tasks. The workflow cannot advance
until you call the `complete_task` MCP tool for each finished task.

### Remaining tasks:
- {taskSlug} [{status}] {title}

### What to do:
1. If you already finished a task's work but forgot to call `complete_task`,
   call it now with a summary of what you did.
2. If the task is not yet done, call `begin_task` and continue the work.
3. Call `complete_task` when finished.
```

**Tests**:
- RED: assert `buildFollowUpPrompt` output lists remaining tasks by slug.
- GREEN: implement.
- RED: assert output includes reminder about `complete_task`.
- GREEN: implement.

### Step 3.3: Add context exhaustion check

**File**: `src/lib/workflows/graph-workflow/iteration-orchestrator.ts`

New pure function:
```typescript
const CONTEXT_EXHAUSTION_THRESHOLD = 0.85;

function isContextExhausted(
  contextTokens: number | null,
  contextWindowMax: number | null,
): boolean {
  if (contextTokens == null || contextWindowMax == null || contextWindowMax === 0) {
    return false; // Unknown — assume not exhausted, let max follow-ups be the guard
  }
  return contextTokens / contextWindowMax > CONTEXT_EXHAUSTION_THRESHOLD;
}
```

**Tests**:
- RED: `isContextExhausted(180_000, 200_000)` → `true` (90% > 85%)
- GREEN: implement.
- RED: `isContextExhausted(100_000, 200_000)` → `false` (50% < 85%)
- GREEN: already passes.
- RED: `isContextExhausted(null, null)` → `false` (unknown = not exhausted)
- GREEN: already passes.

### Step 3.4: Add follow-up loop to runIteration

**File**: `src/lib/workflows/graph-workflow/iteration-orchestrator.ts`

Modify `runIteration` to loop within the `try` block after the first `runAgentIteration` call:

```typescript
// After initial runAgentIteration (line 584):
let agentResult = await deps.runAgentIteration({ ... });

const maxFollowUps = 2; // TODO: make configurable per context
let followUpCount = 0;

while (followUpCount < maxFollowUps) {
  // Re-read execution state to check task status
  const currentExec = await requireExecution(input.projectPath, input.sessionName);
  const remaining = countRemainingTasks(currentExec, input.contextId);
  if (remaining === 0) break;

  // Check if current task was interrupted (agent stopped without completing)
  const currentTask = currentExec.activeTaskId
    ? currentExec.taskStates[currentExec.activeTaskId]
    : null;
  if (currentTask?.status !== "running") break; // Not interrupted mid-work

  // Check context exhaustion
  if (isContextExhausted(agentResult.contextTokens, agentResult.contextWindowMax)) break;

  // Build and send follow-up prompt
  const followUpPrompt = buildFollowUpPrompt({
    tasks: getContextTasks(currentExec, input.contextId).filter(
      (t) => currentExec.taskStates[t.id]?.status !== "completed",
    ),
    execution: currentExec,
  });

  agentResult = await deps.runAgentIteration({
    ...originalInput,
    prompt: followUpPrompt,
    conversationId: conversation.id, // Same conversation
  });
  followUpCount++;
}
```

**Tests** (`iteration-orchestrator.test.ts`):
- RED: when agent returns without completing task AND context not exhausted → `runAgentIteration` called a second time with the same `conversationId` and a follow-up prompt.
- GREEN: implement follow-up loop.
- RED: when agent returns without completing AND context IS exhausted → no follow-up, returns `shouldContinueInContext: true`.
- GREEN: add context exhaustion check.
- RED: when follow-up count reaches max → stops re-messaging, returns `shouldContinueInContext: true`.
- GREEN: add max follow-up guard.
- RED: when agent completes task on first try → no follow-up, proceeds normally.
- GREEN: already passes (remaining === 0, loop doesn't enter).

---

## Implementation Order

```
Phase 1 (prerequisite — tools must be wired first):
  1.1  runtime-state.ts          — add additionalMcpServers field
  1.2  prompt.ts                 — accept and set additionalMcpServers
  1.3  actor-implementations.ts  — merge into createQuerySession
  1.4  execution-route-handlers  — pass tool server through

Phase 2 (independent — can proceed in parallel with Phase 3):
  2.1  iteration-orchestrator.ts — rewrite buildIterationPrompt

Phase 3 (depends on Phase 1):
  3.1  iteration-orchestrator.ts — extend runAgentIteration return type
  3.2  iteration-orchestrator.ts — buildFollowUpPrompt function
  3.3  iteration-orchestrator.ts — isContextExhausted function
  3.4  iteration-orchestrator.ts — follow-up loop in runIteration
```

## Files Changed (Summary)

| File | Phase | Change |
|------|-------|--------|
| `src/lib/workflows/conversation/runtime-state.ts` | 1.1 | Add `additionalMcpServers` field |
| `src/lib/prompt.ts` | 1.2 | Accept MCP servers, set on runtime, return context tokens |
| `src/lib/workflows/conversation/actor-implementations.ts` | 1.3 | Merge additional servers in createQuerySession |
| `src/lib/workflow-graph/execution-route-handlers.ts` | 1.4 | Pass tool server via options |
| `src/lib/workflows/graph-workflow/iteration-orchestrator.ts` | 2.1, 3.1-3.4 | Prompt rewrite, follow-up loop, context check |

## Test Files Changed

| File | Tests Added |
|------|-------------|
| `src/lib/prompt.test.ts` | additionalMcpServers forwarding, context token return |
| `src/lib/workflows/conversation/actor-implementations.test.ts` | additionalMcpServers merge |
| `src/lib/workflow-graph/execution-route-handlers.test.ts` | tool server passed through |
| `src/lib/workflows/graph-workflow/iteration-orchestrator.test.ts` | prompt content, follow-up loop, context exhaustion, buildFollowUpPrompt |

## Risk Assessment

- **Phase 1** is the critical fix. Without it, Phases 2-3 are irrelevant since the agent can't see the tools.
- **Phase 2** is low risk — only changes prompt text, no behavioral changes.
- **Phase 3** changes the iteration lifecycle. Risk: the follow-up loop could stall if the agent responds but never calls `complete_task` despite having the tools. Mitigated by the max follow-up cap (default 2) and context exhaustion check.
- **QuerySession reuse** works in our favor for Phase 3: re-messaging uses the same QuerySession (MCP servers persist), so the tools remain available across follow-ups.
