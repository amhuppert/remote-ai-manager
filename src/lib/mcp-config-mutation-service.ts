import { createHash } from "node:crypto";

import type { GlobalOverrideStore } from "@/lib/mcp/global-store";
import { applyOperations } from "@/lib/mcp/overrides-patch";
import { resolveView, type McpOverrideChain } from "@/lib/mcp/resolver";
import type { ToolInventoryCache } from "@/lib/mcp/tool-discovery-cache";
import type {
  McpSourceDiscoveryInput,
  McpSourceDiscoveryResult,
  McpServerDefinition,
} from "@/lib/mcp/types";
import type {
  McpConfigViewResponse,
  McpOverrideOperation,
  McpOverrides,
  McpServerView,
  McpToolInventoryResult,
} from "@/lib/schemas";
import { createStateManager } from "@/lib/state";
import { withWriteQueue } from "@/lib/state-store/write-queue";
import type {
  ConversationState,
  ManagerState,
  ProjectState,
  SessionState,
} from "@/types";

type StateManager = Pick<ReturnType<typeof createStateManager>, "mutateState">;

export type McpConfigMutationResult =
  | {
      ok: true;
      changedServerKeys: readonly string[];
      effectiveConfigHash: string;
    }
  | { ok: false; reason: "conflict" };

export interface McpConfigMutationService {
  patchGlobal(input: {
    operations: readonly McpOverrideOperation[];
    expectedEffectiveConfigHash?: string;
  }): Promise<McpConfigMutationResult>;
  patchProject(input: {
    projectName: string;
    projectPath: string;
    operations: readonly McpOverrideOperation[];
    expectedEffectiveConfigHash?: string;
  }): Promise<McpConfigMutationResult>;
  patchSession(input: {
    projectName: string;
    projectPath: string;
    sessionName: string;
    operations: readonly McpOverrideOperation[];
    expectedEffectiveConfigHash?: string;
  }): Promise<McpConfigMutationResult>;
  patchConversation(input: {
    projectName: string;
    projectPath: string;
    sessionName: string;
    conversationId: string;
    operations: readonly McpOverrideOperation[];
    expectedEffectiveConfigHash?: string;
  }): Promise<McpConfigMutationResult>;
}

export interface McpConfigMutationServiceDeps {
  stateManager: StateManager;
  globalStore: GlobalOverrideStore;
  discoverAllSources(
    input: McpSourceDiscoveryInput,
  ): Promise<McpSourceDiscoveryResult>;
  globalConfigPath(): string;
  /**
   * Tool inventory cache used while computing the conflict-check hash. The
   * read path (route GET) resolves views with cached inventories merged in,
   * so the write path must read from the same cache or the hashes will
   * always disagree and every PATCH will return 409.
   */
  toolInventoryCache?: ToolInventoryCache;
}

