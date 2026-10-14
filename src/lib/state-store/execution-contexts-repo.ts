import type Database from "better-sqlite3";
import { z } from "zod";
import {
  contextRecordSchema,
  type ContextFacts,
  type ContextProgress,
  type ContextRecord,
} from "@/lib/execution-context/schemas";

type Db = InstanceType<typeof Database>;

const rowSchema = z.object({
  context_id: z.string(),
  run_id: z.string(),
  project_path: z.string(),
  session_name: z.string(),
  owner_conversation_id: z.string(),
  start_cause: z.string(),
  workspace_json: z.string(),
  facts_json: z.string(),
  revision: z.number().int(),
  progress_json: z.string(),
  progress_occurrence: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const COLUMNS = `context_id, run_id, project_path, session_name, owner_conversation_id,
  start_cause, workspace_json, facts_json, revision, progress_json, progress_occurrence,
  created_at, updated_at`;

function fromRow(raw: unknown): ContextRecord {
  const row = rowSchema.parse(raw);
  return contextRecordSchema.parse({
    contextId: row.context_id,
    runId: row.run_id,
    projectPath: row.project_path,
    sessionName: row.session_name,
    ownerConversationId: row.owner_conversation_id,
    startCause: row.start_cause,
    workspace: JSON.parse(row.workspace_json),
    facts: JSON.parse(row.facts_json),
    revision: row.revision,
    progress: JSON.parse(row.progress_json),
    progressOccurrence: row.progress_occurrence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class ContextRevisionConflictError extends Error {
  constructor(contextId: string, expected: number) {
    super(`Context ${contextId} changed since revision ${expected}`);
    this.name = "ContextRevisionConflictError";
  }
}

/** Sole writer of `execution_contexts`; Context's host owns every transition. */
export interface ExecutionContextsRepo {
  insertIfAbsent(record: ContextRecord): void;
  get(contextId: string): ContextRecord | null;
  getByStartCause(cause: string): ContextRecord | null;
  listByRun(runId: string): ContextRecord[];
  update(
    contextId: string,
    expectedRevision: number,
    change: {
      facts: ContextFacts;
      progress: ContextProgress;
      progressOccurrence: string;
      updatedAt: string;
    },
  ): number;
}

export function createExecutionContextsRepo(db: Db): ExecutionContextsRepo {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO execution_contexts (${COLUMNS})
     VALUES (@contextId, @runId, @projectPath, @sessionName, @ownerConversationId,
             @startCause, @workspaceJson, @factsJson, @revision, @progressJson,
             @progressOccurrence, @createdAt, @updatedAt)`,
  );
  const getStmt = db.prepare(
    `SELECT ${COLUMNS} FROM execution_contexts WHERE context_id = ?`,
  );
  const byCauseStmt = db.prepare(
    `SELECT ${COLUMNS} FROM execution_contexts WHERE start_cause = ?`,
  );
  const byRunStmt = db.prepare(
    `SELECT ${COLUMNS} FROM execution_contexts WHERE run_id = ? ORDER BY created_at, rowid`,
  );
  const updateStmt = db.prepare(
    `UPDATE execution_contexts
        SET facts_json = @factsJson, revision = revision + 1, progress_json = @progressJson,
            progress_occurrence = @progressOccurrence, updated_at = @updatedAt
      WHERE context_id = @contextId AND revision = @expectedRevision`,
  );
  return {
    insertIfAbsent(record) {
      const parsed = contextRecordSchema.parse(record);
      insertStmt.run({
        contextId: parsed.contextId,
        runId: parsed.runId,
        projectPath: parsed.projectPath,
        sessionName: parsed.sessionName,
        ownerConversationId: parsed.ownerConversationId,
        startCause: parsed.startCause,
        workspaceJson: JSON.stringify(parsed.workspace),
        factsJson: JSON.stringify(parsed.facts),
        revision: parsed.revision,
        progressJson: JSON.stringify(parsed.progress),
        progressOccurrence: parsed.progressOccurrence,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      });
    },
    get(contextId) {
      const raw: unknown = getStmt.get(contextId);
      return raw === undefined ? null : fromRow(raw);
    },
    getByStartCause(cause) {
      const raw: unknown = byCauseStmt.get(cause);
      return raw === undefined ? null : fromRow(raw);
    },
    listByRun(runId) {
      return byRunStmt.all(runId).map(fromRow);
    },
    update(contextId, expectedRevision, change) {
      const result = updateStmt.run({
        contextId,
        expectedRevision,
        factsJson: JSON.stringify(change.facts),
        progressJson: JSON.stringify(change.progress),
        progressOccurrence: change.progressOccurrence,
        updatedAt: change.updatedAt,
      });
      if (result.changes !== 1) {
        throw new ContextRevisionConflictError(contextId, expectedRevision);
      }
      return expectedRevision + 1;
    },
  };
}
