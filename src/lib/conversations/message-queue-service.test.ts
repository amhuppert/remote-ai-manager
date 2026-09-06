import { describe, it, expect, vi } from "vitest";

// Logging is module-load-time infrastructure; mocking it is the sanctioned
// exception (CLAUDE.md / engineering-principles). We capture log calls so the
// `queue.enqueue` event can be asserted without a real sink. The array is
// `vi.hoisted` so it is initialized before the hoisted `vi.mock` factory's
// closure runs — a logger call during another module's load-time DB open
// (e.g. the state-store purge migration) would otherwise hit the TDZ.
const capturedLogs = vi.hoisted(
  () => [] as { level: string; message: string; data?: unknown }[],
);
vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "info", message, data }),
    debug: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "debug", message, data }),
    warn: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "warn", message, data }),
    error: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "error", message, data }),
  }),
}));

import type { ConversationState } from "@/lib/conversations/schemas";
import { askQuestionItemSchema } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import type {
  PendingQueuedMessage,
  PendingQueuedMessageStatus,
} from "@/lib/conversations/message-queue-schemas";
import { pendingQueuedMessageSchema } from "@/lib/conversations/message-queue-schemas";
import type { SSEEvent } from "@/lib/api/sse-events";

import {
  appendPendingEntry,
  cancelTransform,
  claimLiveDeliveryTransform,
  claimNextTurnBatchTransform,
  coalesceContent,
  contentToText,
  createMessageQueueService,
  createPendingEntry,
  listActiveEntries,
  markDeliveredTransform,
  markFailedTransform,
  markPendingTransform,
  MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS,
  QUEUED_MESSAGE_ATTEMPT_LIMIT_REFUSAL_REASON,
  recoverAbandonedDeliveriesTransform,
  toQueuedMessageView,
  type MessageQueueServiceDeps,
} from "./message-queue-service";

const NOW = "2026-06-07T12:00:00.000Z";

function textBlock(text: string): MessageContentBlock {
  return { type: "text", text };
}

function imageBlock(base64Data: string): MessageContentBlock {
  return { type: "image", mediaType: "image/png", base64Data };
}

function makeEntry(
  overrides: Partial<PendingQueuedMessage> & { id: string },
): PendingQueuedMessage {
  return {
    id: overrides.id,
    content: overrides.content ?? [textBlock("hello")],
    status: overrides.status ?? "pending",
    enqueuedAt: overrides.enqueuedAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    deliveryStartedAt: overrides.deliveryStartedAt ?? null,
    deliveredAt: overrides.deliveredAt ?? null,
    cancelledAt: overrides.cancelledAt ?? null,
    failedAt: overrides.failedAt ?? null,
    deliveryAttemptId: overrides.deliveryAttemptId ?? null,
    attemptCount: overrides.attemptCount ?? 0,
    error: overrides.error ?? null,
    metadata: overrides.metadata ?? null,
    ...(overrides.modelSelection
      ? { modelSelection: overrides.modelSelection }
      : {}),
  };
}

describe("createPendingEntry", () => {
  it("builds a fresh pending row with all terminal timestamps null", () => {
    const entry = createPendingEntry({
      id: "m1",
      content: [textBlock("hi")],
      now: NOW,
    });

    expect(entry).toEqual({
      id: "m1",
      content: [textBlock("hi")],
      status: "pending",
      enqueuedAt: NOW,
      updatedAt: NOW,
      deliveryStartedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      failedAt: null,
      deliveryAttemptId: null,
      attemptCount: 0,
      error: null,
      metadata: null,
    });
    // Output is a valid persisted queue row.
    expect(() => pendingQueuedMessageSchema.parse(entry)).not.toThrow();
  });

  it("stores the complete enqueue-time model selection without rewriting it", () => {
    const modelSelection = {
      modelId: "claude-opus-5",
      parameters: { effort: "xhigh", thinking: "true" },
    };

    const entry = createPendingEntry({
      id: "m1",
      content: [textBlock("hi")],
      now: NOW,
      modelSelection,
    });

    expect(entry.modelSelection).toEqual(modelSelection);
  });
});

describe("appendPendingEntry", () => {
  it("appends to the end preserving enqueue order and does not mutate the input", () => {
    const existing = makeEntry({ id: "m1" });
    const queue: readonly PendingQueuedMessage[] = [existing];
    const next = makeEntry({ id: "m2" });

    const result = appendPendingEntry(queue, next);

    expect(result.map((e) => e.id)).toEqual(["m1", "m2"]);
    expect(queue).toHaveLength(1);
    expect(result).not.toBe(queue);
  });
});

describe("listActiveEntries", () => {
  it("returns active and review-required rows in array order", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "p1", status: "pending" }),
      makeEntry({ id: "d1", status: "delivering" }),
      makeEntry({ id: "done", status: "delivered" }),
      makeEntry({ id: "x", status: "cancelled" }),
      makeEntry({ id: "f", status: "failed" }),
      makeEntry({ id: "p2", status: "pending" }),
    ];

    const active = listActiveEntries(queue);

    expect(active.map((e) => e.id)).toEqual(["p1", "d1", "f", "p2"]);
  });
});

describe("toQueuedMessageView", () => {
  it("projects to the client-safe view omitting internal delivery-claim fields", () => {
    const entry = makeEntry({
      id: "m1",
      status: "delivering",
      deliveryStartedAt: NOW,
      deliveryAttemptId: "attempt-1",
      attemptCount: 1,
    });

    const view = toQueuedMessageView(entry);

    expect(view).toEqual({
      id: "m1",
      content: entry.content,
      status: "delivering",
      enqueuedAt: NOW,
      updatedAt: NOW,
      deliveredAt: null,
      cancelledAt: null,
      failedAt: null,
      error: null,
      metadata: null,
    });
    expect(view).not.toHaveProperty("deliveryStartedAt");
    expect(view).not.toHaveProperty("deliveryAttemptId");
    expect(view).not.toHaveProperty("attemptCount");
  });

  it("keeps the complete model selection in the client-safe projection", () => {
    const modelSelection = {
      modelId: "gpt-5.6-sol",
      parameters: { reasoning: "ultra", fast: "true" },
    };
    const entry = makeEntry({ id: "m1", modelSelection });

    expect(toQueuedMessageView(entry).modelSelection).toEqual(modelSelection);
  });
});

