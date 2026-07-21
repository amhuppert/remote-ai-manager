// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  useRenameConversationMutation,
  useArchiveConversationMutation,
  useAnswerQuestionMutation,
  useMarkConversationReadMutation,
  useGenericRenameConversationMutation,
  useGenericArchiveConversationMutation,
} from "@/lib/conversations/mutations";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import type {
  AskQuestionItem,
  ConversationState,
} from "@/lib/conversations/schemas";
import type {
  ActiveConversation,
  ProjectActiveConversation,
  SessionActiveConversation,
  ActiveConversationsResponse,
} from "@/lib/active-conversations/schemas";

function activeConvo(
  overrides: Partial<SessionActiveConversation> & { id: string },
): SessionActiveConversation {
  return {
    id: overrides.id,
    scope: "session",
    name: overrides.name ?? null,
    status: overrides.status ?? "new",
    lastActivityAt: overrides.lastActivityAt ?? "2025-01-01T00:00:00.000Z",
    projectName: overrides.projectName ?? "p",
    projectPath: overrides.projectPath ?? "/p",
    sessionName: overrides.sessionName ?? "s",
    agentBackend: overrides.agentBackend ?? "claude",
    summary: overrides.summary ?? null,
    pendingQuestion: overrides.pendingQuestion ?? null,
    pendingQuestionId: overrides.pendingQuestionId ?? null,
    pendingQuestions: overrides.pendingQuestions ?? null,
    forkedFrom: overrides.forkedFrom ?? null,
    debugActive: overrides.debugActive ?? false,
    role: overrides.role ?? null,
    branchName: overrides.branchName ?? null,
    worktreePath: overrides.worktreePath ?? "/w",
    lastActivitySummary: overrides.lastActivitySummary ?? null,
    unread: overrides.unread ?? false,
    pendingApproval: overrides.pendingApproval ?? null,
  };
}

function activeProjectConvo(
  overrides: Partial<ProjectActiveConversation> & { id: string },
): ProjectActiveConversation {
  return {
    id: overrides.id,
    scope: "project",
    name: overrides.name ?? null,
    status: overrides.status ?? "new",
    lastActivityAt: overrides.lastActivityAt ?? "2025-01-01T00:00:00.000Z",
    projectName: overrides.projectName ?? "p",
    projectPath: overrides.projectPath ?? "/p",
    agentBackend: overrides.agentBackend ?? "claude",
    summary: overrides.summary ?? null,
    pendingQuestion: overrides.pendingQuestion ?? null,
    pendingQuestionId: overrides.pendingQuestionId ?? null,
    pendingQuestions: overrides.pendingQuestions ?? null,
    forkedFrom: overrides.forkedFrom ?? null,
    debugActive: overrides.debugActive ?? false,
    role: overrides.role ?? null,
    worktreePath: overrides.worktreePath ?? "/p",
    lastActivitySummary: overrides.lastActivitySummary ?? null,
    unread: overrides.unread ?? false,
    pendingApproval: overrides.pendingApproval ?? null,
    open: overrides.open ?? true,
  };
}

function activeResponse(
  conversations: ActiveConversation[],
): ActiveConversationsResponse {
  return {
    conversations,
    graphWorkflowExecutions: [],
    activeCollaborationExecutions: [],
    specExecutions: [],
  };
}
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
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

function conversation(
  overrides: Partial<ConversationState> & { id: string },
): ConversationState {
  return {
    id: overrides.id,
    scope: overrides.scope ?? "session",
    name: overrides.name ?? null,
    transcriptPath: overrides.transcriptPath ?? null,
    status: overrides.status ?? "new",
    promptCount: overrides.promptCount ?? 0,
    createdAt: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
    lastActivityAt: overrides.lastActivityAt ?? "2025-01-01T00:00:00.000Z",
    source: overrides.source ?? "cc",
    summary: overrides.summary ?? null,
    archived: overrides.archived ?? false,
    totalCostUsd: overrides.totalCostUsd ?? null,
    totalDurationMs: overrides.totalDurationMs ?? null,
    totalTurns: overrides.totalTurns ?? null,
    pendingQuestionId: overrides.pendingQuestionId ?? null,
    pendingQuestions: overrides.pendingQuestions ?? null,
    pendingPromptText: overrides.pendingPromptText ?? null,
    forkedFrom: overrides.forkedFrom ?? null,
    role: overrides.role ?? null,
    activeTurnSource: overrides.activeTurnSource ?? null,
    contextTokens: overrides.contextTokens ?? null,
    contextWindowMax: overrides.contextWindowMax ?? null,
    debugMode: overrides.debugMode ?? null,
    agentBackend: overrides.agentBackend ?? "claude",
    backendRef: overrides.backendRef ?? null,
    unread: overrides.unread ?? false,
    pendingQueue: overrides.pendingQueue ?? [],
    lastSeenAlignmentVersion: overrides.lastSeenAlignmentVersion ?? null,
    pendingAgentNotices: [],
    mcpOverrides: overrides.mcpOverrides,
    mcpRuntime: overrides.mcpRuntime,
  };
}

