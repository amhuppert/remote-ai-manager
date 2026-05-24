// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via SessionPage.
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSessionPageConversation } from "./use-session-page-conversation";
import { useSessionPageLocalState } from "./use-session-page-local-state";
import { useCollabContext } from "./use-collab-context";

function wrapper(client: QueryClient) {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  Wrapper.displayName = "TestWrapper";
  return Wrapper;
}

describe("useSessionPageConversation", () => {
  it("returns displayMessages, rows, nav, renderers, and visibility flag", () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { result } = renderHook(
      () => {
        const local = useSessionPageLocalState("");
        const collab = useCollabContext({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          collaborationListQuery: { data: [] },
          activeConversation: undefined,
          rawMessages: [],
          openDocById: () => {},
        });
        return useSessionPageConversation({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          messages: [],
          activeConversation: undefined,
          worktreePath: "/tmp",
          isBusy: false,
          selectedBackend: "claude",
          handleDebugPrompt: async () => {},
          handleFork: async () => {},
          local,
          collab,
        });
      },
      { wrapper: wrapper(client) },
    );
    expect(result.current.displayMessages).toEqual([]);
    expect(result.current.rows).toEqual([]);
    expect(result.current.isCollabPassageInView).toBe(false);
    expect(typeof result.current.renderMessageRow).toBe("function");
    expect(typeof result.current.renderCollabRow).toBe("function");
    expect(result.current.nav).toBeDefined();
  });
});
