// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import PromptComposer from "@/components/session/prompt/PromptComposer";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import type { CollabConfigRowConfig } from "@/components/session/CollabConfigRow";

// ---------------------------------------------------------------------------
// Shared infrastructure mocks (next/navigation + voice + hotkey) — same set
// ConversationWorkspace.test.tsx uses. Permitted: JSDOM/infrastructure only.
// ---------------------------------------------------------------------------
vi.mock(
  "next/navigation",
  async () => (await import("@/test/component-mocks")).nextNavigationMock,
);
vi.mock(
  "@/hooks/useVoiceRecorder",
  async () => (await import("@/test/component-mocks")).voiceRecorderMock,
);
vi.mock(
  "@/hooks/useAppHotkey",
  async () => (await import("@/test/component-mocks")).appHotkeyMock,
);

// The lazy PromptEditor pulls in TipTap/ProseMirror which JSDOM cannot mount.
// Replace it with a focusable textarea so region focus/blur events flow through
// `.prompt-input-area`, which is exactly what the focus model under test reads.
// The stub mirrors the workflow-managed flag so the lane-exclusion threading
// (composer → editor → slash popup) stays pinned.
vi.mock("@/components/session/prompt/PromptEditor", () => ({
  PromptEditor: (props: { isWorkflowManagedConversation?: boolean }) => (
    <textarea
      data-testid="prompt-editor"
      data-workflow-managed={String(
        props.isWorkflowManagedConversation ?? false,
      )}
    />
  ),
}));

// AgentCapabilityPanel containers reach into query/data layers that JSDOM
// can't satisfy; the drawer's open/close trigger (what we exercise) lives in
// ConversationAgentCapabilitiesConfig itself, not these panels.
vi.mock(
  "@/components/agent-capabilities/AgentCapabilityPanelContainer",
  () => ({
    AgentCapabilityPanelContainer: () => null,
  }),
);
vi.mock("@/components/agent-capabilities/McpCapabilityPanelContainer", () => ({
  McpCapabilityPanelContainer: () => null,
}));

function makeProps(): React.ComponentProps<typeof PromptComposer> {
  const editorRef = React.createRef<PromptEditorHandle>();
  const fileInputRef = React.createRef<HTMLInputElement>();
  const collabConfig: CollabConfigRowConfig = {
    claudeModel: "sonnet",
    codexModel: "gpt-5.4",
    claudeEffort: "medium",
    codexEffort: "medium",
  } as CollabConfigRowConfig;
  return {
    projectName: "proj",
    sessionName: "sess",
    conversationId: "conv-1",
    activeConversation: undefined,
    editorRef,
    fileInputRef,
    promptText: "",
    onPromptTextChange: vi.fn(),
    onSendPrompt: vi.fn(),
    pendingImages: [],
    inlineMarkerIds: [],
    onInlineMarkersChange: vi.fn(),
    addImage: vi.fn(),
    removeImage: vi.fn(),
    isAtLimit: false,
    cumulativeImageCount: 0,
    failPrompt: vi.fn(),
    showPlaceholder: vi.fn(),
    promptPlaceholder: null,
    isReadOnly: false,
    isFinished: false,
    sending: false,
    hasActiveCollab: false,
    isRecording: false,
    isProcessing: false,
    voiceAvailable: false,
    elapsedTime: 0,
    toggleRecording: vi.fn(),
    stopAndSubmit: vi.fn(),
    backendLocked: false,
    selectedBackend: "claude",
    onBackendChange: vi.fn(),
    selectedModel: "sonnet",
    onModelChange: vi.fn(),
    selectedEffort: "medium",
    onEffortChange: vi.fn(),
    availableEffortLevels: ["low", "medium", "high"],
    effortSupported: true,
    hasCollabChip: false,
    effectiveCollabConfig: collabConfig,
    originatingCollabAgent: "claude",
    onCollabConfigChange: vi.fn(),
    onCollabDismiss: vi.fn(),
    onDebugToggle: vi.fn(),
    debugTogglePending: false,
  };
}

