# Requirements Document

## Project Description (Input)
Ticket system for Command Center — a CC-native ticketing system whose differentiator is that tickets are context bundles designed for agents: another vehicle for progressive disclosure of context, in the same way the cctl CLI is a progressive-disclosure graph agents navigate as needed.

Command Center users manage many parallel streams of agent work across projects, but today there is no durable place to park upcoming work together with the context an agent will need to execute it: context accumulates in conversations and is lost or manually re-assembled when work actually starts. The ticket system changes this — a ticket is created cheaply (from project and session conversations via a slash command, from the UI, or from any conversation including graph-workflow lanes via CLI), enriched with context over time, and when started, materializes everything an agent needs into a purpose-built session.

Core model: tickets have a per-project sequential id (displayed `<project>#<n>`), title, markdown description, type (Feature/Bug/Research/Tech debt/Performance), status (Not Started/In Progress/Done/Blocked/Closed), exactly one owning project, context attachments, and linked sessions (one active at a time, history kept). Stored in a new SQLite state-store repo in command-center.db. Deliberately minimal v1: no priority, labels, blocked-reason, or comment timeline.

Context attachments (the core value prop): five first-class types — files (content snapshotted into a central store at attach time so worktree-local files survive), conversation references, session references, related tickets, free-form markdown notes. Each attachment carries a user- or agent-authored description of content/purpose, forming a progressive-disclosure index; context accumulates over time until the ticket is worked. URLs/git refs/code locations stay plain text inside descriptions/notes (no machinery needed).

Start work: per-ticket start dialog with two modes — agent starts immediately from a kickoff prompt built from the ticket, or session provisioned and waits for the user. Starting creates a session in the ticket's project and moves the ticket to In Progress (the only automatic status transition; merge does not auto-Done). Materialization at session creation: attachment files written into the worktree and registered as reference documents; attached conversations pre-compacted with compaction markdown materialized; kickoff prompt embeds ticket body + attachment summaries. Two injection channels: an auto-created auto-approved Alignment charter derived from the ticket (mission/intent), plus a dedicated live ticket block rebuilt per turn from live ticket state so post-start attachment additions flow in automatically. Ticket-linked sessions get UI indicators.

Ticket references (first-class): a "Copy ticket reference" button on a ticket copies an XML ticket reference to the clipboard; pasting it into the prompt input auto-renders a ticket-reference chip — exactly mirroring the existing conversation-reference UX (RefPasteHandler/segmentTextByRefs). The reference shows the agent how to find the ticket and all its linked context; agents can follow related-ticket links, making the ticket system a navigable disclosure graph usable from ANY conversation, not just the ticket's own session.

Slash command: /ticket <hint> from project and session conversations following the /commit conversation-command pattern — the in-conversation agent fills title/description/type from accumulated context, creates the ticket immediately, and always auto-attaches the originating conversation (pre-compacted). Graph-workflow lane conversations use `cctl ticket` because their prompts are workflow-managed.

CLI: a cctl ticket command group with full UI parity (create, list, get, update, attach, start, delete) so agents can do everything the user can, from any conversation including graph-workflow lanes.

UI: global /tickets route with list view (project/type/status filters, sorting) and Kanban board (columns = the five statuses, drag to change status), plus per-project pre-filtered entry point; ticket detail view for field editing, attachment management, start-work, session history.

Explicitly deferred: priority/labels/comments, starting a ticket as a graph workflow, first-class URL/git/code attachments, in-repo storage or export.

## Introduction
The Ticket System gives Command Center a durable place to capture upcoming work as agent-oriented context bundles. A ticket belongs to one project, carries a small set of core fields, and accumulates described context attachments over time. Starting a ticket provisions a session with that context materialized and continuously visible to the agent. Tickets are referenceable from any conversation via copy/paste references, creatable from project and session conversations via a slash command, and fully operable from every conversation through the CLI. The differentiator over generic ticketing is progressive disclosure: every attachment is an indexed, described pointer whose full content agents retrieve on demand, and tickets link to other tickets, forming a navigable context graph.

## Boundary Context
- **In scope**: ticket creation and editing (UI, CLI, slash command); the five-status lifecycle with a single automatic transition; described context attachments of five types with durable file capture; start-work session creation with two autonomy modes; context materialization and per-turn ticket visibility in ticket sessions; ticket references in the prompt input; a global and per-project ticket UI (list, Kanban, detail); session-to-ticket indicators; full CLI parity for agents.
- **Out of scope**: priority, labels, blocked-reason fields, and comment/activity timelines; launching a ticket as a graph workflow; first-class URL/git/code-location attachment types (these remain plain text inside descriptions and notes); storing or exporting tickets as files in the repository; multi-user assignment or permissions; any automatic status change on merge or session completion.
- **Adjacent expectations**: the Ticket System composes with existing Command Center capabilities and does not change their ownership — session provisioning (worktree and branch creation), the Alignment charter mechanism, conversation compaction artifacts, the reference-documents registry, conversation slash-command dispatch, and the cctl CLI conventions. Session lifecycle (merging, finishing, deletion) stays outside the Ticket System; tickets only observe it for session history and re-start eligibility.

