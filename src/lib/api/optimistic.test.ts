import { describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";

import {
  cachePrefixUpdate,
  cacheUpdate,
  createOptimisticMutation,
  type OptimisticMutationConfig,
} from "@/lib/api/optimistic";

interface Row {
  id: string;
  archived: boolean;
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function runMutation<TData, TVars>(
  client: QueryClient,
  config: OptimisticMutationConfig<TData, TVars>,
  vars: TVars,
): Promise<TData> {
  const observer = new MutationObserver(
    client,
    createOptimisticMutation(client, config),
  );
  return observer.mutate(vars);
}

const rowListUpdate = cacheUpdate<{ id: string; archived: boolean }, Row[]>({
  key: () => ["rows"],
  update: (old, vars) =>
    old?.map((r) => (r.id === vars.id ? { ...r, archived: vars.archived } : r)),
});

describe("createOptimisticMutation", () => {
  it("applies the optimistic update before the mutationFn resolves and invalidates the touched key on settle", async () => {
    const client = makeClient();
    client.setQueryData<Row[]>(
      ["rows"],
      [
        { id: "a", archived: false },
        { id: "b", archived: false },
      ],
    );

    let resolveFetch: (value: { ok: true }) => void = () => {};
    const pending = new Promise<{ ok: true }>((r) => (resolveFetch = r));

    const done = runMutation(
      client,
      {
        mutationFn: () => pending,
        updates: [rowListUpdate],
      },
      { id: "a", archived: true },
    );

    await vi.waitFor(() => {
      expect(client.getQueryData<Row[]>(["rows"])).toEqual([
        { id: "a", archived: true },
        { id: "b", archived: false },
      ]);
    });

    resolveFetch({ ok: true });
    await done;

    expect(client.getQueryState(["rows"])?.isInvalidated).toBe(true);
  });

  it("cancels in-flight fetches for the touched key before writing", async () => {
    const client = makeClient();
    client.setQueryData<Row[]>(["rows"], [{ id: "a", archived: false }]);

    const prefetch = client.prefetchQuery({
      queryKey: ["rows"],
      queryFn: () => new Promise<Row[]>(() => {}),
    });

    let resolveFetch: (value: { ok: true }) => void = () => {};
    const mutationStarted = new Promise<void>((started) => {
      void runMutation(
        client,
        {
          mutationFn: () => {
            started();
            return new Promise<{ ok: true }>((r) => (resolveFetch = r));
          },
          updates: [rowListUpdate],
        },
        { id: "a", archived: true },
      );
    });

    await mutationStarted;
    expect(client.isFetching({ queryKey: ["rows"] })).toBe(0);

    resolveFetch({ ok: true });
    await prefetch;
  });

  it("rolls back every snapshotted key when the mutationFn rejects, then invalidates", async () => {
    const client = makeClient();
    client.setQueryData<Row[]>(["rows"], [{ id: "a", archived: false }]);
    client.setQueryData<number>(["count"], 1);

    const countUpdate = cacheUpdate<{ id: string; archived: boolean }, number>({
      key: () => ["count"],
      update: () => 0,
    });

    await expect(
      runMutation(
        client,
        {
          mutationFn: () => Promise.reject(new Error("boom")),
          updates: [rowListUpdate, countUpdate],
        },
        { id: "a", archived: true },
      ),
    ).rejects.toThrow("boom");

    expect(client.getQueryData<Row[]>(["rows"])).toEqual([
      { id: "a", archived: false },
    ]);
    expect(client.getQueryData<number>(["count"])).toBe(1);
    expect(client.getQueryState(["rows"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["count"])?.isInvalidated).toBe(true);
  });

  it("does not create a cache entry on rollback when none existed before the mutation", async () => {
    const client = makeClient();

    await expect(
      runMutation(
        client,
        {
          mutationFn: () => Promise.reject(new Error("boom")),
          updates: [rowListUpdate],
        },
        { id: "a", archived: true },
      ),
    ).rejects.toThrow("boom");

    expect(client.getQueryData<Row[]>(["rows"])).toBeUndefined();
  });

  it("supports variable-dependent update sets via the function form", async () => {
    const client = makeClient();
    client.setQueryData<Row[]>(["rows", "p1"], [{ id: "a", archived: false }]);
    client.setQueryData<Row[]>(["rows", "p2"], [{ id: "a", archived: false }]);

    await runMutation<{ ok: true }, { project: string }>(
      client,
      {
        mutationFn: () => Promise.resolve({ ok: true }),
        updates: (vars) => [
          cacheUpdate<{ project: string }, Row[]>({
            key: () => ["rows", vars.project],
            update: (old) => old?.map((r) => ({ ...r, archived: true })),
          }),
        ],
      },
      { project: "p2" },
    );

    expect(client.getQueryData<Row[]>(["rows", "p1"])).toEqual([
      { id: "a", archived: false },
    ]);
    expect(client.getQueryData<Row[]>(["rows", "p2"])).toEqual([
      { id: "a", archived: true },
    ]);
    expect(client.getQueryState(["rows", "p2"])?.isInvalidated).toBe(true);
  });

  it("invalidates the overridden keys instead of the update keys when invalidateKeys is given", async () => {
    const client = makeClient();
    client.setQueryData<Row[]>(["rows"], [{ id: "a", archived: false }]);
    client.setQueryData<number>(["stats"], 5);

    await runMutation(
      client,
      {
        mutationFn: () => Promise.resolve({ ok: true }),
        updates: [rowListUpdate],
        invalidateKeys: () => [["stats"]],
      },
      { id: "a", archived: true },
    );

    expect(client.getQueryState(["stats"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["rows"])?.isInvalidated).toBe(false);
  });

  it("patches and rolls back every cached entry under a prefix with cachePrefixUpdate", async () => {
    const client = makeClient();
    client.setQueryData<Row[]>(
      ["mcp", "global"],
      [{ id: "a", archived: false }],
    );
    client.setQueryData<Row[]>(
      ["mcp", "project", "p"],
      [{ id: "a", archived: false }],
    );
    client.setQueryData<Row[]>(["other"], [{ id: "a", archived: false }]);

    const prefix = cachePrefixUpdate<{ archived: boolean }, Row[]>({
      prefix: () => ["mcp"],
      update: (old, vars) =>
        old?.map((r) => ({ ...r, archived: vars.archived })),
    });

    let resolveFetch: (value: { ok: true }) => void = () => {};
    const done = runMutation(
      client,
      {
        mutationFn: () => new Promise<{ ok: true }>((r) => (resolveFetch = r)),
        updates: [prefix],
      },
      { archived: true },
    );

    await vi.waitFor(() => {
      expect(client.getQueryData<Row[]>(["mcp", "global"])).toEqual([
        { id: "a", archived: true },
      ]);
      expect(client.getQueryData<Row[]>(["mcp", "project", "p"])).toEqual([
        { id: "a", archived: true },
      ]);
    });
    expect(client.getQueryData<Row[]>(["other"])).toEqual([
      { id: "a", archived: false },
    ]);

    resolveFetch({ ok: true });
    await done;

    const rollbackClient = makeClient();
    rollbackClient.setQueryData<Row[]>(
      ["mcp", "global"],
      [{ id: "a", archived: false }],
    );
    rollbackClient.setQueryData<Row[]>(
      ["mcp", "project", "p"],
      [{ id: "a", archived: false }],
    );
    await expect(
      runMutation(
        rollbackClient,
        {
          mutationFn: () => Promise.reject(new Error("boom")),
          updates: [prefix],
        },
        { archived: true },
      ),
    ).rejects.toThrow("boom");
    expect(rollbackClient.getQueryData<Row[]>(["mcp", "global"])).toEqual([
      { id: "a", archived: false },
    ]);
    expect(rollbackClient.getQueryData<Row[]>(["mcp", "project", "p"])).toEqual(
      [{ id: "a", archived: false }],
    );
  });

  it("runs onSuccess with (data, vars), onError after rollback, and onSettled after invalidation", async () => {
    const client = makeClient();
    client.setQueryData<Row[]>(["rows"], [{ id: "a", archived: false }]);

    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    await runMutation(
      client,
      {
        mutationFn: () => Promise.resolve({ created: "row-1" }),
        updates: [rowListUpdate],
        onSuccess,
        onSettled,
      },
      { id: "a", archived: true },
    );
    expect(onSuccess).toHaveBeenCalledWith(
      { created: "row-1" },
      { id: "a", archived: true },
    );
    expect(onSettled).toHaveBeenCalledWith({ id: "a", archived: true });

    const failing = makeClient();
    failing.setQueryData<Row[]>(["rows"], [{ id: "a", archived: false }]);
    const seenAtError: Array<Row[] | undefined> = [];
    await expect(
      runMutation(
        failing,
        {
          mutationFn: () => Promise.reject(new Error("boom")),
          updates: [rowListUpdate],
          onError: (error) => {
            expect(error.message).toBe("boom");
            seenAtError.push(failing.getQueryData<Row[]>(["rows"]));
          },
        },
        { id: "a", archived: true },
      ),
    ).rejects.toThrow("boom");
    expect(seenAtError).toEqual([[{ id: "a", archived: false }]]);
  });
});