function composerFocused(): boolean {
  return useSessionDetailStore.getState().composerFocused;
}

describe("PromptComposer composer-focus wiring", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
  });

  it("routes the visible send action through active dictation", () => {
    const props = makeProps();
    props.promptText = "draft";
    props.isRecording = true;
    renderWithQuery(<PromptComposer {...props} />);

    fireEvent.click(screen.getByTestId("prompt-send"));

    expect(props.stopAndSubmit).toHaveBeenCalledOnce();
    expect(props.onSendPrompt).not.toHaveBeenCalled();
  });

  it("disables the visible send action while transcription is processing", () => {
    const props = makeProps();
    props.promptText = "draft";
    props.isProcessing = true;
    renderWithQuery(<PromptComposer {...props} />);

    expect(screen.getByTestId("prompt-send")).toBeDisabled();
    fireEvent.click(screen.getByTestId("prompt-send"));
    expect(props.onSendPrompt).not.toHaveBeenCalled();
  });

  it("sets composerFocused when focus enters the region and clears it when focus leaves", () => {
    const { container } = renderWithQuery(<PromptComposer {...makeProps()} />);
    expect(composerFocused()).toBe(false);

    const attach = container.querySelector(
      '[title="Attach image"]',
    ) as HTMLButtonElement;
    expect(attach).not.toBeNull();

    fireEvent.focus(attach);
    expect(composerFocused()).toBe(true);

    // relatedTarget outside the region → flag clears.
    fireEvent.blur(attach, { relatedTarget: document.body });
    expect(composerFocused()).toBe(false);
  });

  it("keeps composerFocused while focus moves between in-flow controls inside the region", () => {
    const { container } = renderWithQuery(<PromptComposer {...makeProps()} />);
    const region = container.querySelector(".prompt-input-area") as HTMLElement;
    const attach = container.querySelector(
      '[title="Attach image"]',
    ) as HTMLButtonElement;
    const modelTrigger = region.querySelector(
      '[data-testid="model-selector-trigger"]',
    ) as HTMLButtonElement;

    fireEvent.focus(attach);
    expect(composerFocused()).toBe(true);

    // Blur to another control still inside the region keeps the flag true.
    fireEvent.blur(attach, { relatedTarget: modelTrigger });
    expect(composerFocused()).toBe(true);
  });

  it("keeps composerFocused while the capabilities drawer is open even when focus leaves the region", () => {
    const { container } = renderWithQuery(<PromptComposer {...makeProps()} />);
    const region = container.querySelector(".prompt-input-area") as HTMLElement;

    // The desktop toolbar's capabilities trigger opens the portaled drawer,
    // which reports its open-state to the focus hook via onOpenChange.
    const capsTrigger = region.querySelector(
      'button[aria-label="Agent capability configuration"]',
    ) as HTMLButtonElement;
    expect(capsTrigger).not.toBeNull();

    fireEvent.click(capsTrigger);
    // The drawer is portaled outside the region; simulate focus leaving the
    // region while it is open. The control-active signal must hold the flag.
    fireEvent.blur(capsTrigger, { relatedTarget: document.body });
    expect(composerFocused()).toBe(true);

    // Closing the drawer with focus still outside the region clears the flag.
    // Radix owns dismissal now (the drawer composes ui/Dialog's unstyled
    // edge-anchored variant), so Escape drives onOpenChange(false) → onClose.
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    });
    expect(composerFocused()).toBe(false);
  });
});

describe("PromptComposer workflow-lane threading", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
  });

  it("forwards isWorkflowManagedConversation to the prompt editor", () => {
    renderWithQuery(
      <PromptComposer {...makeProps()} isWorkflowManagedConversation />,
    );
    expect(
      screen.getByTestId("prompt-editor").getAttribute("data-workflow-managed"),
    ).toBe("true");
  });

  it("defaults to a non-workflow-managed editor", () => {
    renderWithQuery(<PromptComposer {...makeProps()} />);
    expect(
      screen.getByTestId("prompt-editor").getAttribute("data-workflow-managed"),
    ).toBe("false");
  });
});