## Requirements

### Requirement 1: Ticket Creation and Identity
**Objective:** As a Command Center user, I want to create tickets classified by work type within a project, so that upcoming work is captured durably where agents and I can find it.

#### Acceptance Criteria
1. When a user or agent creates a ticket, the Ticket System shall persist it with a title, an optional markdown description, a work type, a status, and exactly one owning project.
2. The Ticket System shall restrict work type to one of: Feature, Bug, Research, Tech debt, Performance.
3. The Ticket System shall restrict status to one of: Not Started, In Progress, Done, Blocked, Closed.
4. When a ticket is created without an explicit status, the Ticket System shall set its status to Not Started.
5. When a ticket is created, the Ticket System shall assign it the next sequential ticket number within its owning project.
6. The Ticket System shall never reuse a project's ticket number, including after a ticket is deleted.
7. The Command Center UI shall display ticket identifiers as the owning project's name combined with the ticket number (for example, `command-center#12`).
8. When a user requests ticket deletion from the UI, the Command Center UI shall obtain explicit confirmation before deleting the ticket.
9. When a ticket is deleted, the Ticket System shall remove it from all list, board, and detail views.

### Requirement 2: Ticket Lifecycle
**Objective:** As a Command Center user, I want ticket status to reflect where work stands with minimal automation, so that the board stays truthful without surprising me.

#### Acceptance Criteria
1. When a user or agent sets a ticket's status, the Ticket System shall apply the change without restricting which status transitions are permitted.
2. When work is started on a ticket, the Ticket System shall set the ticket's status to In Progress automatically.
3. If a ticket's linked session is merged, finished, or deleted, the Ticket System shall leave the ticket's status unchanged.
4. The Ticket System shall make no automatic status change other than the start-work transition to In Progress.

### Requirement 3: Context Attachments
**Objective:** As a Command Center user or agent, I want to attach described context items to a ticket over time, so that by the time work starts the ticket is a self-sufficient context bundle.

#### Acceptance Criteria
1. The Ticket System shall support five attachment types on a ticket: file, conversation reference, session reference, related ticket, and free-form markdown note.
2. When an attachment is added, the Ticket System shall record a description of the attachment's content and purpose supplied by the attaching user or agent.
3. When a file is attached, the Ticket System shall capture the file's content at attach time such that the attachment remains readable after the file's source location is deleted.
4. When a user or agent adds, edits, or removes an attachment, the Ticket System shall apply the change in any ticket status, including after work has started.
5. The Ticket System shall present a ticket's attachments as an index of typed entries with descriptions, from which the full content of each attachment can be retrieved on demand.
6. When an attachment references another ticket, the Ticket System shall allow users and agents to navigate from that attachment to the referenced ticket's details and attachment index.

### Requirement 4: Starting Work on a Ticket
**Objective:** As a Command Center user, I want starting a ticket to provision a ready-to-work session with a chosen level of autonomy, so that beginning work is a single action.

#### Acceptance Criteria
1. When work is started on a ticket, the Ticket System shall support a choice between two modes: the agent begins working immediately, or the session is prepared and waits for the user's first prompt.
2. When work is started in either mode, the Ticket System shall create a new session in the ticket's owning project and link it to the ticket as its active session.
3. While a ticket has an active linked session, if a work start is requested, the Ticket System shall reject the request with a reason identifying the active session.
4. When a ticket's active linked session is finished or deleted, the Ticket System shall permit starting work again and shall retain the prior session in the ticket's session history.
5. When work is started in agent-immediate mode, the Ticket System shall begin the session's first agent turn with a kickoff prompt built from the ticket's title, description, and attachment summaries.
6. When work is started in prepared mode, the Ticket System shall run no agent turn until the user sends the first prompt.
7. If session provisioning fails, the Ticket System shall report the failure and leave the ticket's status and session links unchanged.

### Requirement 5: Context Materialization in the Ticket Session
**Objective:** As an agent working a ticket's session, I want the ticket's context delivered as a durable index plus retrievable content, so that I can work without re-gathering context.

