import {
  type ConversationTarget,
  projectConversationTarget,
  sessionConversationTarget,
} from "@/lib/conversations/conversation-target";
import { resolveSessionConversationRoute } from "@/lib/conversations/route-resolution";
import { resolveProjectConversationRoute } from "@/lib/project-conversations/route-resolution";
import type { RouteResolution } from "@/lib/shared/route-resolution";
/**
 * MCP config API route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these factory-created handlers, passing production
 * deps. Tests build handlers with in-process fakes.
 *
 * The factories cover all four cascade scopes (global, project, session,
 * conversation) plus the scoped tool-inventory endpoint pair. Each factory
 * returns only the handlers its route file needs; route files stay thin
 * enough to serve as pure HTTP plumbing.
 */

import { NextResponse } from "next/server";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";

import { createLogger } from "@/lib/logging";
import type { GlobalOverrideStore } from "@/lib/mcp/global-store";
import type { ScopeOverrideStore } from "@/lib/mcp/scope-store";
import type { ToolInventoryCache } from "@/lib/mcp/tool-discovery-cache";
import type {
  AfterOverrideChangeInput,
  ConversationApplyResult,
} from "@/lib/mcp/runtime-apply";
import type { RuntimeTarget } from "@/lib/mcp/runtime-targets";
import {
  computeConfigEditHash,
  type McpConfigMutationService,
} from "@/lib/mcp/config-mutation-service";
import { resolveView, type McpOverrideChain } from "@/lib/mcp/resolver";
import type {
  McpServerDefinition,
  McpSourceDiscoveryInput,
  McpSourceDiscoveryResult,
} from "@/lib/mcp/types";
import {
  mcpConfigPatchRequestSchema,
  type McpConfigLevel,
  type McpConfigPatchRequest,
  type McpConfigViewResponse,
  type McpOverrides,
  type McpToolInventoryResult,
} from "@/lib/mcp/schemas";
import { type AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
/**
 * Per-project override reader. Used at project / session / conversation scopes
 * so the resolver chain includes the just-written project overrides (which
 * `ScopeOverrideStore` only exposes via its patch methods).
 */
type ReadProjectOverrides = (
  projectPath: string,
) => Promise<McpOverrides | undefined>;

const log = createLogger("mcp.routes");

// ---------------------------------------------------------------------------
// Broadcast payload — accepted via injection so the concrete SSE event union
// can grow in Task 13 without changing this module's contract.
// ---------------------------------------------------------------------------

export type McpConfigRouteBroadcastPayload =
  | {
      kind: "config-updated";
      level: McpConfigLevel;
      projectName?: string;
      sessionName?: string;
      conversationId?: string;
      target?: ConversationTarget;
      changedServerKeys: readonly string[];
      effectiveConfigHash: string;
    }
  | {
      kind: "tools-updated";
      level: McpConfigLevel;
      projectName?: string;
      sessionName?: string;
      conversationId?: string;
      target?: ConversationTarget;
      serverKey: string;
    };

export type McpConfigRouteBroadcast = (
  payload: McpConfigRouteBroadcastPayload,
) => void;

// ---------------------------------------------------------------------------
// Shared deps & helpers
// ---------------------------------------------------------------------------

interface SharedDiscoveryDeps {
  discoverAllSources(
    input: McpSourceDiscoveryInput,
  ): Promise<McpSourceDiscoveryResult>;
  globalConfigPath(): string;
}

interface RuntimeApplyFanoutDeps {
  applyAfterOverrideChange(
    input: AfterOverrideChangeInput,
  ): Promise<ConversationApplyResult>;
}

/**
 * Shared optional deps that let GET handlers populate `resolveView`'s
 * `toolInventories` from a cached inventory keyed on
 * `{ serverKey, configSignature }`.
 *
 * When omitted, `resolveView` receives an empty inventory map and server cards
 * render as `idle` until a refresh POST populates the cache. Production routes
 * inject the cache so subsequent GETs surface the cached inventory
 * immediately — closing the gap between a refresh POST and the next config
 * view read.
 */
interface SharedToolInventoryReaderDeps {
  toolInventoryCache?: ToolInventoryCache;
  /**
   * Surface the canonical definition to the shared probe-key lookup map before
   * `peek`/`getOrFetch` runs. Required in production so a subsequent cache
   * fetch can resolve the server config from the key alone.
   */
  onDefinitionLoaded?(
    key: {
      serverKey: string;
      configSignature: string;
    },
    definition: McpServerDefinition,
  ): void;
}

/**
 * Build the `toolInventories` record expected by `resolveView` by peeking the
 * cache for every discovered server. Returns an empty map when no cache is
 * wired, preserving the pre-wiring behaviour of each GET handler.
 */
function buildToolInventoriesFromCache(
  servers: readonly McpServerDefinition[],
  deps: SharedToolInventoryReaderDeps,
): Readonly<Record<string, McpToolInventoryResult>> {
  if (!deps.toolInventoryCache) return {};
  const inventories: Record<string, McpToolInventoryResult> = {};
  for (const def of servers) {
    const key = {
      serverKey: def.serverKey,
      configSignature: def.configSignature,
    };
    deps.onDefinitionLoaded?.(key, def);
    inventories[def.serverKey] = deps.toolInventoryCache.peek(key);
  }
  return inventories;
}

interface RouteContext {
  params: Promise<Record<string, string>>;
}

async function fanOutRuntimeApply(input: {
  targets: readonly RuntimeTarget[];
  changedServerKeys: readonly string[];
  applyAfterOverrideChange: RuntimeApplyFanoutDeps["applyAfterOverrideChange"];
}): Promise<void> {
  for (const target of input.targets) {
    try {
      await input.applyAfterOverrideChange({
        projectPath: target.projectPath,
        target: target.target,
        backend: target.backend,
        changedServerKeys: input.changedServerKeys,
      });
    } catch (err) {
      log.warn("runtime-apply.fanout_failed", {
        projectPath: target.projectPath,
        target: target.target,
        backend: target.backend,
        changedServerKeys: input.changedServerKeys,
        error: getErrorMessage(err),
      });
    }
  }
}

async function parsePatchBody(
  request: Request,
): Promise<
  { ok: true; data: McpConfigPatchRequest } | { ok: false; response: Response }
> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: jsonError("Invalid JSON body", 400) };
  }

  const parsed = mcpConfigPatchRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      response: jsonError(`Invalid patch body: ${detail}`, 400),
    };
  }
  return { ok: true, data: parsed.data };
}

