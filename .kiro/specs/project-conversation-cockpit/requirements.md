# Requirements Document

## Introduction

This is the **project-page UI** spec for the project-level conversations (PLC) initiative. It redesigns the Command Center project page (`projects/[name]`) from a single-column sessions table with a legacy command bar into a two-state surface: a **first-run** state (a unified composer above the full-width sessions table) that animates into a three-column **cockpit** (global Active Conversations rail · conversation pane with tabs/transcript/docked composer · sessions panel) once at least one project conversation is open.

This spec is a **UI consumer** of the project-level-conversations **foundation** spec. The foundation owns the session-less conversation data model, the `scope`-discriminated active-conversation and SSE event shapes, the open-conversation count, and the project prompt/lifecycle routes. This spec **consumes** those contracts and does not redefine them. Likewise it consumes the main-worktree diff endpoint (a direct item produced outside this spec) and renders chat-session-spawning's inline cards inside its transcript without owning their schema or dispatch.

Requirement IDs below are local numeric IDs. Each acceptance criterion is tagged with its source `PLC-n` ID from `memory-bank/project-level-conversations/REQUIREMENTS.md` for traceability. The Two-pane Cockpit prototype under `memory-bank/project-level-conversations/project/` is the interaction source of truth. All PLC clarifying questions were resolved pre-design; this spec does not re-open them.

## Boundary Context

- **In scope (user-observable behavior owned here):**
  - First-run single-column layout: composer on top, full-width sessions table below, no hero/starter buttons (PLC-21).
  - The first-run → cockpit transition driven by the foundation's open-conversation count, with the locked entry animation (PLC-22).
  - Three-column cockpit layout with the locked layout defaults, and retention of the `New session` button + `⌘N`, the sessions table and its row semantics, the topbar breadcrumb, connection status, and project header summary (PLC-23, PLC-24, PLC-25).
  - Conversation tabs: open PLCs as tabs, active-tab and unread indicators, `+ New chat`, per-tab close with active-tab fallback (PLC-26, PLC-27, PLC-28).
  - The unified composer: one input replacing the legacy command bar, routing prose/`/`/`key:value` three ways with a recoloring mode-chip; the `/new`·`/capabilities`·`/workflow-builder` palette wired to existing flows; the session-composer affordances (backend toggle, model/effort, image attach, voice, send); agent recolor for Codex; shared filter-token state with the sessions panel (PLC-14, PLC-15, PLC-16, PLC-18, PLC-19, PLC-20, PLC-52, PLC-53).
  - The sessions panel: dedicated plain-text search plus a filter popover that shares one token state with the composer, with chip display/removal/clear-all and empty-results messaging (PLC-19, PLC-20, PLC-60).
  - The read-only main-worktree diff/review surface that mounts the existing diff component against the main-worktree diff endpoint (PLC-44 consumer).
  - Design-system compliance, keyboard operability, and rendering responsiveness for the project page (PLC-56, PLC-57, PLC-58, PLC-59, PLC-61).

- **Out of scope (owned by other specs/extensions, consumed here):**
  - The session-less conversation data model, persistence, lifecycle state, open-count derivation, main-worktree execution, and the `scope`-discriminated active-conversation/SSE contracts (project-level-conversations foundation).
  - The inline spawn-card schema, validation, multi-session card, and the readiness-gated auto-dispatch primitive (chat-session-spawning). This spec only provides the transcript mount point the card renders into.
  - The global rail's internal aggregation, `<project> / main` grouping, Needs-you logic, cross-page click-routing, and indicator-consistency rules (unified-conversations-panel extension). This spec mounts the rail as the cockpit's left column and consumes its existing data/query.
  - The main-worktree diff **endpoint** itself (direct item). This spec consumes it.
  - Per-PLC capabilities override behavior and PLC notification/Needs-you parity (capabilities + notifications extensions). `/capabilities` opening the existing flow is in scope (PLC-53); the override semantics are not.

