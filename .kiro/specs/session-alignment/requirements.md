# Requirements Document

## Project Description (Input)

**Who has the problem.** Command Center users who run multiple conversations inside a single
session (one git worktree + branch) and need every conversation in that session to share the same
understanding — objective, decisions, constraints, non-goals. Today the only mechanism for this is
**focus mode**, which is chosen as a session *creation mode*.

**Current situation.** A session must be created as a focus-mode session upfront; a `fast` session
cannot become a focus session later. Focus mode writes a placeholder `memory-bank/focus.md` and sets
a session-level `objective` that is injected (as `<objective>…</objective>`) into every
conversation's system prompt. Because alignment is decided at creation time and bound to the
`creation_mode`, it cannot be enabled after the fact, and the alignment content has no real
authoring/updating UI. Graph workflows separately have a richer, immutable **charter** concept
(mission + ranked source-of-truth hierarchy, rendered as a budget-bounded digest injected into
workflow contexts).

**What should change.** Replace focus mode with a session-level **Alignment** feature that is
decoupled from how the session was created:

1. **Creation modes.** Remove `focus` as a session creation mode. Rename `fast` → `normal`. After
   the change the only two creation modes are **`normal`** and **`optimistic`**.
2. **Alignment is presence-based, not a mode.** A session either has an Alignment charter or it does
   not; it can be created, redrafted, and evolved at **any point** in the session's life,
   independent of creation mode. Once present, **all conversations in the session are informed** by
   it.
3. **One primary charter** per session (user-facing label **"Alignment"**; internal model
   `sessionCharter`/`sessionAlignment`), free text, **fully agent-mediated in v1** (no user markdown
   editor), alongside the existing **passive reference documents** for supplementary material.
4. **Creation via a `/align` slash command** in the same family as `/commit` and `/merge`: it runs
   inside a conversation but triggers deterministic CC machinery. On first run it materializes a
   **blank charter template** (Mission, Decisions, Constraints, Non-goals, Known ambiguities,
   Relevant sources) as a *soft scaffold* and instructs the agent to populate it from the
   conversation's context (the agent may adapt/remove sections; it stays free text). On **rerun** it
   does **not** overwrite with the template — the agent **rewrites from the existing charter**,
   informed by the conversation since. Either way the result is a **draft** surfaced behind an
   **"Approve Charter" banner** (the old focus-initialization banner pattern); approval activates it
   as a new version. The active charter keeps governing until a redraft is approved. A single
   system-prompt instruction tells the agent to *suggest* running `/align` when a shared charter
   would help (no separate proposal card/tool).
5. **Evolution via agent-proposed decisions.** The agent proposes decisions (in **bulk**) through a
   dedicated `cctl` command modeled on the custom AskUserQuestion flow, surfaced in an AskUserQuestion-style
   approval UI. The user approves or rejects-with-feedback immediately; only **approved** decisions
   are stored. On approval, each decision is appended to a session-scoped **decision log** and CC
   queues the resolution as the next user message after the proposing turn ends, instructing the
   agent to fold it into the charter; the agent rewrites the charter and it **auto-activates** with **no separate charter
   approval** (the decision approval is the gate). Reject-with-feedback routes back to the agent.
6. **Injection.** The active charter is **governing context** injected into every conversation each
   turn (full-inline when small, digest + pointer when larger) — stronger than passive reference
   docs ("read when relevant"). **Guaranteed per-turn propagation is a hard requirement**: today
   `sessionInstructions` are baked into a backend runtime once at creation, so a live runtime would
   not pick up a mid-session change. The design must guarantee delivery via a true per-turn alignment
   preamble OR stale-runtime detection/recreation when `runtimeAlignmentVersion < activeAlignmentVersion`,
   and verify the actual runtime lifecycle with a test.
7. **Storage & versioning.** A `SessionAlignmentService` owns governing semantics; **app state is
   the source of truth** (content, hash, version, draft/active status, timestamps, author, approver,
   last-updated conversation), with a worktree **mirror** (e.g. `.cc/session-alignment/charter.md`)
   materialized on activation/update (not every turn) for transparency — the mirror is not the
   authority. The content **hash defines a version boundary**; `activeVersion` is the UX/audit handle;
   `lastSeenAlignmentVersion` (per conversation) and `runtimeAlignmentVersion` (per runtime) drive
   stale indicators and the version-seen audit. The exact table shape (extend the per-session
   document substrate vs. a dedicated table) is a design-time decision; **no parallel
   registry/subsystem**, and reuse DocsPanel + reference-documents for discoverability.
