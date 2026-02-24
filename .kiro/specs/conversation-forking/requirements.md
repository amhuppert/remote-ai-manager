# Requirements Document

## Introduction

CSM currently supports multiple conversations per session, but each conversation is independent — there is no way to branch from an existing conversation's history. This feature introduces **conversation forking**: the ability to create a new conversation that inherits the message history of an existing one up to a chosen point. A closely related capability is **message editing**, where the user selects a previous user message, modifies it, and forks from that point with the revised text. Both operations create a new conversation with shared history, diverging from the fork point onward.

## Requirements

### Requirement 1: Fork Conversation from User Message
**Objective:** As a developer, I want to fork a conversation from any previous user message, so that I can explore alternative directions without losing the original conversation.

#### Acceptance Criteria
1. When the user triggers the fork action on a user message, CSM shall create a new conversation within the same session that contains all messages from the original conversation up to and including the selected user message and its corresponding assistant response.
2. When the fork is created, CSM shall assign the new conversation a unique ID, a null `claudeSessionId`, and a new JSONL transcript file containing the copied message history.
3. When the fork is created, CSM shall navigate the user to the newly created conversation automatically.
4. While a conversation is in `running` status, CSM shall disable the fork action on all messages in that conversation.
5. The fork action shall only be available on user-role messages, not on assistant-role messages.

### Requirement 2: Edit and Fork from User Message
**Objective:** As a developer, I want to edit a previous user message and restart the conversation from that point, so that I can refine my instructions without starting from scratch.

#### Acceptance Criteria
1. When the user triggers the edit action on a user message, CSM shall display an inline editor pre-filled with the original message text, replacing the message content area.
2. When the user saves the edited message, CSM shall create a new forked conversation containing all messages up to (but not including) the selected user message, followed by the edited message as the final entry.
3. When the user saves the edited message, CSM shall automatically send the edited message as the first prompt in the new forked conversation, triggering a Claude response.
4. When the user cancels editing, CSM shall restore the original message display without creating a fork.
5. If the user saves without modifying the text, CSM shall create a fork identical to the direct fork action (Requirement 1).

### Requirement 3: Forked Conversation Data Persistence
**Objective:** As a developer, I want forked conversations to be properly persisted and tracked, so that I can manage them alongside regular conversations.

#### Acceptance Criteria
1. CSM shall persist forked conversations using the same `ConversationState` schema as regular conversations, with an additional `forkedFrom` field recording the source conversation ID and the message index of the fork point.
2. CSM shall write the forked transcript as a new JSONL file containing the inherited messages, independent of the original transcript file.
3. CSM shall set the forked conversation's `promptCount` to reflect only prompts sent after the fork point (starting at 0 for a direct fork, 1 for an edit-and-fork after the automatic prompt).
4. When the user deletes a forked conversation, CSM shall not affect the original conversation or other forks from the same source.
5. CSM shall generate a default name for forked conversations that indicates its origin (e.g., "Fork of {original-name} @ turn {N}").

### Requirement 4: Conversation History for Forked Sessions
**Objective:** As a developer, I want forked conversations to maintain full context when interacting with Claude, so that Claude understands the prior conversation history.

#### Acceptance Criteria
1. When sending the first prompt in a forked conversation, CSM shall pass the inherited message history to the Claude Agent SDK so that Claude has full context of the conversation up to the fork point.
2. When sending subsequent prompts in a forked conversation (after the first), CSM shall use the established `claudeSessionId` for session continuity, identical to regular conversations.
3. The inherited message history shall be read from the forked conversation's own transcript file, not from the original conversation's transcript.

### Requirement 5: Fork UI — Message Hover Actions
**Objective:** As a developer, I want to quickly access fork and edit actions without cluttering the conversation view, so that the UI remains clean while the actions are discoverable.

#### Acceptance Criteria
1. When the user hovers over a user message on desktop, CSM shall display a compact action bar at the top-right of the message with Fork and Edit buttons.
2. When the user moves the mouse away from the message, CSM shall hide the action bar.
3. On mobile viewports (≤768px), CSM shall display the action bar below the message content without requiring hover, using 44px minimum touch targets.
4. While a message is being edited (inline editor active), CSM shall hide the hover action bar for that message.
5. When the user clicks Fork, CSM shall show a brief confirmation step (e.g., "Fork from here?" with confirm/cancel) before executing the fork.

### Requirement 6: Fork Visibility in Conversation Sidebar
**Objective:** As a developer, I want to identify forked conversations in the sidebar, so that I can understand the relationship between conversations.

#### Acceptance Criteria
1. CSM shall display a fork indicator icon on conversation entries in the sidebar that were created via forking.
2. When the user hovers over a forked conversation's sidebar entry, CSM shall show a tooltip indicating the source conversation and fork point (e.g., "Forked from {name} at turn {N}").
3. CSM shall list forked conversations in the same conversation list as regular conversations, sorted by creation time.
