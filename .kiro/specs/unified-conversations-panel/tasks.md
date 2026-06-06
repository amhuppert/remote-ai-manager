# Implementation Plan

- [x] 1. Status Schema, Types & Core Logic Update
- [x] 1.1 Update the conversation status schema to use new values with backward-compatible migration
  - Replace the session status enum with a new conversation status enum accepting `new`, `awaiting`, and `running`
  - Add a Zod transform branch that converts legacy values (`idle` → `new`, `ready` → `awaiting`) during parsing
  - Rename the schema export from `sessionStatusSchema` to `conversationStatusSchema` and the type from `SessionStatus` to `ConversationStatus`
  - Update the type re-exports so all downstream consumers reference the new name
  - Define a separate `DerivedSessionStatus` type for session-level derivation (`running` | `awaiting` | `idle`)
  - _Requirements: 1.1, 1.6, 1.7_

- [x] 1.2 Update all status transition code to use the new status values
  - Change conversation creation to assign `new` status instead of `ready`
  - Change imported conversation creation to assign `new` status instead of `idle`
  - Change prompt execution start to set `running` (unchanged value, but verify references)
  - Change prompt execution completion to set `awaiting` instead of `ready`
  - Change hook event processing (Stop event) to set `awaiting` instead of `ready`
  - Update the session status derivation function to check for `awaiting` instead of `ready` and `new` instead of `idle` in conversation status checks
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4_

- [x] 1.3 Write unit tests for schema migration and session status derivation
  - Test that the schema accepts `new`, `awaiting`, and `running` and parses them as-is
  - Test that `idle` is transparently migrated to `new` and `ready` is migrated to `awaiting` during parsing
  - Test that invalid status values are rejected
  - Test the session derivation function: returns `running` when any conversation is running, `awaiting` when any is awaiting and none running, `idle` when all conversations are `new` or empty
  - _Requirements: 1.1, 1.7, 2.1, 2.2, 2.3_

- [x] 2. SSE Broadcaster Extension & Real-time Infrastructure
- [x] 2.1 (P) Generalize the SSE broadcaster to support multiple event types
  - Change the broadcast function signature to accept a discriminated union of event types instead of only the session-ready event
  - Derive the SSE frame event name dynamically from the event's `type` field instead of hardcoding it
  - Define the new conversation status event type with project name, session name, conversation ID, and status fields
  - Add the event schema to the schemas module alongside the existing session-ready event schema
  - Ensure existing session-ready broadcasts continue to work unchanged
  - _Requirements: 6.3_
  - _Contracts: SSE Broadcaster Extension Event Contract_

- [x] 2.2 Add conversation-status broadcasts at status transition points
  - Broadcast a conversation-status event with `running` status when a prompt begins execution, after setting the conversation status
  - Broadcast a conversation-status event with `awaiting` status when prompt execution completes
  - Broadcast a conversation-status event with `awaiting` status from the hooks route when a Stop event is processed
  - Include the project name (derived from the project path), session name, and conversation ID in each broadcast
  - Use fire-and-forget pattern matching the existing hooks route broadcast style
  - _Requirements: 6.1, 6.2_

- [x] 2.3 (P) Update the notification listener and add the active conversations query key
  - Add a `conversation-status` event listener to the notification listener alongside the existing `session-ready` listener
  - On receiving a conversation-status event, invalidate the active conversations query key to trigger a panel refresh
  - Add the `active` key to the conversations query key hierarchy
  - Preserve existing browser notification behavior on session-ready events unchanged
  - _Requirements: 5.8, 6.1, 6.2_

- [x] 3. (P) Active Conversations API Endpoint
  - Create a new GET endpoint that reads the full application state and returns all conversations with status `running` or `awaiting`
  - Enrich each conversation with its parent project name (derived from the project path) and session name for display
  - Exclude conversations belonging to archived sessions or archived projects
  - Sort the results by most recent activity (descending)
  - Return the response as a flat list with conversation ID, name, status, last activity timestamp, project name, project path, and session name
  - _Requirements: 5.3, 5.4, 5.5_
  - _Contracts: ActiveConversations API Contract_

