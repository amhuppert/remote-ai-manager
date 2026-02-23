# Requirements Document

> **UPDATED (2026-02-22) — SDK Migration:** Requirement 6.1-6.2 (SSE events) now uses only `conversation-status` events. The `session-ready` event type referenced in earlier specs has been removed. Status change events are broadcast from `prompt.ts` directly (not from hooks). All other requirements remain valid.

## Introduction

CSM currently lacks cross-project awareness: when a user is working inside a specific conversation, they have no visibility into what's happening in other projects, sessions, or conversations. Additionally, the conversation status labels (`idle`, `ready`, `running`) are confusing and don't clearly communicate the distinction the user cares about: whether Claude hasn't been invoked yet, is actively running, or has finished and awaits user input.

This specification covers two tightly related features:
1. **Status System Cleanup** — Rename and clarify conversation statuses, fix inconsistent project-level status display, and rework project page filters.
2. **Unified Conversations Panel** — A toggleable global side panel showing all running and awaiting conversations across every project, sorted by most recent activity.

## Requirements

### Requirement 1: Conversation Status Rename

**Objective:** As a user, I want conversation statuses to clearly communicate whether Claude hasn't been invoked, is actively running, or has finished and awaits my input, so that I can immediately understand the state of each conversation.

#### Acceptance Criteria

1. The CSM shall use three conversation status values: `new`, `running`, and `awaiting`.
2. When a conversation is created by CSM, the CSM shall assign it a status of `new`.
3. When a conversation is imported from external Claude Code sessions, the CSM shall assign it a status of `new`.
4. When a prompt is submitted and Claude Code begins executing, the CSM shall set the conversation status to `running`.
5. When Claude Code finishes executing (whether success or error), the CSM shall set the conversation status to `awaiting`.
6. The CSM shall remove the `idle` and `ready` status values from the session status schema.
7. The CSM shall migrate any persisted conversation state that uses `idle` or `ready` to the corresponding new values (`idle` → `new`, `ready` → `awaiting`) on read.

### Requirement 2: Session Status Derivation Update

**Objective:** As a user, I want session-level status to reflect the updated conversation statuses, so that session status remains consistent with conversation status.

#### Acceptance Criteria

1. When any conversation in a session has status `running`, the CSM shall derive the session status as `running`.
2. When any conversation in a session has status `awaiting` and none are `running`, the CSM shall derive the session status as `awaiting`.
3. When all conversations in a session have status `new` or the session has no conversations, the CSM shall derive the session status as `idle`.
4. The CSM shall continue to display `merged` as a separate visual indicator for sessions where the `finished` flag is true.

### Requirement 3: Project Badge and Filter Rework

**Objective:** As a user, I want project-level status badges and filters to accurately reflect what's happening in each project, so that I can quickly find projects that need my attention.

#### Acceptance Criteria

1. When a project has at least one conversation with status `running`, the CSM shall display a `running` badge on the project card (replacing the current `active` badge).
2. When a project has at least one non-archived session but no running conversations, the CSM shall display the non-archived session count on the project card.
3. When a project has no non-archived sessions, the CSM shall display an `idle` badge on the project card.
4. The CSM shall provide four filter options on the projects page: `all`, `active`, `running`, and `idle`.
5. When the `active` filter is selected, the CSM shall show projects that have at least one non-archived session.
6. When the `running` filter is selected, the CSM shall show projects that have at least one conversation with status `running`.
7. When the `idle` filter is selected, the CSM shall show projects that have no non-archived sessions or have never been used in CSM.

### Requirement 4: Status Display Consistency

**Objective:** As a user, I want statuses to be displayed consistently across all views, so that the same status always looks and reads the same regardless of where I see it.

#### Acceptance Criteria

1. The CSM shall display conversation status as `new`, `running`, or `awaiting` in all views: conversation cards, conversation sidebar dots, session detail topbar, and the unified panel.
2. The CSM shall use consistent color coding across all views: cyan for `running`, a distinct color for `awaiting`, and a muted color for `new`.
3. The CSM shall animate the status dot for `running` status across all views.

### Requirement 5: Unified Conversations Panel

**Objective:** As a user, I want a toggleable global side panel showing all conversations that are running or awaiting my input across every project, so that I have cross-project awareness without leaving my current context.

#### Acceptance Criteria

1. The CSM shall provide a toggle button in the topbar to open and close the unified conversations panel.
2. The unified conversations panel shall be accessible from every page in the application.
3. The unified conversations panel shall display only conversations with status `running` or `awaiting`.
4. The unified conversations panel shall aggregate conversations from all projects and sessions.
5. The unified conversations panel shall sort conversations by most recent activity (most recent first).
6. While the unified conversations panel is open, the CSM shall display each conversation's project name, session name, conversation name, status, and last activity time.
7. When the user clicks a conversation in the unified panel, the CSM shall navigate to that conversation's detail page.
8. While the unified conversations panel is open and a conversation's status changes (e.g., from `running` to `awaiting`), the CSM shall update the panel in real time without requiring a manual refresh.
9. If no conversations have status `running` or `awaiting`, the unified conversations panel shall display an empty state message.

### Requirement 7: Consolidated Sidebar Tabs

**Objective:** As a user, I want the active conversations view consolidated into the existing conversation sidebar (on session detail pages) via a tab switcher, so that I have cross-project awareness without a separate overlay panel.

#### Acceptance Criteria

1. On session detail pages, the CSM shall display a tab switcher in the conversation sidebar with two tabs: "Session" and "Active".
2. The "Session" tab shall show the current session's conversations (existing behavior).
3. The "Active" tab shall show all running and awaiting conversations across all projects and sessions, reusing the same data as the unified panel overlay.
4. The "Active" tab badge shall display the count of active conversations when greater than zero.
5. Each active conversation item shall display the conversation name, status dot, relative time since last activity, and clickable project/session metadata chips.
6. When the user clicks a project metadata chip in the active tab, the CSM shall navigate to that project's page.
7. When the user clicks a session metadata chip in the active tab, the CSM shall navigate to that session's conversation list page.
8. The user shall be able to rename an active conversation directly from the active tab.
9. The user shall be able to archive an active conversation directly from the active tab.
10. Rename and archive actions on active conversations shall work across any project/session, not just the current session.
11. The empty state in the active tab shall display a message: "No active conversations." with a hint about running/awaiting conversations.

### Requirement 8: Button Consistency

**Objective:** As a user, I want rename and archive buttons to be visually consistent across all views (sidebar, card list), so that the interface feels cohesive.

#### Acceptance Criteria

1. The CSM shall use `data-tooltip` attributes (not `title` attributes) for all action button tooltips in the conversation sidebar and conversation list.
2. The archive button icon shall use the downward arrow to bar character (`\u2913`) consistently across all views.
3. The unarchive button icon shall use the leftward arrow with hook character (`\u21A9`) consistently across all views.
4. The rename button icon shall use the pencil character (`\u270E` / `&#9998;`) consistently across all views.

### Requirement 6: SSE Event Updates for Unified Panel

**Objective:** As a user, I want the unified panel to reflect status changes in real time, so that I always see the current state of all active conversations.

#### Acceptance Criteria

1. When a conversation transitions to `running`, the CSM shall broadcast an SSE event that the unified panel consumes to add or update the conversation entry.
2. When a conversation transitions to `awaiting`, the CSM shall broadcast an SSE event that the unified panel consumes to update the conversation entry.
3. The CSM shall reuse and extend the existing SSE broadcaster infrastructure (`/api/events` endpoint) for unified panel updates.
