import { describe, expect, it, vi } from "vitest";
import {
  createProjectConversationNotificationService,
  type ProjectConversationNotificationServiceDeps,
} from "./project-conversation-service";
import type { CreateProjectConversationNotificationInput } from "./repo";
import type { ProjectConversationNotification } from "./schemas";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createRepoDeps() {
  const notifications: ProjectConversationNotification[] = [];
  const notificationsByDedupeKey = new Map<
    string,
    ProjectConversationNotification
  >();
  let nextId = 1;

  const deps: ProjectConversationNotificationServiceDeps = {
    createProjectConversationNotification(
      input: CreateProjectConversationNotificationInput,
    ) {
      const existing = notificationsByDedupeKey.get(input.dedupeKey);
      if (existing !== undefined) return existing;

      const notification: ProjectConversationNotification = {
        id: `notification-${nextId++}`,
        source: "project-conversation",
        type: input.type,
        title: input.title,
        message: input.message,
        read: false,
        projectName: input.projectName,
        conversationId: input.conversationId,
        conversationName: input.conversationName ?? null,
        status: input.status,
        createdAt: "2026-06-07 12:00:00",
        ...(input.errorMessage !== undefined
          ? { errorMessage: input.errorMessage }
          : {}),
      };

      notifications.push(notification);
      notificationsByDedupeKey.set(input.dedupeKey, notification);
      return notification;
    },
  };

  const createProjectConversationNotification = vi.spyOn(
    deps,
    "createProjectConversationNotification",
  );

  return {
    deps,
    notifications,
    createProjectConversationNotification,
  };
}

function expectNoSessionOrJobContext(
  notification: ProjectConversationNotification,
) {
  expect("sessionName" in notification).toBe(false);
  expect("branchName" in notification).toBe(false);
  expect("jobId" in notification).toBe(false);
  expect("jobType" in notification).toBe(false);
}

describe("createProjectConversationNotificationService", () => {
  it("maps awaiting status transitions to project-conversation readiness notifications", () => {
    const repo = createRepoDeps();
    const service = createProjectConversationNotificationService(repo.deps);

    const notification = service.handleProjectConversationStatus({
      projectName: "command-center",
      conversationId: "conversation-1",
      conversationName: "Architecture pass",
      status: "awaiting",
      transitionKey: "turn-42",
    });

    if (notification === null) {
      throw new Error("Expected awaiting transition to create a notification");
    }

    expect(notification).toEqual({
      id: "notification-1",
      source: "project-conversation",
      type: "project-conversation-ready",
      title: "Project conversation ready",
      message: "Architecture pass in command-center is ready.",
      read: false,
      projectName: "command-center",
      conversationId: "conversation-1",
      conversationName: "Architecture pass",
      status: "awaiting",
      createdAt: "2026-06-07 12:00:00",
    });
    expectNoSessionOrJobContext(notification);
    expect(repo.createProjectConversationNotification).toHaveBeenCalledWith({
      type: "project-conversation-ready",
      title: "Project conversation ready",
      message: "Architecture pass in command-center is ready.",
      projectName: "command-center",
      conversationId: "conversation-1",
      conversationName: "Architecture pass",
      status: "awaiting",
      dedupeKey:
        "project-conversation:command-center:conversation-1:project-conversation-ready:turn-42",
    });
  });

  it("maps waiting_for_input status transitions to input-needed notifications", () => {
    const repo = createRepoDeps();
    const service = createProjectConversationNotificationService(repo.deps);

    const notification = service.handleProjectConversationStatus({
      projectName: "command-center",
      conversationId: "conversation-2",
      conversationName: null,
      status: "waiting_for_input",
      transitionKey: "turn-43",
    });

    if (notification === null) {
      throw new Error(
        "Expected waiting_for_input transition to create a notification",
      );
    }

    expect(notification).toEqual({
      id: "notification-1",
      source: "project-conversation",
      type: "project-conversation-input-needed",
      title: "Project conversation needs input",
      message: "Conversation conversation-2 in command-center needs input.",
      read: false,
      projectName: "command-center",
      conversationId: "conversation-2",
      conversationName: null,
      status: "waiting_for_input",
      createdAt: "2026-06-07 12:00:00",
    });
    expectNoSessionOrJobContext(notification);
    expect(repo.notifications).toHaveLength(1);
    expect(repo.createProjectConversationNotification).toHaveBeenCalledWith({
      type: "project-conversation-input-needed",
      title: "Project conversation needs input",
      message: "Conversation conversation-2 in command-center needs input.",
      projectName: "command-center",
      conversationId: "conversation-2",
      conversationName: null,
      status: "waiting_for_input",
      dedupeKey:
        "project-conversation:command-center:conversation-2:project-conversation-input-needed:turn-43",
    });
  });

  it("maps project-conversation errors to failed notifications with the error message", () => {
    const repo = createRepoDeps();
    const service = createProjectConversationNotificationService(repo.deps);

    const notification = service.handleProjectConversationError({
      projectName: "command-center",
      conversationId: "conversation-3",
      conversationName: "Release checklist",
      errorMessage: "Tool call timed out",
      transitionKey: "turn-44:error",
    });

    expect(notification).toEqual({
      id: "notification-1",
      source: "project-conversation",
      type: "project-conversation-failed",
      title: "Project conversation failed",
      message:
        "Release checklist in command-center failed: Tool call timed out",
      read: false,
      projectName: "command-center",
      conversationId: "conversation-3",
      conversationName: "Release checklist",
      status: "failed",
      errorMessage: "Tool call timed out",
      createdAt: "2026-06-07 12:00:00",
    });
    expectNoSessionOrJobContext(notification);
    expect(repo.createProjectConversationNotification).toHaveBeenCalledWith({
      type: "project-conversation-failed",
      title: "Project conversation failed",
      message:
        "Release checklist in command-center failed: Tool call timed out",
      projectName: "command-center",
      conversationId: "conversation-3",
      conversationName: "Release checklist",
      status: "failed",
      errorMessage: "Tool call timed out",
      dedupeKey:
        "project-conversation:command-center:conversation-3:project-conversation-failed:turn-44%3Aerror",
    });
  });

  it("does not create notifications for non-notifiable status transitions", () => {
    const repo = createRepoDeps();
    const service = createProjectConversationNotificationService(repo.deps);

    const notification = service.handleProjectConversationStatus({
      projectName: "command-center",
      conversationId: "conversation-4",
      conversationName: "Implementation",
      status: "running",
      transitionKey: "turn-45",
    });

    expect(notification).toBeNull();
    expect(repo.createProjectConversationNotification).not.toHaveBeenCalled();
    expect(repo.notifications).toHaveLength(0);
  });

  it("uses the transition key for idempotent persistence", () => {
    const repo = createRepoDeps();
    const service = createProjectConversationNotificationService(repo.deps);

    const first = service.handleProjectConversationStatus({
      projectName: "command-center",
      conversationId: "conversation-5",
      conversationName: "Planning",
      status: "awaiting",
      transitionKey: "turn-46",
    });
    const duplicate = service.handleProjectConversationStatus({
      projectName: "command-center",
      conversationId: "conversation-5",
      conversationName: "Planning",
      status: "awaiting",
      transitionKey: "turn-46",
    });

    expect(duplicate).toBe(first);
    expect(first?.read).toBe(false);
    expect(repo.notifications).toHaveLength(1);
    expect(repo.createProjectConversationNotification).toHaveBeenCalledTimes(2);
  });
});
