# Stream-JSON Prompt Execution Implementation Plan

## Overview

Replace the current buffered `--output-format json` prompt execution with `--output-format stream-json` to enable real-time display of Claude's text responses and tool uses in the UI. The current approach waits for the entire CLI run to complete, then stores a single `result` string. The new approach streams events (text, tool_use, tool_result) from the CLI via SSE to the client, rendering each block as it arrives — matching the interactive Claude Code terminal experience.

This is a **full migration** — no backward compatibility with the old `content: string` message format. Existing session messages are cleared on upgrade. The old `executePrompt` function is deleted and replaced entirely.

**Key architectural changes:**
- `child_process.spawn` replaces `execFile` for streaming stdout line-by-line
- API route returns an SSE `text/event-stream` response instead of JSON
- Client reads the stream via `fetch` + `ReadableStream` reader (not EventSource, since we need POST)
- Message content is always `MessageContentBlock[]` (never a plain string)
- All messages (user and assistant) use the content block format: user messages are `[{ type: "text", text: "..." }]`
- Old `executePrompt` is deleted, replaced by `executePromptStream`
- New `MessageContent` component renders text blocks with markdown and tool_use blocks as compact indicators

## Architecture

```
User submits prompt
  → SessionDetailPage: POST fetch (streaming)
    → API route: creates ReadableStream SSE response
      → executePromptStream(): spawn claude --output-format stream-json
        → readline on stdout, parse each JSON line
        → emit SSE events: init, content, result, error, done
      → SSE events flow to client
    → Client: reads stream, accumulates content blocks
    → UI: renders text + tool indicators in real-time
  → On completion: persist accumulated message to state.json
```

## File Structure

```
src/
  lib/
    stream-events.ts          ← NEW: types + parser for stream-json events
    prompt.ts                 ← REWRITE: replace executePrompt with executePromptStream
    schemas.ts                ← MODIFY: add MessageContentBlock, change ConversationMessage.content to block array
    transcript.ts             ← REVERT: undo earlier content-block changes, restore original
    transcript.test.ts        ← REVERT: restore original test expectations
  types/
    index.ts                  ← MODIFY: TranscriptMessage.content becomes MessageContentBlock[]
  components/
    MessageContent.tsx         ← NEW: renders MessageContentBlock[] content
    MarkdownContent.tsx        ← UNCHANGED
  app/
    api/projects/[name]/sessions/[session]/prompt/
      route.ts                ← REWRITE: SSE streaming response
    projects/[name]/[session]/
      page.tsx                ← MODIFY: pass messages with block array content
      SessionDetailPage.tsx   ← MODIFY: streaming fetch, accumulate blocks, render
    globals.css               ← MODIFY: add tool-use-indicator styles
```

## Schema Changes — `src/lib/schemas.ts`

Add a discriminated union for message content blocks:

```typescript
export const messageContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    name: z.string(),
    input: z.any().optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.string().optional(),
  }),
]);
export type MessageContentBlock = z.infer<typeof messageContentBlockSchema>;
```

Replace `conversationMessageSchema.content` — no union, always block array:

```typescript
export const conversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(messageContentBlockSchema),
  timestamp: z.string(),
});
```

User messages use `[{ type: "text", text: "the prompt" }]`. Assistant messages use arrays of text, tool_use, and tool_result blocks.

Revert the earlier changes to `contentBlockSchema` (remove `name`, `id`, `input`, `tool_use_id`, `content` fields that were added). Restore it to the original minimal form used by `transcriptEntrySchema`:

```typescript
export const contentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});
```

## Type Changes — `src/types/index.ts`

Update `TranscriptMessage` — content is always block array:

```typescript
import type { MessageContentBlock } from "@/lib/schemas";

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: MessageContentBlock[];
  timestamp: string | null;
}
```

Export `MessageContentBlock` from the re-exports section.

Remove `RunPromptResponse` interface — the prompt endpoint no longer returns JSON.

## State Migration

Existing sessions have `messages` with `content: string`. Since we're doing a full migration:

**On state load** (`src/lib/state.ts`), if any session has messages with string content, clear that session's `messages` array to `[]`. This is simpler than converting old messages to the new format. Implement as a one-time migration in `readState()`:

- After parsing, iterate all sessions
- For each session with messages, check if any message has `content` that is a string (not an array)
- If so, set `messages` to `[]` and persist the migrated state

