# Implementation Plan

## Pre-implemented Components
The MessageActions UI component (Copy + Fork buttons per message) is already created with Storybook stories and CSS styles. Tasks below focus on backend services, API wiring, and frontend integration.

## Tasks

- [x] 1. Extend conversation schema with fork provenance and persistent prompt input
  - Add a nullable `forkedFrom` object field to the conversation state schema with source conversation ID, source backend, source backend session ref, message index, fork locator, and fork mode (`native` | `synthetic` | null)
  - Add a nullable `pendingPromptText` string field for persistent prompt input, defaulting to null
  - Ensure backward compatibility so existing conversations without the new fields parse cleanly via nullable defaults
  - Add a fork request validation schema for the API (message index required)
  - _Requirements: 3.1, 5.1_
  - _Contracts: ConversationStateSchema State_

- [x] 2. Implement transcript copy service
- [x] 2.1 (P) Build mode-driven transcript copying logic
  - Accept a `CopyTranscriptInput` with `sourceTranscriptPath`, `targetConversationId`, `upToMessageIndex`, and `mode: "inclusive" | "exclusive"`
  - Read source JSONL transcript and locate the message at `upToMessageIndex`
  - For `mode: "inclusive"` (assistant fork): copy through and including the target message
  - For `mode: "exclusive"` (user fork at index > 0): copy up to but not including the target message
  - Preserve all interleaved non-message lines (system entries, tool_result entries, etc.)
  - Write the copied lines to the target conversation's transcript file
  - Add a sibling `findForkAnchorUuid({ atMessageIndex, mode })` helper that returns the SDK message UUID at the fork boundary for use as the SDK's `upToMessageId`
  - Add `buildSyntheticForkSeed(sourceTranscriptPath, messageIndex)` that serializes the local transcript into a single-shot prompt seed, returning null on empty/unreadable transcripts
  - _Requirements: 1.1, 3.2, 4.4_
  - _Contracts: TranscriptCopy Service_

- [x] 2.2 Write unit tests for transcript copy and helpers
  - Verify correct JSONL subset is copied for each mode at various message indices
  - Verify system/tool_result entries between visible messages are preserved in the copy
  - Verify boundary conditions: fork at first message, fork at last message, fork when no assistant response follows
  - Verify `findForkAnchorUuid` returns the correct UUID for each mode at boundary indices
  - Verify `buildSyntheticForkSeed` round-trips serialization and returns null on empty input
  - _Requirements: 1.1, 3.2, 4.4_

- [x] 3. Implement fork conversation service
- [x] 3.1 Build fork creation logic with the four cases
  - Determine the fork case from the target message's role and index: (a) assistant message → inclusive copy + inclusive anchor; (b) user message at index > 0 → exclusive copy + exclusive anchor; (c) user message at index 0 → no copy, no anchor; (d) synthetic fallback when SDK `forkSession()` throws
  - For cases (a) and (b), eagerly call SDK `forkSession(sourceSessionId, { dir, upToMessageId: anchor })` and record `backendRef` + `forkMode: "native"` on the new conversation
  - On SDK fork failure, build a synthetic seed via `buildSyntheticForkSeed`; if the seed is null, throw `ForkCreationError("fork_failed", …)`; otherwise prepend the seed to `pendingPromptText`, leave `backendRef` null, and record `forkMode: "synthetic"`
  - For case (c), seed `pendingPromptText` with the user's text, copy no transcript, create no SDK fork
  - Create a new conversation with a unique ID, the appropriate `backendRef`, a fully populated `forkedFrom` (including `forkLocator`, `sourceBackend`, `sourceBackendRef`, and `forkMode`), and prompt count 0
  - Generate a descriptive default name indicating the source conversation and fork turn number
  - Coordinate transcript copying via `copyTranscriptUpTo({mode})`
  - Persist the new conversation to session state atomically
  - _Requirements: 1.1, 1.2, 3.1, 3.2, 3.3, 3.5, 4.1, 4.4_
  - _Contracts: ForkConversation Service_

- [x] 3.2 Write unit tests for fork conversation service
  - Verify new conversation has correct `forkedFrom`, `backendRef`, `pendingPromptText`, and `forkMode` for each case
  - Verify prompt count starts at 0
  - Verify default name follows the expected format
  - Verify validation rejects out-of-range message index
  - Verify fork-from-fork resolves the source SDK session ID from the parent's own `backendRef`
  - Verify the synthetic fallback path: SDK `forkSession()` throws, the seed is built, `forkMode === "synthetic"`, and `backendRef` is null
  - _Requirements: 1.1, 1.2, 3.1, 3.3, 3.5, 4.1, 4.4_

