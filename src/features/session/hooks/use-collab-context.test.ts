// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via ConversationWorkspace.
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCollabContext } from "./use-collab-context";

function wrapper(client: QueryClient) {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  Wrapper.displayName = "TestWrapper";
  return Wrapper;
}

describe("useCollabContext", () => {
  it("returns expected keys with safe defaults when no envelope is present", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () =>
        useCollabContext({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          collaborationListQuery: { data: [] },
          activeConversation: undefined,
          rawMessages: [],
          openDocById: () => {},
        }),
      { wrapper: wrapper(client) },
    );

    expect(result.current.hasActiveCollab).toBe(false);
    expect(result.current.collabEnvelopeForConversation).toBeUndefined();
    expect(result.current.isCollabRunning).toBe(false);
    expect(result.current.collabPassageProps).toBeNull();
    expect(result.current.originatingCollabAgent).toBe("claude");
    expect(result.current.effectiveCollabConfig).toBeDefined();
    expect(typeof result.current.handleCollabStop).toBe("function");
    expect(typeof result.current.handleCollabRefClick).toBe("function");
  });
});