function withHash(
  view: McpConfigViewResponse,
  discovered: readonly McpServerDefinition[],
): McpConfigViewResponse {
  return {
    ...view,
    effectiveConfigHash: computeConfigEditHash({ view, discovered }),
  };
}

// ===========================================================================
// 12.1 — Global
// ===========================================================================

export interface GlobalMcpConfigHandlersDeps
  extends
    SharedDiscoveryDeps,
    SharedToolInventoryReaderDeps,
    RuntimeApplyFanoutDeps {
  globalStore: GlobalOverrideStore;
  mutationService: McpConfigMutationService;
  broadcast?: McpConfigRouteBroadcast;
  listGlobalRuntimeTargets(): Promise<readonly RuntimeTarget[]>;
}

export function createGlobalMcpConfigHandlers(
  deps: GlobalMcpConfigHandlersDeps,
) {
  async function resolveCurrent(): Promise<McpConfigViewResponse> {
    const [overrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.discoverAllSources({
        globalConfigPath: deps.globalConfigPath(),
      }),
    ]);
    const visibleServers = globalScopeOnly(discovery.servers);
    const view = resolveView({
      level: "global",
      overrides: { global: overrides },
      discovered: visibleServers,
      discoveryDiagnostics: discovery.diagnostics,
      toolInventories: buildToolInventoriesFromCache(visibleServers, deps),
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    return withHash(view, visibleServers);
  }

  async function GET(_request: Request): Promise<Response> {
    try {
      const view = await resolveCurrent();
      return NextResponse.json({ view });
    } catch (err) {
      return handleUnexpected("global.get", err);
    }
  }

  async function PATCH(request: Request): Promise<Response> {
    const parsed = await parsePatchBody(request);
    if (!parsed.ok) return parsed.response;

    try {
      const result = await deps.mutationService.patchGlobal({
        operations: parsed.data.operations,
        expectedEffectiveConfigHash: parsed.data.expectedEffectiveConfigHash,
      });
      if (!result.ok) {
        return jsonError(
          "effectiveConfigHash mismatch — refresh and retry",
          409,
        );
      }
      const runtimeTargets = await deps.listGlobalRuntimeTargets();
      await fanOutRuntimeApply({
        targets: runtimeTargets,
        changedServerKeys: result.changedServerKeys,
        applyAfterOverrideChange: deps.applyAfterOverrideChange,
      });
      const next = await resolveCurrent();

      deps.broadcast?.({
        kind: "config-updated",
        level: "global",
        changedServerKeys: [...result.changedServerKeys],
        effectiveConfigHash: next.effectiveConfigHash ?? "",
      });

      return NextResponse.json({
        view: next,
        effectiveConfigHash: next.effectiveConfigHash,
      });
    } catch (err) {
      return handleUnexpected("global.patch", err);
    }
  }

  return { GET, PATCH };
}

function globalScopeOnly(
  servers: readonly McpServerDefinition[],
): readonly McpServerDefinition[] {
  return servers.filter((s) =>
    s.sourceRefs.some((ref) => ref.scope === "global"),
  );
}

// ===========================================================================
// 12.2 — Project
// ===========================================================================

export interface ProjectMcpConfigHandlersDeps
  extends
    SharedDiscoveryDeps,
    SharedToolInventoryReaderDeps,
    RuntimeApplyFanoutDeps {
  globalStore: GlobalOverrideStore;
  scopeStore: ScopeOverrideStore;
  mutationService: McpConfigMutationService;
  resolveProjectPath(projectName: string): Promise<string | null>;
  readProjectOverrides: ReadProjectOverrides;
  broadcast?: McpConfigRouteBroadcast;
  listProjectRuntimeTargets(
    projectPath: string,
  ): Promise<readonly RuntimeTarget[]>;
}

type ProjectRouteParams = { name: string };

export function createProjectMcpConfigHandlers(
  deps: ProjectMcpConfigHandlersDeps,
) {
  async function resolveCurrent(input: {
    projectName: string;
    projectPath: string;
  }): Promise<McpConfigViewResponse> {
    const [globalOverrides, projectOverrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.readProjectOverrides(input.projectPath),
      deps.discoverAllSources({
        globalConfigPath: deps.globalConfigPath(),
        worktreePath: input.projectPath,
      }),
    ]);
    const chain: McpOverrideChain = {
      global: globalOverrides,
      ...(projectOverrides !== undefined ? { project: projectOverrides } : {}),
    };
    const view = resolveView({
      level: "project",
      overrides: chain,
      discovered: discovery.servers,
      discoveryDiagnostics: discovery.diagnostics,
      toolInventories: buildToolInventoriesFromCache(discovery.servers, deps),
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
      projectName: input.projectName,
    });
    return withHash(view, discovery.servers);
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const { name } = (await ctx.params) as ProjectRouteParams;
      const project = await resolveProjectOr404(deps, name);
      if (!project.ok) return project.response;
      const projectPath = project.value;
      const view = await resolveCurrent({
        projectName: name,
        projectPath,
      });
      return NextResponse.json({ view });
    } catch (err) {
      return handleUnexpected("project.get", err);
    }
  }

  async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
    const parsed = await parsePatchBody(request);
    if (!parsed.ok) return parsed.response;

    try {
      const { name } = (await ctx.params) as ProjectRouteParams;
      const project = await resolveProjectOr404(deps, name);
      if (!project.ok) return project.response;
      const projectPath = project.value;

      const result = await deps.mutationService.patchProject({
        projectName: name,
        projectPath,
        operations: parsed.data.operations,
        expectedEffectiveConfigHash: parsed.data.expectedEffectiveConfigHash,
      });
      if (!result.ok) {
        return jsonError(
          "effectiveConfigHash mismatch — refresh and retry",
          409,
        );
      }
      const runtimeTargets = await deps.listProjectRuntimeTargets(projectPath);
      await fanOutRuntimeApply({
        targets: runtimeTargets,
        changedServerKeys: result.changedServerKeys,
        applyAfterOverrideChange: deps.applyAfterOverrideChange,
      });
      const next = await resolveCurrent({
        projectName: name,
        projectPath,
      });

      deps.broadcast?.({
        kind: "config-updated",
        level: "project",
        projectName: name,
        changedServerKeys: [...result.changedServerKeys],
        effectiveConfigHash: next.effectiveConfigHash ?? "",
      });

      return NextResponse.json({
        view: next,
        effectiveConfigHash: next.effectiveConfigHash,
      });
    } catch (err) {
      return handleUnexpected("project.patch", err);
    }
  }

  return { GET, PATCH };
}

