import { createLogger } from "@/lib/logging";
import type { StateMigration } from "./types";

const logger = createLogger("state-store/migrations/0002-split-graph-workflow-history");

interface SessionRow {
  project_path: string;
  session_name: string;
  graph_workflow_execution: string | null;
  graph_workflow_execution_history: string | null;
}

interface EventInsert {
  occurredAt: string;
  eventType: string;
  contextId: string | null;
  preReset: number;
  eventJson: string;
}

interface ArchivedInsert {
  executionId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  executionJson: string;
}

interface ParsedExecution {
  executionId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  events: EventInsert[];
  hadHistory: boolean;
  historyFreeJson: string;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Turn one persisted execution blob into its history-free control state plus the
 * extracted event rows. Reads fields positionally off the raw parsed JSON rather
 * than through the live Zod schema, so a blob that predates (or postdates) the
 * current execution shape still migrates cleanly. Unparseable JSON is skipped.
 */
function parseExecution(rawJson: string): ParsedExecution | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const executionId = asString(record.id, "");
  if (executionId === "") return null;

  const rawHistory = record.history;
  const hadHistory = Array.isArray(rawHistory);
  const events: EventInsert[] = [];
  if (Array.isArray(rawHistory)) {
    for (const entry of rawHistory) {
      if (typeof entry !== "object" || entry === null) continue;
      const entryRecord = entry as Record<string, unknown>;
      const event = entryRecord.event;
      if (typeof event !== "object" || event === null) continue;
      const eventRecord = event as Record<string, unknown>;
      const eventType = asString(eventRecord.type, "");
      if (eventType === "") continue;
      events.push({
        occurredAt: asString(entryRecord.occurredAt, ""),
        eventType,
        contextId: asNullableString(eventRecord.contextId),
        preReset: entryRecord.preReset === true ? 1 : 0,
        eventJson: JSON.stringify(event),
      });
    }
  }

  const historyFree: Record<string, unknown> = { ...record };
  delete historyFree.history;

  return {
    executionId,
    status: asString(record.status, "unknown"),
    startedAt: asString(record.startedAt, ""),
    completedAt: asNullableString(record.completedAt),
    events,
    hadHistory,
    historyFreeJson: JSON.stringify(historyFree),
  };
}

/**
 * One-time backfill for the graph-workflow history split. Moves the two
 * unbounded-by-time arrays out of the session JSON blob and into dedicated
 * tables:
 *
 *   - `graph_workflow_execution.history[]` (the active execution's append-only
 *     event log) → `graph_workflow_events`, keyed by the execution id; the blob
 *     is rewritten with `history` stripped.
 *   - `graph_workflow_execution_history[]` (the array of past completed
 *     executions) → one `graph_workflow_archived_executions` control-state row
 *     per entry, with each entry's own `history[]` likewise split into
 *     `graph_workflow_events` keyed by that entry's execution id.
 *
 * Idempotent: re-running clears any rows this migration would have produced for
 * each session before re-inserting (and rewriting a history-free blob a second
 * time is a no-op), so a replay after a mid-run crash converges to the same
 * state. Fields are read off raw parsed JSON, never the live schema, so blobs
 * from any prior shape still migrate.
 */
