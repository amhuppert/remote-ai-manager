# Debug Mode — Implementation Plan

## Overview

Debug Mode is a conversation-level state that any conversation can transition into and out of. When active, it injects a hypothesis-driven debugging workflow: the agent generates labeled hypotheses (H1, H2, etc.), instruments code with logging that POSTs NDJSON entries to a CC API endpoint, and CC writes them to `.debug/logs.jsonl` in the session worktree. The user controls the lifecycle via UI buttons: Mark Reproduced, Mark Fix, Exit Debug Mode, Start/Stop Recording, and Clear Logs.

---

## Phase 1: Schema & State Layer

### 1.1 Add debug mode fields to ConversationState

**File**: `src/lib/schemas.ts`

Add a `debugMode` object field (nullable, default null) to `conversationStateSchema`:

```typescript
export const debugModeStateSchema = z.object({
  active: z.boolean(),
  recording: z.boolean(),           // Whether incoming logs are written
  logFilePath: z.string(),          // Absolute path to .debug/logs.jsonl
  enteredAt: z.string(),            // ISO timestamp
  hypotheses: z.array(z.object({
    id: z.string(),                 // "H1", "H2", etc.
    description: z.string(),
  })).default([]),
});

// Add to conversationStateSchema:
debugMode: debugModeStateSchema.nullable().default(null),
```

**File**: `src/types/index.ts` — re-export `DebugModeState` type

### 1.2 Define debug log entry schema

**File**: `src/lib/schemas.ts`

```typescript
export const debugLogEntrySchema = z.object({
  timestamp: z.string(),                              // ISO 8601
  hypothesisId: z.string().nullable().default(null),   // "H1", "H2", or null
  location: z.string().nullable().default(null),       // "src/lib/foo.ts:42"
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable().default(null),
});
```

### 1.3 Define SSE events for debug mode

**File**: `src/lib/schemas.ts`

```typescript
export const debugModeStatusEventSchema = z.object({
  type: z.literal("debug-mode-status"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  active: z.boolean(),
  recording: z.boolean(),
});

export const debugLogReceivedEventSchema = z.object({
  type: z.literal("debug-log-received"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  entryCount: z.number(),           // Total entries in log file after write
});
```

Add both to the `SSEEvent` union type.

### 1.4 Dependencies
- None — this is the foundation layer.

### 1.5 Edge cases
- `debugMode` must survive server restarts (persisted in state.json via existing mutateState)
- When a conversation is in debug mode and CC restarts, `recording` should default to `false` (safe default — user must explicitly start recording after restart)

---

## Phase 2: Debug Log File Management

### 2.1 Create debug log module

**File**: `src/lib/debug-log.ts` (new)

Functions:
- `ensureDebugDir(worktreePath: string): string` — creates `.debug/` directory in worktree if not exists, returns absolute path
- `getDebugLogPath(worktreePath: string): string` — returns `{worktreePath}/.debug/logs.jsonl`
- `appendDebugLogEntry(logFilePath: string, entry: DebugLogEntry): void` — appends one NDJSON line (synchronous `fs.appendFileSync` for reliability)
- `clearDebugLog(logFilePath: string): void` — truncates the file to empty
- `readDebugLogEntries(logFilePath: string): DebugLogEntry[]` — reads and parses all entries (for potential future use)
- `getDebugLogStats(logFilePath: string): { entryCount: number, hypothesesSeen: string[] }` — quick stats without full parse

### 2.2 Add .debug/ to .gitignore

**When**: During `ensureDebugDir()`, check if `.debug/` is in the worktree's `.gitignore`. If not, append it.

Alternatively, add `.debug/` to the project's root `.gitignore` as part of this feature (simpler, deterministic).

### 2.3 Dependencies
- Phase 1 (schema for `DebugLogEntry`)

### 2.4 Edge cases
- File locking: `appendFileSync` is atomic enough for single-writer (CC is the only writer). No mutex needed.
- Large log files: no cap for now, but `clearDebugLog` gives the user manual control.

---

## Phase 3: API Routes

### 3.1 Debug log ingestion endpoint

**File**: `src/app/api/debug-logs/route.ts` (new)

```
POST /api/debug-logs?conversationId={id}
```

