# Graph workflow execution — data source map

Everything a workflow execution leaves behind, and how to query it by hand
when the `workflow:audit` extractor isn't enough. All paths are under the
CC config dir (`~/Library/Application Support/cc` on macOS, `cc-dev` for
`CC_ENV=dev`, `$XDG_CONFIG_HOME/cc` on Linux; `CC_CONFIG_DIR` overrides).
**Read-only** — open SQLite with `sqlite3 "file:<config-dir>/command-center.db?mode=ro"`.

## 1. SQLite (`command-center.db`, WAL)

### `graph_workflow_executions` — active/latest execution per session
One row per (project_path, session_name). Completed runs often remain here
until a new run replaces them (the old one is then archived).

- `execution_id`, `status` (`pending|running|paused|completed|halted|aborted`), `started_at`, `completed_at`
- `definition_json` — static tier: `id`, `seedDefinitionId`, `seedDefinitionRevision`,
  `boundInputs`, `launchedTier`, `workingDefinition` (`executionContexts[]` with
  `id`, `title`, `acceptanceCriteria`, `placement` (`lane`, `mode`
  `full|owned|readOnly`, `ownedPaths` when owning), `implementer`,
  `contextValidator`, `scriptValidator`, `humanApprovalGate`, `iterationPolicy`,
  `circuitBreaker`, `mutability`; plus `tasks[]`, `edges[]`), `charter`.
  `placement` is where a context runs and what it may write, so it is the field
  to read first when auditing lane cost, concurrency, or an ownership halt:
  members of one authored lane share a worktree and a single fan-in join, and
  read-only contexts are provisioned nothing at all. Definitions stored before
  placement existed are migrated at their inflate boundary, so a row read
  through the repository always carries it.
- `runtime_json` — hot tier:
  - `contextStates{}`: per context — `status`, `iterationCount`,
    `consecutiveFailureCount`, `completedTaskCount`/`totalTaskCount`,
    `worktreePath`, `branchName`, `laneId`, `mergeStatus`, `lastMergeError`,
    `pendingApproval` (`requestedAt`, `decision.decidedAt`),
    `pendingUserInput` (`questions`, `requestedAt`, `answers.answeredAt`)
  - `taskStates{}`: `status`, `startedAt`/`completedAt`, `summary`,
    `lastConversationId`, `failureMessage`, `failureHistory[]`
  - `laneStates{contextId}{lane}`: engine, `sessionRef.conversationId`,
    claude: `lastContextTokens`/`lastContextWindowMax`; codex: `lastTurnUsage`
    (input/cached/output tokens). Only the **latest** conversation per lane.
  - `executionLanes{}`: branch, worktree, `commitSnapshots[]`
    (`{contextId, sha, committedAt}`) — survives lane cleanup
  - `joins{}`: merge fan-ins — `status`, `conflicts.files`, `errorMessage`
  - `haltReason` / `pendingHaltReason` / `secondaryHaltReasons` — discriminated
    by `type`: `circuit_breaker`, `max_iterations`, `recovery_error`,
    `validator_infra_error`, `script_validator_missing_command`,
    `merge_failure`, `join_failure`, `merge_precondition_failed`,
    `agent_turn_failed`, `worktree_creation_dirty`, `execution_loop_failed`,
    `collaboration_failure`, `aborted`
  - `sharedDocuments[]`, `pendingCollaborations{}`, `collaborationContinuations{}`

Canonical schema: `src/lib/workflow-graph/schemas.ts` (`graphWorkflowExecutionSchema`).

### `graph_workflow_archived_executions`
Prior runs per session: `execution_id`, `archived_at`, `status`,
`execution_json` (full execution snapshot, same shape as merged tiers).

### `graph_workflow_events` — the durable event log
`occurred_at`, `event_type`, `context_id`, `pre_reset` (1 = before a context
reset), `event_json`. Ordered by `id`. Event types (17):
status, context-status, task-status, **validation-result** (`pass`,
`summary`, `issues[]`, `reopenTaskIds`, `sessionRef.conversationId`,
codex `reviewArtifact.usage{inputTokens,cachedInputTokens,outputTokens}`),
circuit-breaker, shared-documents-updated, pending-halt-reason, merge-status,
batch-scheduled, lane-status, join-status, **approval-pending/-resolved**
(`requestedAt` / `decision`+`decidedAt`), **user-input-pending/-resolved**
(`requestedAt` / `resolution`+`resolvedAt`), charter-registered/-updated.

```sql
SELECT occurred_at, event_type, context_id FROM graph_workflow_events
WHERE execution_id = ? ORDER BY id;
```

