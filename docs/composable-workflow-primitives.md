# Composable Workflow Primitives

> **Status: Superseded historical design.** This document records the proposal that initiated the composition-units program. The implemented contracts are defined by `.kiro/steering/engineering-principles.md`, `.kiro/steering/workflows.md`, `.kiro/steering/agent-backends.md`, `CONTEXT.md`, and `docs/reports/2026-07-12_consolidated-architecture-design-and-plan.md`. In particular, typed publication is public while StatusBus/lifecycle projection is private implementation detail, and removed creation modes are not precedents for new work.

## Overview

Command Center needs to support increasingly complex agentic workflows without
requiring each workflow to reimplement backend invocation, MCP setup, structured
output handling, continuity, human pauses, status events, artifacts, recovery,
and error normalization.

The target architecture is a small set of reusable primitives that existing and
future workflows compose. These primitives are not a generic workflow platform.
They preserve the existing XState and feature-specific orchestration style while
centralizing the concerns that currently drift across regular conversations,
debug mode, graph workflow, smart merge, focus mode, optimistic mode, and future
collaboration mode.

The core idea is:

> Features own their workflow logic. Shared primitives own agent execution,
> continuity, gates, status, artifacts, and minimal durable lifecycle metadata.

## Purpose

This document describes the desired architecture for composable workflow
primitives in Command Center. It is a design specification, not an
implementation plan.

It defines:

- The goals and boundaries of the architecture
- The reusable primitives and their responsibilities
- How existing and planned features should be expressed using the primitives
- The high-level migration order
- What is explicitly out of scope
- Important design constraints and unresolved questions

## Goals

- Reduce duplicated workflow machinery across Command Center features.
- Keep backend-specific details out of feature orchestration code.
- Give workflows a shared way to run agents, preserve continuity, pause for
  input, validate outputs, emit status, and write artifacts.
- Keep feature-specific logic explicit and understandable.
- Avoid building a generic workflow engine, DSL, or Temporal-style runtime.
- Make Collaboration Mode the first major consumer that proves the primitives.
- Preserve existing working systems while migrating incrementally.

## Non-Goals

- Replacing XState as the workflow modeling tool.
- Building a generic graph or DAG executor.
- Rewriting graph workflow's scheduler, eligibility logic, or task model.
- Building replay-safe activity execution with idempotency keys.
- Forcing all persistent state into one event-sourced workflow store.
- Migrating all existing conversations, background jobs, and graph executions
  into a single storage model upfront.
- Forcing all artifacts into one directory layout.
- Making all workflows parallel by default.
- Hiding meaningful Claude versus Codex capability differences.

## Design Principles

### Keep the Existing Backend Ports

Command Center already has two useful backend ports:

- `ConversationBackendRuntime` for stateful, multi-turn conversations
- `AgentTaskRunner` for one-shot or task-style agent invocations

These interfaces should remain separate because they represent genuinely
different execution shapes. The new architecture adds a coordinating layer above
them; it does not erase the distinction.

### Add Abstractions at Drift Points

The right places to abstract are the places where feature code currently
repeats low-level details:

- Choosing a backend execution path
- Applying MCP configuration
- Validating structured output
- Tracking continuity
- Recording backend references and context metrics
- Emitting status frames
- Writing and registering artifacts
- Pausing for user input
- Normalizing errors

The wrong places to abstract are feature-specific decisions:

- Graph task scheduling
- Smart merge branch policy
- Debug investigation phases
- Focus-mode prompt structure
- Collaboration convergence rules

### Prefer Small Services Over DSLs

The target design uses small services and helpers that feature workflows call.
It does not introduce a workflow DSL or a universal workflow runtime.

Feature workflows may remain XState machines, explicit orchestrators, route
handlers, or background jobs. The shared primitives support those workflows
without prescribing one orchestration style.

### Durable Enough, Not Temporal-Lite

Command Center needs durable lifecycle visibility and restart recovery for some
workflows. It does not need full event replay semantics.

The architecture should support a minimal workflow envelope for workflows that
need durable status and recovery. It should not require a generic event store,
replay-safe activities, or cross-feature state migrations before there is a
clear need.

## Target Primitives

### Existing Backend Ports

**Purpose**: Provide low-level backend-specific execution capabilities.

`ConversationBackendRuntime` owns multi-turn conversation execution. It supports
stateful turns, backend references, queued user input, MCP application, aborts,
ask-user callbacks, and conversation-oriented runtime behavior.