- **Adjacent expectations:**
  - The page reads the foundation's open-conversation count to choose first-run vs cockpit, and reacts in near-real-time to the foundation's `scope`-discriminated events (PLC-46) so tabs, transcript, rail, and sessions panel stay current without manual refresh.
  - Sending a plain-prose prompt with no PLC open relies on the foundation creating the first PLC and routing the prompt into it (PLC-5, foundation-owned); this spec issues that request and renders the resulting cockpit.
  - Selecting a PLC tab that was closed relies on the foundation's reopen lifecycle; this spec issues reopen and focuses the tab.

## Requirements

### Requirement 1: First-run single-column layout

**Objective:** As a developer opening a project with no open conversations, I want a focused single-column page with a composer above the sessions table, so that I can immediately start a conversation or scan sessions without visual clutter.

#### Acceptance Criteria

1. While the project has zero open project conversations, the Project Cockpit shall render a single column with the unified composer on top and the full-width sessions table below. _(PLC-21)_
2. While in first-run, the Project Cockpit shall not render a hero banner or starter action buttons; the composer placeholder and a one-line hint shall carry the affordance. _(PLC-21)_
3. While in first-run, the Project Cockpit shall render the sessions table with its own dedicated text search and filter controls. _(PLC-21)_
4. While in first-run, the Project Cockpit shall retain the topbar breadcrumb, connection status, the project header summary, and the `New session` primary action with its `⌘N` shortcut. _(PLC-25)_
5. The Project Cockpit shall determine the first-run state from the project's open-conversation count provided by the foundation, not from any locally invented state. _(PLC-9, PLC-21)_

### Requirement 2: First-run → cockpit transition

**Objective:** As a developer, I want sending my first prompt to smoothly turn the page into the cockpit, so that the workspace reflects that I now have an active conversation.

#### Acceptance Criteria

1. When the project transitions from zero to at least one open project conversation, the Project Cockpit shall switch from the first-run layout to the cockpit layout. _(PLC-22, PLC-9)_
2. When the page enters the cockpit layout, the Project Cockpit shall animate the entry with an 8px rise and fade over `0.2s ease`. _(PLC-22, PLC-57)_
3. When the user sends a plain-prose prompt while no project conversation is open, the Project Cockpit shall issue the prompt so the first conversation is created and, upon confirmation, render the cockpit with that conversation focused. _(PLC-5, PLC-22)_
4. While the project has at least one open project conversation, the Project Cockpit shall render the cockpit regardless of how many closed or archived conversations exist. _(PLC-9)_
5. When the last open project conversation is closed, the Project Cockpit shall return to the first-run layout. _(PLC-9, PLC-28)_
6. Where the user's motion preference reduces motion, the Project Cockpit shall present the transition without the rise/fade animation. _(PLC-57)_

### Requirement 3: Three-column cockpit layout and locked defaults

**Objective:** As a developer with active conversations, I want a three-column cockpit with stable, opinionated defaults, so that I can converse, switch, and manage sessions in one operator console.

#### Acceptance Criteria

1. While in the cockpit, the Project Cockpit shall render three columns: a collapsible global Active Conversations rail, a conversation pane, and a sessions panel. _(PLC-23)_
2. The Project Cockpit shall render the conversation pane with conversation tabs, a transcript, and a composer docked at the bottom. _(PLC-23, PLC-24)_
3. The Project Cockpit shall ship the locked layout defaults — composer docked at bottom, conversation switcher as tabs, sessions density comfy, and conversation pane width approximately 60% — and shall not expose the prototype's tweak controls for composer position, switcher style, width, or density. _(PLC-24)_
4. The Project Cockpit shall identify the conversation pane's execution context as `main · worktree`. _(PLC-12-presentation, PLC-23)_
5. While in the cockpit, the Project Cockpit shall retain the topbar breadcrumb, connection status, the project header summary, and the `New session` primary action with its `⌘N` shortcut. _(PLC-25)_
6. While in the cockpit, the Project Cockpit shall present the sessions table using the existing row semantics and row sub-components rather than a reimplemented table. _(PLC-25, PLC-58)_
7. When the user collapses the global rail, the Project Cockpit shall present a slim strip and free the reclaimed width to the remaining columns. _(PLC-23)_

