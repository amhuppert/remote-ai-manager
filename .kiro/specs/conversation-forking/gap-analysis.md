# Gap Analysis — Conversation Forking

## Current State Investigation

### Existing Assets

| Asset | File | Purpose |
|-------|------|---------|
| ConversationState schema | `src/lib/conversations/schemas.ts` | Defines conversation data shape with `forkedFrom`, `pendingPromptText`, `backendRef` |
| createConversation() | `src/lib/conversations/service.ts` | Creates new conversation in session state |
| getConversation() | `src/lib/conversations/service.ts` | Retrieves conversation by ID |
| mutateSession() | `src/lib/conversations/service.ts` | Atomic mutation of session and its conversations |
| forkConversation() | `src/lib/conversations/service.ts` | Fork creation with the four cases (assistant inclusive, user idx>0 exclusive, user idx 0 brand-new, synthetic fallback) |
| readConversationMessages() | `src/lib/prompt/transcript.ts` | Reads JSONL transcript into `TranscriptMessage[]` |
| appendTranscriptEntry() | `src/lib/prompt/transcript.ts` | Appends a single JSONL entry |
| copyTranscriptUpTo() | `src/lib/prompt/transcript.ts` | Mode-driven (`inclusive`/`exclusive`) transcript subset copy |
| findForkAnchorUuid() | `src/lib/prompt/transcript.ts` | Resolves the SDK message UUID at a fork boundary |
| buildSyntheticForkSeed() | `src/lib/prompt/transcript.ts` | Serializes local transcript into a single-shot prompt seed |
| forkSession() | `@anthropic-ai/claude-agent-sdk` (consumed in `src/lib/conversations/service.ts`) | Native eager SDK session fork |
| getTranscriptPath() | `src/lib/prompt/transcript.ts` | Returns the per-conversation JSONL path under the configured `transcripts/` dir |
| executePromptStream() | `src/lib/prompt/route-handlers.ts` | SDK query execution with SSE streaming |
| useSendPrompt() | `src/hooks/use-send-prompt.ts` | Client-side prompt dispatch hook |
| ConversationDetailPage | `src/app/projects/[name]/[session]/ConversationDetailPage.tsx` | Full conversation UI: virtualized list, persistent prompt input, fork wiring |
| ConversationSidebar | `src/app/.../ConversationSidebar.tsx` | Conversation list with fork indicator |
| MessageActions | `src/components/MessageActions.tsx` | Per-message action bar (Copy + Fork) |
| Pending-prompt route handlers | `src/lib/pending-prompt-route-handlers.ts` | Server side of the persistent prompt input feature |

### Key SDK Capability: Native Fork

The `@anthropic-ai/claude-agent-sdk` exposes a top-level `forkSession()` helper that creates a new SDK session derived from an existing one, optionally up to a specific message UUID:

```typescript
const { sessionId } = await forkSession(sourceSessionId, {
  dir: projectPath,
  upToMessageId: anchorUuid, // optional
});
```

CC invokes this **eagerly** at fork time so the new conversation owns its own session file from the moment it is created, decoupled from later mutations of the source.

### Conventions Observed

- **State mutations**: Read-mutate-write pattern via `mutateSession()` operating on the in-memory state aggregate persisted to SQLite.
- **Transcript**: JSONL append-only, one file per conversation under the configured `transcripts/` dir.
- **API routes**: REST under `/api/projects/[name]/sessions/[session]/conversations/[conversationId]/...`.
- **ID generation**: `crypto.randomUUID()` for all entity IDs.
- **Navigation**: URL-based (`/projects/{name}/{session}/{conversationId}`).

---

## Requirements Feasibility Analysis

### Requirement-to-Asset Map

| Requirement | Needed | Existing | Status |
|-------------|--------|----------|--------|
| **1.1** Fork creates new conversation with messages up to fork point | createConversation, transcript copy | `forkConversation()` + `copyTranscriptUpTo({mode})` | **Implemented** |
| **1.2** New ID, own SDK session (cases a/b) or none (cases c/d), new JSONL | `forkConversation()` | Cases a/b: eager `forkSession()`; cases c/d: no SDK fork | **Implemented** |
| **1.3** Navigate to new conversation | URL-based navigation | `router.push()` in fork handler | **Implemented** |
| **1.4** Disable fork while running | `isBusy`/`isReadOnly` gating | Passed as `disabled` prop to MessageActions | **Implemented** |
| **1.5** Fork available on user and assistant messages | MessageActions component | Rendered for both roles | **Implemented** |
| **3.1** `forkedFrom` field on ConversationState | conversationStateSchema | Extended with the full `forkedFrom` object | **Implemented** |
| **3.2** Independent JSONL transcript per fork | `copyTranscriptUpTo()` | One file per conversation | **Implemented** |
| **3.3** promptCount starts at 0 | `forkConversation()` | Already starts at 0 | **Implemented** |
| **3.4** Delete doesn't affect original | Existing delete logic | Already independent per ID | **Implemented** |
| **3.5** Default fork name | `forkConversation()` | `"Fork of {sourceName} @ turn {n}"` | **Implemented** |
| **4.1** Eager SDK fork at fork time (cases a/b) | SDK `forkSession()` | Called from `forkConversation()` | **Implemented** |
| **4.2** Subsequent prompts use forked session's own id | Existing prompt flow | Already works (`backendRef` carries the forked session id) | **Implemented** |
| **4.3** History from own transcript | `readConversationMessages()` | Already reads from conversation's own file | **Implemented** |
| **4.4** Compaction-resilient synthetic fallback | `buildSyntheticForkSeed()` + `syntheticForkSeed` turn input | Falls back when `forkSession()` throws | **Implemented** |
| **5.1** Persistent prompt input across navigation | `pendingPromptText` + pending-prompt route + `ConversationDetailPage` | Debounced PUT, hydrated on mount | **Implemented** |
| **5.2** Persistent prompt input across reload | Same as 5.1 + `sendBeacon` flush on unload | Best-effort flush on `beforeunload` | **Implemented** |
| **5.3** Submit clears pending prompt | Existing prompt flow | Cleared client-side and server-side on send | **Implemented** |
| **6.1** Fork indicator in sidebar | ConversationSidebar | Renders icon when `forkedFrom != null` | **Implemented** |
| **6.2** Fork tooltip in sidebar | ConversationSidebar | Tooltip with source info | **Implemented** |
| **6.3** Synthetic-fallback indicator on conversation header | ConversationDetailPage | Shown when `forkedFrom.forkMode === "synthetic"` | **Implemented** |

