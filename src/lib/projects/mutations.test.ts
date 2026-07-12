// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  useArchiveProjectMutation,
  useDeleteProjectMutation,
  usePinProjectMutation,
} from "@/lib/projects/mutations";
import { projectKeys } from "@/lib/projects/query-keys";
import type { z } from "zod";
import type {
  discoveredProjectSchema,
  projectPreferencesResponseSchema,
} from "@/lib/projects/schemas";
import { normalizeTicketListFilters } from "@/lib/tickets/list-filters";
import { ticketKeys } from "@/lib/tickets/query-keys";
import {
  useCreateTicketMutation,
  useUpdateTicketMutation,
} from "@/lib/tickets/mutations";
import { applyTicketChangedEvent } from "@/lib/tickets/sse-reducer";
import type { TicketDetail, TicketListItem } from "@/lib/tickets/schemas";

type DiscoveredProject = z.infer<typeof discoveredProjectSchema>;
type ProjectPreferences = z.infer<typeof projectPreferencesResponseSchema>;

function project(
  overrides: Partial<DiscoveredProject> & { name: string },
): DiscoveredProject {
  return {
    name: overrides.name,
    path: overrides.path ?? `/repos/${overrides.name}`,
    activeSessions: overrides.activeSessions ?? 0,
    hasRunningSession: overrides.hasRunningSession ?? false,
  };
}