- [x] 4. (P) Project Badge & Filter Rework
  - Change the project card badge text from `active` to `running` when Claude Code is running in any conversation within the project
  - Update the projects page filter pills from three options (`all`, `active`, `idle`) to four options (`all`, `active`, `running`, `idle`)
  - Update the filter store type to include the new `running` option
  - Redefine filter semantics: `active` means has at least one non-archived session, `running` means has at least one running conversation, `idle` means no non-archived sessions
  - Update the filter count computation to reflect the new semantics, including a separate count for `running` projects
  - Update the project filtering logic to apply each filter according to its new definition
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 5. (P) Status Display Consistency Updates
  - Add CSS classes for the new status names (`new` and `awaiting`) in both session status badges and sidebar dots, mirroring the styling of the old `idle` and `ready` classes respectively
  - Update the conversation status dot component to map statuses to the correct CSS classes using the new names
  - Update the conversation sidebar dot function to use the new status names for CSS class selection
  - Update the session status badge component to reflect the new derived session status values
  - Update the session detail page status display computation to use `awaiting` instead of `ready` and verify `running` display is unchanged
  - Ensure `merged` display for finished sessions remains unaffected
  - _Requirements: 4.1, 4.2, 4.3, 2.4_

- [x] 6. Unified Panel Component & Integration
- [x] 6.1 Create the unified panel store and component
  - Create a Zustand store for panel open/close state following the existing store patterns (Immer middleware, exported selector and action hooks)
  - Build the panel component as a client component that fetches active conversations via a TanStack Query hook using the new active conversations query key
  - Render each conversation as a list item showing status dot, conversation name (with fallback for unnamed), session name, project name, and relative time since last activity
  - Implement click-to-navigate: each item links to the conversation detail page
  - Show an empty state message when no conversations have status `running` or `awaiting`
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.9_

- [x] 6.2 Integrate the panel toggle into the Topbar and mount the panel globally
  - Add a toggle button to the Topbar right side that is visible on all pages, positioned before page-specific controls
  - The button should show an active/highlighted state when the panel is open
  - Optionally display a badge with the count of active conversations on the toggle button
  - Mount the unified panel component in the root layout so it is accessible from every page in the application
  - _Requirements: 5.1, 5.2_

- [x] 6.3 Style the unified panel and create a Storybook story for review
  - Style the panel as a fixed-position right-side overlay: slides in from the right edge, positioned below the topbar, with a semi-transparent backdrop that closes the panel on click
  - Set z-index above page content but below modals
  - Follow the design system: surface background, subtle left border, mono font for metadata, cyan dot for running (with pulse animation), green dot for awaiting
  - Apply responsive behavior: full-width panel on mobile with backdrop
  - Add a slide-in/slide-out transition animation
  - Create a Storybook story demonstrating the panel in various states: with running conversations, with awaiting conversations, mixed states, and empty state
  - _Requirements: 5.1, 5.2, 5.6, 5.9_

- [x] 7. Consolidated Sidebar Tabs (Phase 2)
- [x] 7.1 Add CSS for sidebar tab switcher and active conversation items
  - Add `.convo-sidebar-tabs`, `.convo-sidebar-tab`, `.convo-sidebar-tab-badge` styles for the tab switcher
  - Add `.convo-sidebar-item-name-row`, `.convo-sidebar-active-meta`, `.convo-sidebar-meta-chip`, `.convo-sidebar-meta-sep`, `.convo-sidebar-active-time` styles for active conversation items
  - Add `.convo-sidebar-empty`, `.convo-sidebar-empty-hint` styles for the active tab empty state
  - Follow design system tokens: `--bg-raised`, `--cyan`, `--text-secondary`, `--text-tertiary`
  - _Requirements: 7.1-7.11_

- [x] 7.2 Create Storybook story for the consolidated sidebar design
  - Create `ConversationSidebar.stories.tsx` with a presentational shell showing both tabs
  - Include stories for Session tab, Active tab with conversations, and Active tab empty state
  - Prototype rename and archive interactions
  - _Requirements: 7.1-7.11_

