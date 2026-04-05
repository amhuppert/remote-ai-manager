# Requirements Document

## Introduction

The Workflow Graph Builder currently creates a fresh implementer conversation for each iteration and treats validator execution as one-shot work. Workflow continuity extends graph workflow execution so implementer iterations, task-level validators, and execution-context-level validators can each reuse their own session within a single execution context when continuity is enabled, while still supporting fresh-session behavior when continuity is disabled.

The feature has four major goals: (1) configurable continuity behavior for implementer and validator lanes, (2) a single context-limit model that rotates sessions only after a completed turn exceeds the configured limit, (3) strict isolation between implementer, task-validator, and execution-context-validator sessions, and (4) continuity behavior that remains scoped to one execution context and survives normal execution persistence and restart flows.

## Requirements

### Requirement 1: Session Continuity Configuration

**Objective:** As a user running graph workflows, I want session continuity to be configurable for each execution lane, so that I can choose when agents should retain or discard conversational context.

#### Acceptance Criteria
1. The Workflow Graph Builder shall support session continuity as a configurable behavior for implementer execution within each execution context.
2. Where task-level validation is included, the Workflow Graph Builder shall support session continuity as a configurable behavior for the task-level validator.
3. Where execution-context-level validation is included, the Workflow Graph Builder shall support session continuity as a configurable behavior for the execution-context-level validator.
4. The Workflow Graph Builder shall default session continuity to enabled for implementer, task-level validator, and execution-context-level validator lanes.
5. The Workflow Graph Builder shall support configuring one context limit value for each continuity lane.
6. The Workflow Graph Builder shall allow a continuity lane to operate without a configured context limit.

### Requirement 2: Implementer Session Continuity

**Objective:** As a user running workflow iterations, I want implementer sessions to continue or rotate according to policy, so that the agent can preserve useful context without being forced to restart every iteration.

#### Acceptance Criteria
1. Where implementer continuity is disabled, when a new iteration starts, the Workflow Graph Builder shall start a fresh implementer session for that iteration.
2. Where implementer continuity is enabled and no context limit is configured, while execution remains in the same execution context, the Workflow Graph Builder shall reuse the same implementer session across iterations.
3. Where implementer continuity is enabled and a context limit is configured, while the current implementer session has not exceeded the configured limit at the end of a completed turn, the Workflow Graph Builder shall reuse that implementer session for the next iteration in the same execution context.
4. Where implementer continuity is enabled and the current implementer session has exceeded the configured limit at the end of a completed turn, when the next iteration starts, the Workflow Graph Builder shall start a fresh implementer session for that execution context.
5. When implementer continuity is disabled and no context limit is configured, the Workflow Graph Builder shall allow the current iteration to finish naturally and shall defer fresh-session behavior to the next iteration boundary.
6. Where implementer continuity is disabled, the Workflow Graph Builder shall not retain an implementer session across iteration boundaries regardless of context-limit configuration.

### Requirement 3: Task-Level Validator Session Continuity

**Objective:** As a user relying on task validation, I want task-level validators to preserve or discard their own session context independently, so that repeated task validation can build on prior review when configured to do so.

#### Acceptance Criteria
1. Where task-level validation is enabled, the Workflow Graph Builder shall apply task-validator continuity rules independently of implementer continuity rules.
2. Where task-validator continuity is disabled, when task-level validation is invoked, the Workflow Graph Builder shall start a fresh task-validator session for that invocation.
3. Where task-validator continuity is enabled and no context limit is configured, while execution remains in the same execution context, the Workflow Graph Builder shall reuse the same task-validator session across task-validation invocations.
4. Where task-validator continuity is enabled and a context limit is configured, while the current task-validator session has not exceeded the configured limit at the end of a completed validation turn, the Workflow Graph Builder shall reuse that task-validator session for later task validations in the same execution context.
5. Where task-validator continuity is enabled and the current task-validator session has exceeded the configured limit at the end of a completed validation turn, when the next task-level validation starts, the Workflow Graph Builder shall start a fresh task-validator session for that execution context.
6. Where the configured task validator type is Claude or Codex, the Workflow Graph Builder shall apply the configured task-validator continuity mode for that validator type.