#### Acceptance Criteria
1. When a ticket session is created, the Ticket System shall write each file attachment into the session's working tree and register it as a reference document carrying the attachment's description.
2. When a ticket session is created, the Ticket System shall ensure each attached conversation has a current compaction artifact and shall materialize its compacted content into the session as a readable, registered reference.
3. When a ticket session is created, the Ticket System shall create and immediately activate an Alignment charter derived from the ticket's title, description, and intent, without a user approval step.
4. While a session is linked to a ticket, the Ticket System shall make a current view of the ticket — identifier, title, status, and attachment index — available to the agent on every turn.
5. When attachments are added or changed after the ticket session was created, the Ticket System shall reflect the changes in the agent's ticket view on subsequent turns without any manual refresh step.
6. While a session is linked to a ticket, the Ticket System shall allow agents in that session to retrieve the full content of any attachment on demand, including the content of attached conversations.

### Requirement 6: Ticket References in Conversations
**Objective:** As a Command Center user, I want to hand any agent a ticket by reference in any conversation, so that ticket context is usable beyond the ticket's own session.

#### Acceptance Criteria
1. When a user activates "Copy ticket reference" on a ticket, the Command Center UI shall place a machine-readable ticket reference on the clipboard.
2. When ticket-reference text is pasted into the prompt input, the Command Center UI shall render it as a ticket-reference chip consistent with existing conversation-reference chips.
3. When a ticket-reference chip is removed from the prompt input before sending, the Command Center UI shall exclude that reference from the sent prompt.
4. When a prompt containing a ticket reference is delivered, the Ticket System shall enable the receiving agent to resolve the reference to the ticket's details and attachment index, regardless of which project or session the conversation belongs to.

### Requirement 7: Slash-Command Ticket Creation
**Objective:** As a Command Center user in a project or session conversation, I want a slash command that turns accumulated conversation context into a ticket, so that capture is effortless at the moment the context exists.

#### Acceptance Criteria
1. When a user sends the ticket slash command in an eligible project or session conversation, with optional hint text, Command Center shall create a ticket in the conversation's project immediately, without an approval step; Command Center shall not expose or run the slash command in graph-workflow lane conversations, where `cctl ticket` provides the creation path.
2. When creating a ticket from the slash command, Command Center shall derive the ticket's title, description, and work type from the conversation's accumulated context combined with any hint text.
3. When a ticket is created via the slash command, the Ticket System shall automatically attach the originating conversation to the ticket as a conversation reference.
4. When slash-command creation completes, Command Center shall report the new ticket's identifier in the conversation.
5. If the slash command cannot create a ticket, Command Center shall report the reason in the conversation and shall create nothing.

### Requirement 8: CLI Parity for Agents
**Objective:** As an agent, I want a ticket command group with full parity to the UI, so that I can manage tickets on the user's behalf from any conversation.

#### Acceptance Criteria
1. The cctl CLI shall provide a ticket command group covering every ticket operation available in the UI: create, list, get, update fields and status, add and remove attachments, start work, and delete.
2. When a ticket command runs in a project scope, the cctl CLI shall accept the bare per-project ticket number as the ticket identifier.
3. The cctl CLI shall accept ticket commands from any conversation, including graph-workflow lane conversations.
4. When listing or reading tickets, the cctl CLI shall include the attachment index with descriptions so that agents can selectively retrieve full content.
5. If a ticket command references a ticket that does not exist, the cctl CLI shall fail with an error identifying the unknown ticket.

### Requirement 9: Ticket UI — List, Board, and Detail
**Objective:** As a Command Center user, I want list, board, and detail views over tickets, so that I can plan and manage work across and within projects.

#### Acceptance Criteria
1. The Command Center UI shall provide a global tickets view spanning all projects.
2. The global tickets view shall provide a list presentation with filtering by project, work type, and status, and sorting by at least creation time and last-updated time.
3. The global tickets view shall provide a Kanban board presentation with one column per ticket status.
4. When a user drags a ticket card to a different status column, the Ticket System shall set the ticket's status to the target column's status.
5. When tickets are opened from a project's page, the Command Center UI shall present the tickets view pre-filtered to that project.
6. The ticket detail view shall support editing the title, description, work type, and status; managing attachments; starting work; and viewing the linked-session history.
7. When a user changes a ticket through the UI, the Command Center UI shall reflect the change immediately with an optimistic update or a visible pending indicator.
8. When ticket data changes from any source (UI, CLI, or agent), the Command Center UI shall update open ticket views without a manual page refresh.

### Requirement 10: Session Indicators for Ticket-Linked Sessions
**Objective:** As a Command Center user, I want to see which sessions belong to tickets, so that I can navigate between work and its ticket.

#### Acceptance Criteria
1. While a session is linked to a ticket, the Command Center UI shall display a ticket indicator carrying the ticket's identifier on the session's presentation surfaces (the session page and session lists).
2. When a user activates a session's ticket indicator, the Command Center UI shall navigate to that ticket's detail view.
