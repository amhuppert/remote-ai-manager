# Requirements Document

## Introduction

This specification defines the Ralph Loop workflow as a native orchestrator feature in CSM. The Ralph Loop is an objective-driven iterative execution pattern: the user sets an objective and a task plan, and CSM runs Claude Code repeatedly in a loop until the objective is completed or a safety condition halts execution.

This is the **first of multiple custom orchestrator workflows** to be built into CSM. While existing CSM usage is conversational (user sends a prompt, Claude responds, user sends another), orchestrator workflows use the Agents SDK to shape predetermined agentic patterns where CSM drives execution programmatically. The Ralph Loop is built directly without premature framework abstraction — common orchestrator patterns will be extracted when adding the second workflow type.

**Key differences from the standalone Ralph CLI tool:**
- Uses `@anthropic-ai/claude-agent-sdk` `query()` API instead of Claude Code CLI
- CSM's existing session/worktree/conversation infrastructure provides isolation
- The web UI replaces tmux-based monitoring with first-class visual experience
- Configuration lives in CSM state rather than `.ralphrc` files
- Transcript storage uses CSM's existing JSONL format

**Guiding principle — deterministic control:** The loop lifecycle, exit evaluation, circuit breaker, progress detection, prompt construction, and state management are all deterministic code within CSM. The LLM's job is narrowed to: writing code and reporting back via custom tools with structured schemas. CSM does not rely on the LLM to follow the workflow, parse text output, or edit state files.

## Requirements

### Requirement 1: Session Integration and Workflow Activation

**Objective:** As a developer, I want to activate a Ralph Loop workflow within an existing session, so that I can start with normal conversations and transition to autonomous execution when ready.

#### Acceptance Criteria

1. The CSM shall allow sessions to be created normally using the existing session creation flow (worktree + branch).
2. Within an existing session, the CSM shall provide a UI action to begin a Ralph Loop workflow. The user may have zero or more conversations in the session before activating the workflow.
3. The CSM shall support at most one Ralph Loop workflow per session at any time.
4. While a Ralph Loop workflow is running, the CSM shall make all other conversations in that session read-only (viewable but no new prompts can be sent).
5. When the Ralph Loop workflow completes, halts, or is aborted, the CSM shall restore normal session access — the user can resume interacting with conversations and create new ones.
6. The CSM shall distinguish workflow-driven sessions from regular sessions in the data model and UI, reflecting the active workflow state.

### Requirement 2: Ralph Loop Workflow Lifecycle

**Objective:** As a developer, I want to configure, start, pause, resume, and stop Ralph Loop workflows through CSM, so that I can run autonomous iterative development sessions.

#### Acceptance Criteria

1. When the user activates a Ralph Loop workflow, the CSM shall present a planning phase where the user defines an objective and a task plan (see Requirement 8 for task plan details).
2. The CSM shall provide a configuration panel during the planning phase where the user can set loop parameters (per-iteration timeout, max iterations, circuit breaker thresholds) before starting.
3. When the user confirms and starts the workflow, the CSM shall begin executing Claude Code in a loop, passing the objective and task plan as context to each iteration.
4. When the user pauses a running workflow, the CSM shall stop after the current iteration completes (not mid-execution) and preserve all state for resumption.
5. When the user resumes a paused workflow, the CSM shall continue from where it left off with updated state.
6. When the user aborts a workflow, the CSM shall terminate execution (aborting the current iteration if running via AbortController) and mark the workflow as aborted.
7. The CSM shall persist the workflow state (status, iteration count, exit signals, circuit breaker state, task plan) across server restarts, recovering stale "running" states to "paused" on startup.

### Requirement 3: Loop Execution Engine

**Objective:** As a developer, I want the loop engine to execute Claude Code iterations intelligently, so that each iteration builds on previous progress toward the objective.

#### Acceptance Criteria

