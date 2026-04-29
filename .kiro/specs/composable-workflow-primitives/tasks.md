# Implementation Plan

- [x] 1. Build the shared agent execution facade
- [x] 1.1 Define a capability-aware execution vocabulary for workflow turns and task runs
  - Capture one shared request shape for conversation-style turns, one-shot tasks, optional lane reuse, workflow-specific tooling, structured-output expectations, and explicit read-only versus write-capable intent.
  - Define a normalized result shape that always returns backend identity, available usage or context metrics, generated artifact references, and backend-specific failure details.
  - Preserve backend capability differences for continuation strength, structured-output enforcement, MCP application boundaries, context metrics, and native mid-turn ask-user behavior so workflows can branch on real support instead of guessed parity.
  - Define the structured logging fields every primitive will emit for request kind, backend, lane, workflow scope, artifact kind, and normalized outcome.
  - _Requirements: 1.3, 1.4, 1.5, 1.6, 8.1, 8.2, 8.4, 8.5, 8.6, 10.1_

- [x] 1.2 Route conversation-style turns through the conversation-oriented runtime
  - Dispatch shared conversation requests to the existing conversation backend path without reintroducing feature-local execution plumbing.
  - Inject any lane continuity and workflow-specific tooling before execution starts.
  - Surface mid-turn ask-user pauses and normalized backend errors without losing backend identity.
  - _Requirements: 1.1, 1.3, 1.5, 8.4, 8.6, 9.4_

- [x] 1.3 Route one-shot and task-style work through the task-oriented runner
  - Dispatch shared task requests to the existing task execution path while preserving backend-specific constraints.
  - Apply workflow-specific tooling and structured-output expectations on the task path as well as the conversation path.
  - Return consistent usage, artifact, and failure metadata so task workflows receive the same semantic contract as conversation turns.
  - _Requirements: 1.2, 1.3, 1.5, 1.6, 8.2, 8.3_

- [x] 1.4 Verify normalized execution behavior across both backends
  - Write unit coverage for backend selection, schema validation success and failure, timeout normalization, unavailable capability handling, and write-capable scheduling hints.
  - Confirm structured-output validation still runs through the shared gate flow even when a backend offers native enforcement.
  - _Requirements: 1.4, 1.5, 1.6, 8.2, 8.3, 8.5, 9.3_

- [x] 2. Establish named lanes and worktree-safe scheduling
- [x] 2.1 Persist named lane state with backend-specific continuity data
  - Store workflow-scoped lane identity, backend, continuity policy, write capability, backend references, and supported metrics without flattening unsupported fields into fake defaults.
  - Ensure lane names can repeat across workflows without continuity collisions.
  - _Requirements: 2.1, 2.5, 2.7, 8.1, 8.5_

- [x] 2.2 Reuse continuity automatically and record post-turn lane outcomes
  - Resolve the active continuity context for lane-backed calls before execution.
  - Record continuation references, rotation or reset decisions, context metrics, and stale-session recovery metadata after each turn using only the data the backend actually supports.
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 8.1, 8.5_

- [x] 2.3 Enforce worktree-safe lane scheduling
  - Serialize lane executions that can write to the shared session worktree.
  - Allow concurrent execution only when the workflow explicitly marks the lane as read-only and the call path can prove it does not mutate the worktree.
  - Treat unspecified write intent as write-capable so the shared primitive layer preserves the current safety model by default.
  - _Requirements: 9.1, 9.2, 9.3_

- [x] 2.4 Adapt existing continuity-heavy workflows onto the shared lane model
  - Round-trip current graph workflow continuity state through the shared lane service without losing supported metadata or stale-session recovery behavior.
  - Add parity tests so adapter-backed continuity behaves the same before and after extraction.
  - _Requirements: 2.5, 2.6, 7.4, 8.1, 8.4_

