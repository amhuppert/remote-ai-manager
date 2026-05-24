// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  useGenericArchiveSessionMutation,
  useBulkSessionsMutation,
} from "@/lib/sessions/mutations";
import { sessionKeys } from "@/lib/sessions/query-keys";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
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

describe("useGenericArchiveSessionMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes the session archive endpoint with the archived flag and invalidates the session list on success", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    client.setQueryData(listKey, []);
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(() => useGenericArchiveSessionMutation(), {
      wrapper: wrapperFor(client),
    });

    await result.current.mutateAsync({
      projectName: "p",
      sessionName: "s",
      archived: true,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/archive",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      }),
    );
    await waitFor(() => {
      expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    });
  });
});

describe("useBulkSessionsMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs op + sessionNames to the bulk endpoint and returns parsed results", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("my-proj");
    client.setQueryData(listKey, []);
    fetchSpy.mockResolvedValue(
      jsonResponse({
        results: [
          { sessionName: "a", success: true },
          { sessionName: "b", success: false, error: "boom" },
        ],
      }),
    );

    const { result } = renderHook(() => useBulkSessionsMutation("my-proj"), {
      wrapper: wrapperFor(client),
    });

    const response = await result.current.mutateAsync({
      op: "archive",
      sessionNames: ["a", "b"],
    });

    expect(response).toEqual({
      results: [
        { sessionName: "a", success: true },
        { sessionName: "b", success: false, error: "boom" },
      ],
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/my-proj/sessions/bulk",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ op: "archive", sessionNames: ["a", "b"] }),
      }),
    );
    await waitFor(() => {
      expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    });
  });

  it("encodes project name segments and forwards delete op", async () => {
    const client = makeClient();
    client.setQueryData(sessionKeys.list("name with space"), []);
    fetchSpy.mockResolvedValue(jsonResponse({ results: [] }));

    const { result } = renderHook(
      () => useBulkSessionsMutation("name with space"),
      { wrapper: wrapperFor(client) },
    );

    await result.current.mutateAsync({ op: "delete", sessionNames: ["x"] });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/name%20with%20space/sessions/bulk",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ op: "delete", sessionNames: ["x"] }),
      }),
    );
  });

  it("surfaces server errors as a rejected mutation without invalidating", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    client.setQueryData(listKey, []);
    fetchSpy.mockResolvedValue(jsonResponse({ error: "nope" }, 500));

    const { result } = renderHook(() => useBulkSessionsMutation("p"), {
      wrapper: wrapperFor(client),
    });

    await expect(
      result.current.mutateAsync({ op: "unarchive", sessionNames: ["a"] }),
    ).rejects.toThrow("nope");

    expect(client.getQueryState(listKey)?.isInvalidated).toBe(false);
  });
});
