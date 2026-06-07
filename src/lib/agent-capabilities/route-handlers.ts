import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP,
  agentCapabilityCascadeKindSchema,
  agentCapabilityPatchRequestSchema,
  agentCapabilityRefreshRequestSchema,
  type AgentCapabilitiesDiscoveryUpdatedEvent,
  type AgentCapabilitiesUpdatedEvent,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityInventory,
  type AgentCapabilityInvalidationHints,
  type AgentCapabilityViewResponse,
} from "./schemas";

import type {
  MutationRequest,
  MutationResult,
  MutationScope,
} from "./mutation-service";
import {
  redactAgentCapabilityInventory,
  redactAgentCapabilityText,
  redactAgentCapabilityViewResponse,
} from "./redaction";

const logger = createLogger("agent-capabilities.routes");

interface RouteContext {
  params: Promise<Record<string, string>>;
}

export type CapabilityRouteScope =
  | { level: "global" }
  | { level: "project"; projectName: string; projectPath: string }
  | {
      level: "session";
      projectName: string;
      projectPath: string;
      sessionName: string;
    }
  | {
      level: "conversation";
      projectName: string;
      projectPath: string;
      conversationScope: "session";
      sessionName: string;
      conversationId: string;
    }
  | {
      level: "conversation";
      projectName: string;
      projectPath: string;
      conversationScope: "project";
      conversationId: string;
    };

export interface CapabilityRouteDeps {
  resolveView(input: {
    scope: CapabilityRouteScope;
    cascadeKind: AgentCapabilityCascadeKind;
  }): Promise<AgentCapabilityViewResponse>;
  mutate(input: MutationRequest): Promise<MutationResult>;
  refreshDiscovery(input: {
    scope: CapabilityRouteScope;
    cascadeKind: AgentCapabilityCascadeKind;
  }): Promise<{
    inventory: AgentCapabilityInventory;
    view: AgentCapabilityViewResponse;
  }>;
  resolveProjectPath?(projectName: string): Promise<string | null>;
  broadcast?(
    event:
      | AgentCapabilitiesUpdatedEvent
      | AgentCapabilitiesDiscoveryUpdatedEvent,
  ): void;
}

export class CapabilityRouteNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityRouteNotFoundError";
  }
}

export class CapabilityRoutePersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityRoutePersistenceError";
  }
}

export class CapabilityRouteDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityRouteDiscoveryError";
  }
}

export function createGlobalCapabilityHandlers(deps: CapabilityRouteDeps) {
  return createHandlers(deps, async () => ({ level: "global" }));
}

export function createProjectCapabilityHandlers(deps: CapabilityRouteDeps) {
  return createHandlers(deps, async (ctx) => {
    const params = await ctx.params;
    const projectName = requireParam(params, "name");
    const projectPath = await resolveProjectPathOrThrow(deps, projectName);
    return { level: "project", projectName, projectPath };
  });
}

export function createSessionCapabilityHandlers(deps: CapabilityRouteDeps) {
  return createHandlers(deps, async (ctx) => {
    const params = await ctx.params;
    const projectName = requireParam(params, "name");
    const sessionName = requirePublicSessionParam(params, "session");
    const projectPath = await resolveProjectPathOrThrow(deps, projectName);
    return { level: "session", projectName, projectPath, sessionName };
  });
}

export function createConversationCapabilityHandlers(
  deps: CapabilityRouteDeps,
) {
  return createHandlers(deps, async (ctx) => {
    const params = await ctx.params;
    const projectName = requireParam(params, "name");
    const sessionName = requirePublicSessionParam(params, "session");
    const conversationId = requireParam(params, "conversationId");
    const projectPath = await resolveProjectPathOrThrow(deps, projectName);
    return {
      level: "conversation",
      projectName,
      projectPath,
      conversationScope: "session",
      sessionName,
      conversationId,
    };
  });
}

export function createProjectConversationCapabilityHandlers(
  deps: CapabilityRouteDeps,
) {
  return createHandlers(deps, async (ctx) => {
    const params = await ctx.params;
    const projectName = requireParam(params, "name");
    const conversationId = requireParam(params, "conversationId");
    const projectPath = await resolveProjectPathOrThrow(deps, projectName);
    return {
      level: "conversation",
      projectName,
      projectPath,
      conversationScope: "project",
      conversationId,
    };
  });
}

