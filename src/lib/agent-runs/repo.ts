/**
 * Durable agent-run bookkeeping.
 *
 * Mirrors the background-jobs SQLite history pattern (`src/lib/jobs/repo.ts`):
 * a run is inserted `running` at start and updated to its terminal state with
 * results when it settles, so agent runs are represented in the established
 * job bookkeeping domain and survive the request that started them. Live
 * coordination (the AbortController) lives in the shared abort registry
 * (scope `agent-run:*`); only the serializable record lives here.
 */

import { z } from "zod";
import type Database from "better-sqlite3";
import { createLogger } from "../logging";
import { timedSync } from "../logging/timed";
import { PersistenceError } from "../shared/errors";
import { isProcessAlive } from "../shared/process-liveness";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import {
  agentRunReferenceDocumentSchema,
  agentRunRecordSchema,
  agentRunStatusSchema,
} from "./schemas";
import type { AgentRunReferenceDocument, AgentRunRecord } from "./schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { getErrorMessage } from "@/lib/shared/errors";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.agent-run-records");

const agentRunRecordRowSchema = registerTrustedSchema(
  z.object({
    run_id: z.string(),
    backend: z.string(),
    project_name: z.string(),
    session_name: z.string(),
    status: z.string(),
    started_at: z.string(),
    completed_at: z.string().nullable(),
    summary: z.string().nullable(),
    reference_documents: z.string().nullable(),
    error_message: z.string().nullable(),
  }),
  "agentRunRecordRowSchema",
);
type AgentRunRecordRow = z.infer<typeof agentRunRecordRowSchema>;

const agentRunReferenceDocumentsColumnSchema = registerTrustedSchema(
  z.array(agentRunReferenceDocumentSchema),
  "agentRunRecord.referenceDocuments",
);

export interface CreateAgentRunRecordInput {
  runId: string;
  backend: AgentBackendId;
  projectName: string;
  sessionName: string;
  startedAt: string;
  /**
   * Pid of the worker process that owns the run's live AbortController.
   * Multiple same-host workers (main server + session dev servers) share one
   * file-backed DB, so the startup sweep uses this to distinguish rows orphaned
   * by a dead process from runs still live in another worker.
   */
  ownerPid: number;
}

export interface UpdateAgentRunRecordInput {
  status: AgentRunRecord["status"];
  completedAt: string;
  summary?: string;
  referenceDocuments?: AgentRunReferenceDocument[];
  error?: string;
}

const updateInputSchema = z.object({
  status: agentRunStatusSchema,
  completedAt: z.string(),
  summary: z.string().optional(),
  referenceDocuments: z.array(agentRunReferenceDocumentSchema).optional(),
  error: z.string().optional(),
});

function logAndThrowValidationFailure(
  identifier: string | undefined,
  issues: unknown,
): never {
  const payload: Record<string, unknown> = { issues };
  if (identifier !== undefined) payload.identifier = identifier;
  logger.error(
    "state-store.agent-run-records.schema_validation_failure",
    payload,
  );
  throw new PersistenceError({
    kind: "validation",
    entity: "agent_run_record",
    ...(identifier !== undefined ? { identifier } : {}),
    issues,
  });
}

function parseReferenceDocumentsColumn(
  identifier: string,
  raw: string | null,
):
  | { ok: true; value: AgentRunReferenceDocument[] | undefined }
  | { ok: false; issues: unknown } {
  if (raw === null) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_json",
          path: ["referenceDocuments"],
          message: getErrorMessage(err),
          identifier,
        },
      ],
    };
  }
  try {
    return {
      ok: true,
      value: parseTrusted(agentRunReferenceDocumentsColumnSchema, parsed),
    };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, issues: err.issues };
    throw err;
  }
}

function rowToRecord(rawRow: unknown): AgentRunRecord {
  const candidateId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { run_id?: unknown }).run_id === "string"
      ? (rawRow as { run_id: string }).run_id
      : undefined;

  const row: AgentRunRecordRow = parseTrusted(
    agentRunRecordRowSchema,
    rawRow,
    (issues) => logAndThrowValidationFailure(candidateId, issues),
  );

  const referenceDocuments = parseReferenceDocumentsColumn(
    row.run_id,
    row.reference_documents,
  );
  if (!referenceDocuments.ok) {
    return logAndThrowValidationFailure(row.run_id, referenceDocuments.issues);
  }

  const candidate: Record<string, unknown> = {
    runId: row.run_id,
    backend: row.backend,
    projectName: row.project_name,
    sessionName: row.session_name,
    status: row.status,
    startedAt: row.started_at,
  };
  if (row.completed_at !== null) candidate.completedAt = row.completed_at;
  if (row.summary !== null) candidate.summary = row.summary;
  if (referenceDocuments.value !== undefined)
    candidate.referenceDocuments = referenceDocuments.value;
  if (row.error_message !== null) candidate.error = row.error_message;

  return parseTrusted(agentRunRecordSchema, candidate, (issues) =>
    logAndThrowValidationFailure(row.run_id, issues),
  );
}

