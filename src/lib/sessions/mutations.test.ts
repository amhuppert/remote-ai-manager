// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  useGenericArchiveSessionMutation,
  useArchiveSessionMutation,
  useBulkSessionsMutation,
  useCreateSessionMutation,
  useDeleteSessionMutation,
  useTddToggleMutation,
} from "@/lib/sessions/mutations";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { conversationKeys } from "@/lib/conversations/query-keys";
import type {
  SessionActiveConversation,
  ActiveConversationsResponse,
} from "@/lib/active-conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import { normalizeTicketListFilters } from "@/lib/tickets/list-filters";
import { ticketKeys } from "@/lib/tickets/query-keys";

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

function activeResponse(
  conversations: SessionActiveConversation[],
): ActiveConversationsResponse {
  return {
    conversations,
    graphWorkflowExecutions: [],
    activeCollaborationExecutions: [],
    specExecutions: [],
  };
}

function sessionListItem(
  overrides: Partial<SessionListItem> & { sessionName: string },
): SessionListItem {
  return {
    sessionName: overrides.sessionName,
    worktreePath: overrides.worktreePath ?? "/w",
    branchName: overrides.branchName ?? "main",
    targetBranch: overrides.targetBranch ?? "main",
    parentSessionName: overrides.parentSessionName ?? null,
    createdAt: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
    lastActivityAt: overrides.lastActivityAt ?? "2025-01-01T00:00:00.000Z",
    archived: overrides.archived ?? false,
    finished: overrides.finished ?? false,
    source: overrides.source ?? "cc",
    creationMode: overrides.creationMode ?? "normal",
    tddEnabled: overrides.tddEnabled ?? true,
    derivedStatus: overrides.derivedStatus ?? "idle",
    promptCount: overrides.promptCount ?? 0,
    derivedLastActivityAt:
      overrides.derivedLastActivityAt ?? "2025-01-01T00:00:00.000Z",
    collabContribution: overrides.collabContribution ?? null,
    hasActiveGraphWorkflow: overrides.hasActiveGraphWorkflow ?? false,
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

describe("useGenericArchiveSessionMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes the session archive endpoint with the archived flag and invalidates the session list on success", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    client.setQueryData(listKey, []);
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(() => useGenericArchiveSessionMutation(), {
      wrapper: wrapperFor(client),
    });

    await result.current.mutateAsync({
      projectName: "p",
      sessionName: "s",
      archived: true,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/archive",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      }),
    );
    await waitFor(() => {
      expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    });
  });

  it("optimistically marks the session archived in the sessions list and removes its conversations from the active cache", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    const activeKey = conversationKeys.active();
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "s", archived: false }),
      sessionListItem({ sessionName: "other", archived: false }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeConvo({ id: "c1", sessionName: "s" }),
        activeConvo({ id: "c2", sessionName: "s" }),
        activeConvo({ id: "c3", sessionName: "other" }),
      ]),
    );

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useGenericArchiveSessionMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({
      projectName: "p",
      sessionName: "s",
      archived: true,
    });

    await waitFor(() => {
      const sessions = client.getQueryData<SessionListItem[]>(listKey);
      const active =
        client.getQueryData<ActiveConversationsResponse>(activeKey);
      expect(sessions?.find((s) => s.sessionName === "s")?.archived).toBe(true);
      expect(active?.conversations.map((c) => c.id)).toEqual(["c3"]);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back both caches when the server rejects", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    const activeKey = conversationKeys.active();
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "s", archived: false }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeConvo({ id: "c1", sessionName: "s" }),
        activeConvo({ id: "c3", sessionName: "other" }),
      ]),
    );

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useGenericArchiveSessionMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({
      projectName: "p",
      sessionName: "s",
      archived: true,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const sessions = client.getQueryData<SessionListItem[]>(listKey);
    const active = client.getQueryData<ActiveConversationsResponse>(activeKey);
    expect(sessions?.find((s) => s.sessionName === "s")?.archived).toBe(false);
    expect(active?.conversations.map((c) => c.id)).toEqual(["c1", "c3"]);
  });
});

