> Codex (agent_two) design draft for the ticket-system spec, extracted at collaboration finalization from memory-bank/collaboration/24cc5b2a-8427-4564-806e-b095adb20819/round-0/agent_two/initial_draft/main.md. Superseded, together with design.agent_one.md, by the canonical design.md.

# Design Document

## Overview

The Ticket System gives Command Center users and agents a durable, project-owned context bundle for work that is not ready to start. A ticket combines a small lifecycle model with described attachments, stable cross-conversation references, and a start-work operation that provisions a normal session with its initial context materialized.

The design adds a ticket domain without moving ownership from existing subsystems. Ticket persistence, attachment snapshots, session-link history, ticket references, and orchestration belong to the new domain. Worktree provisioning, conversation compaction, Alignment charters, reference-document registration, prompt execution, and session lifecycle remain owned by their existing modules and are invoked through narrow contracts.

The implementation is phased by boundary: ticket aggregate and API first; attachments and agent CLI second; session start and live context third; references, slash command, and UI integration last. Each phase is independently testable while preserving one final domain model.

### Goals

- Persist project-scoped tickets with monotonic, never-reused display numbers.
- Make five described attachment types available as a progressive-disclosure index.
- Provision a ready normal session in either immediate-agent or prepared mode.
- Materialize creation-time file and conversation context while exposing current ticket state on every later turn.
- Make tickets resolvable from any conversation through XML references and cctl.
- Provide UI, CLI, slash-command, SSE, and session-indicator surfaces over one authoritative service.

### Non-Goals

- Priority, labels, assignees, blocked-reason fields, comments, or an activity timeline.
- Graph-workflow launch from a ticket.
- First-class URL, git-ref, or code-location attachment variants.
- Repository-backed ticket files, export, or bidirectional synchronization with external ticket systems.
- Automatic status changes on merge, finish, delete, or any event other than successful start-work linking.
- Changes to session merge, finish, delete, worktree, compaction, Alignment, or reference-document ownership.

## Boundary Commitments

### This Spec Owns

- The Ticket aggregate: identity, project ownership, fields, status, timestamps, per-project counter, attachments, and linked-session history.
- The authoritative SQLite tables and focused repository used by ticket operations.
- Durable central snapshots for file attachments and cleanup of those snapshots.
- Ticket start orchestration, including active-session gating, context preparation, compensation, ticket linking, and the sole automatic status transition.
- The current per-turn ticket block for ticket-linked sessions.
- The ticket XML reference contract and its prompt-editor chip representation.
- Ticket REST endpoints, cctl ticket commands, slash-command creation, SSE change events, and ticket UI.
- Ticket-to-session indicator lookup. Session persistence itself is not extended with ticket fields.

### Out of Boundary

- Session provisioning internals, branch naming rules, worktree initialization, and session deletion behavior.
- Conversation transcript ownership and compaction generation.
- Alignment version storage and general approval behavior; this spec adds only a trusted programmatic activation entrypoint for ticket-created sessions.
- Reference-document storage and content endpoints.
- Agent backend selection, runtime lifecycle, and first-turn execution semantics.
- Session lifecycle automation. Ticket status never follows merge, finish, or deletion.
- External authorization, multi-user assignment, or permission policy.

### Allowed Dependencies

- Ticket schemas may depend only on Zod and cross-domain shared primitives.
- Ticket repositories may depend on better-sqlite3, the shared state DB, the global state write queue, parsing helpers, and structured logging.
- Ticket services may depend on ticket repositories plus existing project resolution, session provisioning, compaction, Alignment, reference-document, prompt-dispatch, config-directory, and SSE contracts.
- Route handlers and cctl may depend on ticket services and the existing agent-auth, tracing, fetch, error-envelope, and help-registry conventions.
- UI may depend on ticket query hooks, existing ui primitives, Tiptap extension points, and the two approved dnd-kit packages.
- Existing session and conversation core persistence must not import the ticket domain. Presentation surfaces may consume ticket-owned link queries.

### Revalidation Triggers

- Any change to Ticket, TicketAttachment, TicketSessionLink, ticket-ref, or ticket SSE schemas.
- Any move of ticket/session-link authority into SessionState or another domain.
- Changes to provisionSession rollback guarantees, compaction completion contracts, Alignment activation, reference-document registration, or first-turn dispatch.
- A multi-process server deployment that invalidates the current in-process keyed ticket-operation lock.
- Changes to project identity or display-name resolution that affect project#number references.
- Changes to prompt runtime construction that prevent per-turn transient context injection.
- Replacement or major-version upgrades of dnd-kit, Tiptap, TanStack Query, Zod, SQLite, or Next.js.

## Architecture

### Existing Architecture Analysis

- Durable application state lives in command-center.db and structural table floors are created synchronously in src/lib/state-store/state-db.ts. Focused repositories validate rows at the persistence boundary.
- Session provisioning is centralized in src/lib/sessions/service.ts and already compensates state, worktree, and branch creation failures.
- Conversation compaction exposes a coalescing trigger with an awaitable completion promise and a current-coverage check.
- Alignment owns active-charter versioning and per-runtime governing injection.
- Reference documents are session-scoped records pointing to files inside the worktree.
- Prompt runtimes bake session instructions at creation, so a changing ticket index cannot be added there. The turn actor already has a transient effective-prompt path suitable for a per-turn block.
- Reference parsing, paste conversion, Tiptap atom nodes, serialization, transcript rendering, and embedded cctl commands are already extensible by reference type.
- The global SSE bus carries small typed change notifications while TanStack Query owns bulk ticket data.
- cctl command metadata, flags, help, related edges, and parsing behavior are derived from the typed help registry.

### Architecture Pattern and Boundary Map

The selected pattern is a new domain aggregate with orchestration adapters. It preserves current domain ownership and avoids adding ticket fields or attachment arrays to SessionState or ManagerState.