describe("contentToText", () => {
  it("concatenates text blocks joined by newlines", () => {
    expect(contentToText([textBlock("line one"), textBlock("line two")])).toBe(
      "line one\nline two",
    );
  });

  it("ignores non-text blocks and returns empty string when there is no text", () => {
    const content: MessageContentBlock[] = [
      { type: "image", mediaType: "image/png", base64Data: "abc" },
    ];
    expect(contentToText(content)).toBe("");
  });
});

describe("coalesceContent", () => {
  it("concatenates each entry's content in array order", () => {
    const entries: PendingQueuedMessage[] = [
      makeEntry({ id: "m1", content: [textBlock("first")] }),
      makeEntry({
        id: "m2",
        content: [textBlock("second"), textBlock("third")],
      }),
    ];

    expect(coalesceContent(entries)).toEqual([
      textBlock("first"),
      textBlock("second"),
      textBlock("third"),
    ]);
  });

  it("returns an empty array for no entries and does not mutate inputs", () => {
    const entries: readonly PendingQueuedMessage[] = [];
    expect(coalesceContent(entries)).toEqual([]);
  });

  it("concatenates two entries in their original order", () => {
    const entries: PendingQueuedMessage[] = [
      makeEntry({ id: "m1", content: [textBlock("textA")] }),
      makeEntry({ id: "m2", content: [textBlock("textB")] }),
    ];

    expect(coalesceContent(entries)).toEqual([
      textBlock("textA"),
      textBlock("textB"),
    ]);
  });

  it("preserves enqueue order across 3+ entries", () => {
    const entries: PendingQueuedMessage[] = [
      makeEntry({ id: "m1", content: [textBlock("one")] }),
      makeEntry({ id: "m2", content: [textBlock("two")] }),
      makeEntry({ id: "m3", content: [textBlock("three")] }),
      makeEntry({ id: "m4", content: [textBlock("four")] }),
    ];

    expect(coalesceContent(entries)).toEqual([
      textBlock("one"),
      textBlock("two"),
      textBlock("three"),
      textBlock("four"),
    ]);
  });

  it("preserves image blocks in order alongside text", () => {
    const entries: PendingQueuedMessage[] = [
      makeEntry({
        id: "m1",
        content: [textBlock("intro"), imageBlock("img1")],
      }),
      makeEntry({
        id: "m2",
        content: [imageBlock("img2"), textBlock("outro")],
      }),
    ];

    expect(coalesceContent(entries)).toEqual([
      textBlock("intro"),
      imageBlock("img1"),
      imageBlock("img2"),
      textBlock("outro"),
    ]);
  });
});

describe("claimLiveDeliveryTransform", () => {
  it("claims a pending row by id and marks it delivering under the attempt id", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "m1", status: "pending", attemptCount: 0 }),
      makeEntry({ id: "m2", status: "pending" }),
    ];

    const { queue: next, claimed } = claimLiveDeliveryTransform(
      queue,
      "m1",
      "attempt-A",
      NOW,
    );

    expect(claimed?.id).toBe("m1");
    expect(claimed?.status).toBe("delivering");
    expect(claimed?.deliveryAttemptId).toBe("attempt-A");
    expect(claimed?.deliveryStartedAt).toBe(NOW);
    expect(claimed?.attemptCount).toBe(1);
    // The other row is untouched.
    expect(next.find((e) => e.id === "m2")?.status).toBe("pending");
    // Input not mutated.
    expect(queue[0]?.status).toBe("pending");
  });

  it("returns null and the unchanged queue when the id is not pending", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "m1", status: "delivering" }),
    ];

    const { queue: next, claimed } = claimLiveDeliveryTransform(
      queue,
      "m1",
      "attempt-A",
      NOW,
    );

    expect(claimed).toBeNull();
    expect(next[0]?.status).toBe("delivering");
  });

  it("returns null when the id is absent", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "m1", status: "pending" }),
    ];

    const { claimed } = claimLiveDeliveryTransform(
      queue,
      "missing",
      "attempt-A",
      NOW,
    );

    expect(claimed).toBeNull();
  });
});

