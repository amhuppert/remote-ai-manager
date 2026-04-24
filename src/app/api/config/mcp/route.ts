import { withTracing } from "@/lib/logging";
import { createGlobalMcpConfigHandlers } from "@/lib/mcp-config-route-handlers";
import {
  defaultDiscoverAllSources,
  defaultMcpConfigMutationService,
  defaultGlobalMcpDefinitionPath,
  defaultListGlobalRuntimeTargets,
  defaultMcpRuntimeApplyService,
  defaultGlobalStore,
  defaultToolInventoryCache,
  recordKnownDefinition,
} from "@/lib/mcp/default-deps";
import { createMcpRouteBroadcast } from "@/lib/mcp/sse-broadcast";

export const dynamic = "force-dynamic";

const handlers = createGlobalMcpConfigHandlers({
  globalStore: defaultGlobalStore,
  mutationService: defaultMcpConfigMutationService,
  discoverAllSources: defaultDiscoverAllSources,
  globalConfigPath: defaultGlobalMcpDefinitionPath,
  listGlobalRuntimeTargets: defaultListGlobalRuntimeTargets,
  applyAfterOverrideChange:
    defaultMcpRuntimeApplyService.applyAfterOverrideChange,
  broadcast: createMcpRouteBroadcast(),
  toolInventoryCache: defaultToolInventoryCache,
  onDefinitionLoaded: recordKnownDefinition,
});

/** GET /api/config/mcp — resolved global MCP config view */
export const GET = withTracing(handlers.GET);

/** PATCH /api/config/mcp — apply global override operations */
export const PATCH = withTracing(handlers.PATCH);
