# Conversation Machine Implementation Plan

See the canonical copy in `memory-bank/codex/conversation-machine-implementation-plan.md`. This file mirrors that plan for the requested `.codex` handoff location.

## Objective

Refactor Command Center conversation execution from ad-hoc mutation logic into a conversation-scoped XState v5 machine that owns prompt lifecycle, AskUserQuestion suspension, debug mode, persistence, SSE broadcasting, and startup recovery. The new implementation replaces direct status mutation in `src/lib/prompt.ts`, `src/lib/conversations.ts`, and the conversation answer/debug routes.

## Architecture

### Target module layout

Create a dedicated workflow package:

```text
src/lib/workflows/conversation/
  types.ts
  actors.ts
  machine.ts
  actor-implementations.ts
  actions.ts
  persistence.ts
  runtime-state.ts
  manager.ts
  manager.test.ts
  machine.test.ts
  actor-implementations.test.ts
```

Modify existing entry points:

```text
src/lib/prompt.ts
src/lib/conversations.ts
src/lib/state.ts
src/lib/schemas.ts
src/lib/query-session.ts
src/lib/question-registry.ts
src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/answer/route.ts
src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/route.ts
src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/recording/route.ts
src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/logs/route.ts
src/app/api/debug-logs/route.ts
src/instrumentation.node.ts
```

### Ownership boundaries

- `src/lib/workflows/conversation/machine.ts`
  - pure state chart, types, guards, serializable context
- `src/lib/workflows/conversation/actors.ts`
  - `fromPromise` actor declarations only
- `src/lib/workflows/conversation/actor-implementations.ts`
  - production actor logic currently buried in `executePromptStream()`
- `src/lib/workflows/conversation/actions.ts`
  - named XState actions for persistence, SSE, prompt-stream emission, push notifications, transcript updates
- `src/lib/workflows/conversation/runtime-state.ts`
  - conversation-scoped runtime registry for non-serializable data
- `src/lib/workflows/conversation/persistence.ts`
  - debounced persisted snapshot writes into each conversation record
- `src/lib/workflows/conversation/manager.ts`
  - actor registry, `.provide()` wiring, start/resume/send APIs, startup rehydration

## State Chart

### Top-level states

- `idle`
  - persisted status: `new` when `promptCount === 0`, otherwise `awaiting`
  - accepts prompt submission and debug-mode toggles
- `acquiringResources`
  - acquires session lock and query slot
  - initializes transcript path
- `executing`
  - invokes prompt actor
  - contains normal execution and debug execution branches
- `waitingForInput`
  - AskUserQuestion is outstanding
  - answer route resolves via machine event instead of direct mutation
- `finalizingTurn`
  - stores aggregated metadata, clears transient question state, releases resources
- `failed`
  - terminal for unrecoverable actor failures during a single turn
  - transitions immediately back to `idle` after cleanup if the conversation actor remains long-lived
- `debug`
  - compound superstate used whenever debug mode is active
  - wraps the same turn lifecycle but with debug phases

### Compound debug state

- `debug.preparing`
  - enters debug mode, ensures `.debug/` directory and `logFilePath`, clears stale transient data, sets `instructionsDelivered = false`
- `debug.hypothesizing`
  - next submitted prompt runs with `outputFormat: { type: 'json_schema', schema: debugHypothesisOutputSchema }`
  - actor parses hypotheses and reproduction steps from structured output
- `debug.awaitingReproduction`
  - machine is waiting for the user to reproduce the issue
  - recording can be toggled on/off while remaining in this state
- `debug.analyzingEvidence`
  - submitted prompt uses `outputFormat: { type: 'json_schema', schema: debugEvidenceAnalysisSchema }`
  - requires reading `debugMode.logFilePath`
- `debug.fixing`
  - submitted prompt uses normal streaming output; machine remains in debug mode but marks phase as `fixing`
- `debug.awaitingVerification`
  - waits for the user to verify the fix
