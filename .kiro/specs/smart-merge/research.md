# Research & Design Decisions: Smart Merge

## Summary
- **Feature**: smart-merge
- **Discovery Scope**: Complex Integration (new background job system + two-phase merge pipeline + Claude SDK conflict resolution + SSE extension + 4 UI components)
- **Key Findings**:
  - The `fix-merge-conflicts` skill exists as a plugin skill with a 5-phase workflow (analyze → understand intent → plan → propose → implement). It requires human approval before implementing. For programmatic use, phases 1-4 map to structured output generation and phase 5 maps to direct file editing by Claude.
  - The Claude Agent SDK `query()` returns `SDKMessage` objects. The `result` message type contains the final output. Structured JSON can be extracted from assistant text blocks by instructing Claude via system prompt to output a JSON code fence with a specific schema. No native structured output mode exists in the SDK — the approach is prompt-based extraction.
  - The existing session lock (`acquireSessionLock`) returns a `release()` closure that is callable from any async context. This works for background jobs without modification — the closure captures the lock key and can be called from within the background job's `.then()` or `finally`.

## Research Log

### Fix-Merge-Conflicts Skill Adaptation
- **Context**: Requirement 6 specifies Claude-powered conflict analysis with structured output. The existing `fix-merge-conflicts` skill provides the conflict resolution workflow.
- **Sources Consulted**: `~/.claude/plugins/cache/ai-resources/ai-resources/1.9.0/skills/fix-merge-conflicts/SKILL.md`
- **Findings**:
  - The skill has 5 phases: Analyze Changes, Understand Intent, Plan Resolution, Propose Resolution, Implement
  - Phase 1 uses `git diff --name-only --diff-filter=U` to list conflicted files — this is the same command needed for the two-phase merge conflict detection
  - Phase 4 produces per-file: summary, recommended approach, reasoning, risks — this maps directly to the `ConflictEntry { file, description, resolution, rationale }` schema
  - Phase 5 edits files to remove conflict markers and stages with `git add`
  - The skill expects interactive human approval between phases 4 and 5
  - For programmatic use: combine phases 1-4 into the conflict analysis prompt (structured output), and phase 5 into a separate "apply resolution" step. The prompt instructs Claude to both resolve conflict markers AND produce structured JSON analysis.
- **Implications**: The conflict resolution prompt adapts the skill's workflow but removes the interactive approval gate. Instead, Claude resolves conflicts in the working tree directly while also outputting structured JSON analysis for the UI to display.

### Claude Agent SDK Structured Output Extraction
- **Context**: Need to extract `ConflictEntry[]` JSON from Claude's `query()` response stream.
- **Sources Consulted**: Existing `prompt.ts` implementation, SDK message type handling
- **Findings**:
  - `query()` yields `SDKMessage` objects with types: `system` (init), `assistant` (text/tool_use blocks), `user` (tool_result), `result` (final)
  - The `result` message contains `subtype: "success"` or `"error"` and aggregated cost/duration data but NOT the content
  - Assistant text blocks contain the actual output. To extract structured JSON: instruct Claude via system prompt to include a JSON code fence with a specific schema as part of its final response
  - The existing `processMessage()` in `prompt.ts` shows how to extract text from `message.content` blocks of type `"text"`
  - For conflict resolution: iterate the full `query()` stream, accumulate all assistant text blocks, then parse the last JSON code fence from the accumulated text
  - Alternative: use a low `maxTurns` value (e.g., unlimited) to allow Claude to use tools (Read, Edit, Bash) for multi-step conflict resolution, collecting the final text output
- **Implications**: The conflict resolution function uses `query()` with full tool access (Read, Edit, Bash, Glob, Grep), a system prompt instructing JSON output, and post-processing to extract the structured result from assistant text blocks.

### Background Job Lock Semantics
- **Context**: Background jobs need to hold the session lock across an async execution that outlives the HTTP response.
- **Sources Consulted**: `src/lib/lock.ts`
- **Findings**:
  - `acquireSessionLock()` stores a `Promise<void>` in a `Map<string, Promise<void>>` keyed by `projectPath::sessionName`
  - Returns a `release()` closure that does `activeLocks.delete(key)` and resolves the promise
  - The closure is a plain function with no scope dependency on the caller's execution context
  - `isSessionBusy()` checks `activeLocks.has(key)` — returns `true` while any holder (prompt or job) has the lock
  - The lock was designed for prompt scope but works identically for background jobs: acquire in the route handler, pass the `release` closure into the background job, call it in the job's `finally` block
