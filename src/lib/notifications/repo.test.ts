import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createNotification,
  createProjectConversationNotification,
  getNotifications,
  deleteNotification,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  cleanupOldNotifications,
  notificationExists,
  deleteNotificationsForSession,
  deleteNotificationsForProject,
  _createTestDb,
  _installTestDb,
  _resetForTesting,
} from "./repo";
import { recoverStaleJobs } from "@/lib/jobs/repo";
import {
  _createTestDb as createSharedStateDb,
  _createTestDbAtPath as createSharedStateDbAtPath,
  getDb as getSharedStateDb,
} from "@/lib/state-store/state-db";
import { PersistenceError } from "@/lib/shared/errors";
import { notificationSchema } from "@/lib/notifications/schemas";
import { dispatchPushForNotification } from "@/lib/push-notification/dispatcher";
import { randomUUID } from "node:crypto";

// Prevent tests from sending real push notifications to ntfy
vi.mock("@/lib/push-notification/dispatcher");

// Injected spy for broadcast (no vi.mock needed)
const mockBroadcast = vi.fn();

// ============================================================
// Helpers
// ============================================================

function createTestNotification(overrides: Record<string, unknown> = {}) {
  return createNotification(
    {
      type: "merge-completed",
      title: "Merge completed",
      message: "Branch csm/feature merged successfully",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      jobId: "job-1",
      jobType: "merge",
      ...overrides,
    },
    mockBroadcast,
  );
}

// ============================================================
// Setup
// ============================================================

beforeEach(() => {
  _createTestDb();
  vi.clearAllMocks();
});

afterEach(() => {
  _resetForTesting();
});

// ============================================================
// Schema initialization (Task 2.1)
// ============================================================

describe("schema initialization", () => {
  it("creates notifications and job_records tables", () => {
    // If we can create and query, tables exist
    const result = getNotifications();
    expect(result.notifications).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.unreadCount).toBe(0);
  });
});

// ============================================================
// Notification CRUD (Task 2.2)
// ============================================================

describe("createNotification", () => {
  it("creates a notification and returns it with all fields", () => {
    const notification = createTestNotification();

    expect(notification.id).toBeDefined();
    expect(notification.source).toBe("job");
    expect(notification.type).toBe("merge-completed");
    expect(notification.title).toBe("Merge completed");
    expect(notification.message).toBe("Branch csm/feature merged successfully");
    expect(notification.read).toBe(false);
    expect(notification.projectName).toBe("my-project");
    expect(notification.sessionName).toBe("feature");
    expect(notification.branchName).toBe("csm/feature");
    expect(notification.jobId).toBe("job-1");
    expect(notification.jobType).toBe("merge");
    expect(notification.createdAt).toBeDefined();
  });

  it("stores optional result metadata", () => {
    const notification = createTestNotification({
      mergeHash: "abc123",
      commitHash: "def456",
      conflictCount: 3,
      conflictFiles: ["file1.ts", "file2.ts", "file3.ts"],
      errorMessage: "Something went wrong",
    });

    expect(notification.mergeHash).toBe("abc123");
    expect(notification.commitHash).toBe("def456");
    expect(notification.conflictCount).toBe(3);
    expect(notification.conflictFiles).toEqual([
      "file1.ts",
      "file2.ts",
      "file3.ts",
    ]);
    expect(notification.errorMessage).toBe("Something went wrong");
  });

  it("broadcasts a notification-created SSE event", () => {
    const notification = createTestNotification();

    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "notification-created",
      notification,
    });
  });

  it("defaults read to false", () => {
    const notification = createTestNotification();
    expect(notification.read).toBe(false);
  });
});

