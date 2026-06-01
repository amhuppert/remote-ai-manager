# Requirements Document

## Project Description (Input)
Enable graph workflow implementer agents to invoke collaboration mode themselves via a new MCP tool. The tool is scoped exclusively to graph workflow implementers (not validators, not regular sessions, not recursive inside collab). The agent supplies only a `brief`; all collab settings (`secondAgent`, `negotiationRounds`, `autonomousResolutionThreshold`) are inherited from a standard CC config cascade (per-node graph config → workflow-level config → global defaults).

Because workflows must never pause for user input, any policy decision that would normally `ask_user` (objective disagreement, threshold=none, or rounds exhausted with disagreements above threshold) is reinterpreted as a convergence failure. The tool returns a structured result `{ status, finalAnswer?, openConflicts? }` with a granular reason enum (`converged`, `rounds_exhausted`, `requires_user_input`, `objective_disagreement`). Any non-`converged` status both returns the structured failure to the calling agent AND trips a new workflow-halting circuit breaker condition that immediately halts the entire workflow run.

## Introduction

This feature gives graph workflow implementer agents a structured escape hatch for hard judgment calls: invoke a second-opinion collaboration without leaving the iteration. Today's collaboration mode is reachable only by a user typing `/collab`, so an implementer that needs a second opinion has no way to get one and either succeeds unilaterally, burns iterations against the existing circuit breaker, or produces a low-confidence result.

The new capability is deliberately narrow. It applies only to graph workflow implementer agents, exposes a single input (`brief`), inherits all other collaboration settings from a workflow/node config cascade, and refuses to pause workflow execution for user input. Any need for human resolution becomes a convergence failure that halts the workflow run, so operators see a loud, debuggable failure rather than a hung session.

## Boundary Context
- **In scope**:
  - A new tool callable by graph workflow implementer agents that spawns a collaboration with a single `brief` input.
  - Inheritance of `secondAgent`, `negotiationRounds`, and `autonomousResolutionThreshold` from per-node graph config, workflow-level config, then global defaults.
  - A workflow-context variant of the collaboration envelope that never prompts the user and instead returns granular failure reasons.
  - A new workflow-halting circuit breaker condition triggered by any non-`converged` result.
  - Observability hooks linking the implementer invocation to the spawned collaboration for operator debugging.
- **Out of scope**:
  - Tool availability to validators, regular (non-workflow) session agents, or agents already inside a spawned collaboration.
  - Per-call agent override of `secondAgent`, `negotiationRounds`, or `autonomousResolutionThreshold`.
  - Changes to the user-triggered `/collab` flow, including its existing ask-user pause behavior.
  - New collaboration second-agent types beyond those already supported.
  - Cross-session or cross-project collaboration spawning.
- **Adjacent expectations**:
  - The workflow definition format is expected to accept new optional collaboration config blocks at per-node and workflow scope.
  - The existing circuit breaker infrastructure is expected to accept a new halt condition type without redesign.
  - The existing collaboration envelope, policy, and second-agent infrastructure are expected to be reusable in a workflow-scoped variant.

## Requirements

### Requirement 1: Agent-Invokable Collaboration Tool
**Objective:** As a graph workflow implementer agent, I want to invoke collaboration mode through a tool call during a workflow iteration, so that I can request a second opinion on a hard judgment call without abandoning the iteration.

#### Acceptance Criteria
1. When a graph workflow implementer agent issues a tool call to the collaboration tool with a non-empty `brief` string, the Graph Workflow Runtime shall start a collaboration using that `brief` as the task description.
2. The Graph Workflow Runtime shall expose the collaboration tool only to agents executing in the graph workflow implementer role.
3. While an agent is executing in the graph workflow validator role, the Graph Workflow Runtime shall not list the collaboration tool in the available tool set.
4. While an agent is executing in a regular non-workflow session, the Graph Workflow Runtime shall not list the collaboration tool in the available tool set.
5. While an agent is executing inside an already-spawned collaboration, the Graph Workflow Runtime shall not list the collaboration tool in the available tool set.
6. If a tool call to the collaboration tool supplies an empty or whitespace-only `brief`, the Graph Workflow Runtime shall reject the call with a tool error and shall not start a collaboration.
7. If a tool call to the collaboration tool supplies any input field other than `brief`, the Graph Workflow Runtime shall reject the call with a tool error and shall not start a collaboration.

### Requirement 2: Configuration Cascade for Collaboration Settings
**Objective:** As a workflow author or operator, I want collaboration settings to be governed at the workflow and node level rather than chosen by the calling agent, so that collab behavior is predictable and auditable across runs.

#### Acceptance Criteria
1. When the collaboration tool is invoked, the Graph Workflow Runtime shall resolve `secondAgent`, `negotiationRounds`, and `autonomousResolutionThreshold` by consulting the per-node graph configuration first, then the workflow-level configuration, then the documented global defaults.
2. When per-node configuration omits a collaboration setting, the Graph Workflow Runtime shall use the workflow-level value for that setting.
3. When neither per-node nor workflow-level configuration specifies a collaboration setting, the Graph Workflow Runtime shall use the documented global default for that setting.
4. The Graph Workflow Runtime shall use the resolved settings as the only source of truth for the spawned collaboration and shall ignore any collaboration setting values that may appear in the agent's tool input.
5. When the collaboration tool is invoked, the Graph Workflow Runtime shall record the resolved settings and the source layer (per-node, workflow, or global) for each setting in the workflow run log.

