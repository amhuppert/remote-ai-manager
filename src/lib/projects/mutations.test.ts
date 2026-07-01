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
    });

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
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
