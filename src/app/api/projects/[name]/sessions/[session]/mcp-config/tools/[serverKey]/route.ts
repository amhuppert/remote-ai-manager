import { withTracing } from "@/lib/logging";
import { createSessionToolInventoryHandlers } from "@/lib/mcp-config-route-handlers";
import {
  defaultDiscoverAllSources,
  defaultGlobalMcpDefinitionPath,
  defaultToolInventoryCache,
  recordKnownDefinition,
} from "@/lib/mcp/default-deps";
import { createMcpRouteBroadcast } from "@/lib/mcp/sse-broadcast";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";

export const dynamic = "force-dynamic";

const handlers = createSessionToolInventoryHandlers({
  cache: defaultToolInventoryCache,
  discoverAllSources: defaultDiscoverAllSources,
  globalConfigPath: defaultGlobalMcpDefinitionPath,
  resolveProjectPath,
  getSession,
  onDefinitionLoaded: recordKnownDefinition,
  broadcast: createMcpRouteBroadcast(),
});

/** GET /api/projects/[name]/sessions/[session]/mcp-config/tools/[serverKey] */
export const GET = withTracing(handlers.GET);

/** POST /api/projects/[name]/sessions/[session]/mcp-config/tools/[serverKey] */
export const POST = withTracing(handlers.POST);
