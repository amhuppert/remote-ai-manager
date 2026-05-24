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

import { useFocusInitialization } from "./use-focus-initialization";

function wrapper(client: QueryClient) {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  Wrapper.displayName = "TestWrapper";
  return Wrapper;
}

describe("useFocusInitialization", () => {
  it("returns focusConfirmLoading=false and a handleConfirmFocus callback initially", () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { result } = renderHook(
      () =>
        useFocusInitialization({
          projectName: "p",
          sessionName: "s",
          isBusy: false,
          messagesLength: 0,
          selectedModel: "sonnet",
          selectedEffort: "medium",
          effortSupported: true,
          selectedBackend: "claude",
          sendPrompt: () => Promise.resolve(),
        }),
      { wrapper: wrapper(client) },
    );
    expect(result.current.focusConfirmLoading).toBe(false);
    expect(typeof result.current.handleConfirmFocus).toBe("function");
  });
});