describe("useCreateSessionMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const minimalSession = {
    sessionName: "new-session",
    worktreePath: "/w",
    branchName: "csm/new-session",
    createdAt: "2025-01-01T00:00:00.000Z",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
  };

  it("invalidates the active conversations feed on success so a new session's initial conversation appears in tabs/panes", async () => {
    const client = makeClient();
    const sessionListKey = sessionKeys.list("p");
    const activeKey = conversationKeys.active();
    client.setQueryData(sessionListKey, []);
    client.setQueryData(activeKey, activeResponse([]));
    fetchSpy.mockResolvedValue(jsonResponse(minimalSession));

    const { result } = renderHook(() => useCreateSessionMutation("p"), {
      wrapper: wrapperFor(client),
    });

    await result.current.mutateAsync({
      mode: "normal",
      sessionName: "new-session",
    });

    await waitFor(() => {
      expect(client.getQueryState(sessionListKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
    });
  });
});

describe("useArchiveSessionMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically marks the session archived and removes its conversations from the active cache", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    const activeKey = conversationKeys.active();
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "s", archived: false }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeConvo({ id: "c1", sessionName: "s" }),
        activeConvo({ id: "c2", sessionName: "other" }),
      ]),
    );

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useArchiveSessionMutation("p", "s"), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate(true);

    await waitFor(() => {
      const sessions = client.getQueryData<SessionListItem[]>(listKey);
      const active =
        client.getQueryData<ActiveConversationsResponse>(activeKey);
      expect(sessions?.find((s) => s.sessionName === "s")?.archived).toBe(true);
      expect(active?.conversations.map((c) => c.id)).toEqual(["c2"]);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back both caches when the server rejects", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    const activeKey = conversationKeys.active();
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "s", archived: false }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c1", sessionName: "s" })]),
    );

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useArchiveSessionMutation("p", "s"), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate(true);

    await waitFor(() => expect(result.current.isError).toBe(true));

    const sessions = client.getQueryData<SessionListItem[]>(listKey);
    const active = client.getQueryData<ActiveConversationsResponse>(activeKey);
    expect(sessions?.find((s) => s.sessionName === "s")?.archived).toBe(false);
    expect(active?.conversations.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("useDeleteSessionMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically removes the session from the list and its conversations from the active cache, then invalidates both on settle", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    const activeKey = conversationKeys.active();
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "s" }),
      sessionListItem({ sessionName: "other" }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeConvo({ id: "c1", sessionName: "s" }),
        activeConvo({ id: "c2", sessionName: "s" }),
        activeConvo({ id: "c3", sessionName: "other" }),
      ]),
    );
    const ticketListKey = ticketKeys.list(normalizeTicketListFilters({}));
    const ticketDetailKey = ticketKeys.detail("p", 7);
    const ticketLinksKey = ticketKeys.sessionLinks("p");
    client.setQueryData(ticketListKey, []);
    client.setQueryData(ticketDetailKey, { id: "ticket-7" });
    client.setQueryData(ticketLinksKey, {
      s: {
        ticketId: "ticket-7",
        projectName: "p",
        number: 7,
        title: "Linked ticket",
        active: true,
        linkedAt: "2026-07-01T00:00:00.000Z",
        endedAt: null,
      },
    });

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useDeleteSessionMutation("p"), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate("s");

    await waitFor(() => {
      const sessions = client.getQueryData<SessionListItem[]>(listKey);
      const active =
        client.getQueryData<ActiveConversationsResponse>(activeKey);
      expect(sessions?.map((s) => s.sessionName)).toEqual(["other"]);
      expect(active?.conversations.map((c) => c.id)).toEqual(["c3"]);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => {
      expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(ticketListKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(ticketDetailKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(ticketLinksKey)?.isInvalidated).toBe(true);
    });
  });

  it("rolls back both caches when the server rejects", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    const activeKey = conversationKeys.active();
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "s" }),
      sessionListItem({ sessionName: "other" }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeConvo({ id: "c1", sessionName: "s" }),
        activeConvo({ id: "c3", sessionName: "other" }),
      ]),
    );

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useDeleteSessionMutation("p"), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate("s");

    await waitFor(() => expect(result.current.isError).toBe(true));

    const sessions = client.getQueryData<SessionListItem[]>(listKey);
    const active = client.getQueryData<ActiveConversationsResponse>(activeKey);
    expect(sessions?.map((s) => s.sessionName)).toEqual(["s", "other"]);
    expect(active?.conversations.map((c) => c.id)).toEqual(["c1", "c3"]);
  });
});