- [x] 3. Build reusable gates for validation, pauses, and convergence
- [x] 3.1 Define the shared gate result vocabulary and pause invariants
  - Normalize checkpoint outcomes as pass, fail, or pause with stable details and resume tokens.
  - Preserve mid-turn ask-user pauses separately from post-turn workflow pauses so workflows and UIs can resume the correct state.
  - _Requirements: 3.1, 3.3, 3.4, 3.10, 9.4, 9.5_

- [x] 3.2 Wrap execution-time validation and user-interaction gates
  - Route structured-output validation through the shared gate flow with explicit validation details on failure.
  - Expose native ask-user interruptions as mid-turn pauses and explicit approval steps as post-turn pauses.
  - Evaluate context-limit policies using only the metrics each backend actually exposes.
  - _Requirements: 3.2, 3.3, 3.4, 3.7, 8.3, 8.5, 8.6, 9.4, 9.5_

- [x] 3.3 Wrap workflow-policy and deterministic validation gates
  - Expose script-validation, change-set, convergence, and circuit-breaker decisions through the same gate vocabulary.
  - Preserve the distinction between ordinary gate failures and infrastructure failures so owning workflows can retry, pause, or halt appropriately.
  - _Requirements: 3.5, 3.6, 3.8, 3.9_

- [x] 3.4 Validate gate behavior across shared workflow shapes
  - Add focused tests for structured-output failures, ask-user pauses, approval pauses, empty change sets, failed scripts, convergence disagreement, and repeated-failure thresholds.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 9.4, 9.5_

- [x] 4. Deliver shared status and artifact handling
- [x] 4.1 (P) Introduce scoped status publishing over the existing live transport
  - Publish scoped running, paused, completed, and failed updates using a shared outer envelope with scope, scope identifier, status, timestamp, and feature-owned payloads.
  - Keep existing event granularity so migrated features do not lose the live detail their UIs already consume.
  - Ensure status delivery failures are observable and do not corrupt the owning workflow's state.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 10.2_

- [x] 4.2 (P) Introduce shared artifact writing and discoverability registration
  - Resolve canonical output paths by artifact kind while preserving established locations such as focus memory, Codex outputs, graph shared documents, and validation logs.
  - Reject absolute paths and traversal attempts that would write outside the session worktree.
  - Record shallow source metadata with workflow identity, producing lane or equivalent source, creation time, and audience classification.
  - Register discoverable artifacts in the correct metadata system after the file write succeeds.
  - Distinguish required artifact write failures from optional artifact warnings so workflows can halt or continue deliberately.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 10.3, 10.4_

- [x] 4.3 Migrate existing status publishers and artifact producers through the shared flow
  - Route conversation, workflow, merge, debug, and collaboration live updates through the shared status transport without forcing a single payload schema.
  - Route existing durable outputs through the shared artifact registry without changing their canonical paths or reference entry points.
  - _Requirements: 4.2, 4.4, 4.5, 5.2, 5.3, 5.6, 7.1, 7.2, 7.3, 7.5, 7.6_

- [x] 4.4 Verify scoped delivery and artifact discoverability end to end
  - Add tests that confirm migrated publishers still deliver the payload shapes current consumers expect and that registered artifacts remain discoverable after shared registration.
  - Cover feature-owned status payload preservation, status-delivery failure isolation, path traversal rejection, required artifact failures, and optional artifact warnings.
  - _Requirements: 4.3, 4.4, 4.6, 5.2, 5.4, 5.5, 5.7, 10.2, 10.3, 10.4_

- [x] 5. Persist the minimal workflow envelope
- [x] 5.1 Create minimal lifecycle envelopes for workflows that need durable discovery
  - Persist workflow identity, workflow type, lifecycle status, phase, timestamps, error summary, parent linkage, and a feature-owned snapshot without turning the envelope into a generic child-object store.
  - Expose running, paused, completed, and failed envelopes for UI and recovery queries.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 6.7_