8. **Approval topology** — exactly two human gate types: the **"Approve Charter"** gate on every
   `/align` (initial and reruns), and **decision approvals**. Nothing else gates a charter change.
9. **`objective` removed.** Delete the `objective` field and its `<objective>` injection; the charter
   subsumes its role. Optimistic mode no longer sets it — its instructions become the kickoff prompt.

**Scope / non-goals (v1).**
- **Graph workflows are out of scope** — they keep their existing immutable charter mechanism; this
  feature must not add a competing alignment mechanism for them. A shared "governing-documents" core
  serving both is a possible future only if a clean path is clear.
- **Autonomous workflows do not use this feature** — optimistic mode is small/single-conversation and
  gets no charter; therefore there is **no auto-approval / auto-activation-in-autonomous logic**. The
  feature is **attended / normal-session only**. (The decision-driven auto-activation is not an
  autonomous path — it is still gated by a human approving the decision.)
- Explicitly **dropped for v1**: required-schema template (template is a soft scaffold), alignment
  workshop flow, manual charter editing, manual "Log decision" capture, concurrency guard while a
  draft is open, per-update charter diff/approval gate, agent-proposed-creation card/tool,
  child-session inheritance, project-level cascade, semantic-divergence health detection.

**Migration.** No focus-session migration (historical focus sessions deleted; no draft-seeding from
`focus.md`). Remove `focus` from the enum, creation UI/APIs, chat-spawning schemas, create-modal
tabs, badges, tests, error copy. Rename `fast` → `normal` via a minimal **idempotent** migration
mapping existing `creation_mode = 'fast'` rows to `'normal'`. Remove the `objective` field. Follow
the DB-migration rules (additive/forward-compatible, idempotent, don't brick older builds).

**Reuse map.** `/align` → the `/commit`·`/merge` special-slash-command machinery; decision
propose/approve → the custom AskUserQuestion tool + UI (bulk, select-plus-note); "Approve Charter"
→ the focus-initialization banner; charter rendering/hashing → the graph-workflow charter
renderer/schema/hash (NOT the immutable `execution.charter` snapshot); discoverability → DocsPanel +
reference-documents registry; plus one new agent-facing charter write/update tool. Session-wide
injection precedent: `sessionState.tddEnabled`.

> **Authoritative design detail** (key code touchpoints, version model, open implementation-time
> choices, and a record of superseded decisions) lives in
> `memory-bank/session-alignment-feature.md`. Code references there were gathered in an exploration
> pass and should be re-verified during the design phase.

## Introduction

This feature replaces Command Center's session **focus mode** with a presence-based session-level
**Alignment** capability. Today, sharing a single objective across every conversation in a session
requires choosing *focus mode at session creation*; it cannot be enabled later, the alignment content
has no real authoring/updating surface, and it is bound to the session's `creation_mode`.

The new model decouples alignment from how a session was created. A session may carry an **Alignment
charter** — a free-text, agent-authored governing document — that can be created, approved, and
evolved at any point in the session's life. While present, the active charter is delivered as
governing context to **every** conversation in the session, on **every** turn, including conversations
whose agent was already running. Authoring happens through an `/align` command and an "Approve Charter"
gate; ongoing evolution happens through agent-proposed **decisions** that the user approves in bulk and
that are then folded into the charter automatically. The legacy `objective` field and `focus` creation
mode are removed; `fast` is renamed to `normal`, leaving exactly two creation modes (`normal`,
`optimistic`).

The requirements below describe user- and operator-observable behavior only. Internal storage shape,
the inline-vs-digest size threshold, and the specific mechanism that guarantees mid-session propagation
are deliberately deferred to the design phase.

## Boundary Context

- **In scope**: two consolidated creation modes (`normal`, `optimistic`) and migration of existing
  `fast` sessions; a presence-based Alignment charter available on normal sessions at any time;
  charter authoring/redrafting via `/align` behind an "Approve Charter" gate; agent-proposed decision
  approval that folds approved decisions into the charter and auto-activates it; a session-scoped
  decision log; guaranteed per-turn injection of the active charter as governing context;
  versioning, version-seen audit, per-version diff/rollback, stale and update indicators, a
  transparency preview of exactly what agents receive, and a worktree copy of the active charter;
  removal of the `focus` creation mode and the `objective` field across all user-facing surfaces.
- **Out of scope**: graph-workflow charters (the existing immutable mechanism is unchanged and gains
  no competing alignment mechanism); alignment for `optimistic`/autonomous sessions — an
  autonomous *session*, not the internal backend calls a single attended turn makes on the user's
  behalf (Requirement 12.4); manual charter
  editing (user markdown editor); manual "Log decision" capture; a required-schema charter template
  (the template is a soft scaffold); an alignment workshop flow; a concurrency guard while a draft is
  open; a per-update charter diff/approval gate beyond the decision approval; an agent-proposed
  creation card/tool; child-session inheritance; project-level cascade; semantic-divergence health
  detection; migration or draft-seeding of historical focus sessions.
- **Adjacent expectations**: the feature relies on Command Center's existing per-turn prompt
  composition path, its special slash-command machinery (the family that includes `/commit` and
  `/merge`), its existing bulk question/approval UI (select-plus-note), its documents panel and
  reference-documents registry, and its graph-workflow charter rendering/hashing as reusable building
  blocks. It does **not** own or modify the graph-workflow charter mechanism, and it expects to add no
  parallel alignment registry or subsystem. How these are wired is a design-phase concern.

## Requirements

### Requirement 1: Consolidated session creation modes

**Objective:** As a Command Center user, I want exactly two clearly-named session creation modes, so that creating a session is simpler and shared alignment is no longer tied to how a session was created.

#### Acceptance Criteria
1. The session-creation UI shall offer exactly two creation modes: `normal` and `optimistic`.
2. The session-creation UI shall not present `focus` as a creation mode.
3. The `normal` creation mode shall take the role previously held by `fast`.
4. When Command Center loads a session whose stored creation mode was `fast`, it shall present that session as a `normal` session.
5. When the creation-mode migration runs more than once, it shall produce the same result (idempotent) and shall not change any session data other than mapping the prior `fast` value to `normal`.
6. Command Center shall not present `focus` as a creation mode in any creation UI, session badge, or API response.
7. If a session-creation request specifies an unsupported creation mode (for example `focus`), then Command Center shall reject the request with an error.

### Requirement 2: Presence-based alignment lifecycle

**Objective:** As a user running multiple conversations in one session, I want to add or evolve a shared Alignment charter at any point regardless of how the session was created, so that every conversation in the session shares the same understanding.

#### Acceptance Criteria
1. A session shall be in exactly one of two alignment states: no active Alignment charter, or one active Alignment charter.
2. Where a session has no active Alignment charter, Command Center shall allow the user to create one at any point in the session's lifetime.
3. Command Center shall allow Alignment creation and redrafting independent of the session's creation mode.
4. While a session has an active Alignment charter, every conversation in that session shall be informed by it.
5. Command Center shall enable the conversation agent to suggest running `/align` when a shared charter would help, and shall not provide a separate agent-proposed-creation card or tool.
6. Command Center shall use the user-facing label "Alignment" for this feature.

### Requirement 3: Charter authoring and redrafting via `/align`

**Objective:** As a user, I want an `/align` command that drafts or redrafts the session's Alignment charter from the conversation, so that I can author and evolve shared context through the agent rather than hand-editing files.

#### Acceptance Criteria
1. Command Center shall provide an `/align` command that runs inside a conversation and triggers deterministic Command Center machinery, in the same family as the existing `/commit` and `/merge` commands.
2. When a user runs `/align` and the session has no charter, Command Center shall materialize a blank charter template containing the sections Mission, Decisions, Constraints, Non-goals, Known ambiguities, and Relevant sources as a soft scaffold, and shall instruct the agent to populate it from the conversation context.
3. While drafting from the scaffold, the agent shall be permitted to adapt, restructure, or remove sections, and the charter shall remain free text.
4. When a user runs `/align` and the session already has a charter, Command Center shall provide the existing charter for the agent to rewrite from, and shall not overwrite it with the blank template.
5. When an `/align` run produces a charter, Command Center shall present the result as a draft pending approval and shall not change the currently active charter.
6. Command Center shall not provide a manual charter editor in v1; charter content shall be authored and updated only through the agent (via `/align` and approved decisions).

### Requirement 4: Charter approval gate

**Objective:** As a user, I want to review and approve a charter draft before it governs the session, so that I control the shared context every conversation receives.

#### Acceptance Criteria
1. When an `/align` run produces a draft (whether an initial draft or a rerun rewrite), Command Center shall surface an "Approve Charter" banner offering the user to approve or reject the draft.
2. When the user approves a charter draft, Command Center shall activate it as a new charter version.
3. While a charter draft is unapproved, the currently active charter shall continue to govern the session.
4. While a charter draft is unapproved, Command Center shall not inject the draft as governing context.
5. When the user rejects a charter draft, Command Center shall leave the currently active charter unchanged.

### Requirement 5: Decision-driven charter evolution

**Objective:** As a user, I want the agent to propose decisions in bulk and have approved ones folded into the charter automatically, so that the charter evolves through reviewed decisions without re-approving the whole charter each time.

#### Acceptance Criteria
1. Command Center shall provide an agent-facing command that proposes one or more decisions at once for the user to review.
2. When the agent proposes decisions, Command Center shall present them in a bulk approval UI with one explicit, mutually exclusive Approve/Reject selection per decision whose selected state is visually and semantically exposed, plus an optional rejection note.
3. Command Center shall persist only approved decisions; proposed decisions that are not approved shall not be stored.
4. When the user approves a decision, Command Center shall append it to the session's decision log.
5. When the user approves a decision, Command Center shall instruct the agent in the same conversation to incorporate the decision into the charter, and the resulting charter shall auto-activate without a separate charter-approval gate.
6. When the user rejects a decision with feedback, Command Center shall route that feedback back to the agent for revision or re-proposal and shall not change the charter.
7. Command Center shall not provide a manual decision-capture path in v1; decision-log entries shall originate only from agent-proposed, user-approved decisions.
8. After successfully registering a proposal batch, Command Center shall instruct the proposing agent to end its turn and shall deliver one complete review result covering every approved or rejected decision and any rejection feedback as the next user message, never into the in-progress proposing turn.

### Requirement 6: Decision log

**Objective:** As a user and auditor, I want an append-only log of approved decisions linked to their source and resulting charter version, so that I can audit how the charter evolved.

#### Acceptance Criteria
1. Command Center shall maintain a session-scoped, append-only decision log that contains only approved decisions.
2. Each decision-log entry shall record at least the decision statement, a timestamp, the authoring conversation/agent, a link back to the originating message, and a link to the charter version the decision produced.
3. Command Center shall not inject the decision log into conversation prompts; only the active charter shall be governing context.
4. Command Center shall present the decision log in the Alignment panel in reverse-chronological order, with each entry linking to its originating message and resulting charter version.

### Requirement 7: Alignment injection and guaranteed propagation

**Objective:** As a user, I want the active charter delivered as governing context to every conversation turn — including conversations already running — so that all agents act on the current shared understanding.

#### Acceptance Criteria
1. While a session has an active charter, Command Center shall inject it into every conversation turn in that session as governing context, stronger than passive "read when relevant" reference documents.
2. When the active charter is small enough to inline, Command Center shall inject its full content; when the active charter is larger, Command Center shall inject a digest plus a pointer to the full content.
3. When the active charter changes mid-session, Command Center shall guarantee that every subsequent conversation turn in that session — including turns in conversations whose agent was already running when the change occurred — is informed by the new active version, rather than delivering it on a best-effort basis.
4. The injected active charter shall state that it governs the session and that conflicts resolve via its stated hierarchy or active decisions.
5. Command Center shall keep passive reference documents at "read when relevant" strength and shall not elevate them to governing context.

### Requirement 8: Charter versioning, audit, and storage transparency

**Objective:** As a user, I want versioned, auditable charter history with a worktree copy, so that I can understand and trust how shared alignment changed and roll back if needed.

#### Acceptance Criteria
1. Command Center shall maintain a version history of the charter, distinguishing the active version from any pending draft.
2. Command Center shall treat application state as the source of truth for the charter (its content, version, draft/active status, timestamps, author, and approver).
3. When a charter version is activated or updated, Command Center shall materialize a human-readable copy of the active charter in the session's worktree for transparency, and shall not treat that copy as the source of truth.
4. Command Center shall record which conversation has seen which charter version, kept distinct from the decision log.
5. Command Center shall provide a per-version diff so that any charter change — including an auto-activated post-decision rewrite — can be reviewed and rolled back after the fact.

### Requirement 9: Alignment UX surfaces and discoverability

**Objective:** As a user, I want clear in-app surfaces for the charter's state, history, and exact injected content, so that alignment is discoverable and transparent.

#### Acceptance Criteria
1. Command Center shall display an Alignment indicator in the session header that shows: no alignment (an affordance to add one), an active charter with its version, a completed `/align` draft awaiting approval or approved-decision incorporation in progress, and a stale state when a conversation has not yet seen the active version.
2. Command Center shall surface the Alignment charter within the existing documents panel alongside reference documents, and shall not introduce a parallel alignment registry or subsystem.
3. The Alignment panel shall present the active charter, the current draft, the version history, last-updated metadata, and the decision log.
4. Command Center shall provide a live preview of exactly what agents receive for the active charter.
5. When the active charter changes, Command Center shall broadcast a live "alignment updated" indication to open conversations in the session.

### Requirement 10: Removal of the `objective` field

**Objective:** As a maintainer, I want the legacy `objective` field and its injection removed, so that the charter is the single session-wide alignment mechanism and optimistic sessions behave consistently.

#### Acceptance Criteria
1. Command Center shall remove the session `objective` field and shall no longer inject legacy objective content into conversation prompts.
2. When a session is created in `optimistic` mode, Command Center shall use the provided instructions as the conversation's kickoff prompt and shall not set a session-wide objective.
3. Where a session has an active charter, the charter shall fulfill the session-wide context role formerly held by `objective`.

### Requirement 11: Approval topology

**Objective:** As a user, I want exactly two kinds of human approval governing alignment changes, so that the approval model stays predictable and never activates a charter unattended.

#### Acceptance Criteria
1. Command Center shall apply exactly two human approval gate types to alignment: the "Approve Charter" gate on every completed `/align` draft (initial and reruns), and decision approval.
2. Command Center shall not gate or trigger a charter change through any mechanism other than these two gates.
3. The decision-driven auto-activation shall remain gated by a human approving the decision and shall not constitute an autonomous (unattended) activation path.
4. Command Center shall never offer an auto-activating decision-incorporation draft through the "Approve Charter" gate; the preceding decision approval is sufficient.

### Requirement 12: Scope boundaries — graph workflows and optimistic sessions

**Objective:** As a maintainer, I want alignment confined to attended normal sessions, so that it does not collide with graph-workflow charters or apply to unattended optimistic runs.

#### Acceptance Criteria
1. Command Center shall not apply the session Alignment feature to graph-workflow execution and shall not alter the existing immutable graph-workflow charter mechanism.
2. Command Center shall not provide an Alignment charter for `optimistic` sessions.
3. Command Center shall not include any auto-approval or auto-activation path for alignment that operates without a human approval; the feature shall be attended (normal-session) only.
4. When a user invokes a standalone Collaboration Mode run from a conversation in a `normal` session, Command Center shall treat that run as attended session work — one attended logical originating turn — and shall deliver the session's active charter to both collaborating agents as governing context, even though the run's internal backend calls execute with the autonomous flag set.
5. Command Center shall apply Acceptance Criterion 4 only to a user-invoked standalone Collaboration Mode run in a `normal` session; graph-workflow collaboration remains excluded under Acceptance Criterion 1, and an `optimistic` session remains excluded under Acceptance Criterion 2.
6. Command Center shall not deliver the `/align` suggestion of Requirement 2.5 to a Collaboration Mode agent lane; where such a run's session has no active charter, its agents shall receive no alignment instruction at all.
