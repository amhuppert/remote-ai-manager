import type Database from "better-sqlite3";
import { createLogger } from "@/lib/logging";
import { emitOrDeferRepositoryLog } from "@/lib/state-store/deferred-repo-logging";
import {
  graphWorkflowResultDeliverySchema,
  type GraphWorkflowResultDelivery,
} from "@/lib/workflow-graph/schemas";
import { PersistenceError } from "../shared/errors";
import { getErrorMessage } from "@/lib/shared/errors";
import { stableStringify } from "@/lib/shared/stable-stringify";
import { checkRowColumnSize } from "./row-size-telemetry";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.graph-workflow-result-deliveries");

/**
 * Frozen lifecycle-boundary evidence, plus receipts for origin notification
 * effects. Agent input receipts belong to the subscription inbox. Legacy claim
 * fields remain readable so ordered migrations can preserve historical proof.
 */
export interface GraphWorkflowResultDeliveriesRepo {
  /** Recording a repeated boundary leaves its frozen snapshot untouched. */
  record(delivery: GraphWorkflowResultDelivery): boolean;
  findByBoundary(
    projectPath: string,
    sessionName: string,
    executionId: string,
    boundarySeq: number,
  ): GraphWorkflowResultDelivery | null;
  listByExecution(
    projectPath: string,
    sessionName: string,
    executionId: string,
  ): GraphWorkflowResultDelivery[];
  listPendingEffects(
    projectPath: string,
    sessionName: string,
  ): GraphWorkflowResultDelivery[];
  markEffectsDelivered(
    projectPath: string,
    sessionName: string,
    executionId: string,
    boundarySeq: number,
    effectsDeliveredAt: string,
  ): boolean;
  /** Missing-origin notification settlement is not backend input acceptance. */
  markFallbackDelivered(
    projectPath: string,
    sessionName: string,
    executionId: string,
    boundarySeq: number,
    deliveredAt: string,
  ): boolean;
  markExecutionFallbackDelivered(
    projectPath: string,
    sessionName: string,
    executionId: string,
    originConversationId: string,
    deliveredAt: string,
  ): number;
}

interface StorageRow {
  execution_id: string;
  boundary_seq: number;
  project_path: string;
  session_name: string;
  origin_conversation_id: string | null;
  payload_json: string;
  recorded_at: string;
  delivery_state: string;
  attempt_id: string | null;
  attempt_count: number;
  delivered_at: string | null;
  effects_delivered_at: string | null;
}

function isStorageRow(value: unknown): value is StorageRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.execution_id === "string" &&
    typeof row.boundary_seq === "number" &&
    typeof row.project_path === "string" &&
    typeof row.session_name === "string" &&
    (typeof row.origin_conversation_id === "string" ||
      row.origin_conversation_id === null) &&
    typeof row.payload_json === "string" &&
    typeof row.recorded_at === "string" &&
    typeof row.delivery_state === "string" &&
    typeof row.attempt_count === "number"
  );
}

function logAndThrowValidationFailure(
  identifier: string,
  issues: unknown,
): never {
  emitOrDeferRepositoryLog(() =>
    logger.error(
      "state-store.graph-workflow-result-deliveries.schema_validation_failure",
      { identifier, issues },
    ),
  );
  throw new PersistenceError({
    kind: "validation",
    entity: "graph_workflow_result_delivery",
    identifier,
    issues,
  });
}

function rowToDomain(row: unknown): GraphWorkflowResultDelivery {
  if (!isStorageRow(row)) {
    return logAndThrowValidationFailure("<row>", [
      { code: "invalid_row_shape", path: [], message: "unexpected row shape" },
    ]);
  }
  const identifier = `${row.execution_id}::${row.boundary_seq}`;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (err) {
    return logAndThrowValidationFailure(identifier, [
      {
        code: "invalid_json",
        path: ["payload_json"],
        message: getErrorMessage(err),
      },
    ]);
  }
  const parsed = graphWorkflowResultDeliverySchema.safeParse({
    executionId: row.execution_id,
    boundarySeq: row.boundary_seq,
    projectPath: row.project_path,
    sessionName: row.session_name,
    originConversationId: row.origin_conversation_id,
    payload,
    recordedAt: row.recorded_at,
    state: row.delivery_state,
    attemptId: row.attempt_id,
    attemptCount: row.attempt_count,
    deliveredAt: row.delivered_at,
    effectsDeliveredAt: row.effects_delivered_at,
  });
  if (!parsed.success) {
    return logAndThrowValidationFailure(identifier, parsed.error.issues);
  }
  return parsed.data;
}

function readMany(rows: unknown[]): GraphWorkflowResultDelivery[] {
  return rows.map((row) => rowToDomain(row));
}

