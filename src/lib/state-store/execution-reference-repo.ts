import type Database from "better-sqlite3";
import path from "node:path";
import { z } from "zod";
import {
  executionReferenceItemSchema,
  type ExecutionReferenceItem,
} from "@/lib/workflow-graph/references";
import { createLogger } from "@/lib/logging";

const logger = createLogger("state-store.execution-references");
const rowSchema = executionReferenceItemSchema
  .omit({ projectName: true })
  .extend({ projectPath: z.string() });

export function listExecutionReferences(
  db: Database.Database,
  query: string,
  limit = 100,
): ExecutionReferenceItem[] {
  const rows = db
    .prepare(
      `
    SELECT project_path AS projectPath, session_name AS sessionName, execution_id AS executionId,
           title, status, started_at AS startedAt FROM (
      SELECT project_path, session_name, execution_id, status, started_at,
        COALESCE(json_extract(definition_json, '$.launchDocument.name'), json_extract(definition_json, '$.origin.planName'), json_extract(definition_json, '$.origin.definitionId'), json_extract(definition_json, '$.origin.specSlug'), 'Workflow execution') AS title
      FROM graph_workflow_executions WHERE json_valid(definition_json)
      UNION ALL
      SELECT project_path, session_name, execution_id, status, started_at,
        COALESCE(json_extract(execution_json, '$.launchDocument.name'), json_extract(execution_json, '$.origin.planName'), json_extract(execution_json, '$.origin.definitionId'), json_extract(execution_json, '$.origin.specSlug'), 'Workflow execution') AS title
      FROM graph_workflow_archived_executions WHERE json_valid(execution_json)
    ) WHERE instr(lower(title || ' ' || execution_id || ' ' || project_path || ' ' || session_name), lower(?)) > 0
    ORDER BY started_at DESC, execution_id DESC LIMIT ?
  `,
    )
    .all(query.trim(), Math.max(1, Math.min(limit, 100)));
  const items = rows.flatMap((row) => {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) {
      logger.warn("execution_reference.invalid_row", {
        issues: parsed.error.issues,
      });
      return [];
    }
    const { projectPath, ...item } = parsed.data;
    return [{ ...item, projectName: path.basename(projectPath) }];
  });
  logger.debug("execution_reference.listed", { count: items.length });
  return items;
}