describe("useRenameConversationMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically renames the conversation in the cached list before the server resolves", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("p", "s");
    client.setQueryData<ConversationState[]>(listKey, [
      conversation({ id: "c1", name: "old" }),
    ]);

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useRenameConversationMutation("p", "s"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ conversationId: "c1", name: "new" });

    await waitFor(() => {
      const data = client.getQueryData<ConversationState[]>(listKey);
      expect(data?.[0]?.name).toBe("new");
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the cache when the server rejects", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("p", "s");
    client.setQueryData<ConversationState[]>(listKey, [
      conversation({ id: "c1", name: "old" }),
    ]);

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useRenameConversationMutation("p", "s"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ conversationId: "c1", name: "new" });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const data = client.getQueryData<ConversationState[]>(listKey);
    expect(data?.[0]?.name).toBe("old");
  });

  it("invalidates the conversation list on settle even when the server rejects", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("p", "s");
    client.setQueryData<ConversationState[]>(listKey, [
      conversation({ id: "c1", name: "old" }),
    ]);

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useRenameConversationMutation("p", "s"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ conversationId: "c1", name: "new" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await waitFor(() => {
      expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    });
  });

  it("optimistically renames the conversation in the active conversations cache", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1", name: "old" })]),
    );

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useRenameConversationMutation("p", "s"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ conversationId: "c1", name: "new" });

    await waitFor(() => {
      const data = client.getQueryData<ActiveConversationsResponse>(activeKey);
      expect(data?.conversations[0]?.name).toBe("new");
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the active conversations cache when the server rejects", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1", name: "old" })]),
    );

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useRenameConversationMutation("p", "s"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ conversationId: "c1", name: "new" });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const data = client.getQueryData<ActiveConversationsResponse>(activeKey);
    expect(data?.conversations[0]?.name).toBe("old");
  });
});