describe("job notification variant regressions", () => {
  it("persists terminal job notification rows as the job variant without project-conversation fields", () => {
    const inputs = [
      {
        type: "merge-completed" as const,
        title: "Merge completed",
        message: "Merged",
        jobType: "merge" as const,
        jobId: "job-merge",
        mergeHash: "merge123",
      },
      {
        type: "commit-completed" as const,
        title: "Commit completed",
        message: "Committed",
        jobType: "commit" as const,
        jobId: "job-commit",
        commitHash: "commit123",
      },
      {
        type: "resolve-completed" as const,
        title: "Conflicts resolved",
        message: "Resolved",
        jobType: "resolve-conflicts" as const,
        jobId: "job-resolve",
        mergeHash: "resolve123",
      },
      {
        type: "merge-ready-to-land" as const,
        title: "Merge ready to land",
        message: "Ready",
        jobType: "merge" as const,
        jobId: "job-ready",
        targetBranch: "main",
      },
      {
        type: "merge-discarded" as const,
        title: "Prepared merge discarded",
        message: "Discarded",
        jobType: "merge" as const,
        jobId: "job-discarded",
      },
    ];

    const created = inputs.map((input) =>
      createTestNotification({
        ...input,
        projectName: "my-project",
        sessionName: "feature",
        branchName: "csm/feature",
      }),
    );

    for (const notification of created) {
      expect(notification.source).toBe("job");
      expect(notification.sessionName).toBe("feature");
      expect(notification.branchName).toBe("csm/feature");
      expect(notification.jobId).toMatch(/^job-/);
      expect("conversationId" in notification).toBe(false);
      expect("conversationName" in notification).toBe(false);
      expect("status" in notification).toBe(false);
    }

    const queried = getNotifications({ limit: 10 });
    expect(queried.total).toBe(inputs.length);
    expect(queried.unreadCount).toBe(inputs.length);
    expect(queried.notifications.every((n) => n.source === "job")).toBe(true);

    const db = getSharedStateDb();
    const rows = db
      .prepare(
        "SELECT source, conversation_id, conversation_status, dedupe_key FROM notifications ORDER BY job_id",
      )
      .all() as Array<{
      source: string;
      conversation_id: string | null;
      conversation_status: string | null;
      dedupe_key: string | null;
    }>;

    expect(rows).toHaveLength(inputs.length);
    for (const row of rows) {
      expect(row.source).toBe("job");
      expect(row.conversation_id).toBeNull();
      expect(row.conversation_status).toBeNull();
      expect(row.dedupe_key).toBeNull();
    }

    const readCount = markAllAsRead(mockBroadcast);
    expect(readCount).toBe(inputs.length);
    expect(getUnreadCount()).toBe(0);
  });
});

