# Requirements Document

## Introduction

The Workflow Graph Builder adds a graph-based workflow orchestration system alongside the existing Ralph Loop. Instead of modeling every task as a graph node, the Workflow Graph Builder models a workflow as a directed acyclic graph of execution contexts. Each execution context contains an ordered task list, shared agent configuration, validation policy, and circuit breaker policy, while the dependency graph between execution contexts expresses ordering and future parallelism.

The feature has three major goals: (1) a schema-first workflow definition model for execution contexts, tasks, dependencies, layout, and runtime state, (2) an interactive workflow editor for defining execution contexts, task lists, and dependency relationships, and (3) a session-scoped execution engine that runs execution contexts iteratively until their tasks are complete and validated. The Workflow Graph Builder coexists with Ralph Loop in this phase; replacing Ralph Loop is out of scope.

## Requirements

### Requirement 1: Workflow Definition Model

**Objective:** As a developer, I want a schema-first workflow definition model, so that the editor, planner, persistence layer, and execution engine all use the same source of truth.

#### Acceptance Criteria
1. The Workflow Graph Builder shall represent a workflow definition as a collection of execution contexts and dependency edges with stable unique IDs.
2. The Workflow Graph Builder shall separate the workflow into three schema layers that share stable IDs: semantic definition, visual layout, and execution state.
3. The Workflow Graph Builder shall include a schema version identifier in the workflow definition.
4. The Workflow Graph Builder shall support only top-level execution contexts in MVP and shall reject nested execution contexts.
5. The Workflow Graph Builder shall define the workflow model so that future workflow elements and policies can be added without redefining existing persisted workflows.

### Requirement 2: Execution Contexts

**Objective:** As a user planning a workflow, I want execution contexts that group related work under a shared execution policy, so that I can control how work is organized, executed, and validated.

#### Acceptance Criteria
1. The Workflow Graph Builder shall represent each execution context with a unique ID, a human-readable title, and descriptive instructions.
2. The Workflow Graph Builder shall represent each execution context as the owner of an ordered list of tasks.
3. The Workflow Graph Builder shall support agent configuration on each execution context, including the model and reasoning-effort settings used to execute that context.
4. The Workflow Graph Builder shall support circuit breaker configuration on each execution context.
5. The Workflow Graph Builder shall support iteration policy on each execution context, including limits that constrain autonomous execution across iterations.
6. The Workflow Graph Builder shall support optional task-level validation configuration and optional execution-context-level validation configuration on each execution context.

### Requirement 3: Tasks Within Execution Contexts

**Objective:** As a user planning a workflow, I want tasks to be managed as ordered work items inside an execution context, so that I can express the intended sequence of work without modeling each task as a graph node.

#### Acceptance Criteria
1. The Workflow Graph Builder shall represent each task with a unique ID, a human-readable title, and instructions describing the work to be performed.
2. The Workflow Graph Builder shall support optional metadata on tasks for user-defined annotations.
3. The Workflow Graph Builder shall persist the task order within each execution context.
4. The Workflow Graph Builder shall require every task to belong to exactly one execution context.
5. When a workflow execution is created, the Workflow Graph Builder shall assign each task a default runtime status of `pending`.

### Requirement 4: Execution Context Dependency Graph

**Objective:** As a user planning a workflow, I want directed dependencies between execution contexts, so that the workflow can express ordering constraints and future parallel opportunities at the correct level of abstraction.

#### Acceptance Criteria
1. The Workflow Graph Builder shall represent dependency edges as directed connections between execution context IDs.
2. The Workflow Graph Builder shall enforce that the execution-context dependency graph forms a strict DAG.
3. The Workflow Graph Builder shall treat execution contexts with no incoming dependencies as entry contexts.
4. The Workflow Graph Builder shall treat execution contexts with no outgoing dependencies as terminal contexts.
5. The Workflow Graph Builder shall identify execution contexts whose prerequisites are satisfied as concurrently eligible, even when MVP execution remains sequential.
6. The Workflow Graph Builder shall reject dependency edges that reference tasks instead of execution contexts.

### Requirement 5: Task-Level Validation

**Objective:** As a user, I want optional task-level validation inside an execution context, so that tasks cannot be marked complete until they satisfy the configured quality bar.

