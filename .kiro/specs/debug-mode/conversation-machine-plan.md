# Conversation Machine Implementation Plan

## Objective

Replace the ad-hoc conversation lifecycle in `src/lib/prompt.ts` with an XState v5 conversation machine that:

- owns `new -> awaiting -> running <-> waiting_for_input`
- integrates Debug Mode as a first-class compound workflow
- preserves current API behavior and SSE contracts
- supports recovery after restart or orphaned runtime state
- becomes the reusable prompt-execution primitive for future workflows

The migration should keep `executePromptStream()` as a compatibility facade initially, but move the real orchestration into `src/lib/workflows/conversation/`.

## Design Constraints

- Follow the existing XState v5 pattern already used in `src/lib/workflows/merge/`, `src/lib/workflows/optimistic/`, and `src/lib/workflows/ralph-loop/`
- Keep non-serializable resources in the runtime registry, not machine context
- Persist snapshots with debounced writes
- Use `.provide()` to inject production actors/actions and to stub them in tests
- Preserve the external conversation status enum: `"new" | "awaiting" | "running" | "waiting_for_input"`

## Proposed File Layout

```text
src/lib/workflows/
├── types.ts
├── setup.ts
├── runtime-state.ts
├── persistence.ts
├── actions.ts
├── utils.ts
└── conversation/
   ├── types.ts
   ├── debug-schema.ts
   ├── actors.ts
   ├── actor-implementations.ts
   ├── actions.ts
   ├── machine.ts
   ├── conversation-manager.ts
   ├── machine.test.ts
   ├── conversation-manager.test.ts
   └── debug-schema.test.ts
```

Supporting changes outside the workflow folder:

- `src/lib/prompt.ts`
- `src/lib/prompt-route-handlers.ts`
- `src/app/api/projects/[name]/sessions/[session]/prompt/route.ts`
- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/answer/route.ts`
- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/route.ts`
- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/recording/route.ts`
- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/logs/route.ts`
- `src/app/api/debug-logs/route.ts`
- `src/lib/state.ts`
- `src/lib/conversations.ts`
- `src/lib/schemas.ts`
- `src/types/index.ts`

## Machine Shape

Model the conversation machine as a parallel root so the lifecycle and debug workflow can evolve independently but still coordinate through shared context/events.

```text
conversationMachine (parallel)
|-- lifecycle
|   |-- new
|   |-- awaiting
|   |-- acquiring_session_lock
|   |-- acquiring_query_slot
|   |-- extracting_debug_plan
|   |-- ensuring_query_session
|   |-- running
|   |-- waiting_for_input
|   `-- finalizing_turn
`-- mode
    |-- normal
    `-- debug
        |-- idle
        |-- hypothesizing
        |-- awaiting_reproduction
        |-- analyzing
        |-- fixing
        `-- cleanup
```

### External Status Mapping

Keep the persisted `conversation.status` field derived from the lifecycle branch:

- `new` -> `lifecycle.new`
- `awaiting` -> `lifecycle.awaiting`
- `running` -> `lifecycle.acquiring_session_lock | acquiring_query_slot | extracting_debug_plan | ensuring_query_session | running | finalizing_turn`
- `waiting_for_input` -> `lifecycle.waiting_for_input`

This keeps API consumers stable while still giving the machine finer-grained internal states.

## TypeScript Contracts

### `src/lib/workflows/conversation/types.ts`

