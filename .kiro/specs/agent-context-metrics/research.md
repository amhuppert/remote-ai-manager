# Research & Design Decisions: agent-context-metrics

## Summary
- **Feature**: `agent-context-metrics`
- **Discovery Scope**: Extension (existing SDK processing pipeline)
- **Key Findings**:
  - SDK already emits all needed metrics data — extraction is pure data plumbing
  - `processMessage()` in `prompt.ts` is the single extraction point for all message types
  - Existing `SSEEvent` union and `broadcast()` pattern extends trivially for metrics events

## Research Log

### SDK Message Types with Metrics Data
- **Context**: Need to identify which SDK messages carry operational metrics
- **Sources Consulted**: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (lines 445-454, 1264-1273, 1563-1598, 1676-1714)
- **Findings**:
  - `SDKResultSuccess` / `SDKResultError`: `usage` (aggregate tokens), `modelUsage` (per-model with `contextWindow`, `costUSD`, `maxOutputTokens`), `duration_ms`, `duration_api_ms`, `num_turns`, `stop_reason`, `permission_denials`
  - `SDKSystemMessage` (subtype `init`): `model`, `claude_code_version`, `tools`, `mcp_servers`
  - `SDKCompactBoundaryMessage`: `compact_metadata.trigger` (manual/auto), `compact_metadata.pre_tokens`
  - `SDKStatusMessage`: `status: 'compacting' | null`
  - `SDKTaskNotificationMessage`: `usage.total_tokens`, `usage.tool_uses`, `usage.duration_ms` (deferred to v2)
- **Implications**: Three message types need extraction logic (result, init, compact_boundary); one needs SSE broadcast only (status compacting)

### Current CSM Extraction Coverage
- **Context**: Understanding what's already captured vs. ignored
- **Sources Consulted**: `src/lib/prompt.ts` (processMessage function, lines 439-563)
- **Findings**:
  - Currently extracted: `session_id` (init), `total_cost_usd`/`duration_ms`/`num_turns` (result)
  - Currently ignored: `usage` object, `modelUsage` record, `duration_api_ms`, `stop_reason`, `permission_denials`, all init metadata, compact_boundary data
  - `compact_boundary` and other system subtypes are logged to transcript as raw JSON but not processed
- **Implications**: Extraction can be added to existing switch cases in `processMessage()` with minimal structural change

### ConversationState Schema Analysis
- **Context**: Evaluating schema extension approach
- **Sources Consulted**: `src/lib/schemas.ts` (lines 92-111)
- **Findings**:
  - Current schema has 14 fields including `totalCostUsd`, `totalDurationMs`, `totalTurns`
  - All fields use `.nullable().default(null)` or `.default()` for backward compatibility
  - State persisted as JSON file with atomic write-to-temp-then-rename pattern
- **Implications**: Nested `metrics` sub-schema is preferred over flat fields to avoid schema bloat; nullable default ensures backward compatibility

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Flat fields on ConversationState | Add ~15 top-level fields | Simple, consistent with existing pattern | Schema bloat, awkward for nested data | Rejected |
| Nested metrics sub-schema | Single `metrics` field with dedicated schema | Clean separation, handles nesting, easy to extend | Slightly more complex schema | **Selected** |
| Separate metrics storage | Store in separate files | No schema changes | Diverges from single-state-file pattern, more I/O | Rejected |

## Design Decisions

### Decision: Nested `metrics` sub-schema
- **Context**: Need to store ~20 metrics fields including nested structures (modelUsage, compaction history)
- **Alternatives Considered**:
  1. Flat fields — adds 15+ fields to already-14-field schema
  2. Nested sub-schema — single optional field with dedicated Zod schema
  3. Separate file — parallel metrics storage
- **Selected Approach**: Nested sub-schema (`conversationMetricsSchema`) added as `metrics: conversationMetricsSchema.nullable().default(null)` on `ConversationState`
- **Rationale**: Clean separation, handles nested data naturally, zero migration risk (nullable default), easy to extend
- **Trade-offs**: Slightly more complex schema definition vs. much better organization
- **Follow-up**: Verify Zod v4 nested schema parsing with nullable defaults in unit tests

### Decision: Last-prompt metrics (not cumulative) for SDK data
- **Context**: Existing `totalCostUsd` accumulates across prompts. Should `metrics` do the same?
- **Alternatives Considered**:
  1. Accumulative — sum across prompts like existing fields
  2. Last-prompt snapshot — store only most recent result data
  3. Both — separate fields for each