~~~mermaid
graph TB
    TicketUi[Ticket UI] --> TicketApi[Ticket API]
    TicketCli[cctl ticket] --> TicketApi
    TicketCommand[Ticket slash command] --> TicketService[Ticket service]
    TicketRef[Ticket reference chip] --> TicketCli
    TicketApi --> TicketService
    TicketService --> TicketRepo[Ticket repository]
    TicketService --> AttachmentService[Attachment service]
    TicketService --> StartService[Start service]
    AttachmentService --> ContentStore[Ticket content store]
    StartService --> SessionService[Session service]
    StartService --> CompactionService[Compaction service]
    StartService --> AlignmentService[Alignment service]
    StartService --> Materializer[Ticket materializer]
    Materializer --> ReferenceDocs[Reference documents]
    LiveContext[Live ticket context] --> TicketRepo
    PromptRuntime[Prompt turn runtime] --> LiveContext
    TicketRepo --> StateDb[SQLite state]
    ContentStore --> ConfigStore[Config content directory]
    TicketService --> TicketEvents[Ticket SSE events]
    TicketEvents --> TicketUi
~~~

**Dependency direction**: Schemas → persistence and content storage → domain services → route, command, runtime, and event adapters → UI and CLI. Imports may only move to the right. Existing services are outbound ports of TicketStartService; they never import ticket modules.

**Key decisions**

- Build a sibling ticket content store instead of generalizing the workflow shared-document store. Their retention keys and cleanup lifecycles differ, and a shared abstraction would have one implementation with incompatible ownership.
- Keep session links ticket-side without a foreign key to sessions. A deleted session must remain in ticket history.
- Derive active-session state by left-joining a link to the current sessions table: an existing unfinished session is active; a missing or finished session is historical.
- Serialize every mutation for one ticket with a keyed in-process operation lock, while all SQLite writes still pass through the global write queue. Short CRUD operations hold the lock briefly; start-work holds it across preparation and compensation.
- Use the current conversation actor for /ticket structured generation. This gives the authoring turn the accumulated runtime context in both session and project conversations.
- Adopt @dnd-kit/core 6.3.1 and @dnd-kit/sortable 10.0.0. They support React 19 through their peer ranges and provide pointer and keyboard sensors; native HTML drag-and-drop does not provide equivalent touch and keyboard behavior.

### Technology Stack

| Layer | Choice / Version | Role in Feature | Notes |
|---|---|---|---|
| Frontend | Next.js 16.1, React 19.2, Tiptap 3.22 | Ticket routes, prompt reference chips, session indicators | Thin app shells; feature UI in src/features |
| Client data | TanStack Query 5.90 | Lists, details, mutations, optimistic cache updates | SSE patches or narrowly invalidates |
| Board interaction | @dnd-kit/core 6.3.1, @dnd-kit/sortable 10.0.0 | Pointer, touch, and keyboard Kanban movement | New runtime dependencies |
| Backend | TypeScript strict, Zod 4.3 | Contracts, validation, discriminated unions | No any or duplicate handwritten schema types |
| Data | better-sqlite3 12.6, WAL SQLite | Tickets, counters, attachments, links | Four additive tables in command-center.db |
| Content | Node file APIs in the CC config directory | Durable attachment snapshots | Atomic temporary write and rename |
| Messaging | Existing typed global SSE bus | Lightweight ticket changes | No ticket-specific EventSource |
| Agent runtime | Existing session, compaction, Alignment, reference-doc, and first-turn services | Start-work composition and live context | No new orchestrator |

## File Structure Plan

### New Files

~~~text
src/
├── lib/
│   ├── state-store/
│   │   ├── tickets-repo.ts
│   │   └── tickets-repo.contract.test.ts
│   └── tickets/
│       ├── schemas.ts
│       ├── service.ts
│       ├── service-factory.ts
│       ├── attachment-service.ts
│       ├── content-store.ts
│       ├── start-service.ts
│       ├── operation-lock.ts
│       ├── materializer.ts
│       ├── live-context.ts
│       ├── references.ts
│       ├── route-handlers.ts
│       ├── attachment-route-handlers.ts
│       ├── start-route-handlers.ts
│       ├── session-link-route-handlers.ts
│       ├── query-keys.ts
│       ├── queries.ts
│       ├── mutations.ts
│       ├── sse-cache.ts
│       └── *.test.ts
├── app/
│   ├── tickets/
│   │   ├── page.tsx
│   │   └── [projectName]/[number]/page.tsx
│   └── api/
│       ├── tickets/route.ts
│       └── projects/[name]/tickets/
│           ├── route.ts
│           ├── session-links/route.ts
│           └── [number]/
│               ├── route.ts
│               ├── start/route.ts
│               └── attachments/
│                   ├── route.ts
│                   └── [attachmentId]/route.ts
├── features/
│   └── tickets/
│       ├── TicketsPage.tsx
│       ├── TicketDetailPage.tsx
│       ├── components/
│       │   ├── TicketFilters.tsx
│       │   ├── TicketList.tsx
│       │   ├── TicketBoard.tsx
│       │   ├── TicketCard.tsx
│       │   ├── TicketEditor.tsx
│       │   ├── AttachmentIndex.tsx
│       │   ├── AttachmentDialog.tsx
│       │   ├── StartTicketDialog.tsx
│       │   └── CopyTicketReferenceButton.tsx
│       └── stories/
│           ├── TicketBoard.stories.tsx
│           └── TicketDetailPage.stories.tsx
├── cli/commands/
│   ├── ticket.ts
│   ├── ticket.help.ts
│   └── ticket.test.ts
└── lib/prompt-editor/
    └── ticket-mention-node.ts

src/features/session/conversation/
├── TicketMentionChip.tsx
└── TicketMentionChip.stories.tsx
~~~

**Responsibilities**