- [x] 7.3 Create generic mutation hooks for cross-project operations
  - Add `useGenericArchiveConversationMutation()` to `mutations.ts` — accepts `{ projectName, sessionName, conversationId, archived }` as mutation variables
  - Add `useGenericRenameConversationMutation()` to `mutations.ts` — accepts `{ projectName, sessionName, conversationId, name }` as mutation variables
  - Both hooks invalidate `conversationKeys.list(projectName, sessionName)` and `conversationKeys.active` on success
  - _Requirements: 7.8, 7.9, 7.10_

- [x] 7.4 Implement tabs and active conversations in ConversationSidebar
  - Add `useState` for `activeTab` ("session" | "active")
  - Import and use `useActiveConversationsQuery` for the active tab data
  - Add tab switcher UI with badge count below the header
  - Render active conversations with status dot, name, relative time, and clickable project/session meta chips
  - Implement rename with separate state (`activeEditingId`, `activeEditValue`, `activeEditConvoRef`) to avoid conflict with session tab
  - Implement archive using `useGenericArchiveConversationMutation`
  - Handle the nested `<Link>` problem: meta chips use `<span onClick>` with `e.preventDefault()` + `e.stopPropagation()` + `router.push()`
  - Show empty state when no active conversations
  - _Requirements: 7.1-7.11_

- [x] 8. Button Consistency Fixes
- [x] 8.1 Update ConversationSidebar tooltips and icons
  - Change all `title` attributes to `data-tooltip` in action buttons
  - Change archive icon from `\u2912` (upward arrow to bar) to `\u2913` (downward arrow to bar)
  - _Requirements: 8.1, 8.2_

- [x] 8.2 Update ConversationList archive icon
  - Change archive icon from `\u2912` to `\u2913` for consistency with sidebar
  - _Requirements: 8.2_

## PLC Additive Extension Tasks

- [x] 9. Scope-aware Active Conversation row foundation
- [x] 9.1 Add failing helper tests for mixed session/project active rows
  - Add tests that a project conversation row derives a `project / main` context, never exposes a synthetic session name, and links to the owning project with a focus intent.
  - Add tests that session rows keep their existing `project / session` grouping, search fields, and detail-route href.
  - Add tests that mixed session/project rows preserve Needs-you, unread-finished, and running grouping based on shared status/unread fields.
  - Observable completion: the new helper tests fail before the helper implementation because project rows are still filtered or treated as session rows.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 12.1, 12.3_

- [x] 9.2 Implement scope-aware row descriptors and grouping
  - Widen the active-row helper model from session-only rows to the existing session/project active-conversation union.
  - Derive route hrefs, action scopes, group keys, group labels, display labels, and search fields from row scope.
  - Treat project conversations as a `main` worktree context without adding `sessionName` to the project row.
  - Keep closed-but-not-archived project rows eligible when the active-conversations source returns them, and leave archive exclusion to the source/refetch result.
  - Observable completion: the helper tests from 9.1 pass and existing session helper tests remain green.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 12.1, 12.3, 13.4_

- [ ] 10. Scope-aware row mutations
- [ ] 10.1 Add failing tests for project rename/archive row actions
  - Add tests that a project row rename uses project-conversation context and does not require a session name.
  - Add tests that a project row archive removes or refreshes the row through active/project invalidation while a session row still uses session invalidation.
  - Add tests that mutation failures leave the row recoverable through cache restoration or refetch.
  - Observable completion: the tests fail before mutation support because the existing generic row actions require `sessionName`.
  - _Requirements: 13.1, 13.2, 13.3, 13.4_

- [ ] 10.2 Implement scope-aware active-row rename/archive mutations
  - Route session row rename/archive through the existing session conversation endpoints.
  - Route project row rename/archive through the project-conversation endpoints.
  - Invalidate the active conversations query after either scope changes.
  - Invalidate session list keys for session rows and project conversation list/open-count keys for project rows.
  - Observable completion: project and session row action tests pass without adding a synthetic session name to project rows.
  - _Requirements: 13.1, 13.2, 13.3, 13.4_

