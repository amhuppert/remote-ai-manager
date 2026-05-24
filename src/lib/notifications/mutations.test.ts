// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useMarkNotificationAsReadMutation } from "./mutations";
import { notificationKeys } from "./query-keys";
import type { Notification } from "@/lib/notifications/schemas";
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