const runningRunOwnerRowsSchema = registerTrustedSchema(
  z.array(
    z.object({
      run_id: z.string(),
      owner_pid: z.number().nullable(),
    }),
  ),
  "agentRunRecords.runningOwnerRows",
);

export interface AgentRunsRepo {
  /** Insert a run in its initial `running` state. */
  createAgentRunRecord(input: CreateAgentRunRecordInput): void;
  /** Persist a run's terminal state (status + results/error + completion time). */
  updateAgentRunRecord(runId: string, update: UpdateAgentRunRecordInput): void;
  /**
   * Startup sweep: a run's abort handle lives only in the abort registry of
   * the worker process that started it, so a `running` row whose owner process
   * is gone would report running forever and cancel would be a silent no-op.
   * Because multiple same-host workers share one file-backed DB, another
   * worker's startup must not fail a run that is still live elsewhere — only
   * rows whose owner pid is dead or unrecorded (written before pids were
   * persisted) are marked failed. Returns the swept count.
   */
  recoverStaleAgentRuns(): number;
  /** Read a run's durable record by id, or `null` when no row matches. */
  getAgentRunRecord(runId: string): AgentRunRecord | null;
}

export function createAgentRunsRepo(db: Db): AgentRunsRepo {
  function createAgentRunRecord(input: CreateAgentRunRecordInput): void {
    timedSync(
      logger,
      "state-db.createAgentRunRecord",
      { runId: input.runId, backend: input.backend },
      () => {
        db.prepare(
          `INSERT OR REPLACE INTO agent_run_records
           (run_id, backend, project_name, session_name, status, started_at, owner_pid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.runId,
          input.backend,
          input.projectName,
          input.sessionName,
          "running",
          input.startedAt,
          input.ownerPid,
        );
      },
    );
  }

  function updateAgentRunRecord(
    runId: string,
    update: UpdateAgentRunRecordInput,
  ): void {
    timedSync(
      logger,
      "state-db.updateAgentRunRecord",
      { runId, status: update.status },
      () => {
        const parsed = updateInputSchema.safeParse(update);
        if (!parsed.success) {
          return logAndThrowValidationFailure(runId, parsed.error.issues);
        }
        db.prepare(
          `UPDATE agent_run_records SET
           status = ?,
           completed_at = ?,
           summary = ?,
           reference_documents = ?,
           error_message = ?
         WHERE run_id = ?`,
        ).run(
          parsed.data.status,
          parsed.data.completedAt,
          parsed.data.summary ?? null,
          parsed.data.referenceDocuments
            ? JSON.stringify(parsed.data.referenceDocuments)
            : null,
          parsed.data.error ?? null,
          runId,
        );
      },
    );
  }

  function recoverStaleAgentRuns(): number {
    return timedSync(
      logger,
      "state-db.recoverStaleAgentRuns",
      {},
      () => {
        const rows = parseTrusted(
          runningRunOwnerRowsSchema,
          db
            .prepare(
              `SELECT run_id, owner_pid FROM agent_run_records
             WHERE status = 'running'`,
            )
            .all(),
        );
        const orphaned = rows.filter(
          (row) => row.owner_pid === null || !isProcessAlive(row.owner_pid),
        );
        if (orphaned.length === 0) return 0;

        logger.info("state-store.agent-run-records.sweep_orphaned", {
          runIds: orphaned.map((row) => row.run_id),
          ownerPids: orphaned.map((row) => row.owner_pid),
        });

        const update = db.prepare(
          `UPDATE agent_run_records
           SET status = 'failed',
               completed_at = ?,
               error_message = ?
         WHERE run_id = ? AND status = 'running'`,
        );
        const completedAt = new Date().toISOString();
        const sweepAll = db.transaction(() => {
          let changes = 0;
          for (const row of orphaned) {
            changes += update.run(
              completedAt,
              "Agent run interrupted: owning server process exited",
              row.run_id,
            ).changes;
          }
          return changes;
        });
        return sweepAll();
      },
      (count) => ({ recoveredCount: count }),
    );
  }

  function getAgentRunRecord(runId: string): AgentRunRecord | null {
    return timedSync(
      logger,
      "state-db.getAgentRunRecord",
      { runId },
      () => {
        const rawRow = db
          .prepare("SELECT * FROM agent_run_records WHERE run_id = ?")
          .get(runId);
        if (rawRow === undefined) return null;
        return rowToRecord(rawRow);
      },
      (result) => ({ found: result !== null }),
    );
  }

  return {
    createAgentRunRecord,
    updateAgentRunRecord,
    recoverStaleAgentRuns,
    getAgentRunRecord,
  };
}
