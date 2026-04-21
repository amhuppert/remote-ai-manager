/**
 * Default production dependencies for MCP config route handlers.
 *
 * Route files compose handler factories with these defaults to keep
 * `route.ts` thin. Tests never touch this module — they inject their own deps
 * directly into each factory.
 */

import os from "node:os";

import { createStateManager } from "@/lib/state";
import { getRuntime } from "@/lib/agent-backends/runtime-registry";
import { createLogger } from "@/lib/logging";
import { buildSessionToolsPortableMcp } from "@/lib/mcp-gateway/portable-config";
import { getProjectDisplayName } from "@/lib/project-resolver";
import type { McpOverrides, McpToolInventoryResult } from "@/lib/schemas";

import { createComposePortableMcpForConversation } from "./compose-for-conversation";
import { discoverAllSources } from "./discovery";
import { defaultGlobalOverrideStore } from "./global-store";
import {
  createMcpRuntimeApplyService,
  type McpRuntimeApplyService,
} from "./runtime-apply";
import { defaultScopeOverrideStore } from "./scope-store";
import {
  createToolInventoryCache,
  type ToolInventoryCache,
  type ToolInventoryKey,
} from "./tool-discovery-cache";
import { createProductionMcpProbeClient } from "./tool-discovery-client";
import { createDirectToolProbe } from "./tool-discovery-probe";
import type { McpCanonicalServerConfig, McpServerDefinition } from "./types";

const log = createLogger("mcp.default-deps");

export const defaultDiscoverAllSources = discoverAllSources;
export const defaultHomePath = (): string => os.homedir();
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

function compositeKey(
  key: Pick<ToolInventoryKey, "backend" | "serverKey" | "configSignature">,
): string {
  return `${key.backend}::${key.serverKey}::${key.configSignature}`;
}

export function recordKnownDefinition(
  key: ToolInventoryKey,
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
            backend: key.backend,
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
          backend: key.backend,
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
  homePath: () => os.homedir(),
  buildGatewayServers(projectName, sessionName) {
    return buildSessionToolsPortableMcp(projectName, sessionName).servers;
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
