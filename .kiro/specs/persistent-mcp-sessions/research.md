# Research & Design Decisions

## Summary
- **Feature**: `persistent-mcp-sessions`
- **Discovery Scope**: Extension (refactoring core prompt execution within existing architecture)
- **Key Findings**:
  - The SDK `Query` async iterator naturally pauses between turns after `result` messages, waiting for `streamInput()` — this is the mechanism that keeps subprocesses alive
  - SDK has no turn-level abort; `abortController.abort()` and `close()` both terminate the entire subprocess. Abort always kills the long-lived session.
  - The `for await` loop throws when the subprocess crashes, enabling crash detection via try/catch in the background message pump

## Research Log

### SDK Streaming Input Mode Behavior
- **Context**: Need to understand how `query()` with `AsyncIterable<SDKUserMessage>` prompt keeps the subprocess alive between turns
- **Sources Consulted**: `@anthropic-ai/claude-agent-sdk` TypeScript declarations (sdk.d.ts), Agent SDK documentation, GitHub issues #33 and #34
- **Findings**:
  - When `query()` receives an `AsyncIterable` prompt, the SDK spawns the CLI subprocess once and keeps it alive
  - The async iterator from `query()` yields `SDKMessage` objects including `result` messages at end of each agent turn
  - After a `result` message, the iterator blocks (does not complete) — it waits for additional input via `streamInput()`
  - `streamInput()` accepts an `AsyncIterable<SDKUserMessage>` and delivers buffered messages when the current turn ends
  - The subprocess only exits when: (a) the prompt generator completes, (b) `close()` is called, or (c) abort signal fires
- **Implications**: The initial prompt must be an async generator that never completes on its own. It yields the first message and then effectively hangs. All subsequent messages are delivered via `streamInput()`. The `for await` loop runs continuously in a background async context, processing messages from all turns.

### Abort Mechanism Limitations
- **Context**: Req 5 asks for turn-level abort without killing the subprocess
- **Sources Consulted**: SDK type definitions for `Query`, `Options.abortController`, `Query.close()`
- **Findings**:
  - `abortController.abort()` — "When aborted, the query will stop and clean up resources" (kills subprocess)
  - `Query.close()` — "Forcefully ends the query, cleaning up all resources including pending requests, MCP transports, and the CLI subprocess"
  - No `cancelCurrentTurn()` or equivalent method exists on the `Query` interface
  - `Query.stopTask(taskId)` exists but is for background tasks, not the main agent turn
- **Implications**: Turn-level abort is not possible with the current SDK. Any abort kills the subprocess. Design must accept "abort kills subprocess, next prompt recreates a fresh long-lived session" as the standard behavior. This still preserves the user-facing abort semantics — the only loss is MCP server state (e.g., Playwright browser closes on abort, but this is acceptable since abort is a destructive user action).

### Subprocess Crash Detection
- **Context**: Need to detect when the long-lived subprocess crashes unexpectedly
- **Sources Consulted**: Node.js async iterator behavior, SDK implementation patterns
- **Findings**:
  - When the underlying subprocess exits unexpectedly, the `for await` loop over `Query` throws an error
  - This is standard Node.js behavior — pipe/stream errors propagate through async iterators
  - The `query()` function wraps the subprocess in a typed async generator; process exit causes the generator to throw
  - GitHub issue #1935 (MCP servers not properly terminated on exit) confirms subprocess lifecycle is tied to the `for await` consumption
- **Implications**: The background message pump wrapping the `for await` loop catches errors and marks the session as "dead." The next prompt detects this and creates a fresh long-lived session. No special crash detection mechanism needed beyond standard try/catch.

### Semaphore Semantics With Long-Lived Subprocesses
- **Context**: Current semaphore counts active prompts. With persistent subprocesses, semantics must change.
- **Sources Consulted**: `src/lib/query-semaphore.ts` current implementation, system resource concerns
- **Findings**:
  - Current semaphore default: 2 concurrent subprocesses (`DEFAULT_MAX_CONCURRENT = 2`)
  - Purpose: prevent OOM by limiting child processes
  - With persistent sessions, each conversation keeps a subprocess alive indefinitely
  - If semaphore counts subprocesses, idle conversations consume slots — this blocks new prompts
  - If semaphore counts active turns, the subprocess count is unbounded — defeats the OOM prevention purpose
- **Implications**: A two-tier approach is needed: (1) the existing semaphore continues to count active turns (prompt-in-progress), gating prompt execution, and (2) a separate idle subprocess TTL reaps long-idle subprocesses to bound total process count. This keeps the existing concurrency semantics while preventing unbounded subprocess growth.

