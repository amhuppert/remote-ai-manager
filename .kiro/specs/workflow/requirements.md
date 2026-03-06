# Requirements: Ralph Loop Plan-First Initialization

## Introduction

The Ralph Loop workflow currently initializes through a two-hop process: a conversation agent calls `initialize_ralph_loop` with a single `objective` string, then a separate SDK `query()` call generates structured tasks from that objective. This architecture creates an information bottleneck — the plan generator only has access to the last 6 conversation messages (truncated to 500 chars each), losing critical context from the user's full conversation.

This specification changes the initialization flow so that the conversation agent generates the task plan itself and submits both the objective and structured tasks in a single tool call. The conversation agent is best-positioned for plan generation because it has the complete conversation context, any codebase exploration it already performed, and the user's clarifications and priorities.

## Requirements

### Requirement 1: Structured Plan Submission via Init Tool

**Objective:** As a conversation agent, I want to submit both an objective and a structured task plan when initializing a Ralph Loop, so that the workflow starts with a high-quality plan informed by full conversation context.

#### Acceptance Criteria

1. When the conversation agent calls `initialize_ralph_loop`, the Init Tool shall accept an `objective` (string) and a `tasks` array where each task has a `description` (string) and `group` (positive integer).
2. When `initialize_ralph_loop` is called with a valid objective and at least one task, the Init Tool shall create a workflow in `planning` status with the `fixPlan` pre-populated from the submitted tasks.
3. When the workflow is created with pre-submitted tasks, the Init Tool shall set `generatingPlan` to `false` (since no background generation is needed).
4. The Init Tool shall validate that at least one task is provided in the `tasks` array.
5. If an empty `tasks` array is provided, the Init Tool shall return an error indicating that at least one task is required.

### Requirement 2: Elimination of Automatic Background Plan Generation on Init

**Objective:** As a system maintainer, I want the init tool to no longer fire-and-forget a separate SDK plan generation call, so that we avoid redundant API usage and context loss.

#### Acceptance Criteria

1. When a workflow is created via the init tool with pre-submitted tasks, the Init Tool shall not call `dispatchPlanGeneration()`.
2. The Init Tool shall not set `generatingPlan` to `true` when tasks are provided at initialization.
3. When tasks are submitted at init time, the workflow shall immediately be ready for user review and confirmation without waiting for background plan generation.

### Requirement 3: Plan Regeneration Preserved as Opt-In

**Objective:** As a user, I want to regenerate a task plan via the UI if I'm unhappy with the conversation agent's plan, so that I retain the ability to get AI-assisted plan suggestions.

#### Acceptance Criteria

1. While a workflow is in `planning` status, the Workflow API shall continue to support the `POST /workflow/generate-plan` endpoint for explicit plan regeneration.
2. When plan regeneration is triggered from the UI, the Plan Generator shall use the existing `dispatchPlanGeneration()` flow with conversation context gathering.
3. When regeneration completes, the Plan Generator shall replace the current `fixPlan` with newly generated tasks and broadcast an SSE `workflow-fix-plan-updated` event.

### Requirement 4: Init Tool Schema and Description Update

**Objective:** As a conversation agent (Claude), I want clear tool descriptions and schema that guide me to generate a well-structured plan, so that I produce high-quality task breakdowns.

#### Acceptance Criteria

1. The `initialize_ralph_loop` tool description shall instruct the agent to analyze the user's request, break it into discrete tasks grouped by dependencies, and submit them as structured data.
2. The tool schema shall describe the `tasks` array parameter with guidance on task granularity (single-iteration scope, ~10-30 minutes of work) and group semantics (group 1 = no dependencies, group 2 = depends on group 1, etc.).
3. The `objective` parameter description shall instruct the agent to provide a concise summary of the overall development goal.

### Requirement 5: SSE Event on Workflow Creation with Tasks

**Objective:** As a UI client, I want to receive real-time notification when a workflow is created with pre-populated tasks, so that the planning UI reflects the initial state immediately.

#### Acceptance Criteria

1. When a workflow is created with pre-submitted tasks, the Init Tool shall broadcast a `workflow-status` SSE event with `taskProgress` reflecting the submitted task counts.
2. When a workflow is created with pre-submitted tasks, the Init Tool shall broadcast a `workflow-fix-plan-updated` SSE event containing the full `fixPlan` array.

### Requirement 6: Backward Compatibility for API-Created Workflows

**Objective:** As a UI user creating workflows through the web interface, I want the API-based workflow creation flow (POST /workflow) to continue working, so that I can still create workflows from the UI and add tasks manually or via regeneration.

#### Acceptance Criteria

1. The `POST /workflow` API endpoint shall continue to create workflows with an empty `fixPlan` and optional `objective`.
2. While a workflow has an empty `fixPlan`, the workflow confirmation endpoint shall reject confirmation with an error indicating that at least one task is required.
3. The `PUT /workflow/fix-plan` endpoint shall continue to allow manual task editing during the `planning` phase.

### Requirement 7: Task Data Integrity

**Objective:** As a system, I want submitted tasks to conform to the existing `FixPlanTask` schema, so that downstream systems (iteration execution, exit detection, circuit breaker) work without modification.

#### Acceptance Criteria

1. When tasks are submitted via the init tool, each task shall be assigned a unique UUID `id`, `status: "pending"`, a `createdAt` timestamp, and `null` for `completedAt`, `skipReason`, and `addedByIteration`.
2. The Init Tool shall validate that each task's `group` is a positive integer (minimum 1).
3. The Init Tool shall validate that each task's `description` is a non-empty string.
