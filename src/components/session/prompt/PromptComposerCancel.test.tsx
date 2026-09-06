// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import PromptComposer from "@/components/session/prompt/PromptComposer";
import {
  selectInFlightFor,
  useSessionDetailStore,
} from "@/stores/session-detail.store";

function inFlight() {
  return selectInFlightFor(useSessionDetailStore.getState(), "conv-1");
}
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import { getStaticBackendModelCatalog } from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";

const modelCatalog = getStaticBackendModelCatalog("claude");
const modelSelection = defaultSelectionForModel(modelCatalog, "sonnet");

function makeQueueEntry(
  overrides: Partial<PendingQueuedMessage> & Pick<PendingQueuedMessage, "id">,
): PendingQueuedMessage {
  return {
    content: [{ type: "text", text: "queued text" }],
    status: "pending",
    enqueuedAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
    deliveryStartedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
    deliveryAttemptId: null,
    attemptCount: 0,
    error: null,
    metadata: null,
    ...overrides,
  };
}

function makeConversation(
  pendingQueue: PendingQueuedMessage[],
): ConversationState {
  return makeConversationState({
    status: "running",
    promptCount: 1,
    createdAt: "2026-06-08T00:00:00.000Z",
    lastActivityAt: "2026-06-08T00:00:00.000Z",
    pendingQueue,
  });
}

function makeProps(activeConversation: ConversationState) {
  return {
    projectName: "proj name",
    sessionName: "sess name",
    conversationId: "conv-1",
    activeConversation,
    editorRef: createRef<PromptEditorHandle | null>(),
    fileInputRef: createRef<HTMLInputElement | null>(),
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
    sending: true,
    hasActiveCollab: false,
    isRecording: false,
    isProcessing: false,
    voiceAvailable: false,
    elapsedTime: 0,
    toggleRecording: vi.fn(),
    stopAndSubmit: vi.fn(),
    backendLocked: false,
    selectedBackend: "claude" as const,
    onBackendChange: vi.fn(),
    modelCatalog,
    modelCatalogs: {
      claude: modelCatalog,
      codex: getStaticBackendModelCatalog("codex"),
      cursor: null,
    },
    modelSelection,
    modelSelectionBlockedReason: null,
    onModelSelectionChange: vi.fn(),
    hasCollabChip: false,
    effectiveCollabConfig: {
      agentTwo: {
        backend: "codex" as const,
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
      negotiationRounds: 3,
      autonomousResolutionThreshold: "none" as const,
    },
    collabBackendDefaults: {
      claude: { modelId: "opus", parameters: { effort: "high" } },
      codex: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "false" },
      },
      cursor: { modelId: "composer-2.5", parameters: {} },
    },
    originatingCollabAgent: "claude" as const,
    onCollabConfigChange: vi.fn(),
    onCollabDismiss: vi.fn(),
    onDebugToggle: vi.fn(),
    debugTogglePending: false,
  };
}

beforeEach(() => {
  useSessionDetailStore.getState().resetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PromptComposer cancellation affordance", () => {
  it.each(["retry", "discard"] as const)(
    "offers %s for an uncertain delivery and blocks another send",
    async (action) => {
      const entry = makeQueueEntry({
        id: "held",
        status: "uncertain",
        content: [{ type: "text", text: "possibly delivered" }],
      });
      const props = {
        ...makeProps({ ...makeConversation([entry]), status: "awaiting" }),
        sending: false,
        promptText: "another request",
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) => {
          if (String(input).endsWith("/queue/held"))
            return Response.json({ resolved: true, id: "held", action });
          return Response.json({});
        });
      renderWithQuery(<PromptComposer {...props} />);
      expect(screen.getByText(/may repeat work/i)).toBeInTheDocument();
      expect(screen.getByTestId("prompt-send")).toBeDisabled();
      fireEvent.click(
        screen.getByRole("button", {
          name:
            action === "retry" ? "Retry delivery" : "Discard queued message",
        }),
      );
      await waitFor(() =>
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/projects/proj%20name/sessions/sess%20name/conversations/conv-1/queue/held",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ action }),
          }),
        ),
      );
    },
  );

  it("cancels a pending queued entry via DELETE and removes it optimistically", async () => {
    const entry = makeQueueEntry({
      id: "q1",
      content: [{ type: "text", text: "retract me" }],
    });
    // Seed the optimistic mirror so we can observe its removal.
    useSessionDetailStore
      .getState()
      .addOptimisticQueueEntry("conv-1", "temp-1", entry.content);
    useSessionDetailStore
      .getState()
      .acceptOptimisticQueueEntry("conv-1", "temp-1", "q1");

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    renderWithQuery(
      <PromptComposer {...makeProps(makeConversation([entry]))} />,
    );

    const cancelBtn = screen.getByRole("button", {
      name: "Cancel queued message",
    });
    fireEvent.click(cancelBtn);

    // The backend catalog query also fetches in the background, so target
    // the cancellation request by method instead of total call count.
    const deleteCalls = () =>
      fetchSpy.mock.calls.filter((call) => call[1]?.method === "DELETE");
    await waitFor(() => {
      expect(deleteCalls()).toHaveLength(1);
    });
    const url = deleteCalls()[0]?.[0];
    expect(String(url)).toBe(
      "/api/projects/proj%20name/sessions/sess%20name/conversations/conv-1/queue/q1",
    );

    await waitFor(() => {
      expect(inFlight().optimisticQueue).toHaveLength(0);
    });
  });

  it("does not render a cancel control for delivering or delivered entries", () => {
    const conversation = makeConversation([
      makeQueueEntry({ id: "q1", status: "delivering" }),
      makeQueueEntry({ id: "q2", status: "delivered" }),
    ]);
    renderWithQuery(<PromptComposer {...makeProps(conversation)} />);
    expect(
      screen.queryByRole("button", { name: "Cancel queued message" }),
    ).toBeNull();
  });

  it("keeps the entry when the cancel request fails (does not remove optimistically)", async () => {
    const entry = makeQueueEntry({ id: "q1" });
    useSessionDetailStore
      .getState()
      .addOptimisticQueueEntry("conv-1", "temp-1", entry.content);
    useSessionDetailStore
      .getState()
      .acceptOptimisticQueueEntry("conv-1", "temp-1", "q1");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "conflict" }), { status: 409 }),
    );

    renderWithQuery(
      <PromptComposer {...makeProps(makeConversation([entry]))} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel queued message" }),
    );

    await waitFor(() => {
      expect(inFlight().promptError).not.toBeNull();
    });
    expect(inFlight().optimisticQueue).toHaveLength(1);
  });
});