```ts
import type { BaseWorkflowContext } from "../types";
import type {
  AskQuestionItem,
  ClaudeModel,
  ConversationStatus,
  EffortLevel,
  ImagePayload,
  MessageContentBlock,
} from "@/types";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type ConversationDebugPhase =
  | "idle"
  | "hypothesizing"
  | "awaiting_reproduction"
  | "analyzing"
  | "fixing"
  | "cleanup";

export interface DebugHypothesis {
  id: `H${number}`;
  description: string;
  confidence: number;
}

export interface DebugInstrumentationStep {
  hypothesisId: `H${number}`;
  target: string;
  signal: string;
  logMessage: string;
}

export interface DebugPlan {
  hypotheses: DebugHypothesis[];
  reproductionSteps: string[];
  instrumentationPlan: DebugInstrumentationStep[];
}

export interface ConversationContext extends BaseWorkflowContext {
  conversationId: string;
  transcriptPath: string | null;
  claudeSessionId: string | null;
  status: ConversationStatus;
  promptCount: number;
  pendingPrompt:
    | {
        text: string;
        modelId?: ClaudeModel;
        effort?: EffortLevel;
        images?: ImagePayload[];
        autonomous?: boolean;
      }
    | null;
  pendingQuestion:
    | {
        questionId: string;
        questions: AskQuestionItem[];
      }
    | null;
  lastTurn:
    | {
        costUsd: number | null;
        durationMs: number | null;
        numTurns: number | null;
        contextTokens: number | null;
        contextWindow: number | null;
        contentBlocks: MessageContentBlock[];
        error: string | null;
        aborted: boolean;
      }
    | null;
  debugMode:
    | {
        active: boolean;
        recording: boolean;
        logFilePath: string;
        enteredAt: string;
        phase: ConversationDebugPhase;
        plan: DebugPlan | null;
        instructionsDelivered: boolean;
      }
    | null;
  error: string | null;
}

export interface ConversationInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
}

export type ConversationEvent =
  | {
      type: "SUBMIT_PROMPT";
      text: string;
      modelId?: ClaudeModel;
      effort?: EffortLevel;
      images?: ImagePayload[];
      autonomous?: boolean;
    }
  | { type: "SDK_MESSAGE_RECEIVED"; message: SDKMessage }
  | { type: "QUESTION_ASKED"; questionId: string; questions: AskQuestionItem[] }
  | {
      type: "ANSWER_PROVIDED";
      questionId: string;
      answers: Record<string, string>;
    }
  | { type: "TURN_COMPLETED"; output: RunPromptTurnOutput }
  | { type: "TURN_FAILED"; error: string; aborted: boolean }
  | { type: "ENTER_DEBUG_MODE" }
  | { type: "EXIT_DEBUG_MODE" }
  | { type: "SET_DEBUG_RECORDING"; recording: boolean }
  | { type: "DEBUG_PLAN_EXTRACTED"; plan: DebugPlan }
  | { type: "MARK_REPRODUCED" }
  | { type: "MARK_ANALYZED" }
  | { type: "MARK_FIX_PROPOSED" }
  | { type: "MARK_FIX_CONFIRMED" }
  | { type: "RESET_STALE"; reason: "startup" | "orphaned" }
  | { type: "ABORT" };

export interface ConversationOutput {
  status: ConversationStatus;
  conversationId: string;
  claudeSessionId: string | null;
  error: string | null;
}
```

## Actors

### `src/lib/workflows/conversation/actors.ts`

Use `fromPromise()` for bounded async steps and a single streaming actor for the active turn.

```ts
export interface AcquireSessionLockInput {
  projectPath: string;
  sessionName: string;
}
export interface AcquireSessionLockOutput {
  acquiredAt: string;
}

export interface AcquireQuerySlotInput {
  sessionName: string;
}
export interface AcquireQuerySlotOutput {
  acquiredAt: string;
}

export interface ExtractDebugPlanInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  promptText: string;
  transcriptPath: string | null;
  modelId?: ClaudeModel;
  effort?: EffortLevel;
}
export interface ExtractDebugPlanOutput {
  plan: DebugPlan;
}

export interface EnsureQuerySessionInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  modelId?: ClaudeModel;
  effort?: EffortLevel;
}
export interface EnsureQuerySessionOutput {
  claudeSessionId: string | null;
  reused: boolean;
}

export interface RunPromptTurnInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  text: string;
  modelId?: ClaudeModel;
  effort?: EffortLevel;
  images?: ImagePayload[];
  autonomous?: boolean;
  debugPlan?: DebugPlan | null;
}
export interface RunPromptTurnOutput {
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contentBlocks: MessageContentBlock[];
  error: string | null;
  aborted: boolean;
}
```

