# Research & Design Decisions — Conversation Forking

## Summary
- **Feature**: `conversation-forking`
- **Discovery Scope**: Extension (existing conversation system)
- **Key Findings**:
  - Claude Agent SDK exposes a top-level `forkSession()` helper that creates a new SDK session derived from an existing one — no manual history replay needed
  - `forkSession()` accepts an optional `upToMessageId` (message UUID); CC stores these UUIDs in the raw SDK entries of its own transcript so they can be resolved at fork time
  - The MessageActions UI component (per-message Copy + Fork buttons) was created during prototyping; no separate inline-editing component is used

## Research Log

### SDK Fork Capabilities
- **Context**: Need to understand how the Claude Agent SDK supports conversation forking natively
- **Sources Consulted**: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (type declarations)
- **Findings**:
  - The SDK exports a top-level `forkSession(sourceSessionId, { dir, upToMessageId })` helper that returns `{ sessionId }` for the new forked session
  - The new session is materialized in `~/.claude/projects/` (via the SDK's `persistSession`) at fork time, independent of any later mutations of the source
  - When `upToMessageId` is omitted, the fork inherits the full source session
  - If the source session file has been compacted or removed, `forkSession()` throws — CC handles this with a synthetic-seed fallback path
- **Implications**: CC can leverage SDK-native forking via an eager call at fork creation time, then treat the new session as a first-class session (resumed via the standard prompt path on every subsequent prompt). The synthetic fallback ensures the feature is robust against compaction.

### Transcript Storage & Fork Point
- **Context**: How to copy transcript entries up to a fork point and how to locate the SDK message UUID at the boundary
- **Sources Consulted**: `src/lib/transcript.ts`, JSONL file format
- **Findings**:
  - Transcripts are append-only JSONL files at `{configDir}/transcripts/{id}.jsonl`
  - Each line is a `TranscriptEntry` with `timestamp`, `type`, `role?`, `content?`, `raw?`
  - `readConversationMessages()` filters to only `role === "user" | "assistant"` entries with content
  - Raw JSONL lines include system/tool_result entries not visible in the UI
  - Message indices in the UI map to filtered entries, not raw JSONL lines
  - The raw SDK entries include `uuid` fields, which `findForkAnchorUuid` extracts at the fork boundary
- **Implications**: Fork transcript copy reads raw JSONL lines, locates the boundary by counting visible messages, then copies all raw lines up to (and optionally including, depending on `mode`) the matching raw line. This preserves system entries between visible messages. The SDK anchor UUID is resolved from the raw SDK entry at the boundary.

### ConversationState Schema Extension
- **Context**: How to track fork provenance and the persistent prompt input
- **Sources Consulted**: `src/lib/schemas.ts`
- **Findings**:
  - Schema uses Zod with `.nullable()` / `.default()` for backward compatibility (existing conversations without new fields parse cleanly)
  - Two additive fields cover the feature: `forkedFrom` (with `sourceConversationId`, `messageIndex`, `sourceBackend`, `sourceBackendRef`, `forkLocator`, `forkMode`) and `pendingPromptText`
- **Implications**: Both additions are additive and non-breaking.

### Eager Fork at Creation Time
- **Context**: When to call `forkSession()` — at fork creation or lazily on the first prompt?
- **Findings**:
  - Calling at fork creation gives the new conversation its own session file from the moment it's created, decoupling it from later source mutations
  - Calling lazily on the first prompt forces the source session file to survive until the user revisits the fork — fragile if the source is later deleted or compacted
- **Implications**: Eager. The fork API call performs the SDK fork (cases a/b), captures the resulting session id in the new conversation's `backendRef`, and persists everything in one atomic mutation.

### Persistent Prompt Input
- **Context**: Where to store in-progress prompt text so it survives navigation and reload
- **Findings**:
  - Conversation state is already round-tripped through the state aggregate on each mutation
  - A single nullable `pendingPromptText` string on `ConversationState` is enough; debounced PUTs from the client keep it fresh, and `navigator.sendBeacon` on unload provides a best-effort flush
  - This same field carries the seed text for fork cases (b), (c), and (d) — no separate Zustand store path is needed
- **Implications**: Server-persisted `pendingPromptText` is the single mechanism for both everyday persistent input and the fork re-prompt seed.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Extend existing | Add fork logic to conversations.ts, extend transcript.ts | Minimal files, follows patterns | ConversationDetailPage grows | Chosen |
| New module | Create src/lib/fork.ts | Clean separation | More indirection | Fork logic tightly coupled to existing flows |
| Hybrid | Extract fork business logic, extend UI in place | Balance | Slightly more files | Good for larger teams |

## Design Decisions

### Decision: SDK Fork Strategy
- **Context**: How to give Claude conversation context in a forked conversation
- **Alternatives Considered**:
  1. Manual history replay — pass prior messages as system prompt or initial messages
  2. Eager SDK `forkSession()` at fork creation, then resume normally on every prompt
  3. Lazy SDK fork on the first prompt of the new conversation
- **Selected Approach**: Option 2 — eager `forkSession()` at fork creation time
- **Rationale**: Decouples the fork from later mutations of the source. The new conversation owns its session file immediately.
- **Trade-offs**: Two side effects on a single API call (state mutation + SDK call), but the SDK call is fast and the failure mode is handled by the synthetic fallback.
- **Follow-up**: If `forkSession()` becomes slow for very long sessions, consider deferring it; for now, the eager call is fine.

### Decision: Fork API vs Inline in Prompt
- **Context**: Should forking happen as a separate API call or be embedded in the prompt flow?
- **Alternatives Considered**:
  1. Separate fork API (POST `/fork`) that creates the conversation + copies transcript + eager SDK fork; client navigates and lets the user send the next prompt manually
  2. Extended prompt API that accepts fork parameters and handles everything in one call
- **Selected Approach**: Option 1 — Separate fork API
- **Rationale**: Cleaner separation of concerns. Fork creation (state + transcript + SDK session) is independent of prompt execution. The developer revises the prepopulated prompt and sends from the new conversation manually.
- **Trade-offs**: One extra API call from the user's perspective, but the separation matches the user's mental model (fork ≠ send).

### Decision: Source SDK Session Ref Storage
- **Context**: The forked conversation needs to know how it was derived for the audit trail and for the synthetic-fallback path
- **Alternatives Considered**:
  1. Store the source `backendRef` inside `forkedFrom.sourceBackendRef`
  2. Look up from the source conversation at runtime
- **Selected Approach**: Option 1 — store inside `forkedFrom`
- **Rationale**: Avoids cross-conversation lookup at prompt time. Source conversation may be deleted later. Self-contained metadata.
- **Trade-offs**: Slightly larger schema, but eliminates runtime dependency on source conversation existence.

### Decision: Synthetic Fallback for Compaction Resilience
- **Context**: `forkSession()` throws if the source SDK session file has been compacted away
- **Alternatives Considered**:
  1. Surface the error to the user, abort the fork
  2. Build a synthetic seed from the local CC transcript and bootstrap a brand-new SDK session on the next prompt
- **Selected Approach**: Option 2 — fall back to a synthetic seed
- **Rationale**: The local CC transcript still has the visible context. Serializing it into a `<<<SYNTHETIC_FORK_SEED ...>>>` block prepended to `pendingPromptText` lets the new SDK session be primed by the seed on the first prompt. `forkMode = "synthetic"` is surfaced on the conversation header so the user knows they're in this path.
- **Trade-offs**: The synthetic seed loses some SDK-internal richness (tool messages, etc.), but it preserves the human-visible conversation.

## Risks & Mitigations
- **SDK `forkSession()` errors on compacted sources** — Mitigated by the synthetic fallback (covered by unit tests).
- **Source conversation deleted before fork is prompted** — Eager `forkSession()` materializes the new session file at fork time; the source SDK session is no longer required after the fork is created.
- **Large transcript copy for long conversations** — Mitigated with line-by-line read/write rather than loading the full file into memory.
- **Mid-stream fork attempt** — Mitigated by disabling fork actions while the conversation `isBusy`.

## References
- Claude Agent SDK type declarations: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- CC conversation management: `src/lib/conversations.ts`
- CC prompt execution: `src/lib/prompt.ts`
- CC transcript storage: `src/lib/transcript.ts`