describe("useArchiveConversationMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically flips archived in the cached list before the server resolves", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("p", "s");
    client.setQueryData<ConversationState[]>(listKey, [
      conversation({ id: "c1", archived: false }),
    ]);

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useArchiveConversationMutation("p", "s"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ conversationId: "c1", archived: true });

    await waitFor(() => {
      const data = client.getQueryData<ConversationState[]>(listKey);
      expect(data?.[0]?.archived).toBe(true);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back archived when the server rejects", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("p", "s");
    client.setQueryData<ConversationState[]>(listKey, [
      conversation({ id: "c1", archived: false }),
    ]);

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useArchiveConversationMutation("p", "s"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ conversationId: "c1", archived: true });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const data = client.getQueryData<ConversationState[]>(listKey);
    expect(data?.[0]?.archived).toBe(false);
  });

  it("optimistically removes the conversation from the active conversations cache when archiving", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1" }), activeConvo({ id: "c2" })]),
    );

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useArchiveConversationMutation("p", "s"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ conversationId: "c1", archived: true });

    await waitFor(() => {
      const data = client.getQueryData<ActiveConversationsResponse>(activeKey);
      expect(data?.conversations.map((c) => c.id)).toEqual(["c2"]);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("restores the conversation to the active conversations cache when the server rejects archive", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1" }), activeConvo({ id: "c2" })]),
    );

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useArchiveConversationMutation("p", "s"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ conversationId: "c1", archived: true });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const data = client.getQueryData<ActiveConversationsResponse>(activeKey);
    expect(data?.conversations.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("useGenericRenameConversationMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically renames in both the per-session list and the active conversations cache", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("p", "s");
    const activeKey = conversationKeys.active();
    client.setQueryData<ConversationState[]>(listKey, [
      conversation({ id: "c1", name: "old" }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1", name: "old" })]),
    );

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useGenericRenameConversationMutation(),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
      name: "new",
    });

    await waitFor(() => {
      const listData = client.getQueryData<ConversationState[]>(listKey);
      const activeData =
        client.getQueryData<ActiveConversationsResponse>(activeKey);
      expect(listData?.[0]?.name).toBe("new");
      expect(activeData?.conversations[0]?.name).toBe("new");
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back both caches when the server rejects", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("p", "s");
    const activeKey = conversationKeys.active();
    client.setQueryData<ConversationState[]>(listKey, [
      conversation({ id: "c1", name: "old" }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1", name: "old" })]),
    );

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useGenericRenameConversationMutation(),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
      name: "new",
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const listData = client.getQueryData<ConversationState[]>(listKey);
    const activeData =
      client.getQueryData<ActiveConversationsResponse>(activeKey);
    expect(listData?.[0]?.name).toBe("old");
    expect(activeData?.conversations[0]?.name).toBe("old");
  });

  it("routes project row rename to the project conversation endpoint without a session name", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeProjectConvo({ id: "pc1", name: "old" })]),
    );
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(
      () => useGenericRenameConversationMutation(),
      { wrapper: wrapperFor(client) },
    );

    await result.current.mutateAsync({
      scope: "project",
      projectName: "p",
      conversationId: "pc1",
      name: "new",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/conversations/pc1/rename",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "new" }),
      }),
    );
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain("/sessions/");
  });

  it("invalidates active and project conversation queries after project row rename", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    const projectListKey = projectConversationKeys.list("p");
    const sessionListKey = conversationKeys.list("p", "s");
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeProjectConvo({ id: "pc1", name: "old" })]),
    );
    client.setQueryData(projectListKey, []);
    client.setQueryData(sessionListKey, []);
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(
      () => useGenericRenameConversationMutation(),
      { wrapper: wrapperFor(client) },
    );

    await result.current.mutateAsync({
      scope: "project",
      projectName: "p",
      conversationId: "pc1",
      name: "new",
    });

    await waitFor(() => {
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(projectListKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionListKey)?.isInvalidated).toBe(false);
    });
  });

  it("keeps session row rename on session invalidation", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    const sessionListKey = conversationKeys.list("p", "s");
    const projectListKey = projectConversationKeys.list("p");
    client.setQueryData<ConversationState[]>(sessionListKey, [
      conversation({ id: "c1", name: "old" }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1", name: "old" })]),
    );
    client.setQueryData(projectListKey, []);
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(
      () => useGenericRenameConversationMutation(),
      { wrapper: wrapperFor(client) },
    );

    await result.current.mutateAsync({
      scope: "session",
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
      name: "new",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/conversations/c1/rename",
      expect.objectContaining({ method: "PATCH" }),
    );
    await waitFor(() => {
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionListKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(projectListKey)?.isInvalidated).toBe(false);
    });
  });
});