1. The CSM shall execute each loop iteration using the Agent SDK `query()` API with the session's worktree as working directory and `permissionMode: "bypassPermissions"`.
2. The CSM shall construct a prompt for each iteration that includes: the objective, current task plan state (incomplete tasks with priorities), iteration number and context (e.g., "Iteration 5 of max 20"), and any relevant context from the previous iteration's results (errors, blocked tasks).
3. Each iteration shall use a fresh `query()` call with no SDK session resume. The task plan state and worktree code changes are the only continuity between iterations, preventing LLM context degradation over long loops.
4. When an iteration completes, the CSM shall record the iteration result (duration, cost, turns, files modified, status report data) and persist it in state.
5. The CSM shall create a managed conversation (with role "iteration") for each loop iteration, each with its own transcript file following existing CSM transcript patterns. These conversations are viewable but not interactive.
6. When an iteration produces an error or the SDK returns an error, the CSM shall log the error, update the circuit breaker, and proceed to exit condition evaluation rather than halting immediately.
7. The CSM shall enforce a configurable per-iteration timeout (default: 60 minutes) via AbortController and treat timeouts as iteration failures for circuit breaker purposes.

### Requirement 4: Custom Tool Communication

**Objective:** As a developer, I want Claude to communicate iteration results via structured custom tools, so that the system can reliably extract progress signals without fragile text parsing.

#### Acceptance Criteria

1. The CSM shall provide Claude with a `report_status` custom tool via the SDK's `canUseTool` callback. The tool accepts a structured input with: status enum (in_progress/complete/blocked), exit_signal boolean, work_summary string, and work_type enum (implementation/testing/documentation/refactoring).
2. The CSM shall provide Claude with an `update_fix_plan` custom tool via `canUseTool`. The tool accepts structured input to: mark tasks as complete (by task ID), mark tasks as skipped with a reason (by task ID, for tasks that became unnecessary), and add newly discovered tasks (with description and priority).
3. When Claude calls `report_status`, the CSM shall validate the input against a Zod schema, store the analysis as the iteration's status report, and return an acknowledgment to Claude.
4. When Claude calls `update_fix_plan`, the CSM shall validate the input, mutate the workflow's task plan state, persist the change, broadcast an SSE event, and return confirmation to Claude.
5. If Claude does not call `report_status` during an iteration, the CSM shall treat the iteration as having exit_signal: false and status: in_progress.
6. The CSM shall include instructions for using `report_status` and `update_fix_plan` in each iteration's prompt, describing the tool schemas and when to use them.

### Requirement 5: Git-Based Progress Detection

**Objective:** As a developer, I want the system to detect file changes between iterations using git, so that the circuit breaker and exit detection can make informed decisions about progress.

#### Acceptance Criteria

1. Before each iteration begins, the CSM shall capture a git snapshot of the worktree state (e.g., via `git diff --stat HEAD` or tracking the working tree hash).
2. After each iteration completes, the CSM shall compute the git diff between the pre-iteration and post-iteration worktree state.
3. The CSM shall record the following per-iteration git metrics: number of files changed, number of lines added, number of lines removed, and the list of changed file paths.
4. The CSM shall classify an iteration as "no progress" for circuit breaker purposes when the iteration produced zero file changes AND the `report_status` tool was either not called or reported status: in_progress (not complete).
5. The CSM shall classify an iteration as "progress" when it produced file changes OR the `report_status` tool reported status: complete or the `update_fix_plan` tool marked tasks as done.
6. The CSM shall make the per-iteration git diff available to the UI for display in the iteration history (see Requirement 10).

### Requirement 6: Exit Detection System

**Objective:** As a developer, I want the loop to exit intelligently when the objective is complete or when continuing is unproductive, so that it doesn't waste resources or get stuck.

#### Acceptance Criteria

