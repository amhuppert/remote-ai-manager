# Implementation Plan

- [x] 1. Establish the workflow graph data model, integrity rules, and persisted state foundations
- [x] 1.1 Extend the workflow graph model to cover saved definitions, mutable working definitions, validator directives, shared documents, and execution events
  - Define one schema family that captures execution contexts, ordered tasks, dependency edges, validation policies, runtime history, and shared-document metadata.
  - Seed each run from a saved workflow definition while making the execution-owned working definition the canonical semantic state for runtime edits and archived history.
  - Normalize validator outputs, runtime event payloads, and shared-document registry entries so all untrusted inputs are validated consistently.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 6.1, 6.2, 6.6, 6.7, 6.8, 6.9, 14.1, 14.6, 16.2, 16.3, 16.5, 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 1.2 Build semantic validation and layout generation for execution-context graphs
  - Enforce DAG integrity, unique identifiers, task ownership, ordered task lists, same-context retry scope, and same-context validator remediation rules.
  - Generate stable execution-context positions that preserve manual edits while still supporting planner-created drafts without stored coordinates.
  - Return specific validation failures for definition saves, planner drafts, and runtime edit attempts.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 11.6, 13.5, 13.6_

- [x] 1.3 Persist reusable workflow definitions and session-scoped executions
  - Save project-level workflow definitions with independent semantic and layout data using atomic file writes.
  - Extend session persistence to store one active graph workflow execution, its working definition, machine snapshot, history, and archived terminal runs.
  - Keep runtime execution persistence separate from project-level definition files so reusable definitions are never mutated by a live run.
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 14.1, 14.6, 16.5, 17.5_

- [x] 2. Deliver project-level workflow definition APIs and agent planning
- [x] 2.1 Implement workflow definition create, read, update, delete, and list flows
  - Expose project-scoped endpoints for saving, loading, deleting, and listing workflow definitions.
  - Reject invalid definitions with structured errors that identify the affected execution context, task, or dependency.
  - Preserve definition revisions and stored layout data so the builder can round-trip edits safely.
  - _Requirements: 10.7, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

- [x] 2.2 Implement agent-driven workflow draft generation
  - Accept a planning objective and project context, then generate execution-context graphs with explicit IDs, ordered tasks, and dependency relationships.
  - Validate generated drafts with the same semantic rules used for manual edits and return validation failures alongside the draft when needed.
  - Apply deterministic layout generation to valid drafts so users can review and edit the proposed workflow immediately.
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

- [x] 3. Build the workflow builder authoring experience
- [x] 3.1 Add builder data loading, draft state, and save orchestration
  - Create the client-side query and mutation flows needed to load workflow definitions, track unsaved changes, and persist semantic or layout edits.
  - Keep draft editing isolated to the current browser session while allowing authoritative validation to come from the server.
  - Surface save outcomes and validation failures without discarding in-progress draft changes.
  - _Requirements: 11.5, 11.6, 12.2, 12.3, 12.4, 12.5_

- [x] 3.2 Implement the execution-context graph canvas and inspector editing flows
  - Let users create, position, connect, edit, and remove execution contexts on the canvas.
  - Provide inspector workflows for task lists, validation policies, circuit breaker settings, iteration policies, and agent configuration.
  - Keep task ordering and execution-context properties editable without turning tasks into graph nodes.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 4.1, 4.6, 11.1, 11.2, 11.3, 11.4_

- [x] 3.3 Finish builder feedback, reflow, and reviewability behavior
  - Show graph integrity problems, invalid dependency changes, and save-time validation errors directly in the builder workflow.
  - Support layout reflow and reload behavior that keeps unchanged workflow graphs visually stable across edits and generated drafts.
  - Add reviewable component stories for the graph canvas, execution-context inspector, and ordered task editing interactions.
  - _Requirements: 10.7, 11.4, 11.5, 11.6_

- [x] 4. Implement workflow execution lifecycle, scheduling, and session routes
- [x] 4.1 Build the graph workflow lifecycle manager with recovery-safe state transitions
  - Start runs from a saved workflow definition by creating a session-scoped execution with a mutable working definition.
  - Support `pending`, `running`, `paused`, `completed`, `halted`, and `aborted` transitions with immediate pause semantics that mark the active task as `interrupted`.
  - Normalize in-flight work after server restart by clearing transient iteration handles, persisting interrupted state, and requiring resume to start a fresh iteration.
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 15.8_

- [x] 4.2 Implement dependency scheduling, retry bookkeeping, and circuit-breaker behavior
  - Select the next runnable execution context only after its upstream contexts have completed and passed execution-context-level validation.
  - Keep MVP execution single-context-at-a-time while still preserving concurrency eligibility in the working definition and status model.
  - Track retry attempts and circuit-breaker counters so repeated failures halt the run at the correct validation boundary.
  - _Requirements: 4.5, 7.1, 7.2, 7.3, 7.7, 7.8, 8.1, 8.2, 8.3, 8.4, 15.1, 15.2, 15.3, 16.3_

- [x] 4.3 Add session-scoped execution control, status, and history endpoints
  - Expose start, pause, resume, abort, status, and history retrieval flows for graph workflow runs within a session.
  - Return execution summaries that include lifecycle state, active execution context, interrupted task information, and archived runs.
  - Keep these routes separate from Ralph Loop contracts so both workflow systems can coexist cleanly.
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 16.4, 16.5_