- tickets-repo.ts owns codecs and atomic focused SQL operations across ticket counters, tickets, attachments, and session links.
- schemas.ts is the only source of ticket domain, request, response, event, and reference types.
- service.ts owns ticket CRUD, identity formatting, filters, and status semantics.
- attachment-service.ts owns typed attachment validation, edit/remove/read resolution, and snapshot compensation.
- content-store.ts owns safe central paths, atomic byte capture, reads, and best-effort cleanup.
- start-service.ts owns the start-work state machine and compensation.
- operation-lock.ts serializes update, attachment, start, and delete operations for one ticket within the supported single-process runtime; project-scoped create allocation is serialized by the state write queue.
- materializer.ts writes initial context to the worktree and registers reference documents.
- live-context.ts performs the focused session-to-ticket lookup and renders the current per-turn block.
- references.ts builds and validates canonical ticket-ref XML.
- route handler files map HTTP, auth, tracing, Zod issues, and typed domain errors without owning business rules.
- query files own hierarchical keys, query options, optimistic mutations, and SSE cache reconciliation.
- TicketBoard and TicketCard own board interaction; all field editing remains in TicketEditor.
- The stories cover empty, populated, long-content, active-session, failed-start, and narrow-viewport states before route integration.

### Modified Files

- package.json and bun.lock — add the two pinned dnd-kit dependencies.
- src/lib/state-store/state-db.ts — create the four ticket tables and indexes in the synchronous schema floor.
- src/lib/api/sse-events.ts — add TicketChangedEvent to SSEEvent.
- src/components/NotificationListener.tsx — validate ticket events and call the ticket cache reconciliation helper.
- src/lib/session-alignment/schemas.ts — add ticket as an AlignmentVersionSource.
- src/lib/session-alignment/service.ts and service-factory.ts — add a trusted create-and-activate charter method used only after ticket session provisioning.
- src/lib/workflows/conversation/actor-implementations.ts — request and prepend the live ticket block for each session turn.
- src/lib/conversations/ref-parser.ts, ref-segments.ts, and schemas.ts — recognize and validate ticket-ref.
- src/lib/prompt-editor/ref-paste-extension.ts, serializer.ts, and index.ts — paste, render, remove, and serialize ticket mention atoms.
- src/features/session/prompt/PromptEditor.tsx — register TicketMentionNode.
- src/features/session/conversation/MessageTextWithRefs.tsx — render sent ticket refs as navigable chips.
- src/lib/conversation-commands/parse.ts, schemas.ts, generation.ts, service.ts, and dispatch.ts — recognize /ticket, generate structured fields in the same conversation, compact the source, create atomically, and append a result notice.
- src/features/session/prompt/PromptEditorSlashCommandPopup.tsx — advertise /ticket at session and project scope.
- src/cli/core.ts and src/cli/help-registry.ts — register cctl ticket and its help graph.
- plugins/command-center/command-center/skills/cc-cli/SKILL.md — document the ticket command group and progressive-disclosure edges.
- src/components/Topbar.tsx — add the global Tickets destination and active state.
- src/features/project-detail/ProjectDetailView.tsx — add the project-prefiltered Tickets entry.
- src/features/project-detail/components/SessionRow.tsx — render the ticket indicator from the ticket link query.
- src/features/session/conversation/SessionInfoStrip.tsx — render the linked ticket identifier and detail navigation.

No new stylesheet is created. New UI uses Tailwind v4 utilities, static variant maps, data attributes, cn, and existing Button, IconButton, Badge, Tabs, Select, Dialog, AlertDialog, RadioGroup, FormField, and EmptyState primitives.

## System Flows

### Start Work

~~~mermaid
sequenceDiagram
    participant Caller
    participant Start as TicketStartService
    participant Repo as TicketRepository
    participant Compact as CompactionService
    participant Session as SessionService
    participant Material as TicketMaterializer
    participant Align as AlignmentService
    participant Prompt as FirstTurnDispatcher

    Caller->>Start: start ticket and mode
    Start->>Start: acquire ticket lock
    Start->>Repo: load ticket and derive active session
    alt active session exists
        Repo-->>Start: active session
        Start-->>Caller: conflict with session name
    else no active session
        Start->>Compact: ensure current conversation artifacts
        Compact-->>Start: completed artifacts
        Start->>Session: provision normal session
        Session-->>Start: prepared session
        Start->>Material: write files and conversation summaries
        Material-->>Start: references registered
        Start->>Align: create and activate ticket charter
        Align-->>Start: active charter
        Start->>Repo: link session and set In Progress
        Repo-->>Start: committed ticket
        opt immediate agent mode
            Start->>Prompt: queue kickoff prompt
        end
        Start-->>Caller: ticket session and queue state
    end
~~~

The compaction step precedes session creation, so a compaction failure cannot create an orphan session. Any failure after provisioning but before the ticket-link transaction invokes deleteSession as compensation. The ticket remains unchanged until the final link-and-status transaction. If first-turn dispatch later fails, the session remains linked and prepared; the failure is logged and surfaced while the user can send the first prompt manually.

### Slash-Command Creation

~~~mermaid
sequenceDiagram
    participant User
    participant Command as ConversationCommandService
    participant Actor as ConversationActor
    participant Compact as CompactionService
    participant Ticket as TicketService
    participant Transcript

    User->>Command: ticket with optional hint
    Command->>Transcript: append command message
    Command->>Actor: structured ticket authoring turn
    Actor-->>Command: title description type attachment description
    Command->>Compact: compact originating conversation
    Compact-->>Command: current artifact
    Command->>Ticket: create ticket and conversation attachment
    Ticket-->>Command: project number identifier
    Command->>Transcript: append success notice
~~~

Generation or compaction failure appends a failure notice and performs no ticket transaction. Ticket creation and the originating-conversation attachment share one SQLite transaction.

### Live Ticket Context

