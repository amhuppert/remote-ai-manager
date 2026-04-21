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

import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { createLogger } from "@/lib/logging";
import type { GlobalOverrideStore } from "@/lib/mcp/global-store";
import type { ScopeOverrideStore } from "@/lib/mcp/scope-store";
import type { ToolInventoryCache } from "@/lib/mcp/tool-discovery-cache";
import type {
  AfterOverrideChangeInput,
  ConversationApplyResult,
} from "@/lib/mcp/runtime-apply";
import { resolveView, type McpOverrideChain } from "@/lib/mcp/resolver";
import type {
  McpServerDefinition,
  McpSourceDiscoveryInput,
  McpSourceDiscoveryResult,
} from "@/lib/mcp/types";
import {
  mcpConfigPatchRequestSchema,
  type AgentBackendId,
  type McpConfigLevel,
  type McpConfigPatchRequest,
  type McpConfigViewResponse,
  type McpOverrides,
  type McpServerView,
  type McpToolInventoryResult,
} from "@/lib/schemas";
import type { ConversationState, SessionState } from "@/types";

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
      changedServerKeys: readonly string[];
      effectiveConfigHash: string;
    }
  | {
      kind: "tools-updated";
      level: McpConfigLevel;
      projectName?: string;
      sessionName?: string;
      conversationId?: string;
      serverKey: string;
      configSignature: string;
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
  homePath(): string;
}

/**
 * Shared optional deps that let GET handlers populate `resolveView`'s
 * `toolInventories` from a cached inventory keyed on
 * `{ backend, serverKey, configSignature }`.
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
      backend: AgentBackendId;
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
    const backend = resolveDefinitionBackend(def);
    const key = {
      backend,
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

function jsonError(message: string, status: number): Response {
  return NextResponse.json({ error: message }, { status });
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

/**
 * Deterministic hash of the view-visible state at a given scope. Computed over
 * the resolved server list (sorted, stripped of volatile fields) so a no-op
 * reorder or diagnostic change never invalidates the client's hash.
 */
function computeViewHash(view: McpConfigViewResponse): string {
  const canonical = {
    level: view.level,
    servers: [...view.servers]
      .sort((a, b) => a.serverKey.localeCompare(b.serverKey))
      .map(canonicalServer),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function canonicalServer(server: McpServerView): object {
  return {
    serverKey: server.serverKey,
    enabled: server.enabled,
    inheritanceStatus: server.inheritanceStatus,
    tools: [...server.tools.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        enabled: t.enabled,
        inheritanceStatus: t.inheritanceStatus,
      })),
  };
}

function withHash(view: McpConfigViewResponse): McpConfigViewResponse {
  return { ...view, effectiveConfigHash: computeViewHash(view) };
}

function check409(
  current: McpConfigViewResponse,
  expected: string | undefined,
): Response | null {
  if (expected === undefined) return null;
  if (current.effectiveConfigHash === expected) return null;
  return jsonError("effectiveConfigHash mismatch — refresh and retry", 409);
}

// ===========================================================================
// 12.1 — Global
// ===========================================================================

export interface GlobalMcpConfigHandlersDeps
  extends SharedDiscoveryDeps, SharedToolInventoryReaderDeps {
  globalStore: GlobalOverrideStore;
  broadcast?: McpConfigRouteBroadcast;
}

