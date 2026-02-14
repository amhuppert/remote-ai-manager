# Requirements Document

## Introduction

The Dashboard UI is the primary user interface for the Claude Session Manager (CSM). It provides a three-level navigation hierarchy: project list, sessions list, and session detail. The dashboard enables developers to discover git repositories, create and manage coding sessions, send prompts, view transcripts and diffs, and monitor session status. The UI follows a dark-themed design system with responsive layouts supporting desktop, tablet, and mobile viewports.

## Requirements

### Requirement 1: Project List

**Objective:** As a developer, I want to see all my discovered git repositories as project cards, so that I can navigate to any project's sessions.

#### Acceptance Criteria

1. The Projects Page shall display a grid of project cards for all discovered repositories.
2. Each project card shall display the project name, repository path, and session count.
3. Each project card shall display an active/idle status badge based on whether running sessions exist.
4. Clicking a project card shall navigate to the project's sessions page at `/projects/[name]`.
5. When no projects are discovered, the Projects Page shall display an empty state.
6. The Projects Page shall display the total project count in the page header subtitle.

### Requirement 2: Sessions List

**Objective:** As a developer, I want to view and manage all sessions within a project, so that I can create, navigate to, and delete sessions.

#### Acceptance Criteria

1. The Sessions Page shall display a table of sessions with columns: Session name, Branch, Status, Last Activity, Prompts, and Delete action.
2. The Sessions Page shall provide a "New Session" button that opens a creation modal.
3. The Create Session Modal shall accept a session name, preview the sanitized branch name, and validate input.
4. The Sessions Page shall provide a delete action per session with a confirmation dialog.
5. After session creation, the Sessions Page shall refresh to show the new session.
6. After session deletion, the Sessions Page shall refresh to remove the deleted session.
7. Clicking a session row shall navigate to the session detail page at `/projects/[name]/[session]`.
8. Session status shall be displayed as a badge with visual indicator (running/ready/idle).
9. When no sessions exist, the Sessions Page shall display an empty state.

### Requirement 3: Session Detail Page

**Objective:** As a developer, I want a detailed view of a session showing conversation transcript, git diff, session metadata, and prompt input, so that I can interact with and monitor a coding session.

#### Acceptance Criteria

1. The Session Detail Page shall display a session info strip showing worktree path, branch name, status, and prompt count.
2. The Session Detail Page shall render the conversation transcript as a message list with user/assistant role indicators.
3. The Session Detail Page shall render the git diff in a DiffPanel alongside the conversation.
4. The Session Detail Page shall provide a prompt input area for sending prompts to the session.
5. When a prompt is being executed, the Session Detail Page shall display a running indicator and disable the prompt input.
6. The Session Detail Page shall provide a delete button with confirmation dialog that redirects to the sessions list after deletion.

### Requirement 4: Layout Modes

**Objective:** As a developer, I want to switch between different panel arrangements, so that I can focus on conversation, diff, or both depending on my current task.

#### Acceptance Criteria

1. The Layout Switcher shall provide four layout modes: conversation-only, default (conversation + 420px diff sidebar), split (50/50), and diff-only.
2. The Layout Switcher shall persist the selected mode to localStorage per project/session combination.
3. The Layout Switcher shall restore the persisted mode when returning to a session.
4. The Layout Switcher shall display visual icons representing each layout arrangement.

### Requirement 5: Navigation and Breadcrumbs

**Objective:** As a developer, I want consistent navigation with breadcrumbs, so that I always know where I am and can navigate back to parent pages.

#### Acceptance Criteria

1. The Topbar shall display the "CSM" logo linking to the projects page.
2. The Topbar shall display breadcrumb segments showing the current navigation path.
3. Each breadcrumb segment shall be a clickable link to the corresponding page.
4. On the session detail page, the Topbar shall display session-specific controls (status, layout switcher, refresh, delete).
5. On the projects and sessions pages, the Topbar shall display global status (hooks status, running sessions count).

### Requirement 6: Responsive Design

**Objective:** As a developer, I want the dashboard to be usable on mobile and tablet devices, so that I can monitor sessions from any device.

#### Acceptance Criteria

1. On mobile viewports (max-width 768px), breadcrumbs shall show only the last segment.
2. On mobile viewports, the session detail page shall replace the layout switcher with a bottom bar providing Chat/Diff tab switching.
3. On mobile viewports, the session info strip shall be collapsible with tap-to-expand.
4. On mobile viewports, modals shall render as bottom sheets.
5. On mobile viewports, the sessions table shall hide the Last Activity and Prompts columns.
6. On mobile viewports, touch targets shall be a minimum of 44px.
7. On tablet viewports (max-width 900px), the projects grid shall display in a single column.

### Requirement 7: Confirmation Dialogs

**Objective:** As a developer, I want destructive actions to require confirmation, so that I don't accidentally delete sessions.

#### Acceptance Criteria

1. The ConfirmDialog shall display a modal overlay with title, message, and action buttons.
2. The ConfirmDialog shall support a danger styling variant for destructive actions.
3. The ConfirmDialog shall close when pressing the Escape key.
4. The ConfirmDialog shall close when clicking the overlay backdrop.

### Requirement 8: Hook Status Display

**Objective:** As a developer, I want to see whether Claude Code hooks are configured, so that I know if session metadata will be captured automatically.

#### Acceptance Criteria

1. When hooks are not installed, the Projects Page shall display a warning banner with setup guidance.
2. When hooks are not installed, the Sessions Page shall display a warning banner.
3. The Topbar shall display a hook status indicator ("hooks active" or "hooks missing").
