import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createNotification,
  getNotifications,
  deleteNotification,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  createJobRecord,
  updateJobRecord,
  recoverStaleJobs,
  cleanupOldNotifications,
  notificationExists,
  deriveNotificationType,
  deriveNotificationTitle,
  _createTestDb,
  _installTestDb,
  _resetForTesting,
} from "./notification-db";
import {
  _createTestDb as createSharedStateDb,
  getDb as getSharedStateDb,
} from "./state-store/state-db";
import { PersistenceError } from "./errors";
import { randomUUID } from "node:crypto";

// Prevent tests from sending real push notifications to ntfy
vi.mock("./push-dispatcher");

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

describe("createJobRecord", () => {
  it("inserts a running job record", () => {
    createJobRecord({
      jobId: "job-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: new Date().toISOString(),
    });

    // No public getter for job records — tested via stale recovery
    // Verify it doesn't throw
    expect(true).toBe(true);
  });
});

describe("updateJobRecord", () => {
  it("updates a job record to terminal state", () => {
    createJobRecord({
      jobId: "job-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: new Date().toISOString(),
    });

    updateJobRecord("job-1", {
      status: "completed",
      mergeHash: "abc123",
    });

    // Verify by checking recovery doesn't find it
    const recovered = recoverStaleJobs();
    expect(recovered).toBe(0);
  });
});

// ============================================================
// Startup recovery & cleanup (Task 2.5)
// ============================================================

describe("recoverStaleJobs", () => {
  it("marks running jobs as failed and creates failure notifications", () => {
    createJobRecord({
      jobId: "stale-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: new Date().toISOString(),
    });

    createJobRecord({
      jobId: "stale-2",
      jobType: "commit",
      status: "running",
      projectName: "my-project",
      sessionName: "another",
      branchName: "csm/another",
      startedAt: new Date().toISOString(),
    });

    mockBroadcast.mockClear();
    const recovered = recoverStaleJobs();

    expect(recovered).toBe(2);
    // Should create failure notifications
    const result = getNotifications();
    expect(result.notifications).toHaveLength(2);
    expect(result.notifications.every((n) => n.errorMessage)).toBe(true);
  });

  it("does not affect completed jobs", () => {
    createJobRecord({
      jobId: "completed-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: new Date().toISOString(),
    });
    updateJobRecord("completed-1", { status: "completed", mergeHash: "abc" });

    const recovered = recoverStaleJobs();
    expect(recovered).toBe(0);
  });

  it("returns 0 when no stale jobs exist", () => {
    const recovered = recoverStaleJobs();
    expect(recovered).toBe(0);
  });
});

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
// Derivation helpers
// ============================================================

describe("deriveNotificationType", () => {
  it("maps merge + completed to merge-completed", () => {
    expect(deriveNotificationType("merge", "completed")).toBe(
      "merge-completed",
    );
  });

  it("maps merge + conflicts to merge-conflicts", () => {
    expect(deriveNotificationType("merge", "conflicts")).toBe(
      "merge-conflicts",
    );
  });

  it("maps merge + failed to merge-failed", () => {
    expect(deriveNotificationType("merge", "failed")).toBe("merge-failed");
  });

  it("maps commit + completed to commit-completed", () => {
    expect(deriveNotificationType("commit", "completed")).toBe(
      "commit-completed",
    );
  });

  it("maps commit + failed to commit-failed", () => {
    expect(deriveNotificationType("commit", "failed")).toBe("commit-failed");
  });

  it("maps resolve-conflicts + completed to resolve-completed", () => {
    expect(deriveNotificationType("resolve-conflicts", "completed")).toBe(
      "resolve-completed",
    );
  });

  it("maps resolve-conflicts + failed to resolve-failed", () => {
    expect(deriveNotificationType("resolve-conflicts", "failed")).toBe(
      "resolve-failed",
    );
  });
});

describe("deriveNotificationTitle", () => {
  it("returns human-readable titles for all types", () => {
    expect(deriveNotificationTitle("merge-completed")).toBe("Merge completed");
    expect(deriveNotificationTitle("merge-failed")).toBe("Merge failed");
    expect(deriveNotificationTitle("merge-conflicts")).toBe("Merge conflicts");
    expect(deriveNotificationTitle("commit-completed")).toBe(
      "Commit completed",
    );
    expect(deriveNotificationTitle("commit-failed")).toBe("Commit failed");
    expect(deriveNotificationTitle("resolve-completed")).toBe(
      "Conflicts resolved",
    );
    expect(deriveNotificationTitle("resolve-failed")).toBe(
      "Conflict resolution failed",
    );
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

  it("surfaces a PersistenceError when a stale job_record row has an invalid jobType", () => {
    const db = getSharedStateDb();
    // Row IS in the 'running' set so recoverStaleJobs reads it; the corrupt
    // job_type column trips backgroundJobSchema.safeParse.
    db.prepare(
      `INSERT INTO job_records (job_id, job_type, status, project_name, session_name, branch_name, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "job-stale-bad",
      "not-a-job-type",
      "running",
      "p",
      "s",
      "csm/s",
      new Date().toISOString(),
    );

    let caught: unknown;
    try {
      recoverStaleJobs();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    const failure = (caught as PersistenceError).failure;
    expect(failure.kind).toBe("validation");
    if (failure.kind === "validation") {
      expect(failure.entity).toBe("job_record");
    }
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

  it("rejects createJobRecord when input fails backgroundJobSchema BEFORE the INSERT commits", () => {
    const db = getSharedStateDb();

    let caught: unknown;
    try {
      createJobRecord({
        jobId: "job-bad-create",
        jobType: "not-a-job-type" as unknown as "merge",
        status: "running",
        projectName: "p",
        sessionName: "s",
        branchName: "csm/s",
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    const failure = (caught as PersistenceError).failure;
    expect(failure.kind).toBe("validation");
    if (failure.kind === "validation") {
      expect(failure.entity).toBe("job_record");
    }

    const row = db
      .prepare("SELECT COUNT(*) AS count FROM job_records WHERE job_id = ?")
      .get("job-bad-create") as { count: number };
    expect(row.count).toBe(0);
  });

  it("rejects updateJobRecord when input fails the update schema BEFORE the UPDATE commits", () => {
    const db = getSharedStateDb();
    createJobRecord({
      jobId: "job-update-target",
      jobType: "merge",
      status: "running",
      projectName: "p",
      sessionName: "s",
      branchName: "csm/s",
      startedAt: new Date().toISOString(),
    });

    let caught: unknown;
    try {
      updateJobRecord("job-update-target", {
        status: "not-a-status" as unknown as "completed",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    const failure = (caught as PersistenceError).failure;
    expect(failure.kind).toBe("validation");
    if (failure.kind === "validation") {
      expect(failure.entity).toBe("job_record");
      expect(failure.identifier).toBe("job-update-target");
    }

    const row = db
      .prepare("SELECT status FROM job_records WHERE job_id = ?")
      .get("job-update-target") as { status: string };
    expect(row.status).toBe("running");
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