// ===========================================================================
// 12.3 — Session
// ===========================================================================

export interface SessionMcpConfigHandlersDeps
  extends
    SharedDiscoveryDeps,
    SharedToolInventoryReaderDeps,
    RuntimeApplyFanoutDeps {
  globalStore: GlobalOverrideStore;
  scopeStore: ScopeOverrideStore;
  mutationService: McpConfigMutationService;
  resolveProjectPath(projectName: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  readProjectOverrides: ReadProjectOverrides;
  broadcast?: McpConfigRouteBroadcast;
  listSessionRuntimeTargets(
    projectPath: string,
    sessionName: string,
  ): Promise<readonly RuntimeTarget[]>;
}

type SessionRouteParams = { name: string; session: string };

export function createSessionMcpConfigHandlers(
  deps: SessionMcpConfigHandlersDeps,
) {
  async function resolveCurrent(input: {
    projectName: string;
    sessionName: string;
    projectPath: string;
    worktreePath: string;
    sessionOverrides: McpOverrideChain["session"];
  }): Promise<McpConfigViewResponse> {
    const [globalOverrides, projectOverrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.readProjectOverrides(input.projectPath),
      deps.discoverAllSources({
        globalConfigPath: deps.globalConfigPath(),
        worktreePath: input.worktreePath,
      }),
    ]);
    const chain: McpOverrideChain = {
      global: globalOverrides,
      ...(projectOverrides !== undefined ? { project: projectOverrides } : {}),
      ...(input.sessionOverrides !== undefined
        ? { session: input.sessionOverrides }
        : {}),
    };
    const view = resolveView({
      level: "session",
      overrides: chain,
      discovered: discovery.servers,
      discoveryDiagnostics: discovery.diagnostics,
      toolInventories: buildToolInventoriesFromCache(discovery.servers, deps),
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
      projectName: input.projectName,
      sessionName: input.sessionName,
    });
    return withHash(view, discovery.servers);
  }

  async function loadContext(
    params: SessionRouteParams,
  ): Promise<
    | { ok: true; projectPath: string; session: SessionState }
    | { ok: false; response: Response }
  > {
    const resolved = await resolveProjectSessionOr404(
      deps,
      params.name,
      params.session,
    );
    if (!resolved.ok) return resolved;
    const { projectPath, session } = resolved.value;
    return { ok: true, projectPath, session };
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as SessionRouteParams;
      const loaded = await loadContext(params);
      if (!loaded.ok) return loaded.response;
      const view = await resolveCurrent({
        projectName: params.name,
        sessionName: params.session,
        projectPath: loaded.projectPath,
        worktreePath: loaded.session.worktreePath,
        sessionOverrides: loaded.session.mcpOverrides,
      });
      return NextResponse.json({ view });
    } catch (err) {
      return handleUnexpected("session.get", err);
    }
  }

  async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
    const parsed = await parsePatchBody(request);
    if (!parsed.ok) return parsed.response;

    try {
      const params = (await ctx.params) as SessionRouteParams;
      const loaded = await loadContext(params);
      if (!loaded.ok) return loaded.response;

      const result = await deps.mutationService.patchSession({
        projectName: params.name,
        projectPath: loaded.projectPath,
        sessionName: params.session,
        operations: parsed.data.operations,
        expectedEffectiveConfigHash: parsed.data.expectedEffectiveConfigHash,
      });
      if (!result.ok) {
        return jsonError(
          "effectiveConfigHash mismatch — refresh and retry",
          409,
        );
      }
      const runtimeTargets = await deps.listSessionRuntimeTargets(
        loaded.projectPath,
        params.session,
      );
      await fanOutRuntimeApply({
        targets: runtimeTargets,
        changedServerKeys: result.changedServerKeys,
        applyAfterOverrideChange: deps.applyAfterOverrideChange,
      });
      const refreshedSession = await deps.getSession(
        loaded.projectPath,
        params.session,
      );
      if (!refreshedSession) {
        return notFound("Session not found");
      }
      const next = await resolveCurrent({
        projectName: params.name,
        sessionName: params.session,
        projectPath: loaded.projectPath,
        worktreePath: refreshedSession.worktreePath,
        sessionOverrides: refreshedSession.mcpOverrides,
      });

      deps.broadcast?.({
        kind: "config-updated",
        level: "session",
        projectName: params.name,
        sessionName: params.session,
        changedServerKeys: [...result.changedServerKeys],
        effectiveConfigHash: next.effectiveConfigHash ?? "",
      });

      return NextResponse.json({
        view: next,
        effectiveConfigHash: next.effectiveConfigHash,
      });
    } catch (err) {
      return handleUnexpected("session.patch", err);
    }
  }

  return { GET, PATCH };
}

