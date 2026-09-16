import type { ConversationQueuedUserInput } from "@/lib/agent-backends/conversation";
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
const readNotepadForInjectionMock = vi.fn(async () => null);
const recordNotepadDeliveriesMock = vi.fn(async () => {});
const prepareNotepadChangeNoticeMock = vi.fn(
  async (conversationId: string) => ({
    conversationId,
    block: null as string | null,
    advances: [],
  }),
);
const settleNotepadChangeNoticeMock = vi.fn(async () => {});

const deps: QueueMessageDeps = {
  enqueue: enqueueMock,
  claimLiveDelivery: claimLiveDeliveryMock,
  markDelivered: markDeliveredMock,
  markPending: markPendingMock,
  markUncertain: async () => {},
  getRuntime: getRuntimeMock,
  appendTranscriptEntry: appendTranscriptEntryMock,
  saveTranscriptImage: saveTranscriptImageMock,
  getNextImageIndex: getNextImageIndexMock,
  getProjectDisplayName: getProjectDisplayNameMock,
  queueCapabilityForBackend: queueCapabilityForBackendMock,
  readLiveReference: async () => null,
  readNotepadForInjection: readNotepadForInjectionMock,
  recordNotepadDeliveries: recordNotepadDeliveriesMock,
  prepareNotepadChangeNotice: prepareNotepadChangeNoticeMock,
  settleNotepadChangeNotice: settleNotepadChangeNoticeMock,
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

  it("appends a document_feedback block after text/image blocks", () => {
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
    expect(buildQueueContent({ documentFeedback })).toEqual([
      { type: "document_feedback", items: documentFeedback.items },
    ]);
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

  it("an answer row (consumePendingQuestionId) is never live-delivered — answers arrive as the next turn", async () => {
    // The backend capability says in_turn and a live runtime exists — a typed
    // message would be delivered into the running turn. An answer must not be
    // (docs/design/cc-cli/03 §5): it stays pending for the next-turn drain.
    const queueUserInputMock = vi.fn();
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    const result = await queueMessage({
      ...baseParams,
      text: '<cc-question-answers batch="q_b1">{}</cc-question-answers>',
      backend: "claude",
      consumePendingQuestionId: "q_b1",
      deps,
    });

    expect(result?.deliveryTiming).toBe("next_turn");
    expect(claimLiveDeliveryMock).not.toHaveBeenCalled();
    expect(queueUserInputMock).not.toHaveBeenCalled();
    expect(appendTranscriptEntryMock).not.toHaveBeenCalled();
  });

  it("keeps a caller-deferred message pending for the next turn", async () => {
    const queueUserInputMock = vi.fn();
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    const result = await queueMessage({
      ...baseParams,
      text: "The user approved the decisions.",
      backend: "claude",
      deliveryPolicy: "next_turn",
      deps,
    });

    expect(result.deliveryTiming).toBe("next_turn");
    expect(claimLiveDeliveryMock).not.toHaveBeenCalled();
    expect(queueUserInputMock).not.toHaveBeenCalled();
    expect(appendTranscriptEntryMock).not.toHaveBeenCalled();
  });

  it("defers an explicit model selection instead of live-delivering under the active runtime selection", async () => {
    const queueUserInputMock = vi.fn();
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    const result = await queueMessage({
      ...baseParams,
      text: "use these model options",
      backend: "claude",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "max" },
      },
      deps,
    });

    expect(result.deliveryTiming).toBe("next_turn");
    expect(claimLiveDeliveryMock).not.toHaveBeenCalled();
    expect(queueUserInputMock).not.toHaveBeenCalled();
    expect(appendTranscriptEntryMock).not.toHaveBeenCalled();
  });

  it("confirms delivery: claim -> queueUserInput -> append (once) -> markDelivered", async () => {
    const order: string[] = [];
    const queueUserInputMock = vi
      .fn()
      .mockImplementation(async (input: ConversationQueuedUserInput) => {
        order.push("queueUserInput");
        await input.onAccepted?.();
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
      onAccepted: expect.any(Function),
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
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
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
      { projectName: "my-project", storeSessionName: "my-session" },
    );
  });

  it("expands an in-turn /spec command only for the backend and preserves the raw transcript", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });
    const rawPrompt = "/spec Add an operator status endpoint";

    await queueMessage({
      ...baseParams,
      text: rawPrompt,
      backend: "claude",
      deps,
    });

    expect(enqueueMock).toHaveBeenCalledWith({
      ...baseParams,
      backend: "claude",
      content: [{ type: "text", text: rawPrompt }],
    });
    expect(queueUserInputMock).toHaveBeenCalledWith({
      onAccepted: expect.any(Function),
      content: [
        {
          type: "text",
          text: expect.stringContaining("Author a native Command Center spec"),
        },
      ],
    });
    expect(appendTranscriptEntryMock).toHaveBeenCalledWith(
      "conv-123",
      expect.objectContaining({
        content: [{ type: "text", text: rawPrompt }],
      }),
      undefined,
      { projectName: "my-project", storeSessionName: "my-session" },
    );
  });

  it("delivers a feedback message as backend-safe prose (no document_feedback block) and records the card in the transcript", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    const documentFeedback = {
      items: [
        {
          docPath: "design.md",
          path: "design.md",
          headingLabel: "Intro",
          line: 4,
          quote: "the exact passage",
          note: "reconsider this",
        },
      ],
    };

    await queueMessage({
      ...baseParams,
      text: "Document feedback:\n\nderivable prose",
      documentFeedback,
      backend: "claude",
      deps,
    });

    // The durable entry carries the structured card.
    expect(enqueueMock).toHaveBeenCalledWith({
      ...baseParams,
      backend: "claude",
      content: [{ type: "document_feedback", items: documentFeedback.items }],
    });

    // The backend receives prose text only — a document_feedback block is not a
    // valid SDK content block and must never reach queueUserInput.
    const deliveredContent = (
      queueUserInputMock.mock.calls[0]![0] as {
        content: Array<{ type: string; text?: string }>;
      }
    ).content;
    expect(deliveredContent).toHaveLength(1);
    expect(deliveredContent[0]!.type).toBe("text");
    expect(deliveredContent[0]!.text).toContain("the exact passage");
    expect(deliveredContent[0]!.text).toContain("reconsider this");
    expect(deliveredContent.some((b) => b.type === "document_feedback")).toBe(
      false,
    );

    // The transcript records the card (no duplicate prose block).
    const entry = appendTranscriptEntryMock.mock.calls[0]![1] as {
      content: unknown;
    };
    expect(entry.content).toEqual([
      { type: "document_feedback", items: documentFeedback.items },
    ]);
  });

  it("delivers a notepad dispatch as backend-safe prose and records the typed block in the transcript", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    const notepadFeedback = {
      notepadId: "np-1",
      notepadName: "Release plan",
      notepadRefXml:
        '<notepad-ref notepad-id="np-1" name="Release plan" scope="global" read-command="cctl notepad get np-1" />',
      items: [
        {
          commentId: "c-1",
          location: "§ Rollout · L12",
          quote: "ship on Friday",
          body: "deploys are frozen on Friday",
        },
      ],
    };
    const expectedBlock = { type: "notepad_feedback", ...notepadFeedback };

    await queueMessage({
      ...baseParams,
      text: "Notepad review comments:\n\nderivable prose",
      notepadFeedback,
      backend: "claude",
      deps,
    });

    // The durable entry carries the typed block, not the derivable prose.
    expect(enqueueMock).toHaveBeenCalledWith({
      ...baseParams,
      backend: "claude",
      content: [expectedBlock],
    });

    // The backend receives prose text only — a notepad_feedback block is not a
    // valid SDK content block and must never reach queueUserInput.
    const deliveredContent = (
      queueUserInputMock.mock.calls[0]![0] as {
        content: Array<{ type: string; text?: string }>;
      }
    ).content;
    expect(deliveredContent).toHaveLength(1);
    expect(deliveredContent[0]!.type).toBe("text");
    expect(deliveredContent[0]!.text).toContain("§ Rollout · L12");
    expect(deliveredContent[0]!.text).toContain("ship on Friday");
    expect(deliveredContent[0]!.text).toContain("deploys are frozen on Friday");
    expect(deliveredContent[0]!.text).toContain(notepadFeedback.notepadRefXml);

    const entry = appendTranscriptEntryMock.mock.calls[0]![1] as {
      content: unknown;
    };
    expect(entry.content).toEqual([expectedBlock]);
  });

  it("persists images and writes image_ref blocks (no base64 in transcript)", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
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
      onAccepted: expect.any(Function),
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
    expect(result.deliveryTiming).toBe("next_turn");
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
    expect(result.deliveryTiming).toBe("next_turn");
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
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
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
      backend: "claude",
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
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
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
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    const result = await queueMessage({
      ...baseParams,
      text: "/committed the fix already",
      backend: "claude",
      deps,
    });

    expect(queueUserInputMock).toHaveBeenCalledWith({
      onAccepted: expect.any(Function),
      content: [{ type: "text", text: "/committed the fix already" }],
    });
    expect(result.deliveryTiming).toBe("in_turn");
  });

  it("returns without delivering when the claim is lost (row no longer pending)", async () => {
    claimLiveDeliveryMock.mockResolvedValue(null);
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
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

// ===========================================================================
// D5: notepad references expand to full content on the delivery path only
// ===========================================================================

describe("queueMessage notepad injection", () => {
  const NOTEPAD_REF =
    '<notepad-ref notepad-id="np-1" name="Design Notes" scope="global" read-command="cctl notepad get \'np-1\'" />';
  const NESTED_REF =
    '<notepad-ref notepad-id="np-2" name="Nested" scope="global" read-command="cctl notepad get \'np-2\'" />';

  function deliveredText(queueUserInputMock: ReturnType<typeof vi.fn>): string {
    const call = queueUserInputMock.mock.calls.at(-1)![0] as {
      content: Array<{ type: string; text?: string }>;
    };
    return call.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }

  function blockText(content: Array<{ type: string; text?: string }>): string {
    return content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }

  beforeEach(() => {
    queueCapabilityForBackendMock.mockReturnValue({
      acceptsWhileRunning: true,
      deliveryTiming: "in_turn",
    });
    claimLiveDeliveryMock.mockResolvedValue(
      makePendingEntry({ status: "delivering", deliveryAttemptId: "att-9" }),
    );
  });

  it("captures current entity state only at claimed live delivery and leaves queued text unchanged", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });
    const ref =
      '<ticket-ref project-name="cc" ticket-number="90" identifier="cc#90" title="Captured" read-command="cctl ticket get cc#90" />';
    await queueMessage({
      ...baseParams,
      text: ref,
      backend: "claude",
      deps: {
        ...deps,
        async readLiveReference() {
          return {
            title: "Current",
            identity: "cc#90",
            status: "Done",
            tone: "green",
            href: "/tickets/cc/90",
            readCommand: "read",
            details: [],
            attentionCount: 0,
          };
        },
      },
    });
    expect(deliveredText(queueUserInputMock)).toContain('status="Done"');
    const enqueued = enqueueMock.mock.calls.at(-1)![0] as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(blockText(enqueued.content)).toBe(ref);
  });

  it("delivers full notepad content while the durable row and transcript keep the reference", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    await queueMessage({
      ...baseParams,
      text: `Read ${NOTEPAD_REF} first.`,
      backend: "claude",
      deps: {
        ...deps,
        readNotepadForInjection: vi.fn(async (notepadId: string) =>
          notepadId === "np-1"
            ? {
                id: "np-1",
                name: "Design Notes",
                revision: 4,
                openComments: { count: 0, latestCreatedAt: null },
                writeMode: "read-only" as const,
                content: `Canonical body.\n\n[Image: img-a]\n\n${NESTED_REF}`,
              }
            : null,
        ),
      },
    });

    const delivered = deliveredText(queueUserInputMock);
    expect(delivered).toContain("id: np-1");
    expect(delivered).toContain("name: Design Notes");
    expect(delivered).toContain("revision: 4");
    expect(delivered).toContain("write-mode: read-only");
    expect(delivered).toContain("read: cctl notepad get 'np-1'");
    expect(delivered).toContain("Canonical body.");
    expect(delivered).toContain("[Image: img-a]");
    // Nested reference is delivered as a reference, not expanded content.
    expect(delivered).toContain(NESTED_REF);

    const enqueued = enqueueMock.mock.calls.at(-1)![0] as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(blockText(enqueued.content)).toBe(`Read ${NOTEPAD_REF} first.`);

    const appended = appendTranscriptEntryMock.mock.calls.at(-1)![1] as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(blockText(appended.content)).toBe(`Read ${NOTEPAD_REF} first.`);
  });

  it("injects a not-found block naming the id for a deleted notepad", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    const result = await queueMessage({
      ...baseParams,
      text: `Read ${NOTEPAD_REF}`,
      backend: "claude",
      deps: { ...deps, readNotepadForInjection: vi.fn(async () => null) },
    });

    expect(result.deliveryTiming).toBe("in_turn");
    const delivered = deliveredText(queueUserInputMock);
    expect(delivered).toContain("id: np-1");
    expect(delivered).toContain("not found");
  });

  it("delivers the un-expanded text when the notepad read fails", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    await queueMessage({
      ...baseParams,
      text: `Resilient ${NOTEPAD_REF}`,
      backend: "claude",
      deps: {
        ...deps,
        readNotepadForInjection: vi.fn(async () => {
          throw new Error("state store unavailable");
        }),
      },
    });

    expect(deliveredText(queueUserInputMock)).toBe(`Resilient ${NOTEPAD_REF}`);
  });

  it("does not read notepads for a prompt with no notepad reference", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });
    const readNotepadForInjection = vi.fn(async () => null);

    await queueMessage({
      ...baseParams,
      text: "plain message",
      backend: "claude",
      deps: { ...deps, readNotepadForInjection },
    });

    expect(readNotepadForInjection).not.toHaveBeenCalled();
    expect(deliveredText(queueUserInputMock)).toBe("plain message");
  });

  it("does not record references when in-turn delivery rejects", async () => {
    getRuntimeMock.mockReturnValue({
      queueUserInput: vi.fn().mockRejectedValue(new Error("not consumed")),
    });
    await queueMessage({
      ...baseParams,
      text: NOTEPAD_REF,
      backend: "claude",
      deps: {
        ...deps,
        readNotepadForInjection: async () => ({
          id: "np-1",
          name: "Notes",
          revision: 4,
          writeMode: "read-only",
          content: "Rendered",
          openComments: { count: 0, latestCreatedAt: null },
        }),
      },
    });
    expect(recordNotepadDeliveriesMock).not.toHaveBeenCalled();
    expect(markPendingMock).toHaveBeenCalled();
  });

  it("records the notepad as delivered to the conversation whose reference it expanded", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    await queueMessage({
      ...baseParams,
      text: `Read ${NOTEPAD_REF} first.`,
      backend: "claude",
      deps: {
        ...deps,
        readNotepadForInjection: vi.fn(async (notepadId: string) =>
          notepadId === "np-1"
            ? {
                id: "np-1",
                name: "Design Notes",
                revision: 4,
                openComments: { count: 0, latestCreatedAt: null },
                writeMode: "read-only" as const,
                content: "Canonical body.",
              }
            : null,
        ),
      },
    });

    expect(recordNotepadDeliveriesMock).toHaveBeenCalledWith({
      conversationId: baseParams.conversationId,
      notepads: [
        {
          notepadId: "np-1",
          revision: 4,
          openComments: { count: 0, latestCreatedAt: null },
        },
      ],
    });
  });

  it("records nothing when the message carried no notepad reference", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    await queueMessage({
      ...baseParams,
      text: "plain message",
      backend: "claude",
      deps,
    });

    expect(recordNotepadDeliveriesMock).not.toHaveBeenCalled();
  });

  it("records nothing for a dangling reference — a deleted notepad was never delivered", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    await queueMessage({
      ...baseParams,
      text: `Read ${NOTEPAD_REF}`,
      backend: "claude",
      deps: { ...deps, readNotepadForInjection: vi.fn(async () => null) },
    });

    expect(recordNotepadDeliveriesMock).not.toHaveBeenCalled();
  });

  describe("change notices", () => {
    const NOTICE_BLOCK = [
      "<notepad-changes>",
      "<notepad-change>",
      "id: np-1",
      "revision: 5",
      "</notepad-change>",
      "</notepad-changes>",
    ].join("\n");

    function preparedNotice() {
      return {
        conversationId: baseParams.conversationId,
        block: NOTICE_BLOCK,
        advances: [
          {
            conversationId: baseParams.conversationId,
            notepadId: "np-1",
            revision: 5,
            openComments: { count: 0, latestCreatedAt: null },
            updatedAt: "2026-08-28T12:00:00.000Z",
          },
        ],
      };
    }

    it("carries the notice a live turn would, while the durable row and transcript keep the user's text", async () => {
      const queueUserInputMock = vi.fn(
        async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
      );
      getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

      await queueMessage({
        ...baseParams,
        text: "carry on",
        backend: "claude",
        deps: {
          ...deps,
          prepareNotepadChangeNotice: vi.fn(async () => preparedNotice()),
        },
      });

      const delivered = deliveredText(queueUserInputMock);
      expect(delivered).toContain(NOTICE_BLOCK);
      expect(delivered.indexOf(NOTICE_BLOCK)).toBeLessThan(
        delivered.indexOf("carry on"),
      );

      const enqueued = enqueueMock.mock.calls.at(-1)![0] as {
        content: Array<{ type: string; text?: string }>;
      };
      expect(blockText(enqueued.content)).toBe("carry on");
      const appended = appendTranscriptEntryMock.mock.calls.at(-1)![1] as {
        content: Array<{ type: string; text?: string }>;
      };
      expect(blockText(appended.content)).toBe("carry on");
    });

    it("prepends nothing when no tracked notepad changed", async () => {
      const queueUserInputMock = vi.fn(
        async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
      );
      getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

      await queueMessage({
        ...baseParams,
        text: "carry on",
        backend: "claude",
        deps,
      });

      expect(deliveredText(queueUserInputMock)).toBe("carry on");
    });

    it("advances the watermarks only after the backend accepts the input", async () => {
      const settleNotepadChangeNotice = vi.fn(async () => {});
      const queueUserInputMock = vi
        .fn()
        .mockImplementation(async (input: ConversationQueuedUserInput) => {
          expect(settleNotepadChangeNotice).not.toHaveBeenCalled();
          await input.onAccepted?.();
        });
      getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

      await queueMessage({
        ...baseParams,
        text: "carry on",
        backend: "claude",
        deps: {
          ...deps,
          prepareNotepadChangeNotice: vi.fn(async () => preparedNotice()),
          settleNotepadChangeNotice,
        },
      });

      expect(settleNotepadChangeNotice).toHaveBeenCalledWith(preparedNotice());
    });

    it("leaves the watermarks untouched when live delivery fails", async () => {
      const settleNotepadChangeNotice = vi.fn(async () => {});
      getRuntimeMock.mockReturnValue({
        queueUserInput: vi.fn().mockRejectedValue(new Error("backend down")),
      });

      await queueMessage({
        ...baseParams,
        text: "carry on",
        backend: "claude",
        deps: {
          ...deps,
          prepareNotepadChangeNotice: vi.fn(async () => preparedNotice()),
          settleNotepadChangeNotice,
        },
      });

      expect(settleNotepadChangeNotice).not.toHaveBeenCalled();
      expect(markPendingMock).toHaveBeenCalled();
    });

    it("settles the notice even when transcript persistence fails after acceptance", async () => {
      // The acceptance callback confirms the agent has the
      // notice. Failing to write the transcript afterwards must not strand the
      // watermark and re-deliver the same notice on the next message.
      const settleNotepadChangeNotice = vi.fn(async () => {});
      getRuntimeMock.mockReturnValue({
        queueUserInput: vi.fn(async (input: ConversationQueuedUserInput) =>
          input.onAccepted?.(),
        ),
      });
      appendTranscriptEntryMock.mockRejectedValueOnce(
        new Error("transcript write failed"),
      );

      await queueMessage({
        ...baseParams,
        text: "carry on",
        backend: "claude",
        deps: {
          ...deps,
          prepareNotepadChangeNotice: vi.fn(async () => preparedNotice()),
          settleNotepadChangeNotice,
        },
      }).catch(() => {});

      expect(settleNotepadChangeNotice).toHaveBeenCalledWith(preparedNotice());
    });

    it("delivers the message without a notice when preparing one fails", async () => {
      const queueUserInputMock = vi.fn(
        async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
      );
      getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

      await queueMessage({
        ...baseParams,
        text: "carry on",
        backend: "claude",
        deps: {
          ...deps,
          prepareNotepadChangeNotice: vi.fn(async () => {
            throw new Error("state store unavailable");
          }),
        },
      });

      expect(deliveredText(queueUserInputMock)).toBe("carry on");
      expect(markDeliveredMock).toHaveBeenCalled();
    });
  });

  it("still delivers the message when recording the watermark fails", async () => {
    const queueUserInputMock = vi.fn(
      async (input: ConversationQueuedUserInput) => input.onAccepted?.(),
    );
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    await queueMessage({
      ...baseParams,
      text: `Read ${NOTEPAD_REF}`,
      backend: "claude",
      deps: {
        ...deps,
        readNotepadForInjection: vi.fn(async () => ({
          id: "np-1",
          name: "Design Notes",
          revision: 4,
          openComments: { count: 0, latestCreatedAt: null },
          writeMode: "read-only" as const,
          content: "Canonical body.",
        })),
        recordNotepadDeliveries: vi.fn(async () => {
          throw new Error("state store unavailable");
        }),
      },
    });

    expect(deliveredText(queueUserInputMock)).toContain("Canonical body.");
  });
});