export const splitGraphWorkflowHistory: StateMigration = {
  name: "0002-split-graph-workflow-history",
  up: async ({ context }) => {
    const { db } = context;

    const selectSessions = db.prepare(
      `SELECT project_path, session_name,
              graph_workflow_execution,
              graph_workflow_execution_history
         FROM sessions`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO graph_workflow_events (
         project_path, session_name, execution_id, occurred_at,
         event_type, context_id, pre_reset, event_json
       ) VALUES (
         @project_path, @session_name, @execution_id, @occurred_at,
         @event_type, @context_id, @pre_reset, @event_json
       )`,
    );
    const deleteEventsForExecution = db.prepare(
      `DELETE FROM graph_workflow_events WHERE execution_id = ?`,
    );
    const insertArchived = db.prepare(
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
    const updateActiveBlob = db.prepare(
      `UPDATE sessions
          SET graph_workflow_execution = ?
        WHERE project_path = ? AND session_name = ?`,
    );

    const insertEventsForExecution = (
      projectPath: string,
      sessionName: string,
      executionId: string,
      events: EventInsert[],
    ): void => {
      deleteEventsForExecution.run(executionId);
      for (const event of events) {
        insertEvent.run({
          project_path: projectPath,
          session_name: sessionName,
          execution_id: executionId,
          occurred_at: event.occurredAt,
          event_type: event.eventType,
          context_id: event.contextId,
          pre_reset: event.preReset,
          event_json: event.eventJson,
        });
      }
    };

    let sessionsTouched = 0;
    let eventsInserted = 0;
    let archivedInserted = 0;

    const run = db.transaction(() => {
      const rows = selectSessions.all() as SessionRow[];
      for (const row of rows) {
        const archivedInserts: ArchivedInsert[] = [];
        const archivedEvents = new Map<string, EventInsert[]>();
        let activeRewrite: string | null = null;
        let activeExecutionId: string | null = null;
        let activeEvents: EventInsert[] = [];
        let touched = false;

        if (row.graph_workflow_execution !== null) {
          const active = parseExecution(row.graph_workflow_execution);
          // Only migrate the active blob while its history array is still
          // present. On a replay the blob has already been stripped, so
          // re-deleting its events (with nothing left to re-insert) would erase
          // the events migrated on the first run — leave it untouched.
          if (active !== null && active.hadHistory) {
            activeRewrite = active.historyFreeJson;
            activeExecutionId = active.executionId;
            activeEvents = active.events;
            touched = true;
          }
        }

        if (
          row.graph_workflow_execution_history !== null &&
          row.graph_workflow_execution_history !== "[]"
        ) {
          let parsedHistory: unknown;
          try {
            parsedHistory = JSON.parse(row.graph_workflow_execution_history);
          } catch {
            parsedHistory = null;
          }
          if (Array.isArray(parsedHistory)) {
            for (const entry of parsedHistory) {
              if (typeof entry !== "string" && typeof entry !== "object") {
                continue;
              }
              const entryJson =
                typeof entry === "string" ? entry : JSON.stringify(entry);
              const archived = parseExecution(entryJson);
              if (archived === null) continue;
              archivedInserts.push({
                executionId: archived.executionId,
                status: archived.status,
                startedAt: archived.startedAt,
                completedAt: archived.completedAt,
                executionJson: archived.historyFreeJson,
              });
              archivedEvents.set(archived.executionId, archived.events);
              touched = true;
            }
          }
        }

        if (!touched) continue;

        if (activeExecutionId !== null) {
          insertEventsForExecution(
            row.project_path,
            row.session_name,
            activeExecutionId,
            activeEvents,
          );
          eventsInserted += activeEvents.length;
        }
        if (activeRewrite !== null) {
          updateActiveBlob.run(
            activeRewrite,
            row.project_path,
            row.session_name,
          );
        }

        for (const archived of archivedInserts) {
          insertArchived.run({
            project_path: row.project_path,
            session_name: row.session_name,
            execution_id: archived.executionId,
            archived_at: archived.completedAt ?? archived.startedAt,
            status: archived.status,
            started_at: archived.startedAt,
            completed_at: archived.completedAt,
            execution_json: archived.executionJson,
          });
          const events = archivedEvents.get(archived.executionId) ?? [];
          insertEventsForExecution(
            row.project_path,
            row.session_name,
            archived.executionId,
            events,
          );
          eventsInserted += events.length;
          archivedInserted += 1;
        }

        sessionsTouched += 1;
      }
    });

    run();

    logger.info("state-store.migrations.split_graph_workflow_history", {
      sessionsTouched,
      eventsInserted,
      archivedInserted,
    });
  },
};
