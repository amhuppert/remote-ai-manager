import { describe, it, expect, vi, beforeEach } from "vitest";
import { queueMessage, type QueueMessageDeps } from "./queue-message";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

const getQueryMock = vi.fn();
const appendTranscriptEntryMock = vi.fn();
const broadcastMock = vi.fn();

const deps: QueueMessageDeps = {
  getQuery: getQueryMock,
  appendTranscriptEntry: appendTranscriptEntryMock,
  broadcast: broadcastMock,
};

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  appendTranscriptEntryMock.mockResolvedValue(undefined);
});

// ===========================================================================
// Tests
// ===========================================================================

describe("queueMessage", () => {
  it("throws when conversation has no active query", async () => {
    getQueryMock.mockReturnValue(undefined);

    await expect(
      queueMessage({
        conversationId: "conv-123",
        projectName: "my-project",
        sessionName: "my-session",
        text: "follow up message",
        deps,
      }),
    ).rejects.toThrow("No active query");
  });

  it("calls streamInput on the active query with correct SDKUserMessage shape", async () => {
    const streamInputMock = vi.fn().mockResolvedValue(undefined);
    getQueryMock.mockReturnValue({ streamInput: streamInputMock });

    await queueMessage({
      conversationId: "conv-123",
      projectName: "my-project",
      sessionName: "my-session",
      text: "follow up message",
      deps,
    });

    expect(streamInputMock).toHaveBeenCalledTimes(1);

    // streamInput receives an async iterable — consume it to verify content
    const iterable = streamInputMock.mock.calls[0]![0] as AsyncIterable<
      Record<string, unknown>
    >;
    const messages: Record<string, unknown>[] = [];
    for await (const msg of iterable) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "follow up message" }],
      },
    });
  });

  it("appends user entry to transcript", async () => {
    const streamInputMock = vi.fn().mockResolvedValue(undefined);
    getQueryMock.mockReturnValue({ streamInput: streamInputMock });

    await queueMessage({
      conversationId: "conv-123",
      projectName: "my-project",
      sessionName: "my-session",
      text: "queued prompt",
      deps,
    });

    expect(appendTranscriptEntryMock).toHaveBeenCalledWith(
      "conv-123",
      expect.objectContaining({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "queued prompt" }],
      }),
    );
  });

  it("broadcasts message-queued SSE event", async () => {
    const streamInputMock = vi.fn().mockResolvedValue(undefined);
    getQueryMock.mockReturnValue({ streamInput: streamInputMock });

    await queueMessage({
      conversationId: "conv-123",
      projectName: "my-project",
      sessionName: "my-session",
      text: "queued prompt",
      deps,
    });

    expect(broadcastMock).toHaveBeenCalledWith({
      type: "message-queued",
      projectName: "my-project",
      sessionName: "my-session",
      conversationId: "conv-123",
      text: "queued prompt",
    });
  });

  it("returns without error on successful queue", async () => {
    const streamInputMock = vi.fn().mockResolvedValue(undefined);
    getQueryMock.mockReturnValue({ streamInput: streamInputMock });

    await expect(
      queueMessage({
        conversationId: "conv-123",
        projectName: "my-project",
        sessionName: "my-session",
        text: "hello",
        deps,
      }),
    ).resolves.toBeUndefined();
  });
});
