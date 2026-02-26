# Research & Design Decisions

## Summary
- **Feature**: ralph-workflow
- **Discovery Scope**: Complex Integration (new orchestrator subsystem within existing CSM architecture)
- **Key Findings**:
  - Custom MCP tools via `createSdkMcpServer` + `tool()` are the correct integration pattern for `report_status` and `update_fix_plan` — requires async generator prompt format
  - The existing `executePromptStream()` is too tightly coupled to interactive prompt flows; the orchestrator needs its own execution function that reuses transcript/SSE/state helpers
  - The fire-and-forget background job pattern (globalThis registry + SSE broadcast) is the right model for the long-running orchestrator loop

## Research Log

### Agent SDK Custom Tool Integration
- **Context**: Ralph Loop requires two custom tools (`report_status`, `update_fix_plan`) that Claude can call during iterations to report structured data back to CSM.
- **Sources**: Anthropic Agent SDK docs (custom-tools), npm package docs, claude-agent-sdk-demos
- **Findings**:
  - Custom tools are defined via `createSdkMcpServer()` + `tool()` helper — creates an in-process MCP server
  - Tool names exposed to Claude follow pattern: `mcp__{server_name}__{tool_name}`
  - Tool handlers receive Zod-validated input and return `CallToolResult` objects
  - **Critical constraint**: Custom MCP tools require streaming input mode — `prompt` must be `AsyncIterable<SDKUserMessage>`, not a plain string
  - The `tool()` function signature: `tool(name, description, zodSchema, handler)`
  - Tool handlers can perform side effects (state mutation, SSE broadcast) before returning
- **Implications**: The orchestrator must use the async generator prompt pattern. Tool handlers are closures over iteration context (workflow state, broadcast functions). MCP server is recreated per iteration with fresh context.

### canUseTool vs MCP Server Pattern
- **Context**: CSM already uses `canUseTool` to intercept `AskUserQuestion` in `prompt.ts`. Should Ralph Loop tools use `canUseTool` interception or proper MCP servers?
- **Sources**: Existing `prompt.ts` (lines 198-273), SDK TypeScript reference
- **Findings**:
  - `canUseTool` is for permission gating — intercepts tool calls to approve/deny/modify input. Returns `PermissionResult` with `behavior: "allow" | "deny"`.
  - `createSdkMcpServer` is for defining new tools — proper way to add tools Claude can call
  - `canUseTool` is still useful for the orchestrator: auto-deny `AskUserQuestion` during autonomous iterations (loop should not block on user input)
- **Implications**: Use `createSdkMcpServer` for `report_status` and `update_fix_plan`. Use `canUseTool` to deny `AskUserQuestion` during iterations.

### Orchestrator Execution Model
- **Context**: How should the long-running orchestrator loop execute within CSM's Next.js architecture?
- **Sources**: Existing `background-jobs.ts`, `lock.ts`, `prompt.ts`
- **Findings**:
  - Background jobs use fire-and-forget promises stored in globalThis registry
  - Jobs broadcast progress via global SSE, not per-request streams
  - Session locks are in-memory (globalThis Map), throw immediately if held
  - Jobs have stale recovery (10-minute timeout)
  - The orchestrator is fundamentally a long-running async function like a background job
- **Implications**: Orchestrator dispatched as fire-and-forget, stored in globalThis registry with AbortController and pause flag. Each iteration acquires/releases session lock. Workflow status persisted in state.json provides UI-level session locking (read-only flag). Stale recovery on server restart resets "running" to "paused".

### Iteration Content Streaming
- **Context**: How to stream current iteration's Claude output to the UI in real-time when there's no per-request HTTP stream?
- **Sources**: Existing SSE architecture, `sse-broadcaster.ts`
- **Findings**:
  - Existing prompt execution streams content via per-request ReadableStream (prompt route)
  - Background jobs use global SSE for status only, not content
  - CSM is a single-user tool — broadcasting content to all clients is acceptable
  - TanStack React Query with conditional polling (`refetchInterval: isBusy ? 3000 : false`) used for message refresh
- **Implications**: Two-pronged approach: (1) Broadcast iteration content via global SSE for real-time display, (2) Write to transcript JSONL for persistent access. The UI listens for `workflow-content` SSE events during active iteration and falls back to transcript queries for historical iterations.

### Session Lock Strategy During Loop
- **Context**: How should the orchestrator manage session locks across multiple iterations?
- **Sources**: Existing `lock.ts`, background job patterns
- **Findings**:
  - Per-prompt session lock: acquire before query(), release after
  - Background jobs hold lock for entire operation
  - The orchestrator needs to prevent external prompts while running
  - Pausing should allow the user to send prompts to other conversations
- **Implications**: The orchestrator acquires the session lock for each iteration (not the entire loop). Between iterations, the lock is briefly released but the persisted `workflow.status: "running"` prevents the UI from allowing prompt submission. On pause, the orchestrator exits and the lock is fully released. This allows the UI to check workflow.status for the read-only flag independently of in-memory locks.

