// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via SessionPage.
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSessionPageQueries } from "./use-session-page-queries";

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

describe("useSessionPageQueries", () => {
  it("returns the expected bundle of query results with safe fallbacks", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useSessionPageQueries("p", "s", "c"), {
      wrapper: wrapperFor(client),
    });
    expect(result.current.sessionQuery).toBeDefined();
    expect(result.current.conversationsQuery).toBeDefined();
    expect(result.current.collaborationListQuery).toBeDefined();
    expect(result.current.messagesQuery).toBeDefined();
    expect(result.current.diffQuery).toBeDefined();
    expect(result.current.commitsQuery).toBeDefined();
    expect(result.current.rawMessages).toEqual([]);
    expect(result.current.diff).toEqual({
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    });
    expect(result.current.commits).toEqual([]);
  });
});
