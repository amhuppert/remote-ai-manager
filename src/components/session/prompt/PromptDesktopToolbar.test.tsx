// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import { getStaticBackendModelCatalog } from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
import PromptDesktopToolbar, {
  type PromptDesktopToolbarProps,
} from "@/components/session/prompt/PromptDesktopToolbar";

const defaultCatalog = getStaticBackendModelCatalog("claude");
const defaultSelection = defaultSelectionForModel(
  defaultCatalog,
  defaultCatalog.defaultModelId,
);

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
    modelCatalog: defaultCatalog,
    modelSelection: defaultSelection,
    modelSelectionBlockedReason: null,
    onModelSelectionChange: vi.fn(),
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
  it("renders and applies the catalog-driven atomic controls", () => {
    const modelCatalog = getStaticBackendModelCatalog("codex");
    const modelSelection = defaultSelectionForModel(
      modelCatalog,
      modelCatalog.defaultModelId,
    );
    const onModelSelectionChange = vi.fn();
    renderWithQuery(
      <PromptDesktopToolbar
        {...makeProps({
          selectedBackend: "codex",
          modelCatalog,
          modelSelection,
          onModelSelectionChange,
        })}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Model" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Reasoning" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Model options" }));
    fireEvent.click(screen.getByRole("switch", { name: "Fast mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onModelSelectionChange).toHaveBeenCalledWith({
      ...modelSelection,
      parameters: { ...modelSelection.parameters, fast: "true" },
    });
  });

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

  it("disables the model trigger when isReadOnly=true", () => {
    const { container } = renderWithQuery(
      <PromptDesktopToolbar {...makeProps({ isReadOnly: true })} />,
    );
    const trigger = container.querySelector(
      '[data-testid="model-selector-trigger"]',
    ) as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.disabled).toBe(true);
  });

  it("shows the validation reason on focus for a recoverable invalid selection", async () => {
    const reason =
      "Unsupported parameter combination. Catalog snapshot: Cursor.models.list, generated 2026-08-25T18:55:11.561Z, SDK 1.0.28.";
    renderWithQuery(
      <PromptDesktopToolbar
        {...makeProps({ modelSelectionBlockedReason: reason })}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    fireEvent.focus(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
    expect(trigger).toHaveAccessibleDescription(reason);
  });
});
