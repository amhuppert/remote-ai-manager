# Implementation Plan

- [x] 1. Define data models and schema foundation
- [x] 1.1 Define workflow domain schemas
  - Add Zod schemas for fix plan tasks (id, description, priority, status, timestamps, skip reason, iteration reference), circuit breaker state (three-state enum, counters, error pattern tracking), workflow configuration (max iterations, timeout, circuit breaker thresholds with defaults), halt reasons (discriminated union of all exit types), git iteration metrics (files changed, lines added/removed, changed file paths), iteration metadata (number, conversation reference, status, timing, cost, turns, git metrics, status report, task mutations, progress classification), workflow status enum, and the top-level workflow entity (status, objective, fix plan, config, circuit breaker, iterations, halt reason, timestamps, accumulated cost and duration)
  - Define custom tool input schemas: `report_status` (status enum of in_progress/complete/blocked, exit signal boolean, work summary string, work type enum) and `update_fix_plan` (completed task IDs, skipped tasks with reasons, new tasks with description and priority)
  - Derive TypeScript types via `z.infer` and export from the types module
  - _Requirements: 2.7, 3.4, 4.1, 4.2, 5.3, 6.8, 7.1, 8.1, 9.1_

- [x] 1.2 Extend existing entities and define SSE event schemas
  - Extend the conversation role to include "iteration" for managed workflow conversations
  - Extend session state with an optional nullable workflow field
  - Define SSE event schemas for workflow-status (includes workflow status, iteration count, max iterations, task progress summary, halt reason), workflow-iteration-complete (includes full iteration metadata), workflow-fix-plan-updated (includes full plan and source: tool or user), and workflow-circuit-breaker (includes full circuit breaker state)
  - Add the four new event types to the existing SSE event union
  - _Requirements: 1.6, 3.5, 13.1, 13.2, 13.3_

- [x] 2. Core engine — circuit breaker and exit detection
- [x] 2.1 (P) Implement circuit breaker state machine
  - Implement a three-state machine (CLOSED, HALF_OPEN, OPEN) that takes current state plus an iteration result and returns updated state
  - Track consecutive no-progress iterations; transition from CLOSED to HALF_OPEN when the count reaches the configured threshold and allow one recovery iteration
  - Transition from HALF_OPEN to OPEN when the recovery iteration shows no progress; transition back to CLOSED with reset counters when recovery shows progress
  - Open the circuit breaker directly when the same error pattern appears in consecutive iterations exceeding the configured same-error threshold
  - Support user-initiated reset that transitions to CLOSED with all counters zeroed
  - Include unit tests for all state transitions (CLOSED→HALF_OPEN→OPEN, HALF_OPEN→CLOSED on recovery, user reset), threshold configurations, same-error pattern detection, and counter management
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

- [x] 2.2 (P) Implement exit detection system
  - Implement a pure function that takes iteration history, current iteration result, fix plan state, circuit breaker state, and workflow config; returns either "continue" or "halt" with a reason
  - Evaluate conditions in strict priority order: plan complete → iteration cap → circuit breaker open → permission denied → test saturation → stalled exit signal
  - Plan complete: every task in the fix plan is either completed or skipped (deterministic check on structured task data); this is the only successful exit reason
  - Iteration cap: current iteration number equals configured maximum
  - Permission denied: 2 or more consecutive iterations with permission denial errors
  - Test saturation: 3 or more of the last 5 iterations classified as test-only work (work_type: testing) with no implementation
  - Stalled exit signal: 2 or more of the last 3 iterations report exit_signal: true but unresolved tasks remain in the plan
  - Classify halt reasons as successful (plan_complete) or problematic (all others)
  - Include unit tests for each exit condition in isolation, priority ordering edge cases, empty iteration history, missing status reports, partial task completion, and the stalled exit signal threshold logic
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_

