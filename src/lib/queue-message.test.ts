import { describe, it, expect, vi, beforeEach } from "vitest";
import { queueMessage, type QueueMessageDeps } from "./queue-message";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

const getRuntimeMock = vi.fn();
const appendTranscriptEntryMock = vi.fn();
const broadcastMock = vi.fn();

const deps: QueueMessageDeps = {
  getRuntime: getRuntimeMock,
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
  it("throws when conversation has no active runtime", async () => {
    getRuntimeMock.mockReturnValue(undefined);

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

  it("throws when runtime does not support queueUserInput", async () => {
    getRuntimeMock.mockReturnValue({ queueUserInput: undefined });

    await expect(
      queueMessage({
        conversationId: "conv-123",
        projectName: "my-project",
        sessionName: "my-session",
        text: "follow up message",
        deps,
      }),
    ).rejects.toThrow("Backend does not support message queueing");
  });

  it("calls queueUserInput on the active runtime with correct content shape", async () => {
    const queueUserInputMock = vi.fn().mockResolvedValue(undefined);
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

    await queueMessage({
      conversationId: "conv-123",
      projectName: "my-project",
      sessionName: "my-session",
      text: "follow up message",
      deps,
    });

    expect(queueUserInputMock).toHaveBeenCalledTimes(1);
    expect(queueUserInputMock).toHaveBeenCalledWith({
      content: [{ type: "text", text: "follow up message" }],
    });
  });

  it("appends user entry to transcript", async () => {
    const queueUserInputMock = vi.fn().mockResolvedValue(undefined);
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

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
    const queueUserInputMock = vi.fn().mockResolvedValue(undefined);
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

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
    const queueUserInputMock = vi.fn().mockResolvedValue(undefined);
    getRuntimeMock.mockReturnValue({ queueUserInput: queueUserInputMock });

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
