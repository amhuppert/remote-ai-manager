// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type QueryKey,
} from "@tanstack/react-query";

import type {
  TicketAttachment,
  TicketChangedEvent,
  TicketDetail,
  TicketListItem,
} from "./schemas";
import {
  normalizeTicketListFilters,
  ticketListItemFromDetail,
} from "./list-filters";
import { ticketKeys } from "./query-keys";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { applyTicketChangedEvent } from "./sse-reducer";
import {
  useAddTicketAttachmentMutation,
  useCreateTicketMutation,
  useDeleteTicketMutation,
  useEditTicketAttachmentMutation,
  useRefreshConversationSnapshotMutation,
  useRemoveTicketAttachmentMutation,
  useStartTicketMutation,
  useUpdateTicketMutation,
} from "./mutations";

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

function item(
  overrides: Partial<TicketListItem> & { id: string },
): TicketListItem {
  return {
    id: overrides.id,
    projectPath: overrides.projectPath ?? "/projects/alpha",
    projectName: overrides.projectName ?? "alpha",
    number: overrides.number ?? 1,
    title: overrides.title ?? "A ticket",
    workType: overrides.workType ?? "feature",
    status: overrides.status ?? "not_started",
    attachmentCount: overrides.attachmentCount ?? 0,
    activeSessionName: overrides.activeSessionName ?? null,
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

function attachment(
  overrides: Partial<TicketAttachment> & { id: string },
): TicketAttachment {
  return {
    id: overrides.id,
    ticketId: overrides.ticketId ?? "t1",
    description: overrides.description ?? "context",
    payload: overrides.payload ?? { kind: "note", markdown: "hi" },
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

function detail(
  overrides: Partial<TicketDetail> & { id: string },
): TicketDetail {
  return {
    id: overrides.id,
    projectPath: overrides.projectPath ?? "/projects/alpha",
    projectName: overrides.projectName ?? "alpha",
    number: overrides.number ?? 1,
    title: overrides.title ?? "A ticket",
    description: overrides.description ?? "",
    workType: overrides.workType ?? "feature",
    status: overrides.status ?? "not_started",
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
    attachments: overrides.attachments ?? [],
    sessions: overrides.sessions ?? [],
  };
}

const allKey = ticketKeys.list(normalizeTicketListFilters({}));
const notStartedKey = ticketKeys.list(
  normalizeTicketListFilters({ status: "not_started" }),
);

const fetchSpy = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function deferredFetch(): (res: Response) => void {
  let resolveFetch: (res: Response) => void = () => {};
  fetchSpy.mockImplementation(
    () => new Promise<Response>((r) => (resolveFetch = r)),
  );
  return (res) => resolveFetch(res);
}

interface ControlledRequest {
  input: RequestInfo | URL;
  init?: RequestInit;
  resolve(response: Response): void;
}

function controlledFetches(): ControlledRequest[] {
  const requests: ControlledRequest[] = [];
  fetchSpy.mockImplementation(
    (input, init) =>
      new Promise<Response>((resolve) => {
        requests.push({ input, init, resolve });
      }),
  );
  return requests;
}

function observeFailingRefetch(
  client: QueryClient,
  queryKey: QueryKey,
): { refetch: ReturnType<typeof vi.fn>; unsubscribe(): void } {
  const refetch = vi.fn(async () => {
    throw new Error("refetch failed");
  });
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: refetch,
    retry: false,
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { refetch, unsubscribe };
}

describe("useUpdateTicketMutation", () => {
  it("optimistically patches the detail and re-sorts every cached list before the server resolves", async () => {
    const client = makeClient();
    const t1 = item({
      id: "t1",
      number: 1,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const t2 = item({
      id: "t2",
      number: 2,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    client.setQueryData(allKey, [t2, t1]);
    client.setQueryData(notStartedKey, [t2, t1]);
    client.setQueryData(ticketKeys.detail("alpha", 1), detail({ id: "t1" }));

    deferredFetch();

    const { result } = renderHook(() => useUpdateTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      fields: { status: "in_progress", title: "Renamed" },
    });

    await waitFor(() => {
      const cachedDetail = client.getQueryData<TicketDetail>(
        ticketKeys.detail("alpha", 1),
      );
      expect(cachedDetail?.status).toBe("in_progress");
      expect(cachedDetail?.title).toBe("Renamed");
    });

    // Shared-module ordering: the touched ticket's bumped updatedAt moves it
    // to the head of the updated-sorted list.
    const all = client.getQueryData<TicketListItem[]>(allKey);
    expect(all?.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(all?.[0]?.status).toBe("in_progress");

    // The status-filtered cache no longer matches — identity removed.
    const notStarted = client.getQueryData<TicketListItem[]>(notStartedKey);
    expect(notStarted?.map((t) => t.id)).toEqual(["t2"]);
  });

  it("preserves the authoritative lean session liveness during a field update", async () => {
    const client = makeClient();
    const staleDetail = detail({
      id: "t1",
      sessions: [
        {
          id: "link-1",
          ticketId: "t1",
          projectPath: "/projects/alpha",
          sessionName: "deleted-session",
          sessionCreatedAt: "2026-07-01T00:00:00.000Z",
          startMode: "agent",
          linkedAt: "2026-07-01T00:00:01.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    });
    const authoritativeListItem = item({
      id: "t1",
      activeSessionName: null,
    });
    client.setQueryData(ticketKeys.detail("alpha", 1), staleDetail);
    client.setQueryData(allKey, [authoritativeListItem]);
    const resolveFetch = deferredFetch();
    const { result } = renderHook(() => useUpdateTicketMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({
      projectName: "alpha",
      number: 1,
      fields: { title: "Renamed" },
    });
    await waitFor(() =>
      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.title).toBe(
        "Renamed",
      ),
    );
    expect(
      client.getQueryData<TicketListItem[]>(allKey)?.[0]?.activeSessionName,
    ).toBeNull();

    resolveFetch(
      jsonResponse({
        ...staleDetail,
        title: "Renamed",
        updatedAt: "2026-07-01T00:00:02.000Z",
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      client.getQueryData<TicketListItem[]>(allKey)?.[0]?.activeSessionName,
    ).toBeNull();
  });

  it("rolls back every touched cache when the server rejects", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    const seededDetail = detail({ id: "t1" });
    client.setQueryData(allKey, [t1]);
    client.setQueryData(notStartedKey, [t1]);
    client.setQueryData(ticketKeys.detail("alpha", 1), seededDetail);

    fetchSpy.mockResolvedValue(
      jsonResponse({ error: "boom", code: "validation_failed" }, 400),
    );

    const { result } = renderHook(() => useUpdateTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      fields: { status: "done" },
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(client.getQueryData(allKey)).toEqual([t1]);
    expect(client.getQueryData(notStartedKey)).toEqual([t1]);
    expect(client.getQueryData(ticketKeys.detail("alpha", 1))).toEqual(
      seededDetail,
    );
  });

  it("treats a ticket-endpoint 404 as an authoritative deletion", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t1]);
    client.setQueryData(notStartedKey, [t1]);
    client.setQueryData(detailKey, detail({ id: "t1" }));
    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useUpdateTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      fields: { title: "Local rename" },
    });

    await waitFor(() => {
      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.title).toBe(
        "Local rename",
      );
    });
    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: {
        ...t1,
        title: "Concurrent rename",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
      attachmentIndexChanged: false,
    });
    resolveFetch(jsonResponse({ error: "missing" }, 404));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(allKey)).toEqual([]);
    expect(client.getQueryData(notStartedKey)).toEqual([]);
    expect(client.getQueryData(detailKey)).toBeUndefined();

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: t1,
      attachmentIndexChanged: false,
    });
    expect(client.getQueryData(allKey)).toEqual([]);
  });

  it("keeps onSettled hygiene invalidation after success", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    client.setQueryData(allKey, [t1]);

    const updated = detail({ id: "t1", title: "Server title" });
    fetchSpy.mockResolvedValue(jsonResponse(updated));

    const { result } = renderHook(() => useUpdateTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      fields: { title: "Server title" },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryState(allKey)?.isInvalidated).toBe(true);
    expect(
      client.getQueryState(ticketKeys.detail("alpha", 1))?.isInvalidated,
    ).toBe(true);
  });

  it("serializes same-ticket updates and preserves an earlier success when the queued update fails", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1, title: "Original" });
    client.setQueryData(allKey, [t1]);
    client.setQueryData(
      ticketKeys.detail("alpha", 1),
      detail({ id: "t1", title: "Original" }),
    );
    const requests = controlledFetches();

    const { result } = renderHook(() => useUpdateTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    const first = result.current
      .mutateAsync({
        projectName: "alpha",
        number: 1,
        fields: { title: "Server A" },
      })
      .catch(() => undefined);
    const second = result.current
      .mutateAsync({
        projectName: "alpha",
        number: 1,
        fields: { status: "done" },
      })
      .catch(() => undefined);

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(
      client.getQueryData<TicketDetail>(ticketKeys.detail("alpha", 1))?.title,
    ).toBe("Server A");
    expect(
      client.getQueryData<TicketDetail>(ticketKeys.detail("alpha", 1))?.status,
    ).toBe("not_started");

    const serverA = detail({
      id: "t1",
      title: "Server A",
      status: "not_started",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    requests[0]!.resolve(jsonResponse(serverA));
    await first;

    await waitFor(() => expect(requests).toHaveLength(2));
    await waitFor(() => {
      const cached = client.getQueryData<TicketDetail>(
        ticketKeys.detail("alpha", 1),
      );
      expect(cached?.title).toBe("Server A");
      expect(cached?.status).toBe("done");
    });

    requests[1]!.resolve(jsonResponse({ error: "conflict" }, 409));
    await second;

    await waitFor(() => {
      expect(client.getQueryData(ticketKeys.detail("alpha", 1))).toEqual(
        serverA,
      );
      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.title).toBe(
        "Server A",
      );
      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.status).toBe(
        "not_started",
      );
    });
  });

  it("flushes queued invalidations when the next gate holder cannot cancel cache work", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    client.setQueryData(allKey, [t1]);
    client.setQueryData(ticketKeys.detail("alpha", 1), detail({ id: "t1" }));
    const observedList = observeFailingRefetch(client, allKey);
    let cancelCalls = 0;
    const cancelSpy = vi
      .spyOn(client, "cancelQueries")
      .mockImplementation(async () => {
        cancelCalls += 1;
        if (cancelCalls > 2) throw new Error("cancel failed");
      });
    const requests = controlledFetches();

    try {
      const { result } = renderHook(() => useUpdateTicketMutation(), {
        wrapper: wrapperFor(client),
      });
      const first = result.current
        .mutateAsync({
          projectName: "alpha",
          number: 1,
          fields: { status: "done" },
        })
        .catch(() => undefined);
      const queued = result.current
        .mutateAsync({
          projectName: "alpha",
          number: 1,
          fields: { title: "Queued" },
        })
        .catch(() => undefined);

      await waitFor(() => expect(requests).toHaveLength(1));
      requests[0]!.resolve(jsonResponse({ error: "update failed" }, 409));
      await first;
      await queued;

      await waitFor(() => expect(observedList.refetch).toHaveBeenCalled());
      expect(requests).toHaveLength(1);
      expect(client.getQueryData(allKey)).toEqual([t1]);
    } finally {
      cancelSpy.mockRestore();
      observedList.unsubscribe();
    }
  });
});

