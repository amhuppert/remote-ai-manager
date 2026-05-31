// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useRef } from "react";
import { usePromptSubmission } from "./use-prompt-submission";

interface CollabMutateOptions {
  onSuccess?: () => void;
  onError?: (err: unknown) => void;
}

describe("usePromptSubmission", () => {
  it("returns the handler surface and dispatches /collab prompts via collaborationStartMutation", async () => {
    const collabMutate = vi.fn();
    const sendPrompt = vi.fn(async () => {});
    const queueMessage = vi.fn(async () => {});
    const clearCollabConfigDraft = vi.fn();
    const clearPersisted = vi.fn();
    const enqueuePromptErrorToast = vi.fn();

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
        enqueuePromptErrorToast,
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
    expect(collabMutate).toHaveBeenCalledTimes(1);
    const [vars] = collabMutate.mock.calls[0]!;
    expect(vars).toEqual({
      brief: "let's go",
      negotiationRounds: 2,
      autonomousResolutionThreshold: "minor",
      conversationId: "c",
      backend: "claude",
    });
    expect(clearCollabConfigDraft).toHaveBeenCalledWith("p", "s", "c");
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("defers clearing the persisted /collab draft until the mutation succeeds", async () => {
    const collabMutate = vi.fn();
    const clearPersisted = vi.fn();
    const enqueuePromptErrorToast = vi.fn();

    const { result } = renderHook(() => {
      const promptTextRef = useRef("/collab run validate gap");
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
        clearCollabConfigDraft: vi.fn(),
        messagesLength: 0,
        selectedModel: "sonnet",
        selectedEffort: "medium",
        effortSupported: true,
        selectedBackend: "claude",
        sendPrompt: vi.fn(async () => {}),
        queueMessage: vi.fn(async () => {}),
        collaborationStartMutation: { mutate: collabMutate },
        enqueuePromptErrorToast,
      });
    });

    await act(async () => {
      await result.current.handleSendPrompt();
    });

    expect(clearPersisted).not.toHaveBeenCalled();

    const options = collabMutate.mock.calls[0]![1] as
      | CollabMutateOptions
      | undefined;
    expect(options?.onSuccess).toBeTypeOf("function");
    expect(options?.onError).toBeTypeOf("function");

    act(() => {
      options?.onSuccess?.();
    });

    expect(clearPersisted).toHaveBeenCalledTimes(1);
    expect(enqueuePromptErrorToast).not.toHaveBeenCalled();
  });

  it("on /collab mutation error, enqueues a prompt error toast, restores prompt text, and leaves the persisted draft intact", async () => {
    const collabMutate = vi.fn();
    const clearPersisted = vi.fn();
    const enqueuePromptErrorToast = vi.fn();
    const setPromptText = vi.fn();

    const { result } = renderHook(() => {
      const promptTextRef = useRef("/collab run validate gap");
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
        setPromptText,
        clearImages: () => {},
        clearPersistedPendingPromptOnSubmit: clearPersisted,
        effectiveCollabConfig: {
          negotiationRounds: 2,
          autonomousResolutionThreshold: "minor",
        },
        clearCollabConfigDraft: vi.fn(),
        messagesLength: 0,
        selectedModel: "sonnet",
        selectedEffort: "medium",
        effortSupported: true,
        selectedBackend: "claude",
        sendPrompt: vi.fn(async () => {}),
        queueMessage: vi.fn(async () => {}),
        collaborationStartMutation: { mutate: collabMutate },
        enqueuePromptErrorToast,
      });
    });

    await act(async () => {
      await result.current.handleSendPrompt();
    });

    const options = collabMutate.mock.calls[0]![1] as
      | CollabMutateOptions
      | undefined;
    expect(options?.onError).toBeTypeOf("function");

    setPromptText.mockClear();

    act(() => {
      options?.onError?.(new Error("Failed to start collaboration run"));
    });

    expect(clearPersisted).not.toHaveBeenCalled();
    expect(enqueuePromptErrorToast).toHaveBeenCalledTimes(1);
    expect(enqueuePromptErrorToast).toHaveBeenCalledWith({
      projectName: "p",
      sessionName: "s",
      conversationId: "c",
      error: "Failed to start collaboration run",
    });
    expect(setPromptText).toHaveBeenCalledWith("/collab run validate gap");
  });
});