- **Implications**: No modifications needed to `lock.ts`. Background jobs acquire the same lock, preventing concurrent prompt + job execution on the same session.

### SSE Event Extension Pattern
- **Context**: Need to add `job-status` SSE event type alongside existing `conversation-status` and `ask-question` types.
- **Sources Consulted**: `src/lib/sse-broadcaster.ts`, `src/lib/schemas.ts`
- **Findings**:
  - `broadcast(event: SSEEvent)` serializes as `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  - Client-side `NotificationListener.tsx` uses `es.addEventListener("conversation-status", ...)` — type-specific listeners
  - Adding a new event type requires: (1) new Zod schema in schemas.ts, (2) extend SSEEvent union type, (3) add listener in NotificationListener.tsx
  - The broadcaster itself needs no modification — it uses `event.type` dynamically
- **Implications**: Minimal change to extend SSE infrastructure. Define `jobStatusEventSchema`, add to `SSEEvent` union, add `es.addEventListener("job-status", ...)` in NotificationListener.

### Notifications Panel Integration Strategy
- **Context**: Gap analysis flagged a design decision: replace UnifiedPanel, add second button, or merge both panels.
- **Sources Consulted**: `src/components/Topbar.tsx`, `src/components/NotificationsPanel.tsx`, unified-panel store
- **Findings**:
  - UnifiedPanel shows active conversations with inline status
  - NotificationsPanel shows conversations AND jobs with more metadata (timestamps, status badges, navigation)
  - NotificationsPanel is a superset of UnifiedPanel's conversation functionality
  - The Topbar has one panel toggle button with a badge showing active conversation count
- **Implications**: Replace UnifiedPanel with NotificationsPanel. The NotificationsPanel already supports conversation items, so this is a direct replacement that adds job tracking without losing existing functionality. The Topbar badge extends to include active job count.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Fire-and-forget Promise in route | Route spawns un-awaited Promise, stores in module Map | Minimal new code | Route handlers become complex, no clear job lifecycle | Rejected: mixes concerns |
| Dedicated background-jobs module | New `background-jobs.ts` owns all job state and execution | Clean separation, testable, follows globalThis singleton pattern | More files | Selected: matches existing patterns (sse-broadcaster, abort-registry) |
| External job queue (Bull, etc.) | Use Redis-backed job queue | Persistence, retry, scaling | Massive overkill for in-process single-server app | Rejected: violates "no database" architecture |

## Design Decisions

### Decision: Background Job Module Architecture
- **Context**: Need a system to run commit/merge operations asynchronously and track their lifecycle
- **Alternatives Considered**:
  1. Inline background logic in route handlers
  2. Dedicated `background-jobs.ts` module with `globalThis` registry
  3. External job queue library
- **Selected Approach**: Dedicated module (`src/lib/background-jobs.ts`) with `globalThis` Map for job registry, following the established singleton pattern used by `sse-broadcaster.ts` and `abort-registry.ts`
- **Rationale**: Clean separation of concerns. Routes validate and dispatch; the job module owns execution, state transitions, and SSE broadcasting. The `globalThis` pattern prevents HMR-related state loss in development.
- **Trade-offs**: More files (+1 module), but routes become simpler thin dispatchers
- **Follow-up**: Verify that `globalThis` cleanup handles edge cases (server restart with stale jobs)

### Decision: Shared Session Lock for Jobs
- **Context**: Background jobs must prevent concurrent operations on the same session
- **Alternatives Considered**:
  1. Share existing `acquireSessionLock()` — same lock for prompts and jobs
  2. Separate job-specific lock alongside prompt lock
- **Selected Approach**: Share existing `acquireSessionLock()` — jobs acquire the same lock that prompts use
- **Rationale**: Simplest approach. Prevents all concurrent prompt + job scenarios automatically. The lock's `release()` closure works from any async context.
- **Trade-offs**: A running prompt blocks job submission and vice versa. This is the desired behavior — the session should never have concurrent git operations.
- **Follow-up**: None — existing lock semantics are sufficient

### Decision: Conflict Resolution via Claude Agent SDK query()
- **Context**: Need Claude to resolve conflict markers in working tree files AND produce structured analysis
- **Alternatives Considered**:
  1. Prompt-only approach (instruct JSON output in system prompt, parse from assistant text)
  2. Tool-based extraction (define a custom tool that Claude calls with structured data)
  3. Two-pass approach (first pass resolves files, second pass generates analysis)
- **Selected Approach**: Single `query()` call with full tool access (Read, Edit, Bash, Glob, Grep). The system prompt instructs Claude to: (1) analyze all conflicts, (2) resolve conflict markers by editing files directly, (3) output a JSON code fence with the structured `ConflictEntry[]` analysis as the final step. Post-process the stream to extract JSON from assistant text blocks.
- **Rationale**: Matches how the existing `fix-merge-conflicts` skill works. Claude needs file access tools to properly understand and resolve conflicts. A single pass is more efficient and ensures the analysis matches the actual resolution applied.
- **Trade-offs**: JSON extraction from free-form text is slightly fragile. Mitigation: use a well-defined code fence marker (````json\n`) and validate with Zod `safeParse`.
- **Follow-up**: Define the exact system prompt template. Consider fallback behavior when JSON extraction fails (treat as resolution failure, notify user for manual review).

