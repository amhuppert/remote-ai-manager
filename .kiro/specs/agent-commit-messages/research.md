# Research & Design Decisions — agent-commit-messages

## Summary

- **Feature**: `agent-commit-messages`
- **Discovery Scope**: Extension (integration-focused discovery of existing commit, merge, prompt, and queue subsystems)
- **Key Findings**:
  - Both background machines take the commit/squash message as a plain input (`CommitInput.message`, `MergeInput.message`); no machine change is needed to swap the message source.
  - `executeWorkflowTaskRun` (`src/lib/workflows/conversation/execute-workflow-task-run.ts`) is the existing primitive for running a structured-output agent turn inside a conversation — already used by conflict-resolution and validation-fix, transcript-visible, gate-validated, backend-agnostic.
  - The queued-message drain path (`manager.ts` `drainConversationQueue`) sends `SUBMIT_PROMPT` directly to the conversation machine, **bypassing** `executePromptStream` where `/collab` interception lives. Command interception therefore needs a shared orchestrator callable from both entry points.

## Research Log

### /collab interception pattern

- **Context**: `/commit` and `/merge` need an interception precedent.
- **Sources Consulted**: `src/lib/prompt/sdk-driver.ts:470-626`, `src/lib/prompt/route-handlers.ts:169-197, 405-417`.
- **Findings**: `hasCollabPrefix`/`stripCollabPrefix` detect the command on the trimmed prompt inside `executePromptStream`; the collab branch dispatches to the collaboration manager and returns early with a `collab-started` SSE event. `executePromptStream` accepts `options.outputFormat` and returns `structuredOutput` in `PromptStreamResult`.
- **Implications**: Same detection point works for `/commit`/`/merge` on the direct path; early-return-and-orchestrate is the proven shape.

### Structured-output turns from server code

- **Context**: Requirement 3 needs an in-conversation generation turn.
- **Sources Consulted**: `execute-workflow-task-run.ts:120-144`, `src/lib/sessions/conflict-resolution.ts:43-56`, `src/lib/workflows/validation-fix.ts:31-41`.
- **Findings**: `executeWorkflowTaskRun(input)` takes `prompt`, optional `systemInstructions`, `outputFormat` (JSON schema), `timeoutMs`, origin provenance; returns a discriminated `TaskRunResult` (`structured` | `text` | `error`). Turns append transcript entries (broadcast via `message-appended` SSE) and run through the conversation actor (single-flight respected). Structured output is validated by the workflow gate, which also covers backends without native schema enforcement (Requirement 3.7).
- **Implications**: Adopt as-is; no new turn-execution machinery.

### Queue and drain mechanics (Requirement 8)

- **Context**: Commands submitted mid-turn must queue and run after the active turn, never reaching the agent as text.
- **Sources Consulted**: `src/hooks/use-send-prompt.ts:279-305`, `src/lib/prompt/queue.ts:163-315`, `src/lib/workflows/conversation/manager.ts:210-292`, `actor-implementations.ts:1281, 1689-1706`.
- **Findings**: Busy conversations route to a separate `/queue` endpoint. `queueMessage` chooses delivery timing from backend capability: `in_turn` attempts live delivery into the running turn via `runtime.queueUserInput`; otherwise rows stay pending. On machine idle entry, `drainConversationQueue` claims a batch (`claimNextTurnBatch`), coalesces text with `\n`, and sends `SUBMIT_PROMPT` **directly to the actor** — `executePromptStream` is not involved.
- **Implications**: (a) command messages must force `next_turn` handling at `queueMessage` time or they leak into the active turn; (b) batch claiming must treat command messages as batch boundaries; (c) the drain must route command entries to the shared orchestrator instead of `SUBMIT_PROMPT`.

### Eligibility checks and dispatch contracts

- **Sources Consulted**: `src/lib/git/commits.ts:47-54`, `src/lib/git/route-handlers.ts:199-375`, `src/lib/jobs/queue.ts:509-688`.
- **Findings**: `hasUncommittedChanges(worktreePath)` exists; `session.finished` checked in route handlers; `dispatchCommitJob`/`dispatchMergeJob` return `Result` with `SESSION_BUSY`/`JOB_ALREADY_RUNNING` errors; merge target resolution (child-branch merges → `targetBranch`/`targetWorktreePath`) currently lives inline in `mergeSession` route handler.
- **Implications**: Pre-checks can run deterministically before spending an agent turn (agent-offloading principle); merge target resolution should be extracted for reuse by the command orchestrator instead of duplicated.

