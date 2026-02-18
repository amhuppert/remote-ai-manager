# Implementation Plan

> **Note**: The prompt-execution feature is fully implemented with streaming support (`--output-format stream-json`, SSE response, `MessageContentBlock[]` content). All tasks below address test coverage. Existing `lock.test.ts` covers the lock module; `stream-events.test.ts` covers event parsing; `prompt.test.ts` covers the streaming execution lifecycle; `prompt-route.test.ts` covers the API route.

- [x] 1. Add unit tests for single-flight locking
- [x] 1.1 (P) Test lock acquisition and release lifecycle
  - Verify `acquireSessionLock` returns a release function when no lock is held
  - Verify `isSessionBusy` returns true while lock is held
  - Verify calling the release function clears the lock
  - Verify `isSessionBusy` returns false after release
  - Verify the lock can be re-acquired after release
  - _Requirements: 3.1, 3.3, 3.4_

- [x] 1.2 (P) Test lock rejection when busy
  - Verify `acquireSessionLock` throws "Session is busy" when lock is already held
  - Verify the error message matches the expected text
  - _Requirements: 3.2_

- [x] 1.3 (P) Test lock key isolation
  - Verify that locks for different sessions within the same project are independent
  - Verify that locks for the same session name in different projects are independent
  - Verify the lock key uses the `projectPath::sessionName` format
  - _Requirements: 3.1, 3.4_

- [x] 2. Add unit tests for stream event parsing
- [x] 2.1 Test parseStreamLine for recognized event types
  - Verify `parseStreamLine` returns typed `StreamInitEvent` for system init events
  - Verify `parseStreamLine` returns typed `StreamAssistantEvent` for assistant messages
  - Verify `parseStreamLine` returns typed `StreamUserEvent` for user (tool_result) messages
  - Verify `parseStreamLine` returns typed `StreamResultEvent` for result events
  - _Requirements: 1.5, 8.3_

- [x] 2.2 (P) Test parseStreamLine error handling
  - Verify `parseStreamLine` returns null for malformed JSON
  - Verify `parseStreamLine` returns null for unrecognized event types (progress, file-history-snapshot)
  - _Requirements: 1.5_

- [x] 2.3 (P) Test formatToolUse formatting rules
  - Verify Read tool formats as `Read <file_path>`
  - Verify Write tool formats as `Write <file_path>`
  - Verify Edit/MultiEdit tool formats as `Edit <file_path>`
  - Verify Bash tool formats as `Bash: <description>` or `Bash: <command[:50]>`
  - Verify Grep tool formats as `Search for "<pattern>"`
  - Verify Glob tool formats as `Find files matching "<pattern>"`
  - Verify Task tool formats as `Task: <description[:50]>`
  - Verify unknown tools format as tool name only

- [x] 3. Add integration tests for streaming prompt execution lifecycle
- [x] 3.1 Test successful streaming prompt execution with status transitions
  - Mock `spawn` to simulate successful Claude CLI execution with stream-json output
  - Mock state module to track session mutations
  - Verify session status transitions: ready → running → ready
  - Verify `lastActivityAt` is updated on each state mutation
  - Verify prompt count is incremented by one on success
  - Verify emit callback receives init, content, and done events
  - _Requirements: 1.1, 1.2, 1.5, 4.1, 4.2, 4.4, 2.3, 8.1, 8.2_

- [x] 3.2 Test conversation continuity flag behavior
  - Verify first prompt (promptCount = 0) invokes CLI without `-c` flag
  - Verify subsequent prompts (promptCount > 0) include the `-c` flag
  - Verify both cases include the `-p` flag with the prompt text
  - _Requirements: 2.1, 2.2_

- [x] 3.3 Test CLI environment and configuration
  - Verify the working directory is set to the session's worktree path
  - Verify `CLAUDE`-prefixed environment variables are filtered out
  - Verify `--dangerously-skip-permissions`, `--output-format stream-json`, and `--max-turns 50` flags are passed
  - Verify parent process environment variables are inherited (minus CLAUDE-prefixed)
  - Verify the timeout uses `setTimeout` with `claudeTimeoutMs` config value
  - _Requirements: 1.2, 1.3, 1.4, 5.1_

- [x] 4. Add integration tests for streaming error recovery
- [x] 4.1 Test error handling when CLI fails with no content
  - Mock `spawn` to simulate CLI process failure with no stdout content
  - Verify an error event is emitted
  - Verify session status is reset to "ready" after failure
  - Verify the session lock is released after failure
  - Verify prompt count is not incremented on failure with no blocks
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 4.3_

- [x] 4.2 (P) Test CLI failure with accumulated content blocks
  - Mock `spawn` to emit content blocks then exit non-zero
  - Verify accumulated content blocks are stored as the assistant message
  - Verify prompt count is incremented (content was produced)
  - Verify done event is emitted (not error)
  - _Requirements: 8.2, 8.5_

- [x] 4.3 (P) Test best-effort status recovery
  - Mock `spawn` to fail and mock `updateSession` to also fail during recovery
  - Verify the session lock is still released even when status reset fails
  - _Requirements: 6.2, 6.3_

- [x] 4.4 (P) Test timeout handling
  - Verify the timeout kills the process with SIGTERM
  - Verify an error event is emitted on timeout
  - Verify session status is reset and lock is released after timeout
  - Verify any partial content blocks accumulated before timeout are stored
  - _Requirements: 5.2, 6.2, 6.3_

- [x] 5. Add API route tests for prompt endpoint
- [x] 5.1 Test successful prompt submission
  - Verify POST with valid prompt returns 200 with `Content-Type: text/event-stream`
  - _Requirements: 7.1, 7.6_

- [x] 5.2 (P) Test request validation errors
  - Verify missing prompt field returns 400 with appropriate error message
  - Verify empty prompt field returns 400
  - _Requirements: 7.2_

- [x] 5.3 (P) Test not-found error responses
  - Verify unknown project returns 404 with "Project not found"
  - Verify unknown session returns 404 with "Session not found"
  - _Requirements: 7.3, 7.4_

- [x] 5.4 (P) Test busy session conflict response
  - Mock `isSessionBusy` to return true
  - Verify response is 409 with error code "SESSION_BUSY"
  - Verify the error message matches "Session is busy — a prompt is already running"
  - _Requirements: 7.5_

- [x] 5.5 (P) Test execution failure emits error SSE event
  - Mock `executePromptStream` to throw a non-busy error
  - Verify the SSE stream includes an error event followed by done event
  - _Requirements: 7.7_

- [x] 6. Add tests for conversation message storage with content blocks
- [x] 6.1 Test user message stored as content blocks before CLI execution
  - Verify the first `mutateSession` call appends a user message with `content: [{ type: "text", text }]` and timestamp to `session.messages`
  - Verify the user message is stored before the CLI subprocess is spawned
  - _Requirements: 8.1_

- [x] 6.2 Test assistant message stored as MessageContentBlock[] after successful execution
  - Verify the `mutateSession` call appends an assistant message with accumulated `MessageContentBlock[]` content
  - Verify content blocks include text and tool_use types as emitted by the stream
  - Verify the assistant message timestamp is set
  - _Requirements: 8.2, 8.3_

- [x] 6.3 Test claudeSessionId set from stream init event
  - Mock CLI to emit a system init event with `session_id` field
  - Verify `claudeSessionId` is set on the session state from the parsed value
  - _Requirements: 8.4_
