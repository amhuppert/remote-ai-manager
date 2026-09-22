import { withTracing } from "@/lib/logging";
import {
  createConversationMcpConfigHandlers,
  createGlobalMcpConfigHandlers,
  createGlobalToolInventoryHandlers,
  createProjectMcpConfigHandlers,
  createProjectToolInventoryHandlers,
  createSessionMcpConfigHandlers,
  createSessionToolInventoryHandlers,
  createToolInventoryHandlers,
} from "@/lib/mcp/config-route-handlers";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession, getProjectConversation } from "@/lib/state-store";
import {
  defaultDiscoverAllSources,
  defaultGlobalMcpDefinitionPath,
  defaultGlobalStore,
  defaultListGlobalRuntimeTargets,
  defaultListProjectRuntimeTargets,
  defaultListSessionRuntimeTargets,
  defaultMcpConfigMutationService,
  defaultMcpRuntimeApplyService,
  defaultReadProjectOverrides,
  defaultScopeStore,
  defaultToolInventoryCache,
  recordKnownDefinition,
} from "./default-deps";
import { createMcpRouteBroadcast } from "./sse-broadcast";

const globalConfigHandlers = createGlobalMcpConfigHandlers({
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

const globalToolInventoryHandlers = createGlobalToolInventoryHandlers({
  cache: defaultToolInventoryCache,
  discoverAllSources: defaultDiscoverAllSources,
  globalConfigPath: defaultGlobalMcpDefinitionPath,
  onDefinitionLoaded: recordKnownDefinition,
  broadcast: createMcpRouteBroadcast(),
});

const projectConfigHandlers = createProjectMcpConfigHandlers({
  globalStore: defaultGlobalStore,
  scopeStore: defaultScopeStore,
  mutationService: defaultMcpConfigMutationService,
  discoverAllSources: defaultDiscoverAllSources,
  globalConfigPath: defaultGlobalMcpDefinitionPath,
  resolveProjectPath,
  readProjectOverrides: defaultReadProjectOverrides,
  listProjectRuntimeTargets: defaultListProjectRuntimeTargets,
  applyAfterOverrideChange:
    defaultMcpRuntimeApplyService.applyAfterOverrideChange,
  broadcast: createMcpRouteBroadcast(),
  toolInventoryCache: defaultToolInventoryCache,
  onDefinitionLoaded: recordKnownDefinition,
});

const projectToolInventoryHandlers = createProjectToolInventoryHandlers({
  cache: defaultToolInventoryCache,
  discoverAllSources: defaultDiscoverAllSources,
  globalConfigPath: defaultGlobalMcpDefinitionPath,
  resolveProjectPath,
  onDefinitionLoaded: recordKnownDefinition,
  broadcast: createMcpRouteBroadcast(),
});

const sessionConfigHandlers = createSessionMcpConfigHandlers({
  globalStore: defaultGlobalStore,
  scopeStore: defaultScopeStore,
  mutationService: defaultMcpConfigMutationService,
  discoverAllSources: defaultDiscoverAllSources,
  globalConfigPath: defaultGlobalMcpDefinitionPath,
  resolveProjectPath,
  getSession,
  readProjectOverrides: defaultReadProjectOverrides,
  listSessionRuntimeTargets: defaultListSessionRuntimeTargets,
  applyAfterOverrideChange:
    defaultMcpRuntimeApplyService.applyAfterOverrideChange,
  broadcast: createMcpRouteBroadcast(),
  toolInventoryCache: defaultToolInventoryCache,
  onDefinitionLoaded: recordKnownDefinition,
});

const sessionToolInventoryHandlers = createSessionToolInventoryHandlers({
  cache: defaultToolInventoryCache,
  discoverAllSources: defaultDiscoverAllSources,
  globalConfigPath: defaultGlobalMcpDefinitionPath,
  resolveProjectPath,
  getSession,
  onDefinitionLoaded: recordKnownDefinition,
  broadcast: createMcpRouteBroadcast(),
});

const conversationConfigHandlers = createConversationMcpConfigHandlers({
  globalStore: defaultGlobalStore,
  scopeStore: defaultScopeStore,
  mutationService: defaultMcpConfigMutationService,
  discoverAllSources: defaultDiscoverAllSources,
  globalConfigPath: defaultGlobalMcpDefinitionPath,
  resolveProjectPath,
  getSession,
  getProjectConversation,
  readProjectOverrides: defaultReadProjectOverrides,
  applyAfterOverrideChange:
    defaultMcpRuntimeApplyService.applyAfterOverrideChange,
  broadcast: createMcpRouteBroadcast(),
  toolInventoryCache: defaultToolInventoryCache,
  onDefinitionLoaded: recordKnownDefinition,
});

const conversationToolInventoryHandlers = createToolInventoryHandlers({
  cache: defaultToolInventoryCache,
  discoverAllSources: defaultDiscoverAllSources,
  globalConfigPath: defaultGlobalMcpDefinitionPath,
  resolveProjectPath,
  getSession,
  getProjectConversation,
  onDefinitionLoaded: recordKnownDefinition,
  broadcast: createMcpRouteBroadcast(),
});

export const globalConfigGET = withTracing(globalConfigHandlers.GET);
export const globalConfigPATCH = withTracing(globalConfigHandlers.PATCH);

export const globalToolsGET = withTracing(globalToolInventoryHandlers.GET);
export const globalToolsPOST = withTracing(globalToolInventoryHandlers.POST);

export const projectConfigGET = withTracing(projectConfigHandlers.GET);
export const projectConfigPATCH = withTracing(projectConfigHandlers.PATCH);

export const projectToolsGET = withTracing(projectToolInventoryHandlers.GET);
export const projectToolsPOST = withTracing(projectToolInventoryHandlers.POST);

export const sessionConfigGET = withTracing(sessionConfigHandlers.GET);
export const sessionConfigPATCH = withTracing(sessionConfigHandlers.PATCH);

export const sessionToolsGET = withTracing(sessionToolInventoryHandlers.GET);
export const sessionToolsPOST = withTracing(sessionToolInventoryHandlers.POST);

export const conversationConfigGET = withTracing(
  conversationConfigHandlers.GET,
);
export const conversationConfigPATCH = withTracing(
  conversationConfigHandlers.PATCH,
);

export const conversationToolsGET = withTracing(
  conversationToolInventoryHandlers.GET,
);
export const conversationToolsPOST = withTracing(
  conversationToolInventoryHandlers.POST,
);
