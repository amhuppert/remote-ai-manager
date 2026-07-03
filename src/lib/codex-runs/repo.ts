/**
 * Durable codex-run bookkeeping (docs/design/cc-cli/02 §3.3).
 *
 * Mirrors the background-jobs SQLite history pattern (`src/lib/jobs/repo.ts`):
 * a run is inserted `running` at start and updated to its terminal state with
 * results when it settles, so codex runs are represented in the established job
 * bookkeeping domain and survive the request that started them. Live
 * coordination (the AbortController) lives in the service's in-memory registry;
 * only the serializable record lives here.
 */

import { z } from "zod";
import { getStateDb } from "../state-store/store";
import { createLogger } from "../logging";
import { timedSync } from "../logging/timed";
import { PersistenceError } from "../shared/errors";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import {
  codexReferenceDocumentSchema,
  codexRunRecordSchema,
  codexRunStatusSchema,
} from "./schemas";
import type { CodexReferenceDocument, CodexRunRecord } from "./schemas";

const logger = createLogger("state-store.codex-run-records");

const codexRunRecordRowSchema = registerTrustedSchema(
  z.object({
    run_id: z.string(),
    project_name: z.string(),
    session_name: z.string(),
    status: z.string(),
    started_at: z.string(),
    completed_at: z.string().nullable(),
    summary: z.string().nullable(),
    reference_documents: z.string().nullable(),
    error_message: z.string().nullable(),
  }),
  "codexRunRecordRowSchema",
);
type CodexRunRecordRow = z.infer<typeof codexRunRecordRowSchema>;

const codexReferenceDocumentsColumnSchema = registerTrustedSchema(
  z.array(codexReferenceDocumentSchema),
  "codexRunRecord.referenceDocuments",
);

export interface CreateCodexRunRecordInput {
  runId: string;
  projectName: string;
  sessionName: string;
  startedAt: string;
}

export interface UpdateCodexRunRecordInput {
  status: CodexRunRecord["status"];
  completedAt: string;
  summary?: string;
  referenceDocuments?: CodexReferenceDocument[];
  error?: string;
}

const updateInputSchema = z.object({
  status: codexRunStatusSchema,
  completedAt: z.string(),
  summary: z.string().optional(),
  referenceDocuments: z.array(codexReferenceDocumentSchema).optional(),
  error: z.string().optional(),
});

function logAndThrowValidationFailure(
  identifier: string | undefined,
  issues: unknown,
): never {
  const payload: Record<string, unknown> = { issues };
  if (identifier !== undefined) payload.identifier = identifier;
  logger.error(
    "state-store.codex-run-records.schema_validation_failure",
    payload,
  );
  throw new PersistenceError({
    kind: "validation",
    entity: "codex_run_record",
    ...(identifier !== undefined ? { identifier } : {}),
    issues,
  });
}

function parseReferenceDocumentsColumn(
  identifier: string,
  raw: string | null,
):
  | { ok: true; value: CodexReferenceDocument[] | undefined }
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
          message: err instanceof Error ? err.message : String(err),
          identifier,
        },
      ],
    };
  }
  try {
    return {
      ok: true,
      value: parseTrusted(codexReferenceDocumentsColumnSchema, parsed),
    };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, issues: err.issues };
    throw err;
  }
}

function rowToRecord(rawRow: unknown): CodexRunRecord {
  const candidateId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { run_id?: unknown }).run_id === "string"
      ? (rawRow as { run_id: string }).run_id
      : undefined;

  const row: CodexRunRecordRow = parseTrusted(
    codexRunRecordRowSchema,
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

  return parseTrusted(codexRunRecordSchema, candidate, (issues) =>
    logAndThrowValidationFailure(row.run_id, issues),
  );
}

/** Insert a run in its initial `running` state. */
export function createCodexRunRecord(input: CreateCodexRunRecordInput): void {
  timedSync(
    logger,
    "state-db.createCodexRunRecord",
    { runId: input.runId },
    () => {
      const db = getStateDb();
      db.prepare(
        `INSERT OR REPLACE INTO codex_run_records
           (run_id, project_name, session_name, status, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        input.runId,
        input.projectName,
        input.sessionName,
        "running",
        input.startedAt,
      );
    },
  );
}

/** Persist a run's terminal state (status + results/error + completion time). */
export function updateCodexRunRecord(
  runId: string,
  update: UpdateCodexRunRecordInput,
): void {
  timedSync(
    logger,
    "state-db.updateCodexRunRecord",
    { runId, status: update.status },
    () => {
      const parsed = updateInputSchema.safeParse(update);
      if (!parsed.success) {
        return logAndThrowValidationFailure(runId, parsed.error.issues);
      }
      const db = getStateDb();
      db.prepare(
        `UPDATE codex_run_records SET
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

/** Read a run's durable record by id, or `null` when no row matches. */
export function getCodexRunRecord(runId: string): CodexRunRecord | null {
  return timedSync(
    logger,
    "state-db.getCodexRunRecord",
    { runId },
    () => {
      const db = getStateDb();
      const rawRow = db
        .prepare("SELECT * FROM codex_run_records WHERE run_id = ?")
        .get(runId);
      if (rawRow === undefined) return null;
      return rowToRecord(rawRow);
    },
    (result) => ({ found: result !== null }),
  );
}
