# cc-session-tools robustness & recovery

How CC keeps the **in-process `cc-session-tools` MCP server** healthy across the
life of a long-lived Claude `Query`, and how to measure it. Background and
rationale: `memory-bank/session-tools-recovery-design.md` (incident VOGUE-5013).

`cc-session-tools` is an `sdk`-type (in-process) MCP server. Its transport can
go stale/closed while the `Query` is still alive, after which every
`mcp__cc-session-tools__*` call — including `AskUserQuestion` — returns the
SDK-synthesized `Stream closed` error and the real handler never runs.

## The mechanism

- **`SessionToolsSupervisor`** (`src/lib/agent-backends/claude/session-tools-supervisor.ts`)
  owns the binding's recovery lifecycle for one Claude runtime: single-flight
  rebind, the pre-turn contract, the reactive stream-closed state machine, and
  the pending-question guard.
- **Pre-turn (primary fix).** Before a *reused* turn is delivered, the actor
  awaits `ClaudeConversationRuntime.prepareForTurnStart()`, which forces an
  **unconditional** two-phase rebind (drop the name, re-add a fresh instance).
  The disconnect window is safe because no tool call is in flight. The SDK diffs
  `sdk` servers by name, so a same-name replay is a no-op — only the two-phase
  `replaceSdkServer` reconnects. On an unrecoverable binding the actor recreates
  the runtime (resume-preserving) and retries once; a second failure fails the
  prompt **before** `streamInput` rather than delivering into a broken transport.
  The first turn of a runtime needs no rebind (its `init()` bind is fresh).
- **Reactive (best-effort).** A `cc-session-tools` "Stream closed" tool_result is
  routed to the supervisor: the 1st close this turn triggers one rebind; a failed
  rebind or a 2nd close this turn force-terminates the runtime (the actor
  recreates a resumed runtime on the next prompt). This **supersedes** the generic
  `consecutive-stream-closed` threshold — `cc-session-tools` is excluded from that
  counter so the generic N=3 kill can never race the supervisor's rebind.
- **Pending-question guard.** No proactive/probe-driven rebind or kill runs while
  an `AskUserQuestion` is validly pending. A confirmed-dead query / user abort
  still closes and rejects the resolver normally.
- **`mcpServerStatus()` is telemetry/weak-probe only.** The between-turn keepalive
  pings (and the bounded pre-turn probe) record health and keep the transport
  warm but take **no** recovery action on a bare status failure; every probe is
  bounded (`MCP_STATUS_TIMEOUT_MS`) so a hung probe can never permanently suppress
  future checks. See the SDK assumptions note below.

Codex consumes `cc-session-tools` over portable `streamable-http` with different
recovery semantics and is **out of scope**; the supervisor is Claude-only.

## Metrics

Run the saved DuckDB query on either side of a deploy to compare before/after
rates (the bar for "done" is a demonstrated drop in the failure rate):

```bash
# whole history
scripts/duckdb-logs/run.sh session-tools-recovery
# windowed comparison
scripts/duckdb-logs/run.sh session-tools-recovery --since 2026-06-25T00:00:00Z
```

It aggregates, per `message`, the supervisor + query-session events below.

| Event (`message`) | Module | Meaning |
|---|---|---|
| `query-session.stream_closed_tool_result` | `query-session` | An MCP tool came back `Stream closed` |
| `session_tools.refresh_started` / `_succeeded` / `_failed` | `claude:session-tools-supervisor` | Targeted two-phase rebinds attempted / ok / failed |
| `session_tools.escalate_kill` | `claude:session-tools-supervisor` | Supervisor gave up this turn and asked for a kill |
| `session_tools.marked_unhealthy` | `claude:session-tools-supervisor` | Binding flagged unhealthy (telemetry) |
| `session_tools.ensure_skipped_question_pending` | `claude:session-tools-supervisor` | Pre-turn rebind skipped — a question was pending |
| `query-session.force_terminate` | `query-session` | The kill landed on the query session |
| `prompt.runtime_recreated_after_session_tools_failure` | `prompt` | Actor recreated the runtime pre-turn after a failed readiness check |
| `prompt.session_tools_unrecoverable` | `prompt` | Pre-turn readiness failed twice → prompt not delivered |
| `query-session.mcp_mutation` | `query-session` | Phase 0: every live MCP mutation + its server keyset |
| `query-session.mcp_mutation_missing_supervised_server` | `query-session` | **ALERT** — an unexpected live mutation dropped the `cc-session-tools` name |
| `query-session.mcp_status_timeout` | `query-session` | A bounded `mcpServerStatus()` probe timed out |
| `query-session.mcp_pre_turn_unhealthy` / `mcp_keepalive_unhealthy` | `query-session` | A status probe saw a failed server |
| `tool.rejected` | `ask-user-question-tool` | An `AskUserQuestion` was cancelled/rejected (the user-visible symptom) |

## SDK assumptions

The recovery code relies on the first two `@anthropic-ai/claude-agent-sdk`
`sdk`-server behaviors below and explicitly does not rely on the third:

1. `setMcpServers` diffs `sdk` servers by name (same-name swap = no-op) — **depended on**.
2. Two-phase `replaceSdkServer` (drop then re-add) reconnects — **depended on**.
3. `mcpServerStatus()` flips to `failed` on a broken transport — **not depended on**
   (humility fallback): the pre-turn rebind is unconditional, never probe-gated.

Invariants 1–2 are validated against a faithful name-diff replica in
`conversation-runtime.test.ts` / `query-session.test.ts`. There is no live SDK
contract test in this suite; the real-SDK validation requirement was dropped
because the previous placeholder test did not exercise meaningful behavior.
