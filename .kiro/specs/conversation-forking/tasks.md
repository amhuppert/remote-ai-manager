# Implementation Plan

## Pre-implemented Components
MessageActions and MessageEditor UI components are already created with Storybook stories and CSS styles. Tasks below focus on backend services, API wiring, and frontend integration.

## Tasks

- [x] 1. Extend conversation schema with fork provenance
  - Add a nullable `forkedFrom` object field to the conversation state schema with source conversation ID, source Claude session ID, and message index
  - Ensure backward compatibility so existing conversations without the field parse cleanly via a null default
  - Add a fork request validation schema for the API (message index required, edited text optional)
  - _Requirements: 3.1_
  - _Contracts: ConversationStateSchema State_

- [x] 2. Implement transcript copy service
- [x] 2.1 (P) Build transcript copying logic
  - Read source JSONL transcript and count visible messages (user/assistant with non-empty content) to locate the fork point
  - Copy all raw JSONL lines — including system and tool_result entries between visible messages — up to and including the target message
  - For direct fork: include the assistant response after the target user message if present
  - For edit-and-fork: copy lines up to the message before the fork point, then append a new JSONL entry with the edited text
  - Write the copied lines to the target conversation's transcript file
  - _Requirements: 1.1, 3.2_
  - _Contracts: TranscriptCopy Service_

- [x] 2.2 Write unit tests for transcript copy
  - Verify correct JSONL subset is copied for a direct fork at various message indices
  - Verify edit-and-fork appends the edited user message after truncating at the correct point
  - Verify system/tool_result entries between visible messages are preserved in the copy
  - Verify boundary conditions: fork at first message, fork at last message, fork when no assistant response follows
  - _Requirements: 1.1, 3.2_

- [x] 3. Implement fork conversation service
- [x] 3.1 Build fork creation logic
  - Validate that the source conversation has a resolvable Claude session ID: either its own or inherited from its `forkedFrom` metadata (supporting fork-from-fork)
  - Validate that the message index is within range of the source conversation's visible messages
  - Create a new conversation with a unique ID, null Claude session ID, `forkedFrom` metadata capturing source conversation ID, resolved source Claude session ID, and message index
  - Set prompt count to 0 for the forked conversation
  - Generate a descriptive default name indicating the source conversation and fork turn number
  - Coordinate transcript copying via the transcript copy service
  - Persist the new conversation to session state atomically
  - _Requirements: 1.1, 1.2, 2.2, 3.1, 3.2, 3.3, 3.5_
  - _Contracts: ForkConversation Service_

- [x] 3.2 Write unit tests for fork conversation service
  - Verify new conversation has correct `forkedFrom` metadata and null Claude session ID
  - Verify prompt count starts at 0
  - Verify default name follows the expected format
  - Verify validation rejects conversations with no resolvable Claude session ID
  - Verify validation rejects out-of-range message index
  - Verify fork-from-fork resolves the source Claude session ID from the parent's `forkedFrom` metadata
  - _Requirements: 1.1, 1.2, 3.1, 3.3, 3.5_

- [x] 4. Create fork API route
  - Expose a POST endpoint at the conversation-level fork path under the existing API hierarchy
  - Parse and validate the request body using the fork request schema
  - Resolve project and session from route parameters, returning 404 for missing resources
  - Return 409 if the source conversation is currently running
  - Call the fork conversation service and return the new conversation ID and name
  - Handle errors with appropriate HTTP status codes: 400 for validation, 404 for missing resources, 409 for running conversations, 500 for server errors
  - _Requirements: 1.1, 1.2, 1.3, 2.2_
  - _Contracts: ForkAPIRoute API_

- [x] 5. (P) Extend prompt execution with SDK fork parameters
  - Modify the SDK query options to resolve the `resume` parameter from the conversation's own Claude session ID, falling back to the `forkedFrom` source Claude session ID
  - Set `forkSession: true` when the conversation has fork metadata but no own Claude session ID (first prompt only)
  - After the first prompt completes, the conversation acquires its own Claude session ID and subsequent prompts resume normally without fork parameters
  - Write unit tests verifying fork parameters are injected on first prompt and absent on subsequent prompts
  - _Requirements: 4.1, 4.2, 4.3_
  - _Contracts: PromptExecution Service_

- [x] 6. (P) Extend session detail store with editing and fork prompt state
  - Add an editing index field to track which message is being edited (null when none)
  - Add a pending fork prompt field to carry the edited text and target conversation ID across navigation
  - Implement actions: start editing, cancel editing, set pending fork prompt, and consume pending fork prompt (read and clear atomically)
  - Reset editing index to null when conversation changes
  - Discard stale pending fork prompts when the conversation ID doesn't match
  - _Requirements: 2.1, 2.3, 2.4_
  - _Contracts: SessionDetailStore State_

- [x] 7. Integrate fork and edit actions into session detail page
- [x] 7.1 Wire MessageActions into the message render loop
  - Render the MessageActions component inside each user message in the virtualized list
  - Pass the conversation running status to disable actions while a prompt is executing
  - Implement the fork handler: call the fork API, then navigate to the new conversation
  - _Requirements: 1.3, 1.4, 1.5, 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 7.2 Wire MessageEditor for inline editing
  - When the store's editing index matches a message, render the MessageEditor in place of the message content and apply the editing CSS class
  - Extract the original text from the message content blocks
  - Implement the edit-save handler: call the fork API with edited text, store the pending fork prompt, then navigate to the new conversation
  - Treat unchanged text as a direct fork (no `editedText` in request)
  - Wire cancel to reset the editing index
  - _Requirements: 2.1, 2.2, 2.4, 2.5, 5.4_

- [x] 7.3 Implement auto-prompt delivery on page mount
  - On page mount, consume the pending fork prompt from the store
  - If the pending prompt's conversation ID matches the current conversation, auto-send it via the existing send prompt hook
  - _Requirements: 2.3_

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
| 1.3 | 4, 7.1 |
| 1.4 | 7.1 |
| 1.5 | 7.1 |
| 2.1 | 6, 7.2 |
| 2.2 | 3.1, 4, 7.2 |
| 2.3 | 6, 7.3 |
| 2.4 | 6, 7.2 |
| 2.5 | 7.2 |
| 3.1 | 1, 3.1 |
| 3.2 | 2.1, 3.1 |
| 3.3 | 3.1 |
| 3.4 | Existing delete logic (no changes needed) |
| 3.5 | 3.1 |
| 4.1 | 5 |
| 4.2 | 5 |
| 4.3 | Existing readConversationMessages (no changes needed) |
| 5.1 | 7.1 (MessageActions already implemented) |
| 5.2 | 7.1 (CSS already implemented) |
| 5.3 | 7.1 (CSS already implemented) |
| 5.4 | 7.1, 7.2 |
| 5.5 | 7.1 (MessageActions already implemented) |
| 6.1 | 8 |
| 6.2 | 8 |
| 6.3 | Existing sidebar sort logic (no changes needed) |