### Requirement 4: Conversation tabs and switching

**Objective:** As a developer juggling several repo conversations, I want tabs to switch between open conversations, start new ones, and close ones I am done with, so that I can manage multiple PLCs without losing context.

#### Acceptance Criteria

1. While in the cockpit, the Project Cockpit shall render each open project conversation as a tab at the top of the conversation pane. _(PLC-26)_
2. The Project Cockpit shall visually distinguish the active tab with a cyan top-edge. _(PLC-26, PLC-56)_
3. While a non-active tab has unread activity, the Project Cockpit shall display an amber unread dot on that tab. _(PLC-26, PLC-56)_
4. The Project Cockpit shall provide a `+ New chat` affordance that creates a new project conversation and focuses it; no `/new-chat` slash command shall exist. _(PLC-27)_
5. The Project Cockpit shall provide a close control on each tab. _(PLC-28)_
6. When the active tab is closed and at least one other open conversation remains, the Project Cockpit shall select another open conversation. _(PLC-28)_
7. When the active tab is closed and no open conversation remains, the Project Cockpit shall return to the first-run layout. _(PLC-28, PLC-9)_
8. When the user selects a tab, the Project Cockpit shall make that conversation active and render its transcript and pane header. _(PLC-26)_

### Requirement 5: Unified composer mode routing

**Objective:** As a developer, I want one input that understands whether I'm prompting, running a command, or filtering, so that I don't switch between separate controls.

#### Acceptance Criteria

1. The Project Cockpit shall present one composer that replaces the legacy single-line command bar and routes input by leading content into one of three modes: chat, command, or filter. _(PLC-14)_
2. While the input is plain prose, the Project Cockpit shall set the mode to chat, display a left mode-chip showing `› <selected agent>`, and recolor the field by agent identity (cyan for Claude, violet for Codex). _(PLC-14a, PLC-18, PLC-56)_
3. While the mode is chat, when the user presses Enter without Shift, the Project Cockpit shall send the input to the active project conversation; when the user presses Shift+Enter, the Project Cockpit shall insert a newline. _(PLC-14a)_
4. While the input begins with `/`, the Project Cockpit shall set the mode to command, recolor the field violet, and open a command palette. _(PLC-14b, PLC-56)_
5. While the input matches a `key:value` token, the Project Cockpit shall set the mode to filter, recolor the field amber, and add the corresponding chip to the sessions filter. _(PLC-14c, PLC-56)_
6. The Project Cockpit shall accept the filter keys `is:` (with `status:` accepted as an alias), `target:`, `branch:`, and `archived:true`. _(PLC-14c)_
7. While no project conversation is open, when the user sends a plain-prose prompt, the Project Cockpit shall route it to create-and-send the first conversation rather than treating it as a no-op. _(PLC-5, PLC-14a)_

### Requirement 6: Command palette

**Objective:** As a developer, I want a small, predictable set of slash commands that open existing flows, so that common project actions are one keystroke away.

#### Acceptance Criteria

1. While the mode is command, the Project Cockpit shall expose exactly the commands `/new`, `/capabilities`, and `/workflow-builder`, and no others. _(PLC-15)_
2. While the command palette is open, when the user presses Up or Down, the Project Cockpit shall move the highlighted command; when the user presses Enter, the Project Cockpit shall run the highlighted command. _(PLC-14b, PLC-59)_
3. When the user runs `/new`, the Project Cockpit shall open the existing New Session flow. _(PLC-53)_
4. When the user runs `/capabilities`, the Project Cockpit shall open the existing capabilities flow. _(PLC-53)_
5. When the user runs `/workflow-builder`, the Project Cockpit shall open the existing workflow builder. _(PLC-53)_
6. When a command is run, the Project Cockpit shall clear the composer input and close the palette. _(PLC-14b)_

### Requirement 7: Composer agent, model, effort, image, and voice controls

**Objective:** As a developer, I want the project composer to offer the same controls as the session composer, so that backend, model, effort, attachments, and voice behave identically everywhere.

#### Acceptance Criteria