Recommended actor set:

- `acquireSessionLock`
- `acquireQuerySlot`
- `extractDebugPlan`
- `ensureQuerySession`
- `runPromptTurn`
- `releaseRuntimeResources` as a helper invoked from actions, not a machine actor

### Actor Implementation Notes

- `acquireSessionLock` wraps `acquireSessionLock()` from `src/lib/lock.ts` and stores the release function in runtime state
- `acquireQuerySlot` wraps `acquireQuerySlot()` from `src/lib/query-semaphore.ts` and stores the release function in runtime state
- `extractDebugPlan` uses the SDK with `outputFormat: { type: "json_schema", schema: DEBUG_HYPOTHESIS_EXTRACTION_JSON_SCHEMA }`
- `ensureQuerySession` wraps current get-or-create logic from `prompt.ts` and `query-session-registry.ts`
- `runPromptTurn` reuses the current QuerySession turn mechanics, but emits domain events back into the machine instead of mutating state directly

## Guards

### `src/lib/workflows/conversation/machine.ts`

```ts
guards: {
  hasPendingPrompt: ({ context }) => context.pendingPrompt !== null,
  debugModeActive: ({ context }) => context.debugMode?.active === true,
  needsDebugPlan: ({ context }) =>
    context.debugMode?.active === true && context.debugMode.plan === null,
  hasPendingQuestion: ({ context }) => context.pendingQuestion !== null,
  answerMatchesPendingQuestion: ({ context, event }) =>
    event.type === "ANSWER_PROVIDED" &&
    event.questionId === context.pendingQuestion?.questionId,
  canExitDebugCleanup: ({ context }) =>
    context.debugMode?.phase === "cleanup",
}
```

Additional guard worth adding in production:

- `sessionCanRunPrompt`: recheck session/conversation archival/finished flags before starting execution

## Actions

### `src/lib/workflows/conversation/actions.ts`

Use named actions so `.provide()` can swap production and test implementations.

Recommended action names:

- `syncConversationProjection`
- `broadcastConversationStatus`
- `broadcastDebugStatus`
- `broadcastPromptChunk`
- `appendTranscriptEntry`
- `storePendingQuestion`
- `clearPendingQuestion`
- `storeDebugPlan`
- `recordTurnMetrics`
- `clearTurnError`
- `releaseRuntimeResources`
- `persistSnapshot`
- `onTerminal`

Key responsibilities:

1. `syncConversationProjection`
   - project the machine context back into persisted `ConversationState`
   - own all changes to `status`, `claudeSessionId`, `promptCount`, `pendingQuestionId`, `pendingQuestions`, `totalCostUsd`, `totalDurationMs`, `totalTurns`, `contextTokens`, `contextWindowMax`, `debugMode`

2. `broadcastConversationStatus`
   - broadcast only when derived external status changes
   - keep current `conversation-status` SSE payload unchanged

3. `broadcastDebugStatus`
   - continue existing `debug-mode-status` SSE contract
   - optionally add `phase` later behind a backward-compatible schema extension

4. `appendTranscriptEntry`
   - keep transcript writes outside the machine context
   - append user/assistant/tool events based on `SDK_MESSAGE_RECEIVED`

5. `releaseRuntimeResources`
   - release session lock
   - release semaphore slot
   - reject unresolved question waiters
   - unregister abort controller
   - never leave cleanup in `finally` blocks spread across prompt code again

## Structured Debug Output Schema

### `src/lib/workflows/conversation/debug-schema.ts`

Keep both a Zod validator and the JSON Schema literal used by the SDK.

