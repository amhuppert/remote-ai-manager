// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useDisplayMessages } from "./use-display-messages";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { TranscriptMessage } from "@/lib/conversations/schemas";

function msg(role: "user" | "assistant", text: string): TranscriptMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: null,
  };
}

describe("useDisplayMessages", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
  });

  it("returns the input messages unchanged when optimisticMessages is empty", () => {
    const messages: TranscriptMessage[] = [
      msg("user", "hello"),
      msg("assistant", "hi"),
    ];
    const { result } = renderHook(() => useDisplayMessages(messages));
    expect(result.current).toBe(messages);
  });

  it("splices server messages at messageCountBeforeSubmit and appends optimistic", () => {
    const serverMessages: TranscriptMessage[] = [
      msg("user", "first user"),
      msg("assistant", "first reply"),
      msg("user", "stale optimistic-echo"),
      msg("assistant", "stale optimistic-echo"),
    ];
    // Simulate that the optimistic submit happened after 2 messages
    useSessionDetailStore
      .getState()
      .submitPrompt([{ type: "text", text: "second user" }], 2);

    const { result } = renderHook(() => useDisplayMessages(serverMessages));

    expect(result.current).toHaveLength(3);
    expect(result.current[0]).toBe(serverMessages[0]);
    expect(result.current[1]).toBe(serverMessages[1]);
    expect(result.current[2]?.role).toBe("user");
    expect(result.current[2]?.content).toEqual([
      { type: "text", text: "second user" },
    ]);
  });

  it("when messageCountBeforeSubmit=0, returns only optimistic messages", () => {
    useSessionDetailStore
      .getState()
      .submitPrompt([{ type: "text", text: "kickoff" }], 0);

    const { result } = renderHook(() => useDisplayMessages([]));
    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.content).toEqual([
      { type: "text", text: "kickoff" },
    ]);
  });

  it("reconciles by clearing optimistic when streaming finished and server caught up", () => {
    // Set up an in-flight submit at count=1
    useSessionDetailStore
      .getState()
      .submitPrompt([{ type: "text", text: "the prompt" }], 1);
    // Stream completes (sending=false)
    useSessionDetailStore.getState().completePrompt();

    const serverMessages: TranscriptMessage[] = [
      msg("user", "previous"),
      msg("user", "the prompt"),
      msg("assistant", "reply"),
    ];

    // First render: still has optimistic messages — combined view returns
    // server.slice(0, 1) + optimistic = 1 + 1 = 2 items
    const { result, rerender } = renderHook(
      ({ messages }: { messages: TranscriptMessage[] }) =>
        useDisplayMessages(messages),
      { initialProps: { messages: serverMessages } },
    );

    // After effect runs, reconcileMessages clears optimistic. A subsequent
    // render with the same server messages should pass them through directly.
    rerender({ messages: serverMessages });
    expect(result.current).toBe(serverMessages);
    expect(useSessionDetailStore.getState().optimisticMessages).toHaveLength(0);
  });
});
