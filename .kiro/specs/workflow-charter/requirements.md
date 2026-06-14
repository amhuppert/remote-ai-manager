# Requirements Document

## Project Description (Input)

**Workflow Charter + source-of-truth hierarchy** for the Command Center graph-workflow engine. Part of `graph-workflow-improvements.taskgarden.yaml` (work item `charter`, lane: alignment, p1, depends_on: []), grounded in Report §1.1 + §1.2 of `graph-workflow-improvement-report.md`. Full discovery detail and the resolved 24-decision record are in `.kiro/specs/workflow-charter/brief.md`.

**Who has the problem:** anyone running graph workflows. Alignment today lives in N independent acceptance-criteria (AC) prose blocks that drift, and when an AC restates authoritative behavior incorrectly it becomes a competing source of truth. Implementers and validators then resolve the same conflict with different implicit authority models (the AeroTrainer "floor/round" saga: implementer followed the correct prototype, validator enforced the wrong AC, a later context silently reverted it — one wasted iteration, a wrong TDD test, a silent revert).

**Current situation:** workflow definitions have no charter/source-hierarchy field; shared documents are pointers (`relativePath`/`description`/`readWhen`) with no `kind`/`version`/`authority`; the implementer prompt injects only one-line pointers and `buildFollowUpPrompt` injects nothing; the validator prompt has no shared-document/charter section and its "intent over wording" guidance is underspecified for AC-vs-source conflicts; new executions seed `sharedDocuments` empty; the config cascade is for operational defaults, not semantic content.

**What should change:** introduce a first-class, pre-execution **charter** that declares a source-of-truth precedence hierarchy and is injected into every implementer and validator prompt for new graph workflows, so all agents resolve conflicts identically.

### Resolved scope (decided with Alex; see brief.md for rationale)

**In scope:**
- Charter data model: hybrid typed envelope — structured `sourcesOfTruth` list (`rank`, `id`, `label`, `type`, `locator`, `description`, `appliesTo`, `accessPolicy`) + markdown narrative sections (mission, ownership map, conventions, non-goals, vocabulary, test strategy, known-ambiguities).
- Storage: canonical on the workflow definition + resolved working definition; mirrored to a registered file under reserved `kind: "charter"` for agent read-access; **not** config-cascade data; explicit definition→execution-state propagation at seed time.
- Reserved `kind: "charter"`: a dedicated charter model that also registers a shared-document pointer.
- Injection: a digest at the **literal top** of both implementer and validator prompts; full charter available on demand as a file; a cheap charter id/reference in every prompt (including `buildFollowUpPrompt`); full digest on the seed and on session rotation, not blindly every follow-up turn.
- Prompt-level rules for applying the hierarchy in both prompts; validator guidance amendment: when an AC conflicts with a higher-ranked source and the implementation follows the higher source, do not fail for the AC mismatch — record the conflict in the validator summary. Implementers cite the hierarchy in `complete_task` summaries when resolving a conflict.
- Charter required at the schema level on every workflow definition and execution; a one-time migration deletes pre-charter workflow definitions and clears pre-charter executions.
- Outside-worktree source entries allowed as read-only/descriptive via `accessPolicy`; never auto-read/write/validate; explicit permission for any out-of-worktree access.
- Observability: lifecycle/log events + SSE for charter register/update.
- Tests: schema parse + round-trip durability contract, planner create/replace, definition→execution-seed propagation, implementer prompt injection, validator prompt injection, follow-up prompt behavior, event/log + SSE publication, and a source-vs-AC conflict behavioral fixture.

**Out of scope (owned by neighboring taskgarden items):**
- `acknowledge_artifact` tool and all acknowledgment semantics (deferred from v1) — and therefore any separate charter "version" field (version = working-definition revision).
- ESCALATE / appeal / pre-reopen adversarial verify → `validator-trust`.
- Deterministic plan-time lint (path existence, "cite don't restate") → `spec-lint`.
- Typed deliverables + contract-freeze → `typed-contracts`.
- Approval-gate digest surfacing → `gate-and-steering`; charter UI → `ui-legibility`.
- Per-context charter overrides/subsetting; runtime charter refinement by an early context; ongoing support for charter-less records (a one-time migration removes them rather than retrofitting compatibility).