```ts
import { z } from "zod";

export const debugHypothesisExtractionSchema = z.object({
  hypotheses: z
    .array(
      z.object({
        id: z.string().regex(/^H[1-9][0-9]*$/),
        description: z.string().min(1),
        confidence: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(5),
  reproduction_steps: z.array(z.string().min(1)).min(1),
  instrumentation_plan: z.array(
    z.object({
      hypothesis_id: z.string().regex(/^H[1-9][0-9]*$/),
      target: z.string().min(1),
      signal: z.string().min(1),
      log_message: z.string().min(1),
    }),
  ),
});

export type DebugHypothesisExtraction = z.infer<
  typeof debugHypothesisExtractionSchema
>;

export const DEBUG_HYPOTHESIS_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hypotheses", "reproduction_steps", "instrumentation_plan"],
  properties: {
    hypotheses: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "confidence"],
        properties: {
          id: { type: "string", pattern: "^H[1-9][0-9]*$" },
          description: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    reproduction_steps: {
      type: "array",
      items: { type: "string" },
    },
    instrumentation_plan: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hypothesis_id", "target", "signal", "log_message"],
        properties: {
          hypothesis_id: { type: "string", pattern: "^H[1-9][0-9]*$" },
          target: { type: "string" },
          signal: { type: "string" },
          log_message: { type: "string" },
        },
      },
    },
  },
} as const;

export const DEBUG_HYPOTHESIS_OUTPUT_FORMAT = {
  type: "json_schema" as const,
  name: "debug_hypothesis_extraction",
  schema: DEBUG_HYPOTHESIS_EXTRACTION_JSON_SCHEMA,
};
```

### Debug Flow

1. User enters debug mode
2. Next `SUBMIT_PROMPT` stores the prompt in `pendingPrompt`
3. `lifecycle.extracting_debug_plan` invokes `extractDebugPlan`
4. Machine receives `DEBUG_PLAN_EXTRACTED`
5. `mode.debug` transitions `idle -> hypothesizing -> awaiting_reproduction`
6. The main prompt turn receives the structured plan as input so the assistant can instrument and present the same plan to the user
7. User actions drive `awaiting_reproduction -> analyzing -> fixing -> cleanup`

The key shift is that hypothesis extraction becomes structured machine state, not regex/parsing over assistant prose.

## Machine Definition

### `src/lib/workflows/conversation/machine.ts`