describe("claimNextTurnBatchTransform", () => {
  it("marks all pending rows delivering under one attempt id in array order", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "p1", status: "pending" }),
      makeEntry({ id: "p2", status: "pending" }),
      makeEntry({ id: "done", status: "delivered" }),
    ];

    const { queue: next, claimed } = claimNextTurnBatchTransform(
      queue,
      "attempt-B",
      NOW,
    );

    expect(claimed.map((e) => e.id)).toEqual(["p1", "p2"]);
    expect(claimed.every((e) => e.status === "delivering")).toBe(true);
    expect(claimed.every((e) => e.deliveryAttemptId === "attempt-B")).toBe(
      true,
    );
    expect(claimed.every((e) => e.attemptCount === 1)).toBe(true);
    expect(next.find((e) => e.id === "done")?.status).toBe("delivered");
    // Input not mutated.
    expect(queue[0]?.status).toBe("pending");
  });

  it("stops before a different atomic model selection", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({
        id: "p1",
        modelSelection: {
          modelId: "claude-opus-5",
          parameters: { effort: "xhigh", thinking: "true" },
        },
      }),
      makeEntry({
        id: "p2",
        modelSelection: {
          modelId: "claude-opus-5",
          parameters: { thinking: "true", effort: "xhigh" },
        },
      }),
      makeEntry({
        id: "p3",
        modelSelection: {
          modelId: "claude-opus-5",
          parameters: { effort: "high", thinking: "true" },
        },
      }),
    ];

    const { queue: next, claimed } = claimNextTurnBatchTransform(
      queue,
      "attempt-B",
      NOW,
    );

    expect(claimed.map((entry) => entry.id)).toEqual(["p1", "p2"]);
    expect(next.find((entry) => entry.id === "p3")?.status).toBe("pending");
  });

  it("does not coalesce an unselected row with an explicitly selected row", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "p1" }),
      makeEntry({
        id: "p2",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
      }),
    ];

    const { claimed } = claimNextTurnBatchTransform(queue, "attempt-B", NOW);

    expect(claimed.map((entry) => entry.id)).toEqual(["p1"]);
  });

  it("returns an empty claim when there are no pending rows", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "d1", status: "delivering" }),
    ];

    const { claimed, command } = claimNextTurnBatchTransform(
      queue,
      "attempt-B",
      NOW,
    );

    expect(claimed).toEqual([]);
    expect(command).toBeNull();
  });

  it("claims a head command entry alone and returns the parsed command", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "c1", content: [textBlock("/commit focus the API")] }),
      makeEntry({ id: "p1", content: [textBlock("after the command")] }),
    ];

    const {
      queue: next,
      claimed,
      command,
    } = claimNextTurnBatchTransform(queue, "attempt-B", NOW);

    expect(claimed.map((e) => e.id)).toEqual(["c1"]);
    expect(claimed[0]?.status).toBe("delivering");
    expect(command).toEqual({ command: "commit", hint: "focus the API" });
    // The trailing plain message stays pending for a later drain.
    expect(next.find((e) => e.id === "p1")?.status).toBe("pending");
  });

  it("claims the maximal non-command prefix, stopping before the first command", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "p1", content: [textBlock("one")] }),
      makeEntry({ id: "p2", content: [textBlock("two")] }),
      makeEntry({ id: "c1", content: [textBlock("/merge")] }),
      makeEntry({ id: "p3", content: [textBlock("three")] }),
    ];

    const {
      queue: next,
      claimed,
      command,
    } = claimNextTurnBatchTransform(queue, "attempt-B", NOW);

    expect(claimed.map((e) => e.id)).toEqual(["p1", "p2"]);
    expect(command).toBeNull();
    expect(next.find((e) => e.id === "c1")?.status).toBe("pending");
    expect(next.find((e) => e.id === "p3")?.status).toBe("pending");
  });

  it("ignores non-pending rows when locating the head command", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({
        id: "done",
        status: "delivered",
        content: [textBlock("old")],
      }),
      makeEntry({ id: "c1", content: [textBlock("/commit")] }),
    ];

    const { claimed, command } = claimNextTurnBatchTransform(
      queue,
      "attempt-B",
      NOW,
    );

    expect(claimed.map((e) => e.id)).toEqual(["c1"]);
    expect(command).toEqual({ command: "commit", hint: "" });
  });

  it("treats near-miss text like /committed as a plain message", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "p1", content: [textBlock("/committed the fix")] }),
      makeEntry({ id: "p2", content: [textBlock("two")] }),
    ];

    const { claimed, command } = claimNextTurnBatchTransform(
      queue,
      "attempt-B",
      NOW,
    );

    expect(claimed.map((e) => e.id)).toEqual(["p1", "p2"]);
    expect(command).toBeNull();
  });
});

describe("delivery result transforms", () => {
  function deliveringRow(id: string, attemptId: string): PendingQueuedMessage {
    return makeEntry({
      id,
      status: "delivering",
      deliveryAttemptId: attemptId,
      deliveryStartedAt: NOW,
      attemptCount: 1,
    });
  }

  it("markDeliveredTransform only mutates rows whose attempt id matches", () => {
    const queue: PendingQueuedMessage[] = [
      deliveringRow("m1", "attempt-A"),
      deliveringRow("m2", "attempt-B"),
    ];

    const { queue: next, affected } = markDeliveredTransform(
      queue,
      ["m1", "m2"],
      "attempt-A",
      NOW,
    );

    expect(affected.map((e) => e.id)).toEqual(["m1"]);
    // The delivered row is pruned from the queue; its terminal status rides on
    // `affected` for the broadcast.
    expect(next.find((e) => e.id === "m1")).toBeUndefined();
    expect(affected[0]?.status).toBe("delivered");
    expect(affected[0]?.deliveredAt).toBe(NOW);
    // Mismatched attempt left unchanged.
    expect(next.find((e) => e.id === "m2")?.status).toBe("delivering");
    expect(queue[0]?.status).toBe("delivering");
  });

  it("markPendingTransform resets a delivering row to pending and clears the claim", () => {
    const queue: PendingQueuedMessage[] = [deliveringRow("m1", "attempt-A")];

    const { queue: next, affected } = markPendingTransform(
      queue,
      ["m1"],
      "attempt-A",
      "transient failure",
      NOW,
    );

    expect(affected.map((e) => e.id)).toEqual(["m1"]);
    const row = next.find((e) => e.id === "m1");
    expect(row?.status).toBe("pending");
    expect(row?.deliveryAttemptId).toBeNull();
    expect(row?.deliveryStartedAt).toBeNull();
    expect(row?.error).toBe("transient failure");
    // attemptCount is retained for recoverable failures.
    expect(row?.attemptCount).toBe(1);
  });

  it("markFailedTransform sets a delivering row to failed", () => {
    const queue: PendingQueuedMessage[] = [deliveringRow("m1", "attempt-A")];

    const { queue: next, affected } = markFailedTransform(
      queue,
      ["m1"],
      "attempt-A",
      "terminal failure",
      NOW,
    );

    expect(affected.map((e) => e.id)).toEqual(["m1"]);
    expect(next.find((e) => e.id === "m1")?.status).toBe("failed");
    const row = affected[0];
    expect(row?.status).toBe("failed");
    expect(row?.failedAt).toBe(NOW);
    expect(row?.error).toBe("terminal failure");
  });

  it("delivery result transforms reject a wrong attempt id (row unchanged)", () => {
    const queue: PendingQueuedMessage[] = [deliveringRow("m1", "attempt-A")];

    const { queue: next, affected } = markDeliveredTransform(
      queue,
      ["m1"],
      "WRONG",
      NOW,
    );

    expect(affected).toEqual([]);
    expect(next.find((e) => e.id === "m1")?.status).toBe("delivering");
  });
});