describe("useDeleteTicketMutation", () => {
  it("optimistically removes the ticket from every cached list and restores on failure", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    const t2 = item({ id: "t2", number: 2 });
    const seededDetail = detail({ id: "t1" });
    client.setQueryData(allKey, [t1, t2]);
    client.setQueryData(notStartedKey, [t1, t2]);
    client.setQueryData(ticketKeys.detail("alpha", 1), seededDetail);

    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useDeleteTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ projectName: "alpha", number: 1 });

    await waitFor(() => {
      expect(
        client.getQueryData<TicketListItem[]>(allKey)?.map((t) => t.id),
      ).toEqual(["t2"]);
    });
    expect(
      client.getQueryData<TicketListItem[]>(notStartedKey)?.map((t) => t.id),
    ).toEqual(["t2"]);
    expect(client.getQueryData(ticketKeys.detail("alpha", 1))).toBeUndefined();

    resolveFetch(jsonResponse({ error: "nope" }, 409));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(allKey)).toEqual([t1, t2]);
    expect(client.getQueryData(notStartedKey)).toEqual([t1, t2]);
    expect(client.getQueryData(ticketKeys.detail("alpha", 1))).toEqual(
      seededDetail,
    );
  });

  it("does not revive a stale raw session link when delete rolls back", async () => {
    const client = makeClient();
    const staleDetail = detail({
      id: "t1",
      sessions: [
        {
          id: "link-1",
          ticketId: "t1",
          projectPath: "/projects/alpha",
          sessionName: "deleted-session",
          sessionCreatedAt: "2026-07-01T00:00:00.000Z",
          startMode: "agent",
          linkedAt: "2026-07-01T00:00:01.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    });
    const authoritativeListItem = item({
      id: "t1",
      activeSessionName: null,
    });
    client.setQueryData(ticketKeys.detail("alpha", 1), staleDetail);
    client.setQueryData(allKey, [authoritativeListItem]);
    fetchSpy.mockResolvedValue(jsonResponse({ error: "conflict" }, 409));
    const { result } = renderHook(() => useDeleteTicketMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ projectName: "alpha", number: 1 });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(
      client.getQueryData<TicketListItem[]>(allKey)?.[0]?.activeSessionName,
    ).toBeNull();
  });

  it("clears the detail and invalidates session links after a successful deletion", async () => {
    const client = makeClient();
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(detailKey, detail({ id: "t1" }));
    client.setQueryData(ticketKeys.sessionLinks("alpha"), {
      "ticket-session": {
        ticketId: "t1",
        projectName: "alpha",
        number: 1,
        title: "A ticket",
        active: true,
        linkedAt: "2026-07-01T00:00:00.000Z",
        endedAt: null,
      },
    });
    fetchSpy.mockResolvedValue(
      jsonResponse({
        id: "t1",
        projectPath: "/projects/alpha",
        projectName: "alpha",
        number: 1,
      }),
    );

    const { result } = renderHook(() => useDeleteTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    await result.current.mutateAsync({ projectName: "alpha", number: 1 });

    await waitFor(() => {
      expect(client.getQueryData(detailKey)).toBeUndefined();
      expect(
        client.getQueryData(ticketKeys.sessionLinks("alpha")),
      ).toBeUndefined();
    });
  });

  it("keeps a ticket absent when delete reports it was already missing", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t1]);
    client.setQueryData(notStartedKey, [t1]);
    client.setQueryData(detailKey, detail({ id: "t1" }));
    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useDeleteTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ projectName: "alpha", number: 1 });

    await waitFor(() => {
      expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([]);
    });
    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: {
        ...t1,
        title: "Concurrent rename",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
      attachmentIndexChanged: false,
    });
    resolveFetch(jsonResponse({ error: "missing" }, 404));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(allKey)).toEqual([]);
    expect(client.getQueryData(notStartedKey)).toEqual([]);
    expect(client.getQueryData(detailKey)).toBeUndefined();
  });
});

