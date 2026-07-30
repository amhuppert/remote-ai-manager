# Implementation Plan

## Task 1 — Foundation: consolidate creation modes & remove `objective`

- [x] 1.1 Consolidate session creation-mode and conversation schemas
  - Reduce the creation-mode enum to exactly `normal` and `optimistic`, defaulting to `normal`; remove `focus`.
  - Remove the `objective` field from session state; add a nullable per-conversation seen-version field for stale detection.
  - Rewrite the create-session request contract to a `normal`/`optimistic` discriminated union (no `focus` variant); `optimistic` carries instructions.
  - Update existing characterization tests that asserted `focus` validity or `fast` as default so they pin the new enum/default and fail before the change, pass after.
  - Observable: the schema module exports `normal`/`optimistic` only, has no `objective` field, and its tests are green pinning the new contract.
  - _Requirements: 1.1, 1.2, 1.3, 1.6, 10.1_

- [x] 1.2 Rework the session creation service for two modes
  - Rename the fast-creation path to the normal path; delete the focus-creation path, its placeholder focus-memory write, and the `initialization` conversation role.
  - Stop persisting `objective`; `optimistic` instructions flow to the conversation kickoff prompt instead of a session-wide objective.
  - Update/retire focus-mode and objective service tests; add a test that an optimistic session stores no session-wide objective and seeds its kickoff prompt.
  - Observable: creating a normal session writes no focus-memory file and no objective; creating an optimistic session produces a kickoff prompt with no stored objective.
  - _Depends: 1.1_
  - _Requirements: 1.3, 10.2, 10.3_

- [x] 1.3 Update creation API and chat-spawning for two modes
  - Dispatch only `normal`/`optimistic` in the creation route; reject any other mode (e.g. `focus`) with a client error.
  - Remove the objective mapping from chat-spawning so proposed sessions use the two-mode contract.
  - Add a test asserting an unsupported creation mode is rejected with an error.
  - Observable: a creation request with mode `focus` returns a 4xx error; spawning a session never sets an objective.
  - _Depends: 1.1_
  - _Requirements: 1.6, 1.7, 10.2_

- [x] 1.4 Update session persistence for the mode/objective changes
  - Drop `objective` from session row serialization/binding; change the creation-mode default to `normal` in both the schema floor and the repo.
  - Keep the nullable physical `objective` column in place but unwritten (forward/backward-compatible; no schema-version bump).
  - Update the session round-trip durability contract to reflect the removed objective. (The new conversation seen-version column and its serialization/contract are added later in 2.3/2.4, once that column exists.)
  - Observable: a session round-trips through the real store with no objective persisted and `creation_mode` defaulting to `normal`; the durability contract suite is green.
  - _Depends: 1.1_
  - _Requirements: 10.1, 1.3_

- [x] 1.5 (P) Update creation-mode UI surfaces
  - Present exactly two creation tabs (`normal`, `optimistic`) in the create-session modal, defaulting to `normal`; remove the focus tab and objective field.
  - Remove the `focus` badge/label from the session mode indicator and session row; relabel the fast indicator as normal.
  - Update modal/badge tests to assert no `focus` affordance is rendered.
  - Observable: the create-session modal renders only `normal`/`optimistic`, and no session badge or label shows `focus`.
  - _Depends: 1.1_
  - _Boundary: CreateSessionModal, ModeDot, SessionRow_
  - _Requirements: 1.1, 1.2, 1.6_

- [x] 1.6 Add the idempotent creation-mode data migration
  - Add an ordered migration mapping persisted `creation_mode` values `fast` and `focus` to `normal`, changing no other session data.
  - Add a migration test proving re-running it produces the same result and leaves non-mode fields untouched.
  - Observable: after migration, no session row has creation mode `fast` or `focus`; running it twice yields identical state.
  - _Depends: 1.4_
  - _Requirements: 1.4, 1.5_

## Task 2 — Foundation: Alignment domain skeleton (schemas, rendering, storage)