- [x] 3. Core engine — progress detection and task plan management
- [x] 3.1 (P) Implement git-based progress detection
  - Capture a pre-iteration git snapshot of the worktree state before each iteration begins (e.g., working tree diff hash or git stash create)
  - After each iteration, compute the git diff to determine files changed, lines added, lines removed, and list of changed file paths
  - Classify iterations as "no progress" when zero file changes AND the status report is missing or reports in_progress AND no tasks were completed or skipped
  - Classify iterations as "progress" when file changes exist OR the status report indicates complete OR the update_fix_plan tool marked tasks as done
  - Include unit tests for classification logic with various combinations of git metrics, status reports, and task mutations; test snapshot capture and diff computation with mocked git commands
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 3.2 (P) Implement fix plan manager
  - Implement task plan state mutations: mark tasks as completed (by ID, setting completedAt timestamp), mark tasks as skipped (by ID with reason), add newly discovered tasks (with generated unique ID, priority, pending status, and iteration reference)
  - Validate mutation inputs: reject operations on non-existent task IDs, ensure task IDs are unique when adding
  - Provide a query to check if all tasks are resolved (every task either completed or skipped) for the exit detector
  - Provide a query to get pending and in-progress tasks sorted by priority (high → medium → low) for prompt construction
  - Include unit tests for all mutations, validation edge cases, the "all resolved" check counting both completed and skipped tasks, and priority sorting
  - _Requirements: 8.1, 8.3, 8.4, 8.6_

- [x] 4. Core engine — prompt construction and custom tools
- [x] 4.1 (P) Implement prompt builder
  - Construct iteration prompts that include: the objective, current task plan state (incomplete tasks sorted by priority with their IDs and descriptions), iteration number and maximum (e.g., "Iteration 5 of max 20"), and detailed instructions for using both custom tools
  - Include context from the previous iteration when available: status report data, any errors encountered, and git metrics summary
  - Describe the report_status and update_fix_plan tool schemas in the prompt with clear guidance on when to call each
  - Instruct Claude to call report_status at the end of each iteration with an honest assessment and to call update_fix_plan whenever tasks are completed, discovered, or determined unnecessary
  - Return the prompt in the async generator format required for MCP tool support
  - Summarize previous iteration context concisely to avoid prompt bloat
  - Include unit tests verifying the prompt contains all required sections, tasks are ordered by priority, previous iteration context is conditionally included, and tool instructions are present
  - _Requirements: 3.2, 4.6, 8.3_

- [x] 4.2 (P) Implement custom MCP tool server
  - Create an in-process MCP server using the SDK's createSdkMcpServer and tool() API with two tools: report_status and update_fix_plan
  - report_status handler: validate input against the Zod schema, invoke the onStatusReport callback to store the analysis, return an acknowledgment message
  - update_fix_plan handler: validate input against the Zod schema, invoke the onFixPlanUpdate async callback (which persists state changes and broadcasts SSE events), return a confirmation message
  - Return structured error messages for validation failures so Claude can understand and retry
  - Recreate the MCP server per iteration with fresh context references (closures over current iteration state)
  - Include tests for both tool handlers with valid and invalid inputs, verifying callback invocation and error message formatting
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 5. Orchestrator infrastructure
- [x] 5.1 (P) Implement orchestrator registry
  - Create an in-memory registry using a globalThis singleton Map tracking running workflow loops keyed by session identifier
  - Store the AbortController and pause-requested flag per running workflow entry
  - Support register, get, and remove operations for lifecycle management
  - Enable pause signaling by setting the pause flag on the entry; the orchestrator checks this between iterations
  - Enable abort signaling via the AbortController; calling abort terminates the active SDK query
  - _Requirements: 2.4, 2.5, 2.6_

- [x] 5.2 (P) Implement workflow stream registry
  - Create a per-workflow content streaming system using a globalThis singleton Map of ReadableStreamDefaultController sets keyed by session identifier
  - Support registering stream client controllers (returning a cleanup function), emitting content frames to all connected clients for a workflow, and closing all connections for a workflow
  - Use NDJSON frame format: content frames (iteration number + message content block), iteration boundary frames (started/completed), and terminal done frames
  - Silently remove disconnected clients when controller.enqueue() throws (same resilience pattern as the existing SSE broadcaster)
  - Support a hasClients check so the orchestrator can skip serialization when no UI is watching
  - _Requirements: 10.2_

