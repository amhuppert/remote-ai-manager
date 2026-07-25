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
  conversationTurnKey,
  type ProjectConversationCreation,
  type ProjectTurnSubmission,
  type ProvisionalTurnKey,
  type UseSendProjectPromptResult,
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

  it("create-and-sends (posts to the first-prompt route) when the target is a new conversation", async () => {
    fetchSpy.mockResolvedValue(sseResponse(["event: done\ndata: {}\n\n"]));
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });
    await act(async () => {
      await result.current.send({ target: { kind: "create" }, text: "hello" })
        .settled;
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/projects/proj/prompt");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toMatchObject({ prompt: "hello" });
    expect(result.current.provisionalKeys).toEqual([]);
  });

  it("posts to the per-conversation prompt route when the target is a conversation", async () => {
    fetchSpy.mockResolvedValue(sseResponse(["event: done\ndata: {}\n\n"]));
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });
    await act(async () => {
      await result.current.send({
        target: conversationTurnKey("c1"),
        text: "go",
        backend: "codex",
        modelId: "gpt-5.4",
        effort: "high",
      }).settled;
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
      await result.current.send({
        target: conversationTurnKey("c1"),
        text: "go",
      }).settled;
    });
    expect(result.current.errorFor(conversationTurnKey("c1"))).toEqual({
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
      await result.current.send({
        target: conversationTurnKey("c1"),
        text: "go",
      }).settled;
    });
    expect(result.current.errorFor(conversationTurnKey("c1"))?.message).toBe(
      "Conversation is busy",
    );
  });
});

/**
 * Start a turn inside `act` without awaiting it, so the test can assert on the
 * in-flight state and settle the turn later. Returns the submission the caller
 * addresses the turn by.
 */
function startTurn(
  sender: () => UseSendProjectPromptResult,
  input: Parameters<UseSendProjectPromptResult["send"]>[0],
): ProjectTurnSubmission {
  const started: ProjectTurnSubmission[] = [];
  act(() => {
    started.push(sender().send(input));
  });
  const submission = started[0];
  if (submission === undefined) throw new Error("send returned no submission");
  return submission;
}

/** Narrow a submission to the provisional key a create-and-send allocated. */
function provisionalKeyOf(
  submission: ProjectTurnSubmission,
): ProvisionalTurnKey {
  const { key } = submission;
  if (key.kind !== "provisional") {
    throw new Error(`expected a provisional key, got "${key.kind}"`);
  }
  return key;
}

/** The streamed assistant text mirrored onto a key's in-flight transcript. */
function assistantTextFor(storageId: string): string[] {
  return (
    useSessionDetailStore.getState().inFlight[storageId]?.optimisticMessages ??
    []
  )
    .filter((m) => m.role === "assistant")
    .flatMap((m) =>
      m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
    );
}

/** The optimistic prompt text mirrored onto a key's in-flight transcript. */
function userTextFor(storageId: string): string[] {
  return (
    useSessionDetailStore.getState().inFlight[storageId]?.optimisticMessages ??
    []
  )
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
    );
}

/** Every key the shared in-flight store currently holds turn state under. */
function inFlightKeys(): string[] {
  return Object.keys(useSessionDetailStore.getState().inFlight);
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

    const first = startTurn(() => result.current, {
      target: conversationTurnKey("c1"),
      text: "one",
    });
    await act(async () => {
      await result.current.send({
        target: conversationTurnKey("c2"),
        text: "two",
      }).settled;
    });

    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toContain(
      "/api/projects/proj/conversations/c2/prompt",
    );

    await act(async () => {
      held.resolve(doneStream());
      await first.settled;
    });
  });

  it("still ignores a duplicate send into a conversation whose own turn is in flight", async () => {
    const held = streamingFirstConversation();
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });

    const first = startTurn(() => result.current, {
      target: conversationTurnKey("c1"),
      text: "one",
    });
    await act(async () => {
      await result.current.send({
        target: conversationTurnKey("c1"),
        text: "again",
      }).settled;
    });

    expect(
      fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("/conversations/c1/prompt"),
      ),
    ).toHaveLength(1);

    await act(async () => {
      held.resolve(doneStream());
      await first.settled;
    });
  });

  it("reports busy only for the conversation whose turn is running (R3.2)", async () => {
    const held = streamingFirstConversation();
    const { result } = renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });

    const first = startTurn(() => result.current, {
      target: conversationTurnKey("c1"),
      text: "one",
    });
    await waitFor(() =>
      expect(result.current.isSending(conversationTurnKey("c1"))).toBe(true),
    );
    expect(result.current.isSending(conversationTurnKey("c2"))).toBe(false);
    expect(result.current.isSending(null)).toBe(false);

    await act(async () => {
      held.resolve(doneStream());
      await first.settled;
    });
    await waitFor(() =>
      expect(result.current.isSending(conversationTurnKey("c1"))).toBe(false),
    );
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
      await result.current.send({
        target: conversationTurnKey("c1"),
        text: "one",
      }).settled;
    });
    await act(async () => {
      await result.current.send({
        target: conversationTurnKey("c2"),
        text: "two",
      }).settled;
    });

    // A later successful turn elsewhere must not wipe the failure the user
    // still has to read on `c1`.
    expect(result.current.errorFor(conversationTurnKey("c1"))?.message).toBe(
      "Conversation is busy",
    );
    expect(result.current.errorFor(conversationTurnKey("c2"))).toBeNull();

    await act(async () => {
      result.current.clearError(conversationTurnKey("c2"));
    });
    expect(result.current.errorFor(conversationTurnKey("c1"))?.message).toBe(
      "Conversation is busy",
    );

    await act(async () => {
      result.current.clearError(conversationTurnKey("c1"));
    });
    expect(result.current.errorFor(conversationTurnKey("c1"))).toBeNull();
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
      await result.current.send({
        target: conversationTurnKey("c1"),
        text: "one",
      }).settled;
    });

    expect(assistantTextFor("c1")).toEqual(["partial answer"]);
    expect(assistantTextFor("c2")).toEqual([]);
  });
});

