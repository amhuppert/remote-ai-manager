# Requirements Document

## Introduction

This spec delivers **inline session spawning from a project conversation (PLC)**: an agent turn can emit a **structured, machine-validated spawn proposal** for one or more sessions, rendered as an **inline spawn card** with **Edit** and **Create**. Creating spins up the proposed sessions with **full New-Session parity** by reusing the existing session-creation primitives, starts spawned branches from the main worktree's **committed HEAD** (no uncommitted carryover), tags them **`from chat`**, links them back to the spawning conversation, and — for any session carrying an optional **`initialPrompt`** — reliably **auto-dispatches** that prompt as the session's **first user turn once its agent is ready** (worktree setup, init script, backend live), exactly once. The conversation then **passively tracks** spawned-session status without driving the sessions.

Per the **agent-offloading principle**, the agent only proposes; **Command Center validates the proposal with Zod and performs creation deterministically** — the agent never creates sessions itself.

This is the **orchestration** spec of the project-level-conversations initiative. It depends on the **foundation** (project-level-conversations) as the source of the conversation/turn that emits proposals and the SSE/active-conversations contracts, and has a **soft UI-mount dependency** on the **project-conversation-cockpit** (whose transcript hosts the inline card). The spawn-proposal schema and the auto-dispatch primitive are designed against the foundation and are independent of the cockpit.

Requirement IDs below are local numeric IDs. Each acceptance criterion is tagged with its source `PLC-n` ID from `memory-bank/project-level-conversations/REQUIREMENTS.md` for traceability. All PLC clarifying questions were resolved pre-design; this spec does not re-open them.

## Boundary Context

- **In scope (user/operator-observable behavior):**
  - A structured, machine-validated, user-reviewable spawn proposal for one or more sessions — each with name, branch, target, agent, creation mode, and an optional initial prompt — emitted by an agent turn and validated by Command Center before Create is offered (PLC-29, PLC-30, PLC-33).
  - An inline spawn card rendered in the conversation transcript, one row per proposed session, with **Edit** and **Create**; a single card may propose multiple sessions (batch), and Create on a multi-row card creates all proposed sessions (PLC-29).
  - Deterministic session creation with full New-Session parity — agent (Claude / Codex / dual Claude+Codex race), creation mode (fast / focus / optimistic), branch, target — reusing the same validations and lifecycle as the normal New Session flow; spawned branches start from the main worktree's committed HEAD with no uncommitted carryover (PLC-31).
  - Sessions created from a spawn card are tagged `from chat` and linked back to the spawning conversation (PLC-32).
  - For each created session carrying an `initialPrompt`, reliable auto-dispatch of that prompt as the session's first user turn once its agent is ready, exactly once, with drop-on-setup-failure and best-effort batch semantics; mode-independent; a dual Claude+Codex race seeds both agents with the same prompt (PLC-33, PLC-34, PLC-35).
  - The spawning conversation passively tracks and surfaces spawned-session status without autonomously driving the sessions after creation (PLC-36).

- **Out of scope (deferred to other specs/extensions, not owned here):**
  - The project-conversation data model, persistence, lifecycle, and the main-worktree execution path that runs the proposing agent turn (→ project-level-conversations foundation).
  - The cockpit page shell, unified composer, conversation tabs, and the transcript host that mounts the inline card (→ project-conversation-cockpit); this spec consumes the host's mount point as a contract.
  - The New Session modal UI itself, and the sessions table row presentation (→ existing session UI; reused, not forked).
  - The global rail's surfacing/grouping/routing of spawned sessions (→ unified-conversations-panel / foundation active-conversations data).
  - Autonomous orchestration of spawned sessions beyond their first turn — driving subsequent turns, merging, or workflow launching (explicitly deferred).

- **Adjacent expectations:**
  - The foundation supplies the conversation/turn that emits a proposal and the conversation/turn + SSE/active-conversations contracts; this spec must align to those contracts and must not modify the foundation's conversation data/execution.
  - The cockpit supplies the transcript mount point where the inline card renders; the mount contract is owned by the cockpit spec.
  - Session creation, branch/worktree provisioning, single-flight locking, the message queue, and the dual Claude+Codex collaboration/race are existing primitives this spec composes; it reuses them rather than forking.
  - The active-conversations source / sessions list (foundation + existing session domain) is the surface the spawning conversation reads to passively track spawned-session status; this spec relies on those existing status signals rather than inventing a parallel status pipeline.

## Requirements

