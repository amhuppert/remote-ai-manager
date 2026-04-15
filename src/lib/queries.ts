import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import {
  projectKeys,
  configKeys,
  sessionKeys,
  conversationKeys,
  commandKeys,
  fileKeys,
  workflowDefinitionKeys,
  kiroDocKeys,
  notificationKeys,
  presetKeys,
  roadmapItemKeys,
  debugLogKeys,
  referenceDocumentKeys,
} from "@/lib/query-keys";
import {
  apiFetch,
  apiFetchOptional,
  discoveredProjectSchema,
  projectPreferencesResponseSchema,
  configResponseSchema,
  fullConfigResponseSchema,
  sessionsResponseSchema,
  sessionDiffSchema,
  commitsResponseSchema,
  activeConversationsResponseSchema,
  transcriptMessageSchema,
  contentResponseSchema,
  kiroDocTreeSchema,
  presetsResponseSchema,
  workflowDefinitionsResponseSchema,
  workflowDefinitionMutationResponseSchema,
  roadmapItemsResponseSchema,
  debugLogStatsResponseSchema,
} from "@/lib/api-client";
import { sessionStateSchema, conversationStateSchema } from "@/lib/schemas";
import {
  commandsResponseSchema,
  projectFilesResponseSchema,
  notificationsResponseSchema,
} from "@/lib/schemas";
import type { AgentBackendId } from "@/types";

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

export function useFullConfigQuery() {
  return useQuery({
    queryKey: configKeys.full,
    queryFn: () => apiFetch("/api/config", fullConfigResponseSchema),
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

export function useWorkflowDefinitionsQuery(projectName: string) {
  return useQuery({
    queryKey: workflowDefinitionKeys.list(projectName),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/workflows`,
        workflowDefinitionsResponseSchema,
      );
      return data.items;
    },
  });
}

export function useWorkflowDefinitionQuery(
  projectName: string,
  workflowId: string | null,
) {
  return useQuery({
    queryKey: workflowDefinitionKeys.detail(projectName, workflowId ?? ""),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/workflows/${encodeURIComponent(workflowId!)}`,
        workflowDefinitionMutationResponseSchema,
      );
      return data.item;
    },
    enabled: workflowId != null,
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

export function useReferenceDocumentsQuery(
  projectName: string,
  sessionName: string,
) {
  return useQuery({
    queryKey: referenceDocumentKeys.list(projectName, sessionName),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/reference-documents`,
        z.array(
          z.object({
            id: z.string(),
            filePath: z.string(),
            description: z.string(),
            createdAt: z.string(),
          }),
        ),
      );
      return data;
    },
  });
}

export function useReferenceDocumentContentQuery(
  projectName: string,
  sessionName: string,
  documentId: string | null,
) {
  return useQuery({
    queryKey: referenceDocumentKeys.content(
      projectName,
      sessionName,
      documentId ?? "",
    ),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/reference-documents/${encodeURIComponent(documentId!)}/content`,
        contentResponseSchema,
      );
      return data.content;
    },
    enabled: documentId != null,
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
  agentBackend: "claude" | "codex";
}

export function useActiveConversationsQuery() {
  return useQuery({
    queryKey: conversationKeys.active,
    queryFn: async () => {
      return apiFetch(
        "/api/conversations/active",
        activeConversationsResponseSchema,
      );
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
  backend: AgentBackendId = "claude",
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: commandKeys.list(projectName, sessionName, backend),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commands?backend=${encodeURIComponent(backend)}`,
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
