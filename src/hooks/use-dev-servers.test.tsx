// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";

import type { DevServerRuntimeState } from "@/lib/dev-server/schemas";
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

function makeServer(
  overrides: Partial<DevServerRuntimeState> &
    Pick<DevServerRuntimeState, "serverName" | "status">,
): DevServerRuntimeState {
  return {
    command: "bun run dev",
    port: null,
    remoteUrl: null,
    startedAt: null,
    errorMessage: null,
    recentOutput: [],
    ownedByThisSession: true,
    worktreePath: null,
    ownerPid: null,
    logFilePath: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Routes the list endpoint to `servers` (first call only — later refetches
 * hang so rollback can be distinguished from invalidation-driven refetch)
 * and one action endpoint to a deferred response.
 */
function mockFetchWith(
  servers: DevServerRuntimeState[],
  actionSuffix: string,
  action: Promise<Response>,
) {
  let listServed = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.endsWith("/dev-servers")) {
      if (listServed) return new Promise<Response>(() => {});
      listServed = true;
      return jsonResponse(200, { servers });
    }
    if (url.endsWith(actionSuffix)) return action;
    return jsonResponse(404, { error: "not found" });
  });
}

async function renderReady(): Promise<
  ReturnType<typeof renderHook<ReturnType<typeof useDevServers>, unknown>>
> {
  const rendered = renderHook(() => useDevServers("project", "s1"), {
    wrapper: wrapperFor(makeQueryClient()),
  });
  await waitFor(() => expect(rendered.result.current.isLoading).toBe(false));
  return rendered;
}

describe("useDevServers — optimistic status + per-server pending", () => {
  it("startServer optimistically sets the target server to starting before the API responds", async () => {
    const start = deferred<Response>();
    mockFetchWith(
      [
        makeServer({ serverName: "web", status: "stopped" }),
        makeServer({ serverName: "api", status: "stopped" }),
      ],
      "/dev-servers/web/start",
      start.promise,
    );
    const { result } = await renderReady();

    act(() => {
      result.current.startServer("web");
    });

    await waitFor(() =>
      expect(
        result.current.servers.find((s) => s.serverName === "web")?.status,
      ).toBe("starting"),
    );
    expect(
      result.current.servers.find((s) => s.serverName === "api")?.status,
    ).toBe("stopped");

    start.resolve(jsonResponse(202, {}));
  });

  it("rolls back the optimistic starting status when start fails", async () => {
    const start = deferred<Response>();
    mockFetchWith(
      [makeServer({ serverName: "web", status: "stopped" })],
      "/dev-servers/web/start",
      start.promise,
    );
    const { result } = await renderReady();

    act(() => {
      result.current.startServer("web");
    });
    await waitFor(() =>
      expect(result.current.servers[0]?.status).toBe("starting"),
    );

    start.resolve(jsonResponse(500, { error: "boom" }));

    await waitFor(() =>
      expect(result.current.servers[0]?.status).toBe("stopped"),
    );
  });

  it("unmanaged-conflict failure restores the pre-optimistic status and captures the conflict", async () => {
    const start = deferred<Response>();
    mockFetchWith(
      [makeServer({ serverName: "web", status: "stopped" })],
      "/dev-servers/web/start",
      start.promise,
    );
    const { result } = await renderReady();

    act(() => {
      result.current.startServer("web");
    });
    await waitFor(() =>
      expect(result.current.servers[0]?.status).toBe("starting"),
    );

    start.resolve(
      jsonResponse(409, {
        error: "conflict",
        code: "UNMANAGED_DEV_SERVER_DETECTED",
        details: { serverName: "web", port: 3007, pid: 5001, cwd: "/cwd" },
      }),
    );

    await waitFor(() =>
      expect(result.current.unmanagedConflict).not.toBeNull(),
    );
    expect(result.current.servers[0]?.status).toBe("stopped");
  });

  it("startAll optimistically marks all stopped/error servers as starting", async () => {
    const startAll = deferred<Response>();
    mockFetchWith(
      [
        makeServer({ serverName: "a", status: "stopped" }),
        makeServer({ serverName: "b", status: "error" }),
        makeServer({ serverName: "c", status: "running" }),
      ],
      "/dev-servers/start-all",
      startAll.promise,
    );
    const { result } = await renderReady();

    act(() => {
      result.current.startAll();
    });

    await waitFor(() => {
      const byName = new Map(
        result.current.servers.map((s) => [s.serverName, s.status]),
      );
      expect(byName.get("a")).toBe("starting");
      expect(byName.get("b")).toBe("starting");
      expect(byName.get("c")).toBe("running");
    });

    startAll.resolve(jsonResponse(202, {}));
  });

  it("stopServer marks only the targeted server as stop-pending without changing its status", async () => {
    const stop = deferred<Response>();
    mockFetchWith(
      [
        makeServer({ serverName: "web", status: "running" }),
        makeServer({ serverName: "api", status: "running" }),
      ],
      "/dev-servers/web/stop",
      stop.promise,
    );
    const { result } = await renderReady();

    act(() => {
      result.current.stopServer("web");
    });

    await waitFor(() =>
      expect(
        result.current.servers.find((s) => s.serverName === "web")
          ?.isStopPending,
      ).toBe(true),
    );
    const web = result.current.servers.find((s) => s.serverName === "web");
    const api = result.current.servers.find((s) => s.serverName === "api");
    expect(web?.status).toBe("running");
    expect(api?.isStopPending).toBe(false);

    stop.resolve(jsonResponse(200, {}));

    await waitFor(() =>
      expect(
        result.current.servers.find((s) => s.serverName === "web")
          ?.isStopPending,
      ).toBe(false),
    );
  });

  it("stopAll marks every running/starting server as stop-pending and clears on settle", async () => {
    const stopAll = deferred<Response>();
    mockFetchWith(
      [
        makeServer({ serverName: "a", status: "running" }),
        makeServer({ serverName: "b", status: "starting" }),
        makeServer({ serverName: "c", status: "stopped" }),
      ],
      "/dev-servers/stop-all",
      stopAll.promise,
    );
    const { result } = await renderReady();

    act(() => {
      result.current.stopAll();
    });

    await waitFor(() => {
      const byName = new Map(
        result.current.servers.map((s) => [s.serverName, s.isStopPending]),
      );
      expect(byName.get("a")).toBe(true);
      expect(byName.get("b")).toBe(true);
      expect(byName.get("c")).toBe(false);
    });

    stopAll.resolve(jsonResponse(200, {}));

    await waitFor(() =>
      expect(result.current.servers.every((s) => !s.isStopPending)).toBe(true),
    );
  });
});