function ticket(projectName: string, number: number): TicketListItem {
  return {
    id: `${projectName}-${number}`,
    projectPath: `/repos/${projectName}`,
    projectName,
    number,
    title: `${projectName} ticket`,
    workType: "feature",
    status: "not_started",
    attachmentCount: 0,
    activeSessionName: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
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

describe("useArchiveProjectMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically adds the project to the archived preferences before the server responds", async () => {
    const client = makeClient();
    const prefsKey = projectKeys.preferences();
    client.setQueryData<ProjectPreferences>(prefsKey, {
      archived: ["already"],
      pinned: [],
    });

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useArchiveProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ projectName: "p1", archived: true });

    await waitFor(() => {
      const prefs = client.getQueryData<ProjectPreferences>(prefsKey);
      expect(prefs?.archived).toEqual(["already", "p1"]);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("optimistically removes the project from the archived preferences on unarchive", async () => {
    const client = makeClient();
    const prefsKey = projectKeys.preferences();
    client.setQueryData<ProjectPreferences>(prefsKey, {
      archived: ["p1", "other"],
      pinned: [],
    });

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useArchiveProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ projectName: "p1", archived: false });

    await waitFor(() => {
      const prefs = client.getQueryData<ProjectPreferences>(prefsKey);
      expect(prefs?.archived).toEqual(["other"]);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the caches when the server rejects and still invalidates on settle", async () => {
    const client = makeClient();
    const listKey = projectKeys.list();
    const prefsKey = projectKeys.preferences();
    client.setQueryData<DiscoveredProject[]>(listKey, [
      project({ name: "p1" }),
    ]);
    client.setQueryData<ProjectPreferences>(prefsKey, {
      archived: [],
      pinned: [],
    });

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useArchiveProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ projectName: "p1", archived: true });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(client.getQueryData<ProjectPreferences>(prefsKey)).toEqual({
      archived: [],
      pinned: [],
    });
    expect(client.getQueryData<DiscoveredProject[]>(listKey)).toEqual([
      project({ name: "p1" }),
    ]);
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(prefsKey)?.isInvalidated).toBe(true);
  });

  it("invalidates the list and preferences caches on success", async () => {
    const client = makeClient();
    const listKey = projectKeys.list();
    const prefsKey = projectKeys.preferences();
    client.setQueryData<DiscoveredProject[]>(listKey, []);
    client.setQueryData<ProjectPreferences>(prefsKey, {
      archived: [],
      pinned: [],
    });
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(() => useArchiveProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    await result.current.mutateAsync({ projectName: "p1", archived: true });

    await waitFor(() => {
      expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(prefsKey)?.isInvalidated).toBe(true);
    });
  });

  it("tombstones every server-deleted ticket before a delayed create response arrives", async () => {
    const client = makeClient();
    const ticketListKey = ticketKeys.list(normalizeTicketListFilters({}));
    client.setQueryData(ticketListKey, []);
    client.setQueryData(projectKeys.list(), [project({ name: "doomed" })]);
    client.setQueryData<ProjectPreferences>(projectKeys.preferences(), {
      archived: [],
      pinned: [],
    });
    let resolveCreate: (response: Response) => void = () => {};
    fetchSpy.mockImplementation(async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return await new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
      }
      return jsonResponse({
        success: true,
        sessionsRemoved: 0,
        deletedTicketNumbers: [1],
      });
    });
    const { result } = renderHook(
      () => ({
        create: useCreateTicketMutation(),
        deleteProject: useDeleteProjectMutation(),
      }),
      { wrapper: wrapperFor(client) },
    );

    const delayedCreate = result.current.create
      .mutateAsync({
        projectName: "doomed",
        input: {
          title: "Committed before project deletion",
          description: "",
          workType: "feature",
        },
      })
      .catch(() => undefined);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await result.current.deleteProject.mutateAsync({
      projectName: "doomed",
      projectPath: "/repos/doomed",
    });
    const created: TicketDetail = {
      id: "doomed-1",
      projectPath: "/repos/doomed",
      projectName: "doomed",
      number: 1,
      title: "Committed before project deletion",
      description: "",
      workType: "feature",
      status: "not_started",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      attachments: [],
      sessions: [],
    };
    resolveCreate(jsonResponse(created, 201));
    await delayedCreate;

    expect(client.getQueryData<TicketListItem[]>(ticketListKey)).toEqual([]);
    expect(client.getQueryData(ticketKeys.detail("doomed", 1))).toBeUndefined();
  });

  it("does not let a failed ticket mutation restore or replay across a committed project deletion", async () => {
    const client = makeClient();
    const ticketListKey = ticketKeys.list(normalizeTicketListFilters({}));
    const ticketDetailKey = ticketKeys.detail("doomed", 1);
    const original = ticket("doomed", 1);
    const originalDetail: TicketDetail = {
      id: original.id,
      projectPath: original.projectPath,
      projectName: original.projectName,
      number: original.number,
      title: original.title,
      description: "",
      workType: original.workType,
      status: original.status,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
      attachments: [],
      sessions: [],
    };
    client.setQueryData(ticketListKey, [original]);
    client.setQueryData(ticketDetailKey, originalDetail);
    client.setQueryData(projectKeys.list(), [project({ name: "doomed" })]);
    client.setQueryData<ProjectPreferences>(projectKeys.preferences(), {
      archived: [],
      pinned: [],
    });
    const requests: Array<{ resolve(response: Response): void }> = [];
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          requests.push({ resolve });
        }),
    );
    const { result } = renderHook(
      () => ({
        update: useUpdateTicketMutation(),
        deleteProject: useDeleteProjectMutation(),
      }),
      { wrapper: wrapperFor(client) },
    );

    const update = result.current.update
      .mutateAsync({
        projectName: "doomed",
        number: 1,
        fields: { title: "Optimistic rename" },
      })
      .catch(() => undefined);
    await waitFor(() => expect(requests).toHaveLength(1));
    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "updated",
      projectName: "doomed",
      ticketNumber: 1,
      listItem: {
        ...original,
        title: "Pre-deletion server rename",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
      attachmentIndexChanged: false,
    });

    const deletion = result.current.deleteProject.mutateAsync({
      projectName: "doomed",
      projectPath: "/repos/doomed",
    });
    await waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.resolve(
      jsonResponse({
        success: true,
        sessionsRemoved: 0,
        deletedTicketNumbers: [1],
      }),
    );
    await deletion;
    expect(client.getQueryData<TicketListItem[]>(ticketListKey)).toEqual([]);
    expect(client.getQueryData(ticketDetailKey)).toBeUndefined();

    requests[0]!.resolve(jsonResponse({ error: "connection lost" }, 500));
    await update;

    expect(client.getQueryData<TicketListItem[]>(ticketListKey)).toEqual([]);
    expect(client.getQueryData(ticketDetailKey)).toBeUndefined();
  });
});

