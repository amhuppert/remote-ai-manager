# Graph Workflow Improvement Brainstorm

## Scope

This report is an independent brainstorm based on:

- The AeroTrainer dynamic workflow execution bundle.
- The AeroTrainer Command Center graph workflow logs, validators, transcripts, and implementation output.
- The graph workflow implementation and design surfaces in this worktree.
- The newer human approval gate capability Alex said is available in the Command Center main worktree.

I did not read `aerotrainer-workflow-comparison-report.md` or `graph-workflow-improvement-report.md`.

The goal is not primarily to make graph workflows faster. Faster execution is useful, but the higher-value targets are:

- Better output quality.
- Lower workflow friction.
- Stronger agent alignment.
- More dynamic behavior without losing the graph workflow's auditability, validation, and explicit dependency model.

## Executive Summary

The AeroTrainer graph workflow produced the better final product, mostly because it had validators, durable handoff documents, a final verification context, and stronger evidence from tests and e2e coverage. The dynamic workflow was more fluid and faster, mostly because it could create parallel design/build/review swarms around the work as it learned more.

The best direction is not to replace the graph with a dynamic workflow. It is to let graph executions evolve through controlled, validated graph mutations. Agents should be able to propose new contexts, split contexts, add edges, request review swarms, insert conditional branches, and add specialized validators. Command Center should validate those changes, record the graph diff, and optionally pause at a human approval gate before applying them.

The most important improvements are:

1. Add a first-class contract/source-of-truth layer so agents and validators resolve conflicts the same way.
2. Add graph mutation proposals as a structured runtime edit capability, guarded by validation and approval policy.
3. Add dynamic review subgraphs that reproduce the strongest part of the dynamic workflow: multiple independent reviewers plus verifier/synthesis passes.
4. Add conditional routing and diagnostic branches so workflows can react to test failures, missing configuration, ambiguous requirements, or discovered scope.
5. Improve friction around dev server and repo readiness with preflight checks and automatic remediation tasks.
6. Upgrade validators from local context checkers into a layered validation system: context validators, cross-context integration validators, parity validators, and source-conflict validators.
7. Make shared documents more structured and authoritative, not just discoverable Markdown files.

## What AeroTrainer Revealed

### Dynamic Workflow Strengths To Borrow

The dynamic workflow's strongest properties were:

- It created role-specific design agents with complementary perspectives.
- It used wide build parallelism after the foundation and contracts were established.
- It created an adversarial review phase with multiple independent dimensions.
- It verified findings rather than blindly accepting every reviewer claim.
- It adapted its review surface to what had been built.

Those strengths came from dynamic orchestration, not from lack of structure. The design and build phases still had strong contracts and disjoint ownership. The review phase struggled only because the orchestration had a brittle barrier and one agent hung.

### Graph Workflow Strengths To Preserve

The graph workflow's strongest properties were:

- Durable, inspectable execution state.
- Explicit dependency edges.
- Context-local acceptance criteria.
- Per-context validation and automatic reopen.
- Shared documents for handoff.
- Worktree isolation and fan-in joins.
- Final verification with deterministic evidence.
- Human-understandable progress and failure state.

These are worth preserving. They are the reason the graph workflow product had stronger evidence and fewer unknowns at completion.

### Graph Workflow Friction To Address

The AeroTrainer graph workflow also exposed important friction:

- It over-serialized some work. The five game modes were mostly implemented sequentially even though a foundation plus stronger mode contracts could have allowed more parallelism.
- Context validators were local. They were good at checking their own acceptance criteria, but global parity still needed a special final audit.
- Acceptance criteria and the prototype conflicted once. Night Shift scoring was changed to `Math.floor` because a validator followed local criteria, then changed back to `Math.round` after final parity review found the prototype was authoritative.
- Dev server tooling was configured in the prompt but not in the project config, causing repeated `ensure_dev_server` failures and fallback behavior.
- Shared docs worked, but they were informal. Agents had to decide what mattered and when to read it.
- The final verification context had to run a nested dynamic-style audit to reach high confidence. That is useful, but it should become first-class graph functionality instead of an ad hoc pattern.

## Current Graph Workflow Shape

