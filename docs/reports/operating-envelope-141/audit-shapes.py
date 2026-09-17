"""Read-only evidence for ticket 141; never imports CC or runs migrations."""
import argparse
import datetime
import json
from pathlib import Path
import socket
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument("db")
args = parser.parse_args()
connection = sqlite3.connect(Path(args.db).resolve().as_uri() + "?mode=ro", uri=True)
connection.execute("PRAGMA query_only = ON")
# All queries share one read snapshot even while the running app writes.
connection.execute("BEGIN")

graph = """WITH graph_rows(source, doc) AS (
 SELECT 'active.runtime', runtime_json FROM graph_workflow_executions
 UNION ALL SELECT 'active.definition', definition_json FROM graph_workflow_executions
 UNION ALL SELECT 'archived', execution_json FROM graph_workflow_archived_executions
) """
# Inline machine_snapshot columns are excluded by both conversation repos;
# restoration reads only the owner-discriminated sidecar.
snapshots = """WITH snapshots(doc) AS (
 SELECT snapshot_json FROM conversation_machine_snapshots
) """
envelopes = """WITH envelopes(doc) AS (
 SELECT e.value FROM sessions, json_each(workflow_envelopes) e
 WHERE json_valid(workflow_envelopes)
   AND json_extract(e.value, '$.workflowType') = 'collaboration'
) """
reader_refs = """WITH docs(source, doc) AS (
 SELECT 'conversations.backend_ref', backend_ref FROM conversations WHERE json_valid(backend_ref)
 UNION ALL SELECT 'project_conversations.backend_ref', backend_ref FROM project_conversations WHERE json_valid(backend_ref)
 UNION ALL SELECT 'conversations.forked_from.sourceBackendRef', json_extract(forked_from, '$.sourceBackendRef') FROM conversations WHERE json_valid(forked_from)
 UNION ALL SELECT 'project_conversations.forked_from.sourceBackendRef', json_extract(forked_from, '$.sourceBackendRef') FROM project_conversations WHERE json_valid(forked_from)
) """
# Same exact key sets and nonempty selected handle as asNormalizableRef:
# {backend, sessionId/threadId} or {backend, ref, sessionId/threadId}.
ref_matches = """SELECT source, count(*) FROM docs, json_tree(doc) node
 WHERE node.type = 'object'
   AND json_extract(node.value, '$.backend') IN ('claude', 'codex')
   AND (SELECT count(*) FROM json_each(node.value)) IN (2, 3)
   AND NOT EXISTS (
     SELECT 1 FROM json_each(node.value) field
     WHERE field.key NOT IN ('backend', 'ref',
       CASE json_extract(node.value, '$.backend') WHEN 'claude' THEN 'sessionId' ELSE 'threadId' END)
   )
   AND json_type(node.value,
     CASE json_extract(node.value, '$.backend') WHEN 'claude' THEN '$.sessionId' ELSE '$.threadId' END) IS NOT NULL
   AND json_type(node.value,
     CASE WHEN json_type(node.value, '$.ref') IS NOT NULL THEN '$.ref'
          WHEN json_extract(node.value, '$.backend') = 'claude' THEN '$.sessionId' ELSE '$.threadId' END) = 'text'
   AND length(json_extract(node.value,
     CASE WHEN json_type(node.value, '$.ref') IS NOT NULL THEN '$.ref'
          WHEN json_extract(node.value, '$.backend') = 'claude' THEN '$.sessionId' ELSE '$.threadId' END)) > 0
 GROUP BY source ORDER BY source"""
