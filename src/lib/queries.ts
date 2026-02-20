import { useQuery } from "@tanstack/react-query";
import {
  projectKeys,
  configKeys,
  hooksKeys,
  sessionKeys,
  conversationKeys,
  commandKeys,
} from "@/lib/query-keys";
import type {
  DiscoveredProject,
  SessionState,
  SessionDiff,
  CommitLogEntry,
  ConversationState,
  TranscriptMessage,
  CommandsResponse,
} from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(
      (body as { error?: string }).error ?? `API error ${res.status}`,
    );
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Project Queries
// ---------------------------------------------------------------------------

export function useProjectsQuery() {
  return useQuery({
    queryKey: projectKeys.list(),
    queryFn: () => apiFetch<DiscoveredProject[]>("/api/projects"),
  });
}

export function useProjectPreferencesQuery() {
  return useQuery({
    queryKey: projectKeys.preferences(),
    queryFn: () =>
      apiFetch<{ archived: string[]; pinned: string[] }>(
        "/api/projects/preferences",
      ),
  });
}

// ---------------------------------------------------------------------------
// Config & Hooks Queries
// ---------------------------------------------------------------------------

export function useConfigQuery() {
  return useQuery({
    queryKey: configKeys.all,
    queryFn: () => apiFetch<{ baseDir: string }>("/api/config"),
  });
}

export function useHooksStatusQuery() {
  return useQuery({
    queryKey: hooksKeys.status(),
    queryFn: () =>
      apiFetch<{
        installed: boolean;
        hasUserPromptSubmit: boolean;
        hasStop: boolean;
      }>("/api/hooks/status"),
  });
}

// ---------------------------------------------------------------------------
// Session Queries
// ---------------------------------------------------------------------------

export function useSessionsQuery(projectName: string) {
  return useQuery({
    queryKey: sessionKeys.list(projectName),
    queryFn: async () => {
      const data = await apiFetch<{ sessions: SessionState[] }>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions`,
      );
      return data.sessions;
    },
  });
}

export function useSessionQuery(projectName: string, sessionName: string) {
  return useQuery({
    queryKey: sessionKeys.detail(projectName, sessionName),
    queryFn: () =>
      apiFetch<SessionState>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}`,
      ),
  });
}

export function useSessionDiffQuery(
  projectName: string,
  sessionName: string,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: sessionKeys.diff(projectName, sessionName),
    queryFn: () =>
      apiFetch<SessionDiff>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/diff`,
      ),
    refetchInterval: options?.refetchInterval,
  });
}

export function useCommitsQuery(projectName: string, sessionName: string) {
  return useQuery({
    queryKey: sessionKeys.commits(projectName, sessionName),
    queryFn: async () => {
      const data = await apiFetch<{ commits: CommitLogEntry[] }>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commits`,
      );
      return data.commits;
    },
  });
}

export function useCommitDiffQuery(
  projectName: string,
  sessionName: string,
  hash: string | null,
) {
  return useQuery({
    queryKey: sessionKeys.commitDiff(projectName, sessionName, hash ?? ""),
    queryFn: () =>
      apiFetch<SessionDiff>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commits/${encodeURIComponent(hash!)}/diff`,
      ),
    enabled: !!hash,
  });
}

// ---------------------------------------------------------------------------
// Conversation Queries
// ---------------------------------------------------------------------------

export function useConversationsQuery(
  projectName: string,
  sessionName: string,
) {
  return useQuery({
    queryKey: conversationKeys.list(projectName, sessionName),
    queryFn: () =>
      apiFetch<ConversationState[]>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations?import=true`,
      ),
  });
}

export function useConversationMessagesQuery(
  projectName: string,
  sessionName: string,
  conversationId: string,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: conversationKeys.messages(
      projectName,
      sessionName,
      conversationId,
    ),
    queryFn: () =>
      apiFetch<TranscriptMessage[]>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/messages`,
      ),
    refetchInterval: options?.refetchInterval,
  });
}

// ---------------------------------------------------------------------------
// Command Queries
// ---------------------------------------------------------------------------

export function useCommandsQuery(projectName: string, sessionName: string) {
  return useQuery({
    queryKey: commandKeys.list(projectName, sessionName),
    queryFn: () =>
      apiFetch<CommandsResponse>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commands`,
      ),
  });
}
