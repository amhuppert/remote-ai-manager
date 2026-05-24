// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { mcpConfigKeys, mcpToolsKeys } from "@/lib/mcp/query-keys";
import {
  useToggleMcpServerMutation,
  useResetMcpServerMutation,
  useToggleMcpToolMutation,
  useResetMcpToolMutation,
  useRefreshMcpToolsMutation,
} from "@/lib/mcp/mutations";
import type {
  McpConfigViewResponse,
  McpServerView,
  McpToolInventoryResult,
} from "@/lib/mcp/schemas";
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

function serverRow(
  overrides: Partial<McpServerView> & { serverKey: string },
): McpServerView {
  return {
    serverKey: overrides.serverKey,
    displayName: overrides.displayName ?? overrides.serverKey,
    nativeId: overrides.nativeId ?? overrides.serverKey,
    transport: overrides.transport ?? "stdio",
    enabled: overrides.enabled ?? true,
    inheritanceStatus: overrides.inheritanceStatus ?? "inherited",
    sourceRefs: overrides.sourceRefs ?? [],
    reserved: overrides.reserved ?? false,
    orphaned: overrides.orphaned ?? false,
    pending: overrides.pending ?? false,
    tools: overrides.tools ?? {
      state: "ready",
      tools: [],
      diagnostics: [],
    },
    diagnostics: overrides.diagnostics ?? [],
  };
}

function view(
  level: McpConfigViewResponse["level"],
  servers: McpServerView[],
): McpConfigViewResponse {
  return {
    level,
    servers,
    diagnostics: [],
    pendingServerKeys: [],
    effectiveConfigHash: "hash-0",
  };
}

describe("useToggleMcpServerMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes the conversation-scope endpoint with a set-server-enabled op", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        view: view("conversation", []),
        effectiveConfigHash: "hash-1",
      }),
    );
    const { result } = renderHook(
      () =>
        useToggleMcpServerMutation({
          level: "conversation",
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
        }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate({ serverKey: "srv", enabled: false });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/p/sessions/s/conversations/c/mcp-config");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      operations: [
        { type: "set-server-enabled", serverKey: "srv", enabled: false },
      ],
    });
  });

  it("includes expectedEffectiveConfigHash when the current scope view is cached", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        view: view("conversation", []),
        effectiveConfigHash: "hash-1",
      }),
    );
    const client = makeClient();
    client.setQueryData(
      mcpConfigKeys.conversation("p", "s", "c"),
      view("conversation", [serverRow({ serverKey: "srv" })]),
    );
    const cached = client.getQueryData<McpConfigViewResponse>(
      mcpConfigKeys.conversation("p", "s", "c"),
    );
    if (!cached) {
      throw new Error("expected cached MCP view");
    }
    cached.effectiveConfigHash = "hash-current";

    const { result } = renderHook(
      () =>
        useToggleMcpServerMutation({
          level: "conversation",
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
        }),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ serverKey: "srv", enabled: false });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      operations: [
        { type: "set-server-enabled", serverKey: "srv", enabled: false },
      ],
      expectedEffectiveConfigHash: "hash-current",
    });
  });

  it("omits expectedEffectiveConfigHash when no cached scope view exists", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        view: view("conversation", []),
        effectiveConfigHash: "hash-1",
      }),
    );
    const { result } = renderHook(
      () =>
        useToggleMcpServerMutation({
          level: "conversation",
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
        }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate({ serverKey: "srv", enabled: false });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      operations: [
        { type: "set-server-enabled", serverKey: "srv", enabled: false },
      ],
    });
  });

  it("targets the session endpoint at session scope", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        view: view("session", []),
        effectiveConfigHash: "hash-1",
      }),
    );
    const { result } = renderHook(
      () =>
        useToggleMcpServerMutation({
          level: "session",
          projectName: "p",
          sessionName: "s",
        }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate({ serverKey: "srv", enabled: true });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/api/projects/p/sessions/s/mcp-config",
    );
  });

  it("targets the project endpoint at project scope", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        view: view("project", []),
        effectiveConfigHash: "hash-1",
      }),
    );
    const { result } = renderHook(
      () => useToggleMcpServerMutation({ level: "project", projectName: "p" }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate({ serverKey: "srv", enabled: false });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/projects/p/mcp-config");
  });

  it("targets the global endpoint at global scope", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        view: view("global", []),
        effectiveConfigHash: "hash-1",
      }),
    );
    const { result } = renderHook(
      () => useToggleMcpServerMutation({ level: "global" }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate({ serverKey: "srv", enabled: true });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/config/mcp");
  });

  it("auto-promotes inherited rows by PATCHing the CURRENT view level (not the source level)", async () => {
    // An inherited row at session view was set at global. The toggle must
    // PATCH the session endpoint — not the global endpoint — so an explicit
    // session-level override is created.
    fetchSpy.mockResolvedValue(
      jsonResponse({
        view: view("session", []),
        effectiveConfigHash: "hash-1",
      }),
    );
    const { result } = renderHook(
      () =>
        useToggleMcpServerMutation({
          level: "session",
          projectName: "p",
          sessionName: "s",
        }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate({ serverKey: "srv", enabled: false });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/api/projects/p/sessions/s/mcp-config",
    );
  });

  it("optimistically flips enabled + sets pending, then invalidates on success", async () => {
    const client = makeClient();
    const key = mcpConfigKeys.conversation("p", "s", "c");
    const initial = view("conversation", [
      serverRow({
        serverKey: "srv",
        enabled: true,
        pending: false,
        inheritanceStatus: "inherited",
      }),
    ]);
    client.setQueryData(key, initial);

    let resolve: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolve = r)),
    );

    const { result } = renderHook(
      () =>
        useToggleMcpServerMutation({
          level: "conversation",
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
        }),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ serverKey: "srv", enabled: false });

    await waitFor(() => {
      const cached = client.getQueryData<McpConfigViewResponse>(key);
      expect(cached?.servers[0]?.enabled).toBe(false);
      expect(cached?.servers[0]?.pending).toBe(true);
    });

    const nextView = view("conversation", [
      serverRow({ serverKey: "srv", enabled: false, pending: false }),
    ]);
    resolve(jsonResponse({ view: nextView, effectiveConfigHash: "hash-1" }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the optimistic update when the server rejects", async () => {
    const client = makeClient();
    const key = mcpConfigKeys.project("p");
    const initial = view("project", [
      serverRow({ serverKey: "srv", enabled: true, pending: false }),
    ]);
    client.setQueryData(key, initial);

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useToggleMcpServerMutation({ level: "project", projectName: "p" }),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ serverKey: "srv", enabled: false });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const rolled = client.getQueryData<McpConfigViewResponse>(key);
    expect(rolled?.servers[0]?.enabled).toBe(true);
    expect(rolled?.servers[0]?.pending).toBe(false);
  });
});

