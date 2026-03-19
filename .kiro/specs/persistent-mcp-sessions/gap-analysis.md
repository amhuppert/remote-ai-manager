# Gap Analysis: persistent-mcp-sessions

## 1. Current State Investigation

### Key Files and Modules

| File | Role | Relevance |
|------|------|-----------|
| `src/lib/prompt.ts` | Core prompt execution — `executePromptStream()` | **Primary refactor target.** Creates a new `query()` per prompt call, owns the `for await` message loop, session lock, timeout, and cleanup. |
| `src/lib/query-registry.ts` | In-memory map of active `Query` objects keyed by conversationId | **Reusable.** Already stores `Query` references; would become the long-lived query store. |
| `src/lib/queue-message.ts` | Delivers follow-up messages via `q.streamInput()` | **Reusable as-is.** Already uses `streamInput()` on a registered query — this is the exact mechanism for subsequent prompts. |
| `src/lib/abort-registry.ts` | Stores `AbortController` per conversationId, provides `abortConversation()` | **Must adapt.** Currently aborting kills the subprocess. Need to distinguish "cancel current turn" from "terminate subprocess." |
| `src/lib/query-semaphore.ts` | Counting semaphore limiting concurrent SDK subprocesses | **Semantics change.** Currently acquired per-prompt, released when prompt completes. With long-lived queries, the subprocess is always alive — semaphore must track subprocess count, not prompt count. |
| `src/lib/lock.ts` | Single-flight session lock (prevents concurrent prompts on same session) | **Reusable as-is.** Lock still prevents concurrent prompts; it's held per-turn, not per-subprocess. |
| `src/lib/prompt-route-handlers.ts` | HTTP route handler — validates request, calls `executePromptStream()` | **Minor changes.** May need to check for existing query and dispatch differently (new subprocess vs. `streamInput`). |
| `src/lib/sessions.ts` → `deleteSession()` | Removes worktree, stops dev servers, removes from state | **Must extend.** Needs to call `q.close()` on any active long-lived query before cleanup. |
| `src/lib/state.ts` → `recoverStaleConversations()` | Resets stuck "running" conversations on startup | **Must extend.** Should also clean up orphaned query registry entries. |
| `src/lib/ralph-loop/workflow-route-handlers.ts` | Ralph Loop calls `executePromptStream()` for each iteration | **Consumer — must keep working.** Calls the same API. |
| `src/lib/optimistic.ts` | Optimistic mode calls `executePromptStream()` fire-and-forget | **Consumer — must keep working.** Uses a single-prompt pattern. |

### Conventions Observed

- **Dependency injection**: All major modules use a `Deps` interface + `createX(deps)` factory pattern. `prompt.ts` uses `PromptDeps`, `sessions.ts` uses `SessionDeps`, etc.
- **Global singletons**: HMR-safe via `getGlobalSingleton()` on `globalThis` (query-registry, abort-registry, lock, semaphore).
- **Lifecycle pattern**: `executePromptStream()` owns the full lifecycle — acquire lock → create query → process messages → cleanup in `finally`. This is the monolithic function to decompose.
- **SSE streaming**: Prompt route wraps `executePromptStream()` in a `ReadableStream` and returns it as an SSE response. The stream closes when the function returns.

### SDK API Surface (from `@anthropic-ai/claude-agent-sdk` type definitions)

Key `Query` methods available for this feature:

| Method | Purpose | Notes |
|--------|---------|-------|
| `streamInput(stream)` | Send follow-up messages | Already used by `queue-message.ts` |
| `close()` | Forcefully terminate subprocess + MCP servers | For session deletion / hard abort |
| `reconnectMcpServer(name)` | Reconnect a failed MCP server | For error recovery |
| `toggleMcpServer(name, enabled)` | Enable/disable MCP server | Optional |
| `setMcpServers(servers)` | Replace dynamic MCP servers | Could update MCP config between prompts |

## 2. Requirements Feasibility Analysis

### Requirement-to-Asset Map

| Requirement | Existing Asset | Gap |
|-------------|---------------|-----|
| **Req 1: Long-lived streaming query** | `query()` supports `AsyncIterable<SDKUserMessage>` prompt; `queue-message.ts` uses `streamInput()` | **Missing:** No mechanism to create a query that stays alive beyond a single prompt. `executePromptStream()` creates+destroys per call. |
| **Req 2: Subprocess lifecycle** | `query-registry.ts` stores queries; `sessions.ts.deleteSession()` handles cleanup | **Missing:** No explicit subprocess start/stop lifecycle. `deleteSession()` doesn't terminate queries. No crash detection for the long-lived subprocess. |
| **Req 3: Turn isolation** | Cost/duration/turn tracking exists in `executePromptStream()`; transcript append works | **Missing:** Accounting logic is coupled to the `for await` loop that runs per-query. Need to isolate per-turn accounting from subprocess lifetime. |
| **Req 4: Resume/fork compat** | `resume` and `forkSession` options passed to `query()` | **Constraint:** Resume creates a new subprocess (SDK behavior). After server restart, there's no long-lived query to reuse — must create fresh one with `resume` option. Functionally compatible. |
| **Req 5: Abort handling** | `abort-registry.ts` + `AbortController` on `query()` | **Missing:** SDK `abortController.abort()` kills the entire subprocess. No SDK-level "cancel current turn only" API. The `Query.close()` method is also a full termination. **Research Needed:** Can `streamInput()` interrupt a running turn? Or must abort always kill the subprocess? |
| **Req 6: Backward compat** | All features use `executePromptStream()` | **Constraint:** API signature and SSE event semantics must remain identical. Ralph Loop and optimistic mode call `executePromptStream()` — the refactored version must be drop-in compatible. |

