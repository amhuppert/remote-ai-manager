import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getStateDb } from "./state-store/state-store";
import {
  _createTestDb as _createSharedStateDb,
  _installTestDb as _installSharedStateDb,
  _resetForTesting as _resetSharedStateDb,
} from "./state-store/state-db";
import type { BroadcastFn } from "./sse-broadcaster";
import { publishSessionStatus } from "./workflows/primitives/default-session-status-bus";
import { createLogger } from "./logging";
import { timedSync } from "./logging/timed";
import {
  notificationSchema,
  backgroundJobSchema,
  jobStatusSchema,
} from "./schemas";
import type {
  Notification,
  NotificationType,
  JobType,
  JobStatus,
  BackgroundJob,
} from "@/types";
import { PersistenceError } from "./errors";
import { dispatchPushForNotification } from "./push-dispatcher";

const defaultBroadcast: BroadcastFn = (event) => {
  publishSessionStatus(event);
};

type Db = InstanceType<typeof Database>;

const notificationLogger = createLogger("state-store.notifications");
const jobRecordLogger = createLogger("state-store.job-records");

// ============================================================
// Row schemas (raw SQLite shape) — first-pass validation gate
// ============================================================

const notificationRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  message: z.string(),
  read: z.union([z.literal(0), z.literal(1)]),
  project_name: z.string(),
  session_name: z.string(),
  branch_name: z.string(),
  job_id: z.string(),
  job_type: z.string(),
  merge_hash: z.string().nullable(),
  commit_hash: z.string().nullable(),
  conflict_count: z.number().int().nullable(),
  conflict_files: z.string().nullable(),
  target_branch: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
});
type NotificationRow = z.infer<typeof notificationRowSchema>;

const jobRecordRowSchema = z.object({
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
});
type JobRecordRow = z.infer<typeof jobRecordRowSchema>;

// ============================================================
// Write-input schemas — validated BEFORE the SQL commit so corrupt
// runtime input cannot leave an invalid row in the database.
// ============================================================

const jobRecordUpdateSchema = z.object({
  status: jobStatusSchema,
  mergeHash: z.string().optional(),
  commitHash: z.string().optional(),
  conflictCount: z.number().optional(),
  conflictFiles: z.array(z.string()).optional(),
  errorMessage: z.string().optional(),
});

// ============================================================
// Row → domain mappers (Zod safeParse at the persistence boundary)
// ============================================================

function logAndThrowNotificationValidationFailure(
  identifier: string | undefined,
  issues: unknown,
): never {
  const payload: Record<string, unknown> = { issues };
  if (identifier !== undefined) payload.identifier = identifier;
  notificationLogger.error(
    "state-store.notifications.schema_validation_failure",
    payload,
  );
  throw new PersistenceError({
    kind: "validation",
    entity: "notification",
    ...(identifier !== undefined ? { identifier } : {}),
    issues,
  });
}

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

function parseNotificationOrFail(
  candidate: unknown,
  identifier: string | undefined,
): Notification {
  const result = notificationSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowNotificationValidationFailure(
      identifier,
      result.error.issues,
    );
  }
  return result.data;
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

/**
 * Render a UTC timestamp string in the same format as SQLite's `datetime('now')`
 * — `YYYY-MM-DD HH:MM:SS` — so that retention comparisons against
 * `datetime('now', ?)` remain lexicographically correct after we move
 * timestamp generation from SQL into JS (required to validate the row through
 * notificationSchema BEFORE the INSERT commits).
 */
function sqliteUtcNow(): string {
  const iso = new Date().toISOString();
  return iso.slice(0, 10) + " " + iso.slice(11, 19);
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
  const result = z.array(z.string()).safeParse(parsed);
  if (!result.success) return { ok: false, issues: result.error.issues };
  return { ok: true, value: result.data };
}

function rowToNotification(rawRow: unknown): Notification {
  const candidateId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { id?: unknown }).id === "string"
      ? (rawRow as { id: string }).id
      : undefined;

  const rowResult = notificationRowSchema.safeParse(rawRow);
  if (!rowResult.success) {
    return logAndThrowNotificationValidationFailure(
      candidateId,
      rowResult.error.issues,
    );
  }
  const row: NotificationRow = rowResult.data;

  const conflictFilesResult = parseConflictFilesColumn(
    row.id,
    row.conflict_files,
  );
  if (!conflictFilesResult.ok) {
    return logAndThrowNotificationValidationFailure(
      row.id,
      conflictFilesResult.issues,
    );
  }

  const candidate: Record<string, unknown> = {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    read: row.read === 1,
    projectName: row.project_name,
    sessionName: row.session_name,
    branchName: row.branch_name,
    jobId: row.job_id,
    jobType: row.job_type,
    createdAt: row.created_at,
  };
  if (row.merge_hash !== null) candidate.mergeHash = row.merge_hash;
  if (row.commit_hash !== null) candidate.commitHash = row.commit_hash;
  if (row.conflict_count !== null) candidate.conflictCount = row.conflict_count;
  if (conflictFilesResult.value !== undefined)
    candidate.conflictFiles = conflictFilesResult.value;
  if (row.target_branch !== null) candidate.targetBranch = row.target_branch;
  if (row.error_message !== null) candidate.errorMessage = row.error_message;

  return parseNotificationOrFail(candidate, row.id);
}