### Requirement 1: Structured, machine-validated spawn proposal

**Objective:** As a developer using Command Center, I want the agent's proposal to spawn sessions to be structured and validated before I can act on it, so that I review trustworthy data and Command Center — not the agent — performs the creation.

#### Acceptance Criteria

1. When an agent turn in a project conversation proposes work as one or more sessions, the system shall represent that proposal as structured data describing one or more proposed sessions, each carrying a name, a branch, a target, an agent selection, and a creation mode. _(PLC-29, PLC-30)_
2. The system shall validate a spawn proposal against a defined schema before offering Create, such that a proposal that does not conform to the schema is treated as invalid. _(PLC-30)_
3. If a spawn proposal is invalid, the system shall surface the invalid proposal as an error or safely ignore it, and shall not offer Create for the invalid proposal. _(PLC-30)_
4. The system shall require that a valid spawn proposal describe at least one proposed session. _(PLC-29, PLC-30)_
5. Where a proposed session includes an initial prompt, the system shall represent that initial prompt as an optional, user-editable field of the proposal. _(PLC-33)_
6. The system shall perform session creation deterministically after validation, and shall not allow the agent to create sessions directly. _(PLC-30)_

### Requirement 2: Inline spawn card with Edit and Create (multi-session batch)

**Objective:** As a developer, I want a validated proposal to appear as an inline card in the conversation with Edit and Create, so that I can review, adjust, and create one or several sessions without leaving the conversation.

#### Acceptance Criteria

1. When a valid spawn proposal is available for a conversation turn, the system shall render an inline spawn card in that conversation's transcript, presenting one row per proposed session with each row's name, branch and target, and agent. _(PLC-29)_
2. The system shall present the spawn card with an Edit control and a Create control. _(PLC-29)_
3. When the user invokes Edit, the system shall allow the user to review and modify the proposed sessions — including each proposed session's name, branch, target, agent, creation mode, and optional initial prompt — before creation. _(PLC-29, PLC-33)_
4. While a spawn card proposes multiple sessions, the system shall allow the user to create all proposed sessions from that card in a single Create action. _(PLC-29)_
5. The system shall keep the spawn card's proposed values consistent with the data that will be submitted for creation, so that what the user reviews and edits is what gets created. _(PLC-29, PLC-30)_
6. While rendering the spawn card and its controls, the system shall follow the Command Center design system (semantic color, typography, spacing, radii, and motion tokens) rather than introducing hard-coded visual values. _(PLC-29)_

### Requirement 3: New-Session parity and committed-HEAD spawn base

**Objective:** As a developer, I want sessions created from a spawn card to behave exactly like sessions created from the New Session flow, so that spawning from chat is a first-class creation path with no surprises.

#### Acceptance Criteria

1. When the user creates sessions from a spawn card, the system shall create each session with full New-Session parity — honoring the chosen agent (Claude, Codex, or dual Claude+Codex race), creation mode (fast, focus, or optimistic), branch, and target — using the same validations and lifecycle as the normal New Session flow. _(PLC-31)_
2. The system shall reuse the existing session-creation, branch, and worktree primitives for spawn-card creation rather than introducing a separate creation path. _(PLC-31, PLC-43)_
3. When a session is created from a spawn card, the system shall start the session's branch from the main worktree's committed HEAD. _(PLC-31)_
4. While creating a session from a spawn card, the system shall not carry uncommitted edits from the main worktree into the spawned session's worktree. _(PLC-31)_
5. If a proposed session fails the same validations the normal New Session flow applies (for example, an invalid or duplicate session name or branch), the system shall reject that session's creation with a clear error consistent with the New Session flow. _(PLC-31, PLC-30)_

### Requirement 4: `from chat` tagging and back-links

**Objective:** As a developer, I want sessions created from a conversation to be identifiable as chat-spawned and linked back to the conversation that created them, so that I can trace each session's origin.

#### Acceptance Criteria

1. When sessions are created from a spawn card, the system shall tag those sessions `from chat` so they are identifiable as chat-spawned in the sessions surface. _(PLC-32)_
2. When sessions are created from a spawn card, the system shall link each created session back to the spawning project conversation. _(PLC-32)_
3. The system shall persist the `from chat` tag and the back-link durably with the session, so that the origin survives reloads and restarts. _(PLC-32, PLC-3)_
4. While linking a created session back to its spawning conversation, the system shall associate the created session with the conversation that proposed it (the conversation records the sessions it spawned). _(PLC-32, PLC-3)_