### Turn Result Delivery to Callers
- **Context**: `executePromptStream()` currently returns after the `for await` loop completes. With a persistent `for await` loop, need a different mechanism to signal turn completion.
- **Sources Consulted**: Current `prompt.ts` architecture, SDK message types
- **Findings**:
  - The `result` message type signals turn completion (contains `total_cost_usd`, `duration_ms`, `num_turns`)
  - The background message pump processes all messages; it can detect `result` to know a turn is done
  - A per-turn Promise (resolve on `result`, reject on error) provides a clean async boundary
  - The `emit()` callback already sends SSE events — this remains unchanged
- **Implications**: `executePromptStream()` returns a Promise that resolves when the current turn's `result` message arrives. The background pump resolves the turn promise. The caller sees identical behavior to the current implementation.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A: Extend executePromptStream | Add get-or-create logic inline | Minimal files changed | Bloats 860-line file, complex control flow | Not recommended |
| B: New QuerySession module | Separate lifecycle manager | Clean SoC, testable | More files, interface overhead | Good but may over-engineer |
| C: Hybrid | New module for lifecycle, thin adapter in prompt.ts | Balanced, incremental, testable | Moderate planning | **Selected** |

## Design Decisions

### Decision: Hybrid Architecture (Option C)
- **Context**: Need to decompose `executePromptStream()` without changing its external API
- **Alternatives Considered**:
  1. Option A — Inline refactor of existing function
  2. Option B — Full extraction into new class-based module
- **Selected Approach**: New `query-session.ts` module owns subprocess lifecycle; `executePromptStream()` delegates to it
- **Rationale**: Clean separation without over-engineering. The `QuerySession` object encapsulates: creating the initial `query()`, running the background `for await` message pump, exposing `sendPrompt()` for per-turn execution, and `close()` for cleanup. `prompt.ts` becomes a thin coordinator.
- **Trade-offs**: Adds one new module but keeps all external APIs unchanged. Background message pump requires careful error handling.
- **Follow-up**: Verify async iterator error propagation behavior with real SDK in integration tests

### Decision: Accept Full Subprocess Termination on Abort
- **Context**: SDK provides no turn-level cancel mechanism
- **Selected Approach**: Abort kills the subprocess entirely. The next prompt creates a fresh `QuerySession` with `resume` pointing to the `claudeSessionId`.
- **Rationale**: This matches the existing abort behavior (subprocess is killed). The only difference is that MCP server state is lost, but this is acceptable for an explicit user abort action.
- **Trade-offs**: MCP state (browser windows, etc.) is lost on abort. This is the same behavior as today.

### Decision: Per-Turn Promise for Result Delivery
- **Context**: Need to signal turn completion to `executePromptStream()` callers
- **Selected Approach**: `QuerySession.sendPrompt()` returns a Promise that resolves when the `result` message arrives. The background message pump resolves/rejects this promise based on SDK messages.
- **Rationale**: Clean async boundary. Caller awaits the promise, gets turn results, function returns. Identical external behavior.

### Decision: Keep Semaphore Per-Turn, Add Idle TTL
- **Context**: Semaphore must still prevent OOM while allowing subprocesses to persist
- **Selected Approach**: Semaphore continues to count active turns (acquired on prompt start, released on turn complete). A separate idle timeout (configurable, default 5 minutes) calls `close()` on subprocesses with no recent turn activity.
- **Rationale**: Preserves existing back-pressure semantics. Idle TTL prevents unbounded process growth. Users sending prompts every few minutes keep the subprocess alive; abandoned conversations are reaped.

## Risks & Mitigations
- **Subprocess leak on unhandled errors** — Mitigate: background pump always runs in try/finally with cleanup. Registry cleanup on server shutdown.
- **HMR kills long-lived subprocesses** — Mitigate: globalThis storage survives HMR for registry; subprocess crash detection recreates on next prompt. (Existing queries already have this issue.)
- **Idle TTL too aggressive** — Mitigate: make TTL configurable via `config.json`. Default 5 minutes is generous for interactive workflows but bounds resource usage.
- **Race between turn completion and session deletion** — Mitigate: `close()` is idempotent. Double-close is safe per SDK docs.

## References
- [Agent SDK Streaming Input Mode](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) — Official docs on string vs streaming prompt modes
- [Agent SDK Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions) — Resume and fork semantics
- [Daemon Mode Feature Request (#33)](https://github.com/anthropics/claude-agent-sdk-typescript/issues/33) — Closed; streaming input is the solution
- [~12s Overhead Per Query (#34)](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34) — Confirms subprocess startup overhead
- [Playwright MCP keepAlive (#1302)](https://github.com/microsoft/playwright-mcp/issues/1302) — Maintainer confirms browser lifetime is tied to MCP connection
