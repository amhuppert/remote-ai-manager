import {
  projectConversationTarget,
  sessionConversationTarget,
} from "@/lib/conversations/conversation-target";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { mcpConfigKeys, mcpToolsKeys } from "@/lib/mcp/query-keys";
import {
  useGlobalMcpConfigQuery,
  useProjectMcpConfigQuery,
  useSessionMcpConfigQuery,
  useConversationMcpConfigQuery,
  useMcpToolsQuery,
} from "@/lib/mcp/queries";
import type {
  McpConfigViewResponse,
  McpToolInventoryResult,
} from "@/lib/mcp/schemas";
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

function emptyView(
  level: McpConfigViewResponse["level"],
): McpConfigViewResponse {
  return {
    level,
    servers: [],
    diagnostics: [],
    pendingServerKeys: [],
    effectiveConfigHash: "hash-0",
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MCP query keys", () => {
  it("builds scope-only keys with no backend segment", () => {
    expect(mcpConfigKeys.global()).toEqual(["mcp-config", "global"]);
    expect(mcpConfigKeys.project("p")).toEqual(["mcp-config", "project", "p"]);
    expect(mcpConfigKeys.session("p", "s")).toEqual([
      "mcp-config",
      "session",
      "p",
      "s",
    ]);
    expect(
      mcpConfigKeys.conversation(sessionConversationTarget("p", "s", "c")),
    ).toEqual(["mcp-config", "conversation", "p", "session", "s", "c"]);
  });

  it("builds tool inventory keys scoped by conversation and serverKey", () => {
    expect(mcpToolsKeys.all).toEqual(["mcp-tools"]);
    expect(
      mcpToolsKeys.inventory(
        sessionConversationTarget("p", "s", "c"),
        "server-1",
      ),
    ).toEqual(["mcp-tools", "inventory", "session", "p", "s", "c", "server-1"]);
  });
});

describe("MCP query hooks", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET /api/config/mcp for global scope and unwraps the view", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ view: emptyView("global") }));
    const { result } = renderHook(() => useGlobalMcpConfigQuery(), {
      wrapper: wrapperFor(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith("/api/config/mcp");
    expect(result.current.data?.level).toBe("global");
  });

  it("fetches the project endpoint with no ?backend= query string", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ view: emptyView("project") }));
    renderHook(() => useProjectMcpConfigQuery("my-proj"), {
      wrapper: wrapperFor(makeClient()),
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith("/api/projects/my-proj/mcp-config");
  });

  it("GET /api/projects/.../sessions/.../mcp-config for session scope", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ view: emptyView("session") }));
    renderHook(() => useSessionMcpConfigQuery("p", "s"), {
      wrapper: wrapperFor(makeClient()),
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/mcp-config",
    );
  });

  it("GET /api/projects/.../conversations/.../mcp-config for conversation scope", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ view: emptyView("conversation") }),
    );
    renderHook(
      () =>
        useConversationMcpConfigQuery(sessionConversationTarget("p", "s", "c")),
      {
        wrapper: wrapperFor(makeClient()),
      },
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/conversations/c/mcp-config",
    );
  });

  it("reads project-conversation MCP from its own endpoint and cache slot", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ view: emptyView("conversation") }),
    );
    const target = projectConversationTarget("p", "c");
    const client = makeClient();
    const { result } = renderHook(() => useConversationMcpConfigQuery(target), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/conversations/c/mcp-config",
    );
    expect(
      client.getQueryData(mcpConfigKeys.conversation(target)),
    ).toBeDefined();
    expect(client.getQueryData(mcpConfigKeys.project("p"))).toBeUndefined();
  });

  it("percent-encodes dynamic path segments", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ view: emptyView("project") }));
    renderHook(() => useProjectMcpConfigQuery("my proj/with slash"), {
      wrapper: wrapperFor(makeClient()),
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/my%20proj%2Fwith%20slash/mcp-config",
    );
  });

  it("fetches per-server tool inventory from the scoped endpoint", async () => {
    const inventory: McpToolInventoryResult = {
      state: "ready",
      tools: [],
      diagnostics: [],
    };
    fetchSpy.mockResolvedValue(jsonResponse(inventory));
    const { result } = renderHook(
      () => useMcpToolsQuery(sessionConversationTarget("p", "s", "c"), "srv"),
      { wrapper: wrapperFor(makeClient()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/conversations/c/mcp-config/tools/srv",
    );
    expect(result.current.data?.state).toBe("ready");
  });
});