describe("overlapping ticket mutations", () => {
  it("rolls back only the failed identity while a sibling is pending and survives a failed final refetch", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    const t2 = item({ id: "t2", number: 2 });
    client.setQueryData(allKey, [t1, t2]);
    client.setQueryData(notStartedKey, [t1, t2]);
    client.setQueryData(ticketKeys.detail("alpha", 1), detail({ id: "t1" }));
    client.setQueryData(
      ticketKeys.detail("alpha", 2),
      detail({ id: "t2", number: 2 }),
    );
    const observedList = observeFailingRefetch(client, allKey);
    const requests = controlledFetches();

    try {
      const { result } = renderHook(
        () => ({
          update: useUpdateTicketMutation(),
          remove: useDeleteTicketMutation(),
        }),
        { wrapper: wrapperFor(client) },
      );
      const update = result.current.update
        .mutateAsync({
          projectName: "alpha",
          number: 1,
          fields: { status: "done" },
        })
        .catch(() => undefined);
      const remove = result.current.remove
        .mutateAsync({ projectName: "alpha", number: 2 })
        .catch(() => undefined);

      await waitFor(() => expect(requests).toHaveLength(2));
      await waitFor(() => {
        expect(
          client
            .getQueryData<TicketListItem[]>(allKey)
            ?.map((row) => [row.id, row.status]),
        ).toEqual([["t1", "done"]]);
        expect(client.getQueryData<TicketListItem[]>(notStartedKey)).toEqual(
          [],
        );
      });

      requests[0]!.resolve(jsonResponse({ error: "update failed" }, 409));
      await update;

      await waitFor(() => {
        expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([t1]);
        expect(client.getQueryData<TicketListItem[]>(notStartedKey)).toEqual([
          t1,
        ]);
      });
      expect(observedList.refetch).not.toHaveBeenCalled();

      requests[1]!.resolve(jsonResponse({ error: "delete failed" }, 409));
      await remove;

      await waitFor(() => {
        expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([t1, t2]);
        expect(client.getQueryData<TicketListItem[]>(notStartedKey)).toEqual([
          t1,
          t2,
        ]);
        expect(observedList.refetch).toHaveBeenCalledTimes(1);
      });
    } finally {
      observedList.unsubscribe();
    }
  });
});