- `debug.cleanupInstrumentation`
  - submitted prompt uses `outputFormat: { type: 'json_schema', schema: debugCleanupResultSchema }`
  - on success transitions either to `idle` with debug mode still active or to `debug.completed` if the user chose exit
- `debug.completed`
  - exits compound debug state, clears `debugMode` persisted state, returns to `idle`

### Events

Define `ConversationEvent` in `src/lib/workflows/conversation/types.ts`:

```ts
type ConversationEvent =
  | { type: "SUBMIT_PROMPT"; promptText: string; images?: ImagePayload[]; modelId?: ClaudeModel; effort?: EffortLevel; autonomous?: boolean; streamId: string }
  | { type: "SDK_INIT"; sessionId: string }
  | { type: "ASK_QUESTION"; questionId: string; questions: AskQuestionItem[] }
  | { type: "ANSWER"; questionId: string; answers: Record<string, string> }
  | { type: "PROMPT_COMPLETED"; result: PromptActorResult }
  | { type: "PROMPT_FAILED"; error: string }
  | { type: "ABORT_TURN"; reason: "timeout" | "user" | "shutdown" }
  | { type: "ENTER_DEBUG_MODE"; logFilePath: string }
  | { type: "EXIT_DEBUG_MODE" }
  | { type: "SET_DEBUG_RECORDING"; recording: boolean }
  | { type: "MARK_REPRODUCED" }
  | { type: "MARK_FIX_VERIFIED" }
  | { type: "CLEAR_DEBUG_LOGS" }
  | { type: "RECOVER_FROM_SNAPSHOT" };
```

### Guards

Implement in `machine.ts`:

- `hasPendingPrompt`
- `hasClaudeSessionId`
- `shouldReuseQuerySession`
- `isDebugModeActive`
- `isRecordingEnabled`
- `hasPendingQuestion`
- `isFirstPromptInDebugMode`
- `shouldExitDebugAfterCleanup`
- `canRestoreActiveTurn`

### Transition rules

- `idle --SUBMIT_PROMPT--> acquiringResources`
- `idle --ENTER_DEBUG_MODE--> debug.preparing`
- `debug.awaitingReproduction --MARK_REPRODUCED--> debug.analyzingEvidence`
- `debug.awaitingVerification --MARK_FIX_VERIFIED--> debug.cleanupInstrumentation`
- `executing --ASK_QUESTION--> waitingForInput`
- `waitingForInput --ANSWER--> executing`
- `* --SET_DEBUG_RECORDING--> same state with persisted debug metadata update`
- `* --CLEAR_DEBUG_LOGS--> same state with side-effect action only`
- `* --ABORT_TURN--> finalizingTurn`
- `executing --PROMPT_COMPLETED--> finalizingTurn`
- `executing --PROMPT_FAILED--> finalizingTurn`
- `finalizingTurn --> debug.awaitingReproduction | debug.awaitingVerification | idle`

## Context Type Definition

Define `ConversationContext` in `src/lib/workflows/conversation/types.ts`:

```ts
interface ConversationContext {
  _schemaVersion: 1;
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  conversationId: string;
  createdAt: string;
  lastActivityAt: string;
  status: ConversationStatus;
  promptCount: number;
  transcriptPath: string | null;
  claudeSessionId: string | null;
  forkedFrom: ForkedFrom;
  role: ConversationRole;
  activeTurn: {
    promptText: string;
    images: ImagePayload[];
    modelId: ClaudeModel | null;
    effort: EffortLevel | null;
    autonomous: boolean;
    startedAt: string | null;
    streamId: string | null;
  } | null;
  pendingQuestion: {
    questionId: string;
    questions: AskQuestionItem[];
  } | null;
  debugMode: {
    active: boolean;
    recording: boolean;
    logFilePath: string;
    enteredAt: string;
    hypotheses: DebugHypothesis[];
    instructionsDelivered: boolean;
    phase:
      | "hypothesizing"
      | "awaiting_reproduction"
      | "analyzing_evidence"
      | "fixing"
      | "awaiting_verification"
      | "cleanup_instrumentation";
  } | null;
  totals: {
    totalCostUsd: number | null;
    totalDurationMs: number | null;
    totalTurns: number | null;
    contextTokens: number | null;
    contextWindowMax: number | null;
  };
  lastResult: PromptActorResult | null;
  lastError: string | null;
}
```

