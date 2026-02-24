# Requirements Document

## Introduction

CSM uses the `@anthropic-ai/claude-agent-sdk` `query()` API to execute prompts, which returns a stream of typed `SDKMessage` objects. The SDK already emits comprehensive operational data — token usage, cost breakdowns, model info, context window size, tool timing, and compaction events — but CSM currently only captures `totalCostUsd`, `totalDurationMs`, and `totalTurns` as top-level fields on `ConversationState`. The rest is stored as raw JSON in transcript JSONL files but never parsed or surfaced.

This feature replaces the legacy top-level metric fields (`totalCostUsd`, `totalDurationMs`, `totalTurns`) with a structured `metrics` sub-object and extends it to include all available SDK operational data. Operators can then monitor cumulative token counts, cost, timing, compaction events, and session health from the dashboard.

**Note on context window usage**: The SDK's `usage.inputTokens` is cumulative across all API calls in a prompt execution (each turn re-sends the full history), so it does **not** represent current context fill level. The only reliable signal for context fill is `compact_boundary.pre_tokens` (emitted at compaction time). The UI therefore displays raw cumulative token counts rather than a context-fill percentage.

### SDK Data Available (Not Currently Surfaced)

From `SDKResultSuccess` / `SDKResultError`:
- `usage` — aggregate `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `webSearchRequests`
- `modelUsage` — per-model record with `costUSD`, `contextWindow`, `maxOutputTokens`, plus token breakdown
- `duration_api_ms` — API-only latency (vs wall-clock `duration_ms`)
- `stop_reason` — why the session ended
- `permission_denials` — blocked tool calls

From streaming events:
- `SDKCompactBoundaryMessage` — `pre_tokens` count before context compaction
- `SDKSystemMessage` (subtype `init`) — `model`, `tools`, `mcp_servers`, `claude_code_version`
- `SDKStatusMessage` — `compacting` status
- `SDKToolProgressMessage` — per-tool `elapsed_time_seconds`
- `SDKTaskNotificationMessage` — sub-agent `total_tokens`, `tool_uses`, `duration_ms`

## Requirements

### Requirement 1: Token Counts and Compaction Tracking

**Objective:** As a CSM operator, I want to see cumulative token counts and compaction history for a conversation, so that I can understand consumption patterns and know when context compaction has occurred.

#### Acceptance Criteria

1. When a prompt execution completes, CSM shall extract `contextWindow` and cumulative token counts from `modelUsage` in the SDK result message and persist them in the conversation metrics.
2. The UI shall display cumulative token counts (input, output) and the model's context window size as raw numbers.
3. When a `SDKCompactBoundaryMessage` is received during streaming, CSM shall record the `pre_tokens` count and compaction trigger type in the conversation metrics.
4. While a conversation has undergone context compaction, CSM shall indicate the number of compactions and the token count before the most recent compaction.

### Requirement 2: Token Usage and Cost Breakdown

**Objective:** As a CSM operator, I want to see detailed token counts and cost for each conversation, so that I can understand spending patterns and optimize prompt strategies.

#### Acceptance Criteria

1. When a prompt execution completes, CSM shall extract and persist `inputTokens`, `outputTokens`, `cacheReadInputTokens`, and `cacheCreationInputTokens` from the SDK result's `usage` field.
2. When a prompt execution completes, CSM shall extract and persist the per-model `costUSD` from the `modelUsage` record.
3. The UI shall display token counts grouped by category (input, output, cache read, cache creation) for each conversation.
4. The UI shall display the total cost in USD for each conversation.
5. Where a conversation uses multiple models (e.g., sub-agents), CSM shall display per-model token and cost breakdowns from the `modelUsage` record.

### Requirement 3: Session Metadata

**Objective:** As a CSM operator, I want to see the model name, SDK version, and available tools for each session, so that I can verify session configuration at a glance.

#### Acceptance Criteria

1. When a `SDKSystemMessage` with subtype `init` is received, CSM shall extract and persist `model`, `claude_code_version`, and `tools` list.
2. The UI shall display the model name for each conversation.
3. Where MCP servers are configured, CSM shall display MCP server names and their connection status from the init message's `mcp_servers` field.
4. The UI shall display the Claude Code version used by the session.

### Requirement 4: Execution Timing Metrics

**Objective:** As a CSM operator, I want to see how long prompts take to execute, including the split between API time and total wall-clock time, so that I can identify performance bottlenecks.

#### Acceptance Criteria

1. When a prompt execution completes, CSM shall extract and persist both `duration_ms` (wall-clock) and `duration_api_ms` (API-only) from the SDK result message.
2. The UI shall display both wall-clock and API durations for each conversation.
3. The UI shall display the number of turns (`num_turns`) for each conversation.

### Requirement 5: Metrics Data Model Migration

**Objective:** As a developer, I want conversation metrics stored in a single structured schema that replaces the legacy top-level fields, so that the data is type-safe, non-duplicated, and queryable without parsing raw transcript JSONL.

#### Acceptance Criteria

1. CSM shall define a Zod schema for conversation metrics that includes: token usage (input, output, cache read, cache creation), context window size, cost, durations (wall-clock and API), turn count, model name, SDK version, compaction events, and stop reason.
2. CSM shall extend `ConversationState` with an optional `metrics` field typed to the new schema.
3. CSM shall remove the legacy top-level fields `totalCostUsd`, `totalDurationMs`, and `totalTurns` from `ConversationState` and migrate their accumulation logic into the `metrics` sub-object.
4. When a prompt execution completes with a result message, CSM shall populate the `metrics` field by parsing the SDK result, accumulating cost and duration across prompts within the same conversation.
5. When a session is initialized (init system message received), CSM shall populate session-level metadata fields (model, version, tools) in the metrics.

### Requirement 6: Real-Time Metrics Updates

**Objective:** As a CSM operator, I want metrics to update in near-real-time while a prompt is executing, so that I can monitor active sessions without waiting for completion.

#### Acceptance Criteria

1. When a `SDKStatusMessage` with status `compacting` is received during streaming, CSM shall broadcast a metrics update via SSE indicating that context compaction is in progress.
2. When a prompt execution result is received, CSM shall broadcast updated metrics via the existing SSE channel.
3. The UI shall reactively update displayed metrics when SSE metric events are received, without requiring a page refresh.

### Requirement 7: Stop Reason and Error Visibility

**Objective:** As a CSM operator, I want to see why a conversation ended and whether any tool calls were denied, so that I can diagnose issues without reading full transcripts.

#### Acceptance Criteria

1. When a prompt execution completes, CSM shall extract and persist the `stop_reason` from the SDK result message.
2. If the SDK result contains `permission_denials`, CSM shall persist the list of denied tool names in the conversation metrics.
3. If the SDK result is an error with a `subtype` (e.g., `error_max_turns`, `error_max_budget_usd`), CSM shall persist the error subtype in the conversation metrics.
4. The UI shall display the stop reason and any error subtype for completed conversations.
5. Where permission denials occurred, the UI shall display the count of denied tool calls with the tool names.
