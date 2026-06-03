// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useCreateProjectConversation,
  useCloseProjectConversation,
  useReopenProjectConversation,
  useRenameProjectConversation,
  useSendProjectPrompt,
} from "./mutations";
import { projectConversationKeys } from "./query-keys";

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

/** A `text/event-stream` Response emitting the given SSE frames. */
function sseResponse(frames: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const okConversation = {
  id: "c1",
  scope: "project",
  name: "c1",
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
  forkedFrom: null,
  role: null,
  activeTurnSource: null,
  contextTokens: null,
  contextWindowMax: null,
  agentBackend: "claude",
  backendRef: null,
};

describe("project conversation lifecycle mutations", () => {
  const fetchSpy = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("create posts to the create route and invalidates list + open-count", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(okConversation, 201));
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCreateProjectConversation("proj"), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ agentBackend: "codex" });
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/projects/proj/conversations");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ agentBackend: "codex" });
    const invalidatedKeys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(
      projectConversationKeys.list("proj"),
    );
    expect(invalidatedKeys).toContainEqual(
      projectConversationKeys.openCount("proj"),
    );
  });

  it("close PATCHes open:false for the conversation id", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));
    const { result } = renderHook(() => useCloseProjectConversation("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });
    await act(async () => {
      await result.current.mutateAsync("c9");
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/projects/proj/conversations/c9/open");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ open: false });
  });

  it("reopen PATCHes open:true for the conversation id", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));
    const { result } = renderHook(() => useReopenProjectConversation("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });
    await act(async () => {
      await result.current.mutateAsync("c9");
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/projects/proj/conversations/c9/open");
    expect(JSON.parse(init?.body as string)).toEqual({ open: true });
  });

  it("rename PATCHes the new name and invalidates the list", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRenameProjectConversation("proj"), {
      wrapper: wrapperFor(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ conversationId: "c1", name: "New" });
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/projects/proj/conversations/c1/rename");
    expect(JSON.parse(init?.body as string)).toEqual({ name: "New" });
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toContainEqual(
      projectConversationKeys.list("proj"),
    );
  });
});

describe("useSendProjectPrompt", () => {
  const fetchSpy = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("create-and-sends (posts to the first-prompt route) when conversationId is null", async () => {
    fetchSpy.mockResolvedValue(sseResponse(["event: done\ndata: {}\n\n"]));
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });
    await act(async () => {
      await result.current.send({ conversationId: null, text: "hello" });
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/projects/proj/prompt");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toMatchObject({ prompt: "hello" });
    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("posts to the per-conversation prompt route when a conversation id is provided", async () => {
    fetchSpy.mockResolvedValue(sseResponse(["event: done\ndata: {}\n\n"]));
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });
    await act(async () => {
      await result.current.send({
        conversationId: "c1",
        text: "go",
        backend: "codex",
        modelId: "gpt-5.4",
        effort: "high",
      });
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/projects/proj/conversations/c1/prompt");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      prompt: "go",
      backend: "codex",
      modelId: "gpt-5.4",
      effort: "high",
    });
  });

  it("surfaces a backend-mismatch error frame through the error envelope", async () => {
    fetchSpy.mockResolvedValue(
      sseResponse([
        'event: error\ndata: {"message":"Backend is locked","code":"BACKEND_MISMATCH"}\n\n',
        "event: done\ndata: {}\n\n",
      ]),
    );
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });
    await act(async () => {
      await result.current.send({ conversationId: "c1", text: "go" });
    });
    expect(result.current.error).toEqual({
      message: "Backend is locked",
      code: "BACKEND_MISMATCH",
    });
  });

  it("surfaces an HTTP 409 busy error without a stream", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: "Conversation is busy" }, 409),
    );
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });
    await act(async () => {
      await result.current.send({ conversationId: "c1", text: "go" });
    });
    expect(result.current.error?.message).toBe("Conversation is busy");
  });
});