export function createGraphWorkflowResultDeliveriesRepo(
  db: Db,
): GraphWorkflowResultDeliveriesRepo {
  // INSERT OR IGNORE against the (execution_id, boundary_seq) primary key is
  // what makes a replayed recording a no-op rather than a conflict the caller
  // has to interpret.
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO graph_workflow_result_deliveries (
       execution_id, boundary_seq, project_path, session_name,
       origin_conversation_id, payload_json, recorded_at, delivery_state,
       attempt_id, attempt_count, delivered_at, effects_delivered_at
     ) VALUES (
       @execution_id, @boundary_seq, @project_path, @session_name,
       @origin_conversation_id, @payload_json, @recorded_at, @delivery_state,
       @attempt_id, @attempt_count, @delivered_at, @effects_delivered_at
     )`,
  );
  const findStmt = db.prepare(
    `SELECT * FROM graph_workflow_result_deliveries
      WHERE project_path = ? AND session_name = ?
        AND execution_id = ? AND boundary_seq = ?
      LIMIT 1`,
  );
  const listByExecutionStmt = db.prepare(
    `SELECT * FROM graph_workflow_result_deliveries
      WHERE project_path = ? AND session_name = ? AND execution_id = ?
      ORDER BY boundary_seq`,
  );
  const listPendingEffectsStmt = db.prepare(
    `SELECT * FROM graph_workflow_result_deliveries
      WHERE project_path = ? AND session_name = ?
        AND effects_delivered_at IS NULL
      ORDER BY boundary_seq`,
  );
  const settleEffectsStmt = db.prepare(
    `UPDATE graph_workflow_result_deliveries
        SET effects_delivered_at = @effects_delivered_at
      WHERE project_path = @project_path AND session_name = @session_name
        AND execution_id = @execution_id AND boundary_seq = @boundary_seq
        AND effects_delivered_at IS NULL`,
  );
  const settleFallbackStmt = db.prepare(
    `UPDATE graph_workflow_result_deliveries
        SET delivery_state = 'delivered',
            attempt_id     = NULL,
            delivered_at   = @delivered_at
      WHERE project_path = @project_path AND session_name = @session_name
        AND execution_id = @execution_id AND boundary_seq = @boundary_seq
        AND delivery_state <> 'delivered'`,
  );
  const settleExecutionFallbackStmt = db.prepare(
    `UPDATE graph_workflow_result_deliveries
        SET delivery_state = 'delivered',
            attempt_id     = NULL,
            delivered_at   = @delivered_at
      WHERE project_path = @project_path AND session_name = @session_name
        AND execution_id = @execution_id
        AND origin_conversation_id = @origin_conversation_id
        AND delivery_state <> 'delivered'`,
  );
  return {
    record(delivery) {
      const validated = graphWorkflowResultDeliverySchema.parse(delivery);
      const payloadJson = stableStringify(validated.payload);
      checkRowColumnSize({
        logger,
        table: "graph_workflow_result_deliveries",
        column: "payload_json",
        id: `${validated.executionId}::${validated.boundarySeq}`,
        value: payloadJson,
      });
      const result = insertStmt.run({
        execution_id: validated.executionId,
        boundary_seq: validated.boundarySeq,
        project_path: validated.projectPath,
        session_name: validated.sessionName,
        origin_conversation_id: validated.originConversationId,
        payload_json: payloadJson,
        recorded_at: validated.recordedAt,
        delivery_state: validated.state,
        attempt_id: validated.attemptId,
        attempt_count: validated.attemptCount,
        delivered_at: validated.deliveredAt,
        effects_delivered_at: validated.effectsDeliveredAt,
      });
      return result.changes > 0;
    },
    findByBoundary(projectPath, sessionName, executionId, boundarySeq) {
      const row: unknown = findStmt.get(
        projectPath,
        sessionName,
        executionId,
        boundarySeq,
      );
      if (row === undefined) return null;
      return rowToDomain(row);
    },
    listByExecution(projectPath, sessionName, executionId) {
      return readMany(
        listByExecutionStmt.all(
          projectPath,
          sessionName,
          executionId,
        ) as unknown[],
      );
    },
    listPendingEffects(projectPath, sessionName) {
      return readMany(
        listPendingEffectsStmt.all(projectPath, sessionName) as unknown[],
      );
    },
    markEffectsDelivered(
      projectPath,
      sessionName,
      executionId,
      boundarySeq,
      effectsDeliveredAt,
    ) {
      const result = settleEffectsStmt.run({
        project_path: projectPath,
        session_name: sessionName,
        execution_id: executionId,
        boundary_seq: boundarySeq,
        effects_delivered_at: effectsDeliveredAt,
      });
      return result.changes > 0;
    },
    markFallbackDelivered(
      projectPath,
      sessionName,
      executionId,
      boundarySeq,
      deliveredAt,
    ) {
      const result = settleFallbackStmt.run({
        project_path: projectPath,
        session_name: sessionName,
        execution_id: executionId,
        boundary_seq: boundarySeq,
        delivered_at: deliveredAt,
      });
      return result.changes > 0;
    },
    markExecutionFallbackDelivered(
      projectPath,
      sessionName,
      executionId,
      originConversationId,
      deliveredAt,
    ) {
      const result = settleExecutionFallbackStmt.run({
        project_path: projectPath,
        session_name: sessionName,
        execution_id: executionId,
        origin_conversation_id: originConversationId,
        delivered_at: deliveredAt,
      });
      return result.changes;
    },
  };
}