- [x] 4. Create fork API route
  - Expose a POST endpoint at the conversation-level fork path under the existing API hierarchy
  - Parse and validate the request body using the fork request schema (messageIndex only)
  - Resolve project and session from route parameters, returning 404 for missing resources
  - Return 409 if the source conversation is currently running
  - Call the fork conversation service and return `{ conversationId, name, forkMode }`
  - Handle errors with appropriate HTTP status codes: 400 for validation, 404 for missing resources, 409 for running conversations, 500 for server errors (including `ForkCreationError`)
  - _Requirements: 1.1, 1.2, 1.3_
  - _Contracts: ForkAPIRoute API_

- [x] 5. (P) Wire synthetic seed consumption in agent backends
  - Add a `syntheticForkSeed` field on `ConversationBackendTurnInput`
  - In the Claude backend's `build-prompt-blocks`, prepend the seed to the user's prompt when present
  - In the Codex backend's `conversation-runtime`, prepend the seed in the same way
  - In `actor-implementations`, set `syntheticForkSeed` on the turn input when the conversation's `forkedFrom.forkMode === "synthetic"` and `backendRef` is null
  - Unit-test that the field is consumed exactly once per fork bootstrap
  - _Requirements: 4.4_
  - _Contracts: ConversationBackend Service_

- [x] 6. (P) Add pending-prompt route and handlers
  - Expose a PUT endpoint at the conversation-level pending-prompt path
  - Accept `{ text: string | null }` and update the conversation's `pendingPromptText`
  - Return 204 on success, 400 on validation failure, 404 on missing resources
  - Implement the underlying handler in `src/lib/pending-prompt-route-handlers.ts`
  - _Requirements: 5.1, 5.2_
  - _Contracts: PendingPromptRoute API_

- [x] 7. Integrate fork action and persistent prompt input into the conversation detail page
- [x] 7.1 Wire MessageActions into the message render loop
  - Render the MessageActions component for every message in the virtualized list (user and assistant)
  - Pass the conversation running status and read-only status to disable actions while a prompt is executing or the conversation is read-only
  - Implement the fork handler: call the fork API, then navigate to the new conversation
  - _Requirements: 1.3, 1.4, 1.5_

- [x] 7.2 Wire persistent prompt input on ConversationDetailPage
  - Initialize the prompt input from the conversation's pendingPromptText on mount
  - Debounce changes into a PUT against the pending-prompt route (~500ms)
  - Flush via `navigator.sendBeacon` on `beforeunload` for best-effort capture before navigation
  - Clear the input client-side and server-side on successful prompt submit
  - Manually clearing the input persists null
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 7.3 Wire fork action and synthetic-fallback indicator
  - Wire the fork handler to call the fork API and then navigate to the returned conversation
  - On the conversation header, show a synthetic-fallback indicator when `forkedFrom.forkMode === "synthetic"`
  - The forked conversation hydrates its prompt input from its server-persisted pendingPromptText (no client-side store handoff)
  - _Requirements: 1.3, 6.3_

- [x] 8. (P) Add fork indicator to conversation sidebar
  - Display a small fork icon next to the conversation name for conversations that have `forkedFrom` metadata
  - Show a tooltip on hover indicating the source conversation name and fork turn number
  - Resolve the source conversation name from the conversations list; handle missing sources gracefully
  - _Requirements: 6.1, 6.2, 6.3_

## Requirements Coverage

| Requirement | Tasks |
|-------------|-------|
| 1.1 | 2.1, 3.1, 4 |
| 1.2 | 3.1, 4 |
| 1.3 | 4, 7.1, 7.3 |
| 1.4 | 7.1 |
| 1.5 | 7.1 |
| 3.1 | 1, 3.1 |
| 3.2 | 2.1, 3.1 |
| 3.3 | 3.1 |
| 3.4 | Existing delete logic (no changes needed) |
| 3.5 | 3.1 |
| 4.1 | 3.1 |
| 4.2 | Existing prompt flow (no changes needed) |
| 4.3 | Existing readConversationMessages (no changes needed) |
| 4.4 | 2.1, 3.1, 5 |
| 5.1 | 1, 6, 7.2 |
| 5.2 | 6, 7.2 |
| 5.3 | 7.2 |
| 6.1 | 8 |
| 6.2 | 8 |
| 6.3 | 7.3 |