#### Acceptance Criteria
1. Where task-level validation is enabled on an execution context, when the agent attempts to mark a task as complete, the Workflow Graph Builder shall run the configured task validator for that execution context.
2. When the task validator approves completion, the Workflow Graph Builder shall mark the task as complete.
3. If the task validator blocks completion, the Workflow Graph Builder shall leave the task incomplete and return validator feedback to the current iteration conversation so the agent can continue working.
4. The Workflow Graph Builder shall apply the same task-validator configuration to all tasks within an execution context.
5. The Workflow Graph Builder shall provide the validator enough task identity information to validate the specific task the agent attempted to complete.
6. The Workflow Graph Builder shall support a validator-specific agent configuration for task-level validation that is independent of the execution context's agent configuration.
7. When a task-level agent validator returns structured validation issues, the Workflow Graph Builder shall preserve each issue's title and description.
8. When a task-level agent validator returns task IDs to mark incomplete, the Workflow Graph Builder shall reopen only tasks that are already completed and belong to the same execution context.
9. Where automatic fix-task creation is enabled for task-level validation, when a task-level agent validator returns validation issues, the Workflow Graph Builder shall create new fix tasks from those issues and append them to the end of the same execution context's task list.

### Requirement 6: Execution Context-Level Validation

**Objective:** As a user, I want execution-context-level validation before downstream work starts, so that each execution context must satisfy its completion criteria before the workflow advances.

#### Acceptance Criteria
1. The Workflow Graph Builder shall support agent validators at the execution-context level.
2. The Workflow Graph Builder shall support script validators at the execution-context level.
3. When all tasks in an execution context are marked complete, the Workflow Graph Builder shall run the configured execution-context-level validators before allowing downstream execution contexts to progress.
4. When both an agent validator and a script validator are enabled for an execution context, the Workflow Graph Builder shall require both to pass before the execution context is considered validated.
5. When the script validator is enabled, the Workflow Graph Builder shall use the project's configured pre-merge validation command.
6. The Workflow Graph Builder shall support validator-specific agent configuration for execution-context-level agent validation that is independent of the execution context's agent configuration.
7. When an execution-context-level agent validator runs, the Workflow Graph Builder shall require its response to support identifying completed tasks in the same execution context that should be reopened.
8. When an execution-context-level agent validator returns structured validation issues, the Workflow Graph Builder shall preserve each issue's title and description.
9. Where automatic fix-task creation is enabled for execution-context-level validation, when an execution-context-level agent validator returns validation issues, the Workflow Graph Builder shall create new fix tasks from those issues and append them to the end of the same execution context's task list.

### Requirement 7: Retry Policy for Execution Context Validation

**Objective:** As a user, I want execution-context-level validation failures to reopen the correct work and retry at the execution-context level, so that the system can continue autonomously without modeling retry behavior as task-level graph edges.

#### Acceptance Criteria
1. The Workflow Graph Builder shall support execution-context-level validation failure policies with a mode of `halt` or `retry`.
2. Where execution-context-level validation retry is enabled, the Workflow Graph Builder shall apply that retry only to the same execution context whose validation failed.
3. Where execution-context-level validation retry is enabled, the Workflow Graph Builder shall require a maximum retry-attempt limit.
4. When execution-context-level validation fails with retry enabled, the Workflow Graph Builder shall allow the validator result to reopen tasks in the same execution context by unmarking those tasks as complete.
5. When a validator result requests task reopening, the Workflow Graph Builder shall reopen only completed tasks in that same execution context.
6. When automatic fix-task creation is enabled and a validator result contains validation issues, the Workflow Graph Builder shall add corresponding fix tasks before that same execution context is rerun.
7. When reopened tasks or newly created fix tasks exist after execution-context-level validation fails, the Workflow Graph Builder shall rerun that same execution context so the remaining work can be completed.
8. If the maximum retry-attempt limit is reached without a passing validation result, the Workflow Graph Builder shall halt workflow execution at that validation boundary.

### Requirement 8: Circuit Breakers

**Objective:** As a user, I want circuit breakers on execution contexts, so that autonomous execution stops when repeated failures indicate the workflow is not making meaningful progress.

#### Acceptance Criteria
1. The Workflow Graph Builder shall support circuit breaker configuration on each execution context.
2. The Workflow Graph Builder shall support, at minimum, a consecutive-failure threshold for each execution context circuit breaker.
3. When the configured consecutive-failure threshold is reached, the Workflow Graph Builder shall halt execution for that workflow run.
4. When an execution context later completes validation successfully, the Workflow Graph Builder shall reset that execution context's consecutive-failure counter.

### Requirement 9: Mutability and Runtime Task Editing

