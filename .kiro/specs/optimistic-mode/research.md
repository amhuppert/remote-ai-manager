# Research & Design Decisions

## Summary
- **Feature**: optimistic-mode
- **Discovery Scope**: Extension
- **Key Findings**:
  - Session creation infrastructure already supports a discriminated union pattern (`fast`/`focus`) — adding `optimistic` extends the same schema, API route, and `provisionSession()` pipeline
  - Prompt execution completion is detectable inside `executePromptStream()` at the point where it emits `"done"` and sets status to `"awaiting"` — this is the hook point for automatic merge dispatch
  - The existing `dispatchMergeJob()` with `autoResolve: true` already implements the full commit-merge-resolve-squash pipeline needed for optimistic mode

## Research Log

### Existing Session Mode Architecture
- **Context**: Understand how fast/focus modes are implemented to find extension points
- **Sources Consulted**: `src/lib/sessions/schemas.ts`, `src/lib/sessions.ts`, `src/app/api/projects/[name]/sessions/route.ts`, `CreateSessionModal.tsx`
- **Findings**:
  - `sessionCreationModeSchema` is a `z.enum(["fast", "focus"])` — adding `"optimistic"` is a one-line change
  - `createSessionRequestSchema` is a `z.discriminatedUnion("mode", [...])` — new variant needed for optimistic
  - `provisionSession()` accepts `mode: SessionCreationMode` and `objective: string | null` — fully reusable
  - Focus mode uses `generateSessionName()` to derive session name from objective text via Haiku — same approach works for optimistic
  - Conversation `role` field distinguishes initialization conversations (`"initialization"` for focus) — optimistic needs no special role (uses `null`)
- **Implications**: Minimal schema and backend changes; optimistic mode piggybacks on existing provisioning

### Prompt Execution Completion Hook
- **Context**: Identify where to trigger automatic merge after Claude finishes
- **Sources Consulted**: `src/lib/prompt.ts`, `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/prompt/route.ts`
- **Findings**:
  - `executePromptStream()` runs the full prompt lifecycle: lock → query → stream → release
  - The function always returns to `finally` block which sets conversation status to `"awaiting"` and releases the lock
  - System prompt injection: `session.objective` is appended as `<objective>...</objective>` to the Claude Code preset — optimistic sessions can use this to carry the instructions
  - The `canUseTool` callback intercepts `AskUserQuestion` — for optimistic mode, this should auto-deny rather than block
- **Implications**: Two design options: (1) trigger merge from within `executePromptStream` when mode is optimistic, or (2) use a wrapper in the session creation API that awaits prompt completion then dispatches merge. Option 2 (orchestrator function) is cleaner — keeps prompt.ts generic.

### Smart Merge Pipeline
- **Context**: Verify the merge pipeline works for automatic dispatch
- **Sources Consulted**: `src/lib/background-jobs.ts`, merge route
- **Findings**:
  - `dispatchMergeJob()` is a pure function taking `{ projectPath, projectName, sessionName, worktreePath, branchName, message, autoResolve }` — no HTTP dependency
  - With `autoResolve: true`: commits WIP → merges main → resolves conflicts via Claude → squash merges into main → marks session finished
  - Terminal states create notifications via `persistTerminalState()` → `createNotification()` — users are informed of success/failure
  - `setSessionFinished()` marks the session as `finished: true` — optimistic sessions naturally end up in merged state
- **Implications**: `dispatchMergeJob()` can be called directly from server-side code after prompt completion — no API roundtrip needed

### UI Entry Points
- **Context**: Identify where optimistic mode dialog should appear
- **Sources Consulted**: `CreateSessionModal.tsx`, `SessionsList.tsx`, app router structure
- **Findings**:
  - `CreateSessionModal` uses a `mode` toggle with two buttons (Fast/Focus) — extending to three buttons is straightforward
  - Voice input (`useVoiceRecorder`) is available in focus mode with fire-and-forget support — reusable for optimistic mode
  - Sessions list shows mode badges (`session.creationMode`) — new `"optimistic"` badge needed
  - `session-mode-toggle` CSS class handles button styling — existing pattern supports N buttons