### Critical Finding: SDK Message UUIDs and Fork Anchors

The SDK's `forkSession()` `upToMessageId` parameter requires a message UUID from the source SDK session's transcript. CC's own transcript stores these UUIDs in the raw SDK entries. `findForkAnchorUuid()` resolves the right UUID at a given fork boundary using the same `mode` semantics as `copyTranscriptUpTo()`:

- `mode: "inclusive"` — return the UUID of the message at `atMessageIndex`.
- `mode: "exclusive"` — return the UUID of the message immediately before `atMessageIndex`.

For case (c) (user idx 0) and case (d) (synthetic fallback), no anchor is needed.

### Compaction Resilience

If the source SDK session file has been compacted away or removed by the time the fork is requested, `forkSession()` will throw. `forkConversation()` catches this and falls back:

1. Build a synthetic seed via `buildSyntheticForkSeed(sourceTranscriptPath, messageIndex)`.
2. If the seed is null (transcript unreadable or empty), throw `ForkCreationError("fork_failed", …)` — the fork is not created.
3. Otherwise, prepend the seed to `pendingPromptText`, mark `forkMode = "synthetic"`, and leave `backendRef` null. The next prompt sent from the forked conversation will create a brand-new SDK session primed by the seed (consumed via the backend's `syntheticForkSeed` turn input field).

### Complexity Signals

- **Conversation creation**: Simple CRUD — extends existing patterns.
- **Transcript copying**: File I/O with mode-driven inclusion.
- **SDK fork integration**: One eager helper call at fork time.
- **Synthetic fallback**: Serialization plus a turn-input field on the backend abstraction.
- **Persistent prompt input**: Debounced PUT plus `sendBeacon` flush.

---

## Implementation Approach Options

### Option A: Extend Existing Components (Chosen)

**Which files extended**:
- `src/lib/conversations/schemas.ts` — Added `forkedFrom` (with `forkMode`, `sourceBackend`, `sourceBackendRef`, `forkLocator`) and `pendingPromptText` fields.
- `src/lib/conversations/service.ts` — `forkConversation()` covering all four cases.
- `src/lib/prompt/transcript.ts` — `copyTranscriptUpTo({mode})`, `findForkAnchorUuid`, `buildSyntheticForkSeed`.
- `src/app/api/.../fork/route.ts` — Fork API route.
- `src/app/api/.../pending-prompt/route.ts` + `src/lib/pending-prompt-route-handlers.ts` — Pending-prompt route.
- `src/app/.../ConversationDetailPage.tsx` — Wired MessageActions, persistent prompt input, synthetic-fallback indicator.
- `src/app/.../ConversationSidebar.tsx` — Fork indicator.

**Compatibility**: All changes are additive — existing conversations parse cleanly via nullable/default schema fields.

**Trade-offs**:
- ✅ Leverages existing patterns (state management, transcript I/O, SDK integration).
- ✅ Eager `forkSession()` avoids any lazy-fork bookkeeping on the prompt path.
- ✅ Synthetic fallback keeps the feature robust against compaction.
- ❌ `ConversationDetailPage` grows.

### Option B: Create New Module

Extract forking into a dedicated `src/lib/fork.ts` module. Not chosen — fork logic is tightly coupled to `src/lib/conversations/service.ts` (state mutation) and reuses transcript helpers; a separate module would add indirection without reducing complexity.

---

## Implementation Complexity & Risk

**Effort**: M — Uses existing patterns throughout. SDK native fork eliminates the hardest part (conversation history management). Main work is the four-case dispatcher, the synthetic fallback, and the pending-prompt round trip.

**Risk**: Low — `forkSession()` is well-tested in the SDK; the synthetic fallback covers the failure case explicitly; `pendingPromptText` is a single nullable string with a best-effort flush.

---

## Recommendations for Design Phase

### Preferred Approach
Option A (Extend), with `forkConversation()` and the transcript helpers living in `src/lib/conversations/service.ts` and `src/lib/prompt/transcript.ts` respectively.

### Key Design Decisions
1. **Eager SDK fork**: Call `forkSession()` at fork-creation time, not lazily on the first prompt. This decouples the fork from later mutations of the source.
2. **Mode-driven transcript copy**: `copyTranscriptUpTo({mode})` — `inclusive` for assistant forks, `exclusive` for user forks > 0, no copy for user idx 0.
3. **Synthetic fallback**: When `forkSession()` throws, fall back to a serialized transcript seed prepended to `pendingPromptText`.
4. **Persistent prompt input**: Server-persisted `pendingPromptText` per conversation, used both for the fork re-prompt seed and for everyday in-progress input.

### Research Items
- Validated `forkSession()` behavior with the current SDK version (covered by unit tests in `conversations.test.ts`).
- Confirmed transcript UUID extraction works for both Claude and Codex backends (Claude is the only backend that participates in eager SDK fork; both consume `syntheticForkSeed` for the fallback path).