- [x] 2.1 Define alignment domain schemas and contracts
  - Define schemas for charter versions (status `draft`/`active`/`superseded`, source, hash, auto-activate, linked decisions), approved decisions, transient decision proposals, the aggregate alignment state, the REST request/response payloads, and the `alignment-updated` SSE event payload.
  - Add the `alignment-updated` event to the SSE event union as a typed contract.
  - Observable: the domain exports Zod-derived types for versions, decisions, proposals, and aggregate state, and the SSE union accepts an `alignment-updated` event.
  - _Requirements: 8.1, 8.2, 6.1, 9.5_

- [x] 2.2 Implement free-text charter rendering and hashing
  - Implement the governing-context injection renderer that inlines small charters in full and emits a bounded digest plus a read-the-full-file pointer above a size threshold, including the "this governs the session; conflicts resolve via its hierarchy/active decisions" language.
  - Implement a deterministic content hash over normalized free-text content, and the soft-scaffold template (Mission, Decisions, Constraints, Non-goals, Known ambiguities, Relevant sources).
  - TDD: tests for inline-vs-digest at the threshold boundary, governing preamble presence, hash stability across whitespace normalization, and scaffold section coverage.
  - Observable: rendering a short charter returns full inline content; rendering a long charter returns a digest plus pointer; identical content yields an identical hash.
  - _Depends: 2.1_
  - _Boundary: Alignment render_
  - _Requirements: 3.2, 7.1, 7.2, 7.4_

- [x] 2.3 Add alignment storage to the schema floor
  - Add the version-history, approved-decision-log, and transient-proposal tables (session-scoped, cascade on session delete) plus supporting indexes to the synchronous schema floor.
  - Add the per-conversation seen-version column via the additive-column path.
  - Observable: a fresh in-memory database opens with all three alignment tables and the conversation seen-version column present.
  - _Depends: 2.1_
  - _Requirements: 8.1, 8.4, 6.1_

- [x] 2.4 Implement the alignment repository with a durability contract
  - Implement durable persistence for versions, decisions, and proposals, plus reading/writing a conversation's seen-version (now that its column exists), enforcing the append-only nature of the decision log at the repo boundary.
  - Add a schema-driven round-trip durability contract covering all three tables (including nullable version/produced-version/activated-at and the JSON linked-decisions field), and extend the conversation durability contract to cover the seen-version field.
  - Observable: maximal fixtures for versions/decisions/proposals round-trip through the real store with no dropped fields, the conversation seen-version round-trips, and the contract suite is green.
  - _Depends: 2.1, 2.3_
  - _Boundary: Alignment repo_
  - _Requirements: 8.1, 8.2, 6.1, 8.4_

## Task 3 — Core: SessionAlignmentService governing semantics

- [x] 3.1 (P) Implement the worktree charter mirror
  - Provide a standalone writer that materializes a human-readable copy of an active charter in the session worktree and registers it through the reference-documents registry for discovery — taking content/paths as inputs, never treating the copy as the source of truth, and never rewriting per turn.
  - TDD: writing materializes the file and registers the reference document; repairing a missing copy restores it; a write failure surfaces without corrupting inputs.
  - Observable: invoking the writer with charter content produces the worktree copy and a reference-document entry pointing to it; deleting the copy and repairing restores it.
  - _Depends: 2.1_
  - _Boundary: Alignment mirror writer_
  - _Requirements: 8.3, 9.2_

- [x] 3.2 Implement charter draft lifecycle and activation
  - Implement beginning a draft (scaffold for a first charter, the existing charter for a redraft), filling a draft from agent content, approving a filled non-auto `/align` draft (activate as a new version, supersede the prior active, assign the next version number, materialize the mirror), and rejecting that draft (discard, leave active unchanged).
  - Enforce that a session is always in exactly one of two alignment states (no active charter, or one active charter), that at most one draft exists per session, that a draft is never treated as governing, and that activation is the only state change that broadcasts the alignment-updated event.
  - TDD against the real-store fixture: approval activates, supersedes, and writes the mirror; rejection leaves the active charter unchanged; an unapproved draft is neither the active version nor injected.
  - Observable: approving a filled draft yields exactly one active version with an incremented version number, materializes the mirror, and emits an alignment-updated event; rejecting it leaves the prior active version governing.
  - _Depends: 2.2, 2.4, 3.1_
  - _Boundary: SessionAlignmentService_
  - _Requirements: 2.1, 3.2, 3.4, 3.5, 4.2, 4.3, 4.4, 4.5, 8.1, 8.3, 11.1_

