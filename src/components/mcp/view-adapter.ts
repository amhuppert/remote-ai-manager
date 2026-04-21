import type {
  AgentBackendId,
  McpConfigViewResponse,
  McpServerView as ApiServerView,
  McpToolView as ApiToolView,
  McpInheritanceStatus as ApiInheritanceStatus,
  McpToolListView as ApiToolListView,
} from "@/types";

import type {
  McpBackendId,
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
): McpInheritanceStatus {
  const from = parentSourceLevel(viewLevel);
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
        tools: tools.tools.map((t) => toToolView(t, viewLevel)),
      };
  }
}

function toToolView(tool: ApiToolView, viewLevel: McpViewLevel): McpToolView {
  return {
    name: tool.name,
    description: tool.description,
    enabled: tool.enabled,
    status: toStatus(tool.inheritanceStatus, viewLevel),
    pending: tool.pending,
  };
}

export interface AdaptOptions {
  /** Currently selected agent backend; drives per-server compatibility hint. */
  activeBackend?: AgentBackendId;
}

function deriveCompatibility(
  server: ApiServerView,
  activeBackend: AgentBackendId | undefined,
): McpServerView["backendCompatibility"] {
  if (!activeBackend) return undefined;
  const match = server.compatibility.backends.find(
    (b) => b.backend === activeBackend,
  );
  if (!match || match.supported) return undefined;
  return { compatible: false, reason: match.reason };
}

function deriveSource(server: ApiServerView): {
  scope: McpScope;
  sourceFile: string;
} {
  const first = server.sourceRefs[0];
  if (!first) {
    return { scope: "user", sourceFile: "" };
  }
  return { scope: first.scope, sourceFile: first.filePath };
}

function toBackendId(backend: ApiServerView["backend"]): McpBackendId {
  return backend;
}

/**
 * Map an API `McpConfigViewResponse` to the presentational `McpServerView[]`
 * used by all MCP UI surfaces. Reserved gateway rows are hidden per spec.
 */
export function adaptServerViewsForLevel(
  response: McpConfigViewResponse,
  viewLevel: McpViewLevel,
  options: AdaptOptions = {},
): McpServerView[] {
  const { activeBackend } = options;
  const rows: McpServerView[] = [];
  for (const server of response.servers) {
    if (server.reserved) continue;
    const { scope, sourceFile } = deriveSource(server);
    rows.push({
      id: server.serverKey,
      name: server.displayName,
      sourceFile,
      scope,
      backend: toBackendId(server.backend),
      enabled: server.enabled,
      status: toStatus(server.inheritanceStatus, viewLevel),
      pending: server.pending,
      backendCompatibility: deriveCompatibility(server, activeBackend),
      toolDiscovery: toToolDiscovery(server.tools, viewLevel),
    });
  }
  return rows;
}