Use `z.preprocess` on the `content` field in `conversationMessageSchema` to handle the migration at the Zod level: if `content` is a string, transform it to `[{ type: "text", text: content }]`. This way existing state parses cleanly without a separate migration step.

```typescript
content: z.preprocess(
  (val) =>
    typeof val === "string" ? [{ type: "text" as const, text: val }] : val,
  z.array(messageContentBlockSchema),
),
```

## Stream Events Module — NEW `src/lib/stream-events.ts`

**Responsibility:** TypeScript types for stream-json events, a line parser, and tool-use formatting.

### Types

```typescript
export interface StreamInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
}

export interface StreamAssistantEvent {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<{ type: string; [key: string]: unknown }>;
  };
}

export interface StreamUserEvent {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: string; [key: string]: unknown }>;
  };
}

export interface StreamResultEvent {
  type: "result";
  subtype: "success";
  session_id: string;
  cost_usd?: number;
  num_turns?: number;
}

export type StreamEvent =
  | StreamInitEvent
  | StreamAssistantEvent
  | StreamUserEvent
  | StreamResultEvent;
```

### `parseStreamLine(line: string): StreamEvent | null`

- JSON.parse the line inside a try/catch, return `null` on failure
- Check `.type` field — return typed events for `system` (subtype `init`), `assistant`, `user`, `result`
- Return `null` for unrecognized types (e.g., `progress`, `file-history-snapshot`)

### `formatToolUse(name: string, input: any): string`

Move the `formatToolUse` logic from `transcript.ts` into this shared module (then remove it from transcript.ts). Formatting rules:

| Tool | Format |
|---|---|
| `Read` | `Read <file_path>` |
| `Write` | `Write <file_path>` |
| `Edit` / `MultiEdit` | `Edit <file_path>` |
| `Bash` | `Bash: <description>` or `Bash: <command[:50]>` |
| `Grep` | `Search for "<pattern>"` |
| `Glob` | `Find files matching "<pattern>"` |
| `Task` | `Task: <description[:50]>` |
| Default | Tool name only |

## Prompt Module — REWRITE `src/lib/prompt.ts`

**Delete `executePrompt` entirely.** Replace with `executePromptStream`.

```typescript
export async function executePromptStream(
  projectPath: string,
  session: SessionState,
  promptText: string,
  emit: (event: string, data: unknown) => void,
): Promise<void>
```

**`emit` callback** — called with SSE event name and JSON-serializable data. The API route wires this to the SSE response writer.

**Implementation flow:**

1. Acquire session lock via `acquireSessionLock`
2. Mark session as `running`, push user message to `session.messages` using block format: `{ role: "user", content: [{ type: "text", text: promptText }], timestamp: now }`
3. Build CLI args: `["-c" if promptCount > 0, "-p", promptText, "--dangerously-skip-permissions", "--output-format", "stream-json", "--max-turns", "50"]`
4. `spawn("claude", args, { cwd: session.worktreePath, env: filteredEnv })`
5. Immediately `child.stdin?.end()`
6. Set up a manual timeout: `setTimeout(() => child.kill("SIGTERM"), config.claudeTimeoutMs)`. Clear on process exit.
7. Create `readline.createInterface({ input: child.stdout })` for line-by-line parsing
8. Initialize accumulator: `const contentBlocks: MessageContentBlock[] = []`
9. For each line, call `parseStreamLine(line)`:
   - `system` init → extract `sessionId`, emit `("init", { sessionId })`
   - `assistant` → for each content block in `message.content`:
     - `type: "text"` → push `{ type: "text", text }` to accumulator, emit `("content", { type: "text", text })`
     - `type: "tool_use"` → push `{ type: "tool_use", name, input }` to accumulator, emit `("content", { type: "tool_use", name, input })`
   - `user` (tool_result) → skip emit (internal), but log for debugging
   - `result` → extract `session_id`, emit `("result", { sessionId: session_id })`
10. Capture stderr in a buffer (via `child.stderr` data events) for error logging
11. Listen to `child.on("close", (code) => ...)`:
    - Clear timeout
    - If `contentBlocks.length > 0`, store assistant message via `mutateSession(...)` with `content: contentBlocks`, increment `promptCount`, set `claudeSessionId`
    - If `code !== 0` and `contentBlocks.length === 0`, emit `("error", { message: "Claude exited with code ${code}" })`
    - Emit `("done", {})`
12. In `finally` block: reset status to `"ready"`, release lock

