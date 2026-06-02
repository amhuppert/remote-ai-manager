# Requirements Document

## Introduction

This is the **foundation** spec for project-level conversations (PLCs): durable, session-less conversations attached to a **project** rather than a session, whose agent turns execute in the project's **main (repo-root) worktree**. It delivers the session-less conversation data model, session-less persistence and keying, the open/closed/archived lifecycle and open-count, Claude/Codex backend parity with per-turn model/effort, the main-worktree execution path (repo-root execution target + session-less prompt entry reusing the existing prompt stream and conversation machine), the fully-parallel no-guardrail concurrency posture, the project-global active-conversations data source, and the main-worktree guards.

Existing **session conversations** must continue to behave exactly as today; this spec generalizes shared conversation behavior without changing session-conversation semantics.

Requirement IDs below are local numeric IDs. Each acceptance criterion is tagged with its source `PLC-n` ID from `memory-bank/project-level-conversations/REQUIREMENTS.md` for traceability. All PLC clarifying questions were resolved pre-design; this spec does not re-open them.

## Boundary Context

- **In scope (user/operator-observable behavior):**
  - A project owns zero or more durable, session-less conversations that persist across reloads and restarts (PLC-1, PLC-2, PLC-3, PLC-4).
  - Creating the first project conversation from a plain-prose prompt (PLC-5); multiple concurrently-open project conversations per project (PLC-6).
  - Open / closed / archived lifecycle and the "at least one open" open-count signal that downstream UI uses to choose first-run vs cockpit (PLC-7, PLC-8, PLC-9 data side).
  - Agent turns for a project conversation execute in the repo-root (main) worktree with full read/write; the conversation does not create a branch or worktree (PLC-10, PLC-11, PLC-13); the execution context is identified as `main · worktree` (PLC-12).
  - Claude/Codex backend parity: backend selectable before the first turn and fixed afterward; model/effort changeable between turns (PLC-17).
  - Fully-parallel turns across project conversations on the shared main worktree, with no concurrency guardrails (PLC-42).
  - A project conversation may start a turn while the main worktree is already dirty; the system does not block on a dirty tree (PLC-45, execution side).
  - The active-conversations data source returns project conversations across all projects alongside session conversations, applying open/closed/archived visibility rules (PLC-47 data, PLC-46 data).
  - Long-running main-worktree operations report progress and failure/error state consistently with comparable Command Center operations (PLC-51).
  - Main-worktree guards: the worktree init script does not run on project-conversation turns; dev-server functionality is not available at the project level; pre-merge validation has no role for project conversations (PLC-55).
  - Sessions remain unchanged as a concept; session-scoped prompt execution stays session-worktree based; project conversations sit beside sessions (PLC-43).

- **Out of scope (deferred to downstream specs/extensions, not owned here):**
  - The project-page cockpit UI, the unified composer, conversation tabs, first-run↔cockpit visual transition (→ project-conversation-cockpit).
  - Inline spawn cards, the spawn-proposal schema, and the auto-dispatch primitive (→ chat-session-spawning).
  - The global rail's visual grouping, labeling, click-routing, and cross-page navigation (→ unified-conversations-panel extension; this spec provides only the data the rail consumes).
  - The read-only main-worktree diff/review surface (→ main-worktree diff endpoint direct item + cockpit mount). This spec does not block a dirty tree but does not render the diff.
  - Per-conversation capabilities override and notification/Needs-you parity for project conversations (→ agent-capabilities-configuration and notifications extensions).
  - In-app git mutation on main (commit/discard/reset) and any concurrency protection (explicitly deferred).

- **Adjacent expectations:**
  - The downstream cockpit reads this spec's lifecycle "open-count" to choose first-run vs cockpit.
  - The downstream rail and notifications consume the generalized active-conversation / status shape; the data contract must stay stable across the `scope` discriminator.
  - The chat-session-spawning spec consumes project conversations as a spawn-proposal source.

## Requirements

### Requirement 1: Session-less project conversation data model and durability

**Objective:** As a developer using Command Center, I want a project to own durable conversations that are not tied to any session, so that I can converse with an agent about the repo without creating a throwaway session and worktree.

#### Acceptance Criteria

1. The system shall allow a project to own zero or more project conversations independent of any session. _(PLC-1)_
2. While session conversations exist, the system shall keep them valid and continue to associate each with its owning session, unchanged. _(PLC-1, PLC-43)_
3. The system shall persist each project conversation durably so that it survives page reloads and server restarts, retaining its transcript. _(PLC-2)_
4. The system shall persist for each project conversation at least: title, backend agent, model/effort selection, capabilities, status, unread state, last activity, and links to sessions it spawned. _(PLC-3)_
5. The system shall give each project conversation a human-readable title usable on its tab and rail row. _(PLC-4)_
6. When the system reads a project conversation that was persisted by an earlier turn, the system shall return the same transcript and metadata that were last persisted. _(PLC-2)_
7. The system shall distinguish a project conversation from a session conversation by an explicit scope, such that a project conversation carries no owning session reference while a session conversation continues to carry its session reference. _(PLC-1)_

