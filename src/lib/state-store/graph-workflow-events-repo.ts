import type Database from "better-sqlite3";
import { createLogger } from "@/lib/logging";
import {
  graphWorkflowExecutionEventSchema,
  type GraphWorkflowExecutionEvent,
} from "@/lib/workflow-graph/event-schemas";
import { PersistenceError } from "../shared/errors";
import { getErrorMessage } from "@/lib/shared/errors";
type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.graph-workflow-events");

/**
 * Persisted append-only event log for graph-workflow executions. Each row is one
 * {@link GraphWorkflowExecutionEvent} (an SSE event plus its capture timestamp
 * and the post-reset marker). Rows are ordered by the auto-increment `id`, whose
 * global insertion order coincides with per-execution append order, so a `WHERE
 * execution_id = ? ORDER BY id` scan reproduces the event stream exactly.
 *
 * This table replaces the unbounded `execution.history[]` array that used to
 * live inside the session's `graph_workflow_execution` JSON blob, eliminating the
 * write amplification of rewriting the whole blob on every event.
 */
export interface GraphWorkflowEventsRepo {
  appendMany(
    projectPath: string,
    sessionName: string,
    executionId: string,
    occurredAt: string,
    events: GraphWorkflowExecutionEvent[],
  ): void;
  findByExecution(executionId: string): GraphWorkflowExecutionEvent[];
  findTail(executionId: string, limit: number): GraphWorkflowExecutionEvent[];
  findLatestForContext(
    executionId: string,
    contextId: string,
    eventType: string,
  ): GraphWorkflowExecutionEvent | null;
  markPreReset(
    executionId: string,
    contextId: string,
    boundaryId: number,
  ): number;
  deleteByExecution(executionId: string): void;
}

interface EventStorageRow {
  occurred_at: string;
  event_type: string;
  context_id: string | null;
  pre_reset: number;
  event_json: string;
}

/**
 * Extract the `contextId` the event directly targets, if any. Events whose SSE
 * payload carries a discrete `contextId` field are filed under it so the
 * context-scoped indexes (reset marking, latest-validation lookup) can answer
 * with a single index range rather than a full-execution scan.
 */
function extractContextId(
  event: GraphWorkflowExecutionEvent["event"],
): string | null {
  if ("contextId" in event && typeof event.contextId === "string") {
    return event.contextId;
  }
  return null;
}

function eventToStorageRow(
  event: GraphWorkflowExecutionEvent,
  fallbackOccurredAt: string,
): EventStorageRow {
  return {
    occurred_at:
      event.occurredAt === "" ? fallbackOccurredAt : event.occurredAt,
    event_type: event.event.type,
    context_id: extractContextId(event.event),
    pre_reset: event.preReset ? 1 : 0,
    event_json: JSON.stringify(event.event),
  };
}

function logAndThrowValidationFailure(
  executionId: string,
  issues: unknown,
): never {
  logger.error("state-store.graph-workflow-events.schema_validation_failure", {
    executionId,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity: "graph_workflow_event",
    identifier: executionId,
    issues,
  });
}

function isStorageRow(value: unknown): value is EventStorageRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.occurred_at === "string" &&
    typeof row.event_type === "string" &&
    (row.context_id === null || typeof row.context_id === "string") &&
    (row.pre_reset === 0 || row.pre_reset === 1) &&
    typeof row.event_json === "string"
  );
}

function rowToDomain(
  executionId: string,
  rawRow: unknown,
): GraphWorkflowExecutionEvent {
  if (!isStorageRow(rawRow)) {
    return logAndThrowValidationFailure(executionId, [
      { code: "invalid_row_shape", path: [], message: "unexpected row shape" },
    ]);
  }

  let parsedEvent: unknown;
  try {
    parsedEvent = JSON.parse(rawRow.event_json);
  } catch (err) {
    return logAndThrowValidationFailure(executionId, [
      {
        code: "invalid_json",
        path: ["event_json"],
        message: getErrorMessage(err),
      },
    ]);
  }

  const candidate = {
    occurredAt: rawRow.occurred_at,
    event: parsedEvent,
    preReset: rawRow.pre_reset === 1,
  };
  const result = graphWorkflowExecutionEventSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(executionId, result.error.issues);
  }
  return result.data;
}

