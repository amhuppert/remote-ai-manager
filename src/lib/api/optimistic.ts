import type {
  QueryClient,
  QueryKey,
  UseMutationOptions,
} from "@tanstack/react-query";

/**
 * Shared engine for optimistic React Query mutations (steering contract:
 * optimistic update by default, pending indicator as the floor). A mutation
 * declares its cache touches as `OptimisticCacheUpdate`s; the engine derives
 * the full lifecycle from them:
 *
 * - `onMutate`: cancel in-flight fetches for every touched key, snapshot every
 *   touched entry, then apply the optimistic writes.
 * - `onError`: restore every snapshot that existed (never creates entries).
 * - `onSettled`: invalidate the touched keys (or `invalidateKeys` when the
 *   authoritative refetch surface is broader than the optimistic writes) so
 *   server state reconciles.
 *
 * Mutations whose optimistic signal is not a query-cache write (local React
 * state, Zustand in-flight flags) or that intentionally skip rollback stay
 * hand-rolled — this module only owns the snapshot/rollback/invalidate shape.
 */
export interface OptimisticCacheUpdate<TVars> {
  /** Key (or prefix) whose in-flight fetches are cancelled before writing. */
  cancelKey(vars: TVars): QueryKey;
  /** Concrete cache entries snapshotted for rollback. */
  snapshotKeys(client: QueryClient, vars: TVars): QueryKey[];
  /** Apply the optimistic write. */
  apply(client: QueryClient, vars: TVars): void;
}

/**
 * Optimistic write against one fixed cache entry. `update` follows
 * `setQueryData` updater semantics: returning `undefined` leaves the cache
 * untouched (so `old?.map(...)` no-ops when nothing is cached).
 */
export function cacheUpdate<TVars, TCacheData>(config: {
  key(vars: TVars): QueryKey;
  update(old: TCacheData | undefined, vars: TVars): TCacheData | undefined;
}): OptimisticCacheUpdate<TVars> {
  return {
    cancelKey: (vars) => config.key(vars),
    snapshotKeys: (_client, vars) => [config.key(vars)],
    apply: (client, vars) => {
      client.setQueryData<TCacheData>(config.key(vars), (old) =>
        config.update(old, vars),
      );
    },
  };
}

/**
 * Optimistic write against every cached entry under a key prefix — for
 * cascade-scoped views where one logical resource is cached under several
 * concrete keys (e.g. MCP config views per scope).
 */
export function cachePrefixUpdate<TVars, TCacheData>(config: {
  prefix(vars: TVars): QueryKey;
  update(old: TCacheData | undefined, vars: TVars): TCacheData | undefined;
}): OptimisticCacheUpdate<TVars> {
  const findEntries = (client: QueryClient, vars: TVars) =>
    client.getQueryCache().findAll({ queryKey: config.prefix(vars) });
  return {
    cancelKey: (vars) => config.prefix(vars),
    snapshotKeys: (client, vars) =>
      findEntries(client, vars).map((query) => query.queryKey),
    apply: (client, vars) => {
      for (const query of findEntries(client, vars)) {
        client.setQueryData<TCacheData>(query.queryKey, (old) =>
          config.update(old, vars),
        );
      }
    },
  };
}

export interface OptimisticMutationConfig<TData, TVars> {
  mutationFn(vars: TVars): Promise<TData>;
  /** The optimistic cache touches; function form for variable-dependent sets. */
  updates:
    | ReadonlyArray<OptimisticCacheUpdate<TVars>>
    | ((vars: TVars) => ReadonlyArray<OptimisticCacheUpdate<TVars>>);
  /** Keys invalidated on settle. Defaults to every update's cancel key. */
  invalidateKeys?(vars: TVars): ReadonlyArray<QueryKey>;
  onSuccess?(data: TData, vars: TVars): void;
  /** Runs after the snapshot rollback. */
  onError?(error: Error, vars: TVars): void;
  /** Runs after the settle invalidations. */
  onSettled?(vars: TVars): void;
}

export interface OptimisticMutationContext {
  snapshots: ReadonlyArray<readonly [QueryKey, unknown]>;
}

function resolveUpdates<TVars>(
  updates: OptimisticMutationConfig<never, TVars>["updates"],
  vars: TVars,
): ReadonlyArray<OptimisticCacheUpdate<TVars>> {
  return typeof updates === "function" ? updates(vars) : updates;
}

/**
 * Build `UseMutationOptions` implementing the optimistic lifecycle over the
 * declared cache updates. Usable directly with `useMutation(...)`, and — being
 * a plain function over a `QueryClient` — testable via `MutationObserver`
 * without rendering.
 */
export function createOptimisticMutation<TData, TVars>(
  client: QueryClient,
  config: OptimisticMutationConfig<TData, TVars>,
): UseMutationOptions<TData, Error, TVars, OptimisticMutationContext> {
  return {
    mutationFn: (vars) => config.mutationFn(vars),
    onMutate: async (vars): Promise<OptimisticMutationContext> => {
      const updates = resolveUpdates(config.updates, vars);
      for (const update of updates) {
        await client.cancelQueries({ queryKey: update.cancelKey(vars) });
      }
      const snapshots: Array<readonly [QueryKey, unknown]> = [];
      for (const update of updates) {
        for (const key of update.snapshotKeys(client, vars)) {
          snapshots.push([key, client.getQueryData(key)] as const);
        }
      }
      for (const update of updates) {
        update.apply(client, vars);
      }
      return { snapshots };
    },
    onError: (error, vars, context) => {
      for (const [key, data] of context?.snapshots ?? []) {
        if (data !== undefined) {
          client.setQueryData(key, data);
        }
      }
      config.onError?.(error, vars);
    },
    onSuccess: (data, vars) => {
      config.onSuccess?.(data, vars);
    },
    onSettled: (_data, _error, vars) => {
      const keys = config.invalidateKeys
        ? config.invalidateKeys(vars)
        : resolveUpdates(config.updates, vars).map((update) =>
            update.cancelKey(vars),
          );
      for (const key of keys) {
        void client.invalidateQueries({ queryKey: key });
      }
      config.onSettled?.(vars);
    },
  };
}