**Objective:** As a user, I want runtime task editing rules that distinguish agent autonomy from user control, so that agents stay constrained while users can still steer unfinished work.

#### Acceptance Criteria
1. The Workflow Graph Builder shall support mutability policy on each execution context that controls whether its agent may add tasks during execution.
2. Where execution-context mutability allows agent task creation, the Workflow Graph Builder shall allow the agent to add tasks only to its own currently executing execution context.
3. The Workflow Graph Builder shall prevent agents from editing, removing, reordering, or moving tasks.
4. While a workflow is running, the Workflow Graph Builder shall allow the user to add, edit, remove, and reorder tasks that are not already completed.
5. While a workflow is running, the Workflow Graph Builder shall allow the user to move an incomplete task to another execution context only if the destination execution context is not currently running and not completed.
6. The Workflow Graph Builder shall prevent any change to a completed execution context.
7. The Workflow Graph Builder shall prevent agents and users from modifying dependency edges between execution contexts during runtime.

### Requirement 10: Workflow Integrity Validation

**Objective:** As a developer, I want semantic validation beyond structural schema checks, so that invalid workflow definitions and invalid runtime edits are rejected before they can corrupt execution.

#### Acceptance Criteria
1. The Workflow Graph Builder shall validate that the execution-context dependency graph is acyclic.
2. The Workflow Graph Builder shall validate that all dependency edges reference existing execution contexts.
3. The Workflow Graph Builder shall validate that all execution context IDs and task IDs are unique within a workflow definition.
4. The Workflow Graph Builder shall validate that every task belongs to exactly one execution context.
5. The Workflow Graph Builder shall validate that execution-context-level retry policies can apply only to the same execution context whose validation failed.
6. The Workflow Graph Builder shall validate that validator-directed task reopening can reference only tasks within the validator's execution context.
7. If workflow validation fails, the Workflow Graph Builder shall return specific validation errors that identify the affected execution context, task, or edge.
8. When a runtime edit is proposed, the Workflow Graph Builder shall validate the edited workflow against the same semantic integrity rules before accepting the change.

### Requirement 11: Visual Workflow Editor

**Objective:** As a user, I want an interactive workflow editor for execution contexts, dependency relationships, and task lists, so that I can design and modify workflows visually and inspect their internal work items.

#### Acceptance Criteria
1. The Workflow Graph Builder shall render workflow definitions as interactive execution-context diagrams.
2. The Workflow Graph Builder shall allow users to create, position, connect, and remove execution contexts in the editor.
3. When a user selects an execution context, the Workflow Graph Builder shall display a configuration panel for editing that execution context's properties, task list, validation settings, circuit breaker settings, and agent configuration.
4. When a user changes dependency relationships in the editor, the Workflow Graph Builder shall validate that the resulting dependency graph remains acyclic.
5. While the editor has unsaved changes, the Workflow Graph Builder shall indicate the unsaved state to the user.
6. The Workflow Graph Builder shall persist visual layout separately from the semantic workflow definition.

### Requirement 12: Workflow Persistence

**Objective:** As a user, I want workflow definitions to be saved and reused at the project level, so that I can manage workflows independently of any individual session execution.

#### Acceptance Criteria
1. The Workflow Graph Builder shall store workflow definitions at the project level.
2. The Workflow Graph Builder shall support create, read, update, delete, and list operations for workflow definitions.
3. The Workflow Graph Builder shall expose workflow-definition persistence through project-scoped API routes.
4. When a workflow definition is saved, the Workflow Graph Builder shall validate it and reject invalid definitions with specific error messages.
5. When a workflow definition is saved, the Workflow Graph Builder shall persist both the semantic definition and the visual layout.
6. The Workflow Graph Builder shall assign a unique identifier to each workflow definition when it is created.

### Requirement 13: Agent-Driven Planning

**Objective:** As a user, I want AI agents to generate workflow definitions that I can review and edit, so that I can bootstrap complex workflows without manually designing every execution context and task.

#### Acceptance Criteria
1. The Workflow Graph Builder shall define the workflow schema so it can be produced by AI agents through structured output.
2. The Workflow Graph Builder shall require agent-generated workflow definitions to include explicit IDs for execution contexts, tasks, and dependency relationships.
3. When an agent generates a workflow definition, the Workflow Graph Builder shall validate it against the same workflow integrity rules used for manual edits.
4. If an agent-generated workflow definition has validation errors, the Workflow Graph Builder shall present those errors alongside the generated draft so the user can correct them.
5. The Workflow Graph Builder shall not require AI agents to generate visual layout coordinates.
6. When an AI agent plans a workflow, the Workflow Graph Builder shall preserve dependency information that reflects potential parallel execution contexts even when MVP runtime execution remains sequential.

