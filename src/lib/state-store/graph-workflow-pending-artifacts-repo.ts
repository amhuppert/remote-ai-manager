import type Database from "better-sqlite3";
import { createLogger } from "@/lib/logging";
import { emitOrDeferRepositoryLog } from "@/lib/state-store/deferred-repo-logging";
import {
  graphWorkflowPendingArtifactsSchema,
  type GraphWorkflowPendingArtifacts,
} from "@/lib/workflow-graph/schemas";
import { PersistenceError } from "../shared/errors";
import { getErrorMessage } from "@/lib/shared/errors";
import { stableStringify } from "./serialization";
import { checkRowColumnSize } from "./row-size-telemetry";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.graph-workflow-pending-artifacts");

/**
 * The launch-artifact reconstruction record (D7 R3.4): what a reserved
 * execution still owes the filesystem, written in the reserving transaction and
 * deleted once the writes land.
 *
 * It exists because the lease CAS deliberately precedes every `.cc` write — a
 * losing racer must leave no bytes — which means a crash in between produces a
 * durable run whose seeded documents were never written and whose CONTENTS live
 * nowhere else: the execution row carries registrations, not bytes. Presence of
 * a row here is therefore both the data and the marker a retry needs.
 */
export interface GraphWorkflowPendingArtifactsRepo {
  /**
   * Record what one reserved execution still owes. Replaces any prior record
   * for the same execution, so a re-reservation of the same id converges rather
   * than conflicting.
   */
  record(pending: GraphWorkflowPendingArtifacts): void;
  /**
   * One execution's outstanding artifacts, or null when it has none — which is
   * the durable statement that its materialization already succeeded. Keyed by
   * the full project/session/execution triple so a same-id record from another
   * session can never reach a retry.
   */
  find(
    projectPath: string,
    sessionName: string,
    executionId: string,
  ): GraphWorkflowPendingArtifacts | null;
  /** Settle one execution's record. Returns false when there was none. */
  clear(executionId: string): boolean;
}

interface StorageRow {
  execution_id: string;
  project_path: string;
  session_name: string;
  documents_json: string;
  recorded_at: string;
}

function isStorageRow(value: unknown): value is StorageRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.execution_id === "string" &&
    typeof row.project_path === "string" &&
    typeof row.session_name === "string" &&
    typeof row.documents_json === "string" &&
    typeof row.recorded_at === "string"
  );
}

function logAndThrowValidationFailure(
  identifier: string,
  issues: unknown,
): never {
  // `record` runs inside the lease reservation's immediate transaction, so this
  // branch is reachable while SQLite's write lock is held.
  emitOrDeferRepositoryLog(() =>
    logger.error(
      "state-store.graph-workflow-pending-artifacts.schema_validation_failure",
      { identifier, issues },
    ),
  );
  throw new PersistenceError({
    kind: "validation",
    entity: "graph_workflow_pending_artifacts",
    identifier,
    issues,
  });
}

function rowToDomain(row: unknown): GraphWorkflowPendingArtifacts {
  if (!isStorageRow(row)) {
    return logAndThrowValidationFailure("<row>", [
      { code: "invalid_row_shape", path: [], message: "unexpected row shape" },
    ]);
  }
  let documents: unknown;
  try {
    documents = JSON.parse(row.documents_json);
  } catch (err) {
    return logAndThrowValidationFailure(row.execution_id, [
      {
        code: "invalid_json",
        path: ["documents_json"],
        message: getErrorMessage(err),
      },
    ]);
  }
  const parsed = graphWorkflowPendingArtifactsSchema.safeParse({
    executionId: row.execution_id,
    projectPath: row.project_path,
    sessionName: row.session_name,
    documents,
    recordedAt: row.recorded_at,
  });
  if (!parsed.success) {
    return logAndThrowValidationFailure(row.execution_id, parsed.error.issues);
  }
  return parsed.data;
}

export function createGraphWorkflowPendingArtifactsRepo(
  db: Db,
): GraphWorkflowPendingArtifactsRepo {
  const upsertStmt = db.prepare(
    `INSERT INTO graph_workflow_pending_artifacts (
       execution_id, project_path, session_name, documents_json, recorded_at
     ) VALUES (
       @execution_id, @project_path, @session_name, @documents_json, @recorded_at
     )
     ON CONFLICT(execution_id) DO UPDATE SET
       project_path   = excluded.project_path,
       session_name   = excluded.session_name,
       documents_json = excluded.documents_json,
       recorded_at    = excluded.recorded_at`,
  );
  const findStmt = db.prepare(
    `SELECT * FROM graph_workflow_pending_artifacts
      WHERE project_path = ? AND session_name = ? AND execution_id = ?
      LIMIT 1`,
  );
  const clearStmt = db.prepare(
    `DELETE FROM graph_workflow_pending_artifacts WHERE execution_id = ?`,
  );

  return {
    record(pending) {
      const validated = graphWorkflowPendingArtifactsSchema.parse(pending);
      const documentsJson = stableStringify(validated.documents);
      checkRowColumnSize({
        logger,
        table: "graph_workflow_pending_artifacts",
        column: "documents_json",
        id: validated.executionId,
        value: documentsJson,
      });
      upsertStmt.run({
        execution_id: validated.executionId,
        project_path: validated.projectPath,
        session_name: validated.sessionName,
        documents_json: documentsJson,
        recorded_at: validated.recordedAt,
      });
    },
    find(projectPath, sessionName, executionId) {
      const row: unknown = findStmt.get(projectPath, sessionName, executionId);
      if (row === undefined) return null;
      return rowToDomain(row);
    },
    clear(executionId) {
      return clearStmt.run(executionId).changes > 0;
    },
  };
}
