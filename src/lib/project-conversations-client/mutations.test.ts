// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ActiveConversationsResponse } from "@/lib/active-conversations/schemas";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { useSessionDetailStore } from "@/stores/session-detail.store";
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
    expect(result.current.isSending(null)).toBe(false);
    expect(result.current.errorFor(null)).toBeNull();
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
    expect(result.current.errorFor("c1")).toEqual({
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
    expect(result.current.errorFor("c1")?.message).toBe("Conversation is busy");
  });
});

/**
 * Start an async action inside `act` without awaiting it, so the test can
 * assert on the in-flight state and settle the action later.
 */
function startPending(action: () => Promise<void>): Promise<void> {
  const started: Promise<void>[] = [];
  act(() => {
    started.push(action());
  });
  const pending = started[0];
  if (pending === undefined) throw new Error("action did not start");
  return pending;
}

describe("useSendProjectPrompt: turn state keyed by conversation", () => {
  const fetchSpy = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    useSessionDetailStore.getState().resetStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useSessionDetailStore.getState().resetStore();
  });

  const doneStream = () => sseResponse(["event: done\ndata: {}\n\n"]);

  /** Holds `c1`'s turn open until the test resolves it; `c2` settles at once. */
  function streamingFirstConversation() {
    const held = deferredResponse();
    fetchSpy.mockImplementation((input) =>
      String(input).includes("/conversations/c1/prompt")
        ? held.promise
        : Promise.resolve(doneStream()),
    );
    return held;
  }

  it("starts a turn in a second conversation while the first is still streaming (R3.1)", async () => {
    const held = streamingFirstConversation();
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });

    const firstSend = startPending(() =>
      result.current.send({ conversationId: "c1", text: "one" }),
    );
    await act(async () => {
      await result.current.send({ conversationId: "c2", text: "two" });
    });

    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toContain(
      "/api/projects/proj/conversations/c2/prompt",
    );

    await act(async () => {
      held.resolve(doneStream());
      await firstSend;
    });
  });

  it("still ignores a duplicate send into a conversation whose own turn is in flight", async () => {
    const held = streamingFirstConversation();
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });

    const firstSend = startPending(() =>
      result.current.send({ conversationId: "c1", text: "one" }),
    );
    await act(async () => {
      await result.current.send({ conversationId: "c1", text: "again" });
    });

    expect(
      fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("/conversations/c1/prompt"),
      ),
    ).toHaveLength(1);

    await act(async () => {
      held.resolve(doneStream());
      await firstSend;
    });
  });

  it("reports busy only for the conversation whose turn is running (R3.2)", async () => {
    const held = streamingFirstConversation();
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });

    const firstSend = startPending(() =>
      result.current.send({ conversationId: "c1", text: "one" }),
    );
    await waitFor(() => expect(result.current.isSending("c1")).toBe(true));
    expect(result.current.isSending("c2")).toBe(false);
    expect(result.current.isSending(null)).toBe(false);

    await act(async () => {
      held.resolve(doneStream());
      await firstSend;
    });
    await waitFor(() => expect(result.current.isSending("c1")).toBe(false));
  });

  it("keeps a failed turn's error on its own conversation, and clears only that one (R3.2)", async () => {
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(
        String(input).includes("/conversations/c1/prompt")
          ? jsonResponse({ error: "Conversation is busy" }, 409)
          : doneStream(),
      ),
    );
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });

    await act(async () => {
      await result.current.send({ conversationId: "c1", text: "one" });
    });
    await act(async () => {
      await result.current.send({ conversationId: "c2", text: "two" });
    });

    // A later successful turn elsewhere must not wipe the failure the user
    // still has to read on `c1`.
    expect(result.current.errorFor("c1")?.message).toBe("Conversation is busy");
    expect(result.current.errorFor("c2")).toBeNull();

    await act(async () => {
      result.current.clearError("c2");
    });
    expect(result.current.errorFor("c1")?.message).toBe("Conversation is busy");

    await act(async () => {
      result.current.clearError("c1");
    });
    expect(result.current.errorFor("c1")).toBeNull();
  });

  it("mirrors streamed content onto the conversation that asked for it (R3.2)", async () => {
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(
        String(input).includes("/conversations/c1/prompt")
          ? sseResponse([
              'event: content\ndata: {"type":"text","text":"partial answer"}\n\n',
              "event: done\ndata: {}\n\n",
            ])
          : doneStream(),
      ),
    );
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });

    await act(async () => {
      await result.current.send({ conversationId: "c1", text: "one" });
    });

    const assistantTextFor = (id: string) =>
      (useSessionDetailStore.getState().inFlight[id]?.optimisticMessages ?? [])
        .filter((m) => m.role === "assistant")
        .flatMap((m) =>
          m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
        );
    expect(assistantTextFor("c1")).toEqual(["partial answer"]);
    expect(assistantTextFor("c2")).toEqual([]);
  });
});
