import type Database from "better-sqlite3";
import { emitOrDeferRepositoryLog } from "@/lib/state-store/deferred-repo-logging";
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
  append(
    projectPath: string,
    sessionName: string,
    executionId: string,
    occurredAt: string,
    event: GraphWorkflowExecutionEvent,
  ): GraphWorkflowEventRecord;
  appendMany(
    projectPath: string,
    sessionName: string,
    executionId: string,
    occurredAt: string,
    events: GraphWorkflowExecutionEvent[],
  ): GraphWorkflowEventRecord[];
  findByExecution(
    projectPath: string,
    sessionName: string,
    executionId: string,
  ): GraphWorkflowExecutionEvent[];
  findRecordsByExecution(
    projectPath: string,
    sessionName: string,
    executionId: string,
  ): GraphWorkflowEventRecord[];
  findRecordById(
    projectPath: string,
    sessionName: string,
    executionId: string,
    id: number,
  ): GraphWorkflowEventRecord | null;
  findBoundaryAfter(
    projectPath: string,
    sessionName: string,
    executionId: string,
    cursor?: number | null,
  ): GraphWorkflowEventRecord | null;
  findTail(
    projectPath: string,
    sessionName: string,
    executionId: string,
    limit: number,
  ): GraphWorkflowExecutionEvent[];
  findPage(
    projectPath: string,
    sessionName: string,
    executionId: string,
    query: GraphWorkflowEventPageQuery,
  ): GraphWorkflowEventPage;
  findLatestForContext(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
    eventType: string,
  ): GraphWorkflowExecutionEvent | null;
  markPreReset(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
    boundaryId: number,
  ): number;
  deleteByExecution(
    projectPath: string,
    sessionName: string,
    executionId: string,
  ): void;
}

export interface GraphWorkflowEventRecord extends GraphWorkflowExecutionEvent {
  id: number;
  projectPath: string;
  sessionName: string;
  executionId: string;
}

/** Hard ceiling on one page, whatever a caller asks for. */
export const GRAPH_WORKFLOW_EVENT_PAGE_MAX_LIMIT = 500;

/**
 * One request against the cursor-paginated reader. The cursor is the `id` of
 * the last row the caller already has — the auto-increment id IS the per-
 * execution sequence, because insertion order and append order coincide — so a
 * page is a keyset range, never an OFFSET scan that would re-read the log's head
 * on every page.
 */
export interface GraphWorkflowEventPageQuery {
  /** Rows per page, clamped to {@link GRAPH_WORKFLOW_EVENT_PAGE_MAX_LIMIT}. */
  readonly limit: number;
  /** Exclusive; null or omitted starts at the log's oldest (or newest) row. */
  readonly cursor?: number | null;
  /** `asc` reads oldest→newest (the default); `desc` reads newest→oldest. */
  readonly direction?: "asc" | "desc";
}

export interface GraphWorkflowEventPage {
  readonly records: GraphWorkflowEventRecord[];
  /**
   * The cursor for the next request, or null when this page exhausted the log —
   * so a reader terminates without a trailing empty round trip.
   */
  readonly nextCursor: number | null;
}

interface EventStorageRow {
  occurred_at: string;
  event_type: string;
  context_id: string | null;
  pre_reset: number;
  event_json: string;
}

