import type Database from "better-sqlite3";
import { emitOrDeferRepositoryLog } from "@/lib/state-store/deferred-repo-logging";
import { createLogger } from "@/lib/logging";
import {
  graphWorkflowExecutionSchema,
  type GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import { upgradeLegacyArchivedExecutionBlob } from "@/lib/workflow-graph/archived-legacy-decode";
import {
  graphWorkflowStatusSchema,
  type GraphWorkflowStatus,
} from "@/lib/workflow-graph/definition-schemas";
import { PersistenceError } from "../shared/errors";
import { getErrorMessage } from "@/lib/shared/errors";
import { decodeGraphWorkflowExecution } from "./graph-workflow-execution-codec";
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
  /** Read an archived execution by its globally unique execution id. */
  findByExecutionId(executionId: string): GraphWorkflowExecution | null;
  /**
   * Every decodable archived execution for a session, newest first.
   *
   * A row that neither the current schema nor the legacy decode floor accepts
   * is SKIPPED with a diagnostic rather than throwing: history is a list, and
   * one unreadable record must not hide every readable one. `findByExecution`
   * keeps throwing — a caller who named that execution is asking for it
   * specifically and deserves the failure.
   */
  listBySession(
    projectPath: string,
    sessionName: string,
  ): GraphWorkflowExecution[];
  /**
   * Terminal status of an archived execution by its globally-unique id, for
   * callers that hold only the execution id (e.g. a spec execution's linked
   * workflow) and need to know how a cleared run ended.
   */
  findStatusByExecutionId(executionId: string): GraphWorkflowStatus | null;
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
  // `insert` runs inside the lease reservation's immediate transaction when a
  // lease-free incumbent is normalized, so this branch is reachable while
  // SQLite's write lock is held.
  emitOrDeferRepositoryLog(() =>
    logger.error(
      "state-store.graph-workflow-archived-executions.schema_validation_failure",
      { identifier, issues },
    ),
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

type DecodeResult =
  | { ok: true; value: GraphWorkflowExecution }
  | { ok: false; issues: unknown };

/**
 * The one archived-blob read rule, shared by the point lookup and the list:
 * apply the read-only archived assignment floor, then pass the result through
 * the same legacy and edge-id inflate boundary as an active execution. Never
 * writes back — a finished run's record is what it was. Returning a result
 * instead of throwing lets the list skip a broken row while the point lookup
 * still fails loudly.
 */
function decodeArchivedBlob(executionId: string, raw: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_json",
          path: ["execution_json"],
          message: getErrorMessage(err),
        },
      ],
    };
  }

  const upgraded = upgradeLegacyArchivedExecutionBlob(parsed);
  const decoded = decodeGraphWorkflowExecution(upgraded);
  if (!decoded.ok) return { ok: false, issues: decoded.issues };
  if (decoded.value === null) {
    return {
      ok: false,
      issues: [
        {
          code: "null_execution",
          path: ["execution_json"],
          message: "archived execution decoded to null",
        },
      ],
    };
  }
  if (upgraded !== parsed) {
    emitOrDeferRepositoryLog(() =>
      logger.info(
        "state-store.graph-workflow-archived-executions.legacy_decode",
        { executionId },
      ),
    );
  }
  return { ok: true, value: decoded.value };
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
    emitOrDeferRepositoryLog(() =>
      logger.info(
        `state-store.graph-workflow-archived-executions.${op}.timing`,
        payload,
      ),
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
  const listBySessionStmt = db.prepare(
    `SELECT execution_id, execution_json
       FROM graph_workflow_archived_executions
      WHERE project_path = ? AND session_name = ?
      ORDER BY archived_at DESC, execution_id DESC`,
  );
  const findByExecutionIdStmt = db.prepare(
    `SELECT execution_json
       FROM graph_workflow_archived_executions
      WHERE execution_id = ?
      ORDER BY archived_at DESC
      LIMIT 1`,
  );
  const findStatusStmt = db.prepare(
    `SELECT status
       FROM graph_workflow_archived_executions
      WHERE execution_id = ?
      ORDER BY archived_at DESC
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
          const decoded = decodeArchivedBlob(
            executionId,
            (row as { execution_json: string }).execution_json,
          );
          if (decoded.ok) return decoded.value;
          return logAndThrowValidationFailure(executionId, decoded.issues);
        },
      );
    },
    findByExecutionId(executionId) {
      return timed("findByExecutionId", { executionId }, () => {
        const row: unknown = findByExecutionIdStmt.get(executionId);
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
        const decoded = decodeArchivedBlob(
          executionId,
          (row as { execution_json: string }).execution_json,
        );
        if (decoded.ok) return decoded.value;
        return logAndThrowValidationFailure(executionId, decoded.issues);
      });
    },
    listBySession(projectPath, sessionName) {
      return timed("listBySession", { projectPath, sessionName }, () => {
        const rows = listBySessionStmt.all(
          projectPath,
          sessionName,
        ) as unknown[];
        const executions: GraphWorkflowExecution[] = [];
        for (const row of rows) {
          if (
            typeof row !== "object" ||
            row === null ||
            typeof (row as { execution_id?: unknown }).execution_id !==
              "string" ||
            typeof (row as { execution_json?: unknown }).execution_json !==
              "string"
          ) {
            // Deferral-aware like the rest of this repository. `listBySession`
            // has no serialized-section caller today, so this is uniformity
            // rather than a live fix — but the repository's other writer DOES
            // run inside the reservation transaction, and a future history
            // projection pulled in beside it would otherwise reintroduce
            // synchronous log I/O under SQLite's write lock. Outside a capture
            // this emits immediately.
            emitOrDeferRepositoryLog(() =>
              logger.warn(
                "state-store.graph-workflow-archived-executions.list_row_skipped",
                { projectPath, sessionName, reason: "invalid_row_shape" },
              ),
            );
            continue;
          }
          const { execution_id: executionId, execution_json: executionJson } =
            row as { execution_id: string; execution_json: string };
          const decoded = decodeArchivedBlob(executionId, executionJson);
          if (!decoded.ok) {
            emitOrDeferRepositoryLog(() =>
              logger.warn(
                "state-store.graph-workflow-archived-executions.list_row_skipped",
                {
                  projectPath,
                  sessionName,
                  executionId,
                  reason: "undecodable",
                  issues: decoded.issues,
                },
              ),
            );
            continue;
          }
          executions.push(decoded.value);
        }
        return executions;
      });
    },
    findStatusByExecutionId(executionId) {
      return timed("findStatusByExecutionId", { executionId }, () => {
        const row: unknown = findStatusStmt.get(executionId);
        if (row === undefined) return null;
        const status = (row as { status?: unknown }).status;
        const result = graphWorkflowStatusSchema.safeParse(status);
        if (!result.success) {
          return logAndThrowValidationFailure(executionId, result.error.issues);
        }
        return result.data;
      });
    },
  };
}