- **Implications**: The optimistic tab in CreateSessionModal reuses the same textarea + voice pattern as focus mode; standalone dialog is a separate lightweight component

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Server-side orchestrator | New `createSessionOptimistic()` that provisions session, fires prompt, then dispatches merge on completion | Clean separation, no new API endpoints for the pipeline, all logic in one place | Long-running server-side operation (prompt can take minutes) | Preferred — fire-and-forget pattern already used by background jobs |
| Client-side orchestration | Client creates session, sends prompt, polls for completion, then triggers merge | Simpler server code | Fragile — depends on browser staying open; race conditions | Rejected — defeats fire-and-forget goal |
| Event-driven (SSE listener) | Server listens for own SSE events to trigger merge | Decoupled | Over-engineered; SSE is for client push, not server-internal signaling | Rejected — unnecessary indirection |

## Design Decisions

### Decision: Server-Side Orchestrator Pattern
- **Context**: Optimistic mode must be fire-and-forget — user submits and walks away
- **Alternatives Considered**:
  1. Client-side orchestration — browser polls and triggers merge
  2. Server-side orchestrator — single function coordinates session → prompt → merge
- **Selected Approach**: Server-side orchestrator function `executeOptimisticWorkflow()` that runs in a fire-and-forget async pipeline
- **Rationale**: Matches the existing `dispatchMergeJob()` pattern (fire-and-forget Promises); no dependency on client connection; all coordination logic is server-side
- **Trade-offs**: The prompt execution runs outside an HTTP request context (no SSE stream to a specific client), but transcript storage and SSE broadcasts still function via `broadcast()`
- **Follow-up**: The orchestrator must handle prompt failures gracefully — create a notification on error instead of leaving the session in limbo

### Decision: Reuse Existing Prompt Execution
- **Context**: How to execute the prompt without an HTTP SSE stream
- **Selected Approach**: Call `executePromptStream()` with a no-op `emit` callback. The function already handles all SDK interaction, transcript writing, and conversation state management internally. SSE broadcasts happen via `broadcast()` regardless.
- **Rationale**: Avoids duplicating prompt lifecycle logic; all transcript and state management is already handled
- **Trade-offs**: The `emit` callback goes unused, but this is a minimal cost

### Decision: Suppress AskUserQuestion in Optimistic Mode
- **Context**: Claude may attempt to ask questions via `AskUserQuestion` tool — optimistic mode must not block on user input
- **Selected Approach**: Use the system prompt `append` to instruct Claude not to ask questions. Additionally, the orchestrator's prompt execution can override `canUseTool` to auto-deny `AskUserQuestion`.
- **Rationale**: Belt-and-suspenders — instruction reduces likelihood, tool override prevents deadlock
- **Follow-up**: Need to determine exact mechanism — either a custom `executePromptStream` variant or a configuration flag

### Decision: Optimistic Tab in Existing Modal + Standalone Dialog
- **Context**: UI entry points for optimistic mode
- **Selected Approach**: Add "Optimistic" tab to CreateSessionModal; additionally, expose a global hotkey/button component for quick access from any project page
- **Rationale**: Dual entry points per requirements (2.1, 1.1) — modal for discoverability, standalone for speed

## Risks & Mitigations
- **Risk**: Prompt execution fails silently in fire-and-forget — user never learns about failure
  - **Mitigation**: Orchestrator catches all errors and creates a notification via `createNotification()` with error details
- **Risk**: Merge conflicts that can't be auto-resolved leave the session in a limbo state
  - **Mitigation**: Existing merge pipeline already handles this — creates a "conflicts" notification; user can manually intervene
- **Risk**: Long-running prompts consume resources without user awareness
  - **Mitigation**: Existing `claudeTimeoutMs` safety net applies; session visible in sessions list with running status
- **Risk**: Claude asks a question despite system prompt instructions, causing the session to stall in `waiting_for_input`
  - **Mitigation**: Override `canUseTool` for `AskUserQuestion` to return a deny/auto-answer response

## References
- `@anthropic-ai/claude-agent-sdk` — `query()` API for prompt execution
- `src/lib/background-jobs.ts` — fire-and-forget pattern and `dispatchMergeJob()`
- `src/lib/sessions.ts` — `provisionSession()` and `generateSessionName()` reusable for optimistic mode
- `src/lib/prompt.ts` — `executePromptStream()` handles full prompt lifecycle