Persist `status`, `pendingQuestion`, `debugMode`, `claudeSessionId`, `transcriptPath`, and totals into `ConversationState`. Do not persist runtime-only handles.

## Persisted Schema Changes

### `src/lib/schemas.ts`

Add a serializable machine snapshot field to `conversationStateSchema`:

```ts
machineSnapshot: z.unknown().nullable().default(null)
```

Expand `debugModeStateSchema` with a persisted `phase` field:

```ts
phase: z.enum([
  "hypothesizing",
  "awaiting_reproduction",
  "analyzing_evidence",
  "fixing",
  "awaiting_verification",
  "cleanup_instrumentation",
]).default("hypothesizing")
```

Keep existing `ConversationStatus` string values for UI compatibility. The machine is authoritative; the string remains a derived mirror for APIs and session-derived status logic.

## Actor Definitions

### `prepareTurnActor`

File: `src/lib/workflows/conversation/actor-implementations.ts`

Responsibilities:

- acquire session lock via `acquireSessionLock(projectPath, sessionName)`
- acquire query slot via `acquireQuerySlot("prompt:${sessionName}")`
- create transcript path via `getTranscriptPath(conversationId)` if missing
- register runtime resources in conversation runtime state
- emit `conversation-status: running`

### `executePromptActor`

This is the main rewrite of `executePromptStream()` minus state transitions.

Responsibilities:

- append the user prompt to transcript via `safeAppendTranscriptEntry()`
- create or reuse `QuerySession`
- handle model/effort changes exactly as current code does
- construct system prompt additions, including debug-mode prompt content
- stream raw SDK messages through `processMessage`-equivalent helpers
- send machine events for `SDK_INIT`, `ASK_QUESTION`, `PROMPT_COMPLETED`, and `PROMPT_FAILED`
- support `outputFormat` for debug structured turns

### `waitForAnswerActor`

Wrap current `registerQuestion()` / `resolveQuestion()` behavior.

### `ensureDebugResourcesActor`

Responsibilities:

- `ensureDebugDir(worktreePath)`
- compute `getDebugLogPath(worktreePath)`
- initialize persisted `debugMode`

### `clearDebugLogsActor`

Responsibilities:

- clear `.debug/logs.jsonl`
- broadcast `debug-log-received` with `entryCount: 0`

## Debug Mode Structured Output JSON Schemas

Implement plain JSON Schema objects in `src/lib/workflows/conversation/debug-schemas.ts`.

### `debugHypothesisOutputSchema`

Use for `debug.hypothesizing`:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["hypotheses", "reproductionSteps"],
  "properties": {
    "hypotheses": {
      "type": "array",
      "minItems": 3,
      "maxItems": 5,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "description", "instrumentationPlan"],
        "properties": {
          "id": { "type": "string", "pattern": "^H[1-5]$" },
          "description": { "type": "string", "minLength": 1 },
          "instrumentationPlan": { "type": "string", "minLength": 1 }
        }
      }
    },
    "reproductionSteps": {
      "type": "array",
      "minItems": 2,
      "items": { "type": "string", "minLength": 1 }
    }
  }
}
```

### `debugEvidenceAnalysisSchema`

Use for `debug.analyzingEvidence`:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["supportedHypotheses", "refutedHypotheses", "inconclusiveHypotheses", "recommendedNextStep"],
  "properties": {
    "supportedHypotheses": { "type": "array", "items": { "type": "string", "pattern": "^H[1-5]$" } },
    "refutedHypotheses": { "type": "array", "items": { "type": "string", "pattern": "^H[1-5]$" } },
    "inconclusiveHypotheses": { "type": "array", "items": { "type": "string", "pattern": "^H[1-5]$" } },
    "recommendedNextStep": {
      "type": "string",
      "enum": ["fix", "more_instrumentation"]
    },
    "evidenceSummary": { "type": "string" }
  }
}
```