For every session turn, the actor requests a focused ticket lookup by project path and session name. A linked ticket produces a transient block containing identifier, title, status, the complete typed attachment index, and exact cctl retrieval commands. The block is prepended to that turn's effective prompt and is not stored in the backend runtime. Attachment changes therefore appear on the next turn without runtime recreation or manual refresh. Attachment contents are never inlined.

## Requirements Traceability

| Requirement | Summary | Components | Interfaces and Flows |
|---|---|---|---|
| 1.1, 1.2, 1.3, 1.4 | Core fields and enums | Ticket schemas, TicketService, TicketRepository | CreateTicketInput, ticket create API |
| 1.5, 1.6 | Project number allocation and non-reuse | TicketRepository | Counter transaction |
| 1.7, 1.8, 1.9 | Identifier display and deletion | Ticket UI, TicketService, SSE cache | AlertDialog, DELETE ticket, ticket-changed |
| 2.1, 2.2, 2.3, 2.4 | Free status movement and sole start automation | TicketService, TicketStartService | updateStatus, start flow |
| 3.1, 3.2, 3.3 | Typed described attachments and snapshots | Ticket schemas, AttachmentService, ContentStore | addAttachment, multipart file capture |
| 3.4, 3.5, 3.6 | Mutable index, retrieval, related navigation | AttachmentService, Ticket UI, cctl ticket | attachment APIs, related ticket links |
| 4.1, 4.2, 4.3 | Two start modes, link, active conflict | TicketStartService, TicketRepository | StartTicketInput, start flow |
| 4.4, 4.5, 4.6, 4.7 | Restart history, kickoff, prepared mode, rollback | TicketStartService, FirstTurnDispatcher | start response and compensation |
| 5.1, 5.2, 5.3 | File and conversation materialization, charter | TicketMaterializer, CompactionService, AlignmentService | materialize, activateTicketCharter |
| 5.4, 5.5, 5.6 | Current per-turn index and on-demand content | LiveTicketContext, AttachmentService, cctl ticket | live turn flow, attachment resolution |
| 6.1, 6.2, 6.3, 6.4 | Copy, paste chip, removal, global resolution | TicketReferenceAdapter, PromptEditor, cctl ticket | ticket-ref XML |
| 7.1, 7.2, 7.3, 7.4, 7.5 | Slash creation from accumulated context | TicketCommandAdapter, Actor, CompactionService, TicketService | slash flow |
| 8.1, 8.2, 8.3, 8.4, 8.5 | CLI parity, scope resolution, index, errors | TicketCli, TicketApi | cctl ticket command group |
| 9.1, 9.2, 9.3, 9.4 | Global list and Kanban | Ticket UI, TicketClientData | list queries, board status mutation |
| 9.5, 9.6, 9.7, 9.8 | Project entry, detail, responsiveness, live updates | Ticket UI, optimistic mutations, Ticket events | project filter, detail route, SSE |
| 10.1, 10.2 | Session ticket indicators and navigation | SessionTicketIndicator, session-link query | session rows and info strip |

## Components and Interfaces

| Component | Domain / Layer | Intent | Requirements | Key dependencies | Contracts |
|---|---|---|---|---|---|
| TicketRepository | Data | Persist and query the ticket aggregate atomically | 1.1–1.6, 2.1–2.4, 3.1–3.6, 4.2–4.4 | SQLite P0, write queue P0 | Service, State |
| TicketService | Domain | Enforce CRUD, identity, filters, and lifecycle rules | 1.1–2.4, 8.1–8.5, 9.1–9.8 | Repository P0, events P1 | Service, API, Event |
| TicketAttachmentService | Domain | Capture, mutate, resolve, and remove attachments | 3.1–3.6, 5.1, 5.2, 5.6 | Repository P0, content store P0 | Service, API |
| TicketContentStore | Infrastructure | Preserve file bytes outside worktrees | 3.3, 5.1 | Config directory P0, file system P0 | Service |
| TicketStartService | Orchestration | Provision a ticket session with failure compensation | 2.2–2.4, 4.1–5.3 | Session, compaction, Alignment, materializer P0 | Service, API |
| TicketMaterializer | Integration | Write creation-time artifacts and register references | 5.1, 5.2 | Content, compaction, reference docs P0 | Service |
| LiveTicketContext | Runtime | Render current ticket state on every turn | 5.4–5.6 | Repository P0, prompt actor P0 | Service |
| TicketReferenceAdapter | Conversation UI | Round-trip ticket-ref as text and chips | 6.1–6.4 | Tiptap P0, cctl P1 | State |
| TicketCommandAdapter | Conversation command | Create from accumulated conversation context | 7.1–7.5 | Actor P0, compaction P0, TicketService P0 | Service |
| TicketApi | HTTP | Expose typed UI and agent operations | 1.1–10.2 | Ticket services P0, agent auth P0 | API |
| TicketClientData | Client data | Query, optimistically mutate, and reconcile SSE | 9.1–9.8, 10.1 | TanStack Query P0, SSE P0 | State, Event |
| TicketUi | Feature UI | List, board, detail, attachments, and start | 1.7–1.9, 3.4–4.1, 6.1, 9.1–9.8 | UI primitives P0, dnd-kit P1 | State |
| SessionTicketIndicator | Presentation | Show ticket identity on linked sessions | 10.1, 10.2 | session-link query P0 | State |

### Ticket Repository

**Responsibilities and constraints**

- Allocate a number and insert its ticket in one immediate SQLite transaction.
- Never decrement or delete ticket_counters.
- Store attachments as validated discriminated payload JSON.
- Preserve ticket-session links after session rows disappear.
- Join session links to sessions only to derive active versus historical state.
- Expose focused reads for per-turn context and session-indicator maps.

**Dependencies**

- Inbound: Ticket services — aggregate operations, P0.
- Outbound: command-center.db and global write queue — serialized durability, P0.
- External: better-sqlite3 — transactions and prepared statements, P0.

