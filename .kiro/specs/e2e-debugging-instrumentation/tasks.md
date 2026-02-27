# Implementation Plan

- [x] 1. Build the logger and trace context foundation
- [x] 1.1 Implement the trace context module using AsyncLocalStorage
  - Create a request-scoped context store that holds trace ID, action name, project name, and session name
  - Provide a function to run a callback within a trace context and a function to read the current context
  - Context must be automatically inherited by all async operations within the callback scope
  - Return undefined when called outside any traced context (safe for lib functions called during startup or background operations)
  - _Requirements: 1.3, 2.3_
  - _Contracts: TraceContext State_

- [x] 1.2 Implement the structured logger module
  - Create a logger factory that produces module-scoped loggers (each logger tags entries with its module name)
  - Each log method (debug, info, warn, error) emits a single NDJSON line containing: ISO 8601 timestamp, level, module, message, and any trace context fields automatically read from the context store
  - Accept optional additional structured fields that get merged into the log entry
  - Support configurable log level via `CC_LOG_LEVEL` environment variable, defaulting to `info`; if the value is invalid, fall back to `info` and emit a stderr warning
  - Write log entries to a file at the path specified by `CC_LOG_FILE`, defaulting to `cc-debug.log` in the CC config directory; resolve the path lazily on first log call using a once guard
  - Additionally write entries at warn level and above to stderr for immediate visibility
  - Preserve full error stack traces in log entries without truncation
  - Never throw — silently drop entries if file writes fail
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.3_
  - _Contracts: Logger Service_

- [x] 1.3 Unit tests for logger and trace context
  - Verify NDJSON output format (valid JSON per line, all required fields present)
  - Verify log level filtering (entries below configured level are not written)
  - Verify trace context auto-enrichment (entries within a trace context include traceId, action, projectName, sessionName)
  - Verify entries outside a trace context omit context fields gracefully
  - Verify warn/error entries appear on stderr in addition to the log file
  - Verify invalid `CC_LOG_LEVEL` falls back to info with a warning
  - Verify the logger never throws even when the log file path is invalid
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.3_

- [x] 2. Build the API route tracing wrapper
- [x] 2.1 Implement the withTracing higher-order function
  - Create a wrapper that takes a Next.js API route handler and returns a new handler with tracing instrumentation
  - Extract `X-Trace-Id` from the incoming request header; generate a new UUID if the header is absent
  - Extract `X-Action` from the incoming request header (may be absent for non-UI callers like hooks)
  - For routes with URL parameters named `name` and `session`, extract them and include as projectName/sessionName in the trace context
  - Initialize the trace context store for the duration of the handler execution
  - Log request start (method, path, action) and request completion (status code, duration in ms) at info level
  - Add the `X-Trace-Id` header to the response
  - Catch unhandled errors, log them with full context (traceId, action, request path, session context, stack trace) at error level, then re-throw
  - _Requirements: 2.3, 2.4, 2.5, 6.1_
  - _Contracts: withTracing Service_

- [x] 2.2 Wrap all existing API route handlers with the tracing wrapper
  - Wrap the projects listing endpoint (GET)
  - Wrap the sessions endpoint (GET, POST, DELETE)
  - Wrap the prompt execution endpoint (POST)
  - Wrap the hooks event receiver endpoint (POST)
  - Wrap the hooks status detection endpoint (GET)
  - Log hook validation failures (invalid JSON, schema errors) with the raw payload at warn level before returning error responses
  - Ensure all existing behavior and response formats are preserved exactly
  - _Requirements: 2.3, 2.4, 2.5, 4.2, 4.4, 6.1_

- [x] 2.3 Unit tests for the tracing wrapper
  - Verify trace ID is extracted from `X-Trace-Id` request header when present
  - Verify a new trace ID is generated when the header is absent
  - Verify `X-Trace-Id` is included in the response header
  - Verify request lifecycle is logged (start and completion with method, path, status, duration)
  - Verify unhandled errors are logged with full context before being re-thrown
  - Verify URL parameters (project name, session name) are extracted into trace context
  - _Requirements: 2.3, 2.4, 2.5, 6.1_

- [x] 3. (P) Create the frontend traced fetch utility and update UI components
  - Create a fetch wrapper that generates a UUID trace ID via `crypto.randomUUID()` and adds `X-Trace-Id` and `X-Action` headers to every outgoing request
  - Pass through all other fetch options (method, body, additional headers) unchanged
  - Replace all inline `fetch()` calls in UI components with the traced wrapper:
    - Session creation calls: action `create-session`
    - Prompt submission calls: action `send-prompt`
    - Session deletion calls: action `delete-session`
    - Session listing/refresh calls: action `list-sessions`
  - Verify the wrapper does not break any existing UI behavior
  - _Requirements: 2.1, 2.2_
  - _Contracts: tracedFetch Service_

- [x] 4. Instrument existing modules with logging
- [x] 4.1 (P) Instrument the state module with read/write diagnostics
  - Log state file writes at debug level: number of projects, total session count, file size in bytes, and the traceId from the current context
  - Log atomic write details at debug level: temp file path and final file path
  - Log state file read failures at error level: error type (parse error, missing file, permission error), file path, and traceId
  - Log atomic rename failures at error level: error details and both file paths
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 4.2 (P) Instrument the sessions module with lifecycle logging
  - Log successful session creation at info level: project name, session name, worktree path, branch name
  - Log session deletion at info level: session identifier, worktree cleanup result (success/failure), git branch cleanup result
  - Log worktree or branch creation/deletion failures at error level: git command executed, exit code, stderr output
  - _Requirements: 3.1, 3.5, 6.4_

- [x] 4.3 (P) Instrument the prompt and lock modules with execution and concurrency logging
  - Log prompt submission at info level: prompt length (character count), session identifier, Claude CLI command being invoked (excluding the actual prompt content for security)
  - Log prompt completion at info level: exit code, execution duration in ms, stdout size in bytes, stderr size in bytes
  - Log prompt failure at error level: error details including stderr output, CLI command arguments (excluding prompt content), working directory
  - Log lock acquisition and release at debug level for concurrency tracing
  - Log rejected concurrent execution attempts at warn level with the traceId of the rejected request
  - _Requirements: 3.2, 3.3, 3.4, 3.6, 6.2_

- [x] 4.4 (P) Instrument the hooks module with event debugging
  - Log received hook events at info level: event type (UserPromptSubmit, Stop), matched session identifier, timestamp
  - Log when a hook event references a session that does not exist in state at warn level: unknown session identifier and event type
  - _Requirements: 4.1, 4.3_

- [x] 5. Integration tests and verification
- [x] 5.1 Write integration tests for end-to-end trace flow
  - Simulate an API request with `X-Trace-Id` and `X-Action` headers and verify all log entries produced during that request share the same traceId
  - Simulate a session creation followed by prompt execution and verify the log file contains the complete lifecycle chain
  - Simulate a hook event and verify the log entry includes the hook event type and session context
  - Trigger a prompt execution failure and verify the error log entry contains CLI arguments, stderr output, working directory, and traceId
  - _Requirements: 1.1, 2.3, 2.5, 3.1, 3.2, 3.3, 3.4, 4.1, 6.1, 6.2_

- [x] 5.2 Verify existing tests pass with the logging layer active
  - Run the full existing test suite and confirm no regressions
  - Ensure the logger does not interfere with test output (use test-specific log file path or suppress file writes during tests)
  - Verify typecheck passes with no new errors
  - _Requirements: 1.1_