### Requirement 14: Workflow Execution Lifecycle

**Objective:** As a user, I want to start, pause, resume, and abort workflow execution within a session, so that I can control long-running autonomous work without losing prior progress.

#### Acceptance Criteria
1. When a user starts workflow execution, the Workflow Graph Builder shall create a session-scoped execution instance that references a specific saved workflow definition and initializes a mutable working definition for that run from the saved definition.
2. The Workflow Graph Builder shall support execution status transitions of `pending` to `running` to `completed`, `halted`, or `aborted`, with `running` and `paused` as reversible states.
3. When a user pauses execution while a task is active, the Workflow Graph Builder shall stop the active execution actor and record the active task as `interrupted`.
4. When a user resumes execution after an interrupted task, the Workflow Graph Builder shall rerun that interrupted task from the beginning.
5. When execution is paused or aborted, the Workflow Graph Builder shall preserve partial file changes already made in the session worktree.
6. The Workflow Graph Builder shall persist execution state, including the mutable working definition for the run, so that workflow progress survives server restarts.

### Requirement 15: Execution Scheduling and Iterative Context Execution

**Objective:** As a user, I want the execution engine to schedule execution contexts by dependency order and complete their tasks across multiple iterations, so that the workflow can combine graph orchestration with Ralph-style autonomous task completion.

#### Acceptance Criteria
1. The Workflow Graph Builder shall execute an execution context only after all of its upstream execution contexts have completed and passed execution-context-level validation.
2. The Workflow Graph Builder shall execute at most one execution context at a time in MVP.
3. While an execution context has remaining incomplete tasks and execution has not halted, the Workflow Graph Builder shall continue running further iterations for that execution context.
4. When the Workflow Graph Builder starts a new iteration for an execution context, it shall create a fresh conversation for that iteration.
5. When an execution context agent attempts to complete a task, the Workflow Graph Builder shall require that completion to go through a task-completion tool rather than treating the task as complete from prose alone.
6. If task-level validation blocks task completion during an iteration, the Workflow Graph Builder shall return the validation feedback to that same iteration conversation so the agent can continue working within the current execution context.
7. When the Workflow Graph Builder starts a new conversation for an execution context iteration, it shall provide the current shared-document registry for that session so the agent can discover relevant documents created by other agents.
8. If the server restarts while an iteration is in progress, the Workflow Graph Builder shall normalize that in-flight iteration by marking its active task as `interrupted`, clearing transient iteration handles, and requiring resume to start a fresh iteration conversation from that interrupted task.

### Requirement 16: Observability and Execution History

**Objective:** As a user, I want real-time visibility into workflow execution state and durable run history, so that I can monitor progress, understand failures, and review what happened later.

#### Acceptance Criteria
1. While a workflow is executing, the Workflow Graph Builder shall broadcast real-time status updates for workflow-level status changes, execution-context status changes, task status changes, validation results, retry events, and circuit-breaker events.
2. The Workflow Graph Builder shall track per-task execution state including at minimum `pending`, `running`, `interrupted`, `completed`, and `failed`.
3. The Workflow Graph Builder shall track per-execution-context execution state including task progress, validation outcomes, retry attempts, and circuit-breaker state.
4. When validation fails, the Workflow Graph Builder shall make the failure details available in the user interface.
5. The Workflow Graph Builder shall persist execution history so that completed, halted, and aborted runs can be reviewed after they finish.
6. When validator output reopens completed tasks or creates new fix tasks, the Workflow Graph Builder shall make those changes visible in the user interface and execution history.

### Requirement 17: Persistent Shared Documents

**Objective:** As a user, I want agents to exchange durable context through files in the session worktree, so that information can persist across iterations and execution contexts without relying on transient conversation state.

#### Acceptance Criteria
1. The Workflow Graph Builder shall define a known directory inside the session worktree for shared agent-authored documents.
2. The Workflow Graph Builder shall allow agents to register a shared document explicitly, including the file path, a short description of what the document contains, and guidance about when other agents should read it.
3. The Workflow Graph Builder shall allow agents to update previously registered shared documents.
4. When a new execution-context conversation starts, the Workflow Graph Builder shall provide the current shared-document registry, including each document's description and read guidance.
5. The Workflow Graph Builder shall keep the shared-document registry scoped to the session worktree associated with that workflow execution.
