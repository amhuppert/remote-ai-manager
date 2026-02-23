# Agents SDK Migration Implementation Plan

## Overview

Replace the Claude Code CLI subprocess spawning (`child_process.spawn` + NDJSON readline) with the `@anthropic-ai/claude-agent-sdk` package's `query()` API. This eliminates manual stream parsing, shell-script hooks, and Claude Code filesystem dependencies. Own transcript storage replaces reading from `~/.claude/projects/`. The hook system (install-hooks, HTTP hook endpoint, hook detection) is removed entirely. SDK-only session management — no external CLI observation.

**Key architectural changes:**
- `prompt.ts`: `spawn("claude", ...)` → `query({ prompt, options })` async generator
- `stream-events.ts`: Deleted — SDK provides typed `SDKMessage` objects
- `hooks.ts` + `install-hooks.ts` + `/api/hooks/`: Deleted entirely
- `transcript.ts`: Rewritten — own JSONL storage in CSM config dir instead of reading Claude Code's files
- `conversations.ts`: Simplified — remove all discovery/import/sync functions
- New cost tracking fields on `ConversationState`

**What does NOT change:**
- Git worktree management (`sessions.ts`, `worktrees.ts`)
- Project discovery (`discovery.ts`)
- State persistence (`state.ts`)
- SSE broadcasting infrastructure (`sse-broadcaster.ts`)
- Lock mechanism (`lock.ts`) — kept as-is
- Git operations (`diff.ts`, `git-operations.ts`)
- API route structure for prompts (same endpoints, same SSE event contract)
- Client-side prompt hook (`use-send-prompt.ts`) — no changes needed

## Dependencies

Install:
```bash
bun add @anthropic-ai/claude-agent-sdk
```

The SDK requires:
- `zod@^4` — already present (`^4.3.6`)
- Node.js 18+ — already satisfied
- Claude Code CLI installed and authenticated on the host machine

Latest SDK version: `0.2.50`

## File Changes Summary

### Delete (8 files)
| File | Reason |
|------|--------|
| `src/lib/install-hooks.ts` | Hook installation system removed |
| `src/lib/install-hooks.test.ts` | Tests for deleted module |
| `src/lib/hooks.ts` | Hook event processing removed |
| `src/lib/hooks-detection.test.ts` | Tests for deleted module |
| `src/lib/hooks-route.test.ts` | Tests for deleted routes |
| `src/lib/stream-events.ts` | NDJSON parsing replaced by SDK typed messages |
| `src/app/api/hooks/route.ts` | Hook HTTP endpoint removed |
| `src/app/api/hooks/status/route.ts` | Hook status endpoint removed |

### Create (1 file)
| File | Purpose |
|------|---------|
| `src/lib/format-tool-use.ts` | `formatToolUse()` + `FormattedToolUse` extracted from `stream-events.ts` before deletion |

### Rewrite (2 files)
| File | What changes |
|------|-------------|
| `src/lib/prompt.ts` | SDK `query()` replaces `spawn()` + readline loop |
| `src/lib/transcript.ts` | Own JSONL storage replaces Claude Code filesystem reading |

### Modify (11 files)
| File | What changes |
|------|-------------|
| `src/lib/schemas.ts` | Add cost fields to conversation schema; remove hook schemas; remove session-ready schema |
| `src/types/index.ts` | Remove hook-related type exports; remove `SessionReadyEvent`; add new `TranscriptMessage` fields |
| `src/lib/conversations.ts` | Remove `discoverAndImportConversations`, `syncConversationSummaries`, `encodeProjectPath`, all discovery helpers; remove `renameConversation`'s sessions-index sync |
| `src/lib/conversations.test.ts` | Remove tests for deleted discovery/import/sync functions |
| `src/lib/config.ts` | Add `maxTurns` to default config |
| `src/lib/queries.ts` | Remove `useHooksStatusQuery` |
| `src/lib/query-keys.ts` | Remove `hooksKeys` |
| `src/lib/stream-events.test.ts` | Rename to `src/lib/format-tool-use.test.ts`; keep `formatToolUse` tests, remove `parseStreamLine` tests |
| `src/app/projects/ProjectsGrid.tsx` | Remove hooks status indicator and hooks-missing banner |
| `src/app/projects/[name]/SessionsList.tsx` | Remove hooks status indicator |
| `src/app/projects/[name]/SessionsList.test.tsx` | Remove hooks mock |
| `src/app/api/projects/[name]/sessions/[session]/conversations/route.ts` | Remove `?import=true` auto-import logic |
| `src/components/NotificationListener.tsx` | Remove `session-ready` event listener; keep `conversation-status` |
| `src/components/MessageContent.tsx` | Update import from `stream-events` to `format-tool-use` |
| `package.json` | Add `@anthropic-ai/claude-agent-sdk`; remove `install-hooks` script |