`AgentTaskRunner` owns task-style execution. It supports prompt execution with
system instructions, resume references, structured output, timeout behavior,
sandboxing, approval policy, and network/tooling options.

**Responsibilities**

- Preserve backend-specific capabilities.
- Expose Claude and Codex through stable interfaces.
- Return backend references, usage, structured output, text, and errors.

**Not responsible for**

- Feature workflow decisions.
- Artifact registration.
- Cross-feature status semantics.
- User-facing workflow phase management.

### AgentCall Facade

**Purpose**: Give feature workflows one semantic entry point for agent
execution without merging the underlying backend ports.

The facade should expose named operations for common execution shapes, such as
conversation turns, one-shot tasks, structured turns, and structured tasks.
Feature code should not need to know where to apply MCP config, how to validate
structured output, how to normalize backend errors, or how to record continuity
metadata.

**Responsibilities**

- Choose the appropriate backend port for the requested execution shape.
- Apply the selected lane continuity context.
- Apply MCP configuration and workflow-specific tool fragments.
- Validate structured output through gates or schema helpers.
- Normalize backend errors and timeout behavior.
- Record backend references, context metrics, usage, and generated artifacts.
- Emit execution status through the shared status layer.

**Not responsible for**

- Being a single giant input type that covers every possible option.
- Hiding important backend capability differences.
- Deciding workflow phases or feature-specific retry policy.

### Lane

**Purpose**: Represent a named long-lived agent execution stream.

A lane hides backend-specific continuity details behind a stable workflow
concept. A lane may represent an implementer, validator, debugger,
collaborator, scribe, or conversation participant.

**Responsibilities**

- Store lane identity, backend, and continuity policy.
- Track backend references such as Claude conversation IDs or Codex session
  refs.
- Track context metrics and rotation decisions.
- Preserve stale-session recovery metadata.
- Provide continuity context to the AgentCall facade.
- Record outcomes after agent execution.

**Not responsible for**

- Running the agent directly.
- Knowing whether execution uses a conversation runtime or task runner.
- Owning prompts, schemas, tools, or feature-specific policy.

### Gate

**Purpose**: Represent a workflow checkpoint that can pass, fail, or pause.

Gates make common workflow decisions explicit. They provide a shared vocabulary
for checks that appear across many features.

**Gate categories**

| Gate | Purpose |
| --- | --- |
| Structured Output | Validate agent output against a schema |
| Ask User | Pause for a backend-initiated question during a turn |
| Human Approval | Pause after a workflow step for explicit user approval |
| Script Validation | Run configured validation and branch on success/failure |
| Change Set | Check whether an agent or script changed the worktree |
| Convergence | Decide whether multiple lanes have reached agreement |
| Context Limit | Decide whether a lane should rotate before the next turn |
| Circuit Breaker | Stop or pause after repeated failures |

**Responsibilities**

- Return a clear result: pass, fail, or pause.
- Carry enough detail for user-facing status and recovery.
- Keep reusable checkpoint behavior out of feature-specific orchestrators.

**Not responsible for**

- Becoming a generic workflow engine.
- Forcing all pauses into one exact mechanism.
- Erasing the difference between mid-turn ask-user callbacks and post-turn
  pauses triggered by structured output.

### StatusBus

**Purpose**: Provide one scoped live-status transport for conversations,
workflows, merge jobs, graph execution, collaboration, and future feature
activity.

The StatusBus should replace separate event streaming systems without forcing
all features to share one payload schema.

**Responsibilities**

- Publish events by scope and scope ID.
- Let each feature own its frame payload shape.
- Support live UI updates, notifications, and terminal status.
- Avoid duplicated SSE registries and client subscription paths.

**Not responsible for**

- Owning workflow persistence.
- Defining every feature's event schema.
- Acting as an event-sourced workflow log.

### ArtifactRegistry

**Purpose**: Provide one API for writing and registering workflow artifacts.

Artifacts include focus documents, Codex reference documents, graph shared
documents, collaboration outputs, debug findings, validation logs, conflict
reports, and structured transcripts.

The registry should use named artifact kinds that resolve to established paths.
It should not force every artifact into one directory.

**Responsibilities**

- Write artifacts to the correct path for their kind.
- Register metadata so future agent calls can discover relevant artifacts.
- Preserve existing special cases such as `memory-bank/focus.md`.
- Support feature-specific artifact kinds without duplicating file and metadata
  logic.

**Example artifact kinds**