- [x] 3.3 Implement decision proposal and approval evolution
  - Implement persisting a durable bulk proposal batch without logging it, resolving a batch per-decision (approve or reject with optional feedback), appending only approved decisions to the log, creating an auto-activating draft linked to the approved decisions, and routing one complete review-result message back into the originating conversation.
  - On the agent's subsequent charter fill for an auto-activate draft, activate without a separate gate and stamp each approved decision with the version it produced; ensure no charter change is triggered by any path other than charter approval and decision approval.
  - Route the atomic review-result message to the next turn so approval cannot interrupt the proposing turn, and never expose the linked auto draft through the manual charter gate.
  - TDD: only approved decisions are logged; rejected proposals change nothing; resolution creates a linked auto draft and the subsequent fill activates it; mixed and all-rejected batches each use one atomic next-turn review result.
  - Observable: approving decisions appends them to the log and, after the incorporation fill, produces a linked active version with no separate charter approval; every rejected decision appears in the same next-turn review result, with its feedback when provided, and leaves the charter unchanged.
  - _Depends: 3.2_
  - _Boundary: SessionAlignmentService_
  - _Requirements: 5.1, 5.3, 5.4, 5.5, 5.6, 5.8, 6.1, 6.2, 11.2, 11.3, 11.4_

- [x] 3.4 Implement read accessors, diff, and rollback
  - Implement the aggregate-state read (active, draft, history, reverse-chronological decision log, pending proposals, live injection preview), the cheap active-version accessor used by the per-turn gate, the active-injection accessor, a per-version diff, and rollback (a new active version cloned from a prior version's content).
  - TDD: diff reports content changes between versions; rollback produces a new active version equal in content to the chosen prior version and reviewable afterward.
  - Observable: the state read returns the decision log newest-first and a preview equal to what would be injected; rollback to version K yields a new active version whose content matches K.
  - _Depends: 3.2_
  - _Boundary: SessionAlignmentService_
  - _Requirements: 6.3, 6.4, 8.2, 8.5, 9.4_

## Task 4 — Core: agent entry points (`/align` and `cctl`)

- [x] 4.1 Implement agent-facing alignment CLI routes
  - Provide `cctl charter write` (fills the open draft, deferring draft-vs-activate to service state) and asynchronous `cctl decisions propose` (persists a durable pending batch, returns a load-bearing end-turn instruction, and delivers the complete review result on the next turn).
  - Restrict both authenticated routes to attended normal-session conversations — excluded from project conversations and autonomous turns — and ensure decision-log entries can originate only from these agent-proposed, user-approved decisions (no manual decision-capture path).
  - TDD: charter write fills the open draft; decision proposal stores a pending batch and returns a load-bearing instruction to end the turn; both commands refuse an optimistic/autonomous turn.
  - Observable: `cctl decisions propose` persists a reviewable pending batch and directs the agent to end the turn; an autonomous session cannot invoke either write path.
  - _Depends: 3.2, 3.3_
  - _Boundary: Alignment CLI and agent routes_
  - _Requirements: 3.6, 5.1, 5.5, 5.7, 5.8, 12.2, 12.3_

- [x] 4.2 Implement the `/align` slash command
  - Recognize `/align` in the same command family as commit/merge; route it to begin a draft (scaffold on first run, existing charter on rerun) and enqueue an authoring turn, without archiving the conversation — available at any point in the session's life and independent of how the session was created.
  - Add `/align` to the prompt-editor command suggestions.
  - TDD: first-run `/align` enqueues a scaffold-based authoring turn; rerun `/align` enqueues an existing-charter authoring turn and does not overwrite the active charter or archive the conversation; `/align` is accepted regardless of creation mode at any lifecycle point.
  - Observable: running `/align` produces a pending draft and an authoring turn while the active charter (if any) keeps governing and the conversation stays unarchived.
  - _Depends: 3.2_
  - _Boundary: conversation-commands, SessionAlignmentService_
  - _Requirements: 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5_

## Task 5 — Core/Integration: charter injection & guaranteed propagation

- [x] 5.1 (P) Track the alignment version on backend runtimes
  - Add an alignment-version field to the tracked metadata of both the Claude and Codex conversation runtimes, set when the runtime is created, exposed for comparison — without changing per-turn send/build logic.
  - Observable: a freshly created runtime of either backend reports the alignment version baked into its instructions.
  - _Boundary: agent-backends_
  - _Requirements: 7.3_

- [x] 5.2 Inject the active charter into the per-turn prompt seam
  - Replace the legacy objective injection with the active-charter governing section (inline or digest) sourced through injected service accessors, and add a single instruction nudging the agent to suggest `/align` when no active charter exists — gated to normal sessions, excluded from project/optimistic/autonomous turns, with passive reference docs left at "read when relevant".
  - TDD: a session with an active charter injects its governing section into every conversation's turn; a session without one injects the suggestion instruction; reference docs are not elevated.
  - Observable: the assembled per-turn instructions contain the charter governing section when active (in every conversation of the session) and the `/align` suggestion when absent, and never the removed objective tag.
  - _Depends: 2.2, 3.4_
  - _Boundary: actor-implementations_
  - _Requirements: 2.4, 2.5, 7.1, 7.2, 7.4, 7.5, 10.1, 12.1_

- [x] 5.3 Guarantee propagation via version-gated runtime recreation
  - Read the active alignment version cheaply before the per-turn recreate gate, recreate the runtime when its baked version differs from the active version (in addition to the existing model/effort/output-format triggers), stamp the new runtime with the active version, and record the version each conversation turn ran with for stale detection.
  - TDD on the recreate predicate: returns recreate-needed when the alignment version changed and not when unchanged.
  - Observable: after the active charter advances, the next turn in an already-running conversation recreates the runtime and records the new seen-version.
  - _Depends: 5.1, 5.2, 3.4_
  - _Boundary: actor-implementations_
  - _Requirements: 7.3, 8.4_

## Task 6 — Integration: REST API, client data, and live updates

- [x] 6.1 Implement the alignment REST API
  - Expose endpoints to read the aggregate alignment state (including the live injection preview), approve/reject a filled non-auto `/align` draft, resolve a decision-proposal batch (per-decision approve/reject-with-feedback), fetch a per-version diff, and roll back to a prior version — each backed by the service and validated against the domain schemas, with router shells re-exporting the handlers.
  - TDD: each endpoint validates input and returns the expected state transition; approve activates a manual draft, resolve returns counts and opens the linked auto draft, its later fill activates, and reject leaves state unchanged.
  - Observable: approving a filled non-auto `/align` draft via the API returns the newly active version; resolving an approval returns counts and creates an auto-activating draft whose later fill activates it; invalid bodies and forbidden manual resolutions are rejected.
  - _Depends: 3.2, 3.3, 3.4_
  - _Boundary: Alignment route-handlers_
  - _Requirements: 4.1, 4.2, 5.2, 6.4, 8.5, 9.4_

- [x] 6.2 (P) Wire client data access and live invalidation
  - Add query/mutation/key factories for alignment state, charter approve/reject, decision resolve, diff, and rollback, and invalidate the alignment query on receipt of the alignment-updated SSE event so open session views stay current.
  - Observable: approving/resolving from the client updates cached alignment state, and an alignment-updated event refreshes it without a manual reload.
  - _Depends: 6.1_
  - _Boundary: Alignment client (queries/mutations/keys), SSE invalidation_
  - _Requirements: 9.5_

## Task 7 — Integration: Alignment UI surfaces

- [x] 7.1 (P) Build the session-header alignment indicator
  - Add a header chip showing the four states: no alignment (an affordance to add one), active with version, a completed `/align` draft awaiting approval or approved-decision incorporation in progress, and stale when a conversation has not seen the active version; use the "Alignment" label.
  - Observable: the chip reflects each state from live alignment data, showing the active version number and a stale indicator when applicable.
  - _Depends: 6.2_
  - _Boundary: AlignmentChip_
  - _Requirements: 9.1, 2.6_

- [x] 7.2 (P) Build the alignment panel in the documents surface
  - Add a panel within the existing documents surface presenting the active charter, the current draft, the version history with per-version diff/rollback controls, last-updated metadata, the reverse-chronological decision log (each entry linking to its originating message and resulting version), and a live preview of exactly what agents receive — without introducing a parallel registry.
  - Observable: the panel renders active/draft/history/decision-log/preview from live data, and decision-log rows link to their source message and produced version.
  - _Depends: 6.2_
  - _Boundary: AlignmentPanel_
  - _Requirements: 9.2, 9.3, 9.4, 6.4_

- [x] 7.3 (P) Build the approve-charter and decision-approval components
  - Build the "Approve Charter" banner (approve/reject a filled non-auto `/align` draft) and the bulk decision-approval component (one explicit Approve/Reject selection per decision plus an optional rejection note, reusing the existing question/option/note UI shape) backed by durable proposal state.
  - Observable: the banner approves/rejects a filled non-auto `/align` draft and the decision component submits per-decision approvals and reject-with-feedback against the API.
  - _Depends: 6.2_
  - _Boundary: ApproveCharterBanner, DecisionApprovalPanel_
  - _Requirements: 4.1, 5.2_

- [x] 7.4 Wire alignment gates into the conversation panel
  - Surface the approve-charter banner when a filled non-auto `/align` draft is pending and the decision-approval component when a proposal batch is pending, replacing the retired focus-confirmation wiring.
  - Observable: a filled non-auto `/align` draft shows the approval banner and a pending proposal batch shows the decision-approval UI within the conversation.
  - _Depends: 7.3, 6.2_
  - _Boundary: ConversationPanel_
  - _Requirements: 4.1, 5.2, 9.1_

## Task 8 — Validation

- [x] 8.1 Prove guaranteed propagation to live runtimes
  - Add the load-bearing regression test: with an alive runtime, advance the active charter, run the next turn in the same conversation, and assert the runtime is recreated and its rebuilt instructions carry the new charter — covering both the Claude and Codex runtime types and confirming conversation continuity is preserved across recreation.
  - Observable: the test fails on a first-turn-only/baked-once injection and passes once version-gated recreation delivers the new charter to an already-running runtime of each backend.
  - _Depends: 5.3_
  - _Requirements: 7.3_

- [x] 8.2 Verify the `/align` authoring and approval flow end-to-end
  - Add an integration test covering first-run scaffold drafting, rerun rewrite from the existing charter, the draft remaining non-governing until approval, the conversation not being archived, and approval activating a new version.
  - Observable: the test confirms a first-run draft uses the scaffold, a rerun uses the prior charter, the active charter is unchanged until approval, and approval activates and supersedes.
  - _Depends: 5.3, 6.1_
  - _Requirements: 3.2, 3.4, 3.5, 4.2, 4.3, 4.5_

- [x] 8.3 Verify the decision evolution flow end-to-end
  - Add an integration test through the real store and prompt queue covering propose → end turn → resolve → one complete next-turn review result → auto-activation with decision linkage, no manual approval banner, and an emitted alignment-updated event, plus all-rejected and mixed review batches leaving rejected decisions out of the charter and log.
  - Observable: the test confirms an approved decision is delivered on the next turn, auto-activates a linked version with no second gate, and is logged; a rejected one changes nothing; an alignment-updated event is broadcast.
  - _Depends: 5.3, 6.1_
  - _Requirements: 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 9.5_

- [x] 8.4 Verify creation-mode and alignment UI paths
  - Add UI tests asserting the create-session modal exposes only `normal`/`optimistic`, that approving a charter updates the header chip to the active version, and that the decision-approval component handles explicit, exclusive bulk Approve/Reject selections and rejection notes.
  - Observable: the modal shows no `focus`, the chip transitions to "active vN" after approval, and the decision component round-trips accessible bulk approvals/rejections.
  - _Depends: 7.4, 1.5_
  - _Requirements: 1.1, 1.2, 9.1, 5.2_

- [x] 8.5 Run the full regression sweep
  - Run the complete unit/integration suite, typecheck, and lint, resolving any regressions from the mode/objective removal and the new domain.
  - Observable: the full test suite, typecheck, and lint pass on the branch with no `focus`/`objective` references remaining in active code paths.
  - _Depends: 8.1, 8.2, 8.3, 8.4_
  - _Requirements: 1.6, 10.1_