describe("useCreateTicketMutation", () => {
  it("shows visible pending (no optimistic row) and inserts the created ticket in shared-module order on success", async () => {
    const client = makeClient();
    const existing = item({
      id: "t1",
      number: 1,
      updatedAt: "2026-07-05T00:00:00.000Z",
    });
    client.setQueryData(allKey, [existing]);

    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useCreateTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      input: { title: "New ticket", workType: "bug" },
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(client.getQueryData<TicketListItem[]>(allKey)).toHaveLength(1);

    const created = detail({
      id: "t2",
      number: 2,
      title: "New ticket",
      workType: "bug",
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });
    resolveFetch(jsonResponse({ ticket: created, warnings: [] }, 201));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      client.getQueryData<TicketListItem[]>(allKey)?.map((t) => t.id),
    ).toEqual(["t2", "t1"]);
    expect(client.getQueryData(ticketKeys.detail("alpha", 2))).toEqual(created);
  });

  it("does not resurrect a created identity deleted by SSE before the response arrives", async () => {
    const client = makeClient();
    const existing = item({ id: "t1", number: 1 });
    client.setQueryData(allKey, [existing]);
    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useCreateTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      input: { title: "New ticket", workType: "bug" },
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));
    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "deleted",
      projectName: "alpha",
      ticketNumber: 2,
      listItem: null,
      attachmentIndexChanged: false,
    });
    resolveFetch(
      jsonResponse(
        {
          ticket: detail({
            id: "t2",
            number: 2,
            title: "New ticket",
            workType: "bug",
            updatedAt: "2026-07-02T00:00:00.000Z",
          }),
          warnings: [],
        },
        201,
      ),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([existing]);
    expect(client.getQueryData(ticketKeys.detail("alpha", 2))).toBeUndefined();
  });

  it("keeps a later optimistic update intact while the delayed create response settles", async () => {
    const client = makeClient();
    client.setQueryData(allKey, []);
    const requests = controlledFetches();
    const { result } = renderHook(
      () => ({
        create: useCreateTicketMutation(),
        update: useUpdateTicketMutation(),
      }),
      { wrapper: wrapperFor(client) },
    );

    const create = result.current.create.mutateAsync({
      projectName: "alpha",
      input: { title: "Created title", workType: "feature" },
    });
    await waitFor(() => expect(requests).toHaveLength(1));

    const created = detail({
      id: "t2",
      number: 2,
      title: "Created title",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "created",
      projectName: "alpha",
      ticketNumber: 2,
      listItem: ticketListItemFromDetail(created),
      attachmentIndexChanged: false,
    });

    const update = result.current.update.mutateAsync({
      projectName: "alpha",
      number: 2,
      fields: { title: "Later optimistic title" },
    });
    await waitFor(() => expect(requests).toHaveLength(2));
    const observedTitles: Array<string | undefined> = [];
    const unsubscribe = client.getQueryCache().subscribe(() => {
      observedTitles.push(
        client.getQueryData<TicketListItem[]>(allKey)?.[0]?.title,
      );
    });
    requests[0]!.resolve(jsonResponse({ ticket: created, warnings: [] }, 201));

    const updated = detail({
      ...created,
      title: "Later optimistic title",
      updatedAt: "2026-07-02T00:00:00.001Z",
    });
    requests[1]!.resolve(jsonResponse(updated));
    await expect(update).resolves.toEqual(updated);
    await expect(create).resolves.toEqual({ ticket: created, warnings: [] });
    unsubscribe();

    expect(observedTitles).not.toContain("Created title");
    expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.title).toBe(
      "Later optimistic title",
    );
    expect(client.getQueryData(ticketKeys.detail("alpha", 2))).toEqual(updated);
  });

  it("does not reinsert an identity optimistically deleted after its create event", async () => {
    const client = makeClient();
    client.setQueryData(allKey, []);
    const requests = controlledFetches();
    const { result } = renderHook(
      () => ({
        create: useCreateTicketMutation(),
        remove: useDeleteTicketMutation(),
      }),
      { wrapper: wrapperFor(client) },
    );

    const create = result.current.create.mutateAsync({
      projectName: "alpha",
      input: { title: "Created title", workType: "feature" },
    });
    await waitFor(() => expect(requests).toHaveLength(1));

    const created = detail({
      id: "t2",
      number: 2,
      title: "Created title",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "created",
      projectName: "alpha",
      ticketNumber: 2,
      listItem: ticketListItemFromDetail(created),
      attachmentIndexChanged: false,
    });

    const remove = result.current.remove.mutateAsync({
      projectName: "alpha",
      number: 2,
    });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([]);
    let wasReinserted = false;
    const unsubscribe = client.getQueryCache().subscribe(() => {
      if ((client.getQueryData<TicketListItem[]>(allKey)?.length ?? 0) > 0) {
        wasReinserted = true;
      }
    });

    requests[0]!.resolve(jsonResponse({ ticket: created, warnings: [] }, 201));

    const deleted = {
      id: created.id,
      projectPath: created.projectPath,
      projectName: created.projectName,
      number: created.number,
    };
    requests[1]!.resolve(jsonResponse(deleted));
    await expect(remove).resolves.toEqual(deleted);
    await expect(create).resolves.toEqual({ ticket: created, warnings: [] });
    unsubscribe();

    expect(wasReinserted).toBe(false);
    expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([]);
    expect(client.getQueryData(ticketKeys.detail("alpha", 2))).toBeUndefined();
  });
});

