import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { applyDeliveredCapabilityView } from "./runtime-seed";
import os from "node:os";

import { getRuntime } from "@/lib/agent-backends/runtime-registry";
import {
  getProjectDisplayName,
  resolveProjectPath,
} from "@/lib/projects/resolver";
import { getStateStore } from "@/lib/state-store";
import {
  decodeCascadeKind,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityCascadeLayer,
  type AgentCapabilityInventory,
  type AgentCapabilityOverrides,
  type AgentCapabilityRuntimeApplicationState,
  type AgentCapabilityScopeContext,
  type AgentCapabilityViewResponse,
} from "./schemas";

import {
  createAgentCapabilityDiscoveryCache,
  runDiscoveryThroughCache,
} from "./discovery-cache";
import { createDefaultCapabilityMutationService } from "./default-deps";
import { defaultGlobalCapabilityOverrideStore } from "./global-store";
import { defaultAgentCapabilityMetadataRegistry } from "./metadata";
import type { MutationScope } from "./mutation-service";
import {
  resolveCascadeView,
  resolvePluginEnablement,
  type PluginCascadeKind,
  type PluginEnablementMap,
} from "./resolver";
import {
  type CapabilityRouteDeps,
  type CapabilityRouteScope,
  CapabilityRouteDiscoveryError,
  CapabilityRouteNotFoundError,
} from "./route-handlers";
import { redactAgentCapabilityText } from "./redaction";
import { getErrorMessage } from "@/lib/shared/errors";

const stateManager = getStateStore();
const discoveryCache =
  createAgentCapabilityDiscoveryCache<AgentCapabilityInventory>();

async function resolveAgentCapabilityRouteView(input: {
  scope: CapabilityRouteScope;
  cascadeKind: AgentCapabilityCascadeKind;
  refresh?: boolean;
}): Promise<AgentCapabilityViewResponse> {
  const context = await buildResolutionContext(input.scope);
  const inventory = await discoverInventory({
    cascadeKind: input.cascadeKind,
    scope: context.scopeContext,
    worktreePath: context.worktreePath,
    refresh: input.refresh,
  });
  const metadata = defaultAgentCapabilityMetadataRegistry.get(
    input.cascadeKind,
  );
  const pluginResolution = await resolvePluginOverlay({
    cascadeKind: input.cascadeKind,
    scope: context.scopeContext,
    worktreePath: context.worktreePath,
    overrideChain: context.overrideChain,
    refresh: input.refresh,
  });

  const view = resolveCascadeView({
    cascadeKind: input.cascadeKind,
    scope: context.scopeContext,
    overrideChain: context.overrideChain,
    discoveredItems: inventory.items,
    discoveryDiagnostics: inventory.diagnostics,
    metadata,
    runtimeApplyState: context.runtimeApplyState,
    ...(pluginResolution ? { pluginResolution } : {}),
  });
  if (input.scope.level !== "conversation") return view;
  const catalog = getBackendDescriptor(view.backend).capabilityCatalog;
  const snapshot = await catalog?.delivered?.(input.scope.conversationId);
  const delivered =
    getRuntime(input.scope.conversationId)?.capabilitiesAtCreation ??
    snapshot?.capabilities;
  if (!catalog?.delivered) return view;
  return {
    ...applyDeliveredCapabilityView(view, delivered),
    ...(snapshot?.commands &&
    decodeCascadeKind(input.cascadeKind).kind === "skills"
      ? { appliedCommands: snapshot.commands }
      : {}),
  };
}

async function refreshAgentCapabilityRouteDiscovery(input: {
  scope: CapabilityRouteScope;
  cascadeKind: AgentCapabilityCascadeKind;
}): Promise<{
  inventory: AgentCapabilityInventory;
  view: AgentCapabilityViewResponse;
}> {
  const context = await buildResolutionContext(input.scope);
  const inventory = await discoverInventory({
    cascadeKind: input.cascadeKind,
    scope: context.scopeContext,
    worktreePath: context.worktreePath,
    refresh: true,
  });
  const view = await resolveAgentCapabilityRouteView({
    ...input,
    refresh: true,
  });
  return { inventory, view };
}

