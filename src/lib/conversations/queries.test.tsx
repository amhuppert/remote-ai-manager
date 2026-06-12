// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { useConversationLookupQuery } from "./queries";
import type { ConversationListItem } from "./schemas";

function makeItem(id: string): ConversationListItem {
  return {
    projectName: "proj",
    projectPath: "/projects/proj",
    sessionName: "main",
    worktreePath: "/projects/proj/.worktrees/main",
    conversationId: id,
    conversationName: id,
    summary: null,
    firstPromptSnippet: null,
    backend: "claude",
    backendRef: null,
    transcriptPath: null,
    debugLogPath: null,
    status: "new",
    lastActivityAt: "2024-01-01T00:00:00Z",
    archived: false,
  };
}

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useConversationLookupQuery", () => {
  it("is disabled when conversationId is null", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useConversationLookupQuery(null), {
      wrapper: createWrapper(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("fetches the conversation by id and returns the item", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(makeItem("abc123")));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useConversationLookupQuery("abc123"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.conversationId).toBe("abc123");
    expect(result.current.data?.projectName).toBe("proj");
    expect(fetchMock).toHaveBeenCalledWith("/api/conversations/abc123");
  });

  it("encodes the conversationId in the request URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(makeItem("a b/c")));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useConversationLookupQuery("a b/c"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/conversations/a%20b%2Fc");
  });

  it("surfaces a 404 as a not-found state (null data), not an error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "conversation_not_found" }, 404),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useConversationLookupQuery("missing"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("surfaces non-404 failures as an error state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "kaboom" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useConversationLookupQuery("abc123"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