The current implementation already has useful extension points:

- `WorkflowSemanticDefinition` stores contexts, tasks, edges, and workflow config.
- Runtime edits currently allow user task add/update/remove/reorder/move, and agent task append inside the active context.
- Agents get MCP tools for `complete_task`, `upsert_shared_document`, optional `add_task`, and optional `request_collaboration`.
- Validators are structured enough to reopen specific tasks.
- Script validation can add deterministic remediation tasks.
- Human approval gates can park a context after validators pass.
- Lanes, parallel worktrees, joins, and final publish already support more than a simple linear graph.
- Shared documents are registered and surfaced in downstream prompts.
- Collaboration mode primitives already exist as a way to request a second opinion.

The missing piece is controlled runtime evolution of the graph itself.

## Implementation Anchors In The Current Codebase

The recommendations below map onto existing surfaces rather than requiring a separate workflow engine:

- `src/lib/workflows/schemas.ts` owns graph workflow definitions, context config, task state, validator config, human approval gate config, and execution state.
- `src/lib/workflow-graph/runtime-edits.ts` already centralizes safe runtime edits for tasks. It is the natural place to extend toward graph patch validation and application.
- `src/lib/workflow-graph/tool-server.ts` exposes agent-facing workflow tools. New tools such as `propose_graph_patch`, `record_decision`, `acknowledge_artifact`, or `request_review_subgraph` should follow this pattern.
- `src/lib/workflow-graph/iteration-prompt.ts` is where context-specific briefing, required artifacts, validation failure feedback, and collaboration continuations enter implementer prompts.
- `src/lib/workflow-graph/validator-runner.ts` and `src/lib/workflow-graph/execution-validation.ts` are the current context validator path. They can grow toward validator ensembles and integration validators.
- `src/lib/workflow-graph/iteration-orchestrator.ts` already sequences script validation, context validation, task reopening, circuit breaker checks, and human approval parking.
- `src/lib/workflow-graph/approval-gate.ts` provides the core mechanism needed to make dynamic graph mutation safe for high-impact changes.
- `src/lib/workflow-graph/lane-plan.ts`, `lane-readiness.ts`, `lane-join.ts`, and `join-runner.ts` already model parallel lanes and fan-in. Dynamic contexts should reuse those mechanisms instead of creating a second parallel execution path.
- `src/lib/workflow-graph/shared-documents.ts` already registers shared documents through the artifact registry. This can evolve into typed authoritative artifacts.
- `.kiro/steering/project-configuration.md` defines `preMergeCommand` and `devServers`, which are central to preflight and friction reduction.
- `docs/composable-workflow-primitives.md` already names the right reusable primitives: AgentCall, Lane, Gate, StatusBus, ArtifactRegistry, and Workflow Envelope. Graph workflow dynamic extensions should compose those primitives, not become a generic workflow runtime.

This matters because the system already has most of the durable execution machinery. The main design work is adding typed proposals, policies, gates, artifacts, and UI around graph evolution.

## Improvement Ideas

## 1. Add A Workflow Contract Package

### Proposal

Create a first-class "workflow contract package" at execution start. It should be a structured artifact generated from the user's objective, reference documents, workflow definition, and project config.

It should include:

- Source-of-truth hierarchy.
- User objective.
- Explicit non-goals.
- Reference implementation or prototype authority, if any.
- Global invariants.
- Terminology and vocabulary.
- Test strategy.
- Context ownership map.
- Context produce/consume contracts.
- Task-to-acceptance-criteria mapping.
- Known ambiguity list.
- Required docs for each context.

For AeroTrainer, this would have explicitly said:

1. The prototype behavior is authoritative when it conflicts with acceptance criteria.
2. Local acceptance criteria must not override prototype parity.
3. The final app must cover all five modes.
4. Visual parity includes copied CSS/fonts and representative screenshots.

### Justification

The Night Shift scoring flip-flop was not a validator quality problem by itself. The validator followed the information it was given. The real problem was that authority was distributed across prototype code, generated criteria, local agent interpretation, and final parity review.

A contract package gives every implementer and validator the same hierarchy of truth.

### Implementation Shape

Add a setup/foundation phase before execution or as a generated artifact during workflow creation:

- Store it under `.cc/graph-workflow-docs/workflow-contract.json` and `.md`.
- Register it as a required shared document.
- Inject a short digest into every implementer and validator prompt.
- Let contexts declare `requiredContractSections`.
- Add a validator check that every context's acceptance criteria are consistent with the contract.

### Risk

Too much contract text can bloat every prompt. The contract should have a concise prompt digest and a full artifact available on demand.

## 2. Add Source-Conflict Detection

### Proposal

Introduce a "source conflict gate" that runs before execution and again before final verification. It reviews:

- User objective.
- Workflow contract.
- Context acceptance criteria.
- Reference docs/prototype.
- Shared decisions produced during the workflow.

It reports contradictions such as:

- Acceptance criteria require behavior that conflicts with the prototype.
- A context is asked to validate work assigned downstream.
- Two contexts define different names or APIs for the same concept.
- A downstream context consumes an artifact that no upstream context produces.

### Justification

This directly targets agent alignment. If the graph definition contains contradictions, agents will faithfully amplify them. The validator loop can then cause churn instead of quality.

### Implementation Shape

This can start as a planning-time validator over the definition and contract package. Later it can become a reusable gate:

- `sourceConflictGate.enabled`.
- Structured result with `conflicts[]`, severity, source references, and recommended graph patch.
- Human approval required for blocking conflicts unless the proposed fix is purely additive.

## 3. Add Runtime Graph Mutation Proposals

### Proposal

Extend mutability beyond `allowAgentTaskAdd` with structured graph mutation proposals.

Agents should not directly rewrite the active graph. They should call a tool such as `propose_graph_patch` with a typed patch:

- Add execution context.
- Split current context.
- Add tasks to another not-yet-started context.
- Add edges.
- Add a final verification context.
- Add a specialized validator.
- Add a conditional branch.
- Mark a context as requiring human approval.
- Add or update shared contract metadata.

Command Center validates the patch, computes a graph diff, and applies it according to policy:

- Auto-apply safe append-only changes.
- Require human approval for structural changes.
- Reject unsafe changes.

### Justification

This is the central way to borrow dynamic workflow strengths while preserving the graph's strengths. The graph remains the execution model, but agents can evolve it when they discover missing work.

The dynamic workflow was good at realizing "we need review dimensions now" or "this slice needs a verifier." Graph workflow should let agents express that as graph structure.

### Safety Rules

Runtime graph patches should obey strict rules:

- No cycles.
- No editing completed contexts.
- No changing running context ownership except through explicit split/remediation operations.
- No removing completed evidence.
- No moving a task whose state is running or completed.
- No adding an edge that would make an already-ready context depend on unlanded work without parking it.
- No silent changes to source-of-truth hierarchy.
- Structural changes are logged as graph-diff artifacts.

### Mutability Levels

Add a richer mutability policy:

- `none`: no runtime changes.
- `task-append`: current behavior.
- `task-edit`: add/update/move pending tasks.
- `context-append`: add new contexts that depend on current or completed contexts.
- `edge-append`: add dependency edges among not-yet-started contexts.
- `branch`: add conditional branches.
- `validator-append`: add validators or review contexts.
- `full-proposal`: agent can propose any valid patch, but approval policy decides application.

### Human Approval Integration

Human approval gates are a natural control point:

- Low-risk patches can auto-apply and appear in history.
- Medium-risk patches can pause with a graph diff and recommendation.
- High-risk patches can require Alex to choose among alternatives.

The approval UI should show:

- What changed.
- Why the agent proposed it.
- Which contexts are affected.
- Whether any work will be invalidated or delayed.
- The new critical path.

## 4. Add Conditional Branches

### Proposal

Allow graph definitions to include conditional edges or router contexts.

Examples:

- If script validation fails with test failures, run a "test-fix" context.
- If visual parity is required and dev server config is missing, run "configure-dev-server" before visual validation.
- If prototype parity finds mismatches, branch to "prototype-remediation".
- If no UI changes were made, skip visual audit.
- If a context reports unresolved ambiguity, branch to human approval or collaboration.

### Justification

