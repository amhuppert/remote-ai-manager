// @vitest-environment jsdom
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const routerPushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import {
  useFocusInitialization,
  type UseFocusInitializationArgs,
} from "./use-focus-initialization";

function wrapper(client: QueryClient) {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  Wrapper.displayName = "TestWrapper";
  return Wrapper;
}

function makeArgs(
  overrides: Partial<UseFocusInitializationArgs> = {},
): UseFocusInitializationArgs {
  return {
    projectName: "p",
    sessionName: "s",
    isBusy: false,
    messagesLength: 0,
    selectedModel: "sonnet",
    selectedEffort: "medium",
    effortSupported: true,
    selectedBackend: "claude",
    sendPrompt: () => Promise.resolve(),
    ...overrides,
  };
}

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function stubFinalizeFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ conversationId: "finalized-1", name: "Focus" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
}

describe("useFocusInitialization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    routerPushMock.mockClear();
  });

  it("returns focusConfirmLoading=false and a handleConfirmFocus callback initially", () => {
    const { result } = renderHook(() => useFocusInitialization(makeArgs()), {
      wrapper: wrapper(newClient()),
    });
    expect(result.current.focusConfirmLoading).toBe(false);
    expect(typeof result.current.handleConfirmFocus).toBe("function");
  });

  it("opens the finalized conversation through onOpenConversation when provided and never router.push", async () => {
    stubFinalizeFetch();
    const onOpenConversation = vi.fn();
    const sendPrompt = vi.fn(() => Promise.resolve());

    const { result } = renderHook(
      () =>
        useFocusInitialization(makeArgs({ sendPrompt, onOpenConversation })),
      { wrapper: wrapper(newClient()) },
    );

    await act(async () => {
      result.current.handleConfirmFocus();
    });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(onOpenConversation).toHaveBeenCalledWith({
        conversationId: "finalized-1",
      }),
    );
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("falls back to router.push to the conversations page URL when the seam is absent", async () => {
    stubFinalizeFetch();
    const { result } = renderHook(() => useFocusInitialization(makeArgs()), {
      wrapper: wrapper(newClient()),
    });

    await act(async () => {
      result.current.handleConfirmFocus();
    });

    await waitFor(() =>
      expect(routerPushMock).toHaveBeenCalledWith(
        "/conversations?c=finalized-1",
      ),
    );
  });
});