function createHandlers(
  deps: CapabilityRouteDeps,
  resolveScope: (ctx: RouteContext) => Promise<CapabilityRouteScope>,
) {
  async function GET(request: Request, ctx: RouteContext = emptyContext()) {
    try {
      const scope = await resolveScope(ctx);
      const cascadeKind = parseCascadeFromQuery(request);
      if (!cascadeKind.ok) return cascadeKind.response;
      const view = redactAgentCapabilityViewResponse(
        await deps.resolveView({
          scope,
          cascadeKind: cascadeKind.data,
        }),
      );
      logger.info("route.get.resolved", {
        cascadeKind: cascadeKind.data,
        backend: AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP[cascadeKind.data],
        itemCount: view.items.length,
        diagnosticCount: view.diagnostics.length,
        effectiveHash: view.effectiveHash,
        ...scopeLogContext(scope),
      });
      return NextResponse.json({ view });
    } catch (err) {
      return handleRouteError("get", err);
    }
  }

  async function PATCH(request: Request, ctx: RouteContext = emptyContext()) {
    const parsed = await parseJsonBody(
      request,
      agentCapabilityPatchRequestSchema,
    );
    if (!parsed.ok) return parsed.response;

    try {
      const scope = await resolveScope(ctx);
      const result = await deps.mutate({
        scope: toMutationScope(scope),
        request: parsed.data,
      });

      if (result.status === "conflict") {
        const invalidationHints = buildInvalidationHints({
          scope,
          cascadeKind: result.cascadeKind,
          effectiveHash: result.latestView.effectiveHash,
          operationId: result.operationId,
        });
        logger.info("route.patch.conflict", {
          cascadeKind: result.cascadeKind,
          backend:
            AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP[result.cascadeKind],
          operationId: result.operationId,
          expectedHash: result.expectedHash,
          actualHash: result.actualHash,
          ...scopeLogContext(scope),
        });
        return NextResponse.json(
          {
            error: {
              code: "conflict",
              message: "Capability view hash is stale; refresh and retry.",
            },
            expectedHash: result.expectedHash,
            actualHash: result.actualHash,
            latestView: redactAgentCapabilityViewResponse(result.latestView),
            invalidationHints,
            operationId: result.operationId,
          },
          { status: 409 },
        );
      }

      const invalidationHints = buildInvalidationHints({
        scope,
        cascadeKind: result.cascadeKind,
        itemIds: [...result.changedItemIds],
        effectiveHash: result.effectiveHash,
        operationId: result.operationId,
      });
      logger.info("route.patch.applied", {
        cascadeKind: result.cascadeKind,
        backend: AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP[result.cascadeKind],
        operationId: result.operationId,
        changedCount: result.changedItemIds.length,
        effectiveHash: result.effectiveHash,
        ...scopeLogContext(scope),
      });
      deps.broadcast?.(
        buildUpdatedEvent({
          scope,
          cascadeKind: result.cascadeKind,
          changedItemIds: [...result.changedItemIds],
          effectiveHash: result.effectiveHash,
          invalidationHints,
          operationId: result.operationId,
        }),
      );

      return NextResponse.json({
        view: redactAgentCapabilityViewResponse(result.view),
        effectiveHash: result.effectiveHash,
        changedItemIds: [...result.changedItemIds],
        invalidationHints,
        operationId: result.operationId,
      });
    } catch (err) {
      return handleRouteError("patch", err);
    }
  }

  async function POST(request: Request, ctx: RouteContext = emptyContext()) {
    const parsed = await parseJsonBody(
      request,
      agentCapabilityRefreshRequestSchema,
    );
    if (!parsed.ok) return parsed.response;

    try {
      const scope = await resolveScope(ctx);
      const refreshed = await deps.refreshDiscovery({
        scope,
        cascadeKind: parsed.data.cascadeKind,
      });
      const inventory = redactAgentCapabilityInventory(refreshed.inventory);
      const view = redactAgentCapabilityViewResponse(refreshed.view);
      const invalidationHints = buildInvalidationHints({
        scope,
        cascadeKind: parsed.data.cascadeKind,
        refreshDiscovery: true,
        sourceSignature: inventory.sourceSignature,
      });
      logger.info("route.refresh.completed", {
        cascadeKind: parsed.data.cascadeKind,
        backend:
          AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP[parsed.data.cascadeKind],
        sourceSignature: inventory.sourceSignature,
        itemCount: inventory.items.length,
        diagnosticCount: inventory.diagnostics.length,
        ...scopeLogContext(scope),
      });
      deps.broadcast?.(
        buildDiscoveryEvent({
          scope,
          cascadeKind: parsed.data.cascadeKind,
          refreshedAt: inventory.refreshedAt,
          sourceSignature: inventory.sourceSignature,
          invalidationHints,
        }),
      );
      return NextResponse.json({ inventory, view, invalidationHints });
    } catch (err) {
      return handleRouteError("refresh", err);
    }
  }

  return { GET, PATCH, POST };
}