- [x] 5.2 Preserve pause and recovery semantics inside the shared envelope model
  - Store the shared pause or failure summary needed for restart inspection while keeping domain-specific recovery decisions feature-owned.
  - Keep mid-turn and post-turn pauses distinguishable when workflows project their state into the envelope.
  - _Requirements: 6.5, 6.7, 9.4, 9.5, 9.6_

- [x] 5.3 Keep envelope persistence bounded and restart-safe
  - Add tests covering atomic updates, parent-child relationships, active-workflow listing, restart discovery, and large snapshot fallbacks to artifact references when needed.
  - _Requirements: 6.4, 6.5, 6.6, 6.7, 9.6, 10.5_

- [x] 6. Migrate existing workflow shapes behind feature adapters
- [x] 6.1 Adapt regular conversations and focus-mode initialization to the primitive layer
  - Use shared execution, ask-user pauses, approval pauses, status delivery, and artifact registration without changing the owning workflow shape.
  - Verify session UI behavior remains unchanged for running, paused, completed, and failed states.
  - Confirm migrated adapters preserve current request and response shapes, event names, artifact paths, and durable state visible to existing callers.
  - _Requirements: 7.1, 7.2, 7.7, 7.8_

- [x] 6.2 Adapt debug and graph workflows to shared execution, lanes, gates, and artifacts
  - Keep existing graph scheduling, task state, and debug investigation flow explicit while replacing duplicated execution plumbing with shared primitives.
  - Preserve current continuity, structured-output, script-validation, and circuit-breaker behavior through adapter-backed integration.
  - Confirm migrated adapters preserve current request and response shapes, event names, artifact paths, and durable state visible to existing callers.
  - _Requirements: 7.3, 7.4, 7.7, 7.8_

- [x] 6.3 (P) Adapt smart-merge and optimistic workflows to shared agent-powered substeps
  - Route merge-specific agent steps through shared execution, status, and artifact flows while leaving merge policy and job orchestration feature-owned.
  - Confirm background workflow behavior still surfaces the correct live states and durable outputs.
  - Confirm migrated adapters preserve current request and response shapes, event names, artifact paths, and durable state visible to existing callers.
  - _Requirements: 7.5, 7.7, 7.8_

- [x] 6.4 Implement the first primitive-native collaboration workflow slice
  - Wire multiple lanes, convergence checks, pause gates, artifact registration, scoped status, and a workflow envelope into the first collaboration-mode implementation path.
  - Use this feature to validate that new workflows can compose the primitive set without introducing a generic workflow engine.
  - _Requirements: 6.1, 6.4, 7.6, 7.7_

- [x] 7. Harden backend capability preservation and compatibility
- [x] 7.1 Preserve backend-specific behavior at every primitive seam
  - Audit the primitive APIs and adapters so conversation continuation strength, structured-output enforcement source, MCP application boundaries, available context metrics, and native mid-turn ask-user support remain observable and branchable.
  - Add targeted coverage for unsupported-capability cases so shared primitives never emulate behavior a backend does not actually support.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

- [x] 7.2 Validate observable parity for migrated workflows
  - Build integration coverage that proves migrated conversations, graph workflows, background jobs, and collaboration flows still emit the live status, pauses, artifact registrations, and failure classes their callers expect.
  - _Requirements: 4.3, 4.4, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_

- [x] 7.3 Verify concurrency and recovery behavior under multi-lane load
  - Exercise mixed read-only and write-capable lane execution, pause and resume recovery, and artifact discoverability to confirm the shared primitives preserve worktree safety and restart visibility under realistic parallel workflows.
  - _Requirements: 5.2, 6.5, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [x] 7.4 Verify primitive safety and observability behavior
  - Confirm stateful primitive operations emit structured logs with relevant session, workflow, lane, artifact, and outcome identifiers without logging full prompt or artifact payloads by default.
  - Exercise status delivery degradation, required artifact failures, optional artifact warnings, and artifact-reference fallbacks for large workflow lifecycle content.
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_
