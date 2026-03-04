import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getConfigDirPath } from "./config";
import { broadcast } from "./sse-broadcaster";
import { createLogger } from "./logging";
import {
  getGlobalSingleton,
  getGlobalValue,
  setGlobalValue,
  deleteGlobalValue,
} from "./global-singleton";
import type {
  Notification,
  NotificationType,
  JobType,
  JobStatus,
} from "@/types";
import type { BackgroundJob } from "@/types";

const logger = createLogger("notification-db");

// ============================================================
// Database singleton (HMR-safe via globalThis)
// ============================================================

const GLOBAL_KEY = "__cc_notification_db" as const;

function getDb(): InstanceType<typeof Database> {
  return getGlobalSingleton(GLOBAL_KEY, () => {
    const configDir = getConfigDirPath();
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    const dbPath = path.join(configDir, "notifications.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initializeSchema(db);
    return db;
  });
}

// ============================================================
// Schema initialization
// ============================================================

function initializeSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      title         TEXT NOT NULL,
      message       TEXT NOT NULL,
      read          INTEGER NOT NULL DEFAULT 0,
      project_name  TEXT NOT NULL,
      session_name  TEXT NOT NULL,
      branch_name   TEXT NOT NULL,
      job_id        TEXT NOT NULL,
      job_type      TEXT NOT NULL,
      merge_hash    TEXT,
      commit_hash   TEXT,
      conflict_count INTEGER,
      conflict_files TEXT,
      error_message TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
    CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_project_session ON notifications(project_name, session_name);

    CREATE TABLE IF NOT EXISTS job_records (
      job_id        TEXT PRIMARY KEY,
      job_type      TEXT NOT NULL,
      status        TEXT NOT NULL,
      project_name  TEXT NOT NULL,
      session_name  TEXT NOT NULL,
      branch_name   TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      completed_at  TEXT,
      merge_hash    TEXT,
      commit_hash   TEXT,
      conflict_count INTEGER,
      conflict_files TEXT,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_job_records_status ON job_records(status);
  `);
}

// ============================================================
// Row <-> Domain mapping
// ============================================================

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  message: string;
  read: number;
  project_name: string;
  session_name: string;
  branch_name: string;
  job_id: string;
  job_type: string;
  merge_hash: string | null;
  commit_hash: string | null;
  conflict_count: number | null;
  conflict_files: string | null;
  error_message: string | null;
  created_at: string;
}

function rowToNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    type: row.type as NotificationType,
    title: row.title,
    message: row.message,
    read: row.read === 1,
    projectName: row.project_name,
    sessionName: row.session_name,
    branchName: row.branch_name,
    jobId: row.job_id,
    jobType: row.job_type as JobType,
    ...(row.merge_hash != null && { mergeHash: row.merge_hash }),
    ...(row.commit_hash != null && { commitHash: row.commit_hash }),
    ...(row.conflict_count != null && { conflictCount: row.conflict_count }),
    ...(row.conflict_files != null && {
      conflictFiles: JSON.parse(row.conflict_files) as string[],
    }),
    ...(row.error_message != null && { errorMessage: row.error_message }),
    createdAt: row.created_at,
  };
}

// ============================================================
// Notification CRUD (Task 2.2)
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
  errorMessage?: string;
}

export function createNotification(
  input: CreateNotificationInput,
): Notification {
  const db = getDb();
  const id = randomUUID();
  const stmt = db.prepare(`
    INSERT INTO notifications (id, type, title, message, project_name, session_name, branch_name, job_id, job_type, merge_hash, commit_hash, conflict_count, conflict_files, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    input.type,
    input.title,
    input.message,
    input.projectName,
    input.sessionName,
    input.branchName,
    input.jobId,
    input.jobType,
    input.mergeHash ?? null,
    input.commitHash ?? null,
    input.conflictCount ?? null,
    input.conflictFiles ? JSON.stringify(input.conflictFiles) : null,
    input.errorMessage ?? null,
  );

  // Read back from DB to get the server-generated created_at
  const row = db
    .prepare("SELECT * FROM notifications WHERE id = ?")
    .get(id) as NotificationRow;
  const notification = rowToNotification(row);

  // Broadcast notification-created SSE event
  broadcast({ type: "notification-created", notification });

  logger.info("notification.created", {
    notificationId: id,
    notificationType: input.type,
    projectName: input.projectName,
    sessionName: input.sessionName,
  });

  return notification;
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
  const db = getDb();
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
    .all(...params, limit, offset) as NotificationRow[];

  return {
    notifications: rows.map(rowToNotification),
    total: totalRow.count,
    unreadCount: unreadRow.count,
  };
}

export function deleteNotification(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM notifications WHERE id = ?").run(id);
  return result.changes > 0;
}

// ============================================================
// Read/Unread operations (Task 2.3)
// ============================================================

export function markAsRead(id: string): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE notifications SET read = 1 WHERE id = ? AND read = 0")
    .run(id);
  if (result.changes > 0) {
    broadcast({ type: "notification-updated", id, read: true });
    return true;
  }
  // Check if notification exists but was already read
  const exists = db
    .prepare("SELECT id FROM notifications WHERE id = ?")
    .get(id);
  return exists != null;
}