function emptyContext(): RouteContext {
  return { params: Promise.resolve({}) };
}

function requireParam(params: Record<string, string>, key: string): string {
  const value = params[key];
  if (!value) {
    throw new CapabilityRouteNotFoundError(`Missing route parameter: ${key}`);
  }
  return value;
}

function requirePublicSessionParam(
  params: Record<string, string>,
  key: string,
): string {
  const value = requireParam(params, key);
  if (isProjectSentinel(value)) {
    throw new CapabilityRouteNotFoundError(
      "Project conversation capability routes use the project conversation route shape",
    );
  }
  return value;
}

async function resolveProjectPathOrThrow(
  deps: CapabilityRouteDeps,
  projectName: string,
): Promise<string> {
  if (!deps.resolveProjectPath) {
    throw new CapabilityRouteNotFoundError(
      "Project resolution is not configured for this route",
    );
  }
  const projectPath = await deps.resolveProjectPath(projectName);
  if (!projectPath) {
    throw new CapabilityRouteNotFoundError(
      `Project "${projectName}" not found`,
    );
  }
  return projectPath;
}

function parseCascadeFromQuery(
  request: Request,
):
  | { ok: true; data: AgentCapabilityCascadeKind }
  | { ok: false; response: Response } {
  const url = new URL(request.url);
  const raw = url.searchParams.get("cascadeKind");
  const parsed = agentCapabilityCascadeKindSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: structuredError(
        "validation_error",
        "Query parameter cascadeKind is required and must be a supported capability cascade.",
        400,
        parsed.error.issues,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

async function parseJsonBody<T>(
  request: Request,
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: ZodError };
  },
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: structuredError(
        "validation_error",
        "Request body must be valid JSON.",
        400,
      ),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: structuredError(
        "validation_error",
        "Request body failed capability schema validation.",
        400,
        parsed.error.issues,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

function toMutationScope(scope: CapabilityRouteScope): MutationScope {
  switch (scope.level) {
    case "global":
      return { level: "global" };
    case "project":
      return { level: "project", projectPath: scope.projectPath };
    case "session":
      return {
        level: "session",
        projectPath: scope.projectPath,
        sessionName: scope.sessionName,
      };
    case "conversation":
      if (scope.conversationScope === "project") {
        return {
          level: "conversation",
          projectPath: scope.projectPath,
          conversationScope: "project",
          conversationId: scope.conversationId,
        };
      }
      return {
        level: "conversation",
        projectPath: scope.projectPath,
        sessionName: scope.sessionName,
        conversationId: scope.conversationId,
      };
  }
}

function buildInvalidationHints(input: {
  scope: CapabilityRouteScope;
  cascadeKind: AgentCapabilityCascadeKind;
  itemIds?: string[];
  effectiveHash?: string;
  refreshDiscovery?: boolean;
  sourceSignature?: string;
  operationId?: string;
}): AgentCapabilityInvalidationHints {
  return {
    level: input.scope.level,
    ...scopeNames(input.scope),
    cascadeKind: input.cascadeKind,
    ...(input.itemIds !== undefined ? { itemIds: input.itemIds } : {}),
    ...(input.effectiveHash !== undefined
      ? { effectiveHash: input.effectiveHash }
      : {}),
    ...(input.refreshDiscovery !== undefined
      ? { refreshDiscovery: input.refreshDiscovery }
      : {}),
    ...(input.sourceSignature !== undefined
      ? { sourceSignature: input.sourceSignature }
      : {}),
    ...(input.operationId !== undefined
      ? { operationId: input.operationId }
      : {}),
  };
}

function buildUpdatedEvent(input: {
  scope: CapabilityRouteScope;
  cascadeKind: AgentCapabilityCascadeKind;
  changedItemIds: string[];
  effectiveHash: string;
  invalidationHints: AgentCapabilityInvalidationHints;
  operationId?: string;
}): AgentCapabilitiesUpdatedEvent {
  return {
    type: "agent-capabilities-updated",
    level: input.scope.level,
    ...scopeNames(input.scope),
    cascadeKind: input.cascadeKind,
    backend: AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP[input.cascadeKind],
    changedItemIds: input.changedItemIds,
    effectiveHash: input.effectiveHash,
    ...(input.operationId !== undefined
      ? { operationId: input.operationId }
      : {}),
    invalidationHints: input.invalidationHints,
  };
}

function buildDiscoveryEvent(input: {
  scope: CapabilityRouteScope;
  cascadeKind: AgentCapabilityCascadeKind;
  refreshedAt: string;
  sourceSignature: string;
  invalidationHints: AgentCapabilityInvalidationHints;
}): AgentCapabilitiesDiscoveryUpdatedEvent {
  return {
    type: "agent-capabilities-discovery-updated",
    level: input.scope.level,
    ...scopeNames(input.scope),
    cascadeKind: input.cascadeKind,
    backend: AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP[input.cascadeKind],
    refreshedAt: input.refreshedAt,
    sourceSignature: input.sourceSignature,
    invalidationHints: input.invalidationHints,
  };
}

function scopeNames(scope: CapabilityRouteScope): {
  projectName?: string;
  conversationScope?: "session" | "project";
  sessionName?: string;
  conversationId?: string;
} {
  if (scope.level === "global") return {};
  if (scope.level === "project") return { projectName: scope.projectName };
  if (scope.level === "session") {
    return { projectName: scope.projectName, sessionName: scope.sessionName };
  }
  return {
    projectName: scope.projectName,
    conversationScope: scope.conversationScope,
    ...(scope.conversationScope === "session"
      ? { sessionName: scope.sessionName }
      : {}),
    conversationId: scope.conversationId,
  };
}

function scopeLogContext(scope: CapabilityRouteScope): Record<string, string> {
  if (scope.level === "global") return { level: "global" };
  if (scope.level === "project") {
    return {
      level: "project",
      projectName: scope.projectName,
      projectPath: scope.projectPath,
    };
  }
  if (scope.level === "session") {
    return {
      level: "session",
      projectName: scope.projectName,
      projectPath: scope.projectPath,
      sessionName: scope.sessionName,
    };
  }
  return {
    level: "conversation",
    projectName: scope.projectName,
    projectPath: scope.projectPath,
    conversationScope: scope.conversationScope,
    ...(scope.conversationScope === "session"
      ? { sessionName: scope.sessionName }
      : {}),
    conversationId: scope.conversationId,
  };
}

function handleRouteError(operation: string, err: unknown): Response {
  if (err instanceof CapabilityRouteNotFoundError) {
    return structuredError(
      "not_found",
      redactAgentCapabilityText(err.message),
      404,
    );
  }
  if (err instanceof CapabilityRouteDiscoveryError) {
    logger.warn(`route.${operation}.discovery_failed`, {
      error: redactAgentCapabilityText(err.message),
    });
    return structuredError(
      "discovery_error",
      redactAgentCapabilityText(err.message),
      500,
    );
  }
  if (err instanceof CapabilityRoutePersistenceError) {
    logger.error(`route.${operation}.persistence_failed`, {
      error: redactAgentCapabilityText(err.message),
    });
    return structuredError(
      "persistence_error",
      redactAgentCapabilityText(err.message),
      500,
    );
  }
  if (isScopedResourceNotFoundError(err)) {
    return structuredError(
      "not_found",
      redactAgentCapabilityText(getErrorMessage(err)),
      404,
    );
  }
  logger.error(`route.${operation}.failed`, {
    error: redactAgentCapabilityText(getErrorMessage(err)),
  });
  return structuredError(
    "persistence_error",
    redactAgentCapabilityText(getErrorMessage(err)),
    500,
  );
}

function isScopedResourceNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /^(Project|Session|Conversation) ".+" not found\b/.test(err.message);
}

function structuredError(
  code:
    | "validation_error"
    | "not_found"
    | "conflict"
    | "persistence_error"
    | "discovery_error",
  message: string,
  status: number,
  issues?: ZodError["issues"],
): Response {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(issues !== undefined ? { issues } : {}),
      },
    },
    { status },
  );
}
