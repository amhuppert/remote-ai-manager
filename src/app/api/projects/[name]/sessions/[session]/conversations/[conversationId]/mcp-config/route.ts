import { withTracing } from "@/lib/logging";
import { createConversationMcpConfigHandlers } from "@/lib/mcp-config-route-handlers";
import {
  defaultDiscoverAllSources,
  defaultMcpConfigMutationService,
  defaultGlobalMcpDefinitionPath,
  defaultGlobalStore,
  defaultMcpRuntimeApplyService,
  defaultReadProjectOverrides,
  defaultScopeStore,
  defaultToolInventoryCache,
  recordKnownDefinition,
} from "@/lib/mcp/default-deps";
import { createMcpRouteBroadcast } from "@/lib/mcp/sse-broadcast";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";

export const dynamic = "force-dynamic";

const handlers = createConversationMcpConfigHandlers({
  globalStore: defaultGlobalStore,
  scopeStore: defaultScopeStore,
  mutationService: defaultMcpConfigMutationService,
  discoverAllSources: defaultDiscoverAllSources,
  globalConfigPath: defaultGlobalMcpDefinitionPath,
  resolveProjectPath,
  getSession,
  readProjectOverrides: defaultReadProjectOverrides,
  applyAfterOverrideChange:
    defaultMcpRuntimeApplyService.applyAfterOverrideChange,
  broadcast: createMcpRouteBroadcast(),
  toolInventoryCache: defaultToolInventoryCache,
  onDefinitionLoaded: recordKnownDefinition,
});

/** GET /api/projects/[name]/sessions/[session]/conversations/[conversationId]/mcp-config */
export const GET = withTracing(handlers.GET);

/** PATCH .../mcp-config — apply conversation override operations + live/staged runtime apply */
export const PATCH = withTracing(handlers.PATCH);
