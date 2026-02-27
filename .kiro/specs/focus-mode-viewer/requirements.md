# Requirements Document

## Introduction
CC currently provides a split-pane session detail view with a conversation panel and a diff panel for reviewing code changes. Focus mode sessions produce a `memory-bank/focus.md` file that captures the agent's understanding of the session objective, but users have no way to view this file from within the CC interface. This feature adds a generic markdown file viewer component that shares the diff panel's pane, UI controls for switching between the diff and markdown views, focus.md-specific integration for focus mode sessions, and visual indicators to distinguish focus mode sessions from fast mode sessions.

## Requirements

### Requirement 1: Generic Markdown Viewer Component
**Objective:** As a developer, I want a reusable markdown viewer component that can render any markdown file content, so that CC can support viewing various markdown files in the future without building new components each time.

#### Acceptance Criteria
1. The Markdown Viewer shall render markdown content with proper formatting including headings, lists, code blocks, links, bold, italic, and blockquotes.
2. The Markdown Viewer shall accept a markdown content string as input and render it as formatted HTML.
3. The Markdown Viewer shall display within the same pane area currently occupied by the diff panel.
4. The Markdown Viewer shall be scrollable when content exceeds the visible area.
5. The Markdown Viewer shall use typography and styling consistent with the existing CC design system.

### Requirement 2: Panel Layout and Switching
**Objective:** As a developer, I want to switch between viewing the diff panel and the markdown viewer in the same pane, so that I can view code changes or the focus document without leaving the session detail page.

#### Acceptance Criteria
1. The Session Detail Page shall provide a UI control to switch between the diff panel view and the markdown viewer view within the right-side pane.
2. When the user selects the markdown viewer tab, the Session Detail Page shall hide the diff panel and display the markdown viewer in its place.
3. When the user selects the diff panel tab, the Session Detail Page shall hide the markdown viewer and display the diff panel in its place.
4. The panel pane shall support the same layout flexibility as the current diff panel, including being hidden and resized to different widths.
5. When the user switches between panels, the Session Detail Page shall preserve the scroll position of each panel independently.
6. The Session Detail Page shall default to showing the diff panel when the session detail page is first loaded.

### Requirement 3: Focus.md File Viewing
**Objective:** As a developer, I want to view the `focus.md` file for a focus mode session directly within the CC interface, so that I can read the agent's understanding of the session objective alongside the conversation.

#### Acceptance Criteria
1. When a focus mode session is selected, the Session Detail Page shall provide the option to view the session's `memory-bank/focus.md` file in the markdown viewer panel.
2. The CC API shall expose an endpoint to retrieve the content of the `focus.md` file from the session's worktree directory.
3. If the `focus.md` file does not exist in the session's worktree, the Markdown Viewer shall display an informational message indicating the file is not yet available.
4. When the `focus.md` file content is being loaded, the Markdown Viewer shall display a loading state.

### Requirement 4: Focus Mode Session Scoping
**Objective:** As a developer, I want the focus.md viewing capability to only be available for focus mode sessions, so that the UI does not present irrelevant options for sessions that don't have a focus document.

#### Acceptance Criteria
1. Where a session was created in focus mode, the Session Detail Page shall display the panel switching UI with the markdown viewer option.
2. Where a session was created in fast mode, the Session Detail Page shall not display the panel switching UI or the markdown viewer option; only the diff panel shall be shown.
3. The session data model shall include a field that indicates whether the session was created in focus mode or fast mode.

### Requirement 5: Focus vs Fast Mode Session Indicator
**Objective:** As a developer, I want to visually distinguish between focus mode and fast mode sessions in the session list, so that I can quickly identify which sessions have a focus document and which are fast sessions.

#### Acceptance Criteria
1. The Session List shall display a visual indicator (badge or label) on each session entry showing whether it is a focus mode or fast mode session.
2. The visual indicator shall use distinct styling (color and/or icon) to clearly differentiate focus mode sessions from fast mode sessions.
3. The session indicator shall be visible in the session list without requiring the user to open the session detail.
4. Where a session does not have a mode recorded (legacy sessions), the Session List shall not display any mode indicator for that session.
