import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { SseEventTarget } from "@/lib/api/sse";
import { conversationKeys } from "./query-keys";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { registerConversationSseReactions } from "./sse-reactions";
import type { ConversationUsageUpdatedEvent } from "./schemas";
import { makeConversationState } from "./testing/conversation-state-fixture";

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
    dispatch(event: ConversationUsageUpdatedEvent): void {
      const frame = new MessageEvent(event.type, {
        data: JSON.stringify({ ...event, _sentAt: 1 }),
      });
      for (const listener of listeners.get(event.type) ?? []) listener(frame);
    },
  };
}

function register(queryClient: QueryClient, target: SseEventTarget) {
  registerConversationSseReactions(target, {
    queryClient,
    enqueueInputToast: () => {},
    enqueuePromptErrorToast: () => {},
    showBrowserNotification: () => {},
    settleOptimisticQueueEntry: () => {},
  });
}

const row = (id: string, totalCostUsd: number | null) =>
  makeConversationState({
    id,
    totalCostUsd,
    promptCount: 1,
    createdAt: "2026-09-20T09:00:00.000Z",
    lastActivityAt: "2026-09-20T09:00:00.000Z",
  });

describe("conversation-usage-updated reaction", () => {
  it("patches the session conversation row's total in place", () => {
    const queryClient = new QueryClient();
    const key = conversationKeys.list("demo", "feature-x");
    queryClient.setQueryData(key, [row("conv-1", 0.5), row("conv-2", null)]);
    const { target, dispatch } = createEventTarget();
    register(queryClient, target);

    dispatch({
      type: "conversation-usage-updated",
      scope: "session",
      projectName: "demo",
      sessionName: "feature-x",
      conversationId: "conv-1",
      totalCostUsd: 0.54,
    });

    const rows =
      queryClient.getQueryData<
        Array<{ id: string; totalCostUsd: number | null }>
      >(key);
    expect(rows?.map((r) => [r.id, r.totalCostUsd])).toEqual([
      ["conv-1", 0.54],
      ["conv-2", null],
    ]);
  });

  it("patches the project conversation list entry", () => {
    const queryClient = new QueryClient();
    const key = projectConversationKeys.list("demo");
    queryClient.setQueryData(key, [row("conv-9", 1)]);
    const { target, dispatch } = createEventTarget();
    register(queryClient, target);

    dispatch({
      type: "conversation-usage-updated",
      scope: "project",
      projectName: "demo",
      conversationId: "conv-9",
      totalCostUsd: 1.25,
    });

    const rows =
      queryClient.getQueryData<
        Array<{ id: string; totalCostUsd: number | null }>
      >(key);
    expect(rows?.[0]?.totalCostUsd).toBe(1.25);
  });
});