The current graph is a DAG, but many real workflows are conditional DAGs. Without conditional branches, planners either overbuild by adding every possible validation/remediation context, or underbuild and rely on manual intervention.

### Implementation Shape

Start with explicit router contexts:

- A router context produces a structured decision artifact.
- Edges from the router have predicates over that artifact.
- The scheduler marks non-selected branches as `skipped`.

Later add native conditional edges:

```json
{
  "sourceContextId": "visual-audit",
  "targetContextId": "visual-remediation",
  "condition": {
    "artifact": "visual-audit-result",
    "path": "$.mismatchCount",
    "operator": ">",
    "value": 0
  }
}
```

### Risks

Conditional graphs can become hard to understand. The UI should show inactive branches clearly and preserve the decision artifact that selected the path.

## 5. Add Dynamic Review Subgraphs

### Proposal

Make review swarms a first-class graph feature. A context should be able to request a review subgraph, not just a second opinion.

Review subgraph templates could include:

- `parallel_review`: N independent reviewers inspect the same output from different dimensions.
- `review_then_verify`: reviewers produce findings; verifier contexts independently confirm or reject each finding.
- `synthesis`: a final context groups confirmed findings into remediation tasks.
- `adversarial_pair`: one agent defends the implementation, another attacks it, then a judge resolves.

For AeroTrainer, a built-in "prototype parity review" subgraph would have replaced the ad hoc final dynamic-style audit.

### Justification

The dynamic workflow review phase found real issues. Its problem was orchestration reliability, not the review pattern. Graph workflow can run the same pattern with:

- Durable context state.
- Timeouts.
- Partial-result salvage.
- Per-finding verification.
- Automatic remediation tasks.
- Optional human approval before applying large remediation.

### Implementation Shape

Add a `request_review_subgraph` tool or graph patch type:

- Template name.
- Target contexts or files.
- Review dimensions.
- Required authority docs.
- Whether findings auto-create tasks.
- Whether human approval is required before remediation.

Review findings should be structured:

- Finding ID.
- Severity.
- Evidence.
- Source authority.
- Affected contexts/tasks/files.
- Confidence.
- Suggested remediation.
- Verification status.

## 6. Add Barrier Timeout And Partial Salvage

### Proposal

Any parallel review or implementation batch should support:

- Per-agent timeout.
- Required quorum.
- Partial result salvage.
- Automatic replacement agent for timed-out lanes.
- Synthesis with missing-lane disclosure.

### Justification

The dynamic workflow review hung because one agent blocked a barrier. Graph workflow already has better durable state, but dynamic subgraphs should explicitly avoid "one hung lane blocks all synthesis."

### Implementation Shape

Add batch policies:

- `minSuccessfulContexts`.
- `timeoutMs`.
- `onTimeout: synthesize_partial | spawn_replacement | halt | ask_human`.
- `requiredDimensions`.

For quality-sensitive workflows, a missing required dimension can halt or request human approval. For optional dimensions, synthesis can continue and document the gap.

## 7. Add A Repo Readiness Preflight

### Proposal

Before the first implementation context runs, Command Center should run a graph workflow preflight.

It should check:

- `preMergeCommand` configured if any script validators are enabled.
- `devServers` configured if any context asks for Playwright, visual validation, browser automation, or Next.js MCP.
- Init script availability.
- Dependency install state.
- Reference paths exist.
- Test/build commands are discoverable.
- Browser dependencies are available.
- Worktree is clean enough for parallel worktrees.

### Justification

AeroTrainer had repeated dev server MCP failures because no dev server was configured. Agents recovered, but the workflow wasted attention and produced noisy logs.

### Implementation Shape

Add either:

- A built-in preflight phase before scheduling contexts.
- A generated `repo-readiness` context in the graph.

Failures should produce:

- Suggested `CommandCenter.json` patch.
- Remediation task.
- Human approval option to apply config changes.
- Ability to continue with degraded capability if Alex approves.

## 8. Add Dev Server Capability Inference

### Proposal

When dev server config is missing, CC should infer candidate dev servers from the repo:

- `package.json` scripts such as `dev`, `storybook`, `preview`.
- Framework signals such as Next.js, Vite, Storybook.
- Port hints in scripts.
- Existing config files.