## Schema Changes

### `conversationStateSchema` — add 3 fields

```typescript
// Add to conversationStateSchema in schemas.ts:
totalCostUsd: z.number().nullable().default(null),
totalDurationMs: z.number().nullable().default(null),
totalTurns: z.number().nullable().default(null),
```

These use `.default(null)` so existing state files without these fields parse cleanly (backward compatible).

### `globalConfigSchema` — add `maxTurns`

```typescript
// Add to globalConfigSchema:
maxTurns: z.number().int().positive().default(50),
```

Add to `defaultConfig()` in `config.ts`: `maxTurns: 50`.

### Remove schemas (from `schemas.ts`)

- `hookEventDataSchema` + `HookEventData` type
- `hookEventResultSchema` + `HookEventResult` type
- `sessionReadyEventSchema` + `SessionReadyEvent` type
- Update `SSEEvent` union type: remove `SessionReadyEvent`, keep only `ConversationStatusEvent`

### Remove transcript-related schemas that become unused

- `transcriptEntrySchema` — the old Claude Code JSONL parser schema. The new transcript module uses its own types.
- `contentBlockSchema` — only used by old transcript parser

Keep: `messageContentBlockSchema` (used by UI and new transcript module).

## New Transcript Module (`src/lib/transcript.ts`)

Replaces the old module that read Claude Code JSONL files. Now manages CSM's own transcript storage.

**Storage location**: `<configDir>/transcripts/<conversationId>.jsonl`
- Where `configDir` is the OS-appropriate CSM config directory (same as `state.json` location)
- Example: `~/.config/csm/transcripts/550e8400-e29b-41d4-a716-446655440000.jsonl`

**Transcript entry format** (one JSON line per entry):
```typescript
interface TranscriptEntry {
  timestamp: string;       // ISO 8601
  type: string;            // SDK message type: "system" | "assistant" | "user" | "result" | "status" | etc.
  role?: "user" | "assistant";  // For user/assistant messages
  content?: MessageContentBlock[];  // Extracted content blocks for user/assistant messages
  raw?: unknown;           // Full SDK message data (for debugging/future use)
}
```

**Exported functions**:

| Function | Signature | Purpose |
|----------|-----------|---------|
| `getTranscriptPath` | `(conversationId: string) => Promise<string>` | Returns absolute path to transcript JSONL file |
| `appendTranscriptEntry` | `(conversationId: string, entry: TranscriptEntry) => Promise<void>` | Appends one JSON line to the file |
| `readConversationMessages` | `(transcriptPath: string \| null) => Promise<TranscriptMessage[]>` | Reads and parses transcript into display messages. Handles null/missing gracefully. Replaces the old function of the same name. |

The `readConversationMessages` function:
1. If `transcriptPath` is null or file doesn't exist → return `[]`
2. Read file, split into lines, parse each as JSON
3. Filter for entries with `role: "user"` or `role: "assistant"` that have `content`
4. Return as `TranscriptMessage[]` (same type the UI expects — no client changes needed)

**Command detection**: Preserve the `parseCommandContent` function for detecting slash command invocations in user messages. Move it to the new transcript module since it's used during transcript reading.

## Rewritten `prompt.ts`

The `executePromptStream` function signature is **unchanged** — the API routes call it identically.

