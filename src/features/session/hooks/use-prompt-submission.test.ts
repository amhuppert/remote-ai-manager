// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useRef } from "react";
import { usePromptSubmission } from "./use-prompt-submission";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import type { ImagePayload } from "@/lib/images/schemas";
import type { QueueCapability } from "@/lib/agent-backends/descriptor";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";

function makeConversation(
  overrides: Partial<ConversationState> & {
    id: string;
    status: ConversationState["status"];
  },
): ConversationState {
  return makeConversationState({
    profileSnapshot: null,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalTurns: 0,
    ...overrides,
  });
}

interface CollabMutateOptions {
  onSuccess?: () => void;
  onError?: (err: unknown) => void;
}

const CLAUDE_SELECTION: BackendModelSelection = {
  modelId: "sonnet",
  parameters: { effort: "medium" },
};
const CODEX_SELECTION: BackendModelSelection = {
  modelId: "gpt-5.4",
  parameters: { reasoning: "high", fast: "false" },
};
const CURSOR_SELECTION: BackendModelSelection = {
  modelId: "composer-2.5",
  parameters: { fast: "true" },
};
const AGENT_TWO_DRAFT = {
  backend: "codex" as const,
  modelSelection: CODEX_SELECTION,
};

function selectionForBackend(backend: AgentBackendId): BackendModelSelection {
  if (backend === "codex") return CODEX_SELECTION;
  if (backend === "cursor") return CURSOR_SELECTION;
  return CLAUDE_SELECTION;
}

function makeEditorRef(serialized: {
  prompt: string;
  images: ImagePayload[];
}): {
  current: PromptEditorHandle;
  clear: ReturnType<typeof vi.fn>;
} {
  const clear = vi.fn();
  const current: PromptEditorHandle = {
    serialize: () => serialized,
    clear,
    focus: vi.fn(),
    insertText: vi.fn(),
    editor: null,
  };
  return { current, clear };
}

