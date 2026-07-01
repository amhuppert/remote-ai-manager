// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useClearDebugLogsMutation,
  useDebugModeToggleMutation,
  useDebugPhaseMutation,
} from "@/lib/debug-log/mutations";
import { debugLogKeys } from "@/lib/debug-log/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { conversationKeys } from "@/lib/conversations/query-keys";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function makeWrapper(client: QueryClient) {
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

const statsKey = debugLogKeys.stats("proj-1", "sess-1", "conv-1");

describe("useClearDebugLogsMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically zeroes the cached entry count before the server resolves", async () => {
    const client = makeClient();
    client.setQueryData(statsKey, 7);

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useClearDebugLogsMutation("proj-1", "sess-1", "conv-1"),
      { wrapper: makeWrapper(client) },
    );

    result.current.mutate();

    await waitFor(() => {
      expect(client.getQueryData<number>(statsKey)).toBe(0);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the cached entry count when the server rejects", async () => {
    const client = makeClient();
    client.setQueryData(statsKey, 7);

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useClearDebugLogsMutation("proj-1", "sess-1", "conv-1"),
      { wrapper: makeWrapper(client) },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(client.getQueryData<number>(statsKey)).toBe(7);
  });

  it("invalidates the debug-log stats and session detail queries after a successful clear", async () => {
    const client = makeClient();
    client.setQueryData(statsKey, 7);

    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(
      () => useClearDebugLogsMutation("proj-1", "sess-1", "conv-1"),
      { wrapper: makeWrapper(client) },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: statsKey });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj-1", "sess-1"),
    });
    const state = client.getQueryState(statsKey);
    expect(state?.isInvalidated).toBe(true);
  });

  it("still invalidates the stats query after a failed clear so the rolled-back count is re-verified", async () => {
    const client = makeClient();
    client.setQueryData(statsKey, 7);

    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useClearDebugLogsMutation("proj-1", "sess-1", "conv-1"),
      { wrapper: makeWrapper(client) },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: statsKey });
  });
});

describe("useDebugModeToggleMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invalidates the session detail and conversation list even when the server rejects", async () => {
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useDebugModeToggleMutation("proj-1", "sess-1", "conv-1"),
      { wrapper: makeWrapper(client) },
    );

    result.current.mutate("enter");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj-1", "sess-1"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: conversationKeys.list("proj-1", "sess-1"),
    });
  });
});

describe("useDebugPhaseMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invalidates the session detail even when the server rejects", async () => {
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useDebugPhaseMutation("proj-1", "sess-1", "conv-1"),
      { wrapper: makeWrapper(client) },
    );

    result.current.mutate("mark_reproduced");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail("proj-1", "sess-1"),
    });
  });
});