1. The CSM shall evaluate exit conditions after each iteration in the following priority order: plan complete, iteration cap reached, circuit breaker open, permission denied, test saturation, stalled exit signal.
2. When all tasks in the task plan are resolved — each task is either completed or skipped (deterministic check on structured task data) — the CSM shall halt the workflow with reason "plan_complete". This is the only successful completion reason.
3. When the iteration count reaches the configured maximum iterations, the CSM shall halt the workflow with reason "iteration_cap".
4. When the circuit breaker is in OPEN state, the CSM shall halt the workflow with reason "circuit_breaker" (see Requirement 7 for circuit breaker details).
5. When Claude reports permission denied errors in 2 or more consecutive iterations, the CSM shall halt the workflow with reason "permission_denied".
6. When 3 or more of the last 5 iterations are classified as test-only (work_type: "testing" from `report_status` with no implementation work), the CSM shall halt the workflow with reason "test_saturation".
7. When Claude signals exit_signal: true via `report_status` in 2 or more of the last 3 iterations but tasks remain unresolved (neither completed nor skipped), the CSM shall halt the workflow with reason "stalled_exit_signal". This indicates Claude believes it is done but the task plan disagrees — the user must review whether remaining tasks should be completed, skipped, or removed.
8. When the workflow halts, the CSM shall record the exit reason, final iteration number, and summary in state and broadcast a status event to the UI.
9. The CSM shall categorize halt reasons as either successful ("plan_complete") or problematic (all others), and the UI shall reflect this distinction in how the outcome is presented (see Requirement 12).

### Requirement 7: Circuit Breaker

**Objective:** As a developer, I want a circuit breaker that detects when the loop is stuck or making no progress, so that it stops burning API credits on unproductive iterations.

#### Acceptance Criteria

1. The CSM shall implement a three-state circuit breaker (CLOSED, HALF_OPEN, OPEN) per workflow instance.
2. While the circuit breaker is CLOSED, the CSM shall allow loop iterations to proceed normally and track the consecutive no-progress count (as defined in Requirement 5 AC 4).
3. When the no-progress count reaches a configurable threshold (default: 3), the CSM shall transition to HALF_OPEN and allow one more iteration as a recovery attempt.
4. If the HALF_OPEN iteration shows no progress (as defined in Requirement 5 AC 4), the CSM shall transition to OPEN and halt the workflow with reason "circuit_breaker".
5. If the HALF_OPEN iteration shows progress (as defined in Requirement 5 AC 5), the CSM shall transition back to CLOSED and reset counters.
6. When the same error message or pattern appears in a configurable number of consecutive iterations (default: 5), the CSM shall open the circuit breaker with reason "repeated_error".
7. The CSM shall allow the user to reset the circuit breaker from the UI, which transitions back to CLOSED and resets all counters.

### Requirement 8: Task Plan Management

**Objective:** As a developer, I want to create and manage a structured task plan through a first-class UI, so that I can define what Claude works on and track progress in real time.

#### Acceptance Criteria

1. The CSM shall store the task plan as structured data — an array of task objects with fields: id, description, priority (high/medium/low), status (pending/in_progress/completed/skipped), createdAt, completedAt, and skipReason (for skipped tasks).
2. The CSM shall provide a UI for creating tasks during the workflow planning phase, including adding, removing, reordering, and setting priority for each task.
3. The CSM shall include instructions and the current task plan state in the prompt for each iteration, so Claude knows which tasks to work on.
4. When Claude calls the `update_fix_plan` tool to mark tasks as complete, mark tasks as skipped, or add new tasks, the CSM shall update the task plan state, persist it, and broadcast changes via SSE.
5. While a workflow is paused, the CSM shall allow the user to edit the task plan (add, remove, reorder, reprioritize tasks) with changes taking effect on the next iteration.
6. The CSM shall display the current task plan with real-time progress (completed/total tasks, completion percentage) in the workflow UI.
7. The CSM shall provide a planning phase where, upon workflow activation, Claude can generate a suggested task plan from the conversation context. The user reviews and edits this plan before confirming.

### Requirement 9: Workflow Configuration

**Objective:** As a developer, I want to configure workflow parameters before and during execution, so that I can tune the loop behavior for different projects and situations.

#### Acceptance Criteria

