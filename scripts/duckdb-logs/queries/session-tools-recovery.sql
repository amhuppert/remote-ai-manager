-- cc-session-tools recovery / robustness metrics (incident VOGUE-5013).
--
-- Counts the supervisor + query-session events that track in-process MCP
-- transport breakage and recovery, grouped by message, with how many distinct
-- conversations each touched. Run with --since/--until on either side of a
-- deploy to compare before/after rates (design §12: "Done requires
-- demonstrating the failure rate dropped — not just green tests").
--
-- Event reference:
--   query-session.stream_closed_tool_result                 a cc-session-tools (or other MCP) tool came back "Stream closed"
--   session_tools.refresh_started/_succeeded/_failed         targeted two-phase rebinds attempted / ok / failed
--   session_tools.escalate_kill                              supervisor gave up this turn and force-killed the runtime
--   session_tools.marked_unhealthy                           binding flagged unhealthy (telemetry)
--   query-session.force_terminate                            the kill landed on the query session
--   prompt.runtime_recreated_after_session_tools_failure     actor recreated the runtime pre-turn after a failed readiness check
--   prompt.session_tools_unrecoverable                       pre-turn readiness failed twice → prompt not delivered
--   query-session.mcp_mutation_missing_supervised_server     ALERT: an unexpected live mutation dropped the cc-session-tools name
--   query-session.mcp_status_timeout                         a bounded mcpServerStatus() probe timed out
--   query-session.mcp_pre_turn_unhealthy / _keepalive_unhealthy   status probe saw a failed server
--   ask-user-question-tool / tool.rejected                   an AskUserQuestion was cancelled/rejected (user-visible symptom)
-- Params: --since/--until (window), --limit (default 30).

SELECT
    module,
    message,
    count(*)                        AS n,
    count(DISTINCT conversation_id) AS conversations,
    min(ts)                         AS first_seen,
    max(ts)                         AS last_seen,
    any_value(trace_id)             AS example_trace
FROM logs
WHERE since_ok(ts) AND until_ok(ts)
  AND (
        message LIKE 'session_tools.%'
     OR message IN (
          'query-session.stream_closed_tool_result',
          'query-session.force_terminate',
          'query-session.mcp_mutation_missing_supervised_server',
          'query-session.mcp_status_timeout',
          'query-session.mcp_pre_turn_unhealthy',
          'query-session.mcp_keepalive_unhealthy',
          'prompt.runtime_recreated_after_session_tools_failure',
          'prompt.session_tools_unrecoverable'
        )
     OR (module = 'ask-user-question-tool' AND message = 'tool.rejected')
  )
GROUP BY module, message
ORDER BY n DESC
LIMIT row_limit();