| Kind | Intended location |
| --- | --- |
| Focus | `memory-bank/focus.md` |
| Codex Reference | Existing Codex reference document area |
| Graph Shared Document | Existing graph workflow shared document area |
| Collaboration Design | Collaboration-specific memory-bank location |
| Debug Finding | Debug-specific artifact location |
| Validation Log | Validation or merge artifact location |

### Workflow Envelope

**Purpose**: Provide minimal durable lifecycle metadata for workflows that need
observable status and restart recovery.

The workflow envelope is intentionally small. It is not an event store and does
not replace feature snapshots.

**Responsibilities**

- Store workflow ID, type, status, phase, timestamps, error, and feature-owned
  snapshot.
- Support parent-child relationships when a workflow launches another workflow.
- Let the UI discover running, paused, completed, and failed workflows.
- Give restart recovery code a consistent place to find durable workflow
  lifecycle state.

**Not responsible for**

- Storing every lane, gate, artifact, and child object in a generic schema.
- Replaying activities after restart.
- Migrating all existing persistence into one format upfront.
- Replacing existing XState snapshots or feature-owned state.

## Supporting Utilities

### MCP Configuration Helpers

`PortableMcpConfig` and the existing MCP composition cascade remain the
foundation for tool configuration. New named helpers may return portable MCP
fragments for common feature needs, but this is a convenience layer rather than
a new core primitive.

### XState Actors and Feature Machines

XState remains the right tool for explicit feature state machines. Promise
actors and injected dependencies remain the preferred pattern for external
effects. These are not renamed into a separate Activity abstraction.

## Roles and Responsibilities

| Layer | Owns | Does Not Own |
| --- | --- | --- |
| Feature Workflow | Domain phases, prompts, schemas, UI semantics, policy | Backend quirks, generic status transport, artifact registration |
| AgentCall Facade | Normalized execution, MCP application, error normalization | Feature phase transitions |
| Lane | Continuity state and rotation metadata | Agent execution or prompts |
| Gate | Reusable pass/fail/pause checkpoints | Whole workflow orchestration |
| StatusBus | Scoped live event delivery | Workflow persistence |
| ArtifactRegistry | Artifact paths and metadata registration | Artifact content semantics |
| Workflow Envelope | Minimal lifecycle metadata | Feature-specific state model |
| Backend Ports | Claude/Codex execution details | Cross-feature workflow policy |

## Feature Shapes in the Target Design

### Regular Conversation

Regular conversation is the canonical single-lane workflow.

**Shape**

- One `main` lane per active conversation.
- User prompts become AgentCall conversation turns.
- Backend ask-user callbacks become Ask User gates.
- Transcript and generated references become artifacts.
- Conversation status emits through StatusBus.

**Reused**

- Existing backend ports
- AgentCall facade
- Lane continuity
- MCP helpers
- Ask User gate
- StatusBus
- ArtifactRegistry

**Feature-specific**

- Chat UI
- Message rendering
- Conversation naming and forking
- Queue-while-running user experience
- Model and effort selection UI

### Focus Mode

Focus mode is a session initialization workflow that prepares the session's
objective before normal development begins.

**Shape**

- Creates a focus session and an initialization lane.
- Seeds the focus artifact.
- Runs an objective-understanding AgentCall.
- Uses Ask User gates for clarifying questions.
- Uses a Human Approval gate before writing the final focus document.
- Writes `memory-bank/focus.md` through ArtifactRegistry.
- Finalizes initialization and starts a normal conversation lane.

**Reused**

- AgentCall facade
- Lane continuity
- Ask User and Human Approval gates
- ArtifactRegistry
- StatusBus

**Feature-specific**

- Focus prompt templates
- Focus document structure
- Initialization conversation role
- Confirmation UI
- Finalization policy

### Debug Mode

Debug mode should become a workflow attached to a conversation, not phases
embedded inside the generic conversation machine.

**Shape**

- Attaches a debug workflow to an existing session and lane.
- Runs investigation, hypothesis, fix, and validation steps through AgentCall.
- Uses Structured Output gates for hypothesis and diagnosis schemas.
- Uses Script Validation and Circuit Breaker gates during fix attempts.
- Writes findings and logs as artifacts.
- Emits debug status through StatusBus.

**Reused**

- Existing conversation lane or a dedicated debugger lane
- AgentCall facade
- Structured Output, Script Validation, and Circuit Breaker gates
- ArtifactRegistry
- StatusBus

**Feature-specific**