// ===========================================================================
// 12.4 — Conversation
// ===========================================================================

interface McpConversationContextDeps {
  resolveProjectPath(projectName: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

interface McpConversationContext {
  projectPath: string;
  target: ConversationTarget;
  worktreePath: string;
  sessionOverrides?: McpOverrides;
  conversation: ConversationState;
}

async function resolveMcpConversationContext(
  deps: McpConversationContextDeps,
  ctx: RouteContext,
): Promise<RouteResolution<McpConversationContext>> {
  const params = await ctx.params;
  if (params.session !== undefined) {
    const resolved = await resolveSessionConversationRoute(deps, ctx);
    if (!resolved.ok) return resolved;
    const { projectPath, session, conversation } = resolved.value;
    return {
      ok: true,
      value: {
        projectPath,
        target: sessionConversationTarget(
          params.name ?? "",
          session.sessionName,
          conversation.id,
        ),
        worktreePath: session.worktreePath,
        sessionOverrides: session.mcpOverrides,
        conversation,
      },
    };
  }
  const resolved = await resolveProjectConversationRoute(deps, ctx);
  if (!resolved.ok) return resolved;
  const { projectPath, conversation } = resolved.value;
  return {
    ok: true,
    value: {
      projectPath,
      target: projectConversationTarget(params.name ?? "", conversation.id),
      worktreePath: projectPath,
      conversation,
    },
  };
}

export interface ConversationMcpConfigHandlersDeps
  extends
    SharedDiscoveryDeps,
    SharedToolInventoryReaderDeps,
    McpConversationContextDeps {
  globalStore: GlobalOverrideStore;
  scopeStore: ScopeOverrideStore;
  mutationService: McpConfigMutationService;
  readProjectOverrides: ReadProjectOverrides;
  applyAfterOverrideChange(
    input: AfterOverrideChangeInput,
  ): Promise<ConversationApplyResult>;
  broadcast?: McpConfigRouteBroadcast;
  defaultBackend?: AgentBackendId;
}

export function createConversationMcpConfigHandlers(
  deps: ConversationMcpConfigHandlersDeps,
) {
  async function resolveCurrent(
    input: McpConversationContext,
  ): Promise<McpConfigViewResponse> {
    const [globalOverrides, projectOverrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.readProjectOverrides(input.projectPath),
      deps.discoverAllSources({
        globalConfigPath: deps.globalConfigPath(),
        worktreePath: input.worktreePath,
      }),
    ]);
    const chain: McpOverrideChain = {
      global: globalOverrides,
      ...(projectOverrides !== undefined ? { project: projectOverrides } : {}),
      ...(input.sessionOverrides !== undefined
        ? { session: input.sessionOverrides }
        : {}),
      ...(input.conversation.mcpOverrides !== undefined
        ? { conversation: input.conversation.mcpOverrides }
        : {}),
    };
    const view = resolveView({
      level: "conversation",
      overrides: chain,
      discovered: discovery.servers,
      discoveryDiagnostics: discovery.diagnostics,
      toolInventories: buildToolInventoriesFromCache(discovery.servers, deps),
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: input.conversation.mcpRuntime?.pendingServerKeys ?? [],
      projectName: input.target.projectName,
      ...(input.target.scope === "session"
        ? { sessionName: input.target.sessionName }
        : {}),
      conversationId: input.target.conversationId,
    });
    return withHash(
      {
        ...view,
        target: input.target,
        backend: selectBackend(input.conversation, deps.defaultBackend),
        runtime: input.conversation.mcpRuntime,
      },
      discovery.servers,
    );
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const loaded = await resolveMcpConversationContext(deps, ctx);
      if (!loaded.ok) return loaded.response;
      return NextResponse.json({ view: await resolveCurrent(loaded.value) });
    } catch (err) {
      return handleUnexpected("conversation.get", err);
    }
  }