1. The CSM shall provide configuration options for: per-iteration timeout (default: 60 minutes), maximum iterations (default: 20), and circuit breaker thresholds (no-progress threshold, default: 3; same-error threshold, default: 5).
2. The CSM shall provide sensible defaults for all configuration options that work for typical development workflows.
3. When a user modifies configuration while the workflow is paused, the CSM shall apply the new configuration on the next iteration.
4. The CSM shall validate all configuration values against their allowed ranges and reject invalid values with descriptive errors.

### Requirement 10: Real-Time Monitoring UI

**Objective:** As a developer, I want a rich, real-time monitoring interface for active workflows, so that I can observe progress and intervene when needed.

#### Acceptance Criteria

1. The CSM shall display the current workflow status (running, paused, completed, halted, aborted) with a visual indicator.
2. While a workflow is running, the CSM shall stream the current iteration's Claude output in real-time to the UI via SSE.
3. The CSM shall display an iteration history showing each completed iteration's summary: iteration number, duration, files modified, work type (from `report_status`), exit signal value, and work summary.
4. The CSM shall display the circuit breaker state (CLOSED/HALF_OPEN/OPEN) and its counters in the workflow status area.
5. The CSM shall display iteration progress (current iteration / max iterations) in the workflow status area.
6. The CSM shall provide controls to start, pause, resume, and abort the workflow directly from the monitoring UI.
7. When the workflow halts (via exit detection or circuit breaker), the CSM shall display the halt reason prominently and offer appropriate recovery actions (reset circuit breaker, edit task plan, resume).

### Requirement 11: Iteration Review and History

**Objective:** As a developer, I want to review what happened in each iteration, so that I can understand what Claude did and debug issues.

#### Acceptance Criteria

1. The CSM shall provide access to the full transcript of each iteration via its managed conversation, using the existing conversation transcript viewer.
2. The CSM shall display the git diff of changes made during each iteration, derived from the per-iteration git snapshots (see Requirement 5).
3. The CSM shall provide a timeline or log view showing the sequence of iterations with their statuses, durations, and key metrics.
4. When an iteration resulted in an error or triggered a circuit breaker state change, the CSM shall visually highlight that iteration in the history.

### Requirement 12: Workflow Completion and Results

**Objective:** As a developer, I want clear outcomes when a workflow finishes, so that I can review the work and take next steps.

#### Acceptance Criteria

1. When a workflow completes (any exit reason), the CSM shall display a summary showing: total iterations, total duration, total cost, exit reason, and final task plan state (completed, skipped, and remaining tasks).
2. The CSM shall provide access to the cumulative git diff of all changes made across all iterations in the workflow.
3. When the workflow completes successfully (reason: "plan_complete"), the CSM shall present the outcome as a success with a summary of completed and skipped tasks.
4. When the workflow halts with reason "stalled_exit_signal", the CSM shall highlight that Claude believes the work is done but tasks remain unresolved, and present the remaining tasks for the user to review (complete, skip, remove, or resume the workflow).
5. When the workflow halts due to a problem (circuit breaker, permission denied, iteration cap, test saturation), the CSM shall surface the specific issue and suggest recovery steps.

### Requirement 13: SSE Events and Notifications

**Objective:** As a developer, I want real-time push updates for workflow state changes and notifications when workflows complete or halt, so that I stay informed without polling.

#### Acceptance Criteria

1. The CSM shall broadcast SSE events for workflow status transitions (started, iteration-started, iteration-completed, paused, resumed, halted, completed, aborted).
2. The CSM shall broadcast SSE events for circuit breaker state transitions (closed → half_open, half_open → open, reset → closed).
3. The CSM shall include the workflow's key metrics (iteration count, exit signals, circuit breaker state, task plan progress) in status broadcast events so the UI can update without additional API calls.
4. When a workflow completes or halts, the CSM shall create a notification in the existing activity/notifications panel, visible even if the user is not on the workflow's session page.
5. The CSM shall display currently running workflows in the activity panel, showing session name, iteration progress, and status.
