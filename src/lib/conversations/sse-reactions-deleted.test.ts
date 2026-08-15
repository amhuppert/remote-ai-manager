import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type {
  ActiveConversation,
  ActiveConversationsResponse,
} from "@/lib/active-conversations/schemas";
import type { SseEventTarget } from "@/lib/api/sse";
import { conversationKeys } from "@/lib/conversations/query-keys";
import {
  conversationDeletedEventSchema,
  type ConversationDeletedEvent,
} from "@/lib/conversations/schemas";
import { registerConversationSseReactions } from "@/lib/conversations/sse-reactions";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { sessionKeys } from "@/lib/sessions/query-keys";

function activeConversation(id: string): ActiveConversation {
  return {
    scope: "session",
    id,
    name: id,
    status: "awaiting",
    lastActivityAt: "2026-08-15T00:00:00.000Z",
    projectName: "demo",
    projectPath: "/repo/demo",
    sessionName: "session-1",
    branchName: "cc/session-1",
    agentBackend: "codex",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/repo/demo/.worktrees/session-1",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    backgroundActivity: null,
  };
}

function createEventTarget() {
  const listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  const target: SseEventTarget = {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  return {
    target,
    dispatch(event: ConversationDeletedEvent): void {
      const frame = new MessageEvent(event.type, {
        data: JSON.stringify({ ...event, _sentAt: 1 }),
      });
      for (const listener of listeners.get(event.type) ?? []) listener(frame);
    },
  };
}

describe("conversation-deleted SSE reaction", () => {
  it("removes the deleted row immediately and invalidates session views", () => {
    const queryClient = new QueryClient();
    const deleted = activeConversation("deleted");
    const survivor = activeConversation("survivor");
    queryClient.setQueryData<ActiveConversationsResponse>(
      conversationKeys.active(),
      {
        conversations: [deleted, survivor],
        graphWorkflowExecutions: [],
        activeCollaborationExecutions: [],
        specExecutions: [],
      },
    );
    queryClient.setQueryData(conversationKeys.list("demo", "session-1"), [
      makeConversationState({ id: deleted.id }),
      makeConversationState({ id: survivor.id }),
    ]);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const events = createEventTarget();
    registerConversationSseReactions(events.target, {
      queryClient,
      enqueueInputToast: vi.fn(),
      enqueuePromptErrorToast: vi.fn(),
      showBrowserNotification: vi.fn(),
      settleOptimisticQueueEntry: vi.fn(),
    });
    invalidateQueries.mockClear();

    events.dispatch(
      conversationDeletedEventSchema.parse({
        type: "conversation-deleted",
        scope: "session",
        projectName: "demo",
        sessionName: "session-1",
        conversationId: deleted.id,
      }),
    );

    expect(
      queryClient
        .getQueryData<ActiveConversationsResponse>(conversationKeys.active())
        ?.conversations.map((conversation) => conversation.id),
    ).toEqual([survivor.id]);
    expect(
      queryClient
        .getQueryData<
          Array<{ id: string }>
        >(conversationKeys.list("demo", "session-1"))
        ?.map((conversation) => conversation.id),
    ).toEqual([survivor.id]);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("demo", "session-1"),
    });
  });
});