### `debugCleanupResultSchema`

Use for `debug.cleanupInstrumentation`:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["removedInstrumentation", "notes"],
  "properties": {
    "removedInstrumentation": { "type": "boolean" },
    "notes": { "type": "string" }
  }
}
```

## Runtime State

Create `src/lib/workflows/conversation/runtime-state.ts`.

Key format:

```ts
conversationRuntimeKey(projectPath, sessionName, conversationId)
// `${projectPath}::${sessionName}::${conversationId}`
```

Store:

- `abortController`
- `releaseSessionLock`
- `releaseQuerySlot`
- `querySession`
- `streamEmit`
- `streamController`
- `activeQuestion` deferred resolver
- `timeoutHandle`

## Persistence

Create `src/lib/workflows/conversation/persistence.ts`.

- persist `actor.getPersistedSnapshot()` to `conversation.machineSnapshot`
- mirror derived fields into the same conversation record in the same mutation
- restore only if `_schemaVersion === 1`

## Integration Points

- `src/lib/prompt.ts`: reduce to a manager-backed compatibility façade
- `src/lib/conversations.ts`: keep CRUD/fork helpers, remove direct debug lifecycle mutators
- answer and debug routes: replace direct `mutateConversation()` calls with machine events
- `src/app/api/debug-logs/route.ts`: remove temporary debug instrumentation and read machine-owned debug state
- `src/lib/state.ts`: keep string statuses for compatibility, but treat machine snapshot as authoritative for recovery
- `src/instrumentation.node.ts`: rehydrate conversation actors on startup

## File Structure

### New files

- `src/lib/workflows/conversation/types.ts`
- `src/lib/workflows/conversation/actors.ts`
- `src/lib/workflows/conversation/debug-schemas.ts`
- `src/lib/workflows/conversation/machine.ts`
- `src/lib/workflows/conversation/actions.ts`
- `src/lib/workflows/conversation/actor-implementations.ts`
- `src/lib/workflows/conversation/runtime-state.ts`
- `src/lib/workflows/conversation/persistence.ts`
- `src/lib/workflows/conversation/manager.ts`
- test files for all of the above

### Modified files

- `src/lib/prompt.ts`
- `src/lib/schemas.ts`
- `src/lib/state.ts`
- `src/lib/conversations.ts`
- `src/lib/query-session.ts`
- `src/lib/question-registry.ts`
- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/answer/route.ts`
- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/route.ts`
- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/recording/route.ts`
- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/logs/route.ts`
- `src/app/api/debug-logs/route.ts`
- `src/instrumentation.node.ts`

## Implementation Order

1. Extend schemas and persisted types.
2. Build conversation runtime and persistence modules.
3. Define conversation machine types, debug JSON schemas, and pure machine.
4. Implement actor logic by extracting from `src/lib/prompt.ts`.
5. Implement manager and `.provide()` wiring.
6. Convert `src/lib/prompt.ts` into the manager-backed façade.
7. Convert answer and debug-mode routes to machine events.
8. Update startup recovery and actor rehydration.
9. Remove obsolete helpers and dead code.
10. Run full test pass and add regression coverage.

## Testing Strategy

- machine transition tests
- actor behavior tests
- route integration tests
- startup rehydration tests
- debug-mode structured-output tests
- regression coverage for transcript, forking, session-derived status, and push notifications

## Non-Negotiable Decisions

- The conversation machine is long-lived per conversation, not per HTTP request.
- Persisted `ConversationState.status` remains for compatibility, but it is derived from machine state.
- All non-serializable execution data moves into a conversation runtime registry.
- All answer/debug mode APIs talk to the manager via machine events.
- Debug mode is a true compound XState state with structured-output phases, not a boolean flag plus prompt text injection.