const mutationService = createDefaultCapabilityMutationService({
  async computeEffectiveHash(scope, cascadeKind) {
    const view = await resolveAgentCapabilityRouteView({
      scope: mutationScopeToRouteScope(scope),
      cascadeKind,
    });
    return view.effectiveHash;
  },
  async computeView(scope, cascadeKind) {
    return resolveAgentCapabilityRouteView({
      scope: mutationScopeToRouteScope(scope),
      cascadeKind,
    });
  },
});

export const defaultCapabilityRouteDeps: CapabilityRouteDeps = {
  resolveView(input) {
    return resolveAgentCapabilityRouteView(input);
  },
  mutate(input) {
    return mutationService.mutate(input);
  },
  refreshDiscovery(input) {
    return refreshAgentCapabilityRouteDiscovery(input);
  },
  resolveProjectPath,
};

interface ResolutionContext {
  scopeContext: AgentCapabilityScopeContext;
  worktreePath: string;
  overrideChain: ReadonlyArray<{
    layer: AgentCapabilityCascadeLayer;
    overrides: AgentCapabilityOverrides | undefined;
  }>;
  runtimeApplyState?: AgentCapabilityRuntimeApplicationState;
}

async function buildResolutionContext(
  scope: CapabilityRouteScope,
): Promise<ResolutionContext> {
  const globalOverrides = await defaultGlobalCapabilityOverrideStore.read();
  const chain: Array<{
    layer: AgentCapabilityCascadeLayer;
    overrides: AgentCapabilityOverrides | undefined;
  }> = [{ layer: "global", overrides: globalOverrides }];

  if (scope.level === "global") {
    return {
      scopeContext: { level: "global" },
      worktreePath: "/",
      overrideChain: chain,
    };
  }

  const projectOverrides =
    await stateManager.getProjectAgentCapabilityOverrides(scope.projectPath);

  if (scope.level === "conversation" && scope.conversationScope === "project") {
    const conversation = await stateManager.getProjectConversation(
      scope.projectPath,
      scope.conversationId,
    );
    if (!conversation) {
      throw new CapabilityRouteNotFoundError(
        `Project conversation "${scope.conversationId}" not found`,
      );
    }
    chain.push({ layer: "project", overrides: projectOverrides });
    chain.push({
      layer: "conversation",
      overrides: conversation.agentCapabilityOverrides,
    });
    return {
      scopeContext: {
        level: "conversation",
        projectName: scope.projectName,
        conversationScope: "project",
        conversationId: scope.conversationId,
      },
      worktreePath: scope.projectPath,
      overrideChain: chain,
      runtimeApplyState: conversation.agentCapabilitiesRuntime,
    };
  }

  if (scope.level === "project") {
    const projectExists = (await stateManager.listProjectPaths()).includes(
      scope.projectPath,
    );
    if (!projectExists) {
      throw new CapabilityRouteNotFoundError(
        `Project "${scope.projectName}" not found`,
      );
    }
    chain.push({ layer: "project", overrides: projectOverrides });
    return {
      scopeContext: { level: "project", projectName: scope.projectName },
      worktreePath: scope.projectPath,
      overrideChain: chain,
    };
  }

  const session = await stateManager.getSession(
    scope.projectPath,
    scope.sessionName,
  );
  if (!session) {
    throw new CapabilityRouteNotFoundError(
      `Session "${scope.sessionName}" not found`,
    );
  }
  chain.push({ layer: "project", overrides: projectOverrides });
  chain.push({ layer: "session", overrides: session.agentCapabilityOverrides });

  if (scope.level === "session") {
    return {
      scopeContext: {
        level: "session",
        projectName: scope.projectName,
        sessionName: scope.sessionName,
      },
      worktreePath: session.worktreePath,
      overrideChain: chain,
    };
  }

  const conversation = session.conversations.find(
    (entry) => entry.id === scope.conversationId,
  );
  if (!conversation) {
    throw new CapabilityRouteNotFoundError(
      `Conversation "${scope.conversationId}" not found`,
    );
  }
  chain.push({
    layer: "conversation",
    overrides: conversation.agentCapabilityOverrides,
  });

  return {
    scopeContext: {
      level: "conversation",
      projectName: scope.projectName,
      conversationScope: "session",
      sessionName: scope.sessionName,
      conversationId: scope.conversationId,
    },
    worktreePath: session.worktreePath,
    overrideChain: chain,
    runtimeApplyState: conversation.agentCapabilitiesRuntime,
  };
}

