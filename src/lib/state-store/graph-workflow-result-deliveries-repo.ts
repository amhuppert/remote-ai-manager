import type Database from "better-sqlite3";
import { createLogger } from "@/lib/logging";
import { emitOrDeferRepositoryLog } from "@/lib/state-store/deferred-repo-logging";
import {
  graphWorkflowResultDeliverySchema,
  type GraphWorkflowResultDelivery,
} from "@/lib/workflow-graph/schemas";
import { PersistenceError } from "../shared/errors";
import { getErrorMessage } from "@/lib/shared/errors";
import { stableStringify } from "./serialization";
import { checkRowColumnSize } from "./row-size-telemetry";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.graph-workflow-result-deliveries");

/**
 * The result-delivery ledger (D7 decision D8): one durable record per lifecycle
 * boundary of an execution whose origin conversation is alive, recorded in the
 * same transaction as the boundary's event append.
 *
 * Deliberately NOT a message queue. Nothing here dispatches an agent turn or
 * touches `conversations.pending_queue`; the states are the queue's proven
 * claim/recover/settle shape reused for a passive ledger a turn reads from.
 * `delivering` is a claim rather than an outcome, which is what makes the
 * contract exactly-once per ACKNOWLEDGED turn: a turn that dies before
 * acknowledgment releases its claim through {@link
 * GraphWorkflowResultDeliveriesRepo.resetDeliveringToPending} and the same
 * boundary re-presents under its stable identity.
 */
export interface GraphWorkflowResultDeliveriesRepo {
  /**
   * Record a boundary's result. Returns false when this boundary is already in
   * the ledger, leaving the stored row untouched — the replay a crash between
   * recording and attachment produces is a no-op, not a second delivery.
   */
  record(delivery: GraphWorkflowResultDelivery): boolean;
  /**
   * One boundary's record. Keyed by the full project/session/execution triple
   * like every other read here, so a same-id record from another session can
   * never reach a projection.
   */
  findByBoundary(
    projectPath: string,
    sessionName: string,
    executionId: string,
    boundarySeq: number,
  ): GraphWorkflowResultDelivery | null;
  /**
   * The boundaries a turn of this conversation still owes, in boundary order.
   * Scoped by the full project/session/conversation triple so a same-id record
   * from another session can never reach a turn.
   */
  listUndeliveredForConversation(
    projectPath: string,
    sessionName: string,
    originConversationId: string,
  ): GraphWorkflowResultDelivery[];
  /** One execution's whole ledger, in boundary order. */
  listByExecution(
    projectPath: string,
    sessionName: string,
    executionId: string,
  ): GraphWorkflowResultDelivery[];
  /** Rows whose post-commit publication/unread/push effects still need replay. */
  listPendingEffects(
    projectPath: string,
    sessionName: string,
  ): GraphWorkflowResultDelivery[];
  /**
   * Claim a pending boundary for `attemptId`, counting the attempt. Returns
   * false when the boundary is absent or already claimed or settled.
   */
  markDelivering(
    projectPath: string,
    sessionName: string,
    executionId: string,
    boundarySeq: number,
    attemptId: string,
  ): boolean;
  /**
   * Settle the claim `attemptId` holds. Returns false when another attempt
   * holds the boundary, so a stale turn cannot mark someone else's claim
   * delivered.
   */
  markDelivered(
    projectPath: string,
    sessionName: string,
    executionId: string,
    boundarySeq: number,
    attemptId: string,
    deliveredAt: string,
  ): boolean;
  /** Persist the post-commit effect receipt without settling turn attachment. */
  markEffectsDelivered(
    projectPath: string,
    sessionName: string,
    executionId: string,
    boundarySeq: number,
    effectsDeliveredAt: string,
  ): boolean;
  /** Settle one missing-origin boundary without manufacturing a turn claim. */
  markFallbackDelivered(
    projectPath: string,
    sessionName: string,
    executionId: string,
    boundarySeq: number,
    deliveredAt: string,
  ): boolean;
  /** Settle every unattachable boundary after an execution loses its origin. */
  markExecutionFallbackDelivered(
    projectPath: string,
    sessionName: string,
    executionId: string,
    originConversationId: string,
    deliveredAt: string,
  ): number;
  /** Release one failed turn's unacknowledged claims without touching peers. */
  resetAttemptToPending(
    projectPath: string,
    sessionName: string,
    originConversationId: string,
    attemptId: string,
  ): number;
  /**
   * Release every unacknowledged claim in a session back to `pending`, the way
   * message-queue rehydration does. Returns how many claims were released.
   */
  resetDeliveringToPending(projectPath: string, sessionName: string): number;
}