- [x] 6. Orchestrator engine
- [x] 6.1 Implement core loop and iteration dispatch
  - Build the main orchestrator function dispatched as a fire-and-forget async: for each iteration, create a managed conversation with role "iteration", build the prompt, acquire the session lock, execute the SDK query with the custom MCP tool server, release the lock, capture the git diff, record results, evaluate exit conditions, and continue or stop
  - Execute each iteration as a fresh SDK query (no session resume) with bypass permissions, the session's worktree as working directory, and setting sources for CLI parity
  - Wire the custom MCP tool server into each SDK query call so Claude can invoke report_status and update_fix_plan
  - Check the orchestrator registry's pause flag between iterations; check the AbortController signal during the iteration
  - Deny the AskUserQuestion tool via canUseTool with an instructive message: "Autonomous iteration — make your best judgment and proceed"
  - Enforce a configurable per-iteration timeout (default 60 minutes) via AbortController
  - When Claude does not call report_status during an iteration, default to exit_signal: false and status: in_progress
  - _Requirements: 2.3, 3.1, 3.3, 3.6, 3.7, 4.5_

- [x] 6.2 Implement state persistence, streaming, and error handling
  - After each iteration, persist iteration metadata (duration, cost, turns, git metrics, status report, task mutations, progress classification) to the workflow state via atomic writes
  - Write each iteration's transcript following existing CC JSONL patterns using the managed conversation
  - Stream live iteration content (SDK messages) to connected UI clients via the workflow stream registry during execution
  - Catch SDK errors and timeouts per-iteration: log the error, record the iteration with error/timeout status, update the circuit breaker, and proceed to exit evaluation rather than halting immediately
  - Include context from failed iterations (errors, blocked tasks) in the next iteration's prompt via the prompt builder
  - Broadcast SSE events at lifecycle points: workflow status transitions, iteration started/completed, circuit breaker state changes
  - _Requirements: 2.7, 3.4, 3.5, 3.6, 13.1, 13.2_

- [x] 7. Implement plan generator
  - Build a fire-and-forget async function that reads the most recent conversation transcript from the session to build context for AI-powered task plan generation
  - Run a single SDK query with a planning-focused system prompt and a custom submit_plan MCP tool that captures structured output (array of task objects with description and priority)
  - On completion, write the suggested tasks (all pending status) to the workflow's fix plan state and broadcast a workflow-fix-plan-updated SSE event
  - Configure with a short timeout (2 minutes) and low max turns (3) since plan generation is a single tool call
  - If the user already added tasks manually before triggering generation, append the generated tasks rather than replacing existing ones
  - Handle SDK errors gracefully: log and broadcast error context, leaving the workflow in planning status for manual task entry
  - Does not acquire the session lock since plan generation is a read-only-context operation that does not modify the worktree
  - _Requirements: 8.7_

- [x] 8. State management extensions
- [x] 8.1 (P) Extend derived session status for workflow awareness
  - Update the session status derivation logic to check the workflow status first: a running workflow overrides the derived session status to "running"; a paused workflow maps to "awaiting" at the session level
  - Ensure the session-level status remains stable throughout workflow execution without flickering between iterations (during exit evaluation, git diff computation, and state writes, no conversation is in "running" status)
  - _Requirements: 1.6_

- [x] 8.2 (P) Implement workflow stale recovery on startup
  - On server startup, detect workflows stuck in "running" status (server crashed or restarted during execution) and transition them to "paused"
  - Follow the same recovery pattern used for stale conversations in the existing startup recovery logic
  - _Requirements: 2.7_

- [x] 9. API routes
- [x] 9.1 Implement workflow lifecycle routes
  - POST start: validate session exists and has no active workflow, create a workflow entity in planning status with optional initial objective, persist and return the workflow
  - POST generate-plan: validate workflow is in planning status, dispatch the plan generator as a fire-and-forget background operation, return immediately with status "generating"
  - POST confirm: validate workflow is in planning status, validate the objective is non-empty, fix plan has at least one task, and config values are within allowed ranges; dispatch the orchestrator, return the workflow in running status
  - GET status: return the current workflow state or null if no workflow exists
  - Wrap all routes with tracing and follow the existing error response pattern (409 for invalid status, 404 for not found, 400 for validation failures)
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 8.7_

