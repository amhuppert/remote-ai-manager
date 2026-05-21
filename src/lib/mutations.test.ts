// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  useRenameConversationMutation,
  useArchiveConversationMutation,
  useAnswerQuestionMutation,
  useMarkNotificationAsReadMutation,
} from "@/lib/mutations";
import {
  conversationKeys,
  notificationKeys,
  sessionKeys,
} from "@/lib/query-keys";
import type { ConversationState, Notification } from "@/types";

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
    contextTokens: overrides.contextTokens ?? null,
    contextWindowMax: overrides.contextWindowMax ?? null,
    debugMode: overrides.debugMode ?? null,
    machineSnapshot: overrides.machineSnapshot ?? null,
    agentBackend: overrides.agentBackend ?? "claude",
    backendRef: overrides.backendRef ?? null,
    mcpOverrides: overrides.mcpOverrides,
    mcpRuntime: overrides.mcpRuntime,
  };
}

function notification(
  overrides: Partial<Notification> & { id: string },
): Notification {
  return {
    id: overrides.id,
    type: overrides.type ?? "merge-completed",
    title: overrides.title ?? "Title",
    message: overrides.message ?? "Message",
    read: overrides.read ?? false,
    projectName: overrides.projectName ?? "p",
    sessionName: overrides.sessionName ?? "s",
    branchName: overrides.branchName ?? "csm/s",
    jobId: overrides.jobId ?? "job-1",
    jobType: overrides.jobType ?? "merge",
    mergeHash: overrides.mergeHash,
    commitHash: overrides.commitHash,
    conflictCount: overrides.conflictCount,
    conflictFiles: overrides.conflictFiles,
    targetBranch: overrides.targetBranch,
    errorMessage: overrides.errorMessage,
    createdAt: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
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
});

describe("useAnswerQuestionMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits answers and invalidates messages and session detail", async () => {
    const client = makeClient();
    const messagesKey = conversationKeys.messages("p", "s", "c1");
    const sessionKey = sessionKeys.detail("p", "s");
    client.setQueryData(messagesKey, []);
    client.setQueryData(sessionKey, { sessionName: "s" });
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(
      () => useAnswerQuestionMutation("p", "s", "c1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({
        questionId: "q1",
        answers: { choice: "yes" },
      }),
    ).resolves.toEqual({ status: "ok" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/conversations/c1/answer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          questionId: "q1",
          answers: { choice: "yes" },
        }),
      }),
    );
    await waitFor(() => {
      expect(client.getQueryState(messagesKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionKey)?.isInvalidated).toBe(true);
    });
  });

  it("returns gone status for stale questions", async () => {
    const client = makeClient();
    const messagesKey = conversationKeys.messages("p", "s", "c1");
    const sessionKey = sessionKeys.detail("p", "s");
    client.setQueryData(messagesKey, []);
    client.setQueryData(sessionKey, { sessionName: "s" });
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
        answers: { choice: "yes" },
      }),
    ).resolves.toEqual({ status: "gone", error: "Question expired" });

    await waitFor(() => {
      expect(client.getQueryState(messagesKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionKey)?.isInvalidated).toBe(true);
    });
  });
});

describe("useMarkNotificationAsReadMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically marks the notification as read in the cached list before the server resolves", async () => {
    const client = makeClient();
    const listKey = notificationKeys.list();
    client.setQueryData(listKey, {
      notifications: [notification({ id: "n1", read: false })],
      total: 1,
      unreadCount: 1,
    });

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useMarkNotificationAsReadMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate("n1");

    await waitFor(() => {
      const data = client.getQueryData<{
        notifications: Notification[];
        total: number;
        unreadCount: number;
      }>(listKey);
      expect(data?.notifications[0]?.read).toBe(true);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the cache when the server rejects", async () => {
    const client = makeClient();
    const listKey = notificationKeys.list();
    const before = {
      notifications: [notification({ id: "n1", read: false })],
      total: 1,
      unreadCount: 1,
    };
    client.setQueryData(listKey, before);

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useMarkNotificationAsReadMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate("n1");

    await waitFor(() => expect(result.current.isError).toBe(true));

    const data = client.getQueryData<{
      notifications: Notification[];
      total: number;
      unreadCount: number;
    }>(listKey);
    expect(data?.notifications[0]?.read).toBe(false);
  });
});