- [x] 5. Implement iteration orchestration and agent-facing tools
- [x] 5.1 Build the single-iteration execution orchestrator
  - Start a fresh conversation for each iteration and preload the current shared-document registry for that execution.
  - Track one active task at a time so pause, resume, retry, and restart normalization all have deterministic task ownership.
  - Re-evaluate remaining work after each iteration so the same execution context continues until all required tasks and validation work are satisfied.
  - _Requirements: 15.3, 15.4, 15.6, 15.7, 15.8, 17.4_

- [x] 5.2 Provide scoped task and shared-document tools to execution-context agents
  - Require task progress to flow through explicit begin and complete actions instead of inferring completion from prose.
  - Allow agents to add tasks only to their own currently executing execution context when mutability permits, while blocking edit, remove, reorder, and move operations.
  - Let agents register or update shared documents with descriptions and read guidance inside the known session-worktree directory.
  - _Requirements: 5.1, 5.2, 5.3, 9.1, 9.2, 9.3, 15.5, 17.1, 17.2, 17.3_

- [x] 6. Implement validation, remediation, and runtime editing
- [x] 6.1 Build task-level and execution-context-level validation flows
  - Run task-level validators on task completion attempts and return blocking feedback into the same iteration conversation when validation fails.
  - Run execution-context-level agent validators and script validators after all tasks in a context are complete, using the configured pre-merge command without merge-time auto-commit behavior.
  - Preserve structured validator issues, validator-specific agent configuration, and task identity needed for task-level validation decisions.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8_

- [x] 6.2 Apply deterministic remediation, same-context retries, and fix-task creation
  - Reopen only completed tasks in the same execution context that failed validation when validator output requests it.
  - Convert validator issues into deterministic fix tasks appended to the end of that same execution context, with duplicate suppression for already-open equivalent work.
  - Halt or retry according to the context validation policy, enforcing maximum retry attempts before the workflow stops.
  - _Requirements: 5.8, 5.9, 6.7, 6.9, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 10.6, 16.6_

- [x] 6.3 Support user runtime task editing against the working definition
  - Allow users to add, edit, remove, reorder, and move only unfinished tasks while a workflow is running.
  - Reject edits that touch completed execution contexts or move tasks into execution contexts that are currently running or already completed.
  - Apply accepted edits atomically to the execution’s working definition and runtime task state so later iterations always start from the latest canonical run state.
  - _Requirements: 3.3, 3.4, 3.5, 9.4, 9.5, 9.6, 9.7, 10.8, 16.6_

- [x] 7. Deliver observability, live streaming, and execution UX
- [x] 7.1 Publish graph-workflow status, validation, retry, and shared-document events
  - Broadcast workflow, execution-context, task, validation, retry, circuit-breaker, and shared-document updates through the existing real-time event system.
  - Add a live iteration content stream that complements the durable transcript model without duplicating stored conversation content.
  - Keep graph workflow event contracts isolated from Ralph Loop while still following the same validation and reconnect patterns.
  - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 17.4_

- [x] 7.2 Build the session execution interface for monitoring and steering live runs
  - Show workflow status, execution-context progress, task states, validation failures, retry activity, circuit-breaker events, and archived run history.
  - Surface reopened tasks, auto-created fix tasks, and shared-document registry updates in a way that makes runtime changes understandable during and after execution.
  - Provide the user controls needed to steer runtime task edits without obscuring the current active execution context and interrupted-task state.
  - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 17.4, 17.5_

- [x] 8. Verify the feature end to end and harden regression coverage
- [x] 8.1 Add unit coverage for graph validation, layout, runtime edits, validation normalization, and shared-document rules
  - Exercise the acceptance criteria around DAG validation, task ordering, same-context remediation, runtime move restrictions, and deterministic fix-task creation.
  - Cover directory-boundary enforcement for shared documents and the canonical working-definition mutation rules.
  - _Requirements: 4.2, 4.6, 5.8, 5.9, 7.4, 7.5, 9.5, 9.6, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.8, 17.1, 17.2, 17.3_

- [x] 8.2 Add integration coverage for workflow definition routes, execution lifecycle, restart recovery, validation, and shared documents
  - Validate CRUD and planner flows, lifecycle control routes, fresh-iteration behavior, restart normalization, validator remediation, and history archiving.
  - Verify task-level feedback loops, context-level validation, same-context retries, and shared-document propagation across later iterations.
  - _Requirements: 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 6.8, 6.9, 7.1, 7.2, 7.3, 7.4, 7.6, 7.7, 7.8, 12.2, 12.3, 12.4, 13.3, 13.4, 14.3, 14.4, 14.6, 15.4, 15.5, 15.6, 15.7, 15.8, 16.5, 17.4, 17.5_

- [x] 8.3 Add UI coverage for builder and session execution workflows
  - Verify execution-context authoring, dependency editing, ordered task editing, unsaved-change feedback, and validation error presentation in the builder.
  - Verify live execution monitoring, pause and resume handling, runtime task edits, validator issue presentation, and shared-document visibility in the session experience.
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 14.3, 14.4, 16.4, 16.6, 17.4_
