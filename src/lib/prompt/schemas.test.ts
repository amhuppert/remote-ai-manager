import { describe, expect, it } from "vitest";

import type { ImagePayload } from "@/lib/images/schemas";
import type { QueuedMessageView } from "@/lib/conversations/message-queue-schemas";

import {
  queueCancellationResponseSchema,
  queueEnqueueRequestSchema,
  queueEnqueueResponseSchema,
  runPromptRequestSchema,
} from "./schemas";

const sampleImage: ImagePayload = {
  attachmentId: "att-1",
  mediaType: "image/png",
  base64Data: "aGVsbG8=",
};

const sampleFeedback = {
  items: [
    {
      docPath: "design.md",
      path: "design.md",
      headingLabel: "Intro",
      line: 3,
      quote: "the passage",
      note: "reconsider",
    },
  ],
};

describe("queueEnqueueRequestSchema", () => {
  it("rejects an empty body with neither text nor images", () => {
    const result = queueEnqueueRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only text with no images", () => {
    const result = queueEnqueueRequestSchema.safeParse({ text: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts a text-only body", () => {
    const result = queueEnqueueRequestSchema.safeParse({ text: "hi" });
    expect(result.success).toBe(true);
  });

  it("preserves the exact pending-prompt ownership token", () => {
    const result = queueEnqueueRequestSchema.parse({
      text: "hi",
      submittedPendingPromptText: "  hi  ",
    });
    expect(result.submittedPendingPromptText).toBe("  hi  ");
  });

  it("accepts an image-only body", () => {
    const result = queueEnqueueRequestSchema.safeParse({
      images: [sampleImage],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a text+image body", () => {
    const result = queueEnqueueRequestSchema.safeParse({
      text: "hi",
      images: [sampleImage],
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than five images", () => {
    const result = queueEnqueueRequestSchema.safeParse({
      images: Array.from({ length: 6 }, () => sampleImage),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a documentFeedback-only body (no text or images)", () => {
    const result = queueEnqueueRequestSchema.safeParse({
      documentFeedback: sampleFeedback,
    });
    expect(result.success).toBe(true);
  });

  it("carries documentFeedback alongside text", () => {
    const result = queueEnqueueRequestSchema.safeParse({
      text: "feedback prose",
      documentFeedback: sampleFeedback,
    });
    expect(result.success && result.data.documentFeedback).toEqual(
      sampleFeedback,
    );
  });
});

describe("runPromptRequestSchema documentFeedback", () => {
  it("accepts an explicit Codex fast-mode selection", () => {
    expect(
      runPromptRequestSchema.parse({
        prompt: "ship it",
        codexFastMode: true,
      }).codexFastMode,
    ).toBe(true);
    expect(
      runPromptRequestSchema.parse({
        prompt: "take the standard route",
        codexFastMode: false,
      }).codexFastMode,
    ).toBe(false);
  });

  it("rejects a non-boolean Codex fast-mode selection", () => {
    expect(
      runPromptRequestSchema.safeParse({
        prompt: "ship it",
        codexFastMode: "fast",
      }).success,
    ).toBe(false);
  });

  it("preserves the exact pending-prompt ownership token while trimming the dispatched prompt", () => {
    const result = runPromptRequestSchema.parse({
      prompt: "  hi  ",
      submittedPendingPromptText: "  hi  ",
    });
    expect(result.prompt).toBe("hi");
    expect(result.submittedPendingPromptText).toBe("  hi  ");
  });

  it("accepts a documentFeedback-only body with empty prompt", () => {
    const result = runPromptRequestSchema.safeParse({
      prompt: "",
      documentFeedback: sampleFeedback,
    });
    expect(result.success).toBe(true);
  });

  it("still rejects a body with empty prompt, no images, and no feedback", () => {
    const result = runPromptRequestSchema.safeParse({ prompt: "" });
    expect(result.success).toBe(false);
  });

  it("carries documentFeedback alongside prompt text", () => {
    const result = runPromptRequestSchema.safeParse({
      prompt: "feedback prose",
      documentFeedback: sampleFeedback,
    });
    expect(result.success && result.data.documentFeedback).toEqual(
      sampleFeedback,
    );
  });
});

describe("queueEnqueueResponseSchema", () => {
  const view: QueuedMessageView = {
    id: "q-1",
    content: [{ type: "text", text: "hi" }],
    status: "pending",
    enqueuedAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
    error: null,
    metadata: null,
  };

  it("accepts a valid enqueue response", () => {
    const result = queueEnqueueResponseSchema.safeParse({
      queued: true,
      message: view,
      deliveryTiming: "in_turn",
    });
    expect(result.success).toBe(true);
  });

  it("accepts the next_turn delivery timing", () => {
    const result = queueEnqueueResponseSchema.safeParse({
      queued: true,
      message: view,
      deliveryTiming: "next_turn",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response with queued !== true", () => {
    const result = queueEnqueueResponseSchema.safeParse({
      queued: false,
      message: view,
      deliveryTiming: "in_turn",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown delivery timing", () => {
    const result = queueEnqueueResponseSchema.safeParse({
      queued: true,
      message: view,
      deliveryTiming: "eventually",
    });
    expect(result.success).toBe(false);
  });
});

describe("queueCancellationResponseSchema", () => {
  it("accepts a valid cancellation response", () => {
    const result = queueCancellationResponseSchema.safeParse({
      cancelled: true,
      id: "q-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a cancellation response with cancelled !== true", () => {
    const result = queueCancellationResponseSchema.safeParse({
      cancelled: false,
      id: "q-1",
    });
    expect(result.success).toBe(false);
  });
});
