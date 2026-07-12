# Implementation Plan

- [x] 1. Foundation: domain schemas, database floor, and ticket repository
- [x] 1.1 (P) Define the ticket domain contract as validated schemas
  - Ticket entity with title, optional markdown description, work type, status, exactly one owning project, and timestamps; work type restricted to Feature, Bug, Research, Tech debt, Performance; status restricted to Not Started, In Progress, Done, Blocked, Closed; status defaults to Not Started when unspecified
  - Attachment payloads as a discriminated union over the five kinds (file, conversation, session, related ticket, note), each attachment carrying a required non-empty description
  - Session-link, list-item, detail, list-query, request/response, typed-error, and change-event shapes; all types derived from the schemas; safeParse at external boundaries
  - Done when schema unit tests pass covering enum acceptance and rejection, the Not Started default, mixed-payload rejection, and boundary safeParse behavior
  - _Requirements: 1.2, 1.3, 1.4, 3.1, 3.2_
  - _Boundary: schemas_

- [x] 1.2 (P) Add the ticket tables to the synchronous database schema floor
  - Four additive tables (counters, tickets, attachments, session links) with CHECK constraints, unique constraints, the two partial active-unique link indexes, list-query indexes, and the projects cascade foreign key; the counter table has no project foreign key so numbers survive project delete/re-add
  - Additive only: no ordered migration and no schema-version bump; creation is idempotent on every open
  - Done when a fresh in-memory database exposes all four tables and indexes and repeated initialization succeeds without error
  - _Requirements: 1.1, 1.5, 1.6_
  - _Boundary: state DB schema floor_

- [x] 1.3 Implement the ticket repository with atomic number allocation
  - Counter increment plus ticket insert in one immediate transaction inside the global write queue; numbers monotonic per project and never reused after deletion
  - Ticket CRUD and attachment-row CRUD as validated rows; a combined create-with-conversation-attachment write; focused list/find/update/delete queries honoring the field-equality filters and created/updated sorting
  - Round-trip durability contract test over every persisted shape using the real-store fixture
  - Done when repository tests prove numbers 1, 2, 3 across create → delete → create, unique sequential numbers under concurrent queued creates, and the durability contract passes
  - _Requirements: 1.1, 1.5, 1.6, 2.1, 3.4_
  - _Depends: 1.1, 1.2_

- [x] 1.4 Implement session-link persistence with active/historical derivation
  - Link rows persist after their session disappears; at most one active link per ticket and per project + session name
  - Active vs historical derived by joining live sessions with the instance guard (session created at or before the link time) so a reused session name never resurrects an old link; focused reads for a session's linked ticket and the per-project session-link map
  - Reconciliation demotes stale links with a reason (finished, deleted, replaced) and never modifies ticket status
  - Done when tests prove the instance guard defeats session-name reuse, history survives session deletion, and reconciliation leaves status untouched
  - _Requirements: 2.3, 2.4, 4.4, 10.1_