describe("useTddToggleMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically patches tddEnabled on the matching session, then invalidates the list on settle", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "s", tddEnabled: true }),
      sessionListItem({ sessionName: "other", tddEnabled: true }),
    ]);

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useTddToggleMutation("p", "s"), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate(false);

    await waitFor(() => {
      const sessions = client.getQueryData<SessionListItem[]>(listKey);
      expect(sessions?.find((s) => s.sessionName === "s")?.tddEnabled).toBe(
        false,
      );
      expect(sessions?.find((s) => s.sessionName === "other")?.tddEnabled).toBe(
        true,
      );
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => {
      expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    });
  });

  it("rolls back the session list when the server rejects", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "s", tddEnabled: true }),
    ]);

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useTddToggleMutation("p", "s"), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate(false);

    await waitFor(() => expect(result.current.isError).toBe(true));

    const sessions = client.getQueryData<SessionListItem[]>(listKey);
    expect(sessions?.find((s) => s.sessionName === "s")?.tddEnabled).toBe(true);
  });
});

describe("useBulkSessionsMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs op + sessionNames to the bulk endpoint and returns parsed results", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("my-proj");
    client.setQueryData(listKey, []);
    fetchSpy.mockResolvedValue(
      jsonResponse({
        results: [
          { sessionName: "a", success: true },
          { sessionName: "b", success: false, error: "boom" },
        ],
      }),
    );

    const { result } = renderHook(() => useBulkSessionsMutation("my-proj"), {
      wrapper: wrapperFor(client),
    });

    const response = await result.current.mutateAsync({
      op: "archive",
      sessionNames: ["a", "b"],
    });

    expect(response).toEqual({
      results: [
        { sessionName: "a", success: true },
        { sessionName: "b", success: false, error: "boom" },
      ],
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/my-proj/sessions/bulk",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ op: "archive", sessionNames: ["a", "b"] }),
      }),
    );
    await waitFor(() => {
      expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    });
  });

  it("encodes project name segments and forwards delete op", async () => {
    const client = makeClient();
    client.setQueryData(sessionKeys.list("name with space"), []);
    fetchSpy.mockResolvedValue(jsonResponse({ results: [] }));

    const { result } = renderHook(
      () => useBulkSessionsMutation("name with space"),
      { wrapper: wrapperFor(client) },
    );

    await result.current.mutateAsync({ op: "delete", sessionNames: ["x"] });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/name%20with%20space/sessions/bulk",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ op: "delete", sessionNames: ["x"] }),
      }),
    );
  });

  it("surfaces server errors as a rejected mutation and still invalidates on settle", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    client.setQueryData(listKey, []);
    fetchSpy.mockResolvedValue(jsonResponse({ error: "nope" }, 500));

    const { result } = renderHook(() => useBulkSessionsMutation("p"), {
      wrapper: wrapperFor(client),
    });

    await expect(
      result.current.mutateAsync({ op: "unarchive", sessionNames: ["a"] }),
    ).rejects.toThrow("nope");

    await waitFor(() => {
      expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    });
  });

  it("optimistically archives matching sessions and removes their conversations from the active cache, then invalidates both on settle", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    const activeKey = conversationKeys.active();
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "a", archived: false }),
      sessionListItem({ sessionName: "b", archived: false }),
      sessionListItem({ sessionName: "keep", archived: false }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeConvo({ id: "c1", sessionName: "a" }),
        activeConvo({ id: "c2", sessionName: "b" }),
        activeConvo({ id: "c3", sessionName: "keep" }),
      ]),
    );

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useBulkSessionsMutation("p"), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ op: "archive", sessionNames: ["a", "b"] });

    await waitFor(() => {
      const sessions = client.getQueryData<SessionListItem[]>(listKey);
      const active =
        client.getQueryData<ActiveConversationsResponse>(activeKey);
      expect(sessions?.map((s) => s.archived)).toEqual([true, true, false]);
      expect(active?.conversations.map((c) => c.id)).toEqual(["c3"]);
    });

    resolveFetch(
      jsonResponse({
        results: [
          { sessionName: "a", success: true },
          { sessionName: "b", success: true },
        ],
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => {
      expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
    });
  });

  it("optimistically unarchives matching sessions without touching the active cache", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    const activeKey = conversationKeys.active();
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "a", archived: true }),
      sessionListItem({ sessionName: "keep", archived: true }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([activeConvo({ id: "c3", sessionName: "other" })]),
    );

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useBulkSessionsMutation("p"), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ op: "unarchive", sessionNames: ["a"] });

    await waitFor(() => {
      const sessions = client.getQueryData<SessionListItem[]>(listKey);
      expect(sessions?.map((s) => s.archived)).toEqual([false, true]);
    });
    const active = client.getQueryData<ActiveConversationsResponse>(activeKey);
    expect(active?.conversations.map((c) => c.id)).toEqual(["c3"]);

    resolveFetch(
      jsonResponse({ results: [{ sessionName: "a", success: true }] }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("optimistically removes matching sessions and their conversations for the delete op", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    const activeKey = conversationKeys.active();
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "a" }),
      sessionListItem({ sessionName: "b" }),
      sessionListItem({ sessionName: "keep" }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeConvo({ id: "c1", sessionName: "a" }),
        activeConvo({ id: "c2", sessionName: "b" }),
        activeConvo({ id: "c3", sessionName: "keep" }),
      ]),
    );

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useBulkSessionsMutation("p"), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ op: "delete", sessionNames: ["a", "b"] });

    await waitFor(() => {
      const sessions = client.getQueryData<SessionListItem[]>(listKey);
      const active =
        client.getQueryData<ActiveConversationsResponse>(activeKey);
      expect(sessions?.map((s) => s.sessionName)).toEqual(["keep"]);
      expect(active?.conversations.map((c) => c.id)).toEqual(["c3"]);
    });

    resolveFetch(
      jsonResponse({
        results: [
          { sessionName: "a", success: true },
          { sessionName: "b", success: true },
        ],
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back both caches when the server rejects", async () => {
    const client = makeClient();
    const listKey = sessionKeys.list("p");
    const activeKey = conversationKeys.active();
    client.setQueryData<SessionListItem[]>(listKey, [
      sessionListItem({ sessionName: "a", archived: false }),
      sessionListItem({ sessionName: "keep", archived: false }),
    ]);
    client.setQueryData<ActiveConversationsResponse>(
      activeKey,
      activeResponse([
        activeConvo({ id: "c1", sessionName: "a" }),
        activeConvo({ id: "c3", sessionName: "keep" }),
      ]),
    );

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useBulkSessionsMutation("p"), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ op: "archive", sessionNames: ["a"] });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const sessions = client.getQueryData<SessionListItem[]>(listKey);
    const active = client.getQueryData<ActiveConversationsResponse>(activeKey);
    expect(sessions?.map((s) => s.archived)).toEqual([false, false]);
    expect(active?.conversations.map((c) => c.id)).toEqual(["c1", "c3"]);
  });
});
