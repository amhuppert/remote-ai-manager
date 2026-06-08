import { describe, it, expect } from "vitest";
import {
  messageQueuedEventSchema,
  messageQueueUpdatedEventSchema,
  type MessageQueuedEvent,
  type MessageQueueUpdatedEvent,
} from "@/lib/conversations/schemas";
import type { QueuedMessageView } from "@/lib/conversations/message-queue-schemas";
import type { SSEEvent } from "./sse-events";

const sampleQueuedMessageView: QueuedMessageView = {
  id: "q1",
  content: [{ type: "text", text: "follow up" }],
  status: "pending",
  enqueuedAt: "2026-06-07T00:00:00.000Z",
  updatedAt: "2026-06-07T00:00:00.000Z",
  deliveredAt: null,
  cancelledAt: null,
  failedAt: null,
  error: null,
};

describe("SSEEvent union — queue events", () => {
  it("includes the queue-created (message-queued) event and validates a sample payload", () => {
    const sample: MessageQueuedEvent = {
      type: "message-queued",
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
      text: "follow up",
      message: sampleQueuedMessageView,
    };

    // Compile-time inclusion proof: a MessageQueuedEvent is assignable to SSEEvent.
    const asUnion: SSEEvent = sample;
    expect(asUnion.type).toBe("message-queued");

    const parsed = messageQueuedEventSchema.safeParse(sample);
    expect(parsed.success).toBe(true);
  });

  it("includes the queue-updated (message-queue-updated) event and validates a sample payload", () => {
    const sample: MessageQueueUpdatedEvent = {
      type: "message-queue-updated",
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
      message: sampleQueuedMessageView,
    };

    // Compile-time inclusion proof: a MessageQueueUpdatedEvent is assignable to SSEEvent.
    const asUnion: SSEEvent = sample;
    expect(asUnion.type).toBe("message-queue-updated");

    const parsed = messageQueueUpdatedEventSchema.safeParse(sample);
    expect(parsed.success).toBe(true);
  });
});
