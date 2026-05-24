import type {
  PortableMcpConfig,
  PortableMcpServerConfig,
} from "@/lib/agent-backends/portable-mcp";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { buildGatewayAuthHeaders } from "./auth";
import { getCommandCenterOrigin } from "./origin";

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function buildServer(id: string, path: string): PortableMcpServerConfig {
  return {
    id,
    transport: "streamable-http",
    url: `${getCommandCenterOrigin()}${path}`,
    headers: buildGatewayAuthHeaders(),
  };
}

export function buildSessionToolsPortableMcp(
  projectName: string,
  sessionName: string,
  conversationId: string,
): PortableMcpConfig {
  return {
    servers: [
      buildServer(
        "cc-session-tools",
        `/api/projects/${encodePathSegment(projectName)}/sessions/${encodePathSegment(sessionName)}/conversations/${encodePathSegment(conversationId)}/mcp`,
      ),
    ],
  };
}

export function buildSessionToolsGatewayServers(
  backend: AgentBackendId,
  projectName: string,
  sessionName: string,
  conversationId: string,
): readonly PortableMcpServerConfig[] {
  if (backend === "claude") return [];
  return buildSessionToolsPortableMcp(projectName, sessionName, conversationId)
    .servers;
}

export function buildSessionToolsReservedIds(
  _backend: AgentBackendId,
): readonly string[] {
  return ["cc-session-tools"];
}

export function buildGraphWorkflowPortableMcp(
  projectName: string,
  sessionName: string,
  executionId: string,
  contextId: string,
): PortableMcpConfig {
  return {
    servers: [
      buildServer(
        "cc-graph-workflow",
        `/api/projects/${encodePathSegment(projectName)}/sessions/${encodePathSegment(sessionName)}/mcp/graph-workflow/${encodePathSegment(executionId)}/contexts/${encodePathSegment(contextId)}`,
      ),
    ],
  };
}

export function buildWorkflowDraftPortableMcp(
  projectName: string,
  draftId: string,
): PortableMcpConfig {
  return {
    servers: [
      buildServer(
        "cc-workflow-draft",
        `/api/projects/${encodePathSegment(projectName)}/workflows/generate/mcp/${encodePathSegment(draftId)}`,
      ),
    ],
  };
}

export function mergePortableMcpConfigs(
  ...configs: Array<PortableMcpConfig | undefined | null>
): PortableMcpConfig | undefined {
  const merged = new Map<string, PortableMcpServerConfig>();

  for (const config of configs) {
    if (!config) {
      continue;
    }

    for (const server of config.servers) {
      merged.set(server.id, server);
    }
  }

  if (merged.size === 0) {
    return undefined;
  }

  return {
    servers: Array.from(merged.values()),
  };
}
