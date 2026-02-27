# Gap Analysis — Conversation Forking

## Current State Investigation

### Existing Assets

| Asset | File | Purpose |
|-------|------|---------|
| ConversationState schema | `src/lib/schemas.ts:63-78` | Defines conversation data shape |
| createConversation() | `src/lib/conversations.ts:12-57` | Creates new conversation in session state |
| getConversation() | `src/lib/conversations.ts:59-73` | Retrieves conversation by ID |
| mutateConversation() | `src/lib/conversations.ts` | Atomic mutation of conversation fields |
| readConversationMessages() | `src/lib/transcript.ts:102-148` | Reads JSONL transcript into TranscriptMessage[] |
| appendTranscriptEntry() | `src/lib/transcript.ts:58-65` | Appends a single JSONL entry |
| getTranscriptPath() | `src/lib/transcript.ts:42-48` | Returns `~/.config/cc/transcripts/{id}.jsonl` |
| executePromptStream() | `src/lib/prompt.ts:48-361` | SDK query execution with SSE streaming |
| processMessage() | `src/lib/prompt.ts:393-518` | SDK message → transcript/SSE translation |
| useSendPrompt() | `src/hooks/use-send-prompt.ts` | Client-side prompt dispatch hook |
| SessionDetailPage | `src/app/.../SessionDetailPage.tsx` | Full conversation UI with virtualizer |
| ConversationSidebar | `src/app/.../ConversationSidebar.tsx` | Conversation list with tabs |
| MessageActions | `src/components/MessageActions.tsx` | **Already created** — hover action bar |
| MessageEditor | `src/components/MessageEditor.tsx` | **Already created** — inline editor |
| MessageActions CSS | `src/app/globals.css` | **Already created** — styles for both |

### Key SDK Capability: Built-in Fork Support

The `@anthropic-ai/claude-agent-sdk` `query()` API has **native forking support**:

```typescript
query({
  prompt: "...",
  options: {
    resume: originalSessionId,    // Resume from original conversation
    forkSession: true,            // Fork to new session ID (don't mutate original)
    resumeSessionAt: messageUUID, // Resume up to specific message UUID
  }
})
```

This means CC does **not** need to manually replay conversation history. The SDK handles loading and forking the conversation context internally via `persistSession` data stored in `~/.claude/projects/`.

### Conventions Observed

- **State mutations**: Read-mutate-write pattern via `readState()` → modify → `writeState()`, or per-entity via `mutateConversation()`
- **Transcript**: JSONL append-only, one file per conversation at `{transcriptsDir}/{conversationId}.jsonl`
- **API routes**: REST-style under `/api/projects/[name]/sessions/[session]/conversations/[conversationId]/...`
- **ID generation**: `crypto.randomUUID()` for all entity IDs
- **Navigation**: URL-based (`/projects/{name}/{session}/{conversationId}`)

---

## Requirements Feasibility Analysis

### Requirement-to-Asset Map

| Requirement | Needed | Existing | Gap |
|-------------|--------|----------|-----|
| **1.1** Fork creates new conversation with messages up to fork point | createConversation(), transcript.ts | No fork-specific creation | **New**: `forkConversation()` function |
| **1.2** New conversation gets unique ID, null claudeSessionId, new JSONL | createConversation() | Already generates UUID/null session | **Extend**: Copy transcript subset to new file |
| **1.3** Navigate to new conversation | URL-based navigation | Already works | **None** — just router.push() |
| **1.4** Disable fork while running | `isBusy` flag | Already used for prompt disable | **Minor**: Pass as `disabled` prop |
| **1.5** Fork only on user messages | MessageActions component | Already scoped to user role | **None** |
| **2.1** Inline editor on edit trigger | MessageEditor component | **Already created** | **Integrate**: Add to message render loop |
| **2.2** Edit creates fork with modified message | — | No edit+fork logic | **New**: Fork API with optional `editedText` param |
| **2.3** Auto-send edited prompt | useSendPrompt | Existing send mechanism | **Extend**: Chain fork creation + prompt send |
| **2.4** Cancel restores display | MessageEditor | Already supports cancel | **Minor**: Reset `editingIndex` state |
| **2.5** Unchanged save = direct fork | — | — | **Logic**: Detect unchanged text in fork handler |
| **3.1** `forkedFrom` field on ConversationState | conversationStateSchema | **Missing** | **Extend schema**: Add optional `forkedFrom` field |
| **3.2** Independent JSONL transcript | appendTranscriptEntry() | Can write to any path | **New**: Copy transcript lines to new file |
| **3.3** promptCount starts at 0 | createConversation() | Already starts at 0 | **None** |
| **3.4** Delete doesn't affect original | Delete conversation logic | Already independent per ID | **None** |
| **3.5** Default fork name | createConversation() | Uses sequential numbering | **Extend**: Accept optional name parameter |
| **4.1** Pass history on first prompt | SDK `resume` + `forkSession` + `resumeSessionAt` | **SDK supports natively** | **Extend prompt.ts**: Use SDK fork params |
| **4.2** Subsequent prompts use claudeSessionId | Already implemented | Works as-is | **None** |
| **4.3** History from own transcript | readConversationMessages() | Already reads from conversation's own file | **None** |
| **5.1-5.5** Hover actions UI | MessageActions component + CSS | **Already created** | **Integrate**: Add to virtualizer render loop |
| **6.1** Fork indicator in sidebar | ConversationSidebar | No fork indicator | **Extend**: Render icon when `forkedFrom` exists |
| **6.2** Fork tooltip in sidebar | ConversationSidebar | No tooltip | **Add**: Tooltip with source info |
| **6.3** Fork in same list | ConversationSidebar | Already lists all conversations | **None** |

