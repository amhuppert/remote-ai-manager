# XState v5 Workflow Migration: Research & Architecture

**Date**: 2026-03-03
**Objective**: Migrate all CC workflows to XState v5, establishing a standard pattern for current and future workflows. XState on both server (orchestration) and client (replacing Zustand workflow stores).

---

## Table of Contents

1. [Current Workflow Inventory](#1-current-workflow-inventory)
2. [XState v5 Fundamentals for CC](#2-xstate-v5-fundamentals-for-cc)
3. [Server-Side Architecture](#3-server-side-architecture)
4. [Client-Side Architecture](#4-client-side-architecture)
5. [Persistence Strategy](#5-persistence-strategy)
6. [Migration Path per Workflow](#6-migration-path-per-workflow)
7. [Standard Workflow Pattern](#7-standard-workflow-pattern)
8. [Risks & Mitigations](#8-risks--mitigations)
9. [Recommendation](#9-recommendation)

---

## 1. Current Workflow Inventory

### 1.1 Ralph Loop

**Complexity**: High (~2000 lines across 10 modules)
**Location**: `src/lib/ralph-loop/`

**State lifecycle**:
```
planning → running → completed | halted | aborted
                   ↕ paused
```

**Sub-machines embedded implicitly**:
- Circuit breaker: `closed → half_open → open`
- Fix plan task lifecycle: `pending → in_progress → completed | skipped`
- Iteration lifecycle: per-iteration conversation with own status (`completed | error | timeout | aborted | context_limit`)

**Cross-cutting concerns**:
- Fire-and-forget dispatch from API route
- In-memory orchestrator registry (globalThis) with AbortController + pause flag
- SSE broadcast on every state transition (4 event types)
- Per-workflow NDJSON stream for live content
- State persistence via `mutateSession()` → `state.json`
- Claude Agent SDK integration with custom MCP tools per iteration
- Session lock acquisition, query semaphore
- Context budget management (soft/hard token limits)

**Key design decisions already aligned with XState**:
- Pure function modules (circuit-breaker, exit-detector, fix-plan-manager, progress-detector) have zero side effects — ideal as guards and actions
- Exit conditions are priority-ordered checks — map to guards on transitions
- Circuit breaker is already a state machine

### 1.2 Smart Merge

**Complexity**: Medium (~700 lines)
**Location**: `src/lib/background-jobs.ts`

**State lifecycle**:
```
running → completed | failed | conflicts
```

**Multi-phase pipeline** (phases tracked but not modeled as states):
1. Commit uncommitted changes (conditional)
2. Merge main into feature branch
3. Resolve conflicts (conditional, if autoResolve)
4. Pre-merge validation
5. Fix validation errors (conditional, if autoResolve)
6. Re-validate (one retry)
7. Squash merge + archive session

**Cross-cutting concerns**:
- Fire-and-forget dispatch
- In-memory job registry (globalThis)
- SSE broadcast (`job-status`)
- SQLite persistence for job records + notifications
- Session lock + project lock (with 30s retry)
- Stale job recovery (10-minute timeout)

**Key observation**: The multi-phase pipeline is currently a linear imperative flow with nested conditionals. Modeling as a state machine would make the branching explicit (e.g., `merging` → `conflicts_detected` → `resolving` vs. `merging` → `validating`).

### 1.3 Optimistic Sessions

**Complexity**: Low (~80 lines)
**Location**: `src/lib/optimistic.ts`

**State lifecycle**:
```
executing_prompt → dispatching_merge → (merge workflow lifecycle)
```

**Essentially**: Fire-and-forget chain of prompt execution → merge dispatch. On prompt failure, creates a notification. On success, dispatches a merge job with `autoResolve: true`.

**Key observation**: This is a simple sequential pipeline. As an XState machine, it would be ~30 lines with 3-4 states.

### 1.4 Focus Sessions

**Complexity**: Low (spread across 4 files)
**Location**: `src/lib/sessions.ts`, `src/lib/prompt-templates.ts`, `src/lib/conversations.ts`, API routes

**State lifecycle**:
```
initialization → researching → confirming_understanding → writing_focus_doc → finalized
```

**Key observation**: Not really a background workflow — it's a UI-driven multi-step process where the user interacts with Claude during initialization. The "workflow" is the initialization conversation lifecycle, which ends when the user finalizes.

### 1.5 Cross-Cutting Patterns (Current)

| Pattern | Implementation | XState Equivalent |
|---------|---------------|-------------------|
| Fire-and-forget dispatch | Un-awaited promises | `createActor(machine).start()` |
| In-memory registries | `globalThis.__cc_*` Maps | Actor system with `systemId` |
| SSE broadcast | `broadcast()` calls in imperative code | Actions in state transitions or inspect API |
| State persistence | `mutateSession()` → atomic JSON write | `getPersistedSnapshot()` on subscribe |
| Locking | `acquireSessionLock()` / `acquireProjectLock()` | Guards or invoked lock-acquisition actors |
| Error isolation | try/catch/finally | `onError` transitions, error states |
| Startup recovery | `recoverStaleWorkflows()` / `recoverStaleConversations()` | Restore from persisted snapshot (already in correct state) |

---

## 2. XState v5 Fundamentals for CC

### 2.1 Core Concepts

**Actor model**: Actors are independent entities that process events sequentially from a mailbox. No concurrent state mutations within an actor — this directly solves the race condition risks in the current imperative code.

**State machines**: Declarative definitions of states, transitions, guards, and actions. Created via `setup()` + `createMachine()`.

**Actor logic creators**: Not everything needs a state machine:
- `createMachine()` — complex state logic (workflows)
- `fromPromise()` — async operations (SDK queries, git operations)
- `fromCallback()` — event sources (SSE connections, file watchers)
- `fromTransition()` — reducer-style logic (simple stores)

**Actor systems**: Root actor creates a system. Child actors (invoked or spawned) belong to the same system. `systemId` enables cross-actor communication without parent-child coupling.

### 2.2 Key APIs

```typescript
// Define a machine with full type inference
const workflowMachine = setup({
  types: {
    context: {} as WorkflowContext,
    events: {} as WorkflowEvent,
    input: {} as WorkflowInput,
  },
  actors: {
    runIteration: fromPromise(async ({ input }) => { /* ... */ }),
  },
  guards: {
    isPlanComplete: ({ context }) => /* ... */,
    isCircuitBreakerOpen: ({ context }) => /* ... */,
  },
  actions: {
    broadcastStatus: ({ context }) => { /* SSE broadcast */ },
    persistState: ({ context, self }) => { /* save snapshot */ },
  },
}).createMachine({
  id: 'ralphLoop',
  initial: 'planning',
  context: ({ input }) => ({ /* initial context from input */ }),
  states: {
    planning: { /* ... */ },
    running: { /* ... */ },
    paused: { /* ... */ },
    completed: { type: 'final' },
    halted: { type: 'final' },
    aborted: { type: 'final' },
  },
});

// Create and start an actor
const actor = createActor(workflowMachine, {
  input: { objective, config },
});
actor.start();

// Send events
actor.send({ type: 'CONFIRM_PLAN' });
actor.send({ type: 'PAUSE' });

// Subscribe to state changes
actor.subscribe((snapshot) => {
  console.log(snapshot.value); // current state
  console.log(snapshot.context); // current context
});

// Persist
const persisted = actor.getPersistedSnapshot();
// Later: restore
const restored = createActor(workflowMachine, { snapshot: persisted });
```

### 2.3 Key Properties

- **Zero dependencies**, ~17 kB minified+gzipped
- **Environment-agnostic** — works on Node, Bun, Deno, browser
- **Sequential event processing** — no concurrent mutations within an actor
- **First-class persistence** — `getPersistedSnapshot()` / restore from snapshot
- **Inspect API** — runtime observability hook for debugging and monitoring
- **TypeScript-first** — full type inference via `setup()`

---

## 3. Server-Side Architecture

### 3.1 Actor System Design

Replace the current `globalThis` registries with a single actor system:

```
Root Actor (CC Orchestrator)
├── Ralph Loop Actor (per active workflow)
│   ├── Circuit Breaker Actor (invoked)
│   ├── Iteration Actor (invoked per iteration, fromPromise)
│   └── Plan Generator Actor (invoked, fromPromise)
├── Merge Job Actor (per active merge)
│   ├── Conflict Resolution Actor (invoked, fromPromise)
│   └── Validation Actor (invoked, fromPromise)
├── Optimistic Session Actor (per active optimistic session)
│   ├── Prompt Execution Actor (invoked, fromPromise)
│   └── Merge Dispatch Actor (invoked, fromPromise)
└── Focus Session Actor (per active focus initialization)
    ├── Research Phase Actor (invoked)
    └── Focus Doc Writer Actor (invoked, fromPromise)
```

**Root actor responsibilities**:
- Spawn/track workflow actors by session key (`projectPath::sessionName`)
- Route events from API routes to the correct child actor
- Handle persistence (subscribe to children, debounce writes)
- Replace all `globalThis` registries

**Benefits over current approach**:
- Single source of truth for all active workflows
- Actor system handles lifecycle (start, stop, cleanup)
- `systemId` enables cross-workflow communication
- Inspect API provides unified observability

### 3.2 API Route Integration

Current pattern (imperative):
```typescript
// POST /api/projects/[name]/sessions/[session]/workflow
export async function POST(req, { params }) {
  const { action } = await req.json();
  if (action === 'start') {
    startOrchestrator(projectPath, sessionName); // fire-and-forget
    return Response.json({ status: 'started' });
  }
}
```

XState pattern (event-driven):
```typescript
// POST /api/projects/[name]/sessions/[session]/workflow
export async function POST(req, { params }) {
  const { action } = await req.json();
  const rootActor = getRootActor();
  rootActor.send({
    type: 'WORKFLOW_ACTION',
    projectPath,
    sessionName,
    action, // 'start' | 'pause' | 'resume' | 'abort'
  });
  return Response.json({ status: 'accepted' });
}
```

The root actor handles spawning/routing. API routes become thin event dispatchers.

### 3.3 SSE Broadcasting

Two approaches, not mutually exclusive:

**Approach A: Actions on transitions** (explicit, recommended for most cases)
```typescript
states: {
  running: {
    entry: [
      { type: 'broadcastStatus', params: { status: 'running' } },
      { type: 'persistSnapshot' },
    ],
    // ...
  },
}
```

**Approach B: Inspect API** (automatic, good for debugging/logging)
```typescript
const actor = createActor(workflowMachine, {
  inspect: (inspectionEvent) => {
    if (inspectionEvent.type === '@xstate.snapshot') {
      // Auto-broadcast every state change
      broadcast({
        type: 'workflow-status',
        data: deriveStatusFromSnapshot(inspectionEvent.snapshot),
      });
    }
  },
});
```

**Recommendation**: Use explicit actions for SSE broadcasts (Approach A). The inspect API is better suited for debug logging. Explicit actions make it clear in the machine definition exactly when broadcasts happen.

### 3.4 Locking Integration

Session locks and project locks are external resources. Model them as invoked actors:

```typescript
const acquireLockActor = fromPromise(async ({ input }) => {
  const release = await acquireSessionLock(input.sessionName);
  return release; // stored in context, called in exit action
});

// In the machine:
states: {
  acquiringLock: {
    invoke: {
      src: 'acquireLock',
      input: ({ context }) => ({ sessionName: context.sessionName }),
      onDone: {
        target: 'executing',
        actions: assign({ releaseLock: ({ event }) => event.output }),
      },
      onError: 'lockFailed',
    },
  },
}
```

**Important**: Lock release functions are not serializable. They must be stored outside context (in an external map keyed by actor ID) or reconstructed on restore.

### 3.5 Non-Serializable State

The current code has several non-serializable runtime objects:
- `AbortController` instances
- Lock release functions
- SSE stream controllers
- SDK query handles

**Strategy**: Keep non-serializable state in an external `RuntimeState` map keyed by actor ID:

```typescript
// runtime-state.ts
const runtimeState = new Map<string, {
  abortController?: AbortController;
  releaseLock?: () => void;
  streamController?: ReadableStreamDefaultController;
}>();

// In XState actions:
actions: {
  createAbortController: ({ self }) => {
    runtimeState.set(self.id, {
      ...runtimeState.get(self.id),
      abortController: new AbortController(),
    });
  },
  abort: ({ self }) => {
    runtimeState.get(self.id)?.abortController?.abort();
  },
}
```

On restore from snapshot, runtime state is reconstructed as needed (e.g., new AbortController created when entering `running`).

---

## 4. Client-Side Architecture

### 4.1 Current State

CC uses Zustand + Immer stores for client state:
- `workflow.store.ts` — tracks `TrackedWorkflow` objects per session, processes SSE events
- `notification.store.ts` — toast queue, running jobs
- `sessions.store.ts` — UI state (modals, toggles)
- `unified-panel.store.ts` — side panel state

SSE events arrive via `NotificationListener` component → dispatched to stores.

### 4.2 XState Migration Strategy

Not all stores need full state machines. Use the right tool for each:

| Store | Complexity | Recommendation |
|-------|-----------|----------------|
| `workflow.store.ts` | High (SSE-driven state transitions) | Full XState machine |
| `notification.store.ts` | Medium (toast queue, job tracking) | `@xstate/store` or full machine |
| `sessions.store.ts` | Low (UI toggles) | Keep Zustand or `@xstate/store` |
| `unified-panel.store.ts` | Low (UI state) | Keep Zustand or `@xstate/store` |

**`@xstate/store`**: A <1 kB event-driven store from the XState team. Drop-in Zustand replacement with XState-compatible APIs. Good migration stepping stone for simple stores.

### 4.3 Workflow Store as XState Machine

The workflow store is the primary migration target. It processes SSE events and maintains per-session workflow state:

```typescript
// Client-side workflow machine (mirrors server-side states)
const clientWorkflowMachine = setup({
  types: {
    context: {} as {
      status: WorkflowStatus;
      iterationCount: number;
      maxIterations: number;
      taskProgress: TaskProgress;
      haltReason: HaltReason | null;
      fixPlan: FixPlanTask[] | null;
      circuitBreaker: CircuitBreakerState | null;
      latestIteration: RalphLoopIterationMeta | null;
    },
    events: {} as
      | { type: 'SSE_STATUS'; data: WorkflowStatusEvent }
      | { type: 'SSE_ITERATION_COMPLETE'; data: IterationCompleteEvent }
      | { type: 'SSE_FIX_PLAN_UPDATED'; data: FixPlanUpdatedEvent }
      | { type: 'SSE_CIRCUIT_BREAKER'; data: CircuitBreakerEvent },
  },
}).createMachine({
  id: 'clientWorkflow',
  initial: 'active',
  context: { /* initial */ },
  states: {
    active: {
      on: {
        SSE_STATUS: {
          actions: assign(({ event }) => ({
            status: event.data.status,
            // ... map other fields
          })),
        },
        SSE_ITERATION_COMPLETE: {
          actions: assign(({ context, event }) => ({
            latestIteration: event.data,
            iterationCount: context.iterationCount + 1,
          })),
        },
        SSE_FIX_PLAN_UPDATED: {
          actions: assign({ fixPlan: ({ event }) => event.data.fixPlan }),
        },
        SSE_CIRCUIT_BREAKER: {
          actions: assign({ circuitBreaker: ({ event }) => event.data }),
        },
      },
    },
  },
});
```

### 4.4 SSE Connection as XState Actor

Replace `NotificationListener` component with an SSE connection state machine:

```typescript
const sseConnectionMachine = setup({
  types: {
    context: {} as { reconnectAttempts: number },
    events: {} as
      | { type: 'CONNECT' }
      | { type: 'DISCONNECT' }
      | { type: 'SSE_CONNECTED' }
      | { type: 'SSE_DISCONNECTED' }
      | { type: 'SSE_ERROR' }
      | SSEEventTypes, // all domain SSE events
  },
  actors: {
    sseSource: fromCallback(({ sendBack }) => {
      const es = new EventSource('/api/events');
      es.onopen = () => sendBack({ type: 'SSE_CONNECTED' });
      es.onerror = () => sendBack({ type: 'SSE_DISCONNECTED' });
      // Register all event type listeners, parse, sendBack
      return () => es.close();
    }),
  },
}).createMachine({
  id: 'sseConnection',
  initial: 'disconnected',
  context: { reconnectAttempts: 0 },
  states: {
    disconnected: {
      on: { CONNECT: 'connecting' },
    },
    connecting: {
      invoke: { src: 'sseSource' },
      on: {
        SSE_CONNECTED: { target: 'connected', actions: assign({ reconnectAttempts: 0 }) },
        SSE_ERROR: 'reconnecting',
      },
    },
    connected: {
      invoke: { src: 'sseSource' },
      on: {
        SSE_DISCONNECTED: 'reconnecting',
        DISCONNECT: 'disconnected',
        // Forward all domain events to parent/subscribers
        '*': { actions: emit(({ event }) => event) },
      },
    },
    reconnecting: {
      entry: assign({ reconnectAttempts: ({ context }) => context.reconnectAttempts + 1 }),
      after: {
        RECONNECT_DELAY: 'connecting',
      },
    },
  },
  delays: {
    RECONNECT_DELAY: ({ context }) => Math.min(1000 * 2 ** context.reconnectAttempts, 30000),
  },
});
```

### 4.5 React Integration

**Package**: `@xstate/react` provides `useMachine`, `useActor`, `useActorRef`, `useSelector`, `createActorContext`.

**Key pattern**: `useActorRef` + `useSelector` for performance (avoids re-rendering on every state change):

```typescript
"use client";
import { useSelector } from '@xstate/react';
import { workflowActor } from './workflow-actor';

function WorkflowStatus({ actorRef }) {
  // Only re-renders when status changes
  const status = useSelector(actorRef, (s) => s.context.status);
  const progress = useSelector(actorRef, (s) => s.context.taskProgress);
  return <div>Status: {status}, Tasks: {progress.completed}/{progress.total}</div>;
}
```

**Next.js App Router constraint**: XState actors require `"use client"`. Pattern: Server Components fetch data, pass as props to Client Components that create/use actors.

```typescript
// Provider near root layout (client component)
"use client";
import { createActorContext } from '@xstate/react';
import { appMachine } from './app-machine';

export const AppContext = createActorContext(appMachine);

export function AppProvider({ children }) {
  return <AppContext.Provider>{children}</AppContext.Provider>;
}
```

### 4.6 Client-Side Root Actor

A root client actor manages the SSE connection and routes events to per-workflow child machines:

```typescript
const clientAppMachine = setup({
  types: {
    context: {} as {
      workflows: Map<string, ActorRefFrom<typeof clientWorkflowMachine>>;
    },
  },
  actors: {
    sseConnection: sseConnectionMachine,
    clientWorkflow: clientWorkflowMachine,
  },
}).createMachine({
  id: 'clientApp',
  invoke: { src: 'sseConnection', id: 'sse', systemId: 'sse' },
  on: {
    // SSE events routed to per-workflow actors
    SSE_WORKFLOW_STATUS: {
      actions: ({ context, event }) => {
        const key = `${event.data.projectName}::${event.data.sessionName}`;
        const workflow = context.workflows.get(key);
        workflow?.send({ type: 'SSE_STATUS', data: event.data });
      },
    },
  },
});
```

---

## 5. Persistence Strategy

### 5.1 Snapshot Shape

`getPersistedSnapshot()` returns a plain JSON-serializable object:
```json
{
  "value": "running",
  "context": { "iterationCount": 3, "status": "running", "..." },
  "status": "active",
  "children": { "circuitBreaker": { "snapshot": { "..." }, "src": "circuitBreakerMachine" } },
  "historyValue": {}
}
```

Size is proportional to context data — typically a few hundred bytes to a few KB for workflow machines.

### 5.2 Where to Store

**Recommended**: Store XState snapshots inside the existing `state.json`, replacing the current `session.workflow` field:

```typescript
// Before (current):
session.workflow = {
  status: 'running',
  objective: '...',
  config: { maxIterations: 20 },
  fixPlan: [...],
  circuitBreakerState: { ... },
  iterationHistory: [...],
  // ... 15+ fields
};

// After (XState):
session.workflow = {
  snapshot: { /* XState persisted snapshot — includes all state */ },
  // Derived fields for quick access without deserializing machine:
  status: 'running',
  iterationCount: 3,
};
```

The snapshot IS the source of truth. Derived fields are projections written alongside for query convenience (listing sessions, showing status without restoring actors).

### 5.3 Persistence Frequency

- **Debounced subscribe** (250ms) as default — captures most transitions without write amplification
- **Explicit persist actions** on key transitions (iteration complete, terminal states) — guarantees critical checkpoints
- **Synchronous flush** on SIGTERM/SIGINT — prevent data loss on shutdown

```typescript
actor.subscribe((snapshot) => {
  debouncedPersist(sessionKey, actor.getPersistedSnapshot());
});

// In machine definition:
states: {
  completed: {
    type: 'final',
    entry: ['persistSnapshot'], // explicit, immediate
  },
}
```

### 5.4 Restore on Startup

Replace `recoverStaleWorkflows()` with snapshot restoration:

```typescript
// On server start:
for (const session of getAllSessions()) {
  if (session.workflow?.snapshot) {
    const snapshot = session.workflow.snapshot;
    if (snapshot.status === 'active') {
      // Actor was mid-execution when server died
      // Restore to the persisted state — entry actions don't replay
      const actor = createActor(workflowMachine, { snapshot });
      actor.start();
      // Actor resumes in the exact state it was in
      // Invocations restart (e.g., iteration re-runs from scratch)
    }
  }
}
```

**Key behaviors on restore**:
- Entry actions are NOT replayed (already executed)
- Invoked actors (fromPromise) ARE restarted (e.g., a running iteration re-executes)
- Delayed transitions restart timers from zero
- Spawned actors restore recursively

### 5.5 Schema Versioning

XState has no built-in migration. Strategy:

1. Add `_schemaVersion: number` to machine context
2. On restore, check version against current machine version
3. For compatible changes (added context fields, new states): migrate inline
4. For incompatible changes (removed states, restructured context): discard snapshot, start fresh with appropriate initial state

```typescript
function restoreWorkflow(persisted: PersistedSnapshot) {
  if (persisted.context._schemaVersion === CURRENT_VERSION) {
    return createActor(workflowMachine, { snapshot: persisted });
  }
  if (persisted.context._schemaVersion < CURRENT_VERSION) {
    const migrated = migrateSnapshot(persisted);
    return createActor(workflowMachine, { snapshot: migrated });
  }
  // Unknown version: start fresh in 'halted' state
  return createActor(workflowMachine, {
    input: { ...persisted.context, status: 'halted', haltReason: 'schema_migration' },
  });
}
```

### 5.6 Non-Serializable Data Strategy

Runtime-only state (AbortControllers, lock releases, stream controllers) cannot be persisted. Strategy:

| Data | Where it lives | On restore |
|------|---------------|------------|
| AbortController | External Map keyed by actor ID | Created fresh when entering `running` |
| Lock release fn | External Map keyed by actor ID | Re-acquired when entering a locked state |
| Stream controller | External Map keyed by actor ID | Created fresh when client reconnects |
| SDK query handle | Invoked actor (fromPromise) | Invocation restarts automatically |

---

## 6. Migration Path per Workflow

### 6.1 Ralph Loop

**Machine states**: `planning`, `generatingPlan`, `awaitingConfirmation`, `running` (with `running.acquiringLock`, `running.executing`, `running.evaluatingExit`), `paused`, `completed`, `halted`, `aborted`

**Nested machines**:
- Circuit breaker as a spawned/invoked child machine
- Each iteration as an invoked `fromPromise` actor

**Guards**: `isPlanComplete`, `isIterationCapReached`, `isCircuitBreakerOpen`, `isPermissionDenied`, `isTestSaturated`, `isStalledExitSignal`

**Actions**: `broadcastStatus`, `broadcastIterationComplete`, `broadcastFixPlanUpdated`, `broadcastCircuitBreaker`, `persistSnapshot`, `updateIterationHistory`, `updateFixPlan`, `updateCircuitBreaker`

**Invoked actors**: `runIteration` (fromPromise), `generatePlan` (fromPromise)

**Migration complexity**: High. This is the flagship workflow and will define the standard pattern. ~1-2 weeks of focused work.

### 6.2 Smart Merge

**Machine states**: `committingUncommitted`, `merging`, `conflictsDetected`, `resolvingConflicts`, `validating`, `fixingValidation`, `revalidating`, `acquiringProjectLock`, `squashMerging`, `completed`, `failed`, `conflicts`

**Guards**: `hasUncommittedChanges`, `shouldAutoResolve`, `hasConflicts`, `validationPassed`

**Actions**: `broadcastJobStatus`, `persistJobRecord`, `createNotification`, `markSessionFinished`

**Invoked actors**: `commitChanges`, `mergeMainIntoFeature`, `resolveConflicts`, `runPreMergeValidation`, `fixValidationErrors`, `squashMerge` (all fromPromise)

**Migration complexity**: Medium. The linear pipeline with conditional branches maps cleanly to a state machine. ~3-5 days.

### 6.3 Optimistic Sessions

**Machine states**: `executingPrompt`, `dispatchingMerge`, `completed`, `failed`

**Actions**: `createNotification`

**Invoked actors**: `executePrompt` (fromPromise), `dispatchMerge` (fromPromise — or send event to root actor to spawn a merge workflow)

**Migration complexity**: Low. ~1-2 days.

### 6.4 Focus Sessions

**Machine states**: `initialization`, `writingFocusDoc`, `finalized`

**Note**: This workflow is more UI-driven than the others. The state transitions are triggered by user actions (confirming understanding, finalizing). The XState machine primarily tracks which phase the initialization is in.

**Migration complexity**: Low. ~1-2 days.

---

## 7. Standard Workflow Pattern

### 7.1 File Organization

```
src/lib/workflows/
├── types.ts                    # Shared workflow types, base context
├── persistence.ts              # Snapshot persistence utilities
├── runtime-state.ts            # Non-serializable state registry
├── root-actor.ts               # Root actor system (singleton)
├── ralph-loop/
│   ├── machine.ts              # Ralph Loop state machine definition
│   ├── actors.ts               # Invoked actor definitions (fromPromise)
│   ├── guards.ts               # Guard functions
│   ├── actions.ts              # Action implementations
│   └── types.ts                # Ralph Loop specific types
├── merge/
│   ├── machine.ts
│   ├── actors.ts
│   ├── guards.ts
│   └── actions.ts
├── optimistic/
│   ├── machine.ts
│   └── actors.ts
└── focus/
    ├── machine.ts
    └── actors.ts
```

### 7.2 Machine Definition Convention

Every workflow machine follows the same structural pattern:

```typescript
// src/lib/workflows/{workflow}/machine.ts
import { setup, assign, sendTo, emit } from 'xstate';
import { actors } from './actors';
import { guards } from './guards';
import { actions } from './actions';
import type { WorkflowContext, WorkflowEvents } from './types';

export const workflowMachine = setup({
  types: {
    context: {} as WorkflowContext,
    events: {} as WorkflowEvents,
    input: {} as WorkflowInput,
  },
  actors,
  guards,
  actions,
}).createMachine({
  id: 'workflowName',
  initial: 'initialState',
  context: ({ input }) => ({
    _schemaVersion: 1,
    // ... derive from input
  }),
  states: {
    // ... explicit states with transitions
  },
});
```

### 7.3 Base Context

All workflow machines share a base context shape:

```typescript
interface BaseWorkflowContext {
  _schemaVersion: number;
  projectPath: string;
  sessionName: string;
  startedAt: string;   // ISO timestamp
  completedAt: string | null;
}
```

### 7.4 Standard Actions

Reusable actions shared across workflows:

```typescript
// Broadcast SSE event
const broadcastAction = (eventType: string) => ({ context, event }) => {
  broadcast({ type: eventType, data: deriveEventData(context) });
};

// Persist snapshot
const persistSnapshot = ({ self, context }) => {
  persistWorkflowSnapshot(context.projectPath, context.sessionName, self.getPersistedSnapshot());
};

// Create notification
const createNotificationAction = (template: NotificationTemplate) => ({ context }) => {
  createNotification(template(context));
};
```

---

## 8. Risks & Mitigations

### 8.1 Learning Curve

**Risk**: XState v5's actor model, statecharts, and TypeScript integration have a moderate learning curve.

**Mitigation**: Start with the simplest workflow (Optimistic) to build familiarity, then tackle Smart Merge, then Ralph Loop. Document patterns in steering files.

### 8.2 AI v4/v5 Confusion

**Risk**: Most AI training data covers XState v4. AI assistants frequently generate incorrect v4 syntax (`interpret()`, `send()`, `cond`, `services`).

**Mitigation**: Add XState v5 conventions to project steering. Include a reference file with correct v5 patterns and common v4→v5 renames.

### 8.3 Persistence Schema Evolution

**Risk**: Persisted snapshots break when machine definitions change. No built-in migration.

**Mitigation**: Version-tag all snapshots. For the initial migration, workflows in progress will be halted and restarted under the new system (acceptable for a one-time migration). Post-migration, use explicit version checks with migration functions.

### 8.4 Non-Serializable State

**Risk**: AbortControllers, lock release functions, and stream controllers cannot be persisted. Must be carefully managed outside XState context.

**Mitigation**: External runtime state map keyed by actor ID. Entry actions on stateful states create fresh runtime objects. Exit actions clean up. Document the pattern clearly.

### 8.5 Debugging Complexity

**Risk**: State machines can be harder to debug than imperative code when things go wrong.

**Mitigation**: XState's inspect API provides full event/transition tracing. Stately Studio can visualize machines. The existing `cc-debug.log` can be enriched with XState inspection events.

### 8.6 Migration Scope

**Risk**: Migrating all four workflows + client-side stores is a large effort.

**Mitigation**: Incremental migration. Each workflow can be migrated independently. Old and new systems can coexist during the transition. The root actor system is additive — it doesn't require removing existing registries until a workflow is fully migrated.

---

## 9. Recommendation

### 9.1 Migration Order

1. **Optimistic Sessions** (simplest) — Build the standard pattern, root actor system, and persistence layer. Validate the approach on a low-risk workflow.
2. **Focus Sessions** (simple, UI-driven) — Exercise the pattern with a slightly different workflow shape.
3. **Smart Merge** (medium) — The multi-phase pipeline benefits significantly from explicit states. Validates the pattern for background jobs.
4. **Ralph Loop** (complex) — The flagship migration. By this point, the standard pattern is battle-tested.

### 9.2 Client-Side Migration Order

1. **SSE connection machine** — Replace `NotificationListener` with the SSE connection state machine. This is foundational — all other client-side changes depend on it.
2. **Workflow store** — Replace `workflow.store.ts` with XState machines that receive SSE events.
3. **Other stores** — Evaluate each remaining store. Simple stores (sessions, panel) can stay Zustand or migrate to `@xstate/store` (no rush, low value).

### 9.3 What to Build First

Before migrating any workflow, build the infrastructure:

1. **Root actor system** (`root-actor.ts`) — Singleton, spawns/manages workflow actors
2. **Persistence layer** (`persistence.ts`) — Debounced writes, restore-on-startup, schema versioning
3. **Runtime state registry** (`runtime-state.ts`) — External map for non-serializable data
4. **Standard action library** — SSE broadcast, persistence, notification creation
5. **XState v5 steering doc** — Conventions, v4→v5 gotchas, patterns

### 9.4 Packages to Install

| Package | Purpose | Size |
|---------|---------|------|
| `xstate` | Core library | ~17 kB gzipped, zero deps |
| `@xstate/react` | React hooks (`useActor`, `useSelector`, `createActorContext`) | ~2 kB |
| `@xstate/store` | Lightweight event-driven stores (optional, for simple Zustand replacements) | <1 kB |

### 9.5 What NOT to Do

- **Don't migrate all workflows simultaneously** — incremental, one at a time
- **Don't migrate simple Zustand stores to full state machines** — use `@xstate/store` or leave as-is
- **Don't use `@statelyai/agent`** — immature, wrong abstraction layer for CC
- **Don't try to persist non-serializable state** — use the external runtime state pattern
- **Don't replicate server state on the client** — client machines are projections that receive SSE events, not full replicas of server machines
