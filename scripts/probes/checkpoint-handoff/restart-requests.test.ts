import { describe, expect, it } from "vitest";
import { queueEnqueueRequestSchema } from "@/lib/prompt/schemas";
import {
  restartQueueRequest,
  restartQueuedMessageId,
} from "./restart-requests";

describe("restart fixture queue route contract", () => {
  it("constructs a request admitted by the actual strict queue schema", () => {
    const parsed = queueEnqueueRequestSchema.safeParse(restartQueueRequest());
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.text).toContain("RESTART-QUEUED-DELIVERED");
  });
  it("reads the durable message id from the production response projection", () => {
    expect(
      restartQueuedMessageId({
        queued: true,
        deliveryTiming: "next_turn",
        message: {
          id: "queue-id",
          content: [{ type: "text", text: "queued" }],
          status: "pending",
          enqueuedAt: "2026-09-18T00:00:00Z",
          updatedAt: "2026-09-18T00:00:00Z",
          deliveredAt: null,
          cancelledAt: null,
          failedAt: null,
          error: null,
          metadata: null,
        },
      }),
    ).toBe("queue-id");
    expect(() =>
      restartQueuedMessageId({
        code: "EMPTY_MESSAGE",
        message: { id: "not-a-queue-receipt" },
      }),
    ).toThrow();
  });
});
