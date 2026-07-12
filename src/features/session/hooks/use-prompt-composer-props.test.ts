// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useRef } from "react";
import { usePromptComposerProps } from "./use-prompt-composer-props";

describe("usePromptComposerProps", () => {
  it("returns a composer props bundle and rewires callbacks (onCollabDismiss strips /collab prefix)", () => {
    const setPromptText = vi.fn();
    const clearCollabConfigDraft = vi.fn();
    const debugToggleMutate = vi.fn();

    const { result } = renderHook(() => {
      const editorRef = useRef(null);
      const fileInputRef = useRef(null);
      return usePromptComposerProps({
        projectName: "p",
        sessionName: "s",
        conversationId: "c",
        activeConversation: undefined,
        editorRef,
        fileInputRef,
        promptText: "/collab build a thing",
        handlePromptTextChange: () => {},
        setPromptText,
        handleSendPrompt: async () => {},
        pendingImages: [],
        inlineMarkerIds: [],
        setInlineMarkerIds: () => {},
        addImage: async () => ({ attachment: null, error: null }),
        removeImage: () => {},
        isAtLimit: false,
        cumulativeImageCount: 0,
        failPrompt: () => {},
        showPlaceholder: () => {},
        promptPlaceholder: null,
        isReadOnly: false,
        isFinished: false,
        isWorkflowManagedConversation: true,
        sending: false,
        hasActiveCollab: false,
        isRecording: false,
        isProcessing: false,
        voiceAvailable: true,
        elapsedTime: 0,
        toggleRecording: () => {},
        stopAndSubmit: () => {},
        backendLocked: false,
        selectedBackend: "claude",
        handleBackendChange: () => {},
        selectedModel: "sonnet",
        handleModelChange: () => {},
        selectedEffort: "medium",
        setSelectedEffort: () => {},
        availableEffortLevels: ["low", "medium", "high"],
        effortSupported: true,
        hasCollabChip: true,
        effectiveCollabConfig: {
          secondAgent: "codex",
          negotiationRounds: 2,
          autonomousResolutionThreshold: "minor",
        },
        originatingCollabAgent: "claude",
        setCollabConfigDraft: () => {},
        clearCollabConfigDraft,
        debugToggleMutation: { isPending: false, mutate: debugToggleMutate },
      });
    });

    expect(result.current.projectName).toBe("p");
    expect(result.current.isWorkflowManagedConversation).toBe(true);
    expect(result.current.selectedBackend).toBe("claude");
    expect(result.current.selectedModel).toBe("sonnet");
    expect(result.current.selectedEffort).toBe("medium");
    expect(typeof result.current.onSendPrompt).toBe("function");

    act(() => result.current.onCollabDismiss());
    expect(setPromptText).toHaveBeenCalledWith("build a thing");
    expect(clearCollabConfigDraft).toHaveBeenCalledWith("p", "s", "c");

    act(() => result.current.onDebugToggle());
    expect(debugToggleMutate).toHaveBeenCalledWith("enter");
  });
});
