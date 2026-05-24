import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { mcpConfigKeys, mcpToolsKeys } from "./query-keys";
import {
  mcpConfigViewResponseSchema,
  mcpToolInventoryResultSchema,
} from "./schemas";

const mcpConfigViewEnvelopeSchema = z.object({
  view: mcpConfigViewResponseSchema,
});

async function fetchMcpView(url: string) {
  const envelope = await apiFetch(url, mcpConfigViewEnvelopeSchema);
  return envelope.view;
}

export function useGlobalMcpConfigQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: mcpConfigKeys.global(),
    queryFn: () => fetchMcpView("/api/config/mcp"),
    enabled: options?.enabled ?? true,
  });
}

export function useProjectMcpConfigQuery(
  projectName: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: mcpConfigKeys.project(projectName),
    queryFn: () =>
      fetchMcpView(
        `/api/projects/${encodeURIComponent(projectName)}/mcp-config`,
      ),
    enabled: options?.enabled ?? true,
  });
}

export function useSessionMcpConfigQuery(
  projectName: string,
  sessionName: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: mcpConfigKeys.session(projectName, sessionName),
    queryFn: () =>
      fetchMcpView(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/mcp-config`,
      ),
    enabled: options?.enabled ?? true,
  });
}

export function useConversationMcpConfigQuery(
  projectName: string,
  sessionName: string,
  conversationId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: mcpConfigKeys.conversation(
      projectName,
      sessionName,
      conversationId,
    ),
    queryFn: () =>
      fetchMcpView(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/mcp-config`,
      ),
    enabled: options?.enabled ?? true,
  });
}

export function useMcpToolsQuery(
  projectName: string,
  sessionName: string,
  conversationId: string,
  serverKey: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: mcpToolsKeys.inventory(
      projectName,
      sessionName,
      conversationId,
      serverKey,
    ),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/mcp-config/tools/${encodeURIComponent(serverKey)}`,
        mcpToolInventoryResultSchema,
      ),
    enabled: options?.enabled ?? true,
  });
}