queries = {
    "singular_active_context": graph + "SELECT source,count(*) FROM graph_rows WHERE json_type(doc,'$.activeContextId') IS NOT NULL GROUP BY source",
    "flat_lane_states": graph + "SELECT source,count(DISTINCT doc) FROM graph_rows,json_each(doc,'$.laneStates') lane WHERE json_type(lane.value,'$.engine')='text' GROUP BY source",
    # Structural candidates, not a reimplementation of the frozen Zod decoder:
    # all contexts and both agent roles must pass that decoder before migration.
    "pre_assignment_archives": "SELECT count(DISTINCT a.execution_id) FROM graph_workflow_archived_executions a,json_each(a.execution_json,'$.workingDefinition.executionContexts') ctx WHERE json_type(ctx.value,'$.implementer.agent') IS NULL AND json_type(ctx.value,'$.implementer')='object'",
    "lane_less_worktree_contexts": graph + "SELECT source,count(*) FROM graph_rows,json_each(doc,'$.contextStates') ctx WHERE json_extract(ctx.value,'$.isolation')='worktree' AND (json_type(ctx.value,'$.laneId') IS NULL OR json_type(ctx.value,'$.laneId')='null') GROUP BY source",
    "purge_ledger": "SELECT id,applied_at FROM applied_data_migrations WHERE id IN ('graph-workflow-charter-legacy-purge','graph-workflow-charter-legacy-purge:pending') ORDER BY id",
    "session_ref_ledger": "SELECT name,applied_at FROM applied_migrations WHERE name='0005-agent-session-ref-shape'",
    "legacy_session_refs_direct_decoder_inputs": reader_refs + """SELECT source,count(*) FROM docs
      WHERE json_extract(doc,'$.backend') IN ('claude','codex')
        AND (coalesce(json_type(doc,'$.ref'),'missing') != 'text' OR length(json_extract(doc,'$.ref'))=0)
        AND json_type(doc,CASE json_extract(doc,'$.backend') WHEN 'claude' THEN '$.sessionId' ELSE '$.threadId' END)='text'
        AND length(json_extract(doc,CASE json_extract(doc,'$.backend') WHEN 'claude' THEN '$.sessionId' ELSE '$.threadId' END)) > 0
      GROUP BY source ORDER BY source""",
    "legacy_session_refs_deep_snapshot_inputs": "WITH docs(source,doc) AS (SELECT 'conversation_machine_snapshots.snapshot_json',snapshot_json FROM conversation_machine_snapshots) " + ref_matches,
    "legacy_active_turn": snapshots + "SELECT count(*) FROM snapshots WHERE json_type(doc,'$.context.activeTurn')='object' AND json_type(doc,'$.context.activeTurn.kind') IS NULL",
    "legacy_debug_generation": snapshots + "SELECT count(*) FROM snapshots WHERE json_type(doc,'$.context.debugMode.active')='true' AND (coalesce(json_type(doc,'$.context.debugMode.debugSessionId'),'missing') != 'text' OR json_extract(doc,'$.context.debugMode.debugSessionId')='')",
    "collaboration_backend_map": envelopes + "SELECT count(*) FROM envelopes WHERE json_type(doc,'$.featureSnapshot.agentModelSettings.claude')='object' OR json_type(doc,'$.featureSnapshot.agentModelSettings.codex')='object'",
    "collaboration_missing_origin": envelopes + "SELECT count(*) FROM envelopes WHERE json_type(doc,'$.featureSnapshot')='object' AND json_type(doc,'$.featureSnapshot.origin') IS NULL",
    "delivery_plan_ledger": "SELECT name,applied_at FROM applied_migrations WHERE name='0039-native-sdd-managed-workflow-definitions'",
    "delivery_plan_versions": "SELECT 'attempt',json_extract(content_json,'$.schemaVersion'),count(*) FROM spec_delivery_plan_attempts GROUP BY 2 UNION ALL SELECT 'snapshot',json_extract(content_json,'$.schemaVersion'),count(*) FROM spec_delivery_plan_snapshots GROUP BY 2",
}

# A separate diagnostic inventory is deliberately not evidence that a specific
# reader needs a branch: backups, event payloads, and retired fields can match.
def quoted_identifier(value):
    return '"' + value.replace('"', '""') + '"'

parts = []
extra_columns = {
    "backend_ref", "forked_from", "machine_snapshot", "workflow_envelopes",
    "workflow_lanes", "graph_workflow_execution", "graph_workflow_execution_history",
}
for (table,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall():
    for column in connection.execute("PRAGMA table_info(" + quoted_identifier(table) + ")").fetchall():
        name, column_type = column[1:3]
        if column_type != "TEXT" or not (name.endswith("_json") or name in extra_columns):
            continue
        quoted = quoted_identifier(name)
        source = (table + "." + name).replace("'", "''")
        parts.append(f"SELECT '{source}', {quoted} FROM {quoted_identifier(table)} WHERE json_valid({quoted})")
queries["legacy_session_refs_all_storage_diagnostic"] = "WITH docs(source, doc) AS (" + " UNION ALL ".join(parts) + ") " + ref_matches
queries["excluded_inline_storage"] = """SELECT 'conversations.machine_snapshot',count(*) FROM conversations WHERE machine_snapshot IS NOT NULL
 UNION ALL SELECT 'project_conversations.machine_snapshot',count(*) FROM project_conversations WHERE machine_snapshot IS NOT NULL
 UNION ALL SELECT 'sessions.graph_workflow_execution',count(*) FROM sessions WHERE graph_workflow_execution IS NOT NULL
 UNION ALL SELECT 'sessions.graph_workflow_execution_history',coalesce(sum(json_array_length(graph_workflow_execution_history)),0) FROM sessions"""

result = {
    "machine": socket.gethostname(),
    "queriedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "database": args.db,
    "readOnly": True,
    "consistentReadSnapshot": True,
    "notes": [
        "Reader probes exclude inline conversation snapshots and session graph blobs; current repos do not read those columns.",
        "Direct ref columns use the decoder loose-object predicate; sidecar deep refs use exact key sets. Valid canonical refs do not require a legacy direct decoder arm.",
        "All-storage ref diagnostics include backups and opaque retired fields; positive matches alone do not establish a reader dependency.",
        "Collaboration probes filter workflowType=collaboration; missing-origin applies only to object feature snapshots.",
        "Pre-assignment archive count identifies structural candidates, not proof that every context passes the frozen archived decoder.",
        "Pause/lease repair in migrateLegacyExecution is gated by singular activeContextId or flat laneStates; those two probes cover admission to that repair.",
    ],
    "shapes": {},
}
for name, sql in queries.items():
    try:
        result["shapes"][name] = {"sql": sql, "rows": connection.execute(sql).fetchall()}
    except sqlite3.Error as error:
        result["shapes"][name] = {"sql": sql, "error": str(error)}
connection.close()
print(json.dumps(result, indent=2))
