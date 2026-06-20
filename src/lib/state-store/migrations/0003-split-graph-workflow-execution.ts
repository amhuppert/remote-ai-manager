import { createLogger } from "@/lib/logging";
import {
  DEFINITION_TIER_KEYS,
  RUNTIME_TIER_KEYS,
} from "../graph-workflow-executions-repo";
import { stableStringify } from "../serialization";
import type { StateMigration } from "./types";

const logger = createLogger(
  "state-store/migrations/0003-split-graph-workflow-execution",
);

interface SessionRow {
  project_path: string;
  session_name: string;
  graph_workflow_execution: string | null;
}

interface SplitRawExecution {
  executionId: string;
  seedDefinitionId: string;
  seedDefinitionRevision: number;
  startedAt: string;
  status: string;
  completedAt: string | null;
  definitionJson: string;
  runtimeJson: string;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Split one persisted execution blob into the definition/runtime tier JSON plus
 * the denormalized projection columns. Reads every field positionally off the
 * raw parsed record — never the live Zod schema — so a blob from any prior or
 * future execution shape still migrates. A blob without a usable `id` is
 * unparseable for our purposes and is skipped (left in place).
 */
function splitRawExecution(rawJson: string): SplitRawExecution | null {
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

  const definitionTier: Record<string, unknown> = {};
  for (const key of DEFINITION_TIER_KEYS) {
    definitionTier[key] = record[key];
  }
  const runtimeTier: Record<string, unknown> = {};
  for (const key of RUNTIME_TIER_KEYS) {
    runtimeTier[key] = record[key];
  }

  return {
    executionId,
    seedDefinitionId: asString(record.seedDefinitionId, ""),
    seedDefinitionRevision: asInteger(record.seedDefinitionRevision, 1),
    startedAt: asString(record.startedAt, ""),
    status: asString(record.status, "unknown"),
    completedAt: asNullableString(record.completedAt),
    definitionJson: stableStringify(definitionTier),
    runtimeJson: stableStringify(runtimeTier),
  };
}

/**
 * One-time backfill for the active graph-workflow execution table split. Moves
 * the active execution blob out of `sessions.graph_workflow_execution` and into
 * a dedicated `graph_workflow_executions` row whose heavy/static fields live in
 * `definition_json` and whose hot control state lives in `runtime_json`, with
 * `status`/`completed_at`/identity projected into columns. The source column is
 * NULLed after a successful split so older builds (which read the column as "no
 * active execution") stay forward-compatible.
 *
 * Idempotent: `WHERE graph_workflow_execution IS NOT NULL` is the replay guard —
 * after a successful pass the column is NULL, so a replay processes nothing. The
 * `ON CONFLICT … DO UPDATE` makes a partial-then-replay converge. Fields are read
 * positionally off raw parsed JSON, so blobs of any prior shape still migrate;
 * an identity-less or unparseable blob is skipped and its column left untouched.
 */
export const splitGraphWorkflowExecution: StateMigration = {
  name: "0003-split-graph-workflow-execution",
  up: async ({ context }) => {
    const { db } = context;

    const selectSessions = db.prepare(
      `SELECT project_path, session_name, graph_workflow_execution
         FROM sessions
        WHERE graph_workflow_execution IS NOT NULL`,
    );
    const insertExecution = db.prepare(
      `INSERT INTO graph_workflow_executions (
         project_path, session_name, execution_id, seed_definition_id,
         seed_definition_revision, started_at, status, completed_at,
         definition_json, runtime_json, updated_at
       ) VALUES (
         @project_path, @session_name, @execution_id, @seed_definition_id,
         @seed_definition_revision, @started_at, @status, @completed_at,
         @definition_json, @runtime_json, @updated_at
       )
       ON CONFLICT(project_path, session_name) DO UPDATE SET
         execution_id             = excluded.execution_id,
         seed_definition_id       = excluded.seed_definition_id,
         seed_definition_revision = excluded.seed_definition_revision,
         started_at               = excluded.started_at,
         status                   = excluded.status,
         completed_at             = excluded.completed_at,
         definition_json          = excluded.definition_json,
         runtime_json             = excluded.runtime_json,
         updated_at               = excluded.updated_at`,
    );
    const clearSessionBlob = db.prepare(
      `UPDATE sessions SET graph_workflow_execution = NULL
        WHERE project_path = ? AND session_name = ?`,
    );

    const now = new Date().toISOString();
    let executionsInserted = 0;
    let blobsSkipped = 0;

    const run = db.transaction(() => {
      const rows = selectSessions.all() as SessionRow[];
      for (const row of rows) {
        if (row.graph_workflow_execution === null) continue;
        const split = splitRawExecution(row.graph_workflow_execution);
        if (split === null) {
          blobsSkipped += 1;
          continue;
        }
        insertExecution.run({
          project_path: row.project_path,
          session_name: row.session_name,
          execution_id: split.executionId,
          seed_definition_id: split.seedDefinitionId,
          seed_definition_revision: split.seedDefinitionRevision,
          started_at: split.startedAt,
          status: split.status,
          completed_at: split.completedAt,
          definition_json: split.definitionJson,
          runtime_json: split.runtimeJson,
          updated_at: now,
        });
        clearSessionBlob.run(row.project_path, row.session_name);
        executionsInserted += 1;
      }
    });

    run();

    logger.info("state-store.migrations.split_graph_workflow_execution", {
      executionsInserted,
      blobsSkipped,
    });
  },
};
