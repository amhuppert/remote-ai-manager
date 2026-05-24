// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useClearDebugLogsMutation } from "@/lib/debug-log/mutations";
import { debugLogKeys } from "@/lib/debug-log/query-keys";
function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

describe("useClearDebugLogsMutation", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invalidates the debug-log stats query after a successful clear so the entry counter resets", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(debugLogKeys.stats("proj-1", "sess-1", "conv-1"), {
      entryCount: 7,
    });

    const { result } = renderHook(
      () => useClearDebugLogsMutation("proj-1", "sess-1", "conv-1"),
      { wrapper: makeWrapper(client) },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const state = client.getQueryState(
      debugLogKeys.stats("proj-1", "sess-1", "conv-1"),
    );
    expect(state?.isInvalidated).toBe(true);
  });
});
