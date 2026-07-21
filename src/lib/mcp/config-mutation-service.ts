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
} from "@/lib/mcp/schemas";
import type { StateStore } from "@/lib/state-store";

/**
 * Signals an expected-hash conflict from inside the global override store's
 * precondition (which runs in its serialized write lock). Caught by
 * `patchGlobal` and mapped to `{ ok: false, reason: "conflict" }`; any other
 * error propagates.
 */
class GlobalConfigConflictError extends Error {}

/**
 * The focused store surface the checked-patch flows use: project/session/
 * conversation override reads plus the focused single-column override writes.
 * Configuration resolution (source discovery + global-file I/O) runs BEFORE the
 * write queue; only a short, synchronous commit runs inside it, through the
 * focused override mutators (never a whole-state mutate).
 */
type StateManager = Pick<
  StateStore,
  | "getSession"
  | "getProjectMcpOverrides"
  | "mutateProjectMcpOverrides"
  | "mutateSessionMcpOverrides"
  | "mutateConversationMcpOverrides"
>;

type McpConfigMutationResult =
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
    // --- Resolve OUTSIDE any lock: the only I/O is source discovery. patchGlobal
    // writes the global-overrides FILE (not the state store), so it never touches
    // the state-store write queue. The scoped-config file store owns its own
    // serialized write tail, so `globalStore.patch` makes the
    // read → precondition → apply → write sequence atomic there — the fence lives
    // inside that lock, exactly like the project/session/conversation scopes fence
    // inside their focused DB mutator (no-slow-work-in-critical-section). ---
    const discovery = await deps.discoverAllSources({
      globalConfigPath: deps.globalConfigPath(),
    });

    const result = await deps.globalStore
      .patch({
        operations: input.operations,
        // Runs inside the file store's write lock, on the FRESH on-disk
        // overrides, before the write — the atomic conflict fence.
        precondition: (current) => {
          if (input.expectedEffectiveConfigHash === undefined) return;
          const currentHash = assembleGlobalView(current, discovery).view
            .effectiveConfigHash;
          if (currentHash !== input.expectedEffectiveConfigHash) {
            throw new GlobalConfigConflictError();
          }
        },
      })
      .catch((err: unknown): null => {
        if (err instanceof GlobalConfigConflictError) return null;
        throw err;
      });

    if (result === null) {
      return { ok: false, reason: "conflict" };
    }

    const nextHash = assembleGlobalView(result.overrides, discovery).view
      .effectiveConfigHash;
    return {
      ok: true,
      changedServerKeys: result.changedServerKeys,
      effectiveConfigHash: nextHash ?? "",
    };
  }

  async function patchProject(input: {
    projectName: string;
    projectPath: string;
    operations: readonly McpOverrideOperation[];
    expectedEffectiveConfigHash?: string;
  }): Promise<McpConfigMutationResult> {
    // --- Resolve OUTSIDE the write queue: the only I/O is source discovery and
    // the global-overrides file read (no-slow-work-in-critical-section). ---
    const [globalOverrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.discoverAllSources({
        globalConfigPath: deps.globalConfigPath(),
        worktreePath: input.projectPath,
      }),
    ]);

    // --- Commit INSIDE a short, synchronous critical section. The mutator sees
    // the FRESH persisted overrides, so the current hash it derives (via the
    // pure resolver over pre-fetched discovery) reflects any concurrent write —
    // a mismatch against `expectedEffectiveConfigHash` is the conflict fence. ---
    return deps.stateManager.mutateProjectMcpOverrides<McpConfigMutationResult>(
      input.projectPath,
      "mcp.patchProjectChecked",
      (current) => {
        const currentHash = assembleProjectView(
          input.projectName,
          current,
          globalOverrides,
          discovery,
        ).view.effectiveConfigHash;
        if (
          input.expectedEffectiveConfigHash !== undefined &&
          currentHash !== input.expectedEffectiveConfigHash
        ) {
          return { write: false, result: { ok: false, reason: "conflict" } };
        }
        const result = patchAndPrune(current, input.operations);
        const nextOverrides = pruneEmptyOverrides(result.overrides);
        const nextHash = assembleProjectView(
          input.projectName,
          nextOverrides,
          globalOverrides,
          discovery,
        ).view.effectiveConfigHash;
        return {
          write: true,
          overrides: nextOverrides,
          result: {
            ok: true,
            changedServerKeys: result.changedServerKeys,
            effectiveConfigHash: nextHash ?? "",
          },
        };
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
    // --- Resolve OUTSIDE the queue. The session read supplies the worktree path
    // discovery needs and the ancestor (project) override; the session's own
    // overrides are read FRESH inside the commit as the conflict fence. ---
    const session = await deps.stateManager.getSession(
      input.projectPath,
      input.sessionName,
    );
    if (!session) {
      throw new Error(
        `Session "${input.sessionName}" not found in "${input.projectPath}"`,
      );
    }
    const [globalOverrides, projectOverrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.stateManager.getProjectMcpOverrides(input.projectPath),
      deps.discoverAllSources({
        globalConfigPath: deps.globalConfigPath(),
        worktreePath: session.worktreePath,
      }),
    ]);

    return deps.stateManager.mutateSessionMcpOverrides<McpConfigMutationResult>(
      input.projectPath,
      input.sessionName,
      "mcp.patchSessionChecked",
      (current) => {
        const currentHash = assembleSessionView(
          input.projectName,
          input.sessionName,
          { globalOverrides, projectOverrides, sessionOverrides: current },
          discovery,
        ).view.effectiveConfigHash;
        if (
          input.expectedEffectiveConfigHash !== undefined &&
          currentHash !== input.expectedEffectiveConfigHash
        ) {
          return { write: false, result: { ok: false, reason: "conflict" } };
        }
        const result = patchAndPrune(current, input.operations);
        const nextOverrides = pruneEmptyOverrides(result.overrides);
        const nextHash = assembleSessionView(
          input.projectName,
          input.sessionName,
          {
            globalOverrides,
            projectOverrides,
            sessionOverrides: nextOverrides,
          },
          discovery,
        ).view.effectiveConfigHash;
        return {
          write: true,
          overrides: nextOverrides,
          result: {
            ok: true,
            changedServerKeys: result.changedServerKeys,
            effectiveConfigHash: nextHash ?? "",
          },
        };
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
    // --- Resolve OUTSIDE the queue. Ancestor (project + session) overrides and
    // the worktree path come from the session read; the conversation's own
    // overrides are read FRESH inside the commit as the conflict fence. ---
    const session = await deps.stateManager.getSession(
      input.projectPath,
      input.sessionName,
    );
    const conversation = session?.conversations.find(
      (entry) => entry.id === input.conversationId,
    );
    if (!session || !conversation) {
      throw new Error(
        `Conversation "${input.conversationId}" not found in "${input.projectPath}/${input.sessionName}"`,
      );
    }
    const [globalOverrides, projectOverrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.stateManager.getProjectMcpOverrides(input.projectPath),
      deps.discoverAllSources({
        globalConfigPath: deps.globalConfigPath(),
        worktreePath: session.worktreePath,
      }),
    ]);
    const sessionOverrides = session.mcpOverrides;

    return deps.stateManager.mutateConversationMcpOverrides<McpConfigMutationResult>(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "mcp.patchConversationChecked",
      (current) => {
        const currentHash = assembleConversationView(
          input.projectName,
          input.sessionName,
          input.conversationId,
          {
            globalOverrides,
            projectOverrides,
            sessionOverrides,
            conversationOverrides: current,
          },
          discovery,
        ).view.effectiveConfigHash;
        if (
          input.expectedEffectiveConfigHash !== undefined &&
          currentHash !== input.expectedEffectiveConfigHash
        ) {
          return { write: false, result: { ok: false, reason: "conflict" } };
        }
        const result = patchAndPrune(current, input.operations);
        const nextOverrides = pruneEmptyOverrides(result.overrides);
        const nextHash = assembleConversationView(
          input.projectName,
          input.sessionName,
          input.conversationId,
          {
            globalOverrides,
            projectOverrides,
            sessionOverrides,
            conversationOverrides: nextOverrides,
          },
          discovery,
        ).view.effectiveConfigHash;
        return {
          write: true,
          overrides: nextOverrides,
          result: {
            ok: true,
            changedServerKeys: result.changedServerKeys,
            effectiveConfigHash: nextHash ?? "",
          },
        };
      },
    );
  }

  // Pure view assembly over an already-fetched discovery snapshot. No I/O — safe
  // to call inside the global store's serialized write lock (its precondition),
  // where it derives the effective-config hash from the FRESH on-disk overrides,
  // and outside the lock for the post-write next-hash. `globalScopeOnly` narrows
  // discovery to global-scope servers so the global hash matches the read path.
  function assembleGlobalView(
    globalOverrides: McpOverrides,
    discovery: McpSourceDiscoveryResult,
  ): ResolvedConfigView {
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

  // Pure view assembly over an already-fetched discovery snapshot and an
  // explicit override chain. No I/O — safe to run inside the write queue's
  // synchronous critical section (queue callbacks are repo writes plus pure
  // computation only), where it derives the effective-config hash from the FRESH
  // persisted target override plus the ancestor overrides read before the lock.
  // One discovery snapshot serves both the current-hash and next-hash calls, so
  // the two are strictly comparable.
  function assembleProjectView(
    projectName: string,
    projectOverrides: McpOverrides | undefined,
    globalOverrides: McpOverrides,
    discovery: McpSourceDiscoveryResult,
  ): ResolvedConfigView {
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

  function assembleSessionView(
    projectName: string,
    sessionName: string,
    overrides: {
      globalOverrides: McpOverrides;
      projectOverrides: McpOverrides | undefined;
      sessionOverrides: McpOverrides | undefined;
    },
    discovery: McpSourceDiscoveryResult,
  ): ResolvedConfigView {
    const chain: McpOverrideChain = {
      global: overrides.globalOverrides,
      ...(overrides.projectOverrides !== undefined
        ? { project: overrides.projectOverrides }
        : {}),
      ...(overrides.sessionOverrides !== undefined
        ? { session: overrides.sessionOverrides }
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

  function assembleConversationView(
    projectName: string,
    sessionName: string,
    conversationId: string,
    overrides: {
      globalOverrides: McpOverrides;
      projectOverrides: McpOverrides | undefined;
      sessionOverrides: McpOverrides | undefined;
      conversationOverrides: McpOverrides | undefined;
    },
    discovery: McpSourceDiscoveryResult,
  ): ResolvedConfigView {
    const chain: McpOverrideChain = {
      global: overrides.globalOverrides,
      ...(overrides.projectOverrides !== undefined
        ? { project: overrides.projectOverrides }
        : {}),
      ...(overrides.sessionOverrides !== undefined
        ? { session: overrides.sessionOverrides }
        : {}),
      ...(overrides.conversationOverrides !== undefined
        ? { conversation: overrides.conversationOverrides }
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

/**
 * Collapse an empty override set to `undefined` so a focused override-column
 * write clears the column (NULL) rather than persisting `{ servers: {} }`. Every
 * scope (project/session/conversation) prunes the same way before handing the
 * result to its focused mutation.
 */
function pruneEmptyOverrides(value: McpOverrides): McpOverrides | undefined {
  return Object.keys(value.servers).length === 0 ? undefined : value;
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
