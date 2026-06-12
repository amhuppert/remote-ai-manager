/**
 * Commands route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createCommandsRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getSession as defaultGetSession } from "@/lib/state-store";
import { discoverCommands as defaultDiscoverCommands } from "@/lib/commands/service";
import type { ApiError } from "@/lib/api/errors";
import type { CommandItem, CommandsResponse } from "@/lib/commands/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface CommandsRouteDeps {
  resolveProjectPath: (name: string) => Promise<string | null>;
  getSession: (
    projectPath: string,
    sessionName: string,
  ) => Promise<SessionState | null>;
  discoverCommands: (
    worktreePath: string,
    backend?: AgentBackendId,
  ) => Promise<CommandItem[]>;
}

const defaultDeps: CommandsRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  discoverCommands: defaultDiscoverCommands,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<Record<string, string>>;
};

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
    const requestedBackend = new URL(request.url).searchParams.get("backend");
    const backend: AgentBackendId =
      requestedBackend === "codex" ? "codex" : "claude";

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    try {
      const items = await deps.discoverCommands(session.worktreePath, backend);
      const response: CommandsResponse = { items };
      return NextResponse.json(response);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to discover commands";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  }

  return { GET };
}

// ---------------------------------------------------------------------------
// Project-scoped factory (resolves project root, not session worktree)
// ---------------------------------------------------------------------------

export interface ProjectCommandsRouteDeps {
  resolveProjectPath: (name: string) => Promise<string | null>;
  discoverCommands: (
    worktreePath: string,
    backend?: AgentBackendId,
  ) => Promise<CommandItem[]>;
}

const defaultProjectDeps: ProjectCommandsRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  discoverCommands: defaultDiscoverCommands,
};

export function createProjectCommandsRouteHandlers(
  deps: ProjectCommandsRouteDeps = defaultProjectDeps,
) {
  async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const requestedBackend = new URL(request.url).searchParams.get("backend");
    const backend: AgentBackendId =
      requestedBackend === "codex" ? "codex" : "claude";

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    try {
      const items = await deps.discoverCommands(projectPath, backend);
      const response: CommandsResponse = { items };
      return NextResponse.json(response);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to discover commands";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
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
