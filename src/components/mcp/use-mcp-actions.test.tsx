// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";

import { useMcpActions } from "./use-mcp-actions";

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMcpActions — refresh pending exposure", () => {
  it("reports the server key whose tool refresh is in flight", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(
      () => useMcpActions({ level: "global" }, []),
      { wrapper: wrapperFor(createQueryClient()) },
    );

    expect(result.current.refreshingServerId).toBeUndefined();

    act(() => {
      result.current.onRefreshTools?.("playwright");
    });

    await waitFor(() => {
      expect(result.current.refreshingServerId).toBe("playwright");
    });
  });
});
