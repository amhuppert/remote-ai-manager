import { z } from "zod";
import type Database from "better-sqlite3";
import { createLogger } from "../logging";
import { timedSync } from "../logging/timed";
import { PersistenceError } from "../shared/errors";
import { isProcessAlive } from "../shared/process-liveness";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import { createNotificationsRepo } from "../notifications/repo";
import {
  backgroundJobSchema,
  candidateValidationFactSchema,
  jobRecordSchema,
  jobStatusSchema,
} from "./schemas";
import type {
  BackgroundJob,
  CandidateValidationFact,
  JobRecord,
  JobType,
  JobStatus,
} from "./schemas";
import type { JobNotificationType } from "@/lib/notifications/schemas";
import { getErrorMessage } from "@/lib/shared/errors";

type Db = InstanceType<typeof Database>;

const jobRecordLogger = createLogger("state-store.job-records");

/**
 * Lenient owner-pid read for the sweep — rows may predate the column, so the
 * key may be absent (`undefined`) as well as SQL NULL. Effect-free on purpose:
 * parseTrusted skips parsing in production, so a `.default()` would never
 * apply there; the call site treats `undefined` and `null` identically.
 */
const staleJobOwnerPidSchema = registerTrustedSchema(
  z.looseObject({ owner_pid: z.number().nullish() }),
  "jobRecord.staleOwnerPid",
);

const jobRecordRowSchema = registerTrustedSchema(
  z.object({
    job_id: z.string(),
    job_type: z.string(),
    status: z.string(),
    project_name: z.string(),
    session_name: z.string(),
    branch_name: z.string(),
    started_at: z.string(),
    completed_at: z.string().nullable(),
    merge_hash: z.string().nullable(),
    commit_hash: z.string().nullable(),
    conflict_count: z.number().int().nullable(),
    conflict_files: z.string().nullable(),
    error_message: z.string().nullable(),
    execution_id: z.string().nullable(),
    spec_execution_id: z.string().nullable(),
    final_publish: z.number().int(),
    candidate_validation: z.string().nullable(),
    // Nullish rather than nullable: a row read by a build that has the columns
    // from a connection opened before the floor added them yields `undefined`,
    // and both readings mean the same absent fact.
    parked_ref: z.string().nullish(),
    prepared_sha: z.string().nullish(),
    expected_target_sha: z.string().nullish(),
    finalize_session_on_publish: z.number().int().nullish(),
    resolution_context: z.string().nullish(),
    skip_mark_merged: z.number().int().nullable(),
  }),
  "jobRecordRowSchema",
);
type JobRecordRow = z.infer<typeof jobRecordRowSchema>;

const jobConflictFilesSchema = registerTrustedSchema(
  z.array(z.string()),
  "jobRecord.conflictFiles",
);

const jobIdColumnSchema = registerTrustedSchema(
  z.object({ job_id: z.string() }),
  "jobRecord.jobIdColumn",
);

const publishedMergeColumnsSchema = registerTrustedSchema(
  z.object({
    merge_hash: z.string().nullable(),
    expected_target_sha: z.string().nullish(),
  }),
  "jobRecord.publishedMergeColumns",
);

const jobRecordUpdateSchema = z.object({
  status: jobStatusSchema,
  mergeHash: z.string().optional(),
  commitHash: z.string().optional(),
  conflictCount: z.number().optional(),
  conflictFiles: z.array(z.string()).optional(),
  errorMessage: z.string().optional(),
  executionId: z.string().optional(),
  parkedRef: z.string().optional(),
  preparedSha: z.string().optional(),
  expectedTargetSha: z.string().optional(),
  candidateValidation: candidateValidationFactSchema.optional(),
});

function logAndThrowJobRecordValidationFailure(
  identifier: string | undefined,
  issues: unknown,
): never {
  const payload: Record<string, unknown> = { issues };
  if (identifier !== undefined) payload.identifier = identifier;
  jobRecordLogger.error(
    "state-store.job-records.schema_validation_failure",
    payload,
  );
  throw new PersistenceError({
    kind: "validation",
    entity: "job_record",
    ...(identifier !== undefined ? { identifier } : {}),
    issues,
  });
}

