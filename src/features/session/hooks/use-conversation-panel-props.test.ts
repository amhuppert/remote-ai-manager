// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useRef } from "react";
import { useConversationPanelProps } from "./use-conversation-panel-props";

describe("useConversationPanelProps", () => {
  it("returns a memoized props bundle that mirrors its inputs", () => {
    const renderMessageRow = () => null;
    const renderCollabRow = () => null;
    const renderTypingIndicator = () => null;
    const handleRangeChanged = () => {};
    const handleAtBottomStateChange = () => {};
    const handleAtTopStateChange = () => {};

    const { result } = renderHook(() => {
      const panelBodyRef = useRef<HTMLDivElement | null>(null);
      const virtuosoRef = useRef(null);
      return useConversationPanelProps({
        conversations: [{}],
        activeConversation: undefined,
        sessionName: "sess-1",
        openMobileSidebar: () => {},
        currentMessageIndex: 2,
        totalMessages: 5,
        handleFirstMessage: () => {},
        handlePrevMessage: () => {},
        handleNextMessage: () => {},
        handleLastMessage: () => {},
        contextPercent: 42,
        promptError: null,
        promptCancelled: false,
        dismissError: () => {},
        dismissCancelled: () => {},
        panelBodyRef,
        selectedBackend: "claude",
        setCollabPinnedTopTarget: () => {},
        isCollabPassageInView: false,
        messagesPending: false,
        rows: [],
        virtuosoRef,
        conversationId: "c",
        followBottom: true,
        renderMessageRow,
        renderCollabRow,
        renderTypingIndicator,
        handleRangeChanged,
        handleAtBottomStateChange,
        handleAtTopStateChange,
        showFocusConfirmation: false,
        focusConfirmLoading: false,
        handleConfirmFocus: () => {},
        isReadOnly: false,
        canStop: false,
        onStop: () => {},
      });
    });

    expect(result.current.conversations).toBe(true);
    expect(result.current.currentMessageIndex).toBe(2);
    expect(result.current.totalMessages).toBe(5);
    expect(result.current.contextPercent).toBe(42);
    expect(result.current.selectedBackend).toBe("claude");
    expect(result.current.conversationId).toBe("c");
    expect(result.current.renderMessageRow).toBe(renderMessageRow);
    expect(result.current.renderCollabRow).toBe(renderCollabRow);
  });
});