describe("usePromptSubmission", () => {
  it("returns the handler surface and dispatches /collab prompts via collaborationStartMutation", async () => {
    const collabMutate = vi.fn(
      (_input: unknown, options?: CollabMutateOptions) =>
        options?.onSuccess?.(),
    );
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
        suppressPendingPromptAutosaveAfterSubmit: clearPersisted,
        effectiveCollabConfig: {
          agentTwo: AGENT_TWO_DRAFT,
          negotiationRounds: 2,
          autonomousResolutionThreshold: "minor",
        },
        clearCollabConfigDraft,
        messagesLength: 0,
        selectedModelSelection: CLAUDE_SELECTION,
        selectedBackend: "claude",
        sendPrompt,
        queueMessage,
        collaborationStartMutation: { mutate: collabMutate },
        enqueuePromptErrorToast,
      });
    });

    expect(typeof result.current.handleSendPrompt).toBe("function");
    expect(typeof result.current.handleDirectPrompt).toBe("function");
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
      submittedPendingPromptText: "/collab let's go",
      negotiationRounds: 2,
      autonomousResolutionThreshold: "minor",
      conversationId: "c",
      backend: "claude",
      modelSelection: CLAUDE_SELECTION,
      // Agent Two's seeded draft rides along so the server runs exactly what
      // the config row showed.
      agentTwo: { backend: "codex", modelSelection: CODEX_SELECTION },
    });
    expect(clearCollabConfigDraft).toHaveBeenCalledWith("p", "s", "c");
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("dispatches /collab as a collaboration start when the brief begins on the next line", async () => {
    const collabMutate = vi.fn();
    const sendPrompt = vi.fn(async () => {});

    const { result } = renderHook(() => {
      const promptTextRef = useRef("/collab\nAnalyze the parity gaps.");
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
        suppressPendingPromptAutosaveAfterSubmit: () => {},
        effectiveCollabConfig: {
          agentTwo: AGENT_TWO_DRAFT,
          negotiationRounds: 2,
          autonomousResolutionThreshold: "minor",
        },
        clearCollabConfigDraft: () => {},
        messagesLength: 0,
        selectedModelSelection: CLAUDE_SELECTION,
        selectedBackend: "claude",
        sendPrompt,
        queueMessage: vi.fn(async () => {}),
        collaborationStartMutation: { mutate: collabMutate },
        enqueuePromptErrorToast: vi.fn(),
      });
    });

    await act(async () => {
      await result.current.handleSendPrompt();
    });

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(collabMutate).toHaveBeenCalledTimes(1);
    expect(collabMutate.mock.calls[0]![0]).toMatchObject({
      brief: "Analyze the parity gaps.",
    });
  });

  it("forwards a complete selection without fabricating unsupported parameters", async () => {
    const collabMutate = vi.fn();

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
        suppressPendingPromptAutosaveAfterSubmit: () => {},
        effectiveCollabConfig: {
          agentTwo: AGENT_TWO_DRAFT,
          negotiationRounds: 2,
          autonomousResolutionThreshold: "minor",
        },
        clearCollabConfigDraft: () => {},
        messagesLength: 0,
        selectedModelSelection: { modelId: "haiku", parameters: {} },
        selectedBackend: "claude",
        sendPrompt: vi.fn(async () => {}),
        queueMessage: vi.fn(async () => {}),
        collaborationStartMutation: { mutate: collabMutate },
        enqueuePromptErrorToast: vi.fn(),
      });
    });

    await act(async () => {
      await result.current.handleSendPrompt();
    });
    expect(collabMutate).toHaveBeenCalledTimes(1);
    const [vars] = collabMutate.mock.calls[0]!;
    expect(vars).toMatchObject({
      modelSelection: { modelId: "haiku", parameters: {} },
    });
  });

  it("defers clearing the persisted /collab draft until the mutation succeeds", async () => {
    const collabMutate = vi.fn();
    const clearPersisted = vi.fn();
    const clearImages = vi.fn();
    const enqueuePromptErrorToast = vi.fn();
    const images: ImagePayload[] = [
      {
        attachmentId: "inline",
        mediaType: "image/png",
        base64Data: "inline-data",
        inlineMarkerIndex: 1,
      },
      {
        attachmentId: "strip",
        mediaType: "image/jpeg",
        base64Data: "strip-data",
      },
    ];
    const editor = makeEditorRef({
      prompt: "/collab compare [Image #1]",
      images,
    });

    const { result } = renderHook(() => {
      const promptTextRef = useRef("/collab run validate gap");
      const editorRef = useRef(editor.current);
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
        clearImages,
        suppressPendingPromptAutosaveAfterSubmit: clearPersisted,
        effectiveCollabConfig: {
          agentTwo: AGENT_TWO_DRAFT,
          negotiationRounds: 2,
          autonomousResolutionThreshold: "minor",
        },
        clearCollabConfigDraft: vi.fn(),
        messagesLength: 0,
        selectedModelSelection: CLAUDE_SELECTION,
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
    expect(editor.clear).not.toHaveBeenCalled();
    expect(clearImages).not.toHaveBeenCalled();
    expect(collabMutate.mock.calls[0]?.[0]).toMatchObject({
      brief: "compare [Image #1]",
      images,
    });

    const options = collabMutate.mock.calls[0]![1] as
      | CollabMutateOptions
      | undefined;
    expect(options?.onSuccess).toBeTypeOf("function");
    expect(options?.onError).toBeTypeOf("function");

    act(() => {
      options?.onSuccess?.();
    });

    expect(clearPersisted).toHaveBeenCalledTimes(1);
    expect(editor.clear).toHaveBeenCalledTimes(1);
    expect(clearImages).toHaveBeenCalledTimes(1);
    expect(enqueuePromptErrorToast).not.toHaveBeenCalled();
  });

  it("on /collab mutation error, enqueues a prompt error toast and leaves the lossless draft intact", async () => {
    const collabMutate = vi.fn();
    const clearPersisted = vi.fn();
    const enqueuePromptErrorToast = vi.fn();
    const setPromptText = vi.fn();
    const clearImages = vi.fn();
    const editor = makeEditorRef({
      prompt:
        '/collab inspect <conversation-ref project="p" session="s" conversation="c2" />',
      images: [
        {
          attachmentId: "strip",
          mediaType: "image/png",
          base64Data: "data",
        },
      ],
    });

    const { result } = renderHook(() => {
      const promptTextRef = useRef("/collab run validate gap");
      const editorRef = useRef(editor.current);
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
        clearImages,
        suppressPendingPromptAutosaveAfterSubmit: clearPersisted,
        effectiveCollabConfig: {
          agentTwo: AGENT_TWO_DRAFT,
          negotiationRounds: 2,
          autonomousResolutionThreshold: "minor",
        },
        clearCollabConfigDraft: vi.fn(),
        messagesLength: 0,
        selectedModelSelection: CLAUDE_SELECTION,
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
    expect(setPromptText).not.toHaveBeenCalled();
    expect(editor.clear).not.toHaveBeenCalled();
    expect(clearImages).not.toHaveBeenCalled();
  });

  it("does not clear edits made while a /collab start is pending", async () => {
    const collabMutate = vi.fn();
    const clearPersisted = vi.fn();
    const clearImages = vi.fn();
    const setPromptText = vi.fn();
    let currentDocument = { prompt: "/collab first draft", images: [] };
    const clear = vi.fn();
    const editorRef = {
      current: {
        serialize: () => currentDocument,
        clear,
        focus: vi.fn(),
        insertText: vi.fn(),
        editor: null,
      } satisfies PromptEditorHandle,
    };
    const promptTextRef = { current: currentDocument.prompt };
    const { result } = renderHook(() =>
      usePromptSubmission({
        projectName: "p",
        sessionName: "s",
        conversationId: "c",
        conversations: [],
        sending: false,
        pendingImages: [],
        promptTextRef,
        editorRef,
        setPromptText,
        clearImages,
        suppressPendingPromptAutosaveAfterSubmit: clearPersisted,
        effectiveCollabConfig: {
          agentTwo: AGENT_TWO_DRAFT,
          negotiationRounds: 2,
          autonomousResolutionThreshold: "minor",
        },
        clearCollabConfigDraft: vi.fn(),
        messagesLength: 0,
        selectedModelSelection: CLAUDE_SELECTION,
        selectedBackend: "claude",
        sendPrompt: vi.fn(async () => {}),
        queueMessage: vi.fn(async () => {}),
        collaborationStartMutation: { mutate: collabMutate },
        enqueuePromptErrorToast: vi.fn(),
      }),
    );

    await act(async () => result.current.handleSendPrompt());
    currentDocument = { prompt: "new text typed while pending", images: [] };
    promptTextRef.current = currentDocument.prompt;
    const options = collabMutate.mock.calls[0]![1] as CollabMutateOptions;
    act(() => options.onSuccess?.());

    expect(clear).not.toHaveBeenCalled();
    expect(setPromptText).not.toHaveBeenCalled();
    expect(clearImages).not.toHaveBeenCalled();
    expect(clearPersisted).not.toHaveBeenCalled();
  });

  describe("queue behavior by backend capability", () => {
    const image: ImagePayload = {
      attachmentId: "att-1",
      mediaType: "image/png",
      base64Data: "abc123",
    };

    function renderQueueHook(args: {
      sending: boolean;
      selectedBackend: AgentBackendId;
      serialized: { prompt: string; images: ImagePayload[] };
      conversations?: ConversationState[];
      checkpointMaintenanceHold?: boolean;
      queueCapabilityForBackend?: (backend: AgentBackendId) => QueueCapability;
    }) {
      const sendPrompt = vi.fn(async (..._args: unknown[]) => {});
      const queueMessage = vi.fn(
        async (_text: string, _images?: ImagePayload[]) => {},
      );
      const setPromptText = vi.fn();
      const clearImages = vi.fn();
      const clearPersisted = vi.fn();
      const editor = makeEditorRef(args.serialized);

      const { result } = renderHook(() => {
        const promptTextRef = useRef(args.serialized.prompt);
        const editorRef = useRef(editor.current);
        return usePromptSubmission({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          conversations: args.conversations ?? [],
          sending: args.sending,
          pendingImages: [],
          promptTextRef,
          editorRef,
          setPromptText,
          clearImages,
          suppressPendingPromptAutosaveAfterSubmit: clearPersisted,
          effectiveCollabConfig: {
            agentTwo: AGENT_TWO_DRAFT,
            negotiationRounds: 2,
            autonomousResolutionThreshold: "minor",
          },
          clearCollabConfigDraft: vi.fn(),
          messagesLength: 0,
          selectedModelSelection: selectionForBackend(args.selectedBackend),
          selectedBackend: args.selectedBackend,
          checkpointMaintenanceHold: args.checkpointMaintenanceHold ?? false,
          sendPrompt,
          queueMessage,
          ...(args.queueCapabilityForBackend
            ? { queueCapabilityForBackend: args.queueCapabilityForBackend }
            : {}),
          collaborationStartMutation: { mutate: vi.fn() },
          enqueuePromptErrorToast: vi.fn(),
        });
      });

      return {
        result,
        sendPrompt,
        queueMessage,
        setPromptText,
        clearImages,
        clearPersisted,
        editorClear: editor.clear,
      };
    }

    it("queues with the text when an in-turn backend (claude) is running", async () => {
      const h = renderQueueHook({
        sending: true,
        selectedBackend: "claude",
        serialized: { prompt: "  follow up  ", images: [] },
      });

      await act(async () => {
        await h.result.current.handleSendPrompt();
      });

      expect(h.queueMessage).toHaveBeenCalledTimes(1);
      expect(h.queueMessage).toHaveBeenCalledWith(
        "follow up",
        undefined,
        "  follow up  ",
        CLAUDE_SELECTION,
      );
      expect(h.sendPrompt).not.toHaveBeenCalled();
    });

    it("queues when a next-turn backend (codex) is running", async () => {
      const h = renderQueueHook({
        sending: true,
        selectedBackend: "codex",
        serialized: { prompt: "later", images: [] },
      });

      await act(async () => {
        await h.result.current.handleSendPrompt();
      });

      expect(h.queueMessage).toHaveBeenCalledTimes(1);
      expect(h.queueMessage).toHaveBeenCalledWith(
        "later",
        undefined,
        "later",
        CODEX_SELECTION,
      );
      expect(h.sendPrompt).not.toHaveBeenCalled();
    });

    it("queues when the conversation is running server-side even though this tab did not start the turn", async () => {
      // Codex next-turn delivery: the drained queued turn runs server-side with
      // no client stream, so `sending` is false while status is "running".
      const h = renderQueueHook({
        sending: false,
        selectedBackend: "codex",
        serialized: { prompt: "follow up during drained turn", images: [] },
        conversations: [
          makeConversation({
            id: "c",
            status: "running",
            agentBackend: "codex",
          }),
        ],
      });

      await act(async () => {
        await h.result.current.handleSendPrompt();
      });

      expect(h.queueMessage).toHaveBeenCalledTimes(1);
      expect(h.queueMessage).toHaveBeenCalledWith(
        "follow up during drained turn",
        undefined,
        "follow up during drained turn",
        CODEX_SELECTION,
      );
      expect(h.sendPrompt).not.toHaveBeenCalled();
    });

    it("preserves input when the backend cannot accept while running and the turn is server-side", async () => {
      const h = renderQueueHook({
        sending: false,
        selectedBackend: "claude",
        serialized: { prompt: "no queue", images: [] },
        conversations: [makeConversation({ id: "c", status: "running" })],
        queueCapabilityForBackend: () => ({
          acceptsWhileRunning: false,
          deliveryTiming: "next_turn",
        }),
      });

      await act(async () => {
        await h.result.current.handleSendPrompt();
      });

      expect(h.queueMessage).not.toHaveBeenCalled();
      expect(h.sendPrompt).not.toHaveBeenCalled();
      expect(h.editorClear).not.toHaveBeenCalled();
    });

    // Checkpoint maintenance holds the conversation without running an
    // ordinary turn, so status stays idle while a direct prompt would be
    // refused as busy. Routing on status alone loses the message.
    it("queues into an idle conversation that checkpoint maintenance is holding", async () => {
      const h = renderQueueHook({
        sending: false,
        selectedBackend: "claude",
        serialized: { prompt: "during maintenance", images: [] },
        conversations: [makeConversation({ id: "c", status: "awaiting" })],
        checkpointMaintenanceHold: true,
      });

      await act(async () => {
        await h.result.current.handleSendPrompt();
      });

      expect(h.queueMessage).toHaveBeenCalledTimes(1);
      expect(h.queueMessage.mock.calls[0]?.[0]).toBe("during maintenance");
      expect(h.sendPrompt).not.toHaveBeenCalled();
    });

    it("uses the normal prompt path when the active conversation is not running", async () => {
      const h = renderQueueHook({
        sending: false,
        selectedBackend: "codex",
        serialized: { prompt: "fresh turn", images: [] },
        conversations: [makeConversation({ id: "c", status: "awaiting" })],
      });

      await act(async () => {
        await h.result.current.handleSendPrompt();
      });

      expect(h.sendPrompt).toHaveBeenCalledTimes(1);
      expect(h.sendPrompt.mock.calls[0]?.[0]).toBe("fresh turn");
      expect(h.sendPrompt.mock.calls[0]?.[2]).toEqual(CODEX_SELECTION);
      expect(h.queueMessage).not.toHaveBeenCalled();
    });

    it("ignores other conversations' running status when routing", async () => {
      // Another running conversation in the session triggers the concurrent
      // warning, not the queue path — only the ACTIVE conversation's status
      // may route to the queue.
      const h = renderQueueHook({
        sending: false,
        selectedBackend: "claude",
        serialized: { prompt: "other busy", images: [] },
        conversations: [
          makeConversation({ id: "c", status: "awaiting" }),
          makeConversation({ id: "other", status: "running" }),
        ],
      });

      await act(async () => {
        await h.result.current.handleSendPrompt();
      });

      expect(h.queueMessage).not.toHaveBeenCalled();
      expect(h.sendPrompt).not.toHaveBeenCalled();
      expect(h.result.current.pendingConcurrentSubmission).toEqual({
        text: "other busy",
        images: [],
        busyNames: ["Conversation 1"],
        submittedPendingPromptText: "other busy",
      });
    });

    it("uses the normal prompt path when idle (not sending)", async () => {
      const h = renderQueueHook({
        sending: false,
        selectedBackend: "claude",
        serialized: { prompt: "  go now  ", images: [] },
      });

      await act(async () => {
        await h.result.current.handleSendPrompt();
      });

      expect(h.sendPrompt).toHaveBeenCalledTimes(1);
      expect(h.sendPrompt.mock.calls[0]?.[0]).toBe("go now");
      expect(h.sendPrompt.mock.calls[0]?.[5]).toBe("  go now  ");
      expect(h.queueMessage).not.toHaveBeenCalled();
    });

    it("does not queue and preserves input when the backend cannot accept while running", async () => {
      const h = renderQueueHook({
        sending: true,
        selectedBackend: "claude",
        serialized: { prompt: "no queue", images: [] },
        queueCapabilityForBackend: () => ({
          acceptsWhileRunning: false,
          deliveryTiming: "next_turn",
        }),
      });

      await act(async () => {
        await h.result.current.handleSendPrompt();
      });

      expect(h.queueMessage).not.toHaveBeenCalled();
      expect(h.sendPrompt).not.toHaveBeenCalled();
      expect(h.editorClear).not.toHaveBeenCalled();
      expect(h.setPromptText).not.toHaveBeenCalled();
      expect(h.clearImages).not.toHaveBeenCalled();
    });

    it("forwards serialized images when queuing into a running conversation", async () => {
      const h = renderQueueHook({
        sending: true,
        selectedBackend: "claude",
        serialized: { prompt: "see this", images: [image] },
      });

      await act(async () => {
        await h.result.current.handleSendPrompt();
      });

      expect(h.queueMessage).toHaveBeenCalledTimes(1);
      expect(h.queueMessage).toHaveBeenCalledWith(
        "see this",
        [image],
        "see this",
        CLAUDE_SELECTION,
      );
      expect(h.sendPrompt).not.toHaveBeenCalled();
    });
  });
});