### Decision: Replace UnifiedPanel with NotificationsPanel
- **Context**: Both panels show real-time activity; NotificationsPanel is a superset
- **Alternatives Considered**:
  1. Keep both panels with separate toggle buttons
  2. Merge NotificationsPanel features into UnifiedPanel
  3. Replace UnifiedPanel with NotificationsPanel
- **Selected Approach**: Replace UnifiedPanel with NotificationsPanel
- **Rationale**: NotificationsPanel already supports conversation items with all the metadata UnifiedPanel shows, plus adds job tracking. Two separate panels would confuse users. Replacing avoids maintaining two overlapping components.
- **Trade-offs**: UnifiedPanel's inline conversation preview (status chips) may need to be preserved in NotificationsPanel's conversation items. Verify feature parity before removal.
- **Follow-up**: Ensure NotificationsPanel conversation items show the same information as UnifiedPanel items (status, click-to-navigate)

### Decision: In-Memory Job State (No Persistence)
- **Context**: Background jobs need state tracking. Options: in-memory only vs. persisted to state.json
- **Alternatives Considered**:
  1. In-memory only (lost on server restart)
  2. Persisted to state.json (survives restart)
- **Selected Approach**: In-memory only with stale job recovery on startup
- **Rationale**: Jobs are short-lived (seconds to minutes). Server restarts are rare in development. If the server restarts mid-job, the git operation is already in-flight and cannot be resumed — the recovery strategy is to detect stale state (merge-in-progress worktree) and offer manual resolution, similar to `recoverStaleConversations()`.
- **Trade-offs**: A job in progress during server restart is lost. Acceptable because the underlying git operation either completed (detectable via worktree state) or failed (cleanup needed regardless).
- **Follow-up**: Add startup recovery that detects worktrees in merge conflict state and surfaces them in the UI

## Risks & Mitigations
- **Claude fails to produce valid JSON** — Mitigation: Zod `safeParse` with fallback to treating the resolution as successful (files were edited) but without structured analysis (user directed to manual review)
- **Claude resolves conflicts incorrectly** — Mitigation: The manual conflict review page allows per-conflict rejection with feedback. Auto-resolve users can also navigate to the review page if results are unsatisfactory
- **Background job outlives server process** — Mitigation: In-memory job registry is lost, but the git worktree state (conflict markers, staged files) persists on disk. Startup recovery detects and surfaces these states
- **Pre-commit hooks block indefinitely** — Mitigation: Apply the existing `claudeTimeoutMs` config timeout pattern to background commit/merge jobs. Default to a generous timeout (10 minutes) that covers test suites

## References
- `fix-merge-conflicts` skill: `~/.claude/plugins/cache/ai-resources/ai-resources/1.9.0/skills/fix-merge-conflicts/SKILL.md`
- Claude Agent SDK `query()` usage: `src/lib/prompt.ts`
- SSE broadcaster pattern: `src/lib/sse-broadcaster.ts`
- Session lock implementation: `src/lib/lock.ts`
- globalThis singleton pattern: `src/lib/sse-broadcaster.ts`, `src/lib/abort-registry.ts`
