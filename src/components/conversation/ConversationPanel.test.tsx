// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import ConversationPanel, {
  type ConversationPanelProps,
} from "@/components/conversation/ConversationPanel";

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
    panelBodyRef: createRef<HTMLDivElement>(),
    selectedBackend: "claude",
    transcript: null,
    alignmentGateSlot: null,
    canStop: false,
    onStop: vi.fn(),
    promptInputSlot: null,
    ...overrides,
  };
}

describe("ConversationPanel", () => {
  it("renders the transcript slot inside the panel body", () => {
    render(
      <ConversationPanel
        {...makeProps({
          transcript: <div data-testid="transcript">rows</div>,
        })}
      />,
    );
    expect(screen.getByTestId("transcript")).toBeInTheDocument();
  });

  it("shows the message count and title from the active conversation", () => {
    render(<ConversationPanel {...makeProps({ totalMessages: 3 })} />);
    expect(screen.getByText("3 messages")).toBeInTheDocument();
    // Falls back to the session name when the conversation is unnamed.
    expect(screen.getByText("session-1")).toBeInTheDocument();
  });

  it("renders the Stop control only when a turn can be stopped, and invokes onStop", () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <ConversationPanel {...makeProps({ canStop: false, onStop })} />,
    );
    expect(screen.queryByRole("button", { name: "Stop agent" })).toBeNull();

    rerender(<ConversationPanel {...makeProps({ canStop: true, onStop })} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    expect(onStop).toHaveBeenCalledTimes(1);
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
