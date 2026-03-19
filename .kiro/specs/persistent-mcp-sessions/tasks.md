# Implementation Plan

- [x] 1. QuerySessionRegistry module
- [x] 1.1 (P) Implement the in-memory registry for looking up active query sessions by conversation ID
  - Create a module that stores and retrieves query session objects indexed by conversation ID
  - Use the HMR-safe global singleton pattern (same as existing abort-registry and query-registry)
  - Provide register, get, unregister, and close-all operations
  - The close-all operation calls close on every active session and is used during server shutdown
  - _Requirements: 2.1, 2.2, 2.3_
  - _Contracts: QuerySessionRegistry Service Interface_

- [x] 1.2 (P) Unit tests for the registry
  - Verify register stores and get retrieves by conversation ID
  - Verify unregister removes the entry so get returns undefined
  - Verify close-all calls close on every registered session and clears the registry
  - Verify registering a duplicate conversation ID overwrites the previous entry
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 2. QuerySession core — subprocess lifecycle and message pump
- [x] 2.1 Implement the factory and hanging-generator setup that creates a long-lived SDK query
  - Create a factory function that accepts session options (cwd, model, system prompt, resume, fork, MCP servers, env, etc.) and returns a query session object
  - On creation, start an SDK query using an async generator as the prompt — the generator yields the first user message and then hangs on a never-resolving promise to keep the subprocess alive indefinitely
  - Register the newly created session in the registry immediately after creation
  - Expose the SDK Query object as a readonly property so that queued messages can use streamInput directly
  - Track health status (alive/dead) as a readonly property with a one-way alive-to-dead transition
  - _Requirements: 1.1, 1.3, 2.1, 6.3_
  - _Contracts: QuerySession Service Interface, QuerySessionOptions_

- [x] 2.2 Implement the background message pump and per-turn prompt delivery via sendPrompt
  - Run a detached async function that iterates over SDK messages using for-await on the query object
  - Route each message through the current turn's emit callback when a turn is active; log and discard messages received between turns (idle state)
  - When sendPrompt is called, store the turn's resolve/reject/emit in a pending-turn slot, set the current turn options (including autonomous flag), and feed the user message via streamInput
  - When a result message arrives in the pump, extract turn-level metrics (session ID, cost, duration, turns, context tokens, content blocks, error state) into a TurnResult and resolve the pending turn promise
  - Support both plain text and async-iterable (multimodal) prompt formats
  - Track the claudeSessionId from result messages and expose it for conversation state updates
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 4.3_
  - _Contracts: QuerySession.sendPrompt(), TurnResult, TurnOptions_

- [x] 2.3 Implement crash detection, close, and status transitions
  - When the background pump's for-await throws (subprocess crash, MCP server failure), transition status to dead, unregister from the registry, log the error, and reject any pending turn promise
  - Implement close() that aborts the SDK query, marks status as dead, unregisters from the registry, and clears any idle TTL timer — close must be idempotent
  - Ensure status transitions are strictly alive-to-dead with no resurrection
  - _Requirements: 2.2, 2.3, 5.1, 5.3_
  - _Contracts: QuerySession.close(), QuerySessionState_

- [x] 2.4 Unit tests for QuerySession
  - Verify sendPrompt resolves with correct TurnResult when the pump receives a result message
  - Verify close transitions status to dead and rejects any pending turn promise
  - Verify pump error (simulated subprocess crash) marks session dead, unregisters from registry, and rejects pending turn
  - Verify sendPrompt sets currentTurnOptions before feeding the prompt so canUseTool can read the autonomous flag
  - Verify messages received between turns (no active sendPrompt) do not cause errors
  - Verify the SDK query receives the first message via the hanging generator and subsequent messages via streamInput
  - _Requirements: 1.1, 1.2, 1.3, 2.3, 5.3_

- [x] 3. Refactor executePromptStream to delegate to QuerySession
- [x] 3.1 Replace the one-shot query pattern with get-or-create QuerySession and sendPrompt delegation
  - Change the function body from "create query, run for-await loop, cleanup" to "get-or-create QuerySession from registry, call sendPrompt, handle TurnResult"
  - On first prompt (no existing session or previous session is dead), create a new QuerySession with all SDK options including model, system prompt, resume, fork, MCP servers, environment, and plugins
  - On subsequent prompts (existing alive session found in registry), reuse the session and call sendPrompt directly
  - When creating a QuerySession for a conversation that has a claudeSessionId (resume scenario), pass the resume option so the SDK restores context
  - When creating a QuerySession for a forked conversation, pass the forkSession flag
  - Preserve the external API signature — no changes to callers
  - _Requirements: 1.1, 1.2, 4.1, 4.2, 6.2, 6.3_
  - _Contracts: executePromptStream Service Interface_