describe("project-conversation notifications", () => {
  it("parses a project-conversation variant without session or job fields", () => {
    const parsed = notificationSchema.parse({
      id: "plc-notification-1",
      source: "project-conversation",
      type: "project-conversation-ready",
      title: "Agent finished",
      message: "Project conversation is ready",
      read: false,
      projectName: "my-project",
      conversationId: "conversation-1",
      conversationName: "Architecture pass",
      status: "awaiting",
      createdAt: "2026-06-07 12:00:00",
    });

    expect(parsed.source).toBe("project-conversation");
    if (parsed.source !== "project-conversation") {
      throw new Error("Expected project-conversation notification");
    }
    expect(parsed.projectName).toBe("my-project");
    expect(parsed.conversationId).toBe("conversation-1");
    expect("sessionName" in parsed).toBe(false);
    expect("branchName" in parsed).toBe(false);
    expect("jobId" in parsed).toBe(false);
    expect("jobType" in parsed).toBe(false);
  });

  it("creates, queries, marks read, and dismisses without session fields", () => {
    const notification = createProjectConversationNotification(
      {
        type: "project-conversation-ready",
        title: "Agent finished",
        message: "Project conversation is ready",
        projectName: "my-project",
        conversationId: "conversation-1",
        conversationName: "Architecture pass",
        status: "awaiting",
        dedupeKey: "my-project:conversation-1:ready:turn-1",
      },
      mockBroadcast,
    );

    expect(notification.source).toBe("project-conversation");
    expect(notification.read).toBe(false);
    expect(notification.projectName).toBe("my-project");
    expect(notification.conversationId).toBe("conversation-1");
    expect(notification.conversationName).toBe("Architecture pass");
    expect(notification.status).toBe("awaiting");
    expect("sessionName" in notification).toBe(false);
    expect("branchName" in notification).toBe(false);
    expect("jobId" in notification).toBe(false);
    expect("jobType" in notification).toBe(false);

    const queried = getNotifications();
    expect(queried.total).toBe(1);
    expect(queried.unreadCount).toBe(1);
    expect(queried.notifications[0]).toEqual(notification);

    expect(markAsRead(notification.id, mockBroadcast)).toBe(true);
    expect(getNotifications().notifications[0]!.read).toBe(true);

    expect(deleteNotification(notification.id)).toBe(true);
    expect(getNotifications().total).toBe(0);
  });

  it("dispatches configured push handling for a new project-conversation notification", () => {
    const notification = createProjectConversationNotification(
      {
        type: "project-conversation-ready",
        title: "Agent finished",
        message: "Project conversation is ready",
        projectName: "my-project",
        conversationId: "conversation-1",
        conversationName: "Architecture pass",
        status: "awaiting",
        dedupeKey: "my-project:conversation-1:ready:turn-1",
      },
      mockBroadcast,
    );

    expect(dispatchPushForNotification).toHaveBeenCalledWith(notification);
  });

  it("returns the existing project-conversation row for a duplicate transition key", () => {
    const input = {
      type: "project-conversation-input-needed" as const,
      title: "Input needed",
      message: "Project conversation needs input",
      projectName: "my-project",
      conversationId: "conversation-1",
      conversationName: null,
      status: "waiting_for_input" as const,
      dedupeKey: "my-project:conversation-1:input:turn-2",
    };

    const first = createProjectConversationNotification(input, mockBroadcast);
    mockBroadcast.mockClear();
    vi.mocked(dispatchPushForNotification).mockClear();
    const duplicate = createProjectConversationNotification(
      {
        ...input,
        title: "Input still needed",
        message: "Duplicate transition",
      },
      mockBroadcast,
    );

    expect(duplicate).toEqual(first);
    expect(getNotifications().total).toBe(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(dispatchPushForNotification).not.toHaveBeenCalled();
  });
});

describe("getNotifications", () => {
  it("returns all notifications sorted by created_at descending", () => {
    createTestNotification({ jobId: "job-1" });
    createTestNotification({ jobId: "job-2" });
    createTestNotification({ jobId: "job-3" });

    const result = getNotifications();
    expect(result.notifications).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  it("filters by unread=true", () => {
    const n1 = createTestNotification({ jobId: "job-1" });
    createTestNotification({ jobId: "job-2" });
    markAsRead(n1.id, mockBroadcast);

    const result = getNotifications({ unread: true });
    expect(result.notifications).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.unreadCount).toBe(1);
  });

  it("supports pagination with limit and offset", () => {
    for (let i = 0; i < 5; i++) {
      createTestNotification({ jobId: `job-${i}` });
    }

    const page1 = getNotifications({ limit: 2, offset: 0 });
    expect(page1.notifications).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = getNotifications({ limit: 2, offset: 2 });
    expect(page2.notifications).toHaveLength(2);

    const page3 = getNotifications({ limit: 2, offset: 4 });
    expect(page3.notifications).toHaveLength(1);
  });

  it("returns unreadCount regardless of filter", () => {
    const n1 = createTestNotification({ jobId: "job-1" });
    createTestNotification({ jobId: "job-2" });
    createTestNotification({ jobId: "job-3" });
    markAsRead(n1.id, mockBroadcast);

    const all = getNotifications();
    expect(all.unreadCount).toBe(2);

    const unreadOnly = getNotifications({ unread: true });
    expect(unreadOnly.unreadCount).toBe(2);
  });
});

describe("deleteNotification", () => {
  it("deletes an existing notification and returns true", () => {
    const notification = createTestNotification();
    const deleted = deleteNotification(notification.id);

    expect(deleted).toBe(true);
    expect(getNotifications().total).toBe(0);
  });

  it("returns false for non-existent notification", () => {
    const deleted = deleteNotification("non-existent-id");
    expect(deleted).toBe(false);
  });
});

describe("notificationExists", () => {
  it("returns true for existing notification", () => {
    const notification = createTestNotification();
    expect(notificationExists(notification.id)).toBe(true);
  });

  it("returns false for non-existent notification", () => {
    expect(notificationExists("non-existent")).toBe(false);
  });
});

// ============================================================
// Read/Unread operations (Task 2.3)
// ============================================================

describe("markAsRead", () => {
  it("marks an unread notification as read", () => {
    const notification = createTestNotification();
    const result = markAsRead(notification.id, mockBroadcast);

    expect(result).toBe(true);
    const updated = getNotifications();
    expect(updated.notifications[0]!.read).toBe(true);
  });

  it("broadcasts notification-updated SSE event", () => {
    const notification = createTestNotification();
    mockBroadcast.mockClear();
    markAsRead(notification.id, mockBroadcast);

    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "notification-updated",
      id: notification.id,
      read: true,
    });
  });

  it("returns true for already-read notification (exists but no change)", () => {
    const notification = createTestNotification();
    markAsRead(notification.id, mockBroadcast);
    mockBroadcast.mockClear();

    const result = markAsRead(notification.id, mockBroadcast);
    expect(result).toBe(true);
    // Should NOT broadcast again
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("returns false for non-existent notification", () => {
    const result = markAsRead("non-existent-id", mockBroadcast);
    expect(result).toBe(false);
  });
});

describe("markAllAsRead", () => {
  it("marks all unread notifications as read", () => {
    createTestNotification({ jobId: "job-1" });
    createTestNotification({ jobId: "job-2" });
    createTestNotification({ jobId: "job-3" });

    const count = markAllAsRead(mockBroadcast);
    expect(count).toBe(3);
    expect(getUnreadCount()).toBe(0);
  });

  it("broadcasts notification-updated with id='all'", () => {
    createTestNotification({ jobId: "job-1" });
    mockBroadcast.mockClear();

    markAllAsRead(mockBroadcast);
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "notification-updated",
      id: "all",
      read: true,
    });
  });

  it("returns 0 when no unread notifications exist", () => {
    const count = markAllAsRead(mockBroadcast);
    expect(count).toBe(0);
    // Should NOT broadcast when nothing changed
    expect(mockBroadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "notification-updated" }),
    );
  });
});

