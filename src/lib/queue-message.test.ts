import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks (only for modules that don't support DI yet)
// ---------------------------------------------------------------------------

const { getQueryMock, appendTranscriptEntryMock, getTranscriptPathMock } =
  vi.hoisted(() => ({
    getQueryMock: vi.fn(),
    appendTranscriptEntryMock: vi.fn(),
    getTranscriptPathMock: vi.fn(),
  }));

vi.mock("./query-registry", () => ({
  getQuery: getQueryMock,
}));

vi.mock("./transcript", () => ({
  appendTranscriptEntry: appendTranscriptEntryMock,
  getTranscriptPath: getTranscriptPathMock,
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
import { queueMessage } from "./queue-message";

// ---------------------------------------------------------------------------
// Injected spy for broadcast (no vi.mock needed)
// ---------------------------------------------------------------------------
const broadcastMock = vi.fn();

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  appendTranscriptEntryMock.mockResolvedValue(undefined);
  getTranscriptPathMock.mockResolvedValue("/tmp/cc/transcripts/conv-123.jsonl");
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
        broadcast: broadcastMock,
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
      broadcast: broadcastMock,
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
      broadcast: broadcastMock,
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
      broadcast: broadcastMock,
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
        broadcast: broadcastMock,
      }),
    ).resolves.toBeUndefined();
  });
});
