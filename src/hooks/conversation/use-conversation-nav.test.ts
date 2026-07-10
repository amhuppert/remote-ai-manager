// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useRef } from "react";
import { useConversationNav } from "./use-conversation-nav";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { ConversationRow } from "@/components/conversation/conversation-rows";
import type { VirtuosoHandle } from "@/components/conversation/ConversationVirtuosoList";
import type { TranscriptMessage } from "@/lib/conversations/schemas";

function messageRow(messageIndex: number): ConversationRow {
  const msg: TranscriptMessage = {
    role: "user",
    content: [{ type: "text", text: `m${messageIndex}` }],
    timestamp: null,
  };
  return { kind: "message", messageIndex, msg };
}

function setup(args: { rows: ConversationRow[]; totalMessages: number }) {
  return renderHook(() => {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    return useConversationNav({
      rows: args.rows,
      totalMessages: args.totalMessages,
      virtuosoRef,
    });
  });
}

function setupWithRef(args: {
  rows: ConversationRow[];
  totalMessages: number;
  virtuosoHandle: VirtuosoHandle;
}) {
  return renderHook(() => {
    const virtuosoRef = useRef<VirtuosoHandle>(args.virtuosoHandle);
    return useConversationNav({
      rows: args.rows,
      totalMessages: args.totalMessages,
      virtuosoRef,
      conversationId: "conv-1",
    });
  });
}

describe("useConversationNav", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
  });

  it("currentMessageIndex starts at 0 with empty rows and zero total", () => {
    const { result } = setup({ rows: [], totalMessages: 0 });
    expect(result.current.currentMessageIndex).toBe(0);
  });

  it("currentMessageIndex remains 0 when at top of a non-empty list", () => {
    const rows = [messageRow(0), messageRow(1), messageRow(2)];
    const { result } = setup({ rows, totalMessages: 3 });
    expect(result.current.currentMessageIndex).toBe(0);
  });

  it("handleAtTopStateChange(true) keeps current at 0; handleAtBottomStateChange(true) jumps to last", () => {
    const rows = [messageRow(0), messageRow(1), messageRow(2)];
    const { result } = setup({ rows, totalMessages: 3 });

    act(() => {
      result.current.handleAtTopStateChange(true);
      result.current.handleAtBottomStateChange(false);
    });
    expect(result.current.currentMessageIndex).toBe(0);

    act(() => {
      result.current.handleAtTopStateChange(false);
      result.current.handleAtBottomStateChange(true);
    });
    expect(result.current.currentMessageIndex).toBe(2);
  });

  it("handleRangeChanged updates the topmost message index for middle-of-list", () => {
    const rows = [messageRow(0), messageRow(1), messageRow(2), messageRow(3)];
    const { result } = setup({ rows, totalMessages: 4 });

    act(() => {
      // Leave the top edge so middle position takes effect
      result.current.handleAtTopStateChange(false);
      result.current.handleRangeChanged({ startIndex: 2, endIndex: 3 });
    });

    expect(result.current.currentMessageIndex).toBe(2);
  });

  it("handleFirstMessage and handleLastMessage are no-ops when totalMessages is 0 (do not throw)", () => {
    const { result } = setup({ rows: [], totalMessages: 0 });

    expect(() => {
      act(() => {
        result.current.handleFirstMessage();
      });
    }).not.toThrow();

    expect(() => {
      act(() => {
        result.current.handleLastMessage();
      });
    }).not.toThrow();

    expect(result.current.currentMessageIndex).toBe(0);
  });

  it("returns stable handler functions for all navigation actions", () => {
    const rows = [messageRow(0), messageRow(1)];
    const { result } = setup({ rows, totalMessages: 2 });

    expect(typeof result.current.handleRangeChanged).toBe("function");
    expect(typeof result.current.handleAtBottomStateChange).toBe("function");
    expect(typeof result.current.handleAtTopStateChange).toBe("function");
    expect(typeof result.current.handleFirstMessage).toBe("function");
    expect(typeof result.current.handlePrevMessage).toBe("function");
    expect(typeof result.current.handleNextMessage).toBe("function");
    expect(typeof result.current.handleLastMessage).toBe("function");
  });

  it("followBottom defaults to true so initial content auto-scrolls", () => {
    const { result } = setup({ rows: [], totalMessages: 0 });
    expect(result.current.followBottom).toBe(true);
  });

  it("followBottom turns off when the user scrolls away from the bottom and re-engages when they return", () => {
    const rows = [messageRow(0), messageRow(1), messageRow(2)];
    const { result } = setup({ rows, totalMessages: 3 });

    act(() => {
      result.current.handleAtBottomStateChange(false);
    });
    expect(result.current.followBottom).toBe(false);

    act(() => {
      result.current.handleAtBottomStateChange(true);
    });
    expect(result.current.followBottom).toBe(true);
  });

  it("re-engages followBottom and scrolls to the bottom when a new prompt enters sending state", () => {
    const rows = [messageRow(0), messageRow(1), messageRow(2)];
    const scrollToIndex = vi.fn();
    const virtuosoHandle = {
      scrollToIndex,
      scrollTo: vi.fn(),
      scrollIntoView: vi.fn(),
      scrollBy: vi.fn(),
      getState: vi.fn(),
      autoscrollToBottom: vi.fn(),
    } as unknown as VirtuosoHandle;
    const { result } = setupWithRef({
      rows,
      totalMessages: 3,
      virtuosoHandle,
    });

    act(() => {
      result.current.handleAtBottomStateChange(false);
    });
    expect(result.current.followBottom).toBe(false);

    act(() => {
      useSessionDetailStore
        .getState()
        .submitPrompt("conv-1", [{ type: "text", text: "hello" }], 3);
    });

    expect(result.current.followBottom).toBe(true);
    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        index: "LAST",
        align: "end",
        behavior: "smooth",
      }),
    );
  });

  it("keeps followBottom engaged through send-time size growth, then respects a later user scroll", () => {
    const rows = [messageRow(0), messageRow(1), messageRow(2)];
    const virtuosoHandle = {
      scrollToIndex: vi.fn(),
    } as unknown as VirtuosoHandle;
    const { result } = setupWithRef({
      rows,
      totalMessages: 3,
      virtuosoHandle,
    });

    act(() => {
      result.current.handleAtBottomStateChange(false);
      useSessionDetailStore
        .getState()
        .submitPrompt("conv-1", [{ type: "text", text: "hello" }], 3);
    });
    expect(result.current.followBottom).toBe(true);

    act(() => {
      result.current.handleAtBottomStateChange(false);
    });
    expect(result.current.followBottom).toBe(true);

    act(() => {
      result.current.handleAtBottomStateChange(true);
    });
    act(() => {
      result.current.handleAtBottomStateChange(false);
    });
    expect(result.current.followBottom).toBe(false);
  });
});