```ts
import { assign } from "xstate";
import { createWorkflowSetup } from "../setup";
import type {
  ConversationContext,
  ConversationEvent,
  ConversationInput,
  ConversationOutput,
} from "./types";

const SCHEMA_VERSION = 1;

const s = createWorkflowSetup<
  ConversationContext,
  ConversationEvent,
  ConversationInput,
  ConversationOutput
>({
  actors: {
    acquireSessionLock,
    acquireQuerySlot,
    extractDebugPlan,
    ensureQuerySession,
    runPromptTurn,
  },
  guards: { ... },
  actions: { ... },
});

export const conversationMachine = s.createMachine({
  id: "conversation",
  type: "parallel",
  context: ({ input }) => ({
    _schemaVersion: SCHEMA_VERSION,
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionName: input.sessionName,
    conversationId: input.conversationId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    transcriptPath: null,
    claudeSessionId: null,
    status: "new",
    promptCount: 0,
    pendingPrompt: null,
    pendingQuestion: null,
    lastTurn: null,
    debugMode: null,
    error: null,
  }),
  states: {
    lifecycle: {
      initial: "new",
      states: {
        new: {
          always: { target: "awaiting", actions: "syncConversationProjection" },
        },
        awaiting: {
          on: {
            SUBMIT_PROMPT: {
              target: "acquiring_session_lock",
              actions: assign({
                pendingPrompt: ({ event }) => ({
                  text: event.text,
                  modelId: event.modelId,
                  effort: event.effort,
                  images: event.images ?? [],
                  autonomous: event.autonomous,
                }),
                error: () => null,
              }),
            },
            RESET_STALE: {
              actions: "syncConversationProjection",
            },
          },
        },
        acquiring_session_lock: {
          entry: ["syncConversationProjection", "broadcastConversationStatus"],
          invoke: {
            src: "acquireSessionLock",
            input: ({ context }) => ({
              projectPath: context.projectPath,
              sessionName: context.sessionName,
            }),
            onDone: "acquiring_query_slot",
            onError: {
              target: "awaiting",
              actions: assign({
                error: ({ event }) => String(event.error),
              }),
            },
          },
        },
        acquiring_query_slot: { ... },
        extracting_debug_plan: { ... },
        ensuring_query_session: { ... },
        running: {
          invoke: {
            src: "runPromptTurn",
            input: ({ context }) => ({
              projectPath: context.projectPath,
              sessionName: context.sessionName,
              conversationId: context.conversationId,
              text: context.pendingPrompt!.text,
              modelId: context.pendingPrompt?.modelId,
              effort: context.pendingPrompt?.effort,
              images: context.pendingPrompt?.images,
              autonomous: context.pendingPrompt?.autonomous,
              debugPlan: context.debugMode?.plan ?? null,
            }),
            onDone: {
              target: "finalizing_turn",
              actions: assign({
                lastTurn: ({ event }) => ({
                  costUsd: event.output.costUsd,
                  durationMs: event.output.durationMs,
                  numTurns: event.output.numTurns,
                  contextTokens: event.output.contextTokens,
                  contextWindow: event.output.contextWindow,
                  contentBlocks: event.output.contentBlocks,
                  error: event.output.error,
                  aborted: event.output.aborted,
                }),
                claudeSessionId: ({ event }) => event.output.sessionId,
              }),
            },
            onError: {
              target: "finalizing_turn",
              actions: assign({
                error: ({ event }) => String(event.error),
              }),
            },
          },
          on: {
            QUESTION_ASKED: {
              target: "waiting_for_input",
              actions: "storePendingQuestion",
            },
            SDK_MESSAGE_RECEIVED: {
              actions: ["appendTranscriptEntry", "broadcastPromptChunk"],
            },
          },
        },
        waiting_for_input: {
          entry: ["syncConversationProjection", "broadcastConversationStatus"],
          on: {
            ANSWER_PROVIDED: {
              guard: "answerMatchesPendingQuestion",
              target: "running",
              actions: "clearPendingQuestion",
            },
            ABORT: {
              target: "finalizing_turn",
              actions: assign({ error: () => "Conversation aborted" }),
            },
          },
        },
        finalizing_turn: {
          entry: [
            "recordTurnMetrics",
            "releaseRuntimeResources",
            "syncConversationProjection",
            "broadcastConversationStatus",
            "persistSnapshot",
          ],
          always: {
            target: "awaiting",
            actions: assign({
              pendingPrompt: () => null,
            }),
          },
        },
      },
    },
    mode: {
      initial: "normal",
      states: {
        normal: {
          on: { ENTER_DEBUG_MODE: "debug" },
        },
        debug: {
          initial: "idle",
          entry: ["syncConversationProjection", "broadcastDebugStatus"],
          exit: ["syncConversationProjection", "broadcastDebugStatus"],
          on: {
            EXIT_DEBUG_MODE: "normal",
            SET_DEBUG_RECORDING: {
              actions: "syncConversationProjection",
            },
          },
          states: {
            idle: {
              on: {
                DEBUG_PLAN_EXTRACTED: {
                  target: "awaiting_reproduction",
                  actions: "storeDebugPlan",
                },
              },
            },
            hypothesizing: {},
            awaiting_reproduction: {
              on: {
                MARK_REPRODUCED: "analyzing",
              },
            },
            analyzing: {
              on: {
                MARK_ANALYZED: "fixing",
              },
            },
            fixing: {
              on: {
                MARK_FIX_PROPOSED: "cleanup",
              },
            },
            cleanup: {
              on: {
                MARK_FIX_CONFIRMED: "#conversation.mode.normal",
              },
            },
          },
        },
      },
    },
  },
  output: ({ context }) => ({
    status: context.status,
    conversationId: context.conversationId,
    claudeSessionId: context.claudeSessionId,
    error: context.error,
  }),
});
```

