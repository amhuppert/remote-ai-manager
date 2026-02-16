# Research & Design Decisions

## Summary
- **Feature**: `e2e-debugging-instrumentation`
- **Discovery Scope**: Extension (adding instrumentation to existing system)
- **Key Findings**:
  - Zero logging infrastructure exists today — no console.log, no logger, no middleware
  - Clean lib function separation makes instrumentation straightforward — each domain module is a clear instrumentation boundary
  - No shared frontend fetch wrapper — inline `fetch()` calls in ~3 components need a traced alternative

## Research Log

### Trace Context Propagation in Node.js
- **Context**: Need to propagate traceId from API route entry through all lib function calls without threading a parameter through every function signature
- **Sources Consulted**: Node.js AsyncLocalStorage API (stable since v16), Next.js App Router runtime model
- **Findings**:
  - `AsyncLocalStorage` is the standard Node.js mechanism for request-scoped context propagation
  - Next.js API routes run in Node.js runtime (not Edge), so AsyncLocalStorage is fully available
  - Each API route handler invocation is a separate async context, providing natural isolation
  - No external libraries needed — this is built into Node.js
- **Implications**: Use AsyncLocalStorage to carry traceId + session context through the call chain; logger reads from the store automatically

### NDJSON File Logging in Node.js
- **Context**: Need file-based structured logging that Claude Code agents can grep and parse
- **Sources Consulted**: Node.js `fs.appendFileSync` vs write streams, NDJSON format spec
- **Findings**:
  - `appendFileSync` is simplest for low-throughput logging (CSM is a single-user dev tool, not high-traffic)
  - NDJSON (one JSON object per line) is ideal for `grep` and `Read` tool consumption by AI agents
  - No external logging library needed — custom logger is ~50 lines
  - Async append (`fs.promises.appendFile`) avoids blocking but adds complexity for error paths; sync append is acceptable given low volume
- **Implications**: Use synchronous file append for simplicity; no need for log rotation or buffering at CSM's scale

### Next.js API Route "Middleware" Pattern
- **Context**: Next.js App Router doesn't support per-route middleware; need a pattern to wrap all route handlers with tracing logic
- **Sources Consulted**: Next.js App Router docs, common wrapper patterns
- **Findings**:
  - Standard pattern: higher-order function that wraps the route handler, e.g. `withTracing(handler)`
  - The wrapper can extract headers, set up AsyncLocalStorage context, measure duration, and log request/response
  - This pattern is already common in the Next.js ecosystem for auth, rate limiting, etc.
- **Implications**: Create a `withTracing` wrapper that all API route handlers use; this is the single entry point for request-level instrumentation

### Frontend Trace ID Generation
- **Context**: UI needs to generate trace IDs before sending API requests
- **Sources Consulted**: `crypto.randomUUID()` browser support
- **Findings**:
  - `crypto.randomUUID()` is available in all modern browsers and generates v4 UUIDs
  - A thin wrapper around `fetch` that auto-generates traceId and adds headers is simpler than modifying each call site individually
  - The wrapper also provides a natural place to add the `X-Action` header
- **Implications**: Create a `tracedFetch` utility used by all UI components for API calls

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| AsyncLocalStorage + wrapper | Request-scoped context via ALS, HOF wrapper for routes | Zero param threading, idiomatic Node.js, no lib changes needed | ALS has minor perf overhead (negligible at CSM scale) | Selected approach |
| Explicit context parameter | Pass `TraceContext` as first arg to every function | Fully explicit, no hidden state | Requires changing every function signature in lib/, invasive | Rejected: too invasive |
| Global request context | Store context in module-level variable | Simple | Not safe with concurrent requests | Rejected: unsafe |

## Design Decisions

### Decision: AsyncLocalStorage for Trace Propagation
- **Context**: Need to thread traceId through API handler → lib functions → state writes without changing every function signature
- **Alternatives Considered**:
  1. AsyncLocalStorage — request-scoped, automatic propagation
  2. Explicit context parameter — requires signature changes across all lib modules
- **Selected Approach**: AsyncLocalStorage stores `{ traceId, action, projectName, sessionName }` per request
- **Rationale**: Non-invasive — existing lib functions gain trace context by importing the logger, not by changing their signatures
- **Trade-offs**: Implicit context (harder to trace in code review) vs. zero signature changes
- **Follow-up**: Verify ALS works correctly with Next.js hot-reload in dev mode

### Decision: Synchronous File Append for Logging
- **Context**: Need to write NDJSON log entries to a file
- **Alternatives Considered**:
  1. `appendFileSync` — simple, blocking, guaranteed write order
  2. Write stream with buffering — async, better for high-throughput
  3. External logging library (pino, winston) — feature-rich, adds dependency
- **Selected Approach**: `appendFileSync` with `fs.appendFileSync`
- **Rationale**: CSM is a single-user developer tool with low log volume; simplicity outweighs throughput optimization. Zero new dependencies.
- **Trade-offs**: Blocks event loop briefly per log write (acceptable at low volume) vs. zero complexity

### Decision: Traced Fetch Wrapper on Frontend
- **Context**: ~3 components make inline `fetch()` calls; need to add trace headers
- **Alternatives Considered**:
  1. Shared `tracedFetch()` utility — single function, all components import
  2. Modify each fetch call inline — no abstraction
  3. Fetch interceptor / service worker — transparent but complex
- **Selected Approach**: `tracedFetch(url, action, options)` utility function
- **Rationale**: Minimal abstraction — one function replaces `fetch()` at call sites, adds `X-Trace-Id` and `X-Action` headers automatically
- **Trade-offs**: Requires updating 3-4 call sites vs. provides consistent tracing for all future calls too

## Risks & Mitigations
- **AsyncLocalStorage context loss**: If a lib function uses `setTimeout` or untracked async, ALS context may be lost → Mitigation: CSM's lib code is fully synchronous/promise-based, no timers
- **Log file growth**: Unbounded append → Mitigation: Document log rotation as operational concern; CSM is a dev tool, not production infrastructure
- **Perf impact of sync writes**: Could block event loop → Mitigation: Negligible at CSM's single-user scale; can switch to async if needed later

## References
- [Node.js AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage) — core API for request-scoped context
- [NDJSON spec](https://github.com/ndjson/ndjson-spec) — newline-delimited JSON format
