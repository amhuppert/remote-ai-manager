"use client";

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { devServerKeys } from "@/lib/dev-server/query-keys";
import type {
  DevServersStatusResponse,
  DevServerRuntimeState,
} from "@/lib/dev-server/schemas";
async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost(url: string): Promise<void> {
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
}

function apiBase(projectName: string, sessionName: string): string {
  return `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/dev-servers`;
}

/**
 * Data-fetching hook for dev server state.
 * Real-time updates driven by SSE invalidation in NotificationListener.
 */
export function useDevServers(projectName: string, sessionName: string) {
  const queryClient = useQueryClient();
  const base = apiBase(projectName, sessionName);
  const queryKey = devServerKeys.list(projectName, sessionName);

  const query = useQuery({
    queryKey,
    queryFn: () => apiFetch<DevServersStatusResponse>(base),
  });

  const startServerMutation = useMutation({
    mutationFn: (serverName: string) =>
      apiPost(`${base}/${encodeURIComponent(serverName)}/start`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
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
  };
}