### Planning Phase Design
- **Context**: How should the AI-assisted planning phase work?
- **Sources**: Requirements (2.1, 8.7), focus.md (item 15)
- **Findings**:
  - User activates workflow → planning panel opens
  - Optional "Generate from conversation" button calls Claude to suggest tasks
  - Planning query uses a `propose_fix_plan` custom tool for structured output
  - User reviews, edits, configures before confirming
  - The planning query is a one-shot operation (maxTurns limited), separate from the loop
- **Implications**: Planning is a separate API endpoint that returns a proposed plan. The plan generation query runs in the existing conversation (not a managed iteration conversation). The user sees the suggestion in a config panel and has full control to edit before starting.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Inline in prompt.ts | Add orchestrator logic directly to existing prompt module | No new modules | Bloats existing module, tight coupling, hard to test | Rejected |
| Dedicated module with shared helpers | New `ralph-loop/` module, reuses transcript/state/SSE helpers | Clean boundaries, testable, follows existing module pattern | Some code path duplication with prompt.ts | **Selected** |
| Generic orchestrator framework | Abstract framework with plugin system for workflow types | Future-proof | Premature abstraction, over-engineered for single workflow | Rejected per focus.md principle |

## Design Decisions

### Decision: Fresh Context Per Iteration (No SDK Session Resume)
- **Context**: Should iterations maintain SDK session continuity via `resume`?
- **Alternatives**: (1) Resume from previous session ID, (2) Fresh query each time
- **Selected Approach**: Fresh `query()` per iteration with no resume
- **Rationale**: LLM context degrades over long conversations. The fix plan state and worktree changes provide sufficient continuity. Each iteration gets a clean, focused context with just the objective and current task state.
- **Trade-offs**: Loses in-context learning from previous iterations; gains reliability and consistency

### Decision: MCP Server Tools Over canUseTool Interception
- **Context**: How to implement `report_status` and `update_fix_plan` custom tools
- **Alternatives**: (1) canUseTool interception of fake tool names, (2) MCP server tools
- **Selected Approach**: `createSdkMcpServer` with `tool()` definitions
- **Rationale**: This is the SDK's intended mechanism for custom tools. Provides proper tool registration, schema validation, and clean separation of concerns. canUseTool is reserved for permission gating.
- **Trade-offs**: Requires async generator prompt format; tools appear as `mcp__ralph-loop__report_status` internally

### Decision: Fire-and-Forget Orchestrator With GlobalThis Registry
- **Context**: How to run the long-lived orchestrator loop within Next.js
- **Alternatives**: (1) Per-request long-polling, (2) Separate process, (3) Fire-and-forget async with registry
- **Selected Approach**: Fire-and-forget async function stored in globalThis registry with AbortController and pause flag
- **Rationale**: Follows existing background job pattern. No external process management. Survives HMR. Supports pause/abort via shared state.
- **Trade-offs**: Loop state lost on server restart (mitigated by stale recovery). Single-server only (acceptable for CSM's local deployment model).

### Decision: Deny AskUserQuestion During Iterations
- **Context**: What happens if Claude tries to ask the user a question during an autonomous iteration?
- **Alternatives**: (1) Block and wait for user response, (2) Auto-deny, (3) Auto-respond with defaults
- **Selected Approach**: Auto-deny via `canUseTool` with instructive message
- **Rationale**: The loop is autonomous — blocking on user input defeats the purpose. Claude is instructed to make its best judgment. The deny message tells Claude to proceed without user input.
- **Trade-offs**: Claude may make suboptimal decisions without user guidance; mitigated by the circuit breaker detecting lack of progress

### Decision: Dual-Layer Session Locking
- **Context**: How to prevent concurrent access during loop execution while allowing pause
- **Alternatives**: (1) Hold session lock for entire loop, (2) Per-iteration lock + persisted status flag
- **Selected Approach**: Per-iteration in-memory lock + persisted workflow.status as UI-level gate
- **Rationale**: In-memory lock prevents actual concurrent SDK calls. Persisted status prevents the UI from offering prompt submission. On pause, both are released. On server restart, only persisted status matters (recovered to "paused").
- **Trade-offs**: Brief window between iterations where lock is released but status prevents action. Acceptable since the orchestrator immediately re-acquires.

## Risks & Mitigations
- **Risk**: Orchestrator loop lost on server restart → **Mitigation**: Stale recovery resets "running" to "paused"; user can resume from UI
- **Risk**: Claude ignores custom tool instructions → **Mitigation**: Default to exit_signal: false and status: in_progress when tool not called; circuit breaker catches stagnation
- **Risk**: Large SSE broadcast volume during streaming → **Mitigation**: CSM is single-user; broadcast volume is acceptable. Throttle if needed later.
- **Risk**: Planning phase generates poor task plan → **Mitigation**: User reviews and edits plan before confirming; optional generation, not mandatory
- **Risk**: Abort during iteration leaves dirty git state → **Mitigation**: Each iteration works in the session's worktree (already isolated); user can inspect and clean up

## References
- [Custom Tools - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- Existing CSM patterns: `prompt.ts`, `background-jobs.ts`, `lock.ts`, `sse-broadcaster.ts`, `schemas.ts`