It should propose a `CommandCenter.json` `devServers` entry and optionally apply it through an approval gate.

### Justification

Agents are already instructed to call `ensure_dev_server`, but if config is absent they cannot fix the underlying issue except by falling back. The workflow should turn that failure into a structured remediation.

### Implementation Shape

Add a `dev_server_config_suggestion` artifact:

```json
{
  "name": "app",
  "command": "npm run dev -- --host 127.0.0.1 --port $PORT",
  "port": { "base": 3000, "range": 100 }
}
```

Then route through approval if it edits project config.

## 9. Make Shared Documents Typed And Enforced

### Proposal

Shared documents should evolve from "registered Markdown paths" into a typed contract/artifact registry.

Artifact kinds could include:

- `workflow_contract`.
- `api_contract`.
- `state_machine_contract`.
- `test_plan`.
- `decision_log`.
- `parity_matrix`.
- `validation_report`.
- `review_findings`.
- `handoff_summary`.

Each artifact should have:

- Owner context.
- Required reader contexts.
- Version/hash.
- Supersedes relation.
- Authority level.
- Staleness policy.
- Schema where applicable.

### Justification

AeroTrainer graph workflow used shared docs well, but downstream agents still had to infer what mattered. Typed artifacts make alignment enforceable.

### Implementation Shape

Add `register_artifact` or extend `upsert_shared_document`:

- `kind`.
- `schema`.
- `authority`.
- `requiredForContexts`.
- `supersedes`.

The iteration prompt can then say:

"You must read and acknowledge these artifacts before editing files: workflow contract v3, mode API contract v2."

## 10. Add Required Artifact Acknowledgement

### Proposal

For contexts with required upstream artifacts, force the implementer to acknowledge the artifact versions before completing the first task.

This could be a tool:

- `acknowledge_artifact({ artifactId, version, summary })`

Or a required field on `complete_task` for the first task.

### Justification

Agents often skip or under-read shared docs when they are merely listed. Acknowledgement is not perfect proof, but it raises the cost of ignoring the contract and gives validators evidence to inspect.

### Risk

This can become ceremony. Use it only for high-authority artifacts, not every note.

## 11. Add Decision Logging As A Tool

### Proposal

Add a `record_decision` tool for decisions that affect downstream agents:

- Decision title.
- Context.
- Rationale.
- Alternatives rejected.
- Affected contracts.
- Source authority.
- Downstream contexts that must obey it.

Add a separate `propose_decision_change` tool when an agent believes an established decision is wrong.

### Justification

Agent alignment fails when one context privately decides an interface, behavior, or interpretation. Shared docs can capture decisions, but a structured tool makes it visible and enforceable.

### Human Approval Integration

Changing a high-authority decision can require approval. For example, changing "prototype is authoritative" or a cross-context API contract should not happen silently.

## 12. Add Context Interface Contracts

### Proposal

Every context should optionally declare:

- Produces.
- Consumes.
- May edit.
- Must not edit.
- Must not decide.
- Required upstream artifacts.
- Expected downstream consumers.

The planner can generate these, and validators can enforce them.

### Justification

The current graph has tasks and acceptance criteria, but it does not explicitly model the interfaces between contexts. AeroTrainer worked because agents created handoff docs, but this should be first-class.

### Implementation Shape

Extend context definitions:

```json
{
  "id": "mode-night-shift",
  "produces": ["Night Shift screen", "night shift tests"],
  "consumes": ["screen contract", "WM API", "prototype scoring rules"],
  "mayEdit": ["src/modes/nightshift/**", "src/app/screens/nightshift.tsx"],
  "mustNotEdit": ["src/wm/**"],
  "mustNotDecide": ["global keyboard parser behavior"]
}
```

Validators can catch unauthorized edits or private contract drift.

## 13. Add A Cross-Context Integration Validator

### Proposal

Add a built-in validator type that runs after a join or before final publish. Unlike context validators, it is explicitly global.

It checks:

- All contexts' outputs are wired together.
- Shared contracts are consistently implemented.
- No context-local workaround violates a global invariant.
- User-facing workflows work end to end.
- The final app or feature matches the source hierarchy.