async function discoverInventory(input: {
  cascadeKind: AgentCapabilityCascadeKind;
  scope: AgentCapabilityScopeContext;
  worktreePath: string;
  refresh?: boolean;
}): Promise<AgentCapabilityInventory> {
  try {
    return await runDiscoveryThroughCache({
      cache: discoveryCache,
      cascadeKind: input.cascadeKind,
      scope: input.scope,
      force: input.refresh === true,
      fetcher: () =>
        fetchInventory(input.cascadeKind, input.worktreePath, input.scope),
    });
  } catch (err) {
    throw new CapabilityRouteDiscoveryError(
      `Failed to discover ${input.cascadeKind}: ${redactAgentCapabilityText(
        getErrorMessage(err),
      )}`,
    );
  }
}

async function fetchInventory(
  cascadeKind: AgentCapabilityCascadeKind,
  worktreePath: string,
  scope: AgentCapabilityScopeContext,
): Promise<AgentCapabilityInventory> {
  const { backend, kind } = decodeCascadeKind(cascadeKind);
  const catalog = getBackendDescriptor(backend).capabilityCatalog;
  if (!catalog) throw new Error(`Backend ${backend} has no capability catalog`);
  const inventory = await catalog.discover({
    kind,
    worktreePath,
    home: os.homedir(),
    conversationId: scope.conversationId,
  });
  return {
    cascadeKind,
    items: [...inventory.items],
    diagnostics: [...inventory.diagnostics],
    sourceSignature: inventory.sourceSignature,
    refreshedAt: inventory.refreshedAt ?? new Date().toISOString(),
  };
}

async function resolvePluginOverlay(input: {
  cascadeKind: AgentCapabilityCascadeKind;
  scope: AgentCapabilityScopeContext;
  worktreePath: string;
  overrideChain: ResolutionContext["overrideChain"];
  refresh?: boolean;
}): Promise<PluginEnablementMap | undefined> {
  const pluginCascadeKind = pluginCascadeForChild(input.cascadeKind);
  if (!pluginCascadeKind) return undefined;
  const pluginInventory = await discoverInventory({
    cascadeKind: pluginCascadeKind,
    scope: input.scope,
    worktreePath: input.worktreePath,
    refresh: input.refresh,
  });
  return resolvePluginEnablement({
    pluginCascadeKind,
    discoveredPlugins: pluginInventory.items,
    overrideChain: input.overrideChain,
  });
}

function pluginCascadeForChild(
  cascadeKind: AgentCapabilityCascadeKind,
): PluginCascadeKind | undefined {
  const { backend, kind } = decodeCascadeKind(cascadeKind);
  if (kind === "plugins") return undefined;
  const plugin = defaultAgentCapabilityMetadataRegistry
    .listForBackend(backend)
    .find((metadata) => metadata.capabilityKind === "plugin")?.cascadeKind;
  // The registry validates the kind/cascade pairing when entries are registered.
  return plugin as PluginCascadeKind | undefined;
}

function mutationScopeToRouteScope(scope: MutationScope): CapabilityRouteScope {
  switch (scope.level) {
    case "global":
      return { level: "global" };
    case "project":
      return {
        level: "project",
        projectPath: scope.projectPath,
        projectName: getProjectDisplayName(scope.projectPath),
      };
    case "session":
      return {
        level: "session",
        projectPath: scope.projectPath,
        projectName: getProjectDisplayName(scope.projectPath),
        sessionName: scope.sessionName,
      };
    case "conversation":
      if (scope.conversationScope === "project") {
        return {
          level: "conversation",
          projectPath: scope.projectPath,
          projectName: getProjectDisplayName(scope.projectPath),
          conversationScope: "project",
          conversationId: scope.conversationId,
        };
      }
      return {
        level: "conversation",
        projectPath: scope.projectPath,
        projectName: getProjectDisplayName(scope.projectPath),
        conversationScope: "session",
        sessionName: scope.sessionName,
        conversationId: scope.conversationId,
      };
  }
}
