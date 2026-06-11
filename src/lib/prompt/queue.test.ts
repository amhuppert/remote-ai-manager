import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  queueMessage,
  buildQueueContent,
  type QueueMessageDeps,
} from "./queue";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import type { ImagePayload } from "@/lib/images/schemas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePendingEntry(
  overrides: Partial<PendingQueuedMessage> = {},
): PendingQueuedMessage {
  return {
    id: "msg-1",
    content: [{ type: "text", text: "hello" }],
    status: "pending",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deliveryStartedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
    deliveryAttemptId: null,
    attemptCount: 0,
    error: null,
    ...overrides,
  };
}

function makeImage(overrides: Partial<ImagePayload> = {}): ImagePayload {
  return {
    attachmentId: "att-1",
    mediaType: "image/png",
    base64Data: "AAAA",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock of internal modules)
// ---------------------------------------------------------------------------

const enqueueMock = vi.fn();
const claimLiveDeliveryMock = vi.fn();
const markDeliveredMock = vi.fn();
const markPendingMock = vi.fn();
const getRuntimeMock = vi.fn();
const appendTranscriptEntryMock = vi.fn();
const saveTranscriptImageMock = vi.fn();
const getNextImageIndexMock = vi.fn();
const getProjectDisplayNameMock = vi.fn();
const queueCapabilityForBackendMock = vi.fn();

const deps: QueueMessageDeps = {
  enqueue: enqueueMock,
  claimLiveDelivery: claimLiveDeliveryMock,
  markDelivered: markDeliveredMock,
  markPending: markPendingMock,
  getRuntime: getRuntimeMock,
  appendTranscriptEntry: appendTranscriptEntryMock,
  saveTranscriptImage: saveTranscriptImageMock,
  getNextImageIndex: getNextImageIndexMock,
  getProjectDisplayName: getProjectDisplayNameMock,
  queueCapabilityForBackend: queueCapabilityForBackendMock,
};

const baseParams = {
  projectPath: "/repos/my-project",
  sessionName: "my-session",
  conversationId: "conv-123",
};

beforeEach(() => {
  vi.clearAllMocks();
  enqueueMock.mockResolvedValue(makePendingEntry());
  appendTranscriptEntryMock.mockResolvedValue(undefined);
  markDeliveredMock.mockResolvedValue(undefined);
  markPendingMock.mockResolvedValue(undefined);
  saveTranscriptImageMock.mockResolvedValue("/disk/images/conv-123/1.png");
  getNextImageIndexMock.mockResolvedValue(1);
  getProjectDisplayNameMock.mockReturnValue("my-project");
});

// ===========================================================================
// buildQueueContent (pure)
// ===========================================================================

describe("buildQueueContent", () => {
  it("builds a single text block from text only", () => {
    expect(buildQueueContent({ text: "hello world" })).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("builds image blocks from images only (no text block)", () => {
    const images: ImagePayload[] = [
      makeImage({
        attachmentId: "a",
        mediaType: "image/png",
        base64Data: "X1",
      }),
      makeImage({
        attachmentId: "b",
        mediaType: "image/jpeg",
        base64Data: "X2",
      }),
    ];
    expect(buildQueueContent({ images })).toEqual([
      { type: "image", mediaType: "image/png", base64Data: "X1" },
      { type: "image", mediaType: "image/jpeg", base64Data: "X2" },
    ]);
  });

  it("builds text block(s) before image blocks for text+images", () => {
    const images: ImagePayload[] = [
      makeImage({
        attachmentId: "a",
        mediaType: "image/gif",
        base64Data: "G1",
      }),
    ];
    expect(buildQueueContent({ text: "caption", images })).toEqual([
      { type: "text", text: "caption" },
      { type: "image", mediaType: "image/gif", base64Data: "G1" },
    ]);
  });

  it("omits an empty text block", () => {
    expect(buildQueueContent({ text: "" })).toEqual([]);
    expect(buildQueueContent({})).toEqual([]);
  });
});

// ===========================================================================
// queueMessage — next_turn (durable enqueue, no live delivery)
// ===========================================================================

describe("queueMessage next_turn", () => {
  it("durably enqueues without writing a transcript entry", async () => {
    queueCapabilityForBackendMock.mockReturnValue({
      acceptsWhileRunning: true,
      deliveryTiming: "next_turn",
    });

    const result = await queueMessage({
      ...baseParams,
      text: "follow up",
      backend: "codex",
      deps,
    });

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith({
      ...baseParams,
      content: [{ type: "text", text: "follow up" }],
    });
    expect(appendTranscriptEntryMock).not.toHaveBeenCalled();
    expect(claimLiveDeliveryMock).not.toHaveBeenCalled();
    expect(getRuntimeMock).not.toHaveBeenCalled();
    expect(result.deliveryTiming).toBe("next_turn");
    expect(result.entry.id).toBe("msg-1");
  });
});

// ===========================================================================
// queueMessage — in_turn live delivery
// ===========================================================================

describe("queueMessage in_turn", () => {
  beforeEach(() => {
    queueCapabilityForBackendMock.mockReturnValue({
      acceptsWhileRunning: true,
      deliveryTiming: "in_turn",
    });
    claimLiveDeliveryMock.mockResolvedValue(
      makePendingEntry({ status: "delivering", deliveryAttemptId: "att-9" }),
    );
  });

  it("confirms delivery: claim -> queueUserInput -> append (once) -> markDelivered", async () => {
    const order: string[] = [];
    const queueUserInputMock = vi.fn().mockImplementation(async () => {
      order.push("queueUserInput");
    });
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });
    claimLiveDeliveryMock.mockImplementation(async () => {
      order.push("claim");
      return makePendingEntry({
        status: "delivering",
        deliveryAttemptId: "att-9",
      });
    });
    appendTranscriptEntryMock.mockImplementation(async () => {
      order.push("append");
    });
    markDeliveredMock.mockImplementation(async () => {
      order.push("markDelivered");
    });

    const result = await queueMessage({
      ...baseParams,
      text: "live message",
      backend: "claude",
      deps,
    });

    expect(order).toEqual([
      "claim",
      "queueUserInput",
      "append",
      "markDelivered",
    ]);

    expect(queueUserInputMock).toHaveBeenCalledWith({
      content: [{ type: "text", text: "live message" }],
    });
    expect(appendTranscriptEntryMock).toHaveBeenCalledTimes(1);
    expect(markDeliveredMock).toHaveBeenCalledWith({
      ...baseParams,
      ids: ["msg-1"],
      deliveryAttemptId: "att-9",
    });
    expect(markPendingMock).not.toHaveBeenCalled();
    expect(result.deliveryTiming).toBe("in_turn");
  });

  it("appends a user transcript entry with project/session meta", async () => {
    const queueUserInputMock = vi.fn().mockResolvedValue(undefined);
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    await queueMessage({
      ...baseParams,
      text: "live message",
      backend: "claude",
      deps,
    });

    expect(appendTranscriptEntryMock).toHaveBeenCalledWith(
      "conv-123",
      expect.objectContaining({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "live message" }],
      }),
      undefined,
      { projectName: "my-project", sessionName: "my-session" },
    );
  });

  it("persists images and writes image_ref blocks (no base64 in transcript)", async () => {
    const queueUserInputMock = vi.fn().mockResolvedValue(undefined);
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });
    getNextImageIndexMock.mockResolvedValue(3);
    saveTranscriptImageMock.mockResolvedValue("/disk/conv-123/3.png");

    await queueMessage({
      ...baseParams,
      text: "see this",
      images: [makeImage({ base64Data: "BIN", mediaType: "image/png" })],
      backend: "claude",
      deps,
    });

    // Runtime gets the base64 image block.
    expect(queueUserInputMock).toHaveBeenCalledWith({
      content: [
        { type: "text", text: "see this" },
        { type: "image", mediaType: "image/png", base64Data: "BIN" },
      ],
    });

    // Image persisted at the next cumulative index.
    expect(saveTranscriptImageMock).toHaveBeenCalledWith(
      "conv-123",
      3,
      "image/png",
      "BIN",
    );

    // Transcript carries an image_ref (path) — never base64.
    const appendArgs = appendTranscriptEntryMock.mock.calls[0];
    expect(appendArgs).toBeDefined();
    const entry = appendArgs![1] as { content: Array<{ type: string }> };
    const serialized = JSON.stringify(entry.content);
    expect(serialized).not.toContain("BIN");
    expect(entry.content).toContainEqual({
      type: "image_ref",
      mediaType: "image/png",
      imagePath: "/disk/conv-123/3.png",
    });
  });

  it("leaves the row pending on live-delivery failure and does not throw or append", async () => {
    const queueUserInputMock = vi
      .fn()
      .mockRejectedValue(new Error("stream closed"));
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    const result = await queueMessage({
      ...baseParams,
      text: "live message",
      backend: "claude",
      deps,
    });

    expect(markPendingMock).toHaveBeenCalledWith({
      ...baseParams,
      ids: ["msg-1"],
      deliveryAttemptId: "att-9",
      error: "stream closed",
    });
    expect(appendTranscriptEntryMock).not.toHaveBeenCalled();
    expect(markDeliveredMock).not.toHaveBeenCalled();
    expect(result.deliveryTiming).toBe("in_turn");
  });

  it("marks pending when there is no live runtime", async () => {
    getRuntimeMock.mockReturnValue(undefined);

    const result = await queueMessage({
      ...baseParams,
      text: "live message",
      backend: "claude",
      deps,
    });

    expect(markPendingMock).toHaveBeenCalledWith({
      ...baseParams,
      ids: ["msg-1"],
      deliveryAttemptId: "att-9",
      error: expect.stringContaining("no live runtime"),
    });
    expect(appendTranscriptEntryMock).not.toHaveBeenCalled();
    expect(result.deliveryTiming).toBe("in_turn");
  });

  it("marks pending when the runtime cannot queue input", async () => {
    getRuntimeMock.mockReturnValue({ queueUserInput: undefined });

    await queueMessage({
      ...baseParams,
      text: "live message",
      backend: "claude",
      deps,
    });

    expect(markPendingMock).toHaveBeenCalledTimes(1);
    expect(appendTranscriptEntryMock).not.toHaveBeenCalled();
  });

  it("never live-delivers a /commit command: row stays pending for next-turn handling", async () => {
    const queueUserInputMock = vi.fn().mockResolvedValue(undefined);
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });
    enqueueMock.mockResolvedValue(
      makePendingEntry({ content: [{ type: "text", text: "/commit" }] }),
    );

    const result = await queueMessage({
      ...baseParams,
      text: "/commit",
      backend: "claude",
      deps,
    });

    expect(enqueueMock).toHaveBeenCalledWith({
      ...baseParams,
      content: [{ type: "text", text: "/commit" }],
    });
    expect(claimLiveDeliveryMock).not.toHaveBeenCalled();
    expect(queueUserInputMock).not.toHaveBeenCalled();
    expect(appendTranscriptEntryMock).not.toHaveBeenCalled();
    expect(markDeliveredMock).not.toHaveBeenCalled();
    expect(markPendingMock).not.toHaveBeenCalled();
    expect(result.entry.status).toBe("pending");
    expect(result.deliveryTiming).toBe("next_turn");
  });

  it("never live-delivers a /merge command with hint text", async () => {
    const queueUserInputMock = vi.fn().mockResolvedValue(undefined);
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    const result = await queueMessage({
      ...baseParams,
      text: "/merge focus on the schema change",
      backend: "claude",
      deps,
    });

    expect(claimLiveDeliveryMock).not.toHaveBeenCalled();
    expect(queueUserInputMock).not.toHaveBeenCalled();
    expect(result.deliveryTiming).toBe("next_turn");
  });

  it("still live-delivers near-miss command text like /committed", async () => {
    const queueUserInputMock = vi.fn().mockResolvedValue(undefined);
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    const result = await queueMessage({
      ...baseParams,
      text: "/committed the fix already",
      backend: "claude",
      deps,
    });

    expect(queueUserInputMock).toHaveBeenCalledWith({
      content: [{ type: "text", text: "/committed the fix already" }],
    });
    expect(result.deliveryTiming).toBe("in_turn");
  });

  it("returns without delivering when the claim is lost (row no longer pending)", async () => {
    claimLiveDeliveryMock.mockResolvedValue(null);
    const queueUserInputMock = vi.fn().mockResolvedValue(undefined);
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    const result = await queueMessage({
      ...baseParams,
      text: "live message",
      backend: "claude",
      deps,
    });

    expect(queueUserInputMock).not.toHaveBeenCalled();
    expect(appendTranscriptEntryMock).not.toHaveBeenCalled();
    expect(markDeliveredMock).not.toHaveBeenCalled();
    expect(markPendingMock).not.toHaveBeenCalled();
    expect(result.deliveryTiming).toBe("in_turn");
  });
});