### Surfacing notices in the conversation

- **Sources Consulted**: `src/lib/prompt/transcript.ts:188-232`, `src/lib/notifications/repo.ts`.
- **Findings**: `appendTranscriptEntry` broadcasts `message-appended` SSE only for non-empty `user`/`assistant` entries; there is no system/info entry kind today. Notifications are UI-level (toasts/history), not conversation-visible.
- **Implications**: Requirements 1.4–1.7, 2.6, 4.4 ("explanatory message in the conversation") need a small transcript extension: a CC-authored notice entry kind, broadcast and rendered distinctly.

### UI removal targets and autocomplete

- **Sources Consulted**: `src/features/session/git/SessionGitPanel.tsx:149-162`, `CommitDialog.tsx`, `src/features/session/dialogs/SmartMergeDialog.tsx`, `src/lib/git/mutations.ts`, `src/features/session/prompt/PromptEditorSlashCommandPopup.tsx:26-33`.
- **Findings**: `useCommitMutation` and `useSmartMergeMutation` have no callers besides the two dialogs. Built-in commands are an inline `BUILT_IN_CLAUDE_COMMANDS` constant (`CommandItem` has `name`, `description`, `type`, `source`, `argumentHint?`).
- **Implications**: Clean removal with no orphaned consumers; autocomplete addition is two constant entries.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Generate-then-dispatch via shared orchestrator (chosen) | Detect command at both entry points; one service runs checks → generation turn (`executeWorkflowTaskRun`) → existing job dispatch | Machines untouched; single seam serving direct + queued paths; composes existing primitives | Route-level conversation lock vs task-run interplay needs verification | Matches `/collab` precedent and user's explicit architecture choice |
| Transform-and-continue in `executePromptStream` | Rewrite the intercepted turn into a generation turn with `outputFormat`, dispatch job after stream returns | Full token streaming of generation turn | Drain path bypasses `executePromptStream`, so queued commands would need a second, divergent implementation; post-turn hook awkward | Rejected: violates single-seam goal |
| Machine-internal `generatingMessage` state | Dispatch job first; machines invoke a turn actor for the message | Retries/fallback in machine | Structural changes to two stable machines; user explicitly chose against | Rejected in discovery |

## Design Decisions

### Decision: One shared command orchestrator, collab-style early return

- **Context**: Interception must behave identically for direct submissions and queued commands (Requirement 8.3), but the two paths converge only at the conversation machine, not at `executePromptStream`.
- **Alternatives Considered**: 1. Transform-and-continue inside `executePromptStream`; 2. Duplicate logic at drain site.
- **Selected Approach**: New domain `src/lib/conversation-commands/` exposing a factory-built service; `executePromptStream` (direct path) and `drainConversationQueue` (queued path) both call it.
- **Rationale**: Single responsibility seam; no machine changes; reuses `executeWorkflowTaskRun` which already solves turn execution, transcript visibility, structured-output gating, and backend differences.
- **Trade-offs**: Generation turn streams via transcript-append broadcasts (message-level), not token-level streaming; accepted as "displayed like a normal agent turn".
- **Follow-up**: Integration-verify the route-level conversation lock does not block the task-run turn (collab precedent suggests it does not).

### Decision: Command-aware queue handling (force next_turn + batch boundaries)

- **Context**: Requirement 8 — queued commands run after the active turn; literal text never delivered to the agent.
- **Selected Approach**: `queueMessage` detects command messages with the shared parser and forces pending/next-turn handling (skips live in-turn delivery). Batch claiming stops before a command message; a command entry is claimed alone and routed to the orchestrator by the drain.
- **Rationale**: Preserves submission ordering; no DB schema change (detection from message text at queue/claim time).
- **Trade-offs**: A command in the middle of queued messages splits the batch into multiple turns; acceptable and arguably more correct.
- **Follow-up**: Unit-test mixed batches (text → command → text ordering).

### Decision: System notice transcript entries

