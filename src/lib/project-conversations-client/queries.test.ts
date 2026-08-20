// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useProjectConversationsQuery,
  useProjectConversationCreationsQuery,
  useProjectConversationMessagesQuery,
  isOpenProjectConversation,
} from "./queries";
import type { PublicConversationState } from "@/lib/conversations/schemas";

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

function conv(
  id: string,
  overrides: Partial<PublicConversationState> = {},
): PublicConversationState {
  return {
    redactedProfileSnapshot: null,
    profileLockedAt: null,
    id,
    scope: "project",
    nameOrigin: "default",
    name: id,
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    open: true,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    unread: false,
    pendingQueue: [],
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: "claude",
    backendRef: null,
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    owner: null,
    turnGeneration: 0,
    ...overrides,
  };
}

describe("isOpenProjectConversation", () => {
  it("treats explicitly-open, non-archived rows as open", () => {
    expect(isOpenProjectConversation(conv("a"))).toBe(true);
  });
  it("treats closed (open:false) rows as not open", () => {
    expect(isOpenProjectConversation(conv("a", { open: false }))).toBe(false);
  });
  it("treats archived rows as not open even when open:true", () => {
    expect(
      isOpenProjectConversation(conv("a", { open: true, archived: true })),
    ).toBe(false);
  });
});

describe("useProjectConversationsQuery", () => {
  const fetchSpy = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("hits the documented project conversations route and returns only open PLCs", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        conv("open-1"),
        conv("closed", { open: false }),
        conv("archived", { archived: true }),
      ]),
    );
    const { result } = renderHook(() => useProjectConversationsQuery("proj"), {
      wrapper: wrapperFor(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith("/api/projects/proj/conversations");
    expect(result.current.data?.map((c) => c.id)).toEqual(["open-1"]);
  });

  it("degrades to an empty list when the route is absent (404)", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    const { result } = renderHook(() => useProjectConversationsQuery("proj"), {
      wrapper: wrapperFor(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("rejects a malformed payload", async () => {
    fetchSpy.mockResolvedValue(jsonResponse([{ nope: true }]));
    const { result } = renderHook(() => useProjectConversationsQuery("proj"), {
      wrapper: wrapperFor(makeClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useProjectConversationCreationsQuery", () => {
  const fetchSpy = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports every conversation with the submission that created it, closed and archived included", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        conv("from-a-submission", { creationRequestId: "req-1" }),
        conv("closed", { open: false }),
        conv("archived", { archived: true }),
      ]),
    );
    const { result } = renderHook(
      () => useProjectConversationCreationsQuery("proj"),
      { wrapper: wrapperFor(makeClient()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The complete set, because a pending create-and-send turn's conversation is
    // not necessarily open by the time the client reads it — and each entry
    // carries the creating submission, which is what makes a match causal.
    expect(result.current.data).toEqual([
      { conversationId: "from-a-submission", creationRequestId: "req-1" },
      { conversationId: "closed", creationRequestId: null },
      { conversationId: "archived", creationRequestId: null },
    ]);
  });

  it("keeps the selected array's identity across renders", async () => {
    fetchSpy.mockResolvedValue(jsonResponse([conv("c1")]));
    const { result, rerender } = renderHook(
      () => useProjectConversationCreationsQuery("proj"),
      { wrapper: wrapperFor(makeClient()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const first = result.current.data;
    rerender();

    // Consumers drive an effect off this array; a new identity per render would
    // re-report the same conversations on every render.
    expect(result.current.data).toBe(first);
  });
});

describe("useProjectConversationMessagesQuery", () => {
  const fetchSpy = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("hits the documented messages route and parses transcript messages", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
          timestamp: null,
          seq: 0,
        },
      ]),
    );
    const { result } = renderHook(
      () => useProjectConversationMessagesQuery("proj", "conv-1"),
      { wrapper: wrapperFor(makeClient()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/proj/conversations/conv-1/messages",
    );
    expect(result.current.data?.[0]?.role).toBe("user");
  });

  it("is disabled (no fetch) when there is no active conversation", async () => {
    const { result } = renderHook(
      () => useProjectConversationMessagesQuery("proj", null),
      { wrapper: wrapperFor(makeClient()) },
    );
    // Disabled queries never enter loading/success; data stays undefined.
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
});