**Contracts**: Service checked; State checked.

~~~typescript
interface TicketRepository {
  create(input: PersistTicketInput): Promise<Ticket>;
  createWithConversationAttachment(
    input: PersistTicketInput,
    attachment: PersistAttachmentInput,
  ): Promise<TicketDetail>;
  list(query: TicketListQuery): Promise<TicketListItem[]>;
  find(projectPath: string, number: number): Promise<TicketDetail | null>;
  update(input: UpdateTicketInput): Promise<TicketDetail | null>;
  delete(projectPath: string, number: number): Promise<DeletedTicket | null>;
  addAttachment(input: PersistAttachmentInput): Promise<TicketAttachment>;
  updateAttachment(input: UpdateAttachmentInput): Promise<TicketAttachment | null>;
  deleteAttachment(input: AttachmentIdentity): Promise<TicketAttachment | null>;
  findLinkedTicket(projectPath: string, sessionName: string): Promise<TicketDetail | null>;
  listSessionLinks(projectPath: string): Promise<Record<string, TicketLinkSummary>>;
  linkStartedSession(input: LinkStartedSessionInput): Promise<TicketDetail>;
}
~~~

The public repository methods enter the global write queue. Multi-row writes use one synchronous immediate transaction after the queue is acquired.

### Ticket Service

**Responsibilities and constraints**

- Resolve project names to canonical paths at API boundaries.
- Format identifiers from the current project display name and ticket number.
- Permit every explicit status transition.
- Publish one schema-validated TicketChangedEvent only after a successful mutation.
- Keep events best-effort: event failure never rolls back state.

**Contracts**: Service checked; API checked; Event checked.

~~~typescript
type TicketError =
  | { code: "ticket_not_found"; identifier: string }
  | { code: "validation_failed"; issues: ValidationIssue[] }
  | { code: "active_session"; sessionName: string }
  | { code: "start_in_progress"; identifier: string }
  | { code: "content_unavailable"; attachmentId: string; reason: string }
  | { code: "context_preparation_failed"; reason: string }
  | { code: "session_provision_failed"; reason: string };

type TicketResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TicketError };

interface TicketService {
  create(input: CreateTicketInput): Promise<TicketResult<TicketDetail>>;
  list(input: TicketListQuery): Promise<TicketResult<TicketListItem[]>>;
  get(identity: TicketIdentity): Promise<TicketResult<TicketDetail>>;
  update(input: UpdateTicketInput): Promise<TicketResult<TicketDetail>>;
  delete(identity: TicketIdentity): Promise<TicketResult<DeletedTicket>>;
}
~~~

### Attachment Service and Content Store

File creation accepts multipart form data with a Zod-validated metadata part and a streamed file part. Other variants use JSON. The content store writes to a temporary path beneath the config directory and atomically renames it to:

~~~text
ticket-content/<ticket-uuid>/<attachment-uuid>/<sanitized-file-name>
~~~

The path uses only generated UUID segments plus a sanitized basename. A resolved-path containment check runs before every read, write, materialize, or delete.

~~~typescript
interface TicketContentStore {
  capture(input: CaptureTicketFileInput): Promise<FileSnapshot>;
  read(snapshotKey: string): Promise<Uint8Array>;
  materialize(snapshotKey: string, destination: string): Promise<void>;
  delete(snapshotKey: string): Promise<void>;
  deleteTicket(ticketId: string): Promise<void>;
}

interface TicketAttachmentService {
  add(input: AddTicketAttachmentInput): Promise<TicketResult<TicketAttachment>>;
  update(input: UpdateTicketAttachmentInput): Promise<TicketResult<TicketAttachment>>;
  remove(input: AttachmentIdentity): Promise<TicketResult<DeletedAttachment>>;
  resolve(input: ResolveAttachmentInput): Promise<TicketResult<ResolvedAttachment>>;
}
~~~

For file add, snapshot creation precedes the DB insert; a failed insert removes the snapshot. Delete commits DB removal first and performs best-effort content cleanup, leaving at worst an unreachable orphan rather than a broken DB reference. Ticket deletion captures snapshot keys before the cascading transaction and cleans them afterward.

Resolved attachments are discriminated:

- File: metadata plus UTF-8 text or base64 bytes.
- Note: full markdown.
- Conversation: current compaction when present plus exact compaction and windowed transcript read commands.
- Session: session metadata, conversation index, and read commands.
- Related ticket: current ticket detail and attachment index, or a typed unavailable result if deleted.

### Ticket Start Service

**Responsibilities and constraints**

- Hold the keyed ticket operation lock across eligibility, preparation, provisioning, materialization, charter activation, and final link.
- Require all field, attachment, and delete mutations to acquire the same key so the attachment snapshot and final status write cannot race another mutation.
- Snapshot the attachment set under that lock.
- Ensure attached conversations have current completed compactions before provisioning.
- Use a deterministic unique session name based on ticket number, title slug, and start ordinal.
- Create only normal sessions.
- Set In Progress and insert the session link in one final transaction.
- Never update status in response to later session lifecycle events.

~~~typescript
type TicketStartMode = "agent" | "prepared";

interface StartTicketInput {
  identity: TicketIdentity;
  mode: TicketStartMode;
}

interface StartTicketOutput {
  ticket: TicketDetail;
  sessionName: string;
  conversationId: string;
  initialPromptQueued: boolean;
}

interface TicketStartService {
  start(input: StartTicketInput): Promise<TicketResult<StartTicketOutput>>;
}
~~~

The kickoff prompt contains identifier, title, description, the full attachment summary index, and the same retrieval commands used by the live block. Prepared mode calls no prompt function. Immediate mode queues the existing first-turn dispatcher only after the link transaction commits.

### Materializer and Alignment Contract

Creation-time materialized paths are stable and ignored by git:

~~~text
.cc/tickets/<project-number>/
├── files/<attachment-id>-<file-name>
└── conversations/<attachment-id>-<conversation-id>.md
~~~

Every materialized file is registered as a reference document with the attachment description. Conversation markdown is rendered from the current compaction envelope and includes commands for reading the source transcript. Materialized files remain creation-time snapshots; the live block and cctl ticket are authoritative after later ticket edits.

Alignment gains one explicit trusted method:

~~~typescript
interface SessionAlignmentService {
  createAndActivateTicketCharter(input: {
    projectPath: string;
    sessionName: string;
    ticketIdentifier: string;
    title: string;
    description: string;
  }): Promise<AlignmentVersion>;
}
~~~

The method validates a normal session, creates a source=ticket version, activates it in the existing transaction, mirrors it, and broadcasts through the current activation path. It does not expose an HTTP bypass of the human /align approval flow.

### Live Ticket Context

~~~typescript
interface LiveTicketContextProvider {
  getForSession(
    projectPath: string,
    sessionName: string,
  ): Promise<string | null>;
}
~~~

The rendered block is deterministic and read-only:

~~~text
<active-ticket>
identifier: command-center#12
title: Add durable ticket context
status: In Progress
attachments:
- att-1 file — API contract — cctl ticket attachment get command-center#12 att-1
- att-2 conversation — Original design discussion — cctl conversation compaction get conv-2
refresh: cctl ticket get command-center#12
</active-ticket>
~~~

The full attachment index is included, but attachment bodies are not. Structured logging records the ticket identifier, attachment count, rendered character count, and lookup duration without logging descriptions or content.

### Ticket Reference Contract

The canonical wire form is:

~~~xml
<ticket-ref project-name="command-center" ticket-number="12" identifier="command-center#12" title="Add durable ticket context" read-command="cctl ticket get command-center#12" />
~~~

The parser ignores fenced code, validates all required attributes, and leaves malformed tags as plain text. The Tiptap atom stores the validated attributes, displays identifier plus a truncated title, serializes back to canonical attribute order, and disappears from the outgoing prompt when the chip is deleted.

### HTTP API

| Method | Endpoint | Purpose | Success | Errors |
|---|---|---|---|---|
| GET | /api/tickets | Global filtered and sorted list | TicketListItem array | 400 |
| GET, POST | /api/projects/:name/tickets | Project list or create | List or TicketDetail | 400, 404 |
| GET, PATCH, DELETE | /api/projects/:name/tickets/:number | Detail, field update, delete | TicketDetail or deleted identity | 400, 404, 409 |
| GET, POST | /api/projects/:name/tickets/:number/attachments | Index or add | Attachment array or attachment | 400, 404, 413 |
| GET, PATCH, DELETE | /api/projects/:name/tickets/:number/attachments/:id | Resolve, edit, remove | Resolved or changed attachment | 400, 404, 409 |
| POST | /api/projects/:name/tickets/:number/start | Start in agent or prepared mode | StartTicketOutput | 404, 409, 422, 500 |
| GET | /api/projects/:name/tickets/session-links | Session indicator map | Record by session name | 404 |

Mutation routes are traced, Zod-safeParsed, and token-gated when invoked through cctl. Errors use the existing ApiError shape with a stable code and structured issues.

### Event Contract

~~~typescript
interface TicketChangedEvent {
  type: "ticket-changed";
  change: "created" | "updated" | "deleted";
  projectName: string;
  ticketNumber: number;
  ticket: TicketListItem | null;
  attachmentIndexChanged: boolean;
  linkedSessionName?: string;
}
~~~

Created and updated events carry a small list item; deleted carries null. The client patcher is idempotent, applies current filters and sort order, removes deleted tickets, invalidates only the exact detail when its attachment index changed, and updates the project session-link map when linkedSessionName is present.

### CLI Contract

The cctl ticket group contains:

- create, list, get, update, delete
- attach file, attach conversation, attach session, attach ticket, attach note
- attachment get, attachment update, attachment remove
- start with --mode agent or --mode prepared

In project scope, a bare number resolves through CC_PROJECT. Outside that scope, the accepted public form is project#number. Unknown tickets exit 1 with ticket_not_found; missing flags and malformed identifiers exit 2 before a network call; connection/auth failures exit 3.

List and get always print the typed attachment index. Each entry carries the exact next command for retrieving content or following an edge. The JSON output retains error, code, issues, reminders, and hint fields according to the three-tier CLI contract.

### UI and Interaction

TicketsPage uses a compact topbar destination, a Tabs or SegmentedControl view switch, Select-based project/type/status filters, and creation/update sorting. List and board reuse TicketCard metadata and Badge primitives.

TicketBoard has five named columns. Pointer and touch drag use dnd-kit sensors; KeyboardSensor uses sortable keyboard coordinates and announces pickup, target status, commit, and cancel. Every card also exposes an explicit status Select, so status is operable without drag. A move updates board and list caches optimistically, rolls back on failure, and reconciles with SSE.

TicketDetailPage supports field editing, markdown description, the typed attachment index, session history, Copy ticket reference, Start work, and Delete ticket. Delete uses AlertDialog with title “Delete ticket?” and consequence text. Start uses Dialog plus RadioGroup for “Start agent” and “Prepare session”; the confirmation button exposes a visible pending state.

All new UI is utility-first and mono except rendered markdown prose. Actions remain visible on touch and keyboard. Focus uses the canonical cyan treatment. Board columns collapse to a single horizontally navigable or stacked status sequence at the max-768 breakpoint without removing controls or attachment metadata.

## Data Models

### Domain Model