### Requirement 4: Execution Context-Level Validator Session Continuity

**Objective:** As a user relying on execution-context validation, I want execution-context-level validators to preserve or discard their own session context independently, so that repeated context validation can accumulate review context without sharing it with other lanes.

#### Acceptance Criteria
1. Where execution-context-level agent validation is enabled, the Workflow Graph Builder shall apply execution-context-validator continuity rules independently of implementer continuity rules and task-validator continuity rules.
2. Where execution-context-validator continuity is disabled, when execution-context-level validation is invoked, the Workflow Graph Builder shall start a fresh execution-context-validator session for that invocation.
3. Where execution-context-validator continuity is enabled and no context limit is configured, while execution remains in the same execution context, the Workflow Graph Builder shall reuse the same execution-context-validator session across execution-context validation invocations.
4. Where execution-context-validator continuity is enabled and a context limit is configured, while the current execution-context-validator session has not exceeded the configured limit at the end of a completed validation turn, the Workflow Graph Builder shall reuse that execution-context-validator session for later execution-context validations in the same execution context.
5. Where execution-context-validator continuity is enabled and the current execution-context-validator session has exceeded the configured limit at the end of a completed validation turn, when the next execution-context-level validation starts, the Workflow Graph Builder shall start a fresh execution-context-validator session for that execution context.
6. Where the configured execution-context validator type is Claude or Codex, the Workflow Graph Builder shall apply the configured execution-context-validator continuity mode for that validator type.

### Requirement 5: Execution Context Boundaries and Lane Isolation

**Objective:** As a user running multi-context workflows, I want session continuity to remain isolated by lane and execution context, so that conversational state never leaks between unrelated work.

#### Acceptance Criteria
1. Within a single execution context, the Workflow Graph Builder shall keep separate sessions for implementer, task-level validator, and execution-context-level validator lanes.
2. If both task-level and execution-context-level validation are enabled in the same execution context, the Workflow Graph Builder shall not reuse one validator lane's session for the other validator lane.
3. When execution moves from one execution context to another, the Workflow Graph Builder shall start fresh sessions for all continuity lanes in the new execution context.
4. While execution remains in the same execution context, the Workflow Graph Builder shall apply continuity and rotation decisions only within that execution context's lanes.

### Requirement 6: Context Limit Evaluation

**Objective:** As a user configuring autonomous execution, I want a single, predictable context-limit model, so that session rotation happens only when explicitly configured and never through hidden heuristics.

#### Acceptance Criteria
1. The Workflow Graph Builder shall use one context-limit model and shall not require separate soft-limit and hard-limit behaviors.
2. Where no context limit is configured for a lane, the Workflow Graph Builder shall disable all limit-based rotation logic for that lane.
3. Where no context limit is configured for a lane, the Workflow Graph Builder shall not apply a fallback heuristic based on context-window percentage or any other approximation.
4. Where a validator engine does not expose the context information needed to evaluate a configured context limit, the Workflow Graph Builder shall disable limit-based rotation for that validator engine instead of approximating the limit with a heuristic.
5. Where limit-based rotation is unavailable for a validator engine and continuity is enabled, while execution remains in the same execution context, the Workflow Graph Builder shall continue reusing that validator lane's session according to the configured continuity mode.

### Requirement 7: Persistence and Execution History

**Objective:** As a user running long-lived workflows, I want continuity behavior and execution history to survive normal persistence and restart flows, so that session reuse remains predictable during long executions.

#### Acceptance Criteria
1. The Workflow Graph Builder shall persist sufficient continuity state for each lane so that session continuity behavior survives server restarts within an active execution context.
2. If the server restarts during an active execution context, when execution resumes, the Workflow Graph Builder shall continue applying the configured continuity and context-limit rules for each lane from the persisted execution state.
3. When one session is reused across multiple iterations or validations in the same execution context, the Workflow Graph Builder shall preserve execution history without requiring a separate transcript per iteration or per validator invocation.
4. When a reused session contributes to task progress or validator outcomes, the Workflow Graph Builder shall preserve reviewable linkage from the execution history to that reused session.