/**
 * An SSE response the test feeds one frame at a time, so a turn can be observed
 * mid-stream rather than only after it settles.
 */
function scriptedStream(): {
  response: Response;
  push(frame: string): Promise<void>;
  close(): Promise<void>;
} {
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllers.push(controller);
    },
  });
  const controller = controllers[0];
  if (controller === undefined) {
    throw new Error("stream start did not run synchronously");
  }
  const enc = new TextEncoder();
  return {
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    push: async (frame: string) => {
      await act(async () => {
        controller.enqueue(enc.encode(frame));
      });
    },
    close: async () => {
      await act(async () => {
        controller.close();
      });
    },
  };
}

const DONE_FRAME = "event: done\ndata: {}\n\n";
const ABORTED_FRAME = "event: aborted\ndata: {}\n\n";
const conversationFrame = (id: string) =>
  `event: conversation\ndata: {"conversationId":"${id}"}\n\n`;
const textFrame = (text: string) =>
  `event: content\ndata: {"type":"text","text":"${text}"}\n\n`;
const errorFrame = (message: string) =>
  `event: error\ndata: {"message":"${message}"}\n\n`;

const CREATE = { kind: "create" } as const;

/**
 * Provisional conversation identity for the create-and-send path: a submission
 * with no conversation id yet owns an allocated key, adopts the conversation
 * the server names for it from whichever id source arrives first, and releases
 * the key at that moment (R3.4–R3.8).
 */
