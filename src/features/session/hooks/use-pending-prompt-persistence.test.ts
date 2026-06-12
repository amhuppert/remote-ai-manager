// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via ConversationWorkspace.
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import React from "react";
import { useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePendingPromptPersistence } from "./use-pending-prompt-persistence";

function wrapper(client: QueryClient) {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  Wrapper.displayName = "TestWrapper";
  return Wrapper;
}

describe("usePendingPromptPersistence", () => {
  it("returns handlePromptTextChange and clearPersistedPendingPromptOnSubmit callbacks", () => {
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const { result } = renderHook(
      () => {
        const promptTextRef = useRef("");
        const editorRef = useRef(null);
        return usePendingPromptPersistence({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          activeConversation: undefined,
          promptText: "",
          setPromptText: () => {},
          promptTextRef,
          editorRef,
        });
      },
      { wrapper: wrapper(client) },
    );
    expect(typeof result.current.handlePromptTextChange).toBe("function");
    expect(typeof result.current.clearPersistedPendingPromptOnSubmit).toBe(
      "function",
    );
  });
});