- **Context**: Rejections and fallback notices must appear "in the conversation" (Requirements 1.4–1.7, 2.6, 4.4) on both entry paths, including when no HTTP stream is attached (queued path).
- **Alternatives Considered**: 1. SSE-only error events (invisible on queued path, not durable); 2. Notifications only (not conversation-visible); 3. Assistant-role transcript entries (misattributes CC system text to the agent).
- **Selected Approach**: A CC-authored notice entry kind in the transcript, broadcast over the existing conversation SSE channel and rendered distinctly in the message list.
- **Rationale**: Durable, visible on both paths, survives reloads.
- **Trade-offs**: Touches transcript schema and message renderer; kept minimal (one new entry kind).

### Decision: Keep HTTP commit/merge routes; remove only UI triggers

- **Context**: Requirement 7 removes user-facing triggers; the orchestrator calls `dispatchCommitJob`/`dispatchMergeJob` directly (server-side), not via HTTP.
- **Selected Approach**: Delete buttons, dialogs, and their two mutations; leave `POST .../commit` and `POST .../merge` route handlers in place (API surface, used by tests/automation; land/discard routes unaffected).
- **Rationale**: Brief decision; avoids breaking non-UI consumers; removal can be revisited separately.

### Decision: Deterministic pre-checks before the generation turn

- **Context**: Requirements 1.4–1.7, 2.6 and the agent-offloading principle.
- **Selected Approach**: Session-resolution, finished, active-job, and (commit-only) uncommitted-changes checks run before `executeWorkflowTaskRun`; a rejected command never spends an agent turn. Dispatch `Result` errors still handle the check→dispatch race.
- **Rationale**: Binary, reproducible checks belong in code, not prompts; saves cost and latency on rejections.

### Decision: Fallback messages

- **Selected Approach**: merge → `Merge ${branchName} into ${targetBranch}` (today's text); commit → `Changes from session ${sessionName}`. Fallback use is logged and surfaced via a notice entry.

### Synthesis outcomes

- **Generalization**: `/commit` and `/merge` are two variants of one "conversation git command" — modeled as a discriminated union (`ParsedConversationCommand`) through one parser, one orchestrator, one generation module. Interface supports future commands; implementation scope stays at two.
- **Build vs adopt**: everything turn-, job-, transcript-, and queue-related is adopted from existing primitives; only the parser, generation prompt/schema, orchestrator glue, queue command-awareness, and notice entry are built.
- **Simplification**: no new state machine, no new HTTP routes, no DB migration, no command registry abstraction, no per-command config.

## Risks & Mitigations

- Route-level conversation lock could block the orchestrator's task-run turn on the direct path — mitigate with an integration test mirroring the `/collab` flow before building on it (earliest implementation task).
- Transcript renderer may break on the new notice entry kind if any consumer assumes `user`/`assistant` only — mitigate by extending the Zod transcript schema first and grepping consumers.
- Agent may attempt tool use during the generation turn despite instructions — bounded by `timeoutMs` and the structured-output gate; acceptable.
- Mixed queued batches (text + command interleavings) — covered by ordering unit tests on the claim logic.
- Merge target resolution extraction from `mergeSession` route handler must not change route behavior — covered by existing route tests plus extraction-equivalence test.

## Implementation Notes from Final Review

- `claimNextTurnBatch` is implemented in `src/lib/conversations/message-queue-service.ts` (`claimNextTurnBatchTransform`), consumed via deps in `manager.ts` — the command-aware claim boundary logic for task 4.3 lands there, not in `src/lib/prompt/queue.ts`.
- `route-handlers.ts` constructs `mergeMessage` at three sites (merge ~327, conflict-resolution ~419, land ~585). Task 2.2's resolver extraction targets only the `mergeSession` site; the conflict-resolution and land flows are out of scope and keep their own message construction.

## References

- `src/lib/prompt/sdk-driver.ts` — `/collab` interception precedent and `PromptStreamOptions`.
- `src/lib/workflows/conversation/execute-workflow-task-run.ts` — structured-output turn primitive.
- `src/lib/workflows/conversation/manager.ts` — idle-entry queue drain.
- `src/lib/jobs/queue.ts` — `dispatchCommitJob` / `dispatchMergeJob` contracts.
- `.kiro/specs/agent-commit-messages/brief.md` — discovery decisions (trigger UX, fallback policy, scope cuts).
- `.kiro/steering/engineering-principles.md` — composable primitives, agent-offloading, DI patterns.
