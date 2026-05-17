import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/project-resolver";
import {
  AmbiguousDevServerError,
  DevServerStartFailedError,
  DevServerWaitTimeoutError,
  NoDevServersConfiguredError,
  SessionNotFoundError,
  UnknownDevServerError,
  ensureDevServer,
  listDevServers,
  stopDevServer,
  type DevServerService,
  type DevServerStatusItem,
} from "@/lib/dev-server-service";
import type {
  ApiError,
  DevServerRuntimeState,
  DevServersStatusResponse,
} from "@/types";

const logger = createLogger("dev-server-route");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export interface DevServerRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  service: DevServerService;
}

const defaultDeps: DevServerRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  service: {
    list: listDevServers,
    ensure: ensureDevServer,
    stop: stopDevServer,
  },
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
    source: item.source,
    ownedByThisSession: item.ownedByThisSession,
    worktreePath: item.worktreePath,
    ownerPid: item.ownerPid,
  };
}

function apiError(
  message: string,
  status: number,
  code?: string,
  output?: string,
): Response {
  const payload: ApiError = { error: message };
  if (code !== undefined) payload.code = code;
  if (output !== undefined) payload.output = output;
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

  return { GET, START, START_ALL };
}
