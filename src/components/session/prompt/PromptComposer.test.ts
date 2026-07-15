import { describe, it, expect } from "vitest";
import {
  computeSendButtonState,
  selectCancellableQueueEntries,
} from "./PromptComposer";
import type { QueueCapability } from "@/lib/agent-backends/descriptor";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";

const base = {
  promptText: "hello",
  pendingImageCount: 0,
  sending: false,
  conversationId: "c1",
  backend: "claude" as const,
  isReadOnly: false,
  isRecording: false,
};

describe("computeSendButtonState", () => {
  it("enables send when prompt has text", () => {
    expect(computeSendButtonState(base)).toEqual({
      disabled: false,
      title: "Send prompt",
    });
  });

  it("disables and shows read-only title when read-only", () => {
    expect(computeSendButtonState({ ...base, isReadOnly: true })).toEqual({
      disabled: true,
      title: "Session is read-only",
    });
  });

  it("labels in-turn delivery when sending into a Claude conversation", () => {
    expect(
      computeSendButtonState({ ...base, sending: true, backend: "claude" }),
    ).toEqual({ disabled: false, title: "Queue for this turn" });
  });

  it("labels next-turn delivery when sending into a Codex conversation", () => {
    expect(
      computeSendButtonState({ ...base, sending: true, backend: "codex" }),
    ).toEqual({ disabled: false, title: "Queue for next turn" });
  });

  it("disables and explains when the backend cannot accept a queued message", () => {
    const unsupported: QueueCapability = {
      acceptsWhileRunning: false,
      deliveryTiming: "next_turn",
    };
    expect(
      computeSendButtonState({
        ...base,
        sending: true,
        queueCapabilityForBackend: () => unsupported,
      }),
    ).toEqual({
      disabled: true,
      title: "Queuing isn't supported for this backend",
    });
  });

  it("labels queue delivery when the conversation runs server-side without a local stream", () => {
    // Drained Codex next-turn delivery / reload / another client: `sending`
    // is false but the conversation's turn is running.
    expect(
      computeSendButtonState({
        ...base,
        sending: false,
        conversationRunning: true,
        backend: "codex",
      }),
    ).toEqual({ disabled: false, title: "Queue for next turn" });
  });

  it("disables when the backend cannot accept and the turn runs server-side", () => {
    const unsupported: QueueCapability = {
      acceptsWhileRunning: false,
      deliveryTiming: "next_turn",
    };
    expect(
      computeSendButtonState({
        ...base,
        sending: false,
        conversationRunning: true,
        queueCapabilityForBackend: () => unsupported,
      }),
    ).toEqual({
      disabled: true,
      title: "Queuing isn't supported for this backend",
    });
  });

  it("marks session busy when sending without conversationId", () => {
    expect(
      computeSendButtonState({ ...base, sending: true, conversationId: "" }),
    ).toEqual({ disabled: true, title: "Session is busy" });
  });

  it("disables when no text and no images", () => {
    expect(computeSendButtonState({ ...base, promptText: "  " }).disabled).toBe(
      true,
    );
  });

  it("enables when prompt is empty but images are pending", () => {
    expect(
      computeSendButtonState({
        ...base,
        promptText: "",
        pendingImageCount: 1,
      }).disabled,
    ).toBe(false);
  });

  it("keeps the primary action enabled while recording so it can finalize dictation", () => {
    expect(
      computeSendButtonState({ ...base, isRecording: true }).disabled,
    ).toBe(false);
  });

  it("disables submission while transcription is processing", () => {
    expect(computeSendButtonState({ ...base, isProcessing: true })).toEqual({
      disabled: true,
      title: "Processing voice input…",
    });
  });
});

function makeQueueEntry(
  overrides: Partial<PendingQueuedMessage> & Pick<PendingQueuedMessage, "id">,
): PendingQueuedMessage {
  return {
    content: [{ type: "text", text: "queued text" }],
    status: "pending",
    enqueuedAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
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

describe("selectCancellableQueueEntries", () => {
  it("returns only pending entries with a text preview", () => {
    const entries = selectCancellableQueueEntries([
      makeQueueEntry({
        id: "q1",
        content: [{ type: "text", text: "first queued" }],
      }),
    ]);
    expect(entries).toEqual([{ id: "q1", preview: "first queued" }]);
  });

  it("excludes delivering and delivered entries (only pending is cancellable)", () => {
    const entries = selectCancellableQueueEntries([
      makeQueueEntry({ id: "q1", status: "pending" }),
      makeQueueEntry({ id: "q2", status: "delivering" }),
      makeQueueEntry({ id: "q3", status: "delivered" }),
      makeQueueEntry({ id: "q4", status: "cancelled" }),
      makeQueueEntry({ id: "q5", status: "failed" }),
    ]);
    expect(entries.map((e) => e.id)).toEqual(["q1"]);
  });

  it("falls back to an image label when an entry has no text block", () => {
    const entries = selectCancellableQueueEntries([
      makeQueueEntry({
        id: "q1",
        content: [{ type: "image", mediaType: "image/png", base64Data: "x" }],
      }),
    ]);
    expect(entries[0]?.preview).toBe("Image attachment");
  });
});
