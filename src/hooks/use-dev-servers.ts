"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { devServerKeys } from "@/lib/dev-server/query-keys";
import { ApiCallError } from "@/lib/api/errors";
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
 * Data-fetching hook for dev server state.
 * Real-time updates driven by SSE invalidation in NotificationListener.
 */
export function useDevServers(projectName: string, sessionName: string) {
  const queryClient = useQueryClient();
  const base = apiBase(projectName, sessionName);
  const queryKey = devServerKeys.list(projectName, sessionName);

  const [unmanagedConflict, setUnmanagedConflict] =
    useState<UnmanagedConflict | null>(null);

  const query = useQuery({
    queryKey,
    queryFn: () => apiFetch<DevServersStatusResponse>(base),
  });

  const startServerMutation = useMutation({
    mutationFn: (serverName: string) =>
      apiPost(`${base}/${encodeURIComponent(serverName)}/start`),
    onSuccess: () => {
      setUnmanagedConflict(null);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      const conflict = parseUnmanagedConflict(error);
      if (conflict) setUnmanagedConflict(conflict);
    },
  });

  const stopServerMutation = useMutation({
    mutationFn: (serverName: string) =>
      apiPost(`${base}/${encodeURIComponent(serverName)}/stop`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const startAllMutation = useMutation({
    mutationFn: () => apiPost(`${base}/start-all`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const stopAllMutation = useMutation({
    mutationFn: () => apiPost(`${base}/stop-all`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
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

  const servers: DevServerRuntimeState[] = query.data?.servers ?? [];
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