**Constraints:** Zod-schema-first with `z.infer` types; no `vi.mock` of internal modules (DI patterns); structured logging via `createLogger`; persistence round-trip durability contract for every new persisted field on the definition/execution; worktree isolation for external sources; existing persisted definitions must still parse; optimization preference quality > friction > alignment > token economy > wall-clock.

## Introduction

This feature introduces a first-class **Workflow Charter** for the Graph Workflow engine: a single, pre-execution brief that declares a **source-of-truth precedence hierarchy** alongside mission, conventions, non-goals, vocabulary, ownership, and test-strategy sections. The charter is presented to every implementer and validator working a charter-bearing workflow so that all agents resolve source conflicts identically — directly addressing the observed failure where a wrong acceptance criterion overrode correct higher-ranked sources and was later silently reverted. Requirements below describe user- and operator-observable behavior only; storage mechanism, schema layout, and prompt-assembly internals are deferred to design.

## Boundary Context

- **In scope**: declaring one workflow-global charter with a ranked source-of-truth list and narrative sections; requiring a charter on every workflow definition and execution at the schema level; a one-time migration that removes all pre-charter workflow definitions and executions; presenting the charter (a prominent digest plus on-demand full content) in every implementer and validator prompt, including follow-up turns; instructing agents to apply the declared precedence; validator conflict-resolution behavior (defer to the higher-ranked source, record the conflict instead of failing); implementer citation of the governing source on conflict; read-only, permission-gated treatment of sources outside the worktree; and recording/broadcasting charter lifecycle events.
- **Out of scope**: any acknowledgment/read-receipt tool or requirement and any separate charter version field (a charter's version is the workflow definition revision); structured ESCALATE/appeal/adversarial-verification verdicts (owned by `validator-trust`); deterministic planning-time lint such as referenced-path existence and "cite, don't restate" warnings (owned by `spec-lint`); typed deliverables and contract-freeze (owned by `typed-contracts`); surfacing the charter in the approval-gate digest (owned by `gate-and-steering`) or in inspector/builder UI (owned by `ui-legibility`); per-context charter overrides or subsets; charter changes authored mid-run by an execution context; and ongoing support for charter-less records (they are removed once by the migration, not tolerated thereafter).
- **Adjacent expectations**: this feature relies on the existing Graph Workflow engine — the workflow definition/execution model, the create/replace definition path, implementer and validator prompt preparation, the validator review step, the execution audit log, and the real-time status broadcast channel. Downstream alignment work (`validator-trust`, `spec-lint`) is expected to consume the charter's declared hierarchy but is not delivered here.

## Requirements

### Requirement 1: Charter declaration and content model
**Objective:** As a workflow author, I want to declare one workflow charter containing a ranked source-of-truth hierarchy and narrative sections, so that implementers and validators share a single authoritative brief.

#### Acceptance Criteria
1. The Graph Workflow engine shall allow a workflow to declare exactly one charter composed of narrative sections (mission, architecture/ownership map, conventions, non-goals, vocabulary, test strategy, and known ambiguities) and an ordered source-of-truth list.
2. Where a charter is declared, the Graph Workflow engine shall require each source-of-truth entry to carry a precedence rank, a stable identifier, a label, a source type, a locator, a description, an applicability scope, and an access policy.
3. The Graph Workflow engine shall treat the source-of-truth list as an explicit precedence ordering in which a higher-ranked source governs over a lower-ranked source when they conflict.
4. If a submitted charter omits a required source-of-truth field, or contains a duplicate or missing precedence rank, then the Graph Workflow engine shall reject the charter with a validation error that identifies the offending entry.
5. The Graph Workflow engine shall treat the charter as workflow-global and shall apply the same charter to every execution context without per-context override or subset.

### Requirement 2: Charter required before execution for new workflows
**Objective:** As an operator, I want charters authored before execution and required for new workflows, so that every context begins from the same authority model with no mid-run drift.

#### Acceptance Criteria
1. The Graph Workflow engine shall require a charter to be present before the first execution context of a charter-bearing workflow runs.
2. When a new workflow definition is submitted for creation or replacement, the Graph Workflow engine shall reject the submission if it does not include a charter.
3. While a workflow is executing, the Graph Workflow engine shall not accept changes to the charter authored by an execution context.
4. Where charter behavior applies, the Graph Workflow engine shall apply it to executions started after the charter is in place and shall leave already-running or resumed executions unchanged.

### Requirement 3: Charter required on the schema; one-time migration of legacy records
**Objective:** As an operator, I want the charter to be a required part of every workflow definition and execution, accepting a one-time removal of pre-charter records, so that the engine never has to handle a charter-less workflow.

#### Acceptance Criteria
1. The Graph Workflow engine shall require a charter on every persisted workflow definition and on every execution; a record without a charter shall fail schema validation.
2. When the application starts after this feature is introduced, the system shall run a one-time migration that removes all workflow definitions and clears all graph-workflow executions created before the charter requirement.
3. The system shall run the migration at most once, and a repeated run shall make no further changes.
4. After the migration completes, the system shall retain no charter-less workflow definition or execution.

### Requirement 4: Charter presented to implementers and validators
**Objective:** As an implementer or validator agent, I want the charter and its hierarchy in my prompt, so that I resolve conflicts the same way as every other agent.

#### Acceptance Criteria
1. When the Graph Workflow engine prepares an implementer prompt for a context in a charter-bearing workflow, the engine shall include the charter and its source-of-truth hierarchy in that prompt.
2. When the Graph Workflow engine prepares a validator prompt for a context in a charter-bearing workflow, the engine shall include the charter and its source-of-truth hierarchy in that prompt.
3. The Graph Workflow engine shall present a concise charter digest at the beginning of each implementer and validator prompt and shall make the full charter content available to the agent on demand.
4. While an agent continues within the same context across follow-up turns, the Graph Workflow engine shall keep a charter reference present in every turn and shall re-present the full digest on the first turn of any fresh agent session.
5. The Graph Workflow engine shall present the same charter content to the implementer and the validator of a given context.

### Requirement 5: Conflict resolution by declared precedence
**Objective:** As an operator, I want agents to apply the declared precedence when sources conflict, so that a wrong acceptance criterion no longer overrides a correct higher-ranked source.

#### Acceptance Criteria
1. The Graph Workflow engine shall instruct implementers and validators that, when sources conflict, the higher-ranked source in the charter prevails over a lower-ranked source.
2. When a validator determines that the implementation follows a higher-ranked source that conflicts with a lower-ranked acceptance criterion, the Graph Workflow engine shall not fail the context solely for that acceptance-criterion mismatch.
3. While resolving such a conflict, the Graph Workflow engine shall record the conflict — the affected criterion, the prevailing source, and the resolution — in the validation result summary.
4. When an implementer resolves a source conflict or ambiguity while completing a task, the Graph Workflow engine shall require the implementer to cite the governing source-of-truth entry in the task completion summary.
5. The Graph Workflow engine shall evaluate each source's precedence within that source's declared applicability scope.

### Requirement 6: External and worktree-isolated sources
**Objective:** As a workflow author, I want to reference authoritative sources outside the worktree as read-only, so that real-world authorities can rank in the hierarchy without violating worktree isolation.

#### Acceptance Criteria
1. Where a source-of-truth entry is marked as residing outside the session worktree, the Graph Workflow engine shall treat that entry as read-only and descriptive.
2. The Graph Workflow engine shall not automatically read, write, or verify the existence of an outside-the-worktree source.
3. If an operation attempts to access an outside-the-worktree source, then the Graph Workflow engine shall require explicit human permission before that access occurs.
4. The Graph Workflow engine shall confine all automatic file operations performed for charter sources to the session worktree.

### Requirement 7: Charter lifecycle observability
**Objective:** As an operator, I want charter activity recorded and surfaced live, so that I can audit which charter governed a run.

#### Acceptance Criteria
1. When a charter is registered for a workflow, the Graph Workflow engine shall record a charter-registered event in the execution audit log.
2. When a charter is updated, the Graph Workflow engine shall record a charter-updated event in the execution audit log.
3. When a charter is registered or updated, the Graph Workflow engine shall broadcast the change in real time to connected clients.
4. The Graph Workflow engine shall make the governing charter identifiable in the execution record of the run it applied to.
