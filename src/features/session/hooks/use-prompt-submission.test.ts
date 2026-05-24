// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useRef } from "react";
import { usePromptSubmission } from "./use-prompt-submission";

describe("usePromptSubmission", () => {
  it("returns the handler surface and dispatches /collab prompts via collaborationStartMutation", async () => {
    const collabMutate = vi.fn();
    const sendPrompt = vi.fn(async () => {});
    const queueMessage = vi.fn(async () => {});
    const clearCollabConfigDraft = vi.fn();
    const clearPersisted = vi.fn();

    const { result } = renderHook(() => {
      const promptTextRef = useRef("/collab let's go");
      const editorRef = useRef(null);
      return usePromptSubmission({
        projectName: "p",
        sessionName: "s",
        conversationId: "c",
        conversations: [],
        sending: false,
        pendingImages: [],
        promptTextRef,
        editorRef,
        setPromptText: () => {},
        clearImages: () => {},
        clearPersistedPendingPromptOnSubmit: clearPersisted,
        effectiveCollabConfig: {
          negotiationRounds: 2,
          autonomousResolutionThreshold: "minor",
        },
        clearCollabConfigDraft,
        messagesLength: 0,
        selectedModel: "sonnet",
        selectedEffort: "medium",
        effortSupported: true,
        selectedBackend: "claude",
        sendPrompt,
        queueMessage,
        collaborationStartMutation: { mutate: collabMutate },
      });
    });

    expect(typeof result.current.handleSendPrompt).toBe("function");
    expect(typeof result.current.handleDebugPrompt).toBe("function");
    expect(typeof result.current.handleConcurrentConfirm).toBe("function");
    expect(typeof result.current.cancelConcurrentSubmission).toBe("function");
    expect(result.current.pendingConcurrentSubmission).toBeNull();

    await act(async () => {
      await result.current.handleSendPrompt();
    });
    expect(collabMutate).toHaveBeenCalledWith({
      brief: "let's go",
      negotiationRounds: 2,
      autonomousResolutionThreshold: "minor",
      conversationId: "c",
      backend: "claude",
    });
    expect(clearCollabConfigDraft).toHaveBeenCalledWith("p", "s", "c");
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
