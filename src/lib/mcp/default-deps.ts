/**
 * Default production dependencies for MCP config route handlers.
 *
 * Route files compose handler factories with these defaults to keep
 * `route.ts` thin. Tests never touch this module — they inject their own deps
 * directly into each factory.
 */

import { createStateManager } from "@/lib/state";
import { getRuntime } from "@/lib/agent-backends/runtime-registry";
import { createLogger } from "@/lib/logging";
import { buildSessionToolsPortableMcp } from "@/lib/mcp-gateway/portable-config";
import { getProjectDisplayName } from "@/lib/project-resolver";
import type { McpOverrides, McpToolInventoryResult } from "@/lib/schemas";

import { createComposePortableMcpForConversation } from "./compose-for-conversation";
import { discoverAllSources } from "./discovery";
import {
  defaultGlobalOverrideStore,
  getDefaultGlobalMcpDefinitionPath,
} from "./global-store";
import {
  createMcpRuntimeApplyService,
  type McpRuntimeApplyService,
} from "./runtime-apply";
import {
  createMcpConfigMutationService,
  type McpConfigMutationService,
} from "@/lib/mcp-config-mutation-service";
import { defaultScopeOverrideStore } from "./scope-store";
import {
  createToolInventoryCache,
  type ToolInventoryCache,
} from "./tool-discovery-cache";
import { createProductionMcpProbeClient } from "./tool-discovery-client";
import { createDirectToolProbe } from "./tool-discovery-probe";
import type { McpCanonicalServerConfig, McpServerDefinition } from "./types";
import { collectRuntimeTargets, type RuntimeTarget } from "./runtime-targets";

const log = createLogger("mcp.default-deps");

export const defaultDiscoverAllSources = discoverAllSources;
export const defaultGlobalMcpDefinitionPath = getDefaultGlobalMcpDefinitionPath;
export const defaultGlobalStore = defaultGlobalOverrideStore;
export const defaultScopeStore = defaultScopeOverrideStore;

const defaultStateManager = createStateManager();

/**
 * Reads the current project-level MCP overrides from persisted state so
 * project / session / conversation route handlers can include them in the
 * resolver cascade. The `ScopeOverrideStore` only exposes patch methods, so
 * reads go through the state manager directly.
 */
export async function defaultReadProjectOverrides(
  projectPath: string,
): Promise<McpOverrides | undefined> {
  const state = await defaultStateManager.readState();
  return state.projects[projectPath]?.mcpOverrides;
}

/**
 * Module-scoped side-map linking probe keys to their last-seen canonical
 * config. Routes populate this before invoking the cache so the fetcher can
 * resolve the underlying server config without re-running discovery.
 */
const knownDefinitions = new Map<string, McpCanonicalServerConfig>();

function compositeKey(key: {
  serverKey: string;
  configSignature: string;
}): string {
  return `${key.serverKey}::${key.configSignature}`;
}

export function recordKnownDefinition(
  key: { serverKey: string; configSignature: string },
  definition: McpServerDefinition,
): void {
  knownDefinitions.set(compositeKey(key), definition.config);
}

const directProbe = createDirectToolProbe({
  createClient: createProductionMcpProbeClient,
});

/** Production tool inventory cache — module singleton. */
export const defaultToolInventoryCache: ToolInventoryCache =
  createToolInventoryCache({
    fetcher: {
      async fetch(key): Promise<McpToolInventoryResult> {
        const config = knownDefinitions.get(compositeKey(key));
        if (!config) {
          log.warn("fetch.no_known_definition", {
            serverKey: key.serverKey,
          });
          return {
            state: "error",
            tools: [],
            diagnostics: [
              {
                severity: "error",
                code: "mcp.probe.no_definition",
                message: `No known canonical config for ${key.serverKey}`,
                serverKey: key.serverKey,
              },
            ],
          };
        }
        return directProbe({
          serverKey: key.serverKey,
          server: config,
        });
      },
    },
  });