## Mapping `executePromptStream()` Responsibilities to XState

| Current responsibility | New XState owner |
| --- | --- |
| Acquire session lock | `lifecycle.acquiring_session_lock` invoke `acquireSessionLock` actor |
| Acquire query slot | `lifecycle.acquiring_query_slot` invoke `acquireQuerySlot` actor |
| Set `"running"` and broadcast SSE | `entry` actions on lock/slot/run states via derived status projection |
| Create/reuse QuerySession | `lifecycle.ensuring_query_session` invoke `ensureQuerySession` actor |
| Send prompt via `querySession.sendPrompt()` | `lifecycle.running` invoke `runPromptTurn` actor |
| Process SDK messages | `SDK_MESSAGE_RECEIVED` event handled by `appendTranscriptEntry` + `broadcastPromptChunk` actions |
| Intercept `AskUserQuestion` | `QUESTION_ASKED` event transitions `running -> waiting_for_input`; pending answer resolver stored in runtime state |
| Update metadata on completion | `recordTurnMetrics` action in `lifecycle.finalizing_turn` |
| Release lock/slot, set awaiting, broadcast, notify | `releaseRuntimeResources`, `syncConversationProjection`, `broadcastConversationStatus`, optional `onTerminal` style action during `finalizing_turn` |

## Runtime State Integration

Extend the shared runtime registry pattern for conversation-specific non-serializable state.

### `src/lib/workflows/runtime-state.ts`

Add a dedicated conversation helper instead of overloading session workflow keys:

```ts
export interface ConversationRuntimeState extends RuntimeState {
  releaseSessionLock?: () => void;
  releaseQuerySlot?: () => void;
  pendingQuestionResolver?: {
    questionId: string;
    resolve: (answers: Record<string, string>) => void;
    reject: (error: Error) => void;
  };
}

export function conversationWorkflowKey(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): string {
  return `${projectPath}::${sessionName}::${conversationId}`;
}
```

Do not store these in machine context:

- release closures
- `AbortController`
- answer resolver promises
- live `QuerySession`

Keep `QuerySession` itself in `query-session-registry.ts`, but let the manager own the linkage between machine actor and registry entry.

## Snapshot Persistence

Create a conversation-specific persistence helper parallel to workflow persistence:

- `persistConversationSnapshot(projectPath, sessionName, conversationId, snapshot)`
- `restoreConversationSnapshot(projectPath, sessionName, conversationId, expectedSchemaVersion)`

Recommended storage location:

- `session.conversationMachineSnapshots[conversationId]`

Reason:

- avoids stuffing machine internals into the public `ConversationState`
- keeps parity with existing `session.workflow._xstateSnapshot`
- lets the manager restore actors lazily per conversation

## Conversation Manager

### `src/lib/workflows/conversation/conversation-manager.ts`

Mirror the current `ralph-loop/workflow-manager.ts` pattern.

Responsibilities:

- create actors with `.provide()` production dependencies
- keep a `globalThis` actor registry keyed by `conversationWorkflowKey(...)`
- expose:
  - `ensureConversationActor(input)`
  - `getConversationActor(projectPath, sessionName, conversationId)`
  - `sendConversationEvent(projectPath, sessionName, conversationId, event)`
  - `restoreConversationActor(projectPath, sessionName, conversationId)`
  - `recoverConversationActors()`
  - `shutdownConversationActor(...)`
- subscribe to snapshots and:
  - persist debounced snapshot
  - sync conversation projection
  - clean up runtime state if actor reaches a terminalized cleanup condition

The manager should also offer a temporary compatibility helper:

