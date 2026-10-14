import { describe, it, expect, vi, beforeEach } from "vitest";
import { queueMessage, type QueueMessageDeps } from "./queue";
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
    metadata: null,
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
  markUncertain: async () => {},
  getRuntime: getRuntimeMock,
  getProjectDisplayName: getProjectDisplayNameMock,
  queueCapabilityForBackend: queueCapabilityForBackendMock,
  core: undefined,
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
      backend: "codex",
      content: [{ type: "text", text: "follow up" }],
    });
    expect(appendTranscriptEntryMock).not.toHaveBeenCalled();
    expect(claimLiveDeliveryMock).not.toHaveBeenCalled();
    expect(getRuntimeMock).not.toHaveBeenCalled();
    expect(result.deliveryTiming).toBe("next_turn");
    expect(result.entry.id).toBe("msg-1");
  });

  it("passes the complete model selection into durable enqueue", async () => {
    queueCapabilityForBackendMock.mockReturnValue({
      acceptsWhileRunning: true,
      deliveryTiming: "next_turn",
    });
    const modelSelection = {
      modelId: "gpt-5.6-sol",
      parameters: { reasoning: "ultra", fast: "true" },
    };

    await queueMessage({
      ...baseParams,
      text: "follow up",
      backend: "codex",
      modelSelection,
      deps,
    });

    expect(enqueueMock).toHaveBeenCalledWith({
      ...baseParams,
      backend: "codex",
      content: [{ type: "text", text: "follow up" }],
      modelSelection,
    });
  });

  it("persists a document_feedback block (and no duplicate prose block) for a feedback message", async () => {
    queueCapabilityForBackendMock.mockReturnValue({
      acceptsWhileRunning: true,
      deliveryTiming: "next_turn",
    });

    const documentFeedback = {
      items: [
        {
          docPath: "design.md",
          path: "design.md",
          headingLabel: "Intro",
          line: 4,
          quote: "the passage",
          note: "reconsider",
        },
      ],
    };

    await queueMessage({
      ...baseParams,
      text: "Document feedback:\n\nderivable prose",
      documentFeedback,
      backend: "codex",
      deps,
    });

    // The durable entry carries the structured card, NOT the derivable prose
    // text block (avoids duplicate display + the drain re-derives the prose).
    expect(enqueueMock).toHaveBeenCalledWith({
      ...baseParams,
      backend: "codex",
      content: [{ type: "document_feedback", items: documentFeedback.items }],
    });
  });
});

// ===========================================================================
// D5: notepad references expand to full content on the delivery path only
// ===========================================================================

describe("queueMessage for a conversation the core runs", () => {
  const coreRuntimeInput = vi.fn();
  type CoreDeps = NonNullable<QueueMessageDeps["core"]>;
  function coreDeps(overrides: Partial<CoreDeps> = {}): QueueMessageDeps {
    return {
      ...deps,
      core: {
        owns: async () => true,
        acceptsLive: async () => true,
        deliverLive: async () => "accepted",
        ...overrides,
      },
    };
  }

  beforeEach(() => {
    queueCapabilityForBackendMock.mockReturnValue({
      acceptsWhileRunning: true,
      deliveryTiming: "in_turn",
    });
    claimLiveDeliveryMock.mockResolvedValue(
      makePendingEntry({
        status: "delivering",
        deliveryAttemptId: "att-9",
        inputOrigin: "user",
        content: [
          { type: "text", text: "also this" },
          { type: "image", mediaType: "image/png", base64Data: "AAAA" },
        ],
      }),
    );
    // The core's runtime is in the shared registry; the queue must not steer it itself.
    getRuntimeMock.mockReturnValue({ queueUserInput: coreRuntimeInput });
  });

  it("hands the claimed row to the core's running turn, as the next-turn drain reads it", async () => {
    const delivered: unknown[] = [];
    const result = await queueMessage({
      ...baseParams,
      text: "also this",
      images: [makeImage()],
      backend: "codex",
      deps: coreDeps({
        async deliverLive(identity, request) {
          delivered.push({ identity, request });
          return "accepted";
        },
      }),
    });

    expect(delivered).toEqual([
      {
        identity: {
          projectPath: baseParams.projectPath,
          storeSessionName: baseParams.sessionName,
          conversationId: baseParams.conversationId,
        },
        request: {
          kind: "user_message",
          text: "also this",
          images: [
            {
              attachmentId: "queued-0",
              mediaType: "image/png",
              base64Data: "AAAA",
            },
          ],
          inputOrigin: "user",
          queuedDelivery: { messageIds: ["msg-1"], deliveryAttemptId: "att-9" },
        },
      },
    ]);
    expect(coreRuntimeInput).not.toHaveBeenCalled();
    expect(appendTranscriptEntryMock).not.toHaveBeenCalled();
    expect(markDeliveredMock).not.toHaveBeenCalled();
    expect(markPendingMock).not.toHaveBeenCalled();
    expect(result.deliveryTiming).toBe("in_turn");
  });

  it("leaves the row pending, unclaimed, when the core's running turn cannot take it", async () => {
    const deliverLive = vi.fn();
    const result = await queueMessage({
      ...baseParams,
      text: "later",
      backend: "claude",
      deps: coreDeps({ acceptsLive: async () => false, deliverLive }),
    });

    expect(claimLiveDeliveryMock).not.toHaveBeenCalled();
    expect(deliverLive).not.toHaveBeenCalled();
    expect(coreRuntimeInput).not.toHaveBeenCalled();
    expect(result.deliveryTiming).toBe("next_turn");
  });

  it("reports an unsent delivery as next turn and an uncertain one as held for review", async () => {
    const returned = await queueMessage({
      ...baseParams,
      text: "one",
      backend: "codex",
      deps: coreDeps({ deliverLive: async () => "not_sent" }),
    });
    expect(returned.deliveryTiming).toBe("next_turn");

    const held = await queueMessage({
      ...baseParams,
      text: "two",
      backend: "codex",
      deps: coreDeps({ deliverLive: async () => "uncertain" }),
    });
    expect(held).toMatchObject({
      deliveryTiming: "in_turn",
      entry: { status: "uncertain" },
    });
  });

  it("leaves a queued message for the next turn when the core cannot say whether its turn takes it", async () => {
    const failing = async (): Promise<boolean> => {
      throw new Error("database is locked");
    };
    for (const core of [
      coreDeps({ owns: failing }),
      coreDeps({ acceptsLive: failing }),
    ]) {
      const result = await queueMessage({
        ...baseParams,
        text: "saved",
        backend: "codex",
        deps: core,
      });
      expect(result.deliveryTiming).toBe("next_turn");
    }
    expect(claimLiveDeliveryMock).not.toHaveBeenCalled();
    expect(coreRuntimeInput).not.toHaveBeenCalled();
  });

  it("returns the claimed row to the queue when the core cannot be reached", async () => {
    const result = await queueMessage({
      ...baseParams,
      text: "orphan",
      backend: "codex",
      deps: coreDeps({
        deliverLive: async () => {
          throw new Error("Run supervision is not running");
        },
      }),
    });

    expect(markPendingMock).toHaveBeenCalledWith({
      ...baseParams,
      ids: ["msg-1"],
      deliveryAttemptId: "att-9",
      error: "Run supervision is not running",
    });
    expect(result.deliveryTiming).toBe("next_turn");
  });
});