interface StorageRow {
  execution_id: string;
  boundary_seq: number;
  project_path: string;
  session_name: string;
  origin_conversation_id: string;
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
    typeof row.origin_conversation_id === "string" &&
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
  const listUndeliveredStmt = db.prepare(
    `SELECT * FROM graph_workflow_result_deliveries
      WHERE project_path = ? AND session_name = ?
        AND origin_conversation_id = ? AND delivery_state <> 'delivered'
      ORDER BY boundary_seq`,
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
  const claimStmt = db.prepare(
    `UPDATE graph_workflow_result_deliveries
        SET delivery_state = 'delivering',
            attempt_id     = @attempt_id,
            attempt_count  = attempt_count + 1
      WHERE project_path = @project_path AND session_name = @session_name
        AND execution_id = @execution_id AND boundary_seq = @boundary_seq
        AND delivery_state = 'pending'`,
  );
  const settleStmt = db.prepare(
    `UPDATE graph_workflow_result_deliveries
        SET delivery_state = 'delivered',
            delivered_at   = @delivered_at
      WHERE project_path = @project_path AND session_name = @session_name
        AND execution_id = @execution_id AND boundary_seq = @boundary_seq
        AND delivery_state = 'delivering' AND attempt_id = @attempt_id`,
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
  const releaseStmt = db.prepare(
    `UPDATE graph_workflow_result_deliveries
        SET delivery_state = 'pending',
            attempt_id     = NULL
      WHERE project_path = ? AND session_name = ?
        AND delivery_state = 'delivering'`,
  );
  const releaseAttemptStmt = db.prepare(
    `UPDATE graph_workflow_result_deliveries
        SET delivery_state = 'pending',
            attempt_id     = NULL
      WHERE project_path = ? AND session_name = ?
        AND origin_conversation_id = ? AND attempt_id = ?
        AND delivery_state = 'delivering'`,
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
    listUndeliveredForConversation(
      projectPath,
      sessionName,
      originConversationId,
    ) {
      return readMany(
        listUndeliveredStmt.all(
          projectPath,
          sessionName,
          originConversationId,
        ) as unknown[],
      );
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
    markDelivering(
      projectPath,
      sessionName,
      executionId,
      boundarySeq,
      attemptId,
    ) {
      const result = claimStmt.run({
        project_path: projectPath,
        session_name: sessionName,
        execution_id: executionId,
        boundary_seq: boundarySeq,
        attempt_id: attemptId,
      });
      return result.changes > 0;
    },
    markDelivered(
      projectPath,
      sessionName,
      executionId,
      boundarySeq,
      attemptId,
      deliveredAt,
    ) {
      const result = settleStmt.run({
        project_path: projectPath,
        session_name: sessionName,
        execution_id: executionId,
        boundary_seq: boundarySeq,
        attempt_id: attemptId,
        delivered_at: deliveredAt,
      });
      return result.changes > 0;
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
    resetAttemptToPending(
      projectPath,
      sessionName,
      originConversationId,
      attemptId,
    ) {
      return releaseAttemptStmt.run(
        projectPath,
        sessionName,
        originConversationId,
        attemptId,
      ).changes;
    },
    resetDeliveringToPending(projectPath, sessionName) {
      const result = releaseStmt.run(projectPath, sessionName);
      return result.changes;
    },
  };
}