### Justification

Context validators are intentionally local. That is correct, but insufficient. AeroTrainer needed a final verification context to catch cross-mode and prototype-parity issues. Make that pattern first-class.

### Implementation Shape

Add `integrationValidator` at workflow or terminal-context level:

- Scope: `changed_files | all_contexts | selected_contexts`.
- Required artifacts.
- Deterministic commands.
- Optional visual/browser checks.
- Structured output that can create remediation contexts, not just reopen a local task.

## 14. Add Validator Ensembles

### Proposal

Let a context define multiple validators:

- Intent validator.
- Type/API validator.
- UX/visual validator.
- Test-quality validator.
- Security/privacy validator.
- Performance validator.
- Prototype parity validator.

The context passes only when required validators pass. Optional validators can emit findings for final synthesis.

### Justification

The dynamic workflow's review dimensions were effective because each reviewer had a clear lens. A single context validator is too broad for complex contexts.

### Implementation Shape

Extend `contextValidator` into:

```json
{
  "validators": [
    { "id": "intent", "kind": "agent", "required": true },
    { "id": "prototype-parity", "kind": "agent", "required": true },
    { "id": "test-quality", "kind": "agent", "required": false }
  ]
}
```

Findings should target tasks, contexts, or proposed new contexts.

## 15. Add Validator Appeals

### Proposal

When an implementer believes a validator is wrong, it should have a structured path:

- `appeal_validation`.
- Include evidence.
- Reference source hierarchy.
- Request judge/collaboration/human approval.

### Justification

The Night Shift `floor` vs `round` issue shows that validators can enforce a local criterion that is wrong globally. Today the workflow likely reopens and the implementer complies. A structured appeal prevents low-quality churn.

### Implementation Shape

Appeals should route based on severity:

- Minor local wording conflict: validator judge agent.
- Source-of-truth conflict: source-conflict gate.
- User-facing tradeoff: human approval gate.

## 16. Add Dynamic Exploration Contexts

### Proposal

Allow agents to add read-only exploration contexts during execution.

Examples:

- "Inspect the reference app's scoring behavior."
- "Compare current CSS with prototype CSS."
- "Find all persistence keys and verify no collisions."
- "Audit keyboard handling across modes."

Exploration contexts produce artifacts, not code changes.

### Justification

Dynamic workflows can quickly fan out investigation without blocking implementation. Graph workflow can preserve that by running read-only contexts in parallel, with no merge risk.

### Implementation Shape

Add context isolation mode:

- `readOnly: true`.
- No write tools.
- No lane commit.
- Artifact output required.

The scheduler can run read-only contexts aggressively because they do not contend on worktrees.

## 17. Add Speculative Branches With Convergence

### Proposal

For high-ambiguity design choices, allow two or more implementation/design branches, then converge with a judge context or human approval.

Examples:

- Two UI architecture proposals.
- Two state management approaches.
- Two migration strategies.

### Justification

The dynamic design phase benefited from multiple complementary perspectives. A graph-native version could preserve evidence and make the choice explicit.

### Implementation Shape

Use existing lanes and joins, but add policy:

- Branches are marked speculative.
- Only one branch is selected for merge.
- Rejected branches are archived, not published.
- The convergence gate records why the winner was chosen.

### Risk

This is expensive and can produce merge waste. Use only for consequential ambiguous decisions.

## 18. Add Quality Profiles

### Proposal

Define reusable quality profiles for workflow types.

For example, an "interactive frontend app" profile could require:

- Unit tests.
- E2E tests.
- Visual screenshots.
- Console-error check.
- Dev-server smoke test.
- Accessibility basics.
- Persistence test if local storage is used.
- Prototype parity matrix if a prototype exists.

### Justification

The graph AeroTrainer output was better partly because it had strong final verification. We should not rely on each planner to remember the same quality bar.

### Implementation Shape

Workflow config:

```json
{
  "qualityProfile": "interactive-frontend-app"
}
```

The planner uses the profile to generate contexts and validators. The final validator uses it to decide whether evidence is complete.

## 19. Add Test Plan Generation And Enforcement

### Proposal

Add a test-plan context early in the graph. It produces a matrix:

- Behavior.
- Unit test target.
- Integration/e2e test target.
- Visual evidence target.
- Acceptance criterion covered.
- Source/prototype reference.

Downstream validators check that the matrix is satisfied.

### Justification

Graph workflow should not just ask agents to test. It should make coverage an artifact and enforce traceability.

### TDD Enforcement

For red-green TDD workflows, require task summaries to include:

- Failing test added.
- Failure observed.
- Code change.
- Passing rerun.

Validators can inspect transcript and test files for evidence. This is not perfect, but it is much stronger than prompt-only TDD.

## 20. Add Evidence Requirements To `complete_task`

### Proposal

Extend `complete_task` with optional structured evidence fields:

- `filesChanged`.
- `testsAdded`.
- `commandsRun`.
- `artifactsProduced`.
- `decisionsMade`.
- `openRisks`.

For high-rigor contexts, make some fields required.

### Justification

Validators currently receive task summaries as free text. Structured evidence improves validation and final reporting.

### Risk

Do not make every task bureaucratic. Use evidence profiles based on context risk.

## 21. Add Automatic Remediation Contexts

### Proposal

When final or integration validation finds cross-context issues, create remediation contexts instead of forcing everything into the final verification context.

Examples:

- `remediate-night-shift-parity`.
- `fix-dev-server-config`.
- `add-e2e-coverage`.
- `normalize-shared-css`.

### Justification

Final verification contexts can become giant catch-all contexts. Dynamic remediation contexts keep ownership and validation crisp.

### Implementation Shape

A validator can return:

```json
{
  "issues": [],
  "proposedGraphPatch": {
    "addContexts": [...],
    "addEdges": [...]
  }
}
```

Patch application goes through graph mutation policy and approval as needed.

## 22. Add Alignment Checks Before Scheduling A Context

### Proposal

Before a context starts, run a cheap "context readiness" check:

- Are required upstream artifacts present?
- Are required decisions approved?
- Are dependency outputs visible in this context's lane?
- Is project config sufficient for this context's tools?
- Does the context still make sense after runtime graph edits?

### Justification

This catches friction before the implementer spends a turn discovering it. It is especially useful for dev server requirements and missing shared docs.

## 23. Improve Prompt Digests For Downstream Agents

### Proposal

Instead of listing all shared documents equally, build a context-specific digest:

- Required authoritative artifacts.
- Recently changed decisions that affect this context.
- Upstream summaries relevant to this context.
- Known risks from validators.
- Current graph diff since workflow start.

### Justification

Agents need alignment, not a pile of links. The graph has enough metadata to produce focused briefing packets.

### Implementation Shape

Add a "context briefing builder" that consumes:

- Contract package.
- Shared artifact registry.
- Context interface contracts.
- History events.
- Validation failures.
- Runtime graph patches.

It should write the full briefing as an artifact and inject a concise version into the prompt.

## 24. Add Dynamic Parallelization Suggestions

### Proposal

Let the scheduler or a planning agent suggest additional parallelism once contracts are stable.

Example:

- After foundation contexts complete, inspect remaining contexts.
- Identify disjoint write surfaces and shared contract readiness.
- Propose splitting or parallelizing mode implementations.
- Require approval or auto-apply based on policy.

### Justification

The AeroTrainer graph serialized mode contexts more than necessary. A conservative planner did that to avoid conflicts. Runtime evidence can justify more parallelism after the shared contracts exist.

### Implementation Shape

Add a `parallelization_advisor` that runs at selected milestones and proposes graph patches:

- Add edges removal among not-yet-started independent contexts.
- Split a large context into parallel children.
- Add join context after parallel branches.

The advisor must prove disjoint ownership and validation boundaries.

## 25. Add Graph Diff Audit Trail

### Proposal

Every runtime graph mutation should produce a durable graph diff artifact:

- Before/after graph hash.
- Operations.
- Initiator.
- Reason.
- Validation result.
- Approval decision, if any.
- Affected contexts and tasks.

### Justification

Dynamic behavior is valuable only if it remains inspectable. The audit trail is what lets graph workflows stay trustworthy as they become more adaptive.

## 26. Add Workflow Retrospectives As Training Data