describe("recoverAbandonedDeliveriesTransform", () => {
  it("retains delivering rows as uncertain and reports them", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({
        id: "d1",
        status: "delivering",
        deliveryAttemptId: "attempt-A",
        deliveryStartedAt: NOW,
      }),
      makeEntry({ id: "p1", status: "pending" }),
    ];

    const { queue: next, recovered } = recoverAbandonedDeliveriesTransform(
      queue,
      NOW,
    );

    expect(recovered.map((e) => e.id)).toEqual(["d1"]);
    const row = next.find((e) => e.id === "d1");
    expect(row?.status).toBe("uncertain");
    expect(row?.deliveryAttemptId).toBe("attempt-A");
    expect(row?.deliveryStartedAt).toBe(NOW);
    // pending row untouched.
    expect(next.find((e) => e.id === "p1")?.status).toBe("pending");
    expect(queue[0]?.status).toBe("delivering");
  });
});

describe("cancelTransform", () => {
  it("cancels a pending row, stamping cancelledAt and updatedAt", () => {
    const LATER = "2026-06-07T12:05:00.000Z";
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "m1", status: "pending" }),
      makeEntry({ id: "m2", status: "pending" }),
    ];

    const {
      queue: next,
      result,
      cancelled,
    } = cancelTransform(queue, "m1", LATER);

    expect(result).toBe("cancelled");
    expect(cancelled?.id).toBe("m1");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelledAt).toBe(LATER);
    expect(cancelled?.updatedAt).toBe(LATER);
    // The cancelled row is pruned from the queue; its terminal status rides on
    // the returned `cancelled` entry for the broadcast.
    expect(next.find((e) => e.id === "m1")).toBeUndefined();
    // The other row is untouched.
    expect(next.find((e) => e.id === "m2")?.status).toBe("pending");
    // Input not mutated.
    expect(queue[0]?.status).toBe("pending");
    expect(queue[0]?.cancelledAt).toBeNull();
  });

  it("refuses to cancel a delivering row (not_cancellable, queue unchanged)", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "m1", status: "delivering", deliveryAttemptId: "a" }),
    ];

    const {
      queue: next,
      result,
      cancelled,
    } = cancelTransform(queue, "m1", NOW);

    expect(result).toBe("not_cancellable");
    expect(cancelled).toBeNull();
    expect(next.find((e) => e.id === "m1")?.status).toBe("delivering");
  });

  it("refuses to cancel a delivered row (not_cancellable)", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "m1", status: "delivered", deliveredAt: NOW }),
    ];

    const { result, cancelled } = cancelTransform(queue, "m1", NOW);

    expect(result).toBe("not_cancellable");
    expect(cancelled).toBeNull();
  });

  it("returns not_found for a missing id without changing the queue", () => {
    const queue: PendingQueuedMessage[] = [
      makeEntry({ id: "m1", status: "pending" }),
    ];

    const {
      queue: next,
      result,
      cancelled,
    } = cancelTransform(queue, "missing", NOW);

    expect(result).toBe("not_found");
    expect(cancelled).toBeNull();
    expect(next).toEqual(queue);
  });
});

interface FakeStore {
  conversation: ConversationState | null;
}

function makeConversation(): ConversationState {
  return makeConversationState({
    status: "running",
    createdAt: NOW,
    lastActivityAt: NOW,
  });
}

function makeDeps(store: FakeStore): {
  deps: MessageQueueServiceDeps;
  broadcasts: SSEEvent[];
} {
  const broadcasts: SSEEvent[] = [];
  let idCounter = 0;
  const deps: MessageQueueServiceDeps = {
    async mutateConversation(
      _projectPath,
      _sessionName,
      _conversationId,
      _label,
      mutate,
    ) {
      if (!store.conversation) {
        throw new Error("conversation not found");
      }
      // Apply the REAL mutate callback to the backing object so the test
      // exercises the production enqueue transform, not a mock of it.
      return mutate(store.conversation);
    },
    async getConversation() {
      return store.conversation;
    },
    getProjectDisplayName() {
      return "my-project";
    },
    broadcast(event) {
      broadcasts.push(event);
    },
    now() {
      return NOW;
    },
    newId() {
      idCounter += 1;
      return `id-${idCounter}`;
    },
  };
  return { deps, broadcasts };
}

