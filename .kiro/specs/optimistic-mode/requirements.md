# Requirements Document

## Introduction

CC currently supports two session creation modes: **Fast** (quick session with a name) and **Focus** (objective-driven with AI research phase). This specification introduces a new **Optimistic Mode** — an autonomous fix-and-merge workflow for simple, confident changes that require no user interaction. The existing fast and focus modes remain unchanged. The new session dialog gains a third tab for optimistic mode. Optimistic mode automatically creates a session, sends the instructions to Claude, and triggers a smart merge with auto-resolve when work completes — enabling fire-and-forget development for small tasks.

## Requirements

### Requirement 1: Optimistic Mode Dialog

**Objective:** As a developer, I want to open an optimistic mode dialog from any project-related page and enter instructions, so that I can quickly dispatch autonomous work without navigating to the new session dialog.

#### Acceptance Criteria

1. When the user is on any project-related page (project detail, session view, or any sub-page under a project), CC shall provide a way to open the optimistic mode dialog.
2. The optimistic mode dialog shall display a text input for entering instructions.
3. Where voice input is available, the optimistic mode dialog shall include the voice recording button (same as focus mode) for dictating instructions.
4. When the user submits the optimistic mode dialog with non-empty instructions, CC shall close the dialog and begin the autonomous workflow.
5. If the user submits the optimistic mode dialog with empty instructions, CC shall prevent submission and indicate that instructions are required.

### Requirement 2: Optimistic Mode in New Session Dialog

**Objective:** As a developer, I want an "Optimistic" tab in the new session dialog, so that I can access the autonomous workflow from the same place I create other sessions.

#### Acceptance Criteria

1. When the user opens the new session dialog, CC shall display three tabs: "Fast", "Optimistic", and "Focus".
2. When the user selects the "Optimistic" tab, CC shall display the same instructions input as the standalone optimistic mode dialog (text input with optional voice recording).
3. When the user submits from the "Optimistic" tab, CC shall initiate the same autonomous workflow as the standalone optimistic mode dialog.

### Requirement 3: Autonomous Session Creation

**Objective:** As a developer, I want optimistic mode to automatically create a session and begin work immediately, so that I don't need to manually configure or name the session.

#### Acceptance Criteria

1. When the optimistic mode workflow is initiated, CC shall automatically generate a session name derived from the user's instructions.
2. When the session is created, CC shall provision a worktree and branch following existing session provisioning logic (worktree + `csm/<name>` branch).
3. The CC session creation shall record the session with `mode: "optimistic"` to distinguish it from fast and focus sessions.
4. When the session is provisioned, CC shall immediately send the user's instructions as the first prompt to Claude with directives to begin work autonomously without user interaction.

### Requirement 4: Autonomous Execution

**Objective:** As a developer, I want Claude to work autonomously in optimistic mode sessions without waiting for my input, so that the task runs to completion unattended.

#### Acceptance Criteria

1. When an optimistic mode prompt is sent to Claude, CC shall include a system instruction directing Claude to complete the work without asking the user any questions.
2. While Claude is executing in an optimistic mode session, CC shall not present any permission or input requests to the user (Claude operates in bypass-permissions mode, same as existing sessions).
3. When Claude completes the work in an optimistic mode session, CC shall automatically proceed to the merge phase without waiting for user confirmation.

### Requirement 5: Automatic Smart Merge on Completion

**Objective:** As a developer, I want the optimistic mode workflow to automatically merge the changes into main when Claude finishes, so that the result ends up in main without manual intervention.

#### Acceptance Criteria

1. When Claude's prompt execution completes in an optimistic mode session, CC shall automatically dispatch a smart merge job with auto-resolve enabled.
2. The automatic merge shall follow the existing smart merge pipeline: commit uncommitted changes, merge main into feature branch, resolve conflicts if needed, and squash merge into main.
3. If the automatic merge completes successfully, CC shall create a notification informing the user of the successful merge.
4. If the automatic merge fails (unresolvable conflicts, validation errors), CC shall create a notification informing the user of the failure with details.

### Requirement 6: Session Visibility and Monitoring

**Objective:** As a developer, I want optimistic mode sessions to be visible in the project's session list, so that I can monitor progress and review results if needed.

#### Acceptance Criteria

1. The CC session list shall display optimistic mode sessions alongside fast and focus sessions.
2. While an optimistic mode session is running, CC shall show the session status (running, merging, completed, failed) in the session list.
3. When an optimistic mode session is selected, CC shall display the conversation transcript and code diff, same as other session types.
4. The CC session list shall visually distinguish optimistic mode sessions from fast and focus sessions (e.g., badge, icon, or label).