describe("useGenericArchiveConversationMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically flips archived in per-session list and removes from active cache when archiving", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("p", "s");
    const activeKey = conversationKeys.active();
    client.setQueryData<ConversationState[]>(listKey, [
      conversation({ id: "c1", archived: false }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1" }), activeConvo({ id: "c2" })]),
    );

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useGenericArchiveConversationMutation(),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
      archived: true,
    });

    await waitFor(() => {
      const listData = client.getQueryData<ConversationState[]>(listKey);
      const activeData =
        client.getQueryData<ActiveConversationsResponse>(activeKey);
      expect(listData?.[0]?.archived).toBe(true);
      expect(activeData?.conversations.map((c) => c.id)).toEqual(["c2"]);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back both caches when the server rejects archive", async () => {
    const client = makeClient();
    const listKey = conversationKeys.list("p", "s");
    const activeKey = conversationKeys.active();
    client.setQueryData<ConversationState[]>(listKey, [
      conversation({ id: "c1", archived: false }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1" }), activeConvo({ id: "c2" })]),
    );

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useGenericArchiveConversationMutation(),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
      archived: true,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const listData = client.getQueryData<ConversationState[]>(listKey);
    const activeData =
      client.getQueryData<ActiveConversationsResponse>(activeKey);
    expect(listData?.[0]?.archived).toBe(false);
    expect(activeData?.conversations.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("routes project row archive to the project conversation endpoint without a session name", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeProjectConvo({ id: "pc1" }),
        activeProjectConvo({ id: "pc2" }),
      ]),
    );
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(
      () => useGenericArchiveConversationMutation(),
      { wrapper: wrapperFor(client) },
    );

    await result.current.mutateAsync({
      scope: "project",
      projectName: "p",
      conversationId: "pc1",
      archived: true,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/conversations/pc1/archive",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      }),
    );
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain("/sessions/");
  });

  it("removes project rows from active cache and invalidates active plus project queries after archive", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    const projectListKey = projectConversationKeys.list("p");
    const sessionListKey = conversationKeys.list("p", "s");
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeProjectConvo({ id: "pc1" }),
        activeProjectConvo({ id: "pc2" }),
      ]),
    );
    client.setQueryData(projectListKey, []);
    client.setQueryData(sessionListKey, []);

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useGenericArchiveConversationMutation(),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({
      scope: "project",
      projectName: "p",
      conversationId: "pc1",
      archived: true,
    });

    await waitFor(() => {
      const activeData =
        client.getQueryData<ActiveConversationsResponse>(activeKey);
      expect(activeData?.conversations.map((c) => c.id)).toEqual(["pc2"]);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => {
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(projectListKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionListKey)?.isInvalidated).toBe(false);
    });
  });

  it("keeps session row archive on session invalidation", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    const sessionListKey = conversationKeys.list("p", "s");
    const projectListKey = projectConversationKeys.list("p");
    client.setQueryData<ConversationState[]>(sessionListKey, [
      conversation({ id: "c1", archived: false }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1" })]),
    );
    client.setQueryData(projectListKey, []);
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(
      () => useGenericArchiveConversationMutation(),
      { wrapper: wrapperFor(client) },
    );

    await result.current.mutateAsync({
      scope: "session",
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
      archived: true,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/conversations/c1/archive",
      expect.objectContaining({ method: "PATCH" }),
    );
    await waitFor(() => {
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionListKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(projectListKey)?.isInvalidated).toBe(false);
    });
  });

  it("restores a project row to the active cache when project archive fails", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeProjectConvo({ id: "pc1" }),
        activeProjectConvo({ id: "pc2" }),
      ]),
    );
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useGenericArchiveConversationMutation(),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({
      scope: "project",
      projectName: "p",
      conversationId: "pc1",
      archived: true,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const activeData =
      client.getQueryData<ActiveConversationsResponse>(activeKey);
    expect(activeData?.conversations.map((c) => c.id)).toEqual(["pc1", "pc2"]);
  });
});

function askQuestionItem(
  overrides: Partial<AskQuestionItem> = {},
): AskQuestionItem {
  return {
    id: "q1",
    question: "Which store?",
    options: [
      { label: "SQLite", recommended: true },
      { label: "Redis", recommended: false },
    ],
    multiSelect: false,
    required: true,
    allowNote: true,
    ...overrides,
  };
}