describe("useDeleteProjectMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically removes the project from the list and from archived/pinned preferences", async () => {
    const client = makeClient();
    const listKey = projectKeys.list();
    const prefsKey = projectKeys.preferences();
    client.setQueryData<DiscoveredProject[]>(listKey, [
      project({ name: "doomed", path: "/repos/doomed" }),
      project({ name: "keeper" }),
    ]);
    client.setQueryData<ProjectPreferences>(prefsKey, {
      archived: ["doomed", "keeper"],
      pinned: ["doomed"],
    });
    const ticketListKey = ticketKeys.list(normalizeTicketListFilters({}));
    client.setQueryData(ticketListKey, [
      ticket("doomed", 1),
      ticket("keeper", 2),
    ]);

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => useDeleteProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({
      projectName: "doomed",
      projectPath: "/repos/doomed",
    });

    await waitFor(() => {
      const list = client.getQueryData<DiscoveredProject[]>(listKey);
      const prefs = client.getQueryData<ProjectPreferences>(prefsKey);
      expect(list?.map((p) => p.name)).toEqual(["keeper"]);
      expect(prefs?.archived).toEqual(["keeper"]);
      expect(prefs?.pinned).toEqual([]);
      expect(
        client
          .getQueryData<TicketListItem[]>(ticketListKey)
          ?.map((row) => row.id),
      ).toEqual(["keeper-2"]);
    });

    client.setQueryData<TicketListItem[]>(ticketListKey, (rows) => [
      ...(rows ?? []),
      {
        ...ticket("doomed", 1),
        title: "Reinserted while project deletion was pending",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    ]);

    resolveFetch(
      jsonResponse({
        success: true,
        sessionsRemoved: 0,
        deletedTicketNumbers: [1],
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      client
        .getQueryData<TicketListItem[]>(ticketListKey)
        ?.map((row) => row.id),
    ).toEqual(["keeper-2"]);
  });

  it("rolls back both caches when the server rejects and still invalidates on settle", async () => {
    const client = makeClient();
    const listKey = projectKeys.list();
    const prefsKey = projectKeys.preferences();
    const originalList = [
      project({ name: "doomed", path: "/repos/doomed" }),
      project({ name: "keeper" }),
    ];
    client.setQueryData<DiscoveredProject[]>(listKey, originalList);
    client.setQueryData<ProjectPreferences>(prefsKey, {
      archived: ["doomed"],
      pinned: ["doomed"],
    });
    const ticketListKey = ticketKeys.list(normalizeTicketListFilters({}));
    const originalTickets = [ticket("doomed", 1), ticket("keeper", 2)];
    client.setQueryData(ticketListKey, originalTickets);

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useDeleteProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({
      projectName: "doomed",
      projectPath: "/repos/doomed",
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(client.getQueryData<DiscoveredProject[]>(listKey)).toEqual(
      originalList,
    );
    expect(client.getQueryData<ProjectPreferences>(prefsKey)).toEqual({
      archived: ["doomed"],
      pinned: ["doomed"],
    });
    expect(client.getQueryData(ticketListKey)).toEqual(originalTickets);
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(prefsKey)?.isInvalidated).toBe(true);
  });

  it("restores only the deleted project's rows without clobbering concurrent ticket changes", async () => {
    const client = makeClient();
    const ticketListKey = ticketKeys.list(normalizeTicketListFilters({}));
    const doomed = ticket("doomed", 1);
    const keeper = ticket("keeper", 2);
    client.setQueryData(projectKeys.list(), [project({ name: "doomed" })]);
    client.setQueryData<ProjectPreferences>(projectKeys.preferences(), {
      archived: [],
      pinned: [],
    });
    client.setQueryData(ticketListKey, [doomed, keeper]);
    let resolveDelete: (response: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((resolve) => (resolveDelete = resolve)),
    );
    const { result } = renderHook(() => useDeleteProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({
      projectName: "doomed",
      projectPath: "/repos/doomed",
    });
    await waitFor(() =>
      expect(client.getQueryData<TicketListItem[]>(ticketListKey)).toEqual([
        keeper,
      ]),
    );
    client.setQueryData<TicketListItem[]>(ticketListKey, (rows) =>
      rows?.map((row) =>
        row.id === keeper.id
          ? {
              ...row,
              title: "Keeper changed while deletion was pending",
              updatedAt: "2026-07-02T00:00:00.000Z",
            }
          : row,
      ),
    );
    resolveDelete(jsonResponse({ error: "boom" }, 500));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData<TicketListItem[]>(ticketListKey)).toEqual([
      {
        ...keeper,
        title: "Keeper changed while deletion was pending",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
      doomed,
    ]);
  });

  it("invalidates the list and preferences caches on success", async () => {
    const client = makeClient();
    const listKey = projectKeys.list();
    const prefsKey = projectKeys.preferences();
    client.setQueryData<DiscoveredProject[]>(listKey, []);
    client.setQueryData<ProjectPreferences>(prefsKey, {
      archived: [],
      pinned: [],
    });
    const ticketListKey = ticketKeys.list(normalizeTicketListFilters({}));
    const ticketDetailKey = ticketKeys.detail("p1", 1);
    const ticketLinksKey = ticketKeys.sessionLinks("p1");
    client.setQueryData(ticketListKey, [ticket("p1", 1)]);
    client.setQueryData(ticketDetailKey, { id: "p1-1" });
    client.setQueryData(ticketLinksKey, {});
    fetchSpy.mockResolvedValue(
      jsonResponse({
        success: true,
        sessionsRemoved: 0,
        deletedTicketNumbers: [1],
      }),
    );

    const { result } = renderHook(() => useDeleteProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    await result.current.mutateAsync({
      projectName: "p1",
      projectPath: "/repos/p1",
    });

    await waitFor(() => {
      expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(prefsKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(ticketListKey)?.isInvalidated).toBe(true);
      expect(client.getQueryData(ticketDetailKey)).toBeUndefined();
      expect(client.getQueryData(ticketLinksKey)).toBeUndefined();
    });
  });
});

describe("usePinProjectMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("optimistically adds the project to the pinned preferences before the server responds", async () => {
    const client = makeClient();
    const prefsKey = projectKeys.preferences();
    client.setQueryData<ProjectPreferences>(prefsKey, {
      archived: [],
      pinned: ["already"],
    });

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => usePinProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ projectName: "p1", pinned: true });

    await waitFor(() => {
      const prefs = client.getQueryData<ProjectPreferences>(prefsKey);
      expect(prefs?.pinned).toEqual(["already", "p1"]);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("optimistically removes the project from the pinned preferences on unpin", async () => {
    const client = makeClient();
    const prefsKey = projectKeys.preferences();
    client.setQueryData<ProjectPreferences>(prefsKey, {
      archived: [],
      pinned: ["p1", "other"],
    });

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(() => usePinProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ projectName: "p1", pinned: false });

    await waitFor(() => {
      const prefs = client.getQueryData<ProjectPreferences>(prefsKey);
      expect(prefs?.pinned).toEqual(["other"]);
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the preferences cache when the server rejects and still invalidates on settle", async () => {
    const client = makeClient();
    const prefsKey = projectKeys.preferences();
    client.setQueryData<ProjectPreferences>(prefsKey, {
      archived: [],
      pinned: [],
    });

    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => usePinProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ projectName: "p1", pinned: true });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(client.getQueryData<ProjectPreferences>(prefsKey)).toEqual({
      archived: [],
      pinned: [],
    });
    expect(client.getQueryState(prefsKey)?.isInvalidated).toBe(true);
  });

  it("invalidates the preferences cache on success", async () => {
    const client = makeClient();
    const prefsKey = projectKeys.preferences();
    client.setQueryData<ProjectPreferences>(prefsKey, {
      archived: [],
      pinned: [],
    });
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(() => usePinProjectMutation(), {
      wrapper: wrapperFor(client),
    });

    await result.current.mutateAsync({ projectName: "p1", pinned: true });

    await waitFor(() => {
      expect(client.getQueryState(prefsKey)?.isInvalidated).toBe(true);
    });
  });
});
