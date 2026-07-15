// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useBackendCatalogQuery, useBackendCatalogEntry } from "./queries";
import { listBackendCatalogEntries } from "./catalog";

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function stubCatalogFetch(payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useBackendCatalogQuery", () => {
  it("renders synchronously from the client-safe seed without a loading state", () => {
    stubCatalogFetch({ backends: listBackendCatalogEntries() });
    const { result } = renderHook(() => useBackendCatalogQuery(), {
      wrapper: createWrapper(),
    });
    expect(result.current.data.map((b) => b.id)).toEqual(
      listBackendCatalogEntries().map((b) => b.id),
    );
  });

  it("fetches the server catalog on mount — the seed is hydration, not a permanently-fresh authority", async () => {
    const serverBackends = listBackendCatalogEntries().map((entry) =>
      entry.id === "claude" ? { ...entry, label: "Claude Live" } : entry,
    );
    const fetchMock = stubCatalogFetch({ backends: serverBackends });

    const { result } = renderHook(() => useBackendCatalogQuery(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/agent-backends");
      expect(result.current.data.find((b) => b.id === "claude")?.label).toBe(
        "Claude Live",
      );
    });
  });
});

describe("useBackendCatalogEntry", () => {
  it("resolves a known backend id to its catalog entry", async () => {
    stubCatalogFetch({ backends: listBackendCatalogEntries() });
    const { result } = renderHook(() => useBackendCatalogEntry("codex"), {
      wrapper: createWrapper(),
    });
    expect(result.current?.id).toBe("codex");
    expect(result.current?.label).toBe("Codex");
  });

  it("returns null for an id outside the canonical backend schema — no coercion", () => {
    stubCatalogFetch({ backends: listBackendCatalogEntries() });
    const { result } = renderHook(() => useBackendCatalogEntry("mystery"), {
      wrapper: createWrapper(),
    });
    expect(result.current).toBeNull();
  });
});