function parseBackgroundJobOrFail(
  candidate: unknown,
  identifier: string | undefined,
): BackgroundJob {
  const result = backgroundJobSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowJobRecordValidationFailure(
      identifier,
      result.error.issues,
    );
  }
  return result.data;
}

function parseJobRecordUpdateOrFail(
  candidate: unknown,
  identifier: string,
): z.infer<typeof jobRecordUpdateSchema> {
  const result = jobRecordUpdateSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowJobRecordValidationFailure(
      identifier,
      result.error.issues,
    );
  }
  return result.data;
}

function parseConflictFilesColumn(
  identifier: string,
  raw: string | null,
): { ok: true; value: string[] | undefined } | { ok: false; issues: unknown } {
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
          path: ["conflictFiles"],
          message: getErrorMessage(err),
          identifier,
        },
      ],
    };
  }
  try {
    return { ok: true, value: parseTrusted(jobConflictFilesSchema, parsed) };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, issues: err.issues };
    throw err;
  }
}

function parseCandidateValidationColumn(
  identifier: string,
  raw: string | null,
):
  | {
      ok: true;
      value: BackgroundJob["candidateValidation"] | undefined;
    }
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
          path: ["candidateValidation"],
          message: getErrorMessage(err),
          identifier,
        },
      ],
    };
  }
  try {
    return {
      ok: true,
      value: parseTrusted(candidateValidationFactSchema, parsed),
    };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, issues: err.issues };
    throw err;
  }
}

function rowToBackgroundJob(rawRow: unknown): BackgroundJob {
  const candidateId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { job_id?: unknown }).job_id === "string"
      ? (rawRow as { job_id: string }).job_id
      : undefined;

  const row: JobRecordRow = parseTrusted(jobRecordRowSchema, rawRow, (issues) =>
    logAndThrowJobRecordValidationFailure(candidateId, issues),
  );

  const conflictFilesResult = parseConflictFilesColumn(
    row.job_id,
    row.conflict_files,
  );
  if (!conflictFilesResult.ok) {
    return logAndThrowJobRecordValidationFailure(
      row.job_id,
      conflictFilesResult.issues,
    );
  }
  const candidateValidationResult = parseCandidateValidationColumn(
    row.job_id,
    row.candidate_validation,
  );
  if (!candidateValidationResult.ok) {
    return logAndThrowJobRecordValidationFailure(
      row.job_id,
      candidateValidationResult.issues,
    );
  }

  const candidate: Record<string, unknown> = {
    jobId: row.job_id,
    jobType: row.job_type,
    status: row.status,
    projectName: row.project_name,
    sessionName: row.session_name,
    branchName: row.branch_name,
    startedAt: row.started_at,
  };
  if (row.completed_at !== null) candidate.completedAt = row.completed_at;
  if (row.merge_hash !== null) candidate.mergeHash = row.merge_hash;
  if (row.commit_hash !== null) candidate.commitHash = row.commit_hash;
  if (row.conflict_count !== null) candidate.conflictCount = row.conflict_count;
  if (conflictFilesResult.value !== undefined)
    candidate.conflictFiles = conflictFilesResult.value;
  if (row.error_message !== null) candidate.errorMessage = row.error_message;
  if (row.execution_id !== null) candidate.executionId = row.execution_id;
  if (row.spec_execution_id !== null)
    candidate.specExecutionId = row.spec_execution_id;
  if (row.final_publish === 1) candidate.finalPublish = true;
  if (row.parked_ref != null) candidate.parkedRef = row.parked_ref;
  if (row.prepared_sha != null) candidate.preparedSha = row.prepared_sha;
  if (row.expected_target_sha != null)
    candidate.expectedTargetSha = row.expected_target_sha;
  if (row.finalize_session_on_publish != null)
    candidate.finalizeSessionOnPublish = row.finalize_session_on_publish === 1;
  if (row.skip_mark_merged !== null)
    candidate.skipMarkMerged = row.skip_mark_merged === 1;
  if (row.resolution_context != null)
    candidate.resolutionContext = row.resolution_context;
  if (candidateValidationResult.value !== undefined) {
    candidate.candidateValidation = candidateValidationResult.value;
  }

  return parseTrusted(backgroundJobSchema, candidate, (issues) =>
    logAndThrowJobRecordValidationFailure(row.job_id, issues),
  );
}

