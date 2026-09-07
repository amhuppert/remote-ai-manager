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
import type { ConversationContext } from "@/lib/workflows/conversation/types";
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
      _schemaVersion: 1,
      projectPath: "/repo",
      target: targetFromStoreSessionName(
        "my-project",
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        "conv-plc",
      ),

      worktreePath: "/repo",

      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:01:00Z",
      status: "awaiting",
      promptCount: 2,
      transcriptPath: "/repo/.cc/conv-plc.jsonl",
      agentBackend: "claude",
      backendRef: null,
      forkedFrom: null,
      role: null,
      activeTurn: null,
      pendingQuestion: null,
      debugMode: null,
      totals: {
        totalCostUsd: null,
        totalDurationMs: null,
        totalTurns: 4,
        contextTokens: null,
        contextWindowMax: null,
      },
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
          questions: [
            {
              question: "Continue?",
              multiSelect: false,
              options: [],
              required: true,
              allowNote: true,
            },
          ],
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
        lastResult: {
          backendRef: null,
          costUsd: null,
          durationMs: null,
          numTurns: null,
          contextTokens: null,
          contextWindow: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          contentBlocks: [],
          aborted: false,
          compacted: false,
          error: "Previous turn failed",
          continuationDisposition: "retain",
        },
        pendingQuestion: {
          questionId: "question-8",
          questions: [
            {
              question: "Continue?",
              multiSelect: false,
              options: [],
              required: true,
              allowNote: true,
            },
          ],
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
        totals: {
          totalCostUsd: null,
          totalDurationMs: null,
          totalTurns: 5,
          contextTokens: null,
          contextWindowMax: null,
        },
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
