import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { SseEventTarget } from "@/lib/api/sse";
import { conversationKeys } from "@/lib/conversations/query-keys";
import {
  conversationCreatedEventSchema,
  toPublicConversationState,
  type ConversationCreatedEvent,
  type PublicConversationState,
} from "@/lib/conversations/schemas";
import { registerConversationSseReactions } from "@/lib/conversations/sse-reactions";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { sessionKeys } from "@/lib/sessions/query-keys";
import {
  publicSessionStateSchema,
  type PublicSessionState,
} from "@/lib/sessions/schemas";

function publicConversation(id: string): PublicConversationState {
  return toPublicConversationState(
    makeConversationState({ id, status: "new" }),
  );
}

function sessionDetail(conversationIds: string[]): PublicSessionState {
  return publicSessionStateSchema.parse({
    sessionName: "session-1",
    worktreePath: "/repo/demo/.worktrees/session-1",
    branchName: "cc/session-1",
    createdAt: "2026-08-15T00:00:00.000Z",
    lastActivityAt: "2026-08-15T00:00:00.000Z",
    conversations: conversationIds.map(publicConversation),
  });
}

function createdEvent(id: string): ConversationCreatedEvent {
  return conversationCreatedEventSchema.parse({
    type: "conversation-created",
    scope: "session",
    projectName: "demo",
    sessionName: "session-1",
    conversation: publicConversation(id),
  });
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
    dispatch(event: ConversationCreatedEvent): void {
      const frame = new MessageEvent(event.type, {
        data: JSON.stringify({ ...event, _sentAt: 1 }),
      });
      for (const listener of listeners.get(event.type) ?? []) listener(frame);
    },
  };
}

function register(queryClient: QueryClient) {
  const events = createEventTarget();
  registerConversationSseReactions(events.target, {
    queryClient,
    enqueueInputToast: vi.fn(),
    enqueuePromptErrorToast: vi.fn(),
    showBrowserNotification: vi.fn(),
    settleOptimisticQueueEntry: vi.fn(),
  });
  return events;
}

function cachedConversationIds(queryClient: QueryClient): string[] | undefined {
  return queryClient
    .getQueryData<PublicSessionState>(sessionKeys.detail("demo", "session-1"))
    ?.conversations.map((conversation) => conversation.id);
}

describe("conversation-created SSE reaction", () => {
  // The workspace resolves its active conversation from the session detail,
  // so a created conversation missing there renders as "no conversation" —
  // the /collab config row and the transcript title both fall back.
  it("adds the created conversation to the cached session detail", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      sessionKeys.detail("demo", "session-1"),
      sessionDetail(["existing"]),
    );
    const events = register(queryClient);

    events.dispatch(createdEvent("created"));

    expect(cachedConversationIds(queryClient)).toEqual(["existing", "created"]);
    expect(
      queryClient
        .getQueryData<PublicSessionState>(
          sessionKeys.detail("demo", "session-1"),
        )
        ?.conversations.find((conversation) => conversation.id === "created")
        ?.agentBackend,
    ).toBe("claude");
  });

  it("upserts by id so a redelivered frame does not duplicate the conversation", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      sessionKeys.detail("demo", "session-1"),
      sessionDetail(["existing"]),
    );
    const events = register(queryClient);

    events.dispatch(createdEvent("created"));
    events.dispatch(createdEvent("created"));

    expect(cachedConversationIds(queryClient)).toEqual(["existing", "created"]);
  });

  it("does not seed a session detail entry that was never fetched", () => {
    const queryClient = new QueryClient();
    const events = register(queryClient);

    events.dispatch(createdEvent("created"));

    expect(
      queryClient.getQueryData(sessionKeys.detail("demo", "session-1")),
    ).toBeUndefined();
    expect(
      queryClient
        .getQueryData<
          Array<{ id: string }>
        >(conversationKeys.list("demo", "session-1"))
        ?.map((conversation) => conversation.id),
    ).toEqual(["created"]);
  });
});
