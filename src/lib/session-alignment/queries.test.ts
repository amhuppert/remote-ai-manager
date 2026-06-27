// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useAlignmentStateQuery, useAlignmentDiffQuery } from "./queries";
import type { AlignmentState } from "./schemas";

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const emptyState: AlignmentState = {
  active: null,
  draft: null,
  history: [],
  decisions: [],
  pendingProposals: [],
  preview: null,
};

const fetchSpy = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAlignmentStateQuery", () => {
  it("GETs the alignment state endpoint and returns the validated state", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValue(jsonResponse(emptyState));

    const { result } = renderHook(() => useAlignmentStateQuery("p", "s"), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(emptyState);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/alignment",
    );
  });
});

describe("useAlignmentDiffQuery", () => {
  it("is disabled until enabled is true", () => {
    const client = makeClient();
    const { result } = renderHook(
      () => useAlignmentDiffQuery("p", "s", 1, 2, false),
      { wrapper: wrapperFor(client) },
    );
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("GETs the diff endpoint with from/to query params when enabled", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValue(
      jsonResponse({ from: 1, to: 2, fromContent: "a", toContent: "b" }),
    );

    const { result } = renderHook(
      () => useAlignmentDiffQuery("p", "s", 1, 2, true),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      from: 1,
      to: 2,
      fromContent: "a",
      toContent: "b",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/alignment/diff?from=1&to=2",
    );
  });
});