describe("getUnreadCount", () => {
  it("returns count of unread notifications", () => {
    createTestNotification({ jobId: "job-1" });
    createTestNotification({ jobId: "job-2" });
    createTestNotification({ jobId: "job-3" });

    expect(getUnreadCount()).toBe(3);

    markAsRead(getNotifications().notifications[0]!.id, mockBroadcast);
    expect(getUnreadCount()).toBe(2);
  });

  it("returns 0 when no notifications exist", () => {
    expect(getUnreadCount()).toBe(0);
  });
});

// ============================================================
// Job record operations (Task 2.4)
// ============================================================

describe("cleanupOldNotifications", () => {
  it("deletes notifications older than retention period", () => {
    // Create a notification (it'll have current timestamp)
    createTestNotification();
    // Cleanup with 0 days retention should delete everything
    const cleaned = cleanupOldNotifications(0);
    expect(cleaned).toBe(1);
    expect(getNotifications().total).toBe(0);
  });

  it("preserves recent notifications", () => {
    createTestNotification();
    // Default 7 day retention — recent notification should survive
    const cleaned = cleanupOldNotifications(7);
    expect(cleaned).toBe(0);
    expect(getNotifications().total).toBe(1);
  });
});

// ============================================================
// Bulk delete by session / project
// ============================================================

describe("deleteNotificationsForSession", () => {
  it("removes only notifications matching the project+session pair", () => {
    createTestNotification({
      projectName: "proj-a",
      sessionName: "keep",
      jobId: "job-keep",
    });
    createTestNotification({
      projectName: "proj-a",
      sessionName: "doomed",
      jobId: "job-doomed-1",
    });
    createTestNotification({
      projectName: "proj-a",
      sessionName: "doomed",
      jobId: "job-doomed-2",
    });
    createTestNotification({
      projectName: "proj-b",
      sessionName: "doomed",
      jobId: "job-other-project",
    });

    const deleted = deleteNotificationsForSession("proj-a", "doomed");

    expect(deleted).toBe(2);
    const remaining = getNotifications()
      .notifications.filter((n) => n.source === "job")
      .map((n) => n.jobId);
    expect(remaining.sort()).toEqual(["job-keep", "job-other-project"]);
  });

  it("returns 0 when no rows match", () => {
    createTestNotification({ projectName: "p", sessionName: "s" });
    expect(deleteNotificationsForSession("p", "missing")).toBe(0);
    expect(getNotifications().total).toBe(1);
  });
});

describe("deleteNotificationsForProject", () => {
  it("removes every notification for the given project across all sessions", () => {
    createTestNotification({
      projectName: "proj-a",
      sessionName: "s1",
      jobId: "a1",
    });
    createTestNotification({
      projectName: "proj-a",
      sessionName: "s2",
      jobId: "a2",
    });
    createTestNotification({
      projectName: "proj-b",
      sessionName: "s1",
      jobId: "b1",
    });

    const deleted = deleteNotificationsForProject("proj-a");

    expect(deleted).toBe(2);
    const remaining = getNotifications()
      .notifications.filter((n) => n.source === "job")
      .map((n) => n.jobId);
    expect(remaining).toEqual(["b1"]);
  });
});

// ============================================================
// Zod boundary validation (consolidated state-db)
// ============================================================

