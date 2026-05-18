import os from "node:os";

import { getRuntime } from "@/lib/agent-backends/runtime-registry";
import {
  getProjectDisplayName,
  resolveProjectPath,
} from "@/lib/project-resolver";
import { createStateManager } from "@/lib/state";
import {
  type AgentCapabilityCascadeKind,
  type AgentCapabilityCascadeLayer,
  type AgentCapabilityInventory,
  type AgentCapabilityOverrides,
  type AgentCapabilityRuntimeApplicationState,
  type AgentCapabilityScopeContext,
  type AgentCapabilityViewResponse,
} from "@/lib/schemas";

import {
  discoverClaudeAgents,
  discoverClaudePlugins,
  discoverClaudeSkills,
  type ClaudeRuntimeProbe,
} from "./claude-discovery";
import {
  discoverCodexPluginsCanonical,
  discoverCodexSkillsCanonical,
} from "./codex-discovery";
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

const stateManager = createStateManager();
const discoveryCache =
  createAgentCapabilityDiscoveryCache<AgentCapabilityInventory>();

export async function resolveAgentCapabilityRouteView(input: {
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

  return resolveCascadeView({
    cascadeKind: input.cascadeKind,
    scope: context.scopeContext,
    overrideChain: context.overrideChain,
    discoveredItems: inventory.items,
    discoveryDiagnostics: inventory.diagnostics,
    metadata,
    runtimeApplyState: context.runtimeApplyState,
    ...(pluginResolution ? { pluginResolution } : {}),
  });
}

export async function refreshAgentCapabilityRouteDiscovery(input: {
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
  const [globalOverrides, state] = await Promise.all([
    defaultGlobalCapabilityOverrideStore.read(),
    stateManager.readState(),
  ]);
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

  const project = state.projects[scope.projectPath];
  if (!project) {
    throw new CapabilityRouteNotFoundError(
      `Project "${scope.projectName}" not found`,
    );
  }
  chain.push({ layer: "project", overrides: project.agentCapabilityOverrides });

  if (scope.level === "project") {
    return {
      scopeContext: { level: "project", projectName: scope.projectName },
      worktreePath: scope.projectPath,
      overrideChain: chain,
    };
  }

  const session = project.sessions[scope.sessionName];
  if (!session) {
    throw new CapabilityRouteNotFoundError(
      `Session "${scope.sessionName}" not found`,
    );
  }
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
        err instanceof Error ? err.message : String(err),
      )}`,
    );
  }
}

async function fetchInventory(
  cascadeKind: AgentCapabilityCascadeKind,
  worktreePath: string,
  scope: AgentCapabilityScopeContext,
): Promise<AgentCapabilityInventory> {
  const home = os.homedir();
  switch (cascadeKind) {
    case "claude-skills": {
      const result = await discoverClaudeSkills({
        worktreePath,
        home,
        runtimeProbe: runtimeProbeForScope(scope),
      });
      return {
        cascadeKind,
        items: [...result.items],
        diagnostics: [...result.diagnostics],
        sourceSignature: result.sourceSignature,
        refreshedAt: new Date().toISOString(),
      };
    }
    case "claude-plugins": {
      const result = await discoverClaudePlugins({ worktreePath, home });
      return {
        cascadeKind,
        items: [...result.items],
        diagnostics: [...result.diagnostics],
        sourceSignature: result.sourceSignature,
        refreshedAt: new Date().toISOString(),
      };
    }
    case "claude-agents": {
      const result = await discoverClaudeAgents({
        worktreePath,
        home,
        runtimeProbe: runtimeProbeForScope(scope),
      });
      return {
        cascadeKind,
        items: [...result.items],
        diagnostics: [...result.diagnostics],
        sourceSignature: result.sourceSignature,
        refreshedAt: new Date().toISOString(),
      };
    }
    case "codex-skills":
      return mutableInventory(
        await discoverCodexSkillsCanonical({ worktreePath, home }),
      );
    case "codex-plugins":
      return mutableInventory(
        await discoverCodexPluginsCanonical({ worktreePath, home }),
      );
  }
}

function mutableInventory(
  inventory: Omit<AgentCapabilityInventory, "items" | "diagnostics"> & {
    items: readonly AgentCapabilityInventory["items"][number][];
    diagnostics: readonly AgentCapabilityInventory["diagnostics"][number][];
  },
): AgentCapabilityInventory {
  return {
    ...inventory,
    items: [...inventory.items],
    diagnostics: [...inventory.diagnostics],
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
  if (cascadeKind === "claude-skills" || cascadeKind === "claude-agents") {
    return "claude-plugins";
  }
  if (cascadeKind === "codex-skills") return "codex-plugins";
  return undefined;
}

function runtimeProbeForScope(
  scope: AgentCapabilityScopeContext,
): ClaudeRuntimeProbe | undefined {
  if (scope.level !== "conversation" || !scope.conversationId) {
    return undefined;
  }
  const runtime = getRuntime(scope.conversationId);
  if (!runtime || runtime.backend !== "claude" || runtime.status !== "alive") {
    return undefined;
  }
  return {
    ...(runtime.supportedCommands
      ? { supportedCommands: runtime.supportedCommands.bind(runtime) }
      : {}),
    ...(runtime.supportedAgents
      ? { supportedAgents: runtime.supportedAgents.bind(runtime) }
      : {}),
  };
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
      return {
        level: "conversation",
        projectPath: scope.projectPath,
        projectName: getProjectDisplayName(scope.projectPath),
        sessionName: scope.sessionName,
        conversationId: scope.conversationId,
      };
  }
}