```ts
export async function executePromptViaConversationMachine(
  input: ExecutePromptViaConversationMachineInput,
): Promise<{ conversationId: string }> { ... }
```

Then `executePromptStream()` can delegate into the manager while the route layer remains unchanged for the first migration step.

## Lock, Semaphore, and SSE Integration

### Locking

- Fail-fast session lock behavior stays unchanged
- lock acquisition moves from route and prompt helper code into machine-invoked actors
- any lock release happens only through `releaseRuntimeResources`

### Semaphore

- keep the existing FIFO semaphore behavior
- model slot acquisition explicitly as a state so queued conversations are observable in snapshots
- treat `acquiring_query_slot` as externally `running`

### SSE

Preserve existing event types:

- `conversation-status`
- `content`
- `ask-question`
- `error`
- `done`
- `debug-mode-status`
- `debug-log-received`

Implementation approach:

- machine actions call `broadcast()` for global SSE
- request-scoped SSE streams still use an `emit(event, data)` callback passed into `runPromptTurn`
- machine emits domain events; the manager bridges them to both global SSE and request-scoped stream sinks

This avoids coupling the machine directly to a single HTTP stream while still supporting the existing prompt route.

## Recovery Strategy

### Startup Recovery

Current `recoverStaleConversations()` should become the conservative fallback, not the main control path.

Recommended behavior:

1. For each conversation with a persisted snapshot, try `restoreConversationActor(...)`
2. If the snapshot lifecycle state is `running`, `waiting_for_input`, or any lock/slot acquisition state:
   - do not try to resume in-flight SDK execution
   - transition by sending `RESET_STALE`
   - clear pending question runtime resolvers
   - project back to persisted `status = "awaiting"`
3. Preserve serializable debug data:
   - `debugMode.active`
   - `debugMode.recording`
   - `debugMode.logFilePath`
   - `debugMode.plan`
   - `debugMode.phase` if it is still meaningful

### Orphan Recovery

Extend the current orphan detection with the manager:

- if a live actor exists but runtime lock/query resources are gone, send `RESET_STALE`
- if persisted state says `running` but no actor and no active query session exists, restore then reset to `awaiting`

## API Route Integration

Keep existing route shapes, but route them through machine events.

### Prompt Route

`POST /api/projects/[name]/sessions/[session]/prompt`

- ensure/create conversation actor
- send `SUBMIT_PROMPT`
- subscribe request-scoped SSE to actor-emitted stream events
- return the same SSE response contract

### Answer Route

`POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/answer`

- replace direct `resolveQuestion()` mutation logic with `sendConversationEvent(..., { type: "ANSWER_PROVIDED", ... })`
- if no actor exists after restart, return `410` and reset stale persisted question state as today

### Debug Mode Routes

Keep the current URLs, but map them to events:

- `POST .../debug-mode` -> `ENTER_DEBUG_MODE` or `EXIT_DEBUG_MODE`
- `POST .../debug-mode/recording` -> `SET_DEBUG_RECORDING`
- `DELETE .../debug-mode/logs` remains an imperative side effect, but also sends a debug-state refresh event if the actor is live

### Read State

Add one explicit debug/inspection endpoint for future UI and tests:

`GET /api/projects/[name]/sessions/[session]/conversations/[conversationId]/state`

Response:

```ts
export interface ConversationMachineView {
  snapshotValue: unknown;
  status: ConversationStatus;
  pendingQuestionId: string | null;
  debugPhase: ConversationDebugPhase | null;
  debugPlan: DebugPlan | null;
  hasLiveActor: boolean;
}
```

This route is optional for the first ship, but it will make debugging and test assertions substantially easier.

## Testing Strategy

Follow the current machine test style: create a base machine, override actors/actions via `.provide()`, drive with `createActor()`, assert snapshot transitions and outputs.

### Unit Tests

`src/lib/workflows/conversation/machine.test.ts`

