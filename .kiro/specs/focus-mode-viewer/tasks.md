# Implementation Plan

- [x] 1. MarkdownViewer component and styling
- [x] 1.1 Install markdown rendering dependencies
  - Add `react-markdown` and `remark-gfm` packages to the project
  - Verify they resolve correctly with the existing Next.js 15 and React 19 setup
  - _Requirements: 1.1_

- [x] 1.2 Create the generic MarkdownViewer component
  - Build a shared, reusable component that accepts a markdown content string and renders it as formatted HTML
  - Support three visual states: loading (spinner), content (rendered markdown), and empty (informational message when content is null)
  - Render markdown using `react-markdown` with `remark-gfm` for GFM support (tables, strikethrough, task lists)
  - Ensure the container is scrollable when content exceeds the visible area
  - Keep the component generic — it receives content as a prop with no knowledge of `focus.md` or any specific file
  - _Requirements: 1.1, 1.2, 1.4, 3.3, 3.4_
  - _Contracts: MarkdownViewerProps_

- [x] 1.3 Add markdown viewer CSS styles
  - Add styles for the `.markdown-viewer` scrollable container and `.markdown-content` rendered area to `globals.css`
  - Style all rendered markdown elements (headings h1–h6, paragraphs, lists, code blocks, inline code, links, blockquotes) using design system tokens
  - Code blocks use `--bg-base` background, `--font-mono`, and `--border-subtle` border
  - Inline code uses `--cyan` color, `--bg-raised` background
  - Body text uses `--font-body` (Manrope) for prose, consistent with conversation message styling
  - Ensure heading hierarchy uses appropriate font sizes and weights from the design system
  - _Requirements: 1.5_

- [x] 1.4 Create Storybook story for MarkdownViewer
  - Create a story showcasing the component in all three states: loading, content with rich markdown, and empty with a custom message
  - Include a story variant with long content to demonstrate scrolling behavior
  - _Requirements: 1.1, 1.2, 1.4_

- [x] 2. (P) Focus doc API endpoint and query hook
- [x] 2.1 (P) Create the focus-doc API route
  - Add a GET endpoint that reads `memory-bank/focus.md` from the session's worktree directory
  - Look up the session in state to resolve the worktree path, returning 404 if the session does not exist
  - Read the file from disk and return `{ content: string }` on success
  - Return 404 with `{ error: string }` if the file does not exist (ENOENT)
  - Follow existing route patterns: dynamic params from URL segments, `readState` for session lookup
  - _Requirements: 3.2_
  - _Contracts: FocusDocRoute API_

- [x] 2.2 (P) Add TanStack Query hook for focus doc
  - Add a `focusDoc` query key to the session query keys
  - Create a `useFocusDocQuery` hook that fetches the focus doc content from the API
  - Include an `enabled` option so the query only runs when needed (focus mode session with focus tab active)
  - Handle 404 gracefully — return null content rather than throwing, so the MarkdownViewer can show its empty state
  - _Requirements: 3.2, 3.3, 3.4_

- [x] 3. (P) Session mode badge in session list
- [x] 3.1 (P) Add creation mode badges to the sessions table
  - Add a small badge next to the session name in the sessions table showing "focus" or "fast" based on the session's `creationMode` field
  - Use the existing `session-badge` CSS pattern: "focus" badge uses cyan accent tint, "fast" badge uses neutral/dim styling
  - Render nothing when `creationMode` is undefined (legacy sessions without a mode recorded)
  - Add the necessary CSS classes (`.session-badge.focus`, `.session-badge.fast`) to `globals.css`
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 4. Right-pane state management and panel switching
- [x] 4.1 Extend Zustand store with right-pane tab state
  - Add a `rightPaneTab` field (defaulting to "diff") and a `switchRightPaneTab` action to the session detail store
  - Export selector and action hooks following the existing store pattern
  - Ensure the right-pane tab resets to "diff" when the store resets (session navigation)
  - _Requirements: 2.5, 2.6_

- [x] 4.2 Create the RightPane wrapper component
  - Build a component that wraps DiffPanel and MarkdownViewer within the right-side pane
  - When the session is focus mode, render a tab bar (using the existing `filter-pills` CSS pattern) with "Diff" and "Focus" tabs, and switch between the two panels
  - When the session is fast mode (or undefined), render DiffPanel directly with no tab bar (transparent wrapper)
  - Mount both panels simultaneously but show only the active one (CSS `display: none` on inactive) to preserve each panel's scroll position independently
  - Fetch the focus doc content using the query hook and pass it to the MarkdownViewer
  - Default to showing the "Diff" tab on initial load
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 4.1, 4.2_
  - _Contracts: RightPaneProps_

- [x] 4.3 Wire RightPane into SessionDetailPage
  - Replace the direct DiffPanel render in SessionDetailPage with the new RightPane component
  - Pass through the session's `creationMode`, diff data, commits, project name, and session name
  - Ensure all existing layout modes (conversation, default, split, diff) continue to work unchanged — RightPane visibility is still controlled by the layout mode
  - _Requirements: 1.3, 2.4_

- [x] 4.4 Manage DiffPanel hotkeys when focus tab is active
  - Ensure DiffPanel file and change navigation hotkeys (nextFile, prevFile, nextChange, prevChange) are disabled when the focus tab is the active right-pane tab
  - This prevents hotkey actions from scrolling invisible DiffPanel content while viewing the markdown viewer
  - _Requirements: 2.5_

- [x] 5. Mobile support and final integration
- [x] 5.1 Extend mobile panel switching for focus mode
  - Add a "Focus" tab option to the mobile bottom bar panel switcher, visible only for focus mode sessions
  - Extend the `MobilePanel` type to support the "focus" value alongside "chat" and "diff"
  - Ensure the mobile focus tab displays the MarkdownViewer with the same content and states as the desktop version
  - _Requirements: 2.1, 2.4, 4.1, 4.2_

- [x] 5.2 Run type checking and fix any issues
  - Run `bun run typecheck` and resolve any TypeScript errors introduced by the new components, store extension, API route, and query hook
  - Run `bun run lint` and fix any lint violations
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4_
