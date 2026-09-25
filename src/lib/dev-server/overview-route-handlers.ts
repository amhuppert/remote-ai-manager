import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  jsonError,
  notFound,
  parseJsonBody,
  resolveProjectOr404,
} from "@/lib/shared/route-resolution";
import {
  PROJECT_CONVERSATION_SESSION_SENTINEL,
  isProjectSentinel,
} from "@/lib/conversations/project-conversation-scope";
import { discoverProjects } from "@/lib/projects/discovery";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import { createDevServerOverview, type DevServerOverview } from "./overview";
import {
  getAllServers,
  getServer as defaultGetServer,
  stopServer as defaultStopServer,
} from "./registry";
import { listDevServers } from "./service";
import {
  stopDevServerInstanceRequestSchema,
  type DevServerOverviewResponse,
} from "./schemas";

const logger = createLogger("dev-server-overview-route");

export interface DevServerOverviewRouteDeps {
  overview: DevServerOverview;
  resolveProjectPath(name: string): Promise<string | null>;
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

export function createDevServerOverviewRouteHandlers(
  deps: DevServerOverviewRouteDeps,
) {
  async function GET(): Promise<Response> {
    try {
      return NextResponse.json(
        (await deps.overview.read()) satisfies DevServerOverviewResponse,
      );
    } catch (error) {
      logger.warn("dev-server.route.overview.error", {
        error: getErrorMessage(error),
      });
      return jsonError(getErrorMessage(error), 500);
    }
  }

  /**
   * Stop one registered instance by its exact identity. The overview lists
   * session, lane, and project-root instances side by side, and a lane has
   * no session route that can address it once its workflow context is gone,
   * so the overview stops each row through the identity it was listed with.
   */
  async function STOP_INSTANCE(request: Request): Promise<Response> {
    const body = await parseJsonBody(
      request,
      stopDevServerInstanceRequestSchema,
      "Invalid request: projectName, sessionName (string or null), worktreePath, and serverName are required",
    );
    if (!body.ok) return body.response;
    const { projectName, worktreePath, serverName } = body.value;
    if (
      body.value.sessionName !== null &&
      isProjectSentinel(body.value.sessionName)
    ) {
      return notFound(
        `Session "${body.value.sessionName}" not found`,
        "SESSION_NOT_FOUND",
      );
    }
    const sessionName =
      body.value.sessionName ?? PROJECT_CONVERSATION_SESSION_SENTINEL;
    const project = await resolveProjectOr404(deps, projectName);
    if (!project.ok) return project.response;

    const instance = {
      projectPath: project.value,
      sessionName,
      worktreePath,
      serverName,
    };
    const existing = deps.getServer(instance);
    if (
      !existing ||
      (existing.status !== "running" && existing.status !== "starting")
    ) {
      return notFound(`Server "${serverName}" is not running`);
    }

    logger.info("dev-server.route.stop_instance", {
      projectName,
      sessionName,
      worktreePath,
      serverName,
    });
    await deps.stopServer(instance);
    return NextResponse.json({ status: "ok" });
  }

  return { GET, STOP_INSTANCE };
}

const defaultOverview = createDevServerOverview({
  async listProjects() {
    return (await discoverProjects()).filter((project) => !project.missing);
  },
  listProjectRootServers: (projectPath) =>
    listDevServers({
      projectPath,
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
    }),
  listRegisteredServers: getAllServers,
  async getSessionWorktree(projectPath, sessionName) {
    return (await getSession(projectPath, sessionName))?.worktreePath ?? null;
  },
});

const defaultHandlers = createDevServerOverviewRouteHandlers({
  overview: defaultOverview,
  resolveProjectPath: defaultResolveProjectPath,
  getServer: defaultGetServer,
  stopServer: defaultStopServer,
});

/** GET /api/dev-servers — every project's dev servers, across sessions */
export const GET = withTracing(defaultHandlers.GET);

/** POST /api/dev-servers/stop — stop one listed instance */
export const STOP_INSTANCE = withTracing(defaultHandlers.STOP_INSTANCE);
