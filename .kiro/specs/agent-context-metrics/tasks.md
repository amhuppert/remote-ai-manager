# Implementation Plan

- [x] 1. Define the conversation metrics schema and extend ConversationState
- [x] 1.1 Create the metrics Zod schemas and add the metrics field to ConversationState
  - Define `compactionEventSchema`, `modelUsageEntrySchema`, and `conversationMetricsSchema` as Zod schemas in the schemas module
  - All metrics fields default to `null` (nullable) except `compactionCount` (0) and `compactions` (empty array)
  - Add `metrics` as a nullable optional field on `conversationStateSchema` defaulting to `null`
  - Export the `ConversationMetrics`, `CompactionEvent`, and `ModelUsageEntry` types from the types module
  - _Requirements: 5.1, 5.2_

- [x] 1.2 Remove legacy metric fields from ConversationState
  - Remove `totalCostUsd`, `totalDurationMs`, and `totalTurns` from `conversationStateSchema`
  - Remove the corresponding defaults from conversation creation helpers (conversations module, sessions module)
  - Verify that Zod's parsing behavior silently drops the removed keys when loading existing state files that still contain them
  - _Requirements: 5.3_

- [x] 1.3 Write unit tests for the new metrics schema
  - Test parsing a fully populated metrics object
  - Test parsing with all fields set to `null` (initial state)
  - Test parsing partial data (only init metadata, no result yet)
  - Test that `compactionCount` defaults to 0 and `compactions` to empty array
  - Test that existing state JSON missing the `metrics` key parses with `metrics: null`
  - Test that existing state JSON containing legacy `totalCostUsd`/`totalDurationMs`/`totalTurns` keys parses without errors (Zod strips them)
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 2. Implement metrics extraction from SDK messages
- [x] 2.1 Implement the result metrics extraction function
  - Create a pure function that takes an SDK result message (success or error) and existing metrics, and returns a partial metrics update
  - Map SDK field names to schema field names: `total_cost_usd` → `totalCostUsd`, `duration_api_ms` → `durationApiMs`, `stop_reason` → `stopReason`, etc.
  - Accumulate `totalCostUsd`, `durationMs`, and `numTurns` by adding the new result values to existing metrics values
  - Extract the full `usage` object fields: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`
  - Extract the `modelUsage` record and `contextWindow` from it
  - Extract `stopReason`, `permissionDenials` (tool names only), and `errorSubtype` (for error results)
  - _Requirements: 1.1, 2.1, 2.2, 4.1, 5.4, 7.1, 7.2, 7.3_

- [x] 2.2 (P) Implement the init metrics extraction function
  - Create a pure function that takes an SDK init system message and returns a partial metrics update
  - Extract `model`, `claude_code_version` → `claudeCodeVersion`, `tools`, and `mcp_servers` → `mcpServers`
  - _Requirements: 3.1, 5.5_

- [x] 2.3 (P) Implement the compaction event extraction function
  - Create a pure function that takes a compact boundary message and existing metrics, and returns a partial metrics update
  - Increment `compactionCount`, set `lastCompactionPreTokens` to the new `pre_tokens` value
  - Append a new entry to the `compactions` array with `trigger`, `preTokens`, and current timestamp
  - _Requirements: 1.3_

- [x] 2.4 Write unit tests for all extraction functions
  - Test result extraction with a success message: verify all fields mapped correctly and cost/duration/turns accumulated
  - Test result extraction with an error message: verify `errorSubtype` and `errors` captured, cost/duration still accumulated
  - Test result extraction with `null` existing metrics (first prompt in conversation)
  - Test init extraction: verify `model`, `claudeCodeVersion`, `tools`, `mcpServers` populated
  - Test compaction extraction: verify count incremented, array appended, `lastCompactionPreTokens` updated
  - Test compaction extraction with `null` existing metrics (first compaction before any result)
  - Test that `permissionDenials` stores only tool names, not full input objects
  - _Requirements: 1.1, 1.3, 2.1, 2.2, 3.1, 4.1, 5.4, 5.5, 7.1, 7.2, 7.3_

- [x] 3. Integrate metrics extraction into the prompt execution pipeline
- [x] 3.1 Wire extraction functions into the message processing loop
  - In the `system` message handler for `init` subtype, call the init extraction function and persist the result via the conversation mutation helper
  - Add a new handler for `system` messages with `compact_boundary` subtype that calls the compaction extraction function and persists the result
  - In the `result` message handler, replace the legacy accumulation of `totalCostUsd`/`totalDurationMs`/`totalTurns` with a call to the result extraction function that writes into `metrics`
  - Remove the now-unused `resultCostUsd`, `resultDurationMs`, `resultNumTurns` tracking variables and the `setResultData` callback
  - _Requirements: 5.3, 5.4, 5.5_

- [x] 3.2 Update all references to removed legacy fields across the codebase
  - Update conversation creation in the conversations module to omit the removed fields and set `metrics: null`
  - Update session import logic to omit the removed fields
  - Update all test fixtures and mocks that reference `totalCostUsd`, `totalDurationMs`, or `totalTurns` to use `metrics` instead
  - Update prompt execution tests to assert on `conversation.metrics?.totalCostUsd` rather than `conversation.totalCostUsd`
  - _Requirements: 5.3_

- [x] 3.3 Write integration tests for the full extraction pipeline
  - Test a full prompt execution flow and verify that `ConversationState.metrics` is populated with token counts, cost, timing, model, and version after completion
  - Test that a second prompt execution accumulates cost, duration, and turns onto existing metrics
  - Test backward compatibility: a state file with no `metrics` field parses correctly and subsequent prompt execution populates it
  - _Requirements: 5.2, 5.3, 5.4_

- [x] 4. Add SSE metrics-update event
- [x] 4.1 Define the metrics-update SSE event schema and broadcast it
  - Add a `metricsUpdateEventSchema` to the SSE schemas with `type: "metrics-update"`, project/session/conversation identifiers, and a partial metrics payload
  - Extend the `SSEEvent` union type to include the new event
  - Broadcast `metrics-update` at three points in the message processing loop: on compact boundary receipt, on compacting status, and on result receipt
  - Use fire-and-forget pattern consistent with existing SSE broadcasts
  - _Requirements: 6.1, 6.2_

- [x] 4.2 Write tests for the SSE metrics event
  - Test that the `metricsUpdateEventSchema` validates correctly with partial metrics
  - Test that a metrics-update event is broadcast when a result message is processed
  - _Requirements: 6.1, 6.2_

- [x] 5. Build the metrics display panel UI component
- [x] 5.1 Create the MetricsPanel component with token and cost display
  - Build a collapsible panel that receives conversation metrics as a prop
  - Display cumulative input tokens, output tokens, and context window size as formatted raw numbers
  - Display cache read and cache creation token counts as labeled values
  - Display total cost in USD with per-model breakdown when multiple models are present
  - Render a "No metrics yet" placeholder when metrics are null
  - Format token counts with thousands separators and cost with 2 decimal places
  - _Requirements: 1.2, 2.3, 2.4, 2.5_

- [x] 5.2 Add timing, session info, compaction, and error sections to MetricsPanel
  - Display wall-clock duration and API duration as human-readable values (e.g., "2m 15s"), and accumulated turn count
  - Display model name, Claude Code version, and MCP server names with connection status
  - Display compaction count and last pre-compaction token count when compactions have occurred
  - Display stop reason text, error subtype as a badge, and permission denial count with tool names
  - _Requirements: 1.4, 3.2, 3.3, 3.4, 4.2, 4.3, 7.4, 7.5_

- [x] 5.3 Create a Storybook story for MetricsPanel
  - Story with full metrics data showing all sections populated
  - Story with null metrics showing the placeholder state
  - Story with partial metrics (only init metadata, no result yet)
  - Story showing compaction events and error/stop reason states

- [x] 5.4 Integrate MetricsPanel into the session detail view
  - Render MetricsPanel in the conversation detail page, passing the active conversation's metrics
  - Ensure MetricsPanel updates reactively when SSE `metrics-update` events arrive (via the existing query invalidation pattern or direct SSE listener)
  - _Requirements: 6.3_

- [x] 5.5 Write UI tests for MetricsPanel
  - Test that cumulative token counts render as formatted numbers
  - Test that null metrics renders the placeholder
  - Test that all metric categories display when data is present
  - _Requirements: 1.2, 1.4, 2.3, 2.4, 3.2, 3.3, 3.4, 4.2, 4.3, 7.4, 7.5_
