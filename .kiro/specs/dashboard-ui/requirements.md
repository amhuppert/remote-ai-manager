# Requirements Document

> **UPDATED (2026-02-22) — SDK Migration:** Requirement 8 (Hook Status Display) is obsolete — the hook system was removed. The hooks banner, `useHooksStatusQuery`, and hooks status indicators in the Topbar have been deleted from the codebase. Requirement 5.5's reference to "hooks status" in the Topbar global status should be disregarded. All other requirements remain valid.

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

### Requirement 9: Project Search

**Objective:** As a developer, I want to filter the project list by name, so that I can quickly find a specific project when managing many repositories.

#### Acceptance Criteria

1. The Projects Page shall display a search input field above the project cards grid.
2. When the user types in the search field, the Projects Page shall filter visible project cards to only those whose name contains the search query (case-insensitive).
3. The Projects Page shall filter results in real time as the user types, without requiring form submission.
4. When the search field contains text, the Projects Page shall display a clear button that resets the search query and restores all projects.
5. When no projects match the search query combined with active filters, the Projects Page shall display a "no results" empty state with guidance to adjust filters.
6. The search filter shall combine with status filters and archive visibility — only projects matching all active criteria shall be displayed.

### Requirement 10: Project Status Filters

**Objective:** As a developer, I want to filter projects by their activity status, so that I can focus on active projects or review idle ones separately.

#### Acceptance Criteria

1. The Projects Page shall display status filter controls above the project cards grid, alongside the search field.
2. The status filters shall provide options for: All, Active (projects with running sessions), and Idle (projects with no running sessions).
3. When the user selects a status filter, the Projects Page shall display only project cards matching the selected status.
4. Each status filter option shall display a count of matching non-archived projects.
5. When projects are archived or unarchived, the Dashboard shall update filter counts to reflect the current state.
6. The "All" filter shall be selected by default on page load.
7. The status filter shall combine with the search query and archive visibility — only projects matching all active criteria shall be displayed.

### Requirement 11: Project Archive

**Objective:** As a developer, I want to archive projects I no longer actively use, so that the Ground Control screen only shows projects I care about.

#### Acceptance Criteria

1. Each project card shall provide an action to archive the project, accessible via a context menu on the card.
2. When the user archives a project, the Dashboard shall mark the project as archived and hide it from the default project view.
3. When a project is archived, the Dashboard shall persist the archived state so it survives page reloads.
4. The Projects Page shall display an "Archived" toggle control that shows the count of archived projects.
5. When the user enables the "Archived" toggle, the Projects Page shall display archived projects alongside non-archived projects.
6. While displayed, archived project cards shall be visually distinct from non-archived projects (reduced opacity, dashed border, "archived" badge).
7. Each archived project card shall provide an action to unarchive the project, accessible via the same context menu.
8. When the user unarchives a project, the Dashboard shall restore the project to the default view and remove the archived visual treatment.
9. The archive state shall not affect the project's underlying data, sessions, or git repositories.

### Requirement 12: Project Card Context Menu

**Objective:** As a developer, I want an extensible action menu on each project card, so that I can perform project-level operations without navigating away from the dashboard.

#### Acceptance Criteria

1. Each project card shall display a menu trigger button (three-dot icon) in the card header.
2. The menu trigger button shall be visible on card hover and when the menu is open.
3. When the user clicks the menu trigger, the Dashboard shall display a dropdown menu with available actions for that project.
4. When the user clicks outside the dropdown menu or presses the Escape key, the Dashboard shall close the menu.
5. The Dashboard shall allow only one project card menu to be open at a time.
6. When the user clicks a menu item, the Dashboard shall execute the corresponding action and close the menu.

### Requirement 13: Project Pinning

**Objective:** As a developer, I want to pin important projects so that they appear in a dedicated section above the rest, giving me quick access to the repositories I use most.

#### Acceptance Criteria

1. Each project card shall provide a "Pin Project" action in the context menu.
2. When the user selects "Pin Project" from the context menu, the Dashboard shall mark the project as pinned and move it to the Pinned section.
3. When a project is pinned, the Dashboard shall persist the pinned state so it survives page reloads.
4. Each pinned project card shall provide an "Unpin Project" action in the context menu, replacing the "Pin Project" action.
5. When the user selects "Unpin Project" from the context menu, the Dashboard shall remove the project from the Pinned section and return it to the main projects grid.
6. The pinned state shall not affect the project's underlying data, sessions, or git repositories.

### Requirement 14: Pinned Projects Section

**Objective:** As a developer, I want pinned projects displayed in a visually distinct section above the main grid, so that I can always see and access my most important projects at a glance.

#### Acceptance Criteria

1. When one or more projects are pinned, the Projects Page shall display a "Pinned" section above the main projects grid.
2. The Pinned section shall display its own grid of project cards for all pinned projects.
3. The Pinned section shall display a section header label identifying it as the pinned area.
4. The Pinned section shall remain visible regardless of the active search query or status filter.
5. While search or status filters are active, pinned project cards in the Pinned section shall not be duplicated in the main projects grid below.
6. When no projects are pinned, the Projects Page shall not display the Pinned section.
7. When all pinned projects are archived and the archive toggle is off, the Projects Page shall not display the Pinned section.
