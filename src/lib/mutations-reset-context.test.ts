// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useResetExecutionContextMutation } from "@/lib/mutations";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

describe("useResetExecutionContextMutation", () => {
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

  it("POSTs {executionId, contextId} to the reset-context endpoint", async () => {
    const { result } = renderHook(
      () => useResetExecutionContextMutation("proj-1", "sess-1"),
      { wrapper },
    );

    result.current.mutate({ executionId: "exec-42", contextId: "ctx-7" });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/projects/proj-1/sessions/sess-1/graph-workflow/reset-context",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({ executionId: "exec-42", contextId: "ctx-7" }),
    );
  });
});
