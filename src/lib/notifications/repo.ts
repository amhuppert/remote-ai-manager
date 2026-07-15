/**
 * Notifications persistence — a standalone repo factory over the shared
 * `command-center.db` connection.
 *
 * Pure persistence only: SSE publication and web-push dispatch are owned by
 * the notifications service (`@/lib/notifications/service`), never by repo
 * writes. Every row is validated through the notification schemas at the
 * boundary — on read via `rowToNotification`, and on write BEFORE the INSERT
 * commits so an invalid candidate never reaches the table.
 */

import type Database from "better-sqlite3";
import { getErrorMessage } from "@/lib/shared/errors";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { timedSync } from "@/lib/logging/timed";
import {
  jobNotificationSchema,
  notificationSchema,
} from "@/lib/notifications/schemas";
import type { JobType } from "@/lib/jobs/schemas";
import type {
  JobNotification,
  JobNotificationType,
  Notification,
  ProjectConversationNotification,
  ProjectConversationNotificationType,
} from "@/lib/notifications/schemas";
import { PersistenceError } from "@/lib/shared/errors";
import {
  parseTrusted,
  registerTrustedSchema,
} from "@/lib/shared/parse-trusted";

type Db = InstanceType<typeof Database>;

const notificationLogger = createLogger("state-store.notifications");

// ============================================================
// Row schemas (raw SQLite shape) — first-pass validation gate
// ============================================================

const notificationRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    source: z.enum(["job", "project-conversation"]),
    type: z.string(),
    title: z.string(),
    message: z.string(),
    read: z.union([z.literal(0), z.literal(1)]),
    project_name: z.string(),
    session_name: z.string().nullable(),
    branch_name: z.string().nullable(),
    job_id: z.string().nullable(),
    job_type: z.string().nullable(),
    merge_hash: z.string().nullable(),
    commit_hash: z.string().nullable(),
    conflict_count: z.number().int().nullable(),
    conflict_files: z.string().nullable(),
    target_branch: z.string().nullable(),
    conversation_id: z.string().nullable(),
    conversation_name: z.string().nullable(),
    conversation_status: z.string().nullable(),
    dedupe_key: z.string().nullable(),
    error_message: z.string().nullable(),
    created_at: z.string(),
  }),
  "notificationRowSchema",
);
type NotificationRow = z.infer<typeof notificationRowSchema>;

const notificationConflictFilesSchema = registerTrustedSchema(
  z.array(z.string()),
  "notification.conflictFiles",
);

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

function parseJobNotificationOrFail(
  candidate: unknown,
  identifier: string | undefined,
): JobNotification {
  const result = jobNotificationSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowNotificationValidationFailure(
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
    return {
      ok: true,
      value: parseTrusted(notificationConflictFilesSchema, parsed),
    };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, issues: err.issues };
    throw err;
  }
}

function rowToNotification(rawRow: unknown): Notification {
  const candidateId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { id?: unknown }).id === "string"
      ? (rawRow as { id: string }).id
      : undefined;

  const row: NotificationRow = parseTrusted(
    notificationRowSchema,
    rawRow,
    (issues) => logAndThrowNotificationValidationFailure(candidateId, issues),
  );

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
    source: row.source,
    type: row.type,
    title: row.title,
    message: row.message,
    read: row.read === 1,
    projectName: row.project_name,
    createdAt: row.created_at,
  };

  if (row.source === "job") {
    candidate.sessionName = row.session_name;
    candidate.branchName = row.branch_name;
    candidate.jobId = row.job_id;
    candidate.jobType = row.job_type;
    if (row.merge_hash !== null) candidate.mergeHash = row.merge_hash;
    if (row.commit_hash !== null) candidate.commitHash = row.commit_hash;
    if (row.conflict_count !== null)
      candidate.conflictCount = row.conflict_count;
    if (conflictFilesResult.value !== undefined)
      candidate.conflictFiles = conflictFilesResult.value;
    if (row.target_branch !== null) candidate.targetBranch = row.target_branch;
  } else {
    candidate.conversationId = row.conversation_id;
    candidate.conversationName = row.conversation_name;
    candidate.status = row.conversation_status;
  }

  if (row.error_message !== null) candidate.errorMessage = row.error_message;

  return parseTrusted(notificationSchema, candidate, (issues) =>
    logAndThrowNotificationValidationFailure(row.id, issues),
  );
}

// ============================================================
// Repo surface
// ============================================================