### Requirement 2: First project conversation creation and multiple open conversations

**Objective:** As a developer, I want sending a plain prompt with nothing open to create my first project conversation, and I want to keep several open at once, so that starting and juggling repo conversations is frictionless.

#### Acceptance Criteria

1. When the user sends a plain-prose prompt for a project and no project conversation is open, the system shall create the first project conversation, persist it, and send the prompt into it. _(PLC-5)_
2. The system shall support multiple concurrently-open project conversations per project, each independently selectable. _(PLC-6)_
3. When a project conversation is created, the system shall assign it an identifier that is unique among that project's conversations and stable across reloads. _(PLC-3, PLC-6)_

### Requirement 3: Open / closed / archived lifecycle and open-count

**Objective:** As a developer, I want to close a conversation without losing it, archive ones I am done with, and have the project page know whether to show first-run or the cockpit, so that my workspace reflects what I am actively working on.

#### Acceptance Criteria

1. The system shall treat a project conversation as **open** while it has a tab in the conversation pane, **closed** when it has no tab but is not archived, and **archived** when excluded from the global rail by default. _(PLC-7, PLC-8)_
2. When a project conversation is closed, the system shall remove it from the set of open conversations without archiving or deleting it, and shall keep it reopenable. _(PLC-7)_
3. While a project conversation is closed and not archived, the system shall keep it eligible for listing in the global active-conversations source. _(PLC-7, PLC-47)_
4. When a closed project conversation is reopened, the system shall restore it to the set of open conversations. _(PLC-7)_
5. When a project conversation is archived, the system shall exclude it from the global active-conversations source by default, consistent with archived session conversations, while keeping it retrievable from an archived view. _(PLC-8)_
6. The system shall expose, per project, a count (or boolean equivalent) of currently-open project conversations, regardless of how many closed or archived conversations exist. _(PLC-9 data side)_
7. While a project has at least one open project conversation, the open-count signal shall report open; while a project has zero open project conversations, the open-count signal shall report not-open. _(PLC-9 data side)_

### Requirement 4: Main-worktree execution context

**Objective:** As a developer, I want a project conversation's agent turns to run in the repo's main checkout with full read/write, so that I can ask about and modify the repo without spinning up a session worktree.

#### Acceptance Criteria

1. When a turn is sent in a project conversation, the system shall execute the agent in the project's repo-root checkout worktree (the main worktree), not in any session worktree. _(PLC-10)_
2. The system shall grant a project conversation full read/write capability on the main worktree, not restricted to read-only or Q&A. _(PLC-11)_
3. The system shall make the project conversation's execution context identifiable as `main · worktree`. _(PLC-12)_
4. The system shall not create a branch or worktree as part of a project conversation; branch and worktree creation happen only via session spawning, which is out of scope for this spec. _(PLC-13)_
5. The system shall resolve the main-worktree execution context for a project from the project's repo-root path, without requiring a session. _(PLC-10, PLC-13)_
6. When a project-conversation turn runs, the system shall bind the agent's working directory to the resolved main-worktree path, and the turn shall behave the same way (streaming, status, transcript, error reporting) as a session-conversation turn. _(PLC-10, PLC-51)_

### Requirement 5: Backend parity and per-turn model/effort

**Objective:** As a developer, I want project conversations to choose Claude or Codex exactly like session conversations and to change model/effort between turns, so that backend behavior is consistent everywhere.

#### Acceptance Criteria

1. While a project conversation has not yet been initialized by its first turn, the system shall allow selecting the backend (Claude or Codex). _(PLC-17)_
2. When the first turn of a project conversation has been sent and the conversation is initialized, the system shall fix the backend for the remainder of that conversation. _(PLC-17)_
3. If a turn requests a backend different from the fixed backend of an already-initialized project conversation, the system shall reject the turn with a backend-mismatch error and shall not switch backends. _(PLC-17)_
4. The system shall allow the model and effort selection to change between turns of a project conversation. _(PLC-17)_
5. If a turn requests a model or effort that is invalid for the selected backend, the system shall reject the turn with a validation error before execution. _(PLC-17)_

### Requirement 6: Fully-parallel, no-guardrail concurrency on the shared main worktree

**Objective:** As a developer, I want multiple project conversations to run turns at the same time on the main worktree, accepting the risk, so that I am not artificially serialized.

#### Acceptance Criteria

