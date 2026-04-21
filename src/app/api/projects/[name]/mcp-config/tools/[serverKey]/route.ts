import { withTracing } from "@/lib/logging";
import { createProjectToolInventoryHandlers } from "@/lib/mcp-config-route-handlers";
import {
  defaultDiscoverAllSources,
  defaultHomePath,
  defaultToolInventoryCache,
  recordKnownDefinition,
} from "@/lib/mcp/default-deps";
import { createMcpRouteBroadcast } from "@/lib/mcp/sse-broadcast";
import { resolveProjectPath } from "@/lib/project-resolver";

export const dynamic = "force-dynamic";

const handlers = createProjectToolInventoryHandlers({
  cache: defaultToolInventoryCache,
  discoverAllSources: defaultDiscoverAllSources,
  homePath: defaultHomePath,
  resolveProjectPath,
  onDefinitionLoaded: recordKnownDefinition,
  broadcast: createMcpRouteBroadcast(),
});

/** GET /api/projects/[name]/mcp-config/tools/[serverKey] */
export const GET = withTracing(handlers.GET);

/** POST /api/projects/[name]/mcp-config/tools/[serverKey] */
export const POST = withTracing(handlers.POST);
