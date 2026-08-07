import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { SseEventTarget } from "@/lib/api/sse";
import type {
  ActiveConversation,
  ActiveConversationsResponse,
} from "@/lib/active-conversations/schemas";
import { conversationKeys } from "./query-keys";
import { registerConversationSseReactions } from "./sse-reactions";
import {
  conversationRenamedEventSchema,
  type ConversationRenamedEvent,
  type ConversationState,
} from "./schemas";
import { makeConversationState } from "./testing/conversation-state-fixture";

function makeActiveRow(
  id: string,
  name: string | null = null,
): ActiveConversation {
  return {
    scope: "session",
    id,
    name,
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

/** A schema-valid session-list row: parsed, not asserted, so the fixture can
 * never drift from `ConversationState`. */
function makeListRow(
  id: string,
  name: string | null = null,
): ConversationState {
  return makeConversationState({
    id,
    name,
    promptCount: 1,
    createdAt: "2026-07-28T09:00:00.000Z",
    lastActivityAt: "2026-07-28T09:00:00.000Z",
  });
}

/**
 * A minimal EventSource stand-in implementing the `SseEventTarget` port
 * directly. The test dispatches the exact frame the wire would carry
 * (transport envelope included) so the schema-strip path is exercised too.
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
    dispatch(event: ConversationRenamedEvent): void {
      const frame = new MessageEvent(event.type, {
        data: JSON.stringify({ ...event, _sentAt: 1 }),
      });
      for (const listener of listeners.get(event.type) ?? []) listener(frame);
    },
  };
}

function registerAgainst(queryClient: QueryClient, target: SseEventTarget) {
  registerConversationSseReactions(target, {
    queryClient,
    enqueueInputToast: vi.fn(),
    enqueuePromptErrorToast: vi.fn(),
    showBrowserNotification: vi.fn(),
    settleOptimisticQueueEntry: vi.fn(),
  });
}

function renamedEvent(
  name: string | null,
  conversationId: string,
): ConversationRenamedEvent {
  return conversationRenamedEventSchema.parse({
    type: "conversation-renamed",
    scope: "session",
    projectName: "demo",
    sessionName: "feature-x",
    conversationId,
    name,
  });
}

function createHarness(rowIds: Array<{ id: string; name?: string | null }>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData<ActiveConversationsResponse>(
    conversationKeys.active(),
    {
      conversations: rowIds.map((r) => makeActiveRow(r.id, r.name ?? null)),
      graphWorkflowExecutions: [],
      activeCollaborationExecutions: [],
      specExecutions: [],
    },
  );
  queryClient.setQueryData<ConversationState[]>(
    conversationKeys.list("demo", "feature-x"),
    rowIds.map((r) => makeListRow(r.id, r.name ?? null)),
  );
  const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
  const es = createEventTarget();
  registerAgainst(queryClient, es.target);
  invalidateQueries.mockClear();

  return {
    queryClient,
    invalidateQueries,
    send(name: string | null, conversationId = "conv-1") {
      es.dispatch(renamedEvent(name, conversationId));
    },
    activeRows(): ActiveConversation[] {
      return (
        queryClient.getQueryData<ActiveConversationsResponse>(
          conversationKeys.active(),
        )?.conversations ?? []
      );
    },
    listRows(): ConversationState[] {
      return (
        queryClient.getQueryData<ConversationState[]>(
          conversationKeys.list("demo", "feature-x"),
        ) ?? []
      );
    },
  };
}

describe("conversation-renamed SSE reaction (session scope)", () => {
  it("patches the matching active row's name without refetching", () => {
    const h = createHarness([{ id: "conv-1" }, { id: "conv-2" }]);

    h.send("Auth Flow Refactor");

    // The active cache feeds the sidebar rail and tab strip; an auto-generated
    // name can land after the turn's final status event, so this event is the
    // only signal that ever delivers it.
    expect(h.activeRows()[0]?.name).toBe("Auth Flow Refactor");
    expect(h.activeRows()[1]?.name).toBeNull();
    // The session list keeps its existing patch behavior.
    expect(h.listRows()[0]?.name).toBe("Auth Flow Refactor");
    expect(h.listRows()[1]?.name).toBeNull();
    expect(h.invalidateQueries).not.toHaveBeenCalled();
  });

  it("applies a cleared name to the active row", () => {
    const h = createHarness([{ id: "conv-1", name: "Old Name" }]);

    h.send(null);

    expect(h.activeRows()[0]?.name).toBeNull();
  });

  it("leaves the active cache untouched when no row matches", () => {
    const h = createHarness([{ id: "conv-1" }]);

    h.send("Auth Flow Refactor", "conv-unknown");

    expect(h.activeRows()[0]?.name).toBeNull();
  });

  it("does not seed the active cache when it has not been loaded", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const es = createEventTarget();
    registerAgainst(queryClient, es.target);

    es.dispatch(renamedEvent("Auth Flow Refactor", "conv-1"));

    expect(queryClient.getQueryData(conversationKeys.active())).toBeUndefined();
  });
});