/**
 * Project a stored row onto the durable {@link JobRecord} shape. Live-only keys
 * are dropped by construction: `jobRecordSchema` is `.strict()`, so anything the
 * runtime job carries but the row layer does not own would fail here rather
 * than travel silently.
 */
function rowToJobRecord(rawRow: unknown): JobRecord {
  const job = rowToBackgroundJob(rawRow);
  const durable: Record<string, unknown> = {
    jobId: job.jobId,
    jobType: job.jobType,
    status: job.status,
    projectName: job.projectName,
    sessionName: job.sessionName,
    branchName: job.branchName,
    startedAt: job.startedAt,
  };
  if (job.completedAt !== undefined) durable.completedAt = job.completedAt;
  if (job.mergeHash !== undefined) durable.mergeHash = job.mergeHash;
  if (job.commitHash !== undefined) durable.commitHash = job.commitHash;
  if (job.conflictCount !== undefined)
    durable.conflictCount = job.conflictCount;
  if (job.conflictFiles !== undefined)
    durable.conflictFiles = job.conflictFiles;
  if (job.errorMessage !== undefined) durable.errorMessage = job.errorMessage;
  if (job.executionId !== undefined) durable.executionId = job.executionId;
  if (job.specExecutionId !== undefined)
    durable.specExecutionId = job.specExecutionId;
  if (job.finalPublish !== undefined) durable.finalPublish = job.finalPublish;
  if (job.parkedRef !== undefined) durable.parkedRef = job.parkedRef;
  if (job.preparedSha !== undefined) durable.preparedSha = job.preparedSha;
  if (job.expectedTargetSha !== undefined)
    durable.expectedTargetSha = job.expectedTargetSha;
  if (job.finalizeSessionOnPublish !== undefined)
    durable.finalizeSessionOnPublish = job.finalizeSessionOnPublish;
  if (job.skipMarkMerged !== undefined)
    durable.skipMarkMerged = job.skipMarkMerged;
  if (job.resolutionContext !== undefined)
    durable.resolutionContext = job.resolutionContext;
  if (job.candidateValidation !== undefined) {
    durable.candidateValidation = job.candidateValidation;
  }
  return parseTrusted(jobRecordSchema, durable);
}

export interface JobRecordUpdate {
  status: JobStatus;
  mergeHash?: string;
  commitHash?: string;
  conflictCount?: number;
  conflictFiles?: string[];
  errorMessage?: string;
  executionId?: string;
  specExecutionId?: string;
  /**
   * Parked-merge bookkeeping, carried by a `ready-to-land` terminal. Written
   * unconditionally (not COALESCEd) so a later terminal for the same job — a
   * land that published the commit, a discard that deleted the ref — clears a
   * ref that no longer exists instead of leaving a land re-entry pointing at it.
   */
  parkedRef?: string;
  preparedSha?: string;
  expectedTargetSha?: string;
  candidateValidation?: BackgroundJob["candidateValidation"];
}

/**
 * Derive the notification type from a job type and terminal status.
 */
export function deriveNotificationType(
  jobType: JobType,
  status: JobStatus,
): JobNotificationType {
  switch (jobType) {
    case "merge":
      if (status === "completed") return "merge-completed";
      if (status === "conflicts") return "merge-conflicts";
      if (status === "ready-to-land") return "merge-ready-to-land";
      if (status === "discarded") return "merge-discarded";
      return "merge-failed";
    case "commit":
      if (status === "completed") return "commit-completed";
      return "commit-failed";
    case "resolve-conflicts":
      if (status === "completed") return "resolve-completed";
      return "resolve-failed";
    case "rebase":
      if (status === "completed") return "rebase-completed";
      return "rebase-failed";
  }
}

