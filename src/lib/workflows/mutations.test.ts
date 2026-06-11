// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useResetExecutionContextMutation,
  useResolveApprovalMutation,
} from "@/lib/workflows/mutations";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { ApiCallError } from "@/lib/api/errors";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

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

describe("useResolveApprovalMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seededClient() {
    const client = makeClient();
    client.setQueryData(conversationKeys.active(), { conversations: [] });
    client.setQueryData(sessionKeys.detail("proj-1", "sess-1"), {
      sessionName: "sess-1",
    });
    return client;
  }

  function invalidationState(client: QueryClient) {
    return {
      active: client.getQueryState(conversationKeys.active())?.isInvalidated,
      session: client.getQueryState(sessionKeys.detail("proj-1", "sess-1"))
        ?.isInvalidated,
    };
  }

  it("POSTs an approve decision and invalidates active conversations and session detail on success", async () => {
    const client = seededClient();
    fetchSpy.mockResolvedValue(jsonResponse({ execution: { id: "exec-1" } }));

    const { result } = renderHook(
      () => useResolveApprovalMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({ contextId: "ctx-7", decision: "approve" }),
    ).resolves.toEqual({ status: "ok" });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/projects/proj-1/sessions/sess-1/graph-workflow/resolve-approval",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({ contextId: "ctx-7", decision: "approve" }),
    );

    await waitFor(() => {
      expect(invalidationState(client)).toEqual({
        active: true,
        session: true,
      });
    });
  });

  it("POSTs a reject decision with its message", async () => {
    const client = seededClient();
    fetchSpy.mockResolvedValue(jsonResponse({ execution: { id: "exec-1" } }));

    const { result } = renderHook(
      () => useResolveApprovalMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    await result.current.mutateAsync({
      contextId: "ctx-7",
      decision: "reject",
      message: "Wrong file layout",
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(
      JSON.stringify({
        contextId: "ctx-7",
        decision: "reject",
        message: "Wrong file layout",
      }),
    );
  });

  it("resolves with conflict status and still invalidates both keys on 409", async () => {
    const client = seededClient();
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: "Context ctx-7 is not awaiting approval" }, 409),
    );

    const { result } = renderHook(
      () => useResolveApprovalMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({ contextId: "ctx-7", decision: "approve" }),
    ).resolves.toEqual({
      status: "conflict",
      error: "Context ctx-7 is not awaiting approval",
    });

    await waitFor(() => {
      expect(invalidationState(client)).toEqual({
        active: true,
        session: true,
      });
    });
  });

  it("throws ApiCallError and does not invalidate on other errors", async () => {
    const client = seededClient();
    fetchSpy.mockResolvedValue(jsonResponse({ error: "Boom" }, 500));

    const { result } = renderHook(
      () => useResolveApprovalMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({ contextId: "ctx-7", decision: "approve" }),
    ).rejects.toThrow(ApiCallError);

    expect(invalidationState(client)).toEqual({
      active: false,
      session: false,
    });
  });
});
