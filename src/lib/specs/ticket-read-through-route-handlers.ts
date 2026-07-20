import { NextResponse } from "next/server";

import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
} from "@/lib/shared/route-resolution";
import { parseTicketNumberSegment } from "@/lib/tickets/ticket-number";

import {
  LinksServiceError,
  type LinkedSpecReadThrough,
  type TicketReadThroughInput,
} from "./links-service";

const logger = createLogger("specs.ticket-read-through-routes");

export type TicketReadThroughRouteContext = {
  params: Promise<Record<string, string>>;
};

export interface TicketReadThroughReader {
  getTicketReadThrough(input: TicketReadThroughInput): Promise<{
    readonly specs: LinkedSpecReadThrough[];
  }>;
}

export interface TicketReadThroughRouteDeps {
  resolveProjectPath(projectName: string): Promise<string | null>;
  getLinksService(projectPath: string): Promise<TicketReadThroughReader>;
}

async function loadLinksService(
  projectPath: string,
): Promise<TicketReadThroughReader> {
  const { createProductionSpecRouteServices } =
    await import("./service-factory");
  return (await createProductionSpecRouteServices(projectPath)).links;
}

function defaultDeps(): TicketReadThroughRouteDeps {
  return {
    resolveProjectPath,
    getLinksService: loadLinksService,
  };
}

export function createTicketReadThroughRouteHandlers(
  deps: TicketReadThroughRouteDeps = defaultDeps(),
) {
  return {
    async GET(
      _request: Request,
      context: TicketReadThroughRouteContext,
    ): Promise<Response> {
      const params = await context.params;
      const projectName = params["name"] ?? "";
      const number = parseTicketNumberSegment(params["number"] ?? "");
      if (projectName.length === 0 || number === null) {
        logger.info("specs.ticket_read_through.invalid_route", {
          hasProjectName: projectName.length > 0,
          ticketNumberSegment: params["number"] ?? "",
        });
        return jsonError(
          "Invalid ticket read-through route",
          400,
          "validation",
        );
      }

      const project = await resolveProjectOr404(deps, projectName);
      if (!project.ok) return project.response;

      try {
        const links = await deps.getLinksService(project.value);
        const result = await links.getTicketReadThrough({
          projectName,
          number,
        });
        logger.debug("specs.ticket_read_through.complete", {
          projectName,
          ticketNumber: number,
          linkedSpecCount: result.specs.length,
        });
        return NextResponse.json({ specs: result.specs });
      } catch (error) {
        if (error instanceof LinksServiceError && error.code === "not_found") {
          return notFound(error.message, error.code);
        }
        throw error;
      }
    },
  };
}

const handlers = createTicketReadThroughRouteHandlers();
export const ticketReadThroughGET = withTracing(handlers.GET);
