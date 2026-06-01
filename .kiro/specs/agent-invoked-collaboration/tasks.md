# Implementation Plan — agent-invoked-collaboration

- [x] 1. Foundation: schemas, config defaults, and lint scaffolding
- [x] 1.1 Add the collaboration config schema and per-workflow / per-context override blocks to workflows schemas
  - Define a Zod schema for collaboration settings (`secondAgent`, `negotiationRounds`, `autonomousResolutionThreshold`) that composes the existing agent-config, positive-integer, and autonomous-resolution-threshold primitives.
  - Add an optional collaboration override block to the workflow-level override schema and to the per-context execution-context definition schema.
  - Export the collaboration config schema so the global defaults schema can compose it.
  - Observable: `bun run typecheck` is clean; the new schema is exported and parses a sample object with all three fields populated.
  - _Requirements: 2.1, 2.2_

- [x] 1.2 Extend the global workflow defaults schema and seed the default in the loader
  - Add a required collaboration field on the parsed global workflow-defaults schema and an optional twin on the raw schema.
  - Update the global-config loader so a config file missing `workflowDefaults.collaboration` parses successfully and the resolved value matches a seeded default that mirrors the existing user-triggered `/collab` defaults.
  - Observable: loading a global config that omits the collaboration block yields a `WorkflowDefaults` value whose `collaboration` field equals the seeded default; loading a config that supplies the block yields the supplied value verbatim.
  - _Requirements: 2.3_

- [x] 1.3 Add the `collaboration_failure` halt-reason branch and the workflow collaboration result schemas
  - Extend the workflow halt-reason discriminated union with a `type: "collaboration_failure"` branch carrying `status`, `brief`, `executionContextId`, `conversationId`, and a short operator-facing `summary`.
  - Define the four-value workflow collaboration status enum and the result schema with a `superRefine` that rejects `converged` without `finalAnswer` and non-converged without at least one open conflict.
  - Observable: schema tests reject `converged` with null `finalAnswer`, reject `objective_disagreement` with empty `openConflicts`, and accept valid combinations; TypeScript exhaustiveness checks compile across existing halt-reason consumers.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 5.1, 5.5_

- [x] 1.4 Add the `request_collaboration` tool input schema
  - Define a strict Zod object schema with a single trimmed, non-empty `brief` string.
  - Observable: schema tests accept a non-empty trimmed brief; reject empty, whitespace-only, missing, non-string, and any extra fields with a Zod failure.
  - _Requirements: 1.6, 1.7, 2.4_