### Proposal

At completion, generate a structured retrospective:

- Original graph vs final graph.
- Contexts added dynamically.
- Validator failures.
- Human approvals/rejections.
- Friction points.
- Quality evidence.
- Planner mistakes.
- Suggested template changes.

### Justification

Graph workflows can improve if completed executions feed back into planner guidance and workflow templates. AeroTrainer itself is exactly this kind of retrospective.

### Caution

Do not auto-update global templates from one execution. Store recommendations for review.

## 27. Improve UI For Dynamic Graphs

### Proposal

If graphs become dynamic, the UI needs to make that legible:

- Show original graph vs current graph.
- Highlight newly added contexts.
- Show skipped conditional branches.
- Show graph patches awaiting approval.
- Show why a context is blocked.
- Show required artifacts and whether they are acknowledged.
- Show validation layers per context.

### Justification

Dynamic behavior can reduce friction for agents while increasing confusion for humans. The UI must preserve trust.

## Suggested Roadmap

### Phase 1: Low-Risk Refinements

1. Add workflow contract package and source hierarchy.
2. Add repo readiness preflight, including dev server config checks.
3. Improve `complete_task` evidence fields.
4. Add typed artifact kinds for shared documents.
5. Add required artifact prompts for high-authority docs.
6. Add final integration validator template.
7. Add source-conflict check during planning.

These do not require fully dynamic graphs. They mostly improve alignment and reduce friction.

### Phase 2: Controlled Dynamic Graph Edits

1. Add `propose_graph_patch`.
2. Support append-only context/task/edge additions for not-yet-started work.
3. Add graph diff artifacts.
4. Route medium/high-risk patches through human approval gates.
5. Let validators propose remediation contexts.
6. Add dynamic review subgraph templates.

This is the most important phase for matching dynamic workflow strengths.

### Phase 3: Conditional And Adaptive Execution

1. Add router contexts and skipped branch state.
2. Add conditional edges.
3. Add context readiness gates before scheduling.
4. Add dynamic exploration contexts.
5. Add parallelization advisor.
6. Add validator appeals.

This makes the graph adaptive without making it opaque.

### Phase 4: Advanced Collaboration And Speculation

1. Add speculative branches with convergence gates.
2. Add validator ensembles.
3. Add adversarial review/verifier pipelines.
4. Add workflow retrospectives that feed planner/template improvements.
5. Add quality profiles tied to workflow templates.

These are higher leverage for complex work, but they should build on the earlier safety and audit foundations.

## Highest-Value Concrete Builds

If we picked only five things to build first, I would choose:

1. **Workflow contract package**
   - Fixes source-of-truth drift and aligns implementers/validators.

2. **Repo readiness preflight**
   - Removes avoidable friction like missing dev server config before agents waste turns.

3. **Graph patch proposal tool with approval integration**
   - Unlocks dynamic graph evolution while preserving auditability.

4. **Dynamic review subgraph templates**
   - Captures the strongest quality mechanism from the dynamic workflow.

5. **Cross-context integration validator**
   - Makes final parity/integration review a first-class validation layer instead of an ad hoc final context.

## Design Principles For Dynamic Graph Extensions

1. Agents may propose structural change; Command Center validates and records it.
2. Safe append-only changes can be automatic; destructive or authority-changing changes need approval.
3. Every dynamic change must be visible in the graph and audit log.
4. Validators must share the same contract and source hierarchy as implementers.
5. Read-only exploration should be cheap and parallel.
6. Review swarms should have timeout, quorum, and partial-salvage semantics.
7. Dynamic graph behavior should reduce ambiguity, not hide it.
8. The graph remains the source of truth for execution after every mutation.

## Closing Assessment

The graph workflow should become more dynamic, but not by becoming less structured. The right direction is "audited dynamism": agents get more agency to reshape the plan, but every change is typed, validated, logged, and optionally approved.

That would preserve the graph workflow's best qualities from AeroTrainer: reliable validation, durable state, clear dependencies, and strong final evidence. It would also recover the dynamic workflow's best qualities: adaptive fan-out, specialized review, and the ability to create the right workflow shape after discovering what the work actually needs.
