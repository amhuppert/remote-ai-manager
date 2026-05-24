// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useConflictsQuery } from "@/lib/git/queries";
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
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

describe("useConflictsQuery", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads conflict analysis", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        jobId: "job-1",
        conflicts: [
          {
            file: "src/app.ts",
            description: "Both branches changed the same line.",
            resolution: "Keep the session version.",
            rationale: "It includes the requested behavior.",
          },
        ],
      }),
    );

    const { result } = renderHook(() => useConflictsQuery("p", "s"), {
      wrapper: wrapperFor(makeClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/conflicts",
    );
    expect(result.current.data?.jobId).toBe("job-1");
    expect(result.current.data?.conflicts?.[0]?.file).toBe("src/app.ts");
  });

  it("returns null when conflict analysis does not exist yet", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "not found" }, 404));

    const { result } = renderHook(() => useConflictsQuery("p", "s"), {
      wrapper: wrapperFor(makeClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBeNull();
  });
});
