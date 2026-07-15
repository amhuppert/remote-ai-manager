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
  jobRecordSchema,
  jobStatusSchema,
} from "./schemas";
import type { BackgroundJob, JobRecord, JobType, JobStatus } from "./schemas";
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
  }),
  "jobRecordRowSchema",
);
type JobRecordRow = z.infer<typeof jobRecordRowSchema>;

const jobConflictFilesSchema = registerTrustedSchema(
  z.array(z.string()),
  "jobRecord.conflictFiles",
);

const jobRecordUpdateSchema = z.object({
  status: jobStatusSchema,
  mergeHash: z.string().optional(),
  commitHash: z.string().optional(),
  conflictCount: z.number().optional(),
  conflictFiles: z.array(z.string()).optional(),
  errorMessage: z.string().optional(),
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

  return parseTrusted(backgroundJobSchema, candidate, (issues) =>
    logAndThrowJobRecordValidationFailure(row.job_id, issues),
  );
}

export interface JobRecordUpdate {
  status: JobStatus;
  mergeHash?: string;
  commitHash?: string;
  conflictCount?: number;
  conflictFiles?: string[];
  errorMessage?: string;
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
  }
}

export interface JobsRepo {
  createJobRecord(job: BackgroundJob): void;
  updateJobRecord(jobId: string, update: JobRecordUpdate): void;
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
        db.prepare(
          `INSERT OR REPLACE INTO job_records (job_id, job_type, status, project_name, session_name, branch_name, started_at, owner_pid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          validated.jobId,
          validated.jobType,
          validated.status,
          validated.projectName,
          validated.sessionName,
          validated.branchName,
          validated.startedAt,
          process.pid,
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
       error_message = ?
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
          jobId,
        );
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
        if (job.completedAt !== undefined)
          durable.completedAt = job.completedAt;
        if (job.mergeHash !== undefined) durable.mergeHash = job.mergeHash;
        if (job.commitHash !== undefined) durable.commitHash = job.commitHash;
        if (job.conflictCount !== undefined)
          durable.conflictCount = job.conflictCount;
        if (job.conflictFiles !== undefined)
          durable.conflictFiles = job.conflictFiles;
        if (job.errorMessage !== undefined)
          durable.errorMessage = job.errorMessage;

        return parseTrusted(jobRecordSchema, durable);
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
    createJobRecord,
    updateJobRecord,
    getJobRecord,
    deleteJobRecordsForSession,
    deleteJobRecordsForProject,
    recoverStaleJobs,
  };
}