  async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
    const parsed = await parsePatchBody(request);
    if (!parsed.ok) return parsed.response;
    try {
      const loaded = await resolveMcpConversationContext(deps, ctx);
      if (!loaded.ok) return loaded.response;
      const { target, projectPath, conversation } = loaded.value;
      const result = await deps.mutationService.patchConversation({
        target,
        projectPath,
        operations: parsed.data.operations,
        expectedEffectiveConfigHash: parsed.data.expectedEffectiveConfigHash,
      });
      if (!result.ok)
        return jsonError(
          "effectiveConfigHash mismatch — refresh and retry",
          409,
        );
      const apply = await deps.applyAfterOverrideChange({
        projectPath,
        target,
        backend: selectBackend(conversation, deps.defaultBackend),
        changedServerKeys: result.changedServerKeys,
      });
      const refreshed = await resolveMcpConversationContext(deps, ctx);
      if (!refreshed.ok) return refreshed.response;
      const next = await resolveCurrent(refreshed.value);
      deps.broadcast?.({
        kind: "config-updated",
        level: "conversation",
        target,
        changedServerKeys: [...result.changedServerKeys],
        effectiveConfigHash: next.effectiveConfigHash ?? "",
      });
      return NextResponse.json({
        view: next,
        effectiveConfigHash: next.effectiveConfigHash,
        apply,
      });
    } catch (err) {
      return handleUnexpected("conversation.patch", err);
    }
  }
  return { GET, PATCH };
}