interface EventRecordStorageRow extends EventStorageRow {
  id: number;
  project_path: string;
  session_name: string;
  execution_id: string;
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
  // `appendMany` runs inside the lease reservation's immediate transaction, so
  // this branch is reachable while SQLite's write lock is held.
  emitOrDeferRepositoryLog(() =>
    logger.error(
      "state-store.graph-workflow-events.schema_validation_failure",
      {
        executionId,
        issues,
      },
    ),
  );
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

function rowToRecord(rawRow: unknown): GraphWorkflowEventRecord {
  if (
    typeof rawRow !== "object" ||
    rawRow === null ||
    !("id" in rawRow) ||
    typeof rawRow.id !== "number" ||
    !("execution_id" in rawRow) ||
    typeof rawRow.execution_id !== "string" ||
    !("project_path" in rawRow) ||
    typeof rawRow.project_path !== "string" ||
    !("session_name" in rawRow) ||
    typeof rawRow.session_name !== "string"
  ) {
    return logAndThrowValidationFailure("unknown", [
      {
        code: "invalid_record_shape",
        path: [],
        message:
          "event record requires numeric id and project/session/execution identity",
      },
    ]);
  }
  const row = rawRow as EventRecordStorageRow;
  return {
    id: row.id,
    projectPath: row.project_path,
    sessionName: row.session_name,
    executionId: row.execution_id,
    ...rowToDomain(row.execution_id, row),
  };
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
    emitOrDeferRepositoryLog(() =>
      logger.info(`state-store.graph-workflow-events.${op}.timing`, payload),
    );
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
      WHERE project_path = ? AND session_name = ? AND execution_id = ?
      ORDER BY id ASC`,
  );
  const findRecordsByExecutionStmt = db.prepare(
    `SELECT id, project_path, session_name, execution_id, occurred_at,
            event_type, context_id, pre_reset, event_json
       FROM graph_workflow_events
      WHERE project_path = ? AND session_name = ? AND execution_id = ?
      ORDER BY id ASC`,
  );
  const findRecordByIdStmt = db.prepare(
    `SELECT id, project_path, session_name, execution_id, occurred_at,
            event_type, context_id, pre_reset, event_json
       FROM graph_workflow_events
      WHERE project_path = ? AND session_name = ? AND execution_id = ?
        AND id = ?
      LIMIT 1`,
  );
  const findBoundaryAfterStmt = db.prepare(
    `SELECT id, project_path, session_name, execution_id, occurred_at,
            event_type, context_id, pre_reset, event_json
       FROM graph_workflow_events
      WHERE project_path = ? AND session_name = ? AND execution_id = ?
        AND event_type = 'graph-workflow-boundary' AND id > ?
      ORDER BY id ASC
      LIMIT 1`,
  );
  const findTailStmt = db.prepare(
    `SELECT occurred_at, event_type, context_id, pre_reset, event_json
       FROM graph_workflow_events
      WHERE project_path = ? AND session_name = ? AND execution_id = ?
      ORDER BY id DESC
      LIMIT ?`,
  );
  // One statement per (direction, has-cursor) combination: a keyset page is a
  // different WHERE and ORDER BY, and SQLite plans each of these against the
  // full-scope execution index without a sort.
  const pageStmts = {
    asc: db.prepare(
      `SELECT id, project_path, session_name, execution_id, occurred_at,
              event_type, context_id, pre_reset, event_json
         FROM graph_workflow_events
        WHERE project_path = ? AND session_name = ? AND execution_id = ?
          AND id > ?
        ORDER BY id ASC
        LIMIT ?`,
    ),
    desc: db.prepare(
      `SELECT id, project_path, session_name, execution_id, occurred_at,
              event_type, context_id, pre_reset, event_json
         FROM graph_workflow_events
        WHERE project_path = ? AND session_name = ? AND execution_id = ?
          AND id < ?
        ORDER BY id DESC
        LIMIT ?`,
    ),
  } as const;
  const findLatestForContextStmt = db.prepare(
    `SELECT occurred_at, event_type, context_id, pre_reset, event_json
       FROM graph_workflow_events
      WHERE project_path = ? AND session_name = ? AND execution_id = ?
        AND context_id = ? AND event_type = ?
      ORDER BY id DESC
      LIMIT 1`,
  );
  const markPreResetStmt = db.prepare(
    `UPDATE graph_workflow_events
        SET pre_reset = 1
      WHERE project_path = ? AND session_name = ? AND execution_id = ?
        AND context_id = ? AND id <= ? AND pre_reset = 0`,
  );
  const deleteByExecutionStmt = db.prepare(
    `DELETE FROM graph_workflow_events
      WHERE project_path = ? AND session_name = ? AND execution_id = ?`,
  );

  const insertManyTxn = db.transaction(
    (
      projectPath: string,
      sessionName: string,
      executionId: string,
      occurredAt: string,
      events: GraphWorkflowExecutionEvent[],
    ) => {
      const records: GraphWorkflowEventRecord[] = [];
      for (const event of events) {
        const storage = eventToStorageRow(event, occurredAt);
        const inserted = insertStmt.run({
          project_path: projectPath,
          session_name: sessionName,
          execution_id: executionId,
          occurred_at: storage.occurred_at,
          event_type: storage.event_type,
          context_id: storage.context_id,
          pre_reset: storage.pre_reset,
          event_json: storage.event_json,
        });
        records.push({
          id: Number(inserted.lastInsertRowid),
          projectPath,
          sessionName,
          executionId,
          occurredAt: storage.occurred_at,
          event: event.event,
          preReset: storage.pre_reset === 1,
        });
      }
      return records;
    },
  );

  return {
    append(projectPath, sessionName, executionId, occurredAt, event) {
      const records = timed("append", { executionId }, () =>
        insertManyTxn(projectPath, sessionName, executionId, occurredAt, [
          event,
        ]),
      );
      const record = records[0];
      if (record === undefined) {
        throw new PersistenceError({
          kind: "validation",
          entity: "graph_workflow_event",
          identifier: executionId,
          issues: [
            {
              code: "insert_failed",
              path: [],
              message: "event insert returned no durable row",
            },
          ],
        });
      }
      return record;
    },
    appendMany(projectPath, sessionName, executionId, occurredAt, events) {
      if (events.length === 0) return [];
      return timed("appendMany", { executionId }, () =>
        insertManyTxn(
          projectPath,
          sessionName,
          executionId,
          occurredAt,
          events,
        ),
      );
    },
    findByExecution(projectPath, sessionName, executionId) {
      return timed("findByExecution", { executionId }, () => {
        const rows = findByExecutionStmt.all(
          projectPath,
          sessionName,
          executionId,
        ) as unknown[];
        return rows.map((row) => rowToDomain(executionId, row));
      });
    },
    findRecordsByExecution(projectPath, sessionName, executionId) {
      return timed("findRecordsByExecution", { executionId }, () => {
        const rows = findRecordsByExecutionStmt.all(
          projectPath,
          sessionName,
          executionId,
        ) as unknown[];
        return rows.map(rowToRecord);
      });
    },
    findRecordById(projectPath, sessionName, executionId, id) {
      return timed("findRecordById", { executionId }, () => {
        const row: unknown = findRecordByIdStmt.get(
          projectPath,
          sessionName,
          executionId,
          id,
        );
        return row === undefined ? null : rowToRecord(row);
      });
    },
    findBoundaryAfter(projectPath, sessionName, executionId, cursor) {
      return timed("findBoundaryAfter", { executionId }, () => {
        const row: unknown = findBoundaryAfterStmt.get(
          projectPath,
          sessionName,
          executionId,
          cursor ?? 0,
        );
        return row === undefined ? null : rowToRecord(row);
      });
    },
    findTail(projectPath, sessionName, executionId, limit) {
      return timed("findTail", { executionId }, () => {
        const rows = findTailStmt.all(
          projectPath,
          sessionName,
          executionId,
          limit,
        ) as unknown[];
        return rows.map((row) => rowToDomain(executionId, row)).reverse();
      });
    },
    findPage(projectPath, sessionName, executionId, query) {
      if (!Number.isInteger(query.limit) || query.limit < 1) {
        throw new PersistenceError({
          kind: "validation",
          entity: "graph_workflow_event",
          identifier: executionId,
          issues: [
            {
              code: "invalid_limit",
              path: ["limit"],
              message: "page limit must be a positive integer",
            },
          ],
        });
      }
      return timed("findPage", { executionId }, () => {
        const direction = query.direction ?? "asc";
        const limit = Math.min(
          query.limit,
          GRAPH_WORKFLOW_EVENT_PAGE_MAX_LIMIT,
        );
        // An absent cursor means "from the end of the log this direction starts
        // at"; the sentinels are the open bounds of the id space, so the same
        // keyset statement serves the first page and every later one.
        const cursor =
          query.cursor ?? (direction === "asc" ? 0 : Number.MAX_SAFE_INTEGER);
        // One row past the page, so exhaustion is observed rather than guessed:
        // a full page that happens to end on the log's last row still reports
        // no cursor.
        const rows = pageStmts[direction].all(
          projectPath,
          sessionName,
          executionId,
          cursor,
          limit + 1,
        ) as unknown[];
        const hasMore = rows.length > limit;
        const records = rows.slice(0, limit).map(rowToRecord);
        return {
          records,
          nextCursor: hasMore
            ? (records[records.length - 1]?.id ?? null)
            : null,
        };
      });
    },
    findLatestForContext(
      projectPath,
      sessionName,
      executionId,
      contextId,
      eventType,
    ) {
      return timed("findLatestForContext", { executionId, contextId }, () => {
        const row: unknown = findLatestForContextStmt.get(
          projectPath,
          sessionName,
          executionId,
          contextId,
          eventType,
        );
        if (row === undefined) return null;
        return rowToDomain(executionId, row);
      });
    },
    markPreReset(projectPath, sessionName, executionId, contextId, boundaryId) {
      return timed("markPreReset", { executionId, contextId }, () => {
        const info = markPreResetStmt.run(
          projectPath,
          sessionName,
          executionId,
          contextId,
          boundaryId,
        );
        return info.changes;
      });
    },
    deleteByExecution(projectPath, sessionName, executionId) {
      timed("deleteByExecution", { executionId }, () => {
        deleteByExecutionStmt.run(projectPath, sessionName, executionId);
      });
    },
  };
}