describe("messageQueueService.enqueue", () => {
  it("persists a pending row that listActive then returns and emits message-queued exactly once", async () => {
    const store: FakeStore = { conversation: makeConversation() };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const entry = await service.enqueue({
      projectPath: "/repos/my-project",
      sessionName: "csm/feature",
      conversationId: "conv-1",
      content: [textBlock("queued message")],
    });

    expect(entry?.id).toBe("id-1");
    expect(entry?.status).toBe("pending");

    // Persisted into the backing conversation's pendingQueue.
    expect(store.conversation?.pendingQueue.map((e) => e.id)).toEqual(["id-1"]);
    expect(store.conversation?.pendingQueue[0]?.status).toBe("pending");

    // Active listing returns it.
    const active = await service.listActive({
      projectPath: "/repos/my-project",
      sessionName: "csm/feature",
      conversationId: "conv-1",
    });
    expect(active.map((e) => e.id)).toEqual(["id-1"]);

    // Broadcast happened exactly once with the right shape.
    expect(broadcasts).toHaveLength(1);
    const event = broadcasts[0];
    expect(event?.type).toBe("message-queued");
    if (event?.type !== "message-queued") throw new Error("wrong event type");
    expect(event.projectName).toBe("my-project");
    expect(event.scope).toBe("session");
    if (event.scope !== "session") throw new Error("wrong event scope");
    expect(event.sessionName).toBe("csm/feature");
    expect(event.conversationId).toBe("conv-1");
    expect(event.text).toBe("queued message");
    expect(event.message?.id).toBe("id-1");
    expect(event.message?.status).toBe("pending");
  });

  it("persists and broadcasts the complete enqueue-time model selection", async () => {
    const store: FakeStore = { conversation: makeConversation() };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);
    const modelSelection = {
      modelId: "gpt-5.6-sol",
      parameters: { reasoning: "ultra", fast: "true" },
    };

    await service.enqueue({
      projectPath: "/repos/my-project",
      sessionName: "csm/feature",
      conversationId: "conv-1",
      content: [textBlock("queued message")],
      modelSelection,
    });

    expect(store.conversation?.pendingQueue[0]?.modelSelection).toEqual(
      modelSelection,
    );
    const event = broadcasts[0];
    expect(event?.type).toBe("message-queued");
    if (event?.type !== "message-queued") throw new Error("wrong event type");
    if (!event.message) throw new Error("missing queued message view");
    expect(event.message.modelSelection).toEqual(modelSelection);
  });

  it("does not fail the durable enqueue when broadcast throws", async () => {
    const store: FakeStore = { conversation: makeConversation() };
    const { deps } = makeDeps(store);
    const failingDeps: MessageQueueServiceDeps = {
      ...deps,
      broadcast() {
        throw new Error("broadcast down");
      },
    };
    const service = createMessageQueueService(failingDeps);

    const entry = await service.enqueue({
      projectPath: "/repos/my-project",
      sessionName: "csm/feature",
      conversationId: "conv-1",
      content: [textBlock("queued message")],
    });

    expect(entry?.status).toBe("pending");
    expect(store.conversation?.pendingQueue.map((e) => e.id)).toEqual(["id-1"]);
  });

  it("consumePendingQuestionId: clears the marker and appends the row in one mutate", async () => {
    const conversation = makeConversation();
    conversation.pendingQuestionId = "q_b1";
    conversation.pendingQuestions = [
      askQuestionItemSchema.parse({
        id: "approach",
        question: "Which approach?",
        options: [{ label: "A" }],
      }),
    ];
    const store: FakeStore = { conversation };
    const { deps, broadcasts } = makeDeps(store);
    let mutateCalls = 0;
    const countingDeps: MessageQueueServiceDeps = {
      ...deps,
      mutateConversation(projectPath, sessionName, conversationId, label, fn) {
        mutateCalls += 1;
        return deps.mutateConversation(
          projectPath,
          sessionName,
          conversationId,
          label,
          fn,
        );
      },
    };
    const service = createMessageQueueService(countingDeps);

    const entry = await service.enqueue({
      projectPath: "/repos/my-project",
      sessionName: "csm/feature",
      conversationId: "conv-1",
      content: [textBlock("answers")],
      consumePendingQuestionId: "q_b1",
    });

    expect(entry?.id).toBe("id-1");
    expect(mutateCalls).toBe(1);
    expect(store.conversation?.pendingQuestionId).toBeNull();
    expect(store.conversation?.pendingQuestions).toBeNull();
    expect(store.conversation?.pendingQueue.map((e) => e.id)).toEqual(["id-1"]);
    expect(broadcasts.map((e) => e.type)).toEqual(["message-queued"]);
  });

  it("consumePendingQuestionId: rejects (null, no row, no broadcast) when the marker is gone", async () => {
    const store: FakeStore = { conversation: makeConversation() };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const entry = await service.enqueue({
      projectPath: "/repos/my-project",
      sessionName: "csm/feature",
      conversationId: "conv-1",
      content: [textBlock("answers")],
      consumePendingQuestionId: "q_b1",
    });

    expect(entry).toBeNull();
    expect(store.conversation?.pendingQueue).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  it("logs queue.enqueue with the message id and pending status", async () => {
    capturedLogs.length = 0;
    const store: FakeStore = { conversation: makeConversation() };
    const { deps } = makeDeps(store);
    const service = createMessageQueueService(deps);

    await service.enqueue({
      projectPath: "/repos/my-project",
      sessionName: "csm/feature",
      conversationId: "conv-1",
      content: [textBlock("queued message")],
    });

    const enqueueLog = capturedLogs.find(
      (entry) => entry.message === "queue.enqueue",
    );
    expect(enqueueLog).toBeDefined();
    expect(enqueueLog?.data).toMatchObject({
      projectName: "my-project",
      sessionName: "csm/feature",
      conversationId: "conv-1",
      messageIds: ["id-1"],
      status: "pending",
    });
  });
});

describe("messageQueueService.listActive", () => {
  it("returns [] when the conversation does not exist", async () => {
    const store: FakeStore = { conversation: null };
    const { deps } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const active = await service.listActive({
      projectPath: "/repos/my-project",
      sessionName: "csm/feature",
      conversationId: "missing",
    });

    expect(active).toEqual([]);
  });

  it("excludes delivered and cancelled rows but retains failed deliveries", async () => {
    const conversation = makeConversation();
    const statuses: PendingQueuedMessageStatus[] = [
      "pending",
      "delivering",
      "delivered",
      "cancelled",
      "failed",
    ];
    conversation.pendingQueue = statuses.map((status, i) =>
      makeEntry({ id: `m${i}`, status }),
    );
    const store: FakeStore = { conversation };
    const { deps } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const active = await service.listActive({
      projectPath: "/repos/my-project",
      sessionName: "csm/feature",
      conversationId: "conv-1",
    });

    expect(active.map((e) => e.status)).toEqual([
      "pending",
      "delivering",
      "failed",
    ]);
  });
});

const KEY = {
  projectPath: "/repos/my-project",
  sessionName: "csm/feature",
  conversationId: "conv-1",
} as const;

function conversationWith(entries: PendingQueuedMessage[]): ConversationState {
  const conversation = makeConversation();
  conversation.pendingQueue = entries;
  return conversation;
}

describe("messageQueueService.claimNextTurnBatch", () => {
  it("claims all pending rows into one delivering batch with coalesced content", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "p1", status: "pending", content: [textBlock("one")] }),
        makeEntry({ id: "p2", status: "pending", content: [textBlock("two")] }),
      ]),
    };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const batch = await service.claimNextTurnBatch(KEY);

    expect(batch).not.toBeNull();
    expect(batch?.messageIds).toEqual(["p1", "p2"]);
    expect(batch?.content).toEqual([textBlock("one"), textBlock("two")]);
    expect(batch?.command).toBeNull();

    const ids = batch?.messageIds ?? [];
    const attemptId = batch?.deliveryAttemptId;
    expect(attemptId).toBeTruthy();
    // Both rows are now delivering under the SAME attempt id.
    const rows = store.conversation?.pendingQueue ?? [];
    expect(rows.every((r) => r.status === "delivering")).toBe(true);
    expect(rows.every((r) => r.deliveryAttemptId === attemptId)).toBe(true);

    // One message-queue-updated broadcast per claimed row.
    const updates = broadcasts.filter(
      (e) => e.type === "message-queue-updated",
    );
    expect(updates).toHaveLength(2);
    expect(
      updates.map((e) =>
        e.type === "message-queue-updated" ? e.message.id : null,
      ),
    ).toEqual(ids);
  });

  it("returns the head row's complete model selection on the claimed batch", async () => {
    const modelSelection = {
      modelId: "claude-opus-5",
      parameters: { effort: "xhigh", thinking: "true" },
    };
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "p1", modelSelection }),
        makeEntry({ id: "p2", modelSelection }),
      ]),
    };
    const { deps } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const batch = await service.claimNextTurnBatch(KEY);

    expect(batch?.modelSelection).toEqual(modelSelection);
  });

  it("returns null when there are no pending rows", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "d1", status: "delivering" }),
      ]),
    };
    const { deps } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const batch = await service.claimNextTurnBatch(KEY);

    expect(batch).toBeNull();
  });

  it("claims a single head command row alone and surfaces the parsed command", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({
          id: "c1",
          status: "pending",
          content: [textBlock("/commit polish the API")],
        }),
        makeEntry({
          id: "p1",
          status: "pending",
          content: [textBlock("later message")],
        }),
      ]),
    };
    const { deps } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const batch = await service.claimNextTurnBatch(KEY);

    expect(batch?.messageIds).toEqual(["c1"]);
    expect(batch?.command).toEqual({
      command: "commit",
      hint: "polish the API",
    });
    expect(batch?.content).toEqual([textBlock("/commit polish the API")]);
    // The trailing plain row stays pending for a later drain.
    const rows = store.conversation?.pendingQueue ?? [];
    expect(rows.find((r) => r.id === "p1")?.status).toBe("pending");
    expect(rows.find((r) => r.id === "c1")?.status).toBe("delivering");
  });
});

