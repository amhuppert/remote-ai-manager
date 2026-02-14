# Implementation Plan

> **Note**: The dashboard-ui feature is fully implemented. No production code gaps exist. Tasks below address the test coverage gap — the dashboard is the largest untested surface area in the project.

- [ ] 1. Add unit tests for shared components
- [ ] 1.1 Test ConfirmDialog rendering and interactions
  - Verify dialog renders with title, message, and action buttons when open=true
  - Verify dialog is not rendered when open=false
  - Verify clicking confirm button calls onConfirm
  - Verify clicking cancel button calls onCancel
  - Verify pressing Escape key calls onCancel
  - Verify clicking overlay backdrop calls onCancel
  - Verify danger variant applies danger styling to confirm button
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [ ] 1.2 Test Topbar breadcrumb rendering
  - Verify CSM logo links to /projects
  - Verify breadcrumb segments render with correct labels and links
  - Verify session-specific controls render on detail page
  - Verify global status renders on projects/sessions pages
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 2. Add unit tests for project list components
- [ ] 2.1 Test ProjectCard rendering
  - Verify card displays project name, path, and session count
  - Verify card links to /projects/[name]
  - Verify active status badge when running sessions exist
  - Verify idle status badge when no running sessions
  - _Requirements: 1.2, 1.3, 1.4_

- [ ] 3. Add unit tests for session list components
- [ ] 3.1 Test SessionsList rendering
  - Verify sessions table renders with all column headers
  - Verify each session row displays name, branch, status, and prompts
  - Verify empty state renders when no sessions provided
  - Verify status badge displays correct variant (running/ready/idle)
  - _Requirements: 2.1, 2.8, 2.9_

- [ ] 3.2 (P) Test CreateSessionModal
  - Verify modal renders when open=true
  - Verify input auto-focuses on open
  - Verify branch name preview updates as name is typed
  - Verify empty name shows validation error
  - Verify Enter key submits the form
  - Verify Escape key closes the modal
  - _Requirements: 2.2, 2.3_

- [ ] 4. Add unit tests for session detail components
- [ ] 4.1 Test SessionDetailPage message rendering
  - Verify messages render with role indicators (user/assistant)
  - Verify empty state shows when no messages available
  - Verify session info strip displays worktree path, branch, status, prompt count
  - _Requirements: 3.1, 3.2_

- [ ] 4.2 (P) Test LayoutSwitcher
  - Verify four layout mode buttons render
  - Verify clicking a mode calls onLayoutChange with correct mode
  - Verify active mode is visually highlighted
  - _Requirements: 4.1, 4.4_

- [ ] 4.3 (P) Test prompt input behavior
  - Verify prompt input accepts text
  - Verify send button is disabled when input is empty
  - Verify send button is disabled when sending=true (running state)
  - Verify running indicator displays when session status is "running"
  - _Requirements: 3.4, 3.5_