- [ ] 11. Active Conversations UI integration
- [ ] 11.1 (P) Render project conversations in the sidebar Active tab
  - Stop filtering Active tab data to session-only rows.
  - Render project rows with `main` context, shared status/unread/backend/last-activity indicators, and project focus navigation.
  - Cover the cockpit-mounted rail through the same sidebar component that `ProjectDetailView` passes into the cockpit rail slot.
  - Keep session-only actions such as peek, answer, fork, and copy session context hidden or disabled for project rows unless another spec adds PLC parity.
  - Wire rename/archive row actions through the scope-aware mutations.
  - Observable completion: the Active tab shows mixed session/project rows, clicking a project row navigates to the project focus URL, and existing session Active tab behavior still works.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 12.2, 12.3, 12.4, 13.1, 13.2, 13.3, 13.4_
  - _Boundary: ConversationSidebar active tab, ConversationSidebarRow_
  - _Depends: 9.2, 10.2_

- [ ] 11.2 (P) Include project conversations in the topbar Needs-you shortcut
  - Count project rows with status `waiting_for_input` and unread `awaiting` rows using the same attention rules as session rows.
  - Route the first project attention target to the owning project focus URL.
  - Preserve existing badge count and href behavior when the first attention target is a session row.
  - Observable completion: topbar tests show project attention rows contribute to the Needs-you count and session-only cases remain unchanged.
  - _Requirements: 11.2, 11.3, 12.1, 12.3, 12.4_
  - _Boundary: Topbar needs shortcut_
  - _Depends: 9.2_

- [ ] 11.3 (P) Render project conversations in the global activity panel
  - Stop filtering global panel active conversation items to session-only rows.
  - Render project conversation items with project name, conversation name, `main` context, status, unread state, initialized backend where present, and last activity.
  - Route project conversation item actions to the project focus URL and close the panel after navigation.
  - Preserve existing jobs, persisted notifications, graph workflow items, and session conversation item behavior.
  - Observable completion: the global panel shows project rows from the active-conversations response and session-only panel tests remain green.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 12.3, 12.4_
  - _Boundary: Global activity panel_
  - _Depends: 9.2_

- [ ] 12. Mixed-scope visual and interaction validation
- [ ] 12.1 Add mixed session/project sidebar stories and regression tests
  - Add or update stories showing session rows, project rows, mixed groups, empty state, `waiting_for_input`, unread `awaiting`, running, and archived-after-action behavior.
  - Add component tests for project row breadcrumbs, backend badge, unread dot, status dot, activity summary, and action menu boundaries.
  - Add global panel tests or stories showing project conversation items with `main` context and project focus navigation.
  - Add regression assertions that session row grouping, rename/archive, peek, answer, fork, and copy-context behavior are unchanged.
  - Observable completion: the story renders the PLC row states without visual overlap and the component regression tests pass.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 13.1, 13.2, 13.3, 13.4_

- [ ] 12.2 Verify cross-page routing and cockpit focus handoff
  - Add an integration test or focused component test that clicking a project row navigates to `/projects/[name]?focus=[conversationId]`.
  - Verify the project page focus handler reopens/focuses the tab when the target project conversation is closed but not archived.
  - Add a failing `ProjectDetailView` focus-param test for an unavailable or inaccessible focused project conversation, then implement the minimal clear unavailable state if the current focus handler lacks one.
  - Verify the unavailable focus path never produces or navigates to a session conversation route.
  - Observable completion: cross-page routing tests pass for current-project, other-project, closed-but-not-archived, and unavailable PLC rows.
  - _Requirements: 12.1, 12.2, 12.3, 12.4_
  - _Boundary: Project focus route handoff and minimal unresolved-focus state_

- [ ] 12.3 Run targeted regression checks
  - Run the active-conversations schema/project-pass tests to confirm this extension did not alter the API project pass.
  - Run sidebar helper, sidebar row, sidebar coordinator, and topbar tests that cover the updated surfaces.
  - Run typecheck for the changed active-conversation union consumers.
  - Observable completion: targeted tests and typecheck pass, or any failure is documented with the exact blocking issue.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 12.2, 12.3, 12.4, 13.1, 13.2, 13.3, 13.4_
