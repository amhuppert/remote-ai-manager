# Implementation Plan

- [ ] 1. Schema and provisioning foundations
- [x] 1.1 Extend the session creation schemas with the "optimistic" variant
  - Add "optimistic" as a third value in the session creation mode enum alongside "fast" and "focus"
  - Add an optimistic variant to the session creation request schema, accepting a non-empty trimmed instructions text field
  - Ensure backward compatibility — existing sessions with "fast" or "focus" modes parse correctly without migration
  - _Requirements: 3.3, 1.4, 2.3_

- [x] 1.2 (P) Update session provisioning to give optimistic mode fast-mode treatment
  - Change the mode branching in session provisioning from "not fast" to "explicitly focus" so optimistic sessions receive the same treatment as fast mode
  - Optimistic sessions get a null conversation role (no initialization phase) and the standard memory-bank content
  - Verify that focus mode is unaffected and still receives its initialization conversation role and focus-specific content
  - _Requirements: 3.2, 3.3_

- [x] 2. Build the optimistic workflow orchestrator
  - Implement a fire-and-forget function that executes the user's instructions as a prompt and dispatches a smart merge on successful completion
  - Prepend an autonomous work directive to the session objective directing Claude to complete the work without asking questions
  - Deny AskUserQuestion tool calls with an explanatory message (matching the Ralph Loop pattern) to prevent the workflow from blocking on user input
  - Use a no-op event emitter since no client SSE stream is connected for fire-and-forget execution
  - On successful prompt completion, dispatch the smart merge job with automatic conflict resolution enabled; the existing merge pipeline handles commit, merge, conflict resolution, and squash merge
  - On failure (SDK error, timeout), catch the error and create a notification with details rather than throwing
  - Log phase transitions for observability: workflow start, prompt complete, merge dispatched, and failure
  - _Requirements: 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4_

- [ ] 3. Session creation and API integration
- [x] 3.1 Implement the optimistic session creation function
  - Auto-generate a session name from the user's instructions using the existing name generation capability
  - Ensure the generated name is unique within the project
  - Provision the session with optimistic mode and the instructions stored as the session objective
  - Launch the orchestrator as a detached async operation and return the session state immediately (fire-and-forget)
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3.2 Extend the sessions API route for optimistic mode
  - Add a third branch in the POST sessions endpoint for the optimistic mode variant
  - Route optimistic requests to the new session creation function
  - Return the created session state with 201 status, consistent with fast and focus modes
  - _Requirements: 1.4, 2.3_

- [ ] 4. UI: Optimistic mode dialogs and session list
- [x] 4.1 Add the "Optimistic" tab to the create session modal
  - Add a third mode button ("Fast" | "Optimistic" | "Focus") to the session mode toggle
  - When optimistic is selected, display a textarea for instructions with a voice recording button (same pattern as focus mode)
  - Include a form hint explaining that Claude will complete the task and merge the result into main
  - On submit, send the optimistic creation request; on success, close the dialog without navigating to the session page (fire-and-forget UX)
  - Extend form validation to require non-empty instructions for optimistic mode
  - Enable voice input hotkeys for optimistic mode (same as focus mode behavior)
  - Extract the instructions form as a reusable component for the standalone dialog
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 4.2 Create the standalone optimistic dialog for quick access from project pages
  - Build a lightweight modal that can be opened from any project-related page via a trigger in the project layout
  - Reuse the shared instructions form component from the create session modal
  - Receive the project name from context to target the correct project when submitting
  - On success, close the dialog with a confirmation toast (fire-and-forget)
  - Prevent submission when instructions are empty
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 4.3 (P) Add the optimistic mode badge to the sessions list
  - Display an "optimistic" badge for sessions created in optimistic mode, following the existing badge styling pattern with a distinct color
  - Optimistic sessions appear alongside fast and focus sessions with their current status visible
  - Transcript and code diff display works via the existing session detail page without changes
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
