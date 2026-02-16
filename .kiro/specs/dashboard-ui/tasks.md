# Implementation Plan

> **Note**: Tasks 1–4 address test coverage for existing features (Requirements 1–8). Tasks 5–11 implement and test the new features (Requirements 9–12).

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

- [ ] 5. Add project archive data layer
- [ ] 5.1 (P) Extend state schema and add archive helper functions
  - Add an `archivedProjects` string array with empty default to the manager state schema
  - Implement a function to read archived project paths from persisted state and return as a Set
  - Implement a function to add or remove a project path from the archived set with atomic state write
  - Ensure archive operations do not modify existing project or session data
  - _Requirements: 11.3, 11.9_
  - _Contracts: state.ts archive helpers_

- [ ] 5.2 Write unit tests for archive state helpers
  - Verify adding a project path to the archive set persists correctly
  - Verify removing a project path from the archive set persists correctly
  - Verify archiving does not alter existing project entries or session data
  - Verify reading archived projects from fresh state returns an empty set
  - _Requirements: 11.3, 11.9_

- [ ] 6. (P) Create CardContextMenu shared component
  - Render a three-dot trigger button (vertical ellipsis) visible on parent hover and when menu is open
  - Open a positioned dropdown below the trigger, anchored to the right edge
  - Accept a typed items array and render each item as a clickable menu action
  - Support a danger variant for destructive menu items
  - Close on click outside the dropdown and on Escape key press
  - All click handlers call stopPropagation to prevent parent Link navigation
  - Add CSS styles: fade + scale animation on open (0.12s ease), hover/active item states, min-width 180px
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.6_
  - _Contracts: CardContextMenuProps, ContextMenuItem_

- [ ] 7. (P) Create archive API endpoint
  - Implement a POST route that accepts `{ archived: boolean }` to archive or unarchive a project
  - Resolve the project name parameter to an absolute path using project discovery
  - Call the archive state helper to persist the change
  - Return 404 if the project name does not match any discovered project
  - Return success response on completion
  - Depends on task 5 (archive state helpers must exist)
  - _Requirements: 11.3_
  - _Contracts: POST /api/projects/[name]/archive_

- [ ] 8. (P) Update ProjectCard for context menu and archive display
  - Extend the card component to accept archive status, menu open state, and callback props
  - Render CardContextMenu with an "Archive Project" or "Unarchive Project" item based on archive state
  - When archived: apply reduced opacity, dashed border, and an "archived" badge
  - Stop event propagation on menu trigger to prevent card Link navigation
  - Add CSS for archived card visual treatment
  - Depends on task 6 (CardContextMenu component must exist)
  - _Requirements: 11.1, 11.6, 11.7, 12.1_
  - _Contracts: ProjectCardProps_

- [ ] 9. Build ProjectsGridClient with search, filters, and archive toggle
- [ ] 9.1 Build search input with real-time name filtering
  - Render a search input above the project grid with appropriate placeholder text
  - Filter visible cards in real time as the user types, matching project name case-insensitively
  - Show a clear button when the input has text; clicking it resets the query and restores all cards
  - Add CSS for the search input, clear button, and controls bar layout
  - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 9.2 Add status filter pills with counts
  - Render "All", "Active", "Idle" filter pill buttons alongside the search input
  - Compute and display the count of matching non-archived projects for each filter
  - Apply the selected status filter to visible project cards
  - Select "All" by default on initial render
  - Add CSS for filter pills with active/inactive states
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.6_

- [ ] 9.3 Add archive toggle and integrate archive API
  - Render an archive visibility toggle showing the count of archived projects
  - When enabled, display archived cards alongside non-archived ones
  - On archive or unarchive action from a card's context menu, POST to the archive API and refresh page data
  - Update filter counts when archive state changes
  - When a project is unarchived, restore it to the default view
  - _Requirements: 10.5, 11.2, 11.4, 11.5, 11.8_

- [ ] 9.4 Combine all filters with no-results state and single-menu enforcement
  - Apply combined filter logic: search query AND status filter AND archive visibility
  - Display a "no results" empty state when no projects match all active criteria
  - Enforce only one context menu open at a time across all project cards
  - _Requirements: 9.5, 9.6, 10.7, 12.5_

- [ ] 10. Integrate ProjectsGridClient into the projects page
  - Update the server component to read archived project paths from state
  - Pass the full project list and archived paths set as props to ProjectsGridClient
  - Replace direct card rendering with the new grid client wrapper
  - Ensure project count in page header still reflects total discovered projects
  - Depends on task 9 (ProjectsGridClient must be complete)
  - _Requirements: 1.1, 1.6, 9.1, 10.1, 11.2_

- [ ] 11. Add tests for new features
- [ ] 11.1 (P) Test CardContextMenu interactions
  - Verify menu opens on trigger click
  - Verify menu closes on click outside
  - Verify menu closes on Escape key press
  - Verify clicking an item calls its action handler and closes the menu
  - Verify all click events call stopPropagation
  - _Requirements: 12.1, 12.3, 12.4, 12.6_

- [ ] 11.2 (P) Test archive API endpoint
  - Verify POST with archived:true adds the project to the archive set
  - Verify POST with archived:false removes the project from the archive set
  - Verify 404 response for an unknown project name
  - _Requirements: 11.3_

- [ ] 11.3 (P) Test ProjectsGridClient filter logic
  - Verify search filters project cards by name case-insensitively
  - Verify status filter shows only active or only idle projects
  - Verify archive toggle shows and hides archived projects
  - Verify all three filters combine correctly
  - Verify no-results state appears when no projects match
  - Verify filter counts exclude archived projects from totals
  - _Requirements: 9.2, 9.5, 9.6, 10.3, 10.4, 10.7, 11.2, 11.4_
