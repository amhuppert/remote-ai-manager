# Implementation Plan

> **Note**: The hook-integration feature is fully implemented. `processHookEvent` has unit tests in `hooks.test.ts` covering session matching and metadata update scenarios. Tasks below address remaining test coverage gaps for hook detection and API routes.

- [x] 1. Add unit tests for detectHooksStatus
- [x] 1.1 (P) Test successful detection with both hooks configured
  - Mock filesystem to return settings.json with both UserPromptSubmit and Stop events containing "cc" command
  - Verify `installed` is true, `hasUserPromptSubmit` is true, `hasStop` is true
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 1.2 (P) Test partial hook configuration
  - Mock settings with only UserPromptSubmit configured
  - Verify `installed` is false, `hasUserPromptSubmit` is true, `hasStop` is false
  - Mock settings with only Stop configured
  - Verify `installed` is false, `hasUserPromptSubmit` is false, `hasStop` is true
  - _Requirements: 4.2, 4.4_

- [x] 1.3 (P) Test missing or invalid settings file
  - Mock filesystem to throw ENOENT error
  - Verify all fields return false
  - Mock filesystem to return invalid JSON
  - Verify all fields return false
  - _Requirements: 4.5_

- [x] 1.4 (P) Test command string matching
  - Mock settings with hooks that don't contain "cc" in the command
  - Verify the hooks are not detected (treated as non-CC hooks)
  - _Requirements: 4.3_

- [x] 2. Add API route tests for hook endpoints
- [x] 2.1 Test POST /api/hooks with valid event
  - Verify 200 response with `{ matched: true }` when session matches
  - Verify 200 response with `{ matched: false }` when no session matches
  - _Requirements: 1.1, 1.3_

- [x] 2.2 (P) Test POST /api/hooks with invalid body
  - Verify 400 response when body fails schema validation
  - _Requirements: 1.4_

- [x] 2.3 (P) Test GET /api/hooks/status
  - Verify 200 response with hook detection result
  - Verify response includes installed, hasUserPromptSubmit, and hasStop fields
  - _Requirements: 5.1, 5.2_

- [x] 3. Add tests for cross-project session matching
- [x] 3.1 (P) Test findSessionByCwd across multiple projects
  - Create state with sessions in different projects
  - Verify correct session is matched regardless of project
  - Verify unmatched cwd returns no match
  - _Requirements: 2.1, 2.4_