- [x] 3.2 Wire canUseTool callback with per-turn autonomous support via TurnOptions
  - Build the canUseTool callback once at QuerySession creation time, capturing the session context (project path, session name, conversation ID)
  - The callback reads the autonomous flag from the QuerySession's mutable currentTurnOptions field (set by sendPrompt) rather than from a closure-captured options argument
  - Pass the autonomous flag from the caller's options through to sendPrompt as TurnOptions so the callback can check it per turn
  - Preserve the existing AskUserQuestion blocking/resume semantics (waiting_for_input status, question registry, SSE broadcasts) unchanged
  - _Requirements: 6.1, 6.4_

- [x] 3.3 Handle per-turn accounting, status transitions, transcript, and SSE emission from TurnResult
  - After sendPrompt resolves, extract cost, duration, turns, and context token deltas from TurnResult and update conversation metadata
  - Set conversation status to awaiting and broadcast the status change via SSE after each turn completes, even though the subprocess remains alive
  - Acquire the session lock and query semaphore slot at turn start; release both in the finally block when the turn completes (not when the subprocess exits)
  - Continue appending all SDK messages to the conversation transcript with the same format as the current implementation — the emit callback passed to sendPrompt handles this
  - Emit the same SSE events (conversation-status, ask-question, content, result, done, error, aborted) with the same payloads as today
  - _Requirements: 2.4, 3.1, 3.2, 3.3, 3.4, 6.5_

- [x] 3.4 Update PromptDeps interface and write unit tests for the refactored executePromptStream
  - Add getSessionFromRegistry and registerSessionInRegistry (or equivalent) to the PromptDeps interface for dependency injection, enabling tests to provide mock registries
  - Verify that the first prompt to a conversation creates a new QuerySession and registers it
  - Verify that a subsequent prompt to a conversation with an alive session reuses it (no new creation)
  - Verify that a prompt to a conversation whose previous session is dead creates a fresh session
  - Verify per-turn accounting extracts deltas correctly from TurnResult
  - Verify lock and semaphore are acquired at turn start and released on completion
  - _Requirements: 1.1, 1.2, 3.1, 3.3_

- [x] 4. Lifecycle extensions — cleanup, abort, and idle TTL
- [x] 4.1 (P) Extend session deletion to close active query sessions before removing the worktree
  - Before removing the session from state and worktree, iterate all conversation IDs in the session and call close on any active query session found in the registry
  - The close call is idempotent — safe to call on already-dead sessions or missing entries
  - Ensure subprocesses and MCP servers are terminated before the worktree directory is removed
  - _Requirements: 2.2_

- [x] 4.2 (P) Adapt abort handling for persistent sessions
  - When a user aborts a running prompt, close the query session (which terminates the subprocess) since the SDK does not support turn-level cancellation
  - Mark the session as dead in the registry so the next prompt creates a fresh query session with the resume option to restore SDK context
  - If the safety-net timeout fires during a turn, abort via the same close mechanism and let the next prompt recover
  - Update the abort registry to work with QuerySession close instead of raw AbortController abort
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 4.3 (P) Implement idle TTL timer for reaping inactive query sessions
  - Add the idle TTL configuration option to the config schema with a default of 5 minutes
  - When a turn completes (sendPrompt resolves), start or reset a timer on the query session
  - When the timer fires without any intervening sendPrompt calls, close the session and log the idle timeout event
  - Clear the timer on close to prevent firing after explicit termination
  - The next prompt to this conversation creates a fresh query session with resume
  - _Requirements: 2.4_

- [x] 5. Integration tests and backward-compatibility verification
- [x] 5.1 Write integration tests for multi-turn subprocess reuse and recovery
  - Two consecutive prompts to the same conversation should reuse the same subprocess — verify via init message count (only one init event across both prompts)
  - Abort mid-turn should kill the subprocess; the next prompt should create a fresh session and succeed
  - Deleting a session with an active query session should terminate the subprocess cleanly
  - Queued messages via queueMessage should still work via the session's query streamInput
  - Verify the second prompt in a conversation completes without the subprocess startup overhead (no re-initialization delay)
  - _Requirements: 1.1, 1.2, 1.3, 2.2, 5.1, 6.2_

## Requirements Coverage

| Requirement | Task(s) |
|-------------|---------|
| 1.1 | 2.1, 2.2, 3.1, 3.4, 5.1 |
| 1.2 | 2.2, 3.1, 3.4, 5.1 |
| 1.3 | 2.1, 2.2, 5.1 |
| 1.4 | 2.2 |
| 2.1 | 1.1, 2.1, 3.1 |
| 2.2 | 1.1, 2.3, 4.1, 5.1 |
| 2.3 | 1.1, 2.3 |
| 2.4 | 3.3, 4.3 |
| 3.1 | 2.2, 3.3, 3.4 |
| 3.2 | 3.3 |
| 3.3 | 3.3, 3.4 |
| 3.4 | 3.3 |
| 4.1 | 3.1 |
| 4.2 | 3.1 |
| 4.3 | 2.2 |
| 5.1 | 2.3, 4.2, 5.1 |
| 5.2 | 4.2 |
| 5.3 | 2.3, 4.2 |
| 6.1 | 3.2 |
| 6.2 | 3.1, 5.1 |
| 6.3 | 2.1, 3.1 |
| 6.4 | 3.2 |
| 6.5 | 3.3 |