describe("messageQueueService.claimLiveDelivery", () => {
  it("claims a pending row by id and returns it as delivering", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "p1", status: "pending" }),
      ]),
    };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const claimed = await service.claimLiveDelivery({ ...KEY, id: "p1" });

    expect(claimed?.id).toBe("p1");
    expect(claimed?.status).toBe("delivering");
    expect(claimed?.deliveryAttemptId).toBeTruthy();
    expect(store.conversation?.pendingQueue[0]?.status).toBe("delivering");

    const updates = broadcasts.filter(
      (e) => e.type === "message-queue-updated",
    );
    expect(updates).toHaveLength(1);
  });

  it("returns null when the id is not pending", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "d1", status: "delivering" }),
      ]),
    };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const claimed = await service.claimLiveDelivery({ ...KEY, id: "d1" });

    expect(claimed).toBeNull();
    expect(
      broadcasts.filter((e) => e.type === "message-queue-updated"),
    ).toHaveLength(0);
  });
});

describe("messageQueueService delivery results", () => {
  it("rejects a mismatched attempt id then accepts the real one", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "p1", status: "pending" }),
      ]),
    };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const claimed = await service.claimLiveDelivery({ ...KEY, id: "p1" });
    const attemptId = claimed?.deliveryAttemptId ?? "";
    broadcasts.length = 0;

    // Stale handler with the wrong attempt id must not mutate the row.
    await service.markDelivered({
      ...KEY,
      ids: ["p1"],
      deliveryAttemptId: "WRONG",
    });
    expect(store.conversation?.pendingQueue[0]?.status).toBe("delivering");
    expect(
      broadcasts.filter((e) => e.type === "message-queue-updated"),
    ).toHaveLength(0);

    // The real attempt id transitions the row to delivered.
    await service.markDelivered({
      ...KEY,
      ids: ["p1"],
      deliveryAttemptId: attemptId,
    });
    // The delivered row is pruned from the queue; the broadcast carries the
    // terminal view.
    expect(store.conversation?.pendingQueue).toHaveLength(0);
    const delivered = broadcasts.filter(
      (e) => e.type === "message-queue-updated",
    );
    expect(delivered).toHaveLength(1);
    expect(
      delivered[0]?.type === "message-queue-updated"
        ? delivered[0].message.status
        : null,
    ).toBe("delivered");
  });

  it("markPending returns a delivering row to pending with an error", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "p1", status: "pending" }),
      ]),
    };
    const { deps } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const claimed = await service.claimLiveDelivery({ ...KEY, id: "p1" });
    await service.markPending({
      ...KEY,
      ids: ["p1"],
      deliveryAttemptId: claimed?.deliveryAttemptId ?? "",
      error: "transient",
    });

    const row = store.conversation?.pendingQueue[0];
    expect(row?.status).toBe("pending");
    expect(row?.deliveryAttemptId).toBeNull();
    expect(row?.error).toBe("transient");
  });

  it("markFailed retains the failed row and broadcasts the failed outcome", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "p1", status: "pending" }),
      ]),
    };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const claimed = await service.claimLiveDelivery({ ...KEY, id: "p1" });
    broadcasts.length = 0;
    await service.markFailed({
      ...KEY,
      ids: ["p1"],
      deliveryAttemptId: claimed?.deliveryAttemptId ?? "",
      error: "boom",
    });

    expect(store.conversation?.pendingQueue).toMatchObject([
      { status: "failed" },
    ]);
    const updates = broadcasts.filter(
      (e) => e.type === "message-queue-updated",
    );
    expect(updates).toHaveLength(1);
    const msg =
      updates[0]?.type === "message-queue-updated" ? updates[0].message : null;
    expect(msg?.status).toBe("failed");
    expect(msg?.failedAt).toBe(NOW);
    expect(msg?.error).toBe("boom");
  });
});