### `conversations` — cost/timing grain
`id`, `role`, `total_cost_usd`, `total_duration_ms`, `total_turns`,
`context_tokens`, `context_window_max`, `transcript_path`, `agent_backend`.
Costs accrue per conversation lifetime — not per iteration. Rows written
before the accrual fix over-count any conversation that had follow-ups
(the SDK's cumulative `total_cost_usd` was consumed as a per-turn delta);
recompute from the transcript (section 3) — the extractor does this
automatically and reports `cost_mismatch` + a corrected total.

### `sessions`
`worktree_path`, `branch_name` (`csm/<session>`); lane worktrees:
`<project>/.worktrees/<session>.<laneId>` on `csm/<session>-<laneId>`.

## 2. Execution logs — `workflow-logs/<executionId>/`

Written live by `src/lib/workflow-graph/execution-logger.ts`. Every record:
`{timestamp, event, executionId, contextId?, …}`.

- `_manifest.json` — definition snapshot + per-context iteration/task counts
  + file index. Start here.
- `lifecycle.jsonl` — execution started/resumed/paused/completed/halted,
  merge.retry_attempted, shared_document.created/updated. Halt/pause/resume
  records carry `actor` (`system`/`operator`); `execution.resumed` echoes
  `resolvedHaltType`/`resolvedHaltContextId` so halt→resume pairs (operator
  recovery wait) are verifiable.
- `decisions.jsonl` — context.scheduled, `rotation.scheduled` (emitted once
  per pending rotation, on the flag's false→true transition),
  `implementer.rotation` / `validator.rotation` (applications; reason
  `context_changed` is a lane switch, not a real rotation),
  max_iterations.reached: the scheduler's choices.
- `contexts/<contextId>/`
  - `iterations.jsonl` — `iteration.started` (`iterationNumber`, `modelId`,
    `parameterIds`, `incompleteTaskIds`), `iteration.conversation_resolved`
    (`conversationId` — recovers rotated conversations),
    `iteration.prompt_sent` (`promptLength`, `promptMode`),
    `iteration.agent_turn_completed` (`contextTokens`, `contextWindowMax`,
    `occupancyMeasurable`, `cumulativeCostUsd`, `costUsdDelta` — per-turn
    billing from the conversation transcript),
    `iteration.follow_up_sent/skipped`, `iteration.completed`
    (`completedTaskCount`, `remainingTaskCount`, `consecutiveFailureCount`)
  - `tasks.jsonl` — completion attempts, validation passed/failed,
    added_by_agent, reopened
  - `validation.jsonl` — validator started/invoked/result_parsed/remediation;
    `script_validation.passed/failed` carry `headSha`, `dirty`, `command` —
    the tree identity the gate result certifies
  - `prompts/iteration-<n>.md` — exact implementer seed prompt
  - `validators/<assignmentId>/` — one directory per cohort member:
    - `context-validator.md` + `context-validator.json` — that specialist's
      prompt + response (`{raw, parsed, parsePath}`;
      `parsePath !== "structured_output"` means fallback parsing)
    - `validation-transcript.jsonl` — that specialist's recorded output:
      `validator.transcript_begin` (assignmentId, engine, attempt) +
      `validator.transcript_item` (verbatim backend payloads)
  - Runs that predate validator cohorts keep the flat layout:
    `validation-transcript.jsonl` and `prompts/<n>.json` directly under the
    context directory

## 3. Transcripts — `transcripts/<conversationId>.jsonl`

One JSON entry per line: `{timestamp, type, role, content[], model, …}`;
content blocks: `text`, `tool_use`, `image_ref` (images under
`transcripts/images/<conversationId>/`). Useful greps:

```bash
jq -r 'select(.type=="assistant") | .content[]? | select(.type=="text") | .text' <file> | head
jq -r '.content[]? | select(.type=="tool_use") | .name' <file> | sort | uniq -c | sort -rn
```

**True conversation cost.** Entries with `raw.total_cost_usd` are SDK
results; the value is CUMULATIVE per session lineage. Group by
`raw.session_id`, treat a cumulative DROP within one id as a lineage restart
(a restarted subprocess can resume the same id from zero), and sum each
lineage's final value. The extractor's `scanTranscriptText` and the
production `summarizeTranscriptTelemetry` both implement this.

**Diagnostic system entries** (`type: "system"`, discriminated by
`raw.subtype`): `task_updated` with `patch.status: "killed"` = a background
task killed at a turn boundary; `model_refusal_fallback` = model retry;
`compact_boundary` = silent context compaction. The extractor tallies all
three per conversation.

## 4. Server debug logs — `logs/global.log` (+ rotated `.1…`)

NDJSON; fields include `timestamp`, `module`, `message`, `conversationId`,
`durationMs`. Workflow modules log `graph-workflow.*` events. Query with
`bun run logs:duckdb …` (see `cc-performance-log-analysis` skill) or the
per-session logs under `logs/sessions/<projectSlug>__<sessionSlug>/`.
Rotation: only the newest window is in `global.log`; concat `global.log*`
for full history.

## 5. Git

Per-context commits are titled `Graph workflow context <contextId>`
(`solo-context-committer.ts` / `lane-committer.ts`); SHAs + timestamps also
persist in `executionLanes[].commitSnapshots` even after worktree cleanup.
Shared docs / charter materialize into worktrees under
`.cc/graph-workflow-docs/` (git-excluded).

The final-publish join commit embeds its join id in the subject
(`Graph workflow join final_publish <joinId>: …`), so it is recoverable
after lane cleanup: `git log --all -n 1 --format=%H --grep=<joinId>`. The
extractor resolves it and reports the diffstat + scratch-file composition
in the overview.

## Linkage cheat-sheet

execution → contexts: `runtime_json.contextStates` · context → conversations:
`taskStates[].lastConversationId`, `laneStates[ctx][lane].sessionRef.conversationId`,
`iterations.jsonl` `conversation_resolved`, validation-event `sessionRef` ·
conversation → transcript: `conversations.transcript_path` (or
`transcripts/<id>.jsonl`) · conversation → server logs: filter NDJSON on
`conversationId` · context → code: `contextStates[].branchName` /
`commitSnapshots`.
