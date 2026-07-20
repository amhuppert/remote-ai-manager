import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SSEEvent } from "@/lib/api/sse-events";
import {
  setPublicationBroadcastForTesting,
  _resetPublicationForTesting,
} from "@/lib/events/publication";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting,
} from "@/lib/state-store/state-db";
import { createNotificationsRepo, type NotificationsRepo } from "./repo";
import { createNotificationsService } from "./service";
import type { Notification } from "./schemas";

let repo: NotificationsRepo;
const published: SSEEvent[] = [];
const pushed: Notification[] = [];

function createService() {
  return createNotificationsService({
    repo: () => repo,
    publish: (event) => {
      published.push(event);
      return { delivered: true };
    },
    dispatchPush: (notification) => {
      pushed.push(notification);
    },
  });
}

const jobInput = {
  type: "merge-completed" as const,
  title: "Merge completed",
  message: "Branch csm/feature merged successfully",
  projectName: "my-project",
  sessionName: "feature",
  branchName: "csm/feature",
  jobId: "job-1",
  jobType: "merge" as const,
};

const projectConversationInput = {
  type: "project-conversation-ready" as const,
  title: "Agent finished",
  message: "Project conversation is ready",
  projectName: "my-project",
  conversationId: "conversation-1",
  conversationName: "Architecture pass",
  status: "awaiting" as const,
  dedupeKey: "my-project:conversation-1:ready:turn-1",
};

const specInput = {
  type: "spec-approval-requested" as const,
  title: "Spec approval required",
  message: "Native SDD needs design approval for D2.",
  projectName: "my-project",
  sessionName: "native-sdd",
  specId: "spec-1",
  specSlug: "native-sdd",
  specName: "Native SDD",
  gate: "design" as const,
  gateRequestId: "request-1",
  deepLinkId: "D2",
  dedupeKey: "spec:spec-1:request-1:requested",
};

beforeEach(() => {
  const db = _createTestDb({ inMemory: true });
  _installTestDb(db);
  repo = createNotificationsRepo(db);
  published.length = 0;
  pushed.length = 0;
});

afterEach(() => {
  _resetForTesting();
  _resetPublicationForTesting();
});

describe("notifications repo purity", () => {
  it("repo writes publish nothing to the SSE wire and dispatch no push", () => {
    const wire = vi.fn();
    setPublicationBroadcastForTesting(wire);

    repo.createJobNotification(jobInput);
    repo.createProjectConversationNotification(projectConversationInput);
    repo.markAsRead(repo.getNotifications().notifications[0]!.id);
    repo.markAllAsRead();

    expect(wire).not.toHaveBeenCalled();
  });
});

describe("createJobNotification", () => {
  it("persists the notification, publishes notification-created, and dispatches push", () => {
    const service = createService();
    const notification = service.createJobNotification(jobInput);

    expect(repo.getNotifications().notifications).toEqual([notification]);
    expect(published).toEqual([{ type: "notification-created", notification }]);
    expect(pushed).toEqual([notification]);
  });
});

describe("createProjectConversationNotification", () => {
  it("publishes and pushes for a newly created notification", () => {
    const service = createService();
    const notification = service.createProjectConversationNotification(
      projectConversationInput,
    );

    expect(published).toEqual([{ type: "notification-created", notification }]);
    expect(pushed).toEqual([notification]);
  });

  it("neither publishes nor pushes for a deduped duplicate", () => {
    const service = createService();
    const first = service.createProjectConversationNotification(
      projectConversationInput,
    );
    published.length = 0;
    pushed.length = 0;

    const duplicate = service.createProjectConversationNotification({
      ...projectConversationInput,
      title: "Still ready",
      message: "Duplicate transition",
    });

    expect(duplicate).toEqual(first);
    expect(repo.getNotifications().total).toBe(1);
    expect(published).toEqual([]);
    expect(pushed).toEqual([]);
  });
});

describe("createSpecNotification", () => {
  it("persists a row, publishes it, and delegates push gating to the configured trigger", () => {
    const service = createService();
    const notification = service.createSpecNotification(specInput);

    expect(repo.getNotifications().notifications).toEqual([notification]);
    expect(published).toEqual([{ type: "notification-created", notification }]);
    expect(pushed).toEqual([notification]);
  });

  it("dedupes a repeated spec transition without publishing or pushing twice", () => {
    const service = createService();
    const first = service.createSpecNotification(specInput);
    published.length = 0;
    pushed.length = 0;

    const duplicate = service.createSpecNotification({
      ...specInput,
      message: "Duplicate request event",
    });

    expect(duplicate).toEqual(first);
    expect(repo.getNotifications().total).toBe(1);
    expect(published).toEqual([]);
    expect(pushed).toEqual([]);
  });
});

describe("markAsRead", () => {
  it("publishes notification-updated when a row transitions unread to read", () => {
    const service = createService();
    const notification = service.createJobNotification(jobInput);
    published.length = 0;

    const result = service.markAsRead(notification.id);

    expect(result).toEqual({ updated: true, exists: true });
    expect(published).toEqual([
      { type: "notification-updated", id: notification.id, read: true },
    ]);
  });

  it("does not publish for an already-read row", () => {
    const service = createService();
    const notification = service.createJobNotification(jobInput);
    service.markAsRead(notification.id);
    published.length = 0;

    const result = service.markAsRead(notification.id);

    expect(result).toEqual({ updated: false, exists: true });
    expect(published).toEqual([]);
  });

  it("does not publish for a missing row", () => {
    const service = createService();

    const result = service.markAsRead("missing-id");

    expect(result).toEqual({ updated: false, exists: false });
    expect(published).toEqual([]);
  });
});

describe("markAllAsRead", () => {
  it("publishes a single notification-updated with id 'all' when rows changed", () => {
    const service = createService();
    service.createJobNotification(jobInput);
    service.createJobNotification({ ...jobInput, jobId: "job-2" });
    published.length = 0;

    const count = service.markAllAsRead();

    expect(count).toBe(2);
    expect(published).toEqual([
      { type: "notification-updated", id: "all", read: true },
    ]);
  });

  it("does not publish when nothing was unread", () => {
    const service = createService();

    expect(service.markAllAsRead()).toBe(0);
    expect(published).toEqual([]);
  });
});

describe("side-effect-free passthroughs", () => {
  it("reads and deletes never publish or push", () => {
    const service = createService();
    const notification = service.createJobNotification(jobInput);
    published.length = 0;
    pushed.length = 0;

    expect(service.getNotifications().total).toBe(1);
    expect(service.getUnreadCount()).toBe(1);
    expect(service.notificationExists(notification.id)).toBe(true);
    expect(service.deleteNotification(notification.id)).toBe(true);
    expect(service.deleteAllNotifications()).toBe(0);
    expect(service.deleteNotificationsForSession("my-project", "feature")).toBe(
      0,
    );
    expect(service.deleteNotificationsForProject("my-project")).toBe(0);
    expect(service.cleanupOldNotifications(0)).toBe(0);

    expect(published).toEqual([]);
    expect(pushed).toEqual([]);
  });
});