describe("useAddTicketAttachmentMutation", () => {
  it("is pending until the server resolves, then patches the detail and list attachment counts", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1, attachmentCount: 0 });
    client.setQueryData(allKey, [t1]);
    client.setQueryData(ticketKeys.detail("alpha", 1), detail({ id: "t1" }));

    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useAddTicketAttachmentMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      description: "a note",
      payload: { kind: "note", markdown: "hello" },
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(
      client.getQueryData<TicketDetail>(ticketKeys.detail("alpha", 1))
        ?.attachments,
    ).toHaveLength(0);

    resolveFetch(jsonResponse(attachment({ id: "a1" }), 201));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const cachedDetail = client.getQueryData<TicketDetail>(
      ticketKeys.detail("alpha", 1),
    );
    expect(cachedDetail?.attachments.map((a) => a.id)).toEqual(["a1"]);
    expect(
      client.getQueryData<TicketListItem[]>(allKey)?.[0]?.attachmentCount,
    ).toBe(1);
  });

  it("does not revive a stale raw session link while adding an attachment", async () => {
    const client = makeClient();
    const staleDetail = detail({
      id: "t1",
      sessions: [
        {
          id: "link-1",
          ticketId: "t1",
          projectPath: "/projects/alpha",
          sessionName: "deleted-session",
          sessionCreatedAt: "2026-07-01T00:00:00.000Z",
          startMode: "agent",
          linkedAt: "2026-07-01T00:00:01.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    });
    client.setQueryData(ticketKeys.detail("alpha", 1), staleDetail);
    client.setQueryData(allKey, [item({ id: "t1", activeSessionName: null })]);
    fetchSpy.mockResolvedValue(
      jsonResponse(
        attachment({
          id: "a1",
          updatedAt: "2026-07-01T00:00:02.000Z",
        }),
        201,
      ),
    );
    const { result } = renderHook(() => useAddTicketAttachmentMutation(), {
      wrapper: wrapperFor(client),
    });

    await result.current.mutateAsync({
      projectName: "alpha",
      number: 1,
      description: "new context",
      payload: { kind: "note", markdown: "context" },
    });

    expect(
      client.getQueryData<TicketListItem[]>(allKey)?.[0]?.activeSessionName,
    ).toBeNull();
  });

  it("uploads file attachments as multipart form data with a JSON metadata part", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValue(
      jsonResponse(
        attachment({
          id: "a1",
          payload: {
            kind: "file",
            fileName: "notes.txt",
            snapshotKey: "k",
            mediaType: "text/plain",
            sizeBytes: 5,
            sha256: "abc",
          },
        }),
        201,
      ),
    );

    const { result } = renderHook(() => useAddTicketAttachmentMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      description: "the file",
      file: new File(["hello"], "notes.txt", { type: "text/plain" }),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("file")).toBeInstanceOf(File);
    const metadata = JSON.parse(String(form.get("metadata"))) as {
      description: string;
    };
    expect(metadata.description).toBe("the file");
  });

  it("rebases ticket recency from the created attachment when reconciliation fails", async () => {
    const client = makeClient();
    const t1 = item({
      id: "t1",
      number: 1,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const t2 = item({
      id: "t2",
      number: 2,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t2, t1]);
    client.setQueryData(
      detailKey,
      detail({ id: "t1", updatedAt: t1.updatedAt }),
    );
    const observedDetail = observeFailingRefetch(client, detailKey);
    const created = attachment({
      id: "a1",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    fetchSpy.mockResolvedValue(jsonResponse(created, 201));

    try {
      const { result } = renderHook(() => useAddTicketAttachmentMutation(), {
        wrapper: wrapperFor(client),
      });
      await result.current.mutateAsync({
        projectName: "alpha",
        number: 1,
        description: "new context",
        payload: { kind: "note", markdown: "context" },
      });

      await waitFor(() => {
        expect(client.getQueryData<TicketDetail>(detailKey)?.updatedAt).toBe(
          created.updatedAt,
        );
        expect(
          client.getQueryData<TicketListItem[]>(allKey)?.map((row) => row.id),
        ).toEqual(["t1", "t2"]);
        expect(observedDetail.refetch).toHaveBeenCalled();
      });
    } finally {
      observedDetail.unsubscribe();
    }
  });

  it("keeps a successful attachment add when cache cancellation fails", async () => {
    const client = makeClient();
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [item({ id: "t1", number: 1 })]);
    client.setQueryData(detailKey, detail({ id: "t1" }));
    const created = attachment({
      id: "a1",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    fetchSpy.mockResolvedValue(jsonResponse(created, 201));
    const cancelSpy = vi
      .spyOn(client, "cancelQueries")
      .mockRejectedValue(new Error("cancel failed"));

    try {
      const { result } = renderHook(() => useAddTicketAttachmentMutation(), {
        wrapper: wrapperFor(client),
      });
      await expect(
        result.current.mutateAsync({
          projectName: "alpha",
          number: 1,
          description: "new context",
          payload: { kind: "note", markdown: "context" },
        }),
      ).resolves.toEqual(created);

      expect(client.getQueryData<TicketDetail>(detailKey)?.attachments).toEqual(
        [created],
      );
      expect(client.getQueryData<TicketDetail>(detailKey)?.updatedAt).toBe(
        created.updatedAt,
      );
    } finally {
      cancelSpy.mockRestore();
    }
  });

  it("does not let an older attachment response overwrite newer SSE lean state", async () => {
    const client = makeClient();
    const t1 = item({
      id: "t1",
      number: 1,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t1]);
    client.setQueryData(detailKey, detail({ id: "t1" }));
    const observedDetail = observeFailingRefetch(client, detailKey);
    const resolveFetch = deferredFetch();

    try {
      const { result } = renderHook(() => useAddTicketAttachmentMutation(), {
        wrapper: wrapperFor(client),
      });
      result.current.mutate({
        projectName: "alpha",
        number: 1,
        description: "context",
        payload: { kind: "note", markdown: "context" },
      });

      await waitFor(() => expect(result.current.isPending).toBe(true));
      const newer = {
        ...t1,
        title: "Newer SSE rename",
        status: "done" as const,
        updatedAt: "2026-07-03T00:00:00.000Z",
      };
      applyTicketChangedEvent(client, {
        type: "ticket-changed",
        change: "updated",
        projectName: "alpha",
        ticketNumber: 1,
        listItem: newer,
        attachmentIndexChanged: false,
      });
      resolveFetch(
        jsonResponse(
          attachment({ id: "a1", updatedAt: "2026-07-02T00:00:00.000Z" }),
          201,
        ),
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]).toEqual(newer);
      expect(client.getQueryData(detailKey)).toBeUndefined();
      expect(observedDetail.refetch).toHaveBeenCalled();
    } finally {
      observedDetail.unsubscribe();
    }
  });
});

describe("useEditTicketAttachmentMutation", () => {
  it("optimistically edits the attachment and rolls back on failure", async () => {
    const client = makeClient();
    const original = attachment({ id: "a1", description: "before" });
    const seededDetail = detail({ id: "t1", attachments: [original] });
    client.setQueryData(ticketKeys.detail("alpha", 1), seededDetail);

    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useEditTicketAttachmentMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      attachmentId: "a1",
      description: "after",
    });

    await waitFor(() => {
      expect(
        client.getQueryData<TicketDetail>(ticketKeys.detail("alpha", 1))
          ?.attachments[0]?.description,
      ).toBe("after");
    });

    resolveFetch(jsonResponse({ error: "conflict" }, 409));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(ticketKeys.detail("alpha", 1))).toEqual(
      seededDetail,
    );
  });

  it("rebases ticket recency from the updated attachment", async () => {
    const client = makeClient();
    const original = attachment({ id: "a1", description: "before" });
    const t1 = item({
      id: "t1",
      number: 1,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const t2 = item({
      id: "t2",
      number: 2,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t2, t1]);
    client.setQueryData(
      detailKey,
      detail({ id: "t1", updatedAt: t1.updatedAt, attachments: [original] }),
    );
    const updated = {
      ...original,
      description: "after",
      updatedAt: "2026-07-03T00:00:00.000Z",
    };
    fetchSpy.mockResolvedValue(jsonResponse(updated));

    const { result } = renderHook(() => useEditTicketAttachmentMutation(), {
      wrapper: wrapperFor(client),
    });
    await result.current.mutateAsync({
      projectName: "alpha",
      number: 1,
      attachmentId: "a1",
      description: "after",
    });

    expect(client.getQueryData<TicketDetail>(detailKey)?.updatedAt).toBe(
      updated.updatedAt,
    );
    expect(
      client.getQueryData<TicketListItem[]>(allKey)?.map((row) => row.id),
    ).toEqual(["t1", "t2"]);
  });

  it("replays newer SSE lean state after an older attachment edit response", async () => {
    const client = makeClient();
    const original = attachment({ id: "a1", description: "before" });
    const t1 = item({
      id: "t1",
      number: 1,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t1]);
    client.setQueryData(
      detailKey,
      detail({ id: "t1", attachments: [original] }),
    );
    const observedDetail = observeFailingRefetch(client, detailKey);
    const resolveFetch = deferredFetch();

    try {
      const { result } = renderHook(() => useEditTicketAttachmentMutation(), {
        wrapper: wrapperFor(client),
      });
      result.current.mutate({
        projectName: "alpha",
        number: 1,
        attachmentId: "a1",
        description: "after",
      });

      await waitFor(() => {
        expect(
          client.getQueryData<TicketDetail>(detailKey)?.attachments[0]
            ?.description,
        ).toBe("after");
      });
      const newer = {
        ...t1,
        title: "Newer SSE rename",
        status: "done" as const,
        updatedAt: "2026-07-03T00:00:00.000Z",
      };
      applyTicketChangedEvent(client, {
        type: "ticket-changed",
        change: "updated",
        projectName: "alpha",
        ticketNumber: 1,
        listItem: newer,
        attachmentIndexChanged: false,
      });
      resolveFetch(
        jsonResponse({
          ...original,
          description: "after",
          updatedAt: "2026-07-02T00:00:00.000Z",
        }),
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]).toEqual(newer);
      expect(client.getQueryData(detailKey)).toBeUndefined();
      expect(observedDetail.refetch).toHaveBeenCalled();
    } finally {
      observedDetail.unsubscribe();
    }
  });
});

describe("useRefreshConversationSnapshotMutation", () => {
  it("refetches ticket detail after a failed retry so pending snapshot state converges", async () => {
    const client = makeClient();
    const detailKey = ticketKeys.detail("alpha", 1);
    const pendingAttachment = attachment({
      id: "conversation-1",
      payload: {
        kind: "conversation",
        projectPath: "/projects/alpha",
        sessionName: "investigation",
        conversationId: "conversation-1",
        snapshotKey: null,
        snapshotCapturedAt: null,
        snapshotStatus: "pending",
      },
    });
    const failedAttachment = attachment({
      ...pendingAttachment,
      payload: {
        kind: "conversation",
        projectPath: "/projects/alpha",
        sessionName: "investigation",
        conversationId: "conversation-1",
        snapshotKey: null,
        snapshotCapturedAt: null,
        snapshotStatus: "failed",
        snapshotError: "Compaction timed out",
      },
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    client.setQueryData(
      detailKey,
      detail({ id: "t1", attachments: [pendingAttachment] }),
    );
    const refetchDetail = vi.fn(async () =>
      detail({ id: "t1", attachments: [failedAttachment] }),
    );
    const observer = new QueryObserver(client, {
      queryKey: detailKey,
      queryFn: refetchDetail,
      retry: false,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: "Compaction timed out" }, 500),
    );

    try {
      const { result } = renderHook(
        () => useRefreshConversationSnapshotMutation(),
        { wrapper: wrapperFor(client) },
      );

      await expect(
        result.current.mutateAsync({
          projectName: "alpha",
          number: 1,
          attachmentId: pendingAttachment.id,
        }),
      ).rejects.toThrow("Compaction timed out");

      await waitFor(() => {
        expect(refetchDetail).toHaveBeenCalledTimes(1);
        expect(
          client.getQueryData<TicketDetail>(detailKey)?.attachments[0]?.payload,
        ).toMatchObject({
          snapshotStatus: "failed",
          snapshotError: "Compaction timed out",
        });
      });
    } finally {
      unsubscribe();
    }
  });
});

describe("useRemoveTicketAttachmentMutation", () => {
  it("optimistically removes the attachment and decrements list counts, restoring on failure", async () => {
    const client = makeClient();
    const original = attachment({ id: "a1" });
    const seededDetail = detail({ id: "t1", attachments: [original] });
    const t1 = item({ id: "t1", number: 1, attachmentCount: 1 });
    const t2 = item({
      id: "t2",
      number: 2,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    client.setQueryData(ticketKeys.detail("alpha", 1), seededDetail);
    client.setQueryData(allKey, [t2, t1]);

    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useRemoveTicketAttachmentMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      attachmentId: "a1",
    });

    await waitFor(() => {
      expect(
        client.getQueryData<TicketDetail>(ticketKeys.detail("alpha", 1))
          ?.attachments,
      ).toHaveLength(0);
    });
    expect(
      client
        .getQueryData<TicketListItem[]>(allKey)
        ?.find((row) => row.id === "t1")?.attachmentCount,
    ).toBe(0);
    expect(
      client.getQueryData<TicketDetail>(ticketKeys.detail("alpha", 1))
        ?.updatedAt,
    ).not.toBe(seededDetail.updatedAt);
    expect(
      client.getQueryData<TicketListItem[]>(allKey)?.map((row) => row.id),
    ).toEqual(["t1", "t2"]);

    resolveFetch(jsonResponse({ error: "gone" }, 410));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(ticketKeys.detail("alpha", 1))).toEqual(
      seededDetail,
    );
    expect(client.getQueryData(allKey)).toEqual([t2, t1]);
  });

  it("does not let a fast client clock make later server events look stale", async () => {
    const client = makeClient();
    const original = attachment({ id: "a1" });
    const serverUpdatedAt = "2026-07-01T00:00:00.000Z";
    const seededDetail = detail({
      id: "t1",
      updatedAt: serverUpdatedAt,
      attachments: [original],
    });
    const t1 = item({
      id: "t1",
      number: 1,
      attachmentCount: 1,
      updatedAt: serverUpdatedAt,
    });
    client.setQueryData(ticketKeys.detail("alpha", 1), seededDetail);
    client.setQueryData(allKey, [t1]);
    const resolveFetch = deferredFetch();
    const RealDate = Date;
    class FastDate extends RealDate {
      constructor(value?: string | number) {
        super(value ?? "2099-01-01T00:00:00.000Z");
      }
    }
    vi.stubGlobal("Date", FastDate);

    const { result } = renderHook(() => useRemoveTicketAttachmentMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      attachmentId: "a1",
    });

    await waitFor(() =>
      expect(
        client.getQueryData<TicketDetail>(ticketKeys.detail("alpha", 1))
          ?.attachments,
      ).toHaveLength(0),
    );
    vi.stubGlobal("Date", RealDate);
    resolveFetch(
      jsonResponse({
        attachmentId: "a1",
        ticketId: "t1",
        kind: "note",
        ticketUpdatedAt: "2026-07-01T00:00:00.001Z",
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "attachments",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: {
        ...t1,
        title: "Authoritative server title",
        attachmentCount: 0,
        updatedAt: "2026-07-01T00:00:00.002Z",
      },
      attachmentIndexChanged: true,
    });

    expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.title).toBe(
      "Authoritative server title",
    );
  });
});

describe("overlapping attachment mutations", () => {
  it("serializes one ticket's attachment rows and composes both rollbacks when refetch fails", async () => {
    const client = makeClient();
    const a1 = attachment({ id: "a1", description: "first" });
    const a2 = attachment({ id: "a2", description: "second" });
    const seededDetail = detail({ id: "t1", attachments: [a1, a2] });
    const t1 = item({ id: "t1", number: 1, attachmentCount: 2 });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(detailKey, seededDetail);
    client.setQueryData(allKey, [t1]);
    const observedDetail = observeFailingRefetch(client, detailKey);
    const observedList = observeFailingRefetch(client, allKey);
    const requests = controlledFetches();

    try {
      const { result } = renderHook(
        () => ({
          edit: useEditTicketAttachmentMutation(),
          remove: useRemoveTicketAttachmentMutation(),
        }),
        { wrapper: wrapperFor(client) },
      );
      const edit = result.current.edit
        .mutateAsync({
          projectName: "alpha",
          number: 1,
          attachmentId: "a1",
          description: "edited",
        })
        .catch(() => undefined);
      const remove = result.current.remove
        .mutateAsync({
          projectName: "alpha",
          number: 1,
          attachmentId: "a2",
        })
        .catch(() => undefined);

      await waitFor(() => expect(requests).toHaveLength(1));
      expect(
        client
          .getQueryData<TicketDetail>(detailKey)
          ?.attachments.map((row) => [row.id, row.description]),
      ).toEqual([
        ["a1", "edited"],
        ["a2", "second"],
      ]);

      requests[0]!.resolve(jsonResponse({ error: "edit failed" }, 409));
      await edit;

      await waitFor(() => expect(requests).toHaveLength(2));
      await waitFor(() => {
        expect(
          client
            .getQueryData<TicketDetail>(detailKey)
            ?.attachments.map((row) => row.id),
        ).toEqual(["a1"]);
        expect(
          client.getQueryData<TicketDetail>(detailKey)?.attachments[0]
            ?.description,
        ).toBe("first");
        expect(
          client.getQueryData<TicketListItem[]>(allKey)?.[0]?.attachmentCount,
        ).toBe(1);
      });
      expect(observedDetail.refetch).not.toHaveBeenCalled();
      expect(observedList.refetch).not.toHaveBeenCalled();

      requests[1]!.resolve(jsonResponse({ error: "remove failed" }, 409));
      await remove;

      await waitFor(() => {
        expect(client.getQueryData(detailKey)).toEqual(seededDetail);
        expect(client.getQueryData(allKey)).toEqual([t1]);
        expect(observedDetail.refetch).toHaveBeenCalledTimes(1);
        expect(observedList.refetch).toHaveBeenCalledTimes(1);
      });
    } finally {
      observedDetail.unsubscribe();
      observedList.unsubscribe();
    }
  });
});

describe("useStartTicketMutation", () => {
  it("is pending during provisioning, then applies the returned ticket to detail and list caches", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    client.setQueryData(allKey, [t1]);
    client.setQueryData(ticketKeys.sessionLinks("alpha"), {});
    client.setQueryData(sessionKeys.list("alpha"), []);
    client.setQueryData(conversationKeys.active(), { conversations: [] });

    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useStartTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ projectName: "alpha", number: 1, mode: "agent" });

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.status).toBe(
      "not_started",
    );

    const started = detail({
      id: "t1",
      status: "in_progress",
      sessions: [
        {
          id: "l1",
          ticketId: "t1",
          projectPath: "/projects/alpha",
          sessionName: "ticket-session",
          sessionCreatedAt: "2026-07-05T23:59:59.000Z",
          startMode: "agent",
          linkedAt: "2026-07-06T00:00:00.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    });
    resolveFetch(
      jsonResponse({
        ticket: started,
        sessionName: "ticket-session",
        conversationId: "c1",
        initialPromptQueued: true,
      }),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(ticketKeys.detail("alpha", 1))).toEqual(started);
    const listRow = client.getQueryData<TicketListItem[]>(allKey)?.[0];
    expect(listRow?.status).toBe("in_progress");
    expect(listRow?.activeSessionName).toBe("ticket-session");
    expect(
      client.getQueryState(ticketKeys.sessionLinks("alpha"))?.isInvalidated,
    ).toBe(true);
    expect(client.getQueryState(sessionKeys.list("alpha"))?.isInvalidated).toBe(
      true,
    );
    expect(client.getQueryState(conversationKeys.active())?.isInvalidated).toBe(
      true,
    );
  });

  it("does not let an older start response overwrite newer SSE lean state", async () => {
    const client = makeClient();
    const t1 = item({
      id: "t1",
      number: 1,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t1]);
    client.setQueryData(detailKey, detail({ id: "t1" }));
    const observedDetail = observeFailingRefetch(client, detailKey);
    const resolveFetch = deferredFetch();

    try {
      const { result } = renderHook(() => useStartTicketMutation(), {
        wrapper: wrapperFor(client),
      });
      result.current.mutate({ projectName: "alpha", number: 1, mode: "agent" });

      await waitFor(() => expect(result.current.isPending).toBe(true));
      const newer = {
        ...t1,
        status: "done" as const,
        activeSessionName: "newer-session",
        updatedAt: "2026-07-03T00:00:00.000Z",
      };
      applyTicketChangedEvent(client, {
        type: "ticket-changed",
        change: "session",
        projectName: "alpha",
        ticketNumber: 1,
        listItem: newer,
        attachmentIndexChanged: false,
        linkedSessionName: "newer-session",
      });
      resolveFetch(
        jsonResponse({
          ticket: detail({
            id: "t1",
            status: "in_progress",
            updatedAt: "2026-07-02T00:00:00.000Z",
          }),
          sessionName: "older-session",
          conversationId: "c1",
          initialPromptQueued: true,
        }),
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]).toEqual(newer);
      expect(client.getQueryData(detailKey)).toBeUndefined();
      expect(observedDetail.refetch).toHaveBeenCalled();
    } finally {
      observedDetail.unsubscribe();
    }
  });
});

describe("SSE events interleaved with pending optimistic mutations", () => {
  const inProgressKey = ticketKeys.list(
    normalizeTicketListFilters({ status: "in_progress" }),
  );

  function staleUpdateEvent(listItem: TicketListItem): TicketChangedEvent {
    return {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem,
      attachmentIndexChanged: false,
    };
  }

  function deleteEvent(): TicketChangedEvent {
    return {
      type: "ticket-changed",
      change: "deleted",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: null,
      attachmentIndexChanged: false,
    };
  }

  it("does not resurrect an SSE-deleted ticket when an older update succeeds later", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t1]);
    client.setQueryData(notStartedKey, [t1]);
    client.setQueryData(detailKey, detail({ id: "t1" }));
    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useUpdateTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      fields: { title: "Local rename" },
    });

    await waitFor(() => {
      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.title).toBe(
        "Local rename",
      );
    });
    applyTicketChangedEvent(client, deleteEvent());

    resolveFetch(
      jsonResponse(
        detail({
          id: "t1",
          title: "Local rename",
          updatedAt: "2026-07-02T00:00:00.000Z",
        }),
      ),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(client.getQueryData(allKey)).toEqual([]);
    expect(client.getQueryData(notStartedKey)).toEqual([]);
    expect(client.getQueryData(detailKey)).toBeUndefined();
  });

  it("replays a newer SSE update after an older update response settles", async () => {
    const client = makeClient();
    const t1 = item({
      id: "t1",
      number: 1,
      title: "Original",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t1]);
    client.setQueryData(detailKey, detail({ id: "t1", title: "Original" }));
    const observedList = observeFailingRefetch(client, allKey);
    const observedDetail = observeFailingRefetch(client, detailKey);
    const resolveFetch = deferredFetch();

    try {
      const { result } = renderHook(() => useUpdateTicketMutation(), {
        wrapper: wrapperFor(client),
      });
      result.current.mutate({
        projectName: "alpha",
        number: 1,
        fields: { title: "Local rename" },
      });

      await waitFor(() => {
        expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.title).toBe(
          "Local rename",
        );
      });
      const newer = {
        ...t1,
        title: "Newer SSE rename",
        status: "done" as const,
        updatedAt: "2026-07-03T00:00:00.000Z",
      };
      applyTicketChangedEvent(client, staleUpdateEvent(newer));

      resolveFetch(
        jsonResponse(
          detail({
            id: "t1",
            title: "Local rename",
            updatedAt: "2026-07-02T00:00:00.000Z",
          }),
        ),
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]).toEqual(newer);
      expect(client.getQueryData(detailKey)).toBeUndefined();
      expect(observedList.refetch).toHaveBeenCalled();
      expect(observedDetail.refetch).toHaveBeenCalled();
    } finally {
      observedList.unsubscribe();
      observedDetail.unsubscribe();
    }
  });

  it("does not restore an update snapshot after an SSE deletion", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t1]);
    client.setQueryData(detailKey, detail({ id: "t1" }));
    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useUpdateTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      fields: { title: "Local rename" },
    });

    await waitFor(() => {
      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.title).toBe(
        "Local rename",
      );
    });
    applyTicketChangedEvent(client, deleteEvent());
    resolveFetch(jsonResponse({ error: "conflict" }, 409));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(allKey)).toEqual([]);
    expect(client.getQueryData(detailKey)).toBeUndefined();
  });

  it("does not restore a delete snapshot after an SSE deletion", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t1]);
    client.setQueryData(detailKey, detail({ id: "t1" }));
    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useDeleteTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ projectName: "alpha", number: 1 });

    await waitFor(() => {
      expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([]);
    });
    applyTicketChangedEvent(client, deleteEvent());
    resolveFetch(jsonResponse({ error: "conflict" }, 409));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(allKey)).toEqual([]);
    expect(client.getQueryData(detailKey)).toBeUndefined();
  });

  it("restores newer SSE lean state after a local failure even when refetch fails", async () => {
    const client = makeClient();
    const t1 = item({
      id: "t1",
      number: 1,
      title: "Original",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const detailKey = ticketKeys.detail("alpha", 1);
    client.setQueryData(allKey, [t1]);
    client.setQueryData(detailKey, detail({ id: "t1", title: "Original" }));
    const observedList = observeFailingRefetch(client, allKey);
    const observedDetail = observeFailingRefetch(client, detailKey);
    const resolveFetch = deferredFetch();

    try {
      const { result } = renderHook(() => useUpdateTicketMutation(), {
        wrapper: wrapperFor(client),
      });
      result.current.mutate({
        projectName: "alpha",
        number: 1,
        fields: { title: "Local rename" },
      });

      await waitFor(() => {
        expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.title).toBe(
          "Local rename",
        );
      });
      const newer = {
        ...t1,
        title: "Newer SSE rename",
        status: "done" as const,
        updatedAt: "2026-07-03T00:00:00.000Z",
      };
      applyTicketChangedEvent(client, staleUpdateEvent(newer));
      resolveFetch(jsonResponse({ error: "conflict" }, 409));

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]).toEqual(newer);
      expect(client.getQueryData(detailKey)).toBeUndefined();
      expect(observedList.refetch).toHaveBeenCalled();
      expect(observedDetail.refetch).toHaveBeenCalled();
    } finally {
      observedList.unsubscribe();
      observedDetail.unsubscribe();
    }
  });

  it("a stale event cannot undo an optimistic status move during or after settlement", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1, status: "not_started" });
    client.setQueryData(allKey, [t1]);
    client.setQueryData(notStartedKey, [t1]);
    client.setQueryData(inProgressKey, []);
    client.setQueryData(ticketKeys.detail("alpha", 1), detail({ id: "t1" }));

    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useUpdateTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      fields: { status: "in_progress" },
    });

    await waitFor(() => {
      expect(
        client.getQueryData<TicketListItem[]>(inProgressKey)?.map((r) => r.id),
      ).toEqual(["t1"]);
    });

    // The pre-move server truth arrives over SSE while the PATCH is in flight.
    applyTicketChangedEvent(client, staleUpdateEvent(t1));

    expect(
      client.getQueryData<TicketListItem[]>(allKey)?.find((r) => r.id === "t1")
        ?.status,
    ).toBe("in_progress");
    expect(
      client.getQueryData<TicketListItem[]>(inProgressKey)?.map((r) => r.id),
    ).toEqual(["t1"]);
    expect(client.getQueryData<TicketListItem[]>(notStartedKey)).toEqual([]);

    resolveFetch(
      jsonResponse(
        detail({
          id: "t1",
          status: "in_progress",
          updatedAt: "2026-07-08T00:00:00.000Z",
        }),
      ),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Settled: the overlay is gone, but cache `updatedAt` still rejects the
    // delayed pre-move server delta.
    applyTicketChangedEvent(client, staleUpdateEvent(t1));
    expect(
      client.getQueryData<TicketListItem[]>(allKey)?.find((r) => r.id === "t1")
        ?.status,
    ).toBe("in_progress");
  });

  it("the overlay is released when the mutation fails, after rollback", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1, status: "not_started" });
    client.setQueryData(allKey, [t1]);
    client.setQueryData(ticketKeys.detail("alpha", 1), detail({ id: "t1" }));

    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useUpdateTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({
      projectName: "alpha",
      number: 1,
      fields: { status: "in_progress" },
    });

    await waitFor(() => {
      expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.status).toBe(
        "in_progress",
      );
    });

    resolveFetch(jsonResponse({ error: "boom", code: "conflict" }, 409));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(allKey)).toEqual([t1]);

    // Rolled back and released: server truth via SSE applies unfiltered.
    const serverRow = { ...t1, status: "done" as const };
    applyTicketChangedEvent(client, staleUpdateEvent(serverRow));
    expect(client.getQueryData<TicketListItem[]>(allKey)?.[0]?.status).toBe(
      "done",
    );
  });

  it("an event mid-flight cannot resurrect an optimistically deleted ticket", async () => {
    const client = makeClient();
    const t1 = item({ id: "t1", number: 1 });
    client.setQueryData(allKey, [t1]);
    client.setQueryData(notStartedKey, [t1]);
    client.setQueryData(ticketKeys.detail("alpha", 1), detail({ id: "t1" }));

    const resolveFetch = deferredFetch();

    const { result } = renderHook(() => useDeleteTicketMutation(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ projectName: "alpha", number: 1 });

    await waitFor(() => {
      expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([]);
    });

    // A concurrent update delta for the doomed ticket arrives mid-flight.
    applyTicketChangedEvent(
      client,
      staleUpdateEvent({ ...t1, title: "Concurrent rename" }),
    );

    expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([]);
    expect(client.getQueryData<TicketListItem[]>(notStartedKey)).toEqual([]);

    resolveFetch(
      jsonResponse({
        id: "t1",
        projectPath: "/projects/alpha",
        projectName: "alpha",
        number: 1,
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([]);
  });
});