export function markAllAsRead(): number {
  const db = getDb();
  const result = db
    .prepare("UPDATE notifications SET read = 1 WHERE read = 0")
    .run();
  if (result.changes > 0) {
    broadcast({ type: "notification-updated", id: "all", read: true });
  }
  return result.changes;
}

export function deleteAllNotifications(): number {
  const db = getDb();
  const result = db.prepare("DELETE FROM notifications").run();
  return result.changes;
}

export function getUnreadCount(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0")
    .get() as { count: number };
  return row.count;
}

// ============================================================
// Job record operations (Task 2.4)
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
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO job_records (job_id, job_type, status, project_name, session_name, branch_name, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.jobId,
    job.jobType,
    job.status,
    job.projectName,
    job.sessionName,
    job.branchName,
    job.startedAt,
  );
}

export function updateJobRecord(jobId: string, update: JobRecordUpdate): void {
  const db = getDb();
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
    update.status,
    update.mergeHash ?? null,
    update.commitHash ?? null,
    update.conflictCount ?? null,
    update.conflictFiles ? JSON.stringify(update.conflictFiles) : null,
    update.errorMessage ?? null,
    jobId,
  );
}

// ============================================================
// Startup recovery & retention cleanup (Task 2.5)
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

interface StaleJobRow {
  job_id: string;
  job_type: string;
  project_name: string;
  session_name: string;
  branch_name: string;
}

export function recoverStaleJobs(): number {
  const db = getDb();

  const staleJobs = db
    .prepare("SELECT * FROM job_records WHERE status = 'running'")
    .all() as StaleJobRow[];

  if (staleJobs.length === 0) return 0;

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
      updateStmt.run(errorMsg, job.job_id);
      const notifType = deriveNotificationType(
        job.job_type as JobType,
        "failed",
      );
      insertNotification.run(
        randomUUID(),
        notifType,
        deriveNotificationTitle(notifType),
        `${job.job_type} job on ${job.branch_name} was interrupted by server restart`,
        job.project_name,
        job.session_name,
        job.branch_name,
        job.job_id,
        job.job_type,
        errorMsg,
      );
    }
  });

  recoverAll();

  logger.info("notification-db.stale_jobs_recovered", {
    count: staleJobs.length,
  });
  return staleJobs.length;
}

export function cleanupOldNotifications(retentionDays = 7): number {
  const db = getDb();
  // Use <= for the boundary so that retentionDays=0 correctly deletes everything
  const result = db
    .prepare(
      `DELETE FROM notifications WHERE created_at <= datetime('now', ? || ' days')`,
    )
    .run(`-${retentionDays}`);
  if (result.changes > 0) {
    logger.info("notification-db.cleanup", { deleted: result.changes });
  }
  return result.changes;
}

// ============================================================
// Initialization (called on startup)
// ============================================================

export function initialize(): void {
  // getDb() initializes the schema if needed
  getDb();
  const recovered = recoverStaleJobs();
  const cleaned = cleanupOldNotifications();
  logger.info("notification-db.initialized", {
    recoveredJobs: recovered,
    cleanedNotifications: cleaned,
  });
}

/**
 * Check if a notification exists by id.
 */
export function notificationExists(id: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT id FROM notifications WHERE id = ?").get(id);
  return row != null;
}

// ============================================================
// Test helpers
// ============================================================

/** Reset database for testing — do not use in production */
export function _resetForTesting(): void {
  const db = getGlobalValue<InstanceType<typeof Database>>(GLOBAL_KEY);
  if (db) {
    db.close();
    deleteGlobalValue(GLOBAL_KEY);
  }
}

/** Create an in-memory database for testing */
export function _createTestDb(): void {
  // Close existing if any
  const existing = getGlobalValue<InstanceType<typeof Database>>(GLOBAL_KEY);
  if (existing) {
    existing.close();
  }
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeSchema(db);
  setGlobalValue(GLOBAL_KEY, db);
}
