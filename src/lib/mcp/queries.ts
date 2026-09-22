import {
  type ConversationTarget,
  conversationTargetApiBase,
} from "@/lib/conversations/conversation-target";
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
  target: ConversationTarget | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: target
      ? mcpConfigKeys.conversation(target)
      : [...mcpConfigKeys.conversations(), "unselected"],
    queryFn: () => {
      if (!target) throw new Error("Conversation target required");
      return fetchMcpView(`${conversationTargetApiBase(target)}/mcp-config`);
    },
    enabled: target !== undefined && (options?.enabled ?? true),
  });
}

export function useMcpToolsQuery(
  target: ConversationTarget,
  serverKey: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: mcpToolsKeys.inventory(target, serverKey),
    queryFn: () =>
      apiFetch(
        `${conversationTargetApiBase(target)}/mcp-config/tools/${encodeURIComponent(serverKey)}`,
        mcpToolInventoryResultSchema,
      ),
    enabled: options?.enabled ?? true,
  });
}
