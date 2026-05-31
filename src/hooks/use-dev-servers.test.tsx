// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";

import { useDevServers } from "./use-dev-servers";

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    jsonResponse(200, { servers: [] }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDevServers — unmanaged conflict flow", () => {
  it("captures unmanagedConflict when startServer returns 409 UNMANAGED_DEV_SERVER_DETECTED", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/dev-servers")) {
        return jsonResponse(200, { servers: [] });
      }
      if (url.endsWith("/dev-servers/web/start")) {
        return jsonResponse(409, {
          error: "Port 3007 is already in use",
          code: "UNMANAGED_DEV_SERVER_DETECTED",
          details: {
            serverName: "web",
            port: 3007,
            pid: 5001,
            cwd: "/repos/project/.worktrees/s1",
          },
        });
      }
      return jsonResponse(404, { error: "not found" });
    });

    const { result } = renderHook(() => useDevServers("project", "s1"), {
      wrapper: wrapperFor(makeQueryClient()),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.startServer("web");
    });

    await waitFor(() =>
      expect(result.current.unmanagedConflict).toEqual({
        serverName: "web",
        port: 3007,
        pid: 5001,
        cwd: "/repos/project/.worktrees/s1",
      }),
    );
  });

  it("dismissUnmanagedConflict clears the conflict state", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/dev-servers"))
        return jsonResponse(200, { servers: [] });
      if (url.endsWith("/dev-servers/web/start")) {
        return jsonResponse(409, {
          error: "conflict",
          code: "UNMANAGED_DEV_SERVER_DETECTED",
          details: { serverName: "web", port: 3007, pid: 5001, cwd: "/cwd" },
        });
      }
      return jsonResponse(404, { error: "not found" });
    });

    const { result } = renderHook(() => useDevServers("project", "s1"), {
      wrapper: wrapperFor(makeQueryClient()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.startServer("web");
    });
    await waitFor(() =>
      expect(result.current.unmanagedConflict).not.toBeNull(),
    );

    act(() => {
      result.current.dismissUnmanagedConflict();
    });
    expect(result.current.unmanagedConflict).toBeNull();
  });

  it("stopUnmanagedAndRetry posts to stop-unmanaged with the conflicting port, then retries start", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch");
    let startCallCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      const body = init?.body
        ? (JSON.parse(init.body as string) as unknown)
        : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/dev-servers"))
        return jsonResponse(200, { servers: [] });
      if (url.endsWith("/dev-servers/web/start")) {
        startCallCount += 1;
        if (startCallCount === 1) {
          return jsonResponse(409, {
            error: "conflict",
            code: "UNMANAGED_DEV_SERVER_DETECTED",
            details: {
              serverName: "web",
              port: 3007,
              pid: 5001,
              cwd: "/cwd",
            },
          });
        }
        return jsonResponse(202, { server: { serverName: "web" } });
      }
      if (url.endsWith("/dev-servers/web/stop-unmanaged")) {
        return jsonResponse(200, { status: "ok", killed: [5001], skipped: [] });
      }
      return jsonResponse(404, { error: "not found" });
    });

    const { result } = renderHook(() => useDevServers("project", "s1"), {
      wrapper: wrapperFor(makeQueryClient()),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.startServer("web");
    });
    await waitFor(() =>
      expect(result.current.unmanagedConflict).not.toBeNull(),
    );

    act(() => {
      result.current.stopUnmanagedAndRetry();
    });

    await waitFor(() => expect(startCallCount).toBe(2));

    const stopCall = calls.find((c) =>
      c.url.endsWith("/dev-servers/web/stop-unmanaged"),
    );
    expect(stopCall).toBeDefined();
    expect(stopCall?.body).toEqual({ port: 3007 });

    await waitFor(() => expect(result.current.unmanagedConflict).toBeNull());
  });
});
