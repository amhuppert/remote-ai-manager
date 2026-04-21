import { withTracing } from "@/lib/logging";
import { createSessionMcpConfigHandlers } from "@/lib/mcp-config-route-handlers";
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
import { getSession } from "@/lib/state";

export const dynamic = "force-dynamic";

const handlers = createSessionMcpConfigHandlers({
  globalStore: defaultGlobalStore,
  scopeStore: defaultScopeStore,
  discoverAllSources: defaultDiscoverAllSources,
  homePath: defaultHomePath,
  resolveProjectPath,
  getSession,
  readProjectOverrides: defaultReadProjectOverrides,
  broadcast: createMcpRouteBroadcast(),
  toolInventoryCache: defaultToolInventoryCache,
  onDefinitionLoaded: recordKnownDefinition,
});

/** GET /api/projects/[name]/sessions/[session]/mcp-config */
export const GET = withTracing(handlers.GET);

/** PATCH /api/projects/[name]/sessions/[session]/mcp-config */
export const PATCH = withTracing(handlers.PATCH);
