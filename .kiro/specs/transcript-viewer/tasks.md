# Implementation Plan

> **Note**: The transcript-viewer feature is fully implemented. `readTranscript` and `extractContent` have comprehensive unit tests in `transcript.test.ts` (7 test cases covering Requirements 1–5). Tasks below address the UI rendering test gap for Requirement 6.

- [x] 1. Add unit tests for extractContent edge cases
- [x] 1.1 (P) Test string content trimming
  - Verify leading and trailing whitespace is trimmed from string content
  - Verify content that becomes empty after trimming returns null
  - _Requirements: 4.1, 4.4_

- [x] 1.2 (P) Test content block array with all non-text blocks
  - Verify an array containing only tool_use/tool_result blocks returns null
  - Verify an array with empty text blocks returns null
  - _Requirements: 4.3, 4.4_

- [x] 1.3 (P) Test message.role fallback
  - Verify entries without a `type` field but with `message.role: "user"` are processed
  - Verify entries without a `type` field but with `message.role: "assistant"` are processed
  - _Requirements: 3.2_

- [x] 2. Add rendering tests for SessionDetailPage
- [x] 2.1 Test message rendering with role and content
  - Verify user messages display with "user" role indicator
  - Verify assistant messages display with "assistant" role indicator
  - Verify message content text is rendered
  - _Requirements: 6.1_

- [x] 2.2 Test empty state rendering
  - Verify empty state is displayed when messages array is empty
  - Verify empty state includes guidance text about sending a prompt
  - _Requirements: 6.2_

- [x] 2.3 Test navigation controls
  - Verify navigation shows current position and total count (e.g., "1 / 5")
  - Verify previous button is disabled when at the first message
  - Verify next button is disabled when at the last message
  - Verify clicking next advances to the next message
  - Verify clicking previous goes back to the previous message
  - _Requirements: 6.3, 6.4, 6.5_