### Complexity Signals

- **Workflow refactoring**: The core change decomposes a monolithic function into a two-phase lifecycle (subprocess management + per-turn execution). This is an architectural change, not a simple feature addition.
- **Concurrency model change**: The semaphore currently counts active prompts. With long-lived subprocesses, it must count subprocesses (which persist across prompts). This changes back-pressure semantics.
- **Error boundary shift**: Currently, a crash in one prompt is cleanly contained (subprocess exits, `finally` runs). With long-lived subprocesses, a crash mid-turn must be detected and the subprocess restarted for the next prompt without losing the conversation.

### Research Needed

1. **Turn-level abort without subprocess kill**: The SDK `abortController` kills the entire process. Is there a way to cancel only the current turn? If not, aborting a prompt will always require re-creating the long-lived query for the next prompt.
2. **Subprocess crash detection**: When the long-lived subprocess crashes, how does the `for await` loop behave? Does it throw? Does the async iterator complete? This determines the crash recovery strategy.
3. **`streamInput()` while turn is running**: Can `streamInput()` deliver a message while the agent is mid-turn? The SDK docs say it "buffers for delivery when the current turn ends" — confirm this doesn't interfere with the running turn.

## 3. Implementation Approach Options

### Option A: Extend `executePromptStream()` (Minimal)

Add a "get or create query" step at the top of `executePromptStream()`:
- If a query already exists in the registry for this conversation, use `streamInput()` to send the prompt.
- If no query exists, create a new long-lived `query()` with an async generator and start the `for await` loop in a detached async context.
- Keep the existing function signature identical.

**Trade-offs:**
- Minimal file changes (single function refactor)
- Keeps all callers unchanged
- Risk of bloating an already 860-line file
- Complex control flow: the `for await` loop runs in a detached context while the function returns per-turn results to the caller

### Option B: New `QuerySession` Module (Clean Separation)

Create a new module `src/lib/query-session.ts` that owns subprocess lifecycle:
- `QuerySession` class/object manages: creating the long-lived query, running the `for await` message loop, tracking subprocess health.
- `executePromptStream()` becomes a thin wrapper: get or create `QuerySession`, deliver prompt, collect turn results.
- `QuerySession` is stored in a registry (extending or replacing `query-registry.ts`).

**Trade-offs:**
- Clean separation of concerns (subprocess lifecycle vs. per-turn execution)
- Easier to test in isolation
- More files, careful interface design needed
- Natural boundary for crash recovery and reconnection logic

### Option C: Hybrid (Recommended)

- Extract subprocess lifecycle into a new `query-session.ts` module (Option B's lifecycle layer).
- Refactor `executePromptStream()` to delegate to the session (Option A's minimal caller impact).
- Keep existing registries (query-registry, abort-registry) with extended semantics.
- Phase 1: Get the long-lived subprocess working. Phase 2: Add crash recovery and reconnection.

**Trade-offs:**
- Balanced complexity
- Allows incremental delivery
- Callers remain unchanged
- Subprocess lifecycle is testable independently

## 4. Implementation Complexity & Risk

**Effort: L (1–2 weeks)**
Significant refactoring of the core prompt execution path. Touches multiple interconnected modules (prompt, query-registry, abort-registry, semaphore, sessions, state recovery). Requires careful testing of edge cases (crash recovery, concurrent prompts, session deletion during active query).

**Risk: Medium**
- Known SDK APIs (`streamInput`, `close`, `AsyncIterable` prompt). The SDK already supports this mode.
- Clear existing patterns for registries and lifecycle management.
- Main risk is edge cases in subprocess crash recovery and abort semantics (research items identified above).
- All callers (`prompt-route-handlers`, `ralph-loop`, `optimistic`) use the same `executePromptStream()` API — a drop-in refactor minimizes blast radius.

## 5. Recommendations for Design Phase

### Preferred Approach

**Option C (Hybrid)** — Extract subprocess lifecycle into a `query-session.ts` module while keeping `executePromptStream()` as the stable external API.

### Key Design Decisions Needed

1. **Semaphore semantics**: Should the semaphore count subprocesses (acquired on first prompt, released on conversation close) or continue counting active turns? Counting subprocesses means the semaphore slot is held even when idle.
2. **Turn result delivery**: How does the detached `for await` loop communicate per-turn results back to the `executePromptStream()` caller? Options: event emitter, promise-per-turn, callback.
3. **Idle subprocess lifetime**: Should idle subprocesses have a TTL? Without one, every conversation that was ever used keeps a subprocess alive indefinitely.
4. **Abort granularity**: Given the SDK likely requires full subprocess termination on abort, should the design accept "abort kills subprocess, next prompt recreates it" as the standard abort behavior?

### Research Items to Carry Forward

1. Turn-level abort without subprocess kill (SDK behavior)
2. Subprocess crash detection mechanism (async iterator behavior)
3. `streamInput()` concurrency guarantees during active turns
