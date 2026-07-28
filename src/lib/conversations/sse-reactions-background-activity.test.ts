import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { SseEventTarget } from "@/lib/api/sse";
import type {
  ActiveConversation,
  ActiveConversationsResponse,
} from "@/lib/active-conversations/schemas";
import { conversationKeys } from "./query-keys";
import { registerConversationSseReactions } from "./sse-reactions";
import type { ConversationBackgroundActivity } from "./schemas";

const ACTIVITY: ConversationBackgroundActivity = {
  updatedAt: "2026-07-28T10:00:01.000Z",
  tasks: [
    {
      taskId: "task-a",
      description: "full regression suite",
      taskType: null,
      workflowName: null,
      subagentType: null,
      lastToolName: "Bash",
      totalTokens: 4200,
      toolUses: 7,
      startedAt: "2026-07-28T10:00:00.000Z",
      lastActivityAt: "2026-07-28T10:00:01.000Z",
    },
  ],
};

function makeRow(id: string): ActiveConversation {
  return {
    scope: "session",
    id,
    name: null,
    status: "awaiting",
    lastActivityAt: "2026-07-28T09:00:00.000Z",
    projectName: "demo",
    projectPath: "/repo/demo",
    sessionName: "feature-x",
    branchName: "cc/feature-x",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/repo/demo/.worktrees/feature-x",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    backgroundActivity: null,
  };
}

/**
 * A minimal EventSource stand-in: reactions register per-type listeners, and
 * the test dispatches the exact frame the wire would carry (transport envelope
 * included) so the schema-strip path is exercised too.
 */
function createEventTarget() {
  const listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  const target: SseEventTarget = {
    addEventListener(type, listener) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
  };
  return {
    target,
    dispatch(type: string, payload: unknown): void {
      const frame = {
        data: JSON.stringify({ ...(payload as object), _sentAt: 1 }),
      } as MessageEvent;
      for (const listener of listeners.get(type) ?? []) listener(frame);
    },
  };
}

function createHarness(rows: ActiveConversation[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData<ActiveConversationsResponse>(
    conversationKeys.active(),
    {
      conversations: rows,
      graphWorkflowExecutions: [],
      activeCollaborationExecutions: [],
      specExecutions: [],
    },
  );
  const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
  const es = createEventTarget();
  registerConversationSseReactions(es.target as unknown as EventSource, {
    queryClient,
    enqueueInputToast: vi.fn(),
    enqueuePromptErrorToast: vi.fn(),
    showBrowserNotification: vi.fn(),
    settleOptimisticQueueEntry: vi.fn(),
  });
  invalidateQueries.mockClear();

  return {
    queryClient,
    invalidateQueries,
    send(
      activity: ConversationBackgroundActivity | null,
      conversationId = "conv-1",
    ) {
      es.dispatch("conversation-background-activity", {
        type: "conversation-background-activity",
        scope: "session",
        projectName: "demo",
        sessionName: "feature-x",
        conversationId,
        activity,
      });
    },
    rows(): ActiveConversation[] {
      return (
        queryClient.getQueryData<ActiveConversationsResponse>(
          conversationKeys.active(),
        )?.conversations ?? []
      );
    },
  };
}

describe("conversation-background-activity SSE reaction", () => {
  it("patches the matching row's snapshot without refetching", () => {
    const h = createHarness([makeRow("conv-1"), makeRow("conv-2")]);

    h.send(ACTIVITY);

    expect(h.rows()[0]?.backgroundActivity).toEqual(ACTIVITY);
    expect(h.rows()[1]?.backgroundActivity).toBeNull();
    expect(h.invalidateQueries).not.toHaveBeenCalled();
  });

  it("clears the row when the set drains", () => {
    const h = createHarness([makeRow("conv-1")]);
    h.send(ACTIVITY);

    h.send(null);

    expect(h.rows()[0]?.backgroundActivity).toBeNull();
  });

  it("is idempotent on repeat delivery of the same snapshot", () => {
    const h = createHarness([makeRow("conv-1")]);
    h.send(ACTIVITY);
    const afterFirst = h.queryClient.getQueryData(conversationKeys.active());

    h.send(ACTIVITY);

    expect(h.queryClient.getQueryData(conversationKeys.active())).toBe(
      afterFirst,
    );
  });

  it("leaves the cache untouched when no row matches", () => {
    const h = createHarness([makeRow("conv-1")]);
    const before = h.queryClient.getQueryData(conversationKeys.active());

    h.send(ACTIVITY, "conv-unknown");

    expect(h.queryClient.getQueryData(conversationKeys.active())).toBe(before);
  });

  it("does not seed the list cache when it has not been loaded", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const es = createEventTarget();
    registerConversationSseReactions(es.target as unknown as EventSource, {
      queryClient,
      enqueueInputToast: vi.fn(),
      enqueuePromptErrorToast: vi.fn(),
      showBrowserNotification: vi.fn(),
      settleOptimisticQueueEntry: vi.fn(),
    });

    es.dispatch("conversation-background-activity", {
      type: "conversation-background-activity",
      scope: "session",
      projectName: "demo",
      sessionName: "feature-x",
      conversationId: "conv-1",
      activity: ACTIVITY,
    });

    expect(queryClient.getQueryData(conversationKeys.active())).toBeUndefined();
  });
});
