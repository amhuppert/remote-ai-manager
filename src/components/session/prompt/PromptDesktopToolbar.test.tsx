// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
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
    codexFastMode: false,
    onCodexFastModeChange: vi.fn(),
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

  it("shows the speed control only for Codex", () => {
    const { unmount } = renderWithQuery(
      <PromptDesktopToolbar {...makeProps({ selectedBackend: "claude" })} />,
    );
    expect(
      screen.queryByRole("radiogroup", { name: "Codex speed" }),
    ).toBeNull();

    unmount();
    renderWithQuery(
      <PromptDesktopToolbar {...makeProps({ selectedBackend: "codex" })} />,
    );
    expect(
      screen.getByRole("radiogroup", { name: "Codex speed" }),
    ).toBeInTheDocument();
  });

  it("changes the conversation speed from the Codex control", () => {
    const onCodexFastModeChange = vi.fn();
    renderWithQuery(
      <PromptDesktopToolbar
        {...makeProps({
          selectedBackend: "codex",
          codexFastMode: false,
          onCodexFastModeChange,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    expect(onCodexFastModeChange).toHaveBeenCalledWith(true);
  });

  it.each([
    { sending: true, isReadOnly: false },
    { sending: false, isReadOnly: true },
  ])(
    "disables the Codex speed control when prompt controls are unavailable",
    ({ sending, isReadOnly }) => {
      renderWithQuery(
        <PromptDesktopToolbar
          {...makeProps({
            selectedBackend: "codex",
            sending,
            isReadOnly,
          })}
        />,
      );

      for (const option of screen.getAllByRole("radio", {
        name: /Standard|Fast/,
      })) {
        expect(option).toBeDisabled();
      }
    },
  );
});

describe("PromptDesktopToolbar project-scoped model options", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
    api.json("GET", "/api/agent-backends", {
      backends: listBackendCatalogEntries(),
    });
  });

  afterEach(() => api.restore());

  function serveProjectOptions(
    models: readonly string[],
    defaultModelId: string | null,
  ): void {
    api.json("GET", "/api/projects/proj/model-options", {
      backends: listBackendCatalogEntries().map((entry) =>
        entry.id === "cursor"
          ? {
              backend: entry.id,
              models: models.map((id) => ({
                id,
                label: id,
                description: "Configured for this project.",
                effortLevels: [],
              })),
              defaultModelId,
              source: "project",
            }
          : {
              backend: entry.id,
              models: entry.models,
              defaultModelId: entry.defaultModelId,
              source: "catalog",
            },
      ),
    });
  }

  it("offers the project's models rather than the descriptor catalog's", async () => {
    serveProjectOptions(["composer-1"], "composer-1");
    renderWithQuery(
      <PromptDesktopToolbar
        {...makeProps({
          selectedBackend: "cursor",
          selectedModel: "composer-1",
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
        "composer-1",
      );
    });
  });

  it("marks a configured model outside the project's list as an invalid selection", async () => {
    serveProjectOptions(["composer-1"], "composer-1");
    renderWithQuery(
      <PromptDesktopToolbar
        {...makeProps({
          selectedBackend: "cursor",
          selectedModel: "composer-2.5",
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("model-selector-trigger")).toHaveAttribute(
        "data-invalid-selection",
        "true",
      );
    });
  });

  it("requires an explicit choice when the project's list permits nothing", async () => {
    serveProjectOptions([], null);
    renderWithQuery(
      <PromptDesktopToolbar
        {...makeProps({
          selectedBackend: "cursor",
          selectedModel: "composer-2.5",
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("model-selector-trigger")).toBeDisabled();
    });
  });
});
