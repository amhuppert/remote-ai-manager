# Requirements Document

## Introduction

When a graph workflow implementer agent launches a background task (for example a backgrounded shell command, a test or build run, or a subagent) and then yields its turn to wait for that task to finish, the graph workflow currently mistakes the yielded turn for "work finished." Finding tasks still incomplete, it re-sends the instructions — first as follow-up "nag" turns, then as fresh iterations — pressuring the agent to continue work it is actually waiting on. This makes no progress and consumes the context's iteration budget until the iteration cap or circuit breaker halts the run.

This feature makes the graph workflow recognize in-flight background work and wait for it to settle before re-prompting, then resume the iteration so the agent can act on the results. The recognition and waiting are driven entirely by lifecycle signals the workflow already receives from the agent backend; the implementer agent is not required to call any tool or emit any explicit signal. The wait is time-bounded so a task that never settles can never hang the workflow.

## Boundary Context

- **In scope**:
  - Recognizing that an implementer agent started one or more background tasks during an iteration turn, using lifecycle signals already received from the agent backend (no agent cooperation required).
  - Distinguishing background tasks that are expected to finish on their own from long-lived watch processes that run until stopped or until the session ends.
  - Waiting, with an enforced upper bound, for the expected-to-finish background tasks to settle before sending any follow-up or new-iteration prompt for that context.
  - Resuming the same iteration when those tasks settle, with the settled outcomes delivered to the agent.
  - Preserving iteration and failure accounting across the wait.
  - Behaving identically to today when no waitable background tasks are present.
- **Out of scope**:
  - Any agent-facing tool or prompt instruction by which the agent explicitly declares it is waiting (the deliberately rejected agent-cooperation alternative).
  - Surfacing background-task state in the user interface.
  - Changing how or when the agent decides to launch a background task.
  - Backend-specific behavior beyond the shared turn-execution path; parity is expected only where a backend exposes equivalent background-task lifecycle signals.
- **Adjacent expectations**:
  - Relies on the agent backend emitting background-task lifecycle signals (task started, task status changes, and task settled with its outcome) and on the backend keeping the conversation alive so it auto-continues when a background task settles. This feature consumes those signals; it does not own the backend's execution of background tasks.
  - Applies to implementer iteration turns. Validator turns are unaffected.

## Requirements

### Requirement 1: Detect in-flight background tasks during an implementer turn

**Objective:** As a workflow operator, I want the workflow to recognize when the implementer agent has started a background task during its turn, so that the workflow can react to in-flight asynchronous work instead of assuming the turn's work is finished.

#### Acceptance Criteria
1. When the implementer agent starts a background task during an iteration turn, the Graph Workflow shall record that task as in-flight for that iteration.
2. When a recorded in-flight background task settles during the same turn, the Graph Workflow shall mark that task as no longer in-flight.
3. While an implementer turn is in progress, the Graph Workflow shall maintain an accurate set of in-flight background tasks for that turn from the lifecycle signals it receives.
4. The Graph Workflow shall determine in-flight background-task state without requiring the implementer agent to call any tool or include any explicit signal in its output.

### Requirement 2: Distinguish waitable tasks from long-lived watches

**Objective:** As a workflow operator, I want the workflow to wait only for background tasks that are expected to finish, so that long-lived watch processes never stall the workflow.

#### Acceptance Criteria
1. When the implementer agent starts a background task that is expected to terminate on its own (for example a one-off build, test run, or script), the Graph Workflow shall treat that task as waitable.
2. Where a background task is a long-lived watch that runs until it is explicitly stopped or until the session ends (for example a dev server or file watcher), the Graph Workflow shall exclude that task from the set of tasks it waits on.
3. If the Graph Workflow cannot classify whether a background task is waitable, then the Graph Workflow shall treat it as waitable and rely on the bounded wait to prevent an indefinite stall.

### Requirement 3: Wait for waitable background tasks instead of re-prompting

**Objective:** As a workflow operator, I want the workflow to wait for the implementer's in-flight waitable background tasks to finish before nudging or re-prompting the agent, so that the agent is not repeatedly told to continue work it is waiting on.

#### Acceptance Criteria
1. When an implementer turn ends with one or more waitable background tasks still in-flight, the Graph Workflow shall not send a follow-up or new-iteration prompt for that context until those tasks settle or the wait ends.
2. While the Graph Workflow is waiting for in-flight waitable background tasks, the Graph Workflow shall keep the iteration open rather than finalizing it as completed or failed.
3. When all in-flight waitable background tasks for the iteration settle, the Graph Workflow shall resume the iteration so the agent can act on the results.
4. When the iteration resumes after a wait, the Graph Workflow shall make the settled background tasks' outcomes available to the implementer agent.

### Requirement 4: Bound the wait and degrade safely

**Objective:** As a workflow operator, I want any wait for background tasks to be time-bounded, so that a task that never settles cannot hang the workflow.

#### Acceptance Criteria
1. While waiting for in-flight waitable background tasks, the Graph Workflow shall enforce a maximum wait duration.
2. If the maximum wait duration is reached before the tasks settle, then the Graph Workflow shall stop waiting and resume the behavior it uses when no background tasks are present.
3. If a background-task lifecycle signal indicates a task failed or was stopped, then the Graph Workflow shall treat that task as settled for the purpose of ending the wait.
4. The Graph Workflow shall never wait indefinitely for a background task.

### Requirement 5: Preserve iteration accounting while waiting

**Objective:** As a workflow operator, I want waiting for a background task to not consume the context's iteration budget or failure budget, so that legitimate waiting does not prematurely halt the context.

#### Acceptance Criteria
1. When the Graph Workflow waits for in-flight background tasks and then resumes the same iteration, the Graph Workflow shall not consume an additional iteration from the context's iteration budget as a result of the wait.
2. When the Graph Workflow waits for in-flight background tasks, the Graph Workflow shall not increase the context's consecutive-failure count as a result of the wait.
3. While waiting for in-flight background tasks, the Graph Workflow shall not halt the context on the maximum-iteration limit or the circuit breaker as a result of the wait.

### Requirement 6: No change in behavior when no waitable background tasks are present

**Objective:** As a workflow operator, I want the change to be invisible when no waitable background work is involved, so that existing workflow behavior is preserved.

#### Acceptance Criteria
1. When an implementer turn ends with no in-flight background tasks, the Graph Workflow shall finalize and continue the iteration exactly as it did before this feature.
2. When an implementer turn ends with only excluded long-lived watch tasks, the Graph Workflow shall proceed without waiting.
3. The Graph Workflow shall not change the prompts shown to the implementer agent as a result of this feature.

### Requirement 7: Observability of the wait lifecycle

**Objective:** As a workflow operator, I want the workflow to log when it detects, waits for, and resumes from background tasks, so that I can diagnose stalls and verify the feature is working.

#### Acceptance Criteria
1. When the Graph Workflow begins waiting for in-flight background tasks, the Graph Workflow shall record a structured log entry identifying the affected context and the tasks being waited on.
2. When in-flight background tasks settle and the iteration resumes, the Graph Workflow shall record a structured log entry capturing the outcome.
3. If a wait ends by reaching the maximum wait duration, then the Graph Workflow shall record a structured log entry indicating the timeout and the tasks that were still in-flight.