export interface CreateNotificationInput {
  type: JobNotificationType;
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

export interface CreateProjectConversationNotificationInput {
  type: ProjectConversationNotificationType;
  title: string;
  message: string;
  projectName: string;
  conversationId: string;
  conversationName?: string | null;
  status: ProjectConversationNotification["status"];
  errorMessage?: string;
  dedupeKey: string;
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

export interface MarkAsReadResult {
  /** The row transitioned unread → read by this call. */
  updated: boolean;
  /** A row with the id exists (whether or not it was already read). */
  exists: boolean;
}

export interface CreateProjectConversationNotificationResult {
  notification: ProjectConversationNotification;
  /**
   * False when the dedupe key matched an existing row and that row was
   * returned instead of inserting a new one.
   */
  created: boolean;
}

export interface NotificationsRepo {
  createJobNotification(input: CreateNotificationInput): JobNotification;
  createProjectConversationNotification(
    input: CreateProjectConversationNotificationInput,
  ): CreateProjectConversationNotificationResult;
  getNotifications(options?: GetNotificationsOptions): PaginatedNotifications;
  deleteNotification(id: string): boolean;
  markAsRead(id: string): MarkAsReadResult;
  /** Returns the number of rows transitioned unread → read. */
  markAllAsRead(): number;
  deleteAllNotifications(): number;
  deleteNotificationsForSession(
    projectName: string,
    sessionName: string,
  ): number;
  deleteNotificationsForProject(projectName: string): number;
  getUnreadCount(): number;
  /** Delete notifications older than the retention window; returns the count. */
  cleanupOldNotifications(retentionDays?: number): number;
  notificationExists(id: string): boolean;
}

export function createNotificationsRepo(db: Db): NotificationsRepo {
  function getProjectConversationNotificationByDedupeKey(
    dedupeKey: string,
  ): ProjectConversationNotification | undefined {
    const row = db
      .prepare(
        "SELECT * FROM notifications WHERE source = 'project-conversation' AND dedupe_key = ?",
      )
      .get(dedupeKey) as unknown;
    if (row === undefined) return undefined;
    const notification = rowToNotification(row);
    if (notification.source === "project-conversation") return notification;
    return logAndThrowNotificationValidationFailure(notification.id, [
      {
        code: "invalid_source",
        message: "Expected project-conversation notification for dedupe key",
      },
    ]);
  }

  function createJobNotification(
    input: CreateNotificationInput,
  ): JobNotification {
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
          source: "job",
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
        if (input.mergeHash !== undefined)
          candidate.mergeHash = input.mergeHash;
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

        const validated = parseJobNotificationOrFail(candidate, id);

        db.prepare(
          `INSERT INTO notifications (id, source, type, title, message, read, project_name, session_name, branch_name, job_id, job_type, merge_hash, commit_hash, conflict_count, conflict_files, target_branch, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          validated.id,
          validated.source,
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

        return validated;
      },
    );
  }

  function createProjectConversationNotification(
    input: CreateProjectConversationNotificationInput,
  ): CreateProjectConversationNotificationResult {
    const existing = getProjectConversationNotificationByDedupeKey(
      input.dedupeKey,
    );
    if (existing !== undefined) {
      return { notification: existing, created: false };
    }

    const id = randomUUID();
    return timedSync(
      notificationLogger,
      "state-db.createProjectConversationNotification",
      {
        notificationId: id,
        notificationType: input.type,
        projectName: input.projectName,
        conversationId: input.conversationId,
      },
      () => {
        const createdAt = sqliteUtcNow();
        const candidate: Record<string, unknown> = {
          id,
          source: "project-conversation",
          type: input.type,
          title: input.title,
          message: input.message,
          read: false,
          projectName: input.projectName,
          conversationId: input.conversationId,
          conversationName: input.conversationName ?? null,
          status: input.status,
          createdAt,
        };
        if (input.errorMessage !== undefined) {
          candidate.errorMessage = input.errorMessage;
        }

        const validated = parseNotificationOrFail(candidate, id);
        if (validated.source !== "project-conversation") {
          return logAndThrowNotificationValidationFailure(id, [
            {
              code: "invalid_source",
              message: "Expected project-conversation notification",
            },
          ]);
        }

        const result = db
          .prepare(
            `INSERT OR IGNORE INTO notifications (id, source, type, title, message, read, project_name, conversation_id, conversation_name, conversation_status, dedupe_key, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            validated.id,
            validated.source,
            validated.type,
            validated.title,
            validated.message,
            validated.read ? 1 : 0,
            validated.projectName,
            validated.conversationId,
            validated.conversationName,
            validated.status,
            input.dedupeKey,
            validated.errorMessage ?? null,
            validated.createdAt,
          );

        if (result.changes === 0) {
          const duplicate = getProjectConversationNotificationByDedupeKey(
            input.dedupeKey,
          );
          if (duplicate !== undefined) {
            return { notification: duplicate, created: false };
          }
        }

        return { notification: validated, created: true };
      },
    );
  }

  return {
    createJobNotification,
    createProjectConversationNotification,

    getNotifications(options: GetNotificationsOptions = {}) {
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
    },

    deleteNotification(id) {
      const result = db
        .prepare("DELETE FROM notifications WHERE id = ?")
        .run(id);
      return result.changes > 0;
    },

    markAsRead(id) {
      const result = db
        .prepare("UPDATE notifications SET read = 1 WHERE id = ? AND read = 0")
        .run(id);
      if (result.changes > 0) {
        return { updated: true, exists: true };
      }
      const exists =
        db.prepare("SELECT id FROM notifications WHERE id = ?").get(id) != null;
      return { updated: false, exists };
    },

    markAllAsRead() {
      const result = db
        .prepare("UPDATE notifications SET read = 1 WHERE read = 0")
        .run();
      return result.changes;
    },

    deleteAllNotifications() {
      const result = db.prepare("DELETE FROM notifications").run();
      return result.changes;
    },

    deleteNotificationsForSession(projectName, sessionName) {
      const result = db
        .prepare(
          "DELETE FROM notifications WHERE project_name = ? AND session_name = ?",
        )
        .run(projectName, sessionName);
      return result.changes;
    },

    deleteNotificationsForProject(projectName) {
      const result = db
        .prepare("DELETE FROM notifications WHERE project_name = ?")
        .run(projectName);
      return result.changes;
    },

    getUnreadCount() {
      const row = db
        .prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0")
        .get() as { count: number };
      return row.count;
    },

    cleanupOldNotifications(retentionDays = 7) {
      return timedSync(
        notificationLogger,
        "state-db.cleanupOldNotifications",
        { retentionDays },
        () => {
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
    },

    notificationExists(id) {
      const row = db
        .prepare("SELECT id FROM notifications WHERE id = ?")
        .get(id);
      return row != null;
    },
  };
}
