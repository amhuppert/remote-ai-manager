// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useProjectTemplatesQuery } from "@/lib/workflows/queries";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useProjectTemplatesQuery", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the project workflow-templates endpoint and returns the tier-tagged items", async () => {
    const items = [
      {
        tier: "global",
        id: "tpl-1",
        name: "Build Feature",
        description: "A reusable build flow",
        revision: 2,
        parameters: [
          { type: "string", name: "feature", label: "Feature", required: true },
        ],
        prerequisites: [{ kind: "path", path: ".kiro" }],
      },
      {
        tier: "project",
        id: "tpl-2",
        name: "Local Flow",
        description: null,
        revision: 1,
        parameters: [],
        prerequisites: [],
      },
    ];
    fetchSpy.mockResolvedValue(jsonResponse({ items }));

    const { result } = renderHook(() => useProjectTemplatesQuery("proj-1"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("/api/projects/proj-1/workflow-templates");
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.[0]?.tier).toBe("global");
    expect(result.current.data?.[1]?.description).toBeNull();
    expect(result.current.data?.[0]?.parameters[0]).toMatchObject({
      type: "string",
      name: "feature",
      required: true,
    });
  });

  it("rejects a malformed item at the validation boundary", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        items: [{ tier: "nope", id: "tpl-1", name: "Bad", revision: 1 }],
      }),
    );

    const { result } = renderHook(() => useProjectTemplatesQuery("proj-1"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
