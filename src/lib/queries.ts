import { useQuery } from "@tanstack/react-query";
import {
  projectKeys,
  configKeys,
  sessionKeys,
  conversationKeys,
  commandKeys,
  workflowKeys,
  kiroDocKeys,
  notificationKeys,
  presetKeys,
} from "@/lib/query-keys";
import type {
  DiscoveredProject,
  SessionState,
  SessionDiff,
  CommitLogEntry,
  ConversationState,
  TranscriptMessage,
  CommandsResponse,
  RalphLoopWorkflow,
  RalphLoopIterationMeta,
  KiroDocTree,
  NotificationsResponse,
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
// Config Queries
// ---------------------------------------------------------------------------

export function useConfigQuery() {
  return useQuery({
    queryKey: configKeys.all,
    queryFn: () => apiFetch<{ baseDir: string }>("/api/config"),
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

export function useFocusDocQuery(
  projectName: string,
  sessionName: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: sessionKeys.focusDoc(projectName, sessionName),
    queryFn: async () => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/focus-doc`,
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`Failed to fetch focus document`);
      }
      const data = (await res.json()) as { content: string };
      return data.content;
    },
    enabled: options?.enabled ?? true,
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

export interface ActiveConversation {
  id: string;
  name: string | null;
  status: "running" | "awaiting";
  lastActivityAt: string;
  projectName: string;
  projectPath: string;
  sessionName: string;
}

export function useActiveConversationsQuery() {
  return useQuery({
    queryKey: conversationKeys.active,
    queryFn: async () => {
      const data = await apiFetch<{ conversations: ActiveConversation[] }>(
        "/api/conversations/active",
      );
      return data.conversations;
    },
  });
}

export function useConversationsQuery(
  projectName: string,
  sessionName: string,
) {
  return useQuery({
    queryKey: conversationKeys.list(projectName, sessionName),
    queryFn: () =>
      apiFetch<ConversationState[]>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations`,
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

// ---------------------------------------------------------------------------
// Workflow Queries
// ---------------------------------------------------------------------------

export function useWorkflowQuery(projectName: string, sessionName: string) {
  return useQuery({
    queryKey: workflowKeys.status(projectName, sessionName),
    queryFn: () =>
      apiFetch<{ workflow: RalphLoopWorkflow | null }>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/workflow`,
      ).then((r) => r.workflow),
  });
}

export function useWorkflowIterationsQuery(
  projectName: string,
  sessionName: string,
) {
  return useQuery({
    queryKey: workflowKeys.iterations(projectName, sessionName),
    queryFn: () =>
      apiFetch<{ iterations: RalphLoopIterationMeta[] }>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/workflow/iterations`,
      ).then((r) => r.iterations),
    enabled: false, // Only fetch on demand
  });
}

// ---------------------------------------------------------------------------
// Kiro Doc Queries
// ---------------------------------------------------------------------------

export function useKiroDocTreeQuery(
  projectName: string,
  sessionName?: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: kiroDocKeys.tree(projectName, sessionName),
    queryFn: () => {
      const params = sessionName
        ? `?session=${encodeURIComponent(sessionName)}`
        : "";
      return apiFetch<KiroDocTree>(
        `/api/projects/${encodeURIComponent(projectName)}/kiro-docs${params}`,
      );
    },
    staleTime: 30_000,
    enabled: options?.enabled ?? true,
  });
}

export function useKiroDocFileQuery(
  projectName: string,
  filePath: string | null,
  sessionName?: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: kiroDocKeys.file(projectName, filePath ?? "", sessionName),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("path", filePath!);
      if (sessionName) params.set("session", sessionName);
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectName)}/kiro-docs?${params.toString()}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error("Failed to fetch kiro document");
      }
      const data = (await res.json()) as { content: string };
      return data.content;
    },
    staleTime: 60_000,
    enabled: (options?.enabled ?? true) && !!filePath,
  });
}

// ---------------------------------------------------------------------------
// Notification Queries
// ---------------------------------------------------------------------------

export function useNotificationsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: notificationKeys.list(),
    queryFn: () => apiFetch<NotificationsResponse>("/api/notifications"),
    enabled: options?.enabled ?? true,
  });
}

// ---------------------------------------------------------------------------
// Preset Queries
// ---------------------------------------------------------------------------

export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  badge: string;
  files: string[];
  installed: boolean;
}

export function usePresetsQuery(projectName: string) {
  return useQuery({
    queryKey: presetKeys.list(projectName),
    queryFn: () =>
      apiFetch<{ presets: PresetInfo[] }>(
        `/api/projects/${encodeURIComponent(projectName)}/dev-servers/presets`,
      ).then((r) => r.presets),
  });
}