describe("messageQueueService.recoverAbandonedDeliveries", () => {
  it("retains delivering rows as uncertain, returns the count, and broadcasts updates", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({
          id: "d1",
          status: "delivering",
          deliveryAttemptId: "attempt-A",
          deliveryStartedAt: NOW,
        }),
        makeEntry({ id: "p1", status: "pending" }),
      ]),
    };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const recovered = await service.recoverAbandonedDeliveries(KEY);

    expect(recovered).toBe(1);
    const rows = store.conversation?.pendingQueue ?? [];
    expect(rows.find((r) => r.id === "d1")?.status).toBe("uncertain");
    expect(rows.find((r) => r.id === "d1")?.deliveryAttemptId).toBe(
      "attempt-A",
    );
    expect(rows.find((r) => r.id === "p1")?.status).toBe("pending");

    const updates = broadcasts.filter(
      (e) => e.type === "message-queue-updated",
    );
    expect(updates).toHaveLength(1);
    expect(
      updates[0]?.type === "message-queue-updated"
        ? updates[0].message.id
        : null,
    ).toBe("d1");
  });

  it("returns 0 and broadcasts nothing when there are no delivering rows", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "p1", status: "pending" }),
      ]),
    };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const recovered = await service.recoverAbandonedDeliveries(KEY);

    expect(recovered).toBe(0);
    expect(
      broadcasts.filter((e) => e.type === "message-queue-updated"),
    ).toHaveLength(0);
  });
});

describe("messageQueueService.cancel", () => {
  it("cancels a pending row, prunes it, and broadcasts exactly one update", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "p1", status: "pending" }),
        makeEntry({ id: "p2", status: "pending" }),
      ]),
    };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const result = await service.cancel({ ...KEY, id: "p1" });

    expect(result).toBe("cancelled");
    const rows = store.conversation?.pendingQueue ?? [];
    // The cancelled row is pruned; its terminal outcome rides on the broadcast.
    expect(rows.find((r) => r.id === "p1")).toBeUndefined();
    // The other pending row is untouched.
    expect(rows.find((r) => r.id === "p2")?.status).toBe("pending");

    const updates = broadcasts.filter(
      (e) => e.type === "message-queue-updated",
    );
    expect(updates).toHaveLength(1);
    expect(
      updates[0]?.type === "message-queue-updated"
        ? updates[0].message.id
        : null,
    ).toBe("p1");
    expect(
      updates[0]?.type === "message-queue-updated"
        ? updates[0].message.status
        : null,
    ).toBe("cancelled");
  });

  it("refuses to cancel a delivering row and does not broadcast", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({
          id: "d1",
          status: "delivering",
          deliveryAttemptId: "attempt-A",
        }),
      ]),
    };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const result = await service.cancel({ ...KEY, id: "d1" });

    expect(result).toBe("not_cancellable");
    expect(store.conversation?.pendingQueue[0]?.status).toBe("delivering");
    expect(
      broadcasts.filter((e) => e.type === "message-queue-updated"),
    ).toHaveLength(0);
  });

  it("returns not_found for a missing id and does not broadcast", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "p1", status: "pending" }),
      ]),
    };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const result = await service.cancel({ ...KEY, id: "missing" });

    expect(result).toBe("not_found");
    expect(store.conversation?.pendingQueue[0]?.status).toBe("pending");
    expect(
      broadcasts.filter((e) => e.type === "message-queue-updated"),
    ).toHaveLength(0);
  });

  it("logs queue.cancelled with the message id and cancelled status", async () => {
    capturedLogs.length = 0;
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({ id: "p1", status: "pending" }),
      ]),
    };
    const { deps } = makeDeps(store);
    const service = createMessageQueueService(deps);

    await service.cancel({ ...KEY, id: "p1" });

    const cancelledLog = capturedLogs.find(
      (entry) => entry.message === "queue.cancelled",
    );
    expect(cancelledLog).toBeDefined();
    expect(cancelledLog?.data).toMatchObject({
      projectName: "my-project",
      sessionName: "csm/feature",
      conversationId: "conv-1",
      messageIds: ["p1"],
      status: "cancelled",
    });
  });
});