1. The Project Cockpit shall provide the same composer controls as the session composer: a Claude/Codex toggle, a model selector, an effort selector, image attach, voice input, and send. _(PLC-16)_
2. While the selected effort is in the maximum class (`xhigh` or `max`), the Project Cockpit shall render the rainbow effort border, and shall not render it for any other effort. _(PLC-16, PLC-56)_
3. While a project conversation has not yet been initialized by its first turn, the Project Cockpit shall allow selecting the backend (Claude or Codex). _(PLC-17)_
4. While a project conversation is initialized, the Project Cockpit shall present the backend as fixed and shall not offer changing it. _(PLC-17)_
5. The Project Cockpit shall allow changing the model and effort selection between turns of a project conversation. _(PLC-17)_
6. When Codex is the selected backend, the Project Cockpit shall recolor the composer and the assistant accent violet. _(PLC-18, PLC-56)_
7. The Project Cockpit shall support voice transcription and image attach in the project composer with the same behavior as the session composer. _(PLC-52)_

### Requirement 8: Shared filter-token state and sessions search

**Objective:** As a developer, I want filters set in the composer and the sessions filter popover to stay in sync, and plain-text search to live with the sessions, so that filtering one project surface is reflected consistently.

#### Acceptance Criteria

1. The Project Cockpit shall maintain a single filter-token state shared by the composer's `key:value` filter mode and the sessions-panel filter popover. _(PLC-19)_
2. When a filter token is added or removed in the composer, the Project Cockpit shall reflect that change in the sessions-panel filter popover, and vice versa. _(PLC-19)_
3. The Project Cockpit shall host plain-text session search in the sessions-panel header, not in the composer. _(PLC-20)_
4. The Project Cockpit shall not provide free-text session search inside the composer. _(PLC-20)_
5. The Project Cockpit shall apply session search across session name and branch. _(PLC-60)_

### Requirement 9: Sessions filter chips and empty results

**Objective:** As a developer filtering sessions, I want clear chip controls and helpful empty states, so that I always understand what is filtered and how to clear it.

#### Acceptance Criteria

1. While one or more filter tokens are active, the Project Cockpit shall display them as chips with a per-chip remove control. _(PLC-60)_
2. While one or more filter tokens are active, the Project Cockpit shall provide a clear-all control that removes every filter token. _(PLC-60)_
3. While the sessions filter popover is open, the Project Cockpit shall let the user toggle status, target, and include-archived filters and reflect the toggles in the shared token state. _(PLC-19, PLC-60)_
4. When active filters or search produce no matching sessions, the Project Cockpit shall display an empty-results message that reflects whether a search term or a filter is responsible. _(PLC-60)_
5. The Project Cockpit shall make filter add/remove, clear-all, search, and popover toggles operable by keyboard. _(PLC-59, PLC-60)_

### Requirement 10: Conversation transcript host and spawn-card mount

**Objective:** As a developer, I want the conversation pane to render the PLC transcript and host inline session-spawn cards from chat-session-spawning, so that proposed work appears in context without this spec owning the spawn flow.

#### Acceptance Criteria

1. While a project conversation is active, the Project Cockpit shall render its transcript in the conversation pane. _(PLC-23)_
2. The Project Cockpit shall provide a documented transcript mount point at which chat-session-spawning's inline cards are rendered interleaved with transcript messages. _(PLC-29-mount, PLC-23)_
3. The Project Cockpit shall keep the transcript responsive at realistic transcript lengths by rendering messages through a virtualized list rather than rendering all messages eagerly. _(PLC-61)_
4. While a project conversation has no messages yet, the Project Cockpit shall present an empty transcript state consistent with the design system. _(PLC-23, PLC-57)_
5. The Project Cockpit shall not implement the spawn-card schema, validation, or session-creation dispatch; it shall only render cards provided by chat-session-spawning at the mount point. _(PLC-30-boundary)_

### Requirement 11: Main-worktree diff/review surface

**Objective:** As a developer, I want to review the main worktree's working-tree changes from the cockpit, so that I can see what a PLC turn changed without leaving the page.

#### Acceptance Criteria

