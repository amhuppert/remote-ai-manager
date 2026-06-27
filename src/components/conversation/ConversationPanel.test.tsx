// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import ConversationPanel, {
  type ConversationPanelProps,
} from "@/components/conversation/ConversationPanel";
import type { VirtuosoHandle } from "@/components/conversation/ConversationVirtuosoList";

function makeProps(
  overrides: Partial<ConversationPanelProps> = {},
): ConversationPanelProps {
  return {
    conversations: false,
    activeConversation: undefined,
    sessionName: "session-1",
    openMobileSidebar: vi.fn(),
    currentMessageIndex: 0,
    totalMessages: 0,
    handleFirstMessage: vi.fn(),
    handlePrevMessage: vi.fn(),
    handleNextMessage: vi.fn(),
    handleLastMessage: vi.fn(),
    contextPercent: null,
    promptError: null,
    promptCancelled: false,
    dismissError: vi.fn(),
    dismissCancelled: vi.fn(),
    panelBodyRef: createRef<HTMLDivElement>(),
    selectedBackend: "claude",
    setCollabPinnedTopTarget: vi.fn(),
    isCollabPassageInView: false,
    messagesPending: false,
    rows: [],
    virtuosoRef: createRef<VirtuosoHandle>(),
    conversationId: "conv-1",
    followBottom: true,
    renderMessageRow: () => null,
    renderCollabRow: () => null,
    renderTypingIndicator: () => null,
    handleRangeChanged: vi.fn(),
    handleAtBottomStateChange: vi.fn(),
    handleAtTopStateChange: vi.fn(),
    alignmentGateSlot: null,
    canStop: false,
    onStop: vi.fn(),
    promptInputSlot: null,
    ...overrides,
  };
}

describe("ConversationPanel", () => {
  it("renders 'Loading conversation...' when messagesPending=true", () => {
    render(<ConversationPanel {...makeProps({ messagesPending: true })} />);
    expect(screen.getByText("Loading conversation...")).toBeInTheDocument();
    // The empty-state and the virtualized list should NOT render together.
    expect(screen.queryByText("No messages yet")).toBeNull();
  });

  it("renders 'No messages yet' when not pending and rows is empty", () => {
    render(
      <ConversationPanel
        {...makeProps({ messagesPending: false, rows: [] })}
      />,
    );
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    expect(
      screen.getByText("Send a prompt to start the conversation."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading conversation...")).toBeNull();
  });

  it("renders the promptError text and invokes dismissError on click", () => {
    const dismissError = vi.fn();
    render(
      <ConversationPanel
        {...makeProps({ promptError: "boom", dismissError })}
      />,
    );
    expect(screen.getByText("boom")).toBeInTheDocument();
    const dismiss = screen
      .getByText("boom")
      .parentElement?.querySelector("button");
    expect(dismiss).not.toBeNull();
    fireEvent.click(dismiss!);
    expect(dismissError).toHaveBeenCalledTimes(1);
  });

  it("does not render the prompt-error banner when promptError is null", () => {
    render(<ConversationPanel {...makeProps({ promptError: null })} />);
    expect(screen.queryByText("×")).toBeNull();
  });

  it("renders 'Prompt cancelled' and invokes dismissCancelled on dismiss click", () => {
    const dismissCancelled = vi.fn();
    render(
      <ConversationPanel
        {...makeProps({ promptCancelled: true, dismissCancelled })}
      />,
    );
    expect(screen.getByText("Prompt cancelled")).toBeInTheDocument();
    const dismiss = screen
      .getByText("Prompt cancelled")
      .parentElement?.querySelector("button");
    expect(dismiss).not.toBeNull();
    fireEvent.click(dismiss!);
    expect(dismissCancelled).toHaveBeenCalledTimes(1);
  });

  it("does not render the prompt-cancelled banner when promptCancelled=false", () => {
    render(<ConversationPanel {...makeProps({ promptCancelled: false })} />);
    expect(screen.queryByText("Prompt cancelled")).toBeNull();
  });

  it("renders the promptInputSlot in the panel", () => {
    render(
      <ConversationPanel
        {...makeProps({
          promptInputSlot: <div data-testid="slot">slot content</div>,
        })}
      />,
    );
    expect(screen.getByTestId("slot")).toBeInTheDocument();
  });

  it("renders the alignmentGateSlot in the panel", () => {
    render(
      <ConversationPanel
        {...makeProps({
          alignmentGateSlot: <div data-testid="gate">approve charter</div>,
        })}
      />,
    );
    expect(screen.getByTestId("gate")).toBeInTheDocument();
  });
});