/**
 * Derive human-readable title from notification type.
 */
export function deriveNotificationTitle(type: JobNotificationType): string {
  switch (type) {
    case "merge-completed":
      return "Merge completed";
    case "merge-failed":
      return "Merge failed";
    case "merge-conflicts":
      return "Merge conflicts";
    case "merge-ready-to-land":
      return "Merge ready to land";
    case "merge-discarded":
      return "Prepared merge discarded";
    case "commit-completed":
      return "Commit completed";
    case "commit-failed":
      return "Commit failed";
    case "resolve-completed":
      return "Conflicts resolved";
    case "resolve-failed":
      return "Conflict resolution failed";
    case "rebase-completed":
      return "Rebase completed";
    case "rebase-failed":
      return "Rebase failed";
  }
}

export interface JobsRepo {
  createJobRecord(job: BackgroundJob): void;
  updateJobRecord(jobId: string, update: JobRecordUpdate): void;
  persistCandidateValidation(
    jobId: string,
    candidateValidation: CandidateValidationFact,
  ): void;
  /**
   * Read a single durable job record by id through the production row->domain
   * deserialization boundary (`rowToBackgroundJob`). Returns the durable
   * {@link JobRecord} shape — including `completedAt`, which is generated on
   * the write path by `updateJobRecord` — not the live `BackgroundJob` runtime
   * shape. Live-only keys are dropped: `jobRecordSchema` is `.strict()`, so
   * the returned object contains only durable fields. Returns `null` when no
   * row matches the id.
   */
  getJobRecord(jobId: string): JobRecord | null;
  /**
   * The session's most recent job, or null — the durable answer to the question
   * the in-memory registry answers while the process lives, and answered the
   * same way: one job per session, the latest dispatch owning the slot. A land
   * or discard re-entry resolves against it after a restart, and reads the
   * status ladder off it exactly as it would off the registry entry, so a
   * candidate a later job already took the session from is not offered again.
   */
  findLatestJobRecordForSession(
    projectName: string,
    sessionName: string,
  ): JobRecord | null;
  /**
   * Every parked candidate row the session still has on offer, newest first.
   * A dispatch consults it to end offers the registry no longer remembers —
   * after a restart the row and its `refs/cc-merges/` commit are all that is
   * left of a candidate, and nothing else will ever withdraw them.
   */
  listParkedJobRecords(projectName: string, sessionName: string): JobRecord[];
  /**
   * Job ids that may still own a `refs/cc-merges/` ref: parked candidates
   * awaiting an operator, plus jobs still `running` — a merge mid-prepare in
   * another worker sharing this database has already written its ref, and the
   * startup sweep has by then failed every running row whose owner is gone.
   */
  listJobIdsHoldingParkedRefs(): string[];
  /**
   * The commit the execution's gated final publish delivered, for the read-path
   * reconciliation that backstops delivery marking. A no-op publish delivers
   * the target tip it found the branch already contained in, so a completed
   * final publish with no merge hash answers with that tip rather than nothing.
   */
  findLatestPublishedMergeByExecutionId(workflowExecutionId: string): {
    mergeHash: string;
    deliveryGatePassed: true;
  } | null;
  findLatestPublishedMergeBySpecExecutionId(specExecutionId: string): {
    mergeHash: string;
    deliveryGatePassed: true;
  } | null;
  findMergeValidationByExecutionIdAndRef(
    workflowExecutionId: string,
    validationRef: string,
  ): { mergeJobId: string; validation: CandidateValidationFact } | null;
  deleteJobRecordsForSession(projectName: string, sessionName: string): number;
  deleteJobRecordsForProject(projectName: string): number;
  /**
   * Startup sweep: fail `running` rows whose owner process is dead and record
   * an interruption notification for each (persist-only, via the notifications
   * repo over the same connection). Returns the swept count.
   */
  recoverStaleJobs(): number;
}