function selectBackend(
  conversation: ConversationState,
  fallback: AgentBackendId | undefined,
): AgentBackendId {
  return conversation.agentBackend ?? fallback ?? "claude";
}

// ===========================================================================
// 12.5 — Tool inventory (scoped)
// ===========================================================================

export interface ToolInventoryHandlersDeps
  extends
    SharedDiscoveryDeps,
    McpConversationContextDeps,
    ScopedToolInventoryCore {}

export function createToolInventoryHandlers(deps: ToolInventoryHandlersDeps) {
  async function loadDefinition(ctx: RouteContext): Promise<
    RouteResolution<{
      definition: McpServerDefinition;
      target: ConversationTarget;
    }>
  > {
    const resolved = await resolveMcpConversationContext(deps, ctx);
    if (!resolved.ok) return resolved;
    const params = await ctx.params;
    const discovery = await deps.discoverAllSources({
      globalConfigPath: deps.globalConfigPath(),
      worktreePath: resolved.value.worktreePath,
    });
    const definition = discovery.servers.find(
      (server) => server.serverKey === params.serverKey,
    );
    if (!definition)
      return { ok: false, response: notFound("MCP server not found") };
    return { ok: true, value: { definition, target: resolved.value.target } };
  }
  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const loaded = await loadDefinition(ctx);
      if (!loaded.ok) return loaded.response;
      return runScopedToolGet(deps, loaded.value.definition);
    } catch (err) {
      return handleUnexpected("tools.get", err);
    }
  }
  async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const loaded = await loadDefinition(ctx);
      if (!loaded.ok) return loaded.response;
      return runScopedToolRefresh(deps, loaded.value.definition, {
        level: "conversation",
        target: loaded.value.target,
      });
    } catch (err) {
      return handleUnexpected("tools.refresh", err);
    }
  }
  return { GET, POST };
}

