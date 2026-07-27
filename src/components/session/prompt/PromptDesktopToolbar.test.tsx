// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import PromptDesktopToolbar, {
  type PromptDesktopToolbarProps,
} from "@/components/session/prompt/PromptDesktopToolbar";

function makeProps(
  overrides: Partial<PromptDesktopToolbarProps> = {},
): PromptDesktopToolbarProps {
  return {
    projectName: "proj",
    sessionName: "sess",
    scope: { scope: "session", sessionName: "sess" },
    conversationId: "conv-1",
    activeConversation: undefined,
    onAttachClick: vi.fn(),
    attachDisabled: false,
    backendLocked: false,
    selectedBackend: "claude",
    onBackendChange: vi.fn(),
    selectedModel: "sonnet",
    onModelChange: vi.fn(),
    selectedEffort: "medium",
    onEffortChange: vi.fn(),
    availableEffortLevels: ["low", "medium", "high"],
    effortSupported: true,
    isReadOnly: false,
    sending: false,
    isRecording: false,
    isProcessing: false,
    voiceAvailable: false,
    elapsedTime: 0,
    toggleRecording: vi.fn(),
    sendBusy: false,
    sendDisabled: false,
    sendTitle: "Send prompt",
    sendButtonInner: <span>Send</span>,
    onSendPrompt: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PromptDesktopToolbar", () => {
  it("invokes onAttachClick when the attachment button is clicked", () => {
    const onAttachClick = vi.fn();
    const { container } = renderWithQuery(
      <PromptDesktopToolbar {...makeProps({ onAttachClick })} />,
    );
    const attach = container.querySelector(
      '[title="Attach image"]',
    ) as HTMLButtonElement;
    expect(attach).not.toBeNull();
    fireEvent.click(attach);
    expect(onAttachClick).toHaveBeenCalledTimes(1);
  });

  it("disables the attachment button when attachDisabled=true", () => {
    const onAttachClick = vi.fn();
    const { container } = renderWithQuery(
      <PromptDesktopToolbar
        {...makeProps({ attachDisabled: true, onAttachClick })}
      />,
    );
    const attach = container.querySelector(
      '[title="Attach image"]',
    ) as HTMLButtonElement;
    expect(attach.disabled).toBe(true);
    fireEvent.click(attach);
    expect(onAttachClick).not.toHaveBeenCalled();
  });

  it("invokes onSendPrompt when the send button is clicked", () => {
    const onSendPrompt = vi.fn();
    renderWithQuery(<PromptDesktopToolbar {...makeProps({ onSendPrompt })} />);
    fireEvent.click(screen.getByTitle("Send prompt"));
    expect(onSendPrompt).toHaveBeenCalledTimes(1);
  });

  it("disables the send button when sendDisabled=true", () => {
    const onSendPrompt = vi.fn();
    renderWithQuery(
      <PromptDesktopToolbar
        {...makeProps({ sendDisabled: true, onSendPrompt })}
      />,
    );
    const send = screen.getByTitle("Send prompt") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(onSendPrompt).not.toHaveBeenCalled();
  });

  it("disables the BackendToggle buttons when sending=true", () => {
    const { container } = renderWithQuery(
      <PromptDesktopToolbar {...makeProps({ sending: true })} />,
    );
    const backendButtons = container.querySelectorAll<HTMLButtonElement>(
      ".backend-toggle-btn",
    );
    expect(backendButtons.length).toBeGreaterThan(0);
    for (const btn of backendButtons) {
      expect(btn.disabled).toBe(true);
    }
  });

  it("disables the ModelSelector trigger when isReadOnly=true", () => {
    const { container } = renderWithQuery(
      <PromptDesktopToolbar {...makeProps({ isReadOnly: true })} />,
    );
    const trigger = container.querySelector(
      '[data-testid="model-selector-trigger"]',
    ) as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.disabled).toBe(true);
  });
});
