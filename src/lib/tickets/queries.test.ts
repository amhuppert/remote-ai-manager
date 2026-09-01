// @vitest-environment jsdom

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useTicketRelationshipsQuery,
  useTicketStatusUpdatesQuery,
} from "./queries";

const fetchSpy = vi.fn<typeof fetch>();

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ticket paginated queries", () => {
  it("requests status-update pages with the server cursor", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: "update-2",
              ticketId: "ticket-7",
              bodyMarkdown: "Second update",
              author: { kind: "user" },
              createdAt: "2026-08-02T00:00:00.000Z",
            },
          ],
          total: 2,
          nextCursor: "older+/cursor",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: "update-1",
              ticketId: "ticket-7",
              bodyMarkdown: "First update",
              author: { kind: "user" },
              createdAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          total: 2,
          nextCursor: null,
        }),
      );

    const client = makeClient();
    const { result } = renderHook(
      () => useTicketStatusUpdatesQuery("alpha project", 7),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "/api/projects/alpha%20project/tickets/7/status-updates?limit=20",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const next = await result.current.fetchNextPage();

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/api/projects/alpha%20project/tickets/7/status-updates?limit=20&cursor=older%2B%2Fcursor",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(next.data?.pages.flatMap((page) => page.items)).toHaveLength(2);
    expect(next.hasNextPage).toBe(false);
  });

  it("includes the relative-role filter on relationship pages and preserves it across cursors", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ items: [], total: 1, nextCursor: "next cursor" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [], total: 1, nextCursor: null }),
      );

    const client = makeClient();
    const { result } = renderHook(
      () => useTicketRelationshipsQuery("alpha project", 7, "depends_on"),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "/api/projects/alpha%20project/tickets/7/relationships?limit=20&role=depends_on",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await result.current.fetchNextPage();

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/api/projects/alpha%20project/tickets/7/relationships?limit=20&role=depends_on&cursor=next+cursor",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
