import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
/**
 * Tests for the project-conversation status notification policy.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  notifyProjectConversationStatusFromContext,
  setProjectConversationStatusNotificationDepsForTesting,
  _resetProjectConversationStatusNotificationDepsForTesting,
} from "./status-notifications";
type ConversationContext = Parameters<
  typeof notifyProjectConversationStatusFromContext
>[0];
import type { ConversationState } from "@/lib/conversations/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type {
  ProjectConversationErrorNotificationInput,
  ProjectConversationStatusNotificationInput,
} from "@/lib/notifications/project-conversation-service";

afterEach(() => {
  _resetProjectConversationStatusNotificationDepsForTesting();
});

describe("notifyProjectConversationStatusFromContext", () => {
  function makeContext(
    overrides: Partial<ConversationContext> = {},
  ): ConversationContext {
    return {
      projectPath: "/repo",
      target: targetFromStoreSessionName(
        "my-project",
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        "conv-plc",
      ),
      status: "awaiting",
      promptCount: 2,
      pendingQuestion: null,
      totals: { totalTurns: 4 },
      lastResult: null,
      lastError: null,
      ...overrides,
    };
  }

  function installNotificationDeps() {
    const statuses: ProjectConversationStatusNotificationInput[] = [];
    const errors: ProjectConversationErrorNotificationInput[] = [];
    setProjectConversationStatusNotificationDepsForTesting({
      getProjectConversation: async () =>
        ({
          name: "Project chat",
        }) as ConversationState,
      notificationService: {
        handleProjectConversationStatus(input) {
          statuses.push(input);
          return null;
        },
        handleProjectConversationError(input) {
          errors.push(input);
          return {
            id: "notification-1",
            source: "project-conversation",
            type: "project-conversation-failed",
            title: "Project conversation failed",
            message: "failed",
            read: false,
            projectName: input.projectName,
            conversationId: input.conversationId,
            conversationName: input.conversationName ?? null,
            status: "failed",
            errorMessage: input.errorMessage,
            createdAt: "2026-01-01 00:00:00",
          };
        },
      },
    });
    return { statuses, errors };
  }

  it("creates a readiness notification for an awaiting project conversation", async () => {
    const calls = installNotificationDeps();

    await notifyProjectConversationStatusFromContext(makeContext());

    expect(calls.statuses).toEqual([
      {
        projectName: "my-project",
        conversationId: "conv-plc",
        conversationName: "Project chat",
        status: "awaiting",
        transitionKey: "my-project:conv-plc:awaiting:prompt-2:turns-4",
      },
    ]);
    expect(calls.errors).toEqual([]);
  });

  it("creates an input-needed notification for a mid-turn project question", async () => {
    const calls = installNotificationDeps();

    await notifyProjectConversationStatusFromContext(
      makeContext({
        status: "waiting_for_input",
        promptCount: 1,
        pendingQuestion: {
          questionId: "question-7",
        },
      }),
    );

    expect(calls.statuses).toEqual([
      {
        projectName: "my-project",
        conversationId: "conv-plc",
        conversationName: "Project chat",
        status: "waiting_for_input",
        transitionKey:
          "my-project:conv-plc:waiting_for_input:prompt-1:question-question-7",
      },
    ]);
    expect(calls.errors).toEqual([]);
  });

  it("does not treat a stale previous turn error as a mid-turn project question error", async () => {
    const calls = installNotificationDeps();

    await notifyProjectConversationStatusFromContext(
      makeContext({
        status: "waiting_for_input",
        promptCount: 2,
        lastResult: { error: "Previous turn failed" },
        pendingQuestion: {
          questionId: "question-8",
        },
      }),
    );

    expect(calls.statuses).toEqual([
      {
        projectName: "my-project",
        conversationId: "conv-plc",
        conversationName: "Project chat",
        status: "waiting_for_input",
        transitionKey:
          "my-project:conv-plc:waiting_for_input:prompt-2:question-question-8",
      },
    ]);
    expect(calls.errors).toEqual([]);
  });

  it("creates an error notification instead of a readiness notification when the project turn failed", async () => {
    const calls = installNotificationDeps();

    await notifyProjectConversationStatusFromContext(
      makeContext({
        status: "awaiting",
        promptCount: 3,
        totals: { totalTurns: 5 },
        lastError: "Tool call timed out",
      }),
    );

    expect(calls.errors).toEqual([
      {
        projectName: "my-project",
        conversationId: "conv-plc",
        conversationName: "Project chat",
        errorMessage: "Tool call timed out",
        transitionKey:
          "my-project:conv-plc:error:prompt-3:turns-5:Tool%20call%20timed%20out",
      },
    ]);
    expect(calls.statuses).toEqual([]);
  });

  it("does not create project-conversation notifications for session-scoped conversations", async () => {
    const calls = installNotificationDeps();

    await notifyProjectConversationStatusFromContext(
      makeContext({
        target: targetFromStoreSessionName(
          makeContext().target.projectName,
          "session-a",
          makeContext().target.conversationId,
        ),
      }),
    );

    expect(calls.statuses).toEqual([]);
    expect(calls.errors).toEqual([]);
  });
});