**SDK configuration** — these options ensure parity with CLI behavior:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: promptText,
  options: {
    model: effectiveModel,          // "opus" | "sonnet" | "haiku" or full model ID
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: session.worktreePath,
    maxTurns: config.maxTurns ?? 50,
    resume: conversation.claudeSessionId ?? undefined,
    persistSession: true,
    env: { CLAUDECODE: "" },
  },
});
```

**Critical SDK options explained**:
- `systemPrompt: { type: "preset", preset: "claude_code" }` — loads Claude Code's full system prompt (tools, behaviors, formatting)
- `settingSources: ["user", "project", "local"]` — loads `CLAUDE.md`, user settings (`~/.claude/settings.json`), project settings (`.mcp.json`, project-level config), and local overrides. This is what makes MCP servers, plugins, and all customizations available.
- `permissionMode: "bypassPermissions"` — matches current `--dangerously-skip-permissions`
- `cwd` — sets working directory to the session's worktree (same as current spawn `cwd`)
- `resume` — continues an existing conversation (same as current `--resume <id>`)
- `persistSession: true` — ensures the SDK persists session state for future resume
- `env: { CLAUDECODE: "" }` — prevents nested session detection error

**CLAUDECODE env var**: At the top of `prompt.ts`, add `delete process.env.CLAUDECODE;` as a module-level side effect. This handles the case where CSM itself runs inside a Claude Code session during development.

**Message processing loop**:

```
for await (const message of q):
  case "system" (subtype "init"):
    → Extract session_id
    → emit("init", { sessionId })
    → Append to transcript

  case "assistant":
    → For each block in message.message.content:
      - "text" block → emit("content", { type: "text", text })
      - "tool_use" block → emit("content", { type: "tool_use", name, input })
    → Append to transcript with extracted content blocks

  case "result":
    subtype "success":
      → emit("result", { sessionId, costUsd, numTurns })
      → Store cost/duration/turns data
    subtype "error_*":
      → emit("error", { message: <error description> })
    → Append to transcript

  case "user":
    → Append to transcript only (internal tool results, not displayed)

  all other types:
    → Append to transcript only (status updates, rate limits, etc.)

After loop completes:
  → emit("done", {})
```

**Error handling**:
- Wrap the entire `for await` loop in try/catch
- If the generator throws (e.g., process crash), emit `error` + `done`
- SDK error result subtypes map to error messages:
  - `error_max_turns` → "Agent reached maximum turns (50)"
  - `error_during_execution` → join `errors[]` array with "; "
  - `error_max_budget_usd` → "Agent exceeded budget limit"

**On completion** (after loop, before `emit("done")`):
- Update conversation metadata via `mutateConversation`:
  - `promptCount++`
  - Set `claudeSessionId` if captured from init/result message
  - Set `transcriptPath` to our transcript file path
  - Accumulate `totalCostUsd`, `totalDurationMs`, `totalTurns` from result message

**Stream cancellation**: Add a `cancel` callback to the `ReadableStream` constructor in the API routes. When the client disconnects, the `cancel` callback fires. Store the `Query` object in a module-level variable (scoped to the executePromptStream call), and call `q.close()` from the cancel callback. Implementation:

In the API routes, pass an `AbortSignal` to `executePromptStream` and wire it to the ReadableStream cancel:

```typescript
// In the route's ReadableStream constructor:
const abortController = new AbortController();
const stream = new ReadableStream({
  async start(controller) {
    // ... existing emit/executePromptStream logic,
    // passing abortController.signal
  },
  cancel() {
    abortController.abort();
  },
});
```

In `executePromptStream`, accept an optional `signal?: AbortSignal` parameter. When the signal fires, call `q.close()`.

Updated signature:
```typescript
export async function executePromptStream(
  projectPath: string,
  session: SessionState,
  promptText: string,
  emit: (event: string, data: unknown) => void,
  conversationId?: string,
  modelId?: ClaudeModel,
  signal?: AbortSignal,
): Promise<{ conversationId: string }>
```

The `finally` block remains identical to current: set conversation status to "awaiting", broadcast status, release lock.

## Simplified `conversations.ts`

**Remove these functions** (and all their private helpers):
- `encodeProjectPath()` — Claude Code filesystem path encoding
- `discoverFromIndex()` — sessions-index.json discovery
- `discoverFromJsonl()` — JSONL file scanning
- `discoverAndImportConversations()` — main import orchestrator
- `syncConversationSummaries()` — summary sync from Claude Code index
- `readSessionsIndex()` — sessions-index.json reader
- `updateSessionsIndexSummary()` — sessions-index.json writer
- `matchesSession()` — discovery matcher
- `getClaudeProjectDir()` — Claude Code project directory resolver
- `DiscoveredSession` interface
- `SessionsIndexEntry` interface

**Modify `renameConversation()`**: Remove the `updateSessionsIndexSummary` call at the end. The function becomes a simple state update only.

**Keep unchanged**:
- `createConversation()`
- `getConversation()`
- `getSessionConversations()`
- `setConversationArchived()`
- Re-exports from `session-derived`

## Conversations API Route Change

`src/app/api/projects/[name]/sessions/[session]/conversations/route.ts`:

Remove the `?import=true` query param handling:
```typescript
// DELETE this block:
if (url.searchParams.get("import") === "true") {
  await discoverAndImportConversations(projectPath, session);
  await syncConversationSummaries(projectPath, session);
}
```

Remove the imports for `discoverAndImportConversations` and `syncConversationSummaries`.

## UI Changes

### `ProjectsGrid.tsx`
- Remove `useHooksStatusQuery` import and call
- Remove `hooksStatus` variable
- Remove the hooks status dot in the topbar (`status-dot` with hooks installed/missing text)
- Remove the hooks-missing warning banner (`hooks-banner` div)

### `SessionsList.tsx`
- Remove `useHooksStatusQuery` import and call
- Remove `hooksStatus` variable
- Remove the hooks status dot in the topbar

### `SessionsList.test.tsx`
- Remove `useHooksStatusQuery` mock

### `NotificationListener.tsx`
- Remove the `session-ready` event listener entirely
- Keep the `conversation-status` event listener (still used by prompt.ts broadcasting)
- Remove `SessionReadyEvent` import

### `MessageContent.tsx`
- Update import: `from "@/lib/stream-events"` → `from "@/lib/format-tool-use"`

## `format-tool-use.ts` (extracted from `stream-events.ts`)

Move `FormattedToolUse` interface, `formatToolUse()` function, and the private `truncate()` helper to `src/lib/format-tool-use.ts`. This is a direct copy with no logic changes.

Rename `src/lib/stream-events.test.ts` to `src/lib/format-tool-use.test.ts`. Keep only the `formatToolUse` tests. Delete the `parseStreamLine` tests.

## SSE Event Schema Cleanup

Remove `SessionReadyEvent` from the `SSEEvent` union type. The `session-ready` event was only broadcast by the hooks route (for externally-initiated sessions). With SDK-only, all status transitions are handled by `prompt.ts` broadcasting `conversation-status`.

The `SSEEvent` type becomes just `ConversationStatusEvent`.

## `package.json` Changes

```diff
  "dependencies": {
+   "@anthropic-ai/claude-agent-sdk": "^0.2.50",
    ...
  },
  "scripts": {
-   "install-hooks": "npx tsx src/lib/install-hooks.ts",
    ...
  }
