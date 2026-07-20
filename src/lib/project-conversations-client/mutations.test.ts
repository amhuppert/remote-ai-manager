// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ActiveConversationsResponse } from "@/lib/active-conversations/schemas";
import { conversationKeys } from "@/lib/conversations/query-keys";
import {
  useCreateProjectConversation,
  useCloseProjectConversation,
  useReopenProjectConversation,
  useMarkProjectConversationReadMutation,
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

const okConversation: ConversationState = {
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
  debugMode: null,
  machineSnapshot: null,
  pendingQueue: [],
  lastSeenAlignmentVersion: null,
  pendingAgentNotices: [],
};

describe("project conversation lifecycle mutations", () => {
  const fetchSpy = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("create posts to the create route and invalidates the list", async () => {
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
});

function deferredResponse() {
  let resolve!: (value: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const activeResponse: ActiveConversationsResponse = {
  conversations: [
    {
      scope: "project",
      id: "c1",
      name: "c1",
      status: "awaiting",
      lastActivityAt: "2026-01-01T00:00:00Z",
      projectName: "proj",
      projectPath: "/repos/proj",
      agentBackend: "claude",
      summary: null,
      pendingQuestion: null,
      pendingQuestionId: null,
      pendingQuestions: null,
      forkedFrom: null,
      debugActive: false,
      role: null,
      worktreePath: "/repos/proj",
      lastActivitySummary: null,
      unread: true,
      pendingApproval: null,
      open: true,
    },
  ],
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
  specExecutions: [],
};

describe("optimistic lifecycle updates", () => {
  const fetchSpy = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  function seededClient(): QueryClient {
    const client = new QueryClient();
    client.setQueryData<ConversationState[]>(
      projectConversationKeys.list("proj"),
      [okConversation, { ...okConversation, id: "c2", name: "c2" }],
    );
    client.setQueryData<ActiveConversationsResponse>(
      conversationKeys.active(),
      activeResponse,
    );
    return client;
  }

  function openFlag(client: QueryClient, id: string): boolean | undefined {
    const list =
      client.getQueryData<ConversationState[]>(
        projectConversationKeys.list("proj"),
      ) ?? [];
    return list.find((c) => c.id === id)?.open;
  }

  it("close flips open:false in the list cache before the server responds, then invalidates on settle", async () => {
    const deferred = deferredResponse();
    fetchSpy.mockReturnValue(deferred.promise);
    const client = seededClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCloseProjectConversation("proj"), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current.mutate("c1");
    });
    await waitFor(() => expect(openFlag(client, "c1")).toBe(false));
    expect(openFlag(client, "c2")).toBe(true);
    expect(spy).not.toHaveBeenCalled();

    await act(async () => {
      deferred.resolve(jsonResponse({ ok: true }));
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const invalidatedKeys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(
      projectConversationKeys.list("proj"),
    );
  });

  it("close rolls the list cache back when the server rejects", async () => {
    const deferred = deferredResponse();
    fetchSpy.mockReturnValue(deferred.promise);
    const client = seededClient();
    const { result } = renderHook(() => useCloseProjectConversation("proj"), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current.mutate("c1");
    });
    await waitFor(() => expect(openFlag(client, "c1")).toBe(false));

    await act(async () => {
      deferred.reject(new Error("boom"));
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(openFlag(client, "c1")).toBe(true);
  });

  it("reopen flips open:true in the list cache before the server responds", async () => {
    const deferred = deferredResponse();
    fetchSpy.mockReturnValue(deferred.promise);
    const client = new QueryClient();
    client.setQueryData<ConversationState[]>(
      projectConversationKeys.list("proj"),
      [{ ...okConversation, open: false }],
    );
    const { result } = renderHook(() => useReopenProjectConversation("proj"), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current.mutate("c1");
    });
    await waitFor(() => expect(openFlag(client, "c1")).toBe(true));
  });

  it("mark-read clears unread in the active cache before the server responds, then invalidates on settle", async () => {
    const deferred = deferredResponse();
    fetchSpy.mockReturnValue(deferred.promise);
    const client = seededClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(
      () => useMarkProjectConversationReadMutation(),
      { wrapper: wrapperFor(client) },
    );

    act(() => {
      result.current.mutate({ projectName: "proj", conversationId: "c1" });
    });
    await waitFor(() => {
      const active = client.getQueryData<ActiveConversationsResponse>(
        conversationKeys.active(),
      );
      expect(active?.conversations[0]?.unread).toBe(false);
    });
    expect(spy).not.toHaveBeenCalled();

    await act(async () => {
      deferred.resolve(jsonResponse({ ok: true }));
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toContainEqual(
      conversationKeys.active(),
    );
  });

  it("mark-read restores unread when the server rejects", async () => {
    const deferred = deferredResponse();
    fetchSpy.mockReturnValue(deferred.promise);
    const client = seededClient();
    const { result } = renderHook(
      () => useMarkProjectConversationReadMutation(),
      { wrapper: wrapperFor(client) },
    );

    act(() => {
      result.current.mutate({ projectName: "proj", conversationId: "c1" });
    });
    await waitFor(() => {
      const active = client.getQueryData<ActiveConversationsResponse>(
        conversationKeys.active(),
      );
      expect(active?.conversations[0]?.unread).toBe(false);
    });

    await act(async () => {
      deferred.reject(new Error("boom"));
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const active = client.getQueryData<ActiveConversationsResponse>(
      conversationKeys.active(),
    );
    expect(active?.conversations[0]?.unread).toBe(true);
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