1. While in the cockpit, the Project Cockpit shall provide a read-only diff/review surface for the main worktree's working-tree changes, comparable to the per-session diff. _(PLC-44)_
2. The Project Cockpit shall render the diff/review surface by mounting the existing diff component against the main-worktree diff endpoint. _(PLC-44, PLC-58)_
3. The Project Cockpit shall not provide in-app git mutation operations (commit, discard, reset) on the diff/review surface. _(PLC-44)_
4. While the main worktree has uncommitted changes, the Project Cockpit shall make those changes observable through the diff/review surface. _(PLC-45-presentation)_
5. While the main worktree has no uncommitted changes, the Project Cockpit shall present a no-changes empty state on the diff/review surface. _(PLC-44)_

### Requirement 12: Real-time consistency of the project page

**Objective:** As a developer, I want the cockpit's surfaces to stay current as conversations change, so that tabs, transcript, rail, and sessions reflect reality without a manual refresh.

#### Acceptance Criteria

1. When the foundation emits a project-conversation change event (created, status change, message appended, closed, reopened, or archived), the Project Cockpit shall update the affected tabs, transcript, rail, and sessions panel in near-real-time without a manual refresh. _(PLC-46)_
2. When a project-conversation turn reports running, awaiting, or waiting-for-input status, the Project Cockpit shall reflect that status in the active tab and pane consistently with how session conversations present status. _(PLC-46, PLC-49)_
3. When the open-conversation count changes between zero and non-zero, the Project Cockpit shall switch between first-run and cockpit accordingly. _(PLC-9, PLC-46)_
4. The Project Cockpit shall consume the foundation's `scope`-discriminated events and active-conversation shape without redefining them. _(PLC-46, PLC-47)_

### Requirement 13: Global Active Conversations rail mount

**Objective:** As a developer, I want the global Active Conversations rail present as the cockpit's left column, so that I can see and reach conversations across the project consistently with other pages.

#### Acceptance Criteria

1. While in the cockpit, the Project Cockpit shall mount the existing global Active Conversations rail as the left column. _(PLC-37-mount, PLC-23)_
2. The Project Cockpit shall render the rail using the existing rail component and its existing data source rather than a reimplemented rail. _(PLC-37-mount, PLC-58)_
3. The Project Cockpit shall not redefine the rail's grouping, Needs-you logic, cross-page routing, or indicator rules; those remain owned by the unified-conversations-panel extension. _(PLC-37-boundary)_
4. When the rail signals that a project conversation in the current project should be focused, the Project Cockpit shall focus that conversation's tab, reopening it as a tab if it was closed. _(PLC-50-consumer)_

### Requirement 14: Design system, keyboard operability, and performance

**Objective:** As a developer and as a maintainer, I want the project page to follow the design system, be keyboard-operable, and stay responsive at scale, so that it feels native to Command Center and performs well.

#### Acceptance Criteria

1. The Project Cockpit shall reference design-system tokens for all visual values and shall not use hard-coded color values. _(PLC-56)_
2. The Project Cockpit shall keep color semantic: cyan for active/primary/running/focus, amber for warning/awaiting/user-authored, green for ready/merged, violet for Codex identity, and rainbow reserved for maximum-class effort only. _(PLC-56)_
3. The Project Cockpit shall apply the design-system typography rules (display font for titles, body prose font only for conversation message prose, mono for everything else) and the spacing, radii, and motion rules (interactions `0.15s ease`, entries `0.2s ease`, no spring/bounce/scale-on-press). _(PLC-57)_
4. The Project Cockpit shall reuse production components — the sessions rows and their status/branch/mode/kebab sub-components, the conversation sidebar rows and badges, and the primary button — and shall fold prototype `.pc-*` class names into production naming. _(PLC-58)_
5. The Project Cockpit shall support keyboard operability across command and filter suggestions, sending prompts, tab and new-chat actions, session search, the filter popover, and rail controls. _(PLC-59)_
6. At realistic project sizes (many sessions and conversations across multiple projects in the rail), the Project Cockpit shall keep rendering and live updates responsive with no perceptible regression versus the current project, session, and Conversations pages. _(PLC-61)_