describe("schema validation at the persistence boundary", () => {
  it("surfaces a PersistenceError when a notification row has an invalid type/kind", () => {
    const db = getSharedStateDb();
    db.prepare(
      `INSERT INTO notifications (id, type, title, message, project_name, session_name, branch_name, job_id, job_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "not-a-real-notification-type",
      "Bogus",
      "Row inserted with an invalid `type` enum value to exercise safeParse",
      "p",
      "s",
      "csm/s",
      "job-x",
      "merge",
    );

    let caught: unknown;
    try {
      getNotifications();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    const failure = (caught as PersistenceError).failure;
    expect(failure.kind).toBe("validation");
    if (failure.kind === "validation") {
      expect(failure.entity).toBe("notification");
    }
  });
});

describe("notification table migration", () => {
  it("preserves legacy job rows while allowing project-conversation rows without session columns", () => {
    _resetForTesting();
    const dbPath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "cc-notification-migration-")),
      "command-center.db",
    );
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE notifications (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL,
        title          TEXT NOT NULL,
        message        TEXT NOT NULL,
        read           INTEGER NOT NULL DEFAULT 0,
        project_name   TEXT NOT NULL,
        session_name   TEXT NOT NULL,
        branch_name    TEXT NOT NULL,
        job_id         TEXT NOT NULL,
        job_type       TEXT NOT NULL,
        merge_hash     TEXT,
        commit_hash    TEXT,
        conflict_count INTEGER,
        conflict_files TEXT,
        target_branch  TEXT,
        error_message  TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO notifications (
        id, type, title, message, project_name, session_name, branch_name, job_id, job_type, created_at
      ) VALUES (
        'legacy-job-notification', 'merge-completed', 'Merge completed', 'ok', 'my-project', 'feature', 'csm/feature', 'job-1', 'merge', '2026-06-07 12:00:00'
      );
    `);
    legacyDb.close();

    const migratedDb = createSharedStateDbAtPath(dbPath);
    _installTestDb(migratedDb);

    const projectNotification = createProjectConversationNotification(
      {
        type: "project-conversation-ready",
        title: "Agent finished",
        message: "Project conversation is ready",
        projectName: "my-project",
        conversationId: "conversation-1",
        conversationName: null,
        status: "awaiting",
        dedupeKey: "my-project:conversation-1:ready:turn-1",
      },
      mockBroadcast,
    );

    const result = getNotifications();
    expect(result.total).toBe(2);
    expect(result.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "legacy-job-notification",
          source: "job",
          sessionName: "feature",
          jobId: "job-1",
        }),
        expect.objectContaining({
          id: projectNotification.id,
          source: "project-conversation",
          conversationId: "conversation-1",
        }),
      ]),
    );
  });
});

describe("schema validation on the write path", () => {
  it("rejects createNotification when input fails notificationSchema BEFORE the INSERT commits", () => {
    const db = getSharedStateDb();

    let caught: unknown;
    try {
      createNotification(
        {
          // Type assertion bypasses the compile-time guard so we can simulate
          // a runtime caller that hands us an invalid enum value.
          type: "not-a-real-notification-type" as unknown as "merge-completed",
          title: "x",
          message: "x",
          projectName: "p",
          sessionName: "s",
          branchName: "csm/s",
          jobId: "job-write-bad",
          jobType: "merge",
        },
        mockBroadcast,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    const failure = (caught as PersistenceError).failure;
    expect(failure.kind).toBe("validation");
    if (failure.kind === "validation") {
      expect(failure.entity).toBe("notification");
    }

    const row = db
      .prepare("SELECT COUNT(*) AS count FROM notifications")
      .get() as { count: number };
    expect(row.count).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

// ============================================================
// Boot-order integration: schema init → CRUD → recovery
// ============================================================

describe("boot-order integration", () => {
  it("initialises schema, then performs createNotification + recoverStaleJobs without errors", () => {
    // Reset the singleton so this test owns the full boot path.
    _resetForTesting();
    const db = createSharedStateDb({ inMemory: true });
    _installTestDb(db);

    // Sanity: tables exist after schema init
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notifications','job_records')",
      )
      .all() as { name: string }[];
    const tableNames = new Set(tables.map((r) => r.name));
    expect(tableNames.has("notifications")).toBe(true);
    expect(tableNames.has("job_records")).toBe(true);

    const notification = createNotification(
      {
        type: "merge-completed",
        title: "Merge completed",
        message: "ok",
        projectName: "p",
        sessionName: "s",
        branchName: "csm/s",
        jobId: "job-boot",
        jobType: "merge",
      },
      mockBroadcast,
    );
    expect(notification.id).toBeDefined();

    const recovered = recoverStaleJobs();
    expect(recovered).toBe(0);

    const result = getNotifications();
    expect(result.total).toBe(1);
    expect(result.notifications[0]!.id).toBe(notification.id);
  });
});
