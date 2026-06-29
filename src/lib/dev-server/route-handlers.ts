import { NextResponse } from "next/server";
import { z } from "zod";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getSession as defaultGetSession } from "@/lib/state-store";
import {
  AmbiguousDevServerError,
  DevServerStartFailedError,
  DevServerWaitTimeoutError,
  NoDevServersConfiguredError,
  SessionNotFoundError,
  UnknownDevServerError,
  UnmanagedDevServerDetectedError,
  ensureDevServer,
  listDevServers,
  stopDevServer,
  stopUnmanagedDevServer,
  type DevServerService,
  type DevServerStatusItem,
} from "./service";
import {
  getServer as defaultGetServer,
  stopAllForSession as defaultStopAllForSession,
  stopServer as defaultStopServer,
} from "./registry";
import type { ApiError } from "@/lib/api/errors";
import type {
  DevServerRuntimeState,
  DevServersStatusResponse,
} from "@/lib/dev-server/schemas";
const logger = createLogger("dev-server-route");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface DevServerRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ worktreePath: string } | null>;
  service: DevServerService;
  stopAllForSession(params: {
    projectPath: string;
    sessionName: string;
  }): Promise<void>;
  getServer(params: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    serverName: string;
  }): { status: string } | undefined;
  stopServer(params: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    serverName: string;
  }): Promise<void>;
}

const defaultDeps: DevServerRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  service: {
    list: listDevServers,
    ensure: ensureDevServer,
    stop: stopDevServer,
    stopUnmanaged: stopUnmanagedDevServer,
  },
  stopAllForSession: defaultStopAllForSession,
  getServer: defaultGetServer,
  stopServer: defaultStopServer,
};

function toRuntimeState(item: DevServerStatusItem): DevServerRuntimeState {
  return {
    serverName: item.serverName,
    command: item.command,
    status: item.status,
    port: item.port,
    remoteUrl: item.remoteUrl,
    startedAt: item.startedAt,
    errorMessage: item.errorMessage,
    recentOutput: item.recentOutput,
    ownedByThisSession: item.ownedByThisSession,
    worktreePath: item.worktreePath,
    ownerPid: item.ownerPid,
    logFilePath: item.logFilePath,
  };
}

function apiError(
  message: string,
  status: number,
  code?: string,
  output?: string,
  details?: Record<string, unknown>,
): Response {
  const payload: ApiError = { error: message };
  if (code !== undefined) payload.code = code;
  if (output !== undefined) payload.output = output;
  if (details !== undefined) payload.details = details;
  return NextResponse.json(payload, { status });
}

function serviceErrorResponse(error: unknown): Response {
  if (error instanceof SessionNotFoundError) {
    return apiError(error.message, 404, error.code);
  }
  if (error instanceof NoDevServersConfiguredError) {
    return apiError(error.message, 400, error.code);
  }
  if (error instanceof UnknownDevServerError) {
    return apiError(error.message, 404, error.code);
  }
  if (error instanceof AmbiguousDevServerError) {
    return apiError(error.message, 400, error.code);
  }
  if (error instanceof DevServerWaitTimeoutError) {
    return apiError(error.message, 504, error.code);
  }
  if (error instanceof UnmanagedDevServerDetectedError) {
    return apiError(error.message, 409, error.code, undefined, {
      serverName: error.serverName,
      port: error.port,
      pid: error.pid,
      cwd: error.cwd,
    });
  }
  if (error instanceof DevServerStartFailedError) {
    return apiError(
      error.message,
      500,
      error.code,
      error.recentOutput.join("\n"),
    );
  }
  return apiError(getErrorMessage(error), 500);
}

const stopUnmanagedRequestSchema = z.object({
  port: z.number().int().positive(),
});

async function resolveProjectOr404(
  deps: DevServerRouteDeps,
  projectName: string,
): Promise<{ projectPath: string } | Response> {
  const projectPath = await deps.resolveProjectPath(projectName);
  if (!projectPath) {
    return apiError("Project not found", 404);
  }
  return { projectPath };
}

async function resolveProjectAndSessionOr404(
  deps: DevServerRouteDeps,
  projectName: string,
  sessionName: string,
): Promise<{ projectPath: string; worktreePath: string } | Response> {
  const resolved = await resolveProjectOr404(deps, projectName);
  if (resolved instanceof Response) return resolved;
  const sessionState = await deps.getSession(resolved.projectPath, sessionName);
  if (!sessionState) {
    return apiError("Session not found", 404);
  }
  return {
    projectPath: resolved.projectPath,
    worktreePath: sessionState.worktreePath,
  };
}