// ---------------------------------------------------------------------------
// Scoped tool inventory (global / project / session)
//
// Tool discovery at every cascade level shares the same cache (keyed on
// serverKey + configSignature). What differs per scope is:
//   - which route parameters identify the server,
//   - which discovery context (globalConfigPath / worktreePath) we resolve against,
//   - the level + identifiers emitted on the broadcast.
//
// A small shared helper does cache GET/POST against a pre-resolved server
// definition; each scope factory owns its own parameter parsing and discovery
// context.
// ---------------------------------------------------------------------------

interface ScopedToolInventoryCore {
  cache: ToolInventoryCache;
  broadcast?: McpConfigRouteBroadcast;
  onDefinitionLoaded?(
    key: {
      serverKey: string;
      configSignature: string;
    },
    definition: McpServerDefinition,
  ): void;
}

function scopedCacheKey(definition: McpServerDefinition) {
  return {
    serverKey: definition.serverKey,
    configSignature: definition.configSignature,
  };
}

function scopedNotifyKey(definition: McpServerDefinition) {
  return {
    serverKey: definition.serverKey,
    configSignature: definition.configSignature,
  };
}

async function runScopedToolGet(
  core: ScopedToolInventoryCore,
  definition: McpServerDefinition,
): Promise<Response> {
  core.onDefinitionLoaded?.(scopedNotifyKey(definition), definition);
  const result = core.cache.peek(scopedCacheKey(definition));
  return NextResponse.json(result);
}

async function runScopedToolRefresh(
  core: ScopedToolInventoryCore,
  definition: McpServerDefinition,
  broadcastPayload: Omit<
    Extract<McpConfigRouteBroadcastPayload, { kind: "tools-updated" }>,
    "kind" | "serverKey"
  >,
): Promise<Response> {
  core.onDefinitionLoaded?.(scopedNotifyKey(definition), definition);
  const result = await core.cache.refresh(scopedCacheKey(definition));
  core.broadcast?.({
    ...broadcastPayload,
    kind: "tools-updated",
    serverKey: definition.serverKey,
  });
  return NextResponse.json(result);
}

// ---- Global ---------------------------------------------------------------

export interface GlobalToolInventoryHandlersDeps
  extends SharedDiscoveryDeps, ScopedToolInventoryCore {}

type GlobalToolInventoryRouteParams = { serverKey: string };

export function createGlobalToolInventoryHandlers(
  deps: GlobalToolInventoryHandlersDeps,
) {
  async function loadDefinition(
    serverKey: string,
  ): Promise<
    | { ok: true; definition: McpServerDefinition }
    | { ok: false; response: Response }
  > {
    const discovery = await deps.discoverAllSources({
      globalConfigPath: deps.globalConfigPath(),
    });
    const definition = globalScopeOnly(discovery.servers).find(
      (s) => s.serverKey === serverKey,
    );
    if (!definition) {
      return { ok: false, response: notFound("MCP server not found") };
    }
    return { ok: true, definition };
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const { serverKey } =
        (await ctx.params) as GlobalToolInventoryRouteParams;
      const loaded = await loadDefinition(serverKey);
      if (!loaded.ok) return loaded.response;
      return runScopedToolGet(deps, loaded.definition);
    } catch (err) {
      return handleUnexpected("tools.global.get", err);
    }
  }

  async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const { serverKey } =
        (await ctx.params) as GlobalToolInventoryRouteParams;
      const loaded = await loadDefinition(serverKey);
      if (!loaded.ok) return loaded.response;
      return runScopedToolRefresh(deps, loaded.definition, {
        level: "global",
      });
    } catch (err) {
      return handleUnexpected("tools.global.refresh", err);
    }
  }

  return { GET, POST };
}

