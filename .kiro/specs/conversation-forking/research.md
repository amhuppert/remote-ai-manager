# Research & Design Decisions — Conversation Forking

## Summary
- **Feature**: `conversation-forking`
- **Discovery Scope**: Extension (existing conversation system)
- **Key Findings**:
  - Claude Agent SDK has native `forkSession` + `resume` support — no manual history replay needed
  - SDK's `resumeSessionAt` requires message UUIDs not currently stored in CSM transcripts
  - UI components (MessageActions, MessageEditor) already created during prototyping phase

## Research Log

### SDK Fork Capabilities
- **Context**: Need to understand how the Claude Agent SDK supports conversation forking natively
- **Sources Consulted**: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (type declarations)
- **Findings**:
  - `query()` options include `resume: string` (session ID to resume), `forkSession: boolean` (fork to new session ID), `resumeSessionAt: string` (resume up to specific message UUID)
  - When `forkSession: true` is used with `resume`, the SDK loads the conversation history from the original session and creates a new forked session ID
  - `resumeSessionAt` requires `SDKAssistantMessage.uuid` — a field CSM does not currently persist in transcript entries
  - The SDK stores its own session data in `~/.claude/projects/` via `persistSession: true` (already enabled in CSM)
- **Implications**: CSM can leverage SDK-native forking rather than building its own history management. For v1, use `resume` + `forkSession: true` without `resumeSessionAt` — the SDK loads the full session and the new prompt provides the divergence context.

### Transcript Storage & Fork Point
- **Context**: How to copy transcript entries up to a fork point
- **Sources Consulted**: `src/lib/transcript.ts`, JSONL file format
- **Findings**:
  - Transcripts are append-only JSONL files at `~/.config/csm/transcripts/{id}.jsonl`
  - Each line is a `TranscriptEntry` with `timestamp`, `type`, `role?`, `content?`, `raw?`
  - `readConversationMessages()` filters to only `role === "user" | "assistant"` entries with content
  - Raw JSONL lines include system/tool_result entries not visible in the UI
  - Message indices in the UI map to filtered entries, not raw JSONL lines
- **Implications**: Fork transcript copy must read raw JSONL lines, filter to user/assistant messages, count to the fork point index, then copy all raw lines up to and including the matching raw line. This preserves system entries between visible messages.

### ConversationState Schema Extension
- **Context**: How to track fork provenance
- **Sources Consulted**: `src/lib/schemas.ts:63-78`
- **Findings**:
  - Current schema has no fork-related fields
  - Schema uses Zod with `.default()` for backward compatibility (existing conversations without new fields parse cleanly)
  - Adding an optional `forkedFrom` object field is additive and non-breaking
- **Implications**: Extend `conversationStateSchema` with `forkedFrom: z.object({ sourceId: z.string(), messageIndex: z.number() }).nullable().default(null)`

### Prompt Execution Integration
- **Context**: Where to inject SDK fork parameters
- **Sources Consulted**: `src/lib/prompt.ts:156-248`
- **Findings**:
  - Line 172: `resume: conversation.claudeSessionId ?? undefined` — already passes session ID for resumption
  - Fork integration requires adding `forkSession: true` when conversation has `forkedFrom` metadata AND this is the first prompt (no `claudeSessionId` yet)
  - After first prompt, `claudeSessionId` is set from SDK response and subsequent calls resume normally
  - The `claudeSessionId` of the SOURCE conversation (not the fork) must be passed as `resume` for the first prompt
- **Implications**: The fork API must store the source's `claudeSessionId` in the forked conversation's metadata so `prompt.ts` can use it for the initial `resume + forkSession` call.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Extend existing | Add fork logic to conversations.ts, extend prompt.ts | Minimal files, follows patterns | SessionDetailPage grows | Recommended |
| New module | Create src/lib/fork.ts | Clean separation | More indirection | Fork logic tightly coupled to existing flows |
| Hybrid | Extract fork business logic, extend UI in place | Balance | Slightly more files | Good for larger teams |

## Design Decisions

### Decision: SDK Fork Strategy
- **Context**: How to give Claude conversation context in a forked conversation
- **Alternatives Considered**:
  1. Manual history replay — pass prior messages as system prompt or initial messages
  2. SDK `resume` + `forkSession: true` — let SDK handle session forking natively
  3. SDK `resume` + `forkSession: true` + `resumeSessionAt` — fork at specific message
- **Selected Approach**: Option 2 — `resume` + `forkSession: true` without `resumeSessionAt`
- **Rationale**: Simplest approach. CSM doesn't store message UUIDs, and the SDK's internal session files contain the full conversation state. The new prompt naturally provides divergence context.
- **Trade-offs**: SDK loads full session history (slightly more work for Claude), but avoids schema changes for UUID storage
- **Follow-up**: If performance becomes an issue with long conversations, add `resumeSessionAt` support by storing UUIDs in transcript entries

### Decision: Fork API vs Inline in Prompt
- **Context**: Should forking happen as a separate API call or be embedded in the prompt flow?
- **Alternatives Considered**:
  1. Separate fork API (POST `/fork`) that creates conversation + copies transcript, then client navigates and sends prompt
  2. Extended prompt API that accepts fork parameters and handles everything in one call
- **Selected Approach**: Option 1 — Separate fork API
- **Rationale**: Cleaner separation of concerns. Fork creation (state + transcript) is independent of prompt execution. Client can navigate immediately and then send prompt as normal flow.
- **Trade-offs**: Two API calls for edit-and-fork (create fork + send prompt), but simpler to reason about and test

### Decision: Source claudeSessionId Storage
- **Context**: Forked conversation needs the source's `claudeSessionId` for SDK `resume` on first prompt
- **Alternatives Considered**:
  1. Store in `forkedFrom` metadata
  2. Look up from source conversation at prompt time
- **Selected Approach**: Option 1 — Store `sourceClaudeSessionId` in `forkedFrom` field
- **Rationale**: Avoids cross-conversation lookup at prompt time. Source conversation may be deleted later. Self-contained metadata.
- **Trade-offs**: Slightly larger schema, but eliminates runtime dependency on source conversation existence

## Risks & Mitigations
- **SDK forkSession untested in CSM** — Mitigate with integration test using real SDK session
- **Source conversation deleted before fork prompted** — Mitigate by storing `sourceClaudeSessionId` in fork metadata (SDK session files persist independently)
- **Large transcript copy for long conversations** — Mitigate with streaming copy (read line by line) rather than loading full file into memory
- **Mid-stream fork attempt** — Mitigate by disabling fork actions while `isBusy` (already in requirements)

## References
- Claude Agent SDK type declarations: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- CSM conversation management: `src/lib/conversations.ts`
- CSM prompt execution: `src/lib/prompt.ts`
- CSM transcript storage: `src/lib/transcript.ts`
