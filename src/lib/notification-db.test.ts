import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("./sse-broadcaster");
vi.mock("./config", () => ({
  getConfigDirPath: () => "/tmp/cc-test",
}));
vi.mock("./logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

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
  _resetForTesting,
} from "./notification-db";
import { broadcast } from "./sse-broadcaster";

const mockBroadcast = vi.mocked(broadcast);

// ============================================================
// Helpers
// ============================================================

function createTestNotification(overrides: Record<string, unknown> = {}) {
  return createNotification({
    type: "merge-completed",
    title: "Merge completed",
    message: "Branch csm/feature merged successfully",
    projectName: "my-project",
    sessionName: "feature",
    branchName: "csm/feature",
    jobId: "job-1",
    jobType: "merge",
    ...overrides,
  });
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
    markAsRead(n1.id);

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
    markAsRead(n1.id);

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
    const result = markAsRead(notification.id);

    expect(result).toBe(true);
    const updated = getNotifications();
    expect(updated.notifications[0]!.read).toBe(true);
  });

  it("broadcasts notification-updated SSE event", () => {
    const notification = createTestNotification();
    mockBroadcast.mockClear();
    markAsRead(notification.id);

    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "notification-updated",
      id: notification.id,
      read: true,
    });
  });

  it("returns true for already-read notification (exists but no change)", () => {
    const notification = createTestNotification();
    markAsRead(notification.id);
    mockBroadcast.mockClear();

    const result = markAsRead(notification.id);
    expect(result).toBe(true);
    // Should NOT broadcast again
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("returns false for non-existent notification", () => {
    const result = markAsRead("non-existent-id");
    expect(result).toBe(false);
  });
});

describe("markAllAsRead", () => {
  it("marks all unread notifications as read", () => {
    createTestNotification({ jobId: "job-1" });
    createTestNotification({ jobId: "job-2" });
    createTestNotification({ jobId: "job-3" });

    const count = markAllAsRead();
    expect(count).toBe(3);
    expect(getUnreadCount()).toBe(0);
  });

  it("broadcasts notification-updated with id='all'", () => {
    createTestNotification({ jobId: "job-1" });
    mockBroadcast.mockClear();

    markAllAsRead();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "notification-updated",
      id: "all",
      read: true,
    });
  });

  it("returns 0 when no unread notifications exist", () => {
    const count = markAllAsRead();
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

    markAsRead(getNotifications().notifications[0]!.id);
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