describe("useResetMcpServerMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes reset-server at the current scope", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        view: view("session", []),
        effectiveConfigHash: "hash-1",
      }),
    );
    const { result } = renderHook(
      () =>
        useResetMcpServerMutation({
          level: "session",
          projectName: "p",
          sessionName: "s",
        }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate({ serverKey: "srv" });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/p/sessions/s/mcp-config");
    expect(JSON.parse(init.body as string)).toEqual({
      operations: [{ type: "reset-server", serverKey: "srv" }],
    });
  });
});

describe("useToggleMcpToolMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes set-tool-enabled at the current scope", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        view: view("conversation", []),
        effectiveConfigHash: "hash-1",
      }),
    );
    const { result } = renderHook(
      () =>
        useToggleMcpToolMutation({
          level: "conversation",
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
        }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate({
      serverKey: "srv",
      toolName: "read_file",
      enabled: false,
    });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      operations: [
        {
          type: "set-tool-enabled",
          serverKey: "srv",
          toolName: "read_file",
          enabled: false,
        },
      ],
    });
  });
});

describe("useResetMcpToolMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes reset-tool at the current scope", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        view: view("global", []),
        effectiveConfigHash: "hash-1",
      }),
    );
    const { result } = renderHook(
      () => useResetMcpToolMutation({ level: "global" }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate({ serverKey: "srv", toolName: "read_file" });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/config/mcp");
    expect(JSON.parse(init.body as string)).toEqual({
      operations: [
        { type: "reset-tool", serverKey: "srv", toolName: "read_file" },
      ],
    });
  });
});

describe("useRefreshMcpToolsMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const inv: McpToolInventoryResult = {
    state: "ready",
    tools: [],
    diagnostics: [],
  };

  it("POSTs to the conversation-scoped tools endpoint when scope=conversation", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(inv));
    const { result } = renderHook(
      () =>
        useRefreshMcpToolsMutation({
          level: "conversation",
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
        }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate("srv");

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/projects/p/sessions/s/conversations/c/mcp-config/tools/srv",
    );
    expect(init.method).toBe("POST");
  });

  it("POSTs to the session-scoped tools endpoint when scope=session", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(inv));
    const { result } = renderHook(
      () =>
        useRefreshMcpToolsMutation({
          level: "session",
          projectName: "p",
          sessionName: "s",
        }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate("srv");

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/api/projects/p/sessions/s/mcp-config/tools/srv",
    );
  });

  it("POSTs to the project-scoped tools endpoint when scope=project", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(inv));
    const { result } = renderHook(
      () =>
        useRefreshMcpToolsMutation({
          level: "project",
          projectName: "p",
        }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate("srv");

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/api/projects/p/mcp-config/tools/srv",
    );
  });

  it("POSTs to the global-scoped tools endpoint when scope=global", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(inv));
    const { result } = renderHook(
      () => useRefreshMcpToolsMutation({ level: "global" }),
      { wrapper: wrapperFor(makeClient()) },
    );

    result.current.mutate("srv");

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/config/mcp/tools/srv");
  });

  it("invalidates the conversation tool inventory key on success (conversation scope)", async () => {
    const client = makeClient();
    const key = mcpToolsKeys.inventory("p", "s", "c", "srv");
    let resolved = false;
    client.setQueryData<McpToolInventoryResult>(key, {
      state: "stale",
      tools: [],
      diagnostics: [],
    });

    const unsub = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "invalidate") {
        const match = event.query.queryKey;
        if (
          Array.isArray(match) &&
          match[0] === "mcp-tools" &&
          match.includes("srv")
        ) {
          resolved = true;
        }
      }
    });

    fetchSpy.mockResolvedValue(jsonResponse(inv));

    const { result } = renderHook(
      () =>
        useRefreshMcpToolsMutation({
          level: "conversation",
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
        }),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate("srv");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(resolved).toBe(true));
    unsub();
  });
});