function rowToBackgroundJob(rawRow: unknown): BackgroundJob {
  const candidateId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { job_id?: unknown }).job_id === "string"
      ? (rawRow as { job_id: string }).job_id
      : undefined;

  const rowResult = jobRecordRowSchema.safeParse(rawRow);
  if (!rowResult.success) {
    return logAndThrowJobRecordValidationFailure(
      candidateId,
      rowResult.error.issues,
    );
  }
  const row: JobRecordRow = rowResult.data;

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

  return parseBackgroundJobOrFail(candidate, row.job_id);
}

// ============================================================
// Notification CRUD
// ============================================================

export interface CreateNotificationInput {
  type: NotificationType;
  title: string;
  message: string;
  projectName: string;
  sessionName: string;
  branchName: string;
  jobId: string;
  jobType: JobType;
  mergeHash?: string;
  commitHash?: string;
  conflictCount?: number;
  conflictFiles?: string[];
  targetBranch?: string;
  errorMessage?: string;
}

export function createNotification(
  input: CreateNotificationInput,
  broadcast: BroadcastFn = defaultBroadcast,
): Notification {
  const id = randomUUID();
  return timedSync(
    notificationLogger,
    "state-db.createNotification",
    {
      notificationId: id,
      notificationType: input.type,
      projectName: input.projectName,
      sessionName: input.sessionName,
    },
    () => {
      const createdAt = sqliteUtcNow();

      const candidate: Record<string, unknown> = {
        id,
        type: input.type,
        title: input.title,
        message: input.message,
        read: false,
        projectName: input.projectName,
        sessionName: input.sessionName,
        branchName: input.branchName,
        jobId: input.jobId,
        jobType: input.jobType,
        createdAt,
      };
      if (input.mergeHash !== undefined) candidate.mergeHash = input.mergeHash;
      if (input.commitHash !== undefined)
        candidate.commitHash = input.commitHash;
      if (input.conflictCount !== undefined)
        candidate.conflictCount = input.conflictCount;
      if (input.conflictFiles !== undefined)
        candidate.conflictFiles = input.conflictFiles;
      if (input.targetBranch !== undefined)
        candidate.targetBranch = input.targetBranch;
      if (input.errorMessage !== undefined)
        candidate.errorMessage = input.errorMessage;

      const validated = parseNotificationOrFail(candidate, id);

      const db = getStateDb();
      db.prepare(
        `INSERT INTO notifications (id, type, title, message, read, project_name, session_name, branch_name, job_id, job_type, merge_hash, commit_hash, conflict_count, conflict_files, target_branch, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        validated.id,
        validated.type,
        validated.title,
        validated.message,
        validated.read ? 1 : 0,
        validated.projectName,
        validated.sessionName,
        validated.branchName,
        validated.jobId,
        validated.jobType,
        validated.mergeHash ?? null,
        validated.commitHash ?? null,
        validated.conflictCount ?? null,
        validated.conflictFiles
          ? JSON.stringify(validated.conflictFiles)
          : null,
        validated.targetBranch ?? null,
        validated.errorMessage ?? null,
        validated.createdAt,
      );

      broadcast({ type: "notification-created", notification: validated });

      dispatchPushForNotification(validated);

      return validated;
    },
  );
}

export interface GetNotificationsOptions {
  unread?: boolean;
  limit?: number;
  offset?: number;
}

export interface PaginatedNotifications {
  notifications: Notification[];
  total: number;
  unreadCount: number;
}

export function getNotifications(
  options: GetNotificationsOptions = {},
): PaginatedNotifications {
  const db = getStateDb();
  const { unread, limit = 50, offset = 0 } = options;

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (unread === true) {
    whereClauses.push("read = 0");
  } else if (unread === false) {
    whereClauses.push("read = 1");
  }

  const where =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const totalRow = db
    .prepare(`SELECT COUNT(*) as count FROM notifications ${where}`)
    .get(...params) as { count: number };

  const unreadRow = db
    .prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0")
    .get() as { count: number };

  const rows = db
    .prepare(
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown[];

  return {
    notifications: rows.map(rowToNotification),
    total: totalRow.count,
    unreadCount: unreadRow.count,
  };
}

export function deleteNotification(id: string): boolean {
  const db = getStateDb();
  const result = db.prepare("DELETE FROM notifications WHERE id = ?").run(id);
  return result.changes > 0;
}

export function markAsRead(
  id: string,
  broadcast: BroadcastFn = defaultBroadcast,
): boolean {
  const db = getStateDb();
  const result = db
    .prepare("UPDATE notifications SET read = 1 WHERE id = ? AND read = 0")
    .run(id);
  if (result.changes > 0) {
    broadcast({ type: "notification-updated", id, read: true });
    return true;
  }
  const exists = db
    .prepare("SELECT id FROM notifications WHERE id = ?")
    .get(id);
  return exists != null;
}

export function markAllAsRead(
  broadcast: BroadcastFn = defaultBroadcast,
): number {
  const db = getStateDb();
  const result = db
    .prepare("UPDATE notifications SET read = 1 WHERE read = 0")
    .run();
  if (result.changes > 0) {
    broadcast({ type: "notification-updated", id: "all", read: true });
  }
  return result.changes;
}

export function deleteAllNotifications(): number {
  const db = getStateDb();
  const result = db.prepare("DELETE FROM notifications").run();
  return result.changes;
}

export function getUnreadCount(): number {
  const db = getStateDb();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0")
    .get() as { count: number };
  return row.count;
}

// ============================================================
// Job record operations
// ============================================================

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

// ============================================================
// Startup recovery & retention cleanup
// ============================================================

/**
 * Derive the notification type from a job type and terminal status.
 */
export function deriveNotificationType(
  jobType: JobType,
  status: JobStatus,
): NotificationType {
  switch (jobType) {
    case "merge":
      if (status === "completed") return "merge-completed";
      if (status === "conflicts") return "merge-conflicts";
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
export function deriveNotificationTitle(type: NotificationType): string {
  switch (type) {
    case "merge-completed":
      return "Merge completed";
    case "merge-failed":
      return "Merge failed";
    case "merge-conflicts":
      return "Merge conflicts";
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
    INSERT INTO notifications (id, type, title, message, project_name, session_name, branch_name, job_id, job_type, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const recoverAll = db.transaction(() => {
    for (const job of staleJobs) {
      updateStmt.run(errorMsg, job.jobId);
      const notifType = deriveNotificationType(job.jobType, "failed");
      const candidateId = randomUUID();
      const validated = parseNotificationOrFail(
        {
          id: candidateId,
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
        },
        candidateId,
      );
      insertNotification.run(
        validated.id,
        validated.type,
        validated.title,
        validated.message,
        validated.projectName,
        validated.sessionName,
        validated.branchName,
        validated.jobId,
        validated.jobType,
        validated.errorMessage ?? null,
      );
    }
  });

  recoverAll();

  jobRecordLogger.info("notification-db.stale_jobs_recovered", {
    count: staleJobs.length,
  });
  return staleJobs.length;
}

export function cleanupOldNotifications(retentionDays = 7): number {
  return timedSync(
    notificationLogger,
    "state-db.cleanupOldNotifications",
    { retentionDays },
    () => {
      const db = getStateDb();
      // Use <= for the boundary so that retentionDays=0 correctly deletes everything
      const result = db
        .prepare(
          `DELETE FROM notifications WHERE created_at <= datetime('now', ? || ' days')`,
        )
        .run(`-${retentionDays}`);
      return result.changes;
    },
    (deleted) => ({ deleted }),
  );
}

// ============================================================
// Initialization (called on startup)
// ============================================================

export function initialize(): void {
  // getStateDb() initializes the schema if needed (via state-store/state-db.ts).
  getStateDb();
  const recovered = recoverStaleJobs();
  const cleaned = cleanupOldNotifications();
  notificationLogger.info("notification-db.initialized", {
    recoveredJobs: recovered,
    cleanedNotifications: cleaned,
  });
}

/**
 * Check if a notification exists by id.
 */
export function notificationExists(id: string): boolean {
  const db = getStateDb();
  const row = db.prepare("SELECT id FROM notifications WHERE id = ?").get(id);
  return row != null;
}

// ============================================================
// Test helpers — delegate to the shared state-db singleton
// ============================================================

/**
 * Test helper: reset the shared state-db singleton, closing any open
 * connection. Re-exported from `state-store/state-db.ts` for backward
 * compatibility with `notification-db.test.ts`.
 */
export const _resetForTesting = _resetSharedStateDb;

/**
 * Test helper: install a caller-provided `Database` into the shared singleton.
 * Re-exported for tests that need to point notification-db at a specific
 * connection (e.g. boot-order integration tests).
 */
export const _installTestDb = _installSharedStateDb;

/**
 * Test helper: open a fresh in-memory `command-center.db` connection and
 * install it onto the shared state-db singleton so that subsequent module-level
 * functions (which call `getStateDb()`) target an isolated database.
 */
export function _createTestDb(): Db {
  const db = _createSharedStateDb({ inMemory: true });
  _installSharedStateDb(db);
  return db;
}
