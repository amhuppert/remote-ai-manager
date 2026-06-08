import { describe, expect, it } from "vitest";

import {
  PENDING_QUEUED_MESSAGE_STATUSES,
  QUEUE_ERROR_CODES,
  pendingQueuedMessageSchema,
  pendingQueuedMessageStatusSchema,
  queueErrorCodeSchema,
  queuedMessageViewSchema,
} from "./message-queue-schemas";

const basePending = {
  id: "q-1",
  content: [{ type: "text" as const, text: "follow-up" }],
  status: "pending" as const,
  enqueuedAt: "2026-06-07T00:00:00.000Z",
  updatedAt: "2026-06-07T00:00:00.000Z",
  deliveryStartedAt: null,
  deliveredAt: null,
  cancelledAt: null,
  failedAt: null,
  deliveryAttemptId: null,
  attemptCount: 0,
  error: null,
};

describe("pendingQueuedMessageStatusSchema", () => {
  it("accepts each of the five lifecycle values", () => {
    for (const value of [
      "pending",
      "delivering",
      "delivered",
      "failed",
      "cancelled",
    ]) {
      expect(pendingQueuedMessageStatusSchema.safeParse(value).success).toBe(
        true,
      );
    }
  });

  it("rejects an unknown status value", () => {
    expect(pendingQueuedMessageStatusSchema.safeParse("queued").success).toBe(
      false,
    );
    expect(pendingQueuedMessageStatusSchema.safeParse("done").success).toBe(
      false,
    );
  });

  it("exposes the five statuses in lifecycle order", () => {
    expect(PENDING_QUEUED_MESSAGE_STATUSES).toEqual([
      "pending",
      "delivering",
      "delivered",
      "failed",
      "cancelled",
    ]);
  });
});

describe("pendingQueuedMessageSchema", () => {
  it("parses a representative pending entry", () => {
    const result = pendingQueuedMessageSchema.safeParse(basePending);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("pending");
      expect(result.data.content[0]).toEqual({
        type: "text",
        text: "follow-up",
      });
      expect(result.data.deliveryAttemptId).toBeNull();
      expect(result.data.attemptCount).toBe(0);
    }
  });

  it("parses a delivered entry carrying lifecycle timestamps and attempt id", () => {
    const result = pendingQueuedMessageSchema.safeParse({
      ...basePending,
      status: "delivered",
      updatedAt: "2026-06-07T00:00:02.000Z",
      deliveryStartedAt: "2026-06-07T00:00:01.000Z",
      deliveredAt: "2026-06-07T00:00:02.000Z",
      deliveryAttemptId: "attempt-1",
      attemptCount: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deliveryAttemptId).toBe("attempt-1");
      expect(result.data.deliveredAt).toBe("2026-06-07T00:00:02.000Z");
    }
  });

  it("parses a failed entry carrying an error string", () => {
    const result = pendingQueuedMessageSchema.safeParse({
      ...basePending,
      status: "failed",
      failedAt: "2026-06-07T00:00:03.000Z",
      attemptCount: 2,
      error: "backend rejected input",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error).toBe("backend rejected input");
    }
  });

  it("accepts an image content block in the queued content array", () => {
    const result = pendingQueuedMessageSchema.safeParse({
      ...basePending,
      content: [
        { type: "text" as const, text: "look at this" },
        {
          type: "image" as const,
          mediaType: "image/png",
          base64Data: "AAAA",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an entry with an unknown status", () => {
    const result = pendingQueuedMessageSchema.safeParse({
      ...basePending,
      status: "queued",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an entry missing a required lifecycle field", () => {
    const partial: Record<string, unknown> = { ...basePending };
    delete partial.deliveryAttemptId;
    expect(pendingQueuedMessageSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects an entry whose attemptCount is negative", () => {
    expect(
      pendingQueuedMessageSchema.safeParse({ ...basePending, attemptCount: -1 })
        .success,
    ).toBe(false);
  });
});

describe("queuedMessageViewSchema", () => {
  const baseView = {
    id: "q-1",
    content: [{ type: "text" as const, text: "follow-up" }],
    status: "pending" as const,
    enqueuedAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
    error: null,
  };

  it("parses a representative pending view", () => {
    const result = queuedMessageViewSchema.safeParse(baseView);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("q-1");
      expect(result.data.status).toBe("pending");
    }
  });

  it("parses a failed view carrying an error", () => {
    const result = queuedMessageViewSchema.safeParse({
      ...baseView,
      status: "failed",
      failedAt: "2026-06-07T00:00:03.000Z",
      error: "backend rejected input",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error).toBe("backend rejected input");
    }
  });

  it("rejects a view with an unknown status", () => {
    expect(
      queuedMessageViewSchema.safeParse({ ...baseView, status: "queued" })
        .success,
    ).toBe(false);
  });

  it("derives a pending message into a valid view shape", () => {
    const parsed = pendingQueuedMessageSchema.parse(basePending);
    const view = {
      id: parsed.id,
      content: parsed.content,
      status: parsed.status,
      enqueuedAt: parsed.enqueuedAt,
      updatedAt: parsed.updatedAt,
      deliveredAt: parsed.deliveredAt,
      cancelledAt: parsed.cancelledAt,
      failedAt: parsed.failedAt,
      error: parsed.error,
    };
    expect(queuedMessageViewSchema.safeParse(view).success).toBe(true);
  });
});

describe("queueErrorCodeSchema", () => {
  it("accepts each of the five queue error codes", () => {
    for (const value of [
      "EMPTY_MESSAGE",
      "NOT_RUNNING",
      "NON_INTERACTIVE_CONVERSATION",
      "UNSUPPORTED_BACKEND",
      "NOT_CANCELLABLE",
    ]) {
      expect(queueErrorCodeSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rejects an unknown error code", () => {
    expect(queueErrorCodeSchema.safeParse("INTERNAL_ERROR").success).toBe(
      false,
    );
    expect(queueErrorCodeSchema.safeParse("empty_message").success).toBe(false);
  });

  it("exposes the five error codes", () => {
    expect(QUEUE_ERROR_CODES).toEqual([
      "EMPTY_MESSAGE",
      "NOT_RUNNING",
      "NON_INTERACTIVE_CONVERSATION",
      "UNSUPPORTED_BACKEND",
      "NOT_CANCELLABLE",
    ]);
  });
});