export function createDevServerRouteHandlers(
  deps: DevServerRouteDeps = defaultDeps,
) {
  async function GET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = decodeURIComponent(params["session"] ?? "");
    const resolved = await resolveProjectOr404(deps, projectName);
    if (resolved instanceof Response) return resolved;

    try {
      const servers = await deps.service.list({
        projectPath: resolved.projectPath,
        sessionName,
      });
      return NextResponse.json({
        servers: servers.map(toRuntimeState),
      } satisfies DevServersStatusResponse);
    } catch (error) {
      logger.warn("dev-server.route.list.error", {
        projectName,
        sessionName,
        error: getErrorMessage(error),
      });
      return serviceErrorResponse(error);
    }
  }

  async function START(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = decodeURIComponent(params["session"] ?? "");
    const serverName = decodeURIComponent(params["serverName"] ?? "");
    const resolved = await resolveProjectOr404(deps, projectName);
    if (resolved instanceof Response) return resolved;

    try {
      const server = await deps.service.ensure({
        projectPath: resolved.projectPath,
        sessionName,
        serverName,
        wait: false,
      });
      return NextResponse.json(
        { status: "accepted", server: toRuntimeState(server) },
        { status: 202 },
      );
    } catch (error) {
      logger.warn("dev-server.route.start.error", {
        projectName,
        sessionName,
        serverName,
        error: getErrorMessage(error),
      });
      return serviceErrorResponse(error);
    }
  }

  async function START_ALL(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = decodeURIComponent(params["session"] ?? "");
    const resolved = await resolveProjectOr404(deps, projectName);
    if (resolved instanceof Response) return resolved;

    try {
      const servers = await deps.service.list({
        projectPath: resolved.projectPath,
        sessionName,
      });
      if (servers.length === 0) {
        return apiError("No dev servers configured for this project", 400);
      }

      for (const server of servers) {
        if (server.status === "running" || server.status === "starting") {
          continue;
        }

        await deps.service.ensure({
          projectPath: resolved.projectPath,
          sessionName,
          serverName: server.serverName,
          wait: false,
        });
      }

      return NextResponse.json({ status: "accepted" }, { status: 202 });
    } catch (error) {
      logger.warn("dev-server.route.start_all.error", {
        projectName,
        sessionName,
        error: getErrorMessage(error),
      });
      return serviceErrorResponse(error);
    }
  }

  async function STOP(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = params["session"] ?? "";
    const serverName = params["serverName"] ?? "";
    const resolved = await resolveProjectAndSessionOr404(
      deps,
      projectName,
      sessionName,
    );
    if (resolved instanceof Response) return resolved;

    const existing = deps.getServer({
      projectPath: resolved.projectPath,
      sessionName,
      worktreePath: resolved.worktreePath,
      serverName,
    });
    if (
      !existing ||
      (existing.status !== "running" && existing.status !== "starting")
    ) {
      return apiError(`Server "${serverName}" is not running`, 404);
    }

    await deps.stopServer({
      projectPath: resolved.projectPath,
      sessionName,
      worktreePath: resolved.worktreePath,
      serverName,
    });
    return NextResponse.json({ status: "ok" });
  }

  async function STOP_ALL(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = params["session"] ?? "";
    const resolved = await resolveProjectAndSessionOr404(
      deps,
      projectName,
      sessionName,
    );
    if (resolved instanceof Response) return resolved;

    await deps.stopAllForSession({
      projectPath: resolved.projectPath,
      sessionName,
    });
    return NextResponse.json({ status: "ok" });
  }

  async function STOP_UNMANAGED(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = decodeURIComponent(params["session"] ?? "");
    const serverName = decodeURIComponent(params["serverName"] ?? "");
    const resolved = await resolveProjectOr404(deps, projectName);
    if (resolved instanceof Response) return resolved;

    const body = (await request.json().catch(() => ({}))) as {
      port?: number;
    };
    const parsed = stopUnmanagedRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(
        "Invalid request: port (positive integer) is required",
        400,
      );
    }

    try {
      const result = await deps.service.stopUnmanaged({
        projectPath: resolved.projectPath,
        sessionName,
        serverName,
        port: parsed.data.port,
      });
      if (result.killed.length === 0 && result.skipped.length > 0) {
        return apiError(
          `Could not verify ownership of listener on port ${parsed.data.port}; refused to signal it.`,
          409,
          "UNMANAGED_OWNERSHIP_UNVERIFIED",
          undefined,
          { skipped: result.skipped, port: parsed.data.port },
        );
      }
      return NextResponse.json({
        status: "ok",
        killed: result.killed,
        skipped: result.skipped,
      });
    } catch (error) {
      logger.warn("dev-server.route.stop_unmanaged.error", {
        projectName,
        sessionName,
        serverName,
        error: getErrorMessage(error),
      });
      return serviceErrorResponse(error);
    }
  }

  return { GET, START, START_ALL, STOP, STOP_ALL, STOP_UNMANAGED };
}

const defaultHandlers = createDevServerRouteHandlers();

/** GET /api/projects/[name]/sessions/[session]/dev-servers — list dev server status */
export const GET = withTracing(defaultHandlers.GET);

/** POST /api/projects/[name]/sessions/[session]/dev-servers/[serverName]/start */
export const START = withTracing(defaultHandlers.START);

/** POST /api/projects/[name]/sessions/[session]/dev-servers/start-all */
export const START_ALL = withTracing(defaultHandlers.START_ALL);

/** POST /api/projects/[name]/sessions/[session]/dev-servers/[serverName]/stop */
export const STOP = withTracing(defaultHandlers.STOP);

/** POST /api/projects/[name]/sessions/[session]/dev-servers/stop-all */
export const STOP_ALL = withTracing(defaultHandlers.STOP_ALL);

/** POST /api/projects/[name]/sessions/[session]/dev-servers/[serverName]/stop-unmanaged */
export const STOP_UNMANAGED = withTracing(defaultHandlers.STOP_UNMANAGED);
