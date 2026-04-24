import { withTracing } from "@/lib/logging";
import { createGlobalToolInventoryHandlers } from "@/lib/mcp-config-route-handlers";
import {
  defaultDiscoverAllSources,
  defaultGlobalMcpDefinitionPath,
  defaultToolInventoryCache,
  recordKnownDefinition,
} from "@/lib/mcp/default-deps";
import { createMcpRouteBroadcast } from "@/lib/mcp/sse-broadcast";

export const dynamic = "force-dynamic";

const handlers = createGlobalToolInventoryHandlers({
  cache: defaultToolInventoryCache,
  discoverAllSources: defaultDiscoverAllSources,
  globalConfigPath: defaultGlobalMcpDefinitionPath,
  onDefinitionLoaded: recordKnownDefinition,
  broadcast: createMcpRouteBroadcast(),
});

/** GET /api/config/mcp/tools/[serverKey] — read tool inventory cache */
export const GET = withTracing(handlers.GET);

/** POST /api/config/mcp/tools/[serverKey] — force re-discover tools */
export const POST = withTracing(handlers.POST);