describe("useConversationNav — store message-nav requests", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
  });

  function setupWithConversation(args: {
    conversationId?: string;
    scrollToIndex: ReturnType<typeof vi.fn>;
  }) {
    const rows = [messageRow(0), messageRow(1), messageRow(2)];
    const virtuosoHandle = {
      scrollToIndex: args.scrollToIndex,
    } as unknown as VirtuosoHandle;
    return renderHook(() => {
      const virtuosoRef = useRef<VirtuosoHandle>(virtuosoHandle);
      return useConversationNav({
        rows,
        totalMessages: 3,
        virtuosoRef,
        conversationId: args.conversationId,
      });
    });
  }

  it("scrolls to the requested message and consumes the request", () => {
    const scrollToIndex = vi.fn();
    setupWithConversation({ conversationId: "conv-1", scrollToIndex });

    act(() => {
      useSessionDetailStore.getState().requestMessageNav("conv-1", 2);
    });

    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 2 }),
    );
    expect(useSessionDetailStore.getState().messageNavRequest).toBeNull();
  });

  it("ignores requests targeting another conversation", () => {
    const scrollToIndex = vi.fn();
    setupWithConversation({ conversationId: "conv-1", scrollToIndex });

    act(() => {
      useSessionDetailStore.getState().requestMessageNav("conv-other", 2);
    });

    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(useSessionDetailStore.getState().messageNavRequest).toEqual({
      conversationId: "conv-other",
      messageIndex: 2,
    });
  });

  it("ignores requests when no conversationId was provided", () => {
    const scrollToIndex = vi.fn();
    setupWithConversation({ conversationId: undefined, scrollToIndex });

    act(() => {
      useSessionDetailStore.getState().requestMessageNav("conv-1", 1);
    });

    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
