# Implementation Plan

> **Note**: The prompt-execution feature is fully implemented. All tasks below address the test coverage gap identified during gap analysis. Existing `lock.test.ts` covers the lock module; prompt execution and API route lack tests.

- [ ] 1. Add unit tests for single-flight locking
- [ ] 1.1 (P) Test lock acquisition and release lifecycle
  - Verify `acquireSessionLock` returns a release function when no lock is held
  - Verify `isSessionBusy` returns true while lock is held
  - Verify calling the release function clears the lock
  - Verify `isSessionBusy` returns false after release
  - Verify the lock can be re-acquired after release
  - _Requirements: 3.1, 3.3, 3.4_

- [ ] 1.2 (P) Test lock rejection when busy
  - Verify `acquireSessionLock` throws "Session is busy" when lock is already held
  - Verify the error message matches the expected text
  - _Requirements: 3.2_

- [ ] 1.3 (P) Test lock key isolation
  - Verify that locks for different sessions within the same project are independent
  - Verify that locks for the same session name in different projects are independent
  - Verify the lock key uses the `projectPath::sessionName` format
  - _Requirements: 3.1, 3.4_

- [ ] 2. Add integration tests for prompt execution lifecycle
- [ ] 2.1 Test successful prompt execution with status transitions
  - Mock `execFile` to simulate successful Claude CLI execution
  - Mock state module to track session mutations
  - Verify session status transitions: ready → running → ready
  - Verify `lastActivityAt` is updated on each state mutation
  - Verify prompt count is incremented by one on success
  - Verify the Claude CLI stdout is returned as the output
  - _Requirements: 1.1, 1.2, 1.5, 4.1, 4.2, 4.4, 2.3_

- [ ] 2.2 Test conversation continuity flag behavior
  - Verify first prompt (promptCount = 0) invokes CLI without `-c` flag
  - Verify subsequent prompts (promptCount > 0) include the `-c` flag
  - Verify both cases include the `-p` flag with the prompt text
  - _Requirements: 2.1, 2.2_

- [ ] 2.3 Test CLI environment and configuration
  - Verify the working directory is set to the session's worktree path
  - Verify the `CI` environment variable is set to `"1"`
  - Verify parent process environment variables are inherited
  - Verify the timeout matches the `claudeTimeoutMs` config value
  - Verify the max buffer is set to 10 MB
  - _Requirements: 1.2, 1.3, 1.4, 5.1, 5.3_

- [ ] 3. Add integration tests for error recovery
- [ ] 3.1 Test error handling when CLI fails
  - Mock `execFile` to simulate CLI process failure
  - Verify the error is wrapped with "Prompt execution failed:" prefix
  - Verify session status is reset to "ready" after failure
  - Verify the session lock is released after failure
  - Verify prompt count is not incremented on failure
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 4.3_

- [ ] 3.2 (P) Test best-effort status recovery
  - Mock `execFile` to fail and mock `updateSession` to also fail during recovery
  - Verify the session lock is still released even when status reset fails
  - Verify the original CLI error is propagated (not the status update error)
  - _Requirements: 6.2, 6.3_

- [ ] 3.3 (P) Test timeout handling
  - Mock `execFile` to simulate a timeout error
  - Verify the error is properly wrapped and propagated
  - Verify session status is reset and lock is released after timeout
  - _Requirements: 5.2, 6.2, 6.3_

- [ ] 4. Add API route tests for prompt endpoint
- [ ] 4.1 Test successful prompt submission
  - Verify POST with valid prompt returns 200 with `{ success: true }`
  - Verify the `X-Claude-Output-Length` header is present in the response
  - _Requirements: 7.1, 7.6_

- [ ] 4.2 (P) Test request validation errors
  - Verify missing prompt field returns 400 with appropriate error message
  - Verify empty prompt field returns 400
  - _Requirements: 7.2_

- [ ] 4.3 (P) Test not-found error responses
  - Verify unknown project returns 404 with "Project not found"
  - Verify unknown session returns 404 with "Session not found"
  - _Requirements: 7.3, 7.4_

- [ ] 4.4 (P) Test busy session conflict response
  - Mock `isSessionBusy` to return true
  - Verify response is 409 with error code "SESSION_BUSY"
  - Verify the error message matches "Session is busy — a prompt is already running"
  - _Requirements: 7.5_

- [ ] 4.5 (P) Test execution failure response
  - Mock `executePrompt` to throw a non-busy error
  - Verify response is 500 with the error message
  - _Requirements: 7.7_