1. The system shall allow multiple project conversations to have in-flight turns against the shared main worktree fully in parallel. _(PLC-42)_
2. The system shall not add conflict-prevention, serialization, or guardrails for concurrent main-worktree mutation across project conversations. _(PLC-42)_
3. While a turn for one project conversation is in flight, the system shall not block the start of a turn for a different project conversation in the same project. _(PLC-42)_
4. While a turn for a single project conversation is already in flight, the system shall reject a second concurrent turn for that same conversation, consistent with per-conversation single-flight behavior for session conversations. _(PLC-42)_
5. If starting a parallel project-conversation turn would require rebinding an already-running conversation actor to a different worktree, the system shall surface an error rather than corrupt the in-flight turn. _(PLC-42)_

### Requirement 7: Dirty main worktree does not block

**Objective:** As a developer, I want to keep working in a project conversation even when the main checkout already has uncommitted changes, so that I am not forced to commit or stash first.

#### Acceptance Criteria

1. When a project conversation starts a turn while the main worktree already has uncommitted changes, the system shall proceed with the turn and shall not block on the dirty tree. _(PLC-45 execution side)_
2. The system shall not require committing, stashing, or cleaning the main worktree before a project-conversation turn. _(PLC-45 execution side)_

### Requirement 8: Project-global active-conversations data source

**Objective:** As a developer, I want the active-conversations source that feeds the global rail to include project conversations across all projects, so that the rail (built downstream) can show them beside session conversations.

#### Acceptance Criteria

1. The system shall make the active-conversations source return project conversations across all projects alongside session conversations. _(PLC-47)_
2. While returning project conversations, the system shall apply the open/closed/archived visibility rules so that non-archived project conversations (including closed ones) are eligible and archived ones are excluded by default. _(PLC-7, PLC-8, PLC-47)_
3. For each returned project conversation, the system shall provide the same descriptive fields the source provides for session conversations (identity, status, last activity, backend, unread, pending-question summary, and project association), with the execution context represented as the project's main worktree. _(PLC-46 data, PLC-47)_
4. The system shall keep the active-conversation data shape consistent across project and session conversations so that a single consumer can render both. _(PLC-46 data, PLC-47)_

### Requirement 9: Real-time data consistency for project conversations

**Objective:** As a developer, I want project-conversation lifecycle, turn, and status changes to propagate in near-real-time, so that the surfaces built on this data stay current without manual refresh.

#### Acceptance Criteria

1. When a project conversation is created, its status changes, a message is appended, it is closed, reopened, or archived, the system shall emit a real-time change event carrying the project conversation's identity and project association. _(PLC-46)_
2. The system shall emit project-conversation real-time events using the same event shape as session-conversation events, distinguished by the conversation's scope rather than by a separate event channel. _(PLC-46)_
3. While a project-conversation turn is running, the system shall emit status updates (running, awaiting, waiting-for-input) consistent with how session-conversation turns emit status. _(PLC-46, PLC-51)_

### Requirement 10: Long-running operation progress and failure reporting

**Objective:** As a developer, I want long-running main-worktree work in a project conversation to report progress and errors the same way other Command Center operations do, so that I can tell what is happening and when something fails.

#### Acceptance Criteria

1. While a long-running main-worktree operation (such as an agent turn) is in progress for a project conversation, the system shall report progress consistently with comparable Command Center operations. _(PLC-51)_
2. If a project-conversation turn fails or errors, the system shall surface the failure/error state to the conversation and to the active-conversations source, consistent with session-conversation failure reporting. _(PLC-51)_
3. When a project-conversation turn completes, the system shall record completion and update the conversation's status, last activity, and unread state consistently with session conversations. _(PLC-3, PLC-51)_

### Requirement 11: Main-worktree project-config guards

**Objective:** As a developer, I want project-conversation turns to skip session-only project automation on the main worktree, so that running an agent on main does not trigger init scripts, dev servers, or pre-merge behavior that have no meaning there.

#### Acceptance Criteria

1. When a project-conversation turn executes on the main worktree, the system shall not run the worktree init script. _(PLC-55)_
2. The system shall not provide dev-server functionality at the project level; a project conversation shall not start or observe a dev server. _(PLC-55)_
3. The system shall treat pre-merge validation as having no role for project conversations, since there is no merge. _(PLC-55)_
4. While guarding the main worktree, the system shall preserve existing session behavior so that session worktrees continue to run their init scripts, dev servers, and pre-merge validation unchanged. _(PLC-43, PLC-55)_

### Requirement 12: Preserve existing session-conversation behavior

**Objective:** As a maintainer, I want generalizing the shared conversation model to leave session conversations untouched in behavior, so that this foundation adds project conversations without regressing what exists.

#### Acceptance Criteria

1. While the shared conversation schemas, SSE events, persistence, and execution path are generalized, the system shall keep session-conversation creation, execution, persistence, status, archiving, and listing behavior unchanged. _(PLC-1, PLC-43)_
2. The system shall route session-conversation prompts through the existing session-worktree execution path, unchanged by the addition of the project-conversation path. _(PLC-43)_
3. The system shall not introduce a backward-compatibility shim for already-persisted conversation data without explicit owner approval; instead, the generalized model shall represent existing session conversations natively. _(PLC-1)_