export function createGlobalMcpConfigHandlers(
  deps: GlobalMcpConfigHandlersDeps,
) {
  async function resolveCurrent(): Promise<McpConfigViewResponse> {
    const [overrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.discoverAllSources({
        worktreePath: deps.homePath(),
        homePath: deps.homePath(),
      }),
    ]);
    const visibleServers = userScopeOnly(discovery.servers);
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
    return withHash(view);
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
      const current = await resolveCurrent();
      const conflict = check409(
        current,
        parsed.data.expectedEffectiveConfigHash,
      );
      if (conflict) return conflict;

      const result = await deps.globalStore.patch({
        operations: parsed.data.operations,
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

function userScopeOnly(
  servers: readonly McpServerDefinition[],
): readonly McpServerDefinition[] {
  return servers.filter((s) =>
    s.sourceRefs.some((ref) => ref.scope === "user"),
  );
}

// ===========================================================================
// 12.2 — Project
// ===========================================================================

export interface ProjectMcpConfigHandlersDeps
  extends SharedDiscoveryDeps, SharedToolInventoryReaderDeps {
  globalStore: GlobalOverrideStore;
  scopeStore: ScopeOverrideStore;
  resolveProjectPath(projectName: string): Promise<string | null>;
  readProjectOverrides: ReadProjectOverrides;
  broadcast?: McpConfigRouteBroadcast;
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
        worktreePath: input.projectPath,
        homePath: deps.homePath(),
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
    return withHash(view);
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const { name } = (await ctx.params) as ProjectRouteParams;
      const projectPath = await deps.resolveProjectPath(name);
      if (!projectPath) return jsonError("Project not found", 404);
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
      const projectPath = await deps.resolveProjectPath(name);
      if (!projectPath) return jsonError("Project not found", 404);

      const current = await resolveCurrent({
        projectName: name,
        projectPath,
      });
      const conflict = check409(
        current,
        parsed.data.expectedEffectiveConfigHash,
      );
      if (conflict) return conflict;

      const result = await deps.scopeStore.patchProject(
        projectPath,
        parsed.data.operations,
      );
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
  extends SharedDiscoveryDeps, SharedToolInventoryReaderDeps {
  globalStore: GlobalOverrideStore;
  scopeStore: ScopeOverrideStore;
  resolveProjectPath(projectName: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  readProjectOverrides: ReadProjectOverrides;
  broadcast?: McpConfigRouteBroadcast;
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
        worktreePath: input.worktreePath,
        homePath: deps.homePath(),
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
    return withHash(view);
  }

  async function loadContext(
    params: SessionRouteParams,
  ): Promise<
    | { ok: true; projectPath: string; session: SessionState }
    | { ok: false; response: Response }
  > {
    const projectPath = await deps.resolveProjectPath(params.name);
    if (!projectPath) {
      return { ok: false, response: jsonError("Project not found", 404) };
    }
    const session = await deps.getSession(projectPath, params.session);
    if (!session) {
      return { ok: false, response: jsonError("Session not found", 404) };
    }
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

      const current = await resolveCurrent({
        projectName: params.name,
        sessionName: params.session,
        projectPath: loaded.projectPath,
        worktreePath: loaded.session.worktreePath,
        sessionOverrides: loaded.session.mcpOverrides,
      });
      const conflict = check409(
        current,
        parsed.data.expectedEffectiveConfigHash,
      );
      if (conflict) return conflict;

      const result = await deps.scopeStore.patchSession(
        loaded.projectPath,
        params.session,
        parsed.data.operations,
      );
      const next = await resolveCurrent({
        projectName: params.name,
        sessionName: params.session,
        projectPath: loaded.projectPath,
        worktreePath: loaded.session.worktreePath,
        sessionOverrides: result.overrides,
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

export interface ConversationMcpConfigHandlersDeps
  extends SharedDiscoveryDeps, SharedToolInventoryReaderDeps {
  globalStore: GlobalOverrideStore;
  scopeStore: ScopeOverrideStore;
  resolveProjectPath(projectName: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  readProjectOverrides: ReadProjectOverrides;
  applyAfterOverrideChange(
    input: AfterOverrideChangeInput,
  ): Promise<ConversationApplyResult>;
  broadcast?: McpConfigRouteBroadcast;
  /** Backend to use for `applyAfterOverrideChange` when the conversation has
   * no explicit backend. Defaults to the conversation's recorded backend or
   * "claude" as final fallback. */
  defaultBackend?: AgentBackendId;
}

type ConversationRouteParams = {
  name: string;
  session: string;
  conversationId: string;
};

export function createConversationMcpConfigHandlers(
  deps: ConversationMcpConfigHandlersDeps,
) {
  async function resolveCurrent(input: {
    projectName: string;
    sessionName: string;
    conversationId: string;
    projectPath: string;
    worktreePath: string;
    sessionOverrides: McpOverrideChain["session"];
    conversationOverrides: McpOverrideChain["conversation"];
  }): Promise<McpConfigViewResponse> {
    const [globalOverrides, projectOverrides, discovery] = await Promise.all([
      deps.globalStore.read(),
      deps.readProjectOverrides(input.projectPath),
      deps.discoverAllSources({
        worktreePath: input.worktreePath,
        homePath: deps.homePath(),
      }),
    ]);
    const chain: McpOverrideChain = {
      global: globalOverrides,
      ...(projectOverrides !== undefined ? { project: projectOverrides } : {}),
      ...(input.sessionOverrides !== undefined
        ? { session: input.sessionOverrides }
        : {}),
      ...(input.conversationOverrides !== undefined
        ? { conversation: input.conversationOverrides }
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
      pendingServerKeys: [],
      projectName: input.projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
    });
    return withHash(view);
  }

  async function loadContext(params: ConversationRouteParams): Promise<
    | {
        ok: true;
        projectPath: string;
        session: SessionState;
        conversation: ConversationState;
      }
    | { ok: false; response: Response }
  > {
    const projectPath = await deps.resolveProjectPath(params.name);
    if (!projectPath) {
      return { ok: false, response: jsonError("Project not found", 404) };
    }
    const session = await deps.getSession(projectPath, params.session);
    if (!session) {
      return { ok: false, response: jsonError("Session not found", 404) };
    }
    const conversation = session.conversations.find(
      (c) => c.id === params.conversationId,
    );
    if (!conversation) {
      return {
        ok: false,
        response: jsonError("Conversation not found", 404),
      };
    }
    return { ok: true, projectPath, session, conversation };
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as ConversationRouteParams;
      const loaded = await loadContext(params);
      if (!loaded.ok) return loaded.response;
      const view = await resolveCurrent({
        projectName: params.name,
        sessionName: params.session,
        conversationId: params.conversationId,
        projectPath: loaded.projectPath,
        worktreePath: loaded.session.worktreePath,
        sessionOverrides: loaded.session.mcpOverrides,
        conversationOverrides: loaded.conversation.mcpOverrides,
      });
      return NextResponse.json({ view });
    } catch (err) {
      return handleUnexpected("conversation.get", err);
    }
  }

  async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
    const parsed = await parsePatchBody(request);
    if (!parsed.ok) return parsed.response;

    try {
      const params = (await ctx.params) as ConversationRouteParams;
      const loaded = await loadContext(params);
      if (!loaded.ok) return loaded.response;

      const current = await resolveCurrent({
        projectName: params.name,
        sessionName: params.session,
        conversationId: params.conversationId,
        projectPath: loaded.projectPath,
        worktreePath: loaded.session.worktreePath,
        sessionOverrides: loaded.session.mcpOverrides,
        conversationOverrides: loaded.conversation.mcpOverrides,
      });
      const conflict = check409(
        current,
        parsed.data.expectedEffectiveConfigHash,
      );
      if (conflict) return conflict;

      const result = await deps.scopeStore.patchConversation(
        loaded.projectPath,
        params.session,
        params.conversationId,
        parsed.data.operations,
      );

      const backend = selectBackend(loaded.conversation, deps.defaultBackend);
      const apply = await deps.applyAfterOverrideChange({
        projectPath: loaded.projectPath,
        sessionName: params.session,
        conversationId: params.conversationId,
        backend,
        changedServerKeys: result.changedServerKeys,
      });

      const next = await resolveCurrent({
        projectName: params.name,
        sessionName: params.session,
        conversationId: params.conversationId,
        projectPath: loaded.projectPath,
        worktreePath: loaded.session.worktreePath,
        sessionOverrides: loaded.session.mcpOverrides,
        conversationOverrides: result.overrides,
      });

      deps.broadcast?.({
        kind: "config-updated",
        level: "conversation",
        projectName: params.name,
        sessionName: params.session,
        conversationId: params.conversationId,
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
  const recorded = (conversation as { backend?: AgentBackendId }).backend;
  if (recorded === "claude" || recorded === "codex") return recorded;
  return fallback ?? "claude";
}

// ===========================================================================
// 12.5 — Tool inventory (scoped)
// ===========================================================================

export interface ToolInventoryHandlersDeps extends SharedDiscoveryDeps {
  cache: ToolInventoryCache;
  resolveProjectPath(projectName: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  broadcast?: McpConfigRouteBroadcast;
  /** Called just before a cache operation so production wiring can surface
   * the canonical config to the shared probe-key lookup map. No-op in tests. */
  onDefinitionLoaded?(
    key: {
      backend: AgentBackendId;
      serverKey: string;
      configSignature: string;
    },
    definition: McpServerDefinition,
  ): void;
}

type ToolInventoryRouteParams = {
  name: string;
  session: string;
  conversationId: string;
  serverKey: string;
};

export function createToolInventoryHandlers(deps: ToolInventoryHandlersDeps) {
  async function loadDefinition(
    params: ToolInventoryRouteParams,
  ): Promise<
    | { ok: true; definition: McpServerDefinition; backend: AgentBackendId }
    | { ok: false; response: Response }
  > {
    const projectPath = await deps.resolveProjectPath(params.name);
    if (!projectPath) {
      return { ok: false, response: jsonError("Project not found", 404) };
    }
    const session = await deps.getSession(projectPath, params.session);
    if (!session) {
      return { ok: false, response: jsonError("Session not found", 404) };
    }
    const conversation = session.conversations.find(
      (c) => c.id === params.conversationId,
    );
    if (!conversation) {
      return {
        ok: false,
        response: jsonError("Conversation not found", 404),
      };
    }
    const discovery = await deps.discoverAllSources({
      worktreePath: session.worktreePath,
      homePath: deps.homePath(),
    });
    const definition = discovery.servers.find(
      (s) => s.serverKey === params.serverKey,
    );
    if (!definition) {
      return {
        ok: false,
        response: jsonError("MCP server not found", 404),
      };
    }
    const backend = resolveDefinitionBackend(definition);
    return { ok: true, definition, backend };
  }

  function buildKey(definition: McpServerDefinition, backend: AgentBackendId) {
    return {
      backend,
      serverKey: definition.serverKey,
      configSignature: definition.configSignature,
    };
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as ToolInventoryRouteParams;
      const loaded = await loadDefinition(params);
      if (!loaded.ok) return loaded.response;
      const key = buildKey(loaded.definition, loaded.backend);
      deps.onDefinitionLoaded?.(key, loaded.definition);
      const result = deps.cache.peek(key);
      return NextResponse.json(result);
    } catch (err) {
      return handleUnexpected("tools.get", err);
    }
  }

  async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as ToolInventoryRouteParams;
      const loaded = await loadDefinition(params);
      if (!loaded.ok) return loaded.response;
      const key = buildKey(loaded.definition, loaded.backend);
      deps.onDefinitionLoaded?.(key, loaded.definition);
      const result = await deps.cache.refresh(key);
      deps.broadcast?.({
        kind: "tools-updated",
        level: "conversation",
        projectName: params.name,
        sessionName: params.session,
        conversationId: params.conversationId,
        serverKey: loaded.definition.serverKey,
        configSignature: loaded.definition.configSignature,
      });
      return NextResponse.json(result);
    } catch (err) {
      return handleUnexpected("tools.refresh", err);
    }
  }

  return { GET, POST };
}

function resolveDefinitionBackend(
  definition: McpServerDefinition,
): AgentBackendId {
  if (definition.backend === "claude" || definition.backend === "codex") {
    return definition.backend;
  }
  return "claude";
}

// ---------------------------------------------------------------------------
// Scoped tool inventory (global / project / session)
//
// Tool discovery at every cascade level shares the same cache (keyed on
// backend + serverKey + configSignature). What differs per scope is:
//   - which route parameters identify the server,
//   - which discovery context (worktreePath / homePath) we resolve against,
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
      backend: AgentBackendId;
      serverKey: string;
      configSignature: string;
    },
    definition: McpServerDefinition,
  ): void;
}

async function runScopedToolGet(
  core: ScopedToolInventoryCore,
  definition: McpServerDefinition,
  backend: AgentBackendId,
): Promise<Response> {
  const key = {
    backend,
    serverKey: definition.serverKey,
    configSignature: definition.configSignature,
  };
  core.onDefinitionLoaded?.(key, definition);
  const result = core.cache.peek(key);
  return NextResponse.json(result);
}

async function runScopedToolRefresh(
  core: ScopedToolInventoryCore,
  definition: McpServerDefinition,
  backend: AgentBackendId,
  broadcastPayload: Omit<
    Extract<McpConfigRouteBroadcastPayload, { kind: "tools-updated" }>,
    "kind" | "serverKey" | "configSignature"
  >,
): Promise<Response> {
  const key = {
    backend,
    serverKey: definition.serverKey,
    configSignature: definition.configSignature,
  };
  core.onDefinitionLoaded?.(key, definition);
  const result = await core.cache.refresh(key);
  core.broadcast?.({
    ...broadcastPayload,
    kind: "tools-updated",
    serverKey: definition.serverKey,
    configSignature: definition.configSignature,
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
    | { ok: true; definition: McpServerDefinition; backend: AgentBackendId }
    | { ok: false; response: Response }
  > {
    const discovery = await deps.discoverAllSources({
      worktreePath: deps.homePath(),
      homePath: deps.homePath(),
    });
    const definition = discovery.servers
      .filter((s) => s.sourceRefs.some((ref) => ref.scope === "user"))
      .find((s) => s.serverKey === serverKey);
    if (!definition) {
      return { ok: false, response: jsonError("MCP server not found", 404) };
    }
    return {
      ok: true,
      definition,
      backend: resolveDefinitionBackend(definition),
    };
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const { serverKey } =
        (await ctx.params) as GlobalToolInventoryRouteParams;
      const loaded = await loadDefinition(serverKey);
      if (!loaded.ok) return loaded.response;
      return runScopedToolGet(deps, loaded.definition, loaded.backend);
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
      return runScopedToolRefresh(deps, loaded.definition, loaded.backend, {
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
    | { ok: true; definition: McpServerDefinition; backend: AgentBackendId }
    | { ok: false; response: Response }
  > {
    const projectPath = await deps.resolveProjectPath(params.name);
    if (!projectPath) {
      return { ok: false, response: jsonError("Project not found", 404) };
    }
    const discovery = await deps.discoverAllSources({
      worktreePath: projectPath,
      homePath: deps.homePath(),
    });
    const definition = discovery.servers.find(
      (s) => s.serverKey === params.serverKey,
    );
    if (!definition) {
      return { ok: false, response: jsonError("MCP server not found", 404) };
    }
    return {
      ok: true,
      definition,
      backend: resolveDefinitionBackend(definition),
    };
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as ProjectToolInventoryRouteParams;
      const loaded = await loadDefinition(params);
      if (!loaded.ok) return loaded.response;
      return runScopedToolGet(deps, loaded.definition, loaded.backend);
    } catch (err) {
      return handleUnexpected("tools.project.get", err);
    }
  }

  async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as ProjectToolInventoryRouteParams;
      const loaded = await loadDefinition(params);
      if (!loaded.ok) return loaded.response;
      return runScopedToolRefresh(deps, loaded.definition, loaded.backend, {
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
    | { ok: true; definition: McpServerDefinition; backend: AgentBackendId }
    | { ok: false; response: Response }
  > {
    const projectPath = await deps.resolveProjectPath(params.name);
    if (!projectPath) {
      return { ok: false, response: jsonError("Project not found", 404) };
    }
    const session = await deps.getSession(projectPath, params.session);
    if (!session) {
      return { ok: false, response: jsonError("Session not found", 404) };
    }
    const discovery = await deps.discoverAllSources({
      worktreePath: session.worktreePath,
      homePath: deps.homePath(),
    });
    const definition = discovery.servers.find(
      (s) => s.serverKey === params.serverKey,
    );
    if (!definition) {
      return { ok: false, response: jsonError("MCP server not found", 404) };
    }
    return {
      ok: true,
      definition,
      backend: resolveDefinitionBackend(definition),
    };
  }

  async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as SessionToolInventoryRouteParams;
      const loaded = await loadDefinition(params);
      if (!loaded.ok) return loaded.response;
      return runScopedToolGet(deps, loaded.definition, loaded.backend);
    } catch (err) {
      return handleUnexpected("tools.session.get", err);
    }
  }

  async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
    try {
      const params = (await ctx.params) as SessionToolInventoryRouteParams;
      const loaded = await loadDefinition(params);
      if (!loaded.ok) return loaded.response;
      return runScopedToolRefresh(deps, loaded.definition, loaded.backend, {
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
  const message = err instanceof Error ? err.message : String(err);
  log.error(`${label}.error`, { error: message });
  return jsonError(message, 500);
}