- [x] 9.2 (P) Implement workflow control routes
  - POST pause: look up the running workflow in the orchestrator registry, set the pause flag, return the updated workflow; the loop stops after the current iteration completes
  - POST resume: validate the workflow is paused or halted, dispatch a new orchestrator run from the current state, return the workflow in running status
  - POST abort: signal abort via the orchestrator registry's AbortController to terminate the current iteration, mark the workflow as aborted in state, return the updated workflow
  - Return 409 Conflict with descriptive messages for invalid status transitions
  - _Requirements: 2.4, 2.5, 2.6_

- [x] 9.3 (P) Implement workflow data routes
  - PUT fix-plan: validate workflow is paused, validate task data against the fix plan schema, persist the updated plan, broadcast a workflow-fix-plan-updated SSE event with source "user"
  - PUT config: validate workflow is paused, validate configuration values against allowed ranges (rejecting invalid values with descriptive errors), persist the updated config
  - GET iterations: return the array of iteration metadata from the workflow state
  - GET stream: register a stream client via the workflow stream registry, return a ReadableStream response with NDJSON content frames for real-time iteration content
  - _Requirements: 8.5, 9.3, 9.4, 10.2, 11.3_

- [x] 9.4 Implement prompt route guards
  - Update the existing prompt route to reject requests with 409 when the session has an active workflow (status is "running")
  - Reject prompt requests with 403 for conversations with role "iteration" (managed conversations are never user-interactive)
  - These guards enforce session read-only behavior during active workflows at the API boundary, preventing lock conflicts and state corruption even if the UI is bypassed
  - _Requirements: 1.4_

- [x] 10. UI — planning phase
- [x] 10.1 Implement workflow panel and activation flow
  - [x] Build the top-level WorkflowPanel container that renders conditionally based on workflow status: no workflow shows activation CTA; planning status shows the planning panel; running/paused shows the monitoring panel; completed/halted/aborted shows the completion summary
  - [x] Distinguish workflow-driven sessions visually in the UI with status badges and indicators
  - [x] Wire the activation button to the workflow start API route, transitioning the session into workflow planning mode
  - _Prototype: `src/app/projects/[name]/[session]/workflow/WorkflowPanel.tsx` with Storybook stories covering all states (Activation, PlanningEmpty, PlanningWithTasks, PlanningGenerating, RunningEarly, RunningMidProgress, Paused, HaltedCircuitBreaker, HaltedStalledExitSignal, CompletedSuccess, Aborted)_
  - _Note: Design doc says "Start Ralph Loop button in session header" for activation; prototype uses a full ActivationView panel instead — may want both header trigger + panel content when integrating_
  - _Requirements: 1.2, 1.6, 10.1_

- [x] 10.2 (P) Implement task plan editor
  - [x] Build an interactive task list component with add and remove capabilities
  - [x] Support priority selection (high/medium/low) per task with visual priority indicators
  - [x] Display real-time completion progress: completed/total task count and a completion percentage bar
  - [x] Show task status badges (pending, in_progress, completed, skipped) with skip reasons displayed for skipped tasks
  - [x] Make the editor interactive during planning and paused states; switch to read-only during running
  - [x] Include a "Generate Plan" button with a loading state while generation is in progress
  - [x] Add drag-to-reorder capability for tasks
  - [x] Add inline editing of task descriptions
  - [x] Receive real-time updates via SSE workflow-fix-plan-updated events when Claude modifies the plan during execution
  - _Prototype: `src/app/projects/[name]/[session]/workflow/TaskPlanEditor.tsx` with stories (Empty, WithTasks, MixedStatus, ReadOnly, AllComplete, Generating)_
  - _Requirements: 8.2, 8.5, 8.6, 8.7_