**Changes from the deleted `executePrompt`:**
- Uses `spawn` instead of `execFile` (streaming vs buffered)
- `--output-format stream-json` instead of `--output-format json`
- No `maxBuffer` needed (streaming doesn't buffer)
- Manual timeout implementation (spawn doesn't support `timeout` option)
- Stores `content: MessageContentBlock[]` instead of `content: string`
- User messages stored as `[{ type: "text", text }]` instead of bare string

## API Route — REWRITE `src/app/api/.../prompt/route.ts`

The POST handler keeps validation and guards (project exists, session exists, not busy, valid body). Replace the `executePrompt` call and JSON response with SSE streaming:

```typescript
const encoder = new TextEncoder();
const stream = new ReadableStream({
  async start(controller) {
    const emit = (event: string, data: unknown) => {
      try {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      } catch {
        // Client disconnected — safe to ignore
      }
    };

    try {
      await executePromptStream(projectPath, session, body.prompt.trim(), emit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Prompt failed";
      emit("error", { message: msg });
    } finally {
      emit("done", {});
      controller.close();
    }
  },
});

return new Response(stream, {
  headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  },
});
```

Remove `RunPromptResponse` import. Import `executePromptStream` (not `executePrompt`).

## Page Server Component — `src/app/projects/[name]/[session]/page.tsx`

Update the message mapping — content is now always `MessageContentBlock[]`:

```typescript
const messages: TranscriptMessage[] = (sessionState.messages ?? []).map((m) => ({
  role: m.role,
  content: m.content,
  timestamp: m.timestamp,
}));
```

No type assertion needed — both sides are `MessageContentBlock[]`.

## Client UI Changes — `SessionDetailPage.tsx`

### Update `optimisticMessages` type

Change from `TranscriptMessage[]` to match the new content type. The optimistic user message uses block format:

```typescript
{ role: "user", content: [{ type: "text" as const, text }], timestamp: new Date().toISOString() }
```

### Replace `handleSendPrompt`

Instead of awaiting a JSON response, open a streaming fetch:

1. Add user message optimistically using block format
2. Set `setSending(true)`
3. `const res = await tracedFetch(url, "send-prompt", { method: "POST", ... })`
4. If `!res.ok`, the response is still JSON (from the validation guards) — parse and show error
5. Get `const reader = res.body!.getReader()` and `const decoder = new TextDecoder()`
6. Initialize `streamBlocks: MessageContentBlock[] = []`
7. Read chunks in a loop, split on `\n\n` to extract SSE events, parse `event:` and `data:` lines
8. For `content` events:
   - Push the content block to `streamBlocks`
   - Update `optimisticMessages` to include the growing assistant message: `{ role: "assistant", content: [...streamBlocks], timestamp: new Date().toISOString() }`
9. For `error` events: `setPromptError(data.message)`
10. For `done` events: break the loop
11. In finally: `setSending(false)`, `router.refresh()` to sync server state

### SSE parsing helper

Inline in the component or extract to a utility. Parse the SSE text format:

```
event: content
data: {"type":"text","text":"Let me check..."}

event: content
data: {"type":"tool_use","name":"Read","input":{"file_path":"src/lib/auth.ts"}}

event: done
data: {}
```

Buffer partial chunks across reads. Split on `\n\n` for complete events. Extract event name from `event:` line and JSON from `data:` line.

### Update optimistic message reconciliation

The current `serverHasIt` check compares `m.content === lastOptimistic.content`. This doesn't work for array content. Replace with a count-based approach: track `messageCountBeforeSubmit` and clear optimistic messages when `messages.length > messageCountBeforeSubmit`.

### Replace typing indicator during streaming

Currently shows animated dots while `sending`. During streaming, the assistant message with accumulated blocks renders in real-time, replacing the need for a typing indicator. Show the typing dots only *before* the first content block arrives (i.e., when `sending` is true but no streamed assistant message exists in `optimisticMessages`).

### Update message rendering

Replace `<MarkdownContent content={msg.content} />` (line 455) with `<MessageContent content={msg.content} />`.

## MessageContent Component — NEW `src/components/MessageContent.tsx`

```typescript
interface Props {
  content: MessageContentBlock[];
}
```

**Rendering logic** — iterate each block:

- `type: "text"` → `<MarkdownContent content={block.text} />`
- `type: "tool_use"` → tool indicator element (see CSS below)
- `type: "tool_result"` → skip (not rendered)

**Tool indicator markup:**

```html
<div class="tool-use-indicator">
  <span class="tool-use-icon">⚙</span>
  <span class="tool-use-label">{formatToolUse(block.name, block.input)}</span>
</div>
```

Import `formatToolUse` from `@/lib/stream-events`.

## CSS Changes — `src/app/globals.css`

Add after the existing `.message-content` styles block (around line 1707):

```css
.tool-use-indicator {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-xs) var(--space-sm);
  margin: var(--space-xs) 0;
  background: var(--bg-raised);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text-secondary);
  border-left: 2px solid var(--cyan-dim);
}

.tool-use-icon {
  color: var(--cyan-dim);
  font-size: 0.85rem;
  flex-shrink: 0;
}

.tool-use-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

## Implementation Order

1. **`src/lib/stream-events.ts`** — Create types, `parseStreamLine`, `formatToolUse`. No dependencies on other changes. Write tests in `stream-events.test.ts`.
2. **`src/lib/schemas.ts`** — Add `messageContentBlockSchema`. Change `conversationMessageSchema.content` to `z.preprocess(...)` + `z.array(messageContentBlockSchema)`. Revert `contentBlockSchema` to original minimal form.
3. **`src/types/index.ts`** — Change `TranscriptMessage.content` to `MessageContentBlock[]`. Export `MessageContentBlock`. Remove `RunPromptResponse`.
4. **`src/lib/transcript.ts`** — Revert all earlier changes. Restore original `extractContent` that only handles text blocks. Remove `formatToolUse` (now lives in `stream-events.ts`).
5. **`src/lib/transcript.test.ts`** — Revert to original test expectations (text blocks only).
6. **`src/lib/prompt.ts`** — Delete `executePrompt`. Write `executePromptStream` using `spawn`. Import from `stream-events.ts`.
7. **`src/app/api/.../prompt/route.ts`** — Rewrite to SSE streaming response using `executePromptStream`. Remove `RunPromptResponse` import.
8. **`src/components/MessageContent.tsx`** — Create component. Import `MarkdownContent` and `formatToolUse`.
9. **`src/app/globals.css`** — Add `.tool-use-indicator` styles.
10. **`src/app/projects/[name]/[session]/page.tsx`** — Update message mapping for new content type.
11. **`src/app/projects/[name]/[session]/SessionDetailPage.tsx`** — Rewrite `handleSendPrompt` for streaming, update optimistic messages to use block format, update message rendering to use `MessageContent`, fix optimistic reconciliation, update typing indicator logic.

## Error Handling

| Scenario | Handling |
|---|---|
| CLI exits non-zero with content | Store accumulated blocks, emit done (not error) |
| CLI exits non-zero with no content | Emit error event, don't store empty message |
| CLI timeout | Kill process with SIGTERM, emit error, store any partial content |
| JSON parse failure on stdout line | Skip line, log warning, continue |
| Client disconnects mid-stream | Process continues to completion, state still persisted. Wrap `controller.enqueue` in try/catch. |
| Missing `result` event (known bug) | Don't depend on it. Use process `close` event as the primary completion signal. |
| Lock contention | Return 409 JSON before starting stream (same as current) |
| stderr output | Buffer and log, don't include in SSE |

## Testing

### `src/lib/stream-events.test.ts` (new)
- `parseStreamLine` returns correct types for init, assistant, user, result events
- `parseStreamLine` returns null for malformed JSON
- `parseStreamLine` returns null for unrecognized event types (progress, file-history-snapshot)
- `formatToolUse` formats each tool type correctly

### `src/lib/prompt.test.ts` (rewrite)
- Delete all existing `executePrompt` tests
- New tests for `executePromptStream` that mock `spawn` instead of `execFile`
- Test: emits init event from system message
- Test: emits content events for text blocks
- Test: emits content events for tool_use blocks
- Test: accumulates and stores message with `MessageContentBlock[]` content on completion
- Test: user message stored in block format `[{ type: "text", text }]`
- Test: handles non-zero exit with accumulated content
- Test: handles timeout

### `src/lib/transcript.test.ts`
- Revert to original test expectations

### Manual testing
- Send a prompt, verify text streams in real-time
- Send a prompt that triggers tool uses, verify tool indicators appear
- Verify conversation persists after page refresh
- Verify old sessions have their messages auto-migrated (string → block array) via `z.preprocess`
- Test error scenarios (cancel mid-stream, timeout)
