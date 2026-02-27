# Requirements Document

## Introduction

This specification defines the redesign of Ralph Loop workflow initialization and UI placement in CC. The current flow requires users to click a "Ralph Loop" button on the session overview page, then navigate to a conversation's right-panel Workflow tab to configure it — an unintuitive pattern since the workflow is session-level and not tied to any specific conversation.

The new approach makes initialization **conversation-driven**: users initiate Ralph Loop naturally from within a conversation (e.g., "I want to use Ralph Loop for this"), Claude invokes a custom tool with a summarized objective, and the workflow is created with plan generation starting immediately. The workflow UI moves from a tab in the conversation right panel to a **dedicated page** accessible from the session overview, presented with equal prominence to conversations as a peer way of working.

**Scope boundaries:**
- This specification covers initialization flow changes, UI relocation, and session overview redesign only
- The core Ralph Loop execution engine (orchestrator, circuit breaker, exit detection, iteration execution, MCP tools) remains unchanged
- Existing workflow REST API endpoints continue to serve the dedicated page unchanged
- The planning phase confirmation flow (manual review + Confirm & Start) is preserved

## Requirements

### Requirement 1: Conversation-Based Workflow Initialization via Custom Tool

**Objective:** As a developer, I want to initialize a Ralph Loop workflow from within a conversation by asking Claude, so that I can seamlessly transition from exploratory conversation to autonomous execution without leaving the conversation context.

#### Acceptance Criteria

1. The CC shall register an `initialize_ralph_loop` in-process MCP tool on every standard conversation prompt execution via the Agent SDK `query()` options.
2. The `initialize_ralph_loop` tool shall accept a required `objective` string parameter describing the workflow goal, authored by Claude from the conversation context.
3. When Claude calls `initialize_ralph_loop`, the CC shall create a new workflow in `"planning"` status with the provided objective, using the same workflow data shape as the existing `POST /workflow` endpoint (config defaults, empty fix plan, initial circuit breaker state).
4. When Claude calls `initialize_ralph_loop`, the CC shall immediately dispatch plan generation fire-and-forget using the provided objective as the sole context source (no transcript passthrough from the originating conversation).
5. When Claude calls `initialize_ralph_loop`, the CC shall return a success response to Claude indicating the workflow was created and plan generation has started, along with guidance that the user should visit the dedicated workflow page to review and confirm.
6. While the session already has a workflow, the CC shall not register the `initialize_ralph_loop` tool on conversation prompts (the tool is only available when no workflow exists).
7. If `initialize_ralph_loop` is called but a workflow already exists (race condition), the CC shall return an error response to Claude indicating a workflow is already active.
8. When the workflow is successfully created via the tool, the CC shall broadcast an SSE event so the session overview UI updates to show the new workflow.

### Requirement 2: Dedicated Workflow Page

**Objective:** As a developer, I want to view and manage the Ralph Loop workflow on a dedicated full page, so that the workflow gets appropriate screen real estate and is clearly a session-level feature rather than a conversation-level tab.

#### Acceptance Criteria

1. The CC shall provide a dedicated workflow page at the route `/projects/[name]/[session]/workflow`.
2. The dedicated workflow page shall display the full workflow management interface: objective display, task plan editor, configuration panel, iteration timeline, live iteration stream, and control actions (confirm, pause, resume, abort).
3. While a workflow is in `"planning"` status, the dedicated page shall display the objective, the plan generation progress (if generating), the task plan editor, configuration panel, and a "Confirm & Start" action.
4. While a workflow is in `"running"` status, the dedicated page shall display the live iteration stream, iteration timeline, task plan progress, circuit breaker state, and pause/abort controls.
5. While a workflow is in a terminal status (completed, halted, aborted), the dedicated page shall display the halt reason, cumulative statistics, final task plan state, and cumulative diff.
6. The dedicated workflow page shall use the same existing workflow REST API endpoints — no new API routes are required for this page.
7. If no workflow exists for the session, the dedicated workflow page shall display an empty state indicating that a workflow can be started from a conversation.

### Requirement 3: Session Overview Workflow Card

**Objective:** As a developer, I want to see the Ralph Loop workflow status directly on the session overview page with equal prominence to conversations, so that I can navigate to the workflow and understand its state at a glance.

#### Acceptance Criteria

1. When a session has an active workflow, the session overview page shall display an inline workflow card/section with **equal visual prominence** to the conversation list.
2. The workflow card shall display: the current workflow status (planning, running, paused, completed, halted, aborted), the objective text (truncated if long), and task plan progress (e.g., "3/7 tasks completed").
3. When the user clicks the workflow card, the CC shall navigate to the dedicated workflow page at `/projects/[name]/[session]/workflow`.
4. When no workflow exists for the session, the session overview page shall not display any workflow card or section (initialization is exclusively through conversations).
5. The CC shall update the workflow card in real-time via SSE events (status changes, plan updates, iteration progress) without requiring page refresh.
6. The CC shall remove the existing "Ralph Loop" button from the session overview page action bar.

### Requirement 4: Remove Workflow Tab from Conversation Right Panel

**Objective:** As a developer, I want the conversation right panel to only show conversation-relevant tabs, so that session-level features like Ralph Loop are not confusingly embedded in conversation-level UI.

#### Acceptance Criteria

1. The CC shall remove the "Workflow" tab from the conversation page right panel tab bar.
2. The CC shall remove the `ConnectedWorkflowPanel` rendering from the right panel body.
3. The CC shall remove the `hasWorkflow` prop from the right panel component and all related prop threading from parent components.
4. The CC shall remove `"workflow"` from the right panel tab type definition in the session detail store.
5. The right panel tabs shall be: Diff, Focus (conditional on creation mode), and Specs.