~~~mermaid
erDiagram
    PROJECT ||--o{ TICKET : owns
    TICKET ||--o{ ATTACHMENT : contains
    TICKET ||--o{ SESSION_LINK : records
    TICKET_COUNTER ||--|| PROJECT : allocates
~~~

**Ticket invariants**

- Exactly one canonical project path and positive project-local number.
- Work type is Feature, Bug, Research, Tech debt, or Performance.
- Status is Not Started, In Progress, Done, Blocked, or Closed.
- Default status is Not Started.
- Explicit updates permit every status pair.
- Only start-work writes In Progress automatically.

**Attachment invariants**

- Every attachment has a non-empty authored description.
- Payload kind is exactly one of file, conversation, session, related_ticket, or note.
- A file payload references an existing central snapshot when inserted.
- Editing may change description and note markdown; replacing file bytes is remove plus add.

**Session-link invariants**

- A session links to at most one ticket.
- A ticket may have many historical links.
- At most one linked session can currently resolve to an existing unfinished session.
- Session deletion does not delete the history row.

### Logical Data Model

~~~typescript
const ticketAttachmentPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    fileName: z.string(),
    snapshotKey: z.string(),
    mediaType: z.string().nullable(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string(),
  }),
  z.object({
    kind: z.literal("conversation"),
    projectPath: z.string(),
    sessionName: z.string().nullable(),
    conversationId: z.string(),
  }),
  z.object({
    kind: z.literal("session"),
    projectPath: z.string(),
    sessionName: z.string(),
  }),
  z.object({
    kind: z.literal("related_ticket"),
    ticketId: z.string(),
    identifierSnapshot: z.string(),
  }),
  z.object({
    kind: z.literal("note"),
    markdown: z.string(),
  }),
]);
~~~

Types are derived with z.infer. TicketDetail includes attachments and session history; TicketListItem excludes bodies and carries attachmentCount plus activeSessionName.

### Physical Data Model

