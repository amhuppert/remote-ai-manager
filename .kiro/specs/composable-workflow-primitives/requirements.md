# Requirements Document

## Project Description (Input)
Composable workflow primitives for Command Center. Create a Kiro specification for the architecture described in docs/composable-workflow-primitives.md: a shared AgentCall facade, Lane, Gate, StatusBus, ArtifactRegistry, and minimal workflow envelope that let regular conversations, focus mode, debug mode, graph workflow, smart merge, optimistic mode, and collaboration mode compose reusable workflow machinery without introducing a generic workflow engine.

## Introduction

Command Center (CC) needs a small, reusable set of workflow primitives that
remove duplicated execution machinery without erasing the explicit workflow
logic that already lives in feature-specific state machines, orchestrators, and
jobs. The target design centralizes repeated concerns such as backend selection,
continuity, structured-output validation, pause handling, status transport,
artifact registration, and minimal durable lifecycle metadata.

This specification defines requirements for a composable primitive set that can
be adopted incrementally by current and future workflows. The design must
preserve existing backend differences, session worktree safety, and feature
ownership boundaries. It must not introduce a generic workflow DSL, a generic
DAG runtime, or a Temporal-like replay engine.

## Requirements

### Requirement 1: Shared Agent Execution Facade

**Objective:** As a CC workflow author, I want one shared semantic entry point
for agent execution, so that workflow code can request work without
reimplementing backend selection and execution plumbing.

#### Acceptance Criteria
1. When a workflow requests a stateful conversation-style turn, the Command Center shall execute that request through the conversation-oriented backend runtime.
2. When a workflow requests a one-shot or task-style agent invocation, the Command Center shall execute that request through the task-oriented backend runner.
3. When a workflow supplies MCP configuration or workflow-specific tool fragments for an agent call, the Command Center shall apply that configuration on the selected execution path.
4. When a workflow requests structured output, the Command Center shall validate the returned output against the requested schema before reporting the call as successful.
5. If an agent execution times out, fails, or returns a backend-specific error, the Command Center shall return a normalized failure result that preserves the backend identity and failure details.
6. When an agent execution completes, the Command Center shall return the backend reference, usage or context metrics that are available, and any generated artifact references.

### Requirement 2: Named Lane Continuity

**Objective:** As a CC workflow author, I want long-lived agent continuity to
be represented as named lanes, so that workflows can reuse backend-specific
continuation state without owning the storage details themselves.

#### Acceptance Criteria
1. The Command Center shall represent each long-lived agent execution stream as a named lane with an identity, a backend, and a continuity policy.
2. When a lane-backed execution completes, the Command Center shall record the continuation reference and continuity metadata needed for the next execution on that lane.
3. When a workflow invokes an agent call through a lane, the Command Center shall supply that lane's current continuity context automatically.
4. When lane context metrics indicate that continuation should rotate or reset before the next turn, the Command Center shall record that decision in lane state for the workflow to consume.
5. If a backend cannot provide a particular continuity capability, the Command Center shall preserve only the continuity data that backend actually supports.
6. When stale-session recovery metadata is needed for a lane, the Command Center shall retain enough metadata for the workflow to detect and recover that stale continuity state.
7. When multiple workflows reuse the same lane name, the Command Center shall scope lane state by the owning workflow so continuation state cannot collide across workflows.

### Requirement 3: Reusable Workflow Gates

**Objective:** As a CC workflow author, I want reusable gates that report pass,
fail, or pause, so that common workflow checkpoints do not have to be
reimplemented in each feature.

