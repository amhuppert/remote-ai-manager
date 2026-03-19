# Requirements Document

## Introduction

CC currently creates a new Agent SDK `query()` call for every prompt, which spawns a fresh CLI subprocess. When the subprocess exits after each prompt, all MCP server child processes — including Playwright browsers — are terminated. This makes interactive workflows (like browser-based testing that requires user authentication) impossible, because the browser closes as soon as the agent pauses for user input.

This specification defines the requirements for refactoring prompt execution to use a single long-lived streaming `query()` per conversation. The subprocess (and its MCP server connections) persists across prompts, enabling interactive workflows where MCP tools maintain state between agent turns.

## Requirements

### Requirement 1: Long-Lived Streaming Query Per Conversation

**Objective:** As a CC user, I want the SDK subprocess and its MCP servers to stay alive across multiple prompts within a conversation, so that stateful MCP tools (like Playwright browsers) persist between agent turns.

#### Acceptance Criteria

1. When a first prompt is sent to a new conversation, the Prompt Executor shall create a long-lived `query()` using `AsyncIterable<SDKUserMessage>` (streaming input mode) instead of a one-shot string prompt.
2. When a subsequent prompt is sent to an existing conversation that has an active query, the Prompt Executor shall deliver the prompt via `streamInput()` on the existing `Query` object instead of creating a new `query()` call.
3. While a conversation has an active long-lived query, the Prompt Executor shall keep the underlying SDK subprocess alive between prompts, preserving all MCP server connections.
4. The Prompt Executor shall continue to support multimodal prompts (text + images) through the streaming input mechanism.

### Requirement 2: Subprocess Lifecycle Management

**Objective:** As a CC operator, I want the long-lived subprocess to be reliably started, maintained, and cleaned up, so that system resources are managed correctly and conversations remain functional.

#### Acceptance Criteria

1. When a conversation's first prompt is submitted, the Prompt Executor shall start the long-lived query and register it in the query registry before processing begins.
2. When a conversation is explicitly closed or deleted, the Prompt Executor shall terminate the long-lived query's subprocess and clean up all associated resources (abort controller, query registry entry, MCP servers).
3. If the long-lived query's subprocess exits unexpectedly (crash, MCP server failure, SDK error), the Prompt Executor shall detect the termination, log the error, and set the conversation status to `awaiting` so the next prompt creates a fresh subprocess.
4. While no prompt is actively running within a long-lived query, the Prompt Executor shall keep the subprocess alive without consuming a concurrency slot (query semaphore).

### Requirement 3: Prompt Turn Isolation Within Long-Lived Sessions

**Objective:** As a CC developer, I want each prompt within a long-lived session to maintain correct turn-level accounting (cost, duration, turns, transcript), so that existing observability features continue to work accurately.

#### Acceptance Criteria

1. When a prompt completes within a long-lived query, the Prompt Executor shall update the conversation metadata (cost, duration, turns, context tokens) with the delta from that prompt's turn only.
2. When a prompt completes, the Prompt Executor shall set the conversation status to `awaiting` and broadcast the status change via SSE, even though the underlying subprocess remains alive.
3. When each prompt starts within a long-lived query, the Prompt Executor shall acquire the session lock and concurrency slot, releasing them when the prompt's agent turn completes (not when the subprocess exits).
4. The Prompt Executor shall append all SDK messages to the conversation transcript using the same format and semantics as the current implementation.

### Requirement 4: Session Resume and Fork Compatibility

**Objective:** As a CC user, I want conversation resume and fork to work correctly with long-lived sessions, so that existing session management features are preserved.

#### Acceptance Criteria

1. When resuming a conversation that has no active long-lived query (e.g., after server restart), the Prompt Executor shall create a new long-lived query with the `resume` option set to the conversation's `claudeSessionId`.
2. When forking a conversation, the Prompt Executor shall create a new long-lived query for the forked conversation with `forkSession: true`, independent of the source conversation's query.
3. If a conversation has an active long-lived query and the `claudeSessionId` changes (SDK returns a new session ID), the Prompt Executor shall update the conversation state accordingly.

### Requirement 5: Abort and Timeout Handling

**Objective:** As a CC user, I want to be able to abort a running prompt without killing the entire long-lived subprocess, so that I can cancel a specific operation while preserving MCP server state for the next prompt.

#### Acceptance Criteria

1. When a user aborts a running prompt, the Prompt Executor shall cancel the current agent turn without terminating the long-lived subprocess, allowing the next prompt to reuse the same subprocess and MCP connections.
2. If the safety-net timeout fires during a prompt, the Prompt Executor shall abort the current agent turn. The long-lived subprocess may be terminated as a result (SDK behavior), and the next prompt shall create a fresh subprocess if needed.
3. If the abort mechanism cannot gracefully cancel a turn without killing the subprocess, the Prompt Executor shall fall back to full subprocess termination and allow the next prompt to start a fresh long-lived query.

### Requirement 6: Backward Compatibility

**Objective:** As a CC developer, I want all existing features that interact with prompt execution to continue working without regression, so that the refactor is transparent to users and dependent systems.

#### Acceptance Criteria

1. The Prompt Executor shall continue to support `AskUserQuestion` tool interception with the same blocking/resume semantics (waiting_for_input status, question registry, SSE broadcasts).
2. The Prompt Executor shall continue to support queued messages via `queueMessage()` using `streamInput()` on the active query, with no change in behavior.
3. The Prompt Executor shall continue to register and provide in-process MCP tool servers (Ralph Loop init, roadmap tools, agent notification) through the long-lived query's `mcpServers` configuration.
4. The Prompt Executor shall continue to support the `autonomous` mode flag (denying AskUserQuestion) with unchanged semantics.
5. The Prompt Executor shall emit the same SSE events (`conversation-status`, `ask-question`, `content`, `result`, `done`, `error`, `aborted`) with the same payloads as the current implementation.
