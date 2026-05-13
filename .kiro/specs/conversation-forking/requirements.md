# Requirements Document

## Introduction

CC currently supports multiple conversations per session, but each conversation is independent — there is no way to branch from an existing conversation's history. This feature introduces **conversation forking**: the ability to create a new conversation that inherits the message history of an existing one up to a chosen point. When the fork point is a user message, the user's text is also prepopulated into the new conversation's prompt input so the developer can revise and re-send. The fork is created with its own Claude SDK session eagerly so it is decoupled from later mutations of the source conversation.

## Requirements

### Requirement 1: Fork Conversation from a Message
**Objective:** As a developer, I want to fork a conversation from any previous message, so that I can explore alternative directions without losing the original conversation.

#### Acceptance Criteria
1. When the user triggers the fork action on an assistant message, CC shall create a new conversation within the same session whose transcript copies all messages up to and including the selected assistant message, with its own Claude SDK session created eagerly via `forkSession()`.
2. When the user triggers the fork action on a user message at index > 0, CC shall create a new conversation whose transcript copies all messages up to (but not including) that user message, set `pendingPromptText` to the user's text, and create its own Claude SDK session eagerly.
3. When the user triggers the fork action on a user message at index 0 (the first message), CC shall create a new conversation with no transcript and no SDK session, with `pendingPromptText` set to the user's text — sending the first prompt then starts a brand-new SDK session.
4. When the eager SDK fork fails (e.g., the anchor UUID has been compacted away), CC shall fall back to a synthetic seed built from the local CC transcript: prepend the seed to `pendingPromptText`, mark `forkMode` as `"synthetic"`, and leave `backendRef` null.
5. When the fork is created, CC shall navigate the user to the newly created conversation automatically.
6. While a conversation is in `running` status, CC shall disable the fork action on all messages in that conversation.
7. The fork action shall be available on both user and assistant messages.

### Requirement 3: Forked Conversation Data Persistence
**Objective:** As a developer, I want forked conversations to be properly persisted and tracked, so that I can manage them alongside regular conversations.

#### Acceptance Criteria
1. CC shall persist forked conversations using the same `ConversationState` schema as regular conversations, with an additional `forkedFrom` field recording the source conversation ID, message index, source backend, source backend session ref, fork locator (anchor UUID), and fork mode.
2. CC shall write the forked transcript as a new JSONL file containing the inherited messages, independent of the original transcript file. (No transcript file is created for the user-index-0 case.)
3. CC shall set the forked conversation's `promptCount` to 0.
4. When the user deletes a forked conversation, CC shall not affect the original conversation or other forks from the same source.
5. CC shall generate a default name for forked conversations that indicates their origin (e.g., "Fork of {original-name} @ turn {N}").

### Requirement 4: Conversation History for Forked Sessions
**Objective:** As a developer, I want forked conversations to maintain full context when interacting with Claude, so that Claude understands the prior conversation history.

#### Acceptance Criteria
1. When the fork is an assistant or user-index-greater-than-zero fork, CC shall eagerly create the new conversation's Claude SDK session at fork time via `forkSession(sourceSessionId, { upToMessageId: anchor })`, and record the resulting session id in the new conversation's `backendRef`.
2. When sending subsequent prompts in a forked conversation, CC shall use the established `backendRef` for session continuity, identical to regular conversations.
3. The inherited message history shall be read from the forked conversation's own transcript file, not from the original conversation's transcript.
4. When the eager SDK fork fails, CC shall fall back to a synthetic seed (see Requirement 1.4) — the next prompt sent from the forked conversation primes a brand-new SDK session with the seed via the backend's `syntheticForkSeed` turn input field.

### Requirement 5: Persistent Prompt Input
**Objective:** As a developer, I want my in-progress prompt text to survive navigation and page reloads, so that I don't lose my place when switching conversations or refreshing.

#### Acceptance Criteria
1. While the user types into the prompt input on any conversation, CC shall debounce-persist the input text to that conversation's `pendingPromptText` field on the server.
2. When the user navigates away from a conversation and back (or reloads the page), CC shall restore the input from the conversation's `pendingPromptText`.
3. When the user successfully submits a prompt, CC shall clear `pendingPromptText` both client-side and server-side. Manually clearing the input persists null.
4. Best-effort: CC shall flush any unflushed input on `beforeunload` via `navigator.sendBeacon`.

### Requirement 6: Fork Visibility in the UI
**Objective:** As a developer, I want to identify forked conversations and understand how they were created, so that I can manage relationships between conversations.

#### Acceptance Criteria
1. CC shall display a fork indicator icon on conversation entries in the sidebar that were created via forking.
2. When the user hovers over a forked conversation's sidebar entry, CC shall show a tooltip indicating the source conversation and fork point (e.g., "Forked from {name} at turn {N}").
3. On a conversation whose `forkedFrom.forkMode === "synthetic"`, CC shall display a small fallback indicator on the conversation header to surface that the new conversation was bootstrapped from a synthetic seed rather than a native SDK fork.