function timed<T>(
  op: string,
  identifier: { executionId?: string; contextId?: string },
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    const payload: Record<string, unknown> = { durationMs };
    if (identifier.executionId !== undefined) {
      payload.executionId = identifier.executionId;
    }
    if (identifier.contextId !== undefined) {
      payload.contextId = identifier.contextId;
    }
    logger.info(`state-store.graph-workflow-events.${op}.timing`, payload);
  }
}

export function createGraphWorkflowEventsRepo(db: Db): GraphWorkflowEventsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO graph_workflow_events (
       project_path, session_name, execution_id, occurred_at,
       event_type, context_id, pre_reset, event_json
     ) VALUES (
       @project_path, @session_name, @execution_id, @occurred_at,
       @event_type, @context_id, @pre_reset, @event_json
     )`,
  );
  const findByExecutionStmt = db.prepare(
    `SELECT occurred_at, event_type, context_id, pre_reset, event_json
       FROM graph_workflow_events
      WHERE execution_id = ?
      ORDER BY id ASC`,
  );
  const findTailStmt = db.prepare(
    `SELECT occurred_at, event_type, context_id, pre_reset, event_json
       FROM graph_workflow_events
      WHERE execution_id = ?
      ORDER BY id DESC
      LIMIT ?`,
  );
  const findLatestForContextStmt = db.prepare(
    `SELECT occurred_at, event_type, context_id, pre_reset, event_json
       FROM graph_workflow_events
      WHERE execution_id = ? AND context_id = ? AND event_type = ?
      ORDER BY id DESC
      LIMIT 1`,
  );
  const markPreResetStmt = db.prepare(
    `UPDATE graph_workflow_events
        SET pre_reset = 1
      WHERE execution_id = ? AND context_id = ? AND id <= ? AND pre_reset = 0`,
  );
  const deleteByExecutionStmt = db.prepare(
    `DELETE FROM graph_workflow_events WHERE execution_id = ?`,
  );

  const insertManyTxn = db.transaction(
    (
      projectPath: string,
      sessionName: string,
      executionId: string,
      occurredAt: string,
      events: GraphWorkflowExecutionEvent[],
    ) => {
      for (const event of events) {
        const storage = eventToStorageRow(event, occurredAt);
        insertStmt.run({
          project_path: projectPath,
          session_name: sessionName,
          execution_id: executionId,
          occurred_at: storage.occurred_at,
          event_type: storage.event_type,
          context_id: storage.context_id,
          pre_reset: storage.pre_reset,
          event_json: storage.event_json,
        });
      }
    },
  );

  return {
    appendMany(projectPath, sessionName, executionId, occurredAt, events) {
      if (events.length === 0) return;
      timed("appendMany", { executionId }, () => {
        insertManyTxn(
          projectPath,
          sessionName,
          executionId,
          occurredAt,
          events,
        );
      });
    },
    findByExecution(executionId) {
      return timed("findByExecution", { executionId }, () => {
        const rows = findByExecutionStmt.all(executionId) as unknown[];
        return rows.map((row) => rowToDomain(executionId, row));
      });
    },
    findTail(executionId, limit) {
      return timed("findTail", { executionId }, () => {
        const rows = findTailStmt.all(executionId, limit) as unknown[];
        return rows.map((row) => rowToDomain(executionId, row)).reverse();
      });
    },
    findLatestForContext(executionId, contextId, eventType) {
      return timed("findLatestForContext", { executionId, contextId }, () => {
        const row: unknown = findLatestForContextStmt.get(
          executionId,
          contextId,
          eventType,
        );
        if (row === undefined) return null;
        return rowToDomain(executionId, row);
      });
    },
    markPreReset(executionId, contextId, boundaryId) {
      return timed("markPreReset", { executionId, contextId }, () => {
        const info = markPreResetStmt.run(executionId, contextId, boundaryId);
        return info.changes;
      });
    },
    deleteByExecution(executionId) {
      timed("deleteByExecution", { executionId }, () => {
        deleteByExecutionStmt.run(executionId);
      });
    },
  };
}
