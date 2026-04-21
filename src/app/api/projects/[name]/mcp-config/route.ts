import { withTracing } from "@/lib/logging";
import { createProjectMcpConfigHandlers } from "@/lib/mcp-config-route-handlers";
import {
  defaultDiscoverAllSources,
  defaultGlobalStore,
  defaultHomePath,
  defaultReadProjectOverrides,
  defaultScopeStore,
  defaultToolInventoryCache,
  recordKnownDefinition,
} from "@/lib/mcp/default-deps";
import { createMcpRouteBroadcast } from "@/lib/mcp/sse-broadcast";
import { resolveProjectPath } from "@/lib/project-resolver";

export const dynamic = "force-dynamic";

const handlers = createProjectMcpConfigHandlers({
  globalStore: defaultGlobalStore,
  scopeStore: defaultScopeStore,
  discoverAllSources: defaultDiscoverAllSources,
  homePath: defaultHomePath,
  resolveProjectPath,
  readProjectOverrides: defaultReadProjectOverrides,
  broadcast: createMcpRouteBroadcast(),
  toolInventoryCache: defaultToolInventoryCache,
  onDefinitionLoaded: recordKnownDefinition,
});

/** GET /api/projects/[name]/mcp-config — resolved project MCP config view */
export const GET = withTracing(handlers.GET);

/** PATCH /api/projects/[name]/mcp-config — apply project override operations */
export const PATCH = withTracing(handlers.PATCH);
