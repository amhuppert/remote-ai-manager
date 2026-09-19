/**
 * Commands route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createCommandsRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import {
  resolveProjectOr404,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getSession as defaultGetSession } from "@/lib/state-store";
import { discoverScopedCommands } from "./scoped-discovery";
import {
  CapabilityRouteNotFoundError,
  type CapabilityRouteScope,
} from "@/lib/agent-capabilities/route-handlers";
import type { ApiError } from "@/lib/api/errors";
import type { CommandItem, CommandsResponse } from "@/lib/commands/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import {
  agentBackendSchema,
  DEFAULT_AGENT_BACKEND_ID,
  type AgentBackendId,
} from "@/lib/shared/schemas";
// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface CommandsRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  discoverCommands(
    worktreePath: string,
    backend: AgentBackendId,
    scope: CapabilityRouteScope,
  ): Promise<CommandItem[]>;
}

const defaultDeps: CommandsRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  discoverCommands: discoverScopedCommands,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Backend query parsing
// ---------------------------------------------------------------------------

/**
 * Resolves the `backend` query parameter. An absent value keeps the existing
 * default; a present value must be a canonical backend. An unrecognized value
 * is a client error rather than a silent fall back to the default, so a caller
 * asking for a backend Command Center does not support never receives another
 * backend's commands. The message names the parameter and the accepted values
 * without echoing the rejected input.
 */
function parseBackendFromQuery(
  request: Request,
): { ok: true; backend: AgentBackendId } | { ok: false; response: Response } {
  const requested = new URL(request.url).searchParams.get("backend");
  if (requested === null) {
    return { ok: true, backend: DEFAULT_AGENT_BACKEND_ID };
  }

  const parsed = agentBackendSchema.safeParse(requested);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `Query parameter backend must be one of: ${agentBackendSchema.options.join(", ")}`,
          code: "INVALID_BACKEND",
        } satisfies ApiError,
        { status: 400 },
      ),
    };
  }
  return { ok: true, backend: parsed.data };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCommandsRouteHandlers(
  deps: CommandsRouteDeps = defaultDeps,
) {
  async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const requestedBackend = parseBackendFromQuery(request);
    if (!requestedBackend.ok) return requestedBackend.response;
    const backend = requestedBackend.backend;

    const resolved = await resolveProjectSessionOr404(deps, name, sessionName);
    if (!resolved.ok) return resolved.response;
    const { session, projectPath } = resolved.value;
    const conversationId = new URL(request.url).searchParams.get(
      "conversationId",
    );
    const scope: CapabilityRouteScope =
      conversationId !== null
        ? {
            level: "conversation",
            projectName: name,
            projectPath,
            conversationScope: "session",
            sessionName,
            conversationId,
          }
        : { level: "session", projectName: name, projectPath, sessionName };

    try {
      const items = await deps.discoverCommands(
        session.worktreePath,
        backend,
        scope,
      );
      const response: CommandsResponse = { items };
      return NextResponse.json(response);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to discover commands";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: err instanceof CapabilityRouteNotFoundError ? 404 : 500,
      });
    }
  }

  return { GET };
}

// ---------------------------------------------------------------------------
// Project-scoped factory (resolves project root, not session worktree)
// ---------------------------------------------------------------------------

export interface ProjectCommandsRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  discoverCommands(
    worktreePath: string,
    backend: AgentBackendId,
    scope: CapabilityRouteScope,
  ): Promise<CommandItem[]>;
}

const defaultProjectDeps: ProjectCommandsRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  discoverCommands: discoverScopedCommands,
};

export function createProjectCommandsRouteHandlers(
  deps: ProjectCommandsRouteDeps = defaultProjectDeps,
) {
  async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const requestedBackend = parseBackendFromQuery(request);
    if (!requestedBackend.ok) return requestedBackend.response;
    const backend = requestedBackend.backend;

    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;
    const conversationId = new URL(request.url).searchParams.get(
      "conversationId",
    );
    const scope: CapabilityRouteScope =
      conversationId !== null
        ? {
            level: "conversation",
            projectName: name,
            projectPath,
            conversationScope: "project",
            conversationId,
          }
        : { level: "project", projectName: name, projectPath };

    try {
      const items = await deps.discoverCommands(projectPath, backend, scope);
      const response: CommandsResponse = { items };
      return NextResponse.json(response);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to discover commands";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: err instanceof CapabilityRouteNotFoundError ? 404 : 500,
      });
    }
  }

  return { GET };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultCommandsHandlers = createCommandsRouteHandlers();
export const discoverSessionCommands = withTracing(
  _defaultCommandsHandlers.GET,
);

const _defaultProjectCommandsHandlers = createProjectCommandsRouteHandlers();
export const discoverProjectCommands = withTracing(
  _defaultProjectCommandsHandlers.GET,
);
