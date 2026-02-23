# Requirements Document

> **UPDATED (2026-02-22) — SDK Migration:** Requirement 4 (Hook Event Debugging) is obsolete — the hook system was removed. All references to `hooks.ts`, `hooks module`, hook event logging, and hook validation should be disregarded. The remaining requirements (1, 2, 3, 5, 6) are still valid but Req 3.2-3.4 should reference SDK `query()` execution instead of Claude CLI subprocess spawning.

## Introduction
CSM (Claude Session Manager) orchestrates multiple remote Claude Code sessions across git worktrees. When things go wrong — dropped hooks, stalled prompts, corrupted state, worktree conflicts — the primary debugging workflow is a Claude Code agent reading log files to diagnose the issue. This feature adds structured, end-to-end logging that traces user interactions in the UI through API routes to Claude CLI invocations, producing logs with enough context for an AI agent to reconstruct what happened and identify root causes without needing to reproduce the problem.

## Requirements

### Requirement 1: Structured Logging Foundation
**Objective:** As a developer debugging with a Claude Code agent, I want all CSM server-side operations to produce structured, machine-parseable log entries, so that an AI agent can filter, correlate, and reason about system behavior from log files alone.

#### Acceptance Criteria
1. The Logging Module shall emit all log entries as newline-delimited JSON (NDJSON) objects containing: timestamp (ISO 8601), level (debug/info/warn/error), message, module name, and traceId.
2. The Logging Module shall support configurable log levels via environment variable (`CSM_LOG_LEVEL`), defaulting to `info`.
3. When a log entry is associated with a session, the Logging Module shall include `projectName` and `sessionName` fields for correlation.
4. The Logging Module shall write log output to a configurable log file path (`CSM_LOG_FILE`), defaulting to `csm-debug.log` in the CSM config directory.
5. If the `CSM_LOG_LEVEL` environment variable contains an invalid value, the Logging Module shall fall back to `info` level and emit a warning.
6. The Logging Module shall also write log entries at `warn` level and above to stderr for immediate visibility.

### Requirement 2: UI Action Tracing
**Objective:** As a developer debugging with a Claude Code agent, I want each user-initiated UI action to generate a trace ID that propagates through the entire request chain, so that the agent can follow a single user interaction from button click to CLI execution in the logs.

#### Acceptance Criteria
1. When the UI initiates an API call in response to a user action, the Frontend shall generate a unique `traceId` and include it in the `X-Trace-Id` request header.
2. When the UI initiates an API call, the Frontend shall include an `X-Action` header describing the user action that triggered it (e.g., `create-session`, `send-prompt`, `delete-session`).
3. When an API route handler receives a request, the API Layer shall extract the `traceId` from the `X-Trace-Id` header (or generate one if absent) and attach it to all log entries produced during that request.
4. When the API route handler returns a response, the API Layer shall include the `traceId` in the `X-Trace-Id` response header.
5. The API Layer shall log request method, path, action (from `X-Action`), status code, and duration (ms) for every completed API request at `info` level.

### Requirement 3: Session Lifecycle Instrumentation
**Objective:** As a developer debugging with a Claude Code agent, I want session operations to emit detailed contextual log entries, so that the agent can reconstruct the full lifecycle of any session from the log file.

#### Acceptance Criteria
1. When a session is created, the Session Module shall log the project name, session name, worktree path, branch name, and traceId at `info` level.
2. When a prompt is submitted to a session, the Session Module shall log the prompt length (character count), session identifier, traceId, and the Claude CLI command being invoked (excluding prompt content) at `info` level.
3. When a prompt execution completes, the Session Module shall log the exit code, execution duration (ms), stdout size (bytes), stderr size (bytes), and traceId at `info` level.
4. If a prompt execution fails (non-zero exit code or timeout), the Session Module shall log the error details including stderr output, the CLI command arguments, working directory, and traceId at `error` level.
5. When a session is deleted, the Session Module shall log the session identifier, worktree cleanup result (success/failure), git branch cleanup result, and traceId at `info` level.
6. While a prompt execution is in progress and single-flight lock is held, the Session Module shall log any rejected concurrent execution attempts with the traceId of the rejected request at `warn` level.

### Requirement 4: Hook Event Debugging
**Objective:** As a developer debugging with a Claude Code agent, I want incoming hook events to be logged with enough detail to correlate them back to the session and prompt execution that triggered them.

#### Acceptance Criteria
1. When a hook event (UserPromptSubmit, Stop) is received, the Hook Handler shall log the event type, session identifier, and timestamp at `info` level.
2. If a hook event payload fails validation, the Hook Handler shall log the raw payload and validation errors at `warn` level.
3. If a hook event references a session that does not exist in state, the Hook Handler shall log the unknown session identifier and event type at `warn` level.
4. When a hook event is received with an `X-Trace-Id` header, the Hook Handler shall include that traceId in log entries to enable correlation with the original prompt execution.

### Requirement 5: State File Diagnostics
**Objective:** As a developer debugging with a Claude Code agent, I want state file operations to be logged, so that the agent can diagnose state corruption or data loss by tracing state transitions in the log.

#### Acceptance Criteria
1. When the state file is written, the State Module shall log the number of projects, total session count, file size (bytes), and the traceId of the operation that triggered the write at `debug` level.
2. If a state file read fails (parse error, missing file, permission error), the State Module shall log the error type, file path, and any associated traceId at `error` level.
3. When the state file undergoes atomic write (temp file + rename), the State Module shall log both the temp path and final path at `debug` level.
4. If the atomic rename operation fails, the State Module shall log the error and both file paths at `error` level.

### Requirement 6: Error Context Enrichment
**Objective:** As a developer debugging with a Claude Code agent, I want errors to carry enough contextual information that the agent can identify root causes from the log entry alone.

#### Acceptance Criteria
1. When an error occurs in an API route handler, the Error Handler shall log the error with the associated traceId, action, request path, and any session context at `error` level.
2. If an error occurs during prompt execution, the Error Handler shall log the Claude CLI command arguments (excluding prompt content), working directory, exit code, and stderr output at `error` level.
3. The Error Handler shall preserve full error stack traces in structured log entries without truncation.
4. If an error occurs during worktree creation or deletion, the Error Handler shall log the git command, exit code, stderr output, and traceId at `error` level.
