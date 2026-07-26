// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import {
  useDisplayMessages,
  buildDisplayProjection,
  type OptimisticQueueProjectionEntry,
} from "./use-display-messages";
import {
  selectInFlightFor,
  useSessionDetailStore,
} from "@/stores/session-detail.store";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";

function msg(role: "user" | "assistant", text: string): TranscriptMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: null,
  };
}

function pending(
  id: string,
  text: string,
  status: PendingQueuedMessage["status"] = "pending",
): PendingQueuedMessage {
  return {
    id,
    content: [{ type: "text", text }],
    status,
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deliveryStartedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
    deliveryAttemptId: null,
    attemptCount: 0,
    error: null,
    metadata: null,
  };
}

function optimistic(
  tempId: string,
  text: string,
  queueId: string | null,
  status: OptimisticQueueProjectionEntry["status"] = queueId
    ? "accepted"
    : "pending",
): OptimisticQueueProjectionEntry {
  return {
    tempId,
    queueId,
    content: [{ type: "text", text }],
    status,
  };
}

const A = "conv-a";
const B = "conv-b";

function optimisticMessagesFor(conversationId: string) {
  return selectInFlightFor(useSessionDetailStore.getState(), conversationId)
    .optimisticMessages;
}

describe("useDisplayMessages", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
  });

  it("returns the input messages unchanged when optimisticMessages is empty", () => {
    const messages: TranscriptMessage[] = [
      msg("user", "hello"),
      msg("assistant", "hi"),
    ];
    const { result } = renderHook(() => useDisplayMessages(A, messages));
    expect(result.current).toBe(messages);
  });

  it("splices server messages at messageCountBeforeSubmit and appends optimistic", () => {
    const serverMessages: TranscriptMessage[] = [
      msg("user", "first user"),
      msg("assistant", "first reply"),
      msg("user", "stale optimistic-echo"),
      msg("assistant", "stale optimistic-echo"),
    ];
    // Simulate that the optimistic submit happened after 2 messages
    useSessionDetailStore
      .getState()
      .submitPrompt(A, [{ type: "text", text: "second user" }], 2);

    const { result } = renderHook(() => useDisplayMessages(A, serverMessages));

    expect(result.current).toHaveLength(3);
    expect(result.current[0]).toBe(serverMessages[0]);
    expect(result.current[1]).toBe(serverMessages[1]);
    expect(result.current[2]?.role).toBe("user");
    expect(result.current[2]?.content).toEqual([
      { type: "text", text: "second user" },
    ]);
  });

  it("when messageCountBeforeSubmit=0, returns only optimistic messages", () => {
    useSessionDetailStore
      .getState()
      .submitPrompt(A, [{ type: "text", text: "kickoff" }], 0);

    const { result } = renderHook(() => useDisplayMessages(A, []));
    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.content).toEqual([
      { type: "text", text: "kickoff" },
    ]);
  });

  it("does not merge another conversation's optimistic state (a non-active split-screen pane)", () => {
    // In-flight state is keyed per conversation: a pane rendering B must show
    // only B's server transcript while A's submit is in flight.
    useSessionDetailStore
      .getState()
      .submitPrompt(A, [{ type: "text", text: "to active convo" }], 1);

    const serverMessages: TranscriptMessage[] = [
      msg("user", "previous"),
      msg("assistant", "reply"),
    ];
    const { result } = renderHook(() => useDisplayMessages(B, serverMessages));

    expect(result.current).toBe(serverMessages);
  });

  it("does not clear another conversation's optimistic state from a different pane", () => {
    // A pane whose own transcript has more rows than another conversation's
    // submit point must NOT clear that conversation's optimistic message —
    // otherwise the sending pane's pending message flickers away before its
    // real row lands.
    useSessionDetailStore
      .getState()
      .submitPrompt(A, [{ type: "text", text: "the prompt" }], 1);
    useSessionDetailStore.getState().completePrompt(A);

    const otherPaneMessages: TranscriptMessage[] = [
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      msg("assistant", "d"),
    ];
    renderHook(() => useDisplayMessages(B, otherPaneMessages));

    expect(optimisticMessagesFor(A)).toHaveLength(1);
  });

  it("reconciles by clearing optimistic when streaming finished and server caught up", () => {
    // Set up an in-flight submit at count=1
    useSessionDetailStore
      .getState()
      .submitPrompt(A, [{ type: "text", text: "the prompt" }], 1);
    // Stream completes (sending=false)
    useSessionDetailStore.getState().completePrompt(A);

    const serverMessages: TranscriptMessage[] = [
      msg("user", "previous"),
      msg("user", "the prompt"),
      msg("assistant", "reply"),
    ];

    // First render: still has optimistic messages — combined view returns
    // server.slice(0, 1) + optimistic = 1 + 1 = 2 items
    const { result, rerender } = renderHook(
      ({ messages }: { messages: TranscriptMessage[] }) =>
        useDisplayMessages(A, messages),
      { initialProps: { messages: serverMessages } },
    );

    // After effect runs, reconcileMessages clears optimistic. A subsequent
    // render with the same server messages should pass them through directly.
    rerender({ messages: serverMessages });
    expect(result.current).toBe(serverMessages);
    expect(optimisticMessagesFor(A)).toHaveLength(0);
  });

  it("shows a settled queued message by its transcript row only (R6.1/R6.3)", () => {
    const store = useSessionDetailStore.getState();
    // The enqueue-to-delivery lifecycle, driven through the production store
    // actions: the user's follow-up is shown pending, adopts the server queue
    // id, and is delivered.
    store.addOptimisticQueueEntry(A, "temp-1", [
      { type: "text", text: "queued A" },
    ]);
    store.acceptOptimisticQueueEntry(A, "temp-1", "q-1");

    const running: TranscriptMessage[] = [msg("assistant", "working")];
    const { result, rerender } = renderHook(
      ({ messages }: { messages: TranscriptMessage[] }) =>
        useDisplayMessages(A, messages),
      { initialProps: { messages: running } },
    );
    expect(result.current.filter((m) => m.queued)).toHaveLength(1);

    // Delivery: the durable row leaves the active queue and the message becomes
    // a real transcript row. The optimistic stand-in has nothing left to show —
    // rendering it too would duplicate the delivered message.
    store.settleOptimisticQueueEntry(A, "q-1");
    const delivered: TranscriptMessage[] = [
      msg("assistant", "working"),
      msg("user", "queued A"),
    ];
    rerender({ messages: delivered });

    expect(result.current).toBe(delivered);
    expect(result.current.filter((m) => m.queued)).toHaveLength(0);
  });
});