```

## Implementation Steps (Ordered)

### Phase 1: Foundation (no behavior change yet)

1. **Install SDK**: `bun add @anthropic-ai/claude-agent-sdk`

2. **Extract `format-tool-use.ts`**: Copy `FormattedToolUse`, `truncate`, `formatToolUse` from `stream-events.ts` to new `src/lib/format-tool-use.ts`. Update import in `MessageContent.tsx`. Rename `stream-events.test.ts` to `format-tool-use.test.ts`, remove `parseStreamLine` tests.

3. **Schema changes**: Add `totalCostUsd`, `totalDurationMs`, `totalTurns` to `conversationStateSchema`. Add `maxTurns` to `globalConfigSchema` and `defaultConfig()`. Remove hook schemas (`hookEventDataSchema`, `hookEventResultSchema`, `sessionReadyEventSchema`). Update `SSEEvent` type.

4. **Type updates**: In `types/index.ts`, remove exports for `HookEventResult`, `SessionReadyEvent`. Keep `ConversationStatusEvent`.

### Phase 2: New transcript module

5. **Rewrite `src/lib/transcript.ts`**: Implement `getTranscriptPath`, `appendTranscriptEntry`, `readConversationMessages` with own JSONL storage. Keep `parseCommandContent` for slash command detection. Ensure the `readConversationMessages` return type matches the existing `TranscriptMessage` interface.

6. **Update transcript tests**: Rewrite `src/lib/transcript.test.ts` to test the new storage format instead of Claude Code JSONL parsing.

### Phase 3: Core migration

7. **Rewrite `src/lib/prompt.ts`**: Replace `spawn` + readline with SDK `query()`. Add module-level `delete process.env.CLAUDECODE`. Use the SDK options as specified. Implement the message processing loop. Add `signal` parameter for cancellation. Wire transcript appending into the message loop.

8. **Update API routes**: In both prompt routes, create an `AbortController`, pass `signal` to `executePromptStream`, wire `cancel()` callback on the `ReadableStream`.

### Phase 4: Remove hook system

9. **Delete hook files**: Remove `src/lib/hooks.ts`, `src/lib/install-hooks.ts`, `src/app/api/hooks/route.ts`, `src/app/api/hooks/status/route.ts`. Delete test files: `src/lib/hooks-detection.test.ts`, `src/lib/hooks-route.test.ts`, `src/lib/install-hooks.test.ts`.

10. **Delete `stream-events.ts`**: Already extracted `formatToolUse`. Remove the file.

### Phase 5: Simplify conversations

11. **Simplify `conversations.ts`**: Remove all discovery/import/sync functions and their private helpers. Simplify `renameConversation` to remove sessions-index sync.

12. **Update conversations route**: Remove `?import=true` handling from the conversations GET route. Remove unused imports.

13. **Update conversations tests**: Remove tests for deleted functions in `conversations.test.ts`.

### Phase 6: UI cleanup

14. **Remove hooks UI**: In `ProjectsGrid.tsx`, remove `useHooksStatusQuery` usage and hooks status dot/banner. In `SessionsList.tsx`, remove hooks status usage. In `SessionsList.test.tsx`, remove hooks mock.

15. **Update NotificationListener**: Remove `session-ready` event listener. Keep `conversation-status`.

16. **Clean up queries/keys**: Remove `useHooksStatusQuery` from `queries.ts`. Remove `hooksKeys` from `query-keys.ts`.

### Phase 7: Cleanup

17. **Remove `install-hooks` script from `package.json`**.

18. **Run typecheck**: `bun run typecheck` — fix any remaining type errors from removed imports/types.

19. **Run tests**: `bun run test` — fix any failing tests. Expect failures in deleted test files (already removed) and in tests that mock removed modules.

20. **Run lint**: `bun run lint` — fix any lint issues.

## Error Handling Strategy

| Scenario | Handling |
|----------|----------|
| SDK `query()` throws on spawn | Catch in the `for await` wrapper → emit `error` + `done` |
| SDK result with `is_error: true` | Map subtype to human message → emit `error` |
| Transcript write fails | Log warning, continue (non-fatal — prompt still works) |
| Client disconnects mid-stream | `AbortSignal` fires → `q.close()` → loop ends naturally → cleanup runs in `finally` |
| Lock contention | Unchanged — API routes return 409 before calling `executePromptStream` |
| Session not found | Unchanged — API routes return 404 |
| Missing Claude Code CLI | SDK throws on initialization → caught → emit `error` with descriptive message |

## Testing Requirements

### New tests needed
- `prompt.ts`: Mock `query()` from SDK, verify:
  - Correct SDK options are passed (systemPrompt, settingSources, cwd, etc.)
  - SSE events emitted correctly for each SDK message type
  - Transcript entries written for each message
  - Conversation metadata updated on completion (cost, sessionId, transcriptPath)
  - Error results mapped correctly
  - Lock acquired/released correctly
  - AbortSignal triggers q.close()

- `transcript.ts`: Test:
  - `appendTranscriptEntry` creates file and appends lines
  - `readConversationMessages` parses entries correctly
  - Handles missing/empty files gracefully
  - Slash command detection preserved

### Existing tests to update
- `conversations.test.ts`: Remove discovery/import test blocks
- `format-tool-use.test.ts`: Rename from stream-events, keep formatToolUse tests

### Tests to delete entirely
- `hooks-detection.test.ts`
- `hooks-route.test.ts`
- `install-hooks.test.ts`

## Configuration Reference

For clarity, the complete set of SDK options that ensures feature parity with the current CLI invocation:

| Current CLI flag | SDK option | Value |
|-----------------|-----------|-------|
| `--model opus` | `model` | `effectiveModel` (from config/prompt) |
| `--resume <id>` | `resume` | `conversation.claudeSessionId` |
| `-p "<text>"` | `prompt` (top-level) | `promptText` |
| `--dangerously-skip-permissions` | `permissionMode` + `allowDangerouslySkipPermissions` | `"bypassPermissions"` + `true` |
| `--output-format stream-json` | N/A (SDK streams natively) | — |
| `--verbose` | N/A (SDK provides all message types) | — |
| `--max-turns 50` | `maxTurns` | `config.maxTurns ?? 50` |
| `cwd: session.worktreePath` | `cwd` | `session.worktreePath` |
| Filter CLAUDE* env vars | `env` | `{ CLAUDECODE: "" }` |
| _(not set — CLI loads automatically)_ | `systemPrompt` | `{ type: "preset", preset: "claude_code" }` |
| _(not set — CLI loads automatically)_ | `settingSources` | `["user", "project", "local"]` |
| _(not set)_ | `persistSession` | `true` |
