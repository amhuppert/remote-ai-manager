// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via SessionPage.
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

import { useSessionPageHandlers } from "./use-session-page-handlers";
import { useSessionPageLocalState } from "./use-session-page-local-state";
import { useSessionPageStoreBundle } from "./use-session-page-store-bundle";

function wrapper(client: QueryClient) {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  Wrapper.displayName = "TestWrapper";
  return Wrapper;
}

describe("useSessionPageHandlers", () => {
  it("returns the full session-page handler surface", () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { result } = renderHook(
      () => {
        const local = useSessionPageLocalState();
        const store = useSessionPageStoreBundle("c");
        const router = { push: vi.fn(), replace: vi.fn() } as never;
        return useSessionPageHandlers({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          session: undefined,
          conversations: [],
          router,
          store,
          local,
          isBusy: false,
          messagesLength: 0,
          selectedModel: "sonnet",
          selectedEffort: "medium",
          effortSupported: true,
          selectedBackend: "claude",
          sendPrompt: async () => {},
          queueMessage: async () => {},
          collaborationStartMutation: { mutate: () => {} },
          effectiveCollabConfig: {
            secondAgent: "codex",
            negotiationRounds: 2,
            autonomousResolutionThreshold: "minor",
          },
          clearCollabConfigDraft: () => {},
          suppressPendingPromptAutosaveAfterSubmit: () => {},
          enqueuePromptErrorToast: () => {},
        });
      },
      { wrapper: wrapper(client) },
    );
    expect(typeof result.current.handleSendPrompt).toBe("function");
    expect(typeof result.current.handleDirectPrompt).toBe("function");
    expect(typeof result.current.handleAnswerSubmit).toBe("function");
    expect(typeof result.current.handleDelete).toBe("function");
    expect(typeof result.current.handleFork).toBe("function");
    expect(typeof result.current.toggleRecording).toBe("function");
    expect(typeof result.current.buildContext).toBe("function");
    expect(result.current.pendingConcurrentSubmission).toBeNull();
  });
});
