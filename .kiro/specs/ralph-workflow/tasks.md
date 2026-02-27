# Implementation Plan

- [x] 1. Create the initialize_ralph_loop MCP tool and wire into the prompt pipeline
- [x] 1.1 (P) Create the MCP tool server factory in the Ralph Loop domain
  - Create an in-process MCP tool factory that provides the `initialize_ralph_loop` tool, following the existing in-process MCP server pattern used by other Ralph Loop tools
  - The tool accepts a required `objective` string parameter describing the workflow goal
  - When invoked, the tool handler reads the current session state and validates no workflow already exists
  - If no workflow: creates a new workflow in "planning" status with default configuration (max iterations, timeouts, circuit breaker thresholds), sets plan generation as in-progress, broadcasts an SSE `workflow-status` event for real-time UI update, dispatches plan generation fire-and-forget, and returns a success message guiding Claude to tell the user about the workflow page
  - If a workflow already exists (race condition): returns an error message indicating only one workflow per session is supported
  - All operations logged with the ralph-loop domain logger for creation success, already-exists, and unexpected errors
  - _Contracts: createInitToolServer Service API_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.8_

- [x] 1.2 Register the init tool conditionally in the prompt pipeline
  - Extend the prompt execution pipeline to conditionally register the init tool's MCP server on standard conversation prompts
  - Before building the SDK query, check whether the session already has a workflow
  - If no workflow exists, create the init tool server and include it in the SDK query `mcpServers` option
  - If a workflow exists, omit the MCP server entirely so the tool is not available to Claude
  - The session context is already available in the prompt execution function — no new parameters needed
  - _Requirements: 1.1, 1.6_

- [x] 2. (P) Create the dedicated workflow page
  - Create a new client-side page at the `/projects/[name]/[session]/workflow` route following the existing sub-page pattern (e.g., conflicts page)
  - When a workflow exists, render the existing workflow management panel as a full-page view with appropriate layout (flex column, full height)
  - When no workflow exists, display an empty state message indicating that a workflow can be started from any conversation
  - Include breadcrumb navigation (projects > project > session > Workflow)
  - The page reuses the same REST API endpoints via existing React Query hooks — no new API routes needed
  - All workflow statuses (planning, running, paused, completed, halted, aborted) are handled by the existing panel component
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

- [x] 3. Create the session overview workflow card and integrate into the session overview
- [x] 3.1 (P) Create the WorkflowCard component with real-time SSE updates
  - Create a workflow status card component for display on the session overview page with equal visual prominence to conversation cards
  - The card displays: a color-coded status badge, the workflow objective (truncated), and task plan progress (e.g., "3/7 tasks completed")
  - The entire card is a clickable link navigating to the dedicated workflow page
  - Combine session query data (authoritative initial state) with the SSE-driven workflow store for real-time status updates without page refresh
  - Status badge colors follow the existing convention: planning=diamond, running=cyan, paused=yellow, completed=green, halted=red, aborted=gray
  - Style the card full-width, matching the visual weight of conversation cards
  - Create a Storybook story for interactive review before integration
  - _Requirements: 3.1, 3.2, 3.3, 3.5_

- [x] 3.2 Integrate the workflow card into the session overview and remove the old activation button
  - Import and render the workflow card in the session overview when a workflow exists, positioned with equal prominence above the conversation grid
  - When no workflow exists, no card or section is displayed — initialization is exclusively through conversations
  - Remove the existing "Ralph Loop" button from the session overview action bar
  - Remove the workflow start mutation hook and its associated callback that were used by the old button
  - _Requirements: 3.4, 3.6_

- [x] 4. (P) Remove workflow tab from the conversation right panel
  - Remove the "Workflow" tab button from the conversation right panel tab bar
  - Remove the workflow management panel rendering from the right panel body
  - Remove the `hasWorkflow` prop from the right panel component interface and from the parent component that passes it
  - Remove `"workflow"` from the right panel tab type definition in the session detail store
  - After removal, the right panel tabs shall be: Diff, Focus (conditional on creation mode), and Specs
  - The store's default tab value handles gracefully if any stored state references the removed "workflow" tab
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

## Requirements Coverage

| Requirement | Acceptance Criteria | Covered By Tasks |
|---|---|---|
| 1 | 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8 | 1.1, 1.2 |
| 2 | 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7 | 2 |
| 3 | 3.1, 3.2, 3.3, 3.4, 3.5, 3.6 | 3.1, 3.2 |
| 4 | 4.1, 4.2, 4.3, 4.4, 4.5 | 4 |
