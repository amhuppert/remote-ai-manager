// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via SessionPage.
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useSessionLifecycle } from "./use-session-lifecycle";

describe("useSessionLifecycle", () => {
  it("hydrates layout and clears conversation messages on mount", () => {
    const hydrateLayout = vi.fn();
    const resetStore = vi.fn();
    const clearConversationMessages = vi.fn();
    const showQuestions = vi.fn();
    const clearQuestions = vi.fn();
    const router = { push: vi.fn(), replace: vi.fn() } as never;

    renderHook(() =>
      useSessionLifecycle({
        storageKey: "k",
        hydrateLayout,
        resetStore,
        clearConversationMessages,
        conversationId: "c",
        session: undefined,
        pendingQuestionId: null,
        showQuestions,
        clearQuestions,
        autoFocus: false,
        router,
        projectName: "p",
        sessionName: "s",
        sendPrompt: () => Promise.resolve(),
        messagesLength: 0,
        selectedModel: "sonnet",
        selectedEffort: "medium",
        effortSupported: true,
        selectedBackend: "claude",
      }),
    );
    expect(hydrateLayout).toHaveBeenCalledWith("k");
    expect(clearConversationMessages).toHaveBeenCalled();
    expect(showQuestions).not.toHaveBeenCalled();
  });
});
