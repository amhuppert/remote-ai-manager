import { describe, it, expect } from "vitest";

import {
  conversationStateSchema,
  messageQueuedEventSchema,
  messageQueueUpdatedEventSchema,
} from "./schemas";

const baseConversation = {
  id: "conv-1",
  transcriptPath: null,
  status: "running" as const,
  promptCount: 0,
  createdAt: "2025-01-01T00:00:00.000Z",
  lastActivityAt: "2025-01-01T00:00:00.000Z",
};

const sampleView = {
  id: "msg-1",
  content: [{ type: "text" as const, text: "queued follow-up" }],
  status: "pending" as const,
  enqueuedAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  deliveredAt: null,
  cancelledAt: null,
  failedAt: null,
  error: null,
};

describe("conversationStateSchema — pendingQueue field", () => {
  it("defaults pendingQueue to an empty array when the field is absent (migration)", () => {
    const result = conversationStateSchema.parse(baseConversation);
    expect(result.pendingQueue).toEqual([]);
  });

  it("accepts a populated pendingQueue with a persisted queued message", () => {
    const persisted = {
      ...sampleView,
      deliveryStartedAt: null,
      deliveryAttemptId: null,
      attemptCount: 0,
    };
    const result = conversationStateSchema.parse({
      ...baseConversation,
      pendingQueue: [persisted],
    });
    expect(result.pendingQueue).toHaveLength(1);
    expect(result.pendingQueue[0]?.id).toBe("msg-1");
  });
});

describe("messageQueuedEventSchema — expanded with queued message view", () => {
  it("validates a payload carrying the queued message view", () => {
    const result = messageQueuedEventSchema.safeParse({
      type: "message-queued",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      text: "queued follow-up",
      message: sampleView,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message?.id).toBe("msg-1");
    }
  });

  it("validates a legacy payload without the message field (optional)", () => {
    const result = messageQueuedEventSchema.safeParse({
      type: "message-queued",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      text: "queued follow-up",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBeUndefined();
    }
  });
});

describe("messageQueueUpdatedEventSchema", () => {
  it("validates a payload carrying the queued message view", () => {
    const result = messageQueueUpdatedEventSchema.safeParse({
      type: "message-queue-updated",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      message: {
        ...sampleView,
        status: "cancelled",
        cancelledAt: "2025-01-01T00:00:01.000Z",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message.status).toBe("cancelled");
    }
  });

  it("rejects a payload missing the message field", () => {
    const result = messageQueueUpdatedEventSchema.safeParse({
      type: "message-queue-updated",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
    });
    expect(result.success).toBe(false);
  });
});