- Debug prompts
- Debug logs schema
- Debug phase naming
- Debug UI and endpoints
- Criteria for when debugging is complete

### Graph Workflow

Graph workflow remains a graph-specific scheduler that consumes the shared
execution primitives.

**Shape**

- Graph workflow owns DAG traversal, task eligibility, task reopening, and
  graph-specific persistence.
- Implementer and validator calls run through AgentCall.
- Implementer and validator continuity use named lanes.
- Task and context validation use gates.
- Shared documents and validator outputs become registered artifacts.
- Execution status emits through StatusBus.

**Reused**

- AgentCall facade
- Lane continuity
- Structured Output, Script Validation, Context Limit, and Circuit Breaker gates
- ArtifactRegistry
- StatusBus

**Feature-specific**

- Graph definition schema
- DAG scheduler
- Task and context state model
- Graph editor UI
- Task completion tool semantics
- Task reopening policy

### Smart Merge

Smart merge remains a merge-specific workflow, but its agent-powered substeps
use the shared primitives.

**Shape**

- The existing merge state machine owns merge phases and branch policy.
- Conflict analysis and resolution run through AgentCall.
- Validation fixing runs through AgentCall.
- Pre-merge validation is represented as a Script Validation gate.
- Worktree-change checks are represented as Change Set gates.
- Merge progress emits through StatusBus.
- Conflict reports, validation logs, and fix summaries can become artifacts.

**Reused**

- AgentCall facade
- Structured Output, Script Validation, Change Set, and Circuit Breaker gates
- StatusBus
- ArtifactRegistry

**Feature-specific**

- Git merge policy
- Squash merge policy
- Session and project locking rules
- Conflict decision schema
- Conflict review UI
- Validation retry policy

### Optimistic Mode

Optimistic mode is a small parent workflow that runs an autonomous task and then
starts smart merge.

**Shape**

- Creates an optimistic session.
- Runs an autonomous AgentCall with question-asking disabled.
- Uses Change Set or completion gates if needed.
- Starts smart merge with auto-resolution enabled.
- Notifies the user on terminal outcome.
- May use a workflow envelope when optimistic status needs durable visibility.

**Reused**

- AgentCall facade
- Lane continuity where useful
- Change Set gate
- Smart merge workflow
- StatusBus
- Notifications

**Feature-specific**

- Autonomous prompt directive
- Optimistic session creation UX
- Merge message policy
- Fire-and-forget behavior
- Failure notification wording

### Collaboration Mode

Collaboration Mode is the first major new consumer that should prove the
primitive set.

**Shape**

- Creates one lane per participating agent.
- Runs independent first-round proposals.
- Runs structured review rounds.
- Uses Convergence gates to detect when all lanes accept.
- Uses Ask User or Human Approval gates when structured output requires user
  input.
- Uses a final scribe pass to produce the merged design.
- Writes the merged design, structured debate transcript, and open questions as
  artifacts.
- Uses a minimal workflow envelope for durable status, pause/resume, and restart
  recovery.

**Reused**

- AgentCall facade
- Lanes
- Structured Output, Convergence, Ask User, Human Approval, and Circuit Breaker
  gates
- ArtifactRegistry
- StatusBus
- Workflow envelope

**Feature-specific**

- Collaboration prompt protocol
- Per-round response schema
- Acceptance and convergence rules
- Scribe selection and prompt
- Debate transcript UI
- Max-iteration policy
- Worktree concurrency policy

## Concurrency and Locking

The architecture must respect the current session worktree model. Multiple
lanes in one session can create write conflicts if they run simultaneously.

Default concurrency policy:

- Worktree-writing turns run serially within a session.
- Read-only proposal and review turns may run in parallel only when they do not
  mutate the worktree.
- Collaboration Mode should start conservative: serialize any lane that can
  write files.
- Future parallelism can be introduced after lane write permissions and lock
  scope are explicit.

The locking model is a design constraint, not a new primitive.

## Human Pauses

The architecture must support two different pause shapes:

- Mid-turn pause: the backend asks a question while a turn is running.
- Post-turn pause: structured output indicates the workflow needs user input
  before continuing.

Both are modeled as gates, but they are not mechanically identical. The design
must preserve the difference so backend-driven ask-user behavior continues to
work correctly.

## Backend Differences

Claude and Codex must remain distinct where their capabilities differ.

The shared primitives should normalize common behavior, but they must not hide:

- Whether a backend supports precise conversation continuation.
- Whether structured output is enforced by the backend or validated after the
  fact.
- Whether MCP can be applied at startup, between turns, or not at all.
- Whether context-window metrics are available.
- Whether user questions can be asked mid-turn.

Lane and AgentCall design should use backend capabilities rather than assuming
all backends are equivalent.

## Artifact Policy

Artifacts are the durable memory shared across workflow phases, agents, and
future conversations.

ArtifactRegistry should support:

- Writing artifacts to established feature paths.
- Registering artifacts as reference documents when appropriate.
- Capturing source metadata such as workflow ID, lane ID, round, feature, and
  creation time.
- Distinguishing user-facing artifacts from internal logs.
- Preserving existing special paths instead of forcing a new tree layout.

## Status Policy

StatusBus should be scoped and transport-oriented.

Each feature owns its event payload schema. The bus owns delivery, subscription,
and routing. This keeps feature-specific status semantics out of the transport
layer while eliminating duplicated SSE infrastructure.

Suggested scopes:

- Conversation
- Workflow
- Merge job
- Graph workflow
- Collaboration
- Debug

## Minimal Workflow Envelope Policy

The workflow envelope is introduced only for workflows that need durable
lifecycle tracking beyond existing feature state.

The envelope should initially be proven by Collaboration Mode. It should not
force immediate migration of conversations, graph workflow, or background jobs.

Minimum envelope fields:

- Workflow ID
- Workflow type
- Parent workflow ID, when applicable
- Status
- Phase
- Created, updated, and completed timestamps
- Error summary
- Feature-owned snapshot

Feature snapshots remain the source of truth for domain-specific state.

## High-Level Migration Order

This order is intentionally high level. Each step should remain incremental and
should preserve existing behavior while creating reusable surfaces for the next
step.

1. Add shared structured-output validation as the first concrete gate.
2. Add the AgentCall facade over conversation turns and task-style calls.
3. Add ArtifactRegistry for writing and registering workflow artifacts.
4. Add StatusBus and migrate duplicated live-status paths behind wrappers.
5. Extract Lane from graph workflow continuity behind compatibility adapters.
6. Build Collaboration Mode using AgentCall, Lane, Gate, StatusBus, and
   ArtifactRegistry.
7. Introduce the minimal workflow envelope as part of Collaboration Mode's
   durable lifecycle needs.
8. Pull debug mode phases out of the conversation machine.
9. Migrate focus, optimistic mode, graph validators, smart merge substeps, and
   other existing paths opportunistically when the primitives reduce duplication.

## Success Criteria

The design is successful when new workflows can focus on their domain logic.

A new workflow should primarily define:

- Its phases or state machine
- Its prompts
- Its structured schemas
- Its gates
- Its lane policy
- Its artifacts
- Its user-facing UI

A new workflow should not need to reimplement:

- Backend execution selection
- MCP application
- Structured-output parsing
- Lane continuity
- Status event infrastructure
- Artifact registration
- Common pause semantics
- Error normalization

## Out of Scope

- A universal workflow DSL.
- A generic DAG executor.
- A Temporal-like activity runtime.
- A replay-safe operation log.
- Immediate persistence migration for all existing features.
- Parallel writes to one worktree.
- A single mandatory artifact directory.
- Complete unification of all UI status components.
- Replacing existing backend runtimes.
- Changing project worktree isolation rules.

## Open Questions

- What is the exact first shape of the AgentCall facade: named functions only,
  or a small discriminated request type per execution family?
- Which gate kinds should exist as reusable helpers before Collaboration Mode,
  and which should be extracted only after repeated use?
- What metadata should ArtifactRegistry store for artifacts that are not
  reference documents?
- What StatusBus scopes and frame conventions are needed to support existing UI
  without leaking feature-specific semantics into the transport layer?
- How should Collaboration Mode represent read-only versus write-capable lane
  turns?
- Where should the minimal workflow envelope live in session state, and how
  should paused workflows be discovered after restart?
- Which graph workflow continuity state can be generalized without forcing a
  risky state migration for active executions?

## Design Rationale

The design chooses extraction over rewrite.

Command Center already has strong backend plumbing, useful XState patterns, MCP
composition, session locking, and feature-specific workflow code that works.
The problem is that workflows repeatedly solve the same surrounding concerns.

The proposed primitives centralize those repeated concerns while leaving feature
logic close to the features that own it. This preserves the pragmatic shape of
the existing application and gives future workflows a smaller, safer surface to
compose.