// ---------------------------------------------------------------------------
// Runtime apply service singleton — bridges the conversation PATCH handler to
// the backend runtime so override changes reach live sessions on the next turn
// (or immediately when Claude is idle).
// ---------------------------------------------------------------------------

const composePortableForConversation = createComposePortableMcpForConversation({
  async readGlobalOverrides() {
    return defaultGlobalOverrideStore.read();
  },
  async readProjectOverrides(projectPath) {
    const state = await defaultStateManager.readState();
    return state.projects[projectPath]?.mcpOverrides;
  },
  async readSessionOverrides(projectPath, sessionName) {
    const session = await defaultStateManager.getSession(
      projectPath,
      sessionName,
    );
    return session?.mcpOverrides;
  },
  async readConversationOverrides(projectPath, sessionName, conversationId) {
    const session = await defaultStateManager.getSession(
      projectPath,
      sessionName,
    );
    return session?.conversations.find((c) => c.id === conversationId)
      ?.mcpOverrides;
  },
  discoverSources: discoverAllSources,
  globalConfigPath: () => getDefaultGlobalMcpDefinitionPath(),
  buildGatewayServers(projectName, sessionName, conversationId) {
    return buildSessionToolsPortableMcp(
      projectName,
      sessionName,
      conversationId,
    ).servers;
  },
});

export const defaultMcpRuntimeApplyService: McpRuntimeApplyService =
  createMcpRuntimeApplyService({
    stateManager: defaultStateManager,
    getRuntime,
    async resolvePortableForConversation(input) {
      const session = await defaultStateManager.getSession(
        input.projectPath,
        input.sessionName,
      );
      const worktreePath = session?.worktreePath ?? input.projectPath;
      const projectName = getProjectDisplayName(input.projectPath);
      const portable = await composePortableForConversation({
        backend: input.backend,
        projectPath: input.projectPath,
        projectName,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        worktreePath,
      });
      return { portable };
    },
  });

export const defaultMcpConfigMutationService: McpConfigMutationService =
  createMcpConfigMutationService({
    stateManager: defaultStateManager,
    globalStore: defaultGlobalOverrideStore,
    discoverAllSources,
    globalConfigPath: () => getDefaultGlobalMcpDefinitionPath(),
    toolInventoryCache: defaultToolInventoryCache,
  });

export async function defaultListGlobalRuntimeTargets(): Promise<
  readonly RuntimeTarget[]
> {
  const state = await defaultStateManager.readState();
  return collectRuntimeTargets({
    projects: Object.entries(state.projects).map(([projectPath, project]) => ({
      projectPath,
      projectName: getProjectDisplayName(projectPath),
      sessions: Object.values(project.sessions),
    })),
    getRuntime(conversationId) {
      const runtime = getRuntime(conversationId);
      return runtime
        ? { status: runtime.status, backend: runtime.backend }
        : undefined;
    },
  });
}

export async function defaultListProjectRuntimeTargets(
  projectPath: string,
): Promise<readonly RuntimeTarget[]> {
  const sessions = await defaultStateManager.getProjectSessions(projectPath);
  return collectRuntimeTargets({
    projects: [
      {
        projectPath,
        projectName: getProjectDisplayName(projectPath),
        sessions,
      },
    ],
    getRuntime(conversationId) {
      const runtime = getRuntime(conversationId);
      return runtime
        ? { status: runtime.status, backend: runtime.backend }
        : undefined;
    },
  });
}

export async function defaultListSessionRuntimeTargets(
  projectPath: string,
  sessionName: string,
): Promise<readonly RuntimeTarget[]> {
  const session = await defaultStateManager.getSession(
    projectPath,
    sessionName,
  );
  if (!session) return [];
  return collectRuntimeTargets({
    projects: [
      {
        projectPath,
        projectName: getProjectDisplayName(projectPath),
        sessions: [session],
      },
    ],
    getRuntime(conversationId) {
      const runtime = getRuntime(conversationId);
      return runtime
        ? { status: runtime.status, backend: runtime.backend }
        : undefined;
    },
  });
}