- [x] 10.3 (P) Implement configuration panel and confirm flow
  - [x] Build a configuration form for max iterations (1–100, default 20), per-iteration timeout (1–120 minutes, default 60), and circuit breaker thresholds (no-progress threshold default 3, same-error threshold default 5)
  - [x] Show sensible defaults pre-filled that work for typical development workflows
  - [x] Include a "Confirm & Start" button that validates the objective is non-empty and the plan has at least one task before dispatching the workflow
  - [x] Validate all values against their allowed ranges with inline descriptive error messages
  - [x] Wire config fields as controlled inputs with onChange callbacks to API
  - [x] Make the form editable during paused states (currently only shown during planning)
  - _Prototype: Collapsible config section in WorkflowPanel PlanningView_
  - _Requirements: 2.1, 2.2, 9.1, 9.2, 9.3, 9.4_

- [x] 11. UI — real-time monitoring and control
- [x] 11.1 Implement progress dashboard and control bar
  - [x] Build a real-time status display showing: workflow status badge (running/paused/halted), iteration counter (current / max), task completion progress bar, circuit breaker state indicator (CLOSED/HALF_OPEN/OPEN with visual distinction), elapsed time, and accumulated cost
  - [x] Build lifecycle control buttons: Pause (visible during running), Resume (visible when paused or halted), Abort (visible when running or paused), with appropriate disabled states following the workflow status
  - [x] Show a confirmation dialog before abort to prevent accidental termination
  - [x] Include the iteration history timeline within the monitoring view
  - [x] Drive all dashboard data from SSE events stored in a client-side workflow Zustand store
  - _Prototype: MonitoringView metrics strip + ControlBar in WorkflowPanel, IterationTimeline component_
  - _Requirements: 10.1, 10.3, 10.4, 10.5, 10.6_

- [x] 11.2 Implement live iteration content streaming
  - [x] Connect to the workflow stream endpoint when the monitoring view mounts and the workflow is running, displaying Claude's output in real-time as it arrives
  - [x] Handle iteration boundary frames to visually separate output between iterations
  - [x] Reconnect automatically between iterations, triggered by the workflow-iteration-complete SSE event
  - [x] Disconnect cleanly on component unmount or when the workflow stops (paused, halted, completed, aborted)
  - [x] For completed iterations, display content from transcripts via the existing conversation transcript viewer instead of the live stream
  - _Prototype: Placeholder live output area exists in MonitoringView; needs full streaming implementation_
  - _Requirements: 10.2_

- [x] 11.3 Implement halt reason display and recovery actions
  - [x] When the workflow halts, display the halt reason prominently with visual distinction between successful completion and problematic halts
  - [x] Offer contextual recovery actions based on the specific halt reason: "Reset Circuit Breaker" for circuit breaker halts, "Resume" for all resumable states
  - [x] For stalled exit signal halts, specifically highlight that Claude believes the work is done but tasks remain unresolved, and present the remaining tasks for the user to review
  - [x] For problematic halts (circuit breaker, permission denied, iteration cap, test saturation), surface the specific issue and suggest concrete recovery steps
  - [x] Wire recovery actions to API routes
  - _Prototype: CompletionView in WorkflowPanel with halt banners, recovery panel, stalled exit signal warning_
  - _Requirements: 10.7, 12.4, 12.5_

- [x] 12. UI — iteration history and completion
- [x] 12.1 (P) Implement iteration history component
  - [x] Build a scrollable timeline of completed iterations, each showing: iteration number, duration, files changed count, work type badge, exit signal indicator, and work summary text
  - [x] Visually highlight error iterations and iterations that triggered circuit breaker state changes with warning/error styling
  - [x] Support expanding an iteration row to view the full transcript via the existing conversation transcript viewer
  - [x] Display the per-iteration git diff of changes (file list and line counts)
  - _Prototype: `src/app/projects/[name]/[session]/workflow/IterationTimeline.tsx` with stories (FewIterations, ManyIterations, WithErrors)_
  - _Requirements: 5.6, 11.1, 11.2, 11.3, 11.4_