#### Acceptance Criteria
1. The Command Center shall represent reusable workflow checkpoints as gates that return a result of pass, fail, or pause.
2. When structured output does not satisfy the requested schema, the Command Center shall return a failed Structured Output gate result with validation details.
3. While a backend asks the user a question during an in-flight turn, the Command Center shall surface that condition as a paused Ask User gate without losing the active turn context.
4. When a workflow requires explicit user confirmation after a step completes, the Command Center shall surface that condition as a paused Human Approval gate.
5. When a configured validation script completes, the Command Center shall return a Script Validation gate result that indicates success or failure and includes the validation outcome.
6. When a workflow checks whether a step changed the worktree, the Command Center shall return a Change Set gate result that distinguishes changed and unchanged outcomes.
7. When a workflow evaluates whether a lane should rotate before the next turn based on context-limit policy and available context metrics, the Command Center shall return a Context Limit gate result that indicates whether rotation is required.
8. When a multi-lane workflow evaluates whether participating lanes have reached agreement, the Command Center shall return a Convergence gate result based on the lanes' latest workflow outputs.
9. When repeated failures cross a configured threshold, the Command Center shall return a Circuit Breaker gate result that stops or pauses further attempts.
10. When a gate returns a pause result, the Command Center shall include a resume identity and pause details sufficient for the owning workflow to resume the correct state without ambiguity.

### Requirement 4: Scoped Status Transport

**Objective:** As a CC maintainer, I want a single scoped status transport, so
that conversations, workflows, merge jobs, and future features can publish live
activity without duplicating delivery infrastructure.

#### Acceptance Criteria
1. The Command Center shall publish live status updates by scope and scope identifier.
2. When a feature emits a status update, the Command Center shall deliver the feature's payload without requiring all features to share one global payload schema.
3. When a client subscribes to a supported scope, the Command Center shall deliver running, paused, completed, failed, and equivalent live status updates for that scope.
4. The Command Center shall support scoped status delivery for at least conversation, workflow, merge job, graph workflow, collaboration, and debug activity.
5. When a feature adopts the shared status transport, the Command Center shall not require that feature to move its durable workflow state into the status transport.
6. When a feature has multiple live event shapes within one scope, the Command Center shall preserve the feature-specific event detail inside the scoped transport rather than collapsing it into a single coarse event type.

### Requirement 5: Artifact Writing and Registration

**Objective:** As a CC workflow author, I want a shared artifact registry, so
that workflows can write durable outputs and make them discoverable without
duplicating path and metadata logic.

#### Acceptance Criteria
1. When a workflow writes an artifact of a known kind, the Command Center shall store that artifact at the established path for that kind.
2. When an artifact should be discoverable to future agent executions, the Command Center shall register metadata that makes the artifact available as a reference document or equivalent workflow artifact.
3. The Command Center shall preserve established special-case artifact paths, including `memory-bank/focus.md`, instead of forcing all artifacts into one new directory layout.
4. When an artifact is registered, the Command Center shall capture source metadata that includes the workflow or execution identity, the producing lane or equivalent source, and the creation time.
5. The Command Center shall distinguish user-facing artifacts from internal logs when recording artifact metadata.
6. Where a feature defines a new artifact kind, the Command Center shall allow that feature to reuse the shared writing and registration flow without duplicating artifact bookkeeping.
7. When resolving an artifact path, the Command Center shall reject absolute paths and path traversal that would write outside the session worktree.

### Requirement 6: Minimal Durable Workflow Envelope

**Objective:** As a CC maintainer, I want a minimal durable workflow envelope
for workflows that need restart visibility, so that long-running workflows can
be discovered and recovered without introducing a generic event store.

#### Acceptance Criteria
1. Where a workflow requires durable lifecycle tracking beyond its existing feature state, the Command Center shall create a workflow envelope for that workflow.
2. The Command Center shall store, at minimum, the workflow ID, workflow type, status, phase, created timestamp, updated timestamp, completed timestamp when applicable, error summary, and a feature-owned snapshot in the workflow envelope.
3. When a workflow is launched by another workflow, the Command Center shall allow the envelope to store the parent workflow ID.
4. When the UI or recovery logic queries active workflow state, the Command Center shall expose running, paused, completed, and failed workflows through the workflow envelope.
5. When the server restarts, the Command Center shall provide a consistent place to discover envelopes that require recovery inspection.
6. The Command Center shall not require the workflow envelope to store every lane, gate, artifact, or child object in one generic schema.
7. The Command Center shall allow the feature-owned snapshot to remain the source of truth for domain-specific workflow state.

### Requirement 7: Cross-Feature Workflow Composition

**Objective:** As a CC maintainer, I want the shared primitives to cover current
and planned workflow shapes, so that new features can reuse machinery while
retaining feature-owned orchestration logic.