~~~sql
CREATE TABLE ticket_counters (
  project_path TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL CHECK (last_number >= 0)
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  ticket_number INTEGER NOT NULL CHECK (ticket_number > 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  work_type TEXT NOT NULL CHECK (work_type IN (
    'feature', 'bug', 'research', 'tech_debt', 'performance'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'not_started', 'in_progress', 'done', 'blocked', 'closed'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_path, ticket_number),
  UNIQUE (id, project_path),
  FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE
);

CREATE TABLE ticket_attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  description TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE TABLE ticket_sessions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  session_name TEXT NOT NULL,
  start_mode TEXT NOT NULL CHECK (start_mode IN ('agent', 'prepared')),
  linked_at TEXT NOT NULL,
  UNIQUE (project_path, session_name),
  FOREIGN KEY (ticket_id, project_path)
    REFERENCES tickets(id, project_path) ON DELETE CASCADE
);
~~~

Indexes:

- tickets by project_path, updated_at descending.
- tickets by status, updated_at descending.
- tickets by project_path, status, work_type, updated_at descending.
- ticket_attachments by ticket_id, created_at.
- ticket_sessions by ticket_id, linked_at and unique project_path, session_name.

The counter has no project foreign key so deleting and later rediscovering the same canonical project path cannot reuse prior ticket numbers. Ticket deletion never changes the counter.

## Error Handling

| Category | Condition | Response | State guarantee |
|---|---|---|---|
| Validation | Invalid enum, body, identifier, attachment payload | 400 with issues; CLI exit 2 | No write |
| Not found | Project, ticket, attachment, conversation, or session missing | 404 with stable code; CLI exit 1 for unknown ticket | No write |
| Conflict | Active ticket session or start already in progress | 409 naming the session or ticket | No provisioning |
| Content | Snapshot missing, unsafe path, compaction failed | 422 with actionable reason | Ticket unchanged during start |
| Provisioning | Worktree or init failure | 500 with session error | Existing session service rolls back |
| Preparation | Materialization or charter failure after provision | 500 after compensation | Ticket and links unchanged |
| Dispatch | Immediate first turn cannot begin | Start result or notice identifies failure | Linked prepared session remains usable |
| Event | SSE schema or transport failure | Structured warning only | Successful mutation remains committed |
| Cleanup | Snapshot or compensation cleanup failure | Structured error with orphan path key | DB never points at missing newly-added content |

All new server modules use createLogger with the tickets namespace. Logs include operation, project path or display name, ticket number, attachment kind or count, session name, duration, and typed outcome. They never include file bytes, note markdown, ticket descriptions, conversation content, or kickoff prompts.

## Testing Strategy

### Unit Tests

- Ticket schemas accept every required enum, default Not Started, reject mixed attachment payloads, and parse external input with safeParse.
- Counter allocation returns 1, 2, 3 across create, delete, create and remains monotonic under concurrent queued creates.
- Active-session derivation treats unfinished rows as active and finished or missing rows as history without changing ticket status.
- LiveTicketContext returns null for unrelated sessions and rebuilds identifier, status, descriptions, and retrieval commands after attachment mutations without inlining content.
- Reference parser, segmenter, Tiptap node, paste handler, serializer, deletion, and sent-message renderer round-trip canonical ticket-ref text.
- Slash generation accepts only valid structured title, description, work type, and attachment description; any generation or compaction failure calls no create operation.
- Ticket SSE cache helpers apply created, updated, deleted, filter, sort, attachment-index, and session-link deltas idempotently.

### Repository and Integration Tests

- tickets-repo.contract.test.ts writes every Ticket, Attachment payload, and SessionLink field, reopens the DB, and proves no field is lost.
- A fresh in-memory DB contains all four tables and indexes; repeated state-floor initialization is idempotent; no Umzug migration is required.
- File capture remains readable after the source file is deleted; unsafe names cannot escape the content root; insert failure removes the snapshot.
- Start agent mode ensures current compactions, provisions once, materializes all creation-time file and conversation attachments, registers descriptions, activates a source=ticket charter, links once, changes status, and queues the kickoff.
- Prepared mode performs the same preparation but calls no first-turn dispatcher.
- Active-session conflict provisions nothing; provision, materialization, and charter failures leave status and links unchanged and invoke compensation exactly once.
- A finished or deleted linked session remains in history and permits another start; merge and finish never change ticket status.
- A post-start attachment mutation appears in the next effective prompt while the creation-time materialized reference remains unchanged.
- cctl contract tests cover project-scoped bare numbers, project#number references, all operations, graph-lane environment identity, JSON envelopes, help graph edges, and unknown-ticket exit behavior.

### Storybook and UI Tests

- TicketBoard stories cover all five columns, empty columns, long titles, active sessions, keyboard pickup/move/cancel announcements, and mobile layout.
- TicketDetailPage stories cover each attachment kind, failed content resolution, historical sessions, active-session conflict, delete confirmation, and both start modes.
- Component tests verify list filters and created/updated sorting, optimistic field edits, board status movement with rollback, visible pending states, and SSE reconciliation.
- Prompt-editor tests paste a ticket XML reference into surrounding text, remove the chip, and prove the outgoing prompt excludes it.
- SessionRow and SessionInfoStrip tests render linked ticket indicators and navigate to the exact detail route.
- Axe and real keyboard passes cover board movement, Select fallback, dialogs, attachment controls, ticket chips, and focus restoration.

### End-to-End Paths

- Create a ticket globally, edit its fields, filter and sort it, move it across the board, and delete it only after explicit confirmation.
- Add each attachment kind, delete the source file, retrieve the durable snapshot, follow a related ticket, and edit or remove attachments in In Progress status.
- Start in prepared mode, verify no turn runs, verify materialized references and active charter, send the first prompt, then add an attachment and observe the next-turn live index.
- Start in agent mode, verify the kickoff begins, prevent a second active start, finish the session, start again, and inspect both history entries.
- Copy a ticket reference, paste and remove its chip, paste again and send, then resolve the referenced ticket from a conversation in another project.
- Run /ticket from both a session and project conversation, verify derived fields, originating-conversation compaction and attachment, success identifier notice, and all-or-nothing failure.
- Perform create, list, get, update, attach, retrieve, start, and delete through cctl from a graph-workflow lane.

### Performance and Load

- Measure global list queries over representative multi-project ticket counts and verify indexes with EXPLAIN QUERY PLAN.
- Measure per-turn linked-ticket lookup and rendering; it must remain a focused ticket, attachments, and link query rather than ManagerState hydration.
- Verify a burst of UI and CLI mutations emits small ticket events and causes no broad query invalidation or polling.
- Stress concurrent start requests for one ticket and concurrent creates for one project; exactly one start and unique sequential numbers succeed.
- Record snapshot capture and materialization duration and byte counts without content; large transfers must not hold the SQLite write queue.

## Security Considerations

- Every external JSON or multipart metadata boundary uses Zod safeParse; trusted repository rows are revalidated on decode.
- Snapshot and materialization paths use generated identifiers, sanitized basenames, path.resolve containment checks, and atomic writes.
- File bytes are stored only under the OS-aware CC config directory, never in a source worktree until an explicit ticket start.
- Ticket XML includes display identity and commands, not project paths, snapshot keys, notes, descriptions, or file content.
- Agent mutations use the existing token gateway and cctl identity resolution. This spec adds no independent authorization model.
- Markdown is rendered through the existing safe markdown path without raw HTML execution.
- Related-ticket and conversation traversal returns typed unavailable results rather than following arbitrary paths supplied by the client.

## Performance and Scalability

- TicketListItem is lean: it excludes description bodies, attachment payloads, and session history.
- TicketChangedEvent targets the 1–2 KB SSE budget and never carries TicketDetail.
- Query keys include every project, type, status, sort, and order input. SSE patches matching observed list caches and invalidates only affected details.
- Live context uses a focused session-link lookup plus one ticket and attachment-index read. It does not call readState.
- File I/O and compaction run outside the SQLite write queue; only final metadata transactions enter it.
- No polling is introduced. The global EventSource remains the only lifecycle notification channel.

## Migration Strategy

The schema change is additive. state-db.ts creates four new tables and indexes for fresh and existing databases. No data backfill, ordered cleanup, or compatibility-version bump is required because older builds ignore the new tables and can still read all existing state.

Rollout order:

1. Land schemas, table floor, repository contract tests, and ticket CRUD.
2. Land attachment snapshots, API, and cctl.
3. Land start orchestration, materialization, Alignment entrypoint, and live context.
4. Land ticket references, slash command, SSE cache integration, UI, and session indicators.

Validation checkpoints are repository durability, full targeted tests, typecheck, lint, build, Storybook build, axe and keyboard passes, then desktop 1440×900 and mobile 390×844 visual review. Rollback removes application use of the additive tables; snapshot cleanup may be performed by a later explicit maintenance operation rather than destructive downgrade logic.

## Design Review Gate

### Mechanical Review

- All numeric requirement IDs 1.1 through 10.2 appear in Requirements Traceability.
- This Spec Owns, Out of Boundary, Allowed Dependencies, and Revalidation Triggers are populated.
- The File Structure Plan names concrete new and modified paths.
- Every component in the component summary maps to one or more named files.
- The file plan does not place ticket state inside SessionState or broaden the stated boundary.
- No unresolved markers, unsafe TypeScript escape hatches, or incomplete sections are specified.

### Architecture and Executability Review

- Persistence, content, orchestration, runtime, API, CLI, and UI responsibilities have distinct owners.
- Long-running work never holds the SQLite write queue.
- Start-work failure boundaries and compensation are explicit.
- Deleted session history and active-session derivation are implementable without session-domain backreferences.
- The per-turn context path satisfies freshness without recreating agent runtimes.
- The new dependency is limited to the board behavior that existing primitives do not provide.
- Implementation can be divided into the four rollout phases without unresolved design choices.

**Draft gate result**: Pass. The reconciled collaboration result still requires Alex’s design approval before task generation or implementation.