- **Selected Approach**: Last-prompt snapshot. The `metrics` object reflects the SDK's most recent result. Existing `totalCostUsd`/`totalDurationMs`/`totalTurns` continue to accumulate.
- **Rationale**: Context window usage is inherently "current state" — accumulating it is meaningless. Token counts from the last result are what the operator cares about for monitoring. Cumulative cost is already covered by existing fields.
- **Trade-offs**: Cannot see historical per-prompt breakdown (but that's a non-goal)
- **Follow-up**: None

### Decision: Dedicated MetricsPanel component
- **Context**: Where to display metrics in the UI
- **Alternatives Considered**:
  1. Inline in conversation sidebar — too cramped
  2. Session header strip — limited space for all metrics
  3. Dedicated collapsible panel — full space for all metrics
- **Selected Approach**: Colocated component at `src/app/projects/[name]/[session]/[conversationId]/MetricsPanel.tsx`, rendered in the conversation detail view
- **Rationale**: Metrics are conversation-scoped and detailed enough to warrant dedicated panel space; collapsible to not crowd the main chat view
- **Trade-offs**: Takes UI space; mitigated by being collapsible
- **Follow-up**: Storybook story for interactive review

### Decision: Store full compaction history
- **Context**: Should we store all compaction events or just a count?
- **Selected Approach**: Both — `compactions` array for full history, `compactionCount` and `lastCompactionPreTokens` for quick access
- **Rationale**: Compaction events are infrequent (typically 0-3 per conversation); storage cost is negligible; full history enables future analysis
- **Trade-offs**: Slightly larger state file; negligible impact

### Decision: Selective SSE broadcast (not every streaming event)
- **Context**: How often to broadcast metrics updates
- **Selected Approach**: Broadcast `metrics-update` at three points only: compact_boundary receipt, compacting status, and result receipt
- **Rationale**: These are the only moments metrics actually change. Broadcasting on every stream_event would be noisy and wasteful.
- **Trade-offs**: No real-time token counter during execution (acceptable for v1)

### Decision: Raw token counts, no context usage percentage (post-review)
- **Context**: Design review identified that `usage.inputTokens` is cumulative across all API calls in the prompt execution (each turn re-sends conversation history). So `inputTokens / contextWindow` quickly exceeds 100% and is meaningless as a context fill indicator.
- **Alternatives Considered**:
  1. Show context fill percentage using `inputTokens / contextWindow` — **incorrect** (cumulative ≠ current fill)
  2. Show fill only after compaction using `pre_tokens` — accurate but only available post-compaction
  3. Show raw cumulative token counts without percentage — honest and still useful
- **Selected Approach**: Option 3 — display raw cumulative token counts and context window size as separate numbers. No progress bar or percentage. `compact_boundary.pre_tokens` shown separately as the only reliable fill signal.
- **Rationale**: Showing incorrect data is worse than showing no percentage. Raw counts are still valuable for cost analysis and consumption monitoring.
- **Trade-offs**: Users cannot see "how full" their context is at a glance, but this limitation comes from the SDK, not from CSM.

### Decision: Remove legacy top-level metric fields (post-review)
- **Context**: Design review identified that `ConversationState.totalCostUsd` (accumulative) and `ConversationState.metrics.totalCostUsd` (potentially different semantics) create confusion. Two fields for the same concept with different names/semantics is a maintenance hazard.
- **Alternatives Considered**:
  1. Keep both — legacy fields for backward compatibility, metrics for new data → duplicated, confusing
  2. Rename metrics fields (e.g., `lastPromptCostUsd`) — avoids collision but doesn't solve the duplication
  3. Remove legacy fields, migrate accumulation into `metrics` — clean, single source of truth
- **Selected Approach**: Option 3 — remove `totalCostUsd`, `totalDurationMs`, `totalTurns` from `conversationStateSchema`. Move their accumulation logic into `metrics.totalCostUsd`, `metrics.durationMs`, `metrics.numTurns`.
- **Rationale**: Single source of truth. All consumers updated at once. No confusion about which field to read. The `metrics` sub-object owns all operational data.
- **Trade-offs**: Breaking change — all code referencing `conversation.totalCostUsd` must migrate to `conversation.metrics?.totalCostUsd`. But scope is contained (prompt.ts accumulation, UI display, possibly ConversationList/Sidebar).
- **Follow-up**: Search codebase for all references to the three legacy fields and update during implementation.

## Risks & Mitigations
- **SDK type changes**: ModelUsage fields may change across SDK versions. Mitigation: Use `safeParse` for result extraction; log warnings for unexpected shapes.
- **State file growth**: Per-model usage records and compaction arrays add data. Mitigation: Expected growth is <1KB per conversation; negligible vs. existing state.
- **Backward compatibility**: Existing state files lack `metrics` field. Mitigation: `.nullable().default(null)` ensures clean parsing.
- **Legacy field removal**: Existing state files may contain `totalCostUsd`/`totalDurationMs`/`totalTurns`. Mitigation: Zod's `.strip()` behavior drops unknown keys during parsing; alternatively, keep fields in schema as optional-deprecated during transition.

## References
- `@anthropic-ai/claude-agent-sdk` type definitions: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- Existing prompt processing: `src/lib/prompt.ts` (processMessage, lines 439-563)
- Schema definitions: `src/lib/schemas.ts` (conversationStateSchema, lines 92-111)
- SSE broadcaster: `src/lib/sse-broadcaster.ts`