- [x] 2. Ticket service, change events, and core HTTP API
- [x] 2.1 Implement the ticket service with identity and lifecycle semantics
  - Project names resolve to canonical paths at the boundary; identifiers format as project display name plus number (e.g. command-center#12)
  - Create applies the default status; update permits every explicit status transition; delete returns the removed identity; typed error results for unknown tickets and validation failures
  - One schema-validated ticket-changed event published after each successful mutation, carrying the lean list item (null for deletes) and flags for attachment/session changes; event failure never rolls back a committed mutation; the event type joins the SSE union
  - Structured logging under the tickets namespace — never descriptions, notes, bytes, or prompt content
  - Done when service tests cover the default status, free transitions, deletion, unknown-ticket errors, and one event per successful mutation
  - _Requirements: 1.1, 1.4, 1.7, 2.1, 8.5, 9.8_

- [x] 2.2 Expose ticket CRUD and the session-link map over REST
  - Global filtered/sorted list; project-scoped list and create; detail, update, delete by project + number; a per-project session-link map for session indicators; thin app-router shells re-exporting handlers
  - Every request boundary safeParsed; tracing and agent-token gating per existing conventions; stable error codes (400 validation, 404 unknown, 409 conflict)
  - Done when route tests exercise create/list/get/update/delete round-trips including validation failures and unknown-ticket 404s
  - _Requirements: 1.1, 1.9, 2.1, 9.1, 9.2, 10.1_

- [x] 3. Attachments: durable content store, per-kind operations, REST
- [x] 3.1 (P) Build the central ticket content store
  - Snapshots under the CC config directory keyed by generated ticket/attachment identifiers plus a sanitized basename; atomic temp-write-then-rename; resolved-path containment check before every read, write, materialize, or delete
  - Byte capture for files and text capture for compaction markdown; read, materialize-to-destination, and per-attachment, per-ticket, and per-project deletion
  - Done when a captured file remains readable after its source is deleted and crafted unsafe names cannot escape the content root
  - _Requirements: 3.3_
  - _Boundary: TicketContentStore_
  - _Depends: 1.1_

- [x] 3.2 Implement attachment operations with per-kind capture and resolution
  - Add, edit, remove in any ticket status including after start; file adds snapshot bytes before the row insert and a failed insert removes the snapshot; removal commits the row first with best-effort, lock-aware deferred blob cleanup
  - Conversation adds ensure a compaction exists and snapshot its markdown with source coordinates; session and related-ticket entries remain live pointers; notes are inline markdown
  - Resolution per kind: file metadata plus content; conversation prefers the live artifact with transcript read commands while the source exists and falls back to the snapshot explicitly labeled a retained compaction after deletion; related tickets resolve to current detail plus attachment index or a typed unavailable result
  - Done when per-kind resolution tests pass, including the deleted-source fallback and related-ticket navigation
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 5.6_
  - _Depends: 3.1_

- [x] 3.3 (P) Build the shared attachment-index renderer
  - One typed renderer produces the described index with per-entry retrieval and follow commands; bounded-entry mode truncates descriptions at a fixed budget with an explicit ellipsis; entries are never omitted; full mode renders complete descriptions
  - Later consumed unchanged by the live ticket block, the kickoff prompt, CLI text and JSON output, and reference resolution
  - Done when renderer tests cover truncation budgets, complete entry sets for every kind, and command formatting
  - _Requirements: 3.5_
  - _Boundary: attachment-index renderer_
  - _Depends: 1.1_

- [x] 3.4 Expose attachment operations over REST
  - Index list and add (multipart file uploads with a validated metadata part and streamed content; JSON for the other kinds); resolve, edit, remove by attachment id; oversized uploads rejected with 413; unavailable content yields 410
  - Done when route tests round-trip each kind and a failed file insert leaves neither a row nor a snapshot
  - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6_

- [x] 3.5 Clean up ticket content when a project is deleted (integration)
  - Explicit project deletion triggers best-effort removal of that project's ticket snapshots (the SQL cascade cannot reach the filesystem); cleanup failure logs an orphan path key and never fails the deletion
  - Done when deleting a project removes its tickets via cascade and its snapshot directory best-effort
  - _Requirements: 3.3_

- [x] 4. Agent CLI: the ticket command group
- [x] 4.1 (P) Add the ticket command group with identity resolution
  - create, list, get, update, delete registered through the help registry with related-command edges, following the three-tier output contract (read the CLI steering doc first)
  - A bare number resolves through the ambient project scope; the project#number form works from any conversation including graph-workflow lanes; unknown tickets exit 1 with an error naming the reference; usage errors exit 2 before any network call; connection/auth failures exit 3
  - Done when CLI contract tests cover both identifier forms, lane environment identity, exit codes, and help output
  - _Requirements: 1.7, 8.1, 8.2, 8.3, 8.5_
  - _Boundary: cctl ticket commands_
  - _Depends: 2.2_

- [x] 4.2 Add attachment commands with the described index in both output modes
  - attach for all five kinds with a required description; attachment get, update, remove
  - list and get always include the typed attachment index with descriptions and exact retrieval/follow commands in text and JSON output alike — bounded entries on list, full descriptions on get
  - The agent-facing CLI skill documentation gains the ticket command group and its disclosure edges
  - Done when contract tests assert the index appears in both output modes with follow commands for every kind
  - _Requirements: 3.5, 3.6, 8.1, 8.4_
  - _Depends: 3.4, 4.1_

- [x] 5. Start work: materialization, charter, orchestration, kickoff
- [x] 5.1 (P) Materialize creation-time context into the session worktree
  - File attachments and conversation compaction markdown written from the immutable start snapshot into a git-excluded ticket directory inside the new worktree; every materialized file registered as a reference document carrying the attachment's description; conversation markdown includes source-transcript read commands
  - Done when a start produces worktree files plus registered reference documents with descriptions, and materialized content matches the entry snapshot
  - _Requirements: 5.1, 5.2_
  - _Boundary: TicketMaterializer_
  - _Depends: 3.1_

- [x] 5.2 (P) Add the trusted ticket charter activation entrypoint
  - Alignment versions accept a ticket source; a programmatic create-and-activate path derives the charter from the ticket identifier, title, and description, validates the target is a normal session, and activates through the existing mirror-and-broadcast path with no HTTP bypass of the human approval flow
  - Done when a ticket-created session has an active ticket-source charter with no approval step, and the entrypoint rejects non-normal sessions
  - _Requirements: 5.3_
  - _Boundary: SessionAlignmentService_

- [x] 5.3 Implement start-work orchestration with all-or-nothing compensation
  - Keyed in-process lock serializes start and delete per ticket; a concurrent start receives a start-in-progress error; the active-link check names the live session; a stale active link on a reused session name reconciles and retries the insert once
  - Order: immutable ticket/attachment snapshot → compaction ensure/refresh and re-snapshot → provision a normal session (deterministic name from number, title slug, start ordinal) → materialize and register → activate the charter → one final link-plus-status transaction (the sole automatic transition, to In Progress)
  - Compaction failure aborts before provisioning; any post-provision failure compensates by deleting the session exactly once and leaves ticket status and links unchanged
  - Done when failure-path tests prove an active conflict provisions nothing, compensation runs exactly once, two concurrent starts yield one success plus one start-in-progress, and a restart after finish/delete preserves prior history
  - _Requirements: 2.2, 2.3, 2.4, 4.2, 4.3, 4.4, 4.7, 5.2_
  - _Depends: 5.1, 5.2_

- [x] 5.4 Dispatch the kickoff and expose start over REST and CLI (integration)
  - Agent mode queues the existing first-turn dispatcher only after the link transaction commits, with a kickoff prompt built from identifier, title, description, and the shared attachment index with retrieval commands; prepared mode runs no turn; a dispatch failure leaves a linked, usable session and is surfaced
  - Start endpoint accepting the two modes with conflict/validation/failure semantics; a start subcommand joins the CLI group
  - Done when an agent-mode start begins its first turn from the kickoff and a prepared-mode session stays idle until the user's first prompt
  - _Requirements: 4.1, 4.5, 4.6, 8.1_
  - _Depends: 3.3, 4.1_

- [x] 6. Live ticket context on every turn
- [x] 6.1 (P) Render the current ticket block for linked sessions
  - Focused session-to-ticket lookup; a deterministic block with identifier, title, status, the complete typed attachment index (entries never omitted, descriptions bounded with explicit ellipsis), and exact retrieval commands; attachment bodies never inlined; logs record counts and durations, never content
  - Done when the provider returns null for unlinked sessions and a complete block reflecting current rows for linked ones
  - _Requirements: 5.4, 5.6_
  - _Boundary: LiveTicketContext_
  - _Depends: 1.4, 3.3_

- [x] 6.2 Inject the ticket block into each turn's effective prompt (integration)
  - The block is rebuilt and prepended to the transient effective prompt on every turn of a linked session — never baked into session instructions or the persistent runtime
  - Done when a mid-session attachment addition appears in the next turn's effective prompt without runtime recreation
  - _Requirements: 5.4, 5.5_

- [x] 7. Ticket references across conversations
- [x] 7.1 (P) Establish the ticket reference contract and parsing
  - A canonical self-closing XML reference carrying project name, number, identifier, title, and an embedded globally-valid read command — never paths, snapshot keys, or content; a copy-reference control places it on the clipboard
  - The reference parser and segmenter recognize ticket references outside fenced code, validate required attributes, and leave malformed tags as plain text
  - Done when round-trip tests cover build → parse → segment, the fenced-code exemption, and malformed-tag passthrough
  - _Requirements: 6.1, 6.4_
  - _Boundary: ticket references, ref parser_
  - _Depends: 1.1_

- [x] 7.2 Round-trip ticket chips in the prompt editor
  - Pasting reference XML among text renders an atom chip (identifier plus truncated title, matching the conversation-chip recipe with a ticket glyph); serialization emits canonical XML only for atoms still present; removing the chip excludes the reference from the outgoing prompt
  - Done when editor tests paste XML among text, remove the chip, and prove the sent prompt excludes the removed reference
  - _Requirements: 6.2, 6.3_
  - _Depends: 7.1_

- [x] 7.3 (P) Render sent ticket references as navigable chips
  - Transcript-side chip without a remove control, with hover affordance and navigation to the ticket detail route
  - Done when a sent message containing a ticket reference renders a chip that navigates to the correct detail view
  - _Requirements: 6.2, 6.4_
  - _Boundary: transcript ref rendering_
  - _Depends: 7.1_

- [x] 8. Slash-command ticket creation
- [x] 8.1 (P) Create tickets from conversation context via the ticket command
  - Command recognized with optional hint text; ineligible scopes reuse the existing rejection-notice path; graph-workflow lanes do not expose the command
  - An awaited structured task-run turn — resuming the conversation's native context, with bounded transcript/compaction rendering as the fallback when no backend reference exists — produces title, description, and work type validated against the schema
  - Server code then ensures and snapshots the originating conversation's compaction and creates the ticket plus the auto-attached conversation in one transaction; a deterministic success notice reports the identifier; any generation, validation, compaction, or transaction failure appends a reason notice and persists nothing
  - Done when a command round-trip creates the ticket with its auto-attachment and success notice, and injected failures leave no rows behind
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - _Boundary: TicketCommandAdapter_
  - _Depends: 2.1, 3.2_

- [x] 8.2 Advertise the ticket command in the slash popup
  - The command appears as an autocomplete option with a command badge in eligible session and project conversations
  - Done when typing the slash prefix in an eligible conversation lists the ticket command with its badge
  - _Requirements: 7.1_

- [x] 9. Client data layer and live updates
- [x] 9.1 (P) Build ticket queries and optimistic mutations over one shared filter/order module
  - A client-safe module defines the list filters and ordering used by queries, optimistic updates, and the event reducer alike; query keys embed every filter and sort input; queries cover global and project lists, detail, and the session-link map
  - Mutations for create, field/status updates, delete, attachment add/edit/remove, and start apply optimistically or show visible pending per the responsiveness contract, roll back on failure with retry affordances, and keep settlement hygiene invalidation
  - Done when mutation tests prove optimistic apply plus rollback and list ordering matches the shared module
  - _Requirements: 1.9, 9.7_
  - _Boundary: TicketClientData_
  - _Depends: 2.2, 3.4, 5.4_

- [x] 9.2 Reduce ticket change events into query caches
  - A pure idempotent reducer removes the ticket identity from every cached list, then re-inserts and re-sorts the lean item only where the query's filters match; deletion events remove everywhere; data absent from the event uses exact invalidation only — one detail key on attachment change, one session-link key when a session is named
  - Events validate against the schema in the notification listener; the reducer never fights an in-flight optimistic move
  - Done when reducer property tests over created/updated/deleted/attachments/session deltas are idempotent against filtered, sorted caches
  - _Requirements: 1.9, 9.8_
  - _Depends: 9.1_

- [x] 10. Ticket UI
- [x] 10.1 (P) Extend shared visual primitives for tickets
  - The type badge map gains research (violet), tech debt (amber), and performance (green) appearances; the theme gains the two ticket animation keyframes (drag-commit wash, SSE-enter fade) as tokens; no new global stylesheet
  - Done when Storybook shows all five work-type badges and the keyframes are available as theme animation tokens
  - _Requirements: 9.2, 9.3, 9.6_
  - _Boundary: ui primitives, theme tokens_

- [x] 10.2 Build the global tickets route with list view and filters
  - Global tickets destination in the top bar; List/Board segmented control with URL state; project/type/status/sort selects plus clear-filters with an n-of-m count; list rows per the handoff grid — status rail, mono id, title, type badge, status, attachment-count CTX column (tertiary at zero), session, updated, kebab menu (Open / Copy reference / Delete…)
  - Opening tickets from a project page pre-filters to that project
  - This task owns the page shell; the Board tab renders an empty placeholder until the board task wires in
  - Done when Storybook and component tests cover filtering, sorting, empty state, and the pre-filtered project entry
  - _Requirements: 1.7, 9.1, 9.2, 9.5_
  - _Depends: 9.1, 10.1_

- [x] 10.3 Build the Kanban board with drag and keyboard movement
  - The pinned dnd-kit core package is added as the single new dependency
  - Five status columns as wells with header dot, uppercase mono label, and count pill; cards with mono id, clamped title, type badge, attachment count, and active-session dot; the card kebab carries the Move-to radio group as the guaranteed non-drag status path
  - Drag per the handoff: pickup lift with ghost slot, target-column highlight with count preview and drop bar, commit wash; status-only keyboard protocol (Space/Enter pickup, Left/Right status change, Space/Enter commit, Esc cancel; Up/Down ignored because no intra-column order is persisted) with aria-live status announcements; mobile becomes the status pager with visible Move-to
  - Dropping commits an optimistic status mutation reconciled by the reducer; the board replaces the page shell's Board-tab placeholder (the only Board-tab edit after 10.2)
  - Done when stories cover columns, empty columns, long titles, and keyboard status movement, and drag-to-column changes status optimistically with rollback plus toast on failure
  - _Requirements: 9.3, 9.4, 9.7_

- [x] 10.4 (P) Build the ticket detail page
  - Header with identity, status pill, type badge, and actions (Copy reference, Start work, Delete behind a confirmation dialog) over the main-plus-rail layout; click-to-edit title with saving tail and failure restore; description textarea with markdown rendering; status and type selects permitting free transitions; session history (active and ended) in the rail; deletion removes the ticket and leaves the view
  - Mobile keeps all header actions per the handoff
  - Done when stories cover historical sessions and delete confirmation, and a title-edit failure restores the previous value with inline retry
  - _Requirements: 1.7, 1.8, 1.9, 2.1, 6.1, 9.6, 9.7_
  - _Boundary: TicketDetailPage_
  - _Depends: 7.1, 9.1, 10.1_

- [x] 10.5 Build attachment management UI on the detail page
  - Index entries lead with the description over kind icon tile, kind chip, mono metadata, and View/Edit/Remove actions; expand-in-place preview; related-ticket entries navigate to the referenced ticket
  - The add dialog offers the kind picker and per-kind forms with a required description (submit disabled while empty); file uploads show in-entry progress and leave no phantom entry on failure (Retry/Discard)
  - Done when each kind can be added, edited, and removed from the dossier in any ticket status and a failed file attach leaves no entry
  - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 9.6, 9.7_
  - _Depends: 10.4_

- [x] 10.6 Build the create and start dialogs
  - Create: project and work-type selects (pre-filled from project entry; type defaults to Feature), required title, optional markdown description; validation on submit; pending locks inputs with Cancel enabled; failure preserves input and persists nothing; success reports the identifier and nudges adding context
  - Start: agent/prepared radio choice with a provisioning pending state; the active-session conflict surfaces before the dialog as an alert naming the session; success closes with status In Progress and the session visible as active
  - CreateTicketDialog mounts behind a New-ticket trigger on the global and project-prefiltered ticket views; StartTicketDialog mounts behind the detail header's Start action
  - Done when stories cover validation, pending, failure-preserves-input, and success for create, and the start conflict path names the active session
  - _Requirements: 1.1, 1.4, 4.1, 4.3, 9.7_
  - _Depends: 10.2, 10.4_

- [x] 10.7 (P) Show ticket indicators on session surfaces
  - Session rows and the session info strip display the ticket identifier as a pill/chip for active and historical links with distinct treatments; activation navigates to the ticket detail view; data comes from the per-project session-link map
  - Done when a ticket-started session shows the indicator on the session list and info strip and clicking lands on the ticket's detail view
  - _Requirements: 10.1, 10.2_
  - _Boundary: SessionTicketIndicator_
  - _Depends: 9.1_

- [x] 11. End-to-end validation
- [x] 11.1 Verify ticket lifecycle and attachment journeys end to end
  - Create globally → edit → filter/sort → drag across the board → delete only after confirmation, with the deletion disappearing from open views
  - Every attachment kind added, edited, and removed while In Progress, including durable snapshot retrieval after source-file deletion and navigation through a related-ticket attachment
  - Done when each path passes against the live app with backend state confirmed (rows, snapshots, counter behavior)
  - _Requirements: 1.8, 1.9, 3.3, 3.4, 3.6, 9.4_

- [x] 11.2 Verify start-work journeys end to end
  - Prepared start runs no turn, materializes references, activates the ticket charter, and accepts the user's first prompt; agent start begins from the kickoff; a second start is blocked naming the active session; restart after finish shows both history entries
  - A post-start attachment addition appears in the next turn's live ticket index
  - Done when both modes pass against the live app with worktree files, reference documents, charter, links, and transcripts confirmed
  - _Requirements: 2.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.5_

- [x] 11.3 Verify reference, slash-command, and CLI journeys end to end
  - Copy reference → paste and remove chip → paste and send → resolve the ticket from a conversation in another project
  - Slash-command creation from a conversation: derived fields, compaction auto-attachment, success notice; failure path creates nothing
  - Full CLI lifecycle (create through delete, attachments, start) from a graph-workflow lane conversation
  - Done when each journey passes against the live app with transcripts and rows confirmed
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5, 8.3_

- [x] 11.4 (P) Verify visual parity, mobile, and accessibility
  - Implemented surfaces reviewed against the prototype bundle at desktop and mobile breakpoints; axe plus real keyboard passes over board movement, the status-select fallback, dialogs, attachment controls, chips, and focus restoration
  - Done when parity review and accessibility passes are recorded with no blocking findings
  - _Requirements: 9.3, 9.4, 9.6_
  - _Boundary: verification only (read-only review)_

- [x] 11.5 (P) Verify query plans, event sizes, and concurrency
  - List queries verified with EXPLAIN QUERY PLAN over representative multi-project counts; the per-turn linked-ticket lookup stays a focused query set; mutation bursts emit small events without broad invalidation; concurrent start yields one success and concurrent creates yield unique sequential numbers; snapshot transfers never hold the write queue
  - Done when the checks are recorded with the durable patterns confirmed (or an entry added to the performance log if a fix was needed)
  - _Requirements: 1.5, 4.3, 9.8_
  - _Boundary: verification only (read-only checks)_

## Implementation Notes

- 3.5: importing `@/lib/tickets/service-factory` into `sessions/service.ts` widened the module graph of every test importing the sessions service — `vi.mock("@/lib/logging")` fakes must include `withTracing` (it runs at module load in traced route-handler modules), or unrelated suites fail to collect.
- 4.2: `CliHost` gained `readFileBytes` and `FetchInit.rawBody` (binary multipart bodies) — every injected CLI test-host fake must implement `readFileBytes`; new fakes should copy an existing `makeHost` rather than hand-rolling the interface.
- 4.2 (validation remediation): list/get/index responses failing schema parse exit 1 with code `invalid_response` — never render a ticket without its attachment index; every attach/attachment command strictly rejects extra positionals (exit 2 pre-network). New ticket CLI subcommands (e.g. 5.4 start) should follow both patterns.
- 5.4: `ticketErrorResponse` maps `context_preparation_failed` to 422 everywhere (design §Error Handling: Content) — this covers attachment-add compaction failures too, not just start; only `session_provision_failed` is a 500. New dispatchable CLI subcommands must also be added to the `COVERAGE` list in `help-registry.contract.test.ts` or the registry-coverage gate silently skips them.
- 7.1: `formatTicketIdentifier` / `buildTicketReadCommand` live in `src/lib/tickets/references.ts` — service-layer identity formatting (task 2.x) should import these, not re-derive `project#n`. `ticketRefAttrsSchema` lives in `src/lib/tickets/schemas.ts` (design's "sole source of reference types"), imported by `ref-segments.ts`. MessageTextWithRefs + ref-paste-extension carry minimal raw-text fallbacks for `ticket-ref` segments; 7.2/7.3 replace them with chips.
- 7.2/7.3: chips landed — `TicketMentionNode` (`src/lib/prompt-editor/ticket-mention-node.ts`) + `TicketMentionChip`, and read-side `TicketRefLinkChip` via the `createMessageTextWithRefs` DI seam. `ticketDetailHref` lives in `src/lib/tickets/hrefs.ts` — UI tasks (9.x, 10.x) must build `/tickets/[projectName]/[number]` links through it, not by hand.
- 10.3: dnd-kit trap — spreading `useDraggable` listeners on a container with interactive children lets Enter/Space bubbling from inner links start a keyboard drag (KeyboardSensor skips its target check when no activator node is registered); guard `onKeyDown` with `event.target !== event.currentTarget`.
- 11.4: three axe/keyboard fixes — (a) board cards were `role=button` with focusable children (links + kebab) → axe nested-interactive; moved the keyboard drag activator to a dedicated handle button (`setActivatorNodeRef`) so the card root stays non-interactive (pointer drag still works from the whole body). (b) a committed move remounts the card, dropping focus to `<body>`; the board now refocuses the moved card's drag handle via a `pendingFocusRef` + `useEffect([items])`. (c) state-opened Radix dialogs (no `DialogTrigger`) can't restore focus on close — added the reusable `useOpenerFocus` hook (`src/hooks/use-opener-focus.ts`) wired into ConfirmDialog + all three ticket dialogs; the Start button uses `aria-busy` not `disabled` so it survives as the focus-return target across the pre-dialog liveness check. The empty global `.tooltip-portal` (aria-tooltip-name) is a pre-existing shared-primitive artifact on every page, out of ticket scope.
- 11.1: `projects` rows are persisted lazily — only the sessions aggregate created them, so the first ticket of a discovered-but-never-written project hit the tickets FK. `createTicketTx` now runs `ensureProjectStmt` (INSERT … ON CONFLICT DO NOTHING) first; repo-level tests that pre-seed `projects` rows mask this class of FK gap, so cover the never-persisted path explicitly.
- 10.3 (validation remediation): the shared toast store/`Toast` accept an optional `action` (`pushToast(msg, { action })`, longer TTL) — the design's optimistic contract requires Retry on status-move failure toasts and outranks tasks.md's plainer "rollback plus toast" wording. Board movement is status-only because v1 has no persisted intra-column order: the keyboard coordinate getter accepts Left/Right only, and live-region messages announce statuses rather than fictional positions.
- 10.4: the Claude Design handoff bundle (memory-bank/prototypes/ticket-system-prototype/) is absent from this worktree — design.md's UI bullets (~§614/624) govern the detail dossier. `formatRelativeTime` moved to `src/features/tickets/format-relative-time.ts` (shared by list + detail); `Button`'s base gained `justify-center`, which only affects stretched (`flex-1`/full-width) buttons. The attachment section renders header-only as the 10.5 seam; Start work is an unwired button until 10.6 mounts StartTicketDialog behind it.
- 10.5: `resolvedAttachmentSchema` in `src/lib/tickets/schemas.ts` is now the canonical resolve-endpoint shape (`ResolvedAttachment` derives from it; attachment-service imports the type). It is a plain z.union, not a discriminatedUnion — related_ticket has two arms sharing the kind discriminator. The CLI keeps its own deliberately-loose boundary schema. `parseTicketIdentifier` (references.ts) is the tested inverse of `formatTicketIdentifier` — related-ticket UI links must go through it + `ticketDetailHref`. File uploads render indeterminate Progress (fetch-based mutations expose no byte progress); failed uploads live only in AttachmentIndex local state so a phantom entry is structurally impossible.
- 10.7: `SessionTicketIndicator` (src/components/) owns the `useTicketSessionLinksQuery` lookup itself — surfaces mount it with just projectName/sessionName; per-row calls dedupe on the shared query key. Because session rows now issue this read query on mount, tests that assert "no fetch before <action>" must scope the assertion to the mutating endpoint (SessionsPanel.test.tsx bulk-archive scopes to `/sessions/bulk`).
- 10.6 (validation remediation): the detail view's pre-dialog start-conflict decision must NOT gate on raw link rows (`endedAt === null`) — demotion is reconciliation-driven and only runs on the next start request, so a stale un-ended row would block the very request that reconciles it. `TicketDetailView` derives the active session from the liveness-aware per-project session-link map (`useTicketSessionLinksQuery`, instance-guarded `active`); raw rows are only a placeholder while the map loads, and a map error defers to the server's 409 backstop surfaced inside the start dialog. The Start button exposes `data-start-conflict` as the observable state marker tests wait on.
- 10.6 (validation remediation 2): a loaded map is not permanently authoritative either — session lifecycle paths never invalidate `ticketKeys.sessionLinks` and focus refetching is globally off, so a map cached `active: true` before the session ended would keep blocking restart while the view stays mounted (or across a remount within staleTime). The Start click therefore refetches the map and judges the conflict from the fresh result (`data-start-conflict` reflects only cached knowledge; the click never trusts it); a refetch failure again defers to the server's 409 rather than judging from the stale cache. The button shows a Spinner and disables while resolving. `StartAfterCachedActiveSessionEnds` pins the cached-active → session-ended transition via a fetch-index-aware session-links mock.
