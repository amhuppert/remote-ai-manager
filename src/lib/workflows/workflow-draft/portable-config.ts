import type {
  PortableMcpConfig,
  PortableMcpServerConfig,
} from "@/lib/agent-backends/portable-mcp";
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