- Accepts: NDJSON body (one or more log entries, newline-separated) or single JSON object
- Validates each entry against `debugLogEntrySchema`
- Looks up conversation by ID, verifies debug mode is active
- If `recording` is `false`: return 200 OK, do nothing (silently drop)
- If `recording` is `true`: append entries to log file, broadcast `debug-log-received` SSE event
- Returns 200 OK (always, even if dropped — instrumented app shouldn't care)

**Query params**: `conversationId` (required) — identifies which conversation's debug log to write to

**Why not nested under /api/projects/[name]/sessions/[session]/**: The instrumented app doesn't know project/session names. The conversationId is sufficient to look up the session, and keeping the URL short makes the system prompt injection simpler.

### 3.2 Debug mode toggle endpoint

**File**: `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/route.ts` (new)

```
POST /api/projects/{name}/sessions/{session}/conversations/{conversationId}/debug-mode
Body: { "action": "enter" | "exit" }
```

- `enter`: Sets `debugMode` on ConversationState, creates `.debug/` dir and log file, broadcasts SSE event
- `exit`: Sets `debugMode` to null, broadcasts SSE event (does NOT delete log file — user may want to review)

### 3.3 Recording control endpoint

**File**: `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/recording/route.ts` (new)

```
POST .../debug-mode/recording
Body: { "recording": true | false }
```

- Updates `debugMode.recording` in state
- Broadcasts `debug-mode-status` SSE event

### 3.4 Clear logs endpoint

**File**: `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/logs/route.ts` (new)

```
DELETE .../debug-mode/logs
```

- Truncates the debug log file
- Broadcasts `debug-log-received` SSE event with `entryCount: 0`

### 3.5 Dependencies
- Phase 1 (schemas), Phase 2 (debug-log.ts file management)

### 3.6 Edge cases
- Concurrent requests to ingestion endpoint: `appendFileSync` serializes at OS level, safe for single-process
- Log ingestion must be fast — it's called by the instrumented app during runtime. No heavy validation or state mutations.
- The ingestion endpoint needs to resolve conversationId → session → worktreePath. This requires a lookup helper in state.ts or a new utility.

---

## Phase 4: System Prompt Integration

### 4.1 Add DEBUG_MODE_INSTRUCTIONS constant

**File**: `src/lib/prompt.ts`

```typescript
export const DEBUG_MODE_INSTRUCTIONS = `<debug-mode>
You are in Debug Mode. Follow this structured debugging workflow:

## Workflow
1. **Hypothesize**: Generate 3-5 hypotheses about the root cause, labeled H1, H2, etc. Present them to the user.
2. **Instrument**: Add logging statements to the codebase that POST runtime data to the debug log API. Each log entry must include the hypothesisId it's testing.
3. **Wait**: Tell the user to reproduce the bug. Do NOT proceed until the user signals reproduction is complete.
4. **Analyze**: Read the debug log file and analyze the runtime evidence. Identify which hypotheses are supported or refuted.
5. **Fix**: Propose a minimal, targeted fix based on the evidence.
6. **Verify**: Ask the user to verify the fix works.
7. **Clean up**: When the user confirms the fix, remove ALL debug instrumentation you added.

## Debug Log API
POST log entries to: {DEBUG_LOG_URL}

Each log entry must be a JSON object with these fields:
- timestamp: ISO 8601 string
- hypothesisId: "H1", "H2", etc. (which hypothesis this log tests)
- location: "file/path.ts:lineNumber" (where the log was added)
- message: human-readable description
- data: object with any runtime values to capture

Example instrumentation (JavaScript/TypeScript):
\`\`\`typescript
fetch("{DEBUG_LOG_URL}", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    timestamp: new Date().toISOString(),
    hypothesisId: "H1",
    location: "src/lib/auth.ts:42",
    message: "Token validation result",
    data: { token: token?.slice(0, 8), isValid, userId }
  })
}).catch(() => {});  // Fire and forget — don't break the app
\`\`\`

## Debug Log File
The log file is at: {DEBUG_LOG_FILE_PATH}
You can read this file directly to analyze collected logs.

## Important Rules
- NEVER propose a fix without runtime evidence from the logs
- Keep instrumentation minimal — only log what's needed to test hypotheses
- Use .catch(() => {}) on all fetch calls so logging never breaks the app
- Always clean up ALL instrumentation after the fix is verified
</debug-mode>`;
```

### 4.2 Inject into system prompt assembly

**File**: `src/lib/prompt.ts`, in the system prompt assembly block (~line 474-488):

```typescript
// Add to the filter-join array:
conversation?.debugMode?.active
  ? DEBUG_MODE_INSTRUCTIONS
      .replace(/\{DEBUG_LOG_URL\}/g, getDebugLogUrl(conversation.id))
      .replace(/\{DEBUG_LOG_FILE_PATH\}/g, conversation.debugMode.logFilePath)
  : null,
```

### 4.3 Helper: getDebugLogUrl

**File**: `src/lib/debug-log.ts`

```typescript
export function getDebugLogUrl(conversationId: string): string {
  // CC's own URL — needs to be discoverable
  const host = process.env.CC_HOST || "localhost";
  const port = process.env.PORT || "3000";
  return `http://${host}:${port}/api/debug-logs?conversationId=${conversationId}`;
}
```

### 4.4 Pass conversation to system prompt assembly

The system prompt assembly currently receives `session: SessionState`. It needs the active conversation's debug mode state. Either:
- Pass `conversation` as an additional parameter to the prompt assembly
- Or look up the conversation from the session's conversations array using the conversationId (already available in scope)

The latter is simpler — `conversationId` is already in scope at the system prompt assembly point.

### 4.5 Dependencies
- Phase 1 (debugMode on ConversationState), Phase 2 (getDebugLogUrl)

### 4.6 Edge cases
- The debug log URL must be reachable from the instrumented app. If the app runs in the same machine as CC, `localhost` works. For remote sessions (SSH), the URL needs to be the CC server's reachable address.
- Template replacement must handle the URL appearing in the example code block too.

---

## Phase 5: SSE Events & Client Listeners

### 5.1 Register new SSE event types

**File**: `src/lib/schemas.ts` — add `debugModeStatusEventSchema` and `debugLogReceivedEventSchema` to the SSE union (done in Phase 1.3)

### 5.2 Add client-side SSE listeners

**File**: `src/components/NotificationListener.tsx`

Add event listeners for:
- `debug-mode-status`: Invalidate session/conversation queries to refresh UI state
- `debug-log-received`: Update log entry count in the debug store (or invalidate a debug log query)

### 5.3 Dependencies
- Phase 1 (schemas), Phase 3 (API routes that broadcast events)

---

## Phase 6: User Action Handlers (Backend)

### 6.1 Mark Reproduced

**Trigger**: UI button click → API call (or inline in the prompt submission flow)

**Backend logic**:
1. Send a prompt to the agent via the existing prompt API:
   ```
   "The bug has been reproduced. The debug logs have been collected at {logFilePath}.
   Read the log file and analyze the runtime evidence to identify the root cause.
   Then propose a minimal, targeted fix."
   ```
2. No state transition needed — conversation stays in debug mode

**Implementation**: This can be a client-side action that calls the existing `/prompt` endpoint with a predefined message. No new backend endpoint needed.

### 6.2 Mark Fix

**Trigger**: UI button click → two sequential actions

**Backend logic**:
1. Send a prompt to the agent:
   ```
   "The fix has been verified. Remove ALL debug instrumentation you added (logging statements, fetch calls, etc.) and clean up the codebase."
   ```
2. After the prompt is queued, call `POST .../debug-mode` with `action: "exit"` to transition out of debug mode

**Implementation**: Client-side orchestration — send prompt, then call debug-mode exit API.

### 6.3 Exit Debug Mode

**Trigger**: UI button click → API call

**Backend logic**:
1. Call `POST .../debug-mode` with `action: "exit"`
2. Sets `debugMode` to null on the conversation
3. Does NOT send any prompt to the agent (user chose to exit without cleanup signal)
4. Does NOT delete the log file

### 6.4 Dependencies
- Phase 3 (API routes), Phase 4 (system prompt — so the agent understands debug workflow)

### 6.5 Edge cases
- What if the conversation is currently `running` when the user clicks Mark Fix? Queue the message via the existing message-queuing mechanism (streamInput).
- What if the user exits debug mode while the agent is mid-instrumentation? The agent will continue its current response, but subsequent prompts won't have debug instructions. The instrumentation code stays in the worktree — user's responsibility to clean up or start a new debug session.

---

## Phase 7: Zustand Store

### 7.1 Add debug mode state to session detail store

**File**: `src/stores/session-detail.store.ts`

Add fields:
```typescript
// Debug mode UI state (derived from server state, not source of truth)
debugModeActive: boolean;
debugModeRecording: boolean;
debugLogEntryCount: number;
```

Actions:
```typescript
setDebugModeState: (active: boolean, recording: boolean) => void;
setDebugLogEntryCount: (count: number) => void;
```

Alternatively, since debug mode state is persisted server-side, rely on TanStack Query cache invalidation to keep the UI in sync. The store only needs transient UI state (e.g., "is the recording toggle animating").

**Recommendation**: Lean on React Query. The conversation query already returns `debugMode` from the server. UI reads `conversation.debugMode?.active`, `conversation.debugMode?.recording` directly. No separate Zustand state needed for the core flags. Only add store state for ephemeral UI concerns.

### 7.2 Dependencies
- Phase 1 (schema — so TanStack Query returns debugMode from server state)

---

## Phase 8: UI Components

### 8.1 Debug mode controls in Topbar

**File**: `src/components/Topbar.tsx` or new `src/app/projects/[name]/[session]/DebugModeControls.tsx`

When `conversation.debugMode?.active` is true, render:

```
[● Recording] [⏸ Pause] | [Mark Reproduced] [Mark Fix] | [Clear Logs (42)] [Exit Debug]
```

- **Recording indicator + Start/Stop toggle**: Shows recording state, toggles via `POST .../debug-mode/recording`
- **Mark Reproduced**: Sends predefined prompt via existing prompt API
- **Mark Fix**: Sends cleanup prompt + exits debug mode
- **Clear Logs**: Calls `DELETE .../debug-mode/logs`, shows entry count badge
- **Exit Debug Mode**: Calls `POST .../debug-mode` with `action: "exit"`

### 8.2 Enter Debug Mode button

When `conversation.debugMode` is null, show a debug toggle or button that enters debug mode:
- Location: Near the TDD toggle in the Topbar, or in the prompt toolbar
- Calls `POST .../debug-mode` with `action: "enter"`

### 8.3 Debug mode visual indicator

When debug mode is active, add a visual indicator:
- Topbar background tint or badge (e.g., orange/amber accent)
- Status text: "Debug Mode" near the session status

### 8.4 Dependencies
- Phase 3 (API routes for all actions), Phase 5 (SSE events for real-time updates), Phase 7 (store/query state)

### 8.5 Edge cases
- Disable Mark Reproduced and Mark Fix when conversation status is `running` (agent is busy)
- Disable recording toggle when debug mode is not active
- Show confirmation dialog on Exit Debug Mode if recording is active

---

## Phase 9: Testing Strategy

### 9.1 Unit tests

**File**: `src/lib/debug-log.test.ts`
- `ensureDebugDir` creates directory
- `appendDebugLogEntry` writes valid NDJSON
- `clearDebugLog` truncates file
- `getDebugLogStats` returns correct counts
- `getDebugLogUrl` returns correct URL format

**File**: `src/lib/schemas.test.ts` (or add to existing)
- `debugModeStateSchema` validates correctly
- `debugLogEntrySchema` validates and rejects invalid entries
- New SSE event schemas validate correctly

### 9.2 API route tests

**File**: `src/lib/debug-log-route.test.ts`
- POST `/api/debug-logs`: writes entries when recording, drops when paused, validates schema
- POST `.../debug-mode`: enters/exits debug mode, creates log file on enter
- POST `.../debug-mode/recording`: toggles recording state
- DELETE `.../debug-mode/logs`: clears log file

### 9.3 Integration tests

- System prompt includes debug instructions when debug mode is active
- System prompt excludes debug instructions when debug mode is inactive
- SSE events broadcast correctly on debug mode state changes

### 9.4 Dependencies
- All phases — tests written alongside each phase using TDD

---

## Implementation Order

```
Phase 1: Schema & State          (no dependencies)
    ↓
Phase 2: Debug Log File Mgmt     (depends on Phase 1)
    ↓
Phase 3: API Routes              (depends on Phase 1, 2)
    ↓
Phase 4: System Prompt           (depends on Phase 1, 2)
    ↓
Phase 5: SSE Events              (depends on Phase 1, 3)
    ↓
Phase 6: User Action Handlers    (depends on Phase 3, 4)
    ↓
Phase 7: Zustand Store           (depends on Phase 1)
    ↓
Phase 8: UI Components           (depends on Phase 3, 5, 6, 7)
    ↓
Phase 9: Tests                   (alongside each phase — TDD)
```

Phases 1-4 are backend-only and can be built and tested independently. Phase 5-6 wire up the real-time and action layer. Phases 7-8 are frontend. Tests run throughout.

---

## Files Created/Modified Summary

### New files
- `src/lib/debug-log.ts` — Debug log file management
- `src/lib/debug-log.test.ts` — Tests for debug log module
- `src/app/api/debug-logs/route.ts` — Log ingestion endpoint
- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/route.ts` — Enter/exit debug mode
- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/recording/route.ts` — Recording toggle
- `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode/logs/route.ts` — Clear logs
- `src/app/projects/[name]/[session]/DebugModeControls.tsx` — UI controls component

### Modified files
- `src/lib/schemas.ts` — Add debugModeStateSchema, debugLogEntrySchema, SSE event schemas
- `src/types/index.ts` — Re-export new types
- `src/lib/prompt.ts` — Add DEBUG_MODE_INSTRUCTIONS, inject into system prompt
- `src/components/Topbar.tsx` — Render DebugModeControls
- `src/components/NotificationListener.tsx` — Add SSE listeners for debug events
- `.gitignore` — Add `.debug/`
