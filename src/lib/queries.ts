import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import {
  projectKeys,
  configKeys,
  sessionKeys,
  conversationKeys,
  commandKeys,
  fileKeys,
  workflowKeys,
  kiroDocKeys,
  notificationKeys,
  presetKeys,
  roadmapItemKeys,
  debugLogKeys,
} from "@/lib/query-keys";
import {
  apiFetch,
  apiFetchOptional,
  discoveredProjectSchema,
  projectPreferencesResponseSchema,
  configResponseSchema,
  sessionsResponseSchema,
  sessionDiffSchema,
  commitsResponseSchema,
  activeConversationsResponseSchema,
  transcriptMessageSchema,
  contentResponseSchema,
  kiroDocTreeSchema,
  presetsResponseSchema,
  workflowResponseSchema,
  workflowIterationsResponseSchema,
  roadmapItemsResponseSchema,
  debugLogStatsResponseSchema,
} from "@/lib/api-client";
import { sessionStateSchema, conversationStateSchema } from "@/lib/schemas";
import {
  commandsResponseSchema,
  projectFilesResponseSchema,
  notificationsResponseSchema,
} from "@/lib/schemas";

// ---------------------------------------------------------------------------
// Project Queries
// ---------------------------------------------------------------------------

export function useProjectsQuery() {
  return useQuery({
    queryKey: projectKeys.list(),
    queryFn: () => apiFetch("/api/projects", z.array(discoveredProjectSchema)),
  });
}

export function useProjectPreferencesQuery() {
  return useQuery({
    queryKey: projectKeys.preferences(),
    queryFn: () =>
      apiFetch("/api/projects/preferences", projectPreferencesResponseSchema),
  });
}

// ---------------------------------------------------------------------------
// Config Queries
// ---------------------------------------------------------------------------

export function useConfigQuery() {
  return useQuery({
    queryKey: configKeys.all,
    queryFn: () => apiFetch("/api/config", configResponseSchema),
  });
}

// ---------------------------------------------------------------------------
// Session Queries
// ---------------------------------------------------------------------------

export function useSessionsQuery(projectName: string) {
  return useQuery({
    queryKey: sessionKeys.list(projectName),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions`,
        sessionsResponseSchema,
      );
      return data.sessions;
    },
    refetchInterval: 10_000,
  });
}

export function useSessionQuery(projectName: string, sessionName: string) {
  return useQuery({
    queryKey: sessionKeys.detail(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}`,
        sessionStateSchema,
      ),
    refetchInterval: 10_000,
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
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/diff`,
        sessionDiffSchema,
      ),
    refetchInterval: options?.refetchInterval,
  });
}

export function useCommitsQuery(projectName: string, sessionName: string) {
  return useQuery({
    queryKey: sessionKeys.commits(projectName, sessionName),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commits`,
        commitsResponseSchema,
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
      const data = await apiFetchOptional(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/focus-doc`,
        contentResponseSchema,
      );
      return data?.content ?? null;
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
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commits/${encodeURIComponent(hash!)}/diff`,
        sessionDiffSchema,
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
  status: "new" | "running" | "awaiting" | "waiting_for_input";
  lastActivityAt: string;
  projectName: string;
  projectPath: string;
  sessionName: string;
}

export function useActiveConversationsQuery() {
  return useQuery({
    queryKey: conversationKeys.active,
    queryFn: async () => {
      const data = await apiFetch(
        "/api/conversations/active",
        activeConversationsResponseSchema,
      );
      return data.conversations;
    },
    refetchInterval: 10_000,
  });
}

export function useConversationsQuery(
  projectName: string,
  sessionName: string,
) {
  return useQuery({
    queryKey: conversationKeys.list(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations`,
        z.array(conversationStateSchema),
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
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/messages`,
        z.array(transcriptMessageSchema),
      ),
    refetchInterval: options?.refetchInterval,
  });
}

// ---------------------------------------------------------------------------
// Command Queries
// ---------------------------------------------------------------------------

export function useCommandsQuery(
  projectName: string,
  sessionName: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: commandKeys.list(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commands`,
        commandsResponseSchema,
      ),
    enabled: options?.enabled,
  });
}

export function useProjectCommandsQuery(
  projectName: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: commandKeys.projectList(projectName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/commands`,
        commandsResponseSchema,
      ),
    enabled: options?.enabled,
  });
}

// ---------------------------------------------------------------------------
// File Queries
// ---------------------------------------------------------------------------

export function useProjectFilesQuery(
  projectName: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: fileKeys.list(projectName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/files`,
        projectFilesResponseSchema,
      ),
    enabled: options?.enabled,
  });
}

// ---------------------------------------------------------------------------
// Workflow Queries
// ---------------------------------------------------------------------------

export function useWorkflowQuery(projectName: string, sessionName: string) {
  return useQuery({
    queryKey: workflowKeys.status(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/workflow`,
        workflowResponseSchema,
      ).then((r) => r.workflow),
    refetchInterval: 5_000,
  });
}

export function useWorkflowIterationsQuery(
  projectName: string,
  sessionName: string,
) {
  return useQuery({
    queryKey: workflowKeys.iterations(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/workflow/iterations`,
        workflowIterationsResponseSchema,
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
      return apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/kiro-docs${params}`,
        kiroDocTreeSchema,
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
      const data = await apiFetchOptional(
        `/api/projects/${encodeURIComponent(projectName)}/kiro-docs?${params.toString()}`,
        contentResponseSchema,
      );
      return data?.content ?? null;
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
    queryFn: () => apiFetch("/api/notifications", notificationsResponseSchema),
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
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/dev-servers/presets`,
        presetsResponseSchema,
      ).then((r) => r.presets),
  });
}

// ---------------------------------------------------------------------------
// Roadmap Item Queries
// ---------------------------------------------------------------------------

export function useRoadmapItemsQuery(projectName: string) {
  return useQuery({
    queryKey: roadmapItemKeys.list(projectName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/roadmap-items`,
        roadmapItemsResponseSchema,
      ).then((r) => r.items),
    refetchInterval: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Debug Log Queries
// ---------------------------------------------------------------------------

export function useDebugLogEntryCountQuery(
  projectName: string,
  sessionName: string,
  conversationId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: debugLogKeys.stats(projectName, sessionName, conversationId),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/debug-mode/logs`,
        debugLogStatsResponseSchema,
      ).then((r) => r.entryCount),
    enabled,
  });
}
