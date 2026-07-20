import { NextResponse } from "next/server";
import type { ApiError } from "@/lib/api/errors";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveCommandCenterProjectName } from "@/lib/projects/command-center-project";
import type { CommandCenterProjectResponse } from "@/lib/projects/schemas";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("tickets.routes.command-center-project");
const RESOLUTION_ERROR = "Failed to resolve the Command Center project";

export interface CommandCenterProjectRouteDeps {
  resolveProjectName(): Promise<string | null>;
}

export interface CommandCenterProjectRouteHandlers {
  GET(): Promise<Response>;
}

const defaultDeps: CommandCenterProjectRouteDeps = {
  resolveProjectName: resolveCommandCenterProjectName,
};

export function createCommandCenterProjectRouteHandlers(
  deps: CommandCenterProjectRouteDeps = defaultDeps,
): CommandCenterProjectRouteHandlers {
  return {
    async GET(): Promise<Response> {
      try {
        const projectName = await deps.resolveProjectName();
        logger.debug("tickets.routes.command_center_project_resolved", {
          projectName,
        });
        return NextResponse.json({
          projectName,
        } satisfies CommandCenterProjectResponse);
      } catch (error) {
        logger.error("tickets.routes.command_center_project_failed", {
          error: getErrorMessage(error),
        });
        return NextResponse.json(
          { error: RESOLUTION_ERROR } satisfies ApiError,
          { status: 500 },
        );
      }
    },
  };
}

const handlers = createCommandCenterProjectRouteHandlers();
export const getCommandCenterProject = withTracing(handlers.GET);