describe("useSendProjectPrompt: provisional conversation identity", () => {
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

  function renderSender() {
    return renderHook(() => useSendProjectPrompt("proj"), {
      wrapper: wrapperFor(new QueryClient()),
    });
  }

  /** Serve one scripted stream per prompt request, in call order. */
  function serveStreams(...streams: Array<{ response: Response }>) {
    let served = 0;
    fetchSpy.mockImplementation(() => {
      const stream = streams[served];
      served += 1;
      if (stream === undefined) throw new Error("unexpected extra request");
      return Promise.resolve(stream.response);
    });
  }

  /**
   * The token this client actually sent on its nth create-and-send request
   * (0-based). Read off the request body, so a list report built from it is
   * exactly what a server that recorded the token would report back — the
   * correlation is proved end to end rather than assumed.
   */
  function tokenSent(nth: number): string {
    const creates = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith("/proj/prompt"),
    );
    const raw = creates[nth]?.[1]?.body;
    const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : "null");
    const token =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { creationRequestId?: unknown }).creationRequestId
        : undefined;
    if (typeof token !== "string" || token === "") {
      throw new Error(`create-and-send #${nth} sent no creationRequestId`);
    }
    return token;
  }

  /** A conversation the list reports as created for a given submission token. */
  function createdFor(
    conversationId: string,
    creationRequestId: string,
  ): ProjectConversationCreation {
    return { conversationId, creationRequestId };
  }

  /**
   * A conversation the list reports that records no creating submission: it
   * predates this client, was created through the explicit create route, or was
   * created by a client that sent no token.
   */
  function createdByNobody(
    conversationId: string,
  ): ProjectConversationCreation {
    return { conversationId, creationRequestId: null };
  }

  // -- R3.4: allocate before the request, and attribute everything to it -----

  it("allocates an explicit provisional key that already owns the turn's state when the request is issued (R3.4)", async () => {
    const stream = scriptedStream();
    let inFlightAtRequest: string[] = [];
    fetchSpy.mockImplementation(() => {
      inFlightAtRequest = inFlightKeys();
      return Promise.resolve(stream.response);
    });

    const { result } = renderSender();
    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const key = provisionalKeyOf(submission);

    // The key is an allocated value the submission hands back, and the turn's
    // optimistic prompt is already attributed to it when the request goes out —
    // not a nullable-id branch filled in later.
    expect(key.provisionalId).not.toBe("");
    expect(inFlightAtRequest).toEqual([key.provisionalId]);
    expect(userTextFor(key.provisionalId)).toEqual(["hello"]);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "/api/projects/proj/prompt",
    );
    // The submission's own token went out with the request, so the conversation
    // the server creates for it is identifiable as this turn's.
    expect(tokenSent(0)).not.toBe("");

    await waitFor(() => expect(result.current.isSending(key)).toBe(true));
    expect(result.current.provisionalKeys).toEqual([key]);

    await stream.push(textFrame("partial answer"));
    await waitFor(() =>
      expect(assistantTextFor(key.provisionalId)).toEqual(["partial answer"]),
    );

    await stream.push(errorFrame("mid-turn failure"));
    await waitFor(() =>
      expect(result.current.errorFor(key)?.message).toBe("mid-turn failure"),
    );

    await stream.push(DONE_FRAME);
    await act(async () => {
      await submission.settled;
    });
  });

  it("keeps a create-and-send turn's pre-adoption state off every conversation key (R3.4)", async () => {
    const created = scriptedStream();
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(
        String(input).endsWith("/proj/prompt")
          ? created.response
          : sseResponse([textFrame("c1 answer"), DONE_FRAME]),
      ),
    );

    const { result } = renderSender();
    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "new chat",
    });
    const key = provisionalKeyOf(submission);
    await created.push(textFrame("unnamed answer"));

    // A concurrent turn in an existing conversation neither sees nor is seen by
    // the unnamed one.
    await act(async () => {
      await result.current.send({
        target: conversationTurnKey("c1"),
        text: "existing",
      }).settled;
    });

    expect(assistantTextFor("c1")).toEqual(["c1 answer"]);
    expect(assistantTextFor(key.provisionalId)).toEqual(["unnamed answer"]);
    expect(userTextFor("c1")).toEqual(["existing"]);
    expect(userTextFor(key.provisionalId)).toEqual(["new chat"]);
    expect(result.current.isSending(conversationTurnKey("c1"))).toBe(false);
    expect(result.current.isSending(key)).toBe(true);

    await created.push(DONE_FRAME);
    await act(async () => {
      await submission.settled;
    });
  });

  it("sends no creation token when the turn targets an existing conversation (R3.4)", async () => {
    fetchSpy.mockResolvedValue(sseResponse([DONE_FRAME]));
    const { result } = renderSender();

    await act(async () => {
      await result.current.send({
        target: conversationTurnKey("c1"),
        text: "existing",
      }).settled;
    });

    // Nothing is created, so there is nothing to correlate — and a token on this
    // request would let the list hand this turn a conversation it never created.
    const body: unknown = JSON.parse(
      String(fetchSpy.mock.calls[0]?.[1]?.body ?? "null"),
    );
    expect(body).not.toHaveProperty("creationRequestId");
  });

  // -- R3.5: adoption is exactly-once and order-independent ------------------

  it("adopts from the prompt request stream and treats the later list event as a no-op (R3.5)", async () => {
    const stream = scriptedStream();
    serveStreams(stream);
    const { result } = renderSender();
    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const key = provisionalKeyOf(submission);

    await stream.push(conversationFrame("c9"));
    await stream.push(textFrame("streamed reply"));
    await waitFor(() =>
      expect(assistantTextFor("c9")).toEqual(["streamed reply"]),
    );
    expect(result.current.isSending(conversationTurnKey("c9"))).toBe(true);
    expect(result.current.provisionalKeys).toEqual([]);

    // The list reports the same conversation, recording the same submission. A
    // second adoption would re-seed the conversation's optimistic messages and
    // drop the streamed reply, so this is what exactly-once looks like.
    await act(async () => {
      result.current.noticeConversations([createdFor("c9", tokenSent(0))]);
    });
    expect(assistantTextFor("c9")).toEqual(["streamed reply"]);
    expect(result.current.isSending(key)).toBe(false);

    await stream.push(DONE_FRAME);
    await act(async () => {
      await submission.settled;
    });
  });

  it("adopts from the project conversation list event and treats the later stream event as a no-op (R3.5)", async () => {
    const stream = scriptedStream();
    serveStreams(stream);
    const { result } = renderSender();
    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const key = provisionalKeyOf(submission);

    // The list arrives first — the order that defeated the previous attempts.
    // It names this turn because the conversation records this submission.
    await act(async () => {
      result.current.noticeConversations([createdFor("c9", tokenSent(0))]);
    });
    await waitFor(() =>
      expect(result.current.isSending(conversationTurnKey("c9"))).toBe(true),
    );
    expect(result.current.provisionalKeys).toEqual([]);
    expect(result.current.isSending(key)).toBe(false);

    await stream.push(textFrame("streamed reply"));
    await waitFor(() =>
      expect(assistantTextFor("c9")).toEqual(["streamed reply"]),
    );

    // The stream names the conversation the list already did; adopting again
    // would drop the streamed reply.
    await stream.push(conversationFrame("c9"));
    expect(assistantTextFor("c9")).toEqual(["streamed reply"]);
    expect(result.current.provisionalKeys).toEqual([]);

    await stream.push(DONE_FRAME);
    await act(async () => {
      await submission.settled;
    });
  });

  it("adopts from the list even when the request stream never names the conversation (R3.5)", async () => {
    // The fallback the second source exists for: the turn keeps streaming, but
    // its `conversation` frame was lost. Nothing else can name this turn, and a
    // guess at which conversation is unaccounted for is what the token replaces.
    const stream = scriptedStream();
    serveStreams(stream);
    const { result } = renderSender();
    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const key = provisionalKeyOf(submission);
    await stream.push(textFrame("before the name"));

    await act(async () => {
      result.current.noticeConversations([createdFor("c9", tokenSent(0))]);
    });

    await waitFor(() => expect(result.current.provisionalKeys).toEqual([]));
    expect(userTextFor("c9")).toEqual(["hello"]);
    expect(assistantTextFor("c9")).toEqual(["before the name"]);
    expect(inFlightKeys()).toEqual(["c9"]);

    await stream.push(textFrame(" and after"));
    await waitFor(() =>
      expect(assistantTextFor("c9")).toEqual(["before the name", " and after"]),
    );
    expect(result.current.isSending(key)).toBe(false);

    await stream.push(DONE_FRAME);
    await act(async () => {
      await submission.settled;
    });
  });

  it("reaches identical state under the conversation id whichever source arrived first (R3.5)", async () => {
    async function runAdoption(order: "stream-first" | "list-first") {
      useSessionDetailStore.getState().resetStore();
      fetchSpy.mockReset();
      const stream = scriptedStream();
      serveStreams(stream);
      const { result, unmount } = renderSender();
      const submission = startTurn(() => result.current, {
        target: CREATE,
        text: "hello",
      });
      const listEvent = async () => {
        await act(async () => {
          result.current.noticeConversations([createdFor("c9", tokenSent(0))]);
        });
      };

      if (order === "list-first") {
        await listEvent();
        await stream.push(conversationFrame("c9"));
      } else {
        await stream.push(conversationFrame("c9"));
        await listEvent();
      }
      await stream.push(textFrame("streamed reply"));
      await waitFor(() =>
        expect(assistantTextFor("c9")).toEqual(["streamed reply"]),
      );

      const snapshot = {
        sending: result.current.isSending(conversationTurnKey("c9")),
        error: result.current.errorFor(conversationTurnKey("c9")),
        provisionalKeys: [...result.current.provisionalKeys],
        inFlightKeys: inFlightKeys(),
        userText: userTextFor("c9"),
        assistantText: assistantTextFor("c9"),
      };

      await stream.push(DONE_FRAME);
      await act(async () => {
        await submission.settled;
      });
      unmount();
      return snapshot;
    }

    const streamFirst = await runAdoption("stream-first");
    const listFirst = await runAdoption("list-first");

    expect(listFirst).toEqual(streamFirst);
    expect(streamFirst).toEqual({
      sending: true,
      error: null,
      provisionalKeys: [],
      inFlightKeys: ["c9"],
      userText: ["hello"],
      assistantText: ["streamed reply"],
    });
  });

  // -- R3.6: concurrent create-and-send submissions stay separate -----------

  it("allocates a distinct key for a create-and-send issued while an earlier one is still unnamed, and each adopts only its own conversation (R3.6)", async () => {
    const first = scriptedStream();
    const second = scriptedStream();
    serveStreams(first, second);
    const { result } = renderSender();

    const one = startTurn(() => result.current, {
      target: CREATE,
      text: "prompt one",
    });
    const two = startTurn(() => result.current, {
      target: CREATE,
      text: "prompt two",
    });
    const keyOne = provisionalKeyOf(one);
    const keyTwo = provisionalKeyOf(two);

    expect(keyOne.provisionalId).not.toBe(keyTwo.provisionalId);
    expect(tokenSent(0)).not.toBe(tokenSent(1));
    await waitFor(() =>
      expect(result.current.provisionalKeys).toEqual([keyOne, keyTwo]),
    );
    expect(userTextFor(keyOne.provisionalId)).toEqual(["prompt one"]);
    expect(userTextFor(keyTwo.provisionalId)).toEqual(["prompt two"]);

    await first.push(textFrame("answer one"));
    await second.push(errorFrame("two failed"));
    await waitFor(() =>
      expect(result.current.errorFor(keyTwo)?.message).toBe("two failed"),
    );
    expect(result.current.errorFor(keyOne)).toBeNull();
    expect(assistantTextFor(keyTwo.provisionalId)).toEqual([]);

    // Each turn adopts the conversation returned for its own request.
    await second.push(conversationFrame("c-two"));
    await first.push(conversationFrame("c-one"));

    await waitFor(() => expect(result.current.provisionalKeys).toEqual([]));
    expect(userTextFor("c-one")).toEqual(["prompt one"]);
    expect(assistantTextFor("c-one")).toEqual(["answer one"]);
    expect(userTextFor("c-two")).toEqual(["prompt two"]);
    expect(result.current.errorFor(conversationTurnKey("c-two"))?.message).toBe(
      "two failed",
    );
    expect(result.current.errorFor(conversationTurnKey("c-one"))).toBeNull();

    await first.push(DONE_FRAME);
    await second.push(DONE_FRAME);
    await act(async () => {
      await Promise.all([one.settled, two.settled]);
    });
  });

  it("pairs each concurrent submission with its own conversation when the list reports both, in either report order (R3.5, R3.6)", async () => {
    const first = scriptedStream();
    const second = scriptedStream();
    serveStreams(first, second);
    const { result } = renderSender();

    const one = startTurn(() => result.current, {
      target: CREATE,
      text: "prompt one",
    });
    const two = startTurn(() => result.current, {
      target: CREATE,
      text: "prompt two",
    });
    const keyOne = provisionalKeyOf(one);
    const keyTwo = provisionalKeyOf(two);
    await waitFor(() => expect(result.current.provisionalKeys).toHaveLength(2));
    await first.push(textFrame("answer one"));
    await second.push(textFrame("answer two"));

    // Reported in the opposite order to submission, and with an unrelated
    // conversation in between: the list is a set, not a sequence, so ordering
    // must not be what decides who gets what.
    await act(async () => {
      result.current.noticeConversations([
        createdFor("c-two", tokenSent(1)),
        createdByNobody("c-unrelated"),
        createdFor("c-one", tokenSent(0)),
      ]);
    });

    await waitFor(() => expect(result.current.provisionalKeys).toEqual([]));
    expect(userTextFor("c-one")).toEqual(["prompt one"]);
    expect(assistantTextFor("c-one")).toEqual(["answer one"]);
    expect(userTextFor("c-two")).toEqual(["prompt two"]);
    expect(assistantTextFor("c-two")).toEqual(["answer two"]);
    expect(userTextFor("c-unrelated")).toEqual([]);
    expect(inFlightKeys().sort()).toEqual(["c-one", "c-two"]);
    expect(result.current.isSending(keyOne)).toBe(false);
    expect(result.current.isSending(keyTwo)).toBe(false);

    await first.push(DONE_FRAME);
    await second.push(DONE_FRAME);
    await act(async () => {
      await Promise.all([one.settled, two.settled]);
    });
  });

  it("ignores a conversation created while a submission is pending that the submission did not create (R3.6)", async () => {
    // Exactly one turn is unnamed, which is when a count-based pairing is most
    // tempted to guess. Every conversation here is new to this client and none
    // is this turn's: one has no creating submission at all (another tab's
    // explicit create), one records a different client's submission, and one
    // records this client's earlier, already-settled submission.
    const settled = scriptedStream();
    const pending = scriptedStream();
    serveStreams(settled, pending);
    const { result } = renderSender();

    const earlier = startTurn(() => result.current, {
      target: CREATE,
      text: "earlier",
    });
    await settled.push(conversationFrame("c-earlier"));
    await settled.push(DONE_FRAME);
    await act(async () => {
      await earlier.settled;
    });

    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "mine",
    });
    const key = provisionalKeyOf(submission);
    await pending.push(textFrame("my answer"));

    await act(async () => {
      result.current.noticeConversations([
        createdByNobody("c-another-tab"),
        createdFor("c-other-client", "some-other-client-token-1"),
        createdFor("c-earlier", tokenSent(0)),
      ]);
    });

    // Nothing moved: the turn still owns its provisional key, and no reported
    // conversation acquired this turn's state.
    expect(result.current.provisionalKeys).toEqual([key]);
    expect(inFlightKeys()).toContain(key.provisionalId);
    expect(inFlightKeys()).not.toContain("c-another-tab");
    expect(inFlightKeys()).not.toContain("c-other-client");
    expect(result.current.isSending(key)).toBe(true);
    expect(userTextFor("c-another-tab")).toEqual([]);
    expect(userTextFor("c-other-client")).toEqual([]);
    // The earlier submission's own conversation still holds the earlier prompt,
    // untouched by the pending one.
    expect(userTextFor("c-earlier")).toEqual(["earlier"]);

    // The turn's own stream still names its own conversation — it was never
    // spent on somebody else's.
    await pending.push(conversationFrame("c-mine"));
    await waitFor(() => expect(result.current.provisionalKeys).toEqual([]));
    expect(userTextFor("c-mine")).toEqual(["mine"]);
    expect(assistantTextFor("c-mine")).toEqual(["my answer"]);

    await pending.push(DONE_FRAME);
    await act(async () => {
      await submission.settled;
    });
  });

  it("does not let the conversation list retarget either turn while two are unnamed (R3.6)", async () => {
    const first = scriptedStream();
    const second = scriptedStream();
    serveStreams(first, second);
    const { result } = renderSender();

    const one = startTurn(() => result.current, {
      target: CREATE,
      text: "prompt one",
    });
    const two = startTurn(() => result.current, {
      target: CREATE,
      text: "prompt two",
    });
    const keyOne = provisionalKeyOf(one);
    const keyTwo = provisionalKeyOf(two);
    await waitFor(() => expect(result.current.provisionalKeys).toHaveLength(2));

    // A conversation that records no submission cannot be either turn's, however
    // few candidates are left to reason about.
    await act(async () => {
      result.current.noticeConversations([createdByNobody("c-one")]);
    });

    expect(result.current.provisionalKeys).toEqual([keyOne, keyTwo]);
    expect(result.current.isSending(conversationTurnKey("c-one"))).toBe(false);
    expect(inFlightKeys()).toEqual([
      keyOne.provisionalId,
      keyTwo.provisionalId,
    ]);

    await first.push(DONE_FRAME);
    await second.push(DONE_FRAME);
    await act(async () => {
      await Promise.all([one.settled, two.settled]);
    });
  });

  it("does not re-adopt a conversation the turn that created it already claimed (R3.6, R3.7)", async () => {
    const first = scriptedStream();
    const second = scriptedStream();
    serveStreams(first, second);
    const { result } = renderSender();

    const one = startTurn(() => result.current, {
      target: CREATE,
      text: "prompt one",
    });
    const two = startTurn(() => result.current, {
      target: CREATE,
      text: "prompt two",
    });
    const keyOne = provisionalKeyOf(one);
    await second.push(textFrame("answer two"));

    // The second turn's stream names its conversation before the list has ever
    // mentioned it, so that id is new to the list — and the first turn is the
    // only one still unnamed when the list reports it.
    await second.push(conversationFrame("c-two"));
    await waitFor(() =>
      expect(result.current.provisionalKeys).toEqual([keyOne]),
    );

    await act(async () => {
      result.current.noticeConversations([createdFor("c-two", tokenSent(1))]);
    });

    expect(result.current.provisionalKeys).toEqual([keyOne]);
    expect(userTextFor("c-two")).toEqual(["prompt two"]);
    expect(assistantTextFor("c-two")).toEqual(["answer two"]);
    expect(userTextFor(keyOne.provisionalId)).toEqual(["prompt one"]);
    expect(result.current.isSending(keyOne)).toBe(true);

    await first.push(conversationFrame("c-one"));
    await waitFor(() => expect(result.current.provisionalKeys).toEqual([]));
    expect(userTextFor("c-one")).toEqual(["prompt one"]);
    expect(userTextFor("c-two")).toEqual(["prompt two"]);

    await first.push(DONE_FRAME);
    await second.push(DONE_FRAME);
    await act(async () => {
      await Promise.all([one.settled, two.settled]);
    });
  });

  it("still adopts from the list for a later submission after an earlier one failed without a conversation id (R3.5, R3.8)", async () => {
    // The uncertain failure: the transport died, so nothing proves whether the
    // server created a conversation for that submission first. That uncertainty
    // must not disable the list for every submission that follows — and if the
    // failed submission's conversation does surface, it belongs to no pending
    // turn.
    const retryStream = scriptedStream();
    let call = 0;
    fetchSpy.mockImplementation(() => {
      call += 1;
      return call === 1
        ? Promise.reject(new Error("connection reset"))
        : Promise.resolve(retryStream.response);
    });

    const { result } = renderSender();
    const failed = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const failedKey = provisionalKeyOf(failed);
    await act(async () => {
      await failed.settled;
    });
    expect(result.current.errorFor(failedKey)?.message).toBe(
      "Failed to send prompt",
    );

    const retry = startTurn(() => result.current, {
      target: CREATE,
      text: "hello again",
    });
    const retryKey = provisionalKeyOf(retry);
    // Retrying released the failed key, so nothing of that submission survives
    // except the ownership question over a conversation it may have created.
    expect(result.current.provisionalKeys).toEqual([retryKey]);

    await act(async () => {
      result.current.noticeConversations([
        // The failed submission's conversation, created before the connection
        // broke. It records that submission, not this one.
        createdFor("c-orphan", tokenSent(0)),
        createdFor("c-retry", tokenSent(1)),
      ]);
    });

    await waitFor(() => expect(result.current.provisionalKeys).toEqual([]));
    expect(userTextFor("c-retry")).toEqual(["hello again"]);
    expect(userTextFor("c-orphan")).toEqual([]);
    expect(inFlightKeys()).toEqual(["c-retry"]);
    expect(result.current.isSending(conversationTurnKey("c-retry"))).toBe(true);
    expect(result.current.isSending(conversationTurnKey("c-orphan"))).toBe(
      false,
    );

    await retryStream.push(DONE_FRAME);
    await act(async () => {
      await retry.settled;
    });
  });

  it("still adopts from the list after a failure the user dismissed rather than retried (R3.5, R3.8)", async () => {
    const later = scriptedStream();
    let call = 0;
    fetchSpy.mockImplementation(() => {
      call += 1;
      return call === 1
        ? Promise.reject(new Error("connection reset"))
        : Promise.resolve(later.response);
    });

    const { result } = renderSender();
    const failed = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const failedKey = provisionalKeyOf(failed);
    await act(async () => {
      await failed.settled;
    });
    await act(async () => {
      result.current.clearError(failedKey);
    });
    expect(result.current.provisionalKeys).toEqual([]);

    // A fresh submission much later. The earlier uncertainty is not a permanent
    // veto over the list source.
    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "much later",
    });
    await act(async () => {
      result.current.noticeConversations([createdFor("c-late", tokenSent(1))]);
    });

    await waitFor(() => expect(result.current.provisionalKeys).toEqual([]));
    expect(userTextFor("c-late")).toEqual(["much later"]);
    expect(inFlightKeys()).toEqual(["c-late"]);

    await later.push(DONE_FRAME);
    await act(async () => {
      await submission.settled;
    });
  });

  // -- R3.7: release on adoption ------------------------------------------

  it("releases the provisional key on adoption: no state, and no later lookup reaches it (R3.7)", async () => {
    const stream = scriptedStream();
    serveStreams(stream);
    const { result } = renderSender();
    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const key = provisionalKeyOf(submission);

    await stream.push(conversationFrame("c9"));
    await waitFor(() => expect(result.current.provisionalKeys).toEqual([]));

    // Not enumerable, holding no state, and in neither store.
    expect(result.current.provisionalKeys).not.toContainEqual(key);
    expect(result.current.isSending(key)).toBe(false);
    expect(result.current.errorFor(key)).toBeNull();
    expect(inFlightKeys()).toEqual(["c9"]);

    // Nothing a later frame or list event does can make the key reachable
    // again, or retarget the turn that released it.
    await stream.push(conversationFrame("c-other"));
    await stream.push(errorFrame("late failure"));
    await act(async () => {
      result.current.noticeConversations([
        createdFor("c9", tokenSent(0)),
        // A conversation recording this very submission would still find no
        // turn to name: the key it belonged to is gone, not merely empty.
        createdFor("c-other", tokenSent(0)),
      ]);
    });

    expect(result.current.provisionalKeys).toEqual([]);
    expect(result.current.isSending(key)).toBe(false);
    expect(result.current.errorFor(key)).toBeNull();
    expect(inFlightKeys()).toEqual(["c9"]);
    expect(result.current.errorFor(conversationTurnKey("c9"))?.message).toBe(
      "late failure",
    );
    expect(result.current.errorFor(conversationTurnKey("c-other"))).toBeNull();

    await stream.push(DONE_FRAME);
    await act(async () => {
      await submission.settled;
    });
    expect(result.current.provisionalKeys).toEqual([]);
  });

  it("releases one provisional key without reading or discarding state held under any other (R3.7)", async () => {
    const first = scriptedStream();
    const second = scriptedStream();
    const existing = scriptedStream();
    let creates = 0;
    fetchSpy.mockImplementation((input) => {
      if (String(input).includes("/conversations/c1/prompt")) {
        return Promise.resolve(existing.response);
      }
      creates += 1;
      return Promise.resolve(creates === 1 ? first.response : second.response);
    });

    const { result } = renderSender();
    const existingTurn = startTurn(() => result.current, {
      target: conversationTurnKey("c1"),
      text: "existing",
    });
    const one = startTurn(() => result.current, {
      target: CREATE,
      text: "prompt one",
    });
    const two = startTurn(() => result.current, {
      target: CREATE,
      text: "prompt two",
    });
    const keyTwo = provisionalKeyOf(two);
    await second.push(textFrame("answer two"));
    await waitFor(() =>
      expect(assistantTextFor(keyTwo.provisionalId)).toEqual(["answer two"]),
    );

    await first.push(conversationFrame("c-one"));
    await waitFor(() =>
      expect(result.current.provisionalKeys).toEqual([keyTwo]),
    );

    // The surviving provisional turn and the unrelated conversation turn are
    // exactly as they were.
    expect(result.current.isSending(keyTwo)).toBe(true);
    expect(userTextFor(keyTwo.provisionalId)).toEqual(["prompt two"]);
    expect(assistantTextFor(keyTwo.provisionalId)).toEqual(["answer two"]);
    expect(result.current.isSending(conversationTurnKey("c1"))).toBe(true);
    expect(userTextFor("c1")).toEqual(["existing"]);

    await first.push(DONE_FRAME);
    await second.push(DONE_FRAME);
    await existing.push(DONE_FRAME);
    await act(async () => {
      await Promise.all([one.settled, two.settled, existingTurn.settled]);
    });
  });

  // -- R3.8: the failure path leaks nothing ---------------------------------

  it("surfaces a failure that arrived before any conversation id under its own provisional key (R3.8)", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "Project is busy" }, 409));
    const { result } = renderSender();

    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const key = provisionalKeyOf(submission);
    await act(async () => {
      await submission.settled;
    });

    expect(result.current.errorFor(key)?.message).toBe("Project is busy");
    expect(result.current.isSending(key)).toBe(false);
    expect(result.current.provisionalKeys).toEqual([key]);
  });

  it("releases the failed provisional key when the user dismisses the error (R3.8)", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "Project is busy" }, 409));
    const { result } = renderSender();

    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const key = provisionalKeyOf(submission);
    await act(async () => {
      await submission.settled;
    });

    await act(async () => {
      result.current.clearError(key);
    });

    expect(result.current.provisionalKeys).toEqual([]);
    expect(result.current.errorFor(key)).toBeNull();
    expect(result.current.isSending(key)).toBe(false);
    expect(inFlightKeys()).toEqual([]);
  });

  it("releases the failed provisional key when the user retries, and allocates a new one (R3.8)", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    const { result } = renderSender();

    const failed = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const failedKey = provisionalKeyOf(failed);
    await act(async () => {
      await failed.settled;
    });
    expect(result.current.errorFor(failedKey)?.message).toBe(
      "Failed to send prompt",
    );

    const retry = startTurn(() => result.current, {
      target: CREATE,
      text: "hello again",
    });
    const retryKey = provisionalKeyOf(retry);
    await act(async () => {
      await retry.settled;
    });

    expect(retryKey.provisionalId).not.toBe(failedKey.provisionalId);
    expect(result.current.provisionalKeys).toEqual([retryKey]);
    expect(result.current.provisionalKeys).not.toContainEqual(failedKey);
    expect(inFlightKeys()).toEqual([retryKey.provisionalId]);
  });

  it("releases the provisional key of a turn the user dismissed before it settled unnamed (R3.8)", async () => {
    const stream = scriptedStream();
    serveStreams(stream);
    const { result } = renderSender();

    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const key = provisionalKeyOf(submission);

    await stream.push(errorFrame("mid-turn failure"));
    await waitFor(() =>
      expect(result.current.errorFor(key)?.message).toBe("mid-turn failure"),
    );

    // Dismissed while the turn is still running: the key keeps holding the
    // running turn, so it is not released yet.
    await act(async () => {
      result.current.clearError(key);
    });
    expect(result.current.errorFor(key)).toBeNull();
    expect(result.current.provisionalKeys).toEqual([key]);

    // The turn then ends without ever being named. The dismissal was the last
    // word on its failure, so the key holds nothing and is released rather than
    // left behind holding an idle turn no surface can reach or dismiss again.
    await stream.push(DONE_FRAME);
    await act(async () => {
      await submission.settled;
    });

    expect(result.current.provisionalKeys).toEqual([]);
    expect(result.current.isSending(key)).toBe(false);
    expect(result.current.errorFor(key)).toBeNull();
    expect(inFlightKeys()).toEqual([]);
  });

  it("leaves no provisional key and no busy state when a create-and-send aborts before any conversation id (R3.8)", async () => {
    const stream = scriptedStream();
    serveStreams(stream);
    const { result } = renderSender();

    const submission = startTurn(() => result.current, {
      target: CREATE,
      text: "hello",
    });
    const key = provisionalKeyOf(submission);
    await waitFor(() => expect(result.current.isSending(key)).toBe(true));

    await stream.push(ABORTED_FRAME);
    await act(async () => {
      await submission.settled;
    });

    expect(result.current.provisionalKeys).toEqual([]);
    expect(result.current.isSending(key)).toBe(false);
    expect(result.current.errorFor(key)).toBeNull();
    expect(inFlightKeys()).toEqual([]);
  });
});