describe("delivery attempt cap", () => {
  it("claimLiveDeliveryTransform refuses a pending row at the attempt cap", () => {
    const poison = makeEntry({
      id: "p1",
      status: "pending",
      attemptCount: MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS,
    });
    const queue = [poison];

    const {
      queue: next,
      claimed,
      refused,
    } = claimLiveDeliveryTransform(queue, "p1", "attempt-A", NOW);

    expect(claimed).toBeNull();
    expect(next).toMatchObject([{ status: "failed" }]);
    expect(refused?.id).toBe("p1");
    expect(refused?.status).toBe("failed");
    expect(refused?.failedAt).toBe(NOW);
    expect(refused?.error).toBe(QUEUED_MESSAGE_ATTEMPT_LIMIT_REFUSAL_REASON);
  });

  it("claimLiveDeliveryTransform still claims a row one attempt below the cap", () => {
    const nearCap = makeEntry({
      id: "p1",
      status: "pending",
      attemptCount: MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS - 1,
    });

    const { claimed, refused } = claimLiveDeliveryTransform(
      [nearCap],
      "p1",
      "attempt-A",
      NOW,
    );

    expect(refused).toBeNull();
    expect(claimed?.status).toBe("delivering");
    expect(claimed?.attemptCount).toBe(MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS);
  });

  it("claimNextTurnBatchTransform retains at-cap rows and blocks later pending rows", () => {
    const poison = makeEntry({
      id: "poison",
      status: "pending",
      attemptCount: MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS,
      content: [textBlock("stuck")],
    });
    const healthy = makeEntry({
      id: "ok",
      status: "pending",
      content: [textBlock("fine")],
    });

    const {
      queue: next,
      claimed,
      refused,
    } = claimNextTurnBatchTransform([poison, healthy], "attempt-A", NOW);

    expect(refused.map((row) => row.id)).toEqual(["poison"]);
    expect(refused[0]?.status).toBe("failed");
    expect(refused[0]?.error).toBe(QUEUED_MESSAGE_ATTEMPT_LIMIT_REFUSAL_REASON);
    expect(claimed).toEqual([]);
    expect(next.map((row) => row.id)).toEqual(["poison", "ok"]);
  });

  it("claimNextTurnBatchTransform with only a poison row refuses it and claims nothing", () => {
    const poison = makeEntry({
      id: "poison",
      status: "pending",
      attemptCount: MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS,
    });

    const {
      queue: next,
      claimed,
      refused,
    } = claimNextTurnBatchTransform([poison], "attempt-A", NOW);

    expect(claimed).toHaveLength(0);
    expect(refused.map((row) => row.id)).toEqual(["poison"]);
    expect(next).toMatchObject([{ status: "failed" }]);
  });

  it("a message that keeps failing delivery requires review after the cap instead of looping", async () => {
    const store: FakeStore = { conversation: makeConversation() };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    await service.enqueue({ ...KEY, content: [textBlock("poison")] });

    // Each cycle: claim → recoverable failure → back to pending. Without a cap
    // this loops forever; with the cap the row is claimable exactly
    // MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS times.
    for (let i = 0; i < MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS; i += 1) {
      const batch = await service.claimNextTurnBatch(KEY);
      expect(batch).not.toBeNull();
      await service.markPending({
        ...KEY,
        ids: batch?.messageIds ?? [],
        deliveryAttemptId: batch?.deliveryAttemptId ?? "",
        error: "transient",
      });
    }

    broadcasts.length = 0;
    capturedLogs.length = 0;

    const refusedBatch = await service.claimNextTurnBatch(KEY);

    expect(refusedBatch).toBeNull();
    expect(store.conversation?.pendingQueue).toMatchObject([
      { status: "failed" },
    ]);
    const updates = broadcasts.filter(
      (e) => e.type === "message-queue-updated",
    );
    expect(updates).toHaveLength(1);
    const msg =
      updates[0]?.type === "message-queue-updated" ? updates[0].message : null;
    expect(msg?.status).toBe("failed");
    expect(msg?.error).toBe(QUEUED_MESSAGE_ATTEMPT_LIMIT_REFUSAL_REASON);

    const refusedLog = capturedLogs.find(
      (entry) => entry.message === "queue.refused",
    );
    expect(refusedLog?.level).toBe("warn");
    expect(refusedLog?.data).toMatchObject({
      projectName: "my-project",
      sessionName: "csm/feature",
      conversationId: "conv-1",
      reason: QUEUED_MESSAGE_ATTEMPT_LIMIT_REFUSAL_REASON,
      maxAttempts: MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS,
    });
  });

  it("claimLiveDelivery refuses a poison row: returns null, retains it, and broadcasts the failed outcome", async () => {
    const store: FakeStore = {
      conversation: conversationWith([
        makeEntry({
          id: "p1",
          status: "pending",
          attemptCount: MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS,
        }),
      ]),
    };
    const { deps, broadcasts } = makeDeps(store);
    const service = createMessageQueueService(deps);

    const claimed = await service.claimLiveDelivery({ ...KEY, id: "p1" });

    expect(claimed).toBeNull();
    expect(store.conversation?.pendingQueue).toMatchObject([
      { status: "failed" },
    ]);
    const updates = broadcasts.filter(
      (e) => e.type === "message-queue-updated",
    );
    expect(updates).toHaveLength(1);
    const msg =
      updates[0]?.type === "message-queue-updated" ? updates[0].message : null;
    expect(msg?.id).toBe("p1");
    expect(msg?.status).toBe("failed");
    expect(msg?.error).toBe(QUEUED_MESSAGE_ATTEMPT_LIMIT_REFUSAL_REASON);
  });
});

it("does not let a concurrent drain overtake an outstanding delivery", () => {
  const queued = [
    makeEntry({
      id: "first",
      status: "pending",
      modelSelection: { modelId: "a", parameters: {} },
    }),
    makeEntry({
      id: "second",
      status: "pending",
      modelSelection: { modelId: "b", parameters: {} },
    }),
  ];
  const first = claimNextTurnBatchTransform(queued, "attempt-first", NOW);
  const second = claimNextTurnBatchTransform(
    first.queue,
    "attempt-second",
    NOW,
  );
  expect(first.claimed.map((row) => row.id)).toEqual(["first"]);
  expect(second.claimed).toEqual([]);
  expect(second.queue).toEqual(first.queue);
});
