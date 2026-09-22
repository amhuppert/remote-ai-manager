import type {
  McpConfigViewResponse,
  McpServerView as ApiServerView,
  McpToolView as ApiToolView,
  McpInheritanceStatus as ApiInheritanceStatus,
  McpToolListView as ApiToolListView,
} from "@/lib/mcp/schemas";
import type {
  McpInheritanceStatus,
  McpScope,
  McpServerView,
  McpSourceLevel,
  McpToolDiscoveryState,
  McpToolView,
  McpViewLevel,
} from "./types";

/**
 * Map an API inheritance status to the presentational discriminated union,
 * attributing an `inherited from / inheritsFrom` source based on the view level.
 */
function toStatus(
  apiStatus: ApiInheritanceStatus,
  viewLevel: McpViewLevel,
  projectConversation = false,
): McpInheritanceStatus {
  const from =
    projectConversation && viewLevel === "conversation"
      ? "project"
      : parentSourceLevel(viewLevel);
  switch (apiStatus) {
    case "explicit":
      return { kind: "explicit" };
    case "inherited":
      return from ? { kind: "inherited", from } : { kind: "explicit" };
    case "overridden":
      return from
        ? { kind: "overridden", inheritsFrom: from }
        : { kind: "overridden" };
    case "disabled":
      return from
        ? { kind: "disabled", inheritsFrom: from }
        : { kind: "disabled" };
  }
}

/** Immediate parent level in the cascade, or `undefined` at global. */
function parentSourceLevel(level: McpViewLevel): McpSourceLevel | undefined {
  switch (level) {
    case "conversation":
      return "session";
    case "session":
      return "project";
    case "project":
      return "global";
    case "global":
      return undefined;
  }
}

function toToolDiscovery(
  tools: ApiToolListView,
  viewLevel: McpViewLevel,
  projectConversation = false,
): McpToolDiscoveryState {
  switch (tools.state) {
    case "not-loaded":
      return { kind: "idle" };
    case "loading":
      return { kind: "loading" };
    case "error": {
      const err = tools.diagnostics.find((d) => d.severity === "error");
      return {
        kind: "error",
        message: err?.message ?? "Failed to discover tools",
      };
    }
    case "ready":
    case "stale":
      return {
        kind: "loaded",
        tools: tools.tools.map((t) =>
          toToolView(t, viewLevel, projectConversation),
        ),
      };
  }
}

function toToolView(
  tool: ApiToolView,
  viewLevel: McpViewLevel,
  projectConversation = false,
): McpToolView {
  return {
    name: tool.name,
    description: tool.description,
    enabled: tool.enabled,
    status: toStatus(tool.inheritanceStatus, viewLevel, projectConversation),
    pending: tool.pending,
  };
}

function deriveSource(server: ApiServerView): {
  scope: McpScope;
  sourceFile: string;
} {
  const first = server.sourceRefs[0];
  if (!first) {
    return { scope: "global", sourceFile: "" };
  }
  return { scope: first.scope, sourceFile: first.filePath };
}

/**
 * Map an API `McpConfigViewResponse` to the presentational `McpServerView[]`
 * used by all MCP UI surfaces. Reserved gateway rows are hidden per spec.
 */
export function adaptServerViewsForLevel(
  response: McpConfigViewResponse,
  viewLevel: McpViewLevel,
): McpServerView[] {
  const rows: McpServerView[] = [];
  const projectConversation = response.target?.scope === "project";
  for (const server of response.servers) {
    if (server.reserved) continue;
    const { scope, sourceFile } = deriveSource(server);
    rows.push({
      id: server.serverKey,
      name: server.displayName,
      sourceFile,
      scope,
      enabled: server.enabled,
      status: toStatus(
        server.inheritanceStatus,
        viewLevel,
        projectConversation,
      ),
      pending: server.pending,
      pendingLabel: server.pending
        ? response.runtime?.lastApplyDisposition ===
          "deferred_to_next_conversation"
          ? "Applies in a new conversation"
          : "Applies next turn"
        : undefined,
      compatibility: server.compatibility,
      toolDiscovery: toToolDiscovery(
        server.tools,
        viewLevel,
        projectConversation,
      ),
    });
  }
  return rows;
}