- `new -> awaiting` on startup
- `awaiting -> acquiring_session_lock -> acquiring_query_slot -> ensuring_query_session -> running -> finalizing_turn -> awaiting`
- `running -> waiting_for_input -> running`
- debug mode `normal -> debug.idle -> debug.awaiting_reproduction -> debug.analyzing -> debug.fixing -> debug.cleanup -> normal`
- failure paths from each invoked state
- `RESET_STALE` from running states to awaiting

### Actor Tests

`src/lib/workflows/conversation/debug-schema.test.ts`

- validate Zod schema
- validate JSON schema shape stays in sync with Zod contract
- reject malformed hypothesis ids or missing instrumentation fields

`src/lib/workflows/conversation/conversation-manager.test.ts`

- actor registry lifecycle
- snapshot persistence calls
- runtime cleanup on finalization
- HMR-safe reuse of existing registry

### Route Tests

- prompt route delegates to manager and preserves SSE envelope
- answer route sends `ANSWER_PROVIDED`
- debug mode routes send machine events instead of direct conversation mutation

### `.provide()` Overrides

Use `.provide()` in tests to replace:

- `acquireSessionLock`
- `acquireQuerySlot`
- `extractDebugPlan`
- `ensureQuerySession`
- `runPromptTurn`
- `broadcastConversationStatus`
- `appendTranscriptEntry`
- `persistSnapshot`

This keeps tests deterministic and avoids live SDK/query/session dependencies.

## Migration Plan

### Phase 1: Introduce the machine behind a compatibility facade

- add `src/lib/workflows/conversation/`
- add manager and persistence
- make `executePromptStream()` call the manager internally
- keep existing API routes unchanged

### Phase 2: Move debug mode logic into machine context

- stop mutating `conversation.debugMode` directly from route handlers
- perform structured debug extraction with `outputFormat`
- persist debug plan in machine context and projection

### Phase 3: Move AskUserQuestion flow to machine events

- retire direct `question-registry` orchestration from `prompt.ts`
- keep a small adapter only if the SDK callback shape still requires it

### Phase 4: Switch workflow callers to the conversation manager

- optimistic workflow stops importing `executePromptStream()` directly
- future workflows invoke the conversation machine as the prompt primitive

### Phase 5: Delete obsolete imperative orchestration

- shrink `src/lib/prompt.ts` to query-session helpers and compatibility wrappers
- centralize state projection in conversation machine actions

## Composability for Future Workflows

The conversation machine should become the reusable building block for:

- Optimistic mode
- Ralph Loop iteration conversations
- focus/initialization conversations
- any future structured workflows that need prompt execution with locks, semaphore control, transcript persistence, and AskUserQuestion support

Expose a small workflow-facing API:

```ts
export interface ConversationWorkflowHandle {
  send(event: ConversationEvent): void;
  getSnapshot(): ConversationSnapshot;
  waitForSettledTurn(): Promise<RunPromptTurnOutput>;
}
```

That lets higher-level workflows compose conversations instead of re-implementing prompt execution concerns.

## Recommended Non-Goals for This Refactor

- do not rewrite `QuerySession` internals unless required by machine integration
- do not change public SSE payload shapes in the first pass
- do not move debug log ingestion into XState; the machine should own state transitions, not become the log transport

## Concrete Deliverables

1. New conversation workflow folder under `src/lib/workflows/conversation/`
2. Structured debug extraction schema and SDK `outputFormat` integration
3. Conversation manager with actor registry and snapshot restore
4. Refactored prompt route and answer route to send machine events
5. Startup/orphan recovery path for stale conversation actors
6. Tests covering lifecycle, debug mode, and route integration

## Final Recommendation

Build the conversation machine as the canonical prompt orchestrator, but ship it in two compatibility layers:

1. `executePromptStream()` delegates to the machine first
2. route handlers keep their current HTTP contract until the machine is stable

That gives the project the XState v5 benefits now without forcing a broad API rewrite, and it turns Debug Mode from prompt text injection plus UI buttons into actual structured machine state.