- [x] 1.5 Add the discriminated collaboration `featureSnapshot` schema
  - Create the new collaboration feature-snapshot module with a Zod discriminated union keyed on `origin` (`"user"` retains today's user-triggered shape; `"workflow"` carries `parentImplementerTurnId`, `executionContextId`, `conversationId`, and the resolved collaboration config).
  - Default the discriminator to `"user"` when absent on read so existing user-triggered snapshots without `origin` continue to parse.
  - Observable: round-trip tests parse a captured user-shaped snapshot without `origin`, parse a workflow-shaped snapshot, and reject a workflow-shaped snapshot missing `parentImplementerTurnId`.
  - _Requirements: 6.2_

- [x] 1.6 Add the ESLint forbidden-import rule that makes the no-pause invariant a construction guarantee
  - Configure `no-restricted-imports` so the workflow-scoped envelope module and the feature-snapshot module cannot import `pauseForHumanApproval`, the human-approval-gate module, or the user-triggered envelope module.
  - Observable: `bun run lint` fails when a temporary import of `pauseForHumanApproval` is added to the workflow envelope module, and succeeds when the import is removed.
  - _Requirements: 4.1_

- [x] 2. Core pure functions
- [x] 2.1 (P) Build the decision-to-workflow-result translator
  - Implement a pure function mapping `CollaborationPolicyDecision` to `WorkflowCollaborationResult` per the mapping table in research.md §10.1.
  - Cover every mapping row with table-driven unit tests, including `final → converged`, `ask_user (threshold=none) → requires_user_input`, `fail (objective category) → objective_disagreement`, and rounds-exhausted-without-disagreement.
  - Observable: every mapping row passes; tests fail when any branch is mis-mapped, including a regression case for `ask_user` mistakenly mapped to `converged`.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.2_
  - _Boundary: Decision-to-Workflow-Result Translator_
  - _Depends: 1.3_

- [x] 2.2 (P) Build the collaboration config resolver with provenance
  - Implement `resolveCollaborationConfigWithProvenance` in the workflow-graph config resolver module so each of the three fields is computed independently across per-context → workflow → global, returning a value and the source layer that supplied it.
  - Unit-test the full 3-field × 3-source matrix plus a mixed-provenance case (e.g., context-supplied `negotiationRounds`, workflow-supplied threshold, global-supplied `secondAgent`).
  - Observable: the mixed-provenance test yields three distinct `source` values on the resolved config; no `??` short-circuits across the block.
  - _Requirements: 2.1, 2.2, 2.3, 2.5_
  - _Boundary: Collaboration Config Resolver_
  - _Depends: 1.1, 1.2_

- [x] 3. Workflow collaboration envelope and tool handler
- [x] 3.1 Build the workflow-scoped collaboration envelope
  - Create the new workflow envelope module exposing a `start({ brief, resolvedConfig, parentImplementerTurnId, executionContextId, conversationId })` entry point that returns a `WorkflowCollaborationResult`.
  - Duplicate the round/collaborator-invocation logic from the user-triggered envelope locally (controlled duplication per design §Envelope Extraction Decision); compose the existing policy decider and the new translator to produce the terminal status.
  - Persist envelope snapshots through the new discriminated feature-snapshot schema with `origin: "workflow"`, populating `parentImplementerTurnId`, `executionContextId`, `conversationId`, and `resolvedConfig`.
  - Forbid imports of `pauseForHumanApproval`, the human-approval-gate module, and the user-triggered envelope module (enforced by the lint rule from 1.6 and by a transitive-import test in 5.3).
  - Observable: a unit test exercises the envelope against a stubbed policy decider and stubbed collaborator caller, asserts the snapshot written to the primitive envelope store parses as the workflow variant, and confirms the returned result for a `final` decision is `status: "converged"` with a non-empty `finalAnswer`.
  - _Requirements: 1.1, 4.1, 4.3, 4.4, 6.2_
  - _Boundary: Workflow Collaboration Envelope_
  - _Depends: 1.5, 1.6, 2.1_

- [x] 3.2 Build the `request_collaboration` tool handler with halt ordering
  - Add the handler factory next to the existing implementer tool handlers in the workflow-graph tool server: validate input via the strict schema, resolve the config with provenance, write the invocation log event, invoke the workflow envelope, write the completion log event, and on any non-`converged` outcome write `pendingHaltReason` to execution state and the failure-halt log event before constructing and returning the structured result.
  - Mirror the validation-error pattern used by the existing `complete_task` handler (`safeParse` → validation-error tool result).
  - Observable: an ordering test injects an execution-state writer that records call order and asserts that on the non-converged path `pendingHaltReason` is set before the tool result is constructed; an empty-brief input yields a validation-error tool result with no envelope invocation.
  - _Requirements: 1.1, 1.6, 1.7, 2.5, 5.1, 5.2, 5.4, 6.1, 6.4_
  - _Boundary: request_collaboration Handler_
  - _Depends: 1.3, 1.4, 2.2, 3.1_

- [x] 4. Tool registration, orchestrator dispatch, and gateway plumbing
- [x] 4.1 (P) Register the tool conditionally on `allowAgentCollaboration`
  - Extend the workflow-graph implementer tool registration so the `request_collaboration` tool is added only when the tool-server context flag `allowAgentCollaboration` is `true`.
  - Observable: a registration test initialized with `allowAgentCollaboration: false` reports the tool absent from the implementer's tool list; initialized with `true` reports it present; validator and regular-session contexts never reach this registration site.
  - _Requirements: 1.2, 1.3, 1.4, 1.5_
  - _Boundary: Tool-Server Scope Gate_
  - _Depends: 3.2_

- [x] 4.2 (P) Implement the same-turn dispatch contract and pre-dispatch halt check in the iteration orchestrator
  - Update the iteration orchestrator so tool-use blocks within a single assistant turn are awaited sequentially (no `Promise.all` over per-turn tool_use blocks).
  - Before invoking each handler, read `pendingHaltReason` from execution state; if non-null, emit a synthetic `tool_result` (`isError: true`, message `"iteration halted: collaboration_failure"`) for every remaining tool_use block in the same turn, then throw `IterationHaltedError(pendingHaltReason)`.
  - Observable: orchestrator unit tests confirm that with `pendingHaltReason` pre-seeded the dispatcher never invokes the next handler, records one synthetic `tool_result` per skipped tool_use block, and concludes the iteration with the seeded halt reason.
  - _Requirements: 5.3, 5.4_
  - _Boundary: Pre-Dispatch Halt Check + Same-Turn Dispatch Contract_
  - _Depends: 1.3_

- [x] 4.3 Plumb collaboration context through the workflow MCP gateway
  - In the workflow-execution MCP server, derive `parentImplementerTurnId` from the current implementer iteration/conversation, and pass `allowAgentCollaboration`, `parentImplementerTurnId`, `executionContextId`, `conversationId`, and a bound `startWorkflowCollaboration` into the tool-server context for implementer registrations only.
  - Validator and regular-session paths receive no MCP tool context and remain untouched.
  - Observable: an implementer MCP context is constructed with a non-empty `parentImplementerTurnId` and a non-null `startWorkflowCollaboration` callable; a validator path does not construct this context; a unit test confirms the derived `parentImplementerTurnId` is non-empty on every invocation.
  - _Requirements: 1.2_
  - _Boundary: workflow-execution-server plumbing_
  - _Depends: 3.1, 4.1_

- [x] 5. Integration tests across boundaries
- [x] 5.1 Handler integration tests for the happy path, the non-converged path, and the three canonical execution-log entries
  - Run the handler end-to-end against a DI-stubbed envelope returning `converged`, then against one returning `objective_disagreement`; inject a captured execution logger via DI.
  - Happy path: assert the `collaboration.request_collaboration.invoked` row in the per-context `tasks.jsonl` channel contains the resolved config with `source` fields, and the `.completed` row contains `status`, `roundsConsumed`, `openConflictsSummary`, and `resolvedConfig`.
  - Failure path: assert the `collaboration.failure_halt` row in `decisions.jsonl` carries `brief`, `resolvedConfig`, and the open-conflicts payload; assert the captured execution-state writer records `pendingHaltReason` before the structured result is returned.
  - Observable: all three captured rows are present and well-formed for the matching path; the ordering assertion fails when `pendingHaltReason` writes are intentionally delayed in the test fixture.
  - _Requirements: 2.5, 5.2, 6.1, 6.4_
  - _Depends: 3.2, 4.3_

- [x] 5.2 Orchestrator same-turn and cross-turn halt integration tests
  - Same-turn: drive the orchestrator with an assistant turn whose tool-use blocks are `[request_collaboration (envelope stubbed to return objective_disagreement), complete_task]`. Assert the `complete_task` handler is never invoked, a synthetic `tool_result` is emitted for the `complete_task` block, the structured failure result reaches the agent for the `request_collaboration` block, and the iteration ends with `haltReason.type === "collaboration_failure"`.
  - Cross-turn: emit a turn containing only `request_collaboration` (non-converged), then a second turn containing `complete_task`. Assert the pre-dispatch check fires before the `complete_task` handler runs and the iteration ends with the collaboration-failure halt reason.
  - Observable: both tests pass with the new dispatch contract in place and fail when the pre-dispatch check is removed or when handler dispatch is parallelized.
  - _Requirements: 5.3, 5.4_
  - _Depends: 4.2, 5.1_

- [x] 5.3 Workflow envelope no-pause invariant, parity, and snapshot round-trip
  - Static-analysis test: import the workflow envelope module and assert its transitive import closure excludes `pauseForHumanApproval`, the human-approval-gate module, and the user-triggered envelope module.
  - Parity test: inject the same policy decider and collaborator caller into both envelopes, feed the same canned round inputs, and assert agreement on round-level outcomes for the rounds where both code paths overlap (terminal decisions may legitimately differ).
  - Snapshot round-trip: write a workflow-origin snapshot through the workflow envelope, read it back via the primitive envelope store, assert the discriminated parser recovers `parentImplementerTurnId`; read a captured user-origin snapshot lacking `origin` and assert it parses as the user variant.
  - Observable: all three tests pass; the static-analysis test fails when a forbidden import is added to the workflow envelope module.
  - _Requirements: 4.1, 6.2, 7.1_
  - _Depends: 3.1, 1.5, 1.6_

- [x] 6. End-to-end workflow runs and regression
- [x] 6.1 End-to-end converged collaboration workflow run
  - Drive a workflow with one execution context, an implementer agent that calls `request_collaboration` with a brief, and two stubbed collaborator agents that converge in one round.
  - Observable: the implementer receives a result with `status: "converged"` and a non-empty `finalAnswer`; the workflow run completes normally with no halt; the completion log event includes the `resolvedConfig` with provenance; the existing `graph-workflow-*` SSE channel emits conversation activity from the collaborator sub-agents under the implementer turn that invoked the tool, joinable via `parentImplementerTurnId`.
  - _Requirements: 1.1, 2.5, 3.1, 6.1, 6.3, 6.4_
  - _Depends: 4.1, 4.2, 4.3, 5.1_

- [x] 6.2 End-to-end non-converged collaboration with workflow halt
  - Use the same setup as 6.1 but configure the collaborators to escalate to `objective_disagreement`; the implementer issues `complete_task` in the same turn as `request_collaboration`.
  - Observable: the implementer receives a structured failure result; the `complete_task` handler is not invoked; the workflow halts with `haltReason.type === "collaboration_failure"`; the `collaboration.failure_halt` log entry carries the brief, resolved settings (with provenance), and open-conflicts summary; the operator-visible workflow run-status surface renders the `collaboration_failure` halt category distinctly from existing halt categories such as `circuit_breaker` and iteration-limit halts.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
  - _Depends: 6.1_

- [x] 6.3 User-triggered `/collab` regression
  - Run the existing user-triggered envelope test suite unchanged after the new modules and lint rule have landed; confirm the user-question pause flow, the user-question resume flow, and per-conversation collaboration setting drafts still behave as they did before this spec.
  - Observable: every existing user-triggered envelope test passes; no transcript path through the user envelope has been modified; the ESLint rule does not flag any existing user-triggered envelope code.
  - _Requirements: 7.1, 7.2, 7.3_
  - _Depends: 3.1, 1.6_