### Requirement 5: Optional per-session initial prompt and readiness-gated auto-dispatch

**Objective:** As a developer, I want a proposed session to optionally carry a first prompt that is reliably sent as its first user turn once the agent is ready, so that spawned work begins automatically without me re-typing the task.

#### Acceptance Criteria

1. The system shall allow each proposed session to carry an optional initial prompt that is agent-proposed and editable in the card's Edit flow. _(PLC-33)_
2. When a session is created with an initial prompt, the system shall auto-dispatch that initial prompt as the session's first user turn once the session's agent is ready (worktree setup complete, init script complete, backend live). _(PLC-34)_
3. While auto-dispatching a session's initial prompt, the system shall deliver exactly one first user turn for that session, with no duplicate or conflicting first turn. _(PLC-34)_
4. When a session is created without an initial prompt, the system shall create the session idle and shall not auto-dispatch any first turn. _(PLC-34)_
5. If a session fails setup, the system shall drop that session's queued initial prompt and shall not dispatch it. _(PLC-34)_
6. The system shall apply auto-dispatch independently of the session's creation mode, so that a session created in any mode with an initial prompt receives its first user turn once ready. _(PLC-34)_
7. The system shall deliver the auto-dispatched first turn through the existing message-queue and single-flight execution path rather than a separate execution path. _(PLC-34)_

### Requirement 6: Best-effort batch creation and dispatch

**Objective:** As a developer, I want creating several sessions at once to keep the ones that succeed even if some fail, so that a single bad row does not discard the whole batch.

#### Acceptance Criteria

1. When the user creates multiple sessions from a spawn card and some sessions fail to create, the system shall keep the successfully-created sessions and shall not roll back the entire batch. _(PLC-34)_
2. If a session in a batch fails to create or fails setup, the system shall drop that session's own initial prompt while preserving the other sessions and their initial prompts. _(PLC-34)_
3. When a batch create completes, the system shall report which proposed sessions were created and which failed, so that the user can tell the outcome of the batch. _(PLC-34, PLC-51)_

### Requirement 7: Dual Claude+Codex race seeds both agents

**Objective:** As a developer, I want a spawned dual Claude+Codex race to start both agents on the same initial prompt, so that the race begins from one shared task statement.

#### Acceptance Criteria

1. Where a proposed session's agent is a dual Claude+Codex race and the session carries an initial prompt, the system shall seed both the Claude and the Codex participants of the race with the same initial prompt. _(PLC-35)_
2. While seeding a dual Claude+Codex race from an initial prompt, the system shall apply the same exactly-once first-turn and drop-on-setup-failure guarantees that apply to single-agent sessions. _(PLC-34, PLC-35)_

### Requirement 8: Passive spawned-session status tracking

**Objective:** As a developer, I want the conversation that spawned sessions to show me how those sessions are doing without taking control of them, so that I can monitor progress while remaining in charge.

#### Acceptance Criteria

1. While sessions have been spawned from a project conversation, the system shall surface those spawned sessions' status to the conversation. _(PLC-36)_
2. When a spawned session's status changes, the system shall reflect the updated status in the spawning conversation's surface in near-real-time, consistent with how Command Center reports session status elsewhere. _(PLC-36, PLC-46)_
3. The system shall not autonomously drive a spawned session after creation beyond the single auto-dispatched first turn; it shall only track and surface status. _(PLC-36)_
4. The system shall surface spawned-session status by consuming the existing session status signals rather than introducing a separate status-driving mechanism. _(PLC-36, PLC-51)_

### Requirement 9: Alignment with the foundation and cockpit boundaries

**Objective:** As a maintainer, I want the spawning spec to compose the foundation and cockpit contracts without modifying them, so that the three specs integrate cleanly and remain independently maintainable.

#### Acceptance Criteria

1. While emitting and acting on spawn proposals, the system shall consume the foundation's project-conversation turn and event contracts without modifying the foundation's conversation data model or main-worktree execution path. _(PLC-30, PLC-43)_
2. The system shall render the inline spawn card into the cockpit's transcript mount point, treating that mount point as a contract owned by the cockpit spec. _(PLC-29)_
3. The system shall keep the spawn-proposal schema and the auto-dispatch primitive usable against the foundation alone, so that they do not require the cockpit UI to function. _(PLC-30, PLC-34)_
4. While reusing the existing session-creation and dual-race primitives, the system shall not fork or duplicate those primitives. _(PLC-31, PLC-43)_
