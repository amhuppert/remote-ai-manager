// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useRef } from "react";
import { useConversationNav } from "./use-conversation-nav";
import type { ConversationRow } from "@/features/session/conversation/conversation-rows";
import type { VirtuosoHandle } from "@/features/session/conversation/ConversationVirtuosoList";
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

describe("useConversationNav", () => {
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
});
