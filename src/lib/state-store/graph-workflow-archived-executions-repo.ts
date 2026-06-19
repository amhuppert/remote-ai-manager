import type Database from "better-sqlite3";
import { createLogger } from "@/lib/logging";
import {
  graphWorkflowExecutionSchema,
  graphWorkflowStatusSchema,
  type GraphWorkflowExecution,
  type GraphWorkflowStatus,
} from "@/lib/workflows/schemas";
import { PersistenceError } from "../shared/errors";
type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.graph-workflow-archived-executions");

/**
 * One row per completed graph-workflow execution that has been moved out of the
 * session's active slot. The control-state blob (`execution_json`) is the
 * history-free {@link GraphWorkflowExecution}; the execution's append-only events
 * stay in `graph_workflow_events`, keyed by the same `execution_id`. This table
 * replaces the unbounded `session.graphWorkflowExecutionHistory[]` array that
 * used to accumulate inside the session JSON blob.
 */
export interface GraphWorkflowArchivedExecutionRow {
  projectPath: string;
  sessionName: string;
  executionId: string;
  archivedAt: string;
  status: GraphWorkflowStatus;
  startedAt: string;
  completedAt: string | null;
  execution: GraphWorkflowExecution;
}

export interface GraphWorkflowArchivedExecutionSummary {
  executionId: string;
  archivedAt: string;
  status: GraphWorkflowStatus;
  startedAt: string;
  completedAt: string | null;
}

export interface GraphWorkflowArchivedExecutionsRepo {
  insert(row: GraphWorkflowArchivedExecutionRow): void;
  listSummariesBySession(
    projectPath: string,
    sessionName: string,
  ): GraphWorkflowArchivedExecutionSummary[];
  findByExecution(
    projectPath: string,
    sessionName: string,
    executionId: string,
  ): GraphWorkflowExecution | null;
}

interface SummaryStorageRow {
  execution_id: string;
  archived_at: string;
  status: string;
  started_at: string;
  completed_at: string | null;
}

function isSummaryRow(value: unknown): value is SummaryStorageRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.execution_id === "string" &&
    typeof row.archived_at === "string" &&
    typeof row.status === "string" &&
    typeof row.started_at === "string" &&
    (row.completed_at === null || typeof row.completed_at === "string")
  );
}

function logAndThrowValidationFailure(
  identifier: string,
  issues: unknown,
): never {
  logger.error(
    "state-store.graph-workflow-archived-executions.schema_validation_failure",
    { identifier, issues },
  );
  throw new PersistenceError({
    kind: "validation",
    entity: "graph_workflow_archived_execution",
    identifier,
    issues,
  });
}

function summaryRowToDomain(
  identifier: string,
  rawRow: unknown,
): GraphWorkflowArchivedExecutionSummary {
  if (!isSummaryRow(rawRow)) {
    return logAndThrowValidationFailure(identifier, [
      { code: "invalid_row_shape", path: [], message: "unexpected row shape" },
    ]);
  }
  const statusResult = graphWorkflowStatusSchema.safeParse(rawRow.status);
  if (!statusResult.success) {
    return logAndThrowValidationFailure(identifier, statusResult.error.issues);
  }
  return {
    executionId: rawRow.execution_id,
    archivedAt: rawRow.archived_at,
    status: statusResult.data,
    startedAt: rawRow.started_at,
    completedAt: rawRow.completed_at,
  };
}

function timed<T>(
  op: string,
  identifier: {
    projectPath?: string;
    sessionName?: string;
    executionId?: string;
  },
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    const payload: Record<string, unknown> = { durationMs };
    if (identifier.projectPath !== undefined) {
      payload.projectPath = identifier.projectPath;
    }
    if (identifier.sessionName !== undefined) {
      payload.sessionName = identifier.sessionName;
    }
    if (identifier.executionId !== undefined) {
      payload.executionId = identifier.executionId;
    }
    logger.info(
      `state-store.graph-workflow-archived-executions.${op}.timing`,
      payload,
    );
  }
}

export function createGraphWorkflowArchivedExecutionsRepo(
  db: Db,
): GraphWorkflowArchivedExecutionsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO graph_workflow_archived_executions (
       project_path, session_name, execution_id, archived_at,
       status, started_at, completed_at, execution_json
     ) VALUES (
       @project_path, @session_name, @execution_id, @archived_at,
       @status, @started_at, @completed_at, @execution_json
     )
     ON CONFLICT(project_path, session_name, execution_id) DO UPDATE SET
       archived_at    = excluded.archived_at,
       status         = excluded.status,
       started_at     = excluded.started_at,
       completed_at   = excluded.completed_at,
       execution_json = excluded.execution_json`,
  );
  const listSummariesStmt = db.prepare(
    `SELECT execution_id, archived_at, status, started_at, completed_at
       FROM graph_workflow_archived_executions
      WHERE project_path = ? AND session_name = ?
      ORDER BY archived_at DESC, execution_id DESC`,
  );
  const findByExecutionStmt = db.prepare(
    `SELECT execution_json
       FROM graph_workflow_archived_executions
      WHERE project_path = ? AND session_name = ? AND execution_id = ?
      LIMIT 1`,
  );

  return {
    insert(row) {
      timed(
        "insert",
        {
          projectPath: row.projectPath,
          sessionName: row.sessionName,
          executionId: row.executionId,
        },
        () => {
          const validated = graphWorkflowExecutionSchema.parse(row.execution);
          insertStmt.run({
            project_path: row.projectPath,
            session_name: row.sessionName,
            execution_id: row.executionId,
            archived_at: row.archivedAt,
            status: row.status,
            started_at: row.startedAt,
            completed_at: row.completedAt,
            execution_json: JSON.stringify(validated),
          });
        },
      );
    },
    listSummariesBySession(projectPath, sessionName) {
      return timed(
        "listSummariesBySession",
        { projectPath, sessionName },
        () => {
          const rows = listSummariesStmt.all(
            projectPath,
            sessionName,
          ) as unknown[];
          return rows.map((row) =>
            summaryRowToDomain(`${projectPath}::${sessionName}`, row),
          );
        },
      );
    },
    findByExecution(projectPath, sessionName, executionId) {
      return timed(
        "findByExecution",
        { projectPath, sessionName, executionId },
        () => {
          const row: unknown = findByExecutionStmt.get(
            projectPath,
            sessionName,
            executionId,
          );
          if (row === undefined) return null;
          if (
            typeof row !== "object" ||
            row === null ||
            typeof (row as { execution_json?: unknown }).execution_json !==
              "string"
          ) {
            return logAndThrowValidationFailure(executionId, [
              {
                code: "invalid_row_shape",
                path: [],
                message: "unexpected row shape",
              },
            ]);
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(
              (row as { execution_json: string }).execution_json,
            );
          } catch (err) {
            return logAndThrowValidationFailure(executionId, [
              {
                code: "invalid_json",
                path: ["execution_json"],
                message: err instanceof Error ? err.message : String(err),
              },
            ]);
          }
          const result = graphWorkflowExecutionSchema.safeParse(parsed);
          if (!result.success) {
            return logAndThrowValidationFailure(
              executionId,
              result.error.issues,
            );
          }
          return result.data;
        },
      );
    },
  };
}