#### Acceptance Criteria
1. The Command Center shall support regular conversations as single-lane workflows that can use shared agent execution, ask-user pauses, status delivery, and artifact registration.
2. The Command Center shall support focus-mode initialization workflows that can use shared agent execution, ask-user pauses, human approval pauses, status delivery, and artifact registration.
3. The Command Center shall support debug workflows that can use shared agent execution together with structured-output, script-validation, and circuit-breaker gates.
4. The Command Center shall support graph workflows that retain graph-specific scheduling and task state while reusing shared agent execution, lanes, gates, status delivery, and artifact registration.
5. The Command Center shall support smart-merge and optimistic workflows that retain merge-specific policy while reusing shared agent-powered substeps through the primitive set.
6. The Command Center shall support collaboration workflows that can use multiple lanes, convergence checks, pause gates, artifact registration, status delivery, and the workflow envelope.
7. The Command Center shall allow a feature workflow to remain an XState machine, explicit orchestrator, route handler, or background job while using the shared primitive set.
8. When an existing feature migrates behind primitive adapters, the Command Center shall preserve that feature's current observable behavior and user-facing contracts unless a change is explicitly specified.

### Requirement 8: Backend Capability Preservation

**Objective:** As a CC maintainer, I want shared primitives to normalize common
behavior without hiding real backend differences, so that workflows can branch
on capabilities instead of incorrect assumptions.

#### Acceptance Criteria
1. The Command Center shall preserve whether a backend supports precise conversation continuation or only a weaker form of continuity.
2. Where a backend enforces structured output natively, the Command Center shall use that capability without assuming all backends behave the same way.
3. Where a backend requires structured output to be validated after the fact, the Command Center shall expose that validation outcome through the shared execution and gate flow.
4. The Command Center shall preserve whether MCP can be applied at startup, between turns, or only at other backend-supported execution boundaries.
5. The Command Center shall preserve whether context-window metrics are available for a backend and shall not require unavailable metrics for baseline execution support.
6. The Command Center shall preserve whether a backend can ask the user a question during an in-flight turn and shall not emulate unsupported mid-turn behavior as if it were native.

### Requirement 9: Worktree-Safe Concurrency and Pause Semantics

**Objective:** As a CC maintainer, I want the primitive set to respect session
worktree safety and the two existing pause shapes, so that reusable workflows
do not introduce race conditions or lose user-interaction state.

#### Acceptance Criteria
1. While multiple lanes share the same session worktree, the Command Center shall serialize any lane execution that can write to that worktree.
2. When multiple lane executions are read-only and do not mutate the worktree, the Command Center may allow those executions to run in parallel.
3. Where a workflow cannot prove that a lane execution is read-only, the Command Center shall treat that execution as write-capable for scheduling purposes.
4. When a backend pauses mid-turn to ask the user a question, the Command Center shall preserve that pause as distinct from a post-turn workflow pause.
5. When structured output or workflow policy requires user input after a step completes, the Command Center shall preserve that pause as a post-turn workflow pause before the next step begins.
6. The Command Center shall preserve existing session worktree isolation rules while introducing shared workflow primitives.

### Requirement 10: Primitive Safety and Observability

**Objective:** As a CC maintainer, I want shared primitives to preserve safety
and emit useful operational signals, so that extracted workflow machinery can
be debugged without weakening existing reliability guarantees.

#### Acceptance Criteria
1. When a primitive performs a stateful operation, the Command Center shall emit structured logs that identify the primitive, relevant session or workflow scope, and outcome without logging full prompt or artifact payload bodies by default.
2. If live status publication fails, the Command Center shall log the delivery failure without changing the owning workflow's success or failure outcome solely because status delivery failed.
3. When a required artifact cannot be written or registered, the Command Center shall surface an explicit workflow failure that identifies the artifact kind and failure reason.
4. When an optional artifact cannot be written or registered, the Command Center shall allow the owning workflow to degrade with a warning when the artifact is not required for correctness.
5. When workflow lifecycle state would otherwise embed large generated content, the Command Center shall allow the feature-owned snapshot to reference artifacts instead of requiring that content inline.