export function createJobsRepo(db: Db): JobsRepo {
  function createJobRecord(job: BackgroundJob): void {
    timedSync(
      jobRecordLogger,
      "state-db.createJobRecord",
      { jobId: job.jobId, jobType: job.jobType },
      () => {
        const validated = parseBackgroundJobOrFail(job, job.jobId);
        // owner_pid: jobs execute in-process in the worker that inserts them, so
        // the inserting pid is the process holding the live machine actor. The
        // startup sweep uses it to distinguish rows orphaned by a dead process
        // from jobs still live in another worker sharing the file-backed DB.
        // finalize_session_on_publish and resolution_context are dispatch-time
        // facts: both are decided before the machine starts and never change
        // for the job, so they are written once here and left alone by the
        // terminal update.
        db.prepare(
          `INSERT OR REPLACE INTO job_records (job_id, job_type, status, project_name, session_name, branch_name, started_at, owner_pid, execution_id, spec_execution_id, final_publish, candidate_validation, finalize_session_on_publish, resolution_context, skip_mark_merged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          validated.jobId,
          validated.jobType,
          validated.status,
          validated.projectName,
          validated.sessionName,
          validated.branchName,
          validated.startedAt,
          process.pid,
          validated.executionId ?? null,
          validated.specExecutionId ?? null,
          validated.finalPublish === true ? 1 : 0,
          validated.candidateValidation
            ? JSON.stringify(validated.candidateValidation)
            : null,
          validated.finalizeSessionOnPublish === undefined
            ? null
            : validated.finalizeSessionOnPublish
              ? 1
              : 0,
          validated.resolutionContext ?? null,
          validated.skipMarkMerged === undefined
            ? null
            : Number(validated.skipMarkMerged),
        );
      },
    );
  }

  function updateJobRecord(jobId: string, update: JobRecordUpdate): void {
    timedSync(
      jobRecordLogger,
      "state-db.updateJobRecord",
      { jobId, status: update.status },
      () => {
        const validated = parseJobRecordUpdateOrFail(update, jobId);
        db.prepare(
          `UPDATE job_records SET
       status = ?,
       completed_at = datetime('now'),
       merge_hash = ?,
       commit_hash = ?,
       conflict_count = ?,
       conflict_files = ?,
       error_message = ?,
       execution_id = COALESCE(?, execution_id),
       parked_ref = ?,
       prepared_sha = ?,
       expected_target_sha = ?,
       candidate_validation = COALESCE(?, candidate_validation)
     WHERE job_id = ?`,
        ).run(
          validated.status,
          validated.mergeHash ?? null,
          validated.commitHash ?? null,
          validated.conflictCount ?? null,
          validated.conflictFiles
            ? JSON.stringify(validated.conflictFiles)
            : null,
          validated.errorMessage ?? null,
          validated.executionId ?? null,
          validated.parkedRef ?? null,
          validated.preparedSha ?? null,
          validated.expectedTargetSha ?? null,
          validated.candidateValidation
            ? JSON.stringify(validated.candidateValidation)
            : null,
          jobId,
        );
      },
    );
  }

  function persistCandidateValidation(
    jobId: string,
    candidateValidation: CandidateValidationFact,
  ): void {
    timedSync(
      jobRecordLogger,
      "state-db.persistCandidateValidation",
      { jobId, validationRef: candidateValidation.validationRef },
      () => {
        const validated = parseTrusted(
          candidateValidationFactSchema,
          candidateValidation,
          (issues) => logAndThrowJobRecordValidationFailure(jobId, issues),
        );
        db.prepare(
          `UPDATE job_records
             SET candidate_validation = ?
           WHERE job_id = ?`,
        ).run(JSON.stringify(validated), jobId);
      },
    );
  }

  function getJobRecord(jobId: string): JobRecord | null {
    return timedSync(
      jobRecordLogger,
      "state-db.getJobRecord",
      { jobId },
      () => {
        const rawRow = db
          .prepare("SELECT * FROM job_records WHERE job_id = ?")
          .get(jobId);
        if (rawRow === undefined) return null;
        return rowToJobRecord(rawRow);
      },
      (result) => ({ found: result !== null }),
    );
  }

  function findLatestJobRecordForSession(
    projectName: string,
    sessionName: string,
  ): JobRecord | null {
    return timedSync(
      jobRecordLogger,
      "state-db.findLatestJobRecordForSession",
      { projectName, sessionName },
      () => {
        // Insert order is dispatch order, which is the registry's own rule for
        // which job owns the session; `started_at` would sort two dispatches
        // inside the same millisecond arbitrarily.
        const rawRow = db
          .prepare(
            `SELECT *
               FROM job_records
              WHERE project_name = ?
                AND session_name = ?
              ORDER BY rowid DESC
              LIMIT 1`,
          )
          .get(projectName, sessionName);
        if (rawRow === undefined) return null;
        return rowToJobRecord(rawRow);
      },
      (result) => ({ found: result !== null }),
    );
  }

  function listParkedJobRecords(
    projectName: string,
    sessionName: string,
  ): JobRecord[] {
    return timedSync(
      jobRecordLogger,
      "state-db.listParkedJobRecords",
      { projectName, sessionName },
      () => {
        const rows = db
          .prepare(
            `SELECT *
               FROM job_records
              WHERE project_name = ?
                AND session_name = ?
                AND status = 'ready-to-land'
              ORDER BY rowid DESC`,
          )
          .all(projectName, sessionName);
        return rows.map(rowToJobRecord);
      },
      (result) => ({ count: result.length }),
    );
  }

  function listJobIdsHoldingParkedRefs(): string[] {
    const rows = db
      .prepare(
        `SELECT job_id FROM job_records WHERE status IN ('ready-to-land', 'running')`,
      )
      .all() as unknown[];
    return rows.map((row) => parseTrusted(jobIdColumnSchema, row).job_id);
  }

  function findLatestPublishedMerge(
    identityColumn: "execution_id" | "spec_execution_id",
    executionId: string,
  ): { mergeHash: string; deliveryGatePassed: true } | null {
    return timedSync(
      jobRecordLogger,
      "state-db.findLatestPublishedMerge",
      { identityColumn, executionId },
      () => {
        const rawRow = db
          .prepare(
            `SELECT merge_hash, expected_target_sha
               FROM job_records
              WHERE job_type IN ('merge', 'resolve-conflicts')
                AND status = 'completed'
                AND ${identityColumn} = ?
                AND final_publish = 1
                AND COALESCE(merge_hash, expected_target_sha) IS NOT NULL
              ORDER BY completed_at DESC, rowid DESC
              LIMIT 1`,
          )
          .get(executionId);
        if (rawRow === undefined) return null;
        const row = parseTrusted(publishedMergeColumnsSchema, rawRow);
        // A merge that landed carries its own commit; one that completed
        // without a merge hash found the target already containing the branch
        // and delivered the target tip the gate evaluated as its candidate.
        const deliveredSha = row.merge_hash ?? row.expected_target_sha;
        return deliveredSha === undefined || deliveredSha === null
          ? null
          : { mergeHash: deliveredSha, deliveryGatePassed: true };
      },
      (result) => ({ found: result !== null }),
    );
  }

  function findMergeValidationByExecutionIdAndRef(
    workflowExecutionId: string,
    validationRef: string,
  ): { mergeJobId: string; validation: CandidateValidationFact } | null {
    return timedSync(
      jobRecordLogger,
      "state-db.findMergeValidationByExecutionIdAndRef",
      { workflowExecutionId, validationRef },
      () => {
        const rows = db
          .prepare(
            `SELECT *
               FROM job_records
              WHERE job_type IN ('merge', 'resolve-conflicts')
                AND execution_id = ?
                AND candidate_validation IS NOT NULL
              ORDER BY rowid DESC`,
          )
          .all(workflowExecutionId);
        for (const row of rows) {
          const job = rowToBackgroundJob(row);
          if (job.candidateValidation?.validationRef === validationRef) {
            return {
              mergeJobId: job.jobId,
              validation: job.candidateValidation,
            };
          }
        }
        return null;
      },
      (result) => ({ found: result !== null }),
    );
  }

  function deleteJobRecordsForSession(
    projectName: string,
    sessionName: string,
  ): number {
    const result = db
      .prepare(
        "DELETE FROM job_records WHERE project_name = ? AND session_name = ?",
      )
      .run(projectName, sessionName);
    return result.changes;
  }

  function deleteJobRecordsForProject(projectName: string): number {
    const result = db
      .prepare("DELETE FROM job_records WHERE project_name = ?")
      .run(projectName);
    return result.changes;
  }

  function recoverStaleJobs(): number {
    return timedSync(
      jobRecordLogger,
      "state-db.recoverStaleJobs",
      {},
      () => recoverStaleJobsImpl(),
      (count) => ({ recoveredCount: count }),
    );
  }

  function recoverStaleJobsImpl(): number {
    const rawStaleRows = db
      .prepare("SELECT * FROM job_records WHERE status = 'running'")
      .all() as unknown[];

    if (rawStaleRows.length === 0) return 0;

    // A job's machine actor lives only in the worker process that inserted the
    // row, so a `running` row whose owner process is gone would report running
    // forever. Multiple same-host workers (main server + session dev servers)
    // share one file-backed DB, so another worker's startup must not fail a job
    // still live elsewhere — only rows whose owner pid is dead or unrecorded
    // (written before pids were persisted) are swept.
    const orphanedRows = rawStaleRows.filter((rawRow) => {
      const ownerPid = parseTrusted(staleJobOwnerPidSchema, rawRow).owner_pid;
      return (
        ownerPid === null || ownerPid === undefined || !isProcessAlive(ownerPid)
      );
    });
    if (orphanedRows.length === 0) return 0;

    const staleJobs = orphanedRows.map(rowToBackgroundJob);

    jobRecordLogger.info("state-store.job-records.sweep_orphaned", {
      jobIds: staleJobs.map((job) => job.jobId),
    });

    const updateStmt = db.prepare(
      `UPDATE job_records SET status = 'failed', completed_at = datetime('now'), error_message = ? WHERE job_id = ? AND status = 'running'`,
    );
    const errorMsg = "Job interrupted by server restart";

    // Notification rows go through the notifications repo (same connection, so
    // the writes join this transaction). Startup recovery is persist-only: SSE
    // clients and push targets predate a restarted server's sweep, so no service
    // side effects fire here.
    const notificationsRepo = createNotificationsRepo(db);

    const recoverAll = db.transaction(() => {
      let recoveredCount = 0;
      for (const job of staleJobs) {
        const update = updateStmt.run(errorMsg, job.jobId);
        if (update.changes !== 1) continue;

        const notifType = deriveNotificationType(job.jobType, "failed");
        notificationsRepo.createJobNotification({
          type: notifType,
          title: deriveNotificationTitle(notifType),
          message: `${job.jobType} job on ${job.branchName} was interrupted by server restart`,
          projectName: job.projectName,
          sessionName: job.sessionName,
          branchName: job.branchName,
          jobId: job.jobId,
          jobType: job.jobType,
          errorMessage: errorMsg,
        });
        recoveredCount += 1;
      }
      return recoveredCount;
    });

    const recoveredCount = recoverAll();

    jobRecordLogger.info("notification-db.stale_jobs_recovered", {
      count: recoveredCount,
    });
    return recoveredCount;
  }

  return {
    findLatestPublishedMergeBySpecExecutionId(id) {
      return findLatestPublishedMerge("spec_execution_id", id);
    },
    createJobRecord,
    updateJobRecord,
    persistCandidateValidation,
    getJobRecord,
    findLatestJobRecordForSession,
    listParkedJobRecords,
    listJobIdsHoldingParkedRefs,
    findLatestPublishedMergeByExecutionId(id) {
      return findLatestPublishedMerge("execution_id", id);
    },
    findMergeValidationByExecutionIdAndRef,
    deleteJobRecordsForSession,
    deleteJobRecordsForProject,
    recoverStaleJobs,
  };
}