describe("useAnswerQuestionMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically clears the pending question and marks the conversation running in the active cache", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeConvo({
          id: "c1",
          status: "waiting_for_input",
          pendingQuestion: "Which store?",
          pendingQuestionId: "q1",
          pendingQuestions: [askQuestionItem()],
        }),
      ]),
    );

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useAnswerQuestionMutation("p", "s", "c1"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({
      questionId: "q1",
      answers: { q1: { selected: ["SQLite"], note: null, skipped: false } },
    });

    await waitFor(() => {
      const convo =
        client.getQueryData<ActiveConversationsResponse>(activeKey)
          ?.conversations[0];
      expect(convo?.pendingQuestion).toBeNull();
      expect(convo?.pendingQuestionId).toBeNull();
      expect(convo?.pendingQuestions).toBeNull();
      expect(convo?.status).toBe("running");
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("optimistically clears the pending question in the session detail cache", async () => {
    const client = makeClient();
    const sessionKey = sessionKeys.detail("p", "s");
    client.setQueryData(sessionKey, {
      sessionName: "s",
      conversations: [
        conversation({
          id: "c1",
          status: "waiting_for_input",
          pendingQuestionId: "q1",
          pendingQuestions: [askQuestionItem()],
        }),
      ],
    });

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useAnswerQuestionMutation("p", "s", "c1"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({
      questionId: "q1",
      answers: { q1: { selected: ["SQLite"], note: null, skipped: false } },
    });

    await waitFor(() => {
      const session = client.getQueryData<{
        conversations: ConversationState[];
      }>(sessionKey);
      expect(session?.conversations[0]?.pendingQuestionId).toBeNull();
      expect(session?.conversations[0]?.pendingQuestions).toBeNull();
      expect(session?.conversations[0]?.status).toBe("running");
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the pending question in both caches when the server rejects", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    const sessionKey = sessionKeys.detail("p", "s");
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeConvo({
          id: "c1",
          status: "waiting_for_input",
          pendingQuestion: "Which store?",
          pendingQuestionId: "q1",
          pendingQuestions: [askQuestionItem()],
        }),
      ]),
    );
    client.setQueryData(sessionKey, {
      sessionName: "s",
      conversations: [
        conversation({
          id: "c1",
          status: "waiting_for_input",
          pendingQuestionId: "q1",
          pendingQuestions: [askQuestionItem()],
        }),
      ],
    });

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useAnswerQuestionMutation("p", "s", "c1"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({
      questionId: "q1",
      answers: { q1: { selected: ["SQLite"], note: null, skipped: false } },
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const convo =
      client.getQueryData<ActiveConversationsResponse>(activeKey)
        ?.conversations[0];
    expect(convo?.pendingQuestionId).toBe("q1");
    expect(convo?.status).toBe("waiting_for_input");
    const session = client.getQueryData<{
      conversations: ConversationState[];
    }>(sessionKey);
    expect(session?.conversations[0]?.pendingQuestionId).toBe("q1");
    expect(session?.conversations[0]?.status).toBe("waiting_for_input");
  });

  it("submits answers and invalidates messages, session detail, and active conversations", async () => {
    const client = makeClient();
    const messagesKey = conversationKeys.messages("p", "s", "c1");
    const sessionKey = sessionKeys.detail("p", "s");
    const activeKey = conversationKeys.active();
    client.setQueryData(messagesKey, []);
    client.setQueryData(sessionKey, { sessionName: "s", conversations: [] });
    client.setQueryData(activeKey, { conversations: [] });
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(
      () => useAnswerQuestionMutation("p", "s", "c1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({
        questionId: "q1",
        answers: { choice: { selected: ["yes"], note: null, skipped: false } },
      }),
    ).resolves.toEqual({ status: "ok" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/conversations/c1/answer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          questionId: "q1",
          answers: {
            choice: { selected: ["yes"], note: null, skipped: false },
          },
        }),
      }),
    );
    await waitFor(() => {
      expect(client.getQueryState(messagesKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
    });
  });

  it("returns gone status for stale questions", async () => {
    const client = makeClient();
    const messagesKey = conversationKeys.messages("p", "s", "c1");
    const sessionKey = sessionKeys.detail("p", "s");
    const activeKey = conversationKeys.active();
    client.setQueryData(messagesKey, []);
    client.setQueryData(sessionKey, { sessionName: "s", conversations: [] });
    client.setQueryData(activeKey, { conversations: [] });
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: "Question expired" }, 410),
    );

    const { result } = renderHook(
      () => useAnswerQuestionMutation("p", "s", "c1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({
        questionId: "q1",
        answers: { choice: { selected: ["yes"], note: null, skipped: false } },
      }),
    ).resolves.toEqual({ status: "gone", error: "Question expired" });

    await waitFor(() => {
      expect(client.getQueryState(messagesKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
    });
  });

  it("invalidates messages, session detail, and active conversations on settle even when the server rejects", async () => {
    const client = makeClient();
    const messagesKey = conversationKeys.messages("p", "s", "c1");
    const sessionKey = sessionKeys.detail("p", "s");
    const activeKey = conversationKeys.active();
    client.setQueryData(messagesKey, []);
    client.setQueryData(sessionKey, { sessionName: "s", conversations: [] });
    client.setQueryData(activeKey, { conversations: [] });
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useAnswerQuestionMutation("p", "s", "c1"),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({
      questionId: "q1",
      answers: { choice: { selected: ["yes"], note: null, skipped: false } },
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await waitFor(() => {
      expect(client.getQueryState(messagesKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
    });
  });
});

describe("useMarkConversationReadMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically clears unread in the active conversations cache before the server resolves", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeConvo({ id: "c1", unread: true }),
        activeConvo({ id: "c2", unread: true }),
      ]),
    );

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useMarkConversationReadMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
    });

    await waitFor(() => {
      const data = client.getQueryData<ActiveConversationsResponse>(activeKey);
      expect(data?.conversations[0]?.unread).toBe(false);
      expect(data?.conversations[1]?.unread).toBe(true);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back unread when the server rejects", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1", unread: true })]),
    );

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useMarkConversationReadMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const data = client.getQueryData<ActiveConversationsResponse>(activeKey);
    expect(data?.conversations[0]?.unread).toBe(true);
  });

  it("invalidates the active conversations cache on settle even when the server rejects", async () => {
    const client = makeClient();
    const activeKey = conversationKeys.active();
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1", unread: true })]),
    );

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useMarkConversationReadMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({
      projectName: "p",
      sessionName: "s",
      conversationId: "c1",
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await waitFor(() => {
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
    });
  });
});
