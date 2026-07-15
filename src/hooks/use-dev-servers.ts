"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { devServerKeys } from "@/lib/dev-server/query-keys";
import { ApiCallError } from "@/lib/api/errors";
import { cacheUpdate, createOptimisticMutation } from "@/lib/api/optimistic";
import type {
  DevServersStatusResponse,
  DevServerRuntimeState,
} from "@/lib/dev-server/schemas";

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost(url: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const parsed = (await res
      .json()
      .catch(() => ({ error: `API error: ${res.status}` }))) as {
      error?: string;
      code?: string;
      output?: string;
      details?: Record<string, unknown>;
    };
    throw new ApiCallError(
      parsed.error ?? `API error: ${res.status}`,
      parsed.code,
      parsed.output,
      parsed.details,
    );
  }
  return res.json().catch(() => ({}));
}

function apiBase(projectName: string, sessionName: string): string {
  return `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/dev-servers`;
}

export interface UnmanagedConflict {
  serverName: string;
  port: number;
  pid: number;
  cwd: string;
}

function parseUnmanagedConflict(error: unknown): UnmanagedConflict | null {
  if (!(error instanceof ApiCallError)) return null;
  if (error.code !== "UNMANAGED_DEV_SERVER_DETECTED") return null;
  const d = error.details ?? {};
  if (
    typeof d["serverName"] === "string" &&
    typeof d["port"] === "number" &&
    typeof d["pid"] === "number" &&
    typeof d["cwd"] === "string"
  ) {
    return {
      serverName: d["serverName"],
      port: d["port"],
      pid: d["pid"],
      cwd: d["cwd"],
    };
  }
  return null;
}

/**
 * A runtime state row plus the client-only stop-pending flag: the status enum
 * has no "stopping" value, so an in-flight stop is surfaced as a per-server
 * pending indicator instead of an optimistic status patch.
 */
export type DevServerDisplayState = DevServerRuntimeState & {
  isStopPending: boolean;
};

/**
 * Data-fetching hook for dev server state.
 * Real-time updates driven by SSE invalidation in NotificationListener.
 */
export function useDevServers(projectName: string, sessionName: string) {
  const queryClient = useQueryClient();
  const base = apiBase(projectName, sessionName);
  const queryKey = devServerKeys.list(projectName, sessionName);

  const [unmanagedConflict, setUnmanagedConflict] =
    useState<UnmanagedConflict | null>(null);
  const [stopPendingNames, setStopPendingNames] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const query = useQuery({
    queryKey,
    queryFn: () => apiFetch<DevServersStatusResponse>(base),
  });

  const statusPatchUpdate = useCallback(
    <TVars>(
      shouldPatch: (server: DevServerRuntimeState, vars: TVars) => boolean,
      status: DevServerRuntimeState["status"],
    ) =>
      cacheUpdate<TVars, DevServersStatusResponse>({
        key: () => queryKey,
        update: (old, vars) =>
          old
            ? {
                ...old,
                servers: old.servers.map((s) =>
                  shouldPatch(s, vars) ? { ...s, status } : s,
                ),
              }
            : undefined,
      }),
    [queryKey],
  );

  const markStopPending = useCallback((names: string[]) => {
    setStopPendingNames((prev) => new Set([...prev, ...names]));
  }, []);

  const clearStopPending = useCallback((names: string[]) => {
    setStopPendingNames((prev) => {
      const next = new Set(prev);
      for (const name of names) next.delete(name);
      return next;
    });
  }, []);

  const startServerMutation = useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: (serverName: string) =>
        apiPost(`${base}/${encodeURIComponent(serverName)}/start`),
      updates: [
        statusPatchUpdate<string>(
          (s, serverName) => s.serverName === serverName,
          "starting",
        ),
      ],
      onSuccess: () => setUnmanagedConflict(null),
      onError: (error) => {
        const conflict = parseUnmanagedConflict(error);
        if (conflict) setUnmanagedConflict(conflict);
      },
    }),
  );

  const stopServerMutation = useMutation({
    mutationFn: (serverName: string) =>
      apiPost(`${base}/${encodeURIComponent(serverName)}/stop`),
    onMutate: (serverName) => {
      markStopPending([serverName]);
    },
    onSettled: (_data, _error, serverName) => {
      clearStopPending([serverName]);
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const startAllMutation = useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: () => apiPost(`${base}/start-all`),
      updates: [
        statusPatchUpdate<void>(
          (s) => s.status === "stopped" || s.status === "error",
          "starting",
        ),
      ],
    }),
  );

  const stopAllMutation = useMutation({
    mutationFn: () => apiPost(`${base}/stop-all`),
    onMutate: () => {
      const cached =
        queryClient.getQueryData<DevServersStatusResponse>(queryKey);
      const names = (cached?.servers ?? [])
        .filter((s) => s.status === "running" || s.status === "starting")
        .map((s) => s.serverName);
      markStopPending(names);
      return { names };
    },
    onSettled: (_data, _error, _vars, context) => {
      clearStopPending(context?.names ?? []);
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const stopUnmanagedMutation = useMutation({
    mutationFn: async (input: { serverName: string; port: number }) => {
      await apiPost(
        `${base}/${encodeURIComponent(input.serverName)}/stop-unmanaged`,
        { port: input.port },
      );
      return input;
    },
    onSuccess: (input) => {
      setUnmanagedConflict(null);
      startServerMutation.mutate(input.serverName);
    },
  });

  const dismissUnmanagedConflict = useCallback(() => {
    setUnmanagedConflict(null);
  }, []);

  const stopUnmanagedAndRetry = useCallback(() => {
    if (!unmanagedConflict) return;
    stopUnmanagedMutation.mutate({
      serverName: unmanagedConflict.serverName,
      port: unmanagedConflict.port,
    });
  }, [unmanagedConflict, stopUnmanagedMutation]);

  const servers: DevServerDisplayState[] = (query.data?.servers ?? []).map(
    (s) => ({ ...s, isStopPending: stopPendingNames.has(s.serverName) }),
  );
  const hasRunning = servers.some(
    (s) => s.status === "running" || s.status === "starting",
  );
  const hasStoppable = servers.some(
    (s) => s.status === "running" || s.status === "starting",
  );
  const hasStopped = servers.some(
    (s) => s.status === "stopped" || s.status === "error",
  );

  return {
    servers,
    isLoading: query.isPending,
    isError: query.isError,
    hasRunning,
    hasStoppable,
    hasStopped,
    startServer: startServerMutation.mutate,
    stopServer: stopServerMutation.mutate,
    startAll: () => startAllMutation.mutate(),
    stopAll: () => stopAllMutation.mutate(),
    isStarting: startServerMutation.isPending || startAllMutation.isPending,
    isStopping: stopServerMutation.isPending || stopAllMutation.isPending,
    unmanagedConflict,
    dismissUnmanagedConflict,
    stopUnmanagedAndRetry,
    isStoppingUnmanaged: stopUnmanagedMutation.isPending,
  };
}
