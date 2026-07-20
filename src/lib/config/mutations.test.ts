// @vitest-environment jsdom
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateConfigMutation } from "./mutations";
import { configKeys } from "./query-keys";
import { projectKeys } from "@/lib/projects/query-keys";

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

describe("useUpdateConfigMutation", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            config: {
              baseDir: "/repos",
              ignorePatterns: [],
              claudeTimeoutMs: 3_600_000,
            },
            raw: { commandCenterProjectName: "command-center" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invalidates config and Command Center project resolution after save", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    client.setQueryData(configKeys.full(), { loaded: true });
    client.setQueryData(projectKeys.commandCenter(), {
      projectName: "previous",
    });
    const { result } = renderHook(() => useUpdateConfigMutation(), {
      wrapper: wrapperFor(client),
    });

    await result.current.mutateAsync({
      commandCenterProjectName: "command-center",
    });

    expect(client.getQueryState(configKeys.full())?.isInvalidated).toBe(true);
    expect(
      client.getQueryState(projectKeys.commandCenter())?.isInvalidated,
    ).toBe(true);
  });
});
