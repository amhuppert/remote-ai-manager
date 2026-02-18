# Requirements Document

## Introduction

The Prompt Execution feature enables developers to send prompts to Claude Code CLI processes running within session worktrees. It manages the full execution lifecycle: spawning the Claude CLI subprocess, enforcing single-flight concurrency locking (one prompt per session at a time), transitioning session status between ready and running states, tracking prompt counts for conversation continuity, and handling timeouts and errors gracefully. This feature is the core interaction mechanism between CSM and Claude Code.

## Requirements

### Requirement 1: Claude CLI Invocation

**Objective:** As a developer, I want prompts to be executed by spawning the Claude CLI in the session's worktree, so that Claude Code operates within the correct git context and isolation boundary.

#### Acceptance Criteria

1. When a prompt is submitted, the Prompt Executor shall spawn the `claude` CLI process with the `-p` flag and the prompt text as arguments.
2. When a prompt is submitted, the Prompt Executor shall set the working directory of the spawned process to the session's worktree path.
3. The Prompt Executor shall pass `--dangerously-skip-permissions` to prevent interactive permission prompts that hang in headless mode, `--output-format stream-json` to receive streaming structured output, and `--max-turns 50` as a safety limit against runaway execution.
4. The Prompt Executor shall inherit the parent process environment variables, filtering out any `CLAUDE`-prefixed variables to avoid inheriting the parent Claude Code session context.
5. The Prompt Executor shall read stdout line-by-line from the spawned process, parse each line as a stream-json event, and accumulate content blocks (text, tool_use) from assistant messages into a `MessageContentBlock[]` array.

### Requirement 2: Conversation Continuity

**Objective:** As a developer, I want subsequent prompts in a session to continue the existing conversation, so that Claude Code maintains context across multiple interactions.

#### Acceptance Criteria

1. When a session's prompt count is zero, the Prompt Executor shall invoke the CLI without the continuation flag (first prompt starts a new conversation).
2. When a session's prompt count is greater than zero, the Prompt Executor shall include the `-c` flag to continue the most recent conversation in the worktree.
3. When a prompt completes successfully, the Prompt Executor shall increment the session's prompt count by one.

### Requirement 3: Single-Flight Locking

**Objective:** As a developer, I want only one prompt to execute per session at a time, so that concurrent submissions do not corrupt the conversation state or create conflicting Claude Code processes.

#### Acceptance Criteria

1. When a prompt execution begins, the Prompt Executor shall acquire an in-memory lock keyed by project path and session name.
2. If a lock is already held for a session, the Prompt Executor shall reject the request with a "Session is busy" error rather than queuing the prompt.
3. When a prompt execution completes (success or failure), the Prompt Executor shall release the session lock.
4. The Prompt Executor shall provide a query function to check whether a session currently has an active lock.

### Requirement 4: Session Status Transitions

**Objective:** As a developer, I want the session status to reflect whether a prompt is currently executing, so that the UI and other features can display accurate session state.

#### Acceptance Criteria

1. When a prompt execution begins, the Prompt Executor shall transition the session status from "ready" to "running".
2. When a prompt execution completes successfully, the Prompt Executor shall transition the session status back to "ready".
3. If a prompt execution fails, the Prompt Executor shall still transition the session status back to "ready".
4. When the session status changes, the Prompt Executor shall update the `lastActivityAt` timestamp to the current time.

### Requirement 5: Execution Timeout

**Objective:** As a developer, I want prompt execution to have a configurable timeout, so that runaway processes do not block a session indefinitely.

#### Acceptance Criteria

1. The Prompt Executor shall enforce a timeout on the Claude CLI process using the `claudeTimeoutMs` value from the global configuration.
2. If the Claude CLI process exceeds the configured timeout, the Prompt Executor shall terminate the process with SIGTERM and emit an error event.

### Requirement 6: Error Handling and Recovery

**Objective:** As a developer, I want prompt execution errors to be handled gracefully, so that sessions recover to a usable state and meaningful error information is returned.

#### Acceptance Criteria

1. If the Claude CLI process fails, the Prompt Executor shall wrap the error with a "Prompt execution failed" prefix and re-throw it.
2. While performing error recovery, the Prompt Executor shall reset the session status to "ready" on a best-effort basis (suppressing status-update errors).
3. While performing error recovery, the Prompt Executor shall always release the session lock regardless of whether the status reset succeeds.
4. If a prompt execution fails, the Prompt Executor shall not increment the session's prompt count.

### Requirement 7: API Endpoint

**Objective:** As a developer, I want a REST API endpoint for submitting prompts, so that the UI and external tools can trigger prompt execution programmatically.

#### Acceptance Criteria

1. The Prompt API shall accept POST requests at `/api/projects/[name]/sessions/[session]/prompt` with a JSON body containing a `prompt` field.
2. When the prompt field is missing or empty, the Prompt API shall return a 400 error with the message "prompt is required and must be a non-empty string".
3. When the project is not found, the Prompt API shall return a 404 error with the message "Project not found".
4. When the session is not found, the Prompt API shall return a 404 error with the message "Session not found".
5. When the session is busy (lock held), the Prompt API shall return a 409 error with error code "SESSION_BUSY" and the message "Session is busy — a prompt is already running".
6. When prompt execution begins, the Prompt API shall return a streaming `text/event-stream` SSE response that emits events (`init`, `content`, `result`, `error`, `done`) in real time as the CLI executes.
7. When prompt execution fails with a non-busy error during stream setup, the Prompt API shall emit an `error` SSE event with the failure message followed by a `done` event.

### Requirement 8: Conversation Message Storage

**Objective:** As a developer, I want user prompts and Claude responses to be stored directly in the session state, so that the conversation is immediately available for display without depending on external transcript files or hooks.

#### Acceptance Criteria

1. When a prompt execution begins, the Prompt Executor shall append the user's message (with role and content as `[{ type: "text", text: promptText }]`, and timestamp) to the session's `messages` array before spawning the CLI process.
2. When a prompt execution completes with accumulated content blocks, the Prompt Executor shall append Claude's response (with role and `content: MessageContentBlock[]`, and timestamp) to the session's `messages` array.
3. The Prompt Executor shall accumulate text and tool_use content blocks from streamed assistant messages into a `MessageContentBlock[]` array during execution.
4. When the Claude CLI emits a `system` init event with a `session_id`, the Prompt Executor shall set the session's `claudeSessionId` from that value.
5. If a prompt execution fails with no accumulated content blocks, the Prompt Executor shall not append an assistant message (the user message persisted before execution is retained). If content blocks were accumulated before the failure, they shall be stored.