describe("buildDisplayProjection", () => {
  it("shows two pending entries once each in enqueue order after the transcript", () => {
    const messages = [msg("user", "first"), msg("assistant", "working")];
    const result = buildDisplayProjection({
      messages,
      optimisticMessages: [],
      messageCountBeforeSubmit: 0,
      sending: false,
      pendingQueue: [pending("a", "queued A"), pending("b", "queued B")],
      optimisticQueue: [],
    });

    expect(result).toHaveLength(4);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    expect(result[2]?.content).toEqual([{ type: "text", text: "queued A" }]);
    expect(result[2]?.queued).toEqual({
      id: "a",
      status: "pending",
      metadata: null,
    });
    expect(result[3]?.content).toEqual([{ type: "text", text: "queued B" }]);
    expect(result[3]?.queued).toEqual({
      id: "b",
      status: "pending",
      metadata: null,
    });
  });

  it("carries the durable row's provenance metadata so the renderer can key structured cards off it", () => {
    const answerRow: PendingQueuedMessage = {
      ...pending("a", "<cc-question-answers …>"),
      metadata: { kind: "question_answers", questionBatchId: "q_1" },
    };
    const result = buildDisplayProjection({
      messages: [],
      optimisticMessages: [],
      messageCountBeforeSubmit: 0,
      sending: false,
      pendingQueue: [answerRow],
      optimisticQueue: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.queued?.metadata).toEqual({
      kind: "question_answers",
      questionBatchId: "q_1",
    });
  });

  it("shows a delivered queued entry by its transcript row only, with no duplicate", () => {
    // The delivered queue entry's transcript user row is already present.
    const messages = [
      msg("user", "first"),
      msg("assistant", "reply"),
      msg("user", "queued A"),
    ];
    const result = buildDisplayProjection({
      messages,
      optimisticMessages: [],
      messageCountBeforeSubmit: 0,
      sending: false,
      pendingQueue: [pending("a", "queued A", "delivered")],
      optimisticQueue: [],
    });

    expect(result).toHaveLength(3);
    expect(result.filter((m) => m.queued)).toHaveLength(0);
    expect(
      result.filter(
        (m) =>
          m.content.length === 1 &&
          m.content[0]?.type === "text" &&
          m.content[0].text === "queued A",
      ),
    ).toHaveLength(1);
  });

  it("dedups an optimistic entry whose queueId matches a durable pending id", () => {
    const messages = [msg("assistant", "working")];
    const result = buildDisplayProjection({
      messages,
      optimisticMessages: [],
      messageCountBeforeSubmit: 0,
      sending: false,
      pendingQueue: [pending("X", "shared")],
      optimisticQueue: [optimistic("temp-1", "shared", "X")],
    });

    const sharedRows = result.filter(
      (m) =>
        m.content.length === 1 &&
        m.content[0]?.type === "text" &&
        m.content[0].text === "shared",
    );
    expect(sharedRows).toHaveLength(1);
    // Durable row wins: carries the server id, not the tempId.
    expect(sharedRows[0]?.queued).toEqual({
      id: "X",
      status: "pending",
      metadata: null,
    });
  });

  it("keeps an optimistic-only entry (no queueId, not durable) after durable pending rows", () => {
    const messages = [msg("assistant", "working")];
    const result = buildDisplayProjection({
      messages,
      optimisticMessages: [],
      messageCountBeforeSubmit: 0,
      sending: false,
      pendingQueue: [pending("a", "durable A")],
      optimisticQueue: [optimistic("temp-1", "optimistic only", null)],
    });

    expect(result).toHaveLength(3);
    expect(result[1]?.queued).toEqual({
      id: "a",
      status: "pending",
      metadata: null,
    });
    expect(result[2]?.content).toEqual([
      { type: "text", text: "optimistic only" },
    ]);
    expect(result[2]?.queued).toEqual({
      id: null,
      tempId: "temp-1",
      status: "pending",
      metadata: null,
    });
  });

  it("excludes cancelled and failed pending-queue entries from the projection", () => {
    const messages = [msg("assistant", "working")];
    const result = buildDisplayProjection({
      messages,
      optimisticMessages: [],
      messageCountBeforeSubmit: 0,
      sending: false,
      pendingQueue: [
        pending("a", "cancelled one", "cancelled"),
        pending("b", "failed one", "failed"),
        pending("c", "pending one", "pending"),
      ],
      optimisticQueue: [],
    });

    expect(result).toHaveLength(2);
    expect(result[1]?.content).toEqual([{ type: "text", text: "pending one" }]);
    expect(result[1]?.queued?.id).toBe("c");
  });

  it("marks a delivering pending-queue entry with delivering status", () => {
    const result = buildDisplayProjection({
      messages: [],
      optimisticMessages: [],
      messageCountBeforeSubmit: 0,
      sending: false,
      pendingQueue: [pending("a", "in flight", "delivering")],
      optimisticQueue: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.queued).toEqual({
      id: "a",
      status: "delivering",
      metadata: null,
    });
  });

  it("excludes a failed optimistic queue entry", () => {
    const result = buildDisplayProjection({
      messages: [],
      optimisticMessages: [],
      messageCountBeforeSubmit: 0,
      sending: false,
      pendingQueue: [],
      optimisticQueue: [optimistic("temp-1", "failed", null, "failed")],
    });

    expect(result).toHaveLength(0);
  });

  it("preserves the in-flight base merge when the queue is empty", () => {
    const messages = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "stale"),
      msg("assistant", "stale"),
    ];
    const optimisticMessages = [
      msg("user", "current"),
      msg("assistant", "now"),
    ];
    const result = buildDisplayProjection({
      messages,
      optimisticMessages,
      messageCountBeforeSubmit: 2,
      sending: true,
      pendingQueue: [],
      optimisticQueue: [],
    });

    expect(result).toEqual([
      messages[0],
      messages[1],
      optimisticMessages[0],
      optimisticMessages[1],
    ]);
  });
});
