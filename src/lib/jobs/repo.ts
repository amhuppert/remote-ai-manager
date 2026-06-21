import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getStateDb } from "../state-store/store";
import { createLogger } from "../logging";
import { timedSync } from "../logging/timed";
import { PersistenceError } from "../shared/errors";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import { jobNotificationSchema } from "../notifications/schemas";
import {
  backgroundJobSchema,
  jobRecordSchema,
  jobStatusSchema,
} from "./schemas";
import type { BackgroundJob, JobRecord, JobType, JobStatus } from "./schemas";
import type {
  JobNotification,
  JobNotificationType,
} from "@/lib/notifications/schemas";
const jobRecordLogger = createLogger("state-store.job-records");

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
          message: err instanceof Error ? err.message : String(err),
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

/**
 * Render a UTC timestamp string in the same format as SQLite's `datetime('now')`
 * — `YYYY-MM-DD HH:MM:SS` — so notifications inserted from JS validate through
 * notificationSchema BEFORE the INSERT commits, while remaining lexicographically
 * comparable against retention queries that still use `datetime('now', ?)`.
 */
function sqliteUtcNow(): string {
  const iso = new Date().toISOString();
  return iso.slice(0, 10) + " " + iso.slice(11, 19);
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

export function createJobRecord(job: BackgroundJob): void {
  timedSync(
    jobRecordLogger,
    "state-db.createJobRecord",
    { jobId: job.jobId, jobType: job.jobType },
    () => {
      const validated = parseBackgroundJobOrFail(job, job.jobId);
      const db = getStateDb();
      db.prepare(
        `INSERT OR REPLACE INTO job_records (job_id, job_type, status, project_name, session_name, branch_name, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        validated.jobId,
        validated.jobType,
        validated.status,
        validated.projectName,
        validated.sessionName,
        validated.branchName,
        validated.startedAt,
      );
    },
  );
}

export function updateJobRecord(jobId: string, update: JobRecordUpdate): void {
  timedSync(
    jobRecordLogger,
    "state-db.updateJobRecord",
    { jobId, status: update.status },
    () => {
      const validated = parseJobRecordUpdateOrFail(update, jobId);
      const db = getStateDb();
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

/**
 * Read a single durable job record by id through the production row->domain
 * deserialization boundary (`rowToBackgroundJob`). Returns the durable
 * {@link JobRecord} shape — including `completedAt`, which is generated on the
 * write path by {@link updateJobRecord} — not the live `BackgroundJob` runtime
 * shape. Live-only keys are dropped: `jobRecordSchema` is `.strict()`, so the
 * returned object contains only durable fields. Returns `null` when no row
 * matches the id.
 */
export function getJobRecord(jobId: string): JobRecord | null {
  return timedSync(
    jobRecordLogger,
    "state-db.getJobRecord",
    { jobId },
    () => {
      const db = getStateDb();
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
      if (job.completedAt !== undefined) durable.completedAt = job.completedAt;
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

export function deleteJobRecordsForSession(
  projectName: string,
  sessionName: string,
): number {
  const db = getStateDb();
  const result = db
    .prepare(
      "DELETE FROM job_records WHERE project_name = ? AND session_name = ?",
    )
    .run(projectName, sessionName);
  return result.changes;
}

export function deleteJobRecordsForProject(projectName: string): number {
  const db = getStateDb();
  const result = db
    .prepare("DELETE FROM job_records WHERE project_name = ?")
    .run(projectName);
  return result.changes;
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

export function recoverStaleJobs(): number {
  return timedSync(
    jobRecordLogger,
    "state-db.recoverStaleJobs",
    {},
    () => recoverStaleJobsImpl(),
    (count) => ({ recoveredCount: count }),
  );
}

function recoverStaleJobsImpl(): number {
  const db = getStateDb();

  const rawStaleRows = db
    .prepare("SELECT * FROM job_records WHERE status = 'running'")
    .all() as unknown[];

  if (rawStaleRows.length === 0) return 0;

  const staleJobs = rawStaleRows.map(rowToBackgroundJob);

  const updateStmt = db.prepare(
    `UPDATE job_records SET status = 'failed', completed_at = datetime('now'), error_message = ? WHERE job_id = ?`,
  );
  const errorMsg = "Job interrupted by server restart";

  const insertNotification = db.prepare(`
    INSERT INTO notifications (id, source, type, title, message, project_name, session_name, branch_name, job_id, job_type, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const recoverAll = db.transaction(() => {
    for (const job of staleJobs) {
      updateStmt.run(errorMsg, job.jobId);
      const notifType = deriveNotificationType(job.jobType, "failed");
      const candidateId = randomUUID();
      const candidate: JobNotification = jobNotificationSchema.parse({
        id: candidateId,
        source: "job",
        type: notifType,
        title: deriveNotificationTitle(notifType),
        message: `${job.jobType} job on ${job.branchName} was interrupted by server restart`,
        read: false,
        projectName: job.projectName,
        sessionName: job.sessionName,
        branchName: job.branchName,
        jobId: job.jobId,
        jobType: job.jobType,
        errorMessage: errorMsg,
        createdAt: sqliteUtcNow(),
      });
      insertNotification.run(
        candidate.id,
        candidate.source,
        candidate.type,
        candidate.title,
        candidate.message,
        candidate.projectName,
        candidate.sessionName,
        candidate.branchName,
        candidate.jobId,
        candidate.jobType,
        candidate.errorMessage ?? null,
      );
    }
  });

  recoverAll();

  jobRecordLogger.info("notification-db.stale_jobs_recovered", {
    count: staleJobs.length,
  });
  return staleJobs.length;
}