export function computeConfigEditHash(input: {
  view: McpConfigViewResponse;
  discovered: readonly McpServerDefinition[];
}): string {
  const signatures = new Map(
    input.discovered.map((definition) => [
      definition.serverKey,
      definition.configSignature,
    ]),
  );
  const canonical = {
    level: input.view.level,
    servers: [...input.view.servers]
      .sort((a, b) => a.serverKey.localeCompare(b.serverKey))
      .map((server) => canonicalServer(server, signatures)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function createMcpConfigMutationService(
  deps: McpConfigMutationServiceDeps,
): McpConfigMutationService {
  async function patchGlobal(input: {
    operations: readonly McpOverrideOperation[];
    expectedEffectiveConfigHash?: string;
  }): Promise<McpConfigMutationResult> {
    return withWriteQueue("mcp.patchGlobalChecked", async () => {
      const currentOverrides = await deps.globalStore.read();
      const current = await resolveGlobalView(currentOverrides);
      if (
        input.expectedEffectiveConfigHash !== undefined &&
        current.view.effectiveConfigHash !== input.expectedEffectiveConfigHash
      ) {
        return { ok: false, reason: "conflict" };
      }

      const result = patchAndPrune(currentOverrides, input.operations);
      await deps.globalStore.replace(result.overrides);

      const next = await resolveGlobalView(result.overrides);
      return {
        ok: true,
        changedServerKeys: result.changedServerKeys,
        effectiveConfigHash: next.view.effectiveConfigHash ?? "",
      };
    });
  }

  async function patchProject(input: {
    projectName: string;
    projectPath: string;
    operations: readonly McpOverrideOperation[];
    expectedEffectiveConfigHash?: string;
  }): Promise<McpConfigMutationResult> {
    return deps.stateManager.mutateState(
      `mcp.patchProjectChecked[${input.projectPath}]`,
      async (state) => {
        const project = state.projects[input.projectPath];
        if (!project) {
          throw new Error(`Project "${input.projectPath}" not found`);
        }

        const current = await resolveProjectView(
          state,
          input.projectName,
          input.projectPath,
        );
        if (
          input.expectedEffectiveConfigHash !== undefined &&
          current.view.effectiveConfigHash !== input.expectedEffectiveConfigHash
        ) {
          return { ok: false, reason: "conflict" } as const;
        }

        const result = patchAndPrune(project.mcpOverrides, input.operations);
        writeOrDelete(project, result.overrides);

        const next = await resolveProjectView(
          state,
          input.projectName,
          input.projectPath,
        );
        return {
          ok: true,
          changedServerKeys: result.changedServerKeys,
          effectiveConfigHash: next.view.effectiveConfigHash ?? "",
        } as const;
      },
    );
  }

  async function patchSession(input: {
    projectName: string;
    projectPath: string;
    sessionName: string;
    operations: readonly McpOverrideOperation[];
    expectedEffectiveConfigHash?: string;
  }): Promise<McpConfigMutationResult> {
    return deps.stateManager.mutateState(
      `mcp.patchSessionChecked[${input.projectPath}/${input.sessionName}]`,
      async (state) => {
        const project = state.projects[input.projectPath];
        const session = project?.sessions[input.sessionName];
        if (!project || !session) {
          throw new Error(
            `Session "${input.sessionName}" not found in "${input.projectPath}"`,
          );
        }

        const current = await resolveSessionView(
          state,
          input.projectName,
          input.projectPath,
          input.sessionName,
        );
        if (
          input.expectedEffectiveConfigHash !== undefined &&
          current.view.effectiveConfigHash !== input.expectedEffectiveConfigHash
        ) {
          return { ok: false, reason: "conflict" } as const;
        }

        const result = patchAndPrune(session.mcpOverrides, input.operations);
        writeOrDelete(session, result.overrides);

        const next = await resolveSessionView(
          state,
          input.projectName,
          input.projectPath,
          input.sessionName,
        );
        return {
          ok: true,
          changedServerKeys: result.changedServerKeys,
          effectiveConfigHash: next.view.effectiveConfigHash ?? "",
        } as const;
      },
    );
  }

  async function patchConversation(input: {
    projectName: string;
    projectPath: string;
    sessionName: string;
    conversationId: string;
    operations: readonly McpOverrideOperation[];
    expectedEffectiveConfigHash?: string;
  }): Promise<McpConfigMutationResult> {
    return deps.stateManager.mutateState(
      `mcp.patchConversationChecked[${input.projectPath}/${input.sessionName}/${input.conversationId}]`,
      async (state) => {
        const project = state.projects[input.projectPath];
        const session = project?.sessions[input.sessionName];
        const conversation = session?.conversations.find(
          (entry) => entry.id === input.conversationId,
        );
        if (!project || !session || !conversation) {
          throw new Error(
            `Conversation "${input.conversationId}" not found in "${input.projectPath}/${input.sessionName}"`,
          );
        }

        const current = await resolveConversationView(
          state,
          input.projectName,
          input.projectPath,
          input.sessionName,
          input.conversationId,
        );
        if (
          input.expectedEffectiveConfigHash !== undefined &&
          current.view.effectiveConfigHash !== input.expectedEffectiveConfigHash
        ) {
          return { ok: false, reason: "conflict" } as const;
        }

        const result = patchAndPrune(
          conversation.mcpOverrides,
          input.operations,
        );
        writeOrDelete(conversation, result.overrides);

        const next = await resolveConversationView(
          state,
          input.projectName,
          input.projectPath,
          input.sessionName,
          input.conversationId,
        );
        return {
          ok: true,
          changedServerKeys: result.changedServerKeys,
          effectiveConfigHash: next.view.effectiveConfigHash ?? "",
        } as const;
      },
    );
  }

  async function resolveGlobalView(
    globalOverrides: McpOverrides,
  ): Promise<ResolvedConfigView> {
    const discovery = await deps.discoverAllSources({
      globalConfigPath: deps.globalConfigPath(),
    });
    const discovered = globalScopeOnly(discovery.servers);
    const view = resolveView({
      level: "global",
      overrides: { global: globalOverrides },
      discovered,
      discoveryDiagnostics: discovery.diagnostics,
      toolInventories: peekToolInventories(deps.toolInventoryCache, discovered),
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    return withEffectiveHash(view, discovered);
  }

  async function resolveProjectView(
    state: ManagerState,
    projectName: string,
    projectPath: string,
  ): Promise<ResolvedConfigView> {
    const [globalOverrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.discoverAllSources({
        globalConfigPath: deps.globalConfigPath(),
        worktreePath: projectPath,
      }),
    ]);
    const projectOverrides = state.projects[projectPath]?.mcpOverrides;
    const chain: McpOverrideChain = {
      global: globalOverrides,
      ...(projectOverrides !== undefined ? { project: projectOverrides } : {}),
    };
    const view = resolveView({
      level: "project",
      overrides: chain,
      discovered: discovery.servers,
      discoveryDiagnostics: discovery.diagnostics,
      toolInventories: peekToolInventories(
        deps.toolInventoryCache,
        discovery.servers,
      ),
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
      projectName,
    });
    return withEffectiveHash(view, discovery.servers);
  }

  async function resolveSessionView(
    state: ManagerState,
    projectName: string,
    projectPath: string,
    sessionName: string,
  ): Promise<ResolvedConfigView> {
    const project = state.projects[projectPath];
    const session = project?.sessions[sessionName];
    if (!project || !session) {
      throw new Error(`Session "${sessionName}" not found in "${projectPath}"`);
    }
    const [globalOverrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.discoverAllSources({
        globalConfigPath: deps.globalConfigPath(),
        worktreePath: session.worktreePath,
      }),
    ]);
    const chain: McpOverrideChain = {
      global: globalOverrides,
      ...(project.mcpOverrides !== undefined
        ? { project: project.mcpOverrides }
        : {}),
      ...(session.mcpOverrides !== undefined
        ? { session: session.mcpOverrides }
        : {}),
    };
    const view = resolveView({
      level: "session",
      overrides: chain,
      discovered: discovery.servers,
      discoveryDiagnostics: discovery.diagnostics,
      toolInventories: peekToolInventories(
        deps.toolInventoryCache,
        discovery.servers,
      ),
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
      projectName,
      sessionName,
    });
    return withEffectiveHash(view, discovery.servers);
  }

  async function resolveConversationView(
    state: ManagerState,
    projectName: string,
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ResolvedConfigView> {
    const project = state.projects[projectPath];
    const session = project?.sessions[sessionName];
    const conversation = session?.conversations.find(
      (entry) => entry.id === conversationId,
    );
    if (!project || !session || !conversation) {
      throw new Error(
        `Conversation "${conversationId}" not found in "${projectPath}/${sessionName}"`,
      );
    }
    const [globalOverrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.discoverAllSources({
        globalConfigPath: deps.globalConfigPath(),
        worktreePath: session.worktreePath,
      }),
    ]);
    const chain: McpOverrideChain = {
      global: globalOverrides,
      ...(project.mcpOverrides !== undefined
        ? { project: project.mcpOverrides }
        : {}),
      ...(session.mcpOverrides !== undefined
        ? { session: session.mcpOverrides }
        : {}),
      ...(conversation.mcpOverrides !== undefined
        ? { conversation: conversation.mcpOverrides }
        : {}),
    };
    const view = resolveView({
      level: "conversation",
      overrides: chain,
      discovered: discovery.servers,
      discoveryDiagnostics: discovery.diagnostics,
      toolInventories: peekToolInventories(
        deps.toolInventoryCache,
        discovery.servers,
      ),
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
      projectName,
      sessionName,
      conversationId,
    });
    return withEffectiveHash(view, discovery.servers);
  }

  return { patchGlobal, patchProject, patchSession, patchConversation };
}

interface ResolvedConfigView {
  view: McpConfigViewResponse;
  discovered: readonly McpServerDefinition[];
}

function withEffectiveHash(
  view: McpConfigViewResponse,
  discovered: readonly McpServerDefinition[],
): ResolvedConfigView {
  return {
    view: {
      ...view,
      effectiveConfigHash: computeConfigEditHash({ view, discovered }),
    },
    discovered,
  };
}

function canonicalServer(
  server: McpServerView,
  signatures: ReadonlyMap<string, string>,
) {
  return {
    serverKey: server.serverKey,
    configSignature: signatures.get(server.serverKey) ?? "",
    enabled: server.enabled,
    inheritanceStatus: server.inheritanceStatus,
    sourceRefs: [...server.sourceRefs].sort((a, b) =>
      `${a.scope}:${a.filePath}`.localeCompare(`${b.scope}:${b.filePath}`),
    ),
    reserved: server.reserved,
    orphaned: server.orphaned,
    tools: [...server.tools.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        enabled: tool.enabled,
        inheritanceStatus: tool.inheritanceStatus,
      })),
  };
}

function globalScopeOnly(
  servers: readonly McpServerDefinition[],
): readonly McpServerDefinition[] {
  return servers.filter((server) =>
    server.sourceRefs.some((sourceRef) => sourceRef.scope === "global"),
  );
}

function patchAndPrune(
  current: McpOverrides | undefined,
  operations: readonly McpOverrideOperation[],
) {
  const base: McpOverrides = current ?? { servers: {} };
  return applyOperations(base, operations);
}

function peekToolInventories(
  cache: ToolInventoryCache | undefined,
  servers: readonly McpServerDefinition[],
): Readonly<Record<string, McpToolInventoryResult>> {
  if (!cache) return {};
  const inventories: Record<string, McpToolInventoryResult> = {};
  for (const def of servers) {
    inventories[def.serverKey] = cache.peek({
      serverKey: def.serverKey,
      configSignature: def.configSignature,
    });
  }
  return inventories;
}

function writeOrDelete<
  T extends ProjectState | SessionState | ConversationState,
>(target: T, value: McpOverrides): void {
  if (Object.keys(value.servers).length === 0) {
    delete target.mcpOverrides;
    return;
  }
  target.mcpOverrides = value;
}
