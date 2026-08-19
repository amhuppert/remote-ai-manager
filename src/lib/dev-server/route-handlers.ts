import { NextResponse } from "next/server";
import { z } from "zod";
import {
  notFound,
  resolveProjectOr404,
  resolveProjectSessionOr404,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
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
  awaitReadyDevServer,
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
import {
  DevServerTargetError,
  devServerTargetResolver,
  parseDevServerTarget,
  type DevServerTargetResolver,
  type ResolvedDevServerTarget,
} from "./target-resolver";
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
  targetResolver: DevServerTargetResolver;
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
  targetResolver: devServerTargetResolver,
  service: {
    list: listDevServers,
    ensure: ensureDevServer,
    awaitReady: awaitReadyDevServer,
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
    return notFound(error.message, error.code);
  }
  if (error instanceof NoDevServersConfiguredError) {
    return apiError(error.message, 400, error.code);
  }
  if (error instanceof UnknownDevServerError) {
    return notFound(error.message, error.code);
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

function targetErrorResponse(error: DevServerTargetError): Response {
  const payload: ApiError & { instruction?: string } = {
    error: error.message,
    code: error.code,
  };
  if (error.instruction !== undefined) {
    payload.instruction = error.instruction;
  }
  return NextResponse.json(payload, { status: error.status });
}

const stopUnmanagedRequestSchema = z.object({
  port: z.number().int().positive(),
});

export function createDevServerRouteHandlers(
  deps: DevServerRouteDeps = defaultDeps,
) {
  async function resolveTarget(
    request: Request,
    input: {
      projectName: string;
      projectPath: string;
      sessionName: string;
    },
  ): Promise<RouteResolution<ResolvedDevServerTarget>> {
    try {
      const target = parseDevServerTarget(request);
      return {
        ok: true,
        value: await deps.targetResolver.resolve({ ...input, target }),
      };
    } catch (error) {
      if (!(error instanceof DevServerTargetError)) throw error;
      if (error.code === "INVALID_DEV_SERVER_TARGET") {
        logger.warn("dev-server.target.rejected", {
          projectName: input.projectName,
          sessionName: input.sessionName,
          targetKind: "workflow-context",
          executionId: null,
          contextId: null,
          code: error.code,
        });
      }
      return { ok: false, response: targetErrorResponse(error) };
    }
  }

  async function GET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = decodeURIComponent(params["session"] ?? "");
    const project = await resolveProjectOr404(deps, projectName);
    if (!project.ok) return project.response;

    try {
      const target = await resolveTarget(request, {
        projectName,
        projectPath: project.value,
        sessionName,
      });
      if (!target.ok) return target.response;
      const servers = await deps.service.list({
        projectPath: project.value,
        sessionName,
        worktreePath: target.value.worktreePath,
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
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = decodeURIComponent(params["session"] ?? "");
    const serverName = decodeURIComponent(params["serverName"] ?? "");
    const project = await resolveProjectOr404(deps, projectName);
    if (!project.ok) return project.response;

    try {
      const target = await resolveTarget(request, {
        projectName,
        projectPath: project.value,
        sessionName,
      });
      if (!target.ok) return target.response;
      const server = await deps.service.ensure({
        projectPath: project.value,
        sessionName,
        serverName,
        wait: false,
        worktreePath: target.value.worktreePath,
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
    const project = await resolveProjectOr404(deps, projectName);
    if (!project.ok) return project.response;

    try {
      const servers = await deps.service.list({
        projectPath: project.value,
        sessionName,
      });
      if (servers.length === 0) {
        return apiError("No dev servers configured for this project", 400);
      }

      // Each server's acceptance work is independent, so they run concurrently:
      // one server's port selection and spawn must not add its latency to the
      // next server's, and a server that refuses to start must not stop the
      // others from being accepted.
      const settled = await Promise.allSettled(
        servers
          .filter(
            (server) =>
              server.status !== "running" && server.status !== "starting",
          )
          .map((server) =>
            deps.service.ensure({
              projectPath: project.value,
              sessionName,
              serverName: server.serverName,
              wait: false,
            }),
          ),
      );

      for (const outcome of settled) {
        if (outcome.status === "rejected") throw outcome.reason;
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
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = params["session"] ?? "";
    const serverName = params["serverName"] ?? "";
    const project = await resolveProjectOr404(deps, projectName);
    if (!project.ok) return project.response;

    try {
      const target = await resolveTarget(request, {
        projectName,
        projectPath: project.value,
        sessionName,
      });
      if (!target.ok) return target.response;
      const existing = deps.getServer({
        projectPath: project.value,
        sessionName,
        worktreePath: target.value.worktreePath,
        serverName,
      });
      if (
        !existing ||
        (existing.status !== "running" && existing.status !== "starting")
      ) {
        return notFound(`Server "${serverName}" is not running`);
      }

      await deps.stopServer({
        projectPath: project.value,
        sessionName,
        worktreePath: target.value.worktreePath,
        serverName,
      });
      return NextResponse.json({ status: "ok" });
    } catch (error) {
      logger.warn("dev-server.route.stop.error", {
        projectName,
        sessionName,
        serverName,
        error: getErrorMessage(error),
      });
      return serviceErrorResponse(error);
    }
  }

  async function STOP_ALL(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const projectName = params["name"] ?? "";
    const sessionName = params["session"] ?? "";
    const resolved = await resolveProjectSessionOr404(
      deps,
      projectName,
      sessionName,
    );
    if (!resolved.ok) return resolved.response;

    await deps.stopAllForSession({
      projectPath: resolved.value.projectPath,
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
    const project = await resolveProjectOr404(deps, projectName);
    if (!project.ok) return project.response;

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
        projectPath: project.value,
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