### Requirement 3: Structured Convergence Result
**Objective:** As the calling implementer agent, I want the collaboration tool to return a structured result that distinguishes successful convergence from each specific failure reason, so that I (and the runtime) can interpret the outcome deterministically.

#### Acceptance Criteria
1. When the two agents reach a consensus answer within the allowed negotiation rounds and under the configured autonomy threshold, the Collaboration Tool shall return a result whose `status` is `converged` and whose `finalAnswer` is a non-empty string.
2. When the autonomy threshold is `none` and any unresolved disagreement remains at the end of negotiation, the Collaboration Tool shall return a result whose `status` is `requires_user_input`.
3. When an objective disagreement between the two agents persists at the end of negotiation, the Collaboration Tool shall return a result whose `status` is `objective_disagreement`.
4. When negotiation reaches the configured `negotiationRounds` limit without convergence and neither `objective_disagreement` nor `requires_user_input` applies, the Collaboration Tool shall return a result whose `status` is `rounds_exhausted`.
5. While returning any non-`converged` status, the Collaboration Tool shall populate `openConflicts` with at least one conflict entry that identifies the rejecting agent and the disputed point.
6. The Collaboration Tool shall return exactly one `status` value per invocation; the `status` values are mutually exclusive.
7. The Collaboration Tool shall return the same structured result shape (`status`, optional `finalAnswer`, optional `openConflicts`) for every outcome, so callers can parse the response without status-dependent branching on the shape.

### Requirement 4: No-User-Pause Guarantee in Workflow Context
**Objective:** As an operator running an unattended workflow, I want a guarantee that an agent-invoked collaboration cannot pause the workflow waiting for user input, so that unattended runs remain unattended.

#### Acceptance Criteria
1. While serving an agent-invoked collaboration, the Workflow Collaboration Envelope shall not surface any user-facing question, prompt, or pause state.
2. When the collaboration policy would otherwise decide to ask the user, the Workflow Collaboration Envelope shall instead complete the invocation by returning a non-`converged` status (`requires_user_input` or `objective_disagreement`) to the calling tool.
3. While serving an agent-invoked collaboration, the Workflow Collaboration Envelope shall not emit any real-time event or notification that requests user action.
4. The Workflow Collaboration Envelope shall not require the user-triggered resume flow to complete an agent-invoked collaboration; completion shall depend only on the agents reaching a terminal status.

### Requirement 5: Workflow-Halting Circuit Breaker on Non-Convergence
**Objective:** As an operator, I want any non-converged agent-invoked collaboration outcome to halt the entire workflow run, so that the workflow fails loud and debuggable rather than silently continuing with an inadequate result.

#### Acceptance Criteria
1. When the Collaboration Tool returns any `status` other than `converged`, the Workflow Circuit Breaker shall trip a dedicated collaboration-failure halt condition and halt the entire workflow run.
2. When the Workflow Circuit Breaker trips for a collaboration failure, the Graph Workflow Runtime shall record the failure `status`, the supplied `brief`, the resolved collaboration settings, and the `openConflicts` summary in the workflow run log.
3. After the Workflow Circuit Breaker trips for a collaboration failure, the Graph Workflow Runtime shall not process any further tool calls in the current iteration and shall not start any further iterations for the workflow run.
4. When the Workflow Circuit Breaker trips for a collaboration failure, the Collaboration Tool shall still return the structured failure result to the calling agent as the response to its tool call.
5. The Workflow Circuit Breaker shall expose the collaboration-failure halt condition as a distinct halt reason in the workflow run status visible to operators, separate from existing halt reasons such as iteration limits or validator rejections.

### Requirement 6: Observability and Linkage
**Objective:** As an operator debugging a workflow run, I want spawned collaborations to be traceable back to the implementer call that invoked them, so that I can investigate end-to-end without reconstructing causality from timestamps.

#### Acceptance Criteria
1. When the collaboration tool is invoked, the Graph Workflow Runtime shall emit a structured log event that includes the workflow run identifier, the workflow node identifier, the implementer turn identifier, and the supplied `brief`.
2. While serving an agent-invoked collaboration, the Workflow Collaboration Envelope shall associate every persisted transcript entry and artifact with the originating implementer turn identifier.
3. While an agent-invoked collaboration is in progress, the Graph Workflow Runtime shall emit the same real-time observability events (conversation activity, workflow status) used for any other workflow agent activity, so the collaboration is visible in the operator UI like any other run activity.
4. When an agent-invoked collaboration reaches a terminal status, the Graph Workflow Runtime shall emit a structured log event that includes the resolved settings, the final `status`, the number of negotiation rounds consumed, and a summary of any `openConflicts`.

### Requirement 7: Preservation of User-Triggered Collaboration
**Objective:** As a user of the existing `/collab` command, I want my user-triggered collaboration experience to remain unchanged after this feature ships, so that adding the agent-invoked path does not regress an existing capability.

#### Acceptance Criteria
1. When a user invokes `/collab <brief>` from a session prompt, the Collaboration Envelope shall behave as it does today, including pausing for user input when the configured autonomy threshold and disagreement severity require it.
2. While the collaboration policy decides to ask the user during a user-triggered collaboration, the Collaboration Envelope shall continue to surface user questions and accept answers through the existing user-question resume flow.
3. While storing or retrieving per-conversation collaboration setting drafts for user-triggered collaborations, the Collaboration Envelope shall continue to honor the user's supplied settings without applying the workflow-context overrides defined for agent-invoked collaborations.