- [x] 12.2 (P) Implement completion summary
  - [x] Build a summary view displayed when the workflow ends, showing: total iterations run, total duration, total cost, exit reason with success/problem classification, and final task plan state (counts of completed, skipped, and remaining tasks)
  - [x] For successful completion (plan_complete), present a success-styled summary highlighting completed and skipped tasks
  - [x] For problematic halts, surface the specific issue and suggest recovery steps
  - [x] Provide access to the cumulative git diff across all workflow iterations
  - _Prototype: CompletionView in WorkflowPanel_
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

- [x] 13. Notifications and activity panel integration
- [x] 13.1 Implement workflow notification store
  - Add a workflow notification slice to the existing client-side Zustand store, tracking active and recently-completed workflows keyed by session identifier
  - Process workflow-status SSE events to upsert workflow state; push terminal events (completed, halted, aborted) to a toast queue for display
  - Provide selector hooks: useActiveWorkflows (filters for running/paused) for the activity panel, and useWorkflowBySession for session-page header badges
  - _Requirements: 13.4, 13.5_

- [x] 13.2 Integrate workflows into activity panel
  - Display currently running workflows in the existing activity/notifications panel, showing session name, iteration progress (current/max), and workflow status
  - Show toast notifications when workflows reach terminal states (completed, halted, aborted), visible even when the user is not viewing the workflow's session page
  - _Requirements: 13.4, 13.5_

- [x] 14. Integration — session constraints and end-to-end validation
- [x] 14.1 Enforce session-level workflow constraints in the UI
  - Prevent starting a new workflow if one already exists in the session (disable the activation action)
  - Make all other conversations in the session read-only while a workflow is active (viewable in the sidebar but no new prompts can be sent)
  - Restore normal session access (prompt sending, new conversations) when the workflow completes, halts, or is aborted
  - _Requirements: 1.3, 1.4, 1.5_

- [x] 14.2 End-to-end integration testing
  - Test the full happy-path lifecycle: create session → activate workflow → configure objective and plan → start → iterations run → plan completes → verify completion summary with correct totals
  - Test abort flow: start workflow → abort during iteration → verify the current iteration is terminated, workflow is marked aborted, and session access is restored
  - Test pause/resume cycle: start → pause → verify loop stops after current iteration → edit plan while paused → resume → verify loop continues with updated plan
  - Test circuit breaker integration: simulate multiple no-progress iterations → verify HALF_OPEN transition → one more no-progress → verify OPEN and halt with circuit_breaker reason
  - Test stalled exit signal halt: configure iterations where Claude signals exit_signal: true but tasks remain → verify halt with stalled_exit_signal reason and recovery UI
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 6.1, 6.2, 6.7, 7.3, 7.4_

## Requirements Coverage

| Requirement | Acceptance Criteria | Covered By Tasks |
|---|---|---|
| 1 | 1.1, 1.2, 1.3, 1.4, 1.5, 1.6 | 1.2, 8.1, 9.4, 10.1, 14.1, 14.2 |
| 2 | 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7 | 1.1, 5.1, 6.1, 6.2, 8.2, 9.1, 9.2, 10.3, 14.2 |
| 3 | 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7 | 1.2, 4.1, 6.1, 6.2 |
| 4 | 4.1, 4.2, 4.3, 4.4, 4.5, 4.6 | 4.1, 4.2, 6.1 |
| 5 | 5.1, 5.2, 5.3, 5.4, 5.5, 5.6 | 1.1, 3.1, 12.1 |
| 6 | 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9 | 1.1, 2.2, 14.2 |
| 7 | 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7 | 2.1, 14.2 |
| 8 | 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7 | 1.1, 3.2, 4.1, 7, 9.1, 9.3, 10.2 |
| 9 | 9.1, 9.2, 9.3, 9.4 | 1.1, 9.3, 10.3 |
| 10 | 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7 | 5.2, 10.1, 11.1, 11.2, 11.3 |
| 11 | 11.1, 11.2, 11.3, 11.4 | 12.1 |
| 12 | 12.1, 12.2, 12.3, 12.4, 12.5 | 11.3, 12.2 |
| 13 | 13.1, 13.2, 13.3, 13.4, 13.5 | 1.2, 6.2, 13.1, 13.2 |