// ---- Project --------------------------------------------------------------

export interface ProjectToolInventoryHandlersDeps
  extends SharedDiscoveryDeps, ScopedToolInventoryCore {
  resolveProjectPath(projectName: string): Promise<string | null>;
}

type ProjectToolInventoryRouteParams = { name: string; serverKey: string };

export function createProjectToolInventoryHandlers(
  deps: ProjectToolInventoryHandlersDeps,
) {
  async function loadDefinition(
    params: ProjectToolInventoryRouteParams,
  ): Promise<
    | { ok: true; definition: McpServerDefinition }
    | { ok: false; response: Response }
  > {
    const project = await resolveProjectOr404(deps, params.name);
    if (!project.ok) return project;
    const projectPath = project.value;
    const discovery = await deps.discoverAllSources({
      globalConfigPath: deps.globalConfigPath(),
      worktreePath: projectPath,
    });
    const definition = discovery.servers.find(
      (s) => s.serverKey === params.serverKey,
    );
    if (!definition) {
      return { ok: false, response: notFound("MCP server not found") };
    }
    return { ok: true, definition };
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as ProjectToolInventoryRouteParams;
      const loaded = await loadDefinition(params);
      if (!loaded.ok) return loaded.response;
      return runScopedToolGet(deps, loaded.definition);
    } catch (err) {
      return handleUnexpected("tools.project.get", err);
    }
  }

  async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as ProjectToolInventoryRouteParams;
      const loaded = await loadDefinition(params);
      if (!loaded.ok) return loaded.response;
      return runScopedToolRefresh(deps, loaded.definition, {
        level: "project",
        projectName: params.name,
      });
    } catch (err) {
      return handleUnexpected("tools.project.refresh", err);
    }
  }

  return { GET, POST };
}

// ---- Session --------------------------------------------------------------

export interface SessionToolInventoryHandlersDeps
  extends SharedDiscoveryDeps, ScopedToolInventoryCore {
  resolveProjectPath(projectName: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
}

type SessionToolInventoryRouteParams = {
  name: string;
  session: string;
  serverKey: string;
};

export function createSessionToolInventoryHandlers(
  deps: SessionToolInventoryHandlersDeps,
) {
  async function loadDefinition(
    params: SessionToolInventoryRouteParams,
  ): Promise<
    | { ok: true; definition: McpServerDefinition }
    | { ok: false; response: Response }
  > {
    const resolved = await resolveProjectSessionOr404(
      deps,
      params.name,
      params.session,
    );
    if (!resolved.ok) return resolved;
    const { session } = resolved.value;
    const discovery = await deps.discoverAllSources({
      globalConfigPath: deps.globalConfigPath(),
      worktreePath: session.worktreePath,
    });
    const definition = discovery.servers.find(
      (s) => s.serverKey === params.serverKey,
    );
    if (!definition) {
      return { ok: false, response: notFound("MCP server not found") };
    }
    return { ok: true, definition };
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as SessionToolInventoryRouteParams;
      const loaded = await loadDefinition(params);
      if (!loaded.ok) return loaded.response;
      return runScopedToolGet(deps, loaded.definition);
    } catch (err) {
      return handleUnexpected("tools.session.get", err);
    }
  }

  async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as SessionToolInventoryRouteParams;
      const loaded = await loadDefinition(params);
      if (!loaded.ok) return loaded.response;
      return runScopedToolRefresh(deps, loaded.definition, {
        level: "session",
        projectName: params.name,
        sessionName: params.session,
      });
    } catch (err) {
      return handleUnexpected("tools.session.refresh", err);
    }
  }

  return { GET, POST };
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function handleUnexpected(label: string, err: unknown): Response {
  const message = getErrorMessage(err);
  log.error(`${label}.error`, { error: message });
  return jsonError(message, 500);
}