### Critical Finding: SDK Message UUIDs

The SDK's `resumeSessionAt` requires the `uuid` from `SDKAssistantMessage`. CC currently **does not store** this UUID in transcript entries — it only stores `role`, `content`, and `timestamp`.

**Options**:
- **Option A**: Store `uuid` in transcript entries going forward (extend `TranscriptEntry` type). Forking only works for conversations created after this change.
- **Option B**: Don't use `resumeSessionAt`. Instead, use `resume` + `forkSession` without specifying a point — the SDK resumes the full conversation, and CC truncates its own transcript. The new prompt sent to the forked session provides the divergence point.
- **Option C**: Store the `uuid` and also backfill from the `raw` field in existing transcript entries (system/result entries already store the full SDK message which includes `uuid`).

**Recommendation**: Option B is simplest — fork the entire SDK session and send the new/edited prompt. The SDK handles context. CC only needs to manage its own transcript (copy up to fork point). Future enhancement could add `resumeSessionAt` for efficiency.

### Complexity Signals

- **Conversation creation**: Simple CRUD — extend existing pattern
- **Transcript copying**: File I/O — read JSONL, write subset to new file
- **SDK fork integration**: Single parameter addition to existing `query()` call
- **UI integration**: Component composition — wire existing components into render loop
- **State management**: Add 1-2 fields to Zustand store

---

## Implementation Approach Options

### Option A: Extend Existing Components (Recommended)

**Which files to extend**:
- `src/lib/schemas.ts` — Add `forkedFrom` field to `conversationStateSchema`
- `src/lib/conversations.ts` — Add `forkConversation()` function
- `src/lib/transcript.ts` — Add `copyTranscriptUpTo()` function
- `src/lib/prompt.ts` — Pass `forkSession: true` + `resume` when conversation has `forkedFrom`
- `src/app/api/.../conversations/[conversationId]/fork/route.ts` — New API route (only new file)
- `src/app/.../SessionDetailPage.tsx` — Wire MessageActions/MessageEditor into render loop
- `src/app/.../ConversationSidebar.tsx` — Add fork indicator
- `src/stores/session-detail.store.ts` — Add `editingIndex` state field

**Compatibility**: All changes are additive — existing conversations unaffected.

**Trade-offs**:
- ✅ Leverages all existing patterns (state management, transcript I/O, SDK integration)
- ✅ Minimal new files (only 1 new API route)
- ✅ SDK native fork support eliminates complexity of history replay
- ❌ SessionDetailPage grows larger (already ~900 lines)

### Option B: Create New Module

Extract forking into a dedicated `src/lib/fork.ts` module with all fork logic (create, transcript copy, SDK params). New components for fork-specific UI.

**Trade-offs**:
- ✅ Clean separation of fork logic
- ❌ More files, more indirection
- ❌ Fork logic is tightly coupled to existing conversation/prompt flows

### Option C: Hybrid (Extend + Extract)

Extend schemas and UI in place. Extract fork business logic into `src/lib/fork.ts` to keep `conversations.ts` and `prompt.ts` focused.

**Trade-offs**:
- ✅ Keeps existing files manageable
- ✅ Fork logic testable in isolation
- ❌ Slightly more files but cleaner responsibility boundaries

---

## Implementation Complexity & Risk

**Effort: M (3-7 days)** — Uses existing patterns throughout. SDK native fork support eliminates the hardest part (conversation history management). Main work is wiring UI components, a new API route, and transcript copying.

**Risk: Low-Medium** — SDK `forkSession` + `resume` is documented but untested in CC context. The `claudeSessionId` must be available for forking (won't work for conversations that never ran a prompt). Edge cases around mid-stream forking need handling.

---

## Recommendations for Design Phase

### Preferred Approach
**Option A (Extend)** with one extraction: put `forkConversation()` and `copyTranscriptUpTo()` in `src/lib/conversations.ts` alongside existing conversation logic. This avoids a new module while keeping the fork logic adjacent to related code.

### Key Design Decisions
1. **SDK fork strategy**: Use `resume` + `forkSession: true` (skip `resumeSessionAt` for v1)
2. **Edit-and-fork flow**: Create fork first, then send edited prompt as normal prompt to the new conversation
3. **Transcript handling**: Copy JSONL lines up to fork point to new file; for edit-and-fork, exclude the original user message and append the edited one

### Research Items
- Verify `forkSession: true` behavior with the current SDK version (test with a real session)
- Confirm `claudeSessionId` is always available for conversations that have been prompted (it is — set from system `init` message)
- Determine if `forkSession` returns a new `session_id` in the response (expected from init message)
