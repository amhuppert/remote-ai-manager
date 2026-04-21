import { withTracing } from "@/lib/logging";
import { createToolInventoryHandlers } from "@/lib/mcp-config-route-handlers";
import {
  defaultDiscoverAllSources,
  defaultHomePath,
  defaultToolInventoryCache,
  recordKnownDefinition,
} from "@/lib/mcp/default-deps";
import { createMcpRouteBroadcast } from "@/lib/mcp/sse-broadcast";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";

export const dynamic = "force-dynamic";

const handlers = createToolInventoryHandlers({
  cache: defaultToolInventoryCache,
  discoverAllSources: defaultDiscoverAllSources,
  homePath: defaultHomePath,
  resolveProjectPath,
  getSession,
  onDefinitionLoaded: recordKnownDefinition,
  broadcast: createMcpRouteBroadcast(),
});

/** GET .../mcp-config/tools/[serverKey] — read tool inventory cache (no probe) */
export const GET = withTracing(handlers.GET);

/** POST .../mcp-config/tools/[serverKey] — force re-discover tools */
export const POST = withTracing(handlers.POST);
